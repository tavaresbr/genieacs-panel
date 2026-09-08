import { getDb } from './database.js';

export async function ensureSchema(db = getDb()) {
  if (!(await db.schema.hasTable('users'))) {
    await db.schema.createTable('users', (t) => {
      t.increments('id').primary();
      t.string('username', 64).notNullable().unique();
      t.string('password', 255).notNullable();
      t.string('role', 32).notNullable().defaultTo('user');
      t.integer('token_version').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  } else if (!(await db.schema.hasColumn('users', 'token_version'))) {
    await db.schema.alterTable('users', (t) => {
      t.integer('token_version').notNullable().defaultTo(0);
    });
  }

  if (!(await db.schema.hasTable('settings'))) {
    await db.schema.createTable('settings', (t) => {
      t.string('key', 128).primary();
      t.text('value');
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('app_state'))) {
    await db.schema.createTable('app_state', (t) => {
      t.string('key', 128).primary();
      t.text('value');
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('vendors'))) {
    await db.schema.createTable('vendors', (t) => {
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
    });
  }

  if (!(await db.schema.hasTable('wifi_security_mappings'))) {
    await db.schema.createTable('wifi_security_mappings', (t) => {
      t.increments('id').primary();
      t.integer('vendor_id').notNullable().references('id').inTable('vendors').onDelete('CASCADE');
      t.string('raw_security_value', 128).notNullable();
      t.string('normalized_security', 128).notNullable();
      t.text('description');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('wifi_security_config'))) {
    await db.schema.createTable('wifi_security_config', (t) => {
      t.increments('id').primary();
      t.string('product_class', 128).notNullable();
      t.string('security_types', 255);
      t.string('password_param_path', 255);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('mapping_nodes'))) {
    await db.schema.createTable('mapping_nodes', (t) => {
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
    });
  }

  if (!(await db.schema.hasTable('mapping_edges'))) {
    await db.schema.createTable('mapping_edges', (t) => {
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
    });
  }

  if (!(await db.schema.hasTable('map_settings'))) {
    await db.schema.createTable('map_settings', (t) => {
      t.integer('id').primary();
      t.string('center_lat', 32).notNullable();
      t.string('center_lng', 32).notNullable();
      t.string('max_zoom_in', 8).notNullable();
      t.string('max_zoom_out', 8).notNullable();
      t.string('default_zoom', 8).notNullable();
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('customer_accounts'))) {
    await db.schema.createTable('customer_accounts', (t) => {
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
      t.string('password_hash', 255);
      t.text('password_ciphertext');
      t.string('password_iv', 32);
      t.string('password_tag', 32);
      t.timestamp('password_updated_at');
      t.timestamp('last_seen_at').defaultTo(db.fn.now());
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  } else {
    const customerPasswordColumns = [
      ['password_hash', (t) => t.string('password_hash', 255)],
      ['password_ciphertext', (t) => t.text('password_ciphertext')],
      ['password_iv', (t) => t.string('password_iv', 32)],
      ['password_tag', (t) => t.string('password_tag', 32)],
      ['password_updated_at', (t) => t.timestamp('password_updated_at')]
    ];
    const missing = [];
    for (const [column, add] of customerPasswordColumns) {
      if (!(await db.schema.hasColumn('customer_accounts', column))) missing.push(add);
    }
    if (missing.length > 0) {
      await db.schema.alterTable('customer_accounts', (t) => {
        for (const add of missing) add(t);
      });
    }
  }

  if (!(await db.schema.hasTable('device_profiles'))) {
    await db.schema.createTable('device_profiles', (t) => {
      t.increments('id').primary();
      t.string('device_id', 255).notNullable().unique();
      t.date('installation_date');
      t.string('installation_tag', 64);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('sgp_links'))) {
    await db.schema.createTable('sgp_links', (t) => {
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
      t.string('login', 255);
      t.string('link_mode', 16).notNullable().defaultTo('auto');
      // WhatsApp needs a number and the panel never had one. `phone_e164` is
      // what SGP returned on the last sync; `phone_manual` is what an operator
      // typed and always wins, because the ERP cadastre is often stale and the
      // operator is the one holding the correction.
      t.string('phone_e164', 24);
      t.string('phone_manual', 24);
      t.timestamp('last_synced_at').defaultTo(db.fn.now());
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  } else {
    const sgpPhoneColumns = [
      ['phone_e164', (t) => t.string('phone_e164', 24)],
      ['phone_manual', (t) => t.string('phone_manual', 24)]
    ];
    const missing = [];
    for (const [column, add] of sgpPhoneColumns) {
      if (!(await db.schema.hasColumn('sgp_links', column))) missing.push(add);
    }
    if (missing.length > 0) {
      await db.schema.alterTable('sgp_links', (t) => {
        for (const add of missing) add(t);
      });
    }
  }

  if (!(await db.schema.hasTable('customer_wifi_credentials'))) {
    await db.schema.createTable('customer_wifi_credentials', (t) => {
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
    });
  }

  await ensureWhatsAppSchema(db);
}

/**
 * WhatsApp / Evolution API.
 *
 * Two constraints shape every table below and are easy to violate by habit:
 *
 * 1. The panel runs on SQLite *or* MySQL, so nothing here may use a partial
 *    index, a Postgres type, or an array column. Where the source system used
 *    `UNIQUE ... WHERE deleted IS NULL`, uniqueness is enforced in the model
 *    instead, and the comment says so.
 * 2. Secrets are stored with the shared secret box (AES-256-GCM keyed from
 *    JWT_SECRET under its own context), never in plaintext — same rule the SGP
 *    token already follows.
 */
async function ensureWhatsAppSchema(db) {
  if (!(await db.schema.hasTable('whatsapp_accounts'))) {
    await db.schema.createTable('whatsapp_accounts', (t) => {
      t.increments('id').primary();
      // The instance name on the Evolution server. The inbound webhook resolves
      // the account by this value, so it has to be unique.
      t.string('name', 128).notNullable().unique();
      t.string('label', 128);
      // Which kind of traffic this number carries. The sender routes on it and
      // falls back to the default account when no number claims the purpose.
      t.string('purpose', 32).notNullable().defaultTo('general');
      // 'go' | 'v2' — detected by probe, not configured by hand.
      t.string('flavor', 8).notNullable().defaultTo('v2');
      t.string('base_url', 255).notNullable();
      // The server-side UUID. Evolution GO deletes instances by id, not name,
      // so losing this means we can only log out and drop the local row.
      t.string('instance_id', 64);
      t.string('status', 16).notNullable().defaultTo('pending');
      t.text('qr_code');
      t.timestamp('qr_updated_at');
      t.string('phone_e164', 24);
      t.boolean('is_default').notNullable().defaultTo(false);
      t.timestamp('last_seen_at');
      t.text('last_error');
      // The instance token: sending messages and reading contacts as the
      // provider.
      t.text('token_ciphertext');
      t.string('token_iv', 32);
      t.string('token_tag', 32);
      // A DIFFERENT secret, deliberately: it travels in the webhook URL and is
      // stored on the Evolution server, so it shows up in logs on both ends.
      // Leaking it lets someone forge an inbound event; leaking the instance
      // token would let them send as the provider.
      t.text('webhook_token_ciphertext');
      t.string('webhook_token_iv', 32);
      t.string('webhook_token_tag', 32);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('wa_conversations'))) {
    await db.schema.createTable('wa_conversations', (t) => {
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
      // One thread per number per instance. A subscriber who writes to both the
      // billing and the support number gets two conversations, which is what an
      // operator expects to see.
      t.unique(['account_id', 'external_thread_id']);
      t.index(['wa_phone_e164']);
      t.index(['last_message_at']);
    });
  }

  if (!(await db.schema.hasTable('wa_messages'))) {
    await db.schema.createTable('wa_messages', (t) => {
      t.increments('id').primary();
      t.integer('conversation_id').unsigned().notNullable()
        .references('id').inTable('wa_conversations').onDelete('CASCADE');
      t.string('direction', 3).notNullable(); // 'in' | 'out'
      // The WhatsApp message id. Unique so a redelivered webhook cannot double
      // an inbound message, and so a receipt can find the outbound one. NULL
      // until an outbound message is actually accepted by the server, and
      // repeated NULLs do not collide in either engine.
      t.string('external_id', 128).unique();
      t.text('body');
      t.string('attachment_path', 255);
      t.string('attachment_type', 128);
      t.string('attachment_name', 255);
      // An internal note is written by an operator and never sent.
      t.boolean('is_note').notNullable().defaultTo(false);
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
    });
  }

  if (!(await db.schema.hasTable('wa_opt_outs'))) {
    await db.schema.createTable('wa_opt_outs', (t) => {
      t.increments('id').primary();
      // Keyed by phone and LID, NOT by customer: an opt-out has to survive a
      // record being merged, deleted, or re-created. Whoever asked to be left
      // alone asked as a phone number.
      t.string('wa_phone_e164', 24);
      t.string('wa_lid', 32);
      t.integer('conversation_id').unsigned()
        .references('id').inTable('wa_conversations').onDelete('SET NULL');
      t.string('origin', 16).notNullable().defaultTo('customer'); // customer | operator
      t.string('reason_text', 500);
      t.timestamp('created_at').defaultTo(db.fn.now());
      // Revocation is soft, so the history of who asked out and when survives.
      // Uniqueness of the *active* row is enforced in models/WaOptOut.js —
      // MySQL has no partial index, and a duplicate here is noise rather than a
      // safety failure (the dangerous direction is a MISSING opt-out).
      t.timestamp('revoked_at');
      t.integer('revoked_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
      t.index(['wa_phone_e164']);
      t.index(['wa_lid']);
    });
  }

  if (!(await db.schema.hasTable('wa_templates'))) {
    await db.schema.createTable('wa_templates', (t) => {
      t.increments('id').primary();
      t.string('name', 80).notNullable().unique();
      t.text('body').notNullable();
      // cobranca | alerta | suporte | geral. The dunning renderer only accepts
      // the variables it can fill; see utils/wa/waCobranca.js.
      t.string('category', 32).notNullable().defaultTo('geral');
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('wa_broadcasts'))) {
    await db.schema.createTable('wa_broadcasts', (t) => {
      t.increments('id').primary();
      t.string('title', 200).notNullable();
      t.integer('template_id').unsigned()
        .references('id').inTable('wa_templates').onDelete('SET NULL');
      t.text('body').notNullable();
      t.integer('account_id').unsigned()
        .references('id').inTable('whatsapp_accounts').onDelete('SET NULL');
      // A campaign is born as 'draft' on purpose. Messaging hundreds of people
      // must never be the side effect of a click on a listing screen: an
      // operator opens the campaign, reads it, and presses start.
      t.string('status', 16).notNullable().defaultTo('draft');
      t.timestamp('start_at');
      t.integer('rate_limit_per_min');
      t.integer('total_count').notNullable().defaultTo(0);
      t.integer('sent_count').notNullable().defaultTo(0);
      t.integer('failed_count').notNullable().defaultTo(0);
      t.integer('created_by').unsigned().references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await db.schema.hasTable('wa_broadcast_recipients'))) {
    await db.schema.createTable('wa_broadcast_recipients', (t) => {
      t.increments('id').primary();
      t.integer('broadcast_id').unsigned().notNullable()
        .references('id').inTable('wa_broadcasts').onDelete('CASCADE');
      t.string('phone_e164', 24).notNullable();
      t.string('contract', 64);
      t.string('client_name', 255);
      // Rendered once, when the campaign is built, so what an operator reviews
      // is exactly what goes out.
      t.text('rendered_body').notNullable();
      t.integer('message_id').unsigned()
        .references('id').inTable('wa_messages').onDelete('SET NULL');
      t.string('status', 16).notNullable().defaultTo('pending');
      t.string('error_msg', 500);
      t.integer('attempts').notNullable().defaultTo(0);
      t.timestamp('sent_at');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.index(['broadcast_id', 'status']);
    });
  }

  if (!(await db.schema.hasTable('wa_alert_state'))) {
    await db.schema.createTable('wa_alert_state', (t) => {
      t.increments('id').primary();
      // 'ont_offline', 'rx_power_low', 'temperature_high', 'mass_outage', …
      t.string('rule', 48).notNullable();
      // What the rule is about: a device id, or an ODP/OLT node id.
      t.string('subject', 255).notNullable();
      t.string('state', 16).notNullable().defaultTo('firing');
      t.timestamp('fired_at').defaultTo(db.fn.now());
      t.timestamp('cleared_at');
      // Cooldown lives here: an ONT that stays down must not produce a message
      // every scan.
      t.timestamp('last_notified_at');
      t.integer('notify_count').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
      t.unique(['rule', 'subject']);
    });
  }
}
