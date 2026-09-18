/**
 * RulesAgent (plan task 8) — deterministic snooker scoring engine.
 *
 * Zero knowledge of the camera or the model: it consumes Shot deltas from the
 * StateObserver or manual/correction events from the UI, and mutates workflow
 * state (scores, break, ball-on, frames, event log). FR-2/3/4/7/8,
 * AC-3/4/5/6.
 *
 * Automated foul scope in v1 (per plan): only obvious potted-ball fouls are
 * called from vision — cue ball potted, or the wrong ball potted for the
 * current ball-on. Everything else (touching balls, push shots, in-off
 * without a pot...) arrives via the manual FOUL button.
 */

import {
  BALL_VALUES,
  COLOUR_SEQUENCE,
  type BallColour,
  type BallOn,
  type Correction,
  type EventSource,
  type MatchPhase,
  type Player,
  type RulePresetId,
  type Shot,
  type FrameScores,
} from "../types.ts";
import type { WorkflowState } from "../platform/state.ts";
import { getPreset } from "./presets.ts";
import type { FallbackStateMachine } from "./fallback.ts";

/** Fields captured for UNDO. */
interface UndoSnapshot {
  scores: FrameScores;
  framesWon: FrameScores;
  frameNumber: number;
  activePlayer: Player;
  currentBreak: number;
  ballOn: BallOn;
  redsRemaining: number;
  coloursRemaining: BallColour[];
  remainingPoints: number;
  phase: MatchPhase;
  label: string;
}

export interface MatchSetup {
  player1?: string;
  player2?: string;
  bestOf?: number;
  rulePreset?: RulePresetId;
  confidenceThreshold?: number;
}

export class RulesAgent {
  private undoStack: UndoSnapshot[] = [];

  constructor(
    private readonly state: WorkflowState,
    private readonly fallback: FallbackStateMachine,
  ) {}

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  startMatch(setup: MatchSetup, now: number): void {
    this.undoStack = [];
    this.state.mutate((data) => {
      data.now = now;
      if (setup.player1) data.players[1] = setup.player1;
      if (setup.player2) data.players[2] = setup.player2;
      if (setup.bestOf) data.bestOf = setup.bestOf;
      if (setup.rulePreset) data.rulePreset = setup.rulePreset;
      if (setup.confidenceThreshold !== undefined) {
        data.confidenceThreshold = setup.confidenceThreshold;
      }
      data.scores = { 1: 0, 2: 0 };
      data.framesWon = { 1: 0, 2: 0 };
      data.frameNumber = 1;
      data.activePlayer = 1;
      data.currentBreak = 0;
      data.redsRemaining = getPreset(data.rulePreset).reds;
      data.coloursRemaining = [...COLOUR_SEQUENCE];
      data.ballOn = "red";
      data.phase = "reds_and_colours";
      data.shotTimerStartedAt = now;
      this.state.log(
        "MATCH_STARTED",
        "human",
        `Match started: ${data.players[1]} v ${data.players[2]}, best of ${data.bestOf}, preset ${data.rulePreset}`,
        { preset: data.rulePreset, bestOf: data.bestOf },
      );
    });
  }

  setPreset(preset: RulePresetId, now: number): void {
    this.state.mutate((data) => {
      data.now = now;
      data.rulePreset = preset;
      this.state.log("PRESET_CHANGED", "human", `Rule preset set to ${preset}`);
    });
  }

  setConfidenceThreshold(threshold: number, now: number): void {
    const clamped = Math.max(0, Math.min(1, threshold));
    this.state.mutate((data) => {
      data.now = now;
      data.confidenceThreshold = clamped;
      this.state.log(
        "THRESHOLD_CHANGED",
        "human",
        `Confidence threshold set to ${clamped.toFixed(2)}`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Vision events
  // -------------------------------------------------------------------------

  /**
   * Consume a Shot delta from the StateObserver. Ignored while fallback is
   * active (vision is not trusted) or before the match starts.
   */
  onShot(shot: Shot, now: number): void {
    const data = this.state.data;
    if (this.fallback.active) return;
    if (data.phase !== "reds_and_colours" && data.phase !== "final_colours") return;

    const potted = shot.changes.filter((c) => c.kind === "potted");
    const respotted = shot.changes.filter((c) => c.kind === "respotted");
    const movedOnly = potted.length === 0 && respotted.length === 0;

    for (const change of respotted) {
      this.state.mutate((d) => {
        d.now = now;
        this.state.log("RESPOT", "vision", `${change.colour} respotted`);
      });
    }

    if (movedOnly) {
      // Balls moved but nothing potted: end of the striker's visit.
      this.endTurn("vision", now, "No pot — end of visit");
      return;
    }

    // Ball-on and phase at the start of the stroke: fouls are valued against
    // them (FR-3), and legality is judged against them so the outcome does
    // not depend on the order the observer reports the changes.
    const ballOnAtStroke = data.ballOn;
    const phaseAtStroke = data.phase;
    const others = potted.filter((c) => c.colour !== "cue");

    // Cue ball potted is always a foul (auto-detectable, plan v1 scope),
    // valued at the highest of the cue (4), the ball on, and any other ball
    // potted on the same stroke (the preset caps or flattens the penalty).
    if (potted.some((c) => c.colour === "cue")) {
      this.foul(
        Math.max(
          BALL_VALUES.cue,
          ballOnValue(ballOnAtStroke),
          ...others.map((c) => BALL_VALUES[c.colour]),
        ),
        "vision",
        now,
        "Cue ball potted",
      );
      return;
    }

    // Multiple balls potted in one stroke are legal only when they are all
    // reds and the striker was on a red; any other combination (red+colour,
    // colour+colour) is a foul valued at the highest ball involved (FR-3).
    const onRedStroke =
      ballOnAtStroke === "red" && phaseAtStroke === "reds_and_colours";
    const allReds = others.every((c) => c.colour === "red");
    if (others.length > 1 && !(allReds && onRedStroke)) {
      this.foul(
        Math.max(
          ballOnValue(ballOnAtStroke),
          ...others.map((c) => BALL_VALUES[c.colour]),
        ),
        "vision",
        now,
        "Multiple balls potted in one stroke",
      );
      return;
    }

    for (const change of others) {
      // Potting several reds in one stroke is legal while on a red: each
      // scores 1 and the striker is then on a colour (pot() sets that once
      // per red, idempotently).
      const multiRedPot = change.colour === "red" && onRedStroke;
      if (multiRedPot || this.isLegalPot(change.colour)) {
        this.pot(change.colour, "vision", now);
      } else {
        // Wrong ball potted: foul valued at the higher of the ball on and
        // the ball involved (the preset caps or flattens the penalty).
        this.foul(
          Math.max(BALL_VALUES[change.colour], ballOnValue(ballOnAtStroke)),
          "vision",
          now,
          `Wrong ball potted (${change.colour})`,
        );
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scoring primitives
  // -------------------------------------------------------------------------

  private isLegalPot(colour: BallColour): boolean {
    const data = this.state.data;
    if (colour === "cue") return false;
    if (data.phase === "final_colours") return colour === data.ballOn;
    if (data.ballOn === "red") return colour === "red";
    if (data.ballOn === "colour") return colour !== "red";
    return colour === data.ballOn;
  }

  /** Apply a legal pot for the active player. */
  pot(colour: BallColour, source: EventSource, now: number): void {
    this.snapshot(`POT ${colour}`);
    const value = BALL_VALUES[colour];
    this.state.mutate((data) => {
      data.now = now;
      const striker = data.activePlayer;
      data.scores[striker] += value;
      data.currentBreak += value;
      if (data.phase === "reds_and_colours") {
        if (colour === "red") {
          data.redsRemaining = Math.max(0, data.redsRemaining - 1);
          data.ballOn = "colour";
        } else {
          // Colour potted (respotted while reds remain / last-red colour).
          if (data.redsRemaining > 0) {
            data.ballOn = "red";
          } else {
            // Colour after the final red: enter the final sequence.
            data.phase = "final_colours";
            data.ballOn = data.coloursRemaining[0] ?? "yellow";
          }
        }
      } else if (data.phase === "final_colours") {
        data.coloursRemaining = data.coloursRemaining.filter((c) => c !== colour);
        data.ballOn = data.coloursRemaining[0] ?? "black";
      }
      data.remainingPoints = remainingPoints(data.redsRemaining, data.coloursRemaining);
      data.shotTimerStartedAt = now;
      this.state.log("POT", source, `${data.players[striker]} pots ${colour} (+${value})`, {
        colour,
        value,
        player: striker,
        break: data.currentBreak,
      });
    });
    this.maybeEndFrame(source, now);
  }

  /** A foul by the striker: penalty points to the opponent, turn ends. */
  foul(ballValue: number, source: EventSource, now: number, reason: string): void {
    this.snapshot(`FOUL ${reason}`);
    this.state.mutate((data) => {
      data.now = now;
      const preset = getPreset(data.rulePreset);
      const penalty = preset.foulPenalty(ballValue);
      const offender = data.activePlayer;
      const opponent: Player = offender === 1 ? 2 : 1;
      data.scores[opponent] += penalty;
      this.state.log(
        "FOUL",
        source,
        `Foul by ${data.players[offender]} (${reason}): ${penalty} points to ${data.players[opponent]}`,
        { penalty, offender, reason, preset: data.rulePreset },
      );
    });
    this.endTurn(source, now, "Foul — end of visit", false);
    // FR-3/FR-4: with only the black remaining, a foul settles the frame
    // under professional/amateur (winner = player ahead after the penalty;
    // a tie reuses the existing respot/tie logic). Club plays on.
    const d = this.state.data;
    const onlyBlackLeft =
      d.phase === "final_colours" &&
      d.redsRemaining === 0 &&
      d.coloursRemaining.length === 1 &&
      d.coloursRemaining[0] === "black";
    if (onlyBlackLeft && getPreset(d.rulePreset).foulOnBlackEndsFrame) {
      this.settleFrame(source, now);
    }
  }

  /** End the striker's visit and switch players. */
  endTurn(source: EventSource, now: number, reason: string, log = true): void {
    this.state.mutate((data) => {
      data.now = now;
      data.activePlayer = data.activePlayer === 1 ? 2 : 1;
      data.currentBreak = 0;
      data.ballOn =
        data.phase === "final_colours"
          ? (data.coloursRemaining[0] ?? "black")
          : data.redsRemaining > 0
            ? "red"
            : "colour";
      data.shotTimerStartedAt = now;
      if (log) this.state.log("END_OF_TURN", source, reason);
    });
  }

  /**
   * Frame end check (FR-4, AC-5): the frame ends when the final black is
   * potted. On a tie: professional respots the black; amateur/club award the
   * frame to the potter of the final black.
   */
  private maybeEndFrame(source: EventSource, now: number): void {
    const data = this.state.data;
    if (data.phase !== "final_colours" && data.phase !== "reds_and_colours") return;
    const tableCleared =
      data.redsRemaining === 0 && data.coloursRemaining.length === 0;
    if (!tableCleared) return;
    this.settleFrame(source, now);
  }

  /**
   * Resolve a finished position: respot the black on a professional tie,
   * otherwise award the frame. Reached when the final black is potted, or on
   * a foul with only the black left (professional/amateur).
   */
  private settleFrame(source: EventSource, now: number): void {
    const data = this.state.data;
    const preset = getPreset(data.rulePreset);
    if (data.scores[1] === data.scores[2] && preset.respotBlackOnTie) {
      // Respot the black: sudden death continues.
      this.state.mutate((d) => {
        d.now = now;
        d.coloursRemaining = ["black"];
        d.ballOn = "black";
        d.remainingPoints = 7;
        this.state.log("RESPOT", source, "Tie: black respotted (professional rules)");
      });
      return;
    }
    const winner: Player =
      data.scores[1] === data.scores[2]
        ? data.activePlayer // amateur/club: final-black potter takes the frame
        : data.scores[1] > data.scores[2]
          ? 1
          : 2;
    this.advanceFrame(winner, source, now);
  }

  /** Award the frame, auto-advance or finish the match (FR-4, AC-5). */
  advanceFrame(winner: Player, source: EventSource, now: number): void {
    this.undoStack = []; // frame boundary: undo does not cross frames
    this.state.mutate((data) => {
      data.now = now;
      data.framesWon[winner] += 1;
      const framesToWin = Math.ceil(data.bestOf / 2);
      this.state.log(
        "FRAME_ADVANCED",
        source,
        `Frame ${data.frameNumber} to ${data.players[winner]} (${data.scores[1]}-${data.scores[2]}). Frames: ${data.framesWon[1]}-${data.framesWon[2]}`,
        { winner, frame: data.frameNumber, scores: { ...data.scores } },
      );
      if (data.framesWon[winner] >= framesToWin) {
        data.phase = "match_over";
        this.state.log(
          "MATCH_OVER",
          source,
          `Match to ${data.players[winner]} ${data.framesWon[1]}-${data.framesWon[2]}`,
        );
        return;
      }
      // Reset for the next frame; break-off alternates by frame parity.
      data.frameNumber += 1;
      data.scores = { 1: 0, 2: 0 };
      data.currentBreak = 0;
      data.redsRemaining = getPreset(data.rulePreset).reds;
      data.coloursRemaining = [...COLOUR_SEQUENCE];
      data.ballOn = "red";
      data.phase = "reds_and_colours";
      data.activePlayer = data.frameNumber % 2 === 1 ? 1 : 2;
      data.remainingPoints = remainingPoints(data.redsRemaining, data.coloursRemaining);
      data.shotTimerStartedAt = now;
    });
  }

  // -------------------------------------------------------------------------
  // Corrections (FR-7, FR-12, AC-6) — always trusted over model output
  // -------------------------------------------------------------------------

  applyCorrection(correction: Correction, now: number): void {
    const data = this.state.data;
    // Record for fine-tuning BEFORE mutating (captures the disputed state).
    this.state.mutate((d) => {
      d.now = now;
      d.fineTuningBuffer.push({
        timestamp: now,
        correction,
        tableState: d.latestTableState,
        modelName: d.status.modelName,
      });
      this.state.log("CORRECTION", "human", correctionLabel(correction), {
        correction: { ...correction },
      });
    });

    switch (correction.type) {
      case "POT_MISSED": {
        const colour = correction.colour ?? "red";
        this.pot(colour, "human", now);
        break;
      }
      case "WRONG_COLOUR": {
        // Guard: with no prior scoring event to replace, applying the pot
        // would invent a score out of thin air. Log and leave state alone.
        if (this.undoStack.length === 0) {
          this.state.mutate((d) => {
            d.now = now;
            this.state.log(
              "CORRECTION",
              "human",
              "Nothing to correct — no prior pot to replace",
            );
          });
          break;
        }
        const colour = correction.colour ?? "red";
        this.undo(now, false);
        this.pot(colour, "human", now);
        break;
      }
      case "FOUL": {
        // FR-3: fouls are valued at the higher of the ball on and the ball
        // involved (the preset caps or flattens the penalty).
        const involved = correction.colour ? BALL_VALUES[correction.colour] : 4;
        const value = Math.max(involved, ballOnValue(data.ballOn));
        this.foul(value, "human", now, correction.note ?? "Manual foul call");
        break;
      }
      case "UNDO": {
        this.undo(now, true);
        break;
      }
      case "CORRECT_SCORE": {
        if (correction.scores) {
          this.snapshot("CORRECT_SCORE");
          this.state.mutate((d) => {
            d.now = now;
            d.scores = { ...correction.scores! };
            this.state.log(
              "SCORE_ADJUSTED",
              "human",
              `Score corrected to ${d.scores[1]}-${d.scores[2]}`,
            );
          });
        }
        break;
      }
      case "SWITCH_PLAYER": {
        this.endTurn("human", now, "Active player corrected");
        break;
      }
    }

    // Every correction restores trust and resets the shot timer (ADR-6).
    this.fallback.clearOnCorrection(now);
    this.state.mutate((d) => {
      d.now = now;
      d.shotTimerStartedAt = now;
    });
  }

  private undo(now: number, log: boolean): void {
    const snap = this.undoStack.pop();
    if (!snap) {
      if (log) {
        this.state.mutate((d) => {
          d.now = now;
          this.state.log("UNDO", "human", "Nothing to undo");
        });
      }
      return;
    }
    this.state.mutate((data) => {
      data.now = now;
      data.scores = { ...snap.scores };
      data.framesWon = { ...snap.framesWon };
      data.frameNumber = snap.frameNumber;
      data.activePlayer = snap.activePlayer;
      data.currentBreak = snap.currentBreak;
      data.ballOn = snap.ballOn;
      data.redsRemaining = snap.redsRemaining;
      data.coloursRemaining = [...snap.coloursRemaining];
      data.remainingPoints = snap.remainingPoints;
      data.phase = snap.phase;
      if (log) this.state.log("UNDO", "human", `Undid: ${snap.label}`);
    });
  }

  private snapshot(label: string): void {
    const d = this.state.data;
    this.undoStack.push({
      scores: { ...d.scores },
      framesWon: { ...d.framesWon },
      frameNumber: d.frameNumber,
      activePlayer: d.activePlayer,
      currentBreak: d.currentBreak,
      ballOn: d.ballOn,
      redsRemaining: d.redsRemaining,
      coloursRemaining: [...d.coloursRemaining],
      remainingPoints: d.remainingPoints,
      phase: d.phase,
      label,
    });
    if (this.undoStack.length > 50) this.undoStack.shift();
  }
}

export function remainingPoints(
  redsRemaining: number,
  coloursRemaining: BallColour[],
): number {
  // Each red is worth 1 + 7 (red then black is the maximum continuation).
  const colours = coloursRemaining.reduce((s, c) => s + BALL_VALUES[c], 0);
  return redsRemaining * 8 + colours;
}

/**
 * Value of the ball on for foul purposes (FR-3). Before a colour is nominated
 * the ball on is "any colour"; the lowest nominable colour (yellow) keeps the
 * penalty conservative.
 */
function ballOnValue(ballOn: BallOn): number {
  if (ballOn === "red") return BALL_VALUES.red;
  if (ballOn === "colour") return BALL_VALUES.yellow;
  return BALL_VALUES[ballOn];
}

function correctionLabel(c: Correction): string {
  switch (c.type) {
    case "POT_MISSED":
      return `Correction: missed pot added (${c.colour ?? "red"})`;
    case "WRONG_COLOUR":
      return `Correction: pot colour corrected to ${c.colour ?? "red"}`;
    case "FOUL":
      return `Correction: manual foul${c.colour ? ` (${c.colour})` : ""}`;
    case "UNDO":
      return "Correction: undo last event";
    case "CORRECT_SCORE":
      return "Correction: absolute score adjustment";
    case "SWITCH_PLAYER":
      return "Correction: switch active player";
  }
}
