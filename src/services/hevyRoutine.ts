// Write tomorrow's session into Hevy as a routine (in a "Coach" folder),
// loaded from working_weights. Exercise names are matched to Hevy
// exercise-template ids: Matt's own workout history first (exact ids for
// anything he's done before), then Hevy's full catalog by fuzzy title.
// Runnable directly: npm run routine:push

import 'dotenv/config';
process.env.TZ ||= 'America/Denver';
import { hevy, LBS_TO_KG } from '../lib/hevy.js';
import { one, q } from '../lib/db.js';
import { TEMPLATE_BY_DOW, prescriptionFor } from './progression.js';
import { planSession } from '../coach/coach.js';

// Spec names → Hevy catalog titles, for where they obviously differ.
const ALIASES: Record<string, string> = {
  'Barbell Bench Press': 'Bench Press (Barbell)',
  'Dumbbell Bench Press': 'Bench Press (Dumbbell)',
  'Incline Barbell Press': 'Incline Bench Press (Barbell)',
  'Incline Dumbbell Press': 'Incline Bench Press (Dumbbell)',
  'Conventional Deadlift': 'Deadlift (Barbell)',
  'Barbell Bent Over Row': 'Bent Over Row (Barbell)',
  'Lat Pulldown': 'Lat Pulldown (Cable)',
  'Barbell OHP': 'Overhead Press (Barbell)',
  'Lateral Raise': 'Lateral Raise (Dumbbell)',
  'Barbell Curl': 'Bicep Curl (Barbell)',
  'Tricep Pushdown': 'Triceps Pushdown (Cable - Straight Bar)',
  'Back Squat': 'Squat (Barbell)',
  'Romanian Deadlift': 'Romanian Deadlift (Barbell)',
  'Leg Curl': 'Lying Leg Curl (Machine)',
  "Farmer's Carry": 'Farmers Walk',
  'Farmers Carry': 'Farmers Walk',
  'Farmer Carry': 'Farmers Walk',
};

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');

type Template = { id: string; title: string };

async function templateMap(): Promise<Map<string, Template>> {
  const map = new Map<string, Template>();

  // History first — these ids are exactly what Matt's account uses.
  const sessions = await q(`SELECT raw FROM workout_sessions WHERE raw IS NOT NULL`);
  for (const s of sessions) {
    for (const ex of s.raw?.exercises ?? []) {
      if (ex.exercise_template_id && ex.title && !map.has(norm(ex.title))) {
        map.set(norm(ex.title), { id: ex.exercise_template_id, title: ex.title });
      }
    }
  }

  // Then the catalog; history wins on collisions.
  let page = 1;
  let pageCount = 1;
  do {
    const data = await hevy(`/exercise_templates?page=${page}&pageSize=100`);
    pageCount = data.page_count ?? 1;
    for (const t of data.exercise_templates ?? []) {
      const key = norm(t.title);
      if (!map.has(key)) map.set(key, { id: t.id, title: t.title });
    }
    page++;
  } while (page <= pageCount);

  return map;
}

function resolve(name: string, map: Map<string, Template>): Template | null {
  for (const candidate of [ALIASES[name], name]) {
    if (!candidate) continue;
    const hit = map.get(norm(candidate));
    if (hit) return hit;
  }
  // Fuzzy fallback: most-overlapping title (either direction), ties to the
  // shortest. "Barbell Back Squat" ↔ "Squat (Barbell)" both resolve.
  const tokens = norm(ALIASES[name] ?? name).split(' ');
  let best: { t: Template; score: number; len: number } | null = null;
  for (const [key, val] of map) {
    const ktok = key.split(' ');
    const overlap = tokens.filter((t) => ktok.includes(t)).length;
    if (overlap < 2 || overlap < Math.min(tokens.length, ktok.length)) continue;
    if (!best || overlap > best.score || (overlap === best.score && ktok.length < best.len)) {
      best = { t: val, score: overlap, len: ktok.length };
    }
  }
  return best?.t ?? null;
}

// One exercise line of a session plan, wherever it came from.
type Spec = {
  name: string;
  sets: number;
  reps: number;
  weight_lbs: number | null;
  superset?: string | null;
  note?: string | null;
  rest?: number;
};

// Fallback when the coach plan fails: the static weekly template.
async function staticSpec(target: Date): Promise<{ slot: string; items: Spec[] } | null> {
  const template = TEMPLATE_BY_DOW[target.getDay()];
  if (!template) return null;
  const items: Spec[] = [];
  for (const name of template.exercises) {
    const w = await one(`SELECT * FROM working_weights WHERE exercise = $1`, [name]);
    const p = prescriptionFor(w, template.kind);
    items.push({
      name,
      sets: p.sets,
      reps: p.reps,
      weight_lbs: w?.weight_lbs != null ? Number(w.weight_lbs) : null,
      note: w?.note ?? null,
      rest: p.rest,
    });
  }
  return { slot: template.slot, items };
}

async function coachFolderId(): Promise<number | null> {
  const data = await hevy('/routine_folders?page=1&pageSize=10');
  const existing = (data.routine_folders ?? []).find((f: any) => f.title === 'Coach');
  if (existing) return existing.id;
  const created = await hevy('/routine_folders', {
    method: 'POST',
    body: JSON.stringify({ routine_folder: { title: 'Coach' } }),
  });
  return created.routine_folder?.id ?? created.id ?? null;
}

/** dayOffset 0 = today (morning-of adjustments), 1 = tomorrow (default). */
export async function pushRoutine(dayOffset = 1): Promise<any> {
  // The CALENDAR decides whether it's a lifting day — the coach only
  // fills in the session. (Chat history once talked it into the wrong
  // day; never again.)
  const target = new Date(Date.now() + dayOffset * 86_400_000);
  const template = TEMPLATE_BY_DOW[target.getDay()];
  if (!template) {
    return { skipped: `${target.toLocaleDateString('en-CA')} is an aerobic/recovery day — no Hevy routine to write.` };
  }

  let slot: string;
  let items: Spec[];
  let source = 'coach';
  let planError: string | null = null;

  try {
    const plan = await planSession(
      target.toLocaleDateString('en-CA'),
      target.toLocaleDateString('en-US', { weekday: 'long' }),
      template.slot
    );
    if (!plan.exercises?.length) throw new Error('coach plan had no exercises');
    slot = plan.slot ?? template.slot;
    items = plan.exercises;
  } catch (e: any) {
    planError = e.message;
    const st = await staticSpec(target);
    if (!st) return { skipped: 'Aerobic/recovery day — no Hevy routine to write.' };
    slot = st.slot;
    items = st.items;
    source = 'static template (coach plan failed)';
  }

  const map = await templateMap();
  const exercises: any[] = [];
  const matched: { name: string; hevy: string }[] = [];
  const unmatched: string[] = [];
  const supersetIds = new Map<string, number>();

  for (const it of items) {
    const t = resolve(it.name, map);
    if (!t) {
      unmatched.push(it.name);
      continue;
    }
    matched.push({ name: it.name, hevy: t.title });
    let superset_id: number | null = null;
    if (it.superset) {
      if (!supersetIds.has(it.superset)) supersetIds.set(it.superset, supersetIds.size);
      superset_id = supersetIds.get(it.superset)!;
    }
    exercises.push({
      exercise_template_id: t.id,
      superset_id,
      rest_seconds: it.rest ?? 120,
      notes: it.note ?? (it.weight_lbs == null ? 'calibration — find the RPE 7-8 weight' : null),
      sets: Array.from({ length: it.sets }, () => ({
        type: 'normal',
        weight_kg: it.weight_lbs != null ? Math.round(it.weight_lbs * LBS_TO_KG * 100) / 100 : null,
        reps: it.reps,
      })),
    });
  }

  if (!exercises.length) return { error: 'No exercises matched Hevy templates', unmatched, planError };

  const title = `Coach: ${slot} — ${target.toLocaleDateString('en-CA')}`;
  const folder_id = await coachFolderId().catch(() => null);
  const res = await hevy('/routines', {
    method: 'POST',
    body: JSON.stringify({
      routine: {
        title,
        folder_id,
        notes: 'Written by the coach. RPE governs on the day.',
        exercises,
      },
    }),
  });
  // Persist the plan so /plan (and the coach's context) shows what was
  // actually written to Hevy, not the default template.
  await q(`INSERT INTO coach_messages (role, kind, content) VALUES ('assistant', 'plan', $1)`, [
    JSON.stringify({ date: target.toLocaleDateString('en-CA'), slot, items }),
  ]);

  return { created: title, source, planError, matched, unmatched, routine: res.routine ?? res };
}

// Run directly: npm run routine:push (tomorrow) / npm run routine:push today
if (process.argv[1]?.endsWith('hevyRoutine.ts')) {
  pushRoutine(process.argv[2] === 'today' ? 0 : 1)
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
