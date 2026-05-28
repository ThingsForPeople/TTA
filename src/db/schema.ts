import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email'),
  name: text('name'),
  timezone: text('timezone').default('America/New_York'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const playerMeta = pgTable('player_meta', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  playerUuid: text('player_uuid').notNull(),
  sim: jsonb('sim').notNull().$type<{
    con: number; pow: number; spd: number;
    fld: number; arm: number; pit: number; sta: number;
  }>(),
  talents: jsonb('talents').notNull().$type<string[]>(),
  talentLevels: jsonb('talent_levels').$type<Record<string, number>>(),
  injury: jsonb('injury').$type<{
    severity: 'minor' | 'major' | 'catastrophic';
    date: number;
    note?: string;
  }>(),
  injuryHistory: jsonb('injury_history').$type<{
    severity: 'minor' | 'major' | 'catastrophic';
    date: number;
    resolvedDate?: number;
    note?: string;
  }[]>(),
  pitchTalents: jsonb('pitch_talents').$type<{
    pitch: string;
    level: number;
    sub: { name: string; level: number }[];
  }[]>(),
  bats: text('bats').$type<'R' | 'L'>(),
  throws: text('throws').$type<'R' | 'L'>(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  uniqueIndex('player_meta_user_player').on(t.userId, t.playerUuid),
]);

export const statHistory = pgTable('stat_history', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  playerUuid: text('player_uuid').notNull(),
  sim: jsonb('sim').notNull().$type<{
    con: number; pow: number; spd: number;
    fld: number; arm: number; pit: number; sta: number;
  }>(),
  ovr: integer('ovr').notNull(),
  recordedAt: timestamp('recorded_at').defaultNow(),
}, (t) => [
  index('stat_history_user_player').on(t.userId, t.playerUuid),
]);

export const recentTeams = pgTable('recent_teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  teamUuid: text('team_uuid').notNull(),
  teamName: text('team_name').notNull(),
  lastViewed: timestamp('last_viewed').defaultNow(),
}, (t) => [
  uniqueIndex('recent_teams_user_team').on(t.userId, t.teamUuid),
  index('recent_teams_user_viewed').on(t.userId, t.lastViewed),
]);

export const positionWeights = pgTable('position_weights', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  teamUuid: text('team_uuid').notNull(),
  weights: jsonb('weights').notNull().$type<Record<string, number>>(),
  statWeights: jsonb('stat_weights').$type<Record<string, Record<string, number>>>(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  uniqueIndex('position_weights_user_team').on(t.userId, t.teamUuid),
]);

export const usage = pgTable('usage', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  teamUuid: text('team_uuid').notNull(),
  actionType: text('action_type').notNull(),
  usedAt: timestamp('used_at').defaultNow(),
}, (t) => [
  index('usage_user_team_type').on(t.userId, t.teamUuid, t.actionType),
]);
