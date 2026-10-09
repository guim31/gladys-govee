import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ADDRESSES, parseAddresses } from '../src/lan/addresses.js';

test('single addresses, with any separator', () => {
  assert.deepEqual(
    parseAddresses('192.0.2.1, 192.0.2.2;192.0.2.3\n192.0.2.4  192.0.2.1').addresses,
    ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4'],
  );
});

test('ranges, short ranges and CIDR blocks', () => {
  assert.deepEqual(parseAddresses('192.0.2.10-192.0.2.12').addresses, [
    '192.0.2.10',
    '192.0.2.11',
    '192.0.2.12',
  ]);
  assert.deepEqual(parseAddresses('192.0.2.250-252').addresses, [
    '192.0.2.250',
    '192.0.2.251',
    '192.0.2.252',
  ]);
  const block = parseAddresses('192.0.2.77/24').addresses;
  // Network and broadcast addresses are skipped.
  assert.equal(block.length, 254);
  assert.equal(block[0], '192.0.2.1');
  assert.equal(block.at(-1), '192.0.2.254');
  assert.deepEqual(parseAddresses('192.0.2.8/31').addresses, ['192.0.2.8', '192.0.2.9']);
});

test('invalid entries are reported, not guessed', () => {
  const { addresses, invalid } = parseAddresses(
    'bulb.local, 192.0.2.300, 192.0.2.9-3, 192.0.2.1-999, 10.0.0.0/0, 192.0.2.5',
  );
  assert.deepEqual(addresses, ['192.0.2.5']);
  assert.deepEqual(invalid, [
    'bulb.local',
    '192.0.2.300',
    '192.0.2.9-3',
    '192.0.2.1-999',
    '10.0.0.0/0',
  ]);
});

test('the sweep is capped', () => {
  const { addresses, truncated } = parseAddresses('10.0.0.0/16');
  assert.equal(addresses.length, MAX_ADDRESSES);
  assert.equal(truncated, true);
});

test('empty or missing configuration', () => {
  assert.deepEqual(parseAddresses(''), { addresses: [], invalid: [], truncated: false });
  assert.deepEqual(parseAddresses(undefined), { addresses: [], invalid: [], truncated: false });
});
