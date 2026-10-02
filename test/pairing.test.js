'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { requireWithHomey } = require('./support');

const SwitchSyncDriver = requireWithHomey('../drivers/switch-sync/driver');

function makeDriver() {
  const driver = new SwitchSyncDriver();
  driver.homey = {
    __: key => key,
    drivers: { getDriver() { throw new Error('no drivers in tests'); } },
  };
  return driver;
}

async function handlersFor(driver, method, ...args) {
  const handlers = {};
  await driver[method]({ setHandler: (name, fn) => { handlers[name] = fn; } }, ...args);
  return handlers;
}

test('pairing rejects a list that is below two devices once duplicates are removed', async () => {
  const handlers = await handlersFor(makeDriver(), 'onPair');
  await assert.rejects(handlers.configure_binding({ name: 'G', deviceIds: ['a', 'a'] }), /pair\.err_min2/);
});

test('pairing stores the de-duplicated device list it validated', async () => {
  const handlers = await handlersFor(makeDriver(), 'onPair');
  await handlers.configure_binding({ name: 'G', deviceIds: ['a', 'b', 'a'] });
  const [created] = await handlers.list_devices();
  assert.deepStrictEqual(created.store.deviceIds, ['a', 'b']);
});

function makeGroup() {
  const store = { deviceIds: ['a', 'b'] };
  let reloaded = null;
  return {
    store,
    reloaded: () => reloaded,
    device: {
      getId: () => 'group',
      getStoreValue: key => store[key],
      setStoreValue: async (key, value) => { store[key] = value; },
      reloadConfiguration: async options => { reloaded = options; },
    },
  };
}

test('repair rejects [A, A]: fewer than two unique devices', async () => {
  const group = makeGroup();
  const handlers = await handlersFor(makeDriver(), 'onRepair', group.device);
  await assert.rejects(handlers.save_config({ deviceIds: ['a', 'a'] }), /repair\.err_min2/);
  assert.deepStrictEqual(group.store.deviceIds, ['a', 'b']);
  assert.strictEqual(group.reloaded(), null);
});

test('repair saves the de-duplicated list and re-subscribes with alignment', async () => {
  const group = makeGroup();
  const handlers = await handlersFor(makeDriver(), 'onRepair', group.device);
  await handlers.save_config({ deviceIds: ['a', 'c', 'a'] });
  assert.deepStrictEqual(group.store.deviceIds, ['a', 'c']);
  assert.deepStrictEqual(group.reloaded(), { align: true });
});
