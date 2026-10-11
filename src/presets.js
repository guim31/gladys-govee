// -----------------------------------------------------------------------------
// Presets offered by the dashboard widget and the scene action: built-in Govee
// scenes (codes in src/lan/protocol.js), white tones and colours.
// The `value`s are stored in user scenes and widget actions: permanent.
// -----------------------------------------------------------------------------

import { SCENE_CODES } from './lan/protocol.js';

export const SCENES = [
  {
    value: 'sunrise',
    label: { en: 'Sunrise', fr: 'Lever de soleil', de: 'Sonnenaufgang', es: 'Amanecer' },
  },
  {
    value: 'sunset',
    label: { en: 'Sunset', fr: 'Coucher de soleil', de: 'Sonnenuntergang', es: 'Puesta de sol' },
  },
  { value: 'movie', label: { en: 'Movie', fr: 'Cinéma', de: 'Kino', es: 'Cine' } },
  { value: 'dating', label: { en: 'Dating', fr: 'Rendez-vous', de: 'Date', es: 'Cita' } },
  {
    value: 'romantic',
    label: { en: 'Romantic', fr: 'Romantique', de: 'Romantisch', es: 'Romántico' },
  },
  {
    value: 'twinkle',
    label: { en: 'Twinkle', fr: 'Scintillement', de: 'Funkeln', es: 'Centelleo' },
  },
  {
    value: 'candlelight',
    label: { en: 'Candlelight', fr: 'Bougie', de: 'Kerzenlicht', es: 'Luz de vela' },
  },
  { value: 'breathe', label: { en: 'Breathe', fr: 'Respiration', de: 'Atmen', es: 'Respiración' } },
  {
    value: 'snowflake',
    label: { en: 'Snowflake', fr: 'Flocon de neige', de: 'Schneeflocke', es: 'Copo de nieve' },
  },
  {
    value: 'energetic',
    label: { en: 'Energetic', fr: 'Énergique', de: 'Energisch', es: 'Enérgico' },
  },
  { value: 'crossing', label: { en: 'Crossing', fr: 'Croisement', de: 'Kreuzung', es: 'Cruce' } },
];

// Every scene listed has a code, and every code is offered.
if (
  SCENES.length !== Object.keys(SCENE_CODES).length ||
  SCENES.some((s) => !(s.value in SCENE_CODES))
) {
  throw new Error('SCENES and SCENE_CODES are out of sync');
}

export const WHITES = {
  warm: {
    kelvin: 2700,
    label: { en: 'Warm white', fr: 'Blanc chaud', de: 'Warmweiß', es: 'Blanco cálido' },
  },
  daylight: {
    kelvin: 6500,
    label: { en: 'Daylight', fr: 'Lumière du jour', de: 'Tageslicht', es: 'Luz de día' },
  },
};

export const COLORS = [
  { value: 'red', rgb: 0xff0000, label: { en: 'Red', fr: 'Rouge', de: 'Rot', es: 'Rojo' } },
  {
    value: 'orange',
    rgb: 0xff7f00,
    label: { en: 'Orange', fr: 'Orange', de: 'Orange', es: 'Naranja' },
  },
  {
    value: 'yellow',
    rgb: 0xffd200,
    label: { en: 'Yellow', fr: 'Jaune', de: 'Gelb', es: 'Amarillo' },
  },
  { value: 'green', rgb: 0x00ff00, label: { en: 'Green', fr: 'Vert', de: 'Grün', es: 'Verde' } },
  { value: 'cyan', rgb: 0x00ffff, label: { en: 'Cyan', fr: 'Cyan', de: 'Cyan', es: 'Cian' } },
  { value: 'blue', rgb: 0x0000ff, label: { en: 'Blue', fr: 'Bleu', de: 'Blau', es: 'Azul' } },
  {
    value: 'purple',
    rgb: 0x8000ff,
    label: { en: 'Purple', fr: 'Violet', de: 'Violett', es: 'Morado' },
  },
  { value: 'pink', rgb: 0xff3c9b, label: { en: 'Pink', fr: 'Rose', de: 'Rosa', es: 'Rosa' } },
];

export const sceneLabel = (value) => SCENES.find((scene) => scene.value === value)?.label;
