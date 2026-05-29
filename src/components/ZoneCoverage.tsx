import { computeZoneCoverage } from '../lib/zoneCoverage';
import type { Hand } from '../lib/playerMeta';

interface Props {
  talents: string[];
  bats?: Hand;
}

// Same red, deepening opacity: 1 talent = light, 2 = medium, 3+ = heavy.
function cellClass(count: number): string {
  if (count <= 0) return 'bg-transparent';
  if (count === 1) return 'bg-red-500/25';
  if (count === 2) return 'bg-red-500/50';
  return 'bg-red-500/80';
}

/**
 * Tiny 3×3 hitting-zone-coverage swatch for a roster row. Always rendered (even
 * for players with no batting talents — they still show the always-covered
 * center cell), so the widget stays in a consistent spot across every row.
 */
export function ZoneCoverage({ talents, bats }: Props) {
  const grid = computeZoneCoverage(talents, bats ?? 'R');

  return (
    <span
      className="shrink-0 inline-grid grid-cols-3 gap-px rounded-sm border border-slate-700/60 bg-slate-900/60 p-px"
      role="img"
      aria-label="Batting zone coverage"
      title={`Batting zone coverage (${bats === 'L' ? 'L' : 'R'}HB)`}
    >
      {grid.flatMap((row, r) =>
        row.map((count, c) => {
          // The center cell is the sweet spot — always fully covered, so it
          // renders opaque regardless of which directional talents a player has.
          const isCenter = r === 1 && c === 1;
          const cls = isCenter ? cellClass(3) : cellClass(count);
          return <span key={`${r}-${c}`} className={`h-1.5 w-1.5 rounded-[1px] ${cls}`} />;
        }),
      )}
    </span>
  );
}
