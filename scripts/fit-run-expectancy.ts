/** Offline RE24 (run-expectancy) refitter. Walks each game's `gameState` to
 *  measure expected runs from each base-out state to the end of the half-inning
 *  (standard RE24, complete innings only). Prints the RUN_EXPECTANCY matrix to
 *  paste into src/lib/runExpectancy.ts. Run: npx tsx scripts/fit-run-expectancy.ts [teamUuid] [numGames]
 */
const TEAM = process.argv[2] ?? '019ddff2-6cbc-7ecb-b0b1-a6b511f3379e';
const N = Number(process.argv[3] ?? 120);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const baseIdx = (runners: (string | null)[]) => (runners?.[0] ? 1 : 0) + (runners?.[1] ? 2 : 0) + (runners?.[2] ? 4 : 0);

async function fetchReplay(id: string): Promise<any | null> {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`https://www.tiny-teams.com/api/replay/${id}`, { headers: { Accept: 'application/json' } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    await sleep(1500 * (i + 1));
  }
  return null;
}
async function enumerate(): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 0; page < Math.ceil(N / 10) + 1 && ids.length < N; page++) {
    const res = await fetch(`https://www.tiny-teams.com/api/team-search/teams/${TEAM}/games?offset=${page * 10}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) break;
    const json: any = await res.json();
    for (const g of json.results ?? []) ids.push(g.game_id);
    if (!json.has_more) break;
  }
  return ids.slice(0, N);
}

const buckets: number[][][] = Array.from({ length: 8 }, () => [[], [], []]);
let halfInnings = 0;

function ingest(raw: any) {
  const segs = raw?.segments ?? [];
  type HS = { key: string; half: string; states: { base: number; outs: number; score: number }[]; endScore: number };
  const halves: HS[] = [];
  let cur: HS | null = null;
  const seenAB = new Set<number>();
  for (const s of segs) {
    const md = s.metadata ?? {}; const gs = s.gameState;
    if (!gs || md.inning == null || !md.half) continue;
    const key = md.inning + '|' + md.half;
    if (!cur || cur.key !== key) { cur = { key, half: md.half, states: [], endScore: 0 }; halves.push(cur); seenAB.clear(); }
    const battingScore = md.half === 'top' ? (gs.score?.away ?? 0) : (gs.score?.home ?? 0);
    cur.endScore = battingScore;
    const ab = md.atBatId;
    if (ab != null && !seenAB.has(ab) && typeof gs.outs === 'number' && gs.outs < 3) {
      seenAB.add(ab);
      cur.states.push({ base: baseIdx(gs.runners ?? []), outs: gs.outs, score: battingScore });
    }
  }
  for (let i = 0; i < halves.length - 1; i++) { // drop final half (walk-off/truncation)
    halfInnings++;
    for (const st of halves[i].states) {
      const r = halves[i].endScore - st.score;
      if (r >= 0 && r <= 20) buckets[st.base][st.outs].push(r);
    }
  }
}

async function main() {
  const ids = await enumerate();
  for (const id of ids) { const raw = await fetchReplay(id); if (raw) ingest(raw); await sleep(800); }
  const BASE = ['___', '1__', '_2_', '12_', '__3', '1_3', '_23', '123'];
  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  console.log(`Fit over ${halfInnings} complete half-innings\nbase   0out (n)      1out (n)      2out (n)`);
  const matrix: number[][] = [];
  for (let b = 0; b < 8; b++) {
    const row: number[] = []; let line = BASE[b] + '  ';
    for (let o = 0; o < 3; o++) { const a = buckets[b][o]; const m = avg(a); row.push(Math.round(m * 1000) / 1000); line += `${Number.isFinite(m) ? m.toFixed(3) : ' NA '} (${String(a.length).padStart(4)})  `; }
    matrix.push(row); console.log(line);
  }
  console.log('\nconst RUN_EXPECTANCY: number[][] = ' + JSON.stringify(matrix) + ';');
}
main().catch((e) => { console.error(e); process.exit(1); });

export {};
