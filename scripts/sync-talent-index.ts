/** Sync the official Talent Index (https://www.tiny-teams.com/talents) into
 *  src/lib/talentIndex.json. The page's RSC flight payload embeds the full
 *  talent database — the ONLY externally exposed source of talent magnitudes
 *  (per-tier "+N%" numbers), tags, and synergy/partner bonuses. Re-run after
 *  game patches that touch talents: `npx tsx scripts/sync-talent-index.ts`.
 *  Prints a diff against src/lib/talents.ts ids so drift is visible.
 */
import fs from 'fs';
import path from 'path';
import { ALL_TALENTS } from '../src/lib/talents';

const URL = 'https://www.tiny-teams.com/talents';
const OUT = path.join(__dirname, '..', 'src', 'lib', 'talentIndex.json');

async function main() {
  const res = await fetch(URL, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`fetch ${URL} -> ${res.status}`);
  const html = await res.text();

  // RSC flight: JS-escaped string chunks pushed via self.__next_f.push([1,"..."]).
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/gs)].map((m) => m[1]);
  const blob = chunks.map((c) => JSON.parse(`"${c}"`)).join('');

  const start = blob.indexOf('[{"id"');
  if (start < 0) throw new Error('talent array not found in flight payload — page structure changed?');
  let depth = 0;
  let end = -1;
  let inStr = false;
  for (let j = start; j < blob.length; j++) {
    const ch = blob[j];
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
  const arr = JSON.parse(blob.slice(start, end + 1));

  // Drop the sprite-sheet coordinates (render-only) to keep the module lean.
  for (const t of arr) delete t.sprite;

  fs.writeFileSync(OUT, JSON.stringify(arr, null, 1) + '\n');
  console.log(`wrote ${arr.length} talents -> ${path.relative(process.cwd(), OUT)}`);

  const idxIds = new Set(arr.map((t: { id: string }) => t.id));
  const ourIds = new Set(ALL_TALENTS.map((t) => t.id));
  const onlyIndex = [...idxIds].filter((id) => !ourIds.has(id as string));
  const onlyOurs = [...ourIds].filter((id) => !idxIds.has(id));
  if (onlyIndex.length) console.log(`in index but NOT in talents.ts (${onlyIndex.length}):`, onlyIndex.join(', '));
  console.log(`in talents.ts but not in index (${onlyOurs.length}, expected: pitch types + per-pitch zone/aim variants):`, onlyOurs.slice(0, 12).join(', '), onlyOurs.length > 12 ? '…' : '');
  const withPct = arr.filter((t: { prose?: { range?: string } }) => t.prose?.range?.includes('%')).length;
  console.log(`${withPct}/${arr.length} carry % magnitudes`);
}
main().catch((e) => { console.error(e); process.exit(1); });
