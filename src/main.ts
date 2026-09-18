/**
 * Entry point: `bun run start`
 *
 * Boots the workflow (loading snooker-ball-det.onnx from the artifact store),
 * attaches the camera sidecar, and serves the hub UI:
 *   control UI:  http://localhost:PORT/        (operator)
 *   TV view:     http://<host-ip>:PORT/tv      (read-only)
 *   event log:   http://localhost:PORT/api/events (structured JSON, AC-10)
 *
 * On Android the sidecar is CameraX. On this host the sidecar is chosen by
 * the CAMERA environment variable:
 *   CAMERA=sim   (default) SimulatedCameraSidecar plays a scripted match so
 *                every pipeline stage runs for real without a camera.
 *   CAMERA=macos MacOSCameraSidecar captures a real USB camera through
 *                ffmpeg's AVFoundation input. Tune with CAMERA_DEVICE
 *                (index or name substring, default "Elgato"), CAMERA_SIZE
 *                (WxH, default 3840x2160), CAMERA_FPS (default 30),
 *                CAMERA_PIXFMT (e.g. uyvy422) and CAMERA_CROP (x,y,w,h in
 *                capture pixels). `bun run cameras` lists devices.
 */

import { ArtifactStore } from "./platform/artifacts.ts";
import { type CameraSidecar, SimulatedCameraSidecar } from "./platform/sidecar.ts";
import { ELGATO_FACECAM_4K, MacOSCameraSidecar } from "./platform/sidecar-macos.ts";
import { SnookerWorkflow } from "./workflow.ts";
import { startHub } from "./hub/server.ts";

const artifactsDir = process.env.ARTIFACTS_DIR ?? "artifacts";
const port = Number(process.env.PORT ?? 4750);

let workflow: SnookerWorkflow;
try {
  workflow = new SnookerWorkflow(new ArtifactStore(artifactsDir));
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}

const cameraKind = process.env.CAMERA ?? "sim";

function createSidecar(): CameraSidecar {
  if (cameraKind === "sim") return new SimulatedCameraSidecar();
  if (cameraKind === "macos") {
    const size = /^(\d+)x(\d+)$/.exec(process.env.CAMERA_SIZE ?? "");
    const crop = /^(\d+),(\d+),(\d+),(\d+)$/.exec(process.env.CAMERA_CROP ?? "");
    return new MacOSCameraSidecar({
      ...ELGATO_FACECAM_4K,
      device: process.env.CAMERA_DEVICE ?? ELGATO_FACECAM_4K.device,
      captureWidth: size ? Number(size[1]) : ELGATO_FACECAM_4K.captureWidth,
      captureHeight: size ? Number(size[2]) : ELGATO_FACECAM_4K.captureHeight,
      captureFps: process.env.CAMERA_FPS ? Number(process.env.CAMERA_FPS) : ELGATO_FACECAM_4K.captureFps,
      pixelFormat: process.env.CAMERA_PIXFMT ?? ELGATO_FACECAM_4K.pixelFormat,
      crop: crop
        ? { x: Number(crop[1]), y: Number(crop[2]), width: Number(crop[3]), height: Number(crop[4]) }
        : undefined,
    });
  }
  throw new Error(`Unknown CAMERA="${cameraKind}" (expected "sim" or "macos")`);
}

let sidecar: CameraSidecar;
try {
  sidecar = createSidecar();
  sidecar.start((frame) => workflow.processRawFrame(frame));
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}

const server = startHub(workflow, sidecar, { port });

console.log(`Snooker Match`);
console.log(`  model:      ${workflow.state.data.status.modelName}`);
console.log(`  camera:     ${cameraKind}`);
console.log(`  control UI: http://localhost:${server.port}/`);
console.log(`  TV view:    http://localhost:${server.port}/tv`);
console.log(`  event log:  http://localhost:${server.port}/api/events`);
if (cameraKind === "sim") {
  console.log(
    `  (demo) open the control UI, press "Recalibrate camera" -> "Begin calibration", then "Start match" — the simulated table will begin scoring.`,
  );
} else {
  console.log(
    `  open the control UI, press "Recalibrate camera", tap the four table corners, then "Begin calibration" and "Start match".`,
  );
}
