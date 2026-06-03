/** Compare Battler (count_fighter) vs Waste No Time (quick_strike_adaptation)
 *  activation frequency per player across N recent games. Generalizable: swap
 *  the two talent IDs to compare any pair. Activation IDs are the internal
 *  engine names from talent.activated events (NOT the display names).
 *  Run: npx tsx scripts/talent-compare.ts [teamUuid] [numGames] */
export {}; // module scope — keeps these consts out of the shared script global
const TEAM = process.argv[2] ?? '019ddff2-6cbc-7ecb-b0b1-a6b511f3379e';
const N = Number(process.argv[3] ?? 10);
const GAMES = `https://www.tiny-teams.com/api/team-search/teams`;
const REPLAY = `https://www.tiny-teams.com/api/replay`;
const BATTLER = 'count_fighter';
const WNT = 'quick_strike_adaptation';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchReplay(id: string): Promise<any | null> {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${REPLAY}/${id}`, { headers: { Accept: 'application/json' } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    const ra = Number(res.headers.get('retry-after'));
    await sleep(ra > 0 ? ra * 1000 : 1500 * (i + 1));
  }
  return null;
}

interface P { name: string; games: number; pa: number; swings: number; battler: number; wnt: number; hasBattler: boolean; hasWnt: boolean; }

async function main() {
  const r = await fetch(`${GAMES}/${TEAM}/games?offset=0`, { headers: { Accept: 'application/json' } });
  const ids: string[] = ((await r.json()).results ?? []).slice(0, N).map((g: any) => g.game_id);
  console.log(`Battler=count_fighter | WasteNoTime=quick_strike_adaptation\nPulling ${ids.length} games\n`);

  const agg = new Map<string, P>();
  const get = (id: string, name: string) => {
    let p = agg.get(id);
    if (!p) { p = { name, games: 0, pa: 0, swings: 0, battler: 0, wnt: 0, hasBattler: false, hasWnt: false }; agg.set(id, p); }
    return p;
  };

  for (const gid of ids) {
    const raw = await fetchReplay(gid);
    if (!raw) { console.log(`  ${gid.slice(0,8)}: no replay`); await sleep(900); continue; }
    const ourSide = raw.game?.away?.id === TEAM ? 'away' : 'home';
    const ours = new Set<string>();
    for (const pl of raw.game?.[ourSide]?.players ?? []) {
      ours.add(pl.id);
      const nm = `${pl.firstName ?? ''} ${pl.lastName ?? ''}`.trim();
      const p = get(pl.id, nm);
      const tids = new Set((pl.talents ?? []).map((t: any) => t.id));
      if (tids.has(BATTLER)) p.hasBattler = true;
      if (tids.has(WNT)) p.hasWnt = true;
    }
    const seenThisGame = new Set<string>();
    for (const seg of raw.segments ?? []) {
      const bid = seg.metadata?.batterId;
      for (const ev of seg.events ?? []) {
        const pl = ev.payload ?? {};
        if (ev.type === 'batter.result' && ours.has(bid)) { get(bid, '').pa++; seenThisGame.add(bid); }
        if (ev.type === 'batter.action' && pl.action === 'swing' && ours.has(bid)) get(bid, '').swings++;
        if (ev.type === 'talent.activated' && ours.has(pl.ownerId)) {
          if (pl.talentId === BATTLER) get(pl.ownerId, '').battler++;
          if (pl.talentId === WNT) get(pl.ownerId, '').wnt++;
        }
      }
    }
    for (const id of seenThisGame) get(id, '').games++;
    await sleep(900);
  }

  const rows = [...agg.values()].filter((p) => p.hasBattler || p.hasWnt);
  console.log('Players holding Battler and/or Waste No Time:\n');
  const fmt = (n: number, d: number) => d > 0 ? (n / d).toFixed(2) : '—';
  for (const p of rows.sort((a, b) => b.pa - a.pa)) {
    const tags = [p.hasBattler ? 'Battler' : '', p.hasWnt ? 'WasteNoTime' : ''].filter(Boolean).join('+');
    console.log(`${p.name}  [${tags}]`);
    console.log(`    games ${p.games}  PA ${p.pa}  swings ${p.swings}`);
    if (p.hasBattler) console.log(`    Battler  acts ${p.battler}   ${fmt(p.battler, p.games)}/game  ${fmt(p.battler, p.pa)}/PA  ${fmt(p.battler, p.swings)}/swing`);
    if (p.hasWnt)     console.log(`    WasteNoT acts ${p.wnt}   ${fmt(p.wnt, p.games)}/game  ${fmt(p.wnt, p.pa)}/PA  ${fmt(p.wnt, p.swings)}/swing`);
    console.log('');
  }

  // pooled rates
  const bP = rows.filter((p) => p.hasBattler);
  const wP = rows.filter((p) => p.hasWnt);
  const sum = (a: P[], k: 'pa' | 'games' | 'swings' | 'battler' | 'wnt') => a.reduce((s, p) => s + p[k], 0);
  console.log('=== POOLED ===');
  console.log(`Battler (${bP.length} players): ${sum(bP,'battler')} acts over ${sum(bP,'pa')} PA = ${(sum(bP,'battler')/Math.max(1,sum(bP,'pa'))).toFixed(2)}/PA`);
  console.log(`WasteNoTime (${wP.length} players): ${sum(wP,'wnt')} acts over ${sum(wP,'pa')} PA = ${(sum(wP,'wnt')/Math.max(1,sum(wP,'pa'))).toFixed(2)}/PA`);
}
main().catch((e) => { console.error(e); process.exit(1); });
