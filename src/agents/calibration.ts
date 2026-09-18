/**
 * CalibrationAgent + CalibrationStep (plan tasks 3 and 12; FR-9, AC-7).
 *
 * Single guided sequence driven from the UI:
 *  1. Operator taps the four table corners (TL, TR, BR, BL) on the raw camera
 *     view -> homography to canonical coordinates.
 *  2. With the balls on their spots (standard break-off layout), the agent
 *     samples the rectified frame at the known spot positions and learns the
 *     per-table CIELAB colour centroids (adaptive to venue lighting).
 *  3. "Begin calibration" captures labelled frames into the fine-tuning
 *     buffer and bumps the model calibration suffix shown in system status.
 */

import {
  BALL_COLOURS,
  type BallColour,
  type ColourCentroids,
  type Frame,
  type Point,
} from "../types.ts";
import type { WorkflowState } from "../platform/state.ts";
import { computeHomography } from "../vision/homography.ts";
import { centralCropMean, labDistance, rgbToLab } from "../vision/colour.ts";
import { BALL_RADIUS, SPOTS, SYNTH_RGB, redRack } from "../vision/synth.ts";

/** Canonical sample positions for the guided spot-placement step. */
export function spotSamplePositions(): Record<BallColour, Point> {
  const rack = redRack();
  return {
    red: rack[0]!, // apex red of the rack
    yellow: SPOTS.yellow,
    green: SPOTS.green,
    brown: SPOTS.brown,
    blue: SPOTS.blue,
    pink: SPOTS.pink,
    black: SPOTS.black,
    cue: SPOTS.cue,
  };
}

/** Default centroids from reference paints — used until calibration runs. */
export function defaultCentroids(): ColourCentroids {
  const out = {} as ColourCentroids;
  for (const colour of BALL_COLOURS) {
    const [r, g, b] = SYNTH_RGB[colour];
    out[colour] = rgbToLab(r, g, b);
  }
  return out;
}

export class CalibrationAgent {
  constructor(private readonly state: WorkflowState) {}

  /** Step 1: four corner taps -> homography into workflow state. */
  setCorners(corners: [Point, Point, Point, Point], now: number): void {
    const homography = computeHomography(corners);
    this.state.mutate((data) => {
      data.now = now;
      data.calibration.corners = corners;
      data.calibration.homography = homography;
      this.state.log(
        "CALIBRATION",
        "human",
        "Table corners set — homography computed",
        { corners: corners.map((c) => ({ ...c })) },
      );
    });
  }

  /**
   * Step 2: learn CIELAB centroids from a rectified frame with balls on
   * spots. Each sample is sanity-checked: if the sampled patch looks more
   * like the baize than like the reference paint for that colour (i.e. the
   * spot is empty or mis-placed), the prior/default centroid is kept instead
   * of poisoning the classifier.
   */
  learnCentroids(rectified: Frame, now: number): ColourCentroids {
    const positions = spotSamplePositions();
    const defaults = this.state.data.calibration.centroids ?? defaultCentroids();
    const baizeLab = rgbToLab(...SYNTH_RGB.baize);
    const centroids = {} as ColourCentroids;
    const skipped: string[] = [];
    for (const colour of BALL_COLOURS) {
      const p = positions[colour];
      const [r, g, b] = centralCropMean(rectified, {
        x: p.x,
        y: p.y,
        r: BALL_RADIUS,
        confidence: 1,
      });
      const sample = rgbToLab(r, g, b);
      const toReference = labDistance(sample, defaults[colour]);
      const toBaize = labDistance(sample, baizeLab);
      if (colour !== "green" && toBaize < toReference) {
        // Spot looks empty: keep the prior centroid for this colour.
        centroids[colour] = defaults[colour];
        skipped.push(colour);
      } else {
        centroids[colour] = sample;
      }
    }
    this.state.mutate((data) => {
      data.now = now;
      data.calibration.centroids = centroids;
      data.calibration.calibratedAt = now;
      data.status.calibrated = true;
      this.state.log(
        "CALIBRATION",
        "human",
        skipped.length === 0
          ? "Colour centroids learned from spot placements"
          : `Colour centroids learned; kept prior centroids for empty spots: ${skipped.join(", ")}`,
      );
    });
    return centroids;
  }

  /**
   * Step 3 (CalibrationStep): capture labelled frames for fine-tuning and
   * update the model name shown in system status (AC-7). Each captured frame
   * lands in the fine-tuning buffer (the same buffer corrections feed,
   * FR-9/FR-12) as a downsampled snapshot of the rectified view labelled with
   * the latest detections. In this local build the sidecar exposes one live
   * rectified frame, so a capture run stores that snapshot per frame counted.
   */
  beginCalibration(framesCaptured: number, rectified: Frame, now: number): void {
    const frame = downsample(rectified, SNAPSHOT_DOWNSAMPLE);
    this.state.mutate((data) => {
      data.now = now;
      data.calibration.capturedFrames += framesCaptured;
      for (let i = 0; i < framesCaptured; i++) {
        data.fineTuningBuffer.push({
          timestamp: now,
          correction: null,
          tableState: data.latestTableState,
          modelName: data.status.modelName,
          frame,
        });
      }
      const base = data.status.modelName.replace(/ \(cal #\d+\)$/, "");
      const calCount =
        (Number(/ \(cal #(\d+)\)$/.exec(data.status.modelName)?.[1]) || 0) + 1;
      data.status.modelName = `${base} (cal #${calCount})`;
      this.state.log(
        "CALIBRATION",
        "human",
        `Calibration capture complete: ${framesCaptured} labelled frames stored for fine-tuning. Model now ${data.status.modelName}`,
        { framesCaptured, totalCaptured: data.calibration.capturedFrames },
      );
    });
  }
}

/** Linear downsample factor for stored calibration snapshots. */
const SNAPSHOT_DOWNSAMPLE = 4;

/** Nearest-neighbour downsample of an RGB frame (keeps the buffer small). */
function downsample(frame: Frame, factor: number): Frame {
  const width = Math.max(1, Math.floor(frame.width / factor));
  const height = Math.max(1, Math.floor(frame.height / factor));
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * factor * frame.width + x * factor) * 3;
      const dst = (y * width + x) * 3;
      data[dst] = frame.data[src]!;
      data[dst + 1] = frame.data[src + 1]!;
      data[dst + 2] = frame.data[src + 2]!;
    }
  }
  return { width, height, data, timestamp: frame.timestamp };
}
