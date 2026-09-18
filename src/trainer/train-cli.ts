/**
 * ModelTrainer CLI (plan task 2): `bun run train`
 *
 * Trains the "ball"-only detector from synthetic labelled frames, validates
 * on a held-out split, and stores snooker-ball-det.onnx in the artifact
 * store. The workflow refuses to start without this artifact (ADR-3/5).
 */

import { ArtifactStore, MODEL_ARTIFACT_NAME } from "../platform/artifacts.ts";
import { trainModel } from "./trainer.ts";

const artifactsDir = process.env.ARTIFACTS_DIR ?? "artifacts";
const samples = Number(process.argv[2] ?? 120);

console.log(`ModelTrainer: generating ${samples} synthetic labelled frames...`);
const report = trainModel(samples);

console.log(`  trained on:   ${report.samples} frames`);
console.log(`  held out:     ${report.heldOut} frames`);
console.log(`  recall:       ${(report.recall * 100).toFixed(1)}%`);
console.log(`  precision:    ${(report.precision * 100).toFixed(1)}%`);
console.log(`  params:       ${JSON.stringify(report.artifact.params)}`);

if (report.recall < 0.95 || report.precision < 0.95) {
  console.error(
    "Training failed quality gate (recall/precision must both be >= 95%). " +
      "Artifact NOT stored.",
  );
  process.exit(1);
}

const store = new ArtifactStore(artifactsDir);
const path = store.writeModel(report.artifact);
console.log(`Stored ${MODEL_ARTIFACT_NAME} -> ${path}`);
