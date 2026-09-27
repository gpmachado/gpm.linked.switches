'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DEBUG, BOOT_SYNC_POLICIES, DEFAULT_BOOT_SYNC_POLICY } = require('../lib/constants');

test('DEBUG is off, so a release cannot ship verbose logging', () => {
  assert.strictEqual(DEBUG, false);
});

test('the default boot policy is one of the valid policies', () => {
  assert.ok(BOOT_SYNC_POLICIES.includes(DEFAULT_BOOT_SYNC_POLICY));
});
