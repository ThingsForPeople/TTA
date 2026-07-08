/** Offline expected-outcome (xwOBA / expected-bases) refitter. Bins batted
 *  balls by launch angle × exit velocity and measures empirical expected bases
 *  and wOBA-on-contact. Prints the E_BASES / WOBACON tables + EV_CUTS to paste
 *  into src/lib/expectedOutcome.ts. Run: npx tsx scripts/fit-expected-outcome.ts [teamUuid] [numGames]
 */
const TEAM = process.argv[2] ?? '019ddff2-6cbc-7ecb-b0b1-a6b511f3379e';
const N = Number(process.argv[3] ?? 120);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const W: Record<string, number> = { single: 0.89, double: 1.27, triple: 1.62, homerun: 2.10 };
const BASES: Record<string, number> = { single: 1, double: 2, triple: 3, homerun: 4 };
const HIT = new Set(['single', 'double', 'triple', 'homerun']);

async function fetchReplay(id: string): Promise<any | null> {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`https://www.tiny-teams.com/api/replay/${id}`, { headers: { Accept: 'application/json' } });
    if (res.ok) return res.json(); if (res.status === 404) return null; await sleep(1500 * (i + 1));
  }
  return null;
}
async function enumerate(): Promise<string[]> {
  const ids: string[] = [];
  for (let p = 0; p < Math.ceil(N / 10) + 1 && ids.length < N; p++) {
    const res = await fetch(`https://www.tiny-teams.com/api/team-search/teams/${TEAM}/games?offset=${p * 10}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) break; const j: any = await res.json();
    for (const g of j.results ?? []) ids.push(g.game_id); if (!j.has_more) break;
  }
  return ids.slice(0, N);
}
const balls: { la: number; ev: number; res: string }[] = [];
function ingest(raw: any) {
  for (const s of raw?.segments ?? []) {
    const evs = s.events ?? [];
    const c = evs.find((e: any) => e.type === 'batter.contact')?.payload;
    const r = evs.find((e: any) => e.type === 'batter.result')?.payload?.result;
    if (c && r && typeof c.exitVelocity === 'number' && typeof c.launchAngle === 'number' && r !== 'walk' && r !== 'strikeout' && !/^Foul/.test(c.hitDirection ?? ''))
      balls.push({ la: c.launchAngle, ev: c.exitVelocity, res: r });
  }
}
async function main() {
  // REPLAY_DIR mode: fit from locally harvested replay JSON files instead of
  // fetching (harvest once, fit many — the endpoint 429s aggressive walks).
  const dir = process.env.REPLAY_DIR;
  if (dir) {
    const fs = await import('fs');
    const path = await import('path');
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      ingest(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    }
  } else {
    const ids = await enumerate();
    for (const id of ids) { const raw = await fetchReplay(id); if (raw) ingest(raw); await sleep(800); }
  }
  const laB = (la: number) => la < 0 ? 0 : la < 10 ? 1 : la < 20 ? 2 : la < 30 ? 3 : la < 40 ? 4 : la < 55 ? 5 : 6;
  const sorted = balls.map((b) => b.ev).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(p * sorted.length)];
  const cuts = [q(0.2), q(0.4), q(0.6), q(0.8)];
  const evB = (ev: number) => ev < cuts[0] ? 0 : ev < cuts[1] ? 1 : ev < cuts[2] ? 2 : ev < cuts[3] ? 3 : 4;
  const T: any[][] = Array.from({ length: 7 }, () => Array.from({ length: 5 }, () => ({ n: 0, bases: 0, woba: 0 })));
  for (const b of balls) { const c = T[laB(b.la)][evB(b.ev)]; c.n++; c.bases += BASES[b.res] ?? 0; c.woba += W[b.res] ?? 0; }
  const eb = T.map((row) => row.map((c) => c.n ? Math.round((c.bases / c.n) * 100) / 100 : 0));
  const wc = T.map((row) => row.map((c) => c.n ? Math.round((c.woba / c.n) * 1000) / 1000 : 0));
  console.log(`${balls.length} batted balls. EV cuts ${cuts.map((v) => Math.round(v * 10) / 10).join(',')}`);
  console.log('league wOBAcon ≈', (balls.reduce((s, b) => s + (W[b.res] ?? 0), 0) / balls.length).toFixed(3));
  console.log('EV_CUTS =', JSON.stringify(cuts.map((v) => Math.round(v * 10) / 10)));
  console.log('E_BASES =', JSON.stringify(eb), '\n(fill empty extreme cells to nearest in-row neighbor before pasting)');
  console.log('WOBACON =', JSON.stringify(wc));
}
main().catch((e) => { console.error(e); process.exit(1); });

export {};
