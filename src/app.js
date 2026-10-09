// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or a test double) and
// returns the hub, so index.js stays a few lines and the tests drive the very
// same wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { GoveeHub } from './hub.js';
import { LanClient } from './lan/client.js';
import { SCENE_ACTIONS } from './scenes.js';
import { Store } from './store.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'govee-app' });

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: lan, store, createCloudClient, timers, pauseMs
 */
export function registerHandlers(gladys, options = {}) {
  const lan =
    options.lan ??
    new LanClient({ scanNetwork: (type, scanOptions) => gladys.scanNetwork(type, scanOptions) });
  const hub = new GoveeHub({
    gladys,
    lan,
    store: options.store ?? new Store(),
    createCloudClient: options.createCloudClient,
    timers: options.timers ?? true,
    pauseMs: options.pauseMs,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // command arriving during the first scan is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): re-sync what Gladys may have lost.
        await hub.reconfigure(config);
        await hub.publishDevices();
        await hub.publishTransports({ force: true });
        return;
      }
      started = true;
      await hub.start(config);
      resolveReady();
    } catch (err) {
      logger.error('Initialization failed', err);
      resolveReady();
      await gladys
        .setConnectionStatus(false, {
          en: 'Initialization failed, check the integration logs.',
          fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
        })
        .catch(() => {});
    }
  });

  gladys.onScanRequest(
    whenReady(async () => {
      await hub.discover({ forceCloud: true });
      await hub.pollLan();
    }),
  );

  gladys.onSetValue(whenReady((device, feature, value) => hub.setValue(device, feature, value)));

  // The devices are published with should_poll: false (the hub polls them all
  // in one exchange); this only serves a Gladys that would poll anyway.
  gladys.onPoll(
    whenReady(async (device) => {
      const entry = hub.entryByExternalId(device?.external_id);
      if (entry?.ip) {
        await hub.pollLan([entry]);
      }
    }),
  );

  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      await hub.reconfigure(normalizeConfig(newConfig));
    }),
  );

  gladys.onAction(
    'diagnose',
    whenReady(async () => {
      await hub.discover({ forceCloud: true });
      await hub.pollLan();
      return diagnosticMessage(hub.summary());
    }),
  );

  gladys.onAction(
    'identify',
    whenReady(async (fields) => {
      const done = await hub.identify(fields.device);
      return done
        ? {
            en: 'The device blinks twice, then returns to its state.',
            fr: "L'appareil clignote deux fois, puis revient à son état.",
          }
        : { en: 'This device cannot signal itself.', fr: 'Cet appareil ne peut pas se signaler.' };
    }),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(hub, request)),
    );
    gladys.onWidgetAction(
      key,
      whenReady((actionKey, params, context = {}) =>
        widget.action(hub, { actionKey, params, ...context }),
      ),
    );
  }

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}

/** The bilingual report shown under the "Diagnose" button. */
export function diagnosticMessage(summary) {
  const { lan, lanReachable, cloud, cloudCallsToday, cloudError, addresses, network } = summary;
  const en = [];
  const fr = [];
  en.push(`LAN: ${lanReachable}/${lan} light(s) answering.`);
  fr.push(`Réseau local : ${lanReachable}/${lan} lampe(s) répondent.`);
  if (addresses.addresses.length === 0) {
    en.push('No IP address configured: only lights already known are probed.');
    fr.push('Aucune adresse IP configurée : seules les lampes déjà connues sont interrogées.');
  }
  if (addresses.invalid.length > 0) {
    const list = addresses.invalid.slice(0, 3).join(', ');
    en.push(`Ignored entries: ${list}.`);
    fr.push(`Entrées ignorées : ${list}.`);
  }
  if (addresses.truncated) {
    en.push('Address list cut at 1024 addresses.');
    fr.push('Liste coupée à 1024 adresses.');
  }
  if (network.stats.mediated > 0 || network.preferMediated) {
    en.push('Answers come through the Gladys core (port 4002).');
    fr.push('Les réponses passent par le cœur Gladys (port 4002).');
  } else if (network.stats.direct > 0) {
    en.push('Answers come straight to the integration.');
    fr.push("Les réponses arrivent directement à l'intégration.");
  }
  if (network.mediation === 'unavailable') {
    en.push('Gladys refused the capture on port 4002: update Gladys, or approve the port.');
    fr.push(
      'Gladys a refusé la capture sur le port 4002 : mettez Gladys à jour ou autorisez le port.',
    );
  }
  if (cloudError) {
    en.push(`Cloud: ${cloudError}`);
    fr.push(`Cloud : ${cloudError}`);
  } else if (cloud > 0 || cloudCallsToday > 0) {
    en.push(`Cloud: ${cloud} device(s), ${cloudCallsToday} API calls today (10,000 a day).`);
    fr.push(
      `Cloud : ${cloud} appareil(s), ${cloudCallsToday} appels d'API aujourd'hui (10 000 par jour).`,
    );
  }
  return { en: en.join(' '), fr: fr.join(' ') };
}
