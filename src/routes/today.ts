// GET /today — recovery readout + the coach's one call for the day.
// ?refresh=1 regenerates the check-in (e.g. after a late WHOOP sync).

import { Router } from 'express';
import { one, q } from '../lib/db.js';
import { gateFor } from '../coach/buildContext.js';
import { morningCheckin } from '../coach/coach.js';

/** Today's completed training: Hevy sessions (with sets) + WHOOP overlay + cardio. */
async function todaysTraining() {
  const todayStr = new Date().toLocaleDateString('en-CA');

  const sessions = await q(
    `SELECT id, title, slot, total_sets, total_volume, notes,
            raw->>'start_time' AS start_time, raw->>'end_time' AS end_time
     FROM workout_sessions WHERE day = $1 ORDER BY synced_at DESC`,
    [todayStr]
  );

  const workouts = [];
  for (const s of sessions) {
    const sets = await q(
      `SELECT exercise, weight_lbs, reps, rpe FROM workout_sets WHERE session_id = $1 ORDER BY id`,
      [s.id]
    );
    const byExercise = new Map<string, string[]>();
    for (const x of sets) {
      const arr = byExercise.get(x.exercise) ?? [];
      arr.push(`${x.weight_lbs ?? 'bw'}×${x.reps ?? '?'}${x.rpe ? `@${x.rpe}` : ''}`);
      byExercise.set(x.exercise, arr);
    }
    const whoop =
      s.start_time && s.end_time
        ? await one(
            `SELECT sport, strain, avg_hr, max_hr, kilojoules FROM whoop_workouts
             WHERE start_at < $2::timestamptz + interval '30 minutes'
               AND end_at   > $1::timestamptz - interval '30 minutes'
             ORDER BY start_at DESC LIMIT 1`,
            [s.start_time, s.end_time]
          ).catch(() => null)
        : null;
    workouts.push({
      title: s.title,
      slot: s.slot,
      total_sets: s.total_sets,
      total_volume: s.total_volume,
      exercises: [...byExercise].map(([name, arr]) => ({ name, sets: arr.join(', ') })),
      whoop,
    });
  }

  const cardio = await q(
    `SELECT modality, duration_min, avg_hr, incline_pct, speed_mph, is_drift_test, note
     FROM cardio_sessions WHERE day = $1 ORDER BY id`,
    [todayStr]
  );

  return { workouts, cardio };
}

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
    const training = await todaysTraining();
    const week = await q(
      `SELECT day, recovery_pct FROM whoop_daily ORDER BY day DESC LIMIT 7`
    );

    const now = new Date();
    const weeksToEvent = plan
      ? Math.max(0, Math.round((new Date(plan.event_date).getTime() - now.getTime()) / (7 * 86_400_000)))
      : null;

    res.json({
      whoop,
      gate: gateFor(whoop?.recovery_pct ?? null),
      plan,
      call,
      week: week.reverse(),
      weeksToEvent,
      ...training,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
