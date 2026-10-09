// -----------------------------------------------------------------------------
// Builds a complete test world: fake Gladys, simulated LAN, fake Govee cloud,
// temporary /data, and the integration wired on top through registerHandlers.
// -----------------------------------------------------------------------------

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHandlers } from '../../src/app.js';
import { CloudClient } from '../../src/cloud/client.js';
import { LanClient } from '../../src/lan/client.js';
import { Store } from '../../src/store.js';
import { createFakeGladys } from './fakeGladys.js';
import { FAST_TIMINGS, createFakeNetwork } from './fakeNetwork.js';

// The integration logs every discovery; keep the test output readable
// (LOG_LEVEL is read on every log call). LOG_LEVEL=debug npm test shows them.
process.env.LOG_LEVEL ??= 'silent';

const readFixture = (path) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8'));

export const LAN_FIXTURES = readFixture('lan/devices.json').devices;
export const CLOUD_DEVICES = readFixture('cloud/devices.json');
export const CLOUD_STATES = readFixture('cloud/states.json');

/** A fetch double answering like the Govee OpenAPI, recording every call. */
export function createFakeCloud({ status = 200 } = {}) {
  const calls = [];
  const states = structuredClone(CLOUD_STATES);
  const fetch = async (url, init) => {
    const path = new URL(url).pathname.replace('/router/api/v1', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, headers: init.headers, body });
    const reply = (code, payload) => ({
      ok: code >= 200 && code < 300,
      status: code,
      json: async () => payload,
    });
    if (status !== 200) {
      return reply(status, { code: status, message: 'Unauthorized' });
    }
    if (path === '/user/devices') {
      return reply(200, CLOUD_DEVICES);
    }
    if (path === '/device/state') {
      const state = states[body.payload.sku];
      return state ? reply(200, state) : reply(400, { code: 400, msg: 'device not found' });
    }
    if (path === '/device/control') {
      const { capability } = body.payload;
      return reply(200, {
        requestId: body.requestId,
        msg: 'success',
        code: 200,
        capability: { ...capability, state: { status: 'success' } },
      });
    }
    return reply(404, { code: 404, message: 'not found' });
  };
  return { fetch, calls };
}

/**
 * @param {object} options
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.devices] LAN devices (fixture entries + replyPath)
 * @param {boolean} [options.cloud] enable the fake cloud (needs config.api_key)
 */
export async function createWorld({
  config = {},
  devices = LAN_FIXTURES,
  cloudStatus = 200,
  gladysDevices = [],
  network: networkOptions = {},
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-govee-')),
} = {}) {
  const network = createFakeNetwork({ devices, ...networkOptions });
  const gladys = createFakeGladys({
    config,
    devices: gladysDevices,
    scanNetwork: network.scanNetwork,
  });
  const cloud = createFakeCloud({ status: cloudStatus });
  const lan = new LanClient({
    scanNetwork: (type, options) => gladys.scanNetwork(type, options),
    createSocket: network.createSocket,
    timings: FAST_TIMINGS,
  });
  const app = registerHandlers(gladys, {
    lan,
    store: new Store(dataDir),
    createCloudClient: (options) => new CloudClient({ ...options, fetch: cloud.fetch }),
    timers: false,
    pauseMs: 1,
  });
  if (connect) {
    await gladys.fake.connect();
    await app.ready;
  }
  return { gladys, network, cloud, app, hub: app.hub, lan, dataDir };
}

export const addressesOf = (devices = LAN_FIXTURES) => devices.map((d) => d.ip).join(', ');

/** External id of a Govee device in the fake Gladys. */
export const deviceId = (gladys, rawId) =>
  gladys.externalIds('device', rawId.toLowerCase().replace(/[^0-9a-f]/g, '')).device;
