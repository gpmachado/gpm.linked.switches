'use strict';

const LinkedGroupDevice = require('../../lib/LinkedGroupDevice');
const { SLAVE_STAGGER_MS } = require('../../lib/constants');

const MIN_SLAVES = 2;
const MAX_SLAVES = 9;

// Delay before reporting a failed write, giving late echoes a chance to arrive (ms)
const ERROR_REPORT_DELAY_MS = 2500;

class SwitchMasterDevice extends LinkedGroupDevice {

  // Cancel a delayed error report if the device state has just been confirmed.
  _cancelPendingErrorReport(deviceId, value) {
    const pending = this._pendingErrorReports.get(deviceId);
    if (!pending) return;
    if (pending.expected === value) {
      this.homey.clearTimeout(pending.timer);
      this._pendingErrorReports.delete(deviceId);
      this._debug('error report cancelled', { deviceId, value, device: pending.name });
    }
  }

  // Schedule an error report with a short delay. Late echoes often arrive
  // within a few seconds after the Homey API reports a timeout.
  _scheduleErrorReport(role, name, deviceId, expected, errorMessage) {
    this._cancelPendingErrorReport(deviceId, expected);

    const timer = this.homey.setTimeout(() => {
      this._pendingErrorReports.delete(deviceId);
      this._reportWriteError(role, name, expected, errorMessage);
    }, ERROR_REPORT_DELAY_MS);

    this._pendingErrorReports.set(deviceId, { timer, expected, role, name, errorMessage });
  }

  async onInit() {
    this._debug('init', { message: 'device initialized' });

    this._initGroupState();

    this._master = null;
    this._slaves = new Map();
    this._deviceNames = new Map();
    this._registeredControlCaps = new Set();
    this._settingVirtualMaster = false;
    this._syncingMasterFromUnanimity = false;

    // Delayed error reports: deviceId -> { timer, expected, role, name }
    this._pendingErrorReports = new Map();

    this.registerCapabilityListener('onoff', this._onVirtualMasterChanged.bind(this));
    await this._subscribeToDevices();

    // Boot health check, then a periodic safety net
    this._startHealthMonitor();
  }

  async reloadConfiguration() {
    this._debug('reload', { message: 'reloading configuration' });
    await this._subscribeToDevices();
  }

  async _subscribeToDevices() {
    return this._enqueue(() => this._subscribeToDevicesNow());
  }

  async _subscribeToDevicesNow() {
    this._debug('subscribe', { master: this.getStoreValue('masterDeviceId') || 'none', slaveCount: (this.getStoreValue('deviceIds') || []).length });
    if (this._master && this._master.onoffInstance) {
      try { this._master.onoffInstance.destroy(); } catch (_) {}
    }
    for (const { onoffInstance } of this._slaves.values()) {
      try { onoffInstance.destroy(); } catch (_) {}
    }

    const prevNames = new Map(this._deviceNames);

    this._master = null;
    this._slaves.clear();
    this._deviceNames.clear();
    this._suppress.clear();

    const masterDeviceId = this.getStoreValue('masterDeviceId');
    let slaveIds = this.getStoreValue('deviceIds') || [];
    const api = await this._api();
    let missingCount = 0;

    // Last-known name per device, kept even after it goes missing — lets Repair
    // show what a dead ID used to be, instead of it just silently vanishing.
    const persistedNames = this.getStoreValue('deviceNames') || {};

    if (masterDeviceId) {
      try {
        const device = await api.devices.getDevice({ id: masterDeviceId });
        const name = device.name;
        this._deviceNames.set(masterDeviceId, name);
        persistedNames[masterDeviceId] = name;
        const onoffInstance = device.makeCapabilityInstance('onoff', value => {
          this._debug('callback in', { role: 'master', device: name, value, debounced: true });
          this._debouncedCallback(masterDeviceId, value, debouncedValue => {
            this._onPhysicalMasterChanged(debouncedValue)
              .catch(err => this.error(`[${this.getName()}] Physical master update error from "${name}": ${err.message}`));
          });
        });
        this._master = { deviceId: masterDeviceId, device, onoffInstance };
        this._debug('subscribe', { role: 'master', device: name, deviceId: masterDeviceId });
      } catch (err) {
        this.error(`[${this.getName()}] Could not subscribe master "${masterDeviceId}": ${err.message}`);
        missingCount++;
      }
    }

    for (const deviceId of slaveIds) {
      try {
        const device = await api.devices.getDevice({ id: deviceId });
        const name = device.name;
        this._deviceNames.set(deviceId, name);
        persistedNames[deviceId] = name;

        const onoffInstance = device.makeCapabilityInstance('onoff', value => {
          this._debug('callback in', { role: 'slave', device: name, deviceId, value, debounced: true });
          this._debouncedCallback(deviceId, value, debouncedValue => {
            this._onSlaveChanged(deviceId, name, debouncedValue)
              .catch(err => this.error(`[${this.getName()}] Slave update error from "${name}": ${err.message}`));
          });
        });

        this._slaves.set(deviceId, { device, onoffInstance });
        this._debug('subscribe', { role: 'slave', device: name, deviceId });
      } catch (err) {
        this.error(`[${this.getName()}] Could not subscribe slave "${deviceId}": ${err.message}`);
        missingCount++;
      }
    }

    // Ghost detection (see _confirmSubscribeFailure).
    const now = Date.now();

    // Master can't be auto-removed (the group requires one) — just warn once.
    if (masterDeviceId && !this._master) {
      const prior = this._subscribeFailures.get(masterDeviceId);
      if (!(prior && prior.reported) && this._confirmSubscribeFailure(masterDeviceId, now)) {
        this._subscribeFailures.get(masterDeviceId).reported = true;
        this._reportGhostMaster(prevNames.get(masterDeviceId));
      }
    } else if (masterDeviceId) {
      this._subscribeFailures.delete(masterDeviceId);
    }

    // Slaves can be auto-removed, same as a Linked Switch group member.
    const ghostSlaves = [];
    for (const deviceId of slaveIds) {
      if (!this._slaves.has(deviceId)) {
        if (this._confirmSubscribeFailure(deviceId, now)) ghostSlaves.push(deviceId);
      } else {
        this._subscribeFailures.delete(deviceId);
      }
    }
    for (const deviceId of ghostSlaves) {
      await this._removeGhostSlave(deviceId, prevNames.get(deviceId));
    }
    if (ghostSlaves.length > 0) {
      slaveIds = this.getStoreValue('deviceIds') || [];
      missingCount -= ghostSlaves.length;
    }

    // Prune names for devices no longer part of this group, then persist.
    const keptIds = new Set(masterDeviceId ? [masterDeviceId, ...slaveIds] : slaveIds);
    for (const id of Object.keys(persistedNames)) {
      if (!keptIds.has(id)) delete persistedNames[id];
    }
    await this.setStoreValue('deviceNames', persistedNames).catch(() => {});

    if (missingCount > 0) {
      await this.setUnavailable(`${missingCount} ${this.homey.__('error.missing_devices')}`).catch(() => {});
    } else if (!this._master) {
      await this.setUnavailable(this.homey.__('master_wizard.err_master_required')).catch(() => {});
    } else if (this._slaves.size < MIN_SLAVES) {
      await this.setUnavailable(this.homey.__('master_wizard.err_min2')).catch(() => {});
    } else if (this._slaves.size > MAX_SLAVES) {
      await this.setUnavailable(this.homey.__('master_wizard.err_max9')).catch(() => {});
    } else {
      await this.setAvailable().catch(() => {});
    }

    // Unconditional one-line summary — visible in diagnostic reports even with debug off.
    this.log(`[${this.getName()}] Ready: master ${this._master ? 'ok' : 'MISSING'}, ${this._slaves.size}/${slaveIds.length} slave(s) linked${missingCount > 0 ? `, ${missingCount} missing` : ''}`);

    await this._syncControlCapabilities(masterDeviceId, slaveIds);
    await this._syncStatusCapabilities(masterDeviceId, slaveIds);
    await this._updateLinkedDevicesSetting();
    await this._setVirtualMasterValue(this._getPhysicalMasterValue());
    await this._syncMasterFromUnanimity();
  }

  async _removeGhostSlave(deviceId, deviceName) {
    const slaveIds = (this.getStoreValue('deviceIds') || []).filter(id => id !== deviceId);
    await this.setStoreValue('deviceIds', slaveIds);
    const ghostName = deviceName || this._deviceNames.get(deviceId) || deviceId;
    const remaining = slaveIds.length;
    const degraded = remaining >= MIN_SLAVES;
    this.error(`[${this.getName()}] Removed ghost slave "${ghostName}" — no longer exists in Homey (${remaining} remaining${degraded ? ', group degraded' : ', group condemned'})`);
    this._addSyncReport({
      value:     null,
      devices:   [{ name: ghostName, synced: false, removed: true }],
      hasError:  true,
      important: true,
      note:      degraded
        ? this.homey.__('sync.slave_removed_degraded').replace('{remaining}', remaining)
        : this.homey.__('sync.slave_removed_condemned').replace('{remaining}', remaining),
    });
  }

  // Master can't be auto-removed (the group is defined by it) — report once so it
  // shows in the Desync Log, and rely on setUnavailable to keep the card flagged.
  _reportGhostMaster(deviceName) {
    const masterDeviceId = this.getStoreValue('masterDeviceId');
    const ghostName = deviceName || this._deviceNames.get(masterDeviceId) || masterDeviceId;
    this.error(`[${this.getName()}] Master "${ghostName}" no longer exists in Homey — group needs repair`);
    this._addSyncReport({
      value:     null,
      devices:   [{ name: ghostName, synced: false, removed: true }],
      hasError:  true,
      important: true,
      note:      this.homey.__('sync.master_missing'),
    });
  }

  // ─── Health check (periodic + boot) — re-subscribe missing listeners ─────

  async _verifyGroupHealth() {
    const now = Date.now();
    const canResubscribe = now - this._lastResubscribeAt > this._resubscribeCooldown;
    if (!canResubscribe) return;

    const masterDeviceId = this.getStoreValue('masterDeviceId');
    const masterMissing = Boolean(masterDeviceId) && !this._master;
    const missingSlaves = (this.getStoreValue('deviceIds') || []).filter(id => !this._slaves.has(id));

    if (masterMissing || missingSlaves.length > 0) {
      this._lastResubscribeAt = now;
      this.error(`[${this.getName()}] Re-subscribing missing listener(s)`);
      await this.reloadConfiguration();
    }
  }

  async _syncControlCapabilities(masterDeviceId, slaveIds) {
    const controlIds = masterDeviceId ? [masterDeviceId, ...slaveIds] : slaveIds;
    const needed = new Set(controlIds.map((_, i) => this._controlCapId(i)));

    for (const cap of this.getCapabilities()) {
      const isOldOnoffSlave = cap.startsWith('onoff.slave_');
      const isOldMasterSlave = cap.startsWith('master_slave.');
      const isOldGang = cap.startsWith('onoff.gang');
      const isOldCustomControl = cap.startsWith('master_switch.');
      const isStaleButton = cap.startsWith('master_button.') && !needed.has(cap);
      if (isOldOnoffSlave || isOldMasterSlave || isOldGang || isOldCustomControl || isStaleButton) await this.removeCapability(cap).catch(() => {});
    }

    await this.setCapabilityOptions('onoff', {
      title: { en: this._master ? this.homey.__('sync.master_title').replace('{name}', () => this._master.device.name) : this.homey.__('sync.master_switch') },
    }).catch(() => {});

    for (let i = 0; i < controlIds.length; i++) {
      const deviceId = controlIds[i];
      const capId = this._controlCapId(i);
      try {
        if (!this.hasCapability(capId)) await this.addCapability(capId);
        const isMaster = i === 0 && this._master && this._master.deviceId === deviceId;
        const name = this._deviceNames.get(deviceId) || deviceId;
        const icon = isMaster ? '/drivers/switch-master/assets/icon-masterswitch.svg' : '/drivers/switch-master/assets/icon.svg';
        await this.setCapabilityOptions(capId, {
          title: { en: isMaster ? `MASTER: ${name}` : name },
          ...(isMaster ? { icon } : {}),
        });
        await this._setControlCapValue(capId, isMaster ? this._getPhysicalMasterValue() : this._getSlaveValue(deviceId));
        this._registerControlCapability(capId);
      } catch (err) {
        this.error(`[${this.getName()}] Could not set up ${capId}: ${err.message}`);
      }
    }
  }

  async _syncStatusCapabilities(masterDeviceId, slaveIds) {
    const statusIds = masterDeviceId ? [masterDeviceId, ...slaveIds] : slaveIds;
    const showStatus = this._shouldShowDeviceStatus();
    const needed = new Set(showStatus ? statusIds.map((_, i) => this._statusCapId(i)) : []);

    for (const cap of this.getCapabilities()) {
      const isStaleStatus = (cap.startsWith('subdevice_switch.') || cap.startsWith('linked_switch.')) && !needed.has(cap);
      if (isStaleStatus) await this.removeCapability(cap).catch(() => {});
    }

    if (!showStatus) return;

    for (let i = 0; i < statusIds.length; i++) {
      const capId = this._statusCapId(i);
      try {
        if (!this.hasCapability(capId)) await this.addCapability(capId);
        await this._renderStatusCapability(i, statusIds[i]);
      } catch (err) {
        this.error(`[${this.getName()}] Could not set up ${capId}: ${err.message}`);
      }
    }
  }

  _shouldShowDeviceStatus() {
    return this._isAppToggleOn('show_master_status', false);
  }

  async _refreshStatusCapabilities() {
    await this._syncStatusCapabilities(this.getStoreValue('masterDeviceId'), this.getStoreValue('deviceIds') || []);
  }

  _statusCapId(index) {
    return `subdevice_switch.${index + 1}`;
  }

  async _setRemoteOnOff(device, value, label) {
    try {
      this._debug('write start', { device: label, value });
      await device.setCapabilityValue({ capabilityId: 'onoff', value });
      this._debug('write ok', { device: label, value });
      return { ok: true };
    } catch (err) {
      this._debug('write failed', { device: label, value, error: err.message });
      this.error(`[${this.getName()}] Failed to set ${label}: ${err.message}`);
      return { ok: false, errorMessage: err.message };
    }
  }

  async _renderStatusCapability(index, deviceId) {
    const capId = this._statusCapId(index);
    if (!this.hasCapability(capId)) return;

    const isMaster = index === 0 && this._master && this._master.deviceId === deviceId;
    const name = this._deviceNames.get(deviceId) || deviceId;
    const title = isMaster ? `MASTER: ${name}` : name;
    const icon = isMaster ? '/drivers/switch-master/assets/icon-masterswitch.svg' : '/drivers/switch-master/assets/icon.svg';

    await this.setCapabilityOptions(capId, {
      title: { en: title },
      ...(isMaster ? { icon } : {}),
    });
    await this.setCapabilityValue(capId, this._statusCapText(deviceId));
    this._debug('status render', { capId, deviceId, status: this._statusCapText(deviceId) });
  }

  _statusCapText(deviceId, value) {
    if (typeof value === 'boolean') {
      return this._statusText(value);
    }
    if (this._master && this._master.deviceId === deviceId) {
      return this._statusText(this._getPhysicalMasterValue());
    }
    return this._statusText(this._getSlaveValue(deviceId));
  }

  async _updateStatusCapability(deviceId, value) {
    if (!this._shouldShowDeviceStatus()) return;

    const ids = this._master ? [this._master.deviceId, ...(this.getStoreValue('deviceIds') || [])] : (this.getStoreValue('deviceIds') || []);
    const index = ids.indexOf(deviceId);
    if (index === -1) return;

    const capId = this._statusCapId(index);
    if (!this.hasCapability(capId)) return;
    await this.setCapabilityValue(capId, this._statusCapText(deviceId, value)).catch(() => {});
    this._debug('status update', { capId, deviceId, status: this._statusCapText(deviceId, value) });
  }

  _controlCapId(index) {
    return `master_button.${index + 1}`;
  }

  // Report a failed write to the unified app error log.
  _reportWriteError(role, name, expected, errorMessage) {
    if (!this.homey || !this.homey.app || typeof this.homey.app.addSyncReport !== 'function') return;
    this._addSyncReport({
      trigger: this.homey.__(role === 'master' ? 'sync.master_command' : 'sync.slave_command'),
      value: expected,
      devices: [{ name, synced: false, expected, actual: null, errorMessage }],
      hasError: true,
    });
  }

  _registerControlCapability(capId) {
    if (this._registeredControlCaps.has(capId)) return;
    this._registeredControlCaps.add(capId);

    this.registerCapabilityListener(capId, async (value) => {
      const ids = this._master ? [this._master.deviceId, ...(this.getStoreValue('deviceIds') || [])] : (this.getStoreValue('deviceIds') || []);
      const index = Number(capId.replace('master_button.', '')) - 1;
      const deviceId = ids[index];
      if (!deviceId) return;
      if (this._master && deviceId === this._master.deviceId) {
        await this._onVirtualMasterChanged(value);
      } else {
        await this._setOneSlave(deviceId, value, 'master button');
      }
    });
  }

  _getPhysicalMasterValue() {
    return this._master ? this._master.onoffInstance.value : null;
  }

  _getSlaveValue(deviceId) {
    const entry = this._slaves.get(deviceId);
    return entry ? entry.onoffInstance.value : null;
  }

  _statusText(value) {
    if (value === true) return this.homey.__('sync.on');
    if (value === false) return this.homey.__('sync.off');
    return '—';
  }

  async _setVirtualMasterValue(value) {
    if (typeof value !== 'boolean') return;
    if (this.getCapabilityValue('onoff') === value) return;

    this._settingVirtualMaster = true;
    try {
      await this.setCapabilityValue('onoff', value);
    } finally {
      this._settingVirtualMaster = false;
    }
  }

  async _setControlCapValue(capId, value) {
    if (!this.hasCapability(capId)) return;
    if (typeof value !== 'boolean') return;
    if (this.getCapabilityValue(capId) === value) return;
    await this.setCapabilityValue(capId, value);
  }

  async _updateControlValue(deviceId) {
    const ids = this._master ? [this._master.deviceId, ...(this.getStoreValue('deviceIds') || [])] : (this.getStoreValue('deviceIds') || []);
    const index = ids.indexOf(deviceId);
    if (index === -1) return;
    const value = this._master && deviceId === this._master.deviceId ? this._getPhysicalMasterValue() : this._getSlaveValue(deviceId);
    await this._setControlCapValue(this._controlCapId(index), value);
  }

  async _onVirtualMasterChanged(value) {
    if (this._settingVirtualMaster) return;
    this._debug('virtual master changed', { value });
    await this._setVirtualMasterValue(value);
    if (this._master) await this._setControlCapValue(this._controlCapId(0), value).catch(() => {});
    await this._setPhysicalMaster(value, 'virtual master');
    await this._setAllSlaves(value, 'virtual master');
  }

  async _onPhysicalMasterChanged(value) {
    const masterName = this._master ? this._master.device.name : 'master';
    if (this._master) this._cancelPendingErrorReport(this._master.deviceId, value);
    await this._setVirtualMasterValue(value);
    if (this._master) await this._updateControlValue(this._master.deviceId);
    if (this._master) await this._updateStatusCapability(this._master.deviceId, value);

    if (this._master && this._isSuppressed(this._master.deviceId, value)) {
      this._debug('suppressed', { role: 'master', device: masterName, value });
      return;
    }

    this._debug('propagate', { role: 'master', device: masterName, value });
    await this._setAllSlaves(value, 'physical master');
  }

  async _onSlaveChanged(deviceId, name, value) {
    this._cancelPendingErrorReport(deviceId, value);
    if (this._isSuppressed(deviceId, value)) {
      this._debug('suppressed', { role: 'slave', device: name, deviceId, value });
      return;
    }

    const index = (this.getStoreValue('deviceIds') || []).indexOf(deviceId);
    if (index !== -1) {
      await this._updateControlValue(deviceId).catch(err => {
        this.error(`[${this.getName()}] Could not update slave button "${name}": ${err.message}`);
      });
    }
    await this._updateStatusCapability(deviceId, value);

    await this._syncMasterFromUnanimity();
  }

  async _setPhysicalMaster(value, source) {
    if (!this._master || !this._master.device.available) return;

    const suppressMs = this._suppressMs();
    this._suppressDevice(this._master.deviceId, value, suppressMs);
    this._debug('write start', { role: 'master', source, device: this._master.device.name, value, suppressMs });

    try {
      const result = await this._setRemoteOnOff(this._master.device, value, `master "${this._master.device.name}"`);
      if (!result.ok) throw new Error(result.errorMessage);
      this._debug('write ok', { role: 'master', source, device: this._master.device.name, value });
      await this._updateStatusCapability(this._master.deviceId, value).catch(() => {});
    } catch (err) {
      this._scheduleErrorReport('master', this._master.device.name, this._master.deviceId, value, err.message);
      this.error(`[${this.getName()}] Failed to set master "${this._master.device.name}": ${err.message}`);
    }
  }

  async _setAllSlaves(value, source) {
    const slaveIds = this.getStoreValue('deviceIds') || [];
    const suppressMs = this._suppressMs();

    this._debug('propagate', { source, value, slaveCount: slaveIds.length, staggerMs: SLAVE_STAGGER_MS });

    for (let index = 0; index < slaveIds.length; index++) {
      const deviceId = slaveIds[index];
      const entry = this._slaves.get(deviceId);
      if (!entry) {
        this.error(`[${this.getName()}] ${source}: slave ${deviceId} is not subscribed`);
        continue;
      }
      if (!entry.device.available) {
        this.error(`[${this.getName()}] ${source}: slave "${entry.device.name}" is unavailable`);
        continue;
      }

      const staggerMs = index > 0 ? SLAVE_STAGGER_MS : 0;
      if (staggerMs > 0) {
        this._debug('stagger wait', { source, device: entry.device.name, staggerMs });
        await new Promise(resolve => this.homey.setTimeout(resolve, staggerMs));
      }

      this._suppressDevice(deviceId, value, suppressMs);
      await this._setControlCapValue(this._controlCapId(index + 1), value).catch(() => {});

      try {
        const result = await this._setRemoteOnOff(entry.device, value, `slave "${entry.device.name}"`);
        if (!result.ok) throw new Error(result.errorMessage);
        this._debug('write ok', { role: 'slave', source, device: entry.device.name, value });
        await this._updateStatusCapability(deviceId, value).catch(() => {});
      } catch (err) {
        this._scheduleErrorReport('slave', entry.device.name, deviceId, value, err.message);
        this.error(`[${this.getName()}] Failed to set slave "${entry.device.name}": ${err.message}`);
      }
    }
  }

  async _setOneSlave(deviceId, value, source) {
    const entry = this._slaves.get(deviceId);
    if (!entry || !entry.device.available) return;

    const suppressMs = this._suppressMs();
    this._debug('write start', { role: 'slave', source, device: entry.device.name, value, suppressMs });

    this._suppressDevice(deviceId, value, suppressMs);
    const index = (this.getStoreValue('deviceIds') || []).indexOf(deviceId);
    if (index !== -1) await this._setControlCapValue(this._controlCapId(index + 1), value).catch(() => {});
    try {
      const result = await this._setRemoteOnOff(entry.device, value, `slave "${entry.device.name}"`);
      if (!result.ok) throw new Error(result.errorMessage);
      await this._updateStatusCapability(deviceId, value).catch(() => {});
    } catch (err) {
      this._scheduleErrorReport('slave', entry.device.name, deviceId, value, err.message);
      this.error(`[${this.getName()}] Failed to set slave "${entry.device.name}": ${err.message}`);
    }

    await this._syncMasterFromUnanimity();
  }

  async _syncMasterFromUnanimity() {
    if (this._syncingMasterFromUnanimity) return;

    const values = [...this._slaves.values()]
      .map(({ onoffInstance }) => onoffInstance.value)
      .filter(value => typeof value === 'boolean');

    if (values.length < MIN_SLAVES) return;

    const allOn = values.every(Boolean);
    const allOff = values.every(value => value === false);
    if (!allOn && !allOff) return;

    const target = allOn;
    if (this._getPhysicalMasterValue() === target && this.getCapabilityValue('onoff') === target) return;

    this._syncingMasterFromUnanimity = true;
    try {
      this._debug('unanimity', { slaveCount: values.length, target });
      await this._setVirtualMasterValue(target);
      if (this._master) await this._setControlCapValue(this._controlCapId(0), target).catch(() => {});
      await this._setPhysicalMaster(target, 'slave unanimity');
    } finally {
      this._syncingMasterFromUnanimity = false;
    }
  }

  async _updateLinkedDevicesSetting() {
    try {
      const none = this.homey.__('sync.none');
      const masterName = this._master ? this._master.device.name : none;
      const slaveNames = Array.from(this._slaves.values()).map(({ device }) => device.name).join('\n') || none;
      await this.setSettings({ linked_devices_info: `${this.homey.__('sync.master_label')}: ${masterName}\n\n${this.homey.__('sync.slaves_label')}:\n${slaveNames}` });
    } catch (err) {
      this.error(`[${this.getName()}] Failed to update settings: ${err.message}`);
    }
  }

  async onDeleted() {
    this._disposeGroupState();

    if (this._master && this._master.onoffInstance) {
      try { this._master.onoffInstance.destroy(); } catch (_) {}
    }
    for (const { onoffInstance } of this._slaves.values()) {
      try { onoffInstance.destroy(); } catch (_) {}
    }
    for (const { timer } of this._suppress.values()) {
      if (timer) this.homey.clearTimeout(timer);
    }
    for (const { timer } of this._pendingErrorReports.values()) {
      if (timer) this.homey.clearTimeout(timer);
    }
  }

}

module.exports = SwitchMasterDevice;
