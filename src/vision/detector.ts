/**
 * DetectionAgent (plan task 5).
 *
 * Runs the "ball"-only detector on stable rectified frames and returns
 * bounding circles with per-object confidence, plus an occlusion signal when
 * a large foreign object covers part of the playing surface (FR-1, FR-6).
 *
 * The detector interface is pluggable: on Android the artifact is a real
 * YOLO-style ONNX network run by onnxruntime; in this build the artifact
 * carries fitted blob-detector parameters produced by the ModelTrainer. Both
 * satisfy the same contract: Frame in, {detections, occlusion} out.
 */

import type { Detection, Frame, ModelArtifact, ModelParams } from "../types.ts";

export interface DetectionResult {
  detections: Detection[];
  /** True when a foreign object much larger than a ball is on the surface. */
  occlusion: boolean;
  /** Mean confidence across detections (1 when no balls detected). */
  meanConfidence: number;
}

export interface Detector {
  readonly modelName: string;
  readonly modelVersion: string;
  detect(frame: Frame): DetectionResult;
}

/** How many ball-radii wide a blob must be to be considered an occluder. */
const OCCLUSION_RADIUS_FACTOR = 3;

export class BallDetector implements Detector {
  readonly modelName: string;
  readonly modelVersion: string;
  private readonly params: ModelParams;

  constructor(artifact: ModelArtifact) {
    this.modelName = artifact.name;
    this.modelVersion = artifact.version;
    this.params = artifact.params;
  }

  detect(frame: Frame): DetectionResult {
    const { baize, diffThreshold, minRadius, maxRadius } = this.params;
    const { width, height, data } = frame;
    const n = width * height;
    // 1. Mask pixels that differ from the baize colour.
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const dist =
        Math.abs(data[j]! - baize[0]) +
        Math.abs(data[j + 1]! - baize[1]) +
        Math.abs(data[j + 2]! - baize[2]);
      mask[i] = dist > diffThreshold ? 1 : 0;
    }
    // 2. Connected components (4-connectivity, iterative flood fill).
    const seen = new Uint8Array(n);
    const detections: Detection[] = [];
    let occlusion = false;
    const stack: number[] = [];
    const mid = (minRadius + maxRadius) / 2;
    const halfBand = Math.max((maxRadius - minRadius) / 2, 0.5);
    for (let start = 0; start < n; start++) {
      if (mask[start] !== 1 || seen[start] === 1) continue;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;
      const pixels: number[] = []; // packed x,y pairs for blob splitting
      stack.length = 0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length > 0) {
        const idx = stack.pop()!;
        const x = idx % width;
        const y = (idx / width) | 0;
        area++;
        sumX += x;
        sumY += y;
        pixels.push(x, y);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0 && mask[idx - 1] === 1 && seen[idx - 1] === 0) {
          seen[idx - 1] = 1;
          stack.push(idx - 1);
        }
        if (x < width - 1 && mask[idx + 1] === 1 && seen[idx + 1] === 0) {
          seen[idx + 1] = 1;
          stack.push(idx + 1);
        }
        if (y > 0 && mask[idx - width] === 1 && seen[idx - width] === 0) {
          seen[idx - width] = 1;
          stack.push(idx - width);
        }
        if (y < height - 1 && mask[idx + width] === 1 && seen[idx + width] === 0) {
          seen[idx + width] = 1;
          stack.push(idx + width);
        }
      }
      if (area < 3) continue; // speckle noise
      const r = Math.sqrt(area / Math.PI);
      if (r > maxRadius * OCCLUSION_RADIUS_FACTOR) {
        occlusion = true;
        continue;
      }
      if (r < minRadius * 0.5) continue; // sub-ball speckle
      if (r > maxRadius * 1.2) {
        // Touching/clustered balls (e.g. the racked reds) merge into one
        // component. Split via k-means with k estimated from the blob area.
        for (const d of splitCluster(pixels, area, mid, minRadius, maxRadius)) {
          detections.push(d);
        }
        continue;
      }
      const cx = sumX / area;
      const cy = sumY / area;
      // Confidence: circularity (blob area vs bounding-box ellipse area) times
      // how well the radius fits the trained ball-size band.
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const circularity = Math.min(1, area / ((Math.PI / 4) * bw * bh));
      const sizeFit = Math.max(0, 1 - Math.abs(r - mid) / (halfBand * 3));
      const confidence = Math.max(0.05, Math.min(1, circularity * (0.35 + 0.65 * sizeFit)));
      detections.push({ x: cx, y: cy, r, confidence });
    }
    const meanConfidence =
      detections.length === 0
        ? 1
        : detections.reduce((s, d) => s + d.confidence, 0) / detections.length;
    return { detections, occlusion, meanConfidence };
  }
}

/**
 * Split a merged blob (touching balls) into k detections via k-means on the
 * blob's pixels. k is estimated from the blob area divided by the trained
 * single-ball area, slightly inflated because touching circles overlap.
 */
function splitCluster(
  pixels: number[],
  area: number,
  mid: number,
  minRadius: number,
  maxRadius: number,
): Detection[] {
  const singleArea = Math.PI * mid * mid;
  const k = Math.max(2, Math.min(24, Math.round((area / singleArea) * 1.15)));
  const count = pixels.length / 2;
  // Init centres spread across the blob (deterministic strided picks).
  const centres: { x: number; y: number }[] = [];
  for (let i = 0; i < k; i++) {
    const p = Math.floor((i + 0.5) * (count / k)) * 2;
    centres.push({ x: pixels[p]!, y: pixels[p + 1]! });
  }
  const assign = new Int32Array(count);
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    for (let i = 0; i < count; i++) {
      const x = pixels[i * 2]!;
      const y = pixels[i * 2 + 1]!;
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < k; c++) {
        const dx = x - centres[c]!.x;
        const dy = y - centres[c]!.y;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    const sums = centres.map(() => ({ x: 0, y: 0, n: 0 }));
    for (let i = 0; i < count; i++) {
      const s = sums[assign[i]!]!;
      s.x += pixels[i * 2]!;
      s.y += pixels[i * 2 + 1]!;
      s.n++;
    }
    for (let c = 0; c < k; c++) {
      const s = sums[c]!;
      if (s.n > 0) {
        centres[c] = { x: s.x / s.n, y: s.y / s.n };
      }
    }
    if (!changed) break;
  }
  // Emit one detection per non-empty cluster of plausible ball size.
  const clusterAreas = new Array<number>(k).fill(0);
  for (let i = 0; i < count; i++) clusterAreas[assign[i]!]!++;
  const out: Detection[] = [];
  for (let c = 0; c < k; c++) {
    const ca = clusterAreas[c]!;
    if (ca < 3) continue;
    const r = Math.sqrt(ca / Math.PI);
    if (r < minRadius * 0.4 || r > maxRadius * 1.6) continue;
    // Split detections are inherently less certain than isolated balls.
    const sizeFit = Math.max(0, 1 - Math.abs(r - mid) / Math.max(maxRadius - mid, 1));
    out.push({
      x: centres[c]!.x,
      y: centres[c]!.y,
      r,
      confidence: Math.max(0.05, Math.min(0.85, 0.45 + 0.4 * sizeFit)),
    });
  }
  return out;
}
