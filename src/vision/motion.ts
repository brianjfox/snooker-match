/**
 * MotionDetector (plan task 4).
 *
 * Cheap grayscale mean-absolute-difference between consecutive rectified
 * frames. The table is declared STABLE once the diff stays below threshold
 * for `stableMs` (750 ms by default). This gates ONNX inference so the
 * detector only runs 1-2 times per shot (NFR-3).
 */

import type { Frame, MotionPhase } from "../types.ts";

export interface MotionDetectorOptions {
  /** Mean per-pixel grayscale diff above which the table counts as moving. */
  threshold?: number;
  /** How long the diff must stay below threshold to declare STABLE. */
  stableMs?: number;
}

export class MotionDetector {
  private readonly threshold: number;
  private readonly stableMs: number;
  private previousGray: Float32Array | null = null;
  private belowSince: number | null = null;
  private phase: MotionPhase = "settling";

  constructor(opts: MotionDetectorOptions = {}) {
    this.threshold = opts.threshold ?? 1.5;
    this.stableMs = opts.stableMs ?? 750;
  }

  /** Mean absolute grayscale difference between this frame and the previous. */
  score(frame: Frame): number {
    const gray = toGray(frame);
    if (this.previousGray === null || this.previousGray.length !== gray.length) {
      this.previousGray = gray;
      return Number.POSITIVE_INFINITY; // first frame: unknown, treat as moving
    }
    let sum = 0;
    for (let i = 0; i < gray.length; i++) {
      sum += Math.abs(gray[i]! - this.previousGray[i]!);
    }
    this.previousGray = gray;
    return sum / gray.length;
  }

  /**
   * Feed the next frame; returns the phase after this frame plus whether the
   * table JUST became stable (the trigger to run detection).
   */
  update(frame: Frame): { phase: MotionPhase; becameStable: boolean } {
    const diff = this.score(frame);
    const moving = diff > this.threshold;
    let becameStable = false;
    if (moving) {
      this.belowSince = null;
      this.phase = "moving";
    } else {
      if (this.belowSince === null) this.belowSince = frame.timestamp;
      const settledFor = frame.timestamp - this.belowSince;
      if (settledFor >= this.stableMs) {
        if (this.phase !== "stable") becameStable = true;
        this.phase = "stable";
      } else {
        this.phase = "settling";
      }
    }
    return { phase: this.phase, becameStable };
  }

  reset(): void {
    this.previousGray = null;
    this.belowSince = null;
    this.phase = "settling";
  }
}

export function toGray(frame: Frame): Float32Array {
  const n = frame.width * frame.height;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    gray[i] =
      0.299 * frame.data[j]! + 0.587 * frame.data[j + 1]! + 0.114 * frame.data[j + 2]!;
  }
  return gray;
}
