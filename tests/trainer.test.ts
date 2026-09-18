/**
 * ModelTrainer unit tests (plan test plan bullet 2; FR-1, FR-9): the exported
 * artifact must produce bounding-boxes-plus-confidence output on test images
 * and round-trip through the artifact store.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, MODEL_ARTIFACT_NAME } from "../src/platform/artifacts.ts";
import { BallDetector } from "../src/vision/detector.ts";
import { renderCanonical } from "../src/vision/synth.ts";
import { generateTrainingSet, trainModel } from "../src/trainer/trainer.ts";

describe("ModelTrainer", () => {
  const report = trainModel(60);

  test("meets the quality gate on held-out frames", () => {
    expect(report.recall).toBeGreaterThanOrEqual(0.95);
    expect(report.precision).toBeGreaterThanOrEqual(0.95);
  });

  test("artifact declares the single 'ball' class with fitted params", () => {
    expect(report.artifact.name).toBe("snooker-ball-det");
    expect(report.artifact.classes).toEqual(["ball"]);
    expect(report.artifact.params.diffThreshold).toBeGreaterThan(0);
    expect(report.artifact.params.minRadius).toBeLessThan(report.artifact.params.maxRadius);
  });

  test("detector loaded from the artifact emits boxes + confidence", () => {
    const detector = new BallDetector(report.artifact);
    const frame = renderCanonical([
      { colour: "red", x: 100, y: 60, confidence: 1 },
      { colour: "cue", x: 200, y: 100, confidence: 1 },
    ]);
    const { detections } = detector.detect(frame);
    expect(detections.length).toBe(2);
    for (const d of detections) {
      expect(d.r).toBeGreaterThan(0);
      expect(d.confidence).toBeGreaterThan(0);
      expect(d.confidence).toBeLessThanOrEqual(1);
    }
  });

  test("training set varies lighting and includes clustered layouts", () => {
    const set = generateTrainingSet(30);
    expect(set.length).toBe(30);
    // Rack frames (every 7th) contain 22 balls.
    expect(set[0]!.balls.length).toBe(22);
  });

  test("artifact round-trips through the store; missing artifact fails loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "snooker-artifacts-"));
    try {
      const store = new ArtifactStore(dir);
      expect(() => store.readModel()).toThrow(/Model artifact missing/);
      store.writeModel(report.artifact);
      expect(store.has(MODEL_ARTIFACT_NAME)).toBe(true);
      const loaded = store.readModel();
      expect(loaded.params).toEqual(report.artifact.params);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
