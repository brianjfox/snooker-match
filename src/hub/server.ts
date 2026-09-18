/**
 * Hosted hub (plan tasks 11-13; FR-5, FR-10, FR-11, AC-9, AC-10).
 *
 * Bun.serve serving:
 * - GET  /                       control UI (operator)
 * - GET  /tv                     read-only TV view (viewer)
 * - GET  /api/state              full workflow state as JSON
 * - GET  /api/events             structured event log JSON (AC-10)
 * - GET  /api/stream             SSE: state pushed on every change (<1 s, AC-9)
 * - GET  /api/frame              latest camera frame (base64 RGB for canvas)
 * - POST /api/setup              players / preset / threshold / start match
 * - POST /api/correction         corrections & quick buttons
 * - POST /api/calibration/corners  corner taps (homography)
 * - POST /api/calibration/begin    capture frames, learn centroids, bump model
 *
 * Grants (plan task 10): every POST requires the operator role; viewers get
 * 403. Role resolution is the platform-grants shim in platform/grants.ts.
 */

import type { Server } from "bun";
import { RULE_PRESET_IDS, type Correction, type Frame, type Point } from "../types.ts";
import type { SnookerWorkflow } from "../workflow.ts";
import type { CameraSidecar } from "../platform/sidecar.ts";
import { canCorrect, resolveRole } from "../platform/grants.ts";
import { SIM_TABLE_CORNERS } from "../vision/synth.ts";
import { controlPageHtml, tvPageHtml } from "./ui.ts";

const SSE_MIN_INTERVAL_MS = 100; // coalesce bursts; still far under 1 s

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function forbidden(): Response {
  return json({ error: "Forbidden: correction authority required (operator grant)" }, 403);
}

/** Serializable snapshot of workflow state for browsers. */
export function snapshot(workflow: SnookerWorkflow): Record<string, unknown> {
  const d = workflow.state.data;
  return {
    ...d,
    eventLog: d.eventLog.slice(-100),
    eventCount: d.eventLog.length,
    fineTuningBuffer: undefined,
    fineTuningCount: d.fineTuningBuffer.length,
  };
}

function frameToPayload(frame: Frame | null): Record<string, unknown> | null {
  if (!frame) return null;
  return {
    width: frame.width,
    height: frame.height,
    timestamp: frame.timestamp,
    rgb: Buffer.from(frame.data).toString("base64"),
  };
}

export interface HubOptions {
  port?: number;
  /** Frames captured per calibration run (shown in the log). */
  calibrationFrames?: number;
}

export function startHub(
  workflow: SnookerWorkflow,
  sidecar: CameraSidecar | null,
  opts: HubOptions = {},
): Server<undefined> {
  const port = opts.port ?? 4750;
  const calibrationFrames = opts.calibrationFrames ?? 25;

  // Timestamps for API-driven mutations. Vision events are stamped with the
  // sidecar's virtual epoch (frame timestamps), so API events derive from the
  // same clock — the latest rectified frame — clamped so the event log never
  // steps backwards. Before any frame arrives the epoch starts at 0.
  let lastEventTime = 0;
  const currentTime = (): number => {
    lastEventTime = Math.max(lastEventTime, workflow.latestCanonical?.timestamp ?? 0);
    return lastEventTime;
  };

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const role = resolveRole(req);

      // ------------------------------------------------------------ pages
      if (req.method === "GET" && path === "/") {
        return new Response(controlPageHtml(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (req.method === "GET" && path === "/tv") {
        return new Response(tvPageHtml(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // ------------------------------------------------------------ reads
      if (req.method === "GET" && path === "/api/state") {
        return json(snapshot(workflow));
      }
      if (req.method === "GET" && path === "/api/events") {
        // AC-10: full structured event log for downstream scripts.
        return json({ events: workflow.state.data.eventLog });
      }
      if (req.method === "GET" && path === "/api/frame") {
        const canonical = workflow.latestCanonical;
        const raw = sidecar?.latestFrame ?? null;
        return json({
          canonical: frameToPayload(canonical),
          raw: frameToPayload(raw),
        });
      }
      if (req.method === "GET" && path === "/api/stream") {
        let unsubscribe = () => {};
        let interval: ReturnType<typeof setInterval> | null = null;
        const stream = new ReadableStream({
          start(controller) {
            let lastSent = 0;
            let dirty = false;
            const send = () => {
              lastSent = Date.now();
              dirty = false;
              controller.enqueue(
                `data: ${JSON.stringify(snapshot(workflow))}\n\n`,
              );
            };
            send();
            unsubscribe = workflow.state.subscribe(() => {
              const elapsed = Date.now() - lastSent;
              if (elapsed >= SSE_MIN_INTERVAL_MS) send();
              else dirty = true;
            });
            // Flush coalesced updates + heartbeat for the shot timer.
            interval = setInterval(() => {
              if (dirty || Date.now() - lastSent >= 1000) {
                try {
                  send();
                } catch {
                  /* client gone; cancel() cleans up */
                }
              }
            }, SSE_MIN_INTERVAL_MS);
          },
          cancel() {
            unsubscribe();
            if (interval) clearInterval(interval);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      // ----------------------------------------------------------- writes
      if (req.method === "POST") {
        if (!canCorrect(role)) return forbidden();
        const now = currentTime();

        if (path === "/api/setup") {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const preset = body.rulePreset as string | undefined;
          if (preset && !RULE_PRESET_IDS.includes(preset as never)) {
            return json({ error: `Unknown preset: ${preset}` }, 400);
          }
          const bestOf = body.bestOf;
          if (
            bestOf !== undefined &&
            (typeof bestOf !== "number" ||
              !Number.isInteger(bestOf) ||
              bestOf < 1 ||
              bestOf % 2 === 0)
          ) {
            return json({ error: "bestOf must be a positive odd integer" }, 400);
          }
          if (body.start === true) {
            workflow.rules.startMatch(
              {
                player1: body.player1 as string | undefined,
                player2: body.player2 as string | undefined,
                bestOf,
                rulePreset: preset as never,
                confidenceThreshold: body.confidenceThreshold as number | undefined,
              },
              now,
            );
          } else {
            if (preset) workflow.rules.setPreset(preset as never, now);
            if (typeof body.confidenceThreshold === "number") {
              workflow.rules.setConfidenceThreshold(body.confidenceThreshold, now);
            }
          }
          return json({ ok: true, state: snapshot(workflow) });
        }

        if (path === "/api/correction") {
          const body = (await req.json().catch(() => null)) as Correction | null;
          if (!body || !body.type) {
            return json({ error: "Correction body required: {type, colour?, scores?, note?}" }, 400);
          }
          workflow.rules.applyCorrection(body, now);
          return json({ ok: true, state: snapshot(workflow) });
        }

        if (path === "/api/calibration/corners") {
          const body = (await req.json().catch(() => ({}))) as {
            corners?: [Point, Point, Point, Point];
          };
          // Demo convenience: no corners supplied -> use the simulated mount.
          const corners = body.corners ?? SIM_TABLE_CORNERS;
          if (corners.length !== 4) {
            return json({ error: "Exactly four corner points required (TL,TR,BR,BL)" }, 400);
          }
          workflow.calibration.setCorners(corners, now);
          return json({ ok: true });
        }

        if (path === "/api/calibration/begin") {
          // Guided step: needs a rectified frame with balls on their spots.
          const frame = workflow.latestCanonical;
          if (!frame) {
            return json(
              { error: "No rectified frame yet — set the table corners first" },
              409,
            );
          }
          workflow.calibration.learnCentroids(frame, now);
          workflow.calibration.beginCalibration(calibrationFrames, frame, now);
          return json({ ok: true, state: snapshot(workflow) });
        }

        return json({ error: "Unknown endpoint" }, 404);
      }

      return json({ error: "Not found" }, 404);
    },
  });
  return server;
}
