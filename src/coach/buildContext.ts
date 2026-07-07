// Assembles today's live state into the context block the coach reads:
// date + scheduled slot, phase countdown, WHOOP gate, AeT ceiling,
// working weights, recent lifting + cardio history.

import { one, q } from '../lib/db.js';

const SLOT_BY_DOW: Record<number, string> = {
  1: 'MON Upper (Strength RPE 8-9)',
  2: 'TUE Lower (Strength RPE 8-9, terrain accessories)',
  3: 'WED Zone 2 45-60 min',
  4: 'THU Upper (Hypertrophy RPE 7-8)',
  5: 'FRI Lower (Hypertrophy RPE 7-8, terrain accessories)',
  6: 'SAT LONG Zone 2 (priority session)',
  0: 'SUN Recovery walk OR 3rd Z2 (decide off WHOOP)',
};

export function gateFor(recoveryPct: number | null): string {
  if (recoveryPct == null) return 'UNKNOWN (no recovery synced — say so and coach conservatively)';
  if (recoveryPct >= 67) return 'GREEN';
  if (recoveryPct >= 34) return 'YELLOW';
  return 'RED';
}

export async function buildContext(): Promise<string> {
  const now = new Date();
  const today = now.toLocaleDateString('en-CA'); // local date (TZ from .env), not UTC

  const plan = await one(`SELECT * FROM plan_state WHERE id = 1`);
  const whoopWeek = await q(
    `SELECT day, recovery_pct, hrv_ms, resting_hr, sleep_hours, strain
     FROM whoop_daily ORDER BY day DESC LIMIT 7`
  );
  const todayWhoop = whoopWeek.find((r) => r.day.toISOString?.().slice(0, 10) === today) ?? whoopWeek[0] ?? null;
  const aet = await one(`SELECT * FROM aet_ceiling ORDER BY set_on DESC, id DESC LIMIT 1`);
  const weights = await q(`SELECT * FROM working_weights ORDER BY muscle_group, exercise`);
  const sessions = await q(
    `SELECT id, day, title, slot, total_sets, total_volume, notes,
            raw->>'start_time' AS start_time, raw->>'end_time' AS end_time
     FROM workout_sessions ORDER BY day DESC LIMIT 6`
  );
  // WHOOP-recorded activities (for strain overlay + cardio detail).
  const whoopWorkouts = await q(
    `SELECT * FROM whoop_workouts ORDER BY start_at DESC LIMIT 20`
  ).catch(() => [] as any[]); // table appears on first activity sync
  const sets = sessions.length
    ? await q(
        `SELECT session_id, exercise, weight_lbs, reps, rpe
         FROM workout_sets WHERE session_id = ANY($1) ORDER BY id`,
        [sessions.map((s) => s.id)]
      )
    : [];
  const cardio = await q(`SELECT * FROM cardio_sessions ORDER BY day DESC LIMIT 5`);

  const fmtDay = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
  const weeksToEvent = plan
    ? Math.max(0, Math.round((new Date(plan.event_date).getTime() - now.getTime()) / (7 * 86_400_000)))
    : null;

  const lines: string[] = [];
  lines.push(`# TODAY`);
  lines.push(`${today} (${now.toLocaleDateString('en-US', { weekday: 'long' })})`);
  lines.push(`Scheduled slot: ${SLOT_BY_DOW[now.getDay()]}`);
  lines.push('');

  lines.push(`# PHASE`);
  if (plan) {
    lines.push(
      `${plan.phase}, week ${plan.week_in_phase}. Event: ${fmtDay(plan.event_date)} (~${weeksToEvent} weeks out).` +
        (plan.pack_weight_lbs ? ` Current pack weight: ${plan.pack_weight_lbs} lb.` : '')
    );
  } else {
    lines.push('plan_state missing — run db:init.');
  }
  lines.push('');

  lines.push(`# WHOOP`);
  if (todayWhoop) {
    lines.push(
      `Today: recovery ${todayWhoop.recovery_pct ?? '?'}% → GATE ${gateFor(todayWhoop.recovery_pct)}. ` +
        `HRV ${todayWhoop.hrv_ms ?? '?'} ms, RHR ${todayWhoop.resting_hr ?? '?'}, ` +
        `sleep ${todayWhoop.sleep_hours ?? '?'} h, yesterday strain ${todayWhoop.strain ?? '?'}.`
    );
    lines.push(`Last 7 days (recovery/sleep):`);
    for (const r of whoopWeek) {
      lines.push(`  ${fmtDay(r.day)}: ${r.recovery_pct ?? '?'}% / ${r.sleep_hours ?? '?'}h`);
    }
  } else {
    lines.push('No WHOOP data synced. GATE UNKNOWN — coach conservatively, tell Matt to sync.');
  }
  lines.push('');

  lines.push(`# AEROBIC CEILING (AeT)`);
  lines.push(
    aet
      ? `AeT ${aet.aet_hr} bpm (drift test ${fmtDay(aet.set_on)}, ${aet.test_incline}% @ ${aet.test_speed} mph, drift ${aet.drift_pct}%).`
      : 'NO DRIFT TEST YET — the Z2 ceiling is unset. Scheduling it is the first aerobic priority; use nasal breathing as the proxy until then.'
  );
  lines.push('');

  lines.push(`# WORKING WEIGHTS (lbs — actual session weights, not 1RMs)`);
  for (const w of weights) {
    const flags = [
      w.is_compound ? 'compound' : null,
      w.is_protected ? 'PROTECTED' : null,
      w.hard_cap_lbs ? `HARD CAP ${w.hard_cap_lbs}` : null,
      `progress by ${w.progression}`,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `- ${w.exercise} (${w.muscle_group}): ${w.weight_lbs ?? 'CALIBRATION PENDING'}` +
        ` [${flags}]` +
        (w.note ? ` — ${w.note}` : '')
    );
  }
  lines.push('');

  lines.push(`# RECENT LIFTING (last ${sessions.length} sessions)`);
  if (!sessions.length) lines.push('None synced yet.');
  for (const s of sessions) {
    // WHOOP activity overlapping this session = its cardiovascular cost.
    const ww = s.start_time && s.end_time
      ? whoopWorkouts.find(
          (x: any) =>
            new Date(x.start_at).getTime() < new Date(s.end_time).getTime() + 30 * 60_000 &&
            new Date(x.end_at).getTime() > new Date(s.start_time).getTime() - 30 * 60_000
        )
      : null;
    lines.push(
      `${fmtDay(s.day)} — ${s.title ?? s.slot} (${s.total_sets} sets, ${s.total_volume ?? '?'} lb volume)` +
        (ww ? ` [WHOOP: strain ${ww.strain ?? '?'}, avg HR ${ww.avg_hr ?? '?'}, max HR ${ww.max_hr ?? '?'}]` : '')
    );
    const bySession = sets.filter((x) => x.session_id === s.id);
    const byExercise = new Map<string, string[]>();
    for (const x of bySession) {
      const arr = byExercise.get(x.exercise) ?? [];
      arr.push(`${x.weight_lbs ?? 'bw'}x${x.reps ?? '?'}${x.rpe ? `@${x.rpe}` : ''}`);
      byExercise.set(x.exercise, arr);
    }
    for (const [ex, arr] of byExercise) lines.push(`  ${ex}: ${arr.join(', ')}`);
    if (s.notes) lines.push(`  notes: ${s.notes}`);
  }
  lines.push('');

  lines.push(`# RECENT CARDIO (pace-at-HR is the progress metric)`);
  if (!cardio.length) lines.push('None logged yet.');
  for (const c of cardio) {
    lines.push(
      `${fmtDay(c.day)} — ${c.modality}, ${c.duration_min} min, avg HR ${c.avg_hr ?? '?'}` +
        (c.incline_pct != null ? `, ${c.incline_pct}% @ ${c.speed_mph} mph` : '') +
        (c.pack_weight_lbs ? `, pack ${c.pack_weight_lbs} lb` : '') +
        (c.is_drift_test ? ' [DRIFT TEST]' : '') +
        (c.note ? ` — ${c.note}` : '')
    );
  }

  return lines.join('\n');
}
