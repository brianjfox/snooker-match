/**
 * CameraSidecar — local shim for the CorbitsCore camera sidecar.
 *
 * On Android this is a CameraX ImageAnalysis stream
 * (STRATEGY_KEEP_ONLY_LATEST) delivering 30 fps YUV frames converted to RGB.
 * Here the SimulatedCameraSidecar plays a scripted match so the whole
 * pipeline (motion -> stable -> detect -> diff -> rules) runs end to end on a
 * host with no camera. The scripted scenario drives the live demo when you
 * `bun run start`.
 */

import {
  type BallColour,
  type ClassifiedBall,
  type Frame,
  FPS,
} from "../types.ts";
import { fullTableLayout, renderCanonical, renderRaw, SIM_TABLE_CORNERS } from "../vision/synth.ts";

export interface CameraSidecar {
  /** Begin delivering frames; returns a stop function. */
  start(onFrame: (frame: Frame) => void): () => void;
  /** Most recent raw frame (for the UI's camera view). */
  readonly latestFrame: Frame | null;
}

type ScenarioStep =
  | { kind: "stable"; ms: number }
  | { kind: "motion"; ms: number }
  | { kind: "pot"; colour: BallColour }
  | { kind: "nudge" };

/** A simple scripted visit: settle, shoot, pot a red, settle, pot black... */
const DEFAULT_SCENARIO: ScenarioStep[] = [
  { kind: "stable", ms: 1500 },
  { kind: "motion", ms: 800 },
  { kind: "pot", colour: "red" },
  { kind: "stable", ms: 1600 },
  { kind: "motion", ms: 700 },
  { kind: "pot", colour: "black" },
  { kind: "stable", ms: 1600 },
  { kind: "motion", ms: 700 },
  { kind: "pot", colour: "red" },
  { kind: "stable", ms: 1600 },
  { kind: "motion", ms: 600 },
  { kind: "nudge" },
  { kind: "stable", ms: 2000 },
];

export class SimulatedCameraSidecar implements CameraSidecar {
  latestFrame: Frame | null = null;
  private balls: ClassifiedBall[] = fullTableLayout();
  private virtualNow = 0;
  private stepIndex = 0;
  private stepElapsed = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly scenario: ScenarioStep[] = DEFAULT_SCENARIO,
    /** Real interval between ticks; virtual time always advances 1000/FPS. */
    private readonly realIntervalMs: number = 1000 / FPS,
  ) {}

  start(onFrame: (frame: Frame) => void): () => void {
    const framePeriod = 1000 / FPS;
    this.timer = setInterval(() => {
      const step = this.scenario[this.stepIndex % this.scenario.length]!;
      let jitter = 0;
      if (step.kind === "motion") {
        jitter = 30; // strong pixel churn while balls roll
      } else if (step.kind === "pot" || step.kind === "nudge") {
        this.applyStep(step);
        this.advanceStep();
        jitter = 30;
      }
      const canonical = renderCanonical(this.balls, {
        timestamp: this.virtualNow,
        noise: 2 + jitter,
        seed: (this.virtualNow * 7919) & 0xffff,
      });
      const raw = renderRaw(canonical, SIM_TABLE_CORNERS, this.virtualNow);
      this.latestFrame = raw;
      onFrame(raw);
      this.virtualNow += framePeriod;
      this.stepElapsed += framePeriod;
      if (step.kind === "stable" || step.kind === "motion") {
        if (this.stepElapsed >= step.ms) this.advanceStep();
      }
    }, this.realIntervalMs);
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }

  private advanceStep(): void {
    this.stepIndex++;
    this.stepElapsed = 0;
    if (this.stepIndex % this.scenario.length === 0) {
      // Loop the scenario on a fresh table so the demo never runs dry.
      this.balls = fullTableLayout();
    }
  }

  private applyStep(step: ScenarioStep): void {
    if (step.kind === "pot") {
      const idx = this.balls.findIndex((b) => b.colour === step.colour);
      if (idx >= 0) this.balls.splice(idx, 1);
    } else if (step.kind === "nudge") {
      const red = this.balls.find((b) => b.colour === "red");
      if (red) {
        red.x += 12;
        red.y += 4;
      }
    }
  }
}
