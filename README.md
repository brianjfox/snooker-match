# Snooker Match

Real-time snooker scoring from a single overhead camera. A state-observation
vision pipeline (ball-only detector + deterministic colour/motion/differencing)
feeds a deterministic rules engine; a local-network hub serves a full control
UI and a read-only TV scoreboard, with an angry blinking red banner whenever
the model needs human help.

Built to the approved plan (frozen packet
`bdd569bc04eec3442cee11a2fef549c4696ae51ec1e86489defd2de8b51afaf4`, target
`local`).

## Quick start

```sh
bun install        # dev types only (no runtime dependencies)
bun run train      # ModelTrainer: builds artifacts/snooker-ball-det.onnx
bun run start      # workflow + hub on http://localhost:4750
```

Then open:

- `http://localhost:4750/` — control UI (operator). Press **Recalibrate
  camera** → **Begin calibration**, then **Start match**; the simulated table
  starts scoring.
- `http://localhost:4750/tv` — read-only TV view for any browser on the LAN.
- `http://localhost:4750/api/events` — structured JSON event log (AC-10).

### Real camera on macOS

The host build can also score a live table from a USB camera through
ffmpeg's AVFoundation input (`brew install ffmpeg`). An Elgato Facecam 4K at
3840x2160 @ 30 fps is the reference setup; any UVC camera AVFoundation lists
will do.

```sh
bun run cameras                                   # list video devices
CAMERA=macos CAMERA_DEVICE=Elgato bun run start   # capture instead of simulate
```

Tuning (all optional): `CAMERA_SIZE=WxH` (native capture mode, default
`3840x2160`), `CAMERA_FPS` (default 30), `CAMERA_PIXFMT` (e.g. `uyvy422`),
`CAMERA_CROP=x,y,w,h` in capture pixels to crop to the table before the
downsample so the detector gets the most pixels per ball. `FFMPEG=/path`
overrides the binary. Frames are downsampled to 320x180 with an area filter,
delivered keep-only-latest like CameraX, and ffmpeg is restarted automatically
if the camera drops out.

Checks:

```sh
bun run typecheck  # tsc --noEmit
bun test           # vision, rules, trainer, workflow, hub/UI, macOS sidecar
bun run bundle     # dist/main.js + workflow-manifest.json (Android bundle)
```

## How it works

```
CameraSidecar (30 fps raw frames)
  └─ homography rectification (4 corner taps at calibration)
       └─ MotionDetector (grayscale diff; STABLE after 750 ms quiet)
            └─ on stable: DetectionAgent (ball-only model) x5 frames
                 └─ ColourClassifier (CIELAB nearest-centroid, learned per table)
                      └─ temporal consensus (5 frames, 3 votes)
                           └─ StateObserver (Hungarian differencing on reds,
                              presence diff on colours) → Shot {before, after}
                                └─ RulesAgent (preset-aware deterministic scoring)
                                     └─ WorkflowState → hub SSE → browsers
```

- **Inference is gated**: the detector only runs on the 5 frames after the
  table settles plus a 1 Hz occlusion watchdog, so motion frames cost one
  grayscale diff (NFR-3).
- **No persistent ball identities**: reds are matched between stable states by
  Hungarian assignment on positions; colours by presence (ADR-7).
- **Notification & fallback**: confidence below the slider threshold or a
  detected occlusion raises the `HUMAN INTERVENTION REQUIRED` banner
  immediately (`angry-blink` animation, NFR-5); if the problem persists >5 s
  the FallbackStateMachine suspends vision and keeps the deterministic
  scoreboard alive until a human correction restores trust (ADR-6).
- **Corrections override the model** (FR-7): quick buttons (POT MISSED, WRONG
  COLOUR, FOUL, UNDO, SWITCH PLAYER) and an absolute score form. Every
  correction is logged, recorded into the fine-tuning buffer (FR-12), resets
  the shot timer, and clears fallback.
- **Rule presets** (FR-3/8): Professional (fouls 4-7 by the higher of the ball
  on and the ball involved, respotted black on ties, foul on the final black
  settles the frame), Amateur (same fouls, no respot), Club (flat 4). See
  `src/rules/presets.ts`.
- **Grants** (FR-10): operators may POST corrections/setup/calibration; TV
  viewers are read-only and get 403 on any POST (`src/platform/grants.ts`).

## The model artifact

`bun run train` runs the ModelTrainer (plan task 2 / ADR-5): it generates
synthetic labelled table frames with varied lighting, noise and ball clusters,
fits the ball-only detector's parameters, validates on a held-out split
(quality gate: recall and precision >= 95 %), and stores the result as
`artifacts/snooker-ball-det.onnx`. The workflow refuses to start without it
(ADR-3).

On Android this slot is a real YOLO-style ONNX network executed by
onnxruntime; in this local build the artifact carries fitted deterministic
blob-detector parameters. The artifact name, metadata, store, and the
`Frame in → {detections, occlusion, confidence} out` contract are identical,
so swapping in the real network changes no downstream code.

## Platform shims

This repository targets the `local` deployment. The platform primitives the
plan names are provided as local shims with the same interfaces:

| Plan primitive        | Local shim                                     |
| --------------------- | ---------------------------------------------- |
| CorbitsCore camera sidecar (CameraX) | `SimulatedCameraSidecar` — scripted match at 30 fps (`src/platform/sidecar.ts`); `MacOSCameraSidecar` — real USB camera via ffmpeg/AVFoundation (`src/platform/sidecar-macos.ts`) |
| @corbits/artifacts    | `ArtifactStore` on `artifacts/` (`src/platform/artifacts.ts`) |
| Interchange workflow state | `WorkflowState` observable store (`src/platform/state.ts`) |
| Grants manifest       | `GRANT_MANIFEST` + role resolution (`src/platform/grants.ts`) |
| Hosted hub / react-ui | `Bun.serve` + vanilla HTML matching the design artifact (`src/hub/`) |

`bun run bundle` produces `dist/` with the single-file workflow bundle and a
`workflow-manifest.json` describing the CameraX sidecar allocation, grants,
and the model artifact to mount — the packaging step for tablet deployment
(plan task 16).

## Layout

```
src/types.ts            shared types + workflow state schema (plan task 9)
src/platform/           state, artifacts, grants, camera sidecars (sim, macOS)
src/vision/             synth, homography, motion, detector, colour,
                        consensus, hungarian, observer
src/agents/calibration.ts  guided corner+spot calibration (task 3)
src/rules/              presets, deterministic engine, fallback (tasks 8, 14)
src/workflow.ts         pipeline wiring (task 1)
src/hub/                server + control/TV pages (tasks 11-13)
src/trainer/            ModelTrainer + CLI (task 2)
scripts/bundle.ts       Android-deployable bundle (task 16)
scripts/list-cameras.ts AVFoundation device listing (`bun run cameras`)
tests/                  vision, rules, trainer, workflow, hub, macOS sidecar
```

## Acceptance criteria coverage

| AC | Where proven |
| -- | ------------ |
| AC-1 banner + angry-blink | `tests/hub.test.ts` (markup), `tests/workflow.test.ts`, `tests/rules.test.ts` (state within 1 s) |
| AC-2 ≥30 fps + 16:9 feed | `tests/workflow.test.ts` performance, `tests/hub.test.ts` IR-2 |
| AC-3 pot updates <1 s | `tests/workflow.test.ts` stable-shot-stable, `tests/rules.test.ts` |
| AC-4 preset-scaled fouls | `tests/rules.test.ts` presets |
| AC-5 frame auto-advance | `tests/rules.test.ts` frame advance |
| AC-6 corrections logged + fine-tuning | `tests/rules.test.ts`, `tests/hub.test.ts` |
| AC-7 calibration updates model name | `tests/workflow.test.ts`, `tests/hub.test.ts` |
| AC-8 no silent errors, fallback | `tests/rules.test.ts` fallback, `tests/workflow.test.ts` occlusion/watchdog |
| AC-9 TV update speed | `tests/hub.test.ts` SSE <1 s |
| AC-10 JSON event log | `tests/hub.test.ts` /api/events |
