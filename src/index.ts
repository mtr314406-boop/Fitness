// Fitness Coach server. Routes:
//   GET  /today            — recovery + the coach's one call (?refresh=1)
//   POST /chat             — talk to the coach   GET /chat — transcript
//   GET  /plan             — phase arc + week + working weights
//   GET  /auth/whoop       — start WHOOP OAuth (once)
//   GET  /auth/whoop/callback
//   POST /sync/whoop       — pull recovery now
//   POST /sync/hevy        — pull workouts now
//   POST /progression/apply — run the +5/+10 rule

import 'dotenv/config';
process.env.TZ ||= 'America/Denver'; // UTC servers flip today/tomorrow at 6pm MT
import express from 'express';
import { todayRouter } from './routes/today.js';
import { chatRouter } from './routes/chat.js';
import { planRouter } from './routes/plan.js';
import { authorizeUrl, handleCallback } from './services/whoopAuth.js';
import { syncWhoop, syncWhoopWorkouts } from './services/whoopSync.js';
import { syncHevy } from './services/hevySync.js';
import { applyProgression } from './services/progression.js';
import { pushRoutine } from './services/hevyRoutine.js';
import { morningCheckin } from './coach/coach.js';

const app = express();
app.use(express.json());
app.use(express.static('web')); // the iPad interface — web/index.html at /

app.use(todayRouter);
app.use(chatRouter);
app.use(planRouter);

app.get('/auth/whoop', (_req, res) => res.redirect(authorizeUrl()));

app.get('/auth/whoop/callback', async (req, res) => {
  const code = req.query.code;
  if (typeof code !== 'string') return res.status(400).send('missing ?code');
  try {
    await handleCallback(code);
    const synced = await syncWhoop();
    res.send(`WHOOP connected. Synced ${synced} day(s). You can close this tab.`);
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});

app.post('/sync/whoop', async (_req, res) => {
  try {
    res.json({ synced: await syncWhoop() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/sync/hevy', async (_req, res) => {
  try {
    const synced = await syncHevy();
    // Grab the WHOOP activity for the session that likely just ended.
    await syncWhoopWorkouts(2).catch(() => {});
    res.json({ synced });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/hevy/routine', async (req, res) => {
  try {
    res.json(await pushRoutine(req.query.day === 'today' ? 0 : 1));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/progression/apply', async (_req, res) => {
  try {
    res.json({ moved: await applyProgression() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`fitness-coach listening on :${port}`));

// --- Nightly automation (local time via TZ) ---
// 04:30 sync WHOOP · 04:35 sync Hevy + progressions · 05:30 fresh check-in.
// Runs inside the web service, so deploys need no separate cron jobs.
const lastRun = new Map<string, string>();
function dailyAt(hhmm: string, task: string, fn: () => Promise<unknown>) {
  setInterval(async () => {
    const now = new Date();
    const day = now.toLocaleDateString('en-CA');
    if (now.toTimeString().slice(0, 5) !== hhmm || lastRun.get(task) === day) return;
    lastRun.set(task, day);
    try {
      await fn();
      console.log(`[auto] ${task} ok (${day})`);
    } catch (e: any) {
      console.error(`[auto] ${task} failed: ${e.message}`);
    }
  }, 25_000);
}
dailyAt('04:30', 'sync-whoop', () => syncWhoop());
dailyAt('04:35', 'sync-hevy', async () => {
  await syncHevy();
  await applyProgression();
});
dailyAt('05:30', 'morning-checkin', () => morningCheckin(true));
