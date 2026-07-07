// POST /chat {message} — free-form conversation with the coach.
// GET /chat — recent transcript (for the Chat screen).

import { Router } from 'express';
import { q } from '../lib/db.js';
import { chat } from '../coach/coach.js';

export const chatRouter = Router();

chatRouter.post('/chat', async (req, res) => {
  const message = req.body?.message;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'body must be {"message": "..."}' });
  }
  try {
    const reply = await chat(message);
    res.json({ reply });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

chatRouter.get('/chat', async (_req, res) => {
  try {
    const messages = await q(
      `SELECT role, kind, content, created_at FROM (
         SELECT id, role, kind, content, created_at FROM coach_messages
         ORDER BY id DESC LIMIT 50
       ) recent ORDER BY id`
    );
    res.json({ messages });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
