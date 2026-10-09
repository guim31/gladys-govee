// The UDP client against a simulated LAN: the reply paths a Docker bridge
// leaves (direct through the NAT, captured by the core, lost), and the
// mediated-capture protocol with the core (one capture at a time, refusals).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanClient } from '../src/lan/client.js';
import { SCAN_PORT, COMMAND_PORT, devStatusMessage, scanMessage } from '../src/lan/protocol.js';
import { FAST_TIMINGS, createFakeNetwork } from './helpers/fakeNetwork.js';
import { LAN_FIXTURES } from './helpers/world.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function setup({ paths = [], network: networkOptions = {}, refuse } = {}) {
  const devices = LAN_FIXTURES.slice(0, 3).map((device, index) => ({
    ...device,
    replyPath: paths[index] ?? 'direct',
  }));
  const network = createFakeNetwork({ devices, ...networkOptions });
  network.refuseCapture = refuse ?? null;
  const client = new LanClient({
    scanNetwork: network.scanNetwork,
    createSocket: network.createSocket,
    timings: FAST_TIMINGS,
    logger: silent,
  });
  return { network, client, devices };
}

const statusRequests = (devices) =>
  devices.map((device) => ({ ip: device.ip, port: COMMAND_PORT, payload: devStatusMessage() }));

test('direct answers: no capture is requested from the core', async () => {
  const { network, client, devices } = setup();
  await client.start();
  assert.equal(client.directBound, true);
  const replies = await client.exchange(statusRequests(devices), { cmd: 'devStatus' });
  assert.equal(replies.size, 3);
  assert.deepEqual(replies.get(devices[0].ip), devices[0].status);
  assert.equal(network.captures.length, 0);
  // Requests leave from port 4002, the port the devices answer to.
  assert.ok(network.sent.every((sent) => sent.fromPort === 4002));
  client.stop();
});

test('answers only the core can see come through one capture, then the capture goes first', async () => {
  const { network, client, devices } = setup({ paths: ['mediated', 'mediated', 'direct'] });
  await client.start();
  const first = await client.exchange(statusRequests(devices), { cmd: 'devStatus' });
  assert.equal(first.size, 3);
  assert.equal(network.captures.length, 1);
  assert.deepEqual(network.captures[0], { type: 'udp-broadcast', timeoutSeconds: 1 });
  assert.equal(client.preferMediated, true);
  assert.equal(client.mediation, 'available');

  // Next exchange: the capture is requested up front, still one per exchange.
  const second = await client.exchange(statusRequests(devices), { cmd: 'devStatus' });
  assert.equal(second.size, 3);
  assert.equal(network.captures.length, 2);
  assert.deepEqual(client.describe().stats, { direct: 2, mediated: 4 });
  client.stop();
});

test('concurrent exchanges never overlap captures (the core answers 409)', async () => {
  const { network, client, devices } = setup({ paths: ['mediated', 'mediated', 'mediated'] });
  await client.start();
  client.preferMediated = true;
  const results = await Promise.all(
    devices.map((device) => client.exchange(statusRequests([device]), { cmd: 'devStatus' })),
  );
  assert.deepEqual(
    results.map((map) => map.size),
    [1, 1, 1],
  );
  assert.equal(network.captures.length, 3);
  client.stop();
});

test('a core refusing the capture leaves the direct path only, and is not asked again', async () => {
  const { network, client, devices } = setup({
    paths: ['mediated', 'direct', 'direct'],
    refuse: 403,
  });
  await client.start();
  const first = await client.exchange(statusRequests(devices), { cmd: 'devStatus' });
  assert.equal(first.size, 2);
  assert.equal(client.mediation, 'unavailable');
  await client.exchange(statusRequests(devices), { cmd: 'devStatus' });
  assert.equal(network.captures.length, 1);
  client.stop();
});

test('a transient capture failure does not disable mediation', async () => {
  const { client, devices } = setup({ paths: ['mediated'], refuse: 500 });
  await client.start();
  await client.exchange(statusRequests(devices.slice(0, 1)), { cmd: 'devStatus' });
  assert.equal(client.mediation, 'unknown');
  client.stop();
});

test('port 4002 already taken: the client sends from another port and relies on the core', async () => {
  const { network, client, devices } = setup({ network: { portTaken: true } });
  await client.start();
  assert.equal(client.directBound, false);
  assert.equal(client.preferMediated, true);
  const replies = await client.exchange(statusRequests(devices), { cmd: 'devStatus' });
  assert.equal(replies.size, 3);
  assert.equal(network.captures.length, 1);
  client.stop();
});

test('lost answers: the exchange ends with what it got', async () => {
  const { client, devices } = setup({ paths: ['none', 'direct', 'none'] });
  await client.start();
  const replies = await client.exchange(statusRequests(devices), { cmd: 'devStatus' });
  assert.deepEqual([...replies.keys()], [devices[1].ip]);
  client.stop();
});

test('multicast discovery only works on a host network', async () => {
  const bridge = setup();
  await bridge.client.start();
  const nothing = await bridge.client.exchange([], {
    cmd: 'scan',
    multicast: scanMessage(),
    expectAll: false,
  });
  assert.equal(nothing.size, 0);
  bridge.client.stop();

  const host = setup({ network: { hostNetwork: true } });
  await host.client.start();
  const all = await host.client.exchange([], {
    cmd: 'scan',
    multicast: scanMessage(),
    expectAll: false,
  });
  assert.equal(all.size, 3);
  assert.equal(all.get(host.devices[0].ip).sku, 'H6008');
  host.client.stop();
});

test('a unicast sweep finds the devices among silent addresses', async () => {
  const { client, devices } = setup();
  await client.start();
  const requests = ['192.0.2.1', ...devices.map((d) => d.ip), '192.0.2.200'].map((ip) => ({
    ip,
    port: SCAN_PORT,
    payload: scanMessage(),
  }));
  const replies = await client.exchange(requests, { cmd: 'scan', expectAll: false });
  assert.deepEqual([...replies.keys()].sort(), devices.map((d) => d.ip).sort());
  client.stop();
});

test('send fails cleanly before start', () => {
  const { client } = setup();
  assert.throws(() => client.send('192.0.2.1', Buffer.from('x')), /not started/);
});
