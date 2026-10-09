// -----------------------------------------------------------------------------
// From a Govee device (seen on the LAN, in the cloud API, or both) to Gladys
// features, and back: discovery payload, state mapping, command mapping.
//
// Feature keys are part of the external ids, hence permanent: the same function
// keeps the same key whichever channel reaches it (a LAN light later seen by the
// cloud keeps its features).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { DEFAULT_KELVIN_RANGE, KELVIN_RANGES, modelCapabilities } from './models.js';

// Namespace of every device external id: `ext:<selector>:device:<govee id>`.
export const DEVICE_TYPE = 'device';

export const FEATURE_KEYS = {
  POWER: 'power',
  BRIGHTNESS: 'brightness',
  COLOR: 'color',
  COLOR_TEMPERATURE: 'color-temperature',
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
};
const TOGGLE_PREFIX = 'toggle-';

const CLOUD = {
  ON_OFF: 'devices.capabilities.on_off',
  TOGGLE: 'devices.capabilities.toggle',
  RANGE: 'devices.capabilities.range',
  COLOR: 'devices.capabilities.color_setting',
  PROPERTY: 'devices.capabilities.property',
  ONLINE: 'devices.capabilities.online',
  LIGHT_TYPE: 'devices.types.light',
};

// Feature names are frozen when the user creates the device: written in the
// language chosen in the configuration at that moment.
const NAMES = {
  en: {
    power: 'Power',
    light: 'Light',
    brightness: 'Brightness',
    color: 'Color',
    'color-temperature': 'Color temperature',
    temperature: 'Temperature',
    humidity: 'Humidity',
  },
  fr: {
    power: 'Alimentation',
    light: 'Éclairage',
    brightness: 'Luminosité',
    color: 'Couleur',
    'color-temperature': 'Température de couleur',
    temperature: 'Température',
    humidity: 'Humidité',
  },
};

const TOGGLE_NAMES = {
  gradientToggle: { en: 'Gradient', fr: 'Dégradé' },
  nightlightToggle: { en: 'Night light', fr: 'Veilleuse' },
  oscillationToggle: { en: 'Oscillation', fr: 'Oscillation' },
  warmMistToggle: { en: 'Warm mist', fr: 'Brume chaude' },
  airDeflectorToggle: { en: 'Air deflector', fr: 'Déflecteur' },
  thermostatToggle: { en: 'Thermostat', fr: 'Thermostat' },
  dreamViewToggle: { en: 'DreamView', fr: 'DreamView' },
};

const findCapability = (entry, type, instance) =>
  (entry.cloud?.capabilities ?? []).find((c) => c?.type === type && c?.instance === instance);

const rangeOf = (capability) => {
  const range = capability?.parameters?.range;
  return Number.isFinite(range?.min) && Number.isFinite(range?.max) && range.min < range.max
    ? [range.min, range.max]
    : null;
};

/**
 * True when the device speaks the LAN API (a LAN scan saw it once). Its IP may
 * be unknown for a while (DHCP change): the features stay the same.
 */
export const hasLan = (entry) => entry.lan === true;

/** True when the cloud API lists the device. */
export const hasCloud = (entry) => Boolean(entry.cloud);

/**
 * Light capabilities of a LAN device: the model table, refined by the
 * colour-temperature range the cloud reports when the table has none.
 */
export function lanCapabilities(entry) {
  const caps = modelCapabilities(entry.sku);
  const cloudRange = rangeOf(findCapability(entry, CLOUD.COLOR, 'colorTemperatureK'));
  if (cloudRange && KELVIN_RANGES[String(entry.sku).toUpperCase()] === undefined) {
    caps.kelvinRange = cloudRange;
  }
  return caps;
}

/**
 * The features of one device, each with how to read and drive it.
 * @returns {Array<object>} `{ key, name, category, type, unit?, min, max,
 *   read_only, has_feedback, lan?, cloud? }` — `lan` names the LAN function,
 *   `cloud` the `{ type, instance }` capability.
 */
export function featureSpecs(entry, language = 'en') {
  const names = NAMES[language] ?? NAMES.en;
  const specs = [];
  const cloudPower = findCapability(entry, CLOUD.ON_OFF, 'powerSwitch');

  if (hasLan(entry)) {
    const caps = lanCapabilities(entry);
    specs.push(lightPower(names, cloudPower));
    if (caps.brightness) {
      specs.push(
        lightBrightness(names, findCapability(entry, CLOUD.RANGE, 'brightness'), [0, 100]),
      );
    }
    if (caps.rgb) {
      specs.push(lightColor(names, findCapability(entry, CLOUD.COLOR, 'colorRgb')));
    }
    if (caps.kelvin) {
      specs.push(
        lightKelvin(
          names,
          findCapability(entry, CLOUD.COLOR, 'colorTemperatureK'),
          caps.kelvinRange,
        ),
      );
    }
    for (const spec of specs) {
      spec.lan = spec.key;
    }
  } else if (hasCloud(entry)) {
    const isLight = entry.cloud.type === CLOUD.LIGHT_TYPE;
    if (cloudPower) {
      specs.push(isLight ? lightPower(names, cloudPower) : switchPower(names, cloudPower));
    }
    const brightness = findCapability(entry, CLOUD.RANGE, 'brightness');
    if (brightness) {
      const range = rangeOf(brightness) ?? [1, 100];
      specs.push(lightBrightness(names, brightness, [0, range[1]]));
    }
    const color = findCapability(entry, CLOUD.COLOR, 'colorRgb');
    if (color) {
      specs.push(lightColor(names, color));
    }
    const kelvin = findCapability(entry, CLOUD.COLOR, 'colorTemperatureK');
    if (kelvin) {
      specs.push(lightKelvin(names, kelvin, rangeOf(kelvin) ?? DEFAULT_KELVIN_RANGE));
    }
    const temperature = findCapability(entry, CLOUD.PROPERTY, 'sensorTemperature');
    if (temperature) {
      specs.push(sensorTemperature(names, temperature));
    }
    const humidity = findCapability(entry, CLOUD.PROPERTY, 'sensorHumidity');
    if (humidity) {
      specs.push(sensorHumidity(names, humidity));
    }
  }

  // Cloud toggles (night light, oscillation...): cloud only, on any device the
  // cloud lists, LAN lights included.
  for (const capability of entry.cloud?.capabilities ?? []) {
    if (capability?.type !== CLOUD.TOGGLE || typeof capability.instance !== 'string') {
      continue;
    }
    const label = TOGGLE_NAMES[capability.instance];
    specs.push({
      key: `${TOGGLE_PREFIX}${slug(capability.instance.replace(/Toggle$/, ''))}`,
      name: label?.[language] ?? label?.en ?? prettify(capability.instance),
      category: CATEGORIES.SWITCH,
      type: TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      cloud: { type: capability.type, instance: capability.instance },
    });
  }
  return dedupeNames(specs);
}

function lightPower(names, cloud) {
  return {
    key: FEATURE_KEYS.POWER,
    name: names.light,
    category: CATEGORIES.LIGHT,
    type: TYPES.LIGHT.BINARY,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    cloud: cloud && { type: cloud.type, instance: cloud.instance },
  };
}

function switchPower(names, cloud) {
  return {
    key: FEATURE_KEYS.POWER,
    name: names.power,
    category: CATEGORIES.SWITCH,
    type: TYPES.SWITCH.BINARY,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    cloud: { type: cloud.type, instance: cloud.instance },
  };
}

// 0 % turns the light off, as the Gladys brightness slider expects.
function lightBrightness(names, cloud, [min, max]) {
  return {
    key: FEATURE_KEYS.BRIGHTNESS,
    name: names.brightness,
    category: CATEGORIES.LIGHT,
    type: TYPES.LIGHT.BRIGHTNESS,
    unit: UNITS.PERCENT,
    min,
    max,
    read_only: false,
    has_feedback: true,
    cloud: cloud && { type: cloud.type, instance: cloud.instance },
  };
}

function lightColor(names, cloud) {
  return {
    key: FEATURE_KEYS.COLOR,
    name: names.color,
    category: CATEGORIES.LIGHT,
    type: TYPES.LIGHT.COLOR,
    min: 0,
    max: 0xffffff,
    read_only: false,
    has_feedback: true,
    cloud: cloud && { type: cloud.type, instance: cloud.instance },
  };
}

// In kelvins, with the model's own bounds: the Gladys slider reads a `kelvin`
// unit as a physical scale (warm on the left).
function lightKelvin(names, cloud, [min, max]) {
  return {
    key: FEATURE_KEYS.COLOR_TEMPERATURE,
    name: names['color-temperature'],
    category: CATEGORIES.LIGHT,
    type: TYPES.LIGHT.TEMPERATURE,
    unit: UNITS.KELVIN,
    min,
    max,
    read_only: false,
    has_feedback: true,
    cloud: cloud && { type: cloud.type, instance: cloud.instance },
  };
}

// The Govee API reports sensor temperatures in Fahrenheit unless the
// capability declares a Celsius unit: publish the native value with its unit,
// Gladys converts to each user's preference when it displays it.
function sensorTemperature(names, cloud) {
  const celsius = /celsius/i.test(String(cloud.parameters?.unit ?? ''));
  return {
    key: FEATURE_KEYS.TEMPERATURE,
    name: names.temperature,
    category: CATEGORIES.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: celsius ? UNITS.CELSIUS : UNITS.FAHRENHEIT,
    // Display bounds of a home thermometer (-40 °C to 85 °C).
    min: -40,
    max: celsius ? 85 : 185,
    read_only: true,
    has_feedback: false,
    cloud: { type: cloud.type, instance: cloud.instance },
  };
}

function sensorHumidity(names, cloud) {
  return {
    key: FEATURE_KEYS.HUMIDITY,
    name: names.humidity,
    category: CATEGORIES.HUMIDITY_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    read_only: true,
    has_feedback: false,
    cloud: { type: cloud.type, instance: cloud.instance },
  };
}

function slug(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

function prettify(instance) {
  const words = slug(instance.replace(/Toggle$/, '')).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Two features of one device must not share a name (the Gladys UI could not
// tell them apart): suffix the later ones.
function dedupeNames(specs) {
  const seen = new Map();
  for (const spec of specs) {
    const count = seen.get(spec.name) ?? 0;
    seen.set(spec.name, count + 1);
    if (count > 0) {
      spec.name = `${spec.name} ${count + 1}`;
    }
  }
  return specs;
}

/** Default device name: the one given in the Govee app, else the model. */
export function deviceName(entry) {
  const cloudName = typeof entry.cloud?.name === 'string' ? entry.cloud.name.trim() : '';
  if (cloudName) {
    return cloudName.slice(0, 100);
  }
  return `Govee ${entry.sku} ${entry.id.slice(-4).toUpperCase()}`;
}

/**
 * The discovery payload of one device.
 * @param {object} gladys the SDK client (for externalIds)
 * @param {object} entry the registry entry
 * @param {string} language
 */
export function buildDevice(gladys, entry, language) {
  const ids = gladys.externalIds(DEVICE_TYPE, entry.id);
  const params = [{ name: 'GOVEE_SKU', value: entry.sku }];
  if (entry.rawId) {
    params.push({ name: 'GOVEE_DEVICE_ID', value: entry.rawId });
  }
  if (hasLan(entry) && entry.ip) {
    params.push({ name: 'IP_ADDRESS', value: entry.ip });
  }
  return {
    name: deviceName(entry),
    external_id: ids.device,
    model: entry.sku,
    // States are pushed by the integration's own timers (one LAN exchange for
    // every light at once, cloud polls within the daily quota): Gladys does
    // not poll these devices.
    should_poll: false,
    params,
    features: featureSpecs(entry, language).map((spec) => ({
      name: spec.name,
      external_id: ids.feature(spec.key),
      category: spec.category,
      type: spec.type,
      ...(spec.unit ? { unit: spec.unit } : {}),
      min: spec.min,
      max: spec.max,
      read_only: spec.read_only,
      has_feedback: spec.has_feedback,
      keep_history: true,
    })),
  };
}

/** Feature key of a feature external id (the part after the device id). */
export function featureKeyOf(gladys, entry, featureExternalId) {
  const prefix = `${gladys.externalIds(DEVICE_TYPE, entry.id).device}:`;
  return featureExternalId.startsWith(prefix) ? featureExternalId.slice(prefix.length) : null;
}

/**
 * LAN status (parsed `devStatus`) to feature values, keyed by feature key.
 * Only the features the device has are returned.
 */
export function lanStatusToValues(entry, status, language) {
  const keys = new Set(featureSpecs(entry, language).map((spec) => spec.key));
  const values = {};
  if (status.on !== undefined) {
    values[FEATURE_KEYS.POWER] = status.on ? 1 : 0;
  }
  if (status.brightness !== undefined && keys.has(FEATURE_KEYS.BRIGHTNESS)) {
    values[FEATURE_KEYS.BRIGHTNESS] = status.brightness;
  }
  if (status.color !== undefined && keys.has(FEATURE_KEYS.COLOR)) {
    values[FEATURE_KEYS.COLOR] = status.color;
  }
  if (typeof status.kelvin === 'number' && keys.has(FEATURE_KEYS.COLOR_TEMPERATURE)) {
    values[FEATURE_KEYS.COLOR_TEMPERATURE] = status.kelvin;
  }
  return values;
}

/**
 * Cloud state (`capabilities` of /device/state) to feature values, plus the
 * `online` flag when the API reports it.
 */
export function cloudStateToValues(entry, capabilities, language) {
  const specs = featureSpecs(entry, language).filter((spec) => spec.cloud);
  const values = {};
  let online;
  for (const capability of capabilities ?? []) {
    const raw = capability?.state?.value;
    if (capability?.type === CLOUD.ONLINE) {
      online = raw === true || raw === 'true' || raw === 1;
      continue;
    }
    const spec = specs.find(
      (s) => s.cloud.type === capability?.type && s.cloud.instance === capability?.instance,
    );
    const value = numericValue(raw);
    if (!spec || value === null) {
      continue;
    }
    if (spec.key === FEATURE_KEYS.COLOR_TEMPERATURE && value <= 0) {
      // 0 = the light is in colour mode.
      continue;
    }
    values[spec.key] =
      spec.category === CATEGORIES.SWITCH || spec.type === TYPES.LIGHT.BINARY
        ? value
          ? 1
          : 0
        : value;
  }
  return { values, online };
}

// Sensor values come as numbers, or wrapped in an object on some models
// ({ currentTemperature: 21.5 }): take the only number in it.
function numericValue(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  if (raw && typeof raw === 'object') {
    const numbers = Object.values(raw).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return numbers.length === 1 ? numbers[0] : null;
  }
  return null;
}

/** Cloud control capability for a command, or null when the feature has none. */
export function cloudCommand(spec, value) {
  if (!spec.cloud) {
    return null;
  }
  const { type, instance } = spec.cloud;
  if (spec.type === TYPES.LIGHT.BINARY || spec.type === TYPES.SWITCH.BINARY) {
    return { type, instance, value: value ? 1 : 0 };
  }
  const bounded = Math.round(Math.max(spec.min, Math.min(spec.max, Number(value))));
  if (spec.key === FEATURE_KEYS.BRIGHTNESS) {
    return { type, instance, value: Math.max(1, bounded) };
  }
  return { type, instance, value: bounded };
}

export const isToggleKey = (key) => key.startsWith(TOGGLE_PREFIX);
