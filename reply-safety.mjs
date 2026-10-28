// Reply-safety for the hermes apron bridge, mirroring apron-resident's
// module with one upgrade: the circuit breaker persists its state to disk so
// a crash-restart loop cannot silently reset it (the resident-side breaker
// resets on restart).
//
//   shouldReply({ text, self, from }) — fail-closed Gemma decision gate on
//     http://grace:4000/v1/decisions: true only when the sender is explicitly
//     asking this bot to respond. Any error, timeout, or low confidence is
//     false (observe).
//   isSilent(text) — true only for an exact standalone "[SILENT]" token.
//   CircuitBreaker({ max, windowMs, resetMs, stateFile }) — bounds outbound
//     posts; latches tripped until resetMs after the trip, and that latch
//     (plus the post timestamps) is persisted across restarts.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export function isSilent(text) {
  return text.trim() === '[SILENT]';
}

export async function shouldReply({ text, self, from }, { fetchImpl = fetch, url = 'http://grace:4000/v1/decisions', model = 'gemma4', threshold = 0.9 } = {}) {
  try {
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ model, input: `Bot: ${self}\nSender: ${from}\nMessage: ${text}`, questions: [{ id: 'reply', type: 'yes_no', question: 'Is the sender explicitly asking this bot to respond or perform a task? Yes means the message directly addresses the bot and requests a response or action. No means it is an observation, acknowledgment, conversation with someone else, or ambiguous.' }] }),
    });
    if (!response.ok) return false;
    const result = await response.json();
    const yes = result?.answers?.reply?.probabilities?.yes;
    return typeof yes === 'number' && Number.isFinite(yes) && yes >= threshold;
  } catch { return false; }
}

export class CircuitBreaker {
  constructor({ max = 5, windowMs = 60000, resetMs = 30 * 60 * 1000, now = Date.now, stateFile = null } = {}) {
    this.max = max; this.windowMs = windowMs; this.resetMs = resetMs; this.now = now;
    this.stateFile = stateFile;
    this.posts = []; this.tripped = false; this.trippedAt = 0;
    if (stateFile) this.#load();
  }

  allow() {
    const now = this.now();
    if (this.tripped) {
      if (now - this.trippedAt < this.resetMs) return false;
      this.tripped = false; // reset window elapsed — open again, empty window
      this.posts = []; this.trippedAt = 0;
      this.#save();
    }
    this.posts = this.posts.filter(t => now - t < this.windowMs);
    if (this.posts.length >= this.max) {
      this.tripped = true; this.trippedAt = now;
      this.#save();
      return false;
    }
    this.posts.push(now);
    this.#save();
    return true;
  }

  reset() {
    this.posts = []; this.tripped = false; this.trippedAt = 0;
    this.#save();
  }

  #load() {
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (Array.isArray(s.posts)) this.posts = s.posts.filter(t => typeof t === 'number');
      this.tripped = s.tripped === true;
      this.trippedAt = typeof s.trippedAt === 'number' ? s.trippedAt : 0;
    } catch { /* missing or corrupt state starts clean */ }
  }

  #save() {
    if (!this.stateFile) return;
    try {
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ posts: this.posts, tripped: this.tripped, trippedAt: this.trippedAt }));
      renameSync(tmp, this.stateFile);
    } catch { /* persistence is best-effort; in-memory limits still apply */ }
  }
}
