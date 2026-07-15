// GET /plan — read-only phase arc + this week + working weights.

import { Router } from 'express';
import { one, q } from '../lib/db.js';
import { buildTomorrowPlan } from '../services/progression.js';

export const planRouter = Router();

const PHASE_ARC = [
  { phase: 'BASE', window: 'now → ~Aug 17', focus: 'Pure Z2 volume (Wed 45→60, Sat 60→90), full lifting progression. First task: drift test.' },
  { phase: 'SPECIFIC', window: '~Aug 17 → ~Sep 20', focus: 'Saturday = loaded pack hike. Duration first, then load — never both in one week.' },
  { phase: 'SHARPEN', window: '~Sep 20 → hunt', focus: 'Peak long effort, then taper: aerobic -40%, lifting 2-3 maintenance sessions RPE ≤7.' },
];

const WEEK = [
  'No fixed days — the coach schedules each morning from recovery + the rolling week.',
  'Every 7 days: 1 LONG Z2 (never cut) · 2-3 Z2 total · 2-3 lifts · 1+ rest day',
  'Lift A — Lower + trunk (non-negotiable)',
  'Lift B — Upper + carries',
  'Lift C — Optional full-body power (first thing cut)',
  'Rules: lift fresh · no heavy lower 36h before the long session · RED = easy walk',
];

planRouter.get('/plan', async (_req, res) => {
  try {
    const state = await one(`SELECT * FROM plan_state WHERE id = 1`);
    const weights = await q(`SELECT * FROM working_weights ORDER BY muscle_group, exercise`);
    const aet = await one(`SELECT * FROM aet_ceiling ORDER BY set_on DESC, id DESC LIMIT 1`);
    const tomorrow = await buildTomorrowPlan();
    res.json({ state, arc: PHASE_ARC, week: WEEK, aet, weights, tomorrow });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
