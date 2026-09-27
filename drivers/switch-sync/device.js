'use strict';

const LinkedGroupDevice = require('../../lib/LinkedGroupDevice');
const {
  SLAVE_STAGGER_MS,
  BOOT_SYNC_POLICIES,
  DEFAULT_BOOT_SYNC_POLICY,
} = require('../../lib/constants');

// Extra time after suppressMs before verifying device states.
// Covers: Nova retries (~1.5s) + Tuya backoff retries (~2.2s) + Zigbee routing latency (~1s each way)
const VERIFY_DELAY_EXTRA_MS = 5000;

// Discard expected-state entries older than this (stale after user changes things)
const EXPECTED_STATE_TTL_MS = 5 * 60 * 1000;

// Discard pending-offline entries older than this (device unlikely to return)
const PENDING_OFFLINE_TTL_MS = 60 * 60 * 1000; // 1 hour

class SwitchSyncDevice extends LinkedGroupDevice {

  async onInit() {
    this._debug('init', { message: 'device initialized' });

    this._initGroupState();

    // deviceId → { device, onoffInstance }
    this._listeners   = new Map();
    this._deviceNames = new Map();

    // Last time a listener reported a value for a device
    this._lastListenerUpdate = new Map();

    // Devices offline during propagation: deviceId → targetValue
    this._pendingOffline = new Map();

    // Health monitor: deviceId → { value, timestamp, verified, syncedAt? }
    this._expectedStates = new Map();

    // Devices already notified as desynced — avoid notification spam
    this._notifiedDesyncs = new Set();

    // Auto-heal cooldowns: deviceId → timestamp of last heal attempt
    this._healCooldowns = new Map();

    // Active health-check desyncs: deviceId → { expected, actual, startedAt, lastSeenAt, repeatCount }
    // Dedup the health-check log so a stuck device logs once (opened) and once (resolved),
    // not one identical entry every cycle.
    this._activeDesyncs = new Map();

    // Clickable per-device controls.
    this._registeredButtonCaps = new Set();

    // Primary device: controlled first, others follow with stagger
    this._primaryDeviceId = this.getStoreValue('primaryDeviceId') || null;

    // Flow trigger fired when a device fails to reach the expected state
    this._desyncTriggerCard = this.homey.flow.getDeviceTriggerCard('group_desynced');

    // Boot sync guard
    this._isBootSync = false;

    // The first subscribe after init follows the global boot sync policy;
    // later re-subscribes only re-attach listeners (see _resolveSyncPolicy).
    this._bootPending = true;

    // Same-tick dedup
    this._lastPropagatedValue = null;

    // Context for the current propagation batch (used by verify to build report)
    this._pendingReportContext = null;

    // Single verify timer (reset on each propagation, fires once after settle)
    this._verifyTimer = null;

    this.registerCapabilityListener('onoff', this._onOwnOnOff.bind(this));

    await this._subscribeToDevices();

    // Boot health check, then a periodic safety net (also triggers on-demand via verify / force-resync)
    this._startHealthMonitor();
  }

  // `align`: also align the devices to the group state (Repair). The health check
  // leaves it off: it must never change devices or the group on its own.
  async reloadConfiguration({ align = false } = {}) {
    this._debug('reloading configuration');
    await this._subscribeToDevices(align);
  }

  // ─── Subscribe ────────────────────────────────────────────────────────────

  async _subscribeToDevices(align = false) {
    return this._enqueue(() => this._subscribeToDevicesNow(align));
  }

  async _subscribeToDevicesNow(align = false) {
    for (const { onoffInstance } of this._listeners.values()) {
      try { onoffInstance.destroy(); } catch (_) {}
    }
    this._listeners.clear();
    const prevNames = new Map(this._deviceNames);
    this._deviceNames.clear();
    this._pendingOffline.clear();
    this._expectedStates.clear();
    this._notifiedDesyncs.clear();
    this._activeDesyncs.clear();
    this._lastPropagatedValue = null;
    this._pendingReportContext = null;

    if (this._verifyTimer) {
      this.homey.clearTimeout(this._verifyTimer);
      this._verifyTimer = null;
    }

    let deviceIds = this.getStoreValue('deviceIds') || [];
    const api = await this._api();
    let missingCount = 0;

    // Last-known name per device, kept even after it goes missing — lets Repair
    // show what a dead ID used to be, instead of it just silently vanishing.
    const persistedNames = this.getStoreValue('deviceNames') || {};

    for (const deviceId of deviceIds) {
      try {
        const device = await api.devices.getDevice({ id: deviceId });
        const name = device.name;
        this._deviceNames.set(deviceId, name);
        persistedNames[deviceId] = name;

        const onoffInstance = device.makeCapabilityInstance('onoff', value => {
          this._lastListenerUpdate.set(deviceId, Date.now());
          this._debouncedCallback(deviceId, value, debouncedValue => {
            this._updateButtonValue(deviceId);
            this._updateSubCapStatus(deviceId);
            this._onLinkedDeviceChanged(deviceId, name, debouncedValue)
              .catch(err => this.error(`[${this.getName()}] Error handling change from "${name}": ${err.message}`));
          });
        });

        this._listeners.set(deviceId, { device, onoffInstance });
        this._debug(`subscribed "${name}"`);
      } catch (err) {
        this.error(`[${this.getName()}] Could not subscribe "${deviceId}": ${err.message}`);
        missingCount++;
      }
    }

    // Auto-remove ghost devices that persistently fail subscription.
    const ghosts = [];
    const now = Date.now();
    for (const deviceId of deviceIds) {
      if (!this._listeners.has(deviceId)) {
        if (this._confirmSubscribeFailure(deviceId, now)) ghosts.push(deviceId);
      } else {
        this._subscribeFailures.delete(deviceId);
      }
    }
    for (const deviceId of ghosts) {
      await this._removeGhostDevice(deviceId, prevNames.get(deviceId));
    }
    if (ghosts.length > 0) {
      deviceIds = this.getStoreValue('deviceIds') || [];
      missingCount -= ghosts.length;
    }

    // Prune names for devices no longer part of this group, then persist.
    const keptIds = new Set(deviceIds);
    for (const id of Object.keys(persistedNames)) {
      if (!keptIds.has(id)) delete persistedNames[id];
    }
    await this.setStoreValue('deviceNames', persistedNames).catch(() => {});

    if (missingCount > 0) {
      await this.setUnavailable(`${missingCount} ${this.homey.__('error.missing_devices')}`).catch(() => {});
    } else if (this._listeners.size < 2) {
      await this.setUnavailable(this.homey.__('error.min_devices')).catch(() => {});
    } else {
      await this.setAvailable().catch(() => {});
    }

    // Unconditional one-line summary — visible in diagnostic reports even with debug off.
    this.log(`[${this.getName()}] Ready: ${this._listeners.size}/${deviceIds.length} device(s) linked${missingCount > 0 ? `, ${missingCount} missing` : ''}`);

    await this._syncSubCapabilities(deviceIds);

    try {
      const namesStr = Array.from(this._deviceNames.values()).join('\n');
      await this.setSettings({ linked_devices_info: namesStr });
    } catch (err) {
      this.error(`Failed to update settings: ${err.message}`);
    }

    const policy = this._resolveSyncPolicy(align);
    this._debug(`sync policy: ${policy}`);
    if (!policy) return; // plain re-subscribe: listeners re-attached, state untouched

    this._isBootSync = true;
    try {
      // keep_virtual leaves the group's saved state as is; any_on_wins adopts the devices' state.
      if (policy === 'any_on_wins') {
        let isAnyOn = false;
        for (const { onoffInstance } of this._listeners.values()) {
          if (onoffInstance.value === true) { isAnyOn = true; break; }
        }
        const virtualCurrent = this.getCapabilityValue('onoff');
        if (virtualCurrent !== isAnyOn) {
          this._debug(`boot sync -> ${isAnyOn ? 'ON' : 'OFF'}`);
          await this.setCapabilityValue('onoff', isAnyOn).catch(err => this.error(`[${this.getName()}] Boot sync setCapabilityValue error: ${err.message}`));
        }
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
      this._debug(`boot align: propagating ${targetValue ? 'ON' : 'OFF'} to diverging devices`);
      // Already inside the op queue (called from _subscribeToDevices) — run directly,
      // not through _propagate, to avoid enqueueing onto ourselves and deadlocking.
      await this._propagateNow(targetValue, null);
    }
  }

  // The first subscribe after init follows the global `boot_sync_policy`. A later
  // re-subscribe (health check) returns null: it only re-attaches listeners, because a failed
  // write leaves a device out of step and neither adopting that state nor rewriting devices
  // is safe. Repair (`align`) aligns devices to the group state. A just-paired group has no
  // saved state to keep, so it adopts its devices' state.
  _resolveSyncPolicy(align = false) {
    const isBoot = this._bootPending;
    this._bootPending = false;

    const isNewGroup = this.getStoreValue('pendingInitialSync') === true;
    if (isNewGroup) this.setStoreValue('pendingInitialSync', false).catch(() => {});

    if (isNewGroup || typeof this.getCapabilityValue('onoff') !== 'boolean') return 'any_on_wins';
    if (!isBoot) return align ? 'keep_virtual' : null;

    const policy = this.homey.settings.get('boot_sync_policy');
    return BOOT_SYNC_POLICIES.includes(policy) ? policy : DEFAULT_BOOT_SYNC_POLICY;
  }

  async _removeGhostDevice(deviceId, deviceName) {
    const deviceIds = (this.getStoreValue('deviceIds') || []).filter(id => id !== deviceId);
    await this.setStoreValue('deviceIds', deviceIds);
    const ghostName = deviceName || this._deviceNames.get(deviceId) || deviceId;
    const remaining = deviceIds.length;
    const degraded = remaining >= 2;
    this.error(`[${this.getName()}] Removed ghost device "${ghostName}" — no longer exists in Homey (${remaining} remaining${degraded ? ', group degraded' : ', group condemned'})`);
    this._addSyncReport({
      value:     null,
      devices:   [{ name: ghostName, synced: false, removed: true }],
      hasError:  true,
      important: true,
      note:      degraded
        ? this.homey.__('sync.device_removed_degraded').replace('{remaining}', remaining)
        : this.homey.__('sync.device_removed_condemned').replace('{remaining}', remaining),
    });
  }

  // ─── Sub-capabilities (device names on card) ──────────────────────────────

  async _syncSubCapabilities(deviceIds) {
    const showStatus = this._shouldShowDeviceStatus();
      const neededStatus = new Set(showStatus ? deviceIds.map((_, i) => `subdevice_switch.${i + 1}`) : []);
    const neededButtons = new Set(deviceIds.map((_, i) => this._buttonCapId(i)));

    for (const cap of this.getCapabilities()) {
      const isOldOnoff     = cap !== 'onoff' && cap.startsWith('onoff.');
      const isStaleStatus  = (cap.startsWith('subdevice_switch.') || cap.startsWith('linked_switch.')) && !neededStatus.has(cap);
      const isStaleButton  = cap.startsWith('linked_button.') && !neededButtons.has(cap);
      const isOldDevStatus = cap.startsWith('device_status.');
      if (isOldOnoff || isStaleStatus || isStaleButton || isOldDevStatus) {
        await this.removeCapability(cap).catch(() => {});
      }
    }

    for (let i = 0; i < deviceIds.length; i++) {
      await this._setupButtonCapability(i, deviceIds[i]);

      if (!showStatus) continue;

      const capId = `subdevice_switch.${i + 1}`;
      try {
        if (!this.hasCapability(capId)) await this.addCapability(capId);
      } catch (err) {
        this.error(`[${this.getName()}] Could not set up ${capId}: ${err.message}`);
      }
      await this._renderSubCapability(i, deviceIds[i]);
    }
  }

  async _refreshStatusCapabilities() {
    await this._syncSubCapabilities(this.getStoreValue('deviceIds') || []);
  }

  _buttonCapId(index) {
    return `linked_button.${index + 1}`;
  }

  async _setupButtonCapability(index, deviceId) {
    const capId = this._buttonCapId(index);
    const name = this._deviceNames.get(deviceId) || deviceId;

    try {
      if (!this.hasCapability(capId)) await this.addCapability(capId);
      await this.setCapabilityOptions(capId, { title: { en: name } });
      await this._setButtonCapValue(capId, this._getLinkedValue(deviceId));
      this._registerButtonCapability(capId);
    } catch (err) {
      this.error(`[${this.getName()}] Could not set up ${capId}: ${err.message}`);
    }
  }

  _registerButtonCapability(capId) {
    if (this._registeredButtonCaps.has(capId)) return;
    this._registeredButtonCaps.add(capId);

    this.registerCapabilityListener(capId, async (value) => {
      const deviceIds = this.getStoreValue('deviceIds') || [];
      const index = Number(capId.replace('linked_button.', '')) - 1;
      const deviceId = deviceIds[index];
      const entry = this._listeners.get(deviceId);
      if (!entry || !entry.device.available) return;

      this._debug(`linked button: "${entry.device.name}" -> ${value ? 'ON' : 'OFF'}`);
      await this._setButtonCapValue(capId, value).catch(() => {});
      await entry.device.setCapabilityValue({ capabilityId: 'onoff', value });
    });
  }

  _getLinkedValue(deviceId) {
    const entry = this._listeners.get(deviceId);
    return entry ? entry.onoffInstance.value : null;
  }

  async _setButtonCapValue(capId, value) {
    if (!this.hasCapability(capId)) return;
    if (typeof value !== 'boolean') return;
    if (this.getCapabilityValue(capId) === value) return;
    await this.setCapabilityValue(capId, value);
  }

  _updateButtonValue(deviceId) {
    const deviceIds = this.getStoreValue('deviceIds') || [];
    const index = deviceIds.indexOf(deviceId);
    if (index === -1) return;
    this._setButtonCapValue(this._buttonCapId(index), this._getLinkedValue(deviceId)).catch(() => {});
  }

  _shouldShowDeviceStatus() {
    return this._isAppToggleOn('show_device_status', true);
  }

  // Render one subdevice_switch.N — either live ON/OFF status (default), with a ⚠
  // marker when diverging from the group state, or just the device name.
  // Controlled by the global app setting `show_device_status`.
  async _renderSubCapability(index, deviceId) {
    const capId = `subdevice_switch.${index + 1}`;
    if (!this.hasCapability(capId)) return;
    const name = this._deviceNames.get(deviceId) || deviceId;
    try {
      if (this._shouldShowDeviceStatus()) {
        await this.setCapabilityOptions(capId, { title: { en: name } });
        await this.setCapabilityValue(capId, this._subCapStatus(deviceId));
      } else {
        // The sensor component always renders a title; keep it visually empty
        // when only the linked device name should be shown.
        await this.setCapabilityOptions(capId, { title: { en: '\u00A0' } });
        await this.setCapabilityValue(capId, name);
      }
    } catch (err) {
      this.error(`[${this.getName()}] Could not render ${capId}: ${err.message}`);
    }
  }

  async _renderAllSubCapabilities() {
    const deviceIds = this.getStoreValue('deviceIds') || [];
    for (let i = 0; i < deviceIds.length; i++) {
      await this._renderSubCapability(i, deviceIds[i]);
    }
  }

  _subCapStatus(deviceId) {
    const entry = this._listeners.get(deviceId);
    const v = entry ? entry.onoffInstance.value : null;
    if (v === null || v === undefined) return '—';
    const diverges = v !== this.getCapabilityValue('onoff');
    return this.homey.__(v ? 'sync.on' : 'sync.off') + (diverges ? ' ⚠' : '');
  }

  // Lightweight value-only refresh, used on every device state change
  _updateSubCapStatus(deviceId) {
    if (!this._shouldShowDeviceStatus()) return;
    const deviceIds = this.getStoreValue('deviceIds') || [];
    const i = deviceIds.indexOf(deviceId);
    if (i === -1) return;
    const capId = `subdevice_switch.${i + 1}`;
    if (!this.hasCapability(capId)) return;
    this.setCapabilityValue(capId, this._subCapStatus(deviceId)).catch(() => {});
  }

  // ─── Auto-heal: retry desynced devices directly (no _propagate) ─────────

  async _autoHeal(desynced) {
    if (!this.getSetting('auto_heal')) return;

    const now        = Date.now();
    const suppressMs = this._suppressMs();
    const COOLDOWN   = 20000;

    for (const { deviceId, name, expected } of desynced) {
      // Skip if a propagation is still in flight for this device
      const exp = this._expectedStates.get(deviceId);
      if (exp && !exp.verified) {
        this._debug(`auto-heal skipped "${name}" — propagation in flight`);
        continue;
      }

      // Cooldown: don't retry the same device within 20s
      const lastHeal = this._healCooldowns.get(deviceId) || 0;
      if (now - lastHeal < COOLDOWN) {
        this._debug(`auto-heal skipped "${name}" — cooldown`);
        continue;
      }

      const entry = this._listeners.get(deviceId);
      if (!entry || !entry.device.available) continue;

      this._healCooldowns.set(deviceId, now);
      this._debug(`auto-heal: "${name}" -> ${expected ? 'ON' : 'OFF'}`);
      await this._setDeviceValue(entry.device, deviceId, expected, suppressMs);
    }
  }

  // ─── Mark a previously-desynced device as back in sync ───────────────────

  _markSynced(deviceId) {
    if (!this._notifiedDesyncs.has(deviceId)) return;
    this._notifiedDesyncs.delete(deviceId);
    const name = this._deviceNames.get(deviceId) || deviceId;
    this._debug(`"${name}" back in sync`);
  }

  // ─── Incoming: linked device changed (physical or remote) ─────────────────

  async _onLinkedDeviceChanged(sourceId, sourceName, value) {

    // Device was offline during propagation and just reconnected
    const pendingEntry = this._pendingOffline.get(sourceId);
    if (pendingEntry !== undefined) {
      const { value: pendingValue } = pendingEntry;
      if (pendingValue === value) {
        this._debug(`"${sourceName}" back online already in sync (${value})`);
        this._pendingOffline.delete(sourceId);
      } else {
        this._debug(`"${sourceName}" back online, syncing to ${pendingValue}`);
        this._pendingOffline.delete(sourceId);
        const entry = this._listeners.get(sourceId);
        if (entry) {
          const suppressMs = this._suppressMs();
          await this._setDeviceValue(entry.device, sourceId, pendingValue, suppressMs);
        }
        return;
      }
    }

    // Echo suppression — callback caused by our own command
    if (this._isSuppressed(sourceId, value)) {
      this._debug(`echo suppressed from "${sourceName}" (${value})`);

      // Echo IS the confirmation — mark expected state as verified and record timing
      const exp = this._expectedStates.get(sourceId);
      if (exp && exp.value === value) {
        exp.verified = true;
        exp.syncedAt = Date.now() - exp.timestamp;
        this._markSynced(sourceId);
      }
      return;
    }

    this._debug(`"${sourceName}" -> ${value ? 'ON' : 'OFF'}`);

    // Mark as verified if it matches expected (late confirmation after suppress window)
    const exp = this._expectedStates.get(sourceId);
    if (exp && exp.value === value) {
      exp.verified = true;
      exp.syncedAt = Date.now() - exp.timestamp;
      this._markSynced(sourceId);
    }

    const current = this.getCapabilityValue('onoff');
    if (current !== value) await this.setCapabilityValue('onoff', value).catch(err => this.error(`[${this.getName()}] setCapabilityValue error: ${err.message}`));

    await this._propagate(value, sourceId);
  }

  // ─── Incoming: virtual device toggled via UI / Flow ───────────────────────

  async _onOwnOnOff(value) {
    if (this._isBootSync) return;

    this._debug(`binding set to ${value ? 'ON' : 'OFF'} via UI/Flow`);
    await this._propagate(value, null);
  }

  // ─── Propagate to all linked devices ─────────────────────────────────────

  async _propagate(value, sourceId) {
    // Same-tick dedup: drop if identical value already in flight this tick
    if (this._lastPropagatedValue === value) {
      this._debug('propagate skipped', { value, reason: 'duplicate' });
      return;
    }
    this._lastPropagatedValue = value;
    setImmediate(() => { this._lastPropagatedValue = null; });

    // Queued: a second propagate (e.g. a rapid second toggle) waits for this one
    // to fully finish before reading/mutating shared state — no interleaving.
    return this._enqueue(() => this._propagateNow(value, sourceId));
  }

  async _propagateNow(value, sourceId) {
    // Store context for the verify report
    const triggerName = sourceId
      ? (this._deviceNames.get(sourceId) || sourceId)
      : this.homey.__('sync.virtual_switch');
    this._pendingReportContext = { trigger: triggerName, value, startedAt: Date.now() };

    const deviceIds  = this.getStoreValue('deviceIds') || [];
    const primaryId  = this._primaryDeviceId;
    const suppressMs = this._suppressMs();

    // Order: primary first (if set and not the source), then the rest.
    const orderedIds = [...deviceIds];
    if (primaryId && primaryId !== sourceId) {
      const idx = orderedIds.indexOf(primaryId);
      if (idx > 0) {
        orderedIds.splice(idx, 1);
        orderedIds.unshift(primaryId);
      }
    }

    this._debug('propagate', { value, sourceId, primaryId, count: orderedIds.length });

    let index = 0;
    for (const deviceId of orderedIds) {
      if (deviceId === sourceId) continue;

      const entry = this._listeners.get(deviceId);
      if (!entry) continue;

      const { device, onoffInstance } = entry;

      if (onoffInstance.value === value) {
        this._debug('skip already', { device: device.name, value });
        this._expectedStates.set(deviceId, { value, timestamp: Date.now(), verified: true, syncedAt: 0 });
        continue;
      }

      if (!device.available) {
        this._debug('offline queued', { device: device.name, value });
        this._pendingOffline.set(deviceId, { value, timestamp: Date.now() });
        this._expectedStates.set(deviceId, { value, timestamp: Date.now(), verified: false, offline: true });
        continue;
      }

      // Stagger non-primary devices to avoid Zigbee congestion.
      const staggerMs = (deviceId === primaryId || index === 0) ? 0 : SLAVE_STAGGER_MS;
      index++;
      if (staggerMs > 0) {
        this._debug('stagger wait', { device: device.name, staggerMs });
        await new Promise(resolve => this.homey.setTimeout(resolve, staggerMs));
      }

      // Register expectation — echo callback will mark verified + set syncedAt
      this._expectedStates.set(deviceId, { value, timestamp: Date.now(), verified: false });

      const result = await this._setDeviceValue(device, deviceId, value, suppressMs);
      if (!result.ok) {
        const exp = this._expectedStates.get(deviceId);
        if (exp) exp.errorMessage = result.errorMessage;
      }
    }

    // Group state changed — refresh the ⚠ markers of devices that didn't echo
    for (const deviceId of deviceIds) this._updateSubCapStatus(deviceId);

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

  async _setDeviceValue(device, deviceId, value, suppressMs) {
    this._suppressDevice(deviceId, value, suppressMs);

    try {
      this._debug(`write -> ${value ? 'ON' : 'OFF'} to "${device.name}"`);
      await device.setCapabilityValue({ capabilityId: 'onoff', value });
      this._debug(`"${device.name}" write confirmed`);
      return { ok: true };
    } catch (err) {
      this.error(`[${this.getName()}] Failed to set "${device.name}": ${err.message}`);
      return { ok: false, errorMessage: err.message };
    }
  }

  // ─── Post-propagation verify — build sync report ─────────────────────────

  async _verifyRecentPropagation() {
    const now = Date.now();
    const ctx = this._pendingReportContext;

    const report = {
      timestamp:  new Date().toISOString(),
      group:      this.getName(),
      trigger:    ctx ? ctx.trigger : '?',
      value:      ctx ? ctx.value  : null,
      devices:    [],
      hasError:   false,
    };

    const desynced = [];

    for (const [deviceId, exp] of this._expectedStates) {
      if (now - exp.timestamp > EXPECTED_STATE_TTL_MS) {
        this._expectedStates.delete(deviceId);
        continue;
      }

      if (exp.offline) continue;

      const entry = this._listeners.get(deviceId);
      if (!entry) continue;

      const { device, onoffInstance } = entry;

      if (exp.verified) {
        report.devices.push({ name: device.name, synced: true, syncMs: exp.syncedAt || 0 });
      } else if (onoffInstance.value === exp.value) {
        // Confirmed by reading state directly (no echo received)
        exp.verified = true;
        exp.syncedAt = now - exp.timestamp;
        this._markSynced(deviceId);
        report.devices.push({ name: device.name, synced: true, syncMs: exp.syncedAt });
      } else {
        const entry = { name: device.name, synced: false, expected: exp.value, actual: onoffInstance.value };
        if (exp.errorMessage) entry.errorMessage = exp.errorMessage;
        report.devices.push(entry);
        desynced.push({ deviceId, name: device.name, expected: exp.value, actual: onoffInstance.value });
        report.hasError = true;
      }
    }

    if (report.devices.length > 0) {
      this.homey.app.addSyncReport(report);
    }

    if (desynced.length > 0) {
      this.error(`[${this.getName()}] Post-propagation desync: ${desynced.map(d => d.name).join(', ')}`);
      await this._notifyDesynced(desynced);
      await this._autoHeal(desynced);
      // On-demand health check — may attempt re-subscription for stale listeners
      this._verifyGroupHealth().catch(err => this.error(`[${this.getName()}] Health check error: ${err.message}`));
    }

    // Remove verified entries so the health check can detect any future drift freely.
    // Unverified entries (still desynced) are also removed — health check will catch them next cycle.
    // Offline entries stay so _pendingOffline can resolve them later.
    for (const [deviceId, exp] of this._expectedStates) {
      if (!exp.offline) this._expectedStates.delete(deviceId);
    }
  }

  // ─── Health check (periodic + on-demand) — detect accumulated drift ──────

  async _verifyGroupHealth() {
    // Expire stale pending-offline entries (device removed or unreachable too long)
    const now = Date.now();
    for (const [deviceId, { timestamp }] of this._pendingOffline) {
      if (now - timestamp > PENDING_OFFLINE_TTL_MS) {
      this._debug(`pending offline expired for "${this._deviceNames.get(deviceId) || deviceId}"`);
        this._pendingOffline.delete(deviceId);
        this._expectedStates.delete(deviceId);
      }
    }

    const deviceIds = this.getStoreValue('deviceIds') || [];

    // Defense: if a known group member has no active listener, re-subscribe.
    // This can happen when a device endpoint silently loses its capability instance.
    // Cooldown prevents excessive re-subscriptions on flaky networks.
    const canResubscribe = now - this._lastResubscribeAt > this._resubscribeCooldown;
    const missingListeners = deviceIds.filter(id => !this._listeners.has(id));
    if (missingListeners.length > 0 && canResubscribe) {
      this._lastResubscribeAt = now;
      this.error(`[${this.getName()}] Re-subscribing ${missingListeners.length} missing listener(s): ${missingListeners.map(id => this._deviceNames.get(id) || id).join(', ')}`);
      await this.reloadConfiguration();
      return;
    }

    const virtualValue = this.getCapabilityValue('onoff');
    const desynced = [];
    const desyncedIds = new Set();

    for (const [deviceId, { device, onoffInstance }] of this._listeners) {
      if (!device.available) continue;
      // Skip if device hasn't reported state yet (null/undefined → not a desync)
      const deviceValue = onoffInstance.value;
      if (deviceValue === null || deviceValue === undefined) continue;
      // Skip only if a propagation is still in flight (not yet verified)
      const exp = this._expectedStates.get(deviceId);
      if (exp && !exp.verified) continue;
      if (deviceValue !== virtualValue) {
        desynced.push({ deviceId, name: device.name, expected: virtualValue, actual: deviceValue });
        desyncedIds.add(deviceId);
      }
    }

    // Clear resolved desyncs from notification history
    for (const id of this._notifiedDesyncs) {
      if (!desyncedIds.has(id)) this._markSynced(id);
    }

    // Detect recoveries: tracked desyncs that are now available and back in sync
    const recovered = [];
    for (const [deviceId, info] of this._activeDesyncs) {
      if (desyncedIds.has(deviceId)) continue;
      const entry = this._listeners.get(deviceId);
      if (!entry || !entry.device.available) continue; // still offline → keep pending
      recovered.push({
        name:        this._deviceNames.get(deviceId) || deviceId,
        durationMs:  now - info.startedAt,
        repeatCount: info.repeatCount,
      });
      this._activeDesyncs.delete(deviceId);
    }

    if (recovered.length > 0) {
      this._debug(`health check recovered ${recovered.length} device(s): ${recovered.map(r => r.name).join(', ')}`);
      this._addSyncReport({
        value:     virtualValue,
        devices:   recovered.map(r => ({ name: r.name, synced: true, recovered: true, durationMs: r.durationMs, repeatCount: r.repeatCount })),
        hasError:  false,
        important: true, // keep in the log even in errors-only mode — it closes a prior failure
      });
    }

    if (desynced.length === 0) return;

    // Split current desyncs into newly-opened vs ongoing repeats — only log the new ones
    const newDesyncs = [];
    for (const d of desynced) {
      const info = this._activeDesyncs.get(d.deviceId);
      if (info) {
        info.repeatCount++;
        info.lastSeenAt = now;
        info.actual     = d.actual;
      } else {
        this._activeDesyncs.set(d.deviceId, { expected: d.expected, actual: d.actual, startedAt: now, lastSeenAt: now, repeatCount: 0 });
        newDesyncs.push(d);
      }
    }

    // Defense: on-demand re-subscription when a new desync is detected.
    // A silent listener failure often shows up as a desync, so try to heal
    // the subscription before declaring a hardware failure. Cooldown prevents
    // repeated re-subscriptions for a single underlying problem.
    if (newDesyncs.length > 0 && canResubscribe) {
      this._lastResubscribeAt = now;
      this.error(`[${this.getName()}] Re-subscribing due to desync: ${newDesyncs.map(d => d.name).join(', ')}`);
      this._addSyncReport({
        value:     virtualValue,
        devices:   newDesyncs.map(d => ({ name: d.name, synced: false, expected: d.expected, actual: d.actual })),
        hasError:  true,
        important: true,
        note:      this.homey.__('sync.resubscribe_attempted'),
      });
      await this.reloadConfiguration();
      return;
    }

    if (newDesyncs.length > 0) {
      this.error(`[${this.getName()}] Health check: ${newDesyncs.length} new desync(s) — ${newDesyncs.map(d => `${d.name}(${d.actual ? 'ON' : 'OFF'})`).join(', ')}`);
      this._addSyncReport({
        value:     virtualValue,
        devices:   newDesyncs.map(d => ({ name: d.name, synced: false, expected: d.expected, actual: d.actual })),
        hasError:  true,
      });
    }

    // Notification + auto-heal run on the full desync set — they self-dedup (notify history / 20s cooldown)
    await this._notifyDesynced(desynced);
    await this._autoHeal(desynced);
  }

  // ─── Notify desync — once per device until resolved ──────────────────────

  async _notifyDesynced(desynced) {
    const newDesyncs = desynced.filter(d => !this._notifiedDesyncs.has(d.deviceId));
    if (newDesyncs.length === 0) return;

    newDesyncs.forEach(d => this._notifiedDesyncs.add(d.deviceId));

    // Fire the Flow trigger regardless of the push-notification setting — separate channels
    for (const d of newDesyncs) {
      this._desyncTriggerCard.trigger(this, {
        device_name:    d.name,
        expected_state: d.expected ? 'ON' : 'OFF',
        actual_state:   d.actual ? 'ON' : 'OFF',
      }).catch(err => this.error(`[${this.getName()}] group_desynced trigger error: ${err.message}`));
    }

    if (!this.getSetting('notify_on_desync')) return;

    const names = newDesyncs.map(d =>
      `${d.name} (is ${d.actual ? 'ON' : 'OFF'}, expected ${d.expected ? 'ON' : 'OFF'})`
    ).join(', ');

    try {
      const excerpt = this.homey.__('sync.notification_excerpt')
        .replace('{group}', () => this.getName())
        .replace('{devices}', () => names);
      await this.homey.notifications.createNotification({ excerpt });
    } catch (err) {
      this.error(`[${this.getName()}] Could not send notification: ${err.message}`);
    }
  }

  // ─── Public API (used by Flow conditions and actions) ─────────────────────

  isGroupSynced() {
    return this._notifiedDesyncs.size === 0 && this._pendingOffline.size === 0;
  }

  async forceResync() {
    // Skip if a propagation is already in flight
    for (const exp of this._expectedStates.values()) {
      if (!exp.offline && !exp.verified) return;
    }
    const value = this.getCapabilityValue('onoff');
    this._debug(`flow force resync -> ${value ? 'ON' : 'OFF'}`);
    await this._propagate(value, null);
  }

  // ─── Settings changed ─────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    this._debug(`settings changed: ${changedKeys.join(', ')}`);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  async onDeleted() {
    this._debug('deleted — cleaning up');

    this._disposeGroupState();
    if (this._verifyTimer) this.homey.clearTimeout(this._verifyTimer);

    for (const { onoffInstance } of this._listeners.values()) {
      try { onoffInstance.destroy(); } catch (_) {}
    }
    this._listeners.clear();

    for (const { timer } of this._suppress.values()) this.homey.clearTimeout(timer);
    this._suppress.clear();
    this._lastListenerUpdate.clear();

    this._pendingOffline.clear();
    this._expectedStates.clear();
    this._notifiedDesyncs.clear();
    this._activeDesyncs.clear();
  }

}

module.exports = SwitchSyncDevice;
