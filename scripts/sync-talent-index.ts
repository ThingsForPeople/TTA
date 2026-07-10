/** Sync the official Talent Index (https://www.tiny-teams.com/talents) into
 *  src/lib/talentIndex.json. The main page's RSC flight payload embeds the core
 *  talent database as a clean JSON array; three SUB-PAGES (/talents/hit-zones,
 *  /talents/pitch-counters, /talents/pitch-zones) render additional families as
 *  RSC component trees, which we parse block-by-block (div key = talent id,
 *  bold span = display name, pre-line span = magnitude text like
 *  "+20/30/40/50% Contact in the high zone").
 *  Together this is the ONLY externally exposed source of talent magnitudes.
 *  Re-run after game patches: `npx tsx scripts/sync-talent-index.ts`.
 *  Prints a diff against src/lib/talents.ts ids so drift is visible.
 */
import fs from 'fs';
import path from 'path';
import { ALL_TALENTS } from '../src/lib/talents';

const BASE = 'https://www.tiny-teams.com';
const SUB_PAGES: { page: string; category: string }[] = [
  { page: 'hit-zones', category: 'hitting' },
  { page: 'pitch-counters', category: 'hitting' },
  { page: 'pitch-zones', category: 'pitching' },
];
const OUT = path.join(__dirname, '..', 'src', 'lib', 'talentIndex.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBlob(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const html = await res.text();
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/gs)].map((m) => m[1]);
  return chunks.map((c) => JSON.parse(`"${c}"`)).join('');
}

// Expand "+7/10/13/16% Contact on Cutters" into perTier entries.
function perTierFromRange(range: string): Record<string, string> {
  const m = /([+-]?)(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?){1,3})(%?)/.exec(range);
  const out: Record<string, string> = {};
  if (!m) {
    for (let t = 1; t <= 4; t++) out[String(t)] = range;
    return out;
  }
  const parts = m[2].split('/');
  for (let t = 1; t <= 4; t++) {
    const v = parts[Math.min(t - 1, parts.length - 1)];
    out[String(t)] = range.replace(m[0], `${m[1]}${v}${m[3]}`);
  }
  return out;
}

// Balance brackets/braces from an opening '[' to its matching close,
// skipping string literals — gives one component element's exact extent.
function balancedSlice(blob: string, start: number): string {
  let depth = 0, inStr = false;
  for (let j = start; j < blob.length; j++) {
    const ch = blob[j];
    if (inStr) {
      if (ch === '\\') j++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return blob.slice(start, j + 1);
    }
  }
  return blob.slice(start, Math.min(blob.length, start + 2400));
}

// Parse an RSC component page into talent entries. Each talent renders as
// ["$","div","<talentId>",{...}] whose children include a bold display-name
// span and a whiteSpace:pre-line description span made of text fragments.
// Each block is bracket-balanced to its own subtree so section labels, page
// titles, and neighboring blocks can never bleed into a description.
function parseComponentPage(blob: string, category: string): { entries: any[]; seenIds: string[] } {
  const out: any[] = [];
  const idRe = /\["\$","div","([a-zA-Z0-9_.:-]{3,60})",\{/g;
  const hits: { id: string; start: number }[] = [];
  for (let m = idRe.exec(blob); m; m = idRe.exec(blob)) {
    const id = m[1];
    if (id.includes(':') || id.includes('_') || id.includes('.')) hits.push({ id, start: m.index });
  }
  for (let i = 0; i < hits.length; i++) {
    const seg = balancedSlice(blob, hits[i].start);
    // Display name = the bold span's children.
    const nameM = /"className":"[^"]*font-bold[^"]*"\s*,\s*"children":"((?:[^"\\]|\\.)*)"/.exec(seg);
    if (!nameM) continue;
    const displayName = JSON.parse(`"${nameM[1]}"`);
    // Description = the text fragments inside the whiteSpace:pre-line span's
    // own children array (magnitudes render as colored sub-spans).
    const preIdx = seg.indexOf('"whiteSpace":"pre-line"');
    if (preIdx < 0) continue;
    const childIdx = seg.indexOf('"children":', preIdx);
    if (childIdx < 0) continue;
    const arrStart = seg.indexOf('[', childIdx);
    const descSeg = arrStart > 0 ? balancedSlice(seg, arrStart) : seg.slice(preIdx);
    const frags = [...descSeg.matchAll(/"children":"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => JSON.parse(`"${m[1]}"`))
      .filter((s) => !/^\$/.test(s)); // drop RSC lazy refs like "$L1b"
    const desc = frags.join('').replace(/\s+/g, ' ').trim();
    if (!desc) continue; // deduped lazy-ref description — synthesized later
    out.push({
      id: hits[i].id,
      displayName,
      description: desc,
      category,
      tags: [],
      prose: { range: desc, perTier: perTierFromRange(desc) },
      synergy: null,
      zone: null,
      sourcePage: `/talents/${category === 'pitching' ? 'pitch-zones' : ''}`, // overwritten below
    });
  }
  return { entries: out, seenIds: hits.map((h) => h.id) };
}

const PITCH_LABEL: Record<string, string> = {
  fourSeamFastball: 'Four-Seam Fastballs', twoSeamFastball: 'Two-Seam Fastballs', cutter: 'Cutters',
  sinker: 'Sinkers', changeup: 'Changeups', curveball: 'Curveballs', slider: 'Sliders',
  splitter: 'Splitters', knuckleball: 'Knuckleballs',
};
// Short forms used in display NAMES ("Cutter Tracker", "Four-Seam Crusher").
const PITCH_NAME: Record<string, string> = {
  fourSeamFastball: 'Four-Seam', twoSeamFastball: 'Two-Seam', cutter: 'Cutter',
  sinker: 'Sinker', changeup: 'Changeup', curveball: 'Curveball', slider: 'Slider',
  splitter: 'Splitter', knuckleball: 'Knuckleball',
};
const DIR_WORD: Record<string, string> = { high: 'high', low: 'low', inside: 'inside', outside: 'outside' };

// The RSC serializer DEDUPLICATES repeated identical subtrees — later blocks
// carry "$L" lazy refs instead of inline description text, so some ids parse
// with no description. Magnitudes are verified IDENTICAL across pitch types
// per (direction, effect) (and across directions modulo the zone word), so we
// synthesize the missing entries from a parsed sibling by swapping the pitch
// label and/or zone word. Only ids actually SEEN on the page are synthesized.
function fillDedupedGaps(entries: any[], seenIds: string[]): number {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const swapPitch = (text: string, fromP: string, toP: string) =>
    text.split(PITCH_LABEL[fromP]).join(PITCH_LABEL[toP]);
  const swapDir = (text: string, fromD: string, toD: string) =>
    text.split(`${DIR_WORD[fromD]} zone`).join(`${DIR_WORD[toD]} zone`);
  const swapDirName = (name: string, fromD: string, toD: string) => {
    const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
    return name.split(cap(fromD)).join(cap(toD));
  };
  let added = 0;
  for (const id of seenIds) {
    if (byId.has(id)) continue;
    let donor: any | undefined;
    let make: ((d: any) => { displayName: string; description: string }) | undefined;
    let m: RegExpExecArray | null;
    if ((m = /^(zone|base|ctr:pitch):([a-zA-Z]+):(.+)$/.exec(id))) {
      const [, fam, pitch, rest] = m;
      // sibling: same family+rest, different pitch
      donor = entries.find((e) => new RegExp(`^${fam}:([a-zA-Z]+):${rest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(e.id) && e.id !== id);
      if (donor) {
        const dp = donor.id.split(':')[fam === 'ctr:pitch' ? 2 : 1];
        make = (d) => ({
          displayName: d.displayName.split(PITCH_NAME[dp]).join(PITCH_NAME[pitch]),
          description: swapPitch(d.description, dp, pitch),
        });
      } else if (fam === 'zone' || fam === 'base') {
        // no same-effect sibling at any pitch → borrow same pitch, different direction
        const parts = rest.split(':');
        const dir = fam === 'zone' ? parts[0] : rest;
        const eff = fam === 'zone' ? parts[1] : '';
        donor = entries.find((e) => {
          const em = /^(zone|base):([a-zA-Z]+):(high|low|inside|outside)(?::([a-z]+))?$/.exec(e.id);
          return em && em[1] === fam && (em[4] ?? '') === eff && em[3] !== dir;
        });
        if (donor) {
          const em = /^(?:zone|base):[a-zA-Z]+:(high|low|inside|outside)/.exec(donor.id)!;
          const donorPitch = donor.id.split(':')[1];
          make = (d) => ({
            displayName: swapDirName(d.displayName, em[1], dir),
            description: swapDir(swapPitch(d.description, donorPitch, pitch), em[1], dir),
          });
        }
      }
    } else if ((m = /^ctr:cat:([a-zA-Z]+):(contact|power)$/.exec(id))) {
      donor = entries.find((e) => e.id.startsWith('ctr:cat:') && e.id.endsWith(`:${m![2]}`) && e.id !== id);
      const CAT_LABEL: Record<string, [string, string]> = {
        fastball: ['Fastball', 'fastballs'], breaking: ['Breaking Ball', 'breaking balls'], offSpeed: ['Off Speed', 'off-speed pitches'],
      };
      if (donor) {
        const donorCat = donor.id.split(':')[2];
        make = (d) => ({
          displayName: d.displayName.replace(CAT_LABEL[donorCat][0], CAT_LABEL[m![1]][0]),
          description: d.description.replace(CAT_LABEL[donorCat][1], CAT_LABEL[m![1]][1]),
        });
      }
    } else if ((m = /^hz:(high|low|inside|outside):(.+)$/.exec(id))) {
      donor = entries.find((e) => e.id.startsWith('hz:') && e.id.endsWith(`:${m![2]}`) && e.id !== id);
      if (donor) {
        const donorDir = donor.id.split(':')[1];
        make = (d) => ({
          displayName: swapDirName(d.displayName, donorDir, m![1]),
          description: swapDir(d.description, donorDir, m![1]),
        });
      }
    }
    if (donor && make) {
      const { displayName, description } = make(donor);
      const entry = { ...donor, id, displayName, description, prose: { range: description, perTier: perTierFromRange(description) }, sourcePage: donor.sourcePage + ' (synthesized from sibling — RSC dedup)' };
      entries.push(entry);
      byId.set(id, entry);
      added++;
    }
  }
  return added;
}

async function main() {
  // 1. Core database from the main page (clean JSON array in the payload).
  const mainBlob = await fetchBlob(`${BASE}/talents`);
  const start = mainBlob.indexOf('[{"id"');
  if (start < 0) throw new Error('talent array not found in flight payload — page structure changed?');
  let depth = 0, end = -1, inStr = false;
  for (let j = start; j < mainBlob.length; j++) {
    const ch = mainBlob[j];
    if (inStr) {
      if (ch === '\\') j++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) { end = j; break; }
  }
  if (end < 0) throw new Error('unbalanced talent array');
  const core = JSON.parse(mainBlob.slice(start, end + 1));
  for (const t of core) { delete t.sprite; t.sourcePage = '/talents'; }

  // 2. Sub-page families (RSC component trees).
  const extra: any[] = [];
  for (const { page, category } of SUB_PAGES) {
    await sleep(800);
    const blob = await fetchBlob(`${BASE}/talents/${page}`);
    const { entries, seenIds } = parseComponentPage(blob, category);
    for (const e of entries) e.sourcePage = `/talents/${page}`;
    const synthesized = fillDedupedGaps(entries, seenIds);
    console.log(`/talents/${page}: ${entries.length} talents (${synthesized} synthesized from siblings, ${seenIds.length} blocks seen)`);
    extra.push(...entries);
  }

  // Merge (core wins on id collisions), stable order: core then extras by id.
  const byId = new Map<string, any>();
  for (const t of [...extra, ...core]) byId.set(t.id, t);
  const arr = [...byId.values()];

  fs.writeFileSync(OUT, JSON.stringify(arr, null, 1) + '\n');
  console.log(`wrote ${arr.length} talents (${core.length} core + ${arr.length - core.length} sub-page) -> ${path.relative(process.cwd(), OUT)}`);

  const idxIds = new Set(arr.map((t: { id: string }) => t.id));
  const ourIds = new Set(ALL_TALENTS.map((t) => t.id));
  const onlyIndex = [...idxIds].filter((id) => !ourIds.has(id as string));
  const onlyOurs = [...ourIds].filter((id) => !idxIds.has(id));
  if (onlyIndex.length) console.log(`in index but NOT in talents.ts (${onlyIndex.length}):`, onlyIndex.slice(0, 30).join(', '), onlyIndex.length > 30 ? '…' : '');
  if (onlyOurs.length) console.log(`in talents.ts but not in index (${onlyOurs.length}):`, onlyOurs.slice(0, 30).join(', '), onlyOurs.length > 30 ? '…' : '');
  const withPct = arr.filter((t: { prose?: { range?: string } }) => t.prose?.range?.includes('%')).length;
  console.log(`${withPct}/${arr.length} carry % magnitudes`);
}
main().catch((e) => { console.error(e); process.exit(1); });
