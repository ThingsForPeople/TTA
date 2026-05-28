import type { Team } from './types';
import type { PlayerMetaStore } from './playerMeta';
import { effectiveStats, hasSim, isInjured } from './playerMeta';
import { optimizeRoster } from './rosterOptimizer';

type FieldPosition = 'SS' | 'CF' | 'RF' | '3B' | '2B' | 'C' | '1B' | 'LF';

const DEFENSE_THRESHOLDS: Record<string, { stats: string[]; min: number }> = {
  SS: { stats: ['fld', 'spd'], min: 60 },
  '2B': { stats: ['fld', 'spd'], min: 55 },
  CF: { stats: ['spd'], min: 60 },
  RF: { stats: ['arm'], min: 60 },
  '3B': { stats: ['arm', 'fld'], min: 55 },
  C: { stats: ['arm', 'fld'], min: 50 },
};

const BAT_FIRST = new Set(['1B', 'LF']);

function fmt3(v: number | undefined): string {
  if (typeof v !== 'number') return '—';
  return v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0/, '');
}

export function buildPreComputedInsights(
  team: Team,
  metaStore: PlayerMetaStore,
): string {
  const sections: string[] = [];
  const opt = optimizeRoster(team, metaStore);

  // Position mismatches
  const moves = opt.assignments.filter((a) => a.moved && a.currentPosition);
  if (moves.length > 0) {
    const lines = moves.map((a) => {
      const meta = a.player.uuid ? metaStore[a.player.uuid] : undefined;
      const sim = meta ? effectiveStats(meta) : null;
      const statNote = sim ? ` (FLD=${sim.fld}, SPD=${sim.spd}, ARM=${sim.arm}, POW=${sim.pow})` : '';
      return `- Move ${a.player.name} from ${a.currentPosition} to ${a.position}${statNote}. Fit score: ${a.positionScore}. Reason: ${a.reason}.`;
    });
    sections.push(`POSITION CHANGES:\n${lines.join('\n')}`);
  } else {
    sections.push('POSITION CHANGES:\n- All players are optimally placed at their current positions.');
  }

  // Position fit warnings for current roster
  const fitIssues: string[] = [];
  for (const a of opt.assignments) {
    const meta = a.player.uuid ? metaStore[a.player.uuid] : undefined;
    if (!meta || !hasSim(meta)) continue;
    const sim = effectiveStats(meta);
    const pos = a.position as FieldPosition;
    const thresholds = DEFENSE_THRESHOLDS[pos];
    if (thresholds) {
      for (const stat of thresholds.stats) {
        const val = sim[stat as keyof typeof sim];
        if (val < thresholds.min) {
          fitIssues.push(`- ${a.player.name} at ${pos}: ${stat.toUpperCase()}=${val} is below ${thresholds.min} threshold for ${pos}.`);
        }
      }
    }
    if (BAT_FIRST.has(pos) && sim.fld >= 70 && sim.spd >= 65) {
      fitIssues.push(`- ${a.player.name} at ${pos}: has strong defense (FLD=${sim.fld}, SPD=${sim.spd}) that could be better used at a defense-critical position.`);
    }
  }
  if (fitIssues.length > 0) {
    sections.push(`POSITION FIT CONCERNS:\n${fitIssues.join('\n')}`);
  }

  // Batting order changes
  const boMoves = opt.battingOrder.recommended.filter((s) => s.moved);
  if (boMoves.length > 0) {
    const lines = boMoves.map((s) => {
      const ops = s.player.batting?.ops;
      const opsStr = ops !== undefined ? ` OPS ${fmt3(ops)}` : '';
      const dir = s.currentSlot !== undefined
        ? (s.slot < s.currentSlot ? `up from #${s.currentSlot}` : `down from #${s.currentSlot}`)
        : '';
      return `- ${s.player.name}: slot #${s.slot} (${s.reason}).${opsStr}. ${dir}`.trim();
    });
    sections.push(`BATTING ORDER CHANGES:\n${lines.join('\n')}`);
  } else {
    sections.push('BATTING ORDER:\n- Current batting order is optimal.');
  }

  // Injury impact
  const injured = opt.assignments.filter((a) => a.injured);
  if (injured.length > 0) {
    const lines = injured.map((a) => {
      const meta = a.player.uuid ? metaStore[a.player.uuid] : undefined;
      const severity = meta?.injury?.severity ?? 'unknown';
      return `- ${a.player.name}: ${severity} injury. Consider benching if a healthy bench option is available.`;
    });
    sections.push(`INJURIES:\n${lines.join('\n')}`);
  }

  // Talent synergies from optimizer
  const synergies = opt.assignments.filter((a) => a.talentSynergies.length > 0);
  if (synergies.length > 0) {
    const lines = synergies.map((a) =>
      `- ${a.player.name} at ${a.position}: ${a.talentSynergies.join(', ')}.`
    );
    sections.push(`TALENT SYNERGIES:\n${lines.join('\n')}`);
  }

  // Pitcher summary
  const pitcher = team.pitcher;
  if (pitcher) {
    const meta = pitcher.uuid ? metaStore[pitcher.uuid] : undefined;
    const pi = pitcher.pitching;
    const pitchLines: string[] = [];
    if (pi) {
      pitchLines.push(`- ${pitcher.name}: ERA ${pi.era?.toFixed(2) ?? '—'}, WHIP ${pi.whip?.toFixed(2) ?? '—'}, ${pi.ip ?? '—'} IP, ${pi.k ?? '—'} K.`);
    }
    if (meta?.pitchTalents?.length) {
      const pitches = meta.pitchTalents.map((pt) => `${pt.pitch} Lv${pt.level}`).join(', ');
      pitchLines.push(`- Pitch repertoire: ${pitches}. These are STRENGTHS — do not suggest replacing this pitcher.`);
    }
    if (meta && hasSim(meta)) {
      const sim = effectiveStats(meta);
      pitchLines.push(`- PIT=${sim.pit}, STA=${sim.sta}. Only these stats matter for pitching.`);
    }
    if (pitchLines.length > 0) {
      sections.push(`PITCHER:\n${pitchLines.join('\n')}`);
    }
  }

  // Warnings from optimizer
  if (opt.warnings.length > 0) {
    sections.push(`NOTES:\n${opt.warnings.map((w) => `- ${w}`).join('\n')}`);
  }

  return sections.join('\n\n');
}
