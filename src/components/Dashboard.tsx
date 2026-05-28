'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { track } from '@vercel/analytics';
import { AskAiModal } from './AskAiModal';
import { AppShell } from './AppShell';
import { TeamLookup, saveRecentTeam } from './TeamLookup';
import {
  fetchTeamData,
  fetchRosterStatsJson,
  ScrapeError,
  type ModeFilter,
  type TimeFilter,
} from '@/lib/api';
import { mapPlayer } from '@/lib/parseTeam';
import { useAuthUser, AuthUserButton } from '@/hooks/useAuthUser';
import { loadStore, saveStore, type PlayerMeta, type PlayerMetaStore } from '@/lib/playerMeta';
import { fetchHistoryFromApi, mergeApiHistory } from '@/lib/statHistory';
import { buildCompactSummary, buildTeamSummary } from '@/lib/teamSummary';
import { buildPreComputedInsights } from '@/lib/preComputedInsights';
import type { Player, Team } from '@/lib/types';

const STORAGE_KEY = 'tta:teamUuid';

interface TeamData {
  team: Team;
  raw: unknown;
}

async function fetchMetaFromApi(playerUuids: string[]): Promise<PlayerMetaStore> {
  try {
    const res = await fetch(`/api/player-meta?playerUuids=${playerUuids.join(',')}`);
    if (!res.ok) {
      console.warn(`[TTA] player-meta fetch failed (${res.status})`);
      return {};
    }
    return (await res.json()) as PlayerMetaStore;
  } catch (err) {
    console.warn('[TTA] player-meta fetch error:', err);
    return {};
  }
}

async function saveMetaToApi(playerUuid: string, meta: PlayerMeta): Promise<void> {
  try {
    const res = await fetch('/api/player-meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerUuid,
        sim: meta.sim,
        talents: meta.talents,
        talentLevels: meta.talentLevels,
        injury: meta.injury ?? null,
        injuryHistory: meta.injuryHistory ?? [],
        pitchTalents: meta.pitchTalents ?? [],
        bats: meta.bats ?? null,
        throws: meta.throws ?? null,
      }),
    });
    if (!res.ok) {
      console.warn(`[TTA] player-meta save failed (${res.status}) for ${playerUuid}`);
    }
  } catch (err) {
    console.warn('[TTA] player-meta save error:', err);
  }
}

export default function Dashboard() {
  const clerkUserId = useAuthUser();

  const [uuid, setUuid] = useState<string>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('team') ?? localStorage.getItem(STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [teamData, setTeamData] = useState<TeamData | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [metaStore, setMetaStore] = useState<PlayerMetaStore>(() => loadStore(clerkUserId));
  const [time, setTime] = useState<TimeFilter>('all');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [filteredPlayers, setFilteredPlayers] = useState<Player[] | undefined>();
  const [filterLoading, setFilterLoading] = useState(false);
  const [filterError, setFilterError] = useState<string | undefined>();

  const prevMetaRef = useRef<PlayerMetaStore>(metaStore);

  const updateMetaStore = useCallback((next: PlayerMetaStore) => {
    const prev = prevMetaRef.current;
    setMetaStore(next);
    saveStore(next, clerkUserId);
    prevMetaRef.current = next;

    for (const [playerUuid, meta] of Object.entries(next)) {
      if (meta !== prev[playerUuid]) {
        saveMetaToApi(playerUuid, meta);
      }
    }
  }, [clerkUserId]);

  const load = useCallback(async (u: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await fetchTeamData(u);
      if (!result.team.uuid && result.team.players.length === 0) {
        setError('No team data found — UUID may be wrong.');
        setTeamData(undefined);
      } else {
        setTeamData(result);
        const url = new URL(window.location.href);
        url.searchParams.set('team', u);
        window.history.replaceState(null, '', url.toString());
        track('team_loaded', { teamUuid: u, teamName: result.team.name ?? 'unknown' });
        saveRecentTeam(u, result.team.name ?? 'Unknown Team');

        const playerUuids = result.team.players
          .map((p) => p.uuid)
          .filter((id): id is string => !!id);
        if (playerUuids.length) {
          const apiMeta = await fetchMetaFromApi(playerUuids);
          if (Object.keys(apiMeta).length > 0) {
            setMetaStore((prev) => {
              const merged = { ...prev, ...apiMeta };
              saveStore(merged, clerkUserId);
              prevMetaRef.current = merged;
              return merged;
            });
          }

          const apiHistory = await fetchHistoryFromApi();
          if (Object.keys(apiHistory).length > 0) {
            mergeApiHistory(apiHistory);
          }
        }
      }
    } catch (err) {
      if (err instanceof ScrapeError) {
        setError(`Fetch failed (${err.status}) — check the UUID.`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(String(err));
      }
      setTeamData(undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleTeamSearch = useCallback((newUuid: string) => {
    setUuid(newUuid);
  }, []);

  useEffect(() => {
    if (!uuid) return;
    load(uuid);
    setTime('all');
    setMode('all');
    setFilteredPlayers(undefined);
    setFilterError(undefined);
    try {
      localStorage.setItem(STORAGE_KEY, uuid);
    } catch {
      // ignore
    }
  }, [uuid, load]);

  useEffect(() => {
    if (!teamData) return;
    if (time === 'all' && mode === 'all') {
      setFilteredPlayers(undefined);
      setFilterError(undefined);
      setFilterLoading(false);
      return;
    }
    let cancelled = false;
    setFilterLoading(true);
    setFilterError(undefined);
    fetchRosterStatsJson(uuid, { time, mode })
      .then((rawRoster) => {
        if (cancelled) return;
        setFilteredPlayers(rawRoster.map(mapPlayer));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ScrapeError) {
          setFilterError(`Filtered fetch failed (${err.status}).`);
        } else if (err instanceof Error) {
          setFilterError(err.message);
        } else {
          setFilterError(String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setFilterLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uuid, teamData, time, mode]);

  const displayTeam = useMemo<Team | undefined>(() => {
    if (!teamData) return undefined;
    let players = filteredPlayers ?? teamData.team.players;

    // Fielding stats are only available in all-time data. When a time/mode
    // filter is active, carry forward fielding from the base roster so the
    // position optimizer can still use them.
    if (filteredPlayers) {
      const fieldingByUuid = new Map(
        teamData.team.players
          .filter((p) => p.uuid && p.fielding)
          .map((p) => [p.uuid!, p.fielding!]),
      );
      players = players.map((p) =>
        p.uuid && !p.fielding && fieldingByUuid.has(p.uuid)
          ? { ...p, fielding: fieldingByUuid.get(p.uuid) }
          : p,
      );
    }

    const baseTeam = filteredPlayers
      ? { ...teamData.team, players, pitcher: players.find((p) => p.pitching !== undefined) ?? teamData.team.pitcher }
      : { ...teamData.team, players };
    return baseTeam;
  }, [teamData, filteredPlayers]);

  const contextSourcesRef = useRef({ team: displayTeam, time, mode, metaStore });
  contextSourcesRef.current = { team: displayTeam, time, mode, metaStore };
  const buildAdviseContext = useCallback(() => {
    const { team, time: t, mode: m, metaStore: ms } = contextSourcesRef.current;
    if (!team) return '(no team loaded)';
    return buildTeamSummary(team, { time: t, mode: m }, ms);
  }, []);
  const buildCompactContext = useCallback(() => {
    const { team, time: t, mode: m, metaStore: ms } = contextSourcesRef.current;
    if (!team) return '(no team loaded)';
    return buildCompactSummary(team, { time: t, mode: m }, ms);
  }, []);
  const buildInsights = useCallback(() => {
    const { team, metaStore: ms } = contextSourcesRef.current;
    if (!team) return '';
    return buildPreComputedInsights(team, ms);
  }, []);

  return (
    <>
      {!teamData || !displayTeam ? (
        <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
          <div className="flex justify-end">
            <AuthUserButton />
          </div>
          <TeamLookup uuid={uuid} onChange={handleTeamSearch} loading={loading} />
          {error ? (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}
          <p className="rounded-md border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">
            {loading ? 'Loading team…' : 'Enter your team UUID above to get started. You can find it in the URL when viewing your team on tiny-teams.com.'}
          </p>
        </div>
      ) : (
        <AppShell
          team={displayTeam}
          raw={teamData.raw}
          uuid={uuid}
          onUuidChange={handleTeamSearch}
          onRefresh={() => load(uuid)}
          loading={loading}
          metaStore={metaStore}
          onMetaStoreChange={updateMetaStore}
          time={time}
          mode={mode}
          onFilterChange={(next) => {
            setTime(next.time);
            setMode(next.mode);
          }}
          filterLoading={filterLoading}
          filterError={filterError}
          buildAdviseContext={buildAdviseContext}
          buildCompactContext={buildCompactContext}
          buildInsights={buildInsights}
        />
      )}

      {process.env.NODE_ENV === 'development' && (
        <AskAiModal buildContext={buildAdviseContext} buildCompactContext={buildCompactContext} teamUuid={uuid} />
      )}
    </>
  );
}
