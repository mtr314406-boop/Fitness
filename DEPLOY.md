# Deploying to Render

The database is already on Render; this moves the app next to it.

## One-time setup (~10 min, from any browser)

1. **Render dashboard → New → Blueprint**
   - Connect the GitHub repo `mtr314406-boop/Fitness`
   - Branch: `claude/new-session-e1k2nr` (the default)
   - Render reads `render.yaml` and shows the service + env prompts

2. **Paste the env values** (same ones as `.env` in the Codespace):
   - `DATABASE_URL` — the Render Postgres **External Database URL**
   - `ANTHROPIC_API_KEY`, `HEVY_API_KEY`, `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`
   - `WHOOP_REDIRECT_URI` — `https://<your-service>.onrender.com/auth/whoop/callback`
     (Render shows the service name/URL on this screen; adjust after
     first deploy if needed)

3. **Apply / Create.** First build takes a few minutes. The app is then at
   `https://<your-service>.onrender.com` — permanently.

4. **WHOOP dashboard** (developer.whoop.com → your app): change the
   Redirect URL to the same `https://<your-service>.onrender.com/auth/whoop/callback`.
   (Existing tokens keep refreshing without re-auth; this matters only if
   you ever reconnect.)

5. **Phone/iPad**: open the new URL → Share → Add to Home Screen.
   Retire the Codespace bookmark.

## What runs automatically (in-app scheduler, Mountain time)
- 04:30 — WHOOP sync
- 04:35 — Hevy sync + progression rule
- 05:30 — fresh morning check-in (waiting in the app when you wake)

`plan: starter` (~$7/mo) keeps it warm 24/7. Switch `render.yaml` to
`plan: free` to trade that for a ~45s cold start after idle — note the
free tier sleeps through the 04:30 automation unless something pings it,
so paid is recommended while training for October.

## Redeploys
Push to the branch → Render auto-deploys. Nothing else to do.
