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
  return synced;
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
