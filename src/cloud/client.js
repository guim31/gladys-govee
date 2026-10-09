// -----------------------------------------------------------------------------
// Client for the official Govee cloud API ("Govee OpenAPI", v2 router API).
//
//   GET  /router/api/v1/user/devices     the account's devices + capabilities
//   POST /router/api/v1/device/state     current state of one device
//   POST /router/api/v1/device/control   run one capability
//
// Authentication: the `Govee-API-Key` header, a key the user requests in the
// Govee Home app. Govee allows 10,000 requests per account and per day: the
// client counts its own calls per UTC day and refuses the automatic ones (polls)
// beyond a budget, so user commands always keep a margin.
//
// The key is never logged, and never part of an error message.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

export const API_BASE_URL = 'https://openapi.api.govee.com/router/api/v1';
export const DAILY_QUOTA = 10000;
// Polls stop here; the remaining 2,000 calls are kept for commands.
export const POLL_BUDGET = 8000;

const REQUEST_TIMEOUT_MS = 10000;

export class GoveeCloudError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'GoveeCloudError';
    this.status = status;
    this.code = code;
  }
}

export class CloudClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {typeof fetch} [options.fetch]
   * @param {() => Date} [options.now]
   * @param {{ day: string, count: number }} [options.usage] persisted usage
   */
  constructor({ apiKey, fetch: fetchImpl, now, usage } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.now = now ?? (() => new Date());
    this.usage = usage?.day ? { ...usage } : { day: this.today(), count: 0 };
  }

  today() {
    return this.now().toISOString().slice(0, 10);
  }

  /** Calls made today (UTC), the counter the quota applies to. */
  callsToday() {
    if (this.usage.day !== this.today()) {
      this.usage = { day: this.today(), count: 0 };
    }
    return this.usage.count;
  }

  async request(method, path, body, { automatic = false } = {}) {
    const used = this.callsToday();
    if (used >= DAILY_QUOTA || (automatic && used >= POLL_BUDGET)) {
      throw new GoveeCloudError('Daily Govee API budget reached, polls resume tomorrow (UTC)', {
        code: 'BUDGET',
      });
    }
    this.usage.count += 1;
    let response;
    try {
      response = await this.fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: { 'Govee-API-Key': this.apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GoveeCloudError(`Govee API unreachable: ${err.cause?.code ?? err.message}`, {
        code: 'NETWORK',
      });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A proxy error page or an empty body: the status says enough.
    }
    // Govee answers errors with an HTTP status and/or a `code` in the body.
    const code = Number(payload?.code ?? response.status);
    if (!response.ok || (Number.isFinite(code) && code !== 200)) {
      const status = response.ok ? code : response.status;
      throw new GoveeCloudError(describeError(status, payload), { status });
    }
    return payload;
  }

  /** The account's devices (`data` of /user/devices). */
  async listDevices() {
    const payload = await this.request('GET', '/user/devices');
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  /** Capability states of one device (`payload.capabilities` of /device/state). */
  async getState({ sku, device }, { automatic = true } = {}) {
    const payload = await this.request(
      'POST',
      '/device/state',
      { requestId: randomUUID(), payload: { sku, device } },
      { automatic },
    );
    return Array.isArray(payload?.payload?.capabilities) ? payload.payload.capabilities : [];
  }

  async control({ sku, device }, capability) {
    return this.request('POST', '/device/control', {
      requestId: randomUUID(),
      payload: { sku, device, capability },
    });
  }
}

function describeError(status, payload) {
  const detail =
    typeof (payload?.msg ?? payload?.message) === 'string' ? (payload.msg ?? payload.message) : '';
  if (status === 401 || status === 403) {
    return 'Govee API key refused: check the key in the integration settings';
  }
  if (status === 429) {
    return 'Govee API rate limit reached (10,000 requests per day)';
  }
  return `Govee API error ${status}${detail ? `: ${detail.slice(0, 120)}` : ''}`;
}
