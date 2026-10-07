import ContactProfileService, { checkField } from './contactProfileService.js';
import ContactWhatsappImportService from './contactWhatsappImportService.js';
import { parseCsv } from './contactSheetService.js';
import { normalizarTelefoneBr, variantesTelefoneBr } from '../utils/wa/waDestino.js';

/** The most new clients one import creates: a phone book is not an ERP base. */
const MAX_CREATES = 5000;
/** How many new contacts the preview lists one by one; the counts cover all of them. */
const PREVIEW_ROWS = 200;

function headerKey(value) {
  return String(value ?? '').replace(/^﻿/, '').trim().toLowerCase();
}

/** Google writes several values of one field into one cell, joined by " ::: ". */
function values(cell) {
  return String(cell ?? '').split(':::').map((value) => value.trim()).filter(Boolean);
}

const isMobileLabel = (label) => /mobile|celular|cell|whatsapp|móvel|movel/i.test(String(label ?? ''));

/** `--05-14` (no year) or `1990-05-14` → the record's date text; anything else as written. */
function birthday(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const full = text.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;
  return text.slice(0, 32);
}

// ── CSV (Google and Outlook) ───────────────────────────────────────────────

function peopleFromCsv(text) {
  const [header, ...lines] = parseCsv(text);
  if (!header) return [];
  const index = new Map(header.map((name, position) => [headerKey(name), position]));
  const read = (cells, name) => {
    const position = index.get(name);
    return position === undefined ? '' : String(cells[position] ?? '').trim();
  };
  const numbered = (prefix) => [...index.keys()]
    .map((key) => key.match(new RegExp(`^${prefix} (\\d+) - (value|label|type)$`)))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((n, i, all) => all.indexOf(n) === i)
    .sort((a, b) => a - b);
  const phoneSlots = numbered('phone');
  const emailSlots = numbered('e-mail');
  const addressNumbers = [...index.keys()]
    .map((key) => key.match(/^address (\d+) - /))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((n, i, all) => all.indexOf(n) === i)
    .sort((a, b) => a - b);

  return lines.map((cells) => {
    const name = read(cells, 'name')
      || read(cells, 'file as')
      || [read(cells, 'first name') || read(cells, 'given name'),
        read(cells, 'middle name') || read(cells, 'additional name'),
        read(cells, 'last name') || read(cells, 'family name')].filter(Boolean).join(' ')
      || read(cells, 'nickname')
      || read(cells, 'organization name') || read(cells, 'organization 1 - name') || read(cells, 'company');

    const mobiles = [];
    const others = [];
    for (const slot of phoneSlots) {
      const label = read(cells, `phone ${slot} - label`) || read(cells, `phone ${slot} - type`);
      for (const value of values(read(cells, `phone ${slot} - value`))) {
        (isMobileLabel(label) ? mobiles : others).push(value);
      }
    }
    // Outlook's columns, one number each.
    for (const column of ['mobile phone', 'primary phone', 'home phone', 'business phone', 'other phone', 'home phone 2', 'business phone 2']) {
      for (const value of values(read(cells, column))) {
        (column === 'mobile phone' ? mobiles : others).push(value);
      }
    }

    const emails = [];
    for (const slot of emailSlots) emails.push(...values(read(cells, `e-mail ${slot} - value`)));
    for (const column of ['e-mail address', 'e-mail 2 address', 'e-mail 3 address']) emails.push(...values(read(cells, column)));

    const slot = addressNumbers[0];
    const address = slot === undefined ? null : {
      street: read(cells, `address ${slot} - street`) || values(read(cells, `address ${slot} - formatted`))[0] || '',
      city: read(cells, `address ${slot} - city`),
      state: read(cells, `address ${slot} - region`),
      zip: read(cells, `address ${slot} - postal code`),
      complement: read(cells, `address ${slot} - extended address`)
    };

    return {
      name,
      phones: [...mobiles, ...others],
      emails,
      birthDate: birthday(read(cells, 'birthday')),
      notes: read(cells, 'notes'),
      address
    };
  });
}

// ── vCard ───────────────────────────────────────────────────────────────────

function unescapeVcard(value) {
  return String(value ?? '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
}

function peopleFromVcard(text) {
  // Lines that start with a space or tab continue the previous one.
  const lines = String(text ?? '').replace(/^﻿/, '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const people = [];
  let card = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^BEGIN:VCARD$/i.test(line)) {
      card = { name: '', n: '', mobiles: [], others: [], emails: [], birthDate: null, notes: '', address: null };
      continue;
    }
    if (/^END:VCARD$/i.test(line)) {
      if (card) {
        people.push({
          name: card.name || card.n,
          phones: [...card.mobiles, ...card.others],
          emails: card.emails,
          birthDate: card.birthDate,
          notes: card.notes,
          address: card.address
        });
      }
      card = null;
      continue;
    }
    if (!card) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    // `item1.TEL;TYPE=CELL` → property TEL, parameters TYPE=CELL.
    const [property, ...params] = line.slice(0, colon).replace(/^[^.;:]+\./, '').split(';');
    const value = line.slice(colon + 1);
    const kind = property.toUpperCase();
    const paramText = params.join(';');
    if (kind === 'FN') card.name = unescapeVcard(value);
    else if (kind === 'N') {
      const [family, given, additional] = value.split(';').map(unescapeVcard);
      card.n = [given, additional, family].filter(Boolean).join(' ');
    } else if (kind === 'TEL') {
      (/cell|mobile|iphone/i.test(paramText) ? card.mobiles : card.others).push(unescapeVcard(value.replace(/^tel:/i, '')));
    } else if (kind === 'EMAIL') card.emails.push(unescapeVcard(value));
    else if (kind === 'BDAY') card.birthDate = birthday(value);
    else if (kind === 'NOTE') card.notes = unescapeVcard(value);
    else if (kind === 'ADR' && !card.address) {
      const [, extended, street, city, region, zip] = value.split(';').map(unescapeVcard);
      card.address = { street, complement: extended, city, state: region, zip };
    }
  }
  return people;
}

// ── The service ─────────────────────────────────────────────────────────────

/**
 * The contacts exported from Google Contacts (Gmail): its CSV, the Outlook
 * CSV it also offers, or a vCard.
 *
 * Same rules as the WhatsApp phone book: only people the panel does not know
 * yet become clients — a number already on any contact, in either spelling of
 * the ninth digit, is skipped — and nothing existing is edited.
 */
export default class ContactGoogleImportService {
  /** Which export this is, or null for any other file (the sheet importer's). */
  static detect(text) {
    const source = String(text ?? '').replace(/^﻿/, '').trimStart();
    if (/^BEGIN:VCARD/i.test(source)) return 'vcard';
    const header = (parseCsv(source.split(/\r?\n/, 1)[0] ?? '')[0] ?? []).map(headerKey);
    if (header.some((name) => /^phone \d+ - value$/.test(name) || /^e-mail \d+ - value$/.test(name) || name === 'given name')) {
      return 'google';
    }
    if (header.includes('mobile phone') || header.includes('e-mail address')) return 'outlook';
    return null;
  }

  static people(text, format) {
    return format === 'vcard' ? peopleFromVcard(text) : peopleFromCsv(text);
  }

  /** One contact as the record keeps it: checked fields only, bad emails dropped. */
  static clean(person) {
    const phones = [...new Set(person.phones.map((value) => normalizarTelefoneBr(value)).filter(Boolean))];
    const emails = person.emails.filter((email) => {
      try {
        checkField('emails', [email]);
        return true;
      } catch {
        return false;
      }
    });
    const address = person.address
      ? Object.fromEntries(Object.entries(person.address).filter(([, value]) => value))
      : null;
    return {
      name: String(person.name || '').trim().slice(0, 255),
      phones,
      emails: [...new Set(emails.map((email) => email.toLowerCase()))].slice(0, 20),
      birthDate: person.birthDate || null,
      notes: String(person.notes || '').trim().slice(0, 5000) || null,
      address: address && Object.keys(address).length ? address : null
    };
  }

  /** What the import would do. Writes nothing. */
  static async plan(text, format) {
    const people = this.people(text, format);
    const known = await ContactWhatsappImportService.knownNumbers();
    const seen = new Set();
    const plan = { format, total: people.length, creates: [], existing: 0, invalid: 0, duplicated: 0, truncated: false };

    for (const raw of people) {
      const person = this.clean(raw);
      if (person.phones.length === 0) {
        plan.invalid += 1;
        continue;
      }
      const variants = person.phones.flatMap((phone) => variantesTelefoneBr(phone));
      if (variants.some((variant) => known.has(variant))) {
        plan.existing += 1;
        continue;
      }
      if (variants.some((variant) => seen.has(variant))) {
        plan.duplicated += 1;
        continue;
      }
      variants.forEach((variant) => seen.add(variant));
      if (plan.creates.length >= MAX_CREATES) {
        plan.truncated = true;
        continue;
      }
      // A contact saved without a name is filed under its number, which the
      // operator can rename later.
      plan.creates.push({ ...person, name: person.name || person.phones[0] });
    }
    return plan;
  }

  static async apply(text, format, actor) {
    const plan = await this.plan(text, format);
    let created = 0;
    for (const person of plan.creates) {
      const [whatsappPhone, ...others] = person.phones;
      // eslint-disable-next-line no-await-in-loop -- each client is written with its own list row
      await ContactProfileService.create({
        name: person.name,
        whatsappPhone,
        ...(others.length ? { phones: person.phones } : {}),
        ...(person.emails.length ? { emails: person.emails } : {}),
        ...(person.birthDate ? { birthDate: person.birthDate } : {}),
        ...(person.address ? { address: person.address } : {}),
        ...(person.notes ? { notes: person.notes } : {})
      }, actor, { importSource: 'google' });
      created += 1;
    }
    return { ...this.summary(plan), created };
  }

  static summary(plan) {
    return {
      format: plan.format,
      total: plan.total,
      creates: plan.creates.length,
      existing: plan.existing,
      invalid: plan.invalid,
      duplicated: plan.duplicated,
      truncated: plan.truncated,
      maxCreates: MAX_CREATES,
      rows: plan.creates.slice(0, PREVIEW_ROWS).map((step) => ({ name: step.name, phone: step.phones[0] }))
    };
  }
}
