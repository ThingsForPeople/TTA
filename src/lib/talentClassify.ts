import { ALL_TALENTS, type TalentDef } from './talents';

const PITCH_TYPE_ID_SET = new Set([
  'fastball', 'two_seam_fastball', 'cutter', 'sinker',
  'changeup', 'curveball', 'slider', 'splitter', 'knuckleball',
]);

const PITCH_SUB_ID_SET = new Set(
  ALL_TALENTS.filter((t) =>
    t.category === 'pitching' && (
      t.id.startsWith('zone:') ||
      t.id.startsWith('base:') ||
      t.id.startsWith('pz_')
    )
  ).map((t) => t.id),
);

const PITCH_TYPE_NAMES = new Set(
  ALL_TALENTS.filter((t) => PITCH_TYPE_ID_SET.has(t.id)).map((t) => t.name),
);

const PITCH_SUB_NAMES = new Set(
  ALL_TALENTS.filter((t) => PITCH_SUB_ID_SET.has(t.id)).map((t) => t.name),
);

export const PITCH_TYPE_TALENTS: TalentDef[] = ALL_TALENTS.filter((t) => PITCH_TYPE_ID_SET.has(t.id));
export const PITCH_SUB_TALENTS: TalentDef[] = ALL_TALENTS.filter((t) => PITCH_SUB_ID_SET.has(t.id));
export const STANDALONE_TALENTS: TalentDef[] = ALL_TALENTS.filter((t) => !PITCH_TYPE_ID_SET.has(t.id) && !PITCH_SUB_ID_SET.has(t.id));

export function isPitchTypeTalent(name: string): boolean {
  return PITCH_TYPE_NAMES.has(name);
}

export function isPitchSubTalent(name: string): boolean {
  return PITCH_SUB_NAMES.has(name);
}
