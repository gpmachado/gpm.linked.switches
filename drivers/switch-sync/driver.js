'use strict';

const { Driver } = require('homey');

class SwitchSyncDriver extends Driver {

  async onInit() {
    this.log('SwitchSyncDriver initialized');
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
      pendingConfig = config;
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!pendingConfig) return [];
      return [{
        name: pendingConfig.name,
        data: { id: `binding_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` },
        store: { deviceIds: pendingConfig.deviceIds },
        settings: {
          suppress_ms: 2000,
          debug: false,
          linked_devices_info: 'Pending sync...',
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
      };
    });

    session.setHandler('save_config', async (config) => {
      const ids = config.deviceIds;
      if (!Array.isArray(ids) || ids.length < 2) throw new Error('Select at least 2 devices.');
      const unique = [...new Set(ids)];
      await device.setStoreValue('deviceIds', unique).catch(this.error);
      if (typeof device.reloadConfiguration === 'function') {
        device.reloadConfiguration().catch(this.error);
      }
      return true;
    });
  }

}

module.exports = SwitchSyncDriver;
