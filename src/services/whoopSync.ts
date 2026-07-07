// Pull WHOOP cycles + recovery + sleep into whoop_daily.
// One row per day: recovery % (the gate), HRV, RHR, sleep hours, strain.
// Runnable directly: npm run sync:whoop

import 'dotenv/config';
process.env.TZ ||= 'America/Denver';
import { q } from '../lib/db.js';
import { getAccessToken } from './whoopAuth.js';

const API = 'https://api.prod.whoop.com/developer/v2';

async function whoopGet(path: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`WHOOP GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const dayOf = (iso: string) => iso.slice(0, 10);

/** Sync the last `days` days (default 7). */
export async function syncWhoop(days = 7): Promise<number> {
  const start = new Date(Date.now() - days * 86_400_000).toISOString();

  // Physiological cycles: one per day; carries strain and anchors the date.
  const cycles = (await whoopGet(`/cycle?start=${start}&limit=25`)).records ?? [];

  // Sleep hours keyed by wake-up day (naps excluded).
  const sleeps = (await whoopGet(`/activity/sleep?start=${start}&limit=25`)).records ?? [];
  const sleepByDay = new Map<string, number>();
  for (const s of sleeps) {
    if (s.nap) continue;
    const inBed = s.score?.stage_summary?.total_in_bed_time_milli ?? 0;
    const awake = s.score?.stage_summary?.total_awake_time_milli ?? 0;
    const hours = Math.round(((inBed - awake) / 3_600_000) * 10) / 10;
    if (hours > 0) sleepByDay.set(dayOf(s.end), hours);
  }

  let synced = 0;
  for (const c of cycles) {
    const day = dayOf(c.start);

    // Recovery is scored per cycle.
    let recovery: any = null;
    try {
      recovery = await whoopGet(`/cycle/${c.id}/recovery`);
    } catch {
      // No recovery scored for this cycle yet (e.g. today, early morning).
    }

    await q(
      `INSERT INTO whoop_daily (day, recovery_pct, hrv_ms, resting_hr, sleep_hours, strain, raw, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (day) DO UPDATE SET
         recovery_pct = COALESCE(EXCLUDED.recovery_pct, whoop_daily.recovery_pct),
         hrv_ms       = COALESCE(EXCLUDED.hrv_ms, whoop_daily.hrv_ms),
         resting_hr   = COALESCE(EXCLUDED.resting_hr, whoop_daily.resting_hr),
         sleep_hours  = COALESCE(EXCLUDED.sleep_hours, whoop_daily.sleep_hours),
         strain       = COALESCE(EXCLUDED.strain, whoop_daily.strain),
         raw          = EXCLUDED.raw,
         synced_at    = now()`,
      [
        day,
        recovery?.score?.recovery_score ?? null,
        recovery?.score?.hrv_rmssd_milli ?? null,
        recovery?.score?.resting_heart_rate ?? null,
        sleepByDay.get(day) ?? null,
        c.score?.strain != null ? Math.round(c.score.strain * 10) / 10 : null,
        JSON.stringify({ cycle: c, recovery }),
      ]
    );
    synced++;
  }

  // Activities ride along with every recovery sync.
  await syncWhoopWorkouts(days).catch((e) => console.error('whoop workouts sync failed:', e.message));

  return synced;
}

// --- WHOOP activities (the workouts WHOOP itself recorded) ---
// Lifting sessions get matched to Hevy by time overlap in buildContext;
// cardio activities auto-populate cardio_sessions (deduped by whoop id).

const CARDIO_SPORTS = new Set([
  'walking', 'hiking', 'running', 'cycling', 'spinning', 'elliptical',
  'stairmaster', 'rowing', 'swimming', 'mountain biking', 'ruck',
]);

export async function syncWhoopWorkouts(days = 7): Promise<number> {
  await q(`CREATE TABLE IF NOT EXISTS whoop_workouts (
    id          TEXT PRIMARY KEY,
    start_at    TIMESTAMPTZ,
    end_at      TIMESTAMPTZ,
    sport       TEXT,
    strain      NUMERIC,
    avg_hr      INTEGER,
    max_hr      INTEGER,
    kilojoules  NUMERIC,
    raw         JSONB,
    synced_at   TIMESTAMPTZ DEFAULT now()
  )`);

  const start = new Date(Date.now() - days * 86_400_000).toISOString();
  const records = (await whoopGet(`/activity/workout?start=${start}&limit=25`)).records ?? [];

  let n = 0;
  for (const w of records) {
    const sport = (w.sport_name ?? String(w.sport_id ?? 'unknown')).toLowerCase();
    await q(
      `INSERT INTO whoop_workouts (id, start_at, end_at, sport, strain, avg_hr, max_hr, kilojoules, raw, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (id) DO UPDATE SET
         sport = EXCLUDED.sport, strain = EXCLUDED.strain, avg_hr = EXCLUDED.avg_hr,
         max_hr = EXCLUDED.max_hr, kilojoules = EXCLUDED.kilojoules,
         raw = EXCLUDED.raw, synced_at = now()`,
      [
        w.id, w.start, w.end, sport,
        w.score?.strain != null ? Math.round(w.score.strain * 10) / 10 : null,
        w.score?.average_heart_rate ?? null,
        w.score?.max_heart_rate ?? null,
        w.score?.kilojoule != null ? Math.round(w.score.kilojoule) : null,
        JSON.stringify(w),
      ]
    );
    n++;

    if (CARDIO_SPORTS.has(sport)) {
      const tag = `whoop:${w.id}`;
      const exists = await q(`SELECT 1 FROM cardio_sessions WHERE note LIKE $1`, [`%${tag}%`]);
      if (!exists.length) {
        const day = new Date(w.start).toLocaleDateString('en-CA');
        const durationMin = Math.round((new Date(w.end).getTime() - new Date(w.start).getTime()) / 60_000);
        await q(
          `INSERT INTO cardio_sessions (day, modality, duration_min, avg_hr, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [day, sport, durationMin, w.score?.average_heart_rate ?? null, tag]
        );
      }
    }
  }
  return n;
}

// Run directly: npm run sync:whoop
if (process.argv[1]?.endsWith('whoopSync.ts')) {
  syncWhoop()
    .then(async (n) => {
      const today = await q(`SELECT * FROM whoop_daily ORDER BY day DESC LIMIT 1`);
      console.log(`Synced ${n} day(s). Latest:`, today[0]);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
