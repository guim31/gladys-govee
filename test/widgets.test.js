import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { LAN_FIXTURES, addressesOf, createWorld, deviceId } from './helpers/world.js';

const BULB = LAN_FIXTURES[0]; // H6008: colour, white tones, scenes
const TV_BARS = LAN_FIXTURES[3]; // H6043: colour, no white tones
const STRING_LIGHTS = LAN_FIXTURES[4]; // H7012: brightness only

const get = (gladys, device, language = 'en') =>
  gladys.fake.call('widgetGet:light_presets', {
    settings: device ? { device } : {},
    language,
    units: 'metric',
  });
const act = (gladys, device, actionKey, values) =>
  gladys.fake.call('widgetAction:light_presets', actionKey, {}, { settings: { device }, values });

async function world() {
  return createWorld({ config: { lan_addresses: addressesOf(), api_key: 'test-key' } });
}

test('every content the widget can produce renders exactly as sent', async () => {
  const { gladys, app } = await world();
  try {
    const contents = [await get(gladys), await get(gladys, 'ext:test-integration:device:00')];
    for (const device of gladys.discoveredDevices) {
      for (const language of ['en', 'fr']) {
        contents.push(await get(gladys, device.external_id, language));
      }
    }
    for (const content of contents) {
      // [] = nothing the core would drop, truncate or trim to the budget.
      assert.deepEqual(validateWidgetContent(content), [], JSON.stringify(content));
    }
  } finally {
    app.stop();
  }
});

test('live tiles point at features the device publishes', async () => {
  const { gladys, app } = await world();
  try {
    const featureIds = new Set(
      gladys.discoveredDevices.flatMap((d) => d.features.map((f) => f.external_id)),
    );
    for (const device of gladys.discoveredDevices) {
      const content = await get(gladys, device.external_id);
      for (const component of content.components.filter((c) => c.device_feature)) {
        assert.ok(featureIds.has(component.device_feature), component.device_feature);
      }
    }
  } finally {
    app.stop();
  }
});

test('the buttons follow what the model can do', async () => {
  const { gladys, app } = await world();
  try {
    const keys = async (fixture) =>
      (await get(gladys, deviceId(gladys, fixture.scan.device))).components
        .filter((c) => c.type === 'button')
        .map((c) => c.action.key);
    assert.deepEqual(await keys(BULB), ['warm', 'daylight', 'color', 'scene']);
    assert.deepEqual(await keys(TV_BARS), ['color', 'scene']);
    assert.deepEqual(await keys(STRING_LIGHTS), []);
  } finally {
    app.stop();
  }
});

test('presets drive the light, and the active one is marked by its icon', async () => {
  const { gladys, network, app } = await world();
  try {
    const bulbId = deviceId(gladys, BULB.scan.device);
    const bulb = network.byIp(BULB.ip);
    const icons = async () =>
      Object.fromEntries(
        (await get(gladys, bulbId)).components
          .filter((c) => c.type === 'button')
          .map((c) => [c.action.key, c.icon]),
      );
    assert.equal((await icons()).color, 'check-circle', 'the bulb starts in colour mode');

    const result = await act(gladys, bulbId, 'warm');
    assert.deepEqual(result, { message: { en: 'Sent to the light.', fr: 'Envoyé à la lampe.' } });
    assert.equal(bulb.status.colorTemInKelvin, 2700);
    assert.equal((await icons()).warm, 'check-circle');
    assert.equal((await icons()).color, 'droplet');

    await act(gladys, bulbId, 'color', { color: 'blue' });
    assert.deepEqual(bulb.status.color, { r: 0, g: 0, b: 255 });

    await act(gladys, bulbId, 'scene', { scene: 'candlelight' });
    assert.equal(Buffer.from(bulb.lastPtReal[0], 'base64')[3], 0x09);
    const content = await get(gladys, bulbId);
    assert.equal(content.components.find((c) => c.label === 'Mode').value, 'Candlelight');
    assert.equal((await icons()).scene, 'check-circle');

    await assert.rejects(act(gladys, bulbId, 'disco'), /Unknown action/);
    await assert.rejects(act(gladys, undefined, 'warm'), /Choose a Govee light/);
  } finally {
    app.stop();
  }
});

test('white presets respect the model range (2700-6500 K floor lamp)', async () => {
  const { gladys, network, app } = await world();
  try {
    const lamp = LAN_FIXTURES[1];
    await act(gladys, deviceId(gladys, lamp.scan.device), 'daylight');
    assert.equal(network.byIp(lamp.ip).status.colorTemInKelvin, 6500);
  } finally {
    app.stop();
  }
});
