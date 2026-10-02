'use strict';

const Module = require('module');

// The `homey` module only exists inside the Homey runtime; stub just enough of it.
class FakeDevice {
  getName() { return 'Group'; }
  getSetting(key) { return this.settings ? this.settings[key] : undefined; }
  log() {}
}
class FakeDriver {
  log() {}
  error() {}
}
class FakeApp {
  log() {}
  error() {}
}
const load = Module._load;

// Requires a module with `require('homey')` resolved to the stubs above.
function requireWithHomey(modulePath) {
  Module._load = function (request, ...rest) {
    return request === 'homey' ? { Device: FakeDevice, Driver: FakeDriver, App: FakeApp } : load.call(this, request, ...rest);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = load;
  }
}

const LinkedGroupDevice = requireWithHomey('../lib/LinkedGroupDevice');

// Timers are unref'd so a pending verify/health timer never keeps the test run alive.
const unrefTimeout = (fn, ms) => setTimeout(fn, ms).unref();
const unrefInterval = (fn, ms) => setInterval(fn, ms).unref();

function makeDevice({ settings } = {}) {
  const device = new LinkedGroupDevice();
  const reports = [];
  device.settings = settings;
  device.homey = {
    setTimeout: unrefTimeout,
    clearTimeout,
    setInterval: unrefInterval,
    clearInterval,
    __: key => key,
    app: { addSyncReport: report => reports.push(report) },
  };
  device._initGroupState();
  return { device, reports };
}

// A Linked Switch group over fake devices. `state` holds each device's current onoff value
// (mutate it to simulate a device changing); `writes` records every write sent to a device.
async function makeSyncGroup({ policy, virtual = null, state, store = {} }) {
  const SwitchSyncDevice = require('../drivers/switch-sync/device');
  const writes = [];
  const storeData = { deviceIds: Object.keys(state), ...store };
  const caps = { onoff: virtual };

  const api = { devices: { getDevice: async ({ id }) => ({
    id,
    name: id,
    available: true,
    makeCapabilityInstance: () => ({ get value() { return state[id]; }, destroy() {} }),
    setCapabilityValue: async ({ value }) => { writes.push([id, value]); },
  }) } };

  const device = new SwitchSyncDevice();
  const { device: base } = makeDevice();
  Object.assign(device, {
    homey: {
      ...base.homey,
      settings: { get: key => (key === 'boot_sync_policy' ? policy : undefined) },
      flow: { getDeviceTriggerCard: () => ({}) },
      app: { ...base.homey.app, getHomeyAPI: async () => api, _isSettingEnabled: (v, d) => (v == null ? d : Boolean(v)) },
    },
    getStoreValue: key => storeData[key],
    setStoreValue: async (key, value) => { storeData[key] = value; },
    getCapabilityValue: key => (caps[key] === undefined ? null : caps[key]),
    setCapabilityValue: async (key, value) => { caps[key] = value; },
    hasCapability: () => false,
    getCapabilities: () => [],
    addCapability: async () => {},
    removeCapability: async () => {},
    setCapabilityOptions: async () => {},
    setSettings: async () => {},
    setAvailable: async () => {},
    setUnavailable: async () => {},
    registerCapabilityListener: () => {},
    error: () => {},
  });
  await device.onInit();
  device._disposeGroupState();
  return { device, writes, caps, storeData };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { makeDevice, makeSyncGroup, requireWithHomey, wait };
