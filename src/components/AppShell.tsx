import { useState } from 'react';
import { AuthUserButton } from '@/hooks/useAuthUser';
import type { ModeFilter, TimeFilter } from '../lib/api';
import type { PlayerMetaStore } from '../lib/playerMeta';
import type { Team } from '../lib/types';
import { InsightsPanel } from './InsightsPanel';
import { PitcherCard } from './PitcherCard';
import { RawJsonPanel } from './RawJsonPanel';
import { RecentGamesPanel } from './RecentGamesPanel';
import { RecruitAnalyzer } from './RecruitAnalyzer';
import { RosterEditor } from './RosterEditor';
import { FieldPositionsPanel, OptimalBattingOrder, PositionGuidancePanel } from './RosterOptimizer';
import { StatsTable } from './StatsTable';
import { TalentAdvisor } from './TalentAdvisor';
import { TeamLookup } from './TeamLookup';
import { TimeRangeFilter } from './TimeRangeFilter';
import { ModeBreakdown } from './ModeBreakdown';
import { TrainingPanel } from './TrainingPanel';
import { AdvancedStatsPanel } from './AdvancedStatsPanel';
import { AdvancedBattingPanel } from './AdvancedBattingPanel';
import { Matchups } from './Matchups';

type Tab = 'overview' | 'stats' | 'roster' | 'tools' | 'matchups' | 'debug';

const TABS: { value: Tab; label: string; devOnly?: boolean }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'stats', label: 'Stats' },
  { value: 'roster', label: 'Roster' },
  { value: 'tools', label: 'Tools' },
  { value: 'matchups', label: 'Matchups' },
  { value: 'debug', label: 'Debug', devOnly: true },
];

// Light group header for the Stats tab — labels a cluster of related panels
// (each panel still renders its own chrome) so the tab reads as Batting /
// Pitching / Defense / Games rather than one flat stack.
function StatsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="border-b border-slate-800 pb-1 text-xs font-semibold uppercase tracking-widest text-slate-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

interface Props {
  team: Team;
  raw: unknown;
  uuid: string;
  onUuidChange: (uuid: string) => void;
  onRefresh: () => void;
  loading: boolean;
  metaStore: PlayerMetaStore;
  onMetaStoreChange: (next: PlayerMetaStore) => void;
  time: TimeFilter;
  mode: ModeFilter;
  onFilterChange: (next: { time: TimeFilter; mode: ModeFilter }) => void;
  filterLoading: boolean;
  filterError?: string;
  buildAdviseContext: () => string;
  buildCompactContext: () => string;
  buildInsights: () => string;
}

export function AppShell({
  team,
  raw,
  uuid,
  onUuidChange,
  onRefresh,
  loading,
  metaStore,
  onMetaStoreChange,
  time,
  mode,
  onFilterChange,
  filterLoading,
  filterError,
  buildAdviseContext,
  buildCompactContext,
  buildInsights,
}: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  // Bumped whenever a mutation invalidates data that sibling panels read but
  // don't own — they key re-reads off these counters so changes show without a
  // full page refresh. statHistory lives in localStorage; replay metrics +
  // position weights live in the DB. Both writers and readers are children
  // here, so this is the natural place to lift the signal.
  const [statHistoryVersion, setStatHistoryVersion] = useState(0);
  const [replayDataVersion, setReplayDataVersion] = useState(0);

  const visibleTabs = process.env.NODE_ENV === 'development'
    ? TABS
    : TABS.filter((t) => !t.devOnly);

  return (
    <div className="mx-auto max-w-6xl">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h1 className="truncate text-lg font-bold text-slate-100">
                {team.name ?? 'Unknown Team'}
              </h1>
              {team.recentRecord ? (
                <span className="shrink-0 text-xs text-slate-400">
                  {team.recentRecord}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {team.manager ? (
                <span className="text-[11px] text-slate-500">
                  Manager: {team.manager}
                </span>
              ) : null}
              <TeamLookup
                uuid={uuid}
                onChange={onUuidChange}
                loading={loading}
                compact
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <TimeRangeFilter
              time={time}
              mode={mode}
              onChange={onFilterChange}
              loading={filterLoading}
              inline
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
              <AuthUserButton />
            </div>
          </div>
        </div>
      </header>

      {/* Tab bar */}
      <nav className="border-b border-slate-800 px-4 sm:px-6">
        <div className="-mb-px flex gap-1 overflow-x-auto">
          {visibleTabs.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={
                'shrink-0 whitespace-nowrap px-3 py-2 text-sm font-medium uppercase tracking-wider transition-colors ' +
                (tab === t.value
                  ? 'border-b-2 border-emerald-400 text-emerald-400'
                  : 'text-slate-400 hover:text-slate-200')
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Tab content */}
      <div className="space-y-4 p-4 sm:p-6">
        {filterError ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
            {filterError}
          </div>
        ) : null}

        <div className={tab === 'overview' ? 'space-y-4' : 'hidden'}>
          <OptimalBattingOrder team={team} metaStore={metaStore} />
          <FieldPositionsPanel team={team} metaStore={metaStore} teamUuid={uuid} dataVersion={replayDataVersion} onNavigateToRoster={() => setTab('roster')} />
          <InsightsPanel buildContext={buildAdviseContext} buildCompactContext={buildCompactContext} buildInsights={buildInsights} teamUuid={uuid} />
        </div>

        <div className={tab === 'stats' ? 'space-y-6' : 'hidden'}>
          <StatsSection title="Batting">
            <StatsTable team={team} />
            <AdvancedBattingPanel teamUuid={uuid} dataVersion={replayDataVersion} />
          </StatsSection>
          <StatsSection title="Pitching">
            <PitcherCard pitcher={team.pitcher} />
          </StatsSection>
          <StatsSection title="Defense">
            <AdvancedStatsPanel teamUuid={uuid} onDataChange={() => setReplayDataVersion((v) => v + 1)} />
            <PositionGuidancePanel />
          </StatsSection>
          <StatsSection title="Games">
            <RecentGamesPanel team={team} />
            <ModeBreakdown teamUuid={uuid} time={time} />
          </StatsSection>
        </div>

        <div className={tab === 'roster' ? 'space-y-4' : 'hidden'}>
          <TrainingPanel team={team} metaStore={metaStore} historyVersion={statHistoryVersion} />
          <RosterEditor
            team={team}
            teamUuid={uuid}
            metaStore={metaStore}
            onChange={onMetaStoreChange}
            onHistoryChange={() => setStatHistoryVersion((v) => v + 1)}
          />
        </div>

        <div className={tab === 'tools' ? 'space-y-4' : 'hidden'}>
          <TalentAdvisor
            players={team.players}
            metaStore={metaStore}
            buildContext={buildAdviseContext}
            buildCompactContext={buildCompactContext}
            teamUuid={uuid}
          />
          <RecruitAnalyzer
            open
            onClose={() => setTab('overview')}
            buildContext={buildAdviseContext}
            buildCompactContext={buildCompactContext}
            teamUuid={uuid}
            inline
          />
        </div>

        {/* Mounted lazily so its games fetch only fires when opened. Keyed on
            uuid so switching the viewed team fully resets its internal state
            (selected opponent, filters) rather than keeping the old team's.
            Seeded with the already-scraped recentGames so the dropdown + record
            render with zero upstream calls (the games-list endpoint 429s hard);
            deeper history is an opt-in Refresh inside the tab. */}
        {tab === 'matchups' && (
          <div className="space-y-4">
            <Matchups key={uuid} teamUuid={uuid} seedGames={team.recentGames} />
          </div>
        )}

        {tab === 'debug' && process.env.NODE_ENV === 'development' && (
          <RawJsonPanel raw={raw} />
        )}
      </div>
    </div>
  );
}
