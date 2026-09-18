/**
 * Hub + UI tests (plan test plan bullets 4-5; IR-1..6, AC-1, AC-6, AC-7,
 * AC-9, AC-10, FR-10, FR-11): every design-artifact test ID exists, the
 * angry-blink animation is defined, grants enforce read-only TV viewers, the
 * event log is fetchable as structured JSON, and SSE delivers score changes
 * to browsers in well under a second.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { ArtifactStore } from "../src/platform/artifacts.ts";
import { SnookerWorkflow } from "../src/workflow.ts";
import { startHub } from "../src/hub/server.ts";
import { trainModel } from "../src/trainer/trainer.ts";
import { controlPageHtml, tvPageHtml } from "../src/hub/ui.ts";
import { renderCanonical } from "../src/vision/synth.ts";

let workflow: SnookerWorkflow;
let server: Server<undefined>;
let base: string;

beforeAll(() => {
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), "snooker-hub-")));
  store.writeModel(trainModel(60).artifact);
  workflow = new SnookerWorkflow(store);
  workflow.rules.startMatch({ player1: "A", player2: "B" }, 0);
  server = startHub(workflow, null, { port: 0 });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const operator = {
  method: "POST",
  headers: { "content-type": "application/json", "x-role": "operator" },
};

describe("UI markup (IR-1..6)", () => {
  const control = controlPageHtml();
  const tv = tvPageHtml();

  test("IR-1: notification banner is red, has icon + text + angry-blink", () => {
    for (const html of [control, tv]) {
      expect(html).toContain('data-testid="notification-banner"');
      expect(html).toContain("HUMAN INTERVENTION REQUIRED");
      expect(html).toContain("@keyframes angry-blink");
      expect(html).toMatch(/animation:\s*angry-blink/);
      expect(html).toMatch(/--red:\s*#d21f1f/);
      expect(html).toContain('<span class="icon">!</span>');
    }
  });

  test("IR-2: camera feed placeholder at 16:9 in a container", () => {
    for (const html of [control, tv]) {
      expect(html).toContain('data-testid="camera-feed-container"');
      expect(html).toContain('data-testid="camera-feed-placeholder"');
      expect(html).toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
    }
  });

  test("IR-3: player score cards with names, scores, active indicator", () => {
    for (const html of [control, tv]) {
      expect(html).toContain('data-testid="player-1-score"');
      expect(html).toContain('data-testid="player-2-score"');
      expect(html).toContain("active-indicator");
    }
  });

  test("IR-4: current-break rendered in amber", () => {
    for (const html of [control, tv]) {
      expect(html).toContain('data-testid="current-break"');
    }
    expect(control).toMatch(
      /\[data-testid="current-break"\]\s*\{[^}]*var\(--amber\)/,
    );
    expect(control).toMatch(/--amber:\s*#ffbf00/);
  });

  test("IR-5: rule preset select with Professional/Amateur/Club", () => {
    expect(control).toContain('data-testid="rule-preset-select"');
    expect(control).toContain(">Professional<");
    expect(control).toContain(">Amateur<");
    expect(control).toContain(">Club<");
  });

  test("IR-6: calibration modal with instructions and begin button", () => {
    expect(control).toContain('data-testid="calibrate-button"');
    expect(control).toContain('data-testid="calibration-modal"');
    expect(control).toContain('data-testid="begin-calibration-button"');
    expect(control).toContain("tap the four cushion corners");
  });

  test("corrections panel, quick buttons, slider, frame info, event log", () => {
    expect(control).toContain('data-testid="panel-corrections"');
    expect(control).toContain('data-testid="correction-pot-missed"');
    expect(control).toContain('data-testid="apply-correction-button"');
    expect(control).toContain('data-testid="confidence-slider"');
    expect(control).toContain('data-testid="current-frame"');
    expect(control).toContain('data-testid="frame-info"');
    expect(control).toContain('data-testid="event-log"');
    expect(control).toContain('data-correction="UNDO"');
    expect(control).toContain('data-correction="FOUL"');
    expect(control).toContain('data-correction="CORRECT_SCORE"');
  });

  test("TV page is read-only: tv-main-view present, no controls (FR-10)", () => {
    expect(tv).toContain('data-testid="tv-main-view"');
    expect(tv).not.toContain('data-testid="panel-corrections"');
    expect(tv).not.toContain('data-testid="rule-preset-select"');
    expect(tv).not.toContain('data-testid="calibrate-button"');
    expect(tv).not.toContain('data-testid="apply-correction-button"');
  });
});

describe("HTTP API", () => {
  test("GET / serves the control page, /tv the viewer page", async () => {
    const control = await (await fetch(`${base}/`)).text();
    const tv = await (await fetch(`${base}/tv`)).text();
    expect(control).toContain('data-testid="panel-corrections"');
    expect(tv).toContain('data-testid="tv-main-view"');
  });

  test("GET /api/state returns the scoreboard state", async () => {
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, any>;
    expect(state.players[1]).toBe("A");
    expect(state.rulePreset).toBe("professional");
    expect(state.status.modelName).toContain("snooker-ball-det");
  });

  test("AC-10: GET /api/events returns the structured JSON event log", async () => {
    const body = (await (await fetch(`${base}/api/events`)).json()) as {
      events: { id: number; type: string; timestamp: number; message: string }[];
    };
    expect(Array.isArray(body.events)).toBe(true);
    const started = body.events.find((e) => e.type === "MATCH_STARTED");
    expect(started).toBeDefined();
    expect(typeof started!.id).toBe("number");
    expect(typeof started!.timestamp).toBe("number");
  });

  test("grants: viewer POSTs are rejected with 403 (FR-10)", async () => {
    const res = await fetch(`${base}/api/correction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "UNDO" }),
    });
    expect(res.status).toBe(403);
  });

  test("operator corrections mutate state and are logged (AC-6)", async () => {
    const res = await fetch(`${base}/api/correction`, {
      ...operator,
      body: JSON.stringify({ type: "POT_MISSED", colour: "red" }),
    });
    expect(res.status).toBe(200);
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, any>;
    expect(state.scores[1]).toBeGreaterThanOrEqual(1);
    expect(state.fineTuningCount).toBeGreaterThanOrEqual(1);
    const events = (await (await fetch(`${base}/api/events`)).json()) as {
      events: { type: string }[];
    };
    expect(events.events.some((e) => e.type === "CORRECTION")).toBe(true);
  });

  test("setup endpoint switches preset and threshold (FR-8, AC-4)", async () => {
    const res = await fetch(`${base}/api/setup`, {
      ...operator,
      body: JSON.stringify({ rulePreset: "club", confidenceThreshold: 0.5 }),
    });
    expect(res.status).toBe(200);
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, any>;
    expect(state.rulePreset).toBe("club");
    expect(state.confidenceThreshold).toBe(0.5);
    const bad = await fetch(`${base}/api/setup`, {
      ...operator,
      body: JSON.stringify({ rulePreset: "nonsense" }),
    });
    expect(bad.status).toBe(400);
  });

  test("setup endpoint validates bestOf as a positive odd integer", async () => {
    for (const bestOf of [0, -3, 2, 4.5, "7"]) {
      const res = await fetch(`${base}/api/setup`, {
        ...operator,
        body: JSON.stringify({ bestOf }),
      });
      expect(res.status).toBe(400);
    }
    const ok = await fetch(`${base}/api/setup`, {
      ...operator,
      body: JSON.stringify({ bestOf: 7 }),
    });
    expect(ok.status).toBe(200);
  });

  test("calibration endpoints: corners then begin updates model name (AC-7)", async () => {
    const corners = await fetch(`${base}/api/calibration/corners`, {
      ...operator,
      body: JSON.stringify({}),
    });
    expect(corners.status).toBe(200);
    // Give the workflow a rectified frame to sample colours from.
    workflow.latestCanonical = renderCanonical([], { timestamp: 1 });
    const begin = await fetch(`${base}/api/calibration/begin`, {
      ...operator,
      body: JSON.stringify({}),
    });
    expect(begin.status).toBe(200);
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, any>;
    expect(state.status.modelName).toContain("cal #");
    expect(state.status.calibrated).toBe(true);
  });

  test("AC-9: SSE pushes a score change to a connected browser in <1s", async () => {
    const res = await fetch(`${base}/api/stream`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Initial snapshot arrives first.
    await reader.read();

    const before = Date.now();
    await fetch(`${base}/api/correction`, {
      ...operator,
      body: JSON.stringify({ type: "CORRECT_SCORE", scores: { 1: 77, 2: 3 } }),
    });

    // Read until the update containing the new score arrives (or 1s passes).
    let elapsed = Number.POSITIVE_INFINITY;
    let buffer = "";
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.value) buffer += decoder.decode(chunk.value);
      if (buffer.includes('"1":77')) {
        elapsed = Date.now() - before;
        break;
      }
      if (chunk.done) break;
    }
    await reader.cancel();
    expect(elapsed).toBeLessThan(1000);
  });
});
