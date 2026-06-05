// Optimal assignment (MAXIMIZE total weight) of rows → columns over a
// rectangular weight matrix, each row to a distinct column. Used to pick the
// best player for each of the 8 field positions such that no player fills two
// spots. Classic O(n³) Hungarian on a square-padded cost matrix; n is tiny here
// (≤ ~16 players), so it's instant.
//
//   weight[i][j] = value of assigning row i to column j, or null if ineligible.
//
// Returns, for each row, the chosen column index (or -1 if it ended up
// unassigned — e.g. a position no eligible player can fill).
export function maxAssignment(weight: (number | null)[][]): number[] {
  const rows = weight.length;
  const cols = rows > 0 ? weight[0].length : 0;
  const n = Math.max(rows, cols);
  if (n === 0) return [];

  // Square cost matrix for MINIMIZATION: cost = −value. Ineligible cells and
  // padding get a large finite cost so they're avoided unless unavoidable.
  const BIG = 1e9;
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) {
    cost[i] = [];
    for (let j = 0; j < n; j++) {
      if (i < rows && j < cols) {
        const w = weight[i][j];
        cost[i][j] = w == null ? BIG : -w;
      } else {
        cost[i][j] = 0; // dummy padding row/col — free
      }
    }
  }

  // Hungarian via potentials (1-indexed internals; p[j] = row matched to col j).
  const INF = Infinity;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else { minv[j] -= delta; }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  // p[j] = row assigned to column j → build row→col, dropping any match that
  // landed on an ineligible (null) cell.
  const rowToCol = new Array(rows).fill(-1);
  for (let j = 1; j <= n; j++) {
    const i = p[j];
    if (i >= 1 && i <= rows && j <= cols && weight[i - 1][j - 1] != null) {
      rowToCol[i - 1] = j - 1;
    }
  }
  return rowToCol;
}
