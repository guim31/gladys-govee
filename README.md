# Govee for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for **Govee**
Wi-Fi lights — bulbs, light strips, floor lamps, light bars, string lights —
controlled **over the local network** through Govee's official LAN API, with
the Govee cloud API as an option for the devices the LAN API does not cover
(smart plugs, thermometers, humidifiers...).

> **Developed without the hardware: feedback welcome.** Everything here was
> built from Govee's documentation and from the test suites of the open-source
> projects using the LAN API, and verified against a simulated network, not
> against real devices. Reports with your model number are very welcome in the
> [issues](https://github.com/guim31/gladys-govee/issues).

User documentation: [English](docs/en.md) · [Français](docs/fr.md) (also
linked from the Configuration screen in Gladys).

## Features

- **Local first.** On/off, brightness, color and color temperature over the
  Govee LAN API (UDP), no account needed. The color temperature range follows
  each model (e.g. 2700-6500 K on the H6076), from a table of 272 models.
- **Optional cloud** (Govee OpenAPI v2, free key): devices without LAN control
  (plugs, thermometers, humidifiers, purifiers...), and a fallback for lights
  that stop answering locally, shown as a degraded badge. The integration
  counts its calls and stays within Govee's 10,000 requests a day.
- **Govee built-in scenes** (sunrise, sunset, candlelight, movie...) from a
  scene action and a **light presets** dashboard widget (white tones, a chosen
  color, chosen scenes, one tap each), which the standard light box cannot offer.
- **Search and diagnose** action, **Identify** action (the device blinks).
- Temperatures are published in the sensor's own unit and shown in each user's
  unit (°F or °C) by Gladys.

## Requirements

- Gladys Assistant **5.1.0** or later.
- For local control: **LAN Control** turned on in the Govee Home app for each
  light, and the IP addresses of the lights (or a range to scan).
- For the cloud: a Govee API key (Govee Home app → Profile → Settings → Apply
  for API Key).

## Installation

Install **Govee** from the integration store in Gladys, accept the network
permission (listen on UDP port 4002), enter the IP addresses of your lights in
the **Configuration** tab, then add the devices from the **Discovery** tab. The
[user documentation](docs/en.md) walks through every step.

## How the LAN part works in the Gladys sandbox

Gladys runs each integration in a Docker container on a bridge network. Govee
lights are discovered by a multicast `scan` on `239.255.255.250:4001`, and they
answer `scan` and `devStatus` on **UDP port 4002 of the sender**, whatever port
the request came from. Two consequences:

- the multicast discovery cannot leave the container: the user enters the IP
  addresses, or a range the integration sweeps with unicast `scan` requests;
- the answers may not make it back into the container. The integration sends
  from a socket bound to port 4002, so the NAT can match an answer coming from
  port 4001 to its request; when that does not happen, it asks the Gladys core
  (host network) for a mediated `udp-broadcast` capture of port 4002
  (`network_discovery` in the manifest) while it sends the request, and reads
  the answers from the capture. It learns which path works and uses one
  capture for all the lights of a poll.

The core's `udp-active-broadcast` capture type cannot serve Govee: it collects
the answers on the ephemeral port it sent from, and Govee answers on 4002.
Commands (`turn`, `brightness`, `colorwc`, `ptReal` to port 4003) need no
answer and always go straight from the container.

## Limitations

- No per-segment control (RGBIC), DIY scenes, music mode or cloud scenes yet.
- States are polled (every 30 s by default), the LAN API does not push them.
- Another program listening on port 4002 on the Gladys host (Home Assistant's
  Govee lights local, Homebridge) may take the answers.
- Bluetooth-only Govee devices are out of reach.
- Unknown models get every light feature with the 2000-9000 K range of the
  Govee documentation.

## Development

Node.js 22+, ESM, no build step. The only runtime dependency is
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

```bash
npm install
npm test              # node --test: unit tests + simulated LAN and cloud
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store .   # store validator
```

```
index.js              SDK wiring (src/app.js registers the handlers)
src/hub.js            registry, discovery, polls, LAN/cloud routing, commands
src/lan/              Govee LAN protocol, UDP client, address ranges
src/cloud/client.js   Govee OpenAPI v2 client with the daily quota
src/features.js       Govee device -> Gladys features, states and commands
src/models.js         model table (from govee-local-api)
src/widgets.js        "light presets" dashboard widget
src/scenes.js         "Start a Govee scene" scene action
test/                 node --test; fake Gladys, simulated LAN, fake cloud
```

`test/gladys-rules.test.js` checks every discovered device against the
category/type table extracted from the Gladys core.

To run it outside Gladys (on a host network, where the multicast discovery
works too):

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="govee" \
GOVEE_DATA_DIR=./data \
npm start
```

Releases are made by the **Release** workflow (Actions → Release); never edit
the versions by hand. See [`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- [govee-local-api](https://github.com/Galorhallen/govee-local-api) by
  Galorhallen and contributors (Apache-2.0), the library behind Home
  Assistant's `govee_light_local` integration: the model capability table
  (`src/models.js`), the scene codes and the message formats come from it and
  from its tests.
- Home Assistant's
  [`govee_light_local`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/govee_light_local)
  integration (Apache-2.0), for its handling of manually added devices.
- Govee's LAN API and OpenAPI documentation.

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Govee. "Govee"
is a trademark of its owner.

## License

Apache-2.0
