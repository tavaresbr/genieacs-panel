/**
 * Ordered schema migrations.
 *
 * Each step carries a stable id that is recorded in `schema_migrations` once it
 * succeeds. Ids are never renumbered and never reused: appending a new step is
 * the only supported way to change the schema.
 *
 * Two rules keep the runner safe on installations that predate it:
 *  - every `up` is idempotent, so re-running it on a database that already has
 *    the objects is a no-op instead of an error;
 *  - `isApplied` reports whether the step's objects are already in place, which
 *    is what lets `ensureSchema` baseline an old database (record the step as
 *    applied) rather than migrate it again.
 *
 * Only knex builders that behave the same on better-sqlite3, mysql2 and pg are
 * used here; there is no raw SQL and no dialect-specific syntax. CI runs the
 * whole suite against all three, so a step that holds on only one of them fails
 * before it reaches anyone's database.
 */

/** Portal credential columns, shared by the initial table and the 0003 upgrade. */
const CUSTOMER_PASSWORD_COLUMNS = [
  ['password_hash', (t) => t.string('password_hash', 255)],
  ['password_ciphertext', (t) => t.text('password_ciphertext')],
  ['password_iv', (t) => t.string('password_iv', 32)],
  ['password_tag', (t) => t.string('password_tag', 32)],
  ['password_updated_at', (t) => t.timestamp('password_updated_at')]
];

/**
 * Records which key encrypted each stored secret.
 *
 * Every ciphertext used to be derived from JWT_SECRET, and `secretBox.decrypt`
 * reports failure by returning null. Rotating that secret — an ordinary
 * security operation — therefore turned every stored secret into an unreadable
 * blob, silently. With the version on the row, a deployment can move to a
 * dedicated SECRET_BOX_KEY and still read what was written before the move.
 *
 * Only the secrets stored in their own columns need this. The ones kept as
 * JSON in `app_state` (the SGP token, the Evolution admin key) already carry
 * the field, because those helpers spread the whole box output into the object.
 *
 * Existing rows stay NULL, which already means version 1; writing a value
 * would be a fleet-sized update that says nothing the absence does not.
 */
const SECRET_KEY_VERSION_COLUMNS = [
  ['customer_accounts', ['password_key_version']],
  ['customer_wifi_credentials', ['password_key_version']],
  ['provisioning_profiles', ['wifi_password_key_version', 'cpe_password_key_version']],
  ['whatsapp_accounts', ['token_key_version', 'webhook_token_key_version']]
];

function keyVersionColumns(names) {
  return names.map((name) => [name, (t) => t.integer(name)]);
}

/** Shared by the initial `users` table and the 0002 upgrade. */
function addTokenVersion(t) {
  t.integer('token_version').notNullable().defaultTo(0);
}

/**
 * Shared by `sgp_links` and the 0008 upgrade.
 *
 * WhatsApp needs a number and the panel never had one anywhere. `phone_e164` is
 * what SGP returned on the last sync; `phone_manual` is what an operator typed
 * and always wins, because the ERP cadastre is often stale and the operator is
 * the one holding the correction.
 */
const SGP_PHONE_COLUMNS = [
  ['phone_e164', (t) => t.string('phone_e164', 24)],
  ['phone_manual', (t) => t.string('phone_manual', 24)]
];

function addSgpPhoneColumns(t) {
  for (const [, add] of SGP_PHONE_COLUMNS) add(t);
}

/**
 * Shared by `wa_messages` and the 0014 upgrade.
 *
 * Rows written before this column existed default to 'operator'. That is the
 * safe direction: the ceiling this column exists to make honest only ever
 * counts 'bot', so an old row misfiled as an operator's message can silence
 * nothing.
 */
const WA_MESSAGE_SOURCE_COLUMNS = [
  ['source', (t) => t.string('source', 16).notNullable().defaultTo('operator')]
];

/**
 * Shared by `wa_messages` and the 0020 upgrade.
 *
 * Three queries that already existed and had no index that fit them. See the
 * 0018 step for what each one serves and why the index it had did not.
 */
const WA_MESSAGE_OUTBOX_INDEXES = [
  ['conversation_id', 'id'],
  ['tenant_id', 'created_at'],
  ['delivery_status', 'next_attempt_at']
];

/**
 * Shared by the 0023 upgrade.
 *
 * The runs' two existing indexes, re-fronted with `tenant_id`: a scoped query
 * always carries the provider, so an index that does not lead with it is one
 * the planner has to look past.
 */
const PROVISIONING_RUN_TENANT_INDEXES = [
  [['tenant_id', 'device_id', 'status'], 'provisioning_runs_tenant_device_status_idx'],
  [['tenant_id', 'status', 'next_attempt_at'], 'provisioning_runs_tenant_due_idx']
];

/**
 * Shared by the 0026 upgrade. In dependency order: `wifi_security_mappings`
 * points at `vendors`, so the parent is converted first.
 */
const VENDOR_CATALOGUE_TABLES = ['vendors', 'wifi_security_mappings', 'wifi_security_config'];

// Table definitions. Each is a factory so the builder can reach `db.fn.now()`,
// and each is referenced by exactly one place per table so the initial schema
// and the later upgrade steps can never drift apart.

const tenantUsersTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  t.integer('user_id').unsigned().notNullable()
    .references('id').inTable('users').onDelete('CASCADE');
  // The role belongs to the MEMBERSHIP, not to the person: someone can be an
  // admin at the ISP they own and an ordinary operator at one they consult for.
  t.string('role', 32).notNullable().defaultTo('user');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  // One membership per person per provider. This is the row the token names,
  // so a duplicate would make "which role does she have here" ambiguous.
  t.unique(['tenant_id', 'user_id']);
  // How the users screen asks: everyone at this provider.
  t.index(['tenant_id']);
};

const usersTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('username', 64).notNullable().unique();
  // O e-mail com que a pessoa entra. Nulo é legítimo e é o estado de toda conta
  // que existia antes desta coluna: o login por nome continua valendo enquanto
  // `LOGIN_REQUIRES_EMAIL` estiver desligado, que é o que permite a troca
  // acontecer sem um dia de virada em que ninguém entra.
  //
  // 255 porque é o limite prático de um endereço; guardado sempre em minúsculas
  // — ver `User.normalizeEmail` e o porquê de a comparação não poder depender
  // da colação do banco.
  t.string('email', 255).unique();
  t.string('password', 255).notNullable();
  t.string('role', 32).notNullable().defaultTo('user');
  addTokenVersion(t);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const keyValueTable = (db) => (t) => {
  t.string('key', 128).primary();
  t.text('value');
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const vendorsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('name', 128).notNullable();
  t.text('manufacturer_patterns');
  t.text('product_patterns');
  t.string('parameter_prefix', 255);
  t.string('service_list_path', 255);
  t.string('lan_binding_path', 255);
  t.string('vlan_id_path', 255);
  t.string('wifi_password_path', 255);
  t.string('http_wan_enable_path', 255);
  t.string('firewall_level_path', 255);
  t.integer('priority').notNullable().defaultTo(10);
  t.boolean('enabled').notNullable().defaultTo(true);
  t.text('description');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const wifiSecurityMappingsTable = (db) => (t) => {
  t.increments('id').primary();
  // `unsigned` is what makes this match vendors.id: increments() is
  // `int unsigned` on MySQL, and MySQL refuses a foreign key between a signed
  // and an unsigned column (errno 150 / ER_FK_INCOMPATIBLE_COLUMNS), which
  // aborts the whole schema. The other foreign keys here already carry it.
  t.integer('vendor_id').unsigned().notNullable()
    .references('id').inTable('vendors').onDelete('CASCADE');
  t.string('raw_security_value', 128).notNullable();
  t.string('normalized_security', 128).notNullable();
  t.text('description');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const wifiSecurityConfigTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('product_class', 128).notNullable();
  t.string('security_types', 255);
  t.string('password_param_path', 255);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const mappingNodesTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('node_id', 128).notNullable().unique();
  t.string('type', 32).notNullable();
  t.string('name', 255).notNullable();
  t.decimal('latitude', 10, 7).notNullable();
  t.decimal('longitude', 10, 7).notNullable();
  t.integer('capacity');
  t.string('splitter', 64);
  t.string('pppoe', 255);
  t.text('notes');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const mappingEdgesTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('edge_id', 128).notNullable().unique();
  t.string('source', 128).notNullable().references('node_id').inTable('mapping_nodes').onDelete('CASCADE');
  t.string('target', 128).notNullable().references('node_id').inTable('mapping_nodes').onDelete('CASCADE');
  t.string('fiber_type', 32);
  t.decimal('distance', 10, 2);
  t.text('waypoints');
  t.text('notes');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const mapSettingsTable = (db) => (t) => {
  t.integer('id').primary();
  t.string('center_lat', 32).notNullable();
  t.string('center_lng', 32).notNullable();
  t.string('max_zoom_in', 8).notNullable();
  t.string('max_zoom_out', 8).notNullable();
  t.string('default_zoom', 8).notNullable();
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const customerAccountsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('customer_id', 32).notNullable().unique();
  t.string('device_id', 255).notNullable().unique();
  t.string('identity_hash', 64).notNullable().unique();
  t.string('software_id', 255).notNullable();
  t.string('pppoe_username', 255).notNullable();
  t.boolean('active').notNullable().defaultTo(true);
  // Portal credentials are independent of the Customer ID: the ID only
  // identifies the account, the hash authenticates it, and the encrypted
  // copy lets an operator hand the password back without resetting it.
  for (const [, add] of CUSTOMER_PASSWORD_COLUMNS) add(t);
  t.timestamp('last_seen_at').defaultTo(db.fn.now());
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const deviceProfilesTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('device_id', 255).notNullable().unique();
  t.date('installation_date');
  t.string('installation_tag', 64);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const sgpLinksTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('device_id', 255).notNullable().unique();
  t.integer('account_id').unsigned()
    .references('id').inTable('customer_accounts').onDelete('SET NULL');
  t.string('contract', 64).notNullable();
  t.string('document', 32);
  t.string('client_name', 255);
  t.string('plan', 255);
  t.string('status', 64);
  t.string('status_label', 128);
  // Derived from the SGP status so the fleet views can group contracts
  // without depending on each install's Portuguese labels.
  t.string('state', 16).notNullable().defaultTo('unknown');
  t.string('login', 255);
  t.string('link_mode', 16).notNullable().defaultTo('auto');
  addSgpPhoneColumns(t);
  t.timestamp('last_synced_at').defaultTo(db.fn.now());
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const customerWifiCredentialsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('account_id').unsigned().notNullable()
    .references('id').inTable('customer_accounts').onDelete('CASCADE');
  t.integer('wifi_index').notNullable();
  t.string('ssid', 32).notNullable();
  t.text('password_ciphertext');
  t.string('password_iv', 32);
  t.string('password_tag', 32);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['account_id', 'wifi_index']);
};

/**
 * A provider. One row today — the install itself — so that every table that
 * will be scoped has something real to point at before anything depends on it.
 */
/**
 * The SaaS control plane's roster. Deliberately just an identity: what a
 * platform administrator may do is decided in code, not by a role string here,
 * because there is exactly one such power and naming degrees of it would invite
 * inventing more.
 */
const platformAdminsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('user_id').unsigned().notNullable().unique()
    .references('id').inTable('users').onDelete('CASCADE');
  t.timestamp('created_at').defaultTo(db.fn.now());
};

/**
 * O convite: como uma pessoa entra na equipe de um provedor sem que o
 * administrador escolha a senha dela.
 *
 * A onda 12 recusou, com razão, que o administrador de um provedor anexasse
 * alguém que já existe no deploy: aquele request carrega uma SENHA, e há uma
 * senha por pessoa, então "adicionar a maria" digitado aqui trocaria o login de
 * uma estranha que trabalha para outro ISP, derrubaria as sessões dela em todo
 * lugar e entregaria a este administrador credenciais válidas no painel do
 * vizinho. O convite é a saída: quem administra oferece o vínculo, e é a pessoa
 * convidada quem entra — com a conta que já tem, ou com uma que ela mesma cria.
 *
 * Guarda o HASH do token e nunca o token. O que vai no link é mostrado uma vez,
 * na resposta da criação, e não pode ser recuperado depois — mesma disciplina
 * do segredo do webhook do SGP e da senha do portal do assinante. Um convite é
 * uma credencial: quem tem o link entra na equipe.
 */
/**
 * A trilha das ações sensíveis: quem fez, o quê, sobre quem, e quando.
 *
 * Escopada por provedor como quase tudo aqui, e por um motivo além do óbvio: a
 * trilha de um ISP diz quem são seus operadores, quantos assinantes ele tem e
 * quando alguém revelou a senha de um deles. É dado tão dele quanto a lista de
 * contratos.
 *
 * A coluna `detail` é a que mais precisa de disciplina. Nada de segredo entra
 * ali — nem a senha revelada, nem a credencial da NBI, nem o token do convite.
 * O que a trilha registra é que a senha foi revelada, não qual era: a primeira
 * coisa é o que permite auditar, a segunda transformaria a auditoria no maior
 * repositório de segredos em claro do produto. `audit-log.test.js` guarda isso
 * com uma varredura sobre o que cada gravação de verdade produz.
 */
/**
 * A trilha do plano de controle — acima dos provedores, não dentro de um.
 *
 * `audit_log` é escopada e responde "o que aconteceu no meu painel?". Esta
 * responde outra coisa: o que quem opera o SaaS fez COM um provedor. Precisa
 * ser uma tabela à parte por uma razão que não é organização: a exclusão de um
 * provedor tem que deixar registro, e registrar isso na trilha DELE é inútil —
 * ela vai junto.
 *
 * Daí `tenant_id` ser um inteiro simples e **não** uma chave estrangeira, com o
 * slug e o nome desnormalizados ao lado. Uma FK aqui apagaria em cascata (ou
 * impediria) exatamente a linha que existe para dizer que aquele provedor foi
 * apagado, que é a única linha desta tabela que não pode faltar.
 */
const platformAuditTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('actor_user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.string('actor_username', 64);
  t.string('action', 64).notNullable();
  // Sem FK, de propósito. Ver acima.
  t.integer('tenant_id').unsigned();
  t.string('tenant_slug', 64);
  t.string('tenant_name', 128);
  t.text('detail');
  t.string('ip', 64);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.index(['created_at', 'id'], 'platform_audit_recent_idx');
};

const auditLogTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  // `SET NULL` e não `CASCADE`: a pessoa pode sair, e a linha que diz o que ela
  // fez tem que continuar de pé. Uma trilha que some junto com quem a produziu
  // não é trilha.
  t.integer('actor_user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
  // Desnormalizado pela mesma razão de `provisioning_runs.profile_name`: seis
  // meses depois o nome ainda responde "quem foi", mesmo que a linha em `users`
  // já não exista.
  t.string('actor_username', 64);
  // operator | platform | system. `platform` é quem opera o SaaS agindo sobre o
  // provedor de fora; `system` é trabalho de fundo sem gente por trás.
  t.string('actor_kind', 16).notNullable().defaultTo('operator');
  t.string('action', 64).notNullable();
  // Sobre o quê: 'customer_account', 'tenant_user', 'invite', 'settings'…
  t.string('subject_type', 32);
  t.string('subject_id', 128);
  // JSON curto e SEM segredo. Ver o comentário acima.
  t.text('detail');
  t.string('ip', 64);
  t.timestamp('created_at').defaultTo(db.fn.now());
  // Como a tela pergunta: as ações deste provedor, da mais recente para a mais
  // antiga. `id` no fim desempata dentro do mesmo segundo, que é o que acontece
  // quando uma ação grava duas linhas.
  t.index(['tenant_id', 'created_at', 'id'], 'audit_log_recent_idx');
  t.index(['tenant_id', 'action'], 'audit_log_action_idx');
};

const tenantInvitesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants').onDelete('CASCADE');
  // sha256 do token. Único no deploy porque a busca acontece ANTES de haver
  // provedor em escopo: quem abre o link só apresentou o token, e é o token que
  // diz para qual provedor ele é. Único por provedor não serviria — a busca não
  // tem provedor para filtrar.
  t.string('token_hash', 64).notNullable().unique();
  t.string('role', 32).notNullable();
  // Só para quem administra se lembrar de quem convidou. Não é login, não é
  // conferido contra nada, e não é para onde o convite é enviado: o painel não
  // manda e-mail. Nulo é legítimo.
  t.string('label', 255);
  t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('expires_at').notNullable();
  t.timestamp('accepted_at');
  t.integer('accepted_user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('revoked_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  // Como a tela pergunta: os convites em aberto deste provedor.
  t.index(['tenant_id', 'accepted_at'], 'tenant_invites_open_idx');
};

const tenantsTable = (db) => (t) => {
  t.increments('id').primary();
  // The subdomain the panel will be reached at once tenants are resolved by
  // host; unique from the start so nothing has to be de-duplicated later.
  t.string('slug', 64).notNullable().unique();
  t.string('name', 128).notNullable();
  t.string('status', 16).notNullable().defaultTo('active');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const provisioningProfilesTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('name', 128).notNullable().unique();
  // Case-insensitive substrings matched against the SGP plan name, stored as a
  // JSON array like the vendor pattern columns.
  t.text('plan_patterns');
  // A cleared pattern list must not silently become a catch-all, so the
  // fallback profile is an explicit choice instead.
  t.boolean('is_default').notNullable().defaultTo(false);
  t.integer('priority').notNullable().defaultTo(10);
  t.boolean('enabled').notNullable().defaultTo(true);
  t.boolean('apply_wan').notNullable().defaultTo(true);
  t.boolean('apply_pppoe_password').notNullable().defaultTo(true);
  t.string('wan_name', 256);
  t.integer('wan_vlan_id');
  t.string('wan_service_list', 128);
  t.string('wan_connection_type', 32);
  t.boolean('wan_nat_enabled');
  t.boolean('apply_wifi').notNullable().defaultTo(true);
  t.text('wifi_indexes');
  t.string('wifi_ssid_template', 64);
  t.string('wifi_password_mode', 16).notNullable().defaultTo('random');
  t.text('wifi_password_ciphertext');
  t.string('wifi_password_iv', 32);
  t.string('wifi_password_tag', 32);
  t.boolean('apply_credentials').notNullable().defaultTo(false);
  t.string('credential_targets', 16).notNullable().defaultTo('super');
  t.text('cpe_password_ciphertext');
  t.string('cpe_password_iv', 32);
  t.string('cpe_password_tag', 32);
  t.text('description');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const provisioningRunsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('device_id', 255).notNullable();
  t.string('contract', 64);
  t.integer('profile_id').unsigned()
    .references('id').inTable('provisioning_profiles').onDelete('SET NULL');
  // Denormalized so deleting a profile does not erase why a run behaved the
  // way it did.
  t.string('profile_name', 128);
  t.string('trigger', 16).notNullable().defaultTo('poller');
  t.string('status', 24).notNullable().defaultTo('pending');
  t.integer('attempt_count').notNullable().defaultTo(0);
  t.timestamp('next_attempt_at');
  // JSON array of { step, status, detail, parameterCount, at }, redacted.
  t.text('steps');
  t.text('error');
  t.timestamp('started_at');
  t.timestamp('finished_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.index(['device_id', 'status'], 'provisioning_runs_device_status_idx');
  t.index(['status', 'next_attempt_at'], 'provisioning_runs_due_idx');
};

const sgpEventsTable = (db) => (t) => {
  t.increments('id').primary();
  // A redelivered webhook and a transition seen twice by reconciliation both
  // collapse onto the same key, so neither is processed twice.
  t.string('dedupe_key', 128).notNullable().unique();
  t.string('source', 16).notNullable();
  t.string('type', 32).notNullable();
  t.string('raw_type', 128);
  t.string('contract', 64);
  t.string('document', 32);
  t.string('login', 255);
  t.string('device_id', 255);
  t.string('status', 16).notNullable().defaultTo('pending');
  t.integer('attempts').notNullable().defaultTo(0);
  t.text('payload');
  t.text('error');
  t.timestamp('occurred_at');
  t.timestamp('received_at').defaultTo(db.fn.now());
  t.timestamp('processed_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.index(['status', 'id'], 'sgp_events_status_idx');
  t.index(['contract'], 'sgp_events_contract_idx');
};

/** Provisioning tables, in creation order: the runs reference the profiles. */
const PROVISIONING_TABLES = [
  ['provisioning_profiles', provisioningProfilesTable],
  ['provisioning_runs', provisioningRunsTable],
  ['sgp_events', sgpEventsTable]
];

// ── WhatsApp / Evolution API ───────────────────────────────────────────
//
// Two constraints shape every table below and are easy to violate by habit:
//
// 1. No partial index and no array column: MySQL has neither. Where the source
//    system used `UNIQUE ... WHERE revoked IS NULL`, uniqueness moves into the
//    model instead, and the comment there says why.
// 2. Secrets are stored through the shared secret box (AES-256-GCM keyed from
//    JWT_SECRET under its own context), never in plaintext — the rule the SGP
//    token already follows.

const whatsappAccountsTable = (db) => (t) => {
  t.increments('id').primary();
  // The instance name on the Evolution server. The inbound webhook resolves the
  // account by this value, so it has to be unique.
  t.string('name', 128).notNullable().unique();
  t.string('label', 128);
  // Which kind of traffic this number carries. The sender routes on it and
  // falls back to the default account when no number claims the purpose.
  t.string('purpose', 32).notNullable().defaultTo('general');
  // 'go' | 'v2' — detected by probe, not configured by hand.
  t.string('flavor', 8).notNullable().defaultTo('v2');
  t.string('base_url', 255).notNullable();
  // The server-side UUID. Evolution GO deletes instances by id, not name, so
  // losing this means we can only log out and drop the local row.
  t.string('instance_id', 64);
  t.string('status', 16).notNullable().defaultTo('pending');
  t.text('qr_code');
  t.timestamp('qr_updated_at');
  t.string('phone_e164', 24);
  t.boolean('is_default').notNullable().defaultTo(false);
  t.timestamp('last_seen_at');
  t.text('last_error');
  // The instance token: sending messages and reading contacts as the provider.
  t.text('token_ciphertext');
  t.string('token_iv', 32);
  t.string('token_tag', 32);
  // A DIFFERENT secret, deliberately: it travels in the webhook URL and is
  // stored on the Evolution server, so it shows up in logs on both ends.
  // Leaking it lets someone forge an inbound event; leaking the instance token
  // would let them send as the provider.
  t.text('webhook_token_ciphertext');
  t.string('webhook_token_iv', 32);
  t.string('webhook_token_tag', 32);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const waConversationsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('account_id').unsigned().notNullable()
    .references('id').inTable('whatsapp_accounts').onDelete('CASCADE');
  // Phone and LID are both identities and neither is guaranteed: a contact
  // addressed only by LID has no phone at all. See utils/wa/waJid.js.
  t.string('wa_phone_e164', 24);
  t.string('wa_lid', 32);
  t.string('external_thread_id', 128);
  t.string('push_name', 128);
  // Who this is, once we know: the ONT, the portal account, the contract.
  t.string('device_id', 255);
  t.integer('customer_account_id').unsigned()
    .references('id').inTable('customer_accounts').onDelete('SET NULL');
  t.string('contract', 64);
  t.timestamp('last_message_at');
  t.timestamp('last_inbound_at');
  t.integer('unread_count').notNullable().defaultTo(0);
  t.timestamp('closed_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  // One thread per contact per instance. A subscriber who writes to both the
  // billing and the support number gets two conversations, which is what an
  // operator expects to see.
  t.unique(['account_id', 'external_thread_id']);
  t.index(['wa_phone_e164']);
  t.index(['last_message_at']);
  // The health read asks three questions of this table on every poll — when
  // anything last arrived, how many threads are unread, how many are open —
  // and without these each one is a scan. On a provider with a hundred
  // thousand threads that is the panel's own status strip becoming the reason
  // the panel is slow.
  t.index(['last_inbound_at']);
  t.index(['closed_at']);
  t.index(['unread_count']);
};

const waMessagesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('conversation_id').unsigned().notNullable()
    .references('id').inTable('wa_conversations').onDelete('CASCADE');
  t.string('direction', 3).notNullable(); // 'in' | 'out'
  // The WhatsApp message id. Unique so a redelivered webhook cannot double an
  // inbound message, and so a receipt can find the outbound one. NULL until an
  // outbound message is accepted by the server, and repeated NULLs do not
  // collide in either engine.
  t.string('external_id', 128).unique();
  t.text('body');
  t.string('attachment_path', 255);
  t.string('attachment_type', 128);
  t.string('attachment_name', 255);
  // An internal note is written by an operator and never sent.
  t.boolean('is_note').notNullable().defaultTo(false);
  // Who produced this message: 'operator', 'bot', 'campaign' or 'alert'.
  // `sent_by` cannot answer that — it is NULL for all three automatic senders,
  // so a dunning campaign message and a bot reply were indistinguishable, and
  // the bot's hourly ceiling counted the campaign's messages against itself.
  t.string('source', 16).notNullable().defaultTo('operator');
  // queued | sending | sent | delivered | read | failed. NULL for inbound.
  t.string('delivery_status', 16);
  t.string('delivery_error', 500);
  t.timestamp('claimed_at');
  t.integer('attempts').notNullable().defaultTo(0);
  t.integer('sent_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('read_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.index(['conversation_id', 'created_at']);
  // The outbox worker's only query.
  t.index(['delivery_status', 'created_at']);
  // The three indexes of 0020 are NOT here. This factory runs in step 0001,
  // where `tenant_id` (0012) and `next_attempt_at` (0020) do not exist yet, so
  // indexing them would fail every fresh install. 0020 adds all three, and it
  // runs on a fresh database too.
};

const waOptOutsTable = (db) => (t) => {
  t.increments('id').primary();
  // Keyed by phone and LID, NOT by customer: an opt-out has to survive a record
  // being merged, deleted, or created again. Whoever asked to be left alone
  // asked as a phone number.
  t.string('wa_phone_e164', 24);
  t.string('wa_lid', 32);
  t.integer('conversation_id').unsigned()
    .references('id').inTable('wa_conversations').onDelete('SET NULL');
  t.string('origin', 16).notNullable().defaultTo('customer'); // customer | operator
  t.string('reason_text', 500);
  t.timestamp('created_at').defaultTo(db.fn.now());
  // Revocation is soft, so the history of who asked out and when survives.
  // Uniqueness of the *active* row is enforced in models/WaOptOut.js — MySQL
  // has no partial index, and a duplicate here is noise rather than a safety
  // failure (the dangerous direction is a MISSING opt-out).
  t.timestamp('revoked_at');
  t.integer('revoked_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.index(['wa_phone_e164']);
  t.index(['wa_lid']);
};

const waTemplatesTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('name', 80).notNullable().unique();
  t.text('body').notNullable();
  // cobranca | alerta | suporte | geral. The dunning renderer only accepts the
  // variables it can fill.
  t.string('category', 32).notNullable().defaultTo('geral');
  t.boolean('active').notNullable().defaultTo(true);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const waBroadcastsTable = (db) => (t) => {
  t.increments('id').primary();
  t.string('title', 200).notNullable();
  t.integer('template_id').unsigned()
    .references('id').inTable('wa_templates').onDelete('SET NULL');
  t.text('body').notNullable();
  t.integer('account_id').unsigned()
    .references('id').inTable('whatsapp_accounts').onDelete('SET NULL');
  // A campaign is born as 'draft' on purpose. Messaging hundreds of people must
  // never be the side effect of a click on a listing screen: an operator opens
  // the campaign, reads it, and presses start.
  t.string('status', 16).notNullable().defaultTo('draft');
  t.timestamp('start_at');
  t.integer('rate_limit_per_min');
  t.integer('total_count').notNullable().defaultTo(0);
  t.integer('sent_count').notNullable().defaultTo(0);
  t.integer('failed_count').notNullable().defaultTo(0);
  t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const waBroadcastRecipientsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('broadcast_id').unsigned().notNullable()
    .references('id').inTable('wa_broadcasts').onDelete('CASCADE');
  t.string('phone_e164', 24).notNullable();
  t.string('contract', 64);
  t.string('client_name', 255);
  // Rendered once, when the campaign is built, so what an operator reviews is
  // exactly what goes out.
  t.text('rendered_body').notNullable();
  t.integer('message_id').unsigned()
    .references('id').inTable('wa_messages').onDelete('SET NULL');
  t.string('status', 16).notNullable().defaultTo('pending');
  t.string('error_msg', 500);
  t.integer('attempts').notNullable().defaultTo(0);
  t.timestamp('sent_at');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.index(['broadcast_id', 'status']);
};

const waAlertStateTable = (db) => (t) => {
  t.increments('id').primary();
  // 'ont_offline', 'rx_power_low', 'temperature_high', 'mass_outage', …
  t.string('rule', 48).notNullable();
  // What the rule is about: a device id, or an ODP/OLT node id.
  t.string('subject', 255).notNullable();
  t.string('state', 16).notNullable().defaultTo('firing');
  t.timestamp('fired_at').defaultTo(db.fn.now());
  t.timestamp('cleared_at');
  // Cooldown lives here: an ONT that stays down must not produce a message on
  // every scan.
  t.timestamp('last_notified_at');
  t.integer('notify_count').notNullable().defaultTo(0);
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['rule', 'subject']);
};

/** The campaign tables that gain a provider in 0013, in dependency order. */
const TENANT_CAMPAIGN_TABLES = [
  'wa_templates',
  'wa_broadcasts',
  'wa_broadcast_recipients',
  'wa_alert_state'
];

/** The two key/value tables that gain a provider in 0014. */
const KEY_VALUE_TABLES = ['settings', 'app_state'];

/** In creation order; foreign keys dictate it. */
const WHATSAPP_TABLES = [
  ['whatsapp_accounts', whatsappAccountsTable],
  ['wa_conversations', waConversationsTable],
  ['wa_messages', waMessagesTable],
  ['wa_opt_outs', waOptOutsTable],
  ['wa_templates', waTemplatesTable],
  ['wa_broadcasts', waBroadcastsTable],
  ['wa_broadcast_recipients', waBroadcastRecipientsTable],
  ['wa_alert_state', waAlertStateTable]
];

/**
 * The tables of the initial schema, in creation order. Foreign keys dictate it:
 * `vendors` before `wifi_security_mappings`, `mapping_nodes` before
 * `mapping_edges`, and `customer_accounts` before `sgp_links` and
 * `customer_wifi_credentials`.
 */
const deviceSamplesTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants');
  t.string('device_id', 255).notNullable();
  // The sample's time axis is the inform it came from, not the tick clock.
  // GenieACS only refreshes a parameter when the device informs, so a tick that
  // sees an unchanged `_lastInform` has nothing new to store. That one decision
  // is also why there is no `online` column: a device that stops informing
  // stops producing rows, and the gap that leaves in the series IS the outage.
  t.timestamp('inform_at').notNullable();
  // Float rather than decimal on purpose: `pg` and `mysql2` both hand DECIMAL
  // back as a string, and 0.01 dBm is far inside what a float carries exactly.
  t.float('rx_power');
  t.float('temperature');
  t.integer('uptime_seconds');
  t.timestamp('created_at').defaultTo(db.fn.now());
  // Serves both reads: `max(inform_at) group by device_id` for the per-tick
  // deduplication, and the range scan the chart does.
  t.index(['tenant_id', 'device_id', 'inform_at'], 'device_samples_device_time_idx');
  // Retention walks this one. Without it the daily prune is a full scan of a
  // table that holds a million rows on a fleet of a thousand.
  t.index(['tenant_id', 'inform_at'], 'device_samples_age_idx');
};

const deviceSampleHoursTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants');
  t.string('device_id', 255).notNullable();
  t.timestamp('bucket_at').notNullable();
  t.integer('sample_count').notNullable().defaultTo(0);
  t.float('rx_min');
  t.float('rx_avg');
  t.float('rx_max');
  t.float('temp_min');
  t.float('temp_avg');
  t.float('temp_max');
  t.integer('uptime_last');
  t.timestamp('created_at').defaultTo(db.fn.now());
  // What makes re-running a rollup safe instead of doubling the buckets.
  t.unique(['tenant_id', 'device_id', 'bucket_at']);
  t.index(['tenant_id', 'bucket_at'], 'device_sample_hours_age_idx');
};

const DEVICE_HISTORY_TABLES = [
  ['device_samples', deviceSamplesTable],
  ['device_sample_hours', deviceSampleHoursTable]
];

const deviceSwapsTable = (db) => (t) => {
  t.increments('id').primary();
  t.integer('tenant_id').unsigned().notNullable()
    .references('id').inTable('tenants');
  t.integer('account_id').unsigned()
    .references('id').inTable('customer_accounts').onDelete('SET NULL');
  // Denormalized so the row still says who this was after the account is gone,
  // the same reason `provisioning_runs` keeps `profile_name`.
  t.string('customer_id', 32);
  t.string('pppoe_username', 255);
  t.string('previous_device_id', 255).notNullable();
  t.string('device_id', 255).notNullable();
  t.string('contract', 64);
  // Which branch of `ensureAccount` matched: 'identity_hash' when the
  // replacement runs the same firmware, 'pppoe' when it does not.
  t.string('matched_by', 16).notNullable();
  t.string('link_action', 16).notNullable();
  // Two ONTs trading one login during an install produce this pair over and
  // over. One row saying so beats a hundred each saying it once.
  t.boolean('flapping').notNullable().defaultTo(false);
  t.integer('repeat_count').notNullable().defaultTo(1);
  t.timestamp('occurred_at').defaultTo(db.fn.now());
  t.timestamp('acknowledged_at');
  t.integer('acknowledged_by').unsigned()
    .references('id').inTable('users').onDelete('SET NULL');
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
  t.unique(['tenant_id', 'previous_device_id', 'device_id']);
  t.index(['tenant_id', 'device_id'], 'device_swaps_device_idx');
  t.index(['tenant_id', 'acknowledged_at'], 'device_swaps_open_idx');
};

const tenantSubscriptionsTable = (db) => (t) => {
  t.increments('id').primary();
  // Uma linha por provedor, e é o `unique` que diz isso — não um comentário.
  // Duas assinaturas para o mesmo provedor seria a pergunta "este está em dia?"
  // com duas respostas, e o portão leria a que o banco devolvesse primeiro.
  t.integer('tenant_id').unsigned().notNullable().unique()
    .references('id').inTable('tenants').onDelete('CASCADE');
  // O estado COMERCIAL, que é um eixo diferente de `tenants.status`.
  //
  // `tenants.status` é administrativo: suspenso ali significa congelado, e é
  // pré-requisito da exclusão em duas etapas (onda 22) — "ninguém está
  // trabalhando lá dentro". Misturar os dois faria toda inadimplência tornar o
  // provedor elegível a ser apagado, o que é uma consequência que ninguém
  // pediu para um boleto atrasado.
  t.string('status', 16).notNullable().defaultTo('trial');
  // Quando o teste acaba. Nulo em quem já é cliente pagante.
  t.timestamp('trial_ends_at');
  // O fim do período pago corrente, para a tela dizer até quando vale.
  t.timestamp('current_period_end');
  // O plano contratado. O catálogo e os tetos vivem em `config/plans.js`, e não
  // aqui: um limite é decisão comercial que precisa de diff e de revisor, e num
  // banco um dígito errado alarga o teto de todo mundo daquele plano em
  // silêncio. Esta coluna guarda só QUAL plano, que é dado de cliente.
  t.string('plan_code', 32).notNullable().defaultTo('unlimited');
  // As exceções negociadas. Nulo significa "vale o do plano" — e não zero, que
  // é um teto legítimo de quem contratou zero.
  t.integer('max_operators').unsigned();
  t.integer('max_subscriber_accounts').unsigned();
  // Por que está neste estado, escrito por quem mudou. Aparece para o ISP.
  t.string('status_reason', 255);
  t.timestamp('status_changed_at').defaultTo(db.fn.now());
  t.timestamp('created_at').defaultTo(db.fn.now());
  t.timestamp('updated_at').defaultTo(db.fn.now());
};

const DEVICE_SWAP_TABLES = [
  ['device_swaps', deviceSwapsTable]
];

const TENANCY_TABLES = [
  ['tenants', tenantsTable]
];

/**
 * Created by 0028 rather than with the tenancy tables, because it references
 * `users` — which step 0001 creates, long after `tenants` exists.
 */
const MEMBERSHIP_TABLES = [
  ['tenant_users', tenantUsersTable],
  // Same reason as `tenant_users`: it references `users`, created by step 0001.
  ['platform_admins', platformAdminsTable],
  // Idem: aponta para `users` (quem convidou, quem aceitou) e para `tenants`.
  ['tenant_invites', tenantInvitesTable],
  // Idem: aponta para `users` (quem fez) e para `tenants`.
  ['audit_log', auditLogTable],
  // Aponta para `users` e para mais nada — ver o comentário na fábrica.
  ['platform_audit', platformAuditTable]
];

/**
 * Criada depois de `tenants`, e num grupo próprio em vez de junto com ela.
 *
 * Não vai em `TENANCY_TABLES` porque aquele grupo roda no passo 0001, onde
 * `tenants` está sendo criada na mesma leva — uma FK para uma tabela que a
 * migration ainda está criando depende da ordem dentro do grupo, e depender de
 * ordem implícita é o tipo de coisa que só falha num dos três bancos.
 *
 * Também não vai em `MEMBERSHIP_TABLES`: aquele grupo existe por um motivo
 * específico (apontar para `users`), e esta não aponta. Um grupo cujo nome
 * deixou de descrever o conteúdo é a próxima pessoa colocando a tabela errada
 * nele.
 */
const SUBSCRIPTION_TABLES = [
  ['tenant_subscriptions', tenantSubscriptionsTable]
];

const INITIAL_TABLES = [
  ['users', usersTable],
  ['settings', keyValueTable],
  ['app_state', keyValueTable],
  ['vendors', vendorsTable],
  ['wifi_security_mappings', wifiSecurityMappingsTable],
  ['wifi_security_config', wifiSecurityConfigTable],
  ['mapping_nodes', mappingNodesTable],
  ['mapping_edges', mappingEdgesTable],
  ['map_settings', mapSettingsTable],
  ['customer_accounts', customerAccountsTable],
  ['device_profiles', deviceProfilesTable],
  ['sgp_links', sgpLinksTable],
  ['customer_wifi_credentials', customerWifiCredentialsTable]
];

/**
 * Every table the schema owns, in creation order — which is also the order the
 * foreign keys require, so it is safe to insert along and to delete against.
 *
 * Derived from the lists above rather than written out again: anything that
 * needs to know the full set (copying a panel to another database, asserting
 * coverage in a test) reads this, so adding a table cannot leave a second list
 * quietly behind.
 */
export const SCHEMA_TABLES = [
  ...TENANCY_TABLES,
  ...INITIAL_TABLES,
  ...MEMBERSHIP_TABLES,
  ...SUBSCRIPTION_TABLES,
  ...PROVISIONING_TABLES,
  ...WHATSAPP_TABLES,
  ...DEVICE_HISTORY_TABLES,
  ...DEVICE_SWAP_TABLES
].map(([name]) => name);

/**
 * The columns that identify a subscriber account. Each is unique across the
 * whole table today; each has to become unique per provider instead.
 *
 * `identity_hash` is the one that matters most: it is
 * sha256(softwareId, pppoe_username), so two providers running the same
 * firmware with a subscriber of the same name produce the same value. Left
 * globally unique, the second provider's device sync would find the first
 * provider's account and re-point it — which is the correct behaviour for an
 * ONT swap inside one provider, and account theft across two.
 */
const CUSTOMER_ACCOUNT_IDENTITY_COLUMNS = ['customer_id', 'device_id', 'identity_hash'];

async function createTableIfMissing(db, name, builder) {
  if (await db.schema.hasTable(name)) return;
  await db.schema.createTable(name, builder);
}

async function missingColumns(db, table, columns) {
  const missing = [];
  for (const [column, add] of columns) {
    if (!(await db.schema.hasColumn(table, column))) missing.push(add);
  }
  return missing;
}

/**
 * The columns the health read filters and orders by, and the ones an install
 * older than that read has no index for.
 */
const WA_CONVERSATION_HEALTH_INDEXES = ['last_inbound_at', 'closed_at', 'unread_count'];

/** The ordered list. Ids are stable and are never renumbered or reused. */
export const migrations = [
  {
    id: '0001_initial_schema',
    async isApplied(db) {
      for (const [name] of INITIAL_TABLES) {
        if (!(await db.schema.hasTable(name))) return false;
      }
      return true;
    },
    async up(db) {
      for (const [name, table] of INITIAL_TABLES) {
        await createTableIfMissing(db, name, table(db));
      }
    }
  },
  {
    // Installations from before refresh-token invalidation existed.
    id: '0002_users_token_version',
    async isApplied(db) {
      return db.schema.hasColumn('users', 'token_version');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      if (await db.schema.hasColumn('users', 'token_version')) return;
      await db.schema.alterTable('users', addTokenVersion);
    }
  },
  {
    // Installations from before the customer portal had its own passwords.
    id: '0003_customer_portal_passwords',
    async isApplied(db) {
      if (!(await db.schema.hasTable('customer_accounts'))) return false;
      const missing = await missingColumns(db, 'customer_accounts', CUSTOMER_PASSWORD_COLUMNS);
      return missing.length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('customer_accounts'))) return;
      const missing = await missingColumns(db, 'customer_accounts', CUSTOMER_PASSWORD_COLUMNS);
      if (missing.length === 0) return;
      await db.schema.alterTable('customer_accounts', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    // Installations from before the SGP integration.
    id: '0004_sgp_links',
    async isApplied(db) {
      return db.schema.hasTable('sgp_links');
    },
    async up(db) {
      await createTableIfMissing(db, 'sgp_links', sgpLinksTable(db));
    }
  },
  {
    // Installations whose sgp_links predates the derived contract state.
    id: '0005_sgp_link_state',
    async isApplied(db) {
      if (!(await db.schema.hasTable('sgp_links'))) return false;
      return db.schema.hasColumn('sgp_links', 'state');
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_links'))) return;
      if (await db.schema.hasColumn('sgp_links', 'state')) return;
      await db.schema.alterTable('sgp_links', (t) => {
        t.string('state', 16).notNullable().defaultTo('unknown');
      });
    }
  },
  {
    // Automatic activation and SGP event handling.
    id: '0006_provisioning_and_sgp_events',
    async isApplied(db) {
      for (const [name] of PROVISIONING_TABLES) {
        if (!(await db.schema.hasTable(name))) return false;
      }
      return true;
    },
    async up(db) {
      for (const [name, table] of PROVISIONING_TABLES) {
        await createTableIfMissing(db, name, table(db));
      }
    }
  }
,
  {
    // The WhatsApp integration through the Evolution API.
    id: '0007_whatsapp_tables',
    async isApplied(db) {
      for (const [name] of WHATSAPP_TABLES) {
        if (!(await db.schema.hasTable(name))) return false;
      }
      return true;
    },
    async up(db) {
      for (const [name, table] of WHATSAPP_TABLES) {
        await createTableIfMissing(db, name, table(db));
      }
    }
  },
  {
    // Installations whose sgp_links predates WhatsApp needing a phone number.
    id: '0008_sgp_link_phone',
    async isApplied(db) {
      if (!(await db.schema.hasTable('sgp_links'))) return false;
      const missing = await missingColumns(db, 'sgp_links', SGP_PHONE_COLUMNS);
      return missing.length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_links'))) return;
      const missing = await missingColumns(db, 'sgp_links', SGP_PHONE_COLUMNS);
      if (missing.length === 0) return;
      await db.schema.alterTable('sgp_links', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    // Lets JWT_SECRET be rotated without destroying the secrets it encrypted.
    id: '0009_secret_key_version',
    async isApplied(db) {
      for (const [table, names] of SECRET_KEY_VERSION_COLUMNS) {
        if (!(await db.schema.hasTable(table))) return false;
        const missing = await missingColumns(db, table, keyVersionColumns(names));
        if (missing.length > 0) return false;
      }
      return true;
    },
    async up(db) {
      for (const [table, names] of SECRET_KEY_VERSION_COLUMNS) {
        if (!(await db.schema.hasTable(table))) continue;
        const missing = await missingColumns(db, table, keyVersionColumns(names));
        if (missing.length === 0) continue;
        await db.schema.alterTable(table, (t) => {
          for (const add of missing) add(t);
        });
      }
    }
  },
  {
    // The first table to become per-provider, and the one that cannot wait:
    // its identity columns are unique across the whole table, so a second
    // provider's device sync would collide with — and re-point — the first
    // provider's accounts.
    id: '0010_customer_accounts_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      return db.schema.hasColumn('customer_accounts', 'tenant_id');
    },
    async up(db) {
      for (const [name, table] of TENANCY_TABLES) {
        await createTableIfMissing(db, name, table(db));
      }

      // The install itself becomes provider #1, under the name already on
      // screen, so nothing looks different to an operator.
      let tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) {
        const appName = await db('settings').where({ key: 'appName' }).first();
        await db('tenants').insert({
          slug: 'default',
          name: appName?.value || 'SkyGenPanel',
          status: 'active'
        });
        tenant = await db('tenants').orderBy('id', 'asc').first();
      }

      if (await db.schema.hasColumn('customer_accounts', 'tenant_id')) return;

      // Nullable first: the table already has rows, and the schema alone has
      // no sensible default to give them.
      await db.schema.alterTable('customer_accounts', (t) => {
        t.integer('tenant_id').unsigned();
      });
      await db('customer_accounts').whereNull('tenant_id').update({ tenant_id: tenant.id });

      // One rebuild on SQLite rather than several: tighten the column, point it
      // at tenants, and move every identity unique to be per-provider.
      //
      // The default is this install's own provider, baked in from the row just
      // created rather than hardcoded. Until requests carry a tenant, every
      // write belongs to it, so existing code keeps inserting correct rows
      // without knowing tenancy exists. The scoping work that follows sets the
      // column explicitly on every insert and can then drop the default.
      await db.schema.alterTable('customer_accounts', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        for (const column of CUSTOMER_ACCOUNT_IDENTITY_COLUMNS) {
          t.dropUnique([column]);
          t.unique(['tenant_id', column]);
        }
      });
    }
  },
  {
    // The tables whose models delete or update without a where clause: the map
    // is replaced wholesale on every import, and setting a default WhatsApp
    // number clears every other row first. Those are correct for one provider
    // and destructive for a second, so they are scoped before anything that
    // only reads.
    id: '0011_mapping_and_whatsapp_tenant',
    async isApplied(db) {
      for (const table of ['mapping_nodes', 'mapping_edges', 'whatsapp_accounts']) {
        if (!(await db.schema.hasTable(table))) return false;
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      // Before anything else. Rebuilding `mapping_nodes` to move its unique
      // would otherwise leave these references pointing at a key that no longer
      // exists, and SQLite's foreign_key_check fails the rebuild on the spot.
      if (await db.schema.hasColumn('mapping_edges', 'source')) {
        await db.schema.alterTable('mapping_edges', (t) => {
          t.dropForeign(['source']);
          t.dropForeign(['target']);
        });
      }

      for (const table of ['mapping_nodes', 'mapping_edges', 'whatsapp_accounts']) {
        if (await db.schema.hasColumn(table, 'tenant_id')) continue;
        await db.schema.alterTable(table, (t) => t.integer('tenant_id').unsigned());
        await db(table).whereNull('tenant_id').update({ tenant_id: tenant.id });
      }

      await db.schema.alterTable('mapping_nodes', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        t.dropUnique(['node_id']);
        t.unique(['tenant_id', 'node_id']);
      });

      await db.schema.alterTable('mapping_edges', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.dropUnique(['edge_id']);
        t.unique(['tenant_id', 'edge_id']);
        // Composite rather than an integer key, because the API and the map
        // editor address nodes by their string id. It also buys a guarantee the
        // old shape could not give: an edge can only reach a node of its own
        // provider.
        t.foreign(['tenant_id', 'source'])
          .references(['tenant_id', 'node_id']).inTable('mapping_nodes').onDelete('CASCADE');
        t.foreign(['tenant_id', 'target'])
          .references(['tenant_id', 'node_id']).inTable('mapping_nodes').onDelete('CASCADE');
      });

      await db.schema.alterTable('whatsapp_accounts', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        // `name` deliberately keeps its global unique. The Evolution webhook
        // arrives with no session and finds the account — and therefore the
        // provider — by that name, so it has to identify a row on its own. It
        // is minted locally and already unique by construction.
      });
    }
  },
  {
    // The WhatsApp inbox and its send queue. Scoping these is what releases the
    // outbox worker from `forSoleTenant`: once `WaMessage.listSendable()`
    // carries a provider, a pass per provider divides the queue instead of
    // sending every message once per provider.
    id: '0012_wa_queue_tenant',
    async isApplied(db) {
      for (const table of ['wa_conversations', 'wa_messages', 'wa_opt_outs']) {
        if (!(await db.schema.hasTable(table))) return false;
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      for (const table of ['wa_conversations', 'wa_messages', 'wa_opt_outs']) {
        if (await db.schema.hasColumn(table, 'tenant_id')) continue;
        await db.schema.alterTable(table, (t) => t.integer('tenant_id').unsigned());
        await db(table).whereNull('tenant_id').update({ tenant_id: tenant.id });
      }

      for (const table of ['wa_conversations', 'wa_opt_outs']) {
        await db.schema.alterTable(table, (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.foreign('tenant_id').references('id').inTable('tenants');
        });
      }

      await db.schema.alterTable('wa_messages', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        // The id is minted by the Evolution server, so it is unique only within
        // one of them. Two providers run their own, and a collision on a global
        // unique would not raise an error a human sees — the inbound dedupe
        // would treat the second provider's message as one already stored and
        // drop it. Repeated NULLs still do not collide: an outbound message has
        // no id until the server accepts it.
        t.dropUnique(['external_id']);
        t.unique(['tenant_id', 'external_id']);
      });

      // `wa_conversations.unique(account_id, external_thread_id)` is left as it
      // is, deliberately. `account_id` points at `whatsapp_accounts`, which is
      // already per-provider, so that unique cannot span two providers. Adding
      // `tenant_id` to it would be churn dressed as a rule.
      //
      // The foreign keys stay integer for the same kind of reason. Unlike
      // `mapping_edges`, whose `source` was a string that stopped being unique
      // once the plant became per-provider, these point at `id` columns that
      // remain globally unique. A cross-provider link would take a bug in a
      // scoped model, not a missing constraint.
    }
  },
  {
    // Campaigns, their templates, and the alert cooldown. Scoping these
    // releases the campaign flush from `forSoleTenant`, and fixes a cooldown
    // that was shared across the whole deployment.
    id: '0013_wa_campaigns_tenant',
    async isApplied(db) {
      for (const table of TENANT_CAMPAIGN_TABLES) {
        if (!(await db.schema.hasTable(table))) return false;
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      for (const table of TENANT_CAMPAIGN_TABLES) {
        if (await db.schema.hasColumn(table, 'tenant_id')) continue;
        await db.schema.alterTable(table, (t) => t.integer('tenant_id').unsigned());
        await db(table).whereNull('tenant_id').update({ tenant_id: tenant.id });
      }

      for (const table of ['wa_broadcasts', 'wa_broadcast_recipients']) {
        await db.schema.alterTable(table, (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.foreign('tenant_id').references('id').inTable('tenants');
        });
      }

      await db.schema.alterTable('wa_templates', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        // A template is the provider's own wording — its dunning message, in
        // its voice. Two providers naming one "segunda-via" is expected, not a
        // conflict.
        t.dropUnique(['name']);
        t.unique(['tenant_id', 'name']);
      });

      await db.schema.alterTable('wa_alert_state', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        // `subject` is a device or node id read from GenieACS, and the row
        // carries the cooldown. Shared, one provider's ONT going down silenced
        // the same rule for every other provider — and `clear` on one closed
        // everyone's alert. The cooldown is per provider because the ONT is.
        t.dropUnique(['rule', 'subject']);
        t.unique(['tenant_id', 'rule', 'subject']);
      });
    }
  },
  {
    // Tells the three automatic senders apart. All of them write `sent_by:
    // NULL`, so a billing campaign's message and the bot's own reply looked
    // identical — and the bot's three-an-hour ceiling counted the campaign
    // against itself, going silent on a subscriber it had never answered.
    id: '0014_wa_message_source',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return false;
      const missing = await missingColumns(db, 'wa_messages', WA_MESSAGE_SOURCE_COLUMNS);
      return missing.length === 0;
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return;
      const missing = await missingColumns(db, 'wa_messages', WA_MESSAGE_SOURCE_COLUMNS);
      if (missing.length === 0) return;
      await db.schema.alterTable('wa_messages', (t) => {
        for (const add of missing) add(t);
      });
    }
  },
  {
    // The configuration pair. `settings` holds what an operator sets on screen —
    // the GenieACS URL, the Customer ID scheme, the VirtualParameter names —
    // and `app_state` holds the integration blobs: Evolution, SGP, alerts,
    // provisioning, and the dashboard snapshot. All of it is one set for the
    // whole deployment until this runs.
    //
    // Both tables come from `keyValueTable`, where `key` is the PRIMARY KEY
    // rather than a unique. This is the only step in the phase that moves a
    // primary key.
    id: '0015_settings_and_app_state_tenant',
    async isApplied(db) {
      for (const table of KEY_VALUE_TABLES) {
        if (!(await db.schema.hasTable(table))) return false;
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      for (const table of KEY_VALUE_TABLES) {
        if (await db.schema.hasColumn(table, 'tenant_id')) continue;
        await db.schema.alterTable(table, (t) => t.integer('tenant_id').unsigned());
        await db(table).whereNull('tenant_id').update({ tenant_id: tenant.id });
      }

      for (const table of KEY_VALUE_TABLES) {
        await db.schema.alterTable(table, (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.dropPrimary();
          t.primary(['tenant_id', 'key']);
          t.foreign('tenant_id').references('id').inTable('tenants');
          // Do NOT add `t.string('key', 128).notNullable().alter()` here. It
          // reads as tidying and it breaks PostgreSQL: knex's alter path emits
          // `drop not null` unconditionally before the retype, and Postgres
          // refuses that on a column still in a primary key. knex also fixes
          // the order — every column alteration is emitted before every table
          // statement — so moving `dropPrimary()` above it does not help; it
          // would need its own earlier `alterTable` call. And it buys nothing:
          // `key` is already NOT NULL on Postgres and MySQL by virtue of
          // having been the primary key.
        });
      }

      // After this step `settings.key` and `app_state.key` are no longer unique
      // on their own, so no table may ever declare a foreign key against them.
      // That is what failed the rebuild in 0011: knex appends a bare
      // `PRAGMA foreign_key_check` with no table argument, so it checks the
      // whole database and a dangling reference anywhere fails the migration.
      // Nothing references either key today.
    }
  },
  {
    // The indexes the health read wants. It changes no column and moves no
    // data, which is why it sits apart from the tenancy steps around it: an
    // index is the one schema change that can be added to a live table without
    // anyone noticing.
    //
    // No `isApplied`. That hook exists to baseline an install older than this
    // runner, and answering "yes, present" there would be a guess — the three
    // engines keep index metadata in three different places and knex has no
    // portable way to ask. `up` is idempotent instead: each index is attempted
    // on its own and a duplicate is swallowed, so this costs a no-op on the
    // installs that already have them.
    id: '0016_wa_conversation_health_indexes',
    async up(db) {
      if (!(await db.schema.hasTable('wa_conversations'))) return;
      for (const column of WA_CONVERSATION_HEALTH_INDEXES) {
        // eslint-disable-next-line no-await-in-loop -- DDL, and three of them
        await db.schema.alterTable('wa_conversations', (t) => t.index([column])).catch(() => {});
      }
    }
  },
  {
    // Per-device telemetry over time.
    //
    // Tenant-ready at the end state the earlier steps are working towards
    // rather than the transitional one they had to use. Those tables already
    // had rows and unconverted writers, so their `tenant_id` carries a default
    // to keep those writers correct. These two have neither: every write goes
    // through `tinsert`/`tbatchInsert` from the first commit, so the column is
    // NOT NULL with no default. A default here would be a mechanism for filing
    // one provider's samples under another, quietly.
    id: '0017_device_history',
    async isApplied(db) {
      for (const [name] of DEVICE_HISTORY_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- two schema probes
        if (!(await db.schema.hasTable(name))) return false;
      }
      return true;
    },
    async up(db) {
      for (const [name, table] of DEVICE_HISTORY_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- DDL, and two of them
        await createTableIfMissing(db, name, table(db));
      }
    }
  },
  {
    // A record of one ONT replacing another for the same subscriber.
    //
    // Its own table rather than an `sgp_events` row, and the deciding reason is
    // that a CPE swap happens on installs with no SGP configured at all.
    // `sgp_events` is also an ingest queue whose rows exist to be acted on and
    // are pruned on an SGP retention setting, and a swap is a fact that already
    // happened.
    id: '0018_device_swaps',
    async isApplied(db) {
      return db.schema.hasTable('device_swaps');
    },
    async up(db) {
      await createTableIfMissing(db, 'device_swaps', deviceSwapsTable(db));
    }
  },
  {
    /**
     * The contract cadastre, per provider.
     *
     * `sgp_links` is what turns a device id into a subscriber: contract,
     * document, name, plan, and the phone number the WhatsApp side resolves an
     * inbound message against. Left deployment-wide it is the last place where
     * one provider's operator can type a phone number and be handed another
     * provider's subscriber — and, through the self-service bot, be read that
     * subscriber's invoice without anyone having logged in anywhere.
     *
     * `device_id` was unique across the deployment, which was right while there
     * was one GenieACS behind one panel. It becomes unique per provider here,
     * for the same reason `customer_accounts` did in 0010: two providers
     * reading one ACS see the same ids, and a deployment-wide unique would let
     * whichever synced first own the row for good.
     *
     * The column is added here rather than in `sgpLinksTable` on purpose. That
     * factory runs in step 0001, before `tenants` exists, so a foreign key
     * written into it would fail every fresh install. `customer_accounts`
     * carries its `tenant_id` the same way and for the same reason.
     */
    id: '0019_sgp_links_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      if (!(await db.schema.hasTable('sgp_links'))) return false;
      return db.schema.hasColumn('sgp_links', 'tenant_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_links'))) return;
      if (await db.schema.hasColumn('sgp_links', 'tenant_id')) return;

      // 0010 created the provider row; this only reads it. If it is somehow
      // missing there is nothing to backfill to, and the step stops rather than
      // inventing a second provider nobody asked for.
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      // Nullable first: the table already has rows and the schema alone has no
      // sensible default to give them.
      await db.schema.alterTable('sgp_links', (t) => {
        t.integer('tenant_id').unsigned();
      });
      await db('sgp_links').whereNull('tenant_id').update({ tenant_id: tenant.id });

      // One rebuild on SQLite rather than several: tighten the column, point it
      // at `tenants`, and move the device unique to be per-provider. The
      // default is this install's own provider, so every insert written before
      // the scoping work lands still produces a correct row.
      await db.schema.alterTable('sgp_links', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        t.dropUnique(['device_id']);
        t.unique(['tenant_id', 'device_id']);
      });
    }
  },
  {
    /**
     * What the outbox needs to survive an Evolution server that blinks, and
     * what the two sweeps and the thread reader need to stay fast on the
     * installation they were written for.
     *
     * `next_attempt_at` is the important one. Without it a failed send goes
     * straight back to `queued` and the worker, which wakes every five seconds,
     * picks it up again immediately: three attempts burn in fifteen seconds and
     * the row is `failed` for good. An Evolution restart that takes twenty
     * seconds therefore fails every message in the queue permanently — during a
     * dunning campaign, thousands of them. `provisioning_runs` already carries
     * this column and its due index; this is the same pattern, in the place
     * that needed it more.
     *
     * The three indexes are queries that already exist and have no index that
     * fits them:
     *
     * - `(conversation_id, id)` — the thread reader pages by `id` (keyset,
     *   since the attachments wave) while the only index orders by
     *   `created_at`, so opening a busy thread filters by index and then sorts.
     * - `(tenant_id, created_at)` — the history sweep reads a provider's oldest
     *   rows. The existing `(delivery_status, created_at)` cannot serve it: the
     *   sweep's test on that column is `IS NULL OR NOT IN (...)`, which no
     *   engine seeks on.
     * - `(delivery_status, next_attempt_at)` — the outbox's own query, once it
     *   has a due time to respect.
     *
     * Indexes are attempted one at a time and a duplicate is swallowed, like
     * 0016: there is no portable way to ask whether an index exists, and
     * guessing would be dishonest.
     */
    id: '0020_wa_outbox_backoff_and_indexes',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return false;
      return db.schema.hasColumn('wa_messages', 'next_attempt_at');
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_messages'))) return;

      if (!(await db.schema.hasColumn('wa_messages', 'next_attempt_at'))) {
        await db.schema.alterTable('wa_messages', (t) => {
          // Nullable, and NULL means "due now". Rows written before this
          // column existed are due, which is the only reading that does not
          // strand a queue on upgrade.
          t.timestamp('next_attempt_at');
        });
      }

      for (const columns of WA_MESSAGE_OUTBOX_INDEXES) {
        // eslint-disable-next-line no-await-in-loop -- DDL, and three of them
        await db.schema.alterTable('wa_messages', (t) => t.index(columns)).catch(() => {});
      }
    }
  },
  {
    /**
     * The campaign queue, given the same patience the outbox got in 0020.
     *
     * `waBroadcastService.deliver` has the same shape of bug 0020 fixed one
     * table over: `MAX_ATTEMPTS` is 3, a failed recipient goes straight back to
     * 'pending', and the flush loop wakes every 60 s — so three attempts burn
     * in about two minutes and the row is 'failed' for good.
     *
     * The failure it actually meets is NOT an Evolution server that is down.
     * `deliver` only ENQUEUES: it writes a row to `wa_messages` and the outbox
     * owns the transport, so a server restart is 0018's problem and is already
     * survived. What reaches this catch is `no_account` — no number connected —
     * a `no_public_url`, or a database that hiccupped. Those are configuration
     * and infrastructure, which is precisely the kind of thing an operator
     * fixes in the ten minutes after starting a campaign and noticing.
     *
     * Two minutes is not enough time for that, and the cost of running out is
     * the whole campaign: every recipient in flight ends `failed`, and the
     * operator's only recovery is the bulk requeue on the messages that were
     * never created.
     *
     * Nullable, and NULL means due now, exactly as in 0020: every row written
     * before this column existed is due, which is the only reading that does
     * not strand a campaign that was already in flight during the upgrade.
     *
     * The index fronts `broadcast_id` because that is how `listPendingIds`
     * asks — one campaign at a time, never the table.
     */
    id: '0021_wa_broadcast_recipient_backoff',
    async isApplied(db) {
      if (!(await db.schema.hasTable('wa_broadcast_recipients'))) return false;
      return db.schema.hasColumn('wa_broadcast_recipients', 'next_attempt_at');
    },
    async up(db) {
      if (!(await db.schema.hasTable('wa_broadcast_recipients'))) return;

      if (!(await db.schema.hasColumn('wa_broadcast_recipients', 'next_attempt_at'))) {
        await db.schema.alterTable('wa_broadcast_recipients', (t) => {
          t.timestamp('next_attempt_at');
        });
      }

      await db.schema
        .alterTable('wa_broadcast_recipients', (t) => t.index(['broadcast_id', 'status', 'next_attempt_at']))
        .catch(() => {});
    }
  },
  {
    /**
     * The installation dates, per provider — and the one table standing between
     * the Customer ID sweep and a per-provider loop.
     *
     * `server.js` runs that sweep under `forSoleTenant`, and its comment names
     * two blockers. One of them, `sgp_links`, stopped being true in 0019. This
     * is the other: `CustomerService.ensureAccount` reads
     * `DeviceProfile.getByDeviceId` when the Customer ID is derived from an
     * installation date, and that read was deployment-wide — so with two
     * providers it could mint provider B's identifier out of provider A's date.
     *
     * `device_id` UNIQUE is the same failure `sgp_links` had before 0019: two
     * providers reading their own GenieACS see the same ids, and the write path
     * decides insert-vs-update from that read, so the second provider would
     * never get a row of its own — it would keep overwriting the first's.
     */
    id: '0022_device_profiles_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      if (!(await db.schema.hasTable('device_profiles'))) return false;
      return db.schema.hasColumn('device_profiles', 'tenant_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('device_profiles'))) return;
      if (await db.schema.hasColumn('device_profiles', 'tenant_id')) return;
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      await db.schema.alterTable('device_profiles', (t) => t.integer('tenant_id').unsigned());
      await db('device_profiles').whereNull('tenant_id').update({ tenant_id: tenant.id });
      await db.schema.alterTable('device_profiles', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        t.dropUnique(['device_id']);
        t.unique(['tenant_id', 'device_id']);
      });
    }
  },
  {
    /**
     * Provisioning, per provider — the profiles and the runs together.
     *
     * They move in one step because `provisioning_runs.profile_id` points at
     * `provisioning_profiles.id`: converting one alone would leave a foreign
     * key that can reach across providers, which is the shape of leak the
     * `mapping_edges` work in 0011 went out of its way to avoid.
     *
     * The profiles hold two AES-GCM secrets (the WiFi and CPE passwords an
     * activation writes), and their `name` is UNIQUE deployment-wide — two ISPs
     * both calling a profile "Padrão" is the expected case, not the exotic one.
     *
     * The runs are the sharper half. `ProvisioningRun.reapInterrupted` and
     * `pruneOlderThan` carry NO identity column in their WHERE at all: the
     * first fails every 'running' row older than a cutoff, the second deletes
     * every settled row older than one. Run per provider as they are, each pass
     * would do that to every other provider's history — which is why
     * `schedulerService` still refuses to loop.
     *
     * Both indexes are re-fronted with `tenant_id`: a scoped query always
     * carries it, so an index that does not lead with it is an index the
     * planner has to look past.
     */
    id: '0023_provisioning_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      for (const table of ['provisioning_profiles', 'provisioning_runs']) {
        // eslint-disable-next-line no-await-in-loop -- two schema probes
        if (!(await db.schema.hasTable(table))) return false;
        // eslint-disable-next-line no-await-in-loop -- two schema probes
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      if (await db.schema.hasTable('provisioning_profiles')
        && !(await db.schema.hasColumn('provisioning_profiles', 'tenant_id'))) {
        await db.schema.alterTable('provisioning_profiles', (t) => t.integer('tenant_id').unsigned());
        await db('provisioning_profiles').whereNull('tenant_id').update({ tenant_id: tenant.id });
        await db.schema.alterTable('provisioning_profiles', (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.foreign('tenant_id').references('id').inTable('tenants');
          t.dropUnique(['name']);
          t.unique(['tenant_id', 'name']);
        });
      }

      if (await db.schema.hasTable('provisioning_runs')
        && !(await db.schema.hasColumn('provisioning_runs', 'tenant_id'))) {
        await db.schema.alterTable('provisioning_runs', (t) => t.integer('tenant_id').unsigned());
        await db('provisioning_runs').whereNull('tenant_id').update({ tenant_id: tenant.id });
        await db.schema.alterTable('provisioning_runs', (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.foreign('tenant_id').references('id').inTable('tenants');
        });
        for (const [columns, name] of PROVISIONING_RUN_TENANT_INDEXES) {
          // eslint-disable-next-line no-await-in-loop -- DDL, and two of them
          await db.schema.alterTable('provisioning_runs', (t) => t.index(columns, name)).catch(() => {});
        }
      }
    }
  },
  {
    /**
     * The ERP event log, per provider — and the silent-drop it was hiding.
     *
     * `sgp_events` is the PII-heaviest table the panel has: contract, document
     * (CPF/CNPJ), login, device id and a redacted payload, one row per webhook
     * or reconciliation event from one ISP's SGP.
     *
     * `dedupe_key` UNIQUE deployment-wide is worse than a collision error.
     * `sgpEventService` builds it as `webhook:sha256(eventId)`, and SGP event
     * ids are per-ERP sequential numbers — so provider B's event #12345 hashes
     * to exactly what provider A's did. `SgpEvent.insertIfNew` reads that as a
     * redelivery and answers 200 duplicate: the second provider's event
     * disappears, with no error anywhere and nothing to notice.
     *
     * `pruneOlderThan` is the destructive one, with no identity column in its
     * WHERE — it deletes every provider's settled history.
     *
     * NOTE, and it is not fixed by this column: the webhook that feeds this
     * table is unauthenticated and mounted under the resolver, which always
     * answers with the FIRST provider, so the HMAC can only ever be checked
     * against provider #1's secret. Scoping the table without giving the
     * request a way to name its provider moves the failure rather than ending
     * it. That is the code half of this slice, not the schema half.
     */
    id: '0024_sgp_events_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      if (!(await db.schema.hasTable('sgp_events'))) return false;
      return db.schema.hasColumn('sgp_events', 'tenant_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('sgp_events'))) return;
      if (await db.schema.hasColumn('sgp_events', 'tenant_id')) return;
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      await db.schema.alterTable('sgp_events', (t) => t.integer('tenant_id').unsigned());
      await db('sgp_events').whereNull('tenant_id').update({ tenant_id: tenant.id });
      await db.schema.alterTable('sgp_events', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        t.dropUnique(['dedupe_key']);
        t.unique(['tenant_id', 'dedupe_key']);
      });
    }
  },
  {
    /**
     * The map, per provider. The only one of these that needs a PRIMARY KEY.
     *
     * `map_settings` is a singleton keyed `id: 1`, so `where({ id: 1 })` was
     * never an identity filter — it means "the only row". Provider B saving its
     * map centre overwrote provider A's, and `reset()` put the deployment's one
     * row back to defaults for everybody. There is nothing per-provider about
     * a latitude: it is literally where one ISP's city is.
     *
     * This is the `0015` shape, not the `0019` one: the key becomes
     * `(tenant_id, id)` so each provider keeps its own row 1, and `tdb` adds
     * the provider to the WHERE that the model already writes.
     *
     * Deliberately NOT retyping or re-declaring `id` while changing the key —
     * knex emits `drop not null` before a retype and Postgres refuses that on a
     * column still in a primary key. 0015 documents the same trap.
     */
    id: '0025_map_settings_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      if (!(await db.schema.hasTable('map_settings'))) return false;
      return db.schema.hasColumn('map_settings', 'tenant_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('map_settings'))) return;
      if (await db.schema.hasColumn('map_settings', 'tenant_id')) return;
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      await db.schema.alterTable('map_settings', (t) => t.integer('tenant_id').unsigned());
      await db('map_settings').whereNull('tenant_id').update({ tenant_id: tenant.id });
      await db.schema.alterTable('map_settings', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.dropPrimary();
        t.primary(['tenant_id', 'id']);
        t.foreign('tenant_id').references('id').inTable('tenants');
      });
    }
  },
  {
    /**
     * The equipment catalogue, per provider — the three tables together.
     *
     * The honest counter-argument first, because it is a good one: the CONTENT
     * really is the same for every ISP on earth. A ZTE's `wifi_password_path`
     * is a fact about firmware, not about anybody's subscribers. What makes
     * these per-provider is not the data, it is that the rows are OPERATOR-
     * EDITABLE: every path, priority and enabled flag is changed through
     * `/api/vendor-management`, so left shared, one ISP correcting a detection
     * pattern silently changes another ISP's WiFi writes. `Vendor.delete` also
     * cascades into `wifi_security_mappings`, so it is destructive across
     * providers as well as surprising.
     *
     * The project already made this call: the plan chooses a per-tenant
     * catalogue COPY over a `tenant_id NULL = global` row, precisely to keep
     * the invariant `tdb` depends on — every row of every scoped table carries
     * a provider, with no nulls to special-case.
     *
     * The three move together because `wifi_security_mappings.vendor_id` points
     * at `vendors.id`: converting one alone leaves a foreign key that can reach
     * across providers.
     *
     * NO new unique is added here. The plan wants `(tenant_id, name)` on
     * vendors and `(tenant_id, product_class)` on the config, and both would be
     * NEW constraints rather than conversions of existing ones — a migration
     * that can fail on data an install already has is a migration that strands
     * an upgrade halfway. They belong in their own step, after a pass that
     * reports duplicates.
     *
     * CONSEQUENCE, and it is not a schema one: nothing seeds `vendors`. A
     * provider created after this step starts with an empty catalogue, and an
     * empty catalogue does not fail loudly — device detection simply matches
     * nothing. The code half of this slice has to give a new provider a copy.
     */
    id: '0026_vendor_catalogue_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      for (const table of VENDOR_CATALOGUE_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- three schema probes
        if (!(await db.schema.hasTable(table))) return false;
        // eslint-disable-next-line no-await-in-loop -- three schema probes
        if (!(await db.schema.hasColumn(table, 'tenant_id'))) return false;
      }
      return true;
    },
    async up(db) {
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      for (const table of VENDOR_CATALOGUE_TABLES) {
        // eslint-disable-next-line no-await-in-loop -- DDL, three tables
        if (!(await db.schema.hasTable(table))) continue;
        // eslint-disable-next-line no-await-in-loop -- DDL, three tables
        if (await db.schema.hasColumn(table, 'tenant_id')) continue;
        // eslint-disable-next-line no-await-in-loop -- DDL, three tables
        await db.schema.alterTable(table, (t) => t.integer('tenant_id').unsigned());
        // eslint-disable-next-line no-await-in-loop -- DDL, three tables
        await db(table).whereNull('tenant_id').update({ tenant_id: tenant.id });
        // eslint-disable-next-line no-await-in-loop -- DDL, three tables
        await db.schema.alterTable(table, (t) => {
          t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
          t.foreign('tenant_id').references('id').inTable('tenants');
        });
      }
    }
  },
  {
    /**
     * The subscriber's WiFi credentials, per provider.
     *
     * There is no live leak here today, and it is worth saying why rather than
     * implying one: every method filters on `account_id`, a surrogate key into
     * `customer_accounts`, which has been scoped since 0010 — so the parent
     * already refuses to hand one provider another's account, and the portal
     * session carries the account it belongs to.
     *
     * The column is added anyway, for two reasons. The filter becomes direct
     * instead of inherited, which is what lets `tdb` cover the table like every
     * other; and the row holds an AES-GCM-encrypted WiFi password, which is the
     * kind of thing that should not depend on a join staying correct.
     *
     * The unique moves to `(tenant_id, account_id, wifi_index)`. Strictly it
     * need not — `account_id` is globally unique — but the `onConflict` in
     * `CustomerWifiCredential.upsert` names this exact tuple, and a conflict
     * target that does not match the index is the failure `sgp_links` hit in
     * 0019: silent on MySQL, refused on SQLite and Postgres.
     */
    id: '0027_customer_wifi_credentials_tenant',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      if (!(await db.schema.hasTable('customer_wifi_credentials'))) return false;
      return db.schema.hasColumn('customer_wifi_credentials', 'tenant_id');
    },
    async up(db) {
      if (!(await db.schema.hasTable('customer_wifi_credentials'))) return;
      if (await db.schema.hasColumn('customer_wifi_credentials', 'tenant_id')) return;
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      await db.schema.alterTable('customer_wifi_credentials', (t) => t.integer('tenant_id').unsigned());
      await db('customer_wifi_credentials').whereNull('tenant_id').update({ tenant_id: tenant.id });

      // Before the unique moves, and in a statement of its own so it is in
      // place when it does. `account_id` stops being the leading column of any
      // index once the unique becomes `(tenant_id, …)`, and that column carries
      // the cascade from `customer_accounts`: on MySQL InnoDB simply refuses to
      // drop the index its foreign key is resting on, and on Postgres it would
      // have accepted the drop and turned every cascading delete into a scan.
      await db.schema.alterTable('customer_wifi_credentials', (t) => {
        t.index(['account_id'], 'customer_wifi_credentials_account_idx');
      });

      await db.schema.alterTable('customer_wifi_credentials', (t) => {
        t.integer('tenant_id').unsigned().notNullable().defaultTo(tenant.id).alter();
        t.foreign('tenant_id').references('id').inTable('tenants');
        t.dropUnique(['account_id', 'wifi_index']);
        t.unique(['tenant_id', 'account_id', 'wifi_index']);
      });
    }
  },
  {
    /**
     * Who works for which provider — the last piece of the conversion, and the
     * one that deliberately does NOT follow the pattern of the ten before it.
     *
     * Every other table got a `tenant_id`. `users` must not. A row here is a
     * PERSON, and the plan is explicit about why that matters: a consultant or
     * a reseller serving several ISPs with one login is the common arrangement
     * in this market, and a `users.tenant_id` forecloses it permanently. So
     * `users` stays the identity table, globally unique on `username`, and
     * `tenant_users` is the bridge that says which providers a person works
     * for and with what role there.
     *
     * The role moves onto the membership rather than staying on the person: an
     * operator can be an admin at the ISP they own and an ordinary operator at
     * one they consult for. `users.role` is left in place and keeps its value,
     * because it is what the backfill reads and what an install running the
     * previous code still answers logins with — it stops being consulted once
     * the token carries a membership role.
     *
     * Note what is NOT here: the plan also wants `users` keyed by email rather
     * than username. That is a change to how every operator signs in, it buys
     * no isolation, and doing it in the same step as the authentication spine
     * would be two risky changes at once. It keeps its own step, later.
     */
    id: '0028_tenant_users',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenants'))) return false;
      return db.schema.hasTable('tenant_users');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      const tenant = await db('tenants').orderBy('id', 'asc').first();
      if (!tenant) return;

      await createTableIfMissing(db, 'tenant_users', tenantUsersTable(db));

      // Everybody who can already sign in keeps working, at the provider this
      // install has always been. Their current `users.role` becomes their role
      // there, so nobody is promoted or demoted by an upgrade.
      const existing = await db('users').select('id', 'role');
      const members = await db('tenant_users').where({ tenant_id: tenant.id }).pluck('user_id');
      const already = new Set(members.map(Number));
      const rows = existing
        .filter((user) => !already.has(Number(user.id)))
        .map((user) => ({
          tenant_id: tenant.id,
          user_id: user.id,
          role: user.role || 'user'
        }));
      if (rows.length > 0) await db('tenant_users').insert(rows);
    }
  },
  {
    /**
     * The control plane: who may create and suspend providers.
     *
     * Twelve steps of per-provider isolation went in before this, and none of
     * them could be used — nothing in the panel creates a second provider. The
     * gap was not an oversight about screens, it was a missing authority: a
     * provider's own administrator must NOT be able to mint providers or reach
     * into another one's, so "who may" needed a plane above them before "how"
     * could exist at all.
     *
     * The table is created EMPTY, and the migration grants nobody. A migration
     * that handed the platform to the lowest-numbered administrator would be an
     * upgrade quietly promoting somebody — and on the self-hosted edition,
     * where there is one provider and no platform plane, promoting them to a
     * role that should not exist there. Bootstrapping is explicit instead:
     * `setup` grants it on a fresh SaaS install, and `scripts/grant-platform-admin.js`
     * grants it on an install that already had users, run by whoever holds the
     * server — which is exactly who should be deciding this.
     */
    id: '0029_platform_admins',
    async isApplied(db) {
      return db.schema.hasTable('platform_admins');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      await createTableIfMissing(db, 'platform_admins', platformAdminsTable(db));
    }
  },
  {
    /**
     * Dá um `owner` a cada provedor: o administrador mais antigo dali.
     *
     * Os papéis passaram de dois (`admin`, `viewer`) para quatro (`owner`,
     * `admin`, `tech`, `viewer`). A coluna já é `string(32)` sem constraint, de
     * modo que os dois novos cabem sem tocar no schema — o que falta é ter
     * alguém no papel de cima, porque a única coisa que só o `owner` pode fazer
     * é promover e rebaixar outro `owner`, e sem nenhum `owner` essa porta fica
     * trancada por dentro em todo install que já existe.
     *
     * O mais antigo, e não "todos os admins": promover todo mundo faria de
     * `owner` outro nome para `admin` e apagaria a distinção no mesmo passo que
     * a cria. Quem tiver que ser promovido depois, um `owner` promove.
     *
     * Não tira capacidade de ninguém: `owner` e `admin` carregam exatamente as
     * mesmas capacidades (ver `config/permissions.js`), então a pessoa promovida
     * não ganha rota nenhuma que já não alcançasse, e as que ficaram `admin`
     * não perdem nenhuma.
     *
     * Sem `isApplied`: não há nada para baselinar. Um install anterior ao
     * runner não tem `tenant_users` — a tabela nasceu na 0028, que é do runner
     * — então "já estava assim" não é estado possível aqui.
     */
    id: '0030_tenant_owner_role',
    async up(db) {
      if (!(await db.schema.hasTable('tenant_users'))) return;

      const tenants = await db('tenant_users').distinct('tenant_id').pluck('tenant_id');
      for (const tenantId of tenants) {
        // Se já houver `owner` ali, a migração não tem o que fazer: ou já rodou,
        // ou alguém promovido depois já ocupa o papel, e nos dois casos escolher
        // outro seria desfazer uma decisão que não é desta migração.
        const existente = await db('tenant_users')
          .where({ tenant_id: tenantId, role: 'owner' })
          .first();
        if (existente) continue;

        const maisAntigo = await db('tenant_users')
          .where({ tenant_id: tenantId, role: 'admin' })
          .orderBy('id', 'asc')
          .first();
        // Provedor sem nenhum administrador fica sem `owner`, de propósito:
        // inventar um a partir de um `viewer` daria a alguém um poder que
        // ninguém lhe deu.
        if (!maisAntigo) continue;

        await db('tenant_users')
          .where({ id: maisAntigo.id })
          .update({ role: 'owner', updated_at: new Date() });
      }
    }
  },
  {
    /**
     * A tabela de convites. Criada aqui e não com as tabelas de tenancy porque
     * aponta para `users` — que o passo 0001 cria, muito depois de `tenants`.
     * Mesmo motivo de `tenant_users` e `platform_admins`.
     */
    id: '0031_tenant_invites',
    async isApplied(db) {
      return db.schema.hasTable('tenant_invites');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'tenant_invites', tenantInvitesTable(db));
    }
  },
  {
    /** A trilha. Mesmo motivo das duas acima para nascer aqui: aponta para `users`. */
    id: '0032_audit_log',
    async isApplied(db) {
      return db.schema.hasTable('audit_log');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      if (!(await db.schema.hasTable('tenants'))) return;
      await createTableIfMissing(db, 'audit_log', auditLogTable(db));
    }
  },
  {
    /** A trilha do plano de controle. Aponta para `users`, daí nascer aqui. */
    id: '0033_platform_audit',
    async isApplied(db) {
      return db.schema.hasTable('platform_audit');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      await createTableIfMissing(db, 'platform_audit', platformAuditTable(db));
    }
  },
  {
    /**
     * O e-mail de login, acrescentado NULO.
     *
     * Nulo e não preenchido a partir de nada: não há de onde tirar o endereço
     * de quem já usa o painel, e inventar um (`fulano@localhost`, o username
     * com um domínio colado) daria a cada conta existente um endereço que
     * ninguém controla — e que, no dia em que houver redefinição de senha por
     * e-mail, seria o caminho para dentro dela.
     *
     * Por isso a coluna é anulável e o login por nome continua valendo: a
     * transição é cada pessoa cadastrando o próprio endereço, e não uma
     * migração adivinhando por elas.
     */
    id: '0034_users_email',
    async isApplied(db) {
      return db.schema.hasColumn('users', 'email');
    },
    async up(db) {
      if (!(await db.schema.hasTable('users'))) return;
      if (await db.schema.hasColumn('users', 'email')) return;
      await db.schema.alterTable('users', (t) => {
        t.string('email', 255).unique();
      });
    }
  },
  {
    /**
     * O estado comercial de cada provedor.
     *
     * Nasce com uma linha `active` para todo provedor que JÁ existe, e não
     * `trial`: quem já está no ar é cliente, e acordar um deploy com todo mundo
     * em teste seria dar um prazo a quem já pagou — e, pior, um prazo que
     * vence.
     *
     * Provedor novo nasce em `trial`, e isso é decidido em `PlatformController`
     * e não aqui: a migration fala do que existe, o controller do que passa a
     * existir.
     */
    id: '0035_tenant_subscriptions',
    async isApplied(db) {
      return db.schema.hasTable('tenant_subscriptions');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenants'))) return;
      const nova = !(await db.schema.hasTable('tenant_subscriptions'));
      await createTableIfMissing(db, 'tenant_subscriptions', tenantSubscriptionsTable(db));
      if (!nova) return;
      const tenants = await db('tenants').select('id');
      if (!tenants.length) return;
      await db('tenant_subscriptions').insert(tenants.map(({ id }) => ({
        tenant_id: id,
        status: 'active',
        status_reason: 'Provedor existente no dia em que a assinatura passou a ser registrada',
        status_changed_at: new Date()
      })));
    }
  },
  {
    /**
     * O plano, acrescentado a uma tabela que pode já existir.
     *
     * A 0035 é recente, então na maioria das instalações a tabela nasce já com
     * estas colunas e este passo não faz nada. Ele existe para a minoria que
     * subiu entre as duas — e a ordem importa: `hasColumn` antes de `alterTable`
     * porque o SQLite reconstrói a tabela para acrescentar coluna, e reconstruir
     * à toa é o tipo de coisa que só dá errado com dado dentro.
     *
     * `unlimited` como padrão pelo mesmo motivo do backfill da 0035: aplicar um
     * teto retroativamente a quem já tem doze operadores não cobra nada de
     * ninguém — só impede o ISP de contratar o décimo terceiro, num dia em que
     * ele não mudou nada e não foi avisado.
     */
    id: '0036_tenant_subscription_plans',
    async isApplied(db) {
      if (!(await db.schema.hasTable('tenant_subscriptions'))) return false;
      return db.schema.hasColumn('tenant_subscriptions', 'plan_code');
    },
    async up(db) {
      if (!(await db.schema.hasTable('tenant_subscriptions'))) return;
      const faltando = [];
      if (!(await db.schema.hasColumn('tenant_subscriptions', 'plan_code'))) {
        faltando.push((t) => t.string('plan_code', 32).notNullable().defaultTo('unlimited'));
      }
      if (!(await db.schema.hasColumn('tenant_subscriptions', 'max_operators'))) {
        faltando.push((t) => t.integer('max_operators').unsigned());
      }
      if (!(await db.schema.hasColumn('tenant_subscriptions', 'max_subscriber_accounts'))) {
        faltando.push((t) => t.integer('max_subscriber_accounts').unsigned());
      }
      if (!faltando.length) return;
      await db.schema.alterTable('tenant_subscriptions', (t) => {
        for (const add of faltando) add(t);
      });
    }
  }
];

export default migrations;
