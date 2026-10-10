# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.2] - 2026-10-10

### Fixed

- "Govee light presets" widget: the Color and Scene buttons did nothing on the
  published Gladys versions (they opened a form, which no Gladys release
  supports yet). Each button now acts in one tap, with the color and the
  scenes chosen in the widget settings, and a second scene button on lights
  without white tones.

## [1.0.1] - 2026-10-09

### Added

- Govee lights over the local network (Govee LAN API): on/off, brightness,
  color and color temperature, with the color temperature range of each model
  (272 models known).
- Lights found from a list of IP addresses or ranges; their answers read
  directly or through the Gladys core (network capture on UDP port 4002).
- Optional Govee cloud API key: smart plugs, thermometers, humidifiers and the
  other devices without LAN control, cloud fallback for lights that stop
  answering locally, and a daily quota guard (10,000 requests a day).
- "Start a Govee scene" scene action and "Govee light presets" dashboard
  widget: white tones, named colors and the Govee built-in scenes.
- "Search and diagnose" and "Identify a device" actions.
- User documentation in English and French.

[Unreleased]: https://github.com/guim31/gladys-govee/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/guim31/gladys-govee/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/guim31/gladys-govee/releases/tag/v1.0.1
