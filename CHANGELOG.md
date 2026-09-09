# Changelog

SkyGenPanel follows [Semantic Versioning](https://semver.org/). Release versions
are calculated from conventional commits since the previous `v*` Git tag.

## [1.15.0] - 2026-09-09

### New

- Add provisioning and SGP event storage (`7490fae`)
- Read the PPPoE password and normalize SGP events (`b4067b6`)
- Add the write primitives provisioning composes (`8a8d18a`)
- Apply the SGP contract profile to a CPE (`4ca67f2`)
- Ingest SGP events by webhook and by reconciliation (`fb0d246`)
- Add Italian (`c7107e4`)
- Add the activation and SGP event surfaces (`6f74052`)
- Lay the foundation for the Evolution API integration (`b76cace`)
- Run the backend on PostgreSQL, and prove it in CI (`d10daa1`)
- Add the Evolution HTTP client and the wave 1 message keys (`c7766dd`)
- The Evolution instance lifecycle (`314df6d`)
- Inbound handlers and the outbox worker (`efa7042`)
- Make customer accounts belong to a provider (`4dbe6b7`)
- The dunning renderer, the SGP phone, and the wave 2 surface (`2bc7817`)
- Conversation reads and the subscriber resolver (`67c2e3c`)
- Technical alerts, and the rules that keep them readable (`6cf7f82`)
- Technical alerts, and the message bodies they were missing (`7090e0d`)
- The billing cadence — templates, campaigns and the flush loop (`ab71cb7`)
- O bot de autoatendimento (`8a0dff5`)
- The settings tab, the number cards and the QR pairing (`36fa2e1`)
- The portal URL on the settings form, and a delete warning that says what to do (`73eee6e`)
- The inbox route, and the vocabulary its screen will need (`22a813e`)
- The mechanism that scopes a query to one provider (`bc24934`)
- Scope the three tables that delete without a where clause (`bf53a7b`)
- The operator's inbox screen (`0b2c487`)
- The two refusals the inbox could provoke but not name (`8a87dde`)
- Make subscriber accounts answer only to their own provider (`061616f`)
- The two screens where a campaign's text is decided (`f92c3b4`)
- The alerts screen, where four thresholds are four different units (`a4009d8`)
- Give the WhatsApp inbox and send queue a provider (`088e951`)
- The billing cadence and the campaigns list (`f02b1f5`)
- Campaigns and the alert cooldown belong to a provider (`1c3c5a8`)
- One page, six tabs — the operator's whole WhatsApp surface (`4bf39f4`)
- The shared ground for wave 5 — a message's origin, and the words for the rest (`b57f2cf`)
- Closing a thread, and finding one (`3dd452a`)
- Let an operator correct a subscriber's number (`97137a2`)
- Give the configuration pair a provider (`c542636`)
- The shared ground for wave 6 — attachments, and where each audience fetches them (`5c3f809`)
- The operator's file — upload, allowlist, and a composer that carries it (`392c43a`)
- A stored attachment becomes one somebody can open (`2930786`)
- A real page back through a thread (`d3e959e`)
- Add Korean and repair the Traditional Chinese drift (`69e0f5b`)
- The shared ground for wave 7 — a retention window and one honest health read (`c373702`)
- Add Russian, and undo the zh-TW duplication two merges caused (`9151ccd`)
- Give each provider its own caches, and release the two jobs that can go (`a0d9527`)
- The attachment sweep — the first thing here that deletes (`640a71e`)
- One read that answers "is this working?", and a strip that says it (`718bf28`)
- The sweep tells the strip, and the strip stops scanning (`21609c1`)

### Fixed

- Close the gaps found in the second codebase analysis (`756a29a`)
- Make MySQL usable and JWT_SECRET rotatable (`689efbe`)
- Derive the copied-table list from the schema, and refresh the plan (`9bc490c`)
- Three ways the alerts and the templates lied, and the codes that hid it (`4f77c28`)
- The alerts form was about to speak the campaign's sentence (`5a00cd0`)
- The reason a build refused, and a timestamp typed as a lie (`977ceda`)
- The bot's ceiling counts the bot, and nothing else (`d12dc3f`)
- The dedupe belt was also mistaking a campaign for an answer (`e2867fb`)
- The panel could not serve itself from a path containing a dot (`3f3376f`)
- One error map for everybody, and a file with nothing in it (`9c1062c`)
- The limiter next to its sibling, and a disk path the browser never needed (`8f235a6`)
- Twenty-one keys that were declared twice, and the check that would have caught them (`af09eb2`)
- Wire the retention window the config was only pretending to have (`06ec4c3`)
- MySQL keeps whole seconds, and three health tests were asserting milliseconds (`8efb5ca`)
- Complete the Russian dictionary (`37f0b90`)
- Point the comparison links at this repository (`e0d3ff1`)

### Maintenance

- Deepen the multi-tenant plan with verified code findings (`7b3e05f`)
- Drop the stale note about hardcoded portal messages (`bdd16e7`)
- Cover activation and SGP event handling (`5241ad2`)
- Document activation and event handling (`e9fc591`)
- Merge branch 'main' and translate the new strings into Italian (`305c27f`)
- Name the migration that creates the tables (`011c107`)
- Add German as a fifth interface and API language (`f16fdc1`)
- Ignore the harness agent worktrees (`f7575b2`)
- Add French as a sixth interface and API language (`e395bcb`)
- I18n: French for everything this branch added (`5ce9880`)
- Add Japanese as a seventh interface and API language (`fdc12b3`)
- I18n: the vocabulary for the screens of wave 4 (`f69408c`)
- Add Simplified Chinese as an eighth interface and API language (`030dff3`)
- Add Traditional Chinese as a ninth interface and API language (`32d137c`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/v1.14.0...v1.15.0)

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

### Maintenance

- Add the multi-tenant SaaS conversion plan (`7071b38`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/v1.13.1...v1.14.0)

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
