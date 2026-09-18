/**
 * Packaging step (plan task 16): builds the Android-deployable workflow
 * bundle. Emits a single-file JS bundle plus a manifest describing the
 * sidecar allocation (CameraX) and the model artifact the workflow loads at
 * start. On the real platform this bundle is what gets sideloaded to the
 * tablet.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MODEL_ARTIFACT_NAME } from "../src/platform/artifacts.ts";

const outDir = "dist";
mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: outDir,
  target: "bun",
  minify: false,
});
if (!result.success) {
  console.error("Bundle failed:");
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}

const manifest = {
  name: "snooker-match",
  version: "1.0.0",
  entry: "main.js",
  targets: ["android-tablet"],
  sidecars: [
    {
      id: "camera",
      kind: "camerax-imageanalysis",
      strategy: "STRATEGY_KEEP_ONLY_LATEST",
      fps: 30,
      permissions: ["android.permission.CAMERA"],
    },
  ],
  artifacts: [{ name: MODEL_ARTIFACT_NAME, loadAt: "workflow-start" }],
  grants: {
    operator: ["read", "correct"],
    viewer: ["read"],
  },
  hub: { port: 4750, pages: ["/", "/tv"], api: ["/api/state", "/api/events", "/api/stream"] },
};
writeFileSync(join(outDir, "workflow-manifest.json"), JSON.stringify(manifest, null, 2));

const artifactNote = existsSync(join("artifacts", MODEL_ARTIFACT_NAME))
  ? `model artifact present (artifacts/${MODEL_ARTIFACT_NAME})`
  : `WARNING: model artifact missing — run \`bun run train\` before deploying`;

console.log(`Bundle written to ${outDir}/`);
console.log(`  entry:    ${outDir}/main.js`);
console.log(`  manifest: ${outDir}/workflow-manifest.json`);
console.log(`  ${artifactNote}`);
