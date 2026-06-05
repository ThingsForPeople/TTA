# Tiny Teams Analyzer

A multi-user dashboard for analyzing and optimizing teams in **Tiny Teams Baseball**, a mobile baseball management game by Knightmare Games (https://www.tiny-teams.com/).

## What this app does

- Loads any team by UUID from the Tiny Teams public website
- Scrapes the Next.js RSC flight data from the team-search page to extract roster, stats, and recent games
- Displays batting stats, pitcher stats, recommended batting order, and AI-generated insights
- AI chat (Ask AI modal) lets users ask natural-language questions about their team via `/api/advise` and `/api/chat`
- Roster Editor lets users override sim stats, talents, pitch talents, injuries, handedness, and archetype (persisted to Postgres per user). Setting a **pitcher archetype** (Ace/Gunner/Weaver/Two Way) unlocks the pitch-talent editor for a player even when they aren't listed at P
- Training Progress panel (Roster tab) charts sim stat snapshots over time using Recharts
- Talent Advisor and Recruit Analyzer tools on the Tools tab
- Time/mode filters hit the `/api/team-search/teams/:uuid/roster-stats` JSON endpoint for filtered stats
- **Advanced Stats** (Stats tab): syncs per-game replays into Postgres and derives fielding/contact metrics not exposed by the public API (range, arm, caught-stealing, Plays Above Expected), then folds them into field-position recommendations and data-derived position importance — see "Replay data & advanced fielding metrics" below
- **Replay Analysis** (box-score modal): per-game batting/pitching/fielding/talent breakdown from the replay event log

## Tech stack

- **Framework**: Next.js 15 (App Router, Turbopack dev) + React 18 + TypeScript + Tailwind CSS v4
- **Auth**: Clerk (`@clerk/nextjs`) — optional, multi-user with webhook sync
- **Database**: Postgres via `postgres` (postgres.js) + Drizzle ORM — optional, works with Neon, Supabase, or local postgres
- **AI**: Google Generative AI (`@google/generative-ai`) + Groq SDK for chat/advise routes; `@anthropic-ai/claude-agent-sdk` available in dev
- **Data source**: Scrapes https://www.tiny-teams.com (Next.js RSC flight data). Proxied in dev via Next.js rewrites
- **Charting**: Recharts (training progress line charts, sparklines)
- **Deployment**: Vercel (analytics + speed insights included)

## Auth & database (optional)

The app runs in three tiers depending on which env vars are set:

| Tier | Env vars | What works |
|---|---|---|
| Zero config | None | Team scraping, analysis, optimizer, localStorage persistence |
| Local dev | `AUTH_DISABLED=true`, `NEXT_PUBLIC_AUTH_DISABLED=true`, `DATABASE_URL` | Full DB persistence, single anonymous user |
| Production | Clerk keys, `DATABASE_URL`, AI keys | Multi-user auth, rate limiting, full features |

- `src/lib/auth.ts` — `getUser()` returns `'local-dev'` when `AUTH_DISABLED=true`, otherwise calls Clerk `auth()`
- `src/db/index.ts` — `hasDb()` returns false when `DATABASE_URL` is unset; API routes return sensible defaults
- `src/hooks/useAuthUser.ts` — client-side auth hook + `AuthUserButton` component; uses `NEXT_PUBLIC_AUTH_DISABLED`
- `middleware.ts` — no-op when `AUTH_DISABLED=true`, otherwise runs Clerk middleware
- All API routes use `getUser()` + `hasDb()` for graceful degradation

## Database schema (`src/db/schema.ts`)

- `users` — synced from Clerk via webhook, stores timezone preference
- `playerMeta` — per-user sim stat overrides, talents, injuries, pitch talents, handedness, archetype, age (unique on userId + playerUuid). `isPitcherArchetype()` in `playerMeta.ts` drives pitch-talent gating; `ARCHETYPES`/`PITCHER_ARCHETYPES` are the shared lists; `normalizeArchetype()` canonicalizes the lowercase scraped archetype. **Age is NOT in the scrape** — manual entry only; surfaced to the AI as `Age: N` in the team summary for retirement/succession reasoning
- `statHistory` — timestamped sim stat snapshots per user per player, grouped by training day (10 AM EST tick)
- `usage` — rate-limit tracking per user/team/action
- `recentTeams`, `positionWeights` — recently-viewed teams; per-team optimizer importance/stat weights
- `replayMetrics` — per user/team/game/player derived replay stats; **metrics stored as JSONB** (add fields with no migration, but re-sync to backfill). Includes `engageDists` (raw per-chance `{distance, isOut}`) so the out-curve + PAE/leverage are re-derived at query time from the visible set
- `replaySyncs` — marks a (user,team,game) replay as processed so syncs skip it

**Migrations are HAND-WRITTEN** (`src/db/migrations/0001`–`0008`); the drizzle-kit snapshots are stale, so **do not run `db:generate`** (it prompts interactively and tries to recreate everything). Add a `000N_*.sql` (idempotent `IF NOT EXISTS`) + a `meta/_journal.json` entry by hand; `db:migrate` applies them.

## Key files

- `app/api/advise/route.ts` — AI advise endpoint (Google Generative AI)
- `app/api/chat/route.ts` — AI chat endpoint
- `app/api/player-meta/route.ts` — CRUD for player sim stats/talents
- `app/api/stat-history/route.ts` — stat snapshot storage and retrieval
- `app/api/team/[uuid]/` — team data proxy
- `app/api/webhooks/clerk/` — Clerk webhook handler for user sync
- `src/lib/auth.ts` — server-side auth helper (Clerk or local-dev bypass)
- `src/hooks/useAuthUser.ts` — client-side auth hook + AuthUserButton
- `src/components/AppShell.tsx` — main app shell with tab navigation (Overview, Stats, Roster, Tools, Matchups, Debug). The Matchups tab is mounted lazily (only when opened) so its games-list fetch doesn't fire on page load
- `src/components/Matchups.tsx` — opponent scouting (Matchups tab): pick an opponent, filter by time window (today/yesterday/7d/30d/all) + last-N count, see head-to-head record/run-diff/game list (rows open the box score), plus a **local-only AI matchup analysis** that fetches the filtered subset's replay evals (capped at 8, gentle) and sends a multi-game context to `/api/advise`
- `app/api/team/[uuid]/games/route.ts` — lists a team's games (metadata only) by proxying the public upstream games endpoint; DB-independent, all tiers. Walks the **full history** (newest-first, bounded by `MAX_GAMES`=1500) rather than a recency cap — a flat 150-cap silently buried sparse modes (season games are ~8% of a quickplay-heavy log, so season-only opponents never appeared in the Matchups dropdown). The upstream paginates 10/page and **throttles concurrency, so parallelizing doesn't help** — measured; some teams have 600+ games, and bursts 429. So the walk is **sequential, paced (`INTER_PAGE_MS`), and backs off on 429/5xx** (`fetchPage`) so a cold rate-limited walk isn't truncated. Mitigated by caching: per-page `revalidate` + a response `Cache-Control` (CDN) + a client-side session memo in `Matchups.tsx`, so only the cold load pays the sequential page cost
- `src/components/TrainingPanel.tsx` — training progress charts + delta table (Roster tab)
- `src/components/RosterEditor.tsx` — sim stat / talent / injury editor
- `src/components/RosterOptimizer.tsx` — batting order + field position optimizer
- `src/components/InsightsPanel.tsx` — AI-generated insights
- `src/lib/api.ts` — fetch helpers, time/mode filter resolution
- `src/lib/parseTeam.ts` — RSC flight extraction and player/game mapping
- `src/lib/types.ts` — core TypeScript interfaces (Player, Team, BattingStats, etc.)
- `src/lib/analysis.ts` — batting order recommendation engine, stat insights
- `src/lib/statHistory.ts` — client-side stat history (localStorage + API sync)
- `src/lib/playerMeta.ts` — client-side player meta (localStorage + API sync)
- `src/lib/simData.ts` — position-specific defensive stat guidance
- `src/lib/teamSummary.ts` — builds Markdown context string sent to AI
- `src/lib/talentEffects.ts` — talent displayName → engine stat levers (decoded from replays); zone-effect ranking
- `src/lib/parseReplay.ts` — **replay parser**: `evaluateReplay` (single-game summary), `extractPlayerMetrics` (per-player fielding+batting counting stats), `expectedOut` (per-position out-probability, `POS_CURVE`), `fieldingLinesFromMetrics`, `collectFieldingChances` (raw per-chance `(position,distance,isOut)` records for the curve fitter)
- `scripts/fit-curves.ts` — offline `POS_CURVE` re-fitter (logistic regression of out-vs-distance per position over recent games); prints a `POS_CURVE` literal to paste back. `npx tsx scripts/fit-curves.ts [teamUuid] [numGames]`
- `src/lib/fieldingGrades.ts` — turns aggregated metrics into the optimizer's empirical fielding bonus
- `src/components/AdvancedStatsPanel.tsx` — Stats-tab panel: sync, fielding/batting tables, data-derived position importance. Views: **fielding** (per-player table, expandable to a player's per-position breakdown — "where's this player best"), **batting**, **by position** (`PositionComparison` — inverts `byPosition` to rank every player who's fielded a position by PAE/g, "who's my best SS"), **best alignment** (`BestAlignment` — solves the optimal player→position assignment over the context-corrected PAE matrix, importance-weighted, via `maxAssignment` in `src/lib/assign.ts`: each player one spot, "best overall team composition"; only positions actually fielded are eligible, catcher ranked by steal defense), and **heat map**
- `src/lib/assign.ts` — `maxAssignment`: O(n³) Hungarian (max-weight assignment) over a rectangular weight matrix; powers the best-alignment view
- `src/components/ReplayAnalysis.tsx` — single-game replay tab inside the box-score modal. Hosts the **AI game analysis** (`GameAiAnalysis.tsx`), gated to **dev/local only** (`process.env.NODE_ENV === 'development'`) for now — streams a what-went-right/what-went-wrong eval from `/api/advise` (actionType `game-analysis`)
- `src/lib/gameSummary.ts` — `buildGameContext(ReplayEvaluation)` → compact markdown of one game; `buildGamesContext(evals[], opponentName)` concatenates several for the multi-game matchup read
- `src/components/GameAiAnalysis.tsx` — reusable streaming panel; takes either a ready `context` (single game) or an async `prepareContext()` (matchups: fetch+concat a subset) plus a `prompt`/`title`/`hint`. `GAME_EVAL_PROMPT` is the single-game default
- `app/api/team/[uuid]/replay-sync/route.ts` — GET lists last-100 games + synced set (enumeration stops once it has the window — doesn't walk a 600-game history); POST processes a batch then **prunes** the DB to a rolling `RETENTION_GAMES` (100) window; DELETE clears (for Clear&re-sync)
- `app/api/team/[uuid]/replay-metrics/route.ts` — aggregates stored metrics per player + per-position importance; also emits **per-player per-position fielding splits** (`AggregatedPlayer.byPosition`, most-played first) for the best-position breakdown, and sets each player's `position` to their **most-played** spot (not the last-synced row)
- `app/api/team/[uuid]/games/[gameId]/replay/route.ts` — single-game replay evaluation (proxies + parses)
- `src/db/schema.ts` — Drizzle schema (users, playerMeta, statHistory, usage, recentTeams, positionWeights, replayMetrics, replaySyncs)
- `src/db/index.ts` — Drizzle client init

## Commands

```bash
npm run dev          # Start dev server with Turbopack (http://localhost:3000)
npm run build        # Production build
npm run start        # Start production server
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Run Drizzle migrations
npm run db:studio    # Open Drizzle Studio
```

## Replay data & advanced fielding metrics

A second, richer data source beyond the roster scrape: **per-game replay event logs**. This powers the Advanced Stats panel (Stats tab) and the Replay Analysis tab (box-score modal).

### Upstream endpoints (all public, no auth)
- `GET /api/replay/:gameId` — full deterministic event log, **~2.8 MB**. Shape: `{ game:{home,away:{id,name,players:[{id,position(1-9),firstName,lastName,bats,throws,speed,coordinates{x,y},talents[{id,tier,displayName}]}]}}, segments:[{type,events:[{type,payload}],metadata:{inning,half,atBatId,batterId,pitcherId},gameState:{score,hits,outs,runners}}] }`. **Rate-limits bursts (429)** — fetch gently.
- `GET /api/team-search/teams/:uuid/games?offset=N` — paginated games list (`{results,has_more}`, 10/page, newest-first).
- `GET /api/team-search/teams/:uuid/games/:gameId` — box score (batting+pitching lines; ground truth for verification).
- **ID join**: roster `player.uuid` == box `player_id` == replay player `id` (`parseTeam` sets `uuid: rp.player_id`). Team uuid == `game.home.id`/`away.id`.

### Replay event model (key facts learned)
- One `pitch` segment = one pitch (`pitch.thrown` + `batter.action` + `pitch.result`). The at-bat OUTCOME lands in a later `post` segment as `batter.result`; join by `metadata.atBatId`.
- **Fielding**: putout = `runner.out.fielderId`; assist = a `fielder.throw` whose `targetOut` matches the out runner (**exclude `targetBase:5` = throws back to the mound**); error = `fielder.miss`; positions are standard 1-9 scorekeeping; **range** = dist(player `coordinates` → `fielder.catch.catchPoint`). `catchType` ∈ `pitch`/`relay`/`ground`/`fly` — only `ground`/`fly` count as chances (`pitch`=catcher receiving, `relay`=throw reception). 1B putouts are mostly throw-receptions, not range.
- **Foul balls**: a `fielder.catch`/`miss` in a foul pitch-segment (`batter.foul` or `pitch.result.outcome==='foul'`) with **no out in the segment** is a dead foul-ball *fetch*, NOT a chance — `extractPlayerMetrics` skips it (`skipFoulFetch`). Without this, corner spots (1B 36% / 3B 28% / LF 14% of catches were fouls) get inflated chances/expected-outs/leverage and deflated PAE. Foul pop-OUTS (foul + an out) still count, so box-score putouts reconcile.
- **Steals**: `runner.steal`/`runner.stolen_base` = attempt; if that runner appears in `runner.out` = caught. Credited to our **pos-2 catcher** when the opponent bats.
- **Talents**: internal IDs map to engine `targetKey`s (see `talentEffects.ts`); zone talents are `hz:<row|col>:<effect>`.

### Metrics pipeline
- `extractPlayerMetrics(raw, teamUuid)` → per-player COUNTING stats for one game (so they aggregate across games; averages derived at query time). Stored in `replayMetrics.metrics` (JSONB).
- **Sync** (`/replay-sync`): client-driven, batched (3/POST), gentle (900ms inter-fetch, 1200ms inter-batch, retry/backoff honoring `Retry-After`), resumable/idempotent, multi-round retry of stragglers. Syncs the **most-recent 100 games** (`SYNC_LIMIT`); after each batch it **prunes** stored metrics/syncs beyond a rolling **`RETENTION_GAMES` = 100** window (delete-oldest, keep-newest by completedAt) so the DB tracks recent replays rather than growing unbounded. The panel's "Last N games" query filter is a 5/10/25/50/100 select. `Clear & re-sync` button (DELETE then sync) wipes + rebuilds — **required after changing how metrics are computed**, since plain re-sync SKIPS already-synced games.
- **Query** (`/replay-metrics`): aggregates per player + rolls up per-position importance. **`applyDynamicCurve` re-fits the out-curve from the VISIBLE rows** (via `fitOutCurve`) and recomputes each row's `expectedOuts`/`leverageSum`/`engagedOuts` from its raw `engageDists` before aggregating — so PAE/leverage/importance always self-calibrate to the current time/mode/last-N filter (mean PAE/chance ≈ 0 per position by construction). A position with < `DYNAMIC_MIN_CHANCES` (40) visible chances falls back to the static `POS_CURVE`; rows lacking `engageDists` (pre-backfill) keep their stored values. Consequence: PAE shifts a bit as you change the window (it's relative to the visible cohort) — expected. **Then `applyGameContext` strips the shared per-GAME fielding-difficulty component** (leave-one-out: it estimates each game's difficulty from the REST of the team that game and shifts each row's `expectedOuts` by it, then re-centers per position back to mean-0). This removes a real confound: the out-curve only conditions on (position, distance), so without it a backup whose reps cluster in tougher games (blowouts, bad stretches) read artificially low in cross-player comparisons. Query-time, no re-sync needed (uses the same stored `engageDists`). Only `expectedOuts`/PAE shift — `engagedOuts`/`leverageSum`/importance are untouched. Splits each player's fielding by position (`byPosition`) for the best-position breakdown, ranked by **PAE/game** (now comparable across positions since the visible-set fit is mean-0 per position; positive = above the typical fielder there). Caveat surfaced in-UI: PAE only scores balls ENGAGED (can't see range a fielder lacks); rows below 5 games / 12 chances flagged low-sample, best spot starred only among rankable splits. (A solo-occupant position reads ≈0 since the curve was fit partly on that player — meaningful comparison needs rotation / multiple occupants.)

### Calibrated metrics (the core models)
- **PAE (Plays Above Expected)** = `engagedOuts − Σ P(out | distance, position)`. The out-probability is a **per-position logistic**. **Two paths**: (1) the **query route fits it dynamically** from the visible set (`fitOutCurve` over `engageDists`) — primary, self-calibrating, no re-sync needed when data changes; (2) the static **`POS_CURVE`** in `parseReplay.ts` is the **fallback/prior** (small visible samples, and single-game `ReplayAnalysis` which can't fit from one game) — refreshed offline by **`scripts/fit-curves.ts`** (last fit ~50 games / ~1500 chances; the fitter's `Σout` reconciles exactly with `extractPlayerMetrics` engagedOuts). Both calibrate each position to **mean PAE/chance ≈ 0** (the logistic MLE forces Σouts = Σp per fitted position). The earlier drift (prior `POS_CURVE` over-read 1B +0.086 / RF +0.038 / etc., making RF look like everyone's "best position") is now self-correcting via path (1). Bucketed out-rates drive the shape: **infielders convert ~95–100% at normal range — only the long-distance tail is in doubt, so IF skill-leverage is small and lives at distance; outfielders fall ~100%→~5–8% across the 6–12-unit band where most OF balls land, so OF carries the real leverage.** Curves fit from ONE team's games, so that team's fielding skill is baked into the baseline (PAE is team-relative by design, mean ≈ 0). P (1) and C (2) are NOT fit (pitcher rarely fields, catcher fields no batted balls). Re-run the fitter as more games accrue; `collectFieldingChances` in `parseReplay.ts` yields the raw per-chance `(position, distance, isOut)` records it fits on.
- **Skill-leverage** = `Σ P(1−P)` per chance (max at P=0.5). Drives **data-derived position importance**. Catcher leverage comes from steals (`STEAL_LEVERAGE=0.22`/attempt) since catchers rarely field batted balls.
- **Position importance**: raw shares are `impLeverage` (principled) / `impXouts` (workload) / `impVolume`; the value the optimizer uses is **`impRecommended`** = blend `0.6·impLeverage + 0.4·impXouts` (workload damps small-sample leverage noise + the chances-taken bias), **catcher floored to its default** (its only leverage signal is caught-stealing), normalized to mean 1.0. "Use derived weights" writes `impRecommended` **and the derived stat weights** to `positionWeights`. **Key finding for THIS sim: outfield carries the most defensive leverage (fly balls land in the in-doubt range band); infield grounders are converted ~95–100% so their leverage is low and concentrated in the long tail. CF/LF/RF > SS≈2B/3B > 1B — unlike real MLB.**
- **Derived stat weights** (FLD/ARM/SPD per position, `buildStatWeights`): SPD ← avg range distance covered; ARM ← throw-share (`throws/(throws+chances)`) × avg throw speed — **uses throw rate, NOT assists** (outfielders make ~6 throws/game but rarely get a credited assist, so an assist-based signal wrongly zeroes their arms); FLD ← constant catch/exchange baseline (the log can't isolate receiving/scooping). Each row normalized to sum 1.0, magnitude anchored to the defaults' averages. ARM is then **blended 50/50 toward the hand-tuned prior** (`ARM_DATA_WEIGHT`) because arm's deterrence value — a strong corner-OF arm holding runners — never appears in the log (RF otherwise reads far too low).
- **Optimizer integration** (`empiricalFieldingBonus`): position-ANCHORED PAE/game (×60, cap ±25, confidence=games/25, min 10 games) + transferable arm z-score (×9 × the position's arm weight). Only anchors at positions actually played; never invents a score for unplayed positions. The PAE/games/arm it grades off are **position-pure** — `buildFieldingGrades` pulls them from the player's **primary (most-played) split** (`byPosition[0]`), so a multi-position player's SS bonus is no longer diluted by his 2B reps (previously it anchored the position-MIXED totals to a semi-arbitrary last-row position). Shown as `def ±X` chips. ARM is used twice: sim ARM in `positionScore` weights, and measured arm here.

### Verification (how correctness was established)
Batting (AB/H/K/BB/2B/3B/HR) matches the box score **exactly**; fielding putouts reconcile via `3×defensive_innings − strikeouts`; errors match box; derived AVG/OBP exact; ΣPAE ≈ 0 on the calibration set. Always verify replay-derived stats against the box score.

### Known limitations / next steps
- PAE only scores chances TAKEN, not balls never reached. **"v2 nearest-fielder" was investigated and is NOT feasible** with this data: the log only gives a ball location via `fielder.catch`/`miss` `catchPoint` (where a fielder engaged it), and `batter.contact` has no usable horizontal spray for unfielded balls — a grounder through the SS hole is recorded as a LF catch in the outfield, with nothing saying SS could've reached it. Blending leverage with workload (`impXouts`) is the practical mitigation.
- The aggregate PAE is now **self-calibrating at query time** (`applyDynamicCurve` re-fits from the visible set once `engageDists` is backfilled by a re-sync), so the old "stale curve → everyone's best position is RF" drift no longer needs manual intervention there. The static `POS_CURVE` is just the fallback/prior — `scripts/fit-curves.ts` refreshes it occasionally, but it only matters for small visible samples and single-game views.
- **Game-context confound (mostly addressed):** PAE conditions only on (position, distance), so it can't see that some games were just harder to field. `applyGameContext` removes the *between-player* component (a backup whose reps cluster in tough games no longer reads low vs a regular who played the easy ones) via a leave-one-out per-game team adjustment. Residual: it still can't credit a fielder for the absolute difficulty of his own games beyond what teammates reveal, and (separately) PAE never charges for range a fielder lacks. The catcher slot's value in the alignment view is steal-defense, not batted-ball PAE.
- **RF arm reads low** even after the 50/50 prior blend — pure deterrence value (holding runners without recording an out) is unmeasurable from the log.
- Run-value-weighted leverage (an OF miss = extra bases > an IF single) is the "most correct" importance — not yet built.
- A one-click "Recompute" (clear+resync) was suggested but not built.
- The **talent-chains batting-order mode was removed** (2 of its 3 chain talents were mathematically no-ops); slot-affinity talent value is baked into `slotFit`.

### Repo gotchas
- No ESLint config installed → `tsc --noEmit` + `npm run build` are the gates. Build can flake on a stale Turbopack cache (`rm -rf .next` and retry).
- The `searchParams is async` lint hint is a **false positive** for route handlers parsing `req.url` (this is Next 15).
- `tsx` is a devDep; run one-off TS scripts with `npx tsx`. The cached real replay used for verification was at `/tmp/replay.json` (re-fetch if gone).

## Game domain context

Tiny Teams Baseball is a mobile game where players recruit, train, and compete with baseball teams. Key concepts:

- **Player archetypes** (11 types) affect stats and playstyle
- **Talents** are special abilities per player (e.g., "Clutch", "Set the Tone", "Law & Order") — some require both pitcher AND catcher to have the talent. Talents are permanent once chosen, EXCEPT the most-recently-added one, which a **Lacuna Device** (a common drop / cheap shop item) can erase — doing so re-generates 3 new talent choices for that player. Not undoable, but you can chain another Lacuna to re-roll the choices. Surfaced to the AI in `system-prompt.ts` so talent advice accounts for the "last pick is reversible" mechanic
- **Sim stats**: CON (contact), POW (power), SPD (speed), FLD (fielding), ARM (arm strength), PIT (pitching), STA (stamina) — each 0-100
- **Game modes**: Quickplay, Challenge, Season
- **Positions**: Standard baseball (C, 1B, 2B, SS, 3B, LF, CF, RF, P) + bench (BN)
- **Batting order**: 9 slots, pitcher typically bats 9th. The analyzer recommends orders based on role-based slot assignment (cleanup=SLG, leadoff=OBP-K%, etc.)

### Game schedule (all times ET)

| Event | When | What happens |
|---|---|---|
| **Weekly reset** | Tuesday 6 AM | All players fully heal (energy → 100, injuries cleared). Current season closes. |
| **Daily reset** | Every day 6 AM | Injury rolls on players. Quickplay rewards reset. |
| **Training tick** | Every day 10 AM | Sim stats update from training. The analyzer groups stat snapshots by this boundary (14:00 UTC). |

### Handedness

Each player has a batting hand (B) and throwing hand (T), recorded as `R` (right) or `L` (left) in player meta. Handedness determines how the strike zone is oriented — "Inside" and "Outside" are relative to the batter, not absolute.

### Batting zone grid

The strike zone is a 3×3 grid. Zone talents reference a full row or column, not individual cells. Inside/Outside flip based on batter handedness:

```
  Right-handed batter (R)           Left-handed batter (L)
  (catcher's perspective)           (catcher's perspective)

         Inside  Mid  Outside            Outside  Mid  Inside
        ┌──────┬─────┬──────┐           ┌──────┬─────┬──────┐
  High  │ HI   │ HM  │ HO   │    High  │ HO   │ HM  │ HI   │
        ├──────┼─────┼──────┤           ├──────┼─────┼──────┤
  Mid   │ MI   │ MM  │ MO   │    Mid   │ MO   │ MM  │ MI   │
        ├──────┼─────┼──────┤           ├──────┼─────┼──────┤
  Low   │ LI   │ LM  │ LO   │    Low   │ LO   │ LM  │ LI   │
        └──────┴─────┴──────┘           └──────┴─────┴──────┘
```

- **Row zones**: High (top row), Mid (middle row), Low (bottom row) — same regardless of handedness
- **Column zones**: Inside (closest to batter), Middle (center), Outside (farthest from batter) — flip with handedness
- Each zone talent targets one row or column (3 cells). Two zone talents with different axes overlap on exactly 1 cell (e.g., "Inside" + "Low" both cover the LI corner). Same-axis zones never overlap.
- **Zone effects**: Dialed (general boost), Driver (line drives), Chopper (grounders), Popper (fly balls), Hacker (swing speed). Each can be prefixed by a zone direction (e.g., "High Driver", "Inside Chopper").
- A player with two overlapping zone talents (e.g., "Low Hacker" + "Inside Driver") gets both effects in the overlapping cell (LI), making that cell doubly boosted.
