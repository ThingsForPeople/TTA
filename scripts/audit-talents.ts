/**
 * Talent classification audit.
 *
 * Cross-checks the hand-maintained talent classification tables that drive the
 * batting-order and field-position engines against two sources of truth:
 *   1. talents.ts        — the canonical talent list (names, descriptions).
 *   2. talentEffects.ts  — engine stat levers OBSERVED in real replay data.
 *
 * It reports three things:
 *   • ERRORS       — a classified talent name that doesn't exist in talents.ts
 *                    (typo / renamed talent). Exits non-zero.
 *   • COVERAGE     — talents that have a known engine effect but aren't
 *                    classified by the relevant engine yet.
 *   • DIRECTION    — classified hitting talents whose lineup role tilt looks
 *                    inconsistent with their observed engine effect (advisory;
 *                    a payoff can legitimately differ from a trigger).
 *
 * Run:  npm run audit:talents
 */
import { ALL_TALENTS, TALENT_BY_NAME } from '../src/lib/talents';
import { TALENT_ENGINE_EFFECTS, type EngineStat } from '../src/lib/talentEffects';
import { TALENT_VALUES, BASERUNNING_VALUES } from '../src/lib/analysis';
import { FIELDING_TALENT_RULES } from '../src/lib/rosterOptimizer';

const POWER_SLOTS = ['best', 'cleanup', 'protection'] as const;
const TABLE_SLOTS = ['leadoff', 'quality'] as const;

const POWER_EFFECTS = new Set<EngineStat>(['power', 'homerun_chance', 'fly_ball_chance', 'line_drive_chance']);
const TABLE_EFFECTS = new Set<EngineStat>(['contact_chance', 'swing_chance', 'foul_chance']);

const errors: string[] = [];
const coverage: string[] = [];
const direction: string[] = [];

// ── 1. Typo guard: every classified name must exist in talents.ts ──
const classifiedNames = new Set<string>([
  ...Object.keys(TALENT_VALUES),
  ...Object.keys(BASERUNNING_VALUES),
  ...Object.keys(FIELDING_TALENT_RULES),
]);
for (const name of classifiedNames) {
  if (!TALENT_BY_NAME[name]) {
    errors.push(`Classified talent "${name}" is not in talents.ts (typo or renamed?).`);
  }
}

// ── 2. Coverage: talents with a known engine effect but unclassified ──
const handledOffense = new Set([...Object.keys(TALENT_VALUES), ...Object.keys(BASERUNNING_VALUES)]);
for (const t of ALL_TALENTS) {
  const effects = TALENT_ENGINE_EFFECTS[t.name];
  if (!effects) continue; // no replay observation → nothing to check
  if (t.category === 'hitting' || t.category === 'baserunning') {
    if (!handledOffense.has(t.name)) {
      coverage.push(`[${t.category}] "${t.name}" affects ${effects.join(', ')} but has no batting-order weight.`);
    }
  }
  if (t.category === 'fielding') {
    const fieldingEffects = effects.filter((e) => e.startsWith('fielding_'));
    if (fieldingEffects.length && !FIELDING_TALENT_RULES[t.name]) {
      coverage.push(`[fielding] "${t.name}" affects ${fieldingEffects.join(', ')} but has no position-fit rule.`);
    }
  }
}

// ── 3. Direction sanity for classified hitting talents ──
for (const [name, value] of Object.entries(TALENT_VALUES)) {
  const effects = TALENT_ENGINE_EFFECTS[name];
  if (!effects) continue;
  const isPower = effects.some((e) => POWER_EFFECTS.has(e));
  const isTable = effects.some((e) => TABLE_EFFECTS.has(e));
  // pure-power vs pure-table talents are the cleanest to sanity-check
  const roles = value.roles ?? {};
  const powerTilt = POWER_SLOTS.reduce((s, r) => s + (roles[r] ?? 0), 0);
  const tableTilt = TABLE_SLOTS.reduce((s, r) => s + (roles[r] ?? 0), 0);
  if (isPower && !isTable && tableTilt > powerTilt) {
    direction.push(`"${name}" is power-type (${effects.join(', ')}) but tilts to table slots (leadoff/quality). Verify in-game.`);
  }
  if (isTable && !isPower && powerTilt > tableTilt) {
    direction.push(`"${name}" is contact/swing-type (${effects.join(', ')}) but tilts to power slots. Verify in-game.`);
  }
}

// ── Report ──
const section = (title: string, items: string[]) => {
  console.log(`\n${title} (${items.length})`);
  if (!items.length) console.log('  ✓ none');
  else for (const i of items) console.log(`  • ${i}`);
};

console.log('Talent classification audit');
console.log('===========================');
console.log(`talents.ts: ${ALL_TALENTS.length} talents | replay-observed effects: ${Object.keys(TALENT_ENGINE_EFFECTS).length}`);
section('ERRORS', errors);
section('COVERAGE GAPS', coverage);
section('DIRECTION NOTES', direction);
console.log('');

process.exit(errors.length ? 1 : 0);
