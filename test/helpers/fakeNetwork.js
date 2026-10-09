// -----------------------------------------------------------------------------
// A simulated LAN of Govee devices behind the Gladys Docker bridge.
//
// Each device answers the Govee LAN API like the real ones (fixtures in
// test/fixtures/lan/), keeps a state the control commands change, and sends
// its answers along one of the paths the integration must cope with:
//   - 'direct'   the answer reaches the container (it sent from port 4002 and
//                the NAT matched the answer to its request, or host network);
//   - 'mediated' the answer reaches the host only: the core captures it when a
//                `udp-broadcast` scan on port 4002 is running;
//   - 'none'     the answer is lost (e.g. another program holds port 4002).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { FakeApiError } from './fakeGladys.js';

export const FAST_TIMINGS = { directWaitMs: 30, captureSeconds: 1, resendDelaysMs: [2, 10] };
const CAPTURE_MS = 40;

class FakeSocket extends EventEmitter {
  constructor(network, options) {
    super();
    this.network = network;
    this.options = options;
    this.port = null;
    this.closed = false;
  }

  bind(port, callback) {
    setImmediate(() => {
      if (this.network.portTaken) {
        const err = new Error('bind EADDRINUSE');
        err.code = 'EADDRINUSE';
        this.emit('error', err);
        return;
      }
      this.port = port;
      callback?.();
    });
  }

  send(payload, port, ip, callback) {
    this.network.receive(this, Buffer.from(payload), port, ip);
    setImmediate(() => callback?.(null));
  }

  close() {
    this.closed = true;
  }
}

export function createFakeNetwork({ devices = [], hostNetwork = false, portTaken = false } = {}) {
  const network = {
    devices: devices.map((device) => ({ replyPath: 'direct', ...structuredClone(device) })),
    hostNetwork,
    portTaken,
    sent: [],
    captures: [],
    activeCapture: null,
    // When set, scanNetwork rejects with this HTTP status (old core, port not approved...).
    refuseCapture: null,

    createSocket(options) {
      const socket = new FakeSocket(network, options);
      network.sockets.push(socket);
      return socket;
    },
    sockets: [],

    byIp(ip) {
      return network.devices.find((device) => device.ip === ip);
    },

    receive(socket, payload, port, ip) {
      let message;
      try {
        message = JSON.parse(payload.toString('utf8')).msg;
      } catch {
        return;
      }
      network.sent.push({ ip, port, fromPort: socket.port, cmd: message.cmd, data: message.data });
      if (ip === '239.255.255.250') {
        // Multicast never crosses the Docker bridge; on a host network every
        // device hears it.
        if (network.hostNetwork) {
          for (const device of network.devices) {
            network.handle(socket, device, port, message);
          }
        }
        return;
      }
      const device = network.byIp(ip);
      if (device) {
        network.handle(socket, device, port, message);
      }
    },

    handle(socket, device, port, { cmd, data }) {
      if (port === 4001 && cmd === 'scan') {
        network.reply(socket, device, { cmd: 'scan', data: { ...device.scan, ip: device.ip } });
        return;
      }
      if (port !== 4003) {
        return;
      }
      const status = device.status;
      switch (cmd) {
        case 'devStatus':
          network.reply(socket, device, { cmd: 'devStatus', data: structuredClone(status) });
          break;
        case 'turn':
          status.onOff = data.value;
          break;
        case 'brightness':
          status.brightness = data.value;
          break;
        case 'colorwc':
          status.color = data.color;
          status.colorTemInKelvin = data.colorTemInKelvin;
          break;
        case 'ptReal':
          device.lastPtReal = data.command;
          break;
        default:
      }
    },

    reply(socket, device, msg) {
      const payload = Buffer.from(JSON.stringify({ msg }));
      const path = network.hostNetwork ? 'direct' : device.replyPath;
      if (path === 'direct' && socket.port === 4002) {
        setImmediate(() => socket.emit('message', payload, { address: device.ip, port: 4001 }));
      } else if ((path === 'direct' || path === 'mediated') && network.activeCapture) {
        // Not matched by the NAT (or sent from another port): the answer lands
        // on the host, where the core may be listening.
        network.activeCapture.push({
          source_ip: device.ip,
          source_port: 4001,
          payload_base64: payload.toString('base64'),
        });
      }
    },

    async scanNetwork(type, options) {
      network.captures.push({ type, ...options });
      if (network.refuseCapture) {
        throw new FakeApiError(network.refuseCapture, 'capture refused');
      }
      if (network.activeCapture) {
        throw new FakeApiError(409, 'EXTERNAL_INTEGRATION_SCAN_ALREADY_RUNNING');
      }
      const results = [];
      network.activeCapture = results;
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_MS));
      network.activeCapture = null;
      return results;
    },
  };
  return network;
}
