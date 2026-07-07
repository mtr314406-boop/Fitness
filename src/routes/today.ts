// GET /today — recovery readout + the coach's one call for the day.
// ?refresh=1 regenerates the check-in (e.g. after a late WHOOP sync).

import { Router } from 'express';
import { one } from '../lib/db.js';
import { gateFor } from '../coach/buildContext.js';
import { morningCheckin } from '../coach/coach.js';

export const todayRouter = Router();

todayRouter.get('/today', async (req, res) => {
  try {
    // Latest row, not CURRENT_DATE — the server clock is UTC and rolls
    // over at 5-6pm Mountain time, which would blank the evening readout.
    const whoop = await one(
      `SELECT day, recovery_pct, hrv_ms, resting_hr, sleep_hours, strain
       FROM whoop_daily ORDER BY day DESC LIMIT 1`
    );
    const plan = await one(`SELECT phase, week_in_phase, event_date, pack_weight_lbs FROM plan_state WHERE id = 1`);
    const call = await morningCheckin(req.query.refresh === '1');

    res.json({
      whoop,
      gate: gateFor(whoop?.recovery_pct ?? null),
      plan,
      call,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
