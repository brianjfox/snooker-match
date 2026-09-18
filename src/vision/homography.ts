/**
 * Perspective homography (plan: CalibrationAgent geometry core).
 *
 * computeHomography maps four raw-frame corner taps (TL, TR, BR, BL order) to
 * the canonical table rectangle. rectify() resamples a raw frame into
 * canonical space. On Android this is OpenCV's getPerspectiveTransform /
 * warpPerspective; here it is a direct DLT solve, same math.
 */

import {
  CANON_W,
  CANON_H,
  type Frame,
  type Homography,
  type Point,
} from "../types.ts";
import { solveDlt } from "./synth.ts";

export const CANONICAL_CORNERS: [Point, Point, Point, Point] = [
  { x: 0, y: 0 },
  { x: CANON_W, y: 0 },
  { x: CANON_W, y: CANON_H },
  { x: 0, y: CANON_H },
];

/** Homography mapping raw camera points to canonical table points. */
export function computeHomography(
  corners: [Point, Point, Point, Point],
): Homography {
  return solveDlt(corners, CANONICAL_CORNERS) as Homography;
}

/** Apply H to a point. */
export function applyHomography(H: Homography, p: Point): Point {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

/** Invert a 3x3 homography. */
export function invertHomography(H: Homography): Homography {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("Homography is singular");
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

/** Resample a raw frame into the canonical top-down view using H (raw->canon). */
export function rectify(raw: Frame, H: Homography): Frame {
  const inv = invertHomography(H);
  const out: Frame = {
    width: CANON_W,
    height: CANON_H,
    data: new Uint8Array(CANON_W * CANON_H * 3),
    timestamp: raw.timestamp,
  };
  for (let y = 0; y < CANON_H; y++) {
    for (let x = 0; x < CANON_W; x++) {
      const p = applyHomography(inv, { x, y });
      const sx = Math.round(p.x);
      const sy = Math.round(p.y);
      if (sx >= 0 && sx < raw.width && sy >= 0 && sy < raw.height) {
        const si = (sy * raw.width + sx) * 3;
        const di = (y * CANON_W + x) * 3;
        out.data[di] = raw.data[si]!;
        out.data[di + 1] = raw.data[si + 1]!;
        out.data[di + 2] = raw.data[si + 2]!;
      }
    }
  }
  return out;
}
