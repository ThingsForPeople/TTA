/** Decode the pitchZone cell numbering (1–9 grid, 10 = out of zone) by joining
 *  batter zone-talent effect activations to the segment's pitchZone: a
 *  directional hitting-zone talent (hz:<row|col>:<effect>) only fires when the
 *  pitch lands in its 3 covered cells, so P(activation | cell) concentrates on
 *  exactly those cells. Run over a harvested replay dir:
 *  `REPLAY_DIR=<dir> npx tsx scripts/decode-zones.ts`
 *  Prints per-direction cell distributions + a proposed mapping to paste into
 *  talentEffects.ts (ZONE_CELLS).
 */
import fs from 'fs';
import path from 'path';

const DIR = process.env.REPLAY_DIR;
if (!DIR) { console.error('set REPLAY_DIR=<harvested replay json dir>'); process.exit(1); }

// direction → cellId → activation count; plus overall cell exposure.
const byDir = new Map<string, Map<string, number>>();
const exposure = new Map<string, number>();

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  // Batter handedness matters for inside/outside — decode per hand.
  const bats = new Map<string, string>();
  for (const side of ['home', 'away']) {
    for (const p of d.game?.[side]?.players ?? []) bats.set(p.id, p.bats);
  }
  for (const s of d.segments ?? []) {
    const batterId = s.metadata?.batterId;
    let zone: unknown;
    for (const e of s.events ?? []) if (e.type === 'pitch.thrown') zone = e.payload?.pitchZone;
    if (zone == null) continue;
    const cell = String(zone);
    exposure.set(cell, (exposure.get(cell) ?? 0) + 1);
    for (const e of s.events ?? []) {
      if (e.type !== 'effect.activated') continue;
      const pl = e.payload ?? {};
      if (pl.source !== 'talent' || pl.targetEntityId !== batterId) continue;
      const m = /^hz:(high|low|inside|outside):/.exec(pl.talentId ?? '');
      if (!m) continue;
      const hand = bats.get(batterId) ?? '?';
      // Rows are absolute; columns flip with handedness → key columns by hand.
      const dir = m[1] === 'high' || m[1] === 'low' ? m[1] : `${m[1]}(${hand})`;
      const cells = byDir.get(dir) ?? new Map<string, number>();
      cells.set(cell, (cells.get(cell) ?? 0) + 1);
      byDir.set(dir, cells);
    }
  }
}

console.log('cell exposure:', Object.fromEntries([...exposure.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))));
const mapping: Record<string, string[]> = {};
for (const [dir, cells] of [...byDir.entries()].sort()) {
  const total = [...cells.values()].reduce((s, v) => s + v, 0);
  const rows = [...cells.entries()]
    .map(([cell, n]) => ({ cell, n, rate: n / (exposure.get(cell) ?? 1) }))
    .sort((a, b) => b.rate - a.rate);
  console.log(`\n${dir}: ${total} activations`);
  for (const r of rows) console.log(`  cell ${r.cell}: ${r.n} (${(100 * r.rate).toFixed(1)}% of pitches there)`);
  // A direction covers 3 cells; take the top 3 by activation rate.
  mapping[dir] = rows.slice(0, 3).map((r) => r.cell).sort((a, b) => Number(a) - Number(b));
}
console.log('\nproposed ZONE_CELLS =', JSON.stringify(mapping, null, 1));
