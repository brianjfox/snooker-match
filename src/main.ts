/**
 * Entry point: `bun run start`
 *
 * Boots the workflow (loading snooker-ball-det.onnx from the artifact store),
 * attaches the camera sidecar, and serves the hub UI:
 *   control UI:  http://localhost:PORT/        (operator)
 *   TV view:     http://<host-ip>:PORT/tv      (read-only)
 *   event log:   http://localhost:PORT/api/events (structured JSON, AC-10)
 *
 * On Android the sidecar is CameraX; on this host the SimulatedCameraSidecar
 * plays a scripted match so every pipeline stage runs for real.
 */

import { ArtifactStore } from "./platform/artifacts.ts";
import { SimulatedCameraSidecar } from "./platform/sidecar.ts";
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

const sidecar = new SimulatedCameraSidecar();
sidecar.start((frame) => workflow.processRawFrame(frame));

const server = startHub(workflow, sidecar, { port });

console.log(`Snooker Match`);
console.log(`  model:      ${workflow.state.data.status.modelName}`);
console.log(`  control UI: http://localhost:${server.port}/`);
console.log(`  TV view:    http://localhost:${server.port}/tv`);
console.log(`  event log:  http://localhost:${server.port}/api/events`);
console.log(
  `  (demo) open the control UI, press "Recalibrate camera" -> "Begin calibration", then "Start match" — the simulated table will begin scoring.`,
);
