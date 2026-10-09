// -----------------------------------------------------------------------------
// The Govee hub: the registry of known devices, discovery (LAN scan + cloud
// listing), state polling, and the routing of every command to the LAN or the
// cloud. index.js only wires it to the SDK.
//
// Registry entry: {
//   id        normalized Govee id (lowercase hex), the external id suffix
//   rawId     the id as Govee writes it ("1F:80:C5:...")
//   sku       model, e.g. "H6008"
//   lan       true once a LAN scan saw the device (it speaks the LAN API)
//   ip        its current IP (LAN devices)
//   cloud     { type, name, capabilities } when the cloud API lists it
// }
// Runtime only: lastLanReply, lanMisses, cloudOnline, lastCloudPoll, and mode
// ('white' | 'color' | 'scene', with `scene`) for the presets widget.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { CloudClient, POLL_BUDGET } from './cloud/client.js';
import {
  DEVICE_TYPE,
  FEATURE_KEYS,
  buildDevice,
  cloudCommand,
  cloudStateToValues,
  featureKeyOf,
  featureSpecs,
  hasCloud,
  hasLan,
  lanCapabilities,
  lanStatusToValues,
} from './features.js';
import {
  COMMAND_PORT,
  SCAN_PORT,
  brightnessMessage,
  colorMessage,
  devStatusMessage,
  kelvinMessage,
  normalizeDeviceId,
  parseScanReply,
  parseStatusReply,
  sceneMessage,
  scanMessage,
  turnMessage,
} from './lan/protocol.js';

export const PRESETS_WIDGET = 'light_presets';

const LAN_MISSES_BEFORE_UNREACHABLE = 3;
const DISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
const CLOUD_LIST_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLOUD_TICK_MS = 60 * 1000;
const REFRESH_AFTER_COMMAND_MS = 1000;
const MAX_TRANSPORTS_PER_REQUEST = 100;

const NOT_ON_LAN = {
  en: 'Local control preferred, but the light does not answer on the LAN: using the cloud.',
  fr: 'Contrôle local préféré, mais la lampe ne répond pas sur le réseau local : passage par le cloud.',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GoveeHub {
  /**
   * @param {object} options
   * @param {object} options.gladys the SDK client
   * @param {import('./lan/client.js').LanClient} options.lan
   * @param {import('./store.js').Store} options.store
   * @param {(options: object) => CloudClient} [options.createCloudClient]
   * @param {() => number} [options.now]
   * @param {boolean} [options.timers] schedule the background loops (off in tests)
   * @param {number} [options.pauseMs] pause between the identify blinks
   */
  constructor({ gladys, lan, store, createCloudClient, now, timers = true, pauseMs = 600 }) {
    this.gladys = gladys;
    this.lan = lan;
    this.store = store;
    this.createCloudClient = createCloudClient ?? ((options) => new CloudClient(options));
    this.now = now ?? Date.now;
    this.timersEnabled = timers;
    this.pauseMs = pauseMs;
    this.logger = createLogger({ name: 'govee' });
    this.entries = new Map();
    this.values = new Map(); // id -> { featureKey: value }
    this.published = new Map(); // feature external id -> last value Gladys accepted
    this.publishedTransports = new Map(); // device external id -> JSON of the entry
    this.refreshTimers = new Map();
    this.timers = [];
    this.cloud = null;
    this.cloudError = null;
    this.lastCloudList = 0;
    this.cloudUsage = undefined;
    this.config = null;
    this.busy = { discovery: null, lanPoll: null, cloudPoll: null };
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    for (const entry of Array.isArray(saved.devices) ? saved.devices : []) {
      this.upsert(entry);
    }
    this.cloudUsage = saved.cloudUsage;
    this.seedFromGladysDevices();
    await this.lan.start();
    this.applyConfig(config);
    await this.discover();
    await this.pollLan();
    await this.pollCloud();
    this.schedule();
  }

  stop() {
    for (const timer of [...this.timers, ...this.refreshTimers.values()]) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers = [];
    this.refreshTimers.clear();
    this.lan.stop();
  }

  /** Apply a (new) configuration. Returns true when the cloud client changed. */
  applyConfig(config) {
    const previous = this.config;
    this.config = config;
    if (previous?.apiKey === config.apiKey && (this.cloud !== null) === Boolean(config.apiKey)) {
      return false;
    }
    this.cloud = config.apiKey
      ? this.createCloudClient({
          apiKey: config.apiKey,
          usage: this.cloud?.usage ?? this.cloudUsage,
        })
      : null;
    this.cloudError = null;
    this.lastCloudList = 0;
    return true;
  }

  async reconfigure(config) {
    const previous = this.config;
    const cloudChanged = this.applyConfig(config);
    if (previous && previous.lanPollSeconds !== config.lanPollSeconds) {
      this.schedule();
    }
    if (cloudChanged || previous?.lanAddresses !== config.lanAddresses) {
      await this.discover();
      await this.pollLan();
      await this.pollCloud();
    } else {
      // Names (language) or the transport preference may have changed.
      await this.publishDevices();
      await this.publishTransports();
    }
  }

  schedule() {
    if (!this.timersEnabled) {
      return;
    }
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    const background = (fn) => () => fn().catch((err) => this.logger.error(err.message));
    this.timers = [
      setInterval(
        background(() => this.pollLan()),
        this.config.lanPollSeconds * 1000,
      ),
      setInterval(
        background(() => this.discover()),
        DISCOVERY_INTERVAL_MS,
      ),
      setInterval(
        background(() => this.pollCloud()),
        CLOUD_TICK_MS,
      ),
    ];
  }

  // --- Registry --------------------------------------------------------------

  upsert(data) {
    const id = normalizeDeviceId(data.id ?? data.rawId);
    if (!id || typeof data.sku !== 'string' || data.sku.length === 0) {
      return null;
    }
    const entry = this.entries.get(id) ?? { id, lanMisses: 0 };
    entry.sku = data.sku.toUpperCase();
    if (data.rawId) {
      entry.rawId = data.rawId;
    }
    if (data.lan === true) {
      entry.lan = true;
    }
    if (typeof data.ip === 'string' && data.ip) {
      // An IP belongs to one device: a replaced bulb or a DHCP shuffle must
      // not route the answers of one light to another.
      for (const other of this.entries.values()) {
        if (other.id !== id && other.ip === data.ip) {
          other.ip = undefined;
        }
      }
      entry.ip = data.ip;
    }
    if (data.cloud) {
      entry.cloud = data.cloud;
    }
    this.entries.set(id, entry);
    return entry;
  }

  // Devices the user already created carry their SKU and last IP as params:
  // they are known before the first scan answers.
  seedFromGladysDevices() {
    const prefix = this.deviceExternalId('');
    for (const device of this.gladys.devices ?? []) {
      if (typeof device?.external_id !== 'string' || !device.external_id.startsWith(prefix)) {
        continue;
      }
      const params = Object.fromEntries(
        (device.params ?? []).map((param) => [param.name, param.value]),
      );
      const id = device.external_id.slice(prefix.length);
      const known = this.entries.get(normalizeDeviceId(id));
      this.upsert({
        id,
        rawId: params.GOVEE_DEVICE_ID,
        sku: params.GOVEE_SKU ?? device.model,
        ip: known?.ip ? undefined : params.IP_ADDRESS,
        lan: Boolean(params.IP_ADDRESS) || undefined,
      });
    }
  }

  persist() {
    const devices = [...this.entries.values()].map(({ id, rawId, sku, lan, ip, cloud }) => ({
      id,
      rawId,
      sku,
      lan,
      ip,
      cloud,
    }));
    return this.store.save({ devices, cloudUsage: this.cloud?.usage ?? this.cloudUsage });
  }

  deviceExternalId(id) {
    return this.gladys.externalIds(DEVICE_TYPE, id).device;
  }

  entryByExternalId(externalId) {
    const prefix = this.deviceExternalId('');
    if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
      return null;
    }
    return this.entries.get(externalId.slice(prefix.length)) ?? null;
  }

  lanReachable(entry) {
    return (
      hasLan(entry) &&
      Boolean(entry.ip) &&
      entry.lastLanReply !== undefined &&
      entry.lanMisses < LAN_MISSES_BEFORE_UNREACHABLE
    );
  }

  /**
   * Which channel drives the device now, and the badge Gladys shows for it.
   * The local preference is a wish: a light silent on the LAN goes through the
   * cloud when it can, flagged degraded so the user knows why.
   */
  route(entry) {
    const lan = hasLan(entry);
    const lanOk = this.lanReachable(entry);
    const cloudOk = Boolean(this.cloud) && hasCloud(entry) && entry.cloudOnline !== false;
    if (lanOk && (this.config.preferLocal || !cloudOk)) {
      return { use: 'lan', transport: 'local' };
    }
    if (cloudOk) {
      return lan && this.config.preferLocal
        ? { use: 'cloud', transport: 'cloud', degraded: true, message: NOT_ON_LAN }
        : { use: 'cloud', transport: 'cloud' };
    }
    if (lan && entry.ip) {
      // Silent on the LAN, no cloud: commands are still sent (a datagram costs
      // nothing, and the light may only fail to answer), the badge says it.
      return { use: 'lan', transport: 'unreachable' };
    }
    return { use: null, transport: 'unreachable' };
  }

  // --- Discovery -------------------------------------------------------------

  discover({ forceCloud = false } = {}) {
    return this.once('discovery', async () => {
      const lanFound = await this.scanLan();
      await this.listCloud(forceCloud);
      await this.publishDevices();
      await this.publishTransports();
      await this.reportConnection(lanFound);
      this.persist();
      return lanFound;
    });
  }

  async scanLan() {
    const targets = new Set(this.config.addresses.addresses);
    for (const entry of this.entries.values()) {
      if (hasLan(entry) && entry.ip) {
        targets.add(entry.ip);
      }
    }
    const payload = scanMessage();
    const replies = await this.lan.exchange(
      [...targets].map((ip) => ({ ip, port: SCAN_PORT, payload })),
      { cmd: 'scan', multicast: payload, expectAll: false },
    );
    let found = 0;
    for (const [sourceIp, data] of replies) {
      const reply = parseScanReply(data, sourceIp);
      if (!reply) {
        continue;
      }
      const isNew = !this.entries.get(reply.id)?.lan;
      const entry = this.upsert({ ...reply, lan: true });
      // Answering a scan is answering on the LAN.
      entry.lastLanReply = this.now();
      entry.lanMisses = 0;
      found += 1;
      if (isNew) {
        const caps = lanCapabilities(entry);
        this.logger.info(
          `Found ${entry.sku} at ${entry.ip}` +
            (caps.known ? '' : ' (model not in the table yet: all light features exposed)'),
        );
      }
    }
    return found;
  }

  async listCloud(force) {
    if (!this.cloud || (!force && this.now() - this.lastCloudList < CLOUD_LIST_INTERVAL_MS)) {
      return;
    }
    try {
      const devices = await this.cloud.listDevices();
      this.lastCloudList = this.now();
      this.cloudError = null;
      for (const device of devices) {
        this.upsert({
          id: device?.device,
          rawId: device?.device,
          sku: device?.sku,
          cloud: {
            type: device?.type,
            name: device?.deviceName,
            capabilities: Array.isArray(device?.capabilities) ? device.capabilities : [],
          },
        });
      }
    } catch (err) {
      this.cloudError = err;
      this.logger.warn(`Cloud device list failed: ${err.message}`);
    }
  }

  async publishDevices() {
    const devices = [...this.entries.values()].map((entry) =>
      buildDevice(this.gladys, entry, this.config.language),
    );
    await this.gladys.publishDiscoveredDevices(devices);
  }

  async publishTransports({ only, force = false } = {}) {
    const entries = [];
    for (const entry of this.entries.values()) {
      if (only && entry.id !== only) {
        continue;
      }
      const { use: _use, ...badge } = this.route(entry);
      const transport = { external_id: this.deviceExternalId(entry.id), ...badge };
      const serialized = JSON.stringify(transport);
      if (!force && this.publishedTransports.get(transport.external_id) === serialized) {
        continue;
      }
      entries.push({ transport, serialized });
    }
    for (let i = 0; i < entries.length; i += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(i, i + MAX_TRANSPORTS_PER_REQUEST);
      await this.gladys.publishTransports(batch.map((item) => item.transport));
      for (const item of batch) {
        this.publishedTransports.set(item.transport.external_id, item.serialized);
      }
    }
  }

  async reportConnection(lanFound) {
    if (this.cloudError?.status === 401 || this.cloudError?.status === 403) {
      await this.gladys.setConnectionStatus(false, {
        en: 'Govee API key refused: check it in the configuration.',
        fr: 'Clé d’API Govee refusée : vérifiez-la dans la configuration.',
      });
      return;
    }
    if (this.entries.size === 0 && lanFound === 0) {
      await this.gladys.setConnectionStatus(false, {
        en: 'No Govee device found yet: enter the IP addresses of your lights (LAN Control on).',
        fr: 'Aucun appareil Govee trouvé : saisissez les adresses IP de vos lampes (Contrôle LAN activé).',
      });
      return;
    }
    await this.gladys.setConnectionStatus(true);
  }

  // --- States ----------------------------------------------------------------

  /** One devStatus exchange for every LAN light (or the given ones). */
  pollLan(only) {
    const run = async () => {
      const entries = (only ?? [...this.entries.values()]).filter(
        (entry) => hasLan(entry) && entry.ip,
      );
      if (entries.length === 0) {
        return;
      }
      const payload = devStatusMessage();
      const replies = await this.lan.exchange(
        entries.map((entry) => ({ ip: entry.ip, port: COMMAND_PORT, payload })),
        { cmd: 'devStatus' },
      );
      let changed = false;
      for (const entry of entries) {
        const data = replies.get(entry.ip);
        const wasReachable = this.lanReachable(entry);
        if (!data) {
          entry.lanMisses += 1;
        } else {
          entry.lanMisses = 0;
          entry.lastLanReply = this.now();
          const status = parseStatusReply(data);
          this.trackMode(entry, status);
          const values = lanStatusToValues(entry, status, this.config.language);
          changed = (await this.publishValues(entry, values)) || changed;
        }
        if (wasReachable !== this.lanReachable(entry)) {
          changed = true;
          const fallback = this.route(entry).use === 'cloud' ? ', using the cloud' : '';
          this.logger.info(
            wasReachable
              ? `${entry.sku} at ${entry.ip} stopped answering on the LAN${fallback}`
              : `${entry.sku} at ${entry.ip} answers on the LAN`,
          );
        }
      }
      await this.publishTransports();
      if (changed) {
        this.gladys.requestWidgetRefresh(PRESETS_WIDGET);
      }
    };
    // The periodic poll skips a round while one runs; a targeted refresh waits.
    return only ? run() : this.once('lanPoll', run);
  }

  /**
   * Cloud polls of the devices the cloud drives, spread so the whole fleet
   * stays within the daily budget whatever the configured interval.
   */
  pollCloud() {
    return this.once('cloudPoll', async () => {
      if (!this.cloud) {
        return;
      }
      await this.listCloud(false);
      const due = [...this.entries.values()].filter(
        (entry) => hasCloud(entry) && this.route(entry).use !== 'lan',
      );
      if (due.length === 0) {
        return;
      }
      const intervalMs = this.cloudPollIntervalMs(due.length);
      let changed = false;
      for (const entry of due) {
        if (entry.lastCloudPoll !== undefined && this.now() - entry.lastCloudPoll < intervalMs) {
          continue;
        }
        entry.lastCloudPoll = this.now();
        try {
          const capabilities = await this.cloud.getState(
            { sku: entry.sku, device: entry.rawId ?? entry.id },
            { automatic: true },
          );
          const { values, online } = cloudStateToValues(entry, capabilities, this.config.language);
          if (online !== undefined) {
            changed = changed || entry.cloudOnline !== online;
            entry.cloudOnline = online;
          }
          changed = (await this.publishValues(entry, values)) || changed;
        } catch (err) {
          if (err.code === 'BUDGET') {
            // Once a day in the logs, not once a minute until midnight UTC.
            const today = new Date(this.now()).toISOString().slice(0, 10);
            if (this.budgetWarnedOn !== today) {
              this.budgetWarnedOn = today;
              this.logger.warn(err.message);
            }
            break;
          }
          this.logger.warn(`Cloud state of ${entry.sku} failed: ${err.message}`);
        }
      }
      await this.publishTransports();
      if (changed) {
        this.gladys.requestWidgetRefresh(PRESETS_WIDGET);
      }
      this.persist();
    });
  }

  // A running scene reports itself as colour mode: keep showing the scene
  // until a white light is reported or another command is sent.
  trackMode(entry, status) {
    if (status.kelvin === undefined) {
      return;
    }
    if (status.kelvin) {
      entry.mode = 'white';
    } else if (entry.mode !== 'scene') {
      entry.mode = 'color';
    }
  }

  cloudPollIntervalMs(deviceCount) {
    const configured = this.config.cloudPollMinutes;
    const minimum = Math.ceil((deviceCount * 24 * 60) / POLL_BUDGET);
    return Math.max(configured, minimum) * 60 * 1000;
  }

  /**
   * Publish the values that changed (or all of them with `force`), and keep
   * them as the device's current state. Returns true when something was sent.
   */
  async publishValues(entry, values, { force = false } = {}) {
    const current = { ...this.values.get(entry.id), ...values };
    this.values.set(entry.id, current);
    const ids = this.gladys.externalIds(DEVICE_TYPE, entry.id);
    const states = [];
    for (const [key, value] of Object.entries(force ? current : values)) {
      const featureExternalId = ids.feature(key);
      if (force || this.published.get(featureExternalId) !== value) {
        states.push({ device_feature_external_id: featureExternalId, state: value });
      }
    }
    if (states.length === 0) {
      return false;
    }
    await this.gladys.publishStates(states);
    for (const { device_feature_external_id: id, state } of states) {
      this.published.set(id, state);
    }
    return true;
  }

  /**
   * Gladys created a device from the Discovery screen: the states it received
   * before were dropped (no feature yet), and so was its transport badge.
   */
  async onDeviceCreated(device) {
    const entry = this.entryByExternalId(device?.external_id);
    if (!entry) {
      return;
    }
    await this.publishValues(entry, {}, { force: true });
    await this.publishTransports({ only: entry.id, force: true });
    this.gladys.requestWidgetRefresh(PRESETS_WIDGET);
    if (hasLan(entry)) {
      this.scheduleRefresh(entry, 0);
    }
  }

  scheduleRefresh(entry, delay = REFRESH_AFTER_COMMAND_MS) {
    clearTimeout(this.refreshTimers.get(entry.id));
    this.refreshTimers.set(
      entry.id,
      setTimeout(() => {
        this.refreshTimers.delete(entry.id);
        this.pollLan([entry]).catch((err) => this.logger.warn(`Refresh failed: ${err.message}`));
      }, delay),
    );
  }

  // --- Commands --------------------------------------------------------------

  /** Gladys asks to set a feature (dashboard, scene, voice...). */
  async setValue(device, feature, value) {
    const entry = this.entryByExternalId(device?.external_id);
    if (!entry) {
      throw new Error(`Unknown Govee device ${device?.external_id}`);
    }
    const key = featureKeyOf(this.gladys, entry, feature?.external_id ?? '');
    const spec = featureSpecs(entry, this.config.language).find((s) => s.key === key);
    if (!spec) {
      throw new Error(`Unknown feature ${feature?.external_id}`);
    }
    const route = this.route(entry);
    let values;
    if (spec.lan && route.use === 'lan') {
      values = await this.lanCommand(entry, spec, Number(value));
      this.scheduleRefresh(entry);
    } else if (spec.cloud && this.cloud && hasCloud(entry)) {
      values = await this.cloudCommand(entry, spec, Number(value));
    } else if (spec.lan && entry.ip) {
      values = await this.lanCommand(entry, spec, Number(value));
      this.scheduleRefresh(entry);
    } else if (spec.cloud) {
      throw new Error('This feature needs the Govee API key (cloud)');
    } else {
      throw new Error('The device is not reachable: no IP address known yet');
    }
    if (values[FEATURE_KEYS.COLOR] !== undefined) {
      entry.mode = 'color';
    } else if (values[FEATURE_KEYS.COLOR_TEMPERATURE] !== undefined) {
      entry.mode = 'white';
    }
    // Optimistic: the follow-up status (LAN) or the next poll (cloud) confirms.
    await this.publishValues(entry, values);
    this.gladys.requestWidgetRefresh(PRESETS_WIDGET);
  }

  async lanCommand(entry, spec, value) {
    const state = this.values.get(entry.id) ?? {};
    const turnOnFirst = async () => {
      if (state[FEATURE_KEYS.POWER] !== 1) {
        await this.lan.send(entry.ip, turnMessage(true));
      }
    };
    switch (spec.key) {
      case FEATURE_KEYS.POWER:
        await this.lan.send(entry.ip, turnMessage(value === 1));
        return { [FEATURE_KEYS.POWER]: value === 1 ? 1 : 0 };
      case FEATURE_KEYS.BRIGHTNESS:
        if (value <= 0) {
          await this.lan.send(entry.ip, turnMessage(false));
          return { [FEATURE_KEYS.POWER]: 0 };
        }
        await turnOnFirst();
        await this.lan.send(entry.ip, brightnessMessage(value));
        return {
          [FEATURE_KEYS.POWER]: 1,
          [FEATURE_KEYS.BRIGHTNESS]: Math.min(100, Math.round(value)),
        };
      case FEATURE_KEYS.COLOR:
        await turnOnFirst();
        await this.lan.send(entry.ip, colorMessage(value));
        return { [FEATURE_KEYS.POWER]: 1, [FEATURE_KEYS.COLOR]: Math.round(value) };
      case FEATURE_KEYS.COLOR_TEMPERATURE: {
        const kelvin = Math.round(Math.max(spec.min, Math.min(spec.max, value)));
        await turnOnFirst();
        await this.lan.send(entry.ip, kelvinMessage(kelvin, [spec.min, spec.max]));
        return { [FEATURE_KEYS.POWER]: 1, [FEATURE_KEYS.COLOR_TEMPERATURE]: kelvin };
      }
      default:
        throw new Error(`No LAN command for ${spec.key}`);
    }
  }

  async cloudCommand(entry, spec, value) {
    const target = { sku: entry.sku, device: entry.rawId ?? entry.id };
    if (spec.key === FEATURE_KEYS.BRIGHTNESS && value <= 0) {
      const power = featureSpecs(entry, this.config.language).find(
        (s) => s.key === FEATURE_KEYS.POWER && s.cloud,
      );
      if (power) {
        await this.cloud.control(target, cloudCommand(power, 0));
        return { [FEATURE_KEYS.POWER]: 0 };
      }
    }
    const capability = cloudCommand(spec, value);
    await this.cloud.control(target, capability);
    return { [spec.key]: capability.value };
  }

  /** Run a built-in Govee scene (LAN lights that support them). */
  async applyScene(externalId, scene) {
    const entry = this.entryByExternalId(externalId);
    if (!entry || !hasLan(entry) || !entry.ip) {
      throw new Error('Scenes need a Govee light reachable on the LAN');
    }
    if (!lanCapabilities(entry).scenes) {
      throw new Error(`The ${entry.sku} has no known built-in scenes`);
    }
    const message = sceneMessage(scene);
    if ((this.values.get(entry.id) ?? {})[FEATURE_KEYS.POWER] !== 1) {
      await this.lan.send(entry.ip, turnMessage(true));
      await this.publishValues(entry, { [FEATURE_KEYS.POWER]: 1 });
    }
    await this.lan.send(entry.ip, message);
    entry.mode = 'scene';
    entry.scene = scene;
    this.gladys.requestWidgetRefresh(PRESETS_WIDGET);
    this.scheduleRefresh(entry);
  }

  /** Drive one feature by key, through the normal command path. */
  async setFeature(externalId, key, value) {
    const entry = this.entryByExternalId(externalId);
    if (!entry) {
      throw new Error(`Unknown Govee device ${externalId}`);
    }
    const ids = this.gladys.externalIds(DEVICE_TYPE, entry.id);
    await this.setValue({ external_id: ids.device }, { external_id: ids.feature(key) }, value);
  }

  /**
   * Make a device blink twice, then restore its power state. Resolves false
   * when the device has no power feature.
   */
  async identify(externalId) {
    const entry = this.entryByExternalId(externalId);
    if (!entry) {
      return false;
    }
    const hasPower = featureSpecs(entry, this.config.language).some(
      (spec) => spec.key === FEATURE_KEYS.POWER,
    );
    if (!hasPower) {
      return false;
    }
    const wasOn = (this.values.get(entry.id) ?? {})[FEATURE_KEYS.POWER] === 1;
    for (const on of [!wasOn, wasOn, !wasOn, wasOn]) {
      await this.setFeature(externalId, FEATURE_KEYS.POWER, on ? 1 : 0);
      await sleep(this.pauseMs);
    }
    return true;
  }

  // --- Helpers ---------------------------------------------------------------

  // Runs `fn` unless the same job is already running, in which case the
  // caller shares its result (no overlapping scans or polls).
  once(name, fn) {
    if (!this.busy[name]) {
      this.busy[name] = Promise.resolve()
        .then(fn)
        .finally(() => {
          this.busy[name] = null;
        });
    }
    return this.busy[name];
  }

  /** Data for the diagnostics action and the widget. */
  summary() {
    const entries = [...this.entries.values()];
    return {
      lan: entries.filter(hasLan).length,
      lanReachable: entries.filter((entry) => this.lanReachable(entry)).length,
      cloud: entries.filter(hasCloud).length,
      cloudCallsToday: this.cloud?.callsToday() ?? 0,
      cloudError: this.cloudError?.message ?? null,
      addresses: this.config.addresses,
      network: this.lan.describe(),
    };
  }

  entriesList() {
    return [...this.entries.values()];
  }

  valuesOf(entry) {
    return this.values.get(entry.id) ?? {};
  }
}
