'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeDevice, wait } = require('./support');

// Polls instead of sleeping a fixed time, so a slow machine only makes the test slower.
async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('condition not met in time');
    await wait(10);
  }
}

test('_suppressMs falls back to 2000 and honours the group setting', () => {
  assert.strictEqual(makeDevice().device._suppressMs(), 2000);
  assert.strictEqual(makeDevice({ settings: { suppress_ms: 3500 } }).device._suppressMs(), 3500);
});

test('_suppressDevice ignores only the matching value, until the window ends', async () => {
  const { device } = makeDevice();
  device._suppressDevice('a', true, 50);
  assert.strictEqual(device._isSuppressed('a', true), true);
  assert.strictEqual(device._isSuppressed('a', false), false);
  assert.strictEqual(device._isSuppressed('b', true), false);
  await waitFor(() => !device._isSuppressed('a', true));
});

test('_suppressDevice restarts the window and replaces the value', async () => {
  const { device } = makeDevice();
  device._suppressDevice('a', true, 50);
  device._suppressDevice('a', false, 600);
  await wait(200); // past the first window: its timer must not have cleared the new entry
  assert.strictEqual(device._isSuppressed('a', false), true);
  assert.strictEqual(device._isSuppressed('a', true), false);
  await waitFor(() => !device._isSuppressed('a', false));
});

test('an old timer does not end a newer window after the map was cleared', async () => {
  const { device } = makeDevice();
  device._suppressDevice('a', true, 50);
  device._suppress.clear(); // what Switch Master does on every re-subscribe
  device._suppressDevice('a', false, 600);
  await wait(200); // the first timer has fired by now
  assert.strictEqual(device._isSuppressed('a', false), true);
});

test('_addSyncReport fills timestamp, group and Health Check trigger, and lets callers override', () => {
  const { device, reports } = makeDevice();
  device._addSyncReport({ value: null, hasError: true });
  device._addSyncReport({ trigger: 'Master command', value: true });

  assert.strictEqual(reports[0].group, 'Group');
  assert.strictEqual(reports[0].trigger, 'sync.health_check');
  assert.ok(!Number.isNaN(Date.parse(reports[0].timestamp)));
  assert.strictEqual(reports[0].hasError, true);
  assert.strictEqual(reports[1].trigger, 'Master command');
});
