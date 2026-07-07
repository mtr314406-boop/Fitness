# Fitness Coach — Setup

Your coach that runs FITNESS SPEC v2 against WHOOP + Hevy every morning.

## What's already built (this scaffold)
- `db/schema.sql` — all state tables (weights, history, recovery, phase)
- `db/seed.sql` — your working weights + BASE phase, from the spec
- `src/coach/systemPrompt.ts` — the ENTIRE spec compiled into coach rules

Everything else you build in the Codespace with Claude Code, in order.

---

## Step 0 — Keys first (5 min, phone/iPad)
1. Hevy: hevy.com/settings?developer → copy API key (needs PRO — you have it)
2. WHOOP: developer.whoop.com → Dashboard → create app → Client ID + Secret.
   Set redirect URL to your Codespace/Render callback (fill later).
3. Anthropic: console.anthropic.com → API key

## Step 1 — Codespace (your dev machine, from iPad)
1. github.com → new repo `fitness-coach` (or a folder in your OS repo)
2. Push this scaffold to it
3. Code → Create codespace on main. Full Linux shell + editor in Safari.

## Step 2 — Wire it up (in the Codespace terminal)
```bash
cp .env.example .env      # fill in your 3 keys
npm install
npm run db:init           # creates tables + seeds your weights
```

## Step 3 — Build order (drive with Claude Code)
Each step is testable before the next. Tell Claude Code to build them one
at a time:

1. `src/lib/db.ts` — pg pool + query helper
2. `src/services/whoopAuth.ts` + `whoopSync.ts` — OAuth, store tokens,
   pull recovery into `whoop_daily`. TEST: confirm one real recovery %.
3. `src/services/hevySync.ts` — pull recent workouts into `workout_sessions`
   /`workout_sets`. TEST: your last session shows up.
4. `src/coach/buildContext.ts` — assemble today's recovery + phase +
   scheduled slot + recent logs + working weights into a context block.
5. `src/coach/coach.ts` — call Anthropic with system prompt + context.
   Two entry points: `morningCheckin()` and `chat(message)`.
6. `src/routes/*` — `/today`, `/chat`, `/plan` endpoints.
7. `src/services/progression.ts` — apply the +5/+10 rule, update
   `working_weights`, write tomorrow's Hevy routine.

## Step 4 — The interface (web/, last)
Thin React app, 3 screens, iPad-friendly:
- **Today** — recovery readout + the coach's one call + reply box
- **Chat** — free-form, same brain
- **Plan** — read-only phase arc + this week

Build after the `/today` endpoint returns real data — the screen is a
skin over it.

## Deploy
Render (matches your OS). Backend web service + the web/ as a static site.
Add a cron job for nightly `sync:whoop` and `sync:hevy`. Optionally a Hevy
webhook to sync the moment you finish a workout.
