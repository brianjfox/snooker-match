/**
 * FallbackStateMachine + notification logic (plan tasks 5/14, ADR-6).
 *
 * Notification (FR-6, NFR-5, AC-1): the angry red banner activates the moment
 * confidence drops below the configured threshold or occlusion is detected —
 * the state mutation is synchronous with the observation, so it reaches every
 * browser well inside one second.
 *
 * Fallback (NFR-1, AC-8): if the problem persists for more than
 * FALLBACK_AFTER_MS (5 s), the workflow stops trusting vision Shot events and
 * keeps only the deterministic scoreboard alive (manual/correction events
 * still work). Any human correction clears fallback and the notification and
 * resets the shot timer.
 */

import type { WorkflowState } from "../platform/state.ts";
import type { NotificationReason } from "../types.ts";

export const FALLBACK_AFTER_MS = 5000;

export class FallbackStateMachine {
  constructor(private readonly state: WorkflowState) {}

  /** True while vision output must be ignored. */
  get active(): boolean {
    return this.state.data.fallback.active;
  }

  /**
   * Feed the latest vision quality signals. `confidence` is the mean detection
   * confidence of the latest stable observation.
   */
  observe(confidence: number, occlusion: boolean, now: number): void {
    const threshold = this.state.data.confidenceThreshold;
    const problem: NotificationReason = occlusion
      ? "occlusion"
      : confidence < threshold
        ? "low_confidence"
        : null;
    this.state.mutate((data) => {
      data.now = now;
      if (problem) {
        if (!data.notification.active) {
          data.notification = {
            active: true,
            reason: problem,
            since: now,
            message:
              problem === "occlusion"
                ? "Table partially occluded — model output unreliable"
                : `Model confidence ${confidence.toFixed(2)} below threshold ${threshold.toFixed(2)}`,
          };
          this.state.log("NOTIFICATION", "system", data.notification.message, {
            reason: problem,
            confidence,
            threshold,
          });
        }
        if (data.fallback.lowConfidenceSince === null) {
          data.fallback.lowConfidenceSince = now;
        }
        const sustained = now - data.fallback.lowConfidenceSince;
        if (!data.fallback.active && sustained >= FALLBACK_AFTER_MS) {
          data.fallback.active = true;
          data.fallback.since = now;
          data.status.fallbackActive = true;
          this.state.log(
            "FALLBACK_ACTIVATED",
            "system",
            "Sustained low confidence: vision suspended, scoreboard in deterministic fallback. Awaiting human confirmation.",
            { sustainedMs: sustained },
          );
        }
      } else {
        data.fallback.lowConfidenceSince = null;
        if (data.notification.active && !data.fallback.active) {
          // Auto-clear the banner only when fallback never engaged; once
          // fallback is active a human must confirm (correction clears it).
          data.notification = { active: false, reason: null, since: null, message: "" };
          this.state.log("NOTIFICATION_CLEARED", "system", "Vision quality recovered");
        }
      }
    });
  }

  /** A human correction arrived: trust restored (FR-7, plan ADR-6). */
  clearOnCorrection(now: number): void {
    this.state.mutate((data) => {
      data.now = now;
      data.fallback.lowConfidenceSince = null;
      if (data.fallback.active) {
        data.fallback.active = false;
        data.fallback.since = null;
        data.status.fallbackActive = false;
        this.state.log("FALLBACK_CLEARED", "human", "Fallback cleared by human correction");
      }
      if (data.notification.active) {
        data.notification = { active: false, reason: null, since: null, message: "" };
        this.state.log("NOTIFICATION_CLEARED", "human", "Notification cleared by correction");
      }
    });
  }
}
