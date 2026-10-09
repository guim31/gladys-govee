import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudCommand,
  cloudStateToValues,
  deviceName,
  featureSpecs,
  lanStatusToValues,
} from '../src/features.js';
import { DEFAULT_KELVIN_RANGE, MODEL_FLAGS, modelCapabilities } from '../src/models.js';
import { CLOUD_DEVICES, CLOUD_STATES } from './helpers/world.js';

const cloudEntry = (sku, extra = {}) => {
  const device = CLOUD_DEVICES.data.find((d) => d.sku === sku);
  return {
    id: device.device.toLowerCase().replace(/:/g, ''),
    rawId: device.device,
    sku,
    cloud: { type: device.type, name: device.deviceName, capabilities: device.capabilities },
    ...extra,
  };
};
const keys = (entry, language) => featureSpecs(entry, language).map((spec) => spec.key);

test('the model table is the govee-local-api one', () => {
  assert.equal(Object.keys(MODEL_FLAGS).length, 272);
  assert.deepEqual(modelCapabilities('H6008'), {
    known: true,
    rgb: true,
    kelvin: true,
    brightness: true,
    scenes: true,
    kelvinRange: DEFAULT_KELVIN_RANGE,
  });
  assert.deepEqual(modelCapabilities('h6076').kelvinRange, [2700, 6500]);
  assert.equal(modelCapabilities('H6043').kelvin, false);
  assert.equal(modelCapabilities('H6093').rgb, false);
  assert.deepEqual(modelCapabilities('H7012'), {
    known: true,
    rgb: false,
    kelvin: false,
    brightness: true,
    scenes: false,
    kelvinRange: DEFAULT_KELVIN_RANGE,
  });
  // Unknown: the documented LAN features, but no scene codes.
  assert.deepEqual(modelCapabilities('H9999'), {
    known: false,
    rgb: true,
    kelvin: true,
    brightness: true,
    scenes: false,
    kelvinRange: DEFAULT_KELVIN_RANGE,
  });
});

test('LAN lights: features from the model, kelvin range refined by the cloud', () => {
  const bulb = { id: 'a1', sku: 'H6058', lan: true, ip: '192.0.2.1' };
  assert.deepEqual(keys(bulb), ['power', 'brightness', 'color', 'color-temperature']);
  // H6058 is not in the range table: the cloud range applies.
  const cloudBar = cloudEntry('H6058', { lan: true, ip: '192.0.2.1' });
  cloudBar.cloud.capabilities = cloudBar.cloud.capabilities.map((c) =>
    c.instance === 'colorTemperatureK'
      ? { ...c, parameters: { range: { min: 2200, max: 6500 } } }
      : c,
  );
  const kelvin = featureSpecs(cloudBar).find((s) => s.key === 'color-temperature');
  assert.deepEqual([kelvin.min, kelvin.max, kelvin.unit], [2200, 6500, 'kelvin']);
  // The table range wins when it has one (measured on the device).
  const lamp = cloudEntry('H6076', { lan: true });
  lamp.cloud.capabilities = lamp.cloud.capabilities.map((c) =>
    c.instance === 'colorTemperatureK'
      ? { ...c, parameters: { range: { min: 2000, max: 9000 } } }
      : c,
  );
  const lampKelvin = featureSpecs(lamp).find((s) => s.key === 'color-temperature');
  assert.deepEqual([lampKelvin.min, lampKelvin.max], [2700, 6500]);
});

test('cloud devices: only the capabilities Gladys can show', () => {
  assert.deepEqual(keys(cloudEntry('H5080')), ['power']);
  assert.equal(featureSpecs(cloudEntry('H5080'))[0].category, 'switch');
  assert.deepEqual(keys(cloudEntry('H5179')), ['temperature', 'humidity']);
  // workMode and the target humidity range are not mapped.
  assert.deepEqual(keys(cloudEntry('H7141')), ['power', 'color', 'toggle-nightlight']);
  assert.deepEqual(
    featureSpecs(cloudEntry('H7141'), 'fr').map((s) => s.name),
    ['Alimentation', 'Couleur', 'Veilleuse'],
  );
  assert.equal(featureSpecs(cloudEntry('H6058'))[0].category, 'light');
});

test('sensor temperature: Fahrenheit unless the capability says Celsius', () => {
  const entry = cloudEntry('H5179');
  assert.equal(featureSpecs(entry)[0].unit, 'fahrenheit');
  entry.cloud.capabilities = entry.cloud.capabilities.map((c) =>
    c.instance === 'sensorTemperature'
      ? { ...c, parameters: { unit: 'unit.temperature.celsius' } }
      : c,
  );
  assert.equal(featureSpecs(entry)[0].unit, 'celsius');
});

test('unknown toggles get a readable, distinct name', () => {
  const entry = cloudEntry('H5080');
  entry.cloud.capabilities = [
    ...entry.cloud.capabilities,
    { type: 'devices.capabilities.toggle', instance: 'childLockToggle' },
    { type: 'devices.capabilities.toggle', instance: 'childLockToggle2' },
    { type: 'devices.capabilities.toggle', instance: 'powerToggle' },
  ];
  const specs = featureSpecs(entry);
  assert.deepEqual(
    specs.map((s) => [s.key, s.name]),
    [
      ['power', 'Power'],
      ['toggle-child-lock', 'Child lock'],
      ['toggle-child-lock-toggle2', 'Child lock toggle2'],
      ['toggle-power', 'Power 2'],
    ],
  );
});

test('cloud states map to feature values', () => {
  const sensor = cloudStateToValues(cloudEntry('H5179'), CLOUD_STATES.H5179.payload.capabilities);
  assert.deepEqual(sensor, { values: { temperature: 68.36, humidity: 47.2 }, online: true });
  const humidifier = cloudStateToValues(
    cloudEntry('H7141'),
    CLOUD_STATES.H7141.payload.capabilities,
  );
  assert.deepEqual(humidifier, {
    values: { power: 0, 'toggle-nightlight': 1, color: 16753920 },
    online: false,
  });
  // Wrapped sensor values, and a colour-mode light (kelvin 0 is skipped).
  const wrapped = cloudStateToValues(cloudEntry('H5179'), [
    {
      type: 'devices.capabilities.property',
      instance: 'sensorTemperature',
      state: { value: { currentTemperature: 20.5 } },
    },
  ]);
  assert.deepEqual(wrapped.values, { temperature: 20.5 });
  const colorMode = cloudStateToValues(cloudEntry('H6058'), [
    {
      type: 'devices.capabilities.color_setting',
      instance: 'colorTemperatureK',
      state: { value: 0 },
    },
    { type: 'devices.capabilities.color_setting', instance: 'colorRgb', state: { value: 255 } },
  ]);
  assert.deepEqual(colorMode.values, { color: 255 });
});

test('cloud commands are bounded by the capability range', () => {
  const [power, brightness, color, kelvin] = featureSpecs(cloudEntry('H6058'));
  assert.deepEqual(cloudCommand(power, 1), {
    type: 'devices.capabilities.on_off',
    instance: 'powerSwitch',
    value: 1,
  });
  assert.equal(cloudCommand(brightness, 150).value, 100);
  assert.equal(cloudCommand(brightness, 0.2).value, 1);
  assert.equal(cloudCommand(color, 0x123456).value, 0x123456);
  assert.equal(cloudCommand(kelvin, 12000).value, 9000);
  assert.equal(cloudCommand({ key: 'power' }, 1), null);
});

test('LAN status values only cover the features the model has', () => {
  const strings = { id: 'a5', sku: 'H7012', lan: true };
  assert.deepEqual(
    lanStatusToValues(strings, { on: true, brightness: 60, color: 0, kelvin: null }),
    { power: 1, brightness: 60 },
  );
});

test('device names: the Govee app name, else model and id suffix', () => {
  assert.equal(deviceName(cloudEntry('H5080')), 'Coffee maker plug');
  assert.equal(deviceName({ id: '1a2b3c4d5e6f7001', sku: 'H6008' }), 'Govee H6008 7001');
  assert.equal(
    deviceName({ id: '1a2b3c4d5e6f7001', sku: 'H6008', cloud: { name: '  ' } }),
    'Govee H6008 7001',
  );
});
