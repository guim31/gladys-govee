// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or a test double) and
// returns the hub, so index.js stays a few lines and the tests drive the very
// same wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { LANGUAGES, normalizeConfig } from './config.js';
import { GoveeHub } from './hub.js';
import { LanClient } from './lan/client.js';
import { SCENE_ACTIONS } from './scenes.js';
import { Store } from './store.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'govee-app' });

export const MESSAGES = {
  initFailed: {
    en: 'Initialization failed, check the integration logs.',
    fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
    de: 'Initialisierung fehlgeschlagen, sieh in den Logs der Integration nach.',
    es: 'La inicialización ha fallado, consulte los registros de la integración.',
  },
  identified: {
    en: 'The device blinks twice, then returns to its state.',
    fr: "L'appareil clignote deux fois, puis revient à son état.",
    de: 'Das Gerät blinkt zweimal und kehrt dann zu seinem Zustand zurück.',
    es: 'El dispositivo parpadea dos veces y luego vuelve a su estado.',
  },
  cannotIdentify: {
    en: 'This device cannot signal itself.',
    fr: 'Cet appareil ne peut pas se signaler.',
    de: 'Dieses Gerät kann sich nicht bemerkbar machen.',
    es: 'Este dispositivo no puede identificarse.',
  },
};

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
      await gladys.setConnectionStatus(false, MESSAGES.initFailed).catch(() => {});
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
      return done ? MESSAGES.identified : MESSAGES.cannotIdentify;
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

/** The report shown under the "Diagnose" button, one sentence per finding. */
export function diagnosticMessage(summary) {
  const { lan, lanReachable, cloud, cloudCallsToday, cloudError, addresses, network } = summary;
  const lines = [];
  lines.push({
    en: `LAN: ${lanReachable}/${lan} light(s) answering.`,
    fr: `Réseau local : ${lanReachable}/${lan} lampe(s) répondent.`,
    de: `Lokales Netzwerk: ${lanReachable}/${lan} Lampe(n) antworten.`,
    es: `Red local: ${lanReachable}/${lan} luz(es) responden.`,
  });
  if (addresses.addresses.length === 0) {
    lines.push({
      en: 'No IP address configured: only lights already known are probed.',
      fr: 'Aucune adresse IP configurée : seules les lampes déjà connues sont interrogées.',
      de: 'Keine IP-Adresse konfiguriert: Nur bereits bekannte Lampen werden abgefragt.',
      es: 'No hay ninguna dirección IP configurada: solo se consultan las luces ya conocidas.',
    });
  }
  if (addresses.invalid.length > 0) {
    const list = addresses.invalid.slice(0, 3).join(', ');
    lines.push({
      en: `Ignored entries: ${list}.`,
      fr: `Entrées ignorées : ${list}.`,
      de: `Ignorierte Einträge: ${list}.`,
      es: `Entradas ignoradas: ${list}.`,
    });
  }
  if (addresses.truncated) {
    lines.push({
      en: 'Address list cut at 1024 addresses.',
      fr: 'Liste coupée à 1024 adresses.',
      de: 'Adressliste bei 1024 Adressen abgeschnitten.',
      es: 'Lista de direcciones cortada en 1024 direcciones.',
    });
  }
  if (network.stats.mediated > 0 || network.preferMediated) {
    lines.push({
      en: 'Answers come through the Gladys core (port 4002).',
      fr: 'Les réponses passent par le cœur Gladys (port 4002).',
      de: 'Die Antworten laufen über den Gladys-Kern (Port 4002).',
      es: 'Las respuestas pasan por el núcleo de Gladys (puerto 4002).',
    });
  } else if (network.stats.direct > 0) {
    lines.push({
      en: 'Answers come straight to the integration.',
      fr: "Les réponses arrivent directement à l'intégration.",
      de: 'Die Antworten kommen direkt bei der Integration an.',
      es: 'Las respuestas llegan directamente a la integración.',
    });
  }
  if (network.mediation === 'unavailable') {
    lines.push({
      en: 'Gladys refused the capture on port 4002: update Gladys, or approve the port.',
      fr: 'Gladys a refusé la capture sur le port 4002 : mettez Gladys à jour ou autorisez le port.',
      de: 'Gladys hat die Erfassung auf Port 4002 abgelehnt: Aktualisiere Gladys oder erlaube den Port.',
      es: 'Gladys ha rechazado la captura en el puerto 4002: actualice Gladys o autorice el puerto.',
    });
  }
  if (cloudError) {
    // The error itself comes from the Govee API, in English.
    lines.push({
      en: `Cloud: ${cloudError}`,
      fr: `Cloud : ${cloudError}`,
      de: `Cloud: ${cloudError}`,
      es: `Nube: ${cloudError}`,
    });
  } else if (cloud > 0 || cloudCallsToday > 0) {
    lines.push({
      en: `Cloud: ${cloud} device(s), ${cloudCallsToday} API calls today (10,000 a day).`,
      fr: `Cloud : ${cloud} appareil(s), ${cloudCallsToday} appels d'API aujourd'hui (10 000 par jour).`,
      de: `Cloud: ${cloud} Gerät(e), heute ${cloudCallsToday} API-Aufrufe (10.000 pro Tag).`,
      es: `Nube: ${cloud} dispositivo(s), ${cloudCallsToday} llamadas a la API hoy (10.000 al día).`,
    });
  }
  return Object.fromEntries(
    LANGUAGES.map((language) => [language, lines.map((line) => line[language]).join(' ')]),
  );
}
