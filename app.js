'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { BOOT_SYNC_POLICIES, DEFAULT_BOOT_SYNC_POLICY } = require('./lib/constants');

module.exports = class SwitchSyncApp extends Homey.App {

  _isSettingEnabled(value, defaultValue = true) {
    if (value === undefined || value === null) return defaultValue;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return true;
  }

  async onInit() {
    this.log('Switch Sync app initialized');
    this._homeyAPI     = null;
    this._syncLog      = null;
    this._syncLogTimer = null;

    if (this.homey.settings.get('show_device_status') === undefined) {
      this.homey.settings.set('show_device_status', 'true');
    }
    if (this.homey.settings.get('show_master_status') === undefined) {
      this.homey.settings.set('show_master_status', 'false');
    }
    if (!BOOT_SYNC_POLICIES.includes(this.homey.settings.get('boot_sync_policy'))) {
      this.homey.settings.set('boot_sync_policy', DEFAULT_BOOT_SYNC_POLICY);
    }

    // Avoid false-positive MaxListenersExceededWarning caused by Homey SDK
    // internal listeners on the shared ManagerSettings emitter.
    if (typeof this.homey.settings.setMaxListeners === 'function') {
      this.homey.settings.setMaxListeners(0);
    }

    this.homey.settings.on('set', (key) => {
      if (key === 'desyncLog') {
        const val = this.homey.settings.get('desyncLog');
        if (Array.isArray(val) && val.length === 0) {
          this.log('Log cleared from settings page');
          if (this._syncLogTimer) {
            this.homey.clearTimeout(this._syncLogTimer);
            this._syncLogTimer = null;
          }
          this._syncLog = [];
        }
      }

      if (key === 'show_device_status' || key === 'show_master_status') {
        this._renderAllGroupCards().catch(err => this.error(`Failed to refresh group cards: ${err.message}`));
      }
    });

    // log_mode was removed in v1.2.0 and debug_logging in v1.1.5; clean up stale settings from older installs.
    this.homey.settings.unset('log_mode');
    this.homey.settings.unset('debug_logging');
  }

  async getHomeyAPI() {
    if (!this._homeyAPI) {
      this._homeyAPI = await HomeyAPI.createAppAPI({ homey: this.homey });
    }
    return this._homeyAPI;
  }

  addSyncReport(report) {
    // Suppress writes for 3s after a manual clear (health check race)
    if (this._clearTs && Date.now() - this._clearTs < 3000) return;

    // The settings log only tracks sync failures and recoveries.
    // Successful syncs are visible in each device's own Homey history.
    if (!report.hasError && !report.important) return;

    const summary = this._formatSyncReport(report);
    if (summary) {
      if (report.hasError) this.error(summary);
      else this.log(summary);
    }

    if (!this._syncLog) {
      this._syncLog = this.homey.settings.get('desyncLog') || [];
    }
    this._syncLog.unshift(report);
    if (this._syncLog.length > 200) this._syncLog.length = 200;

    if (report.hasError) {
      // Write immediately for errors — never lose a failure event
      if (this._syncLogTimer) {
        this.homey.clearTimeout(this._syncLogTimer);
        this._syncLogTimer = null;
      }
      this.homey.settings.set('desyncLog', this._syncLog);
    } else {
      // Debounce flash writes for recoveries — max once per minute
      if (this._syncLogTimer) return;
      this._syncLogTimer = this.homey.setTimeout(() => {
        this._syncLogTimer = null;
        this.homey.settings.set('desyncLog', this._syncLog);
      }, 60000);
    }
  }

  clearSyncLog() {
    if (this._syncLogTimer) {
      this.homey.clearTimeout(this._syncLogTimer);
      this._syncLogTimer = null;
    }
    this._syncLog = [];
    this._clearTs = Date.now();
    this.homey.settings.set('desyncLog', []);
  }

  // ON/OFF, or '?' when the state is unknown (a failed write, a removed device).
  _stateLabel(value) {
    return typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : '?';
  }

  _formatSyncReport(report) {
    if (!report || !Array.isArray(report.devices) || report.devices.length === 0) return '';
    const target = this._stateLabel(report.value);

    if (report.hasError) {
      const failed = report.devices
        .filter(device => !device.synced)
        .map(device => {
          const state = `${this._stateLabel(device.expected)} expected, ${this._stateLabel(device.actual)} actual`;
          return device.errorMessage
            ? `${device.name} (${state}; ${device.errorMessage})`
            : `${device.name} (${state})`;
        });
      const note = report.note ? ` (${report.note})` : '';
      return `[Sync failed] ${report.group}: ${report.trigger} -> ${target}; ${failed.join(', ')}${note}`;
    }

    const recovered = report.devices.filter(device => device.recovered);
    if (recovered.length > 0) {
      const names = recovered.map(device => `${device.name} (${Math.round((device.durationMs || 0) / 1000)}s)`);
      return `[Sync recovered] ${report.group}: ${names.join(', ')}`;
    }

    return `[Sync ok] ${report.group}: ${report.trigger} -> ${target}; ${report.devices.length} device(s) verified`;
  }

  async _renderAllGroupCards() {
    for (const driverId of ['switch-sync', 'switch-master']) {
      let driver;
      try {
        driver = this.homey.drivers.getDriver(driverId);
      } catch (_) {
        continue;
      }

      for (const device of driver.getDevices()) {
        if (typeof device._refreshStatusCapabilities === 'function') {
          await device._refreshStatusCapabilities();
        } else if (typeof device._renderAllSubCapabilities === 'function') {
          await device._renderAllSubCapabilities();
        }
      }
    }
  }

  async onApi(method, path, body) {
    this.log(`onApi called: ${method} "${path}"`);
    const normalPath = path.startsWith('/') ? path : `/${path}`;
    if (method === 'POST' && normalPath === '/clear-log') {
      this.clearSyncLog();
      this.log('onApi: clearSyncLog done');
      return { ok: true };
    }
    throw new Error(`Unknown API: ${method} ${path}`);
  }

  // Returns all devices with onoff capability, excluding our own driver, with zone info
  async getDevicesWithOnOff() {
    const api = await this.getHomeyAPI();
    const [allDevices, allZones] = await Promise.all([
      api.devices.getDevices(),
      api.zones.getZones().catch(() => ({})),
    ]);

    return Object.values(allDevices)
      .filter(d => {
        const caps = d.capabilities || [];
        const isOwn = d.ownerUri === 'homey:app:gpm.linked.switches';
        return caps.includes('onoff') && !isOwn;
      })
      .map(d => {
        const zone = allZones[d.zone] || null;
        return { id: d.id, name: d.name, zoneId: d.zone || null, zoneName: zone ? zone.name : null };
      })
      .sort((a, b) => {
        const za = a.zoneName || '';
        const zb = b.zoneName || '';
        return za.localeCompare(zb) || a.name.localeCompare(b.name);
      });
  }

};
