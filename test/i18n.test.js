// Every text shown to the user exists in the four languages of the Gladys
// interface (front/src/config/i18n/{en,fr,de,es}.json): the manifest, and the
// tables of messages the code sends to Gladys. German says "du", never the
// polite "Sie".

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MESSAGES as APP_MESSAGES, diagnosticMessage } from '../src/app.js';
import { LANGUAGES } from '../src/config.js';
import { NAMES, TOGGLE_NAMES } from '../src/features.js';
import { MESSAGES as HUB_MESSAGES } from '../src/hub.js';
import { COLORS, SCENES, WHITES } from '../src/presets.js';
import { TEXT as WIDGET_TEXT } from '../src/widgets.js';

const REQUIRED = ['en', 'fr', 'de', 'es'];
const POLITE_GERMAN = /(?<![\p{L}])(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?![\p{L}])/u;

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

/** An object carrying at least one language key is a multi-language text. */
const isMultilingual = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  REQUIRED.some((language) => language in value);

/** Every multi-language object under `root`, with its path. */
function collect(root, path) {
  const found = [];
  const walk = (value, at) => {
    if (isMultilingual(value)) {
      found.push({ at, text: value });
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${at}[${i}]`));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        walk(item, `${at}.${key}`);
      }
    }
  };
  walk(root, path);
  return found;
}

/** The problems of one text, [] when it is fine. */
function check({ at, text }, maxLength) {
  const problems = [];
  const keys = Object.keys(text).sort();
  if (keys.join() !== [...REQUIRED].sort().join()) {
    problems.push(`${at}: languages ${keys.join(', ')} instead of ${REQUIRED.join(', ')}`);
  }
  for (const language of REQUIRED) {
    const value = text[language];
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${at}.${language}: missing or empty`);
    } else if (value.length > maxLength) {
      problems.push(`${at}.${language}: ${value.length} characters, ${maxLength} at most`);
    }
  }
  if (typeof text.de === 'string' && POLITE_GERMAN.test(text.de)) {
    problems.push(`${at}.de: polite form ("${text.de.match(POLITE_GERMAN)[0]}"), use "du"`);
  }
  return problems;
}

const checkAll = (texts, maxLength) => texts.flatMap((text) => check(text, maxLength));

// A summary that takes every branch of the diagnostic report.
const FULL_SUMMARY = {
  lan: 3,
  lanReachable: 2,
  cloud: 1,
  cloudCallsToday: 42,
  cloudError: null,
  addresses: { addresses: [], invalid: ['nope'], truncated: true },
  network: { stats: { mediated: 1, direct: 0 }, preferMediated: false, mediation: 'unavailable' },
};

const CODE_TEXTS = [
  // Connection status, transport badges and action results: a toast shows
  // 200 characters.
  { texts: collect(APP_MESSAGES, 'app.MESSAGES'), max: 200 },
  { texts: collect(HUB_MESSAGES, 'hub.MESSAGES'), max: 200 },
  { texts: collect(WIDGET_TEXT, 'widgets.TEXT'), max: 200 },
  // Widget buttons, tiles and select options: short.
  { texts: collect(SCENES, 'presets.SCENES'), max: 20 },
  { texts: collect(COLORS, 'presets.COLORS'), max: 20 },
  { texts: collect(WHITES, 'presets.WHITES'), max: 20 },
  { texts: collect(TOGGLE_NAMES, 'features.TOGGLE_NAMES'), max: 40 },
  {
    texts: [
      { at: 'diagnosticMessage(every branch)', text: diagnosticMessage(FULL_SUMMARY) },
      {
        at: 'diagnosticMessage(cloud error)',
        text: diagnosticMessage({ ...FULL_SUMMARY, cloudError: 'HTTP 500' }),
      },
    ],
    max: 1000,
  },
];

test('the guard sees the texts it must check', () => {
  assert.ok(collect(manifest, 'manifest').length >= 80);
  for (const { texts } of CODE_TEXTS) {
    assert.ok(texts.length > 0);
  }
});

test('every manifest text has en, fr, de and es, none empty or too long', () => {
  const texts = collect(manifest, 'manifest');
  const description = texts.filter(({ at }) => at === 'manifest.description');
  assert.equal(description.length, 1);
  assert.deepEqual(
    [...checkAll(description, 100), ...checkAll(texts, 600)],
    [],
    'the catalog description holds 100 characters at most, every text 600',
  );
});

test('every text of the code has en, fr, de and es, none empty or too long', () => {
  assert.deepEqual(
    CODE_TEXTS.flatMap(({ texts, max }) => checkAll(texts, max)),
    [],
  );
});

test('the feature names exist in every language of the setting', () => {
  const options = manifest.config_schema
    .find((field) => field.key === 'language')
    .options.map((option) => option.value);
  assert.deepEqual(options, LANGUAGES);
  assert.deepEqual(Object.keys(NAMES), LANGUAGES);
  assert.deepEqual([...LANGUAGES].sort(), [...REQUIRED].sort());
  const problems = [];
  for (const language of LANGUAGES) {
    assert.deepEqual(Object.keys(NAMES[language]), Object.keys(NAMES.en), language);
    for (const [key, name] of Object.entries(NAMES[language])) {
      if (typeof name !== 'string' || name.trim() === '' || name.length > 40) {
        problems.push(`NAMES.${language}.${key}`);
      }
      if (language === 'de' && POLITE_GERMAN.test(name)) {
        problems.push(`NAMES.de.${key}: polite form`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the guard catches a forgotten language, an empty text and a polite German', () => {
  const broken = {
    label: { en: 'Light', fr: 'Lampe', de: 'Lampe' },
    hint: { en: 'Hint', fr: 'Astuce', de: ' ', es: 'Consejo' },
    help: { en: 'Choose', fr: 'Choisissez', de: 'Wählen Sie', es: 'Elija' },
    note: { en: 'Your light', fr: 'Votre lampe', de: 'Ihre Lampe', es: 'Su luz' },
    long: { en: 'x'.repeat(31), fr: 'x', de: 'x', es: 'x' },
    fine: { en: 'Light', fr: 'Lampe', de: 'Lampe', es: 'Luz' },
    // "sie" (they) is not the polite form.
    plural: { en: 'They', fr: 'Elles', de: 'Prüfe, ob sie antworten.', es: 'Ellas' },
  };
  const problems = checkAll(collect(broken, 'broken'), 30);
  assert.equal(problems.length, 6, problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('broken.label: languages')));
  assert.ok(problems.some((p) => p.startsWith('broken.label.es: missing')));
  assert.ok(problems.some((p) => p.startsWith('broken.hint.de: missing or empty')));
  assert.ok(problems.some((p) => p.startsWith('broken.help.de: polite')));
  assert.ok(problems.some((p) => p.startsWith('broken.note.de: polite')));
  assert.ok(problems.some((p) => p.startsWith('broken.long.en: 31 characters')));
});
