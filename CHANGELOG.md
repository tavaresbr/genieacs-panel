# Changelog

SkyGenPanel follows [Semantic Versioning](https://semver.org/). Release versions
are calculated from conventional commits since the previous `v*` Git tag.

## [1.14.0] - 2026-09-08

### New

- Issue an independent password for each customer account (`ac6157c`)
- Integrate subscriber contracts and billing from SGP (`675f2dc`)
- Add multi-language support with pt-BR, en and es (`ab7b32b`)
- Translate network map and customer portal (`61d9831`)
- Translate the settings page (`5d4574f`)
- Translate the device detail page and document languages (`74744a3`)
- Translate the API responses (`2cf15ca`)
- Surface contract state across the device fleet (`00dd64b`)
- Reconcile the ONT fleet against SGP contracts (`a88e62d`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.13.1...v1.14.0)

## [1.13.1] - 2026-07-26

### Fixed

- Bootstrap legacy CLI updates (`5e2c9d5`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.13.0...v1.13.1)

## [1.13.0] - 2026-07-26

### New

- Added explicit Customer ID synchronization when settings are saved, with immutable identity preservation and accurate generated, preserved, and pending counts.
- Added writable WAN parameter discovery across ZTE, Huawei, CMCC, and FiberHome conventions, including name, VLAN, PPPoE credentials, service list, connection mode, NAT, and interface bindings.

### Changed

- Migrated the frontend to React 19 and React Router 8.
- Raised the supported runtime to Node.js 22.22 and updated both install and CLI update flows to replace older runtimes automatically.

### Fixed

- Fixed disabled or read-only WAN fields when the ONT reports writable parameters.
- Fixed misleading WAN task responses when no values changed.
- Fixed Customer ID preservation counts when a stable SoftwareID and PPPoE identity moves to a new GenieACS device ID.

### Security

- Removed the affected React Router 7 dependency line and verified zero production dependency vulnerabilities.

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.12.0...v1.13.0)

## [1.12.0] - 2026-07-25

### New

- Expand customer operations and device management (`6bf6a8e`)

### Maintenance

- Redesign project readme (`feea67e`)
- Add product screenshots and community badges (`97ef8d6`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.11.0...v1.12.0)

## [1.11.0] - 2026-07-24

### New

- Added customer self-service controls for changing the SSID and WiFi password reported by each ONT.
- Added encrypted recovery of the last password changed through the portal, with explicit eye controls for on-demand reveal.

### Fixed

- Normalized GenieACS boolean variants so enabled WiFi radios no longer appear disabled in the operator panel or customer portal.

### Security

- Bound every portal WiFi mutation and password reveal to the authenticated customer account, with dedicated rate limits and no client-supplied device target.
- Protected saved WiFi passwords with AES-256-GCM and kept decrypted values out of overview responses and process caches.

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.10.2...v1.11.0)

## [1.10.2] - 2026-07-24

### Fixed

- Bind overview cache independently of request context (`d940608`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.10.1...v1.10.2)

## [1.10.1] - 2026-07-24

### Fixed

- Deduplicate global toast notifications (`f10067e`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.10.0...v1.10.1)

## [1.10.0] - 2026-07-24

### New

- Added an isolated customer portal on port 5891 with safe ONT and WiFi status.
- Added immutable, database-backed Customer IDs bound to SoftwareVersion and PPPoE identity.

### Fixed

- Loaded the map engine and topology concurrently, bundled Leaflet CSS locally, and centered existing assets at zoom 15.

### Security

- Hardened session revocation, route isolation, origin checks, rate limits, CSP, and deployment secrets.

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.2...v1.10.0)

## [1.9.2] - 2026-07-24

### Improved

- Render cached charts without Recharts (`321ab4b`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.1...v1.9.2)

## [1.9.1] - 2026-07-24

### Fixed

- Keep desktop sidebar anchored while scrolling (`9eef4fd`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.0...v1.9.1)

## [1.9.0] - 2026-07-24

### New

- Add Git-derived version and changelog UI (`ffae6ab`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.8.5...v1.9.0)

## [1.8.5] - 2026-07-24

### New

- Rebuilt the panel as a lightweight Vite single-page application.
- Added production installer and self-updating `skygenpanel` management CLI.
- Added branded navigation, responsive operator UI, and selectable map layers.
- Added full physical topology management for HTB, OLT, ODC, ODP, ONT, and fiber cables.
- Added typed WiFi configuration tasks compatible with installer virtual parameters.
- Added fleet analytics and the GenieACS fault queue.

### Fixed

- Prevented blank screens caused by GenieACS metadata objects reaching React.
- Preserved the Leaflet map and viewport across topology refreshes.
- Removed stale Next.js artifacts during updates.
- Hardened production headers, dependency bootstrapping, and static asset delivery.

[Full history](https://github.com/skydashnet/genieacs-panel/commits/main)
