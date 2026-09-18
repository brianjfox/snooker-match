/**
 * ColourClassifier (plan task 6).
 *
 * Central-crops each detection, converts the mean crop colour to CIELAB and
 * assigns the nearest learned centroid (red/yellow/green/brown/blue/pink/
 * black/cue). Centroids are learned per-table at calibration from the spot
 * placements, so lighting changes move the centroids with the table (FR-1).
 * A size sanity check against the expected ball radius reduces confidence for
 * implausible blobs.
 */

import {
  BALL_COLOURS,
  type BallColour,
  type ClassifiedBall,
  type ColourCentroids,
  type Detection,
  type Frame,
  type Lab,
} from "../types.ts";

// ---------------------------------------------------------------------------
// sRGB -> CIELAB (D65)
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  // sRGB D65 reference white
  const x = (0.4124 * rl + 0.3576 * gl + 0.1805 * bl) / 0.95047;
  const y = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
  const z = (0.0193 * rl + 0.1192 * gl + 0.9505 * bl) / 1.08883;
  const f = (t: number) =>
    t > 0.008856 ? Math.cbrt(t) : (903.3 * t + 16) / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labDistance(p: Lab, q: Lab): number {
  const dL = p.L - q.L;
  const da = p.a - q.a;
  const db = p.b - q.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** Mean RGB of the central crop (half-radius box) of a detection. */
export function centralCropMean(
  frame: Frame,
  det: Detection,
): [number, number, number] {
  const half = Math.max(1, Math.floor(det.r / 2));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let count = 0;
  const cx = Math.round(det.x);
  const cy = Math.round(det.y);
  for (let y = Math.max(0, cy - half); y <= Math.min(frame.height - 1, cy + half); y++) {
    for (let x = Math.max(0, cx - half); x <= Math.min(frame.width - 1, cx + half); x++) {
      const i = (y * frame.width + x) * 3;
      sr += frame.data[i]!;
      sg += frame.data[i + 1]!;
      sb += frame.data[i + 2]!;
      count++;
    }
  }
  if (count === 0) return [0, 0, 0];
  return [sr / count, sg / count, sb / count];
}

export interface ColourClassifierOptions {
  /** Expected ball radius band in canonical units for the sanity check. */
  minRadius: number;
  maxRadius: number;
}

export class ColourClassifier {
  constructor(
    private centroids: ColourCentroids,
    private readonly opts: ColourClassifierOptions,
  ) {}

  setCentroids(centroids: ColourCentroids): void {
    this.centroids = centroids;
  }

  classify(frame: Frame, det: Detection): ClassifiedBall {
    const [r, g, b] = centralCropMean(frame, det);
    const lab = rgbToLab(r, g, b);
    let best: BallColour = "red";
    let bestDist = Number.POSITIVE_INFINITY;
    let secondDist = Number.POSITIVE_INFINITY;
    for (const colour of BALL_COLOURS) {
      const d = labDistance(lab, this.centroids[colour]);
      if (d < bestDist) {
        secondDist = bestDist;
        bestDist = d;
        best = colour;
      } else if (d < secondDist) {
        secondDist = d;
      }
    }
    // Margin-based colour confidence: 1 when unambiguous, ->0 when the two
    // nearest centroids are equidistant.
    const margin =
      secondDist === Number.POSITIVE_INFINITY
        ? 1
        : Math.max(0, Math.min(1, (secondDist - bestDist) / Math.max(secondDist, 1e-6)));
    // Size sanity check (plan: "sanity check against expected ball size").
    const { minRadius, maxRadius } = this.opts;
    const sizeOk = det.r >= minRadius * 0.6 && det.r <= maxRadius * 1.5;
    const sizeFactor = sizeOk ? 1 : 0.4;
    const confidence = Math.max(
      0.02,
      Math.min(1, det.confidence * (0.4 + 0.6 * margin) * sizeFactor),
    );
    return { colour: best, x: det.x, y: det.y, confidence };
  }

  classifyAll(frame: Frame, detections: Detection[]): ClassifiedBall[] {
    return detections.map((d) => this.classify(frame, d));
  }
}
