/** Offline POS_CURVE fitter. Logistic regression of out-vs-distance per
 *  position over the most-recent N games, so each position's curve is
 *  calibrated (mean PAE/chance ≈ 0) on current data. Prints the new POS_CURVE
 *  literal + per-position diagnostics. Paste the result into parseReplay.ts.
 *  Run: npx tsx scripts/fit-curves.ts [teamUuid] [n]
 */
import { collectFieldingChances, extractPlayerMetrics, expectedOut, fitOutCurve, type FieldingChance } from '../src/lib/parseReplay';
import { POS_NUM_TO_STR } from '../src/lib/fieldingGrades';

const TEAM = process.argv[2] ?? '019ddff2-6cbc-7ecb-b0b1-a6b511f3379e';
const N = Number(process.argv[3] ?? 50);
const MIN_N = 40; // need this many chances to refit a position; else keep current
const FIT_POS = [3, 4, 5, 6, 7, 8, 9]; // 1B,2B,3B,SS,LF,CF,RF (skip P/C)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// current curve (fallback for sparse positions) — keep in sync with POS_CURVE
// in parseReplay.ts (last refit 2026-07-08 post-patch; OF converts ~100% of
// engaged chances now, so 7/8/9 are near-1 plateaus).
const CURRENT: Record<number, { a: number; d50: number }> = {
  1: { a: 0.35, d50: 12 }, 2: { a: 0.35, d50: 10 }, 3: { a: 0.11, d50: 26 },
  4: { a: 0.76, d50: 17.5 }, 5: { a: 0.44, d50: 14.3 }, 6: { a: 0.39, d50: 16 },
  7: { a: 0.15, d50: 40 }, 8: { a: 0.15, d50: 40 }, 9: { a: 0.15, d50: 40 },
};

async function fetchReplay(id: string): Promise<any | null> {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`https://www.tiny-teams.com/api/replay/${id}`, { headers: { Accept: 'application/json' } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    await sleep(1500 * (i + 1));
  }
  return null;
}

// Fit via the shared IRLS fitter (same one the query route uses at runtime).
const fit = (data: FieldingChance[]) => fitOutCurve(data.map((c) => ({ d: c.distance, o: c.isOut })), MIN_N);

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

async function main() {
  const ids = await enumerate();

  const byPos = new Map<number, FieldingChance[]>();
  let games = 0;
  // sanity: compare Σisout per pos vs extractPlayerMetrics engagedOuts per pos
  const checkEngaged = new Map<number, number>();
  for (const id of ids) {
    const raw = await fetchReplay(id);
    if (!raw) { await sleep(900); continue; }
    const chances = collectFieldingChances(raw, TEAM);
    if (chances.length) games++;
    for (const c of chances) {
      if (c.position == null) continue;
      (byPos.get(c.position) ?? byPos.set(c.position, []).get(c.position)!).push(c);
    }
    const gm = extractPlayerMetrics(raw, TEAM);
    for (const p of gm.players) {
      if (p.position == null) continue;
      checkEngaged.set(p.position, (checkEngaged.get(p.position) ?? 0) + p.engagedOuts);
    }
    await sleep(800);
  }

  console.log(`Fitted over ${games} games, ${[...byPos.values()].reduce((s, a) => s + a.length, 0)} chances\n`);
  console.log('Pos  n    out%   bucket out% (<6/6-12/>12)   fitted a / d50   current a/d50   meanPAE/ch (new→old)   reconcile');

  const fitted: Record<number, { a: number; d50: number }> = { ...CURRENT };
  for (const pos of FIT_POS) {
    const data = byPos.get(pos) ?? [];
    const n = data.length;
    const outs = data.filter((c) => c.isOut).length;
    const b = (lo: number, hi: number) => {
      const sub = data.filter((c) => c.distance >= lo && c.distance < hi);
      return sub.length ? `${Math.round((sub.filter((c) => c.isOut).length / sub.length) * 100)}%` : '—';
    };
    const f = fit(data);
    const used = f ?? CURRENT[pos];
    if (f) fitted[pos] = f;
    const meanResid = (c: { a: number; d50: number }) =>
      n ? data.reduce((s, x) => s + ((x.isOut ? 1 : 0) - 1 / (1 + Math.exp(c.a * (x.distance - c.d50)))), 0) / n : 0;
    const recon = checkEngaged.get(pos) ?? 0;
    console.log(
      `${(POS_NUM_TO_STR[pos] ?? pos).padEnd(4)} ${String(n).padStart(4)} ${(Math.round((outs / Math.max(1, n)) * 100) + '%').padStart(5)}  ` +
      `${b(0, 6).padStart(4)}/${b(6, 12).padStart(4)}/${b(12, 99).padStart(4)}        ` +
      `${used.a.toFixed(2)} / ${used.d50.toFixed(1)}${f ? '' : ' (kept)'}   ${CURRENT[pos].a.toFixed(2)}/${CURRENT[pos].d50}   ` +
      `${meanResid(used).toFixed(3)}→${meanResid(CURRENT[pos]).toFixed(3)}   Σout fit=${outs} extract=${recon}`,
    );
  }

  console.log('\n// ── paste into parseReplay.ts POS_CURVE ──');
  const note: Record<number, string> = { 1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF' };
  console.log('const POS_CURVE: Record<number, { a: number; d50: number }> = {');
  for (let p = 1; p <= 9; p++) {
    const c = fitted[p];
    console.log(`  ${p}: { a: ${Math.round(c.a * 100) / 100}, d50: ${Math.round(c.d50 * 10) / 10} }, // ${note[p]}`);
  }
  console.log('};');
}
main().catch((e) => { console.error(e); process.exit(1); });
