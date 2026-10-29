import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReply, isSilent, CircuitBreaker } from './reply-safety.mjs';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('decision requires a confident yes and fails closed', async () => {
  const response = yes => async () => ({ ok: true, json: async () => ({ answers: { reply: { probabilities: { yes } } } }) });
  assert.equal(await shouldReply({ text: 'hermes: hi', self: 'hermes', from: 'squire', isBot: true }, { fetchImpl: response(0.95) }), true);
  assert.equal(await shouldReply({ text: 'hi', self: 'hermes', from: 'squire', isBot: true }, { fetchImpl: response(0.5) }), false);
  // exactly at threshold passes; below does not
  assert.equal(await shouldReply({ text: 'hi', self: 'hermes', from: 'squire', isBot: true }, { fetchImpl: response(0.9) }), true);
  assert.equal(await shouldReply({ text: 'hi', self: 'hermes', from: 'squire', isBot: true }, { fetchImpl: response(0.89) }), false);
});

test('decision gate is fail-closed when the decision service is down', async () => {
  assert.equal(await shouldReply({ text: 'hermes: hi', self: 'hermes', from: 'squire', isBot: true }, { fetchImpl: async () => { throw Error('offline'); } }), false);
  assert.equal(await shouldReply({ text: 'hermes: hi', self: 'hermes', from: 'squire', isBot: true }, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }), false);
});

test('human senders bypass the gate — even pronoun-only messages (2026-10-28 regression)', async () => {
  let calls = 0;
  const countingFetch = async () => { calls += 1; return { ok: true, json: async () => ({ answers: { reply: { probabilities: { yes: 0 } } } }) }; };
  // Gemma judged this 0.91 "no" because it names no bot — the human must still get through.
  assert.equal(await shouldReply({ text: 'hey why are you not talking to me on apron lol', self: 'hermes', from: 'doug', isBot: false }, { fetchImpl: countingFetch }), true);
  assert.equal(calls, 0);
  // A failing decision service must not block a human either.
  assert.equal(await shouldReply({ text: 'hermes: hi', self: 'hermes', from: 'doug', isBot: false }, { fetchImpl: async () => { throw Error('offline'); } }), true);
});

test('only a standalone silence token suppresses output', () => {
  assert.equal(isSilent('  [SILENT]\n'), true);
  assert.equal(isSilent('Explain [SILENT]'), false);
});

test('circuit breaker bounds all posts and latches until the reset window passes', () => {
  let now = 1000;
  const breaker = new CircuitBreaker({ max: 2, windowMs: 100, now: () => now, resetMs: 5000 });
  assert.equal(breaker.allow(), true);
  assert.equal(breaker.allow(), true);
  assert.equal(breaker.allow(), false);
  now += 1000; // past windowMs but not past resetMs — still latched
  assert.equal(breaker.allow(), false);
  now += 5000; // past resetMs measured from the trip — breaker resets
  assert.equal(breaker.allow(), true);
});

test('circuit breaker state survives a restart', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'breaker-'));
  const stateFile = path.join(dir, 'breaker-state.json');
  let now = 1000;
  const first = new CircuitBreaker({ max: 2, windowMs: 100, now: () => now, resetMs: 500, stateFile });
  first.allow(); first.allow(); first.allow(); // trips
  assert.equal(existsSync(stateFile), true);
  // A brand-new breaker (process restart) must inherit the latched state.
  const second = new CircuitBreaker({ max: 2, windowMs: 100, now: () => now, resetMs: 500, stateFile });
  assert.equal(second.allow(), false);
  // Once the reset window passes (measured from trip time, also persisted), it opens again.
  now += 600;
  const third = new CircuitBreaker({ max: 2, windowMs: 100, now: () => now, resetMs: 500, stateFile });
  assert.equal(third.allow(), true);
});

test('corrupt breaker state file starts clean instead of crashing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'breaker-'));
  const stateFile = path.join(dir, 'breaker-state.json');
  const fs = await import('node:fs');
  fs.writeFileSync(stateFile, 'not json');
  const breaker = new CircuitBreaker({ max: 2, now: () => 1000, stateFile });
  assert.equal(breaker.allow(), true);
});
