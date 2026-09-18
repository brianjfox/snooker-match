/**
 * StateObserver (plan task 7, second half).
 *
 * Holds the previous stable TableState and, when a new consensus state
 * arrives, computes the delta as a Shot {before, after, changes}:
 * - Reds are matched by Hungarian assignment on positions (no persistent
 *   identities — ADR-7); unmatched before-reds are potted.
 * - Non-red colours are matched by presence: a colour present before and
 *   absent after was potted; absent before and present after was respotted.
 * - The cue ball disappearing is reported as a potted cue (a foul upstream).
 */

import {
  BALL_COLOURS,
  type BallColour,
  type ClassifiedBall,
  type Shot,
  type ShotChange,
  type TableState,
} from "../types.ts";
import { hungarian } from "./hungarian.ts";

/** Reds closer than this between states are "the same red, maybe nudged". */
const MOVE_TOLERANCE = 2.5;

export class StateObserver {
  private previous: TableState | null = null;

  get previousState(): TableState | null {
    return this.previous;
  }

  reset(initial: TableState | null = null): void {
    this.previous = initial;
  }

  /**
   * Feed a new consensus stable state. Returns a Shot when the table changed
   * relative to the previous stable state, else null. Always advances the
   * previous state.
   */
  observe(state: TableState): Shot | null {
    const before = this.previous;
    this.previous = state;
    if (!before) return null;
    const changes = diffStates(before, state);
    if (changes.length === 0) return null;
    return { before, after: state, changes };
  }
}

export function diffStates(
  before: TableState,
  after: TableState,
): ShotChange[] {
  const changes: ShotChange[] = [];
  // --- Reds: Hungarian on positions.
  const redsBefore = before.balls.filter((b) => b.colour === "red");
  const redsAfter = after.balls.filter((b) => b.colour === "red");
  if (redsBefore.length > 0) {
    const costs = redsBefore.map((rb) =>
      redsAfter.map((ra) => Math.hypot(rb.x - ra.x, rb.y - ra.y)),
    );
    const assign = hungarian(costs);
    let moved = false;
    for (let i = 0; i < redsBefore.length; i++) {
      const j = assign[i]!;
      if (j === -1) {
        changes.push({ kind: "potted", colour: "red" });
      } else {
        const d = costs[i]![j]!;
        if (d > MOVE_TOLERANCE) moved = true;
      }
    }
    if (moved) changes.push({ kind: "moved", colour: "red" });
  }
  // --- Colours and cue: presence-based.
  for (const colour of BALL_COLOURS) {
    if (colour === "red") continue;
    const wasThere = before.balls.some((b) => b.colour === colour);
    const isThere = after.balls.some((b) => b.colour === colour);
    if (wasThere && !isThere) {
      changes.push({ kind: "potted", colour });
    } else if (!wasThere && isThere) {
      changes.push({ kind: "respotted", colour });
    } else if (wasThere && isThere) {
      const b = pick(before.balls, colour);
      const a = pick(after.balls, colour);
      if (b && a && Math.hypot(b.x - a.x, b.y - a.y) > MOVE_TOLERANCE) {
        changes.push({ kind: "moved", colour });
      }
    }
  }
  return changes;
}

function pick(
  balls: ClassifiedBall[],
  colour: BallColour,
): ClassifiedBall | undefined {
  return balls.find((b) => b.colour === colour);
}
