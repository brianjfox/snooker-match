/**
 * Unit tests: homography, motion scoring, detector output, CIELAB
 * classification, temporal consensus, Hungarian differencing (plan test plan
 * bullets 1-2; FR-1, FR-2).
 */

import { describe, expect, test } from "bun:test";
import { CANON_H, CANON_W, type ClassifiedBall } from "../src/types.ts";
import {
  applyHomography,
  computeHomography,
  invertHomography,
  rectify,
} from "../src/vision/homography.ts";
import { MotionDetector } from "../src/vision/motion.ts";
import { BallDetector } from "../src/vision/detector.ts";
import { ColourClassifier, labDistance, rgbToLab } from "../src/vision/colour.ts";
import { consensusState } from "../src/vision/consensus.ts";
import { hungarian } from "../src/vision/hungarian.ts";
import { StateObserver, diffStates } from "../src/vision/observer.ts";
import {
  SIM_TABLE_CORNERS,
  fullTableLayout,
  renderCanonical,
  renderRaw,
} from "../src/vision/synth.ts";
import { defaultCentroids } from "../src/agents/calibration.ts";
import { trainModel } from "../src/trainer/trainer.ts";

const MODEL = trainModel(60).artifact;

function spreadLayout(): ClassifiedBall[] {
  // Non-touching layout: 4 reds + 3 colours far apart.
  return [
    { colour: "red", x: 60, y: 40, confidence: 1 },
    { colour: "red", x: 120, y: 120, confidence: 1 },
    { colour: "red", x: 200, y: 50, confidence: 1 },
    { colour: "red", x: 260, y: 130, confidence: 1 },
    { colour: "black", x: 293, y: 80, confidence: 1 },
    { colour: "blue", x: 160, y: 80, confidence: 1 },
    { colour: "cue", x: 48, y: 80, confidence: 1 },
  ];
}

describe("homography", () => {
  test("corner taps map exactly to canonical corners", () => {
    const H = computeHomography(SIM_TABLE_CORNERS);
    const tl = applyHomography(H, SIM_TABLE_CORNERS[0]);
    const br = applyHomography(H, SIM_TABLE_CORNERS[2]);
    expect(tl.x).toBeCloseTo(0, 4);
    expect(tl.y).toBeCloseTo(0, 4);
    expect(br.x).toBeCloseTo(CANON_W, 4);
    expect(br.y).toBeCloseTo(CANON_H, 4);
  });

  test("inverse homography round-trips points", () => {
    const H = computeHomography(SIM_TABLE_CORNERS);
    const inv = invertHomography(H);
    const p = { x: 150, y: 90 };
    const out = applyHomography(inv, applyHomography(H, p));
    expect(out.x).toBeCloseTo(p.x, 6);
    expect(out.y).toBeCloseTo(p.y, 6);
  });

  test("rectify recovers the canonical table from a raw projected frame", () => {
    const balls = spreadLayout();
    const canonical = renderCanonical(balls);
    const raw = renderRaw(canonical, SIM_TABLE_CORNERS);
    const H = computeHomography(SIM_TABLE_CORNERS);
    const rect = rectify(raw, H);
    const detector = new BallDetector(MODEL);
    const { detections } = detector.detect(rect);
    // Every ball should be found within a couple of canonical units.
    for (const ball of balls) {
      const hit = detections.some(
        (d) => Math.hypot(d.x - ball.x, d.y - ball.y) < 4,
      );
      expect(hit).toBe(true);
    }
  });
});

describe("motion detector", () => {
  test("declares stable only after 750ms below threshold, then triggers once", () => {
    const motion = new MotionDetector();
    const balls = spreadLayout();
    let t = 0;
    let stableTriggers = 0;
    // 30 identical-noise-free frames = 1 second: must become stable exactly once.
    for (let i = 0; i < 30; i++) {
      const frame = renderCanonical(balls, { timestamp: t });
      const { becameStable } = motion.update(frame);
      if (becameStable) {
        expect(t).toBeGreaterThanOrEqual(750);
        stableTriggers++;
      }
      t += 1000 / 30;
    }
    expect(stableTriggers).toBe(1);
  });

  test("high-noise (moving) frames reset stability", () => {
    const motion = new MotionDetector();
    const balls = spreadLayout();
    let t = 0;
    for (let i = 0; i < 30; i++) {
      motion.update(renderCanonical(balls, { timestamp: t }));
      t += 1000 / 30;
    }
    const moving = motion.update(
      renderCanonical(balls, { timestamp: t, noise: 40, seed: 7 }),
    );
    expect(moving.phase).toBe("moving");
  });
});

describe("detector", () => {
  test("finds all isolated balls with confidence", () => {
    const balls = spreadLayout();
    const detector = new BallDetector(MODEL);
    const { detections, occlusion } = detector.detect(renderCanonical(balls));
    expect(occlusion).toBe(false);
    expect(detections.length).toBe(balls.length);
    for (const d of detections) {
      expect(d.confidence).toBeGreaterThan(0.3);
    }
  });

  test("splits the racked reds into ball-sized detections", () => {
    const detector = new BallDetector(MODEL);
    const { detections } = detector.detect(renderCanonical(fullTableLayout()));
    // 15 reds + 7 colours; splitting is approximate, so allow a band.
    expect(detections.length).toBeGreaterThanOrEqual(18);
    expect(detections.length).toBeLessThanOrEqual(26);
  });

  test("flags occlusion for a large foreign object", () => {
    const detector = new BallDetector(MODEL);
    const frame = renderCanonical(spreadLayout(), {
      occlusion: { x: 100, y: 40, w: 60, h: 90 },
    });
    const { occlusion } = detector.detect(frame);
    expect(occlusion).toBe(true);
  });
});

describe("colour classifier", () => {
  test("classifies every ball colour from reference paints", () => {
    const balls = spreadLayout();
    const frame = renderCanonical(balls);
    const classifier = new ColourClassifier(defaultCentroids(), {
      minRadius: MODEL.params.minRadius,
      maxRadius: MODEL.params.maxRadius,
    });
    const detector = new BallDetector(MODEL);
    const { detections } = detector.detect(frame);
    const classified = classifier.classifyAll(frame, detections);
    for (const ball of balls) {
      const hit = classified.find(
        (c) => Math.hypot(c.x - ball.x, c.y - ball.y) < 4,
      );
      expect(hit?.colour).toBe(ball.colour);
    }
  });

  test("CIELAB distance separates snooker colours", () => {
    const red = rgbToLab(200, 30, 30);
    const brown = rgbToLab(130, 70, 30);
    const yellow = rgbToLab(235, 215, 50);
    expect(labDistance(red, brown)).toBeGreaterThan(15);
    expect(labDistance(red, yellow)).toBeGreaterThan(40);
  });
});

describe("temporal consensus", () => {
  test("rejects single-frame flicker, keeps persistent balls", () => {
    const persistent: ClassifiedBall = { colour: "red", x: 100, y: 60, confidence: 0.9 };
    const flicker: ClassifiedBall = { colour: "black", x: 200, y: 100, confidence: 0.5 };
    const frames = [
      [persistent, flicker],
      [persistent],
      [persistent],
      [persistent],
      [persistent],
    ];
    const state = consensusState(frames, 1000);
    expect(state.balls.length).toBe(1);
    expect(state.balls[0]!.colour).toBe("red");
  });
});

describe("hungarian", () => {
  test("finds the minimal assignment", () => {
    const assign = hungarian([
      [10, 1, 8],
      [1, 10, 8],
      [8, 8, 1],
    ]);
    expect(assign).toEqual([1, 0, 2]);
  });

  test("marks unmatched rows when columns run out", () => {
    const assign = hungarian([
      [1, 5],
      [5, 1],
      [3, 3],
    ]);
    expect(assign.filter((a) => a === -1).length).toBe(1);
  });
});

describe("state observer", () => {
  const state = (balls: ClassifiedBall[], t: number) => ({
    timestamp: t,
    balls,
    confidence: 0.9,
  });

  test("emits potted red when a red disappears", () => {
    const before = spreadLayout();
    const after = before.filter((b) => !(b.colour === "red" && b.x === 60));
    const changes = diffStates(state(before, 0), state(after, 1000));
    expect(changes).toContainEqual({ kind: "potted", colour: "red" });
  });

  test("emits potted + respotted for colours", () => {
    const before = spreadLayout();
    const after = before.filter((b) => b.colour !== "black");
    expect(diffStates(state(before, 0), state(after, 1))).toContainEqual({
      kind: "potted",
      colour: "black",
    });
    expect(diffStates(state(after, 1), state(before, 2))).toContainEqual({
      kind: "respotted",
      colour: "black",
    });
  });

  test("small red drift is not a pot; big drift is a move", () => {
    const before = spreadLayout();
    const drifted = before.map((b) =>
      b.colour === "red" && b.x === 120 ? { ...b, x: 121 } : b,
    );
    expect(diffStates(state(before, 0), state(drifted, 1))).toEqual([]);
    const moved = before.map((b) =>
      b.colour === "red" && b.x === 120 ? { ...b, x: 150 } : b,
    );
    expect(diffStates(state(before, 0), state(moved, 1))).toEqual([
      { kind: "moved", colour: "red" },
    ]);
  });

  test("observer returns null until it has two states", () => {
    const obs = new StateObserver();
    expect(obs.observe(state(spreadLayout(), 0))).toBeNull();
    const after = spreadLayout().filter((b) => b.colour !== "blue");
    const shot = obs.observe(state(after, 1000));
    expect(shot).not.toBeNull();
    expect(shot!.changes).toContainEqual({ kind: "potted", colour: "blue" });
  });
});
