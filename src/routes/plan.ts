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
  'Mon — Upper (Strength RPE 8-9)',
  'Tue — Lower (Strength RPE 8-9, terrain accessories)',
  'Wed — Zone 2, 45-60 min',
  'Thu — Upper (Hypertrophy RPE 7-8)',
  'Fri — Lower (Hypertrophy RPE 7-8, terrain accessories)',
  'Sat — LONG Zone 2 (priority; pack hike in Specific)',
  'Sun — Recovery walk or 3rd Z2, decided off WHOOP',
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
