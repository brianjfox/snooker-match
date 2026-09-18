/**
 * ArtifactStore — local shim for @corbits/artifacts.
 *
 * Stores named artifacts as files under an artifacts directory. The workflow
 * loads `snooker-ball-det.onnx` from here at start (plan ADR-3). On the real
 * platform this is the hosted artifact registry; only the read/write calls
 * change.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelArtifact } from "../types.ts";

export const MODEL_ARTIFACT_NAME = "snooker-ball-det.onnx";

export class ArtifactStore {
  constructor(readonly dir: string) {}

  private pathFor(name: string): string {
    return join(this.dir, name);
  }

  has(name: string): boolean {
    return existsSync(this.pathFor(name));
  }

  writeModel(artifact: ModelArtifact): string {
    mkdirSync(this.dir, { recursive: true });
    const path = this.pathFor(MODEL_ARTIFACT_NAME);
    writeFileSync(path, JSON.stringify(artifact, null, 2));
    return path;
  }

  readModel(): ModelArtifact {
    const path = this.pathFor(MODEL_ARTIFACT_NAME);
    if (!existsSync(path)) {
      throw new Error(
        `Model artifact missing: ${path}. Run \`bun run train\` first to build ` +
          `and store ${MODEL_ARTIFACT_NAME}.`,
      );
    }
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ModelArtifact;
    if (!parsed.name || !parsed.params || parsed.classes?.[0] !== "ball") {
      throw new Error(`Model artifact at ${path} is malformed.`);
    }
    return parsed;
  }
}
