// -----------------------------------------------------------------------------
// In-memory stand-in for the Gladys SDK client.
//
// The published SDK (0.14.0) does not ship `createFakeGladys` yet, so this
// double reproduces the surface the integration uses, with the host API checks
// that bite most often (external id prefix, known category/type/unit, poll
// frequency, numeric states), using the feature table taken from the core.
// It records what Gladys would receive and lets tests call the handlers the way
// Gladys does.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

const table = JSON.parse(
  readFileSync(new URL('../fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

export const SELECTOR = 'test-integration';

export class FakeApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createFakeGladys({ config = {}, devices = [], scanNetwork } = {}) {
  const gladys = new EventEmitter();
  const handlers = new Map();
  const prefix = `ext:${SELECTOR}:`;

  Object.assign(gladys, {
    config: { ...config },
    devices: [...devices],
    discoveredDevices: [],
    states: [],
    transports: [],
    connectionStatuses: [],
    widgetRefreshes: [],
    scans: [],

    externalId(suffix) {
      return `${prefix}${suffix}`;
    },
    externalIds(type, platformId) {
      const device = `${prefix}${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },

    async getConfig() {
      return { ...gladys.config };
    },

    async publishDiscoveredDevices(list) {
      for (const device of list) {
        if (!device.external_id?.startsWith(prefix)) {
          throw new FakeApiError(400, `bad device external_id ${device.external_id}`);
        }
        if (
          device.poll_frequency !== undefined &&
          !table.poll_frequencies_ms.includes(device.poll_frequency)
        ) {
          throw new FakeApiError(400, 'invalid poll frequency');
        }
        for (const feature of device.features) {
          if (!feature.external_id?.startsWith(prefix)) {
            throw new FakeApiError(400, `bad feature external_id ${feature.external_id}`);
          }
          if (!table.categories.includes(feature.category) || !table.types.includes(feature.type)) {
            throw new FakeApiError(
              400,
              `unknown category/type ${feature.category}/${feature.type}`,
            );
          }
          if (feature.unit !== undefined && !table.units.includes(feature.unit)) {
            throw new FakeApiError(400, `unknown unit ${feature.unit}`);
          }
        }
      }
      gladys.discoveredDevices = structuredClone(list);
    },

    async publishStates(states) {
      for (const state of states) {
        if (!state.device_feature_external_id?.startsWith(prefix)) {
          throw new FakeApiError(400, 'bad state external id');
        }
        if (typeof state.state !== 'number' || !Number.isFinite(state.state)) {
          throw new FakeApiError(400, `state must be a number, got ${state.state}`);
        }
      }
      gladys.states.push(...structuredClone(states));
    },

    async publishTransports(entries) {
      if (entries.length < 1 || entries.length > 100) {
        throw new FakeApiError(400, 'transports: 1-100 entries');
      }
      gladys.transports.push(...structuredClone(entries));
    },

    async setConnectionStatus(connected, message) {
      gladys.connectionStatuses.push({ connected, message });
    },

    requestWidgetRefresh(key) {
      gladys.widgetRefreshes.push(key);
    },

    async scanNetwork(type, options = {}) {
      gladys.scans.push({ type, ...options });
      if (!scanNetwork) {
        throw new FakeApiError(403, 'network_discovery: capture type not declared');
      }
      return scanNetwork(type, options);
    },

    // --- Handler registration (the SDK surface) ------------------------------
    onScanRequest: (cb) => handlers.set('scan', cb),
    onSetValue: (cb) => handlers.set('setValue', cb),
    onPoll: (cb) => handlers.set('poll', cb),
    onDeviceCreated: (cb) => handlers.set('deviceCreated', cb),
    onConfigUpdated: (cb) => handlers.set('configUpdated', cb),
    onAction: (key, cb) => handlers.set(`action:${key}`, cb),
    onSceneAction: (key, cb) => handlers.set(`sceneAction:${key}`, cb),
    onWidgetGet: (key, cb) => handlers.set(`widgetGet:${key}`, cb),
    onWidgetAction: (key, cb) => handlers.set(`widgetAction:${key}`, cb),

    // --- Gladys calling the integration ---------------------------------------
    fake: {
      handlers,
      async connect() {
        await Promise.all(gladys.listeners('connected').map((listener) => listener()));
      },
      call(name, ...args) {
        const handler = handlers.get(name);
        if (!handler) {
          throw new Error(`no handler registered for ${name}`);
        }
        return handler(...args);
      },
      async createDevice(external_id) {
        const device = gladys.discoveredDevices.find((d) => d.external_id === external_id);
        gladys.devices.push(device);
        await handlers.get('deviceCreated')(device);
        return device;
      },
      lastState(featureExternalId) {
        const state = gladys.states.findLast(
          (s) => s.device_feature_external_id === featureExternalId,
        );
        return state?.state;
      },
      lastTransport(externalId) {
        return gladys.transports.findLast((t) => t.external_id === externalId);
      },
    },
  });
  return gladys;
}
