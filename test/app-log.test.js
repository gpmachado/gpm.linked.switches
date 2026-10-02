'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { requireWithHomey } = require('./support');

const SwitchSyncApp = requireWithHomey('../app');
const app = new SwitchSyncApp();

test('an unknown state is logged as ? instead of OFF', () => {
  const writeError = app._formatSyncReport({
    group: 'G', trigger: 'Slave command', value: true, hasError: true,
    devices: [{ name: 'Lamp', synced: false, expected: true, actual: null, errorMessage: 'Timeout' }],
  });
  assert.match(writeError, /Lamp \(ON expected, \? actual; Timeout\)/);

  const removed = app._formatSyncReport({
    group: 'G', trigger: 'Health Check', value: null, hasError: true,
    devices: [{ name: 'Gone', synced: false, removed: true }],
  });
  assert.match(removed, /-> \?; Gone \(\? expected, \? actual\)/);
});

test('known states are still logged as ON/OFF', () => {
  const line = app._formatSyncReport({
    group: 'G', trigger: 'Lamp', value: false, hasError: true,
    devices: [{ name: 'Lamp', synced: false, expected: false, actual: true }],
  });
  assert.match(line, /-> OFF; Lamp \(OFF expected, ON actual\)/);
});
