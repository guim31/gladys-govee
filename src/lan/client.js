// -----------------------------------------------------------------------------
// UDP client for the Govee LAN API, built for the Gladys sandbox.
//
// The integration runs in a Docker container on a bridge network: a datagram
// it sends to a device IP crosses the NAT (commands to port 4003 always work),
// but the devices answer `scan` and `devStatus` on port 4002 of the sender,
// whatever port the request left from. Two ways for that answer to come back:
//
//   1. direct: we send from a socket bound to port 4002. The NAT keeps the
//      source port when it can, so a device answering from port 4001 matches
//      the NAT entry and the answer is forwarded to the container. Nothing
//      guarantees the device answers from that port: this path is tried, never
//      assumed. It is also the normal path when the container runs on the host
//      network (development, `docker run --network host`).
//   2. mediated: the manifest declares `network_discovery` `udp-broadcast` on
//      port 4002. While the Gladys core (host network) listens on that port for
//      us, we send the request: the answer reaches the host on port 4002, the
//      core captures it and hands us the raw datagrams.
//
// Every exchange tries the direct path first; the IPs that stay silent get one
// mediated round. Once an answer only came through the core, the client starts
// the capture up front for the next exchanges (one HTTP call per exchange,
// whatever the number of devices).
//
// The core runs one capture at a time per integration (409 otherwise): the
// mediated rounds are serialized here.
// -----------------------------------------------------------------------------

import nodeDgram from 'node:dgram';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  COMMAND_PORT,
  MULTICAST_ADDRESS,
  REPLY_PORT,
  SCAN_PORT,
  parseMessage,
} from './protocol.js';

const DEFAULT_TIMINGS = {
  // How long to wait for direct answers before falling back to the core.
  directWaitMs: 1200,
  // Duration of a mediated capture (the core accepts 1-30 s).
  captureSeconds: 2,
  // When to (re)send the requests once the capture is requested: the core
  // binds its socket when it handles the HTTP request, a few ms after it
  // leaves; the second send covers a lost datagram or a slow core.
  resendDelaysMs: [250, 900],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LanClient {
  /**
   * @param {object} options
   * @param {(type: string, options: object) => Promise<Array>} options.scanNetwork
   *   the SDK `gladys.scanNetwork`, bound
   * @param {(options: object) => import('node:dgram').Socket} [options.createSocket]
   * @param {object} [options.timings]
   * @param {object} [options.logger]
   */
  constructor({ scanNetwork, createSocket, timings, logger } = {}) {
    this.scanNetwork = scanNetwork;
    this.createSocket = createSocket ?? ((opts) => nodeDgram.createSocket(opts));
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.logger = logger ?? createLogger({ name: 'govee-lan' });
    this.socket = null;
    this.directBound = false;
    this.listeners = new Set();
    // 'unknown' until a capture answers or is refused; 'unavailable' when the
    // core refuses it (too old, port not approved).
    this.mediation = 'unknown';
    // True once an answer only came back through the core.
    this.preferMediated = false;
    this.captureChain = Promise.resolve();
    this.stats = { direct: 0, mediated: 0 };
  }

  /** Open the UDP socket. Never throws: a failed bind leaves the mediated path. */
  async start() {
    if (this.socket) {
      return;
    }
    const socket = this.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (payload, remote) => this.dispatch(remote.address, payload, 'direct'));
    socket.on('error', (err) => this.logger.warn(`UDP socket error: ${err.message}`));
    this.socket = socket;
    this.directBound = await new Promise((resolve) => {
      const onError = (err) => {
        this.logger.warn(
          `Cannot listen on UDP port ${REPLY_PORT} (${err.code ?? err.message}): ` +
            'device answers will only come through the Gladys core.',
        );
        resolve(false);
      };
      socket.once('error', onError);
      socket.bind(REPLY_PORT, () => {
        socket.off('error', onError);
        resolve(true);
      });
    });
    if (!this.directBound) {
      // Keep a socket to send from: an unbound socket gets an ephemeral port.
      socket.close();
      this.socket = this.createSocket({ type: 'udp4' });
      this.socket.on('error', (err) => this.logger.warn(`UDP socket error: ${err.message}`));
      this.preferMediated = true;
    }
  }

  stop() {
    this.socket?.close();
    this.socket = null;
    this.directBound = false;
  }

  /** Fire-and-forget command to a device (port 4003, no answer). */
  send(ip, payload, port = COMMAND_PORT) {
    if (!this.socket) {
      throw new Error('The LAN client is not started');
    }
    return new Promise((resolve, reject) => {
      this.socket.send(payload, port, ip, (err) => (err ? reject(err) : resolve()));
    });
  }

  dispatch(ip, payload, path) {
    const message = parseMessage(payload);
    if (!message) {
      return;
    }
    for (const listener of this.listeners) {
      listener(ip, message, path);
    }
  }

  /**
   * Send requests and collect the answers of one command type.
   * @param {Array<{ ip: string, port: number, payload: Buffer }>} requests
   * @param {object} options
   * @param {string} options.cmd the answer command to collect ('scan', 'devStatus')
   * @param {Buffer} [options.multicast] also send this payload to the Govee
   *   multicast group (only reaches the LAN on a host network)
   * @param {boolean} [options.expectAll] stop waiting once every requested IP
   *   answered (status polls); a sweep waits the full time
   * @returns {Promise<Map<string, object>>} answer data per source IP
   */
  async exchange(requests, { cmd, multicast, expectAll = true } = {}) {
    const replies = new Map();
    const wanted = new Set(requests.map((request) => request.ip));
    let notify = () => {};
    const listener = (ip, message, path) => {
      // Captured datagrams reach every exchange in progress: keep the answers
      // of the IPs this one asked (any IP may answer a multicast scan).
      if (message.cmd !== cmd || replies.has(ip) || (!multicast && !wanted.has(ip))) {
        return;
      }
      replies.set(ip, message.data);
      this.stats[path] += 1;
      if (path === 'mediated' && !this.preferMediated) {
        this.preferMediated = true;
        this.logger.info(
          'Govee devices answer through the Gladys core only (normal on a Docker bridge network).',
        );
      }
      notify();
    };
    this.listeners.add(listener);
    try {
      if (this.preferMediated && this.mediation !== 'unavailable') {
        await this.mediatedRound(requests, multicast);
      } else {
        await this.sendAll(requests, multicast);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, this.timings.directWaitMs);
          notify = () => {
            if (expectAll && [...wanted].every((ip) => replies.has(ip))) {
              clearTimeout(timer);
              resolve();
            }
          };
          notify();
        });
        notify = () => {};
        const missing = requests.filter((request) => !replies.has(request.ip));
        if (missing.length > 0 && this.mediation !== 'unavailable') {
          await this.mediatedRound(missing);
        }
      }
    } finally {
      this.listeners.delete(listener);
    }
    return replies;
  }

  async sendAll(requests, multicast) {
    const sends = requests.map(({ ip, port, payload }) =>
      this.send(ip, payload, port).catch((err) =>
        this.logger.debug(`Send to ${ip}:${port} failed: ${err.message}`),
      ),
    );
    if (multicast) {
      sends.push(
        this.send(MULTICAST_ADDRESS, multicast, SCAN_PORT).catch((err) =>
          this.logger.debug(`Multicast scan failed: ${err.message}`),
        ),
      );
    }
    await Promise.all(sends);
  }

  // One capture on port 4002 by the core, with our requests sent while it
  // listens. The captured datagrams are dispatched to every exchange in
  // progress: an answer is an answer, whoever asked.
  mediatedRound(requests, multicast) {
    const run = async () => {
      const capture = this.scanNetwork('udp-broadcast', {
        timeoutSeconds: this.timings.captureSeconds,
      });
      // Swallow here, inspect below: the sends must not wait on the capture.
      const settled = capture.then(
        (results) => ({ results }),
        (error) => ({ error }),
      );
      let elapsed = 0;
      for (const delay of this.timings.resendDelaysMs) {
        await sleep(delay - elapsed);
        elapsed = delay;
        await this.sendAll(requests, multicast);
      }
      const { results, error } = await settled;
      if (error) {
        this.onCaptureError(error);
        return;
      }
      this.mediation = 'available';
      for (const result of Array.isArray(results) ? results : []) {
        if (typeof result?.source_ip !== 'string' || typeof result.payload_base64 !== 'string') {
          continue;
        }
        this.dispatch(result.source_ip, Buffer.from(result.payload_base64, 'base64'), 'mediated');
      }
    };
    const next = this.captureChain.then(run, run);
    this.captureChain = next.catch(() => {});
    return next;
  }

  onCaptureError(error) {
    const status = error?.status;
    if (status === 400 || status === 403 || status === 404) {
      // 403: port 4002 not declared/approved; 404/400: a core without
      // mediated discovery. Stop asking: only the direct path is left.
      if (this.mediation !== 'unavailable') {
        this.logger.warn(
          `The Gladys core refused the network capture on port ${REPLY_PORT} ` +
            `(${status} ${error.message}): only direct answers can be read.`,
        );
      }
      this.mediation = 'unavailable';
      this.preferMediated = false;
      return;
    }
    this.logger.warn(`Network capture failed: ${error?.message ?? error}`);
  }

  /** What the diagnostics action reports. */
  describe() {
    return {
      directBound: this.directBound,
      mediation: this.mediation,
      preferMediated: this.preferMediated,
      stats: { ...this.stats },
    };
  }
}
