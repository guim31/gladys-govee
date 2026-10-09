import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  brightnessMessage,
  colorMessage,
  devStatusMessage,
  intToRgb,
  kelvinMessage,
  normalizeDeviceId,
  parseMessage,
  parseScanReply,
  parseStatusReply,
  rgbToInt,
  scanMessage,
  sceneMessage,
  turnMessage,
} from '../src/lan/protocol.js';
import { LAN_FIXTURES } from './helpers/world.js';

const json = (buffer) => JSON.parse(buffer.toString('utf8'));

// Expected payloads: the ones govee-local-api's own tests pin (tests/test_message.py).
test('requests match the Govee LAN API wire format', () => {
  assert.deepEqual(json(scanMessage()), {
    msg: { cmd: 'scan', data: { account_topic: 'reserve' } },
  });
  assert.deepEqual(json(devStatusMessage()), { msg: { cmd: 'devStatus', data: {} } });
  assert.deepEqual(json(turnMessage(true)), { msg: { cmd: 'turn', data: { value: 1 } } });
  assert.deepEqual(json(turnMessage(false)), { msg: { cmd: 'turn', data: { value: 0 } } });
  assert.deepEqual(json(brightnessMessage(42)), {
    msg: { cmd: 'brightness', data: { value: 42 } },
  });
  assert.deepEqual(json(colorMessage(rgbToInt({ r: 64, g: 128, b: 255 }))), {
    msg: { cmd: 'colorwc', data: { color: { r: 64, g: 128, b: 255 }, colorTemInKelvin: 0 } },
  });
  assert.deepEqual(json(kelvinMessage(5000, [2000, 9000])), {
    msg: { cmd: 'colorwc', data: { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 5000 } },
  });
});

test('values are clamped to what the devices accept', () => {
  // Govee documents brightness 1-100: 0 is "off", sent as `turn` by the hub.
  assert.equal(json(brightnessMessage(0)).msg.data.value, 1);
  assert.equal(json(brightnessMessage(150)).msg.data.value, 100);
  assert.equal(json(brightnessMessage(49.6)).msg.data.value, 50);
  assert.equal(json(kelvinMessage(2000, [2700, 6500])).msg.data.colorTemInKelvin, 2700);
  assert.equal(json(kelvinMessage(9000, [2700, 6500])).msg.data.colorTemInKelvin, 6500);
  assert.deepEqual(json(colorMessage(-5)).msg.data.color, { r: 0, g: 0, b: 0 });
  assert.deepEqual(json(colorMessage(0x1ffffff)).msg.data.color, { r: 255, g: 255, b: 255 });
});

test('scenes are ptReal frames with the XOR checksum', () => {
  const frame = Buffer.from(json(sceneMessage('sunset')).msg.data.command[0], 'base64');
  // 0x33 0x05 0x04 <code> + zero padding, checksum = XOR of the 19 bytes.
  assert.equal(frame.toString('hex'), '3305040100000000000000000000000000000033');
  const candle = Buffer.from(json(sceneMessage('candlelight')).msg.data.command[0], 'base64');
  assert.equal(candle.length, 20);
  assert.equal(candle[3], 0x09);
  assert.equal(candle[19], 0x33 ^ 0x05 ^ 0x04 ^ 0x09);
  assert.throws(() => sceneMessage('disco'), /Unknown scene/);
});

test('scan answers of every fixture model parse', () => {
  for (const fixture of LAN_FIXTURES) {
    const payload = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: fixture.scan } }));
    const message = parseMessage(payload);
    assert.equal(message.cmd, 'scan');
    const reply = parseScanReply(message.data, fixture.ip);
    assert.equal(reply.sku, fixture.scan.sku);
    assert.equal(reply.ip, fixture.ip);
    assert.equal(reply.rawId, fixture.scan.device);
    assert.match(reply.id, /^[0-9a-f]{16}$/);
  }
});

test('a scan answer without id or SKU is ignored', () => {
  assert.equal(parseScanReply({ sku: 'H6008' }, '192.0.2.1'), null);
  assert.equal(parseScanReply({ device: '1A:2B', sku: 'H6008' }, '192.0.2.1'), null);
  assert.equal(parseScanReply({ device: '1A:2B:3C:4D:5E:6F:70:01' }, '192.0.2.1'), null);
});

test('devStatus answers map to on/off, brightness, colour and white tone', () => {
  assert.deepEqual(
    parseStatusReply({
      onOff: 1,
      brightness: 100,
      color: { r: 255, g: 0, b: 0 },
      colorTemInKelvin: 7200,
    }),
    { on: true, brightness: 100, color: 0xff0000, kelvin: 7200 },
  );
  // colorTemInKelvin 0 = colour mode, no white tone to report.
  assert.equal(parseStatusReply({ onOff: 0, colorTemInKelvin: 0 }).kelvin, null);
  // A firmware that omits fields: nothing invented.
  assert.deepEqual(parseStatusReply({ onOff: 1 }), { on: true });
  assert.deepEqual(parseStatusReply({ onOff: 'yes', color: { r: 1 } }), {});
});

test('noise on port 4002 is ignored', () => {
  assert.equal(parseMessage(Buffer.from('M-SEARCH * HTTP/1.1')), null);
  assert.equal(parseMessage(Buffer.from('{"msg":{"cmd":"scan"}}')), null);
  assert.equal(parseMessage(Buffer.from('{"msg":{"data":{}}}')), null);
  assert.equal(parseMessage(Buffer.from('null')), null);
});

test('device ids normalize to stable lowercase hex', () => {
  assert.equal(normalizeDeviceId('1F:80:C5:32:32:36:72:4E'), '1f80c5323236724e');
  assert.equal(normalizeDeviceId('1f80c5323236724e'), '1f80c5323236724e');
  assert.equal(normalizeDeviceId(''), null);
  assert.equal(normalizeDeviceId(undefined), null);
});

test('RGB integers round-trip', () => {
  assert.equal(rgbToInt({ r: 18, g: 52, b: 86 }), 0x123456);
  assert.deepEqual(intToRgb(0x123456), { r: 18, g: 52, b: 86 });
});
