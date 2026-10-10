import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { SETTING_DEFAULTS, WIDGETS, WIDGET_ACTION_FORMS } from '../src/widgets.js';
import { LAN_FIXTURES, addressesOf, createWorld, deviceId } from './helpers/world.js';

const BULB = LAN_FIXTURES[0]; // H6008: colour, white tones, scenes
const TV_BARS = LAN_FIXTURES[3]; // H6043: colour, no white tones
const STRING_LIGHTS = LAN_FIXTURES[4]; // H7012: brightness only

// Gladys applies the settings defaults before calling the widget.
const withDefaults = (settings) => ({ ...SETTING_DEFAULTS, ...settings });

const get = (gladys, device, language = 'en', settings = {}) =>
  gladys.fake.call('widgetGet:light_presets', {
    settings: withDefaults(device ? { device, ...settings } : settings),
    language,
    units: 'metric',
  });

// Taps a button the way the core does: only an action key present in the
// current content, with the params that content declared.
async function press(gladys, device, actionKey, settings = {}) {
  const content = await get(gladys, device, 'en', settings);
  const button = content.components.find((c) => c.type === 'button' && c.action?.key === actionKey);
  assert.ok(button, `no "${actionKey}" button in the content`);
  return gladys.fake.call('widgetAction:light_presets', actionKey, button.action.params ?? {}, {
    settings: withDefaults({ device, ...settings }),
  });
}

const buttons = async (gladys, device, settings) =>
  (await get(gladys, device, 'en', settings)).components.filter((c) => c.type === 'button');

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

test('no button opens a form: published Gladys versions cannot send one', async () => {
  // Action `fields` come with GladysAssistant/Gladys#3168, in no release yet
  // (5.1.4 shows the button and sends nothing). The SDK validator ignores
  // `fields`, so this test is the guard.
  assert.equal(WIDGET_ACTION_FORMS, false);
  const { gladys, app } = await world();
  try {
    for (const device of gladys.discoveredDevices) {
      for (const button of await buttons(gladys, device.external_id)) {
        assert.equal(button.action?.fields, undefined, `${device.model}: ${button.label}`);
      }
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

test('the buttons follow what the model can do and the settings', async () => {
  const { gladys, app } = await world();
  try {
    const labels = async (fixture, settings) =>
      (await buttons(gladys, deviceId(gladys, fixture.scan.device), settings)).map((b) => b.label);
    assert.deepEqual(await labels(BULB), ['Warm white', 'Daylight', 'Blue', 'Sunset']);
    // No white tones: room for the second scene.
    assert.deepEqual(await labels(TV_BARS), ['Blue', 'Sunset', 'Candlelight']);
    assert.deepEqual(await labels(TV_BARS, { color: 'pink', scene: 'movie', scene_2: 'movie' }), [
      'Pink',
      'Movie',
    ]);
    assert.deepEqual(await labels(STRING_LIGHTS), []);
    // An unknown stored value falls back to the default.
    assert.deepEqual(await labels(BULB, { color: 'mauve' }), [
      'Warm white',
      'Daylight',
      'Blue',
      'Sunset',
    ]);
  } finally {
    app.stop();
  }
});

test('presets drive the light in one tap, the active one marked by its icon', async () => {
  const { gladys, network, app } = await world();
  try {
    const bulbId = deviceId(gladys, BULB.scan.device);
    const bulb = network.byIp(BULB.ip);
    const icons = async (settings) =>
      Object.fromEntries(
        (await buttons(gladys, bulbId, settings)).map((b) => [b.action.key, b.icon]),
      );
    // The bulb starts red: the red button is active, not the blue one.
    assert.equal((await icons({ color: 'red' })).color, 'check-circle');
    assert.equal((await icons()).color, 'droplet');

    const result = await press(gladys, bulbId, 'warm');
    assert.deepEqual(result, { message: { en: 'Sent to the light.', fr: 'Envoyé à la lampe.' } });
    assert.equal(bulb.status.colorTemInKelvin, 2700);
    assert.equal((await icons()).warm, 'check-circle');

    await press(gladys, bulbId, 'color');
    assert.deepEqual(bulb.status.color, { r: 0, g: 0, b: 255 });
    assert.equal((await icons()).color, 'check-circle');

    await press(gladys, bulbId, 'scene', { scene: 'candlelight' });
    assert.equal(Buffer.from(bulb.lastPtReal[0], 'base64')[3], 0x09);
    const content = await get(gladys, bulbId, 'en', { scene: 'candlelight' });
    assert.equal(content.components.find((c) => c.label === 'Mode').value, 'Candlelight');
    assert.equal((await icons({ scene: 'candlelight' })).scene, 'check-circle');

    await assert.rejects(
      gladys.fake.call('widgetAction:light_presets', 'disco', {}, { settings: { device: bulbId } }),
      /Unknown action/,
    );
    await assert.rejects(
      gladys.fake.call('widgetAction:light_presets', 'warm', {}, { settings: {} }),
      /Choose a Govee light/,
    );
  } finally {
    app.stop();
  }
});

test('the second scene button runs its own scene', async () => {
  const { gladys, network, app } = await world();
  try {
    await press(gladys, deviceId(gladys, TV_BARS.scan.device), 'scene_2', { scene_2: 'twinkle' });
    assert.equal(Buffer.from(network.byIp(TV_BARS.ip).lastPtReal[0], 'base64')[3], 0x08);
  } finally {
    app.stop();
  }
});

test('white presets respect the model range (2700-6500 K floor lamp)', async () => {
  const { gladys, network, app } = await world();
  try {
    const lamp = LAN_FIXTURES[1];
    await press(gladys, deviceId(gladys, lamp.scan.device), 'daylight');
    assert.equal(network.byIp(lamp.ip).status.colorTemInKelvin, 6500);
  } finally {
    app.stop();
  }
});

test('the form variant, kept for Gladys#3168, still drives the light', async () => {
  const { gladys, hub, network, app } = await world();
  try {
    const bulbId = deviceId(gladys, BULB.scan.device);
    const widget = WIDGETS.light_presets;
    const content = await widget.get(
      hub,
      { settings: { device: bulbId }, language: 'en' },
      { forms: true },
    );
    const keys = content.components.filter((c) => c.type === 'button').map((c) => c.action.key);
    assert.deepEqual(keys, ['warm', 'daylight', 'color', 'scene']);
    await widget.action(hub, {
      actionKey: 'color',
      settings: { device: bulbId },
      values: { color: 'green' },
    });
    assert.deepEqual(network.byIp(BULB.ip).status.color, { r: 0, g: 255, b: 0 });
  } finally {
    app.stop();
  }
});
