/**
 * Synthetic frame generation — used by the ModelTrainer (training data), the
 * SimulatedCameraSidecar (live demo feed on hosts with no camera), and tests.
 */

import {
  CANON_W,
  CANON_H,
  RAW_W,
  RAW_H,
  type BallColour,
  type ClassifiedBall,
  type Frame,
  type Point,
} from "../types.ts";

/** Reference RGB paints used by the synthesizer. */
export const SYNTH_RGB: Record<BallColour | "baize", [number, number, number]> = {
  baize: [30, 115, 70],
  red: [200, 30, 30],
  yellow: [235, 215, 50],
  green: [0, 80, 25],
  brown: [130, 70, 30],
  blue: [30, 60, 200],
  pink: [235, 130, 160],
  black: [15, 15, 15],
  cue: [240, 240, 220],
};

export const BALL_RADIUS = 5;

/** Standard spot positions in canonical coordinates (top-down, baulk left). */
export const SPOTS: Record<Exclude<BallColour, "red">, Point> = {
  yellow: { x: 66, y: 110 },
  green: { x: 66, y: 50 },
  brown: { x: 66, y: 80 },
  blue: { x: 160, y: 80 },
  pink: { x: 240, y: 80 },
  black: { x: 293, y: 80 },
  cue: { x: 48, y: 80 },
};

/** The 15-red triangle racked behind the pink spot. */
export function redRack(): Point[] {
  const points: Point[] = [];
  const startX = 248;
  let placed = 0;
  for (let row = 0; row < 5 && placed < 15; row++) {
    const x = startX + row * (BALL_RADIUS * 2 - 1);
    for (let i = 0; i <= row && placed < 15; i++) {
      const y = 80 + (i - row / 2) * (BALL_RADIUS * 2 + 1);
      points.push({ x, y: Math.round(y) });
      placed++;
    }
  }
  return points;
}

/** Full break-off table layout: 15 reds racked + all colours on spots. */
export function fullTableLayout(): ClassifiedBall[] {
  const balls: ClassifiedBall[] = [];
  for (const p of redRack()) {
    balls.push({ colour: "red", x: p.x, y: p.y, confidence: 1 });
  }
  for (const [colour, p] of Object.entries(SPOTS)) {
    balls.push({ colour: colour as BallColour, x: p.x, y: p.y, confidence: 1 });
  }
  return balls;
}

/** Deterministic seeded RNG (mulberry32) for reproducible noise. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthOptions {
  /** Per-channel uniform noise amplitude (0 = clean). */
  noise?: number;
  /** RNG seed for the noise. */
  seed?: number;
  timestamp?: number;
  /** Simulated lighting multiplier applied to every pixel (1 = neutral). */
  lighting?: number;
  /** Paint a large foreign blob (e.g. a player's arm) over the table. */
  occlusion?: { x: number; y: number; w: number; h: number } | null;
}

function fill(
  frame: Frame,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number],
): void {
  for (let y = Math.max(0, y0); y < Math.min(frame.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(frame.width, x1); x++) {
      const i = (y * frame.width + x) * 3;
      frame.data[i] = rgb[0];
      frame.data[i + 1] = rgb[1];
      frame.data[i + 2] = rgb[2];
    }
  }
}

function drawCircle(
  frame: Frame,
  cx: number,
  cy: number,
  r: number,
  rgb: [number, number, number],
): void {
  const r2 = r * r;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(frame.height - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(frame.width - 1, Math.ceil(cx + r)); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        const i = (y * frame.width + x) * 3;
        frame.data[i] = rgb[0];
        frame.data[i + 1] = rgb[1];
        frame.data[i + 2] = rgb[2];
      }
    }
  }
}

/** Render a canonical (rectified, top-down) table frame with the given balls. */
export function renderCanonical(
  balls: ClassifiedBall[],
  opts: SynthOptions = {},
): Frame {
  const { noise = 0, seed = 1, timestamp = 0, lighting = 1, occlusion = null } = opts;
  const frame: Frame = {
    width: CANON_W,
    height: CANON_H,
    data: new Uint8Array(CANON_W * CANON_H * 3),
    timestamp,
  };
  fill(frame, 0, 0, CANON_W, CANON_H, SYNTH_RGB.baize);
  for (const ball of balls) {
    drawCircle(frame, ball.x, ball.y, BALL_RADIUS, SYNTH_RGB[ball.colour]);
  }
  if (occlusion) {
    fill(
      frame,
      occlusion.x,
      occlusion.y,
      occlusion.x + occlusion.w,
      occlusion.y + occlusion.h,
      [90, 70, 60], // skin/sleeve-ish foreign object
    );
  }
  if (lighting !== 1 || noise > 0) {
    const rng = makeRng(seed);
    for (let i = 0; i < frame.data.length; i++) {
      let v = frame.data[i]! * lighting;
      if (noise > 0) v += (rng() * 2 - 1) * noise;
      frame.data[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return frame;
}

/**
 * The fixed trapezoid the simulated camera sees the table at, inside a 16:9
 * raw frame (slightly off-axis, as a real overhead mount would be).
 * Order: TL, TR, BR, BL — matching the guided corner-tap sequence.
 */
export const SIM_TABLE_CORNERS: [Point, Point, Point, Point] = [
  { x: 24, y: 18 },
  { x: 296, y: 14 },
  { x: 306, y: 168 },
  { x: 14, y: 164 },
];

/**
 * Render a raw camera frame: dark venue background with the canonical table
 * content projected into SIM_TABLE_CORNERS. Uses bilinear-free nearest
 * neighbour sampling, which is adequate at this resolution.
 */
export function renderRaw(
  canonical: Frame,
  corners: [Point, Point, Point, Point] = SIM_TABLE_CORNERS,
  timestamp = canonical.timestamp,
): Frame {
  // Homography canonical -> raw, computed inline to avoid a circular import.
  // (The vision pipeline computes raw -> canonical from corner taps; here we
  // need the forward projection to paint the raw frame.)
  const frame: Frame = {
    width: RAW_W,
    height: RAW_H,
    data: new Uint8Array(RAW_W * RAW_H * 3),
    timestamp,
  };
  fill(frame, 0, 0, RAW_W, RAW_H, [18, 16, 20]);
  // Inverse-map each raw pixel into canonical space via the raw->canonical
  // homography of the corner correspondence.
  const H = homographyFromCorners(corners);
  for (let y = 0; y < RAW_H; y++) {
    for (let x = 0; x < RAW_W; x++) {
      const w = H[6]! * x + H[7]! * y + H[8]!;
      const cx = (H[0]! * x + H[1]! * y + H[2]!) / w;
      const cy = (H[3]! * x + H[4]! * y + H[5]!) / w;
      const sx = Math.round(cx);
      const sy = Math.round(cy);
      if (sx >= 0 && sx < canonical.width && sy >= 0 && sy < canonical.height) {
        const si = (sy * canonical.width + sx) * 3;
        const di = (y * RAW_W + x) * 3;
        frame.data[di] = canonical.data[si]!;
        frame.data[di + 1] = canonical.data[si + 1]!;
        frame.data[di + 2] = canonical.data[si + 2]!;
      }
    }
  }
  return frame;
}

// Minimal local DLT for the synthesizer (the real one lives in homography.ts).
function homographyFromCorners(
  corners: [Point, Point, Point, Point],
): number[] {
  const dst: Point[] = [
    { x: 0, y: 0 },
    { x: CANON_W, y: 0 },
    { x: CANON_W, y: CANON_H },
    { x: 0, y: CANON_H },
  ];
  return solveDlt(corners, dst);
}

/** Solve for H (raw src -> dst) from 4 correspondences via DLT + elimination. */
export function solveDlt(src: Point[], dst: Point[]): number[] {
  // Build the 8x9 system A h = 0 with h33 = 1 -> 8x8 linear system.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i]!;
    const d = dst[i]!;
    A.push([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x]);
    b.push(d.x);
    A.push([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y]);
    b.push(d.y);
  }
  const h = gaussianSolve(A, b);
  return [...h, 1];
}

function gaussianSolve(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row]![col]!) > Math.abs(M[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) {
      throw new Error("Degenerate corner configuration: cannot solve homography");
    }
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    for (let row = col + 1; row < n; row++) {
      const f = M[row]![col]! / M[col]![col]!;
      for (let k = col; k <= n; k++) M[row]![k]! -= f * M[col]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row]![n]!;
    for (let k = row + 1; k < n; k++) sum -= M[row]![k]! * x[k]!;
    x[row] = sum / M[row]![row]!;
  }
  return x;
}
