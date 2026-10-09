// -----------------------------------------------------------------------------
// Govee LAN API: message builders and parsers (pure functions, no sockets).
//
// The protocol, as documented by Govee ("Govee LAN API" / WLAN guide) and
// implemented by govee-local-api:
//   - discovery: `scan` sent to 239.255.255.250:4001 (multicast) or to one
//     device IP on port 4001 (unicast); the device answers on port 4002 of the
//     sender with its id, SKU and IP;
//   - control: `turn`, `brightness`, `colorwc`, `ptReal` sent to port 4003, no
//     answer;
//   - state: `devStatus` sent to port 4003, the device answers on port 4002.
// Every message is the JSON `{ "msg": { "cmd": ..., "data": ... } }`.
// -----------------------------------------------------------------------------

export const MULTICAST_ADDRESS = '239.255.255.250';
export const SCAN_PORT = 4001;
export const REPLY_PORT = 4002;
export const COMMAND_PORT = 4003;

function encode(cmd, data) {
  return Buffer.from(JSON.stringify({ msg: { cmd, data } }));
}

const clampInt = (value, min, max) => Math.max(min, Math.min(max, Math.round(Number(value))));

export function scanMessage() {
  return encode('scan', { account_topic: 'reserve' });
}

export function devStatusMessage() {
  return encode('devStatus', {});
}

export function turnMessage(on) {
  return encode('turn', { value: on ? 1 : 0 });
}

// Govee documents 1-100: 0 is not a brightness, the caller turns the light
// off instead.
export function brightnessMessage(percent) {
  return encode('brightness', { value: clampInt(percent, 1, 100) });
}

// `colorTemInKelvin: 0` tells the device to use the RGB colour.
export function colorMessage(rgbInt) {
  const { r, g, b } = intToRgb(rgbInt);
  return encode('colorwc', { color: { r, g, b }, colorTemInKelvin: 0 });
}

export function kelvinMessage(kelvin, [minKelvin, maxKelvin]) {
  return encode('colorwc', {
    color: { r: 0, g: 0, b: 0 },
    colorTemInKelvin: clampInt(kelvin, minKelvin, maxKelvin),
  });
}

// Built-in scenes, sent as a raw BLE-style frame wrapped in `ptReal`: 0x33 0x05
// 0x04, the scene code, zero padding to 19 bytes, then an XOR checksum byte.
// Codes from govee-local-api (SCENE_CODES), verified by its users.
export const SCENE_CODES = {
  sunrise: 0x00,
  sunset: 0x01,
  movie: 0x04,
  dating: 0x05,
  romantic: 0x07,
  twinkle: 0x08,
  candlelight: 0x09,
  breathe: 0x0a,
  snowflake: 0x0f,
  energetic: 0x10,
  crossing: 0x15,
};

export function sceneMessage(scene) {
  const code = SCENE_CODES[scene];
  if (code === undefined) {
    throw new Error(`Unknown scene "${scene}"`);
  }
  const frame = Buffer.alloc(20);
  frame.set([0x33, 0x05, 0x04, code]);
  frame[19] = frame.subarray(0, 19).reduce((xor, byte) => xor ^ byte, 0);
  return encode('ptReal', { command: [frame.toString('base64')] });
}

/**
 * Parse one datagram received on port 4002. Returns `{ cmd, data }`, or null
 * for anything else (other devices and services send noise there too).
 * @param {Buffer|string} payload
 */
export function parseMessage(payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  const msg = parsed?.msg;
  if (!msg || typeof msg.cmd !== 'string' || msg.data === null || typeof msg.data !== 'object') {
    return null;
  }
  return { cmd: msg.cmd, data: msg.data };
}

/**
 * Normalize a `scan` answer: `{ id, rawId, sku, ip, firmware }`, or null when
 * the answer lacks the device id or the SKU.
 */
export function parseScanReply(data, sourceIp) {
  if (typeof data.device !== 'string' || typeof data.sku !== 'string') {
    return null;
  }
  const id = normalizeDeviceId(data.device);
  if (!id) {
    return null;
  }
  return {
    id,
    rawId: data.device,
    sku: data.sku.toUpperCase(),
    // The source address is what reaches the device; the IP the device
    // reports about itself is only a fallback (equal in practice).
    ip: sourceIp || data.ip,
    firmware: typeof data.wifiVersionSoft === 'string' ? data.wifiVersionSoft : undefined,
  };
}

/**
 * Normalize a `devStatus` answer. Every field is optional: a firmware that
 * omits one must not make us publish a wrong value.
 */
export function parseStatusReply(data) {
  const status = {};
  if (data.onOff === 0 || data.onOff === 1) {
    status.on = data.onOff === 1;
  }
  if (Number.isFinite(data.brightness)) {
    status.brightness = clampInt(data.brightness, 0, 100);
  }
  const { color } = data;
  if (color && [color.r, color.g, color.b].every(Number.isFinite)) {
    status.color = rgbToInt(color);
  }
  if (Number.isFinite(data.colorTemInKelvin)) {
    // 0 means "colour mode": no colour temperature to report.
    status.kelvin = data.colorTemInKelvin > 0 ? Math.round(data.colorTemInKelvin) : null;
  }
  return status;
}

// Govee ids look like "1F:80:C5:32:32:36:72:4E" (LAN) and the same string in
// the cloud API. External ids keep only the lowercase hex digits: stable, and
// free of the ':' separator Gladys external ids use.
export function normalizeDeviceId(raw) {
  const hex = String(raw ?? '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  return hex.length >= 8 ? hex : null;
}

export function rgbToInt({ r, g, b }) {
  return (clampInt(r, 0, 255) << 16) | (clampInt(g, 0, 255) << 8) | clampInt(b, 0, 255);
}

export function intToRgb(value) {
  const int = clampInt(value, 0, 0xffffff);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}
