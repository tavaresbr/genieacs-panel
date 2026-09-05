# SGP integration

SkyGenPanel can read subscriber contract and billing data from
[SGP (Sistema de Gestão de Provedores)](https://sgp.net.br) through the provider's
own integration API. Once configured, an operator sees the contract, plan,
service status, and open invoices next to the ONT, and the customer portal can
show the subscriber their own open invoices and — optionally — request a trust
unlock ("liberação em confiança").

The panel only reads billing data and requests a trust unlock. It never creates,
edits, or settles invoices in SGP.

## What the panel calls

All requests are `POST` with a JSON body that carries the `app` and `token`
credentials plus one customer filter:

| Purpose | Default path | Filters sent |
| --- | --- | --- |
| Contract lookup | `/api/ura/consultacliente/` | `cpfcnpj`, `contrato`, or `login` |
| Open invoices | `/api/ura/titulos/` | `contrato` (or `cpfcnpj`), `limit`, `apenas_titulos_em_aberto` |
| Trust unlock | `/api/ura/liberacao/` | `contrato` |

Responses are read through a normalizing layer, so field spellings that differ
between SGP releases (`linhadigitavel`, `linha_digitavel`, `linhaDigitavel`) and
value formats (`129,90` or `129.90`, `10/10/2026` or `2026-10-10`) are all
accepted. Requests time out after 15 seconds.

## Setup

1. In SGP, open **Administração → Integrações → Tokens** and create a token.
   Note the *app* name and the generated token.
2. In SkyGenPanel, open **Settings → SGP integration** as an administrator.
3. Fill in:
   - **SGP URL** — the provider base URL, e.g. `https://provedor.sgp.net.br`.
   - **App** and **Token** — the credentials from step 1.
   - **ONT to contract link** — which identifier is sent to SGP when a device
     has no contract linked yet:
     - *PPPoE login of the ONT* (default) — uses the PPPoE username the ONT reports.
     - *Panel Customer ID* — uses the panel's generated Customer ID.
     - *Manual link only* — no automatic lookup; an operator links each ONT.
   - **Invoices per query** — how many open invoices to request (1–24).
4. Use **Test connection** to verify. Without a sample customer the probe only
   confirms that the URL, app, and token are accepted; entering a CPF/CNPJ,
   contract number, or PPPoE login also verifies the lookup itself.
5. Enable **Enable the SGP integration** and save.

The token is encrypted with the shared secret box (AES-256-GCM, keyed from
`JWT_SECRET` under its own context) before being stored, and it is never
returned to the browser. Saving with an empty token
field keeps the stored one; **Remove token** clears it and disables the
integration.

> Because the key is derived from `JWT_SECRET`, changing that secret invalidates
> the stored token — re-enter it in Settings afterwards.

## Operator view

**Device Inventory → device → Overview** shows an *SGP integration* card with the
contract number, customer name, plan, and service status, followed by the open
invoices with their digitable line, PIX code, and second-copy link.

- **Refresh from SGP** re-queries SGP and refreshes the cached link.
- **Trust unlock** requests a trust unlock for the linked contract.
- **Unlink** removes the stored link so the ONT resolves again (or can be
  linked to a different contract).
- When automatic resolution finds nothing, the card offers a manual link by
  contract number.

Resolved links are cached in the `sgp_links` table, so day-to-day page loads do
not re-query SGP.

## Customer portal

Two portal options are configured in the same settings tab:

- **Show invoices in the customer portal** adds an *Invoices* section to the
  portal listing the subscriber's open invoices, with the CPF/CNPJ masked to its
  last four digits. Paid invoices are filtered out.
- **Allow trust unlock from the portal** adds a trust-unlock button. SGP still
  decides whether the request is granted.

The contract is always resolved from the authenticated portal session; the
browser cannot choose which contract is read. Both endpoints are rate limited
per customer account rather than per source address — 20 billing reads a minute
and 3 trust unlocks an hour — so one subscriber cannot exhaust the quota for
everyone behind the same proxy.

## API reference

Operator endpoints (admin role required, `/api` on the panel port):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sgp/config` | Current configuration; never includes the token |
| `PUT` | `/api/sgp/config` | Update configuration (omit `token` to keep it) |
| `POST` | `/api/sgp/test` | Connectivity and credential probe |
| `GET` | `/api/sgp/customers?login=&contract=&document=` | Contract lookup |
| `GET` | `/api/sgp/devices/:deviceId?refresh=1` | Link plus open invoices for a device |
| `POST` | `/api/sgp/devices/:deviceId/link` | Manually link a contract |
| `DELETE` | `/api/sgp/devices/:deviceId/link` | Remove the link |
| `POST` | `/api/sgp/devices/:deviceId/unlock` | Request a trust unlock |

Customer portal endpoints (portal session required, portal port):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/customer/billing` | Contract summary and open invoices |
| `POST` | `/api/customer/billing/trust-unlock` | Request a trust unlock |

Errors carry a machine-readable `code`: `not_configured`, `unlinked`,
`not_found`, `unauthorized`, `timeout`, `unreachable`, `sgp_rejected`,
`invalid_response`.

All panel and portal strings for the integration go through the panel's
translation dictionaries (`pt-BR`, `en`, `es`), so the labels above appear in
the reader's language. Two kinds of text are not translated: values that come
from SGP itself (contract status, plan name, invoice description) are shown
exactly as the provider's system returns them, and the API error messages in
the table below are returned in Portuguese, like the rest of this API's
messages.

## Troubleshooting reference

| Symptom | Likely cause |
| --- | --- |
| "O SGP recusou as credenciais de integração" | Wrong app/token, or the token has no permission for the URA endpoints |
| "Este ONT ainda não tem contrato do SGP vinculado" | The ONT reports no PPPoE username, or the login does not match SGP; link manually |
| "O SGP não respondeu dentro do tempo limite" | Network path or firewall between the panel and SGP |
| Invoices missing while the contract loads | The provider's SGP install restricts the `titulos` endpoint for this token |
| Custom integration paths | Endpoint paths are stored per install and can be adjusted through `PUT /api/sgp/config` (`endpoints.customer`, `endpoints.invoices`, `endpoints.unlock`) |
