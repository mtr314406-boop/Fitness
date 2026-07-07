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
import express from 'express';
import { todayRouter } from './routes/today.js';
import { chatRouter } from './routes/chat.js';
import { planRouter } from './routes/plan.js';
import { authorizeUrl, handleCallback } from './services/whoopAuth.js';
import { syncWhoop } from './services/whoopSync.js';
import { syncHevy } from './services/hevySync.js';
import { applyProgression } from './services/progression.js';

const app = express();
app.use(express.json());

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
    res.json({ synced: await syncHevy() });
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
