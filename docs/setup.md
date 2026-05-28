# Tiny Teams Analyzer — Full Setup Guide

## Overview

A Next.js 15 App Router application deployed on Vercel. Users sign in, search for any Tiny Teams Baseball team by UUID, view stats and AI-generated insights, and manage roster sim data.

### Stack

| Layer | Technology | Cost |
|---|---|---|
| Framework | Next.js 15 (App Router) | Free |
| Hosting | Vercel (Hobby plan) | Free |
| Auth | Clerk (Vercel Marketplace) | Free tier |
| Database | Neon Postgres (Vercel Marketplace) + Drizzle ORM | Free tier |
| AI | Groq (Llama 3.3 70B) in production | Free tier |
| AI (local dev) | Claude Agent SDK via local Claude Code session | Free (your subscription) |
| Analytics | Vercel Web Analytics + Speed Insights | Free tier |
| CSS | Tailwind CSS v4 | Free |

### Architecture

```
Browser → Vercel (Next.js)
             ├─ /              Landing page (Clerk sign-in)
             ├─ /app           Dashboard (auth-gated, client-side SPA)
             ├─ /api/team/*    Server-side scrape of tiny-teams.com
             ├─ /api/advise    AI insights + recruit analysis (Groq, rate-limited)
             ├─ /api/chat      AI chat (Groq in prod, local Claude in dev)
             ├─ /api/player-meta   CRUD for sim stat overrides (Neon)
             ├─ /api/stat-history  CRUD for training snapshots (Neon)
             └─ /api/webhooks/clerk  User sync from Clerk
```

---

## 1. Prerequisites

- Node.js 20+ (22 LTS recommended)
- A Vercel account (free Hobby plan)
- A GitHub repo (for Vercel deployment)

---

## 2. Environment Variables

Copy `.env.example` to `.env.local` and fill in the values as you complete each section below.

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=
DATABASE_URL=
GROQ_API_KEY=
```

---

## 3. Clerk (Authentication)

### 3a. Create Clerk Application

1. Go to [clerk.com](https://clerk.com) and create a free account
2. Create a new application — name it "Tiny Teams Analyzer"
3. Choose authentication methods (Email + Google recommended)

### 3b. Get API Keys

1. In the Clerk dashboard, go to **API Keys**
2. Copy **Publishable Key** → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
3. Copy **Secret Key** → `CLERK_SECRET_KEY`

### 3c. Configure Redirect URLs

In Clerk dashboard → **Paths**:
- Sign-in URL: `/sign-in`
- Sign-up URL: `/sign-up`
- After sign-in URL: `/app`
- After sign-up URL: `/app`

### 3d. Set Up Webhook (for user sync to database)

1. In Clerk dashboard → **Webhooks** → **Add Endpoint**
2. URL: `https://your-domain.vercel.app/api/webhooks/clerk`
   - For local testing: use [ngrok](https://ngrok.com) or skip until deployed
3. Subscribe to events: `user.created`, `user.updated`
4. Copy the **Signing Secret** → `CLERK_WEBHOOK_SECRET`

### 3e. Vercel Marketplace (alternative)

Instead of manual setup, you can add Clerk from the Vercel Marketplace:
1. Vercel Dashboard → Integrations → Add Clerk
2. This auto-provisions `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` as env vars
3. You still need to set up the webhook manually (step 3d)

---

## 4. Neon Postgres (Database)

### 4a. Create Database

1. Go to [neon.tech](https://neon.tech) and create a free account
2. Create a new project — name it "tiny-teams-analyzer"
3. Copy the **Connection String** → `DATABASE_URL`
   - Format: `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`

### 4b. Vercel Marketplace (alternative)

1. Vercel Dashboard → Storage → Add Neon Postgres
2. This auto-provisions `DATABASE_URL` as an env var
3. Run `vercel env pull .env.local` to sync locally

### 4c. Run Migrations

```bash
# Generate migration SQL from the Drizzle schema
npm run db:generate

# Apply migrations to Neon
npm run db:migrate
```

### 4d. Verify

```bash
# Open Drizzle Studio to inspect tables
npm run db:studio
```

You should see four tables: `users`, `player_meta`, `stat_history`, `usage`.

### Database Schema

| Table | Purpose |
|---|---|
| `users` | Synced from Clerk webhooks. Stores timezone for rate limit calculations. |
| `player_meta` | Per-user sim stat overrides, talents, and position overrides for each player. |
| `stat_history` | Training progress snapshots (sim stats + OVR over time). 2-hour merge window prevents spam. |
| `usage` | Rate limit tracking. One row per AI action per team per day. |

---

## 5. Groq (AI in Production)

1. Go to [console.groq.com](https://console.groq.com) and create a free account
2. Create an API key → `GROQ_API_KEY`

### Free Tier Limits

| Resource | Limit |
|---|---|
| Requests/min | 30 |
| Tokens/min | 15,000 |
| Requests/day | 14,400 |

This is more than enough for a companion app. The app uses `llama-3.3-70b-versatile`.

### What Uses Groq

| Feature | Route | Rate Limited |
|---|---|---|
| Insights panel | `POST /api/advise` | 1/day per team |
| Recruit analyzer | `POST /api/advise` | 3/day per team |
| Ask Claude chat | `POST /api/chat` | No limit |

### Local Dev

In development (`npm run dev`), the Ask Claude chat modal uses your local Claude Code OAuth session via `@anthropic-ai/claude-agent-sdk` instead of Groq. No API key needed. Insights and recruit analysis still use Groq locally (but rate limits are bypassed in dev).

---

## 6. Vercel Analytics

### Setup

1. Deploy the app to Vercel (see section 8)
2. Vercel Dashboard → [Project] → **Analytics** tab → **Enable**
3. Vercel Dashboard → [Project] → **Speed Insights** tab → **Enable**

No env vars or API keys needed — Vercel auto-injects the connection.

### What's Tracked

**Automatic:** All page views (route changes)

**Custom events:**

| Event | Trigger | Properties |
|---|---|---|
| `team_loaded` | Team data loads successfully | `teamUuid`, `teamName` |
| `insight_generated` | Insights panel streams a complete response | `teamUuid` |
| `recruit_analyzed` | Recruit analyzer streams a complete response | `teamUuid`, `recruitName` |
| `chat_message_sent` | Ask Claude chat streams a complete response | (none) |

**Web Vitals:** LCP, FID, CLS, TTFB, INP collected automatically via Speed Insights.

### Free Tier Limits

- Web Analytics: 2,500 events/month
- Speed Insights: 10,000 data points/month
- Data retention: 12 months

---

## 7. Local Development

```bash
# Install dependencies
npm install

# Fill in .env.local (see section 2)

# Run database migrations (needs DATABASE_URL)
npm run db:generate
npm run db:migrate

# Start dev server
npm run dev
```

The app runs at `http://localhost:3000`.

### Dev vs Production Differences

| Behavior | Local Dev | Production |
|---|---|---|
| Ask Claude chat | Local Claude Agent SDK (free) | Groq API |
| Rate limits | Disabled | Enforced |
| Analytics | No-op | Active |
| Clerk auth | Works with test keys | Works with live keys |
| Team scraping | Server-side (same as prod) | Server-side |

---

## 8. Deploying to Vercel

### First Deploy

```bash
# Push to GitHub
git add -A
git commit -m "Initial deploy"
git push origin main

# Import in Vercel
# Vercel Dashboard → Add New Project → Import from GitHub
```

### Environment Variables

Set these in Vercel Dashboard → [Project] → Settings → Environment Variables:

| Variable | Where to Get It |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk dashboard (or auto from Marketplace) |
| `CLERK_SECRET_KEY` | Clerk dashboard (or auto from Marketplace) |
| `CLERK_WEBHOOK_SECRET` | Clerk dashboard → Webhooks |
| `DATABASE_URL` | Neon dashboard (or auto from Marketplace) |
| `GROQ_API_KEY` | console.groq.com |

Or if using Vercel Marketplace integrations, `vercel env pull .env.local` syncs them.

### After First Deploy

1. Update the Clerk webhook URL to your production domain (section 3d)
2. Enable Analytics and Speed Insights (section 6)
3. Verify the webhook by creating a test user

---

## 9. Project Structure

```
app/
  layout.tsx                    Root layout (Clerk + Analytics)
  page.tsx                      Landing page (sign-in/sign-up)
  sign-in/[[...sign-in]]/       Clerk sign-in page
  sign-up/[[...sign-up]]/       Clerk sign-up page
  app/
    layout.tsx                  Auth gate
    page.tsx                    Dashboard entry (client component)
  api/
    advise/route.ts             Groq AI (insights + recruit, rate-limited)
    chat/route.ts               Groq AI in prod / local Claude in dev
    team/[uuid]/route.ts        Scrape team from tiny-teams.com
    team/[uuid]/roster-stats/   Proxy filtered stats
    team/[uuid]/games/[gameId]/ Proxy box scores
    player-meta/route.ts        CRUD for sim stat overrides
    stat-history/route.ts       CRUD for training snapshots
    webhooks/clerk/route.ts     Clerk user sync
middleware.ts                   Clerk auth middleware
src/
  components/                   All React components (client-side)
  db/
    schema.ts                   Drizzle schema (4 tables)
    index.ts                    Lazy-initialized Neon client
  lib/
    api.ts                      Client-side fetch helpers
    rate-limit.ts               Timezone-aware daily limit checker
    system-prompt.ts            Shared AI system prompt
    parseTeam.ts                RSC flight data extraction
    talents.ts                  144 talent definitions
    (+ analysis, types, simData, teamSummary, playerMeta, statHistory)
```

---

## 10. Rate Limits

Enforced in production only. Each limit is per user, per team, per calendar day (in the user's timezone).

| Feature | Daily Limit |
|---|---|
| Insights generation | 1 per team |
| Recruit analysis | 3 per team |
| Ask Claude chat | Unlimited |

Rate limit data is stored in the `usage` table. The user's timezone comes from the `users` table (defaults to `America/New_York`). Day boundaries are calculated server-side using Postgres `date_trunc`.

---

## 11. Troubleshooting

**Build fails with "Missing publishableKey"**
Clerk needs `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` at build time. Make sure it's set in Vercel env vars (or `.env.local` locally).

**Build fails with "No database connection string"**
`DATABASE_URL` is only needed at runtime, not build time. The db client is lazy-initialized. If you see this error, something is importing the db at the module level during build — check for eager imports.

**Webhook returns 400**
Check that `CLERK_WEBHOOK_SECRET` matches the signing secret from Clerk's webhook dashboard. Also verify the endpoint URL is correct and the event types are subscribed.

**"Daily limit reached" for a new day**
The rate limit resets at midnight in the user's timezone. If the user hasn't set a timezone, it defaults to `America/New_York`. Timezone can be updated in the `users` table directly or via Clerk metadata.

**Local dev: "Ask Claude" errors**
Make sure you have an active Claude Code session locally (`claude` CLI must be authenticated). The dev chat route uses `@anthropic-ai/claude-agent-sdk` which requires this.

**Local dev: Insights/Recruit 429 errors**
This shouldn't happen — rate limits are disabled in development. If you see this, check that `NODE_ENV` is `development` (it should be automatically with `npm run dev`).
