export interface TalentDef {
    id: string;
    name: string;
    description: string;
    category: 'hitting' | 'pitching' | 'fielding' | 'baserunning';
}
export declare const ALL_TALENTS: TalentDef[];
export declare const ALL_TALENT_NAMES: string[];
export declare const TALENT_BY_NAME: Record<string, TalentDef>;
export declare const CATEGORY_COLORS: Record<TalentDef['category'], string>;
