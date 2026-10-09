import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudClient, DAILY_QUOTA, POLL_BUDGET } from '../src/cloud/client.js';
import { createFakeCloud } from './helpers/world.js';

const target = { sku: 'H5080', device: '1A:2B:3C:4D:5E:6F:70:11' };

test('requests carry the key header and a JSON body', async () => {
  const cloud = createFakeCloud();
  const client = new CloudClient({ apiKey: 'test-key', fetch: cloud.fetch });
  const devices = await client.listDevices();
  assert.equal(devices.length, 5);
  const capabilities = await client.getState(target);
  assert.equal(capabilities.find((c) => c.instance === 'powerSwitch').state.value, 1);
  await client.control(target, {
    type: 'devices.capabilities.on_off',
    instance: 'powerSwitch',
    value: 1,
  });
  assert.deepEqual(
    cloud.calls.map((c) => [c.method, c.path]),
    [
      ['GET', '/user/devices'],
      ['POST', '/device/state'],
      ['POST', '/device/control'],
    ],
  );
  for (const call of cloud.calls) {
    assert.equal(call.headers['Govee-API-Key'], 'test-key');
  }
  assert.match(cloud.calls[1].body.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(cloud.calls[1].body.payload, target);
  assert.equal(client.callsToday(), 3);
});

test('errors are explicit and never contain the key', async () => {
  for (const [status, pattern] of [
    [401, /key refused/],
    [429, /rate limit/],
    [500, /error 500/],
  ]) {
    const cloud = createFakeCloud({ status });
    const client = new CloudClient({ apiKey: 'super-secret', fetch: cloud.fetch });
    await assert.rejects(client.listDevices(), (err) => {
      assert.match(err.message, pattern);
      assert.equal(err.status, status);
      assert.ok(!err.message.includes('super-secret'));
      return true;
    });
  }
});

test('an HTTP 200 carrying an error code is an error', async () => {
  const fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 400, msg: 'Parameter error: device not found' }),
  });
  const client = new CloudClient({ apiKey: 'k', fetch });
  await assert.rejects(client.getState(target), /error 400: Parameter error/);
});

test('network failures are reported without stack noise', async () => {
  const fetch = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  };
  const client = new CloudClient({ apiKey: 'k', fetch });
  await assert.rejects(client.listDevices(), /unreachable: ENOTFOUND/);
});

test('polls stop at the budget, commands keep the margin, the counter resets daily', async () => {
  let now = new Date('2026-10-09T23:59:00Z');
  const cloud = createFakeCloud();
  const client = new CloudClient({
    apiKey: 'k',
    fetch: cloud.fetch,
    now: () => now,
    usage: { day: '2026-10-09', count: POLL_BUDGET },
  });
  await assert.rejects(client.getState(target, { automatic: true }), /budget/);
  await client.control(target, {
    type: 'devices.capabilities.on_off',
    instance: 'powerSwitch',
    value: 0,
  });
  client.usage.count = DAILY_QUOTA;
  await assert.rejects(client.control(target, {}), /budget/);

  now = new Date('2026-10-10T00:01:00Z');
  assert.equal(client.callsToday(), 0);
  await client.getState(target);
  assert.deepEqual(client.usage, { day: '2026-10-10', count: 1 });
});
