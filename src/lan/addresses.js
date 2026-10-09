// -----------------------------------------------------------------------------
// Parse the "IP addresses or ranges" configuration field into a list of IPv4
// addresses to probe with a unicast `scan`.
//
// Accepted, separated by commas, semicolons, spaces or line breaks:
//   192.168.1.42                 one address
//   192.168.1.0/24               a CIDR block (network and broadcast skipped)
//   192.168.1.20-192.168.1.60    a range
//   192.168.1.20-60              a range within the last byte
// The total is capped: a probe is a tiny datagram, but sweeping a /16 from a
// home automation box is never what the user meant.
// -----------------------------------------------------------------------------

export const MAX_ADDRESSES = 1024;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipToInt(text) {
  const match = IPV4.exec(text);
  if (!match) {
    return null;
  }
  const bytes = match.slice(1).map(Number);
  if (bytes.some((byte) => byte > 255)) {
    return null;
  }
  return bytes.reduce((int, byte) => int * 256 + byte, 0);
}

function intToIp(int) {
  return [24, 16, 8, 0].map((shift) => Math.floor(int / 2 ** shift) % 256).join('.');
}

function expand(token) {
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(token);
  if (cidr) {
    const base = ipToInt(cidr[1]);
    const prefix = Number(cidr[2]);
    if (base === null || prefix < 1 || prefix > 32) {
      return null;
    }
    const size = 2 ** (32 - prefix);
    const network = base - (base % size);
    // /31 and /32 have no network or broadcast address to skip.
    return size <= 2 ? [network, network + size - 1] : [network + 1, network + size - 2];
  }
  const range = /^([\d.]+)-([\d.]+)$/.exec(token);
  if (range) {
    const start = ipToInt(range[1]);
    let end = ipToInt(range[2]);
    if (end === null && /^\d{1,3}$/.test(range[2]) && start !== null) {
      end = start - (start % 256) + Number(range[2]);
    }
    if (start === null || end === null || end < start || Number(range[2]) > 255) {
      return null;
    }
    return [start, end];
  }
  const single = ipToInt(token);
  return single === null ? null : [single, single];
}

/**
 * @param {string} text the raw configuration value
 * @returns {{ addresses: string[], invalid: string[], truncated: boolean }}
 */
export function parseAddresses(text) {
  const tokens = String(text ?? '')
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const seen = new Set();
  const invalid = [];
  let truncated = false;
  for (const token of tokens) {
    const bounds = expand(token);
    if (!bounds) {
      invalid.push(token);
      continue;
    }
    for (let int = bounds[0]; int <= bounds[1]; int += 1) {
      if (seen.size >= MAX_ADDRESSES) {
        truncated = true;
        break;
      }
      seen.add(int);
    }
  }
  return { addresses: [...seen].map(intToIp), invalid, truncated };
}
