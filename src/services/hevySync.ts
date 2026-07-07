// Pull recent Hevy workouts into workout_sessions / workout_sets.
// Hevy stores kg; the spec and working_weights are lbs — converted here.
// Runnable directly: npm run sync:hevy

import 'dotenv/config';
process.env.TZ ||= 'America/Denver';
import { q } from '../lib/db.js';
import { hevy, KG_TO_LBS } from '../lib/hevy.js';

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

const toLbs = (kg: number | null | undefined) =>
  kg == null ? null : Math.round(kg * KG_TO_LBS * 10) / 10;

const newestStart = (ws: any[]) =>
  ws.reduce((m, w) => (w.start_time > m ? w.start_time : m), '');

/**
 * Sync the most recent `pages` pages of workouts (10 per page).
 * Hevy pages oldest-first, so with a big history the newest sessions
 * live on the LAST pages — detect the ordering and pull from that end.
 */
export async function syncHevy(pages = 3): Promise<number> {
  const first = await hevy(`/workouts?page=1&pageSize=10`);
  const pageCount = first.page_count ?? 1;
  const cache = new Map<number, any>([[1, first]]);

  let pageNums: number[];
  if (pageCount <= pages) {
    pageNums = Array.from({ length: pageCount }, (_, i) => i + 1);
  } else {
    const last = await hevy(`/workouts?page=${pageCount}&pageSize=10`);
    cache.set(pageCount, last);
    const newestFirst = newestStart(first.workouts ?? []) >= newestStart(last.workouts ?? []);
    pageNums = newestFirst
      ? Array.from({ length: pages }, (_, i) => i + 1)
      : Array.from({ length: pages }, (_, i) => pageCount - pages + 1 + i);
  }

  let synced = 0;
  for (const page of pageNums) {
    const data = cache.get(page) ?? (await hevy(`/workouts?page=${page}&pageSize=10`));
    const workouts = data.workouts ?? [];

    for (const w of workouts) {
      const day = w.start_time.slice(0, 10);
      const dow = new Date(w.start_time).getDay();

      let totalVolume = 0;
      let totalSets = 0;
      const sets: { exercise: string; idx: number; lbs: number | null; reps: number | null; rpe: number | null }[] = [];
      for (const ex of w.exercises ?? []) {
        for (const s of ex.sets ?? []) {
          const lbs = toLbs(s.weight_kg);
          // Volume matches Hevy's convention: every set counts.
          if (lbs && s.reps) totalVolume += lbs * s.reps;
          if (s.type === 'warmup') continue; // working sets only below
          sets.push({ exercise: ex.title, idx: s.index, lbs, reps: s.reps ?? null, rpe: s.rpe ?? null });
          totalSets++;
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
