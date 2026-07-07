// The coach: system prompt (philosophy) + buildContext() (live state) → Claude.
// Two entry points: morningCheckin() and chat(message).
// Every exchange is logged to coach_messages.

import Anthropic from '@anthropic-ai/sdk';
import { COACH_SYSTEM_PROMPT } from './systemPrompt.js';
import { buildContext } from './buildContext.js';
import { one, q } from '../lib/db.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

// --- The coach's hands: actions it can take when asked in chat ---

const COACH_TOOLS: Anthropic.Tool[] = [
  {
    name: 'write_routine_to_hevy',
    description:
      "Write a lifting session into Matt's Hevy app (Coach folder) as a routine. " +
      'Use when Matt asks to send/update a workout in Hevy. The session content ' +
      'comes from this conversation and the working weights.',
    input_schema: {
      type: 'object',
      properties: { day: { type: 'string', enum: ['today', 'tomorrow'] } },
      required: ['day'],
    },
  },
  {
    name: 'sync_hevy',
    description: "Pull Matt's latest logged workouts from Hevy into the database. Use when he says he finished a session.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'sync_whoop',
    description: 'Pull the latest WHOOP recovery/sleep/strain data into the database.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'apply_progression',
    description: 'Run the +5/+10 progression rule over recent history and update working weights. Returns what moved.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'update_working_weight',
    description:
      'Set a working weight and/or note for one exercise (calibration results, coaching decisions). ' +
      'Use the exact exercise name from the working-weights table in context.',
    input_schema: {
      type: 'object',
      properties: {
        exercise: { type: 'string' },
        weight_lbs: { type: 'number' },
        note: { type: 'string' },
      },
      required: ['exercise', 'weight_lbs'],
    },
  },
];

async function runTool(name: string, input: any): Promise<string> {
  switch (name) {
    case 'write_routine_to_hevy': {
      const { pushRoutine } = await import('../services/hevyRoutine.js');
      return JSON.stringify(await pushRoutine(input.day === 'today' ? 0 : 1));
    }
    case 'sync_hevy': {
      const { syncHevy } = await import('../services/hevySync.js');
      const { syncWhoopWorkouts } = await import('../services/whoopSync.js');
      const n = await syncHevy();
      await syncWhoopWorkouts(2).catch(() => {}); // strain for the session that just ended
      const s = await one(
        `SELECT id, day, title, total_sets, total_volume FROM workout_sessions
         ORDER BY day DESC, synced_at DESC LIMIT 1`
      );
      if (!s) return `Synced ${n} workout(s); database has none.`;
      const sets = await q(
        `SELECT exercise, weight_lbs, reps, rpe FROM workout_sets WHERE session_id = $1 ORDER BY id`,
        [s.id]
      );
      const byExercise = new Map<string, string[]>();
      for (const x of sets) {
        const arr = byExercise.get(x.exercise) ?? [];
        arr.push(`${x.weight_lbs ?? 'bw'}x${x.reps ?? '?'}${x.rpe ? `@${x.rpe}` : ''}`);
        byExercise.set(x.exercise, arr);
      }
      const detail = [...byExercise].map(([ex, arr]) => `  ${ex}: ${arr.join(', ')}`).join('\n');
      const dayStr = s.day instanceof Date ? s.day.toISOString().slice(0, 10) : s.day;
      return `Synced ${n} workout(s). Most recent — ${dayStr} ${s.title} (${s.total_sets} sets, ${s.total_volume} lb):\n${detail}`;
    }
    case 'sync_whoop': {
      const { syncWhoop } = await import('../services/whoopSync.js');
      return `Synced ${await syncWhoop()} day(s) from WHOOP.`;
    }
    case 'apply_progression': {
      const { applyProgression } = await import('../services/progression.js');
      return JSON.stringify({ moved: await applyProgression() });
    }
    case 'update_working_weight': {
      const rows = await q(
        `UPDATE working_weights
         SET weight_lbs = $2, note = COALESCE($3, note), updated_at = now()
         WHERE exercise = $1 RETURNING exercise`,
        [input.exercise, input.weight_lbs, input.note ?? null]
      );
      return rows.length
        ? `${input.exercise} set to ${input.weight_lbs} lb.`
        : `No exercise named "${input.exercise}" — use the exact name from the working-weights table.`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

async function coachRequest(
  messages: Anthropic.MessageParam[],
  withTools = false
): Promise<Anthropic.Message> {
  const context = await buildContext();
  const toolNote = withTools
    ? '\n\nYou have tools to act on Matt\'s systems (sync data, write routines to Hevy, ' +
      'update working weights). Use them when he asks or when clearly needed, then ' +
      'confirm what you did in one line. The LIVE STATE block is rebuilt fresh after ' +
      'every tool call — after a sync, what you see there IS current; never claim it is stale.'
    : '';
  return anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: `${COACH_SYSTEM_PROMPT}${toolNote}\n\n=== LIVE STATE (injected at runtime) ===\n${context}`,
    messages,
    ...(withTools ? { tools: COACH_TOOLS } : {}),
  });
}

async function callCoach(messages: Anthropic.MessageParam[]): Promise<string> {
  const res = await coachRequest(messages);
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

async function log(role: string, kind: string, content: string): Promise<void> {
  await q(`INSERT INTO coach_messages (role, kind, content) VALUES ($1, $2, $3)`, [role, kind, content]);
}

/**
 * The one call for today. Idempotent per day: returns the stored check-in
 * if one exists, unless force = true.
 */
export async function morningCheckin(force = false): Promise<string> {
  if (!force) {
    const existing = await one<{ content: string }>(
      `SELECT content FROM coach_messages
       WHERE day = CURRENT_DATE AND kind = 'checkin' AND role = 'assistant'
       ORDER BY id DESC LIMIT 1`
    );
    if (existing) return existing.content;
  }

  const reply = await callCoach([
    {
      role: 'user',
      content:
        'Morning check-in. Give me today\'s call: the session (or rest/modification), ' +
        'loads/durations, and the one-line reason if anything changed from the plan.',
    },
  ]);
  await log('assistant', 'checkin', reply);
  return reply;
}

export interface PlannedExercise {
  name: string;
  sets: number;
  reps: number;
  weight_lbs: number | null;
  superset: string | null;
  note: string | null;
}
export interface PlannedSession {
  lifting: boolean;
  slot?: string;
  exercises?: PlannedExercise[];
}

/**
 * Ask the coach to fill in a specific lifting session as structured data —
 * this is what gets written into Hevy. WHICH day it is (and whether it's
 * a lifting day at all) is decided by the caller from the calendar; the
 * coach owns exercise selection, supersets, and loads.
 */
export async function planSession(date: string, weekday: string, slot: string): Promise<PlannedSession> {
  // Recent chat rides along — if a session was already agreed on in
  // conversation, the plan must match it, not re-derive from scratch.
  const history = await q<{ role: string; content: string }>(
    `SELECT role, content FROM (
       SELECT id, role, content FROM coach_messages
       WHERE role IN ('user','assistant')
       ORDER BY id DESC LIMIT 20
     ) recent ORDER BY id`
  );
  const raw = await callCoach([
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    {
      role: 'user',
      content:
        `Write the lifting session for ${date} (${weekday}) — the scheduled slot is: ${slot}. ` +
        'This date and slot are authoritative (from the calendar) — if anything in our conversation ' +
        'implies a different day, trust THIS. Output ONLY JSON, no prose, schema: ' +
        '{"lifting": true, "slot": string, "exercises": [{"name": string, "sets": number, ' +
        '"reps": number, "weight_lbs": number|null, "superset": string|null, "note": string|null}]}. ' +
        'Rules: apply the WHOOP gate and the working weights from context. ' +
        'If a session plan for this slot was already agreed in chat, output exactly that plan. ' +
        'reps is per set (for unilateral work it means per leg — say so in note). ' +
        'weight_lbs: your best call in pounds; null only if genuinely unknown. ' +
        'superset: shared label ("A", "B") for paired accessories, else null.',
    },
  ]);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Coach did not return JSON: ' + raw.slice(0, 200));
  return JSON.parse(match[0]);
}

/**
 * Free-form chat with the same brain, with hands: the coach can sync
 * data, write routines to Hevy, and update weights mid-conversation.
 */
export async function chat(message: string): Promise<string> {
  const history = await q<{ role: string; content: string }>(
    `SELECT role, content FROM (
       SELECT id, role, content FROM coach_messages
       WHERE role IN ('user','assistant')
       ORDER BY id DESC LIMIT 20
     ) recent ORDER BY id`
  );

  await log('user', 'chat', message);

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: message },
  ];

  let reply = '';
  for (let round = 0; round < 5; round++) {
    const res = await coachRequest(messages, true);
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (res.stop_reason !== 'tool_use') {
      reply = text;
      break;
    }

    // Execute the requested actions and hand results back.
    messages.push({ role: 'assistant', content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of res.content) {
      if (b.type !== 'tool_use') continue;
      let out: string;
      try {
        out = await runTool(b.name, b.input);
      } catch (e: any) {
        out = `ERROR: ${e.message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: out });
    }
    messages.push({ role: 'user', content: results });
    reply = text; // keep last text in case the loop caps out
  }

  if (!reply) reply = 'Done (actions ran, but I lost my words — check Hevy/data).';
  await log('assistant', 'chat', reply);
  return reply;
}
