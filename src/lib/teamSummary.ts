import type { ModeFilter, TimeFilter } from './api';
import { MODE_OPTIONS, TIME_OPTIONS } from './api';
import { effectiveStats, normalizeArchetype, type PitchTalent, type PlayerMetaStore } from './playerMeta';
import { TALENT_BY_NAME } from './talents';
import type { Player, Team } from './types';

function fmt3(v: number | undefined): string {
  if (typeof v !== 'number') return '—';
  return v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0/, '');
}

function fmt2(v: number | undefined): string {
  return typeof v === 'number' ? v.toFixed(2) : '—';
}

function labelFor<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T,
): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

// Manual archetype override (set in the Roster editor) wins over the scraped one.
function archetypeOf(p: Player, metaStore: PlayerMetaStore): string | undefined {
  return (p.uuid ? metaStore[p.uuid]?.archetype : undefined) ?? normalizeArchetype(p.archetype);
}

function playerMetaLine(p: Player, metaStore: PlayerMetaStore): string {
  const meta = p.uuid ? metaStore[p.uuid] : undefined;
  if (!meta) return '';
  const parts: string[] = [];
  if (typeof meta.age === 'number') {
    parts.push(`Age: ${meta.age}`);
  }
  if (meta.bats || meta.throws) {
    parts.push(`B/T: ${meta.bats ?? '?'}/${meta.throws ?? '?'}`);
  }
  const s = meta.sim;
  if (s.con || s.pow || s.spd || s.fld || s.arm || s.pit || s.sta) {
    parts.push(`Sims: CON=${s.con} POW=${s.pow} SPD=${s.spd} FLD=${s.fld} ARM=${s.arm} PIT=${s.pit} STA=${s.sta}`);
  }
  if (meta.injury) {
    const eff = effectiveStats(meta);
    parts.push(`INJURED (${meta.injury.severity}${meta.injury.note ? ': ' + meta.injury.note : ''}) — effective: CON=${eff.con} POW=${eff.pow} SPD=${eff.spd} FLD=${eff.fld} ARM=${eff.arm} PIT=${eff.pit} STA=${eff.sta}`);
  }
  if (meta.talents.length) {
    const talentDescs = meta.talents.map((t) => {
      const def = TALENT_BY_NAME[t];
      const lvl = meta.talentLevels?.[t] ?? 1;
      const lvlStr = lvl > 1 ? ` Lv${lvl}` : '';
      return def ? `${t}${lvlStr} (${def.description})` : `${t}${lvlStr}`;
    });
    parts.push(`Talents: ${talentDescs.join('; ')}`);
  }
  if (meta.pitchTalents && meta.pitchTalents.length > 0) {
    const pitchDescs = meta.pitchTalents.map((pt) => {
      const subs = pt.sub.length
        ? ' [' + pt.sub.map((s) => `${s.name} Lv${s.level}`).join(', ') + ']'
        : '';
      return `${pt.pitch} Lv${pt.level}${subs}`;
    });
    parts.push(`Pitches: ${pitchDescs.join('; ')}`);
  }
  return parts.length ? `  → ${parts.join(' | ')}` : '';
}

export function buildTeamSummary(
  team: Team,
  filters: { time: TimeFilter; mode: ModeFilter },
  metaStore: PlayerMetaStore,
): string {
  const lines: string[] = [];
  lines.push(`# Team: ${team.name ?? '(unknown)'}`);
  if (team.manager) lines.push(`Manager: ${team.manager}`);
  if (team.recentRecord) lines.push(`Record: ${team.recentRecord}`);
  lines.push(
    `Stats window: ${labelFor(TIME_OPTIONS, filters.time)} / ${labelFor(MODE_OPTIONS, filters.mode)}`,
  );
  lines.push('');

  const roster = team.players.filter((p) => !p.bench);
  const bench = team.players.filter((p) => p.bench);

  lines.push('## Active roster');
  lines.push('| # | Name | Pos | Archetype | AVG/OBP/SLG | OPS | AB | R | HR | RBI | BB | K | FLD% | PO | A | E |');
  lines.push('|---|------|-----|-----------|-------------|-----|----|----|----|----|----|----|------|----|----|---|');
  for (const p of roster) {
    const b = p.batting ?? {};
    const f = p.fielding;
    const slash = `${fmt3(b.avg)}/${fmt3(b.obp)}/${fmt3(b.slg)}`;
    const fPct = f?.fieldingPct != null ? fmt3(f.fieldingPct) : '-';
    lines.push(
      `| ${p.battingOrder ?? '-'} | ${p.name} | ${p.position ?? '-'} | ${archetypeOf(p, metaStore) ?? '-'} | ${slash} | ${fmt3(b.ops)} | ${b.ab ?? '-'} | ${b.runs ?? '-'} | ${b.hr ?? '-'} | ${b.rbi ?? '-'} | ${b.bb ?? '-'} | ${b.k ?? '-'} | ${fPct} | ${f?.putouts ?? '-'} | ${f?.assists ?? '-'} | ${f?.errors ?? '-'} |`,
    );
    const metaLine = playerMetaLine(p, metaStore);
    if (metaLine) lines.push(metaLine);
  }

  if (bench.length) {
    lines.push('');
    lines.push('## Bench');
    for (const p of bench) {
      const b = p.batting ?? {};
      const f = p.fielding;
      const fStr = f?.fieldingPct != null ? `, F% ${fmt3(f.fieldingPct)} (${f.putouts ?? 0}PO ${f.assists ?? 0}A ${f.errors ?? 0}E)` : '';
      lines.push(
        `- ${p.name} (${p.position ?? '?'}, ${archetypeOf(p, metaStore) ?? '?'}) — ${fmt3(b.avg)}/${fmt3(b.obp)}/${fmt3(b.slg)}, ${b.ab ?? 0} AB${fStr}`,
      );
      const metaLine = playerMetaLine(p, metaStore);
      if (metaLine) lines.push(metaLine);
    }
  }

  if (team.pitcher) {
    const p = team.pitcher;
    const pi = p.pitching ?? {};
    lines.push('');
    lines.push('## Pitcher');
    lines.push(
      `${p.name} (${archetypeOf(p, metaStore) ?? '?'}) — ERA ${fmt2(pi.era)}, WHIP ${fmt2(pi.whip)}, ${pi.ip ?? '-'} IP, ${pi.k ?? '-'} K, ${pi.bb ?? '-'} BB`,
    );
    const metaLine = playerMetaLine(p, metaStore);
    if (metaLine) lines.push(metaLine);
  }

  if (team.recentGames.length) {
    lines.push('');
    lines.push(`## Recent games (${team.recentGames.length})`);
    for (const g of team.recentGames.slice(0, 15)) {
      const wl = g.won ? 'W' : 'L';
      const venue = g.wasHome ? 'vs' : '@';
      lines.push(`- ${wl} ${venue} ${g.opponentName} ${g.ourScore}-${g.opponentScore}`);
    }
  }

  return lines.join('\n');
}

function compactMetaLine(p: Player, metaStore: PlayerMetaStore): string {
  const meta = p.uuid ? metaStore[p.uuid] : undefined;
  if (!meta) return '';
  const parts: string[] = [];
  if (meta.bats || meta.throws) parts.push(`${meta.bats ?? '?'}/${meta.throws ?? '?'}`);
  const s = meta.sim;
  if (s.con || s.pow || s.spd || s.fld || s.arm || s.pit || s.sta) {
    parts.push(`${s.con}/${s.pow}/${s.spd}/${s.fld}/${s.arm}/${s.pit}/${s.sta}`);
  }
  if (meta.injury) parts.push(`INJ:${meta.injury.severity}`);
  if (meta.talents.length) {
    parts.push(meta.talents.map((t) => {
      const lvl = meta.talentLevels?.[t] ?? 1;
      return lvl > 1 ? `${t} Lv${lvl}` : t;
    }).join(', '));
  }
  if (meta.pitchTalents && meta.pitchTalents.length > 0) {
    parts.push(meta.pitchTalents.map((pt) => {
      const subs = pt.sub.length
        ? '[' + pt.sub.map((s) => `${s.name}${s.level > 1 ? ' Lv' + s.level : ''}`).join(',') + ']'
        : '';
      return `${pt.pitch}Lv${pt.level}${subs}`;
    }).join('; '));
  }
  return parts.length ? ` → ${parts.join(' | ')}` : '';
}

export function buildCompactSummary(
  team: Team,
  filters: { time: TimeFilter; mode: ModeFilter },
  metaStore: PlayerMetaStore,
): string {
  const lines: string[] = [];
  lines.push(`Team: ${team.name ?? '?'} ${team.recentRecord ?? ''}`);
  lines.push('');

  const roster = team.players.filter((p) => !p.bench);
  const bench = team.players.filter((p) => p.bench);

  lines.push('Roster (sim: CON/POW/SPD/FLD/ARM/PIT/STA):');
  for (const p of roster) {
    const b = p.batting ?? {};
    const f = p.fielding;
    const fStr = f?.fieldingPct != null ? ` F%${fmt3(f.fieldingPct)}` : '';
    lines.push(
      `${p.battingOrder ?? '-'}. ${p.name} ${p.position ?? '?'} ${p.archetype ?? '?'} ${fmt3(b.avg)}/${fmt3(b.obp)}/${fmt3(b.slg)} ${b.ab ?? 0}AB ${b.hr ?? 0}HR ${b.bb ?? 0}BB ${b.k ?? 0}K${fStr}${compactMetaLine(p, metaStore)}`,
    );
  }

  if (bench.length) {
    lines.push('Bench:');
    for (const p of bench) {
      const b = p.batting ?? {};
      lines.push(
        `- ${p.name} ${p.position ?? '?'} ${fmt3(b.avg)}/${fmt3(b.obp)}/${fmt3(b.slg)} ${b.ab ?? 0}AB${compactMetaLine(p, metaStore)}`,
      );
    }
  }

  if (team.pitcher) {
    const pi = team.pitcher.pitching ?? {};
    lines.push(
      `P: ${team.pitcher.name} ERA${fmt2(pi.era)} WHIP${fmt2(pi.whip)} ${pi.ip ?? '-'}IP ${pi.k ?? '-'}K${compactMetaLine(team.pitcher, metaStore)}`,
    );
  }

  if (team.recentGames.length) {
    const wins = team.recentGames.filter((g) => g.won).length;
    lines.push(`Recent: ${wins}-${team.recentGames.length - wins}`);
  }

  return lines.join('\n');
}
