'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeSyncGroup } = require('./support');

test('boot, keep_virtual: devices that differ are set to the saved group state', async () => {
  const on = await makeSyncGroup({ policy: 'keep_virtual', virtual: true, state: { a: false, b: false } });
  assert.deepStrictEqual(on.writes, [['a', true], ['b', true]]);
  assert.strictEqual(on.caps.onoff, true);

  const off = await makeSyncGroup({ policy: 'keep_virtual', virtual: false, state: { a: true, b: false } });
  assert.deepStrictEqual(off.writes, [['a', false]]);
  assert.strictEqual(off.caps.onoff, false);
});

test('boot, any_on_wins: the group adopts an ON device and the rest follow', async () => {
  const group = await makeSyncGroup({ policy: 'any_on_wins', virtual: false, state: { a: true, b: false } });
  assert.strictEqual(group.caps.onoff, true);
  assert.deepStrictEqual(group.writes, [['b', true]]);
});

test('boot: an unset or invalid policy falls back to keep_virtual', async () => {
  for (const policy of [undefined, 'garbage']) {
    const group = await makeSyncGroup({ policy, virtual: true, state: { a: false, b: false } });
    assert.deepStrictEqual(group.writes, [['a', true], ['b', true]], String(policy));
  }
});

test('a just-paired group adopts its devices even if onoff already reads false', async () => {
  const group = await makeSyncGroup({
    policy: 'keep_virtual',
    virtual: false,
    state: { a: true, b: true },
    store: { pendingInitialSync: true },
  });
  assert.strictEqual(group.caps.onoff, true);
  assert.deepStrictEqual(group.writes, []);
  assert.strictEqual(group.storeData.pendingInitialSync, false);
});

test('a group with no saved state adopts its devices', async () => {
  const group = await makeSyncGroup({ policy: 'keep_virtual', virtual: null, state: { a: true, b: false } });
  assert.strictEqual(group.caps.onoff, true);
  assert.deepStrictEqual(group.writes, [['b', true]]);
});

test('health-check re-subscribe never changes the group or its devices (failed OFF stays OFF)', async () => {
  const state = { a: false, b: false };
  const group = await makeSyncGroup({ policy: 'keep_virtual', virtual: false, state });

  state.a = true; // an OFF write timed out: the device is still ON
  await group.device.reloadConfiguration();

  assert.strictEqual(group.caps.onoff, false);
  assert.deepStrictEqual(group.writes, []);
});

test('Repair re-subscribe aligns devices to the saved group state', async () => {
  const state = { a: false, b: false };
  const group = await makeSyncGroup({ policy: 'any_on_wins', virtual: false, state });

  state.a = true;
  await group.device.reloadConfiguration({ align: true });

  assert.strictEqual(group.caps.onoff, false);
  assert.deepStrictEqual(group.writes, [['a', false]]);
});
