// Pull recent Hevy workouts into workout_sessions / workout_sets.
// Hevy stores kg; the spec and working_weights are lbs — converted here.
// Runnable directly: npm run sync:hevy

import { q } from '../lib/db.js';

const API = 'https://api.hevyapp.com/v1';
const KG_TO_LBS = 2.20462;

// Weekly structure → slot label, keyed by JS getDay() (0 = Sunday).
const SLOT_BY_DOW: Record<number, string> = {
  1: 'MON_UPPER_STR',
  2: 'TUE_LOWER_STR',
  3: 'WED_Z2',
  4: 'THU_UPPER_HYP',
  5: 'FRI_LOWER_HYP',
  6: 'SAT_LONG_Z2',
  0: 'SUN_RECOVERY',
};

async function hevyGet(path: string): Promise<any> {
  const key = process.env.HEVY_API_KEY;
  if (!key) throw new Error('HEVY_API_KEY is not set — see .env.example');
  const res = await fetch(`${API}${path}`, { headers: { 'api-key': key } });
  if (!res.ok) throw new Error(`Hevy GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const toLbs = (kg: number | null | undefined) =>
  kg == null ? null : Math.round(kg * KG_TO_LBS * 10) / 10;

/** Sync the most recent `pages` pages of workouts (10 per page). */
export async function syncHevy(pages = 3): Promise<number> {
  let synced = 0;

  for (let page = 1; page <= pages; page++) {
    const data = await hevyGet(`/workouts?page=${page}&pageSize=10`);
    const workouts = data.workouts ?? [];

    for (const w of workouts) {
      const day = w.start_time.slice(0, 10);
      const dow = new Date(w.start_time).getDay();

      let totalVolume = 0;
      let totalSets = 0;
      const sets: { exercise: string; idx: number; lbs: number | null; reps: number | null; rpe: number | null }[] = [];
      for (const ex of w.exercises ?? []) {
        for (const s of ex.sets ?? []) {
          if (s.type === 'warmup') continue;
          const lbs = toLbs(s.weight_kg);
          sets.push({ exercise: ex.title, idx: s.index, lbs, reps: s.reps ?? null, rpe: s.rpe ?? null });
          totalSets++;
          if (lbs && s.reps) totalVolume += lbs * s.reps;
        }
      }

      await q(
        `INSERT INTO workout_sessions (id, day, title, slot, total_volume, total_sets, notes, raw, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (id) DO UPDATE SET
           day = EXCLUDED.day, title = EXCLUDED.title, slot = EXCLUDED.slot,
           total_volume = EXCLUDED.total_volume, total_sets = EXCLUDED.total_sets,
           notes = EXCLUDED.notes, raw = EXCLUDED.raw, synced_at = now()`,
        [w.id, day, w.title, SLOT_BY_DOW[dow] ?? null, Math.round(totalVolume), totalSets, w.description ?? null, JSON.stringify(w)]
      );

      // Re-insert sets so edits in Hevy (fixed weights, added RPE) win.
      await q(`DELETE FROM workout_sets WHERE session_id = $1`, [w.id]);
      for (const s of sets) {
        await q(
          `INSERT INTO workout_sets (session_id, exercise, set_index, weight_lbs, reps, rpe)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [w.id, s.exercise, s.idx, s.lbs, s.reps, s.rpe]
        );
      }
      synced++;
    }

    if (page >= (data.page_count ?? 1)) break;
  }
  return synced;
}

// Run directly: npm run sync:hevy
if (process.argv[1]?.endsWith('hevySync.ts')) {
  syncHevy()
    .then(async (n) => {
      const last = await q(
        `SELECT day, title, slot, total_sets, total_volume FROM workout_sessions ORDER BY day DESC LIMIT 1`
      );
      console.log(`Synced ${n} workout(s). Latest:`, last[0]);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
