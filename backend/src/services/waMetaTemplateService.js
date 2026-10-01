import AppState from '../models/AppState.js';
import WaMetaTemplate from '../models/WaMetaTemplate.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { WaError } from './whatsappConfigService.js';
import { findMetaTemplatesRequest, readMetaTemplates, sanitizeMetaParam } from '../utils/wa/evolutionApi.js';

/** O texto inteiro já renderizado, em uma linha — vale para qualquer modelo. */
export const TEXTO_COMPLETO = 'texto';

/** Os avisos automáticos que podem sair por modelo da Meta fora da janela. */
export const NOTICE_KEYS = Object.freeze(['maintenance', 'outage', 'alert']);
const NOTICE_BINDINGS_KEY = 'wa_meta_notice_bindings';

function falha(error) {
  const texto = error?.translationVars?.body || error?.code || error?.message || 'error';
  return String(texto).slice(0, 255);
}

function lerParams(raw) {
  if (!raw) return [];
  try {
    const lista = JSON.parse(raw);
    return Array.isArray(lista) ? lista.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * Os modelos (templates) aprovados da Meta e o que liga o painel a eles.
 *
 * Num número oficial, fora da janela de 24 h só sai modelo aprovado. O painel
 * não cria modelo na Meta — o provedor cria e aprova lá —; ele SINCRONIZA a
 * lista e deixa cada modelo do painel (cobrança, campanha) e cada aviso
 * automático (manutenção, queda, alerta) apontar para um deles. Quem decide se
 * a mensagem sai como texto ou como modelo é o envio (`waSendService`), pela
 * janela da conversa.
 */
class WaMetaTemplateService {
  static async requireCloudAccount(id) {
    const { default: EvolutionInstanceService } = await import('./evolutionInstanceService.js');
    const account = await EvolutionInstanceService.loadAccount(id);
    if (!WhatsAppAccount.isCloud(account)) {
      throw new WaError('whatsapp.error.metaTemplatesCloudOnly', { code: 'meta_templates_cloud_only', status: 409 });
    }
    return { account, EvolutionInstanceService };
  }

  /** Busca na Meta (pelo servidor Evolution) e troca a cópia local. */
  static async sync(accountId) {
    const { account, EvolutionInstanceService } = await this.requireCloudAccount(accountId);
    const config = await EvolutionInstanceService.requireConfig();
    const client = EvolutionInstanceService.clientFor(account, config);
    try {
      const result = await client.sendOrThrow(findMetaTemplatesRequest(account.name));
      const rows = await WaMetaTemplate.replaceForAccount(account.id, readMetaTemplates(result.data));
      await WhatsAppAccount.update(account.id, { meta_templates_synced_at: new Date(), meta_templates_error: null });
      return rows.map((row) => this.publicMetaTemplate(row));
    } catch (error) {
      await WhatsAppAccount.update(account.id, { meta_templates_error: falha(error) });
      throw error;
    }
  }

  /** Os modelos de um número, ou de todos os números oficiais do provedor. */
  static async list({ accountId = null, usableOnly = false } = {}) {
    const contas = accountId
      ? [await WhatsAppAccount.getById(Number(accountId))].filter(Boolean)
      : (await WhatsAppAccount.getAll()).filter((row) => WhatsAppAccount.isCloud(row));
    const out = [];
    for (const conta of contas) {
      // eslint-disable-next-line no-await-in-loop -- um ou dois números
      const rows = await WaMetaTemplate.listByAccount(conta.id, { usableOnly });
      out.push(...rows.map((row) => this.publicMetaTemplate(row)));
    }
    return out;
  }

  static publicMetaTemplate(row) {
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      language: row.language,
      category: row.category || null,
      status: row.status || null,
      bodyText: row.body_text || '',
      paramCount: Number(row.param_count) || 0,
      paramFormat: row.param_format === 'named' ? 'named' : 'positional',
      supported: Boolean(row.supported),
      usable: row.status === 'APPROVED' && Boolean(row.supported),
      syncedAt: row.synced_at || null
    };
  }

  /**
   * O modelo aprovado e utilizável com este nome e idioma, em qualquer número
   * oficial do provedor — a ligação é feita uma vez e vale para o número que
   * estiver enviando.
   */
  static async requireUsable(name, language) {
    const row = await WaMetaTemplate.findAnyAccount(String(name ?? '').trim(), String(language ?? '').trim());
    if (!row || row.status !== 'APPROVED' || !row.supported) {
      throw new WaError('whatsapp.error.metaTemplateUnavailable', { code: 'meta_template_unavailable', status: 400 });
    }
    return row;
  }

  /**
   * Confere a ligação de um modelo do painel a um modelo da Meta.
   *
   * @param {string[]} variaveis as variáveis que a categoria do modelo aceita
   * @returns {Promise<{ meta_template_name: string|null, meta_language: string|null, meta_params: string|null }>}
   */
  static async validateMapping({ metaTemplateName, metaLanguage, metaParams }, variaveis) {
    const nome = String(metaTemplateName ?? '').trim();
    if (!nome) return { meta_template_name: null, meta_language: null, meta_params: null };
    const modelo = await this.requireUsable(nome, metaLanguage);
    const params = (Array.isArray(metaParams) ? metaParams : []).map((v) => String(v ?? '').trim());
    const aceitas = new Set([...variaveis, TEXTO_COMPLETO]);
    if (params.length !== Number(modelo.param_count) || params.some((v) => !aceitas.has(v))) {
      throw new WaError('whatsapp.error.metaParamMismatch', {
        code: 'meta_param_mismatch',
        status: 400,
        vars: { count: Number(modelo.param_count) }
      });
    }
    return { meta_template_name: modelo.name, meta_language: modelo.language, meta_params: JSON.stringify(params) };
  }

  /**
   * A foto do modelo Meta para UMA mensagem: nome, idioma e os parâmetros já
   * preenchidos. `null` quando o modelo do painel não aponta para nenhum;
   * `{ incomplete }` quando falta o valor de uma variável — a mesma regra do
   * texto, que não sai com buraco.
   */
  static buildPayload(waTemplate, vars = {}, renderedBody = '') {
    if (!waTemplate?.meta_template_name) return null;
    const nomes = lerParams(waTemplate.meta_params);
    const vazias = [];
    const params = nomes.map((nome) => {
      const valor = nome === TEXTO_COMPLETO ? renderedBody : vars[nome];
      const limpo = sanitizeMetaParam(valor);
      if (!limpo) vazias.push(nome);
      return limpo;
    });
    if (vazias.length) return { incomplete: vazias };
    return { name: waTemplate.meta_template_name, language: waTemplate.meta_language, params };
  }

  // ── Avisos automáticos ─────────────────────────────────────────────

  static async getNoticeBindings() {
    const raw = await AppState.get(NOTICE_BINDINGS_KEY);
    let salvo = {};
    try {
      salvo = raw ? JSON.parse(raw) : {};
    } catch {
      salvo = {};
    }
    const out = {};
    for (const key of NOTICE_KEYS) {
      const b = salvo?.[key];
      out[key] = b && b.name ? { name: String(b.name), language: String(b.language), paramCount: Number(b.paramCount) || 0 } : null;
    }
    return out;
  }

  /**
   * Cada aviso aponta para um modelo com no máximo UM parâmetro, que recebe o
   * texto inteiro do aviso. Os avisos são texto livre (o operador edita o da
   * queda), então não há variáveis para mapear uma a uma.
   */
  static async saveNoticeBindings(input = {}) {
    const atual = await this.getNoticeBindings();
    const next = { ...atual };
    for (const key of NOTICE_KEYS) {
      if (input[key] === undefined) continue;
      const b = input[key];
      if (!b || !String(b.name ?? '').trim()) {
        next[key] = null;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- três chaves
      const modelo = await this.requireUsable(b.name, b.language);
      if (Number(modelo.param_count) > 1) {
        throw new WaError('whatsapp.error.metaParamMismatch', {
          code: 'meta_param_mismatch', status: 400, vars: { count: 1 }
        });
      }
      next[key] = { name: modelo.name, language: modelo.language, paramCount: Number(modelo.param_count) };
    }
    await AppState.upsert(NOTICE_BINDINGS_KEY, JSON.stringify(next));
    return next;
  }

  /** A foto do modelo para um aviso, ou `null` quando o aviso não tem ligação. */
  static async noticePayload(key, body) {
    const b = (await this.getNoticeBindings())[key];
    if (!b) return null;
    return { name: b.name, language: b.language, params: b.paramCount ? [sanitizeMetaParam(body)] : [] };
  }

  /** O modelo de um envio do operador, conferido contra o número que vai enviar. */
  static async checkForAccount(account, metaTemplate) {
    if (!metaTemplate) return null;
    const row = await WaMetaTemplate.find(account.id, metaTemplate.name, metaTemplate.language);
    if (!row || row.status !== 'APPROVED' || !row.supported
      || metaTemplate.params.length !== Number(row.param_count)
      || metaTemplate.params.some((p) => !p)) {
      throw new WaError('whatsapp.error.metaTemplateUnavailable', { code: 'meta_template_unavailable', status: 400 });
    }
    return row;
  }

  /** O texto do modelo com os parâmetros, para a conversa mostrar o que saiu. */
  static renderBody(row, params) {
    return String(row?.body_text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => params[Number(n) - 1] ?? m);
  }
}

export default WaMetaTemplateService;
