/**
 * Rule presets (FR-3, FR-8, AC-4).
 *
 * Deterministic, documented differences:
 * - professional: foul = max(4, value of ball involved, capped at 7); the
 *   "miss" rule is available (operator may replay via corrections); a tied
 *   frame after the final black respots the black.
 * - amateur: foul = max(4, ball value) like professional, but no miss rule
 *   and no respotted black on a tie (frame goes to the player who potted the
 *   final black — common league simplification).
 * - club: simplified flat foul — every foul is exactly 4 away regardless of
 *   the ball involved; no miss rule; no respotted black. Fouls always end the
 *   break and the turn (they do under every preset, but club has no exceptions).
 *
 * Professional and amateur end the frame on a foul with only the black left
 * (a tie respots the black under professional; amateur applies its usual tie
 * rule); club plays on until the black is actually potted.
 */

import type { RulePreset, RulePresetId } from "../types.ts";

const cap = (v: number) => Math.min(7, Math.max(4, v));

export const PRESETS: Record<RulePresetId, RulePreset> = {
  professional: {
    id: "professional",
    label: "Professional",
    foulPenalty: (ballValue) => cap(ballValue),
    missRule: true,
    respotBlackOnTie: true,
    foulOnBlackEndsFrame: true,
    reds: 15,
    description:
      "Full WPBSA scoring: fouls 4-7 by ball value, miss rule available, respotted black on ties.",
  },
  amateur: {
    id: "amateur",
    label: "Amateur",
    foulPenalty: (ballValue) => cap(ballValue),
    missRule: false,
    respotBlackOnTie: false,
    foulOnBlackEndsFrame: true,
    reds: 15,
    description:
      "League scoring: fouls 4-7 by ball value, no miss rule, no respotted black.",
  },
  club: {
    id: "club",
    label: "Club",
    foulPenalty: () => 4,
    missRule: false,
    respotBlackOnTie: false,
    foulOnBlackEndsFrame: false,
    reds: 15,
    description:
      "Simplified club scoring: every foul is a flat 4 away, no miss rule, no respotted black.",
  },
};

export function getPreset(id: RulePresetId): RulePreset {
  return PRESETS[id];
}
