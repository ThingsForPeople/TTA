import type { SimStats } from './playerMeta';

export interface StatSnapshot {
  timestamp: number;
  sim: SimStats;
  ovr: number;
}

export type StatHistoryStore = Record<string /* player uuid */, StatSnapshot[]>;

const STORAGE_KEY = 'tta:statHistory';
const TRAINING_TICK_HOUR_UTC = 14; // 10 AM EST = 14:00 UTC

export function trainingDayKey(ts: number): number {
  const d = new Date(ts);
  const utcHours = d.getUTCHours();
  const utcDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (utcHours < TRAINING_TICK_HOUR_UTC) utcDate.setUTCDate(utcDate.getUTCDate() - 1);
  return utcDate.getTime();
}

function computeOvr(sim: SimStats): number {
  const keys: (keyof SimStats)[] = ['con', 'pow', 'spd', 'fld', 'arm', 'pit', 'sta'];
  const total = keys.reduce((sum, k) => sum + sim[k], 0);
  return Math.round(total / keys.length);
}

function simEqual(a: SimStats, b: SimStats): boolean {
  return (
    a.con === b.con &&
    a.pow === b.pow &&
    a.spd === b.spd &&
    a.fld === b.fld &&
    a.arm === b.arm &&
    a.pit === b.pit &&
    a.sta === b.sta
  );
}

export function loadHistory(): StatHistoryStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StatHistoryStore;
  } catch {
    return {};
  }
}

function saveHistory(store: StatHistoryStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota / private mode
  }
}

export function recordSnapshot(uuid: string, sim: SimStats): void {
  const keys: (keyof SimStats)[] = ['con', 'pow', 'spd', 'fld', 'arm', 'pit', 'sta'];
  const nonZero = keys.filter((k) => sim[k] > 0).length;
  if (nonZero < 2) return;

  const store = loadHistory();
  const entries = store[uuid] ?? [];
  const now = Date.now();
  const ovr = computeOvr(sim);
  const last = entries[entries.length - 1];

  if (last && simEqual(last.sim, sim)) return;

  if (last && trainingDayKey(now) === trainingDayKey(last.timestamp)) {
    entries[entries.length - 1] = { timestamp: now, sim: { ...sim }, ovr };
  } else {
    entries.push({ timestamp: now, sim: { ...sim }, ovr });
  }

  store[uuid] = entries;
  saveHistory(store);
  saveSnapshotToApi(uuid, sim, ovr, now);
}

export interface StatDelta {
  stat: keyof SimStats;
  prev: number;
  curr: number;
  diff: number;
}

export function getLatestDelta(uuid: string): { deltas: StatDelta[]; ovrDiff: number; daysBetween: number } | null {
  const store = loadHistory();
  const entries = store[uuid];
  if (!entries || entries.length < 2) return null;

  const prev = entries[entries.length - 2];
  const curr = entries[entries.length - 1];
  const keys: (keyof SimStats)[] = ['con', 'pow', 'spd', 'fld', 'arm', 'pit', 'sta'];
  const deltas: StatDelta[] = keys.map((k) => ({
    stat: k,
    prev: prev.sim[k],
    curr: curr.sim[k],
    diff: curr.sim[k] - prev.sim[k],
  }));
  const ovrDiff = curr.ovr - prev.ovr;
  const daysBetween = Math.max(1, Math.round((curr.timestamp - prev.timestamp) / (1000 * 60 * 60 * 24)));

  return { deltas, ovrDiff, daysBetween };
}

export function getPlayerHistory(uuid: string): StatSnapshot[] {
  const store = loadHistory();
  return store[uuid] ?? [];
}

export function getAllPlayerHistories(): StatHistoryStore {
  return loadHistory();
}

export function getOvrSeries(uuid: string): { timestamp: number; ovr: number }[] {
  return getPlayerHistory(uuid).map((s) => ({ timestamp: s.timestamp, ovr: s.ovr }));
}

export function getStatSeries(uuid: string, stat: keyof SimStats): { timestamp: number; value: number }[] {
  return getPlayerHistory(uuid).map((s) => ({ timestamp: s.timestamp, value: s.sim[stat] }));
}

function saveSnapshotToApi(playerUuid: string, sim: SimStats, ovr: number, timestamp: number): void {
  fetch('/api/stat-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerUuid, sim, ovr, timestamp }),
  }).catch(() => {});
}

interface ApiStatRow {
  playerUuid: string;
  sim: SimStats;
  ovr: number;
  recordedAt: string;
}

export async function fetchHistoryFromApi(): Promise<StatHistoryStore> {
  try {
    const res = await fetch('/api/stat-history');
    if (!res.ok) return {};
    const rows = (await res.json()) as ApiStatRow[];
    const store: StatHistoryStore = {};
    for (const row of rows) {
      const snap: StatSnapshot = {
        timestamp: new Date(row.recordedAt).getTime(),
        sim: row.sim,
        ovr: row.ovr,
      };
      (store[row.playerUuid] ??= []).push(snap);
    }
    for (const entries of Object.values(store)) {
      entries.sort((a, b) => a.timestamp - b.timestamp);
    }
    return store;
  } catch {
    return {};
  }
}

export function mergeApiHistory(apiStore: StatHistoryStore): void {
  const local = loadHistory();
  const allKeys = new Set([...Object.keys(local), ...Object.keys(apiStore)]);
  const FUZZY_MS = 30_000; // treat snapshots within 30s as the same event

  for (const uuid of allKeys) {
    const localEntries = local[uuid] ?? [];
    const apiEntries = apiStore[uuid] ?? [];
    const merged = [...localEntries];

    for (const apiSnap of apiEntries) {
      const duplicate = merged.some(
        (s) => Math.abs(s.timestamp - apiSnap.timestamp) < FUZZY_MS && simEqual(s.sim, apiSnap.sim),
      );
      if (!duplicate) merged.push(apiSnap);
    }

    merged.sort((a, b) => a.timestamp - b.timestamp);
    local[uuid] = merged;
  }

  saveHistory(local);
}
