/**
 * MacOSCameraSidecar — real camera input on macOS.
 *
 * Bun has no AVFoundation bindings, so the sidecar drives ffmpeg's
 * `avfoundation` device input as a child process. ffmpeg captures the USB
 * camera at its native mode (e.g. an Elgato Facecam 4K at 3840x2160 @ 30 fps),
 * optionally crops to the table, downsamples to RAW_W x RAW_H with an area
 * filter, and streams packed rgb24 frames over stdout. This process slices
 * stdout into fixed-size frames and hands them to the workflow exactly as the
 * CameraX sidecar does on Android.
 *
 * Frame policy mirrors CameraX STRATEGY_KEEP_ONLY_LATEST: if the consumer
 * falls behind and several complete frames arrive in one read, only the most
 * recent is delivered.
 *
 * Requires ffmpeg on PATH (`brew install ffmpeg`) or FFMPEG=/path/to/ffmpeg.
 */

import { FPS, RAW_H, RAW_W, type Frame } from "../types.ts";
import type { CameraSidecar } from "./sidecar.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MacOSCameraOptions {
  /**
   * AVFoundation video device: a numeric index ("0") or a case-insensitive
   * substring of the device name ("Elgato"). Resolved against
   * `listVideoDevices()` at start.
   */
  device?: string;
  /** Native capture mode requested from the camera. Must be a supported mode. */
  captureWidth?: number;
  captureHeight?: number;
  captureFps?: number;
  /**
   * Input pixel format passed to avfoundation (e.g. "uyvy422", "nv12").
   * Leave unset to accept the device default; ffmpeg converts to rgb24 anyway.
   */
  pixelFormat?: string;
  /**
   * Optional crop in capture pixels applied before downsampling, so the
   * table fills the RAW_W x RAW_H frame and the detector gets the most
   * pixels per ball. The homography still handles perspective.
   */
  crop?: CropRect;
  /** ffmpeg binary. Defaults to $FFMPEG, then "ffmpeg" on PATH. */
  ffmpegPath?: string;
  /** Restart policy when ffmpeg exits unexpectedly (camera unplugged, etc). */
  restartDelayMs?: number;
  maxRestarts?: number;
  /** Diagnostic sink; defaults to console.error. */
  log?: (message: string) => void;
}

/**
 * Elgato Facecam 4K over USB 3: 3840x2160 at 30 fps is a native mode and
 * uyvy422 is the format AVFoundation settles on for it (it overrides
 * anything else with a warning).
 */
export const ELGATO_FACECAM_4K: MacOSCameraOptions = {
  device: "Elgato",
  captureWidth: 3840,
  captureHeight: 2160,
  captureFps: 30,
  pixelFormat: "uyvy422",
};

type Resolved = Required<
  Omit<MacOSCameraOptions, "pixelFormat" | "crop">
> &
  Pick<MacOSCameraOptions, "pixelFormat" | "crop">;

function resolveOptions(opts: MacOSCameraOptions): Resolved {
  return {
    device: opts.device ?? ELGATO_FACECAM_4K.device!,
    captureWidth: opts.captureWidth ?? ELGATO_FACECAM_4K.captureWidth!,
    captureHeight: opts.captureHeight ?? ELGATO_FACECAM_4K.captureHeight!,
    captureFps: opts.captureFps ?? FPS,
    pixelFormat: opts.pixelFormat,
    crop: opts.crop,
    ffmpegPath: opts.ffmpegPath ?? process.env.FFMPEG ?? "ffmpeg",
    restartDelayMs: opts.restartDelayMs ?? 1000,
    maxRestarts: opts.maxRestarts ?? 10,
    log: opts.log ?? ((m) => console.error(m)),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

export interface VideoDevice {
  index: number;
  name: string;
}

/**
 * Parse the stderr of `ffmpeg -f avfoundation -list_devices true -i ""`.
 * Only the video section is returned; audio devices are ignored.
 */
export function parseAvFoundationDevices(stderr: string): VideoDevice[] {
  const devices: VideoDevice[] = [];
  let inVideo = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation video devices:/.test(line)) {
      inVideo = true;
      continue;
    }
    if (/AVFoundation audio devices:/.test(line)) {
      inVideo = false;
      continue;
    }
    if (!inVideo) continue;
    const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (m) devices.push({ index: Number(m[1]), name: m[2]! });
  }
  return devices;
}

/** Resolve a numeric index or name substring to a listed device. */
export function resolveVideoDevice(
  devices: VideoDevice[],
  selector: string,
): VideoDevice {
  const trimmed = selector.trim();
  if (/^\d+$/.test(trimmed)) {
    const idx = Number(trimmed);
    const byIndex = devices.find((d) => d.index === idx);
    if (byIndex) return byIndex;
  } else {
    const needle = trimmed.toLowerCase();
    const byName = devices.find((d) => d.name.toLowerCase().includes(needle));
    if (byName) return byName;
  }
  const available = devices.length
    ? devices.map((d) => `[${d.index}] ${d.name}`).join(", ")
    : "(none)";
  throw new Error(
    `Camera "${selector}" not found. AVFoundation video devices: ${available}`,
  );
}

/** Build the ffmpeg argument list for a resolved device index. */
export function buildFfmpegArgs(
  deviceIndex: number,
  opts: MacOSCameraOptions = {},
): string[] {
  const o = resolveOptions(opts);
  const filters: string[] = [];
  if (o.crop) {
    const { x, y, width, height } = o.crop;
    filters.push(`crop=${width}:${height}:${x}:${y}`);
  }
  filters.push(`scale=${RAW_W}:${RAW_H}:flags=area`);

  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-nostdin",
    // Minimise input-side buffering so the frame we get is the frame that
    // just happened, not one from a second ago.
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-f", "avfoundation",
    "-framerate", String(o.captureFps),
    "-video_size", `${o.captureWidth}x${o.captureHeight}`,
  ];
  if (o.pixelFormat) args.push("-pixel_format", o.pixelFormat);
  args.push(
    // "<video>:<audio>"; "none" leaves the audio device untouched.
    "-i", `${deviceIndex}:none`,
    "-an",
    "-vf", filters.join(","),
    "-pix_fmt", "rgb24",
    // Emit each captured frame exactly once. With nobuffer, ffmpeg cannot
    // estimate the input rate and the default constant-frame-rate output
    // duplicates frames by the thousand to fill the gap.
    "-fps_mode", "passthrough",
    "-f", "rawvideo",
    "pipe:1",
  );
  return args;
}

/**
 * Slices an arbitrary byte stream into fixed-size frames. `push` returns the
 * newest complete frame contained in the stream so far (as a fresh copy) and
 * counts any older complete frames it skipped, implementing keep-only-latest.
 */
export class FrameAssembler {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  /** Complete frames discarded because a newer one was already available. */
  dropped = 0;

  constructor(readonly frameBytes: number) {}

  push(chunk: Uint8Array): Uint8Array | null {
    if (chunk.length === 0) return null;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes < this.frameBytes) return null;

    const complete = Math.floor(this.pendingBytes / this.frameBytes);
    const remainder = this.pendingBytes - complete * this.frameBytes;
    this.dropped += complete - 1;

    // Flatten, then keep the last complete frame and the trailing remainder.
    const all = new Uint8Array(this.pendingBytes);
    let off = 0;
    for (const c of this.pending) {
      all.set(c, off);
      off += c.length;
    }
    const frameStart = (complete - 1) * this.frameBytes;
    const frame = all.slice(frameStart, frameStart + this.frameBytes);
    this.pending = remainder > 0 ? [all.slice(all.length - remainder)] : [];
    this.pendingBytes = remainder;
    return frame;
  }
}

// ---------------------------------------------------------------------------
// Device discovery
// ---------------------------------------------------------------------------

/** List AVFoundation video devices by running ffmpeg. */
export async function listVideoDevices(
  ffmpegPath = process.env.FFMPEG ?? "ffmpeg",
): Promise<VideoDevice[]> {
  ensureFfmpeg(ffmpegPath);
  const proc = Bun.spawn(
    [ffmpegPath, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  // ffmpeg exits non-zero after listing (no real input); that's expected.
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return parseAvFoundationDevices(stderr);
}

function ensureFfmpeg(ffmpegPath: string): void {
  if (!Bun.which(ffmpegPath)) {
    throw new Error(
      `ffmpeg not found at "${ffmpegPath}". Install with \`brew install ffmpeg\` or set FFMPEG=/path/to/ffmpeg.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

export class MacOSCameraSidecar implements CameraSidecar {
  latestFrame: Frame | null = null;
  /** Complete frames skipped because the consumer fell behind. */
  droppedFrames = 0;

  private readonly opts: Resolved;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private running = false;
  private restarts = 0;
  private epoch: number | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: MacOSCameraOptions = {}) {
    this.opts = resolveOptions(opts);
  }

  start(onFrame: (frame: Frame) => void): () => void {
    ensureFfmpeg(this.opts.ffmpegPath);
    this.running = true;
    void this.run(onFrame);
    return () => this.stop();
  }

  stop(): void {
    this.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  private async run(onFrame: (frame: Frame) => void): Promise<void> {
    let deviceIndex: number;
    try {
      const devices = await listVideoDevices(this.opts.ffmpegPath);
      const device = resolveVideoDevice(devices, this.opts.device);
      deviceIndex = device.index;
      this.opts.log(
        `camera: using [${device.index}] ${device.name} at ${this.opts.captureWidth}x${this.opts.captureHeight}@${this.opts.captureFps}fps -> ${RAW_W}x${RAW_H}`,
      );
    } catch (err) {
      this.opts.log(`camera: ${err instanceof Error ? err.message : String(err)}`);
      this.running = false;
      return;
    }
    if (!this.running) return;

    const args = buildFfmpegArgs(deviceIndex, this.opts);
    const proc = Bun.spawn([this.opts.ffmpegPath, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;

    void this.pumpStderr(proc.stderr);

    const assembler = new FrameAssembler(RAW_W * RAW_H * 3);
    try {
      for await (const chunk of proc.stdout) {
        const data = assembler.push(chunk as Uint8Array);
        if (!data) continue;
        const now = performance.now();
        if (this.epoch === null) this.epoch = now;
        const frame: Frame = {
          width: RAW_W,
          height: RAW_H,
          data,
          timestamp: Math.round(now - this.epoch),
        };
        this.droppedFrames = assembler.dropped;
        this.latestFrame = frame;
        onFrame(frame);
      }
    } catch (err) {
      if (this.running) {
        this.opts.log(`camera: read error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const code = await proc.exited;
    if (this.proc === proc) this.proc = null;
    if (!this.running) return;

    if (this.restarts >= this.opts.maxRestarts) {
      this.opts.log(
        `camera: ffmpeg exited (code ${code}) and restart limit (${this.opts.maxRestarts}) reached; giving up`,
      );
      this.running = false;
      return;
    }
    this.restarts++;
    this.opts.log(
      `camera: ffmpeg exited (code ${code}); restarting in ${this.opts.restartDelayMs} ms (${this.restarts}/${this.opts.maxRestarts})`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.running) void this.run(onFrame);
    }, this.opts.restartDelayMs);
  }

  private async pumpStderr(stderr: ReadableStream<Uint8Array> | number | undefined): Promise<void> {
    if (!stderr || typeof stderr === "number") return;
    const decoder = new TextDecoder();
    let carry = "";
    try {
      for await (const chunk of stderr) {
        carry += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = carry.split(/\r?\n/);
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) this.opts.log(`ffmpeg: ${line.trim()}`);
        }
      }
      if (carry.trim()) this.opts.log(`ffmpeg: ${carry.trim()}`);
    } catch {
      // stream closed with the process
    }
  }
}
