/**
 * WorkflowState — local shim for the Interchange workflow-state primitive.
 *
 * All match data lives in a single mutable state object (plan ADR-2). Mutations
 * go through `mutate` so subscribers (SSE clients, tests) are notified
 * synchronously and the event log is the single audit trail.
 *
 * On the real platform this object is the workflow run's state document and
 * grants control who may call which mutation.
 */

import type {
  MatchEvent,
  MatchEventType,
  EventSource,
  WorkflowStateData,
} from "../types.ts";

export type StateListener = (state: WorkflowStateData) => void;

export function initialStateData(now = 0): WorkflowStateData {
  return {
    players: { 1: "Player 1", 2: "Player 2" },
    scores: { 1: 0, 2: 0 },
    framesWon: { 1: 0, 2: 0 },
    frameNumber: 1,
    bestOf: 7,
    activePlayer: 1,
    currentBreak: 0,
    ballOn: "red",
    redsRemaining: 15,
    coloursRemaining: ["yellow", "green", "brown", "blue", "pink", "black"],
    remainingPoints: 15 * 8 + 27,
    phase: "setup",
    rulePreset: "professional",
    confidenceThreshold: 0.6,
    shotTimerStartedAt: now,
    now,
    calibration: {
      corners: null,
      homography: null,
      centroids: null,
      calibratedAt: null,
      capturedFrames: 0,
    },
    latestTableState: null,
    previousTableState: null,
    notification: { active: false, reason: null, since: null, message: "" },
    fallback: { active: false, since: null, lowConfidenceSince: null },
    eventLog: [],
    fineTuningBuffer: [],
    status: {
      modelName: "(no model loaded)",
      modelVersion: "-",
      calibrated: false,
      fallbackActive: false,
      fps: 0,
    },
  };
}

export class WorkflowState {
  private listeners = new Set<StateListener>();
  private nextEventId = 1;
  data: WorkflowStateData;

  constructor(data?: WorkflowStateData) {
    this.data = data ?? initialStateData();
  }

  /** Apply a mutation and notify subscribers. */
  mutate(fn: (data: WorkflowStateData) => void): void {
    fn(this.data);
    for (const listener of this.listeners) listener(this.data);
  }

  /** Append an event to the log (inside a mutation). */
  log(
    type: MatchEventType,
    source: EventSource,
    message: string,
    data?: Record<string, unknown>,
  ): MatchEvent {
    const event: MatchEvent = {
      id: this.nextEventId++,
      timestamp: this.data.now,
      type,
      source,
      message,
      ...(data ? { data } : {}),
    };
    this.data.eventLog.push(event);
    return event;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
