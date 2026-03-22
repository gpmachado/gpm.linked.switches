'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

module.exports = class SwitchSyncApp extends Homey.App {

  async onInit() {
    this.log('Switch Sync app initialized');
    this._homeyAPI = null;
  }

  async getHomeyAPI() {
    if (!this._homeyAPI) {
      this._homeyAPI = await HomeyAPI.createAppAPI({ homey: this.homey });
    }
    return this._homeyAPI;
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
        const isOwn = d.driverId === 'switch-sync' && d.ownerUri === 'homey:app:gpm.linked.switches';
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
