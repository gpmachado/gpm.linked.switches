'use strict';

const { Device } = require('homey');
const {
  DEBUG,
  HEALTH_INTERVAL_MS,
  GHOST_CONFIRM_GAP_MS,
  CALLBACK_DEBOUNCE_MS,
} = require('./constants');

// Plumbing shared by the Linked Switch and Switch Master drivers. Subclasses
// call _initGroupState() from onInit and implement _verifyGroupHealth().
class LinkedGroupDevice extends Device {

  _initGroupState() {
    // Callback debounce: deviceId → timer
    this._callbackTimers = new Map();
    // Last seen value per device (for debounce change detection)
    this._lastCallbackValues = new Map();

    // Persistent subscription failures: deviceId → { count, firstFailAt, reported? }
    this._subscribeFailures = new Map();

    // Cooldown for on-demand re-subscription defense (ms)
    this._resubscribeCooldown = 60 * 1000;
    this._lastResubscribeAt = 0;

    // Echo suppression: deviceId → { value, timer }
    this._suppress = new Map();

    // Serializes state-mutating operations so overlapping triggers
    // (rapid toggles, concurrent re-subscribes) never interleave.
    this._opQueue = null;
  }

  _debug(tag, payload) {
    if (!DEBUG) return;
    if (payload !== undefined) this.log(`[${this.getName()}][debug][${tag}]`, payload);
    else this.log(`[${this.getName()}][debug][${tag}]`);
  }

  async _api() {
    return this.homey.app.getHomeyAPI();
  }

  // Runs fn() after any previously-enqueued operation settles, so two triggers
  // (e.g. two rapid toggles, or a toggle racing a re-subscribe) never run their
  // state-mutating bodies concurrently. A rejected fn() doesn't stall the queue.
  _enqueue(fn) {
    const prev = this._opQueue || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this._opQueue = next.catch(() => {});
    return next;
  }

  // Echo suppression window (ms) configured on the group.
  _suppressMs() {
    return this.getSetting('suppress_ms') || 2000;
  }

  // Ignore `value` echoing back from deviceId for the next suppressMs.
  _suppressDevice(deviceId, value, suppressMs) {
    const old = this._suppress.get(deviceId);
    if (old && old.timer) this.homey.clearTimeout(old.timer);

    // Only drop our own entry: a cleared map plus a newer write must keep its window.
    const timer = this.homey.setTimeout(() => {
      const current = this._suppress.get(deviceId);
      if (current && current.timer === timer) this._suppress.delete(deviceId);
    }, suppressMs);
    this._suppress.set(deviceId, { value, timer });
  }

  _isSuppressed(deviceId, value) {
    const entry = this._suppress.get(deviceId);
    return Boolean(entry && entry.value === value);
  }

  // Adds a Desync Log entry for this group; `trigger` defaults to the Health Check.
  _addSyncReport(report) {
    this.homey.app.addSyncReport({
      timestamp: new Date().toISOString(),
      group:     this.getName(),
      trigger:   this.homey.__('sync.health_check'),
      ...report,
    });
  }

  // Global app toggle (ManagerSettings) with a default for when it was never set.
  _isAppToggleOn(key, defaultValue) {
    return this.homey.app._isSettingEnabled(this.homey.settings.get(key), defaultValue);
  }

  // Debounce rapid duplicate capability callbacks. If the same device fires
  // the same value within CALLBACK_DEBOUNCE_MS, only the last one is processed.
  // If the value changes, process immediately.
  _debouncedCallback(deviceId, value, handler) {
    const last = this._lastCallbackValues.get(deviceId);
    if (last !== undefined && last !== value) {
      this._flushCallback(deviceId, value, handler);
      return;
    }
    this._lastCallbackValues.set(deviceId, value);

    const existing = this._callbackTimers.get(deviceId);
    if (existing) this.homey.clearTimeout(existing);

    const timer = this.homey.setTimeout(() => {
      this._callbackTimers.delete(deviceId);
      this._flushCallback(deviceId, value, handler);
    }, CALLBACK_DEBOUNCE_MS);

    this._callbackTimers.set(deviceId, timer);
  }

  _flushCallback(deviceId, value, handler) {
    // A value change flushes immediately; drop the older pending timer so it can't
    // fire later and deliver the stale value after this one.
    const pending = this._callbackTimers.get(deviceId);
    if (pending) this.homey.clearTimeout(pending);
    this._callbackTimers.delete(deviceId);
    this._lastCallbackValues.set(deviceId, value);
    handler(value);
  }

  // Records a failed subscribe and returns true once the device has failed twice,
  // at least GHOST_CONFIRM_GAP_MS apart — a transient API hiccup during a single
  // boot burst can't get a real device treated as deleted from Homey.
  _confirmSubscribeFailure(deviceId, now) {
    const existing = this._subscribeFailures.get(deviceId);
    if (!existing) {
      this._subscribeFailures.set(deviceId, { count: 1, firstFailAt: now });
      return false;
    }
    if (now - existing.firstFailAt < GHOST_CONFIRM_GAP_MS) return false;
    existing.count++;
    return existing.count >= 2;
  }

  // Boot health check (after a small jitter so groups don't all fire at once),
  // then a periodic safety net.
  _startHealthMonitor() {
    const check = () => this._verifyGroupHealth()
      .catch(err => this.error(`[${this.getName()}] Health check error: ${err.message}`));

    const jitter = Math.random() * 10000;
    this._healthStartTimer = this.homey.setTimeout(() => {
      this._healthStartTimer = null;
      check();
      this._healthInterval = this.homey.setInterval(check, HEALTH_INTERVAL_MS);
    }, jitter);
  }

  // Timers and maps common to both drivers; subclasses clear their own on top.
  _disposeGroupState() {
    if (this._healthStartTimer) this.homey.clearTimeout(this._healthStartTimer);
    if (this._healthInterval)   this.homey.clearInterval(this._healthInterval);

    for (const timer of this._callbackTimers.values()) this.homey.clearTimeout(timer);
    this._callbackTimers.clear();
    this._subscribeFailures.clear();
  }

}

module.exports = LinkedGroupDevice;
