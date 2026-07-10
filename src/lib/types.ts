export interface BattingStats {
  avg?: number;
  obp?: number;
  slg?: number;
  ops?: number;
  ab?: number;
  h?: number;
  hr?: number;
  rbi?: number;
  bb?: number;
  k?: number;
  // Extras available from public scrape
  singles?: number;
  doubles?: number;
  triples?: number;
  runs?: number;
  games?: number;
}

export interface PitchingStats {
  era?: number;
  whip?: number;
  ip?: number;
  k?: number;
  bb?: number;
  h?: number;
  pitches?: number;
  runsAllowed?: number;
}

export interface FieldingStats {
  putouts?: number;
  assists?: number;
  errors?: number;
  fieldingPct?: number;
}

export interface Player {
  uuid?: string;
  name: string;
  archetype?: string;
  position?: string;
  bench?: boolean;
  battingOrder?: number; // 1-9
  fieldingPosition?: number; // raw numeric from feed
  rosterStatus?: string;
  batting?: BattingStats;
  pitching?: PitchingStats;
  fielding?: FieldingStats;
}

export interface RecentGame {
  gameId: string;
  completedAt: string;
  wasHome: boolean;
  ourScore: number;
  opponentScore: number;
  opponentTeamId: string;
  opponentName: string;
  won: boolean;
}

export interface Team {
  uuid?: string;
  name?: string;
  manager?: string;
  recentRecord?: string; // derived "W-L" from recentGames
  players: Player[];
  pitcher?: Player;
  recentGames: RecentGame[];
}

export interface ParsedTeam {
  team: Team;
  raw: unknown;
}
