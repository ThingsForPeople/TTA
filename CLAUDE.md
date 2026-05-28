# Tiny Teams Analyzer

A multi-user dashboard for analyzing and optimizing teams in **Tiny Teams Baseball**, a mobile baseball management game by Knightmare Games (https://www.tiny-teams.com/).

## What this app does

- Loads any team by UUID from the Tiny Teams public website
- Scrapes the Next.js RSC flight data from the team-search page to extract roster, stats, and recent games
- Displays batting stats, pitcher stats, recommended batting order, and AI-generated insights
- AI chat (Ask AI modal) lets users ask natural-language questions about their team via `/api/advise` and `/api/chat`
- Roster Editor lets users override sim stats, talents, pitch talents, injuries, and handedness (persisted to Postgres per user)
- Training Progress panel (Roster tab) charts sim stat snapshots over time using Recharts
- Talent Advisor and Recruit Analyzer tools on the Tools tab
- Time/mode filters hit the `/api/team-search/teams/:uuid/roster-stats` JSON endpoint for filtered stats

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
- `playerMeta` — per-user sim stat overrides, talents, injuries, pitch talents, handedness (unique on userId + playerUuid)
- `statHistory` — timestamped sim stat snapshots per user per player, grouped by training day (10 AM EST tick)
- `usage` — rate-limit tracking per user/team/action

## Key files

- `app/api/advise/route.ts` — AI advise endpoint (Google Generative AI)
- `app/api/chat/route.ts` — AI chat endpoint
- `app/api/player-meta/route.ts` — CRUD for player sim stats/talents
- `app/api/stat-history/route.ts` — stat snapshot storage and retrieval
- `app/api/team/[uuid]/` — team data proxy
- `app/api/webhooks/clerk/` — Clerk webhook handler for user sync
- `src/lib/auth.ts` — server-side auth helper (Clerk or local-dev bypass)
- `src/hooks/useAuthUser.ts` — client-side auth hook + AuthUserButton
- `src/components/AppShell.tsx` — main app shell with tab navigation (Overview, Stats, Roster, Tools, Debug)
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
- `src/db/schema.ts` — Drizzle schema (users, playerMeta, statHistory, usage)
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

## Game domain context

Tiny Teams Baseball is a mobile game where players recruit, train, and compete with baseball teams. Key concepts:

- **Player archetypes** (11 types) affect stats and playstyle
- **Talents** are special abilities per player (e.g., "Clutch", "Set the Tone", "Law & Order") — some require both pitcher AND catcher to have the talent
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
