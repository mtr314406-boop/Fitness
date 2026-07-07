// The coach: system prompt (philosophy) + buildContext() (live state) → Claude.
// Two entry points: morningCheckin() and chat(message).
// Every exchange is logged to coach_messages.

import Anthropic from '@anthropic-ai/sdk';
import { COACH_SYSTEM_PROMPT } from './systemPrompt.js';
import { buildContext } from './buildContext.js';
import { one, q } from '../lib/db.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

async function callCoach(
  messages: Anthropic.MessageParam[]
): Promise<string> {
  const context = await buildContext();
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: `${COACH_SYSTEM_PROMPT}\n\n=== LIVE STATE (injected at runtime) ===\n${context}`,
    messages,
  });
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
 * Ask the coach to plan tomorrow's lifting session as structured data —
 * this is what gets written into Hevy, so the coach (not a static
 * template) owns exercise selection, supersets, and loads.
 */
export async function planTomorrowSession(): Promise<PlannedSession> {
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
        'Plan TOMORROW\'s lifting session. Output ONLY JSON, no prose, schema: ' +
        '{"lifting": boolean, "slot": string, "exercises": [{"name": string, "sets": number, ' +
        '"reps": number, "weight_lbs": number|null, "superset": string|null, "note": string|null}]}. ' +
        'Rules: apply the weekly structure, the WHOOP gate, and the working weights from context. ' +
        'reps is per set (for unilateral work it means per leg — say so in note). ' +
        'weight_lbs: your best call in pounds; null only if genuinely unknown. ' +
        'superset: shared label ("A", "B") for paired accessories, else null. ' +
        'Recent conversation counts: if a session plan was already agreed in chat, output THAT. ' +
        'If tomorrow is an aerobic or rest day, output {"lifting": false}.',
    },
  ]);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Coach did not return JSON: ' + raw.slice(0, 200));
  return JSON.parse(match[0]);
}

/** Free-form chat with the same brain. Recent history rides along. */
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
  const reply = await callCoach(messages);
  await log('assistant', 'chat', reply);
  return reply;
}
