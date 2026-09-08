import WaTemplate from '../models/WaTemplate.js';
import { WaError } from './whatsappConfigService.js';
import { VARIAVEIS_DE_COBRANCA, variaveisDesconhecidas } from '../utils/wa/waCobranca.js';

/** Column widths from `wa_templates`; truncating here beats a driver error. */
const NAME_LIMIT = 80;
const CATEGORY_LIMIT = 32;

const CATEGORIES = Object.freeze(['cobranca', 'alerta', 'suporte', 'geral']);

/**
 * Saved message bodies.
 *
 * The one rule this service exists to enforce: a body may only cite variables
 * the dispatcher knows how to fill. It is checked on the way IN, for every
 * category, rather than at send time — by then the render has already refused
 * (`renderCobranca` returns null on an empty variable) and the operator is
 * looking at a campaign that silently dropped everybody, with no way to tell
 * why from the screen. The category is not part of the test on purpose: a
 * template's category can be changed with a `PUT` later, so accepting
 * `{{fatura_anterior}}` into a 'suporte' row would only move the failure.
 */
class WaTemplateService {
  static async list({ category, includeInactive } = {}) {
    const rows = await WaTemplate.list({
      category: CATEGORIES.includes(String(category ?? '')) ? String(category) : null,
      includeInactive: includeInactive === true
    });
    return rows.map((row) => this.publicTemplate(row));
  }

  static async create({ name, body, category } = {}) {
    const clean = this.validate({ name, body, category });
    if (await WaTemplate.getByName(clean.name)) {
      throw new WaError('whatsapp.templates.nameTaken', { code: 'name_taken', status: 409 });
    }
    return this.publicTemplate(await WaTemplate.create({
      name: clean.name,
      body: clean.body,
      category: clean.category,
      active: true
    }));
  }

  static async update(id, patch = {}) {
    const existing = await this.require(id);
    // A patch that omits a field keeps the stored one, so a rename cannot be
    // read as "and blank the body".
    const merged = this.validate({
      name: patch.name === undefined ? existing.name : patch.name,
      body: patch.body === undefined ? existing.body : patch.body,
      category: patch.category === undefined ? existing.category : patch.category
    });
    if (merged.name !== existing.name && await WaTemplate.getByName(merged.name)) {
      throw new WaError('whatsapp.templates.nameTaken', { code: 'name_taken', status: 409 });
    }
    return this.publicTemplate(await WaTemplate.update(existing.id, {
      name: merged.name,
      body: merged.body,
      category: merged.category,
      active: patch.active === undefined ? existing.active : patch.active === true
    }));
  }

  static async remove(id) {
    const existing = await this.require(id);
    await WaTemplate.remove(existing.id);
    return true;
  }

  /**
   * The body a campaign should use for `template`.
   *
   * A campaign may cite a stored template by name or by id, or carry a body
   * typed straight into the box for a one-off run. Both are legitimate, and the
   * same validation covers them: whichever it turns out to be, the text that
   * reaches the recipients went through `variaveisDesconhecidas` first.
   *
   * @returns {Promise<{ body: string, templateId: number|null, name: string|null }>}
   */
  static async resolveBody(template) {
    const raw = String(template ?? '').trim();
    if (!raw) {
      throw new WaError('whatsapp.error.templateEmpty', { code: 'template_empty', status: 400 });
    }
    const stored = /^\d+$/.test(raw)
      ? await WaTemplate.getById(Number(raw))
      : await WaTemplate.getByName(raw);
    const body = stored ? String(stored.body) : raw;
    this.assertKnownVariables(body);
    return { body, templateId: stored?.id ?? null, name: stored?.name ?? null };
  }

  static assertKnownVariables(body) {
    const unknown = variaveisDesconhecidas(body);
    if (unknown.length > 0) {
      const names = unknown.map((name) => `{{${name}}}`).join(', ');
      throw new WaError('whatsapp.error.unknownVariable', {
        code: 'unknown_variable',
        status: 400,
        // Named in the message, not just counted: "uses a variable the
        // dispatcher cannot fill" leaves the operator hunting through the text.
        vars: { names },
        details: unknown
      });
    }
  }

  static validate({ name, body, category }) {
    const cleanName = String(name ?? '').trim().slice(0, NAME_LIMIT);
    const cleanBody = String(body ?? '').trim();
    if (!cleanName || !cleanBody) {
      throw new WaError('whatsapp.error.templateEmpty', { code: 'template_empty', status: 400 });
    }
    this.assertKnownVariables(cleanBody);
    const cleanCategory = String(category ?? '').trim().slice(0, CATEGORY_LIMIT);
    return {
      name: cleanName,
      body: cleanBody,
      category: CATEGORIES.includes(cleanCategory) ? cleanCategory : 'geral'
    };
  }

  static async require(id) {
    const numeric = Number(id);
    const row = Number.isInteger(numeric) ? await WaTemplate.getById(numeric) : null;
    if (!row) {
      throw new WaError('whatsapp.templates.notFound', { code: 'template_not_found', status: 404 });
    }
    return row;
  }

  /**
   * The shape the browser may see.
   *
   * Built field by field like `publicAccount`, and for the same reason: a
   * column added later must not reach the browser by default.
   */
  static publicTemplate(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      body: row.body,
      category: row.category,
      active: Boolean(row.active),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };
  }
}

export { CATEGORIES, VARIAVEIS_DE_COBRANCA };
export default WaTemplateService;
