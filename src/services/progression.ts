// Progressive overload, mechanized:
//   top of rep range at target RPE for 2 consecutive exposures → add weight.
//   Upper compounds +5 lb, lower +10 lb. Accessories progress by reps (the
//   coach prescribes those verbally; only progression='weight' rows move here).
// Also builds tomorrow's routine and (optionally) pushes it to Hevy.

import { one, q } from '../lib/db.js';

// Defaults to tune as the block settles. "Top of rep range" per the spec:
// strength compounds run lower ranges than accessories.
const REP_TOP = { compound: 6, accessory: 12 };
const RPE_TARGET = { compound: 9, accessory: 8 };

const isLower = (w: { muscle_group: string | null; exercise: string }) =>
  w.muscle_group === 'LEGS' || /deadlift|squat|lunge/i.test(w.exercise);

export interface ProgressionResult {
  exercise: string;
  from: number;
  to: number;
  reason: string;
}

/**
 * Scan the last two exposures of every weight-progression exercise and
 * bump working_weights where the rule fires. Returns what moved.
 */
export async function applyProgression(): Promise<ProgressionResult[]> {
  const weights = await q(
    `SELECT * FROM working_weights WHERE progression = 'weight' AND weight_lbs IS NOT NULL`
  );
  const moved: ProgressionResult[] = [];

  for (const w of weights) {
    // Last 2 sessions that contain this exercise, best working set of each.
    const exposures = await q(
      `SELECT s.day, MAX(ws.weight_lbs) AS top_weight,
              MAX(ws.reps) FILTER (WHERE ws.weight_lbs >= $2) AS top_reps,
              MAX(ws.rpe)  FILTER (WHERE ws.weight_lbs >= $2) AS top_rpe
       FROM workout_sets ws JOIN workout_sessions s ON s.id = ws.session_id
       WHERE ws.exercise = $1
       GROUP BY s.day ORDER BY s.day DESC LIMIT 2`,
      [w.exercise, w.weight_lbs]
    );
    if (exposures.length < 2) continue;

    const repTop = w.is_compound ? REP_TOP.compound : REP_TOP.accessory;
    const rpeTarget = w.is_compound ? RPE_TARGET.compound : RPE_TARGET.accessory;

    const qualifies = exposures.every(
      (e) =>
        e.top_reps != null &&
        Number(e.top_reps) >= repTop &&
        (e.top_rpe == null || Number(e.top_rpe) <= rpeTarget)
    );
    if (!qualifies) continue;

    const bump = isLower(w) ? 10 : 5;
    let next = Number(w.weight_lbs) + bump;
    if (w.hard_cap_lbs != null && next > Number(w.hard_cap_lbs)) {
      next = Number(w.hard_cap_lbs);
      if (next === Number(w.weight_lbs)) continue; // already at the cap — hold
    }

    await q(
      `UPDATE working_weights
       SET weight_lbs = $2, note = $3, updated_at = now()
       WHERE exercise = $1`,
      [w.exercise, next, `auto +${next - Number(w.weight_lbs)} on ${new Date().toISOString().slice(0, 10)} (2 exposures at rep top)`]
    );
    moved.push({
      exercise: w.exercise,
      from: Number(w.weight_lbs),
      to: next,
      reason: `${repTop}+ reps at ≤RPE ${rpeTarget} for 2 consecutive exposures`,
    });
  }
  return moved;
}

// --- Tomorrow's session, from the weekly structure + working weights ---

export type DayKind = 'strength' | 'hypertrophy';

export const TEMPLATE_BY_DOW: Record<number, { slot: string; kind: DayKind; exercises: string[] } | null> = {
  1: { slot: 'MON Upper (Strength)', kind: 'strength', exercises: ['Barbell Bench Press', 'Barbell OHP', 'Barbell Bent Over Row', 'Lat Pulldown', 'Barbell Curl'] },
  2: { slot: 'TUE Lower (Strength)', kind: 'strength', exercises: ['Back Squat', 'Conventional Deadlift', 'Bulgarian Split Squat', 'Leg Curl'] },
  3: null, // WED Zone 2 — aerobic, lives in cardio_sessions not Hevy
  4: { slot: 'THU Upper (Hypertrophy)', kind: 'hypertrophy', exercises: ['Incline Barbell Press', 'Dumbbell Bench Press', 'Lat Pulldown', 'Lateral Raise', 'Tricep Pushdown', 'Barbell Curl'] },
  5: { slot: 'FRI Lower (Hypertrophy)', kind: 'hypertrophy', exercises: ['Back Squat', 'Romanian Deadlift', 'Bulgarian Split Squat', 'Leg Curl'] },
  6: null, // SAT long Z2 / pack hike
  0: null, // SUN recovery
};

// Default set/rep/rest prescriptions per the spec's RPE ranges. The coach
// adjusts on the day; these are what gets written into the Hevy routine.
export function prescriptionFor(
  w: { is_compound?: boolean } | null,
  kind: DayKind
): { sets: number; reps: number; rest: number } {
  if (w?.is_compound) {
    return kind === 'strength' ? { sets: 4, reps: 5, rest: 180 } : { sets: 3, reps: 8, rest: 150 };
  }
  return kind === 'strength' ? { sets: 3, reps: 8, rest: 120 } : { sets: 3, reps: 12, rest: 90 };
}

export async function buildTomorrowPlan(): Promise<{ slot: string; lines: string[] } | null> {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const template = TEMPLATE_BY_DOW[tomorrow.getDay()];
  if (!template) return null; // aerobic day — no Hevy routine

  const lines: string[] = [];
  for (const name of template.exercises) {
    const w = await one(`SELECT * FROM working_weights WHERE exercise = $1`, [name]);
    if (!w) continue;
    const p = prescriptionFor(w, template.kind);
    lines.push(
      `${name}: ${p.sets}x${p.reps} @ ${w.weight_lbs ?? 'CALIBRATE'} lb` +
        (w.hard_cap_lbs ? ` (cap ${w.hard_cap_lbs})` : '') +
        ` — progress by ${w.progression}`
    );
  }
  return { slot: template.slot, lines };
}
