import { TALENT_BY_NAME } from './talents';
import type { Hand } from './playerMeta';

/**
 * Hitting zone coverage derived from a player's zone talents.
 *
 * The strike zone is a 3×3 grid. Each directional zone talent
 * (e.g. "High Driver", "Inside Chopper") covers a full row or column —
 * 3 cells. We count how many talents touch each cell so the UI can shade
 * by coverage depth (1 = light, 2 = medium, 3+ = heavy).
 *
 * Rows (High/Mid/Low) are absolute. Columns (Inside/Mid/Outside) flip with
 * batter handedness — Inside is the column closest to the batter — so a grid
 * rendered from the catcher's perspective mirrors for left-handed batters.
 *
 * grid[row][col]: row 0 = High, 1 = Mid, 2 = Low; col 0..2 left→right.
 */
export type ZoneGrid = number[][];

// Hitting zone talent ids look like `hz:high:line_drive`. The directional
// segment is what places the talent on the grid; the effect is irrelevant here.
const ZONE_DIR_RE = /^hz:(high|low|inside|outside):/;

export function computeZoneCoverage(talents: string[], bats: Hand = 'R'): ZoneGrid {
  const grid: ZoneGrid = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  // Inside = closest to the batter. From the catcher's perspective that's the
  // left column for a right-handed batter and the right column for a lefty.
  const insideCol = bats === 'L' ? 2 : 0;
  const outsideCol = bats === 'L' ? 0 : 2;

  for (const name of talents) {
    const def = TALENT_BY_NAME[name];
    if (!def) continue;
    const m = def.id.match(ZONE_DIR_RE);
    if (!m) continue;

    switch (m[1]) {
      case 'high':
        grid[0][0]++; grid[0][1]++; grid[0][2]++;
        break;
      case 'low':
        grid[2][0]++; grid[2][1]++; grid[2][2]++;
        break;
      case 'inside':
        grid[0][insideCol]++; grid[1][insideCol]++; grid[2][insideCol]++;
        break;
      case 'outside':
        grid[0][outsideCol]++; grid[1][outsideCol]++; grid[2][outsideCol]++;
        break;
    }
  }

  return grid;
}

export function hasZoneCoverage(grid: ZoneGrid): boolean {
  return grid.some((row) => row.some((c) => c > 0));
}
