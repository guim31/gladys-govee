// The hub polls on its own timer (Gladys 5.2.0 never polls a device created
// without should_poll, GladysAssistant/Gladys#3198), the onPoll fallback does
// not double that work, and a normal cycle stays quiet in the logs.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudClient } from '../src/cloud/client.js';
import {
  LAN_FIXTURES,
  addressesOf,
  createFakeCloud,
  createWorld,
  deviceId,
} from './helpers/world.js';

const BULB = LAN_FIXTURES[0];
const API_KEY = 'secret-govee-key-0123';

const devStatusTo = (network, ip) =>
  network.sent.filter((s) => s.ip === ip && s.cmd === 'devStatus').length;

/** Capture what the SDK logger prints (info/debug on stdout, warn/error on stderr). */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const lines = [];
  const record = (...args) => lines.push(args.map(String).join(' '));
  t.mock.method(console, 'log', record);
  t.mock.method(console, 'error', record);
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}

test('the hub polls the LAN lights on its own timer, without any onPoll', async (t) => {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  const { gladys, hub, network, app } = await createWorld({
    config: { lan_addresses: addressesOf(), lan_poll_interval: '30' },
    timers: true,
  });
  try {
    assert.ok(gladys.discoveredDevices.every((d) => d.should_poll === false));
    const id = deviceId(gladys, BULB.scan.device);
    network.byIp(BULB.ip).status.brightness = 42; // changed with the Govee app

    mock.timers.tick(29_000);
    assert.equal(hub.busy.lanPoll, null, 'not before the interval');
    mock.timers.tick(1_000);
    assert.ok(hub.busy.lanPoll, 'the timer started a LAN poll');
    await hub.busy.lanPoll;
    assert.equal(gladys.fake.lastState(`${id}:brightness`), 42);
  } finally {
    await app.stop();
  }
});

test('the onPoll fallback skips a light the hub has just polled', async () => {
  const { gladys, hub, network, app } = await createWorld({
    config: { lan_addresses: addressesOf() },
  });
  try {
    const device = { external_id: deviceId(gladys, BULB.scan.device) };
    const before = devStatusTo(network, BULB.ip);
    await gladys.fake.call('poll', device);
    assert.equal(devStatusTo(network, BULB.ip), before, 'polled at start-up: nothing sent');

    // Later than the interval (the hub's timer would have run otherwise).
    hub.entryByExternalId(device.external_id).lastLanPoll -= 31_000;
    network.byIp(BULB.ip).status.brightness = 55;
    await gladys.fake.call('poll', device);
    assert.equal(devStatusTo(network, BULB.ip), before + 1);
    assert.equal(gladys.fake.lastState(`${device.external_id}:brightness`), 55);
  } finally {
    await app.stop();
  }
});

test('a normal cycle writes nothing at info level, and never the API key', async (t) => {
  const lines = captureLogs(t);
  const { hub, network, app } = await createWorld({
    config: { lan_addresses: addressesOf(), api_key: API_KEY },
  });
  try {
    const startup = lines.length;
    network.byIp(BULB.ip).status.brightness = 12; // a state change is a normal cycle too
    await hub.pollLan();
    await hub.pollCloud();
    await hub.discover();
    await hub.pollLan();
    assert.deepEqual(lines.slice(startup), []);
    assert.ok(lines.every((line) => !line.includes(API_KEY)));
  } finally {
    await app.stop();
  }
});

test('a repeated cloud failure is logged once, then its recovery once', async (t) => {
  const lines = captureLogs(t, 'info');
  const { hub, app } = await createWorld({
    config: { lan_addresses: addressesOf(), api_key: API_KEY },
    cloudStatus: 500,
  });
  try {
    await hub.pollCloud();
    await hub.pollCloud();
    await hub.pollCloud();
    const failures = lines.filter((line) => line.includes('Cloud device list failed'));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /\[WARN\]/);

    hub.cloud = new CloudClient({ apiKey: API_KEY, fetch: createFakeCloud().fetch });
    await hub.pollCloud();
    await hub.pollCloud();
    assert.equal(lines.filter((line) => line.includes('available again')).length, 1);
    assert.ok(lines.every((line) => !line.includes(API_KEY)));
  } finally {
    await app.stop();
  }
});
