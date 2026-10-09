// -----------------------------------------------------------------------------
// Presets offered by the dashboard widget and the scene action: built-in Govee
// scenes (codes in src/lan/protocol.js), white tones and colours.
// The `value`s are stored in user scenes and widget actions: permanent.
// -----------------------------------------------------------------------------

import { SCENE_CODES } from './lan/protocol.js';

export const SCENES = [
  { value: 'sunrise', label: { en: 'Sunrise', fr: 'Lever de soleil' } },
  { value: 'sunset', label: { en: 'Sunset', fr: 'Coucher de soleil' } },
  { value: 'movie', label: { en: 'Movie', fr: 'Cinéma' } },
  { value: 'dating', label: { en: 'Dating', fr: 'Rendez-vous' } },
  { value: 'romantic', label: { en: 'Romantic', fr: 'Romantique' } },
  { value: 'twinkle', label: { en: 'Twinkle', fr: 'Scintillement' } },
  { value: 'candlelight', label: { en: 'Candlelight', fr: 'Bougie' } },
  { value: 'breathe', label: { en: 'Breathe', fr: 'Respiration' } },
  { value: 'snowflake', label: { en: 'Snowflake', fr: 'Flocon de neige' } },
  { value: 'energetic', label: { en: 'Energetic', fr: 'Énergique' } },
  { value: 'crossing', label: { en: 'Crossing', fr: 'Croisement' } },
];

// Every scene listed has a code, and every code is offered.
if (
  SCENES.length !== Object.keys(SCENE_CODES).length ||
  SCENES.some((s) => !(s.value in SCENE_CODES))
) {
  throw new Error('SCENES and SCENE_CODES are out of sync');
}

export const WHITES = {
  warm: { kelvin: 2700, label: { en: 'Warm white', fr: 'Blanc chaud' } },
  daylight: { kelvin: 6500, label: { en: 'Daylight', fr: 'Lumière du jour' } },
};

export const COLORS = [
  { value: 'red', rgb: 0xff0000, label: { en: 'Red', fr: 'Rouge' } },
  { value: 'orange', rgb: 0xff7f00, label: { en: 'Orange', fr: 'Orange' } },
  { value: 'yellow', rgb: 0xffd200, label: { en: 'Yellow', fr: 'Jaune' } },
  { value: 'green', rgb: 0x00ff00, label: { en: 'Green', fr: 'Vert' } },
  { value: 'cyan', rgb: 0x00ffff, label: { en: 'Cyan', fr: 'Cyan' } },
  { value: 'blue', rgb: 0x0000ff, label: { en: 'Blue', fr: 'Bleu' } },
  { value: 'purple', rgb: 0x8000ff, label: { en: 'Purple', fr: 'Violet' } },
  { value: 'pink', rgb: 0xff3c9b, label: { en: 'Pink', fr: 'Rose' } },
];

export const sceneLabel = (value) => SCENES.find((scene) => scene.value === value)?.label;
