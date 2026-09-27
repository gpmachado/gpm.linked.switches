'use strict';

const { Driver } = require('homey');

class SwitchSyncDriver extends Driver {

  async onInit() {
    this.log('SwitchSyncDriver initialized');

    this.homey.flow.getConditionCard('group_is_synced')
      .registerRunListener(async (args) => args.device.isGroupSynced());
    this.homey.flow.getActionCard('force_resync')
      .registerRunListener(async (args) => { await args.device.forceResync(); });
  }

  // Returns a Map of physicalDeviceId → array of { name, role, driverId, groupId }
  // for all devices already in a group. Optionally excludes one group by its
  // Homey device id (for repair).
  _buildOccupiedMap(excludeHomeyDeviceId = null) {
    const occupied = new Map();
    const driverIds = ['switch-sync', 'switch-master'];
    const markOccupied = (id, entry) => {
      const current = occupied.get(id) || [];
      current.push(entry);
      occupied.set(id, current);
    };

    for (const driverId of driverIds) {
      let driver;
      try {
        driver = this.homey.drivers.getDriver(driverId);
      } catch (_) {
        continue;
      }

      for (const device of driver.getDevices()) {
        if (excludeHomeyDeviceId && device.getId() === excludeHomeyDeviceId) continue;
        const name = device.getName();
        const groupId = device.getId();
        const masterId = device.getStoreValue('masterDeviceId');
        if (masterId) {
          markOccupied(masterId, { name, role: 'master', driverId, groupId });
        }

        for (const id of (device.getStoreValue('deviceIds') || []).filter(Boolean)) {
          markOccupied(id, { name, role: 'member', driverId, groupId });
        }
      }
    }
    return occupied;
  }

  // Mirrors the validation in switch-master/driver.js:
  // - A LinkSwitch member may also be a slave in a Switch Master.
  // - But both members of the same LinkSwitch cannot be slaves of the same Master.
  // - A device that is a Switch Master primary cannot be in a LinkSwitch.
  _assertNoConflicts(deviceIds, primaryDeviceId, excludeHomeyDeviceId = null) {
    const occupied = this._buildOccupiedMap(excludeHomeyDeviceId);
    const conflicts = [];
    const linkedFamilies = new Map();

    for (const id of deviceIds) {
      const entries = occupied.get(id) || [];

      // The LinkSwitch primary may not be the primary of a Switch Master.
      const masterPrimaryEntries = entries.filter(entry => entry.role === 'master');
      if (masterPrimaryEntries.length > 0) {
        conflicts.push(...masterPrimaryEntries.map(entry => entry.name));
      }

      // Slaves of a Switch Master are allowed, but only one per LinkSwitch pair.
      const allowedMasterSlaveEntries = entries.filter(entry => entry.driverId === 'switch-master' && entry.role === 'member');
      const blockedEntries = entries.filter(entry => !(entry.driverId === 'switch-master' && entry.role === 'member'));
      if (blockedEntries.length > 0) {
        conflicts.push(...blockedEntries.map(entry => entry.name));
      }

      for (const entry of allowedMasterSlaveEntries) {
        const seen = linkedFamilies.get(entry.groupId);
        if (seen && seen !== id) {
          conflicts.push(entry.name);
          continue;
        }
        linkedFamilies.set(entry.groupId, id);
      }
    }

    if (conflicts.length === 0) return;

    const names = [...new Set(conflicts)];
    throw new Error(
      this.homey.__('pair.err_device_conflict').replace('{names}', names.join('", "'))
    );
  }

  async onPair(session) {
    let pendingConfig = null;

    session.setHandler('get_available_devices', async () => {
      try {
        const devices = await this.homey.app.getDevicesWithOnOff();
        this.log(`get_available_devices: found ${devices.length} devices`);
        return devices;
      } catch (err) {
        this.error(`get_available_devices error: ${err.message}`, err);
        throw err;
      }
    });

    session.setHandler('configure_binding', async (config) => {
      const ids = [...new Set(config.deviceIds || [])];
      if (ids.length < 2) {
        throw new Error(this.homey.__('pair.err_min2'));
      }
      const primaryId = config.primaryDeviceId || null;
      if (primaryId && !ids.includes(primaryId)) {
        throw new Error(this.homey.__('repair.err_primary_not_selected'));
      }
      this._assertNoConflicts(ids, primaryId);
      pendingConfig = config;
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!pendingConfig) return [];
      return [{
        name: pendingConfig.name,
        data: { id: `binding_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` },
        store: {
          deviceIds: pendingConfig.deviceIds,
          primaryDeviceId: pendingConfig.primaryDeviceId || null,
          pendingInitialSync: true,
        },
        settings: {
          suppress_ms: 2000,
          linked_devices_info: '',
        },
      }];
    });
  }

  async onRepair(session, device) {
    session.setHandler('get_available_devices', async () => {
      return this.homey.app.getDevicesWithOnOff();
    });

    session.setHandler('get_config', async () => {
      return {
        deviceIds: device.getStoreValue('deviceIds') || [],
        primaryDeviceId: device.getStoreValue('primaryDeviceId') || null,
        deviceNames: device.getStoreValue('deviceNames') || {},
      };
    });

    session.setHandler('save_config', async (config) => {
      const ids = config.deviceIds;
      if (!Array.isArray(ids) || ids.length < 2)
        throw new Error(this.homey.__('repair.err_min2'));
      const unique = [...new Set(ids)];
      const primaryId = config.primaryDeviceId || null;
      if (primaryId && !unique.includes(primaryId)) {
        throw new Error(this.homey.__('repair.err_primary_not_selected'));
      }

      // Validate: one LinkSwitch member may be a Switch Master slave, but not both.
      this._assertNoConflicts(unique, primaryId, device.getId());

      await device.setStoreValue('deviceIds', unique).catch(this.error);
      await device.setStoreValue('primaryDeviceId', primaryId).catch(this.error);
      if (typeof device.reloadConfiguration === 'function') {
        await device.reloadConfiguration({ align: true }).catch(err => this.error(`reloadConfiguration error: ${err.message}`));
      }
      return true;
    });
  }

}

module.exports = SwitchSyncDriver;
