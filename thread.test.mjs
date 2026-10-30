import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkChain, renderChain } from './thread.mjs';

const m = (id, parent, who = 'doug', text = `msg ${id}`) => ({
  message_id: id, log_id: id, reply_to: parent ? { message_id: parent } : undefined,
  from: { name: who }, body: { text },
});

test('walks a reply chain oldest-first', () => {
  const page = [m('3', '2'), m('2', '1'), m('1')];
  const { chain, missing } = walkChain(page, '3');
  assert.deepEqual(chain.map((c) => c.message_id), ['1', '2', '3']);
  assert.equal(missing, false);
});

test('starts mid-thread: a reply whose parent is on the page', () => {
  const page = [m('9', '8'), m('8')];
  assert.deepEqual(walkChain(page, '9').chain.map((c) => c.message_id), ['8', '9']);
});

test('reports a hole when the parent is outside the fetched window', () => {
  const page = [m('5', '4')]; // parent 4 predates the page
  const { chain, missing } = walkChain(page, '5');
  assert.deepEqual(chain.map((c) => c.message_id), ['5']);
  assert.equal(missing, true);
});

test('reports missing when the message itself is outside the window', () => {
  const { chain, missing } = walkChain([m('7')], '99');
  assert.deepEqual(chain, []);
  assert.equal(missing, true);
});

test('a self-referential or cyclic reply_to cannot loop', () => {
  const page = [{ ...m('2', '2') }, { ...m('1', '2') }];
  const { chain } = walkChain(page, '2');
  assert.ok(chain.length <= 2);
});

test('maxHops bounds runaway chains', () => {
  const page = Array.from({ length: 40 }, (_, i) => m(String(i), String(i - 1)));
  assert.equal(walkChain(page, '39', { maxHops: 5 }).chain.length, 5);
});

test('renders one line per message with author and text', () => {
  const out = renderChain([m('1', null, 'doug', 'hey\n look into   this')]);
  assert.equal(out, '[1] doug: hey look into this');
});
