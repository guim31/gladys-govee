// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `light_presets`.
//
// The Gladys light box already has the switch, the brightness slider, the
// colour picker and the white-tone slider. What it lacks, and this widget adds:
// one-tap white tones, a short list of named colours, and the Govee built-in
// scenes (sunset, candlelight, movie...), unreachable from any device feature.
//
// Budget (8 components, 2 texts, 4 buttons): a caption, two tiles (live
// brightness, current mode) and up to four buttons. The current preset is
// marked by its icon (`check-circle`), never by the button style: `primary` is
// invisible in dark mode.
//
// Every button acts in one tap: the colour and the scenes it sends are chosen
// in the widget settings. A button that opens a form (action `fields`) needs
// GladysAssistant/Gladys#3168, in no published Gladys yet (5.1.4 renders the
// button and sends nothing): that variant stays behind WIDGET_ACTION_FORMS.
// -----------------------------------------------------------------------------

import { DEVICE_TYPE, FEATURE_KEYS, featureSpecs, hasLan, lanCapabilities } from './features.js';
import { PRESETS_WIDGET } from './hub.js';
import { COLORS, SCENES, WHITES, sceneLabel } from './presets.js';

const ACTIVE_ICON = 'check-circle';

// Turn on once a published Gladys renders widget action forms (#3168).
export const WIDGET_ACTION_FORMS = false;

// Widget settings defaults, mirrored in the manifest (test/manifest.test.js).
export const SETTING_DEFAULTS = { color: 'blue', scene: 'sunset', scene_2: 'candlelight' };

const colorOf = (value) => COLORS.find((c) => c.value === value);
const sceneOf = (value) => SCENES.find((s) => s.value === value);

const TEXT = {
  pick: {
    en: 'Choose a Govee light in the settings of this widget.',
    fr: 'Choisissez une lampe Govee dans les réglages de ce widget.',
  },
  unknown: {
    en: 'This Govee light is not known yet: run a scan in the integration.',
    fr: 'Cette lampe Govee est inconnue : lancez une recherche dans l’intégration.',
  },
  brightness: { en: 'Brightness', fr: 'Luminosité' },
  mode: { en: 'Mode', fr: 'Mode' },
  off: { en: 'Off', fr: 'Éteinte' },
  color: { en: 'Color', fr: 'Couleur' },
  scene: { en: 'Scene', fr: 'Scène' },
  local: { en: 'local network', fr: 'réseau local' },
  cloud: { en: 'cloud', fr: 'cloud' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  done: { en: 'Sent to the light.', fr: 'Envoyé à la lampe.' },
};

const t = (text, language) => text[language] ?? text.en;

function currentMode(hub, entry, language) {
  const values = hub.valuesOf(entry);
  if (values[FEATURE_KEYS.POWER] === 0) {
    return t(TEXT.off, language);
  }
  if (entry.mode === 'scene' && entry.scene) {
    return t(sceneLabel(entry.scene) ?? TEXT.scene, language);
  }
  if (entry.mode === 'white' && values[FEATURE_KEYS.COLOR_TEMPERATURE]) {
    return `${values[FEATURE_KEYS.COLOR_TEMPERATURE]} K`;
  }
  if (entry.mode === 'color') {
    return t(TEXT.color, language);
  }
  return '–';
}

const clampKelvin = (spec, kelvin) => Math.max(spec.min, Math.min(spec.max, kelvin));

async function get(hub, { settings = {}, language }, { forms = WIDGET_ACTION_FORMS } = {}) {
  const entry = settings?.device ? hub.entryByExternalId(settings.device) : null;
  if (!entry) {
    return {
      ttl_seconds: 300,
      components: [
        {
          type: 'text',
          variant: 'body',
          text: t(settings?.device ? TEXT.unknown : TEXT.pick, language),
        },
      ],
    };
  }
  const specs = featureSpecs(entry, language);
  const has = (key) => specs.find((spec) => spec.key === key);
  const values = hub.valuesOf(entry);
  const on = values[FEATURE_KEYS.POWER] === 1;
  const route = hub.route(entry);
  const ids = hub.gladys.externalIds(DEVICE_TYPE, entry.id);
  const components = [
    {
      type: 'text',
      variant: 'caption',
      text: `${entry.sku} · ${t(TEXT[route.transport] ?? TEXT.unreachable, language)}`,
    },
  ];
  if (has(FEATURE_KEYS.BRIGHTNESS)) {
    components.push({
      type: 'value',
      device_feature: ids.feature(FEATURE_KEYS.BRIGHTNESS),
      label: t(TEXT.brightness, language),
      icon: 'sun',
    });
  }
  components.push({
    type: 'value',
    value: currentMode(hub, entry, language),
    label: t(TEXT.mode, language),
    icon: 'droplet',
  });

  const buttons = [];
  const kelvinSpec = has(FEATURE_KEYS.COLOR_TEMPERATURE);
  if (kelvinSpec) {
    for (const [key, white] of Object.entries(WHITES)) {
      const kelvin = clampKelvin(kelvinSpec, white.kelvin);
      const active =
        on && entry.mode === 'white' && values[FEATURE_KEYS.COLOR_TEMPERATURE] === kelvin;
      buttons.push({
        type: 'button',
        label: t(white.label, language),
        icon: active ? ACTIVE_ICON : 'sun',
        action: { key },
      });
    }
  }
  const color = has(FEATURE_KEYS.COLOR);
  const scenes = hasLan(entry) && lanCapabilities(entry).scenes;
  if (forms) {
    if (color) {
      buttons.push(colorFormButton(entry, on, language));
    }
    if (scenes) {
      buttons.push(sceneFormButton(entry, on, language));
    }
  } else {
    if (color) {
      const preset = colorOf(settings.color) ?? colorOf(SETTING_DEFAULTS.color);
      const active = on && entry.mode === 'color' && values[FEATURE_KEYS.COLOR] === preset.rgb;
      buttons.push({
        type: 'button',
        label: t(preset.label, language),
        icon: active ? ACTIVE_ICON : 'droplet',
        action: { key: 'color', params: { color: preset.value } },
      });
    }
    if (scenes) {
      for (const key of ['scene', 'scene_2']) {
        const scene = sceneOf(settings[key]) ?? sceneOf(SETTING_DEFAULTS[key]);
        // The same scene picked twice is one button.
        if (buttons.some((b) => b.action.params?.scene === scene.value)) {
          continue;
        }
        buttons.push({
          type: 'button',
          label: t(scene.label, language),
          icon: on && entry.mode === 'scene' && entry.scene === scene.value ? ACTIVE_ICON : 'film',
          action: { key, params: { scene: scene.value } },
        });
      }
    }
  }
  return { ttl_seconds: 60, components: [...components, ...buttons.slice(0, 4)] };
}

// One button, one form: the colour list (needs Gladys#3168, see the header).
function colorFormButton(entry, on, language) {
  return {
    type: 'button',
    label: t(TEXT.color, language),
    icon: on && entry.mode === 'color' ? ACTIVE_ICON : 'droplet',
    action: {
      key: 'color',
      fields: [
        {
          key: 'color',
          type: 'select',
          required: true,
          default: COLORS[0].value,
          label: TEXT.color,
          options: COLORS.map(({ value, label }) => ({ value, label })),
        },
      ],
    },
  };
}

function sceneFormButton(entry, on, language) {
  return {
    type: 'button',
    label: t(TEXT.scene, language),
    icon: on && entry.mode === 'scene' ? ACTIVE_ICON : 'film',
    action: {
      key: 'scene',
      fields: [
        {
          key: 'scene',
          type: 'select',
          required: true,
          default: entry.scene ?? SCENES[0].value,
          label: TEXT.scene,
          options: SCENES.map(({ value, label }) => ({ value, label })),
        },
      ],
    },
  };
}

// `params` come from the buttons above; `values` from a form (#3168).
async function action(hub, { actionKey, params = {}, settings, values = {}, language = 'en' }) {
  const externalId = settings?.device;
  const entry = externalId ? hub.entryByExternalId(externalId) : null;
  if (!entry) {
    throw new Error(t(TEXT.pick, language));
  }
  if (actionKey in WHITES) {
    const spec = featureSpecs(entry).find((s) => s.key === FEATURE_KEYS.COLOR_TEMPERATURE);
    if (!spec) {
      throw new Error('This light has no white tones');
    }
    await hub.setFeature(externalId, spec.key, clampKelvin(spec, WHITES[actionKey].kelvin));
  } else if (actionKey === 'color') {
    const color = colorOf(params.color ?? values.color) ?? colorOf(SETTING_DEFAULTS.color);
    await hub.setFeature(externalId, FEATURE_KEYS.COLOR, color.rgb);
  } else if (actionKey === 'scene' || actionKey === 'scene_2') {
    const scene = sceneOf(params.scene ?? values.scene) ?? sceneOf(SETTING_DEFAULTS[actionKey]);
    await hub.applyScene(externalId, scene.value);
  } else {
    throw new Error(`Unknown action ${actionKey}`);
  }
  return { message: TEXT.done };
}

export const WIDGETS = {
  [PRESETS_WIDGET]: { get, action },
};
