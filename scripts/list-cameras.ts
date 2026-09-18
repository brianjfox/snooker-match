/**
 * `bun run cameras` — list AVFoundation video devices so the operator can
 * pick a CAMERA_DEVICE selector (index or name substring) for `bun run start`.
 */

import { listVideoDevices } from "../src/platform/sidecar-macos.ts";

try {
  const devices = await listVideoDevices();
  if (devices.length === 0) {
    console.log("No AVFoundation video devices found.");
  } else {
    for (const d of devices) console.log(`[${d.index}] ${d.name}`);
    console.log(`\nStart with: CAMERA=macos CAMERA_DEVICE="${devices[0]!.name}" bun run start`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
