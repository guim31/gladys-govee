// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

import { parseAddresses } from './lan/addresses.js';

export const LAN_POLL_INTERVALS = [10, 30, 60, 120, 300]; // seconds
export const CLOUD_POLL_INTERVALS = [5, 10, 15, 30, 60]; // minutes
export const LANGUAGES = ['en', 'fr'];

export const DEFAULT_CONFIG = {
  lan_addresses: '',
  lan_poll_interval: '30',
  language: 'en',
  cloud_poll_interval: '10',
  // Reserved key (not in config_schema): the manifest declares both 'local'
  // and 'cloud' transports, so Gladys shows a "Prefer the local connection"
  // toggle and sends the choice here. Defaults to true.
  GLADYS_PREFER_LOCAL: true,
};

const pick = (value, allowed, fallback) => {
  const number = Number(value);
  return allowed.includes(number) ? number : fallback;
};

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const lanAddresses = typeof raw.lan_addresses === 'string' ? raw.lan_addresses : '';
  const apiKey = typeof raw.api_key === 'string' ? raw.api_key.trim() : '';
  return {
    lanAddresses,
    addresses: parseAddresses(lanAddresses),
    lanPollSeconds: pick(raw.lan_poll_interval, LAN_POLL_INTERVALS, 30),
    language: LANGUAGES.includes(raw.language) ? raw.language : 'en',
    apiKey,
    cloudPollMinutes: pick(raw.cloud_poll_interval, CLOUD_POLL_INTERVALS, 10),
    preferLocal: raw.GLADYS_PREFER_LOCAL !== false,
  };
}
