/**
 * SnookerWorkflow (plan task 1) — the Interchange workflow definition.
 *
 * Wires: CameraSidecar frames -> homography rectification -> MotionDetector
 * -> (on stable) DetectionAgent over a 5-frame consensus window ->
 * ColourClassifier -> StateObserver -> Shot deltas -> RulesAgent, with the
 * FallbackStateMachine watching confidence/occlusion throughout.
 *
 * Inference only runs on the 5 frames following a stability onset plus a 1 Hz
 * occlusion watchdog while stable — motion frames cost one grayscale diff
 * (NFR-3). All outputs land in WorkflowState, which the hub serves to
 * browsers.
 */

import { FPS, type Frame } from "./types.ts";
import { ArtifactStore } from "./platform/artifacts.ts";
import { WorkflowState } from "./platform/state.ts";
import { MotionDetector } from "./vision/motion.ts";
import { BallDetector, type Detector } from "./vision/detector.ts";
import { ColourClassifier } from "./vision/colour.ts";
import { consensusState, CONSENSUS_WINDOW } from "./vision/consensus.ts";
import { StateObserver } from "./vision/observer.ts";
import { rectify } from "./vision/homography.ts";
import { BALL_RADIUS } from "./vision/synth.ts";
import { CalibrationAgent, defaultCentroids } from "./agents/calibration.ts";
import { FallbackStateMachine } from "./rules/fallback.ts";
import { RulesAgent } from "./rules/engine.ts";
import type { ClassifiedBall } from "./types.ts";

/** How often the occlusion watchdog runs while the table is stable. */
const WATCHDOG_EVERY_FRAMES = FPS; // ~1 Hz => notification within 1 s (NFR-5)

export class SnookerWorkflow {
  readonly state: WorkflowState;
  readonly detector: Detector;
  readonly classifier: ColourClassifier;
  readonly motion: MotionDetector;
  readonly observer: StateObserver;
  readonly calibration: CalibrationAgent;
  readonly fallback: FallbackStateMachine;
  readonly rules: RulesAgent;

  /** Latest rectified frame (for the UI camera view + calibration). */
  latestCanonical: Frame | null = null;

  private window: ClassifiedBall[][] = [];
  private collecting = false;
  private occlusionSeen = false;
  private framesSinceWatchdog = 0;
  private fpsCounter = 0;
  private fpsWindowStart = 0;

  constructor(artifacts: ArtifactStore, state = new WorkflowState()) {
    this.state = state;
    // ADR-3: the model is loaded from the artifact store at workflow start;
    // a missing artifact fails loudly (run `bun run train`).
    const artifact = artifacts.readModel();
    this.detector = new BallDetector(artifact);
    this.state.mutate((data) => {
      data.status.modelName = `${artifact.name} v${artifact.version}`;
      data.status.modelVersion = artifact.version;
    });
    this.classifier = new ColourClassifier(defaultCentroids(), {
      minRadius: BALL_RADIUS * 0.55,
      maxRadius: BALL_RADIUS * 1.45,
    });
    this.motion = new MotionDetector();
    this.observer = new StateObserver();
    this.calibration = new CalibrationAgent(this.state);
    this.fallback = new FallbackStateMachine(this.state);
    this.rules = new RulesAgent(this.state, this.fallback);
    // Adopt learned centroids whenever calibration updates them.
    this.state.subscribe((data) => {
      if (data.calibration.centroids) {
        this.classifier.setCentroids(data.calibration.centroids);
      }
    });
  }

  /** Feed one raw camera frame (the sidecar calls this at 30 fps). */
  processRawFrame(raw: Frame): void {
    this.trackFps(raw.timestamp);
    const H = this.state.data.calibration.homography;
    if (!H) return; // uncalibrated: vision idle until corners are tapped
    const canonical = rectify(raw, H);
    this.processCanonicalFrame(canonical);
  }

  /** Feed one already-rectified frame (tests inject these directly). */
  processCanonicalFrame(frame: Frame): void {
    this.latestCanonical = frame;
    const now = frame.timestamp;
    const { phase, becameStable } = this.motion.update(frame);

    if (phase === "moving") {
      this.collecting = false;
      this.window = [];
      this.framesSinceWatchdog = 0;
      return;
    }

    if (becameStable) {
      this.collecting = true;
      this.window = [];
      this.occlusionSeen = false;
    }

    if (this.collecting && phase === "stable") {
      const result = this.detector.detect(frame);
      this.occlusionSeen ||= result.occlusion;
      this.window.push(this.classifier.classifyAll(frame, result.detections));
      if (this.window.length >= CONSENSUS_WINDOW) {
        this.collecting = false;
        const consensus = consensusState(this.window, now);
        this.window = [];
        // Quality signals first: banner/fallback state must precede scoring.
        this.fallback.observe(consensus.confidence, this.occlusionSeen, now);
        this.state.mutate((data) => {
          data.now = now;
          data.previousTableState = data.latestTableState;
          data.latestTableState = consensus;
        });
        if (this.occlusionSeen) {
          // Do not diff against an occluded view — wait for a clean stable.
          return;
        }
        const shot = this.observer.observe(consensus);
        if (shot) this.rules.onShot(shot, now);
      }
      return;
    }

    // Stable steady-state: 1 Hz watchdog for occlusion / confidence decay so
    // the notification appears within one second even with no shot (NFR-5).
    if (phase === "stable" && !this.collecting) {
      this.framesSinceWatchdog++;
      if (this.framesSinceWatchdog >= WATCHDOG_EVERY_FRAMES) {
        this.framesSinceWatchdog = 0;
        const result = this.detector.detect(frame);
        this.fallback.observe(result.meanConfidence, result.occlusion, now);
      }
    }
  }

  private trackFps(timestamp: number): void {
    this.fpsCounter++;
    if (timestamp - this.fpsWindowStart >= 1000) {
      const fps = Math.round(
        (this.fpsCounter * 1000) / Math.max(1, timestamp - this.fpsWindowStart),
      );
      this.fpsWindowStart = timestamp;
      this.fpsCounter = 0;
      this.state.mutate((data) => {
        data.status.fps = fps;
      });
    }
  }
}
