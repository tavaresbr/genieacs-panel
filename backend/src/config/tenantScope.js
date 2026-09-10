import { SCHEMA_TABLES } from './migrations.js';

/**
 * The tables whose rows belong to one provider and are filtered by it.
 *
 * This list is the migration's progress, not a description of the goal. A table
 * enters it only once three things are true: it has a `tenant_id` column, every
 * model method that touches it goes through `tdb`/`tinsert`, and a leak test
 * covers it. Until then the table is read unfiltered, exactly as before — which
 * is correct while there is one provider, and is why the conversion can be done
 * a few tables at a time instead of in one unreviewable change.
 *
 * Everything not listed here is either still pending or genuinely shared. The
 * difference matters, so the shared ones are named rather than left implicit.
 */
export const SCOPED_TABLES = new Set([
  // The three whose models delete or update without a where clause. Scoped
  // first because a half-converted destructive write does not leak data, it
  // destroys someone else's.
  'mapping_nodes',
  'mapping_edges',
  'whatsapp_accounts',
  // The identity table. `identity_hash` is sha256(softwareId, pppoe_username):
  // within one provider, matching on it is how an ONT swap keeps the
  // subscriber's portal login. Across two it is account takeover, because the
  // same firmware and a same-named subscriber produce the same hash.
  'customer_accounts',
  // The subscriber's SSID and their AES-GCM-encrypted WiFi password. No
  // provider could read another's before this: every method filters on
  // `account_id`, and `customer_accounts` has been scoped since 0010, so the
  // parent already refused to hand one provider another's account. What the
  // column buys is a filter of its own rather than one inherited through a
  // join, which is what a stored secret should rest on.
  'customer_wifi_credentials',
  // The installation dates. Read across providers, the date one ISP recorded
  // for a device id becomes the suffix of another ISP's Customer ID — and since
  // the same read is what decides insert-vs-update, the second provider never
  // got a row at all: it overwrote the first's, so correcting a date at one ISP
  // silently changed a subscriber's at the other.
  'device_profiles',
  // The contract cadastre. It is what turns a device id into a subscriber, so
  // it is also the table the WhatsApp side resolves an inbound phone number
  // against: unfiltered, one provider's operator could type a number and be
  // handed another provider's contract, name and document.
  'sgp_links',
  // The ERP event log, and the heaviest concentration of personal data here:
  // contract, document, PPPoE login, device id and a redacted payload, per
  // event. Deployment-wide it also had a second failure that read as no
  // failure at all — `dedupe_key` was unique across every provider while it is
  // built from SGP's per-ERP sequential event id, so one ISP's event #12345
  // was filed as a redelivery of another ISP's and silently discarded.
  'sgp_events',
  // The WhatsApp inbox and its send queue. Scoping these is what lets the
  // outbox worker drain one provider at a time instead of the deployment.
  'wa_conversations',
  'wa_messages',
  'wa_opt_outs',
  // Campaigns and the alert cooldown. Scoping these lets the campaign flush
  // run per provider, and stops one provider's ONT outage from suppressing
  // another provider's alert for the same rule.
  'wa_templates',
  'wa_broadcasts',
  'wa_broadcast_recipients',
  'wa_alert_state',
  // The provisioning rulebook and its history. A profile is one ISP's decision
  // about its own plans, secrets included; a run names a device id and a
  // contract, neither of which is unique outside the provider that issued it.
  // Scoping the pair together is what lets the reaper and the retention prune
  // — whose WHERE is only a status and a cutoff — stop being deployment-wide.
  'provisioning_profiles',
  'provisioning_runs',
  // The configuration pair. `settings` is what an operator sets on screen;
  // `app_state` holds the integration blobs — and `dashboard_snapshot`, which
  // is not configuration at all but a provider's own device and fault counts.
  'settings',
  'app_state',
  // Telemetry. A sample is a reading from one provider's subscriber's
  // equipment, and the device id it is keyed on is only unique inside that
  // provider's GenieACS — two providers can hand the same id to two ONTs.
  'device_samples',
  'device_sample_hours',
  // Which ONT replaced which, for one provider's subscriber.
  'device_swaps',
  // Where the operator's own plant is centred. A singleton keyed `id: 1`, so
  // its WHERE never was an identity filter — it meant "the only row", and the
  // second provider to save a map centre wrote over the first's.
  'map_settings',
  // The equipment catalogue. Its content really is the same fact about firmware
  // for every ISP, but the rows are edited on screen, so shared they made one
  // operator's corrected detection pattern or parameter path silently change
  // another's WiFi writes. The three move together because a mapping points at
  // a vendor and the delete cascades down that foreign key — scoping the parent
  // alone would leave a destructive write reaching across providers.
  'vendors',
  'wifi_security_mappings',
  'wifi_security_config',
  // A trilha das ações sensíveis. Escopada pelo motivo óbvio e por mais um: a
  // trilha de um ISP diz quem são seus operadores, quantos assinantes ele tem e
  // quando alguém revelou a senha de um deles.
  'audit_log',
  // Os convites em aberto de um provedor. Escopada e não compartilhada, ao
  // contrário de `tenant_users`: um convite pertence a UM provedor — é o
  // vínculo que ele oferece — e listá-los sem filtro entregaria a um provedor
  // quem o vizinho está tentando contratar. A busca pelo token é a exceção
  // declarada, e está em `TenantInvite.findByToken`, com o motivo escrito lá.
  'tenant_invites',
  // A assinatura e o extrato de um provedor. Escopadas como o resto: a tela de
  // plano e uso é do próprio provedor, e o extrato é dado financeiro dele — sai
  // no export e some na exclusão, como tudo que é dele.
  'subscriptions',
  'billing_events'
]);

/** Tables that belong to the deployment rather than to any one provider. */
export const SHARED_TABLES = new Set([
  // The provider registry itself.
  'tenants',
  // A row in `users` is a PERSON, not one provider's data. A consultant or a
  // reseller serving several ISPs with one login is the common arrangement in
  // this market, and a `tenant_id` here would foreclose it — while the three
  // foreign keys that point at `users.id` (who sent the message, who revoked
  // the opt-out, who created the campaign) would still name only the id, so
  // nothing in the schema would stop one provider's operator being recorded as
  // the sender of another's message.
  'users',
  // The bridge that says which providers a person works for, and with what
  // role at each. Shared for the same reason `tenants` is: it is asked BEFORE
  // a scope exists, at login, to decide which scope to open — reading it
  // through the scope would be circular. `TenantUser` carries the rule that
  // every query against it must name a person or a provider.
  'tenant_users',
  // A trilha do plano de controle: o que quem opera o SaaS fez COM um
  // provedor. Compartilhada porque é ACIMA dos provedores e porque a linha que
  // registra a exclusão de um tem que sobreviver a ele — escopada, ela seria
  // apagada exatamente junto com o que existe para registrar.
  'platform_audit',
  // The control plane's roster. Above providers rather than inside one: a
  // provider's own administrator must not be able to mint providers or reach
  // into another's, so this cannot be a per-provider table by construction.
  'platform_admins',
  // A tabela de preços. É uma só para o deploy inteiro, e um provedor não
  // edita o próprio plano — ele o lê, por `subscriptions.plan_id`.
  'plans'
]);

/** Tables still to be converted. Shrinks to empty as the phase progresses. */
export function pendingTables() {
  return SCHEMA_TABLES.filter(
    (table) => !SCOPED_TABLES.has(table) && !SHARED_TABLES.has(table)
  );
}

export function isScoped(table) {
  return SCOPED_TABLES.has(table);
}

/**
 * Guards the list against drifting from the schema. Called by the tests rather
 * than at import time, so a typo is a named failure instead of a boot crash.
 */
export function unknownScopedTables() {
  const known = new Set(SCHEMA_TABLES);
  return [...SCOPED_TABLES, ...SHARED_TABLES].filter((table) => !known.has(table));
}
