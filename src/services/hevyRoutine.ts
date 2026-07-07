// Write tomorrow's session into Hevy as a routine (in a "Coach" folder),
// loaded from working_weights. Exercise names are matched to Hevy
// exercise-template ids: Matt's own workout history first (exact ids for
// anything he's done before), then Hevy's full catalog by fuzzy title.
// Runnable directly: npm run routine:push

import 'dotenv/config';
import { hevy, LBS_TO_KG } from '../lib/hevy.js';
import { one, q } from '../lib/db.js';
import { TEMPLATE_BY_DOW, prescriptionFor } from './progression.js';

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
  // Fallback: shortest template title containing every word of the name.
  const tokens = norm(ALIASES[name] ?? name).split(' ');
  let best: (Template & { len: number }) | null = null;
  for (const [key, val] of map) {
    const ktok = key.split(' ');
    if (tokens.every((t) => ktok.includes(t)) && (!best || ktok.length < best.len)) {
      best = { ...val, len: ktok.length };
    }
  }
  return best;
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

export async function pushTomorrowRoutine(): Promise<any> {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const template = TEMPLATE_BY_DOW[tomorrow.getDay()];
  if (!template) {
    return { skipped: 'Tomorrow is an aerobic/recovery day — no Hevy routine to write.' };
  }

  const map = await templateMap();
  const exercises: any[] = [];
  const unmatched: string[] = [];

  for (const name of template.exercises) {
    const w = await one(`SELECT * FROM working_weights WHERE exercise = $1`, [name]);
    const t = resolve(name, map);
    if (!t) {
      unmatched.push(name);
      continue;
    }
    const p = prescriptionFor(w, template.kind);
    const lbs = w?.weight_lbs != null ? Number(w.weight_lbs) : null;
    exercises.push({
      exercise_template_id: t.id,
      superset_id: null,
      rest_seconds: p.rest,
      notes: w?.note ?? (lbs == null ? 'calibration — find the RPE 7-8 weight' : null),
      sets: Array.from({ length: p.sets }, () => ({
        type: 'normal',
        weight_kg: lbs != null ? Math.round(lbs * LBS_TO_KG * 100) / 100 : null,
        reps: p.reps,
      })),
    });
  }

  if (!exercises.length) return { error: 'No exercises matched Hevy templates', unmatched };

  const title = `Coach: ${template.slot} — ${tomorrow.toLocaleDateString('en-CA')}`;
  const folder_id = await coachFolderId().catch(() => null);
  const res = await hevy('/routines', {
    method: 'POST',
    body: JSON.stringify({
      routine: {
        title,
        folder_id,
        notes: 'Written by the coach from working weights. RPE governs on the day.',
        exercises,
      },
    }),
  });
  return { created: title, exercises: exercises.length, unmatched, routine: res.routine ?? res };
}

// Run directly: npm run routine:push
if (process.argv[1]?.endsWith('hevyRoutine.ts')) {
  pushTomorrowRoutine()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
