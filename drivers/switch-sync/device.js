'use strict';

const { Device } = require('homey');

// How long after a propagation to verify that devices actually changed state
const VERIFY_DELAY_EXTRA_MS = 1000;

// Periodic health check interval
const HEALTH_INTERVAL_MS = 30000;

// Discard expected-state entries older than this (stale after user changes things)
const EXPECTED_STATE_TTL_MS = 5 * 60 * 1000;

class SwitchSyncDevice extends Device {

  async onInit() {
    this.log(`[${this.getName()}] Initialized`);

    // deviceId → { device, onoffInstance }
    this._listeners   = new Map();
    this._deviceNames = new Map();

    // Echo suppression: deviceId → { value, timer }
    this._suppress = new Map();

    // Devices offline during propagation: deviceId → targetValue
    // Resolved when device reconnects via capability callback
    this._pendingOffline = new Map();

    // Health monitor: deviceId → { value, timestamp, verified }
    this._expectedStates = new Map();

    // Devices already notified as desynced — avoid notification spam
    this._notifiedDesyncs = new Set();

    // Boot sync guard
    this._isBootSync = false;

    // Same-tick dedup
    this._lastPropagatedValue = null;

    // Single verify timer (reset on each propagation, fires once after settle)
    this._verifyTimer = null;

    this.registerCapabilityListener('onoff', this._onOwnOnOff.bind(this));

    await this._subscribeToDevices();

    this._healthInterval = this.homey.setInterval(
      () => this._verifyGroupHealth().catch(err => this.error(`[${this.getName()}] Health check error: ${err.message}`)),
      HEALTH_INTERVAL_MS,
    );
  }

  async reloadConfiguration() {
    this.log(`[${this.getName()}] Reloading configuration...`);
    await this._subscribeToDevices();
  }

  async _api() {
    return this.homey.app.getHomeyAPI();
  }

  // ─── Subscribe ────────────────────────────────────────────────────────────

  async _subscribeToDevices() {
    for (const { onoffInstance } of this._listeners.values()) {
      try { onoffInstance.destroy(); } catch (_) {}
    }
    this._listeners.clear();
    this._deviceNames.clear();
    this._pendingOffline.clear();
    this._expectedStates.clear();
    this._notifiedDesyncs.clear();
    this._lastPropagatedValue = null;

    if (this._verifyTimer) {
      this.homey.clearTimeout(this._verifyTimer);
      this._verifyTimer = null;
    }

    const deviceIds = this.getStoreValue('deviceIds') || [];
    const api = await this._api();

    for (const deviceId of deviceIds) {
      try {
        const device = await api.devices.getDevice({ id: deviceId });
        const name = device.name;
        this._deviceNames.set(deviceId, name);

        const onoffInstance = device.makeCapabilityInstance('onoff', value => {
          this._onLinkedDeviceChanged(deviceId, name, value)
            .catch(err => this.error(`[${this.getName()}] Error handling change from "${name}": ${err.message}`));
        });

        this._listeners.set(deviceId, { device, onoffInstance });
        this.log(`[${this.getName()}] Subscribed to "${name}"`);
      } catch (err) {
        this.error(`[${this.getName()}] Could not subscribe "${deviceId}": ${err.message}`);
      }
    }

    await this._syncSubCapabilities(deviceIds);

    try {
      const namesStr = Array.from(this._deviceNames.values()).join('\n') || 'None';
      await this.setSettings({ linked_devices_info: namesStr });
    } catch (err) {
      this.error(`Failed to update settings: ${err.message}`);
    }

    this._isBootSync = true;
    try {
      let isAnyOn = false;
      for (const { onoffInstance } of this._listeners.values()) {
        if (onoffInstance.value === true) { isAnyOn = true; break; }
      }
      const virtualCurrent = this.getCapabilityValue('onoff');
      if (virtualCurrent !== isAnyOn) {
        if (this.getSetting('debug')) this.log(`[${this.getName()}] Boot sync: → ${isAnyOn}`);
        await this.setCapabilityValue('onoff', isAnyOn).catch(this.error);
      }
    } catch (err) {
      this.error(`[${this.getName()}] Boot sync error:`, err);
    } finally {
      this._isBootSync = false;
    }

    // Align diverging devices to the virtual state without waiting for user action
    const targetValue = this.getCapabilityValue('onoff');
    const hasDiverging = [...this._listeners.values()].some(({ onoffInstance }) => onoffInstance.value !== targetValue);
    if (hasDiverging) {
      this.log(`[${this.getName()}] Boot align: propagating ${targetValue ? 'ON' : 'OFF'} to diverging devices`);
      await this._propagate(targetValue, null);
    }
  }

  // ─── Sub-capabilities (device names on card) ──────────────────────────────

  async _syncSubCapabilities(deviceIds) {
    const needed = new Set(deviceIds.map((_, i) => `linked_switch.${i + 1}`));

    for (const cap of this.getCapabilities()) {
      const isOldOnoff     = cap !== 'onoff' && cap.startsWith('onoff.');
      const isStale        = cap.startsWith('linked_switch.') && !needed.has(cap);
      const isOldDevStatus = cap.startsWith('device_status.');
      if (isOldOnoff || isStale || isOldDevStatus) {
        await this.removeCapability(cap).catch(() => {});
      }
    }

    for (let i = 0; i < deviceIds.length; i++) {
      const capId = `linked_switch.${i + 1}`;
      const name  = this._deviceNames.get(deviceIds[i]) || deviceIds[i];
      try {
        if (!this.hasCapability(capId)) await this.addCapability(capId);
        await this.setCapabilityOptions(capId, { title: { en: 'Switch' } });
        await this.setCapabilityValue(capId, name);
      } catch (err) {
        this.error(`[${this.getName()}] Could not set up ${capId}: ${err.message}`);
      }
    }
  }

  // ─── Incoming: linked device changed (physical or remote) ─────────────────

  async _onLinkedDeviceChanged(sourceId, sourceName, value) {
    const isDebug = this.getSetting('debug');

    // Device was offline during propagation and just reconnected
    const pending = this._pendingOffline.get(sourceId);
    if (pending !== undefined) {
      if (pending === value) {
        if (isDebug) this.log(`[${this.getName()}] "${sourceName}" back online already in sync (${value})`);
        this._pendingOffline.delete(sourceId);
      } else {
        if (isDebug) this.log(`[${this.getName()}] "${sourceName}" back online, syncing to ${pending}`);
        this._pendingOffline.delete(sourceId);
        const entry = this._listeners.get(sourceId);
        if (entry) {
          const suppressMs = this.getSetting('suppress_ms') || 2000;
          await this._setDeviceValue(entry.device, sourceId, pending, suppressMs, isDebug);
        }
        return;
      }
    }

    // Echo suppression — callback caused by our own command
    const suppressed = this._suppress.get(sourceId);
    if (suppressed && suppressed.value === value) {
      if (isDebug) this.log(`[${this.getName()}] Echo suppressed from "${sourceName}" (${value})`);

      // This echo IS the confirmation — mark expected state as verified
      const exp = this._expectedStates.get(sourceId);
      if (exp && exp.value === value) {
        exp.verified = true;
        this._notifiedDesyncs.delete(sourceId); // Clear any previous desync alert
      }
      return;
    }

    if (isDebug) this.log(`[${this.getName()}] "${sourceName}" → ${value ? 'ON' : 'OFF'}`);

    // Mark as verified if it matches what we expected (protocol confirmed via state report)
    const exp = this._expectedStates.get(sourceId);
    if (exp && exp.value === value) {
      exp.verified = true;
      this._notifiedDesyncs.delete(sourceId);
    }

    const current = this.getCapabilityValue('onoff');
    if (current !== value) await this.setCapabilityValue('onoff', value).catch(this.error);

    await this._propagate(value, sourceId);
  }

  // ─── Incoming: virtual device toggled via UI / Flow ───────────────────────

  async _onOwnOnOff(value) {
    if (this._isBootSync) return;

    this.log(`[${this.getName()}] Binding set to ${value ? 'ON' : 'OFF'} via UI/Flow`);
    await this._propagate(value, null);
  }

  // ─── Propagate to all linked devices ─────────────────────────────────────

  async _propagate(value, sourceId) {
    // Same-tick dedup: drop if identical value already in flight this tick
    if (this._lastPropagatedValue === value) {
      if (this.getSetting('debug')) this.log(`[${this.getName()}] Skipping duplicate propagation ${value}`);
      return;
    }
    this._lastPropagatedValue = value;
    setImmediate(() => { this._lastPropagatedValue = null; });

    const deviceIds  = this.getStoreValue('deviceIds') || [];
    const suppressMs = this.getSetting('suppress_ms') || 2000;
    const isDebug    = this.getSetting('debug');

    const promises = deviceIds.map(async (deviceId) => {
      if (deviceId === sourceId) return;

      const entry = this._listeners.get(deviceId);
      if (!entry) return;

      const { device, onoffInstance } = entry;

      if (onoffInstance.value === value) {
        if (isDebug) this.log(`[${this.getName()}] "${device.name}" already ${value ? 'ON' : 'OFF'} — skipped`);
        // Already correct — mark verified immediately
        this._expectedStates.set(deviceId, { value, timestamp: Date.now(), verified: true });
        return;
      }

      if (!device.available) {
        if (isDebug) this.log(`[${this.getName()}] "${device.name}" offline — will sync when it comes back`);
        this._pendingOffline.set(deviceId, value);
        this._expectedStates.set(deviceId, { value, timestamp: Date.now(), verified: false, offline: true });
        return;
      }

      // Register expectation — echo callback will mark verified
      this._expectedStates.set(deviceId, { value, timestamp: Date.now(), verified: false });

      await this._setDeviceValue(device, deviceId, value, suppressMs, isDebug);
    });

    await Promise.allSettled(promises);

    // Schedule a single post-propagation verify, reset if another propagation comes first
    if (this._verifyTimer) this.homey.clearTimeout(this._verifyTimer);
    this._verifyTimer = this.homey.setTimeout(() => {
      this._verifyTimer = null;
      this._verifyRecentPropagation().catch(err =>
        this.error(`[${this.getName()}] Verify error: ${err.message}`)
      );
    }, suppressMs + VERIFY_DELAY_EXTRA_MS);
  }

  // ─── Set a single device value with echo suppression ─────────────────────

  async _setDeviceValue(device, deviceId, value, suppressMs, isDebug) {
    try {
      const existing = this._suppress.get(deviceId);
      if (existing) this.homey.clearTimeout(existing.timer);
      const timer = this.homey.setTimeout(() => this._suppress.delete(deviceId), suppressMs);
      this._suppress.set(deviceId, { value, timer });

      if (isDebug) this.log(`[${this.getName()}] → ${value ? 'ON' : 'OFF'} to "${device.name}"`);
      await device.setCapabilityValue({ capabilityId: 'onoff', value });
    } catch (err) {
      this.error(`[${this.getName()}] Failed to set "${device.name}": ${err.message}`);
    }
  }

  // ─── Post-propagation verify — detect silent failures ────────────────────

  async _verifyRecentPropagation() {
    const now = Date.now();
    const desynced = [];

    for (const [deviceId, exp] of this._expectedStates) {
      // Discard stale entries
      if (now - exp.timestamp > EXPECTED_STATE_TTL_MS) {
        this._expectedStates.delete(deviceId);
        continue;
      }

      if (exp.verified || exp.offline) continue;

      const entry = this._listeners.get(deviceId);
      if (!entry) continue;

      const { device, onoffInstance } = entry;

      if (onoffInstance.value === exp.value) {
        exp.verified = true;
        this._notifiedDesyncs.delete(deviceId);
      } else {
        desynced.push({ deviceId, name: device.name, expected: exp.value, actual: onoffInstance.value });
      }
    }

    if (desynced.length > 0) {
      this.error(`[${this.getName()}] Post-propagation desync: ${desynced.map(d => d.name).join(', ')}`);
      await this._notifyDesynced(desynced);
    }
  }

  // ─── Periodic health check — detect accumulated drift ────────────────────

  async _verifyGroupHealth() {
    const virtualValue = this.getCapabilityValue('onoff');
    const desynced = [];

    for (const [deviceId, { device, onoffInstance }] of this._listeners) {
      if (!device.available) continue; // Offline devices are tracked via _pendingOffline
      if (onoffInstance.value !== virtualValue) {
        desynced.push({ deviceId, name: device.name, expected: virtualValue, actual: onoffInstance.value });
      }
    }

    // Clear resolved desyncs from notification history
    for (const id of this._notifiedDesyncs) {
      if (!desynced.find(d => d.deviceId === id)) {
        this._notifiedDesyncs.delete(id);
        this.log(`[${this.getName()}] Health: ${this._deviceNames.get(id) || id} back in sync`);
      }
    }

    if (desynced.length === 0) return;

    this.error(`[${this.getName()}] Health check: ${desynced.length} device(s) desynced — ${desynced.map(d => `${d.name}(${d.actual ? 'ON' : 'OFF'})`).join(', ')}`);
    await this._notifyDesynced(desynced);
  }

  // ─── Notify desync — once per device until resolved ──────────────────────

  async _notifyDesynced(desynced) {
    const newDesyncs = desynced.filter(d => !this._notifiedDesyncs.has(d.deviceId));
    if (newDesyncs.length === 0) return;

    newDesyncs.forEach(d => this._notifiedDesyncs.add(d.deviceId));

    // Always write to the global log
    for (const d of newDesyncs) {
      this.homey.app.addDesyncLog({
        timestamp: new Date().toISOString(),
        group:     this.getName(),
        device:    d.name,
        expected:  d.expected,
        actual:    d.actual,
      });
    }

    // Push notification — only if setting is enabled
    if (!this.getSetting('notify_on_desync')) return;

    const names = newDesyncs.map(d =>
      `${d.name} (is ${d.actual ? 'ON' : 'OFF'}, expected ${d.expected ? 'ON' : 'OFF'})`
    ).join(', ');

    try {
      await this.homey.notifications.createNotification({
        excerpt: `Switch Sync "${this.getName()}": ${names}`,
      });
    } catch (err) {
      this.error(`[${this.getName()}] Could not send notification: ${err.message}`);
    }
  }

  // ─── Settings changed ─────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    this.log(`[${this.getName()}] Settings changed: ${changedKeys.join(', ')}`);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  async onDeleted() {
    this.log(`[${this.getName()}] Deleted — cleaning up`);

    if (this._healthInterval) this.homey.clearInterval(this._healthInterval);
    if (this._verifyTimer)    this.homey.clearTimeout(this._verifyTimer);

    for (const { onoffInstance } of this._listeners.values()) {
      try { onoffInstance.destroy(); } catch (_) {}
    }
    this._listeners.clear();

    for (const { timer } of this._suppress.values()) this.homey.clearTimeout(timer);
    this._suppress.clear();

    this._pendingOffline.clear();
    this._expectedStates.clear();
    this._notifiedDesyncs.clear();
  }

}

module.exports = SwitchSyncDevice;
