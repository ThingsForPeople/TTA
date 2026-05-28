import { recommendBattingOrder, type BattingSlotRole } from '../lib/analysis';
import type { Team } from '../lib/types';

interface Props {
  team: Team;
}

const ROLE_LABEL: Record<BattingSlotRole, string> = {
  leadoff: 'Leadoff',
  quality: 'Quality AB',
  best: 'Best hitter',
  cleanup: 'Power',
  protection: 'Protection',
  lower: 'Lower',
};

const ROLE_CHIP: Record<BattingSlotRole, string> = {
  leadoff: 'bg-emerald-500/15 text-emerald-300',
  quality: 'bg-sky-500/15 text-sky-300',
  best: 'bg-indigo-500/15 text-indigo-300',
  cleanup: 'bg-red-500/15 text-red-300',
  protection: 'bg-orange-500/15 text-orange-300',
  lower: 'bg-slate-700/40 text-slate-400',
};

export function BattingOrderPanel({ team }: Props) {
  const { recommended } = recommendBattingOrder(team);

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">
        Recommended batting order
      </h2>
      {recommended.length === 0 ? (
        <p className="text-sm text-slate-400">No active players found.</p>
      ) : (
        <ol className="space-y-1.5">
          {recommended.map((slot) => {
            const ops = slot.player.batting?.ops;
            return (
              <li
                key={`${slot.slot}-${slot.player.name}`}
                className="flex items-center gap-3 rounded-md bg-slate-950/60 px-3 py-2 text-sm"
                title={slot.reason}
              >
                <span className="w-6 text-right font-mono text-slate-500">{slot.slot}.</span>
                <span className="flex-1 truncate text-slate-100">
                  {slot.player.name}
                  {slot.player.position ? (
                    <span className="ml-2 text-xs text-slate-500">{slot.player.position}</span>
                  ) : null}
                </span>
                <span
                  className={
                    'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ' +
                    ROLE_CHIP[slot.role]
                  }
                >
                  {ROLE_LABEL[slot.role]}
                </span>
                {slot.moved ? (
                  <span
                    title={`Currently slot ${slot.currentSlot}`}
                    className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-300"
                  >
                    ↕ from {slot.currentSlot}
                  </span>
                ) : null}
                <span className="w-16 text-right font-mono text-xs text-slate-400">
                  OPS {typeof ops === 'number' ? ops.toFixed(3).replace(/^0/, '') : '—'}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Picks fill in role priority: #3 cleanup (SLG + HR/RBI rate, low K%), #1 leadoff (OBP + BB
        rate, low K%), #2 best hitter (wOBP), #4 power-leaning OPS, #5 protection (SLG, low K%);
        #8 best contact to turn the order over; #6–7 by RBI production; pitcher pinned at 9. Hover
        a row to see why. ↕ marks slots that differ from current.
      </p>
    </section>
  );
}
