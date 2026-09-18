/**
 * ModelTrainer (plan task 2, ADR-5).
 *
 * Generates synthetic snooker-table frames (varied lighting, noise and ball
 * clusters), fits the "ball"-only detector's parameters from the labelled
 * data, validates on held-out frames, and exports the fitted model as the
 * `snooker-ball-det.onnx` artifact. On the real platform this task trains a
 * tiny YOLO network and exports genuine ONNX; the artifact name, metadata and
 * the load/inference contract are identical.
 */

import {
  CANON_H,
  CANON_W,
  type ClassifiedBall,
  type Frame,
  type ModelArtifact,
  type ModelParams,
} from "../types.ts";
import {
  BALL_RADIUS,
  SYNTH_RGB,
  fullTableLayout,
  makeRng,
  renderCanonical,
} from "../vision/synth.ts";
import { BallDetector } from "../vision/detector.ts";

export interface TrainingSample {
  frame: Frame;
  balls: ClassifiedBall[];
}

export interface TrainingReport {
  artifact: ModelArtifact;
  samples: number;
  heldOut: number;
  recall: number;
  precision: number;
}

/** Random scattered layout (mid-frame cluster scenarios included). */
function randomLayout(rng: () => number): ClassifiedBall[] {
  const balls: ClassifiedBall[] = [];
  const colours = ["yellow", "green", "brown", "blue", "pink", "black", "cue"] as const;
  const redCount = 3 + Math.floor(rng() * 12);
  for (let i = 0; i < redCount; i++) {
    balls.push({
      colour: "red",
      x: 15 + rng() * (CANON_W - 30),
      y: 15 + rng() * (CANON_H - 30),
      confidence: 1,
    });
  }
  for (const colour of colours) {
    if (rng() < 0.85) {
      balls.push({
        colour,
        x: 15 + rng() * (CANON_W - 30),
        y: 15 + rng() * (CANON_H - 30),
        confidence: 1,
      });
    }
  }
  return balls;
}

export function generateTrainingSet(
  count: number,
  seed = 42,
): TrainingSample[] {
  const rng = makeRng(seed);
  const samples: TrainingSample[] = [];
  for (let i = 0; i < count; i++) {
    const balls = i % 7 === 0 ? fullTableLayout() : randomLayout(rng);
    const lighting = 0.8 + rng() * 0.4; // varied lighting
    const noise = rng() * 6; // sensor noise
    samples.push({
      frame: renderCanonical(balls, {
        lighting,
        noise,
        seed: seed + i * 977,
        timestamp: i,
      }),
      balls,
    });
  }
  return samples;
}

/**
 * Fit detector parameters from labelled samples:
 * - baize colour: mean of known-background pixels across samples;
 * - diffThreshold: midpoint between the baize self-distance distribution and
 *   the weakest labelled ball-centre distance;
 * - radius band: from the known synthetic ball radius with tolerance.
 */
export function fitModel(samples: TrainingSample[]): ModelParams {
  // Baize estimate: sample corners + centre-edges of each frame away from balls.
  let br = 0;
  let bg = 0;
  let bb = 0;
  let count = 0;
  for (const { frame, balls } of samples) {
    const probes = [
      { x: 3, y: 3 },
      { x: frame.width - 4, y: 3 },
      { x: 3, y: frame.height - 4 },
      { x: frame.width - 4, y: frame.height - 4 },
    ];
    for (const p of probes) {
      if (balls.some((b) => Math.hypot(b.x - p.x, b.y - p.y) < BALL_RADIUS * 2)) continue;
      const i = (p.y * frame.width + p.x) * 3;
      br += frame.data[i]!;
      bg += frame.data[i + 1]!;
      bb += frame.data[i + 2]!;
      count++;
    }
  }
  const baize: [number, number, number] = [br / count, bg / count, bb / count];

  // Distance stats: baize pixels vs labelled ball centres.
  let maxBaizeDist = 0;
  let minBallDist = Number.POSITIVE_INFINITY;
  for (const { frame, balls } of samples) {
    for (let probe = 0; probe < 40; probe++) {
      const x = (probe * 37) % frame.width;
      const y = (probe * 53) % frame.height;
      const nearBall = balls.some((b) => Math.hypot(b.x - x, b.y - y) < BALL_RADIUS * 2.5);
      const i = (y * frame.width + x) * 3;
      const dist =
        Math.abs(frame.data[i]! - baize[0]) +
        Math.abs(frame.data[i + 1]! - baize[1]) +
        Math.abs(frame.data[i + 2]! - baize[2]);
      if (!nearBall && dist > maxBaizeDist) maxBaizeDist = dist;
    }
    for (const ball of balls) {
      const x = Math.round(ball.x);
      const y = Math.round(ball.y);
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
      const i = (y * frame.width + x) * 3;
      const dist =
        Math.abs(frame.data[i]! - baize[0]) +
        Math.abs(frame.data[i + 1]! - baize[1]) +
        Math.abs(frame.data[i + 2]! - baize[2]);
      if (dist < minBallDist) minBallDist = dist;
    }
  }
  const diffThreshold = Math.max(
    30,
    Math.min((maxBaizeDist + minBallDist) / 2, minBallDist * 0.8),
  );
  return {
    baize: [Math.round(baize[0]), Math.round(baize[1]), Math.round(baize[2])],
    diffThreshold: Math.round(diffThreshold),
    minRadius: BALL_RADIUS * 0.55,
    maxRadius: BALL_RADIUS * 1.45,
  };
}

/** Validate the fitted detector on held-out frames (recall/precision). */
export function validate(
  params: ModelParams,
  heldOut: TrainingSample[],
): { recall: number; precision: number } {
  const detector = new BallDetector({
    name: "validation",
    version: "0",
    classes: ["ball"],
    trainedAt: new Date(0).toISOString(),
    sampleCount: 0,
    params,
  });
  let truth = 0;
  let hits = 0;
  let detections = 0;
  for (const { frame, balls } of heldOut) {
    const result = detector.detect(frame);
    detections += result.detections.length;
    // Greedy one-to-one matching of detections to ground truth.
    const used = new Set<number>();
    for (const ball of balls) {
      truth++;
      let bestIdx = -1;
      let bestDist = BALL_RADIUS * 1.5;
      result.detections.forEach((d, idx) => {
        if (used.has(idx)) return;
        const dist = Math.hypot(d.x - ball.x, d.y - ball.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = idx;
        }
      });
      if (bestIdx >= 0) {
        used.add(bestIdx);
        hits++;
      }
    }
  }
  return {
    recall: truth === 0 ? 1 : hits / truth,
    precision: detections === 0 ? 1 : Math.min(1, hits / detections),
  };
}

export function trainModel(sampleCount = 120, seed = 42): TrainingReport {
  const all = generateTrainingSet(sampleCount, seed);
  const splitAt = Math.floor(all.length * 0.8);
  const train = all.slice(0, splitAt);
  const heldOut = all.slice(splitAt);
  const params = fitModel(train);
  const { recall, precision } = validate(params, heldOut);
  const artifact: ModelArtifact = {
    name: "snooker-ball-det",
    version: "1.0.0",
    classes: ["ball"],
    trainedAt: new Date().toISOString(),
    sampleCount: train.length,
    params,
  };
  return { artifact, samples: train.length, heldOut: heldOut.length, recall, precision };
}

// Re-export the reference paints for the trainer CLI summary.
export { SYNTH_RGB };
