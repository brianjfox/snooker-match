/**
 * Integration tests: synthetic frame sequences with known stable-shot-stable
 * cycles produce correct Shot events and state changes (plan test plan
 * bullet 3; AC-1, AC-2, AC-3, AC-5, AC-8), plus the performance bullet
 * (motion-only 30 fps, detection gated to stable moments).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/platform/artifacts.ts";
import { SnookerWorkflow } from "../src/workflow.ts";
import { trainModel } from "../src/trainer/trainer.ts";
import { renderCanonical, SIM_TABLE_CORNERS, renderRaw } from "../src/vision/synth.ts";
import { FPS, type ClassifiedBall, type Frame } from "../src/types.ts";

const FRAME_MS = 1000 / FPS;

const store = new ArtifactStore(mkdtempSync(join(tmpdir(), "snooker-wf-")));
store.writeModel(trainModel(60).artifact);

function spreadLayout(): ClassifiedBall[] {
  return [
    { colour: "red", x: 60, y: 40, confidence: 1 },
    { colour: "red", x: 120, y: 120, confidence: 1 },
    { colour: "red", x: 200, y: 50, confidence: 1 },
    { colour: "black", x: 293, y: 80, confidence: 1 },
    { colour: "blue", x: 160, y: 80, confidence: 1 },
    { colour: "cue", x: 48, y: 80, confidence: 1 },
  ];
}

let workflow: SnookerWorkflow;
let t = 0;

beforeEach(() => {
  workflow = new SnookerWorkflow(store);
  workflow.rules.startMatch({ player1: "A", player2: "B" }, 0);
  t = 0;
});

/** Feed n identical clean frames (stable period). */
function feedStable(balls: ClassifiedBall[], n: number, opts: Record<string, unknown> = {}): void {
  for (let i = 0; i < n; i++) {
    workflow.processCanonicalFrame(renderCanonical(balls, { timestamp: t, ...opts }));
    t += FRAME_MS;
  }
}

/** Feed n noisy frames (balls in motion). */
function feedMotion(balls: ClassifiedBall[], n: number): void {
  for (let i = 0; i < n; i++) {
    workflow.processCanonicalFrame(
      renderCanonical(balls, { timestamp: t, noise: 40, seed: 1000 + i }),
    );
    t += FRAME_MS;
  }
}

// ~23 stable frames = 750ms to trigger + 5 consensus frames.
const STABLE_RUN = 35;

describe("stable-shot-stable cycles (AC-3, AC-8)", () => {
  test("a potted red is scored from vision within the next stable window", () => {
    const before = spreadLayout();
    feedStable(before, STABLE_RUN); // baseline state
    feedMotion(before, 10); // cue strikes
    const after = before.filter((b) => !(b.colour === "red" && b.x === 60));
    feedStable(after, STABLE_RUN);
    expect(workflow.state.data.scores[1]).toBe(1);
    expect(workflow.state.data.currentBreak).toBe(1);
    expect(workflow.state.data.redsRemaining).toBe(14);
    expect(
      workflow.state.data.eventLog.some((e) => e.type === "POT" && e.source === "vision"),
    ).toBe(true);
  });

  test("scoreboard state updates in under a second of virtual time after stability", () => {
    const before = spreadLayout();
    feedStable(before, STABLE_RUN);
    feedMotion(before, 10);
    const after = before.filter((b) => b.colour !== "blue"); // wrong ball -> foul
    const motionEnd = t;
    feedStable(after, STABLE_RUN);
    const foul = workflow.state.data.eventLog.find((e) => e.type === "FOUL");
    expect(foul).toBeDefined();
    // Logged within stableMs (750) + consensus window (5 frames) + margin < 1s
    // of the stability onset — i.e. score reaches state faster than manual entry.
    expect(foul!.timestamp - motionEnd).toBeLessThan(1000);
  });

  test("no table change produces no scoring events", () => {
    const balls = spreadLayout();
    feedStable(balls, STABLE_RUN);
    feedMotion(balls, 8);
    feedStable(balls, STABLE_RUN);
    expect(workflow.state.data.scores[1]).toBe(0);
    expect(workflow.state.data.scores[2]).toBe(0);
  });
});

describe("occlusion and low confidence (AC-1, AC-8)", () => {
  test("occlusion during a stable window raises the notification and blocks diffing", () => {
    const balls = spreadLayout();
    feedStable(balls, STABLE_RUN);
    feedMotion(balls, 10);
    // A big foreign object (arm) covers part of the table.
    feedStable(balls, STABLE_RUN, { occlusion: { x: 100, y: 40, w: 60, h: 90 } });
    expect(workflow.state.data.notification.active).toBe(true);
    expect(workflow.state.data.notification.reason).toBe("occlusion");
    // Nothing was scored from the occluded view.
    expect(workflow.state.data.scores[1]).toBe(0);
    expect(workflow.state.data.scores[2]).toBe(0);
  });

  test("notification appears within 1s of the problem (NFR-5 watchdog)", () => {
    const balls = spreadLayout();
    feedStable(balls, STABLE_RUN); // healthy baseline, consensus done
    const problemStart = t;
    // Table stays stable but an occluder appears without any motion phase
    // (someone leans over): the 1 Hz watchdog must catch it.
    feedStable(balls, FPS + 2, { occlusion: { x: 100, y: 40, w: 60, h: 90 } });
    expect(workflow.state.data.notification.active).toBe(true);
    expect(workflow.state.data.notification.since! - problemStart).toBeLessThanOrEqual(1000);
  });
});

describe("uncalibrated + raw path (FR-9)", () => {
  test("raw frames are ignored until corners are set, then scored end-to-end", () => {
    const before = spreadLayout();
    const raw = (balls: ClassifiedBall[], opts: Record<string, unknown> = {}): Frame =>
      renderRaw(renderCanonical(balls, { timestamp: t, ...opts }), SIM_TABLE_CORNERS, t);

    // Uncalibrated: nothing happens.
    for (let i = 0; i < 10; i++) {
      workflow.processRawFrame(raw(before));
      t += FRAME_MS;
    }
    expect(workflow.latestCanonical).toBeNull();

    // Calibrate via the agent (corner taps), then the pipeline runs.
    workflow.calibration.setCorners(SIM_TABLE_CORNERS, t);
    for (let i = 0; i < STABLE_RUN; i++) {
      workflow.processRawFrame(raw(before));
      t += FRAME_MS;
    }
    for (let i = 0; i < 10; i++) {
      workflow.processRawFrame(raw(before, { noise: 40, seed: i }));
      t += FRAME_MS;
    }
    const after = before.filter((b) => !(b.colour === "red" && b.x === 60));
    for (let i = 0; i < STABLE_RUN; i++) {
      workflow.processRawFrame(raw(after));
      t += FRAME_MS;
    }
    expect(workflow.state.data.scores[1]).toBe(1);
  });

  test("learnCentroids + beginCalibration update status and model name (AC-7)", () => {
    const frame = renderCanonical(spreadLayout(), { timestamp: 0 });
    workflow.calibration.learnCentroids(frame, 100);
    expect(workflow.state.data.status.calibrated).toBe(true);
    const nameBefore = workflow.state.data.status.modelName;
    workflow.calibration.beginCalibration(25, frame, 200);
    expect(workflow.state.data.status.modelName).not.toBe(nameBefore);
    expect(workflow.state.data.status.modelName).toContain("cal #1");
    expect(workflow.state.data.calibration.capturedFrames).toBe(25);
  });

  test("beginCalibration stores labelled frames in the fine-tuning buffer (FR-9)", () => {
    const frame = renderCanonical(spreadLayout(), { timestamp: 0 });
    const before = workflow.state.data.fineTuningBuffer.length;
    workflow.calibration.beginCalibration(25, frame, 300);
    const buffer = workflow.state.data.fineTuningBuffer;
    // The buffer grows by one labelled entry per captured frame...
    expect(buffer.length).toBe(before + 25);
    const sample = buffer[buffer.length - 1]!;
    // ...each carrying a downsampled snapshot of the rectified view (no
    // correction: these are calibration captures, not human overrides).
    expect(sample.correction).toBeNull();
    expect(sample.frame).toBeDefined();
    expect(sample.frame!.width).toBe(Math.floor(frame.width / 4));
    expect(sample.frame!.height).toBe(Math.floor(frame.height / 4));
    expect(sample.frame!.data.length).toBe(
      sample.frame!.width * sample.frame!.height * 3,
    );
    expect(sample.tableState).toBe(workflow.state.data.latestTableState);
  });
});

describe("performance (AC-2, NFR-3)", () => {
  test("motion-phase frames process faster than the 33ms frame budget", () => {
    const balls = spreadLayout();
    workflow.calibration.setCorners(SIM_TABLE_CORNERS, 0);
    // Warm up.
    feedMotion(balls, 5);
    const frames: Frame[] = [];
    for (let i = 0; i < 60; i++) {
      frames.push(
        renderRaw(
          renderCanonical(balls, { timestamp: t + i * FRAME_MS, noise: 40, seed: i }),
          SIM_TABLE_CORNERS,
          t + i * FRAME_MS,
        ),
      );
    }
    const start = performance.now();
    for (const f of frames) workflow.processRawFrame(f);
    const perFrame = (performance.now() - start) / frames.length;
    expect(perFrame).toBeLessThan(1000 / FPS);
  });

  test("detection runs only in the consensus window, not per frame", () => {
    const balls = spreadLayout();
    let detectCalls = 0;
    const inner = workflow.detector.detect.bind(workflow.detector);
    (workflow.detector as { detect: typeof inner }).detect = (frame) => {
      detectCalls++;
      return inner(frame);
    };
    feedStable(balls, STABLE_RUN);
    feedMotion(balls, 10);
    feedStable(balls, STABLE_RUN);
    // Two stable windows x 5 consensus frames + at most a few watchdog calls.
    expect(detectCalls).toBeLessThanOrEqual(14);
  });
});
