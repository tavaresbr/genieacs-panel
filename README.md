<div align="center">
  <img src="frontend/public/icon.svg" alt="SkyGenPanel logo" width="104" height="104">

  <h1>SkyGenPanel</h1>

  <p><strong>A focused operations console and customer self-service portal for GenieACS.</strong></p>
  <p>Monitor ONTs, manage network topology, configure multi-vendor devices, and give customers a safe view of their own connection from one lightweight service.</p>

  <p>
    <a href="https://github.com/skydashnet/genieacs-panel/tags"><img alt="Latest release" src="https://img.shields.io/github/v/tag/skydashnet/genieacs-panel?sort=semver&style=for-the-badge&label=Release&color=173F35"></a>
    <a href="https://github.com/skydashnet/genieacs-panel/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/skydashnet/genieacs-panel?style=for-the-badge&logo=github&color=D97706"></a>
    <a href="https://github.com/skydashnet/genieacs-panel/forks"><img alt="GitHub forks" src="https://img.shields.io/github/forks/skydashnet/genieacs-panel?style=for-the-badge&logo=github&color=2563EB"></a>
    <img alt="Node.js 22.22 or newer" src="https://img.shields.io/badge/Node.js-22.22%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white">
    <img alt="React and Vite" src="https://img.shields.io/badge/React%20%2B%20Vite-Production-646CFF?style=for-the-badge&logo=vite&logoColor=white">
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-D97706?style=for-the-badge"></a>
    <a href="https://saweria.co/skydashnet"><img alt="Support SkyDashNET on Saweria" src="https://img.shields.io/badge/Support-Saweria-FAAE2B?style=for-the-badge&labelColor=173F35"></a>
  </p>

  <p>
    <a href="#installation">Installation</a> ·
    <a href="#skygenpanel-cli">CLI</a> ·
    <a href="#configuration">Configuration</a> ·
    <a href="#security">Security</a>
  </p>
</div>

---

## Overview

SkyGenPanel is a management layer for GenieACS deployments. It combines an operator-facing panel on port `5890` with an isolated customer portal on port `5891`. SQLite works out of the box, while MySQL can be selected and migrated to later from the interface.

| Operator console | Customer portal |
| --- | --- |
| Fleet health, faults, optical signal, temperature, and registration trends | ONT health, optical signal, uptime, and connected-device visibility |
| ONT, OLT, ODC, and ODP topology management with a network map | Permanent Customer IDs bound to SoftwareVersion and PPPoE identity |
| Multi-vendor WAN, WiFi, credential, and virtual-parameter configuration | Safe SSID and WiFi password changes for the authenticated customer's ONT |
| Per-customer portal passwords that operators can reveal or regenerate | Portal sign-in with a credential independent of the Customer ID |
| Runtime SQLite-to-MySQL migration and deployment controls | No WAN or administrative credential exposure |

## Highlights

- Dedicated operator and customer listeners served by one application.
- First-run setup wizard for the initial administrator account.
- Fast Vite and React interface with responsive light and dark themes.
- Multi-language interface in Portuguese (Brazil), English, Spanish, Italian, German, French, Japanese, Simplified Chinese, Traditional Chinese, Korean, and Russian for both the operator panel and the customer portal.
- GenieACS fault visibility and dependency-light dashboard charts.
- Network topology editor with Google Maps and OpenStreetMap-compatible providers.
- Automatic Customer ID generation that can be enabled or disabled in Settings.
- Independent portal passwords per customer, generated automatically and rotatable from the device page.
- Operator accounts with an administrator and a read-only role.
- Server-side paging, search and status filtering for large ONT fleets.
- Encrypted recovery of the last WiFi password changed through the customer portal.
- SGP integration for subscriber contract, plan, and open-invoice data, with fleet-wide synchronization, contract-state filtering, and optional invoice display and trust unlock in the customer portal.
- Automatic activation of a new ONT from its SGP contract, with per-step run history and a dry run before anything is written.
- SGP event handling through a signed webhook and periodic contract reconciliation.
- Automatic Linux dependency and Node.js installation during both first install and CLI updates.

## Screenshots

<div align="center">
  <table>
    <tr>
      <td align="center"><strong>Operator panel</strong></td>
      <td align="center"><strong>Customer portal</strong></td>
    </tr>
    <tr>
      <td><img src="docs/screenshots/operator-panel.png" alt="SkyGenPanel operator access screen" width="680"></td>
      <td><img src="docs/screenshots/customer-portal.png" alt="SkyGenPanel customer portal access screen" width="680"></td>
    </tr>
    <tr>
      <td align="center"><sub>Secure access to fleet operations and GenieACS management.</sub></td>
      <td align="center"><sub>Isolated self-service access for each authenticated customer.</sub></td>
    </tr>
  </table>
</div>

## Installation

The production installer targets Linux systems running `systemd`. It supports:

- Debian and Ubuntu
- Fedora, RHEL, Rocky Linux, and AlmaLinux
- Arch Linux
- openSUSE

Git, native build tools, and the latest Node.js 22 release are installed automatically when required. An existing Node.js 22.22 or newer installation is reused.

Run as a regular user:

```bash
curl -fsSL https://raw.githubusercontent.com/skydashnet/genieacs-panel/main/deploy/install.sh | sudo bash
```

Run from an existing root shell:

```bash
curl -fsSL https://raw.githubusercontent.com/skydashnet/genieacs-panel/main/deploy/install.sh | bash
```

After installation:

- Operator setup: `http://localhost:5890`
- Customer portal: `http://localhost:5891`

Both listeners bind to `127.0.0.1` by default. This is suitable for a reverse proxy or a Cloudflare Tunnel running on the same host. Use `skygenpanel expose` only when another trusted machine must reach the service directly, and protect the ports with a firewall.

## `skygenpanel` CLI

| Command | Description |
| --- | --- |
| `skygenpanel update` | Fetch the latest source, rebuild the application, and restart the service |
| `skygenpanel expose` | Bind the panel and customer portal to `0.0.0.0` |
| `skygenpanel unexpose` | Return both listeners to `127.0.0.1` |
| `skygenpanel restart` | Restart the system service |
| `skygenpanel start` | Start the system service |
| `skygenpanel stop` | Stop the system service |
| `skygenpanel status` | Show service and endpoint status |
| `skygenpanel logs [N]` | Follow the latest log lines; defaults to 100 |
| `skygenpanel reset-password <user> [password]` | Reset an operator password; prompts securely when the password is omitted |

## Cloudflare Tunnel

When `cloudflared` runs on the SkyGenPanel host, publish two HTTP services:

| Public hostname | Origin service |
| --- | --- |
| `panel.example.com` | `http://127.0.0.1:5890` |
| `portal.example.com` | `http://127.0.0.1:5891` |

TLS terminates at Cloudflare, so the local origin URLs intentionally use HTTP. Keep Universal SSL active for the zone and wait for its edge certificate to reach `Active` before forcing HTTPS redirects.

## Configuration

Environment configuration lives in `backend/.env`; see [`backend/.env.example`](backend/.env.example).

| Variable | Purpose |
| --- | --- |
| `APP_HOST` | Operator panel bind address |
| `APP_PORT` | Operator panel port; defaults to `5890` |
| `PORTAL_HOST` | Optional customer portal bind address |
| `PORTAL_PORT` | Customer portal port; defaults to `5891` |
| `JWT_SECRET` | Stable application secret used for operator and customer sessions |
| `PORTAL_JWT_SECRET` | Optional independent customer-session secret |
| `SECRET_BOX_KEY` | Encrypts the secrets an operator can read back (portal and WiFi passwords, SGP and WhatsApp tokens); falls back to `JWT_SECRET` when unset |
| `EDITION` | `selfhosted` (default) or `saas`; the hosted edition withdraws the runtime database switcher |
| `CORS_ORIGINS` | Explicitly allowed browser origins |
| `DATA_DIR` | Optional persistent application data directory |
| `TRUST_PROXY` | Number of trusted proxy hops in front of the panel; `1` for the default reverse-proxy or Cloudflare Tunnel deployment, `0` when the listeners are exposed directly |
| `PORTAL_COOKIE_SECURE` | `auto` (default), `true`, or `false`; overrides the portal cookie `Secure` flag when a proxy terminates TLS without advertising it |

The GenieACS URL and optional MySQL connection are managed from the Settings interface rather than environment variables. Runtime database configuration is stored in `DATA_DIR/db-config.json`.

### Rotating `JWT_SECRET`

`SECRET_BOX_KEY` exists so that rotating `JWT_SECRET` does not destroy stored
data. Until it was introduced, session signing and secret encryption derived
from the same value, and decryption reports failure by returning nothing — so a
rotation quietly turned every portal password, saved WiFi password, provisioning
password and integration token into an unreadable blob.

Each encrypted secret now records which key wrote it, so both keys are readable
side by side. `install.sh` generates `SECRET_BOX_KEY` for new installs and adds
one to an existing `.env` on update, which is safe: data already stored stays
readable through `JWT_SECRET`, and only new writes use the dedicated key.

Anything written before `SECRET_BOX_KEY` was configured remains tied to
`JWT_SECRET` until it is written again. Regenerating a customer's portal
password, or re-saving a provisioning profile or WhatsApp instance, moves that
secret onto the new key.

## Customer Portal Credentials

Each customer account carries its own portal password. The Customer ID identifies
the account; it is never the credential for it.

- A password is generated automatically when an account is created.
- Open a device in the operator panel and use **Customer access → Portal password**
  to reveal the current password or generate a new one.
- Passwords are stored as a bcrypt hash for authentication plus an AES-256-GCM
  encrypted copy so staff can read one back without disrupting the customer.

Accounts created before this release authenticated with the last six characters of
their own Customer ID. On the first start after upgrading, every one of them
receives a freshly generated password in the background, and the log reports how
many were issued. Reveal the new password from the device page before sharing it —
the old one no longer works.

## Customer Account Lifecycle

A customer account is bound to an ONT, and the **PPPoE login is what identifies
the subscriber** behind it. The software version is not: a firmware upgrade
refreshes the stored identity in place and changes nothing else.

- **Replacement ONT, same subscriber** — the account, Customer ID and portal
  password follow the subscriber to the new device.
- **Same ONT, new subscriber** — when the fleet sync sees a device reporting a
  different PPPoE login, the previous account is *retired*: it is deactivated,
  its Customer ID and portal password stop working, and its SGP contract link is
  dropped. The incoming subscriber gets a fresh account. Without this the new
  occupant of a recycled ONT would inherit the previous customer's Customer ID,
  portal password, saved WiFi credentials, and their contract, plan and open
  invoices from SGP.

Retirement is destructive, so it is logged at warning level with both PPPoE
logins:

```
Device <id> now reports PPPoE "b@isp" instead of "a@isp"; retiring customer account CSG-…
```

Watch that line after changing the `vpPppoeUsername` virtual parameter — a
misreported login there is the one way a live customer could be retired by
mistake. Retired rows are kept in `customer_accounts` with `active = 0`, so a
mistake can be inspected and undone in the database.

## Operator Accounts

**Settings → Operators** (administrators only) manages who can sign in to the
panel. Two roles exist:

| Role | May do |
| --- | --- |
| `admin` | Everything, including settings, device changes, the database, SGP and operator management |
| `viewer` | Read the dashboard, the device list and GenieACS faults; every administrative route answers `403` |

The panel always keeps at least one administrator: the last one cannot be
demoted or deleted, and you cannot demote or delete the account you are signed
in with. Changing an operator's role or password revokes their existing sessions
immediately.

A viewer sees only the dashboard and the device list; the network map and
settings are hidden from the navigation and redirect to the dashboard if the
URL is entered directly. The backend enforces the same boundary independently,
so the UI is a convenience rather than the control.

## SGP Integration

Open **Settings → SGP integration** (*Integração SGP*) to connect the panel to
[SGP](https://sgp.net.br) and show contract, plan, and open-invoice data next to
each ONT. The integration token is encrypted with `JWT_SECRET` and never leaves
the server.

A fleet synchronization links every ONT to its contract in one pass, after which
the device inventory can be filtered by contract state and the dashboard reports
the divergences neither system sees alone: an ONT answering while its contract is
blocked or cancelled, a contract that is active while the ONT stays silent, and a
device with no contract linked. See
[`docs/sgp-integration.md`](docs/sgp-integration.md) for setup, endpoints, and
troubleshooting.

The same tab receives events from SGP — a signed webhook when the provider's
install can push one, and periodic reconciliation of the linked contracts when
it cannot — so a payment, a block, or a cancellation reaches the panel and the
customer portal without anyone reloading a page.

Invoices are always read live from SGP. The contract behind a device (holder,
plan, status) is cached for 24 hours and re-read after that, and a cached link
recorded for a different customer account than the device currently serves is
discarded rather than shown.

## Automatic activation

Open **Settings → Automatic activation** to let a newly installed ONT configure
itself. The panel resolves the SGP contract from the PPPoE login the ONT already
reports, applies the profile matching the contract's plan (WiFi, administrative
password, PPPoE WAN, VLAN), and records every step so a failed activation can be
diagnosed. It is off by default, and every action has a dry run. See
[`docs/provisioning.md`](docs/provisioning.md).

## Database Migration

Open **Settings → Database** as an administrator to:

1. Inspect the active database configuration.
2. Test a MySQL connection.
3. Migrate existing application data.
4. Switch the running application to the new database.

The migration includes device installation profiles, related customer accounts, encrypted customer WiFi credentials, SGP contract links, provisioning profiles and their run history, and stored SGP events.

## Development

```bash
git clone https://github.com/skydashnet/genieacs-panel.git
cd genieacs-panel
npm run install:all
npm run dev:backend
npm run dev:frontend
```

Useful project checks:

```bash
npm run check:backend   # syntax-check every backend module
npm run test:backend    # operator and customer portal integration tests
npm run lint
npm run typecheck
npm run build
npm run verify          # all of the above, the same sequence CI runs
```

Build and run the production bundle locally:

```bash
npm run build
npm start
```

## Languages

The operator panel and the customer portal ship with Portuguese (Brazil),
English, Spanish, Italian, German, French, Japanese, Simplified Chinese,
Traditional Chinese, Korean, and Russian. The active language follows the
browser preference on first load and falls back to Portuguese (Brazil); the
choice is stored per browser in `localStorage` under the `language` key.
Operators change it from the sidebar or from **Settings → Panel & ACS**, and
subscribers change it from the portal header. Dates and numbers follow the
active locale and the viewer time zone.

API responses follow the same language. The panel and the portal send the
active locale in `Accept-Language`, the backend negotiates it per request
(falling back to Portuguese), and every response carries `Content-Language`
plus `Vary: Accept-Language` so a proxy never serves one language to a client
that asked for another.

Translations live in `frontend/src/lib/i18n/locales/` for the interface and
`backend/src/i18n/locales/` for the API messages. In both places `en` is the
source of truth: the frontend dictionaries are typed against it, so
`npm run typecheck` fails whenever a key is added without a translation in
every language, and `npm run test:backend` fails on the same gap for the API
dictionaries. To add a language, create a locale file on both sides, register
it in `frontend/src/lib/i18n/config.ts` and `backend/src/i18n/config.js`, and
add it to `dictionaries` in the matching `index` module.

Text that SGP or GenieACS itself returns is passed through as the provider
phrased it, since only the provider can translate it.

## Architecture

- **Backend:** Node.js, Express 5, Knex, SQLite, MySQL, and JWT.
- **Schema:** ordered, recorded migrations in `backend/src/config/migrations.js`; every applied step is stored in a `schema_migrations` table, and a database created before the runner existed is baselined on first boot rather than rebuilt.
- **Frontend:** Vite, React, React Router, TypeScript, and Tailwind CSS.
- **Deployment:** `systemd`, hardened service boundaries, automatic dependency installation, and an update-safe CLI.
- **Integration:** GenieACS NBI with typed task values and multi-vendor parameter discovery.

The operator and customer APIs use separate listeners. Administrative routes are not mounted on the customer portal port.

## Security

- Role-based operator access with bcrypt password hashing and separate access and refresh tokens.
- Per-customer portal passwords, bcrypt hashed and independent of the Customer ID.
- Customer sessions stored in `HttpOnly`, `SameSite=Strict` cookies.
- Customer actions resolve the target device exclusively from the authenticated account.
- Saved WiFi passwords protected at rest with authenticated AES-256-GCM encryption.
- Password values revealed only through an authenticated, rate-limited request.
- Same-origin mutation checks, strict CSP, security headers, and request-size limits.
- Dedicated rate limits for login, portal API access, WiFi mutations, and password reveals.
- Authenticated portal limits keyed per customer account, so one visitor cannot exhaust the quota for the rest of the customer base behind a shared proxy address.
- Session revocation after operator password changes, role changes and logout.
- A recycled ONT retires the previous subscriber's account instead of handing it to the next one.
- Internal error text is returned only when `APP_ENV=development` is set explicitly.
- Loopback-only listeners by default.
- Hardened `systemd` unit with restricted write paths and `NoNewPrivileges`.

Keep `JWT_SECRET` stable across reinstallations and container replacements. Changing it invalidates existing sessions and makes previously encrypted WiFi credentials unreadable.

## Docker

```bash
docker build -t skygenpanel .
docker run \
  -p 5890:5890 \
  -p 5891:5891 \
  -v skygenpanel-data:/var/lib/skygenpanel \
  -e DATA_DIR=/var/lib/skygenpanel \
  -e JWT_SECRET="$(openssl rand -hex 48)" \
  skygenpanel
```

## License

SkyGenPanel is available under the [MIT License](LICENSE).

For support, email [support@skydash.net](mailto:support@skydash.net) or open a [GitHub issue](https://github.com/skydashnet/genieacs-panel/issues).

<div align="center">
  <sub>© 2024–2026 SkydashNET</sub>
</div>
