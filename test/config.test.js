import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';

test('defaults when nothing is configured', () => {
  const config = normalizeConfig({});
  assert.deepEqual(
    {
      lanPollSeconds: config.lanPollSeconds,
      cloudPollMinutes: config.cloudPollMinutes,
      language: config.language,
      apiKey: config.apiKey,
      preferLocal: config.preferLocal,
      addresses: config.addresses.addresses,
    },
    {
      lanPollSeconds: Number(DEFAULT_CONFIG.lan_poll_interval),
      cloudPollMinutes: Number(DEFAULT_CONFIG.cloud_poll_interval),
      language: 'en',
      apiKey: '',
      preferLocal: true,
      addresses: [],
    },
  );
});

test('form values arrive as strings and are checked against the choices', () => {
  const config = normalizeConfig({
    lan_addresses: '192.0.2.10-11',
    lan_poll_interval: '10',
    cloud_poll_interval: '60',
    language: 'fr',
    api_key: '  key-with-spaces  ',
    GLADYS_PREFER_LOCAL: false,
  });
  assert.deepEqual(config.addresses.addresses, ['192.0.2.10', '192.0.2.11']);
  assert.equal(config.lanPollSeconds, 10);
  assert.equal(config.cloudPollMinutes, 60);
  assert.equal(config.language, 'fr');
  assert.equal(config.apiKey, 'key-with-spaces');
  assert.equal(config.preferLocal, false);

  const odd = normalizeConfig({ lan_poll_interval: '7', cloud_poll_interval: '1', language: 'de' });
  assert.equal(odd.lanPollSeconds, 30);
  assert.equal(odd.cloudPollMinutes, 10);
  assert.equal(odd.language, 'en');
});
