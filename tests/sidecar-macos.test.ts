/**
 * MacOSCameraSidecar tests: AVFoundation device-list parsing and selection,
 * ffmpeg argument construction (crop before scale, rgb24 rawvideo to stdout),
 * the keep-only-latest frame assembler, and an end-to-end run of the sidecar
 * against a fake ffmpeg that writes known frames so the spawn/pump/stop path
 * is proven without a camera attached.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RAW_H, RAW_W } from "../src/types.ts";
import {
  buildFfmpegArgs,
  ELGATO_FACECAM_4K,
  FrameAssembler,
  MacOSCameraSidecar,
  parseAvFoundationDevices,
  resolveVideoDevice,
} from "../src/platform/sidecar-macos.ts";

const FRAME_BYTES = RAW_W * RAW_H * 3;

const LIST_OUTPUT = `
[AVFoundation indev @ 0x7cf5010140] AVFoundation video devices:
[AVFoundation indev @ 0x7cf5010140] [0] Elgato Facecam 4K
[AVFoundation indev @ 0x7cf5010140] [1] Capture screen 0
[AVFoundation indev @ 0x7cf5010140] [2] Capture screen 1
[AVFoundation indev @ 0x7cf5010140] AVFoundation audio devices:
[AVFoundation indev @ 0x7cf5010140] [0] MacBook Air Microphone
[in#0 @ 0x7cf5010000] Error opening input: Input/output error
`;

describe("device discovery", () => {
  test("parses only the video section of ffmpeg's device list", () => {
    const devices = parseAvFoundationDevices(LIST_OUTPUT);
    expect(devices).toEqual([
      { index: 0, name: "Elgato Facecam 4K" },
      { index: 1, name: "Capture screen 0" },
      { index: 2, name: "Capture screen 1" },
    ]);
  });

  test("resolves by name substring (case-insensitive) or numeric index", () => {
    const devices = parseAvFoundationDevices(LIST_OUTPUT);
    expect(resolveVideoDevice(devices, "elgato").index).toBe(0);
    expect(resolveVideoDevice(devices, "Elgato Facecam 4K").index).toBe(0);
    expect(resolveVideoDevice(devices, "2").name).toBe("Capture screen 1");
  });

  test("unknown selector throws and lists what is available", () => {
    const devices = parseAvFoundationDevices(LIST_OUTPUT);
    expect(() => resolveVideoDevice(devices, "Logitech")).toThrow(/Elgato Facecam 4K/);
    expect(() => resolveVideoDevice(devices, "9")).toThrow(/not found/);
    expect(() => resolveVideoDevice([], "Elgato")).toThrow(/\(none\)/);
  });
});

describe("ffmpeg arguments", () => {
  test("Elgato preset captures 4K30 and emits rgb24 rawvideo at RAW size", () => {
    const args = buildFfmpegArgs(0, ELGATO_FACECAM_4K);
    const s = args.join(" ");
    expect(s).toContain("-f avfoundation");
    expect(s).toContain("-framerate 30");
    expect(s).toContain("-video_size 3840x2160");
    expect(s).toContain("-i 0:none");
    expect(s).toContain(`-vf scale=${RAW_W}:${RAW_H}:flags=area`);
    expect(s).toContain("-pix_fmt rgb24");
    expect(s).toContain("-fps_mode passthrough -f rawvideo pipe:1");
    expect(args[args.indexOf("-pixel_format") + 1]).toBe("uyvy422");
    expect(args[args.length - 1]).toBe("pipe:1");
  });

  test("no pixel format is passed when none is requested", () => {
    expect(buildFfmpegArgs(0, { captureWidth: 1280, captureHeight: 720 })).not.toContain("-pixel_format");
  });

  test("crop is applied before scaling and pixel format is forwarded", () => {
    const args = buildFfmpegArgs(1, {
      captureWidth: 1920,
      captureHeight: 1080,
      captureFps: 60,
      pixelFormat: "uyvy422",
      crop: { x: 100, y: 50, width: 1600, height: 800 },
    });
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toBe(`crop=1600:800:100:50,scale=${RAW_W}:${RAW_H}:flags=area`);
    expect(args).toContain("-pixel_format");
    expect(args[args.indexOf("-pixel_format") + 1]).toBe("uyvy422");
    expect(args[args.indexOf("-i") + 1]).toBe("1:none");
    expect(args[args.indexOf("-framerate") + 1]).toBe("60");
  });
});

describe("FrameAssembler", () => {
  test("reassembles a frame split across chunks and carries the remainder", () => {
    const a = new FrameAssembler(6);
    expect(a.push(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(a.push(new Uint8Array([4, 5]))).toBeNull();
    const f1 = a.push(new Uint8Array([6, 7]));
    expect(f1).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    // "7" carried over into the next frame
    const f2 = a.push(new Uint8Array([8, 9, 10, 11, 12]));
    expect(f2).toEqual(new Uint8Array([7, 8, 9, 10, 11, 12]));
    expect(a.dropped).toBe(0);
  });

  test("keeps only the latest frame when several arrive at once", () => {
    const a = new FrameAssembler(2);
    const f = a.push(new Uint8Array([1, 1, 2, 2, 3, 3, 4]));
    expect(f).toEqual(new Uint8Array([3, 3]));
    expect(a.dropped).toBe(2);
    expect(a.push(new Uint8Array([4]))).toEqual(new Uint8Array([4, 4]));
    expect(a.dropped).toBe(2);
  });

  test("returned frames are independent copies", () => {
    const a = new FrameAssembler(2);
    const src = new Uint8Array([9, 9]);
    const f = a.push(src)!;
    src[0] = 0;
    expect(f[0]).toBe(9);
  });
});

describe("MacOSCameraSidecar end to end (fake ffmpeg)", () => {
  /**
   * A stand-in ffmpeg: on `-list_devices` it prints a device list to stderr
   * and exits 1 like the real thing; otherwise it writes three RAW-sized
   * rgb24 frames filled with 10, 20, 30 to stdout and then sleeps so `stop`
   * has a live process to kill.
   */
  function fakeFfmpeg(): string {
    const dir = mkdtempSync(join(tmpdir(), "fake-ffmpeg-"));
    const path = join(dir, "ffmpeg");
    const script = `#!/bin/sh
case "$*" in
  *-list_devices*)
    printf '%s\\n' '[AVFoundation indev @ 0x1] AVFoundation video devices:' \\
      '[AVFoundation indev @ 0x1] [0] Elgato Facecam 4K' \\
      '[AVFoundation indev @ 0x1] AVFoundation audio devices:' >&2
    exit 1 ;;
esac
echo "fake ffmpeg: capturing $*" >&2
for fill in 10 20 30; do
  head -c ${FRAME_BYTES} /dev/zero | LC_ALL=C tr '\\000' "$(printf '\\\\%03o' $fill)"
done
sleep 30
`;
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    return path;
  }

  test("resolves the device, delivers RAW-sized frames, and stop kills ffmpeg", async () => {
    const logs: string[] = [];
    const sidecar = new MacOSCameraSidecar({
      ...ELGATO_FACECAM_4K,
      ffmpegPath: fakeFfmpeg(),
      maxRestarts: 0,
      log: (m) => logs.push(m),
    });

    const received: number[] = [];
    const stamps: number[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const stop = sidecar.start((frame) => {
      expect(frame.width).toBe(RAW_W);
      expect(frame.height).toBe(RAW_H);
      expect(frame.data.length).toBe(FRAME_BYTES);
      received.push(frame.data[0]!);
      stamps.push(frame.timestamp);
      if (received.includes(30)) resolveDone();
    });

    await Promise.race([
      done,
      new Promise((_, rej) => setTimeout(() => rej(new Error("no frames in 5 s")), 5000)),
    ]);

    // Frames may be coalesced (keep-only-latest); the last one must be 30.
    expect(received[received.length - 1]).toBe(30);
    for (const v of received) expect([10, 20, 30]).toContain(v);
    expect(sidecar.latestFrame?.data[0]).toBe(30);
    expect(stamps[0]).toBe(0);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]!).toBeGreaterThanOrEqual(stamps[i - 1]!);
    expect(logs.some((l) => /using \[0\] Elgato Facecam 4K/.test(l))).toBe(true);
    expect(logs.some((l) => /ffmpeg: fake ffmpeg: capturing/.test(l))).toBe(true);

    stop();
    await new Promise((r) => setTimeout(r, 200));
    // No restart attempted after an explicit stop.
    expect(logs.some((l) => /restarting/.test(l))).toBe(false);
  });

  test("an unknown device is reported and the sidecar goes idle", async () => {
    const logs: string[] = [];
    const sidecar = new MacOSCameraSidecar({
      device: "Logitech",
      ffmpegPath: fakeFfmpeg(),
      log: (m) => logs.push(m),
    });
    const stop = sidecar.start(() => {
      throw new Error("no frames expected");
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(logs.some((l) => /Camera "Logitech" not found/.test(l))).toBe(true);
    expect(sidecar.latestFrame).toBeNull();
    stop();
  });

  test("missing ffmpeg binary fails fast with install guidance", () => {
    const sidecar = new MacOSCameraSidecar({ ffmpegPath: "/nonexistent/ffmpeg" });
    expect(() => sidecar.start(() => {})).toThrow(/brew install ffmpeg/);
  });
});
