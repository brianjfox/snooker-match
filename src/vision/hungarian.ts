/**
 * Hungarian (Kuhn–Munkres) assignment on a square cost matrix — used by the
 * StateObserver to match red-ball positions between consecutive stable states
 * without persistent identities (plan task 7, ADR-7).
 *
 * O(n^3) potentials implementation. Rectangular inputs are padded with a
 * large cost; padded assignments are reported as -1 (unmatched).
 */

const BIG = 1e9;

/**
 * Returns `assign` where assign[i] = column matched to row i, or -1 when the
 * row is effectively unmatched (padded column).
 */
export function hungarian(costs: number[][]): number[] {
  const rows = costs.length;
  const cols = rows > 0 ? costs[0]!.length : 0;
  if (rows === 0 || cols === 0) return new Array(rows).fill(-1);
  const n = Math.max(rows, cols);
  // Pad to square with BIG cost.
  const a: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      row.push(i < rows && j < cols ? costs[i]![j]! : BIG);
    }
    a.push(row);
  }
  // Potentials + matching (1-indexed internals, classic formulation).
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0); // p[j] = row matched to column j
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const assign = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= n; j++) {
    const i = p[j]! - 1;
    const col = j - 1;
    if (i >= 0 && i < rows && col < cols && a[i]![col]! < BIG / 2) {
      assign[i] = col;
    }
  }
  return assign;
}
