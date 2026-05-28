# Tiny Teams Analyzer

A dashboard for analyzing and optimizing teams in [Tiny Teams Baseball](https://www.tiny-teams.com/), a mobile baseball management game by Knightmare Games.

## Features

- **Roster analysis** — batting stats, pitcher stats, fielding performance
- **Batting order optimizer** — role-based slot assignment (leadoff, cleanup, etc.)
- **Field position optimizer** — sim stats + fielding performance + talent-aware positioning
- **Roster editor** — override sim stats, talents, pitch talents, injuries, handedness
- **Training progress** — chart sim stat changes over time across training days
- **AI insights** — natural-language analysis of your team's strengths and weaknesses
- **Talent advisor** — evaluate talent combinations and zone coverage
- **Recruit analyzer** — assess potential recruits against your roster

## Quick start

No configuration required. Clone, install, and run:

```bash
git clone https://github.com/ThingsForPeople/TTA.git
cd TTA
npm install
npm run dev
```

Open http://localhost:3000 and enter your team UUID (find it in the URL when viewing your team on tiny-teams.com).

Everything works out of the box with localStorage persistence. Auth, database, and AI features are optional.

## Setup tiers

### Tier 1: Zero config (default)

No env vars needed. You get team scraping, stat analysis, batting/field position optimizer, and localStorage persistence.

### Tier 2: Local dev with database

Add a Postgres database for server-side persistence (roster edits, stat history, position weights):

```bash
cp .env.example .env.local
```

Set these in `.env.local`:

```env
AUTH_DISABLED=true
NEXT_PUBLIC_AUTH_DISABLED=true
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tiny_teams
```

Then run migrations:

```bash
npm run db:generate
npm run db:migrate
```

### Tier 3: Full production

For multi-user deployment with authentication:

1. Create a [Clerk](https://clerk.com) application
2. Set up a Postgres database (Neon, Supabase, or any provider)
3. Configure all env vars (see `.env.example`)
4. Set up the Clerk webhook endpoint at `/api/webhooks/clerk`

### AI features (any tier)

AI insights and the recruit/talent tools use a cloud LLM. Set an API key from either provider:

```env
GROQ_API_KEY=your-groq-key        # Groq (free tier available)
GEMINI_API_KEY=your-gemini-key     # Google Gemini (alternative)
```

### Local AI chat with Claude Code

In development mode, an "Ask AI" modal is available that runs queries through a local Claude Code agent via the `@anthropic-ai/claude-agent-sdk`. This gives you a conversational AI assistant that understands your full team context.

Requirements:
1. [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` CLI available in your PATH)
2. Dev server running (`npm run dev`)

The chat modal appears automatically in the bottom-right corner when running locally. The `/api/chat` route is disabled in production — it only responds in development mode.

## Tech stack

- [Next.js 15](https://nextjs.org) (App Router) + React 18 + TypeScript
- [Tailwind CSS v4](https://tailwindcss.com)
- [Drizzle ORM](https://orm.drizzle.team) + [postgres.js](https://github.com/porsager/postgres)
- [Clerk](https://clerk.com) (optional auth)
- [Recharts](https://recharts.org) (training progress charts)
- [Groq](https://groq.com) / [Google Gemini](https://ai.google.dev) (optional AI)

## Commands

```bash
npm run dev          # Start dev server (http://localhost:3000)
npm run build        # Production build
npm run start        # Start production server
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Run Drizzle migrations
npm run db:studio    # Open Drizzle Studio
```

## Game context

Tiny Teams Baseball is a mobile game where you recruit, train, and compete with a baseball team. The analyzer helps you make data-driven decisions about:

- **Batting order** — who should lead off, bat cleanup, etc. based on OBP, SLG, K%, and other stats
- **Field positions** — where to place players based on sim stats (CON, POW, SPD, FLD, ARM) and real fielding performance
- **Talent synergies** — which talent combinations work together (zone coverage, pitcher-catcher pairings)
- **Training priorities** — which stats to focus on based on current roster gaps

## License

MIT
