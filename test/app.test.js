// The integration end to end, through the handlers Gladys calls: discovery,
// states, commands, LAN/cloud routing, persistence. Simulated LAN and cloud.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LAN_FIXTURES, addressesOf, createWorld, deviceId } from './helpers/world.js';

const BULB = LAN_FIXTURES[0]; // H6008, on, red, 80 %
const FLOOR_LAMP = LAN_FIXTURES[1]; // H6076, off, 4000 K, cloud too
const STRING_LIGHTS = LAN_FIXTURES[4]; // H7012, brightness only, no scenes
const PLUG = '1A:2B:3C:4D:5E:6F:70:11';
const THERMOMETER = '1A:2B:3C:4D:5E:6F:70:12';
const HUMIDIFIER = '1A:2B:3C:4D:5E:6F:70:13';
const LIGHT_BAR = '1A:2B:3C:4D:5E:6F:70:14';

const lanConfig = { lan_addresses: addressesOf() };
const cloudConfig = { lan_addresses: addressesOf(), api_key: 'test-key' };

const feature = (gladys, rawId, key) => `${deviceId(gladys, rawId)}:${key}`;
const setValue = (gladys, rawId, key, value) =>
  gladys.fake.call(
    'setValue',
    { external_id: deviceId(gladys, rawId) },
    { external_id: feature(gladys, rawId, key) },
    value,
  );
const fakeDevice = (network, fixture) => network.byIp(fixture.ip);
const sentTo = (network, ip, cmd) => network.sent.filter((s) => s.ip === ip && s.cmd === cmd);

test('LAN discovery publishes the lights and their state', async () => {
  const { gladys, app } = await createWorld({ config: lanConfig });
  try {
    assert.equal(gladys.discoveredDevices.length, LAN_FIXTURES.length);
    const bulb = gladys.discoveredDevices.find((d) => d.model === 'H6008');
    assert.equal(bulb.external_id, deviceId(gladys, BULB.scan.device));
    assert.deepEqual(bulb.params.find((p) => p.name === 'IP_ADDRESS').value, BULB.ip);
    assert.equal(bulb.should_poll, false);

    const id = BULB.scan.device;
    assert.equal(gladys.fake.lastState(feature(gladys, id, 'power')), 1);
    assert.equal(gladys.fake.lastState(feature(gladys, id, 'brightness')), 80);
    assert.equal(gladys.fake.lastState(feature(gladys, id, 'color')), 0xff0000);
    // Colour mode: no white tone published.
    assert.equal(gladys.fake.lastState(feature(gladys, id, 'color-temperature')), undefined);
    assert.equal(
      gladys.fake.lastState(feature(gladys, FLOOR_LAMP.scan.device, 'color-temperature')),
      4000,
    );

    assert.deepEqual(gladys.connectionStatuses.at(-1), { connected: true, message: undefined });
    assert.equal(gladys.fake.lastTransport(deviceId(gladys, id)).transport, 'local');
  } finally {
    app.stop();
  }
});

test('only changed values are published again', async () => {
  const { gladys, hub, network, app } = await createWorld({ config: lanConfig });
  try {
    const count = gladys.states.length;
    await hub.pollLan();
    assert.equal(gladys.states.length, count, 'nothing changed, nothing sent');

    fakeDevice(network, BULB).status.brightness = 20; // changed with the Govee app
    await hub.pollLan();
    assert.deepEqual(gladys.states.slice(count), [
      { device_feature_external_id: feature(gladys, BULB.scan.device, 'brightness'), state: 20 },
    ]);
    assert.ok(gladys.widgetRefreshes.includes('light_presets'));
  } finally {
    app.stop();
  }
});

test('a created device gets every known state again, its badge, and a widget refresh', async () => {
  const { gladys, app } = await createWorld({ config: lanConfig });
  try {
    const count = gladys.states.length;
    const refreshes = gladys.widgetRefreshes.length;
    const externalId = deviceId(gladys, BULB.scan.device);
    const transports = gladys.transports.length;
    await gladys.fake.createDevice(externalId);
    const resent = gladys.states.slice(count).map((s) => s.device_feature_external_id);
    assert.deepEqual(
      resent.sort(),
      ['brightness', 'color', 'power'].map((k) => `${externalId}:${k}`),
    );
    assert.equal(gladys.transports.length, transports + 1);
    assert.equal(gladys.transports.at(-1).external_id, externalId);
    assert.ok(gladys.widgetRefreshes.length > refreshes);
  } finally {
    app.stop();
  }
});

test('LAN commands reach the light and its answer confirms them', async () => {
  const { gladys, hub, network, app } = await createWorld({ config: lanConfig });
  try {
    const lamp = fakeDevice(network, FLOOR_LAMP);
    const id = FLOOR_LAMP.scan.device;
    // The lamp is off: a white tone turns it on first, clamped to 2700-6500 K.
    await setValue(gladys, id, 'color-temperature', 2000);
    assert.equal(lamp.status.onOff, 1);
    assert.equal(lamp.status.colorTemInKelvin, 2700);
    assert.equal(gladys.fake.lastState(feature(gladys, id, 'color-temperature')), 2700);
    assert.equal(gladys.fake.lastState(feature(gladys, id, 'power')), 1);
    assert.deepEqual(
      sentTo(network, FLOOR_LAMP.ip, 'turn').map((s) => [s.port, s.data.value]),
      [[4003, 1]],
    );

    await setValue(gladys, id, 'color', 0x00ff80);
    assert.deepEqual(lamp.status.color, { r: 0, g: 255, b: 128 });
    assert.equal(lamp.status.colorTemInKelvin, 0);

    await setValue(gladys, id, 'brightness', 35);
    assert.equal(lamp.status.brightness, 35);

    // 0 % is "off" in Gladys; Govee's brightness starts at 1.
    await setValue(gladys, id, 'brightness', 0);
    assert.equal(lamp.status.onOff, 0);
    assert.equal(lamp.status.brightness, 35);

    await setValue(gladys, id, 'power', 1);
    assert.equal(lamp.status.onOff, 1);

    // The follow-up devStatus confirms the state (1 s after the last command).
    await hub.pollLan([hub.entryByExternalId(deviceId(gladys, id))]);
    assert.equal(gladys.fake.lastState(feature(gladys, id, 'color')), 0x00ff80);
  } finally {
    app.stop();
  }
});

test('commands on unknown devices or features fail clearly', async () => {
  const { gladys, app } = await createWorld({ config: lanConfig });
  try {
    await assert.rejects(
      setValue(gladys, '00:00:00:00:00:00:00:99', 'power', 1),
      /Unknown Govee device/,
    );
    // Cloud-only features do not exist without the API key.
    await assert.rejects(
      setValue(gladys, FLOOR_LAMP.scan.device, 'toggle-gradient', 1),
      /Unknown feature/,
    );
  } finally {
    app.stop();
  }
});

test('cloud: devices without LAN control, sensors in their native unit, offline badge', async () => {
  const { gladys, cloud, app } = await createWorld({ config: cloudConfig });
  try {
    const names = gladys.discoveredDevices.map((d) => d.name);
    assert.ok(names.includes('Coffee maker plug'));
    assert.ok(names.includes('Living room floor lamp'), 'the cloud name wins over "Govee H6076"');
    assert.equal(gladys.fake.lastState(feature(gladys, PLUG, 'power')), 1);
    assert.equal(gladys.fake.lastState(feature(gladys, THERMOMETER, 'temperature')), 68.36);
    assert.equal(gladys.fake.lastState(feature(gladys, THERMOMETER, 'humidity')), 47.2);
    const thermometer = gladys.discoveredDevices.find((d) => d.model === 'H5179');
    assert.equal(thermometer.features[0].unit, 'fahrenheit');
    assert.equal(gladys.fake.lastState(feature(gladys, LIGHT_BAR, 'color-temperature')), 3000);
    assert.equal(gladys.fake.lastTransport(deviceId(gladys, HUMIDIFIER)).transport, 'unreachable');
    assert.equal(gladys.fake.lastTransport(deviceId(gladys, PLUG)).transport, 'cloud');

    // The LAN floor lamp answers locally: the cloud never polls it.
    const polled = cloud.calls
      .filter((c) => c.path === '/device/state')
      .map((c) => c.body.payload.sku);
    assert.ok(!polled.includes('H6076'));
    assert.equal(cloud.calls[0].headers['Govee-API-Key'], 'test-key');
  } finally {
    app.stop();
  }
});

test('cloud commands: power, brightness 0, toggles of a LAN light', async () => {
  const { gladys, cloud, app } = await createWorld({ config: cloudConfig });
  try {
    await setValue(gladys, PLUG, 'power', 0);
    const control = () =>
      cloud.calls.filter((c) => c.path === '/device/control').at(-1).body.payload;
    assert.deepEqual(control(), {
      sku: 'H5080',
      device: PLUG,
      capability: { type: 'devices.capabilities.on_off', instance: 'powerSwitch', value: 0 },
    });
    assert.equal(gladys.fake.lastState(feature(gladys, PLUG, 'power')), 0);

    await setValue(gladys, LIGHT_BAR, 'brightness', 0);
    assert.equal(control().capability.instance, 'powerSwitch');
    await setValue(gladys, LIGHT_BAR, 'brightness', 55);
    assert.deepEqual(control().capability, {
      type: 'devices.capabilities.range',
      instance: 'brightness',
      value: 55,
    });

    // The gradient toggle of the floor lamp only exists in the cloud API.
    await setValue(gladys, FLOOR_LAMP.scan.device, 'toggle-gradient', 1);
    assert.deepEqual(control().capability, {
      type: 'devices.capabilities.toggle',
      instance: 'gradientToggle',
      value: 1,
    });
  } finally {
    app.stop();
  }
});

test('a light silent on the LAN falls back to the cloud, flagged degraded', async () => {
  const devices = LAN_FIXTURES.map((d) => ({ ...d }));
  const { gladys, hub, network, cloud, app } = await createWorld({ config: cloudConfig, devices });
  try {
    const lampId = deviceId(gladys, FLOOR_LAMP.scan.device);
    assert.equal(gladys.fake.lastTransport(lampId).transport, 'local');
    fakeDevice(network, FLOOR_LAMP).replyPath = 'none';
    for (let i = 0; i < 3; i += 1) {
      await hub.pollLan();
    }
    const badge = gladys.fake.lastTransport(lampId);
    assert.equal(badge.transport, 'cloud');
    assert.equal(badge.degraded, true);
    assert.ok(badge.message.en && badge.message.fr);

    await setValue(gladys, FLOOR_LAMP.scan.device, 'power', 0);
    assert.equal(cloud.calls.at(-1).path, '/device/control');

    // Back on the LAN: local again, the degraded flag cleared.
    fakeDevice(network, FLOOR_LAMP).replyPath = 'direct';
    await hub.pollLan();
    assert.deepEqual(gladys.fake.lastTransport(lampId), {
      external_id: lampId,
      transport: 'local',
    });
  } finally {
    app.stop();
  }
});

test('local preference off: a light both channels reach goes through the cloud', async () => {
  const { gladys, cloud, network, app } = await createWorld({
    config: { ...cloudConfig, GLADYS_PREFER_LOCAL: false },
  });
  try {
    const lampId = deviceId(gladys, FLOOR_LAMP.scan.device);
    assert.deepEqual(gladys.fake.lastTransport(lampId), {
      external_id: lampId,
      transport: 'cloud',
    });
    const before = network.sent.length;
    await setValue(gladys, FLOOR_LAMP.scan.device, 'color-temperature', 3000);
    assert.equal(network.sent.length, before, 'nothing sent on the LAN');
    assert.deepEqual(cloud.calls.at(-1).body.payload.capability, {
      type: 'devices.capabilities.color_setting',
      instance: 'colorTemperatureK',
      value: 3000,
    });
  } finally {
    app.stop();
  }
});

test('without cloud, a silent LAN light is unreachable but still receives commands', async () => {
  const devices = LAN_FIXTURES.map((d) => (d === BULB ? { ...d, replyPath: 'none' } : d));
  const { gladys, hub, network, app } = await createWorld({ config: lanConfig, devices });
  try {
    // Known from an earlier run: give the hub its entry as Gladys would.
    assert.equal(gladys.discoveredDevices.length, LAN_FIXTURES.length - 1);
    hub.upsert({
      id: BULB.scan.device,
      rawId: BULB.scan.device,
      sku: 'H6008',
      ip: BULB.ip,
      lan: true,
    });
    await hub.pollLan();
    assert.equal(
      hub.route(hub.entryByExternalId(deviceId(gladys, BULB.scan.device))).transport,
      'unreachable',
    );
    await setValue(gladys, BULB.scan.device, 'power', 0);
    assert.equal(fakeDevice(network, BULB).status.onOff, 0);
  } finally {
    app.stop();
  }
});

test('answers seen only by the core: discovery and states still work', async () => {
  const devices = LAN_FIXTURES.map((d) => ({ ...d, replyPath: 'mediated' }));
  const { gladys, network, app } = await createWorld({ config: lanConfig, devices });
  try {
    assert.equal(gladys.discoveredDevices.length, LAN_FIXTURES.length);
    assert.equal(gladys.fake.lastState(feature(gladys, BULB.scan.device, 'brightness')), 80);
    assert.ok(network.captures.length >= 2, 'scan and status went through captures');
    assert.ok(network.captures.every((c) => c.type === 'udp-broadcast'));
  } finally {
    app.stop();
  }
});

test('a refused API key turns the connection status red, without leaking the key', async () => {
  const { gladys, app } = await createWorld({
    config: { ...cloudConfig, api_key: 'super-secret-key' },
    cloudStatus: 401,
  });
  try {
    const status = gladys.connectionStatuses.at(-1);
    assert.equal(status.connected, false);
    assert.match(status.message.en, /API key/);
    assert.ok(!JSON.stringify(gladys.connectionStatuses).includes('super-secret-key'));
    // The LAN keeps working.
    assert.equal(gladys.fake.lastState(feature(gladys, BULB.scan.device, 'power')), 1);
  } finally {
    app.stop();
  }
});

test('nothing configured, nothing found: the status says what to do', async () => {
  const { gladys, app } = await createWorld({ config: {} });
  try {
    assert.equal(gladys.discoveredDevices.length, 0);
    const status = gladys.connectionStatuses.at(-1);
    assert.equal(status.connected, false);
    assert.match(status.message.en, /IP addresses/);
    assert.match(status.message.fr, /adresses IP/);
  } finally {
    app.stop();
  }
});

test('a restart knows the lights before they answer, and keeps the cloud counter', async () => {
  const first = await createWorld({ config: cloudConfig });
  // stop() resolves once the last state write is on disk.
  await first.app.stop();
  const saved = JSON.parse(await readFile(join(first.dataDir, 'govee-state.json'), 'utf8'));
  assert.equal(saved.devices.length, 10);
  assert.ok(saved.cloudUsage.count > 0);
  assert.ok(!JSON.stringify(saved).includes('test-key'), 'the key is not persisted');

  const silent = LAN_FIXTURES.map((d) => ({ ...d, replyPath: 'none' }));
  const second = await createWorld({ config: lanConfig, devices: silent, dataDir: first.dataDir });
  try {
    assert.equal(second.gladys.discoveredDevices.length, 10);
  } finally {
    second.app.stop();
  }
});

test('devices created in Gladys are known from their params', async () => {
  const silent = LAN_FIXTURES.map((d) => ({ ...d, replyPath: 'none' }));
  const created = {
    external_id: 'ext:test-integration:device:1a2b3c4d5e6f7001',
    model: 'H6008',
    params: [
      { name: 'GOVEE_SKU', value: 'H6008' },
      { name: 'IP_ADDRESS', value: BULB.ip },
    ],
  };
  const { gladys, network, app } = await createWorld({
    config: {},
    devices: silent,
    gladysDevices: [created],
  });
  try {
    assert.equal(gladys.discoveredDevices.length, 1);
    assert.equal(gladys.discoveredDevices[0].features.length, 4);
    // Probed at its last known IP.
    assert.ok(sentTo(network, BULB.ip, 'scan').length > 0);
  } finally {
    app.stop();
  }
});

test('a light that changed IP is followed, and no other light takes its answers', async () => {
  const devices = LAN_FIXTURES.map((d) => ({ ...d }));
  const { gladys, hub, network, app } = await createWorld({
    config: { lan_addresses: '192.0.2.20-40' },
    devices,
  });
  try {
    const bulb = fakeDevice(network, BULB);
    const lamp = fakeDevice(network, FLOOR_LAMP);
    // DHCP swaps the two addresses.
    [bulb.ip, lamp.ip] = [lamp.ip, bulb.ip];
    await hub.discover();
    const ipOf = (fixture) =>
      gladys.discoveredDevices
        .find((d) => d.external_id === deviceId(gladys, fixture.scan.device))
        .params.find((p) => p.name === 'IP_ADDRESS').value;
    assert.equal(ipOf(BULB), FLOOR_LAMP.ip);
    assert.equal(ipOf(FLOOR_LAMP), BULB.ip);
    bulb.status.brightness = 11;
    await hub.pollLan();
    assert.equal(gladys.fake.lastState(feature(gladys, BULB.scan.device, 'brightness')), 11);
  } finally {
    app.stop();
  }
});

test('identify blinks twice and restores the state', async () => {
  const { gladys, network, app } = await createWorld({ config: lanConfig });
  try {
    const message = await gladys.fake.call('action:identify', {
      device: deviceId(gladys, BULB.scan.device),
    });
    assert.match(message.en, /blinks/);
    assert.deepEqual(
      sentTo(network, BULB.ip, 'turn').map((s) => s.data.value),
      [0, 1, 0, 1],
    );
    assert.equal(fakeDevice(network, BULB).status.onOff, 1);
    const unknown = await gladys.fake.call('action:identify', {
      device: 'ext:test-integration:device:00',
    });
    assert.match(unknown.en, /cannot/);
  } finally {
    app.stop();
  }
});

test('the Govee scene action runs a built-in scene on a LAN light', async () => {
  const { gladys, network, app } = await createWorld({ config: lanConfig });
  try {
    const lampId = deviceId(gladys, FLOOR_LAMP.scan.device);
    assert.deepEqual(
      await gladys.fake.call('sceneAction:run_govee_scene', { device: lampId, scene: 'sunset' }),
      {},
    );
    const lamp = fakeDevice(network, FLOOR_LAMP);
    assert.equal(lamp.status.onOff, 1, 'turned on first');
    assert.equal(Buffer.from(lamp.lastPtReal[0], 'base64')[3], 0x01);

    await assert.rejects(
      gladys.fake.call('sceneAction:run_govee_scene', {
        device: deviceId(gladys, STRING_LIGHTS.scan.device),
        scene: 'sunset',
      }),
      /no known built-in scenes/,
    );
    await assert.rejects(
      gladys.fake.call('sceneAction:run_govee_scene', { device: lampId, scene: 'disco' }),
      /Unknown Govee scene/,
    );
  } finally {
    app.stop();
  }
});

test('the diagnose action reports what it found, in both languages', async () => {
  const { gladys, app } = await createWorld({
    config: { ...cloudConfig, lan_addresses: `${addressesOf()}, bulb.local` },
  });
  try {
    const message = await gladys.fake.call('action:diagnose', {});
    assert.match(message.en, /6\/6 light\(s\) answering/);
    assert.match(message.en, /Ignored entries: bulb\.local/);
    assert.match(message.en, /Cloud: 5 device\(s\)/);
    assert.match(message.fr, /6\/6 lampe\(s\) répondent/);
    assert.match(message.en, /straight to the integration/);
  } finally {
    app.stop();
  }
});

test('a scan request lists the cloud again; a new language renames new devices', async () => {
  const { gladys, cloud, app } = await createWorld({ config: cloudConfig });
  try {
    const lists = () => cloud.calls.filter((c) => c.path === '/user/devices').length;
    assert.equal(lists(), 1);
    await gladys.fake.call('scan');
    assert.equal(lists(), 2);

    await gladys.fake.call('configUpdated', { ...cloudConfig, language: 'fr' });
    const bulb = gladys.discoveredDevices.find((d) => d.model === 'H6008');
    assert.deepEqual(
      bulb.features.map((f) => f.name),
      ['Éclairage', 'Luminosité', 'Couleur', 'Température de couleur'],
    );
  } finally {
    app.stop();
  }
});

test('the cloud polls stretch to fit the daily budget', async () => {
  const { hub, app } = await createWorld({ config: cloudConfig });
  try {
    // 10 min for a few devices; 100 devices need 18 min to stay under 8,000 calls.
    assert.equal(hub.cloudPollIntervalMs(4), 10 * 60 * 1000);
    assert.equal(hub.cloudPollIntervalMs(100), 18 * 60 * 1000);
  } finally {
    app.stop();
  }
});
