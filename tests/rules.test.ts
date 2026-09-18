/**
 * Unit tests: rule presets, deterministic engine, corrections, timer reset,
 * fallback activation (plan test plan bullet 1; FR-3, FR-4, FR-7, FR-8,
 * AC-4, AC-5, AC-6, AC-8 state-level).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { WorkflowState } from "../src/platform/state.ts";
import { RulesAgent, remainingPoints } from "../src/rules/engine.ts";
import { FallbackStateMachine, FALLBACK_AFTER_MS } from "../src/rules/fallback.ts";
import { PRESETS } from "../src/rules/presets.ts";
import type { Shot, TableState } from "../src/types.ts";

let state: WorkflowState;
let fallback: FallbackStateMachine;
let rules: RulesAgent;

beforeEach(() => {
  state = new WorkflowState();
  fallback = new FallbackStateMachine(state);
  rules = new RulesAgent(state, fallback);
  rules.startMatch({ player1: "Ronnie", player2: "Judd", bestOf: 3 }, 0);
});

const emptyState = (t: number): TableState => ({ timestamp: t, balls: [], confidence: 0.9 });

function shot(changes: Shot["changes"]): Shot {
  return { before: emptyState(0), after: emptyState(1), changes };
}

/** An independent match on the given preset (the shared state is professional). */
function matchOn(preset: "professional" | "amateur" | "club") {
  const s = new WorkflowState();
  const r = new RulesAgent(s, new FallbackStateMachine(s));
  r.startMatch({ player1: "P1", player2: "P2", bestOf: 3, rulePreset: preset }, 0);
  return { s, r };
}

/** Put frame 1 into the "only the black remains" position, player 1 at the table. */
function onFinalBlack(s: WorkflowState, scores: { 1: number; 2: number }): void {
  s.mutate((d) => {
    d.phase = "final_colours";
    d.redsRemaining = 0;
    d.coloursRemaining = ["black"];
    d.ballOn = "black";
    d.scores = { ...scores };
    d.remainingPoints = 7;
    d.activePlayer = 1;
  });
}

describe("presets (AC-4)", () => {
  test("professional and amateur scale fouls by ball value, club is flat 4", () => {
    expect(PRESETS.professional.foulPenalty(7)).toBe(7);
    expect(PRESETS.professional.foulPenalty(2)).toBe(4);
    expect(PRESETS.amateur.foulPenalty(6)).toBe(6);
    expect(PRESETS.club.foulPenalty(7)).toBe(4);
    expect(PRESETS.club.foulPenalty(5)).toBe(4);
  });

  test("same foul applies different penalties per selected preset", () => {
    // Professional: potting the black illegally = 7 away.
    rules.foul(7, "human", 1000, "black off the table");
    expect(state.data.scores[2]).toBe(7);

    // Club: the same foul = 4 away.
    const s2 = new WorkflowState();
    const r2 = new RulesAgent(s2, new FallbackStateMachine(s2));
    r2.startMatch({ rulePreset: "club" }, 0);
    r2.foul(7, "human", 1000, "black off the table");
    expect(s2.data.scores[2]).toBe(4);
  });
});

describe("pots, break and turn (FR-2, AC-3)", () => {
  test("red then black builds a break and alternates ball-on", () => {
    rules.onShot(shot([{ kind: "potted", colour: "red" }]), 1000);
    expect(state.data.scores[1]).toBe(1);
    expect(state.data.currentBreak).toBe(1);
    expect(state.data.ballOn).toBe("colour");
    expect(state.data.redsRemaining).toBe(14);

    rules.onShot(shot([{ kind: "potted", colour: "black" }]), 2000);
    expect(state.data.scores[1]).toBe(8);
    expect(state.data.currentBreak).toBe(8);
    expect(state.data.ballOn).toBe("red");
  });

  test("no pot ends the visit and swaps the active player", () => {
    rules.onShot(shot([{ kind: "moved", colour: "red" }]), 1000);
    expect(state.data.activePlayer).toBe(2);
    expect(state.data.currentBreak).toBe(0);
  });

  test("cue ball potted is an automatic foul", () => {
    rules.onShot(shot([{ kind: "potted", colour: "cue" }]), 1000);
    expect(state.data.scores[2]).toBe(4);
    expect(state.data.activePlayer).toBe(2);
  });

  test("wrong ball potted is a foul scaled by ball value", () => {
    // Ball on is red; potting the blue is a 5-point foul (professional).
    rules.onShot(shot([{ kind: "potted", colour: "blue" }]), 1000);
    expect(state.data.scores[2]).toBe(5);
  });

  test("remaining points follow the standard formula", () => {
    expect(remainingPoints(15, ["yellow", "green", "brown", "blue", "pink", "black"])).toBe(147);
    expect(remainingPoints(0, ["pink", "black"])).toBe(13);
  });

  test("shot timer resets on every pot", () => {
    state.mutate((d) => (d.now = 5000));
    rules.pot("red", "vision", 5000, );
    expect(state.data.shotTimerStartedAt).toBe(5000);
  });
});

describe("frame advance (FR-4, AC-5)", () => {
  function clearTable(agent: RulesAgent, s: WorkflowState, base: number): void {
    // Pot all reds with blacks, then clear the colours.
    let t = base;
    while (s.data.redsRemaining > 0) {
      agent.pot("red", "human", (t += 10));
      agent.pot("black", "human", (t += 10));
    }
    for (const colour of ["yellow", "green", "brown", "blue", "pink", "black"] as const) {
      agent.pot(colour, "human", (t += 10));
    }
  }

  test("clearing the table awards the frame, resets break, increments frame number", () => {
    clearTable(rules, state, 1000);
    expect(state.data.frameNumber).toBe(2);
    expect(state.data.framesWon[1]).toBe(1);
    expect(state.data.currentBreak).toBe(0);
    expect(state.data.redsRemaining).toBe(15);
    expect(state.data.scores[1]).toBe(0);
    expect(state.data.phase).toBe("reds_and_colours");
    const advanced = state.data.eventLog.find((e) => e.type === "FRAME_ADVANCED");
    expect(advanced).toBeDefined();
  });

  test("winning the deciding frame ends the match", () => {
    clearTable(rules, state, 1000); // frame 1 -> player 1
    clearTable(rules, state, 100000); // frame 2: player 2 broke, but pots go to active player
    // framesWon may be split; drive frames until someone reaches 2 of best-of-3.
    if (state.data.phase !== "match_over") clearTable(rules, state, 200000);
    expect(state.data.phase).toBe("match_over");
    expect(state.data.eventLog.some((e) => e.type === "MATCH_OVER")).toBe(true);
  });
});

describe("corrections (FR-7, FR-12, AC-6)", () => {
  test("POT_MISSED applies the pot, logs it, and records fine-tuning data", () => {
    rules.applyCorrection({ type: "POT_MISSED", colour: "red" }, 1000);
    expect(state.data.scores[1]).toBe(1);
    expect(state.data.eventLog.some((e) => e.type === "CORRECTION")).toBe(true);
    expect(state.data.fineTuningBuffer.length).toBe(1);
    expect(state.data.fineTuningBuffer[0]!.correction?.type).toBe("POT_MISSED");
  });

  test("UNDO reverts the last scoring event", () => {
    rules.pot("red", "vision", 500);
    expect(state.data.scores[1]).toBe(1);
    rules.applyCorrection({ type: "UNDO" }, 1000);
    expect(state.data.scores[1]).toBe(0);
    expect(state.data.redsRemaining).toBe(15);
    expect(state.data.ballOn).toBe("red");
  });

  test("WRONG_COLOUR replaces the last pot", () => {
    rules.pot("red", "vision", 500); // model said red...
    rules.applyCorrection({ type: "WRONG_COLOUR", colour: "brown" }, 1000); // ...operator says brown
    // Undo removed the red (+1); pot brown applies +4 (foul-free human override).
    expect(state.data.scores[1]).toBe(4);
  });

  test("CORRECT_SCORE sets absolute scores", () => {
    rules.applyCorrection({ type: "CORRECT_SCORE", scores: { 1: 37, 2: 21 } }, 1000);
    expect(state.data.scores[1]).toBe(37);
    expect(state.data.scores[2]).toBe(21);
  });

  test("every correction resets the shot timer (ADR-6)", () => {
    rules.applyCorrection({ type: "FOUL", colour: "blue" }, 9000);
    expect(state.data.shotTimerStartedAt).toBe(9000);
  });
});

describe("fallback & notification (NFR-1, NFR-5, AC-1, AC-8)", () => {
  test("low confidence raises the notification immediately", () => {
    fallback.observe(0.3, false, 1000); // threshold defaults to 0.6
    expect(state.data.notification.active).toBe(true);
    expect(state.data.notification.reason).toBe("low_confidence");
  });

  test("occlusion raises the notification immediately", () => {
    fallback.observe(0.95, true, 1000);
    expect(state.data.notification.active).toBe(true);
    expect(state.data.notification.reason).toBe("occlusion");
  });

  test("sustained low confidence (>5s) activates fallback; vision is ignored", () => {
    fallback.observe(0.3, false, 1000);
    fallback.observe(0.3, false, 1000 + FALLBACK_AFTER_MS);
    expect(state.data.fallback.active).toBe(true);
    // Vision shots are now ignored...
    rules.onShot(shot([{ kind: "potted", colour: "red" }]), 7000);
    expect(state.data.scores[1]).toBe(0);
    // ...but manual corrections still work.
    rules.applyCorrection({ type: "POT_MISSED", colour: "red" }, 8000);
    expect(state.data.scores[1]).toBe(1);
  });

  test("a correction clears fallback and the notification", () => {
    fallback.observe(0.3, false, 1000);
    fallback.observe(0.3, false, 7000);
    expect(state.data.fallback.active).toBe(true);
    rules.applyCorrection({ type: "UNDO" }, 8000);
    expect(state.data.fallback.active).toBe(false);
    expect(state.data.notification.active).toBe(false);
  });

  test("brief dips recover without fallback", () => {
    fallback.observe(0.3, false, 1000);
    fallback.observe(0.95, false, 2000);
    expect(state.data.notification.active).toBe(false);
    expect(state.data.fallback.active).toBe(false);
  });

  test("threshold from the confidence slider is respected (FR-8)", () => {
    rules.setConfidenceThreshold(0.2, 500);
    fallback.observe(0.3, false, 1000); // 0.3 > 0.2 -> fine
    expect(state.data.notification.active).toBe(false);
  });
});

describe("foul valuation considers the ball on (FR-3)", () => {
  test("cue ball potted while on black is 7 away under professional", () => {
    onFinalBlack(state, { 1: 7, 2: 0 });
    rules.onShot(shot([{ kind: "potted", colour: "cue" }]), 1000);
    // max(4, black 7, cue basis 4) = 7 away -> 7-7 tie -> black respotted,
    // so the frame does not advance and the penalty stays visible.
    expect(state.data.scores[2]).toBe(7);
    expect(state.data.frameNumber).toBe(1);
    expect(state.data.eventLog.findLast((e) => e.type === "FOUL")?.data?.penalty).toBe(7);
    expect(state.data.eventLog.some((e) => e.type === "RESPOT")).toBe(true);
  });

  test("cue ball potted while on black stays a flat 4 under club (frame continues)", () => {
    const { s, r } = matchOn("club");
    onFinalBlack(s, { 1: 0, 2: 0 });
    r.onShot(shot([{ kind: "potted", colour: "cue" }]), 1000);
    expect(s.data.scores[2]).toBe(4);
    // Club: fouls never settle the frame — play on until the black is potted.
    expect(s.data.frameNumber).toBe(1);
    expect(s.data.phase).toBe("final_colours");
  });

  test("wrong ball on the final black (pink potted) is 7 away, not 6", () => {
    onFinalBlack(state, { 1: 7, 2: 0 });
    rules.onShot(shot([{ kind: "potted", colour: "pink" }]), 1000);
    // max(4, black on = 7, pink involved = 6) = 7 -> 7-7 tie -> respot.
    expect(state.data.scores[2]).toBe(7);
    expect(state.data.eventLog.findLast((e) => e.type === "FOUL")?.data?.penalty).toBe(7);
  });

  test("manual FOUL correction is valued against the ball on", () => {
    state.mutate((d) => {
      d.phase = "final_colours";
      d.redsRemaining = 0;
      d.coloursRemaining = ["pink", "black"];
      d.ballOn = "pink";
      d.remainingPoints = 13;
    });
    rules.applyCorrection({ type: "FOUL", colour: "yellow" }, 1000);
    // max(4, pink on = 6, yellow involved = 2) = 6 away.
    expect(state.data.scores[2]).toBe(6);
  });
});

describe("multiple reds in one stroke (FR-3)", () => {
  test("two reds potted in one stroke score +2 with no foul on every preset", () => {
    for (const preset of ["professional", "amateur", "club"] as const) {
      const { s, r } = matchOn(preset);
      r.onShot(
        shot([
          { kind: "potted", colour: "red" },
          { kind: "potted", colour: "red" },
        ]),
        1000,
      );
      expect(s.data.scores[1]).toBe(2);
      expect(s.data.scores[2]).toBe(0);
      expect(s.data.redsRemaining).toBe(13);
      expect(s.data.ballOn).toBe("colour");
      expect(s.data.eventLog.some((e) => e.type === "FOUL")).toBe(false);
    }
  });

  test("a red and a colour in one stroke is a foul, regardless of change order", () => {
    for (const order of [
      ["red", "blue"],
      ["blue", "red"],
    ] as const) {
      const { s, r } = matchOn("professional");
      r.onShot(
        shot(order.map((colour) => ({ kind: "potted" as const, colour }))),
        1000,
      );
      // Foul valued at the highest ball involved: max(4, red 1, blue 5) = 5.
      expect(s.data.scores[1]).toBe(0);
      expect(s.data.scores[2]).toBe(5);
      expect(s.data.eventLog.findLast((e) => e.type === "FOUL")?.data?.penalty).toBe(5);
      expect(s.data.activePlayer).toBe(2);
    }
  });

  test("two colours in one stroke while on a colour is a foul at the higher value", () => {
    const { s, r } = matchOn("professional");
    r.onShot(shot([{ kind: "potted", colour: "red" }]), 1000); // now on a colour
    r.onShot(
      shot([
        { kind: "potted", colour: "green" },
        { kind: "potted", colour: "pink" },
      ]),
      2000,
    );
    // max(4, green 3, pink 6) = 6 to the opponent; the red stands (+1).
    expect(s.data.scores[1]).toBe(1);
    expect(s.data.scores[2]).toBe(6);
  });

  test("cue potted alongside another ball is valued against that ball too", () => {
    const { s, r } = matchOn("professional");
    r.onShot(
      shot([
        { kind: "potted", colour: "cue" },
        { kind: "potted", colour: "black" },
      ]),
      1000,
    );
    // max(cue 4, ball on red 1, black 7) = 7 away.
    expect(s.data.scores[2]).toBe(7);
    expect(s.data.scores[1]).toBe(0);
  });
});

describe("WRONG_COLOUR guard (FR-7)", () => {
  test("with nothing to undo it mutates no score and logs 'nothing to correct'", () => {
    rules.applyCorrection({ type: "WRONG_COLOUR", colour: "brown" }, 1000);
    expect(state.data.scores[1]).toBe(0);
    expect(state.data.scores[2]).toBe(0);
    expect(state.data.redsRemaining).toBe(15);
    expect(state.data.currentBreak).toBe(0);
    expect(
      state.data.eventLog.some(
        (e) => e.type === "CORRECTION" && e.message.includes("Nothing to correct"),
      ),
    ).toBe(true);
  });
});

describe("settling the final black (FR-4, AC-5)", () => {
  test("professional tie respots the black and the frame does not advance", () => {
    onFinalBlack(state, { 1: 0, 2: 7 });
    rules.onShot(shot([{ kind: "potted", colour: "black" }]), 1000);
    expect(state.data.scores[1]).toBe(7); // 7-7 after the black
    expect(state.data.frameNumber).toBe(1);
    expect(state.data.framesWon[1]).toBe(0);
    expect(state.data.framesWon[2]).toBe(0);
    expect(state.data.phase).toBe("final_colours");
    expect(state.data.ballOn).toBe("black");
    expect(state.data.coloursRemaining).toEqual(["black"]);
    expect(state.data.remainingPoints).toBe(7);
    expect(state.data.eventLog.some((e) => e.type === "RESPOT")).toBe(true);
  });

  test("amateur and club ties award the frame to the final-black potter", () => {
    for (const preset of ["amateur", "club"] as const) {
      const { s, r } = matchOn(preset);
      onFinalBlack(s, { 1: 0, 2: 7 });
      r.onShot(shot([{ kind: "potted", colour: "black" }]), 1000);
      expect(s.data.framesWon[1]).toBe(1); // potter (player 1) takes the frame
      expect(s.data.framesWon[2]).toBe(0);
      expect(s.data.frameNumber).toBe(2);
    }
  });

  test("UNDO after a professional foul-tie respot restores the pre-foul position", () => {
    onFinalBlack(state, { 1: 7, 2: 0 });
    rules.onShot(shot([{ kind: "potted", colour: "cue" }]), 1000); // 7 away -> tie -> respot
    expect(state.data.scores[2]).toBe(7);
    rules.applyCorrection({ type: "UNDO" }, 2000);
    expect(state.data.scores[2]).toBe(0);
    expect(state.data.ballOn).toBe("black");
    expect(state.data.coloursRemaining).toEqual(["black"]);
    expect(state.data.activePlayer).toBe(1);
    expect(state.data.frameNumber).toBe(1);
  });

  test("UNDO cannot cross a foul-ended frame boundary", () => {
    const { s, r } = matchOn("amateur");
    onFinalBlack(s, { 1: 30, 2: 0 });
    r.onShot(shot([{ kind: "potted", colour: "cue" }]), 1000); // frame settles 30-7
    expect(s.data.framesWon[1]).toBe(1);
    r.applyCorrection({ type: "UNDO" }, 2000);
    expect(s.data.framesWon[1]).toBe(1); // frame result stands
    expect(s.data.frameNumber).toBe(2);
    expect(
      s.data.eventLog.some((e) => e.message.includes("Nothing to undo")),
    ).toBe(true);
  });

  test("a foul with only the black left ends the frame (professional/amateur)", () => {
    for (const preset of ["professional", "amateur"] as const) {
      const { s, r } = matchOn(preset);
      onFinalBlack(s, { 1: 30, 2: 0 });
      r.onShot(shot([{ kind: "potted", colour: "cue" }]), 1000);
      // 30-7 after the penalty: the player ahead takes the frame.
      expect(s.data.framesWon[1]).toBe(1);
      expect(s.data.frameNumber).toBe(2);
      expect(s.data.eventLog.some((e) => e.type === "FRAME_ADVANCED")).toBe(true);
    }
  });
});
