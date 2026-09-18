/**
 * Temporal consensus (plan task 7, first half).
 *
 * Detection runs on WINDOW consecutive post-stable frames; a ball is accepted
 * into the consensus TableState only if it appears (same colour, nearby
 * position) in at least MIN_VOTES of them. Positions are averaged. This
 * suppresses single-frame flicker from noise or specular highlights.
 */

import type { BallColour, ClassifiedBall, TableState } from "../types.ts";

export const CONSENSUS_WINDOW = 5;
export const CONSENSUS_MIN_VOTES = 3;
/** Max distance (canonical units) for two observations to count as one ball. */
const MATCH_RADIUS = 6;

interface Cluster {
  colour: BallColour;
  xs: number[];
  ys: number[];
  confs: number[];
  votes: number;
}

export function consensusState(
  frames: ClassifiedBall[][],
  timestamp: number,
  window = CONSENSUS_WINDOW,
  minVotes = CONSENSUS_MIN_VOTES,
): TableState {
  const recent = frames.slice(-window);
  const clusters: Cluster[] = [];
  for (const frameBalls of recent) {
    const claimed = new Set<Cluster>();
    for (const ball of frameBalls) {
      let best: Cluster | null = null;
      let bestDist = MATCH_RADIUS;
      for (const cluster of clusters) {
        if (cluster.colour !== ball.colour || claimed.has(cluster)) continue;
        const cx = mean(cluster.xs);
        const cy = mean(cluster.ys);
        const d = Math.hypot(cx - ball.x, cy - ball.y);
        if (d < bestDist) {
          bestDist = d;
          best = cluster;
        }
      }
      if (best) {
        best.xs.push(ball.x);
        best.ys.push(ball.y);
        best.confs.push(ball.confidence);
        best.votes++;
        claimed.add(best);
      } else {
        const cluster: Cluster = {
          colour: ball.colour,
          xs: [ball.x],
          ys: [ball.y],
          confs: [ball.confidence],
          votes: 1,
        };
        clusters.push(cluster);
        claimed.add(cluster);
      }
    }
  }
  const balls: ClassifiedBall[] = clusters
    .filter((c) => c.votes >= Math.min(minVotes, recent.length))
    .map((c) => ({
      colour: c.colour,
      x: mean(c.xs),
      y: mean(c.ys),
      confidence: mean(c.confs),
    }));
  const confidence =
    balls.length === 0 ? 1 : balls.reduce((s, b) => s + b.confidence, 0) / balls.length;
  return { timestamp, balls, confidence };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
