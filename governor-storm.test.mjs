import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Governor } from './governor.mjs';

const policy = { quietWords: ['quiet'], resumeWords: ['resume'] };

// The storm scenario: bots ack each other's quiet messages ("Going quiet. Say
// '<bot> resume' to bring me back."). Each ack carries the quiet word plus a
// bot name, so the old governor chained acks into the millions.
test('bot acknowledgments cannot trigger quiet or resume', () => {
  const gov = new Governor(policy, { self: 'hermes', bots: ['resident', 'squire', 'colt', 'jeeves'] });
  assert.notEqual(gov.classify({ from: 'squire', text: 'Going quiet. Say "squire resume" to bring me back.' }).action, 'quiet');
  assert.notEqual(gov.classify({ from: 'resident', text: 'Going quiet. Say "resident resume" to bring me back.' }).action, 'quiet');
  // ...and bot messages cannot bring us out of quiet either
  gov.quiet = true;
  assert.notEqual(gov.classify({ from: 'resident', text: 'hermes resume please' }).action, 'resumed');
});

test('an already-quiet bot observes repeated quiet commands instead of re-acking', () => {
  const gov = new Governor(policy, { self: 'hermes', bots: ['resident', 'squire', 'colt', 'jeeves'] });
  assert.equal(gov.classify({ from: 'doug', text: 'hermes: quiet' }).action, 'quiet');
  // ack only on the transition into quiet; repeats are observed silently
  assert.equal(gov.classify({ from: 'doug', text: 'hermes: quiet' }).action, 'observe');
  assert.equal(gov.classify({ from: 'doug', text: 'hermes: quiet' }).action, 'observe');
  assert.equal(gov.classify({ from: 'doug', text: 'hermes: resume' }).action, 'resumed');
});

test('bots can still get conversational replies via name mention (gated elsewhere)', () => {
  const gov = new Governor(policy, { self: 'hermes', bots: ['resident', 'squire', 'colt', 'jeeves'] });
  const d = gov.classify({ from: 'resident', text: 'hermes, what did doug mean by that?' });
  assert.equal(d.action, 'reply');
});

test('a human followup within the continuation window replies even with no name', () => {
  const gov = new Governor(policy, { self: 'hermes', bots: ['resident', 'squire', 'colt', 'jeeves'] });
  assert.equal(gov.classify({ from: 'doug', text: 'hermes: hi' }).action, 'reply'); // opens the conversation
  const d = gov.classify({ from: 'doug', text: 'so what did you mean by that lol' });
  assert.equal(d.action, 'reply');
});

test('an unaddressed human message after the continuation window is just observed', () => {
  const gov = new Governor(policy, { self: 'hermes', bots: ['resident', 'squire', 'colt', 'jeeves'] });
  assert.equal(gov.classify({ from: 'doug', text: 'hermes: hi' }).action, 'reply');
  // 6 minutes later — outside followupSeconds (300)
  const realNow = Date.now; Date.now = () => realNow() + 6 * 60 * 1000;
  try { assert.equal(gov.classify({ from: 'doug', text: 'so what did you mean by that lol' }).action, 'observe'); }
  finally { Date.now = realNow; }
});

test('room heat does not defer a name mention while the bot is mid-conversation', () => {
  const gov = new Governor(policy, { self: 'hermes', bots: ['resident', 'squire', 'colt', 'jeeves'] });
  assert.equal(gov.classify({ from: 'doug', text: 'hermes: hi' }).action, 'reply');
  const d = gov.classify({ from: 'doug', text: 'hey hermes, one more thing' }); // human traffic < 120s ago
  assert.equal(d.action, 'reply');
});

test('room heat still defers casual name mentions in human-to-human chatter', () => {
  const gov = new Governor(policy, { self: 'hermes', bots: ['resident', 'squire', 'colt', 'jeeves'] });
  gov.classify({ from: 'doug', text: 'hey hermes, what do you think?' }); // reply — but we won't count it against a chat
  // Simulate: bot not in the conversation — clear the reply timestamp.
  gov.lastBotReplyAt = 0;
  const d = gov.classify({ from: 'eileen', text: 'lol hermes would say that' });
  assert.equal(d.action, 'observe');
});
