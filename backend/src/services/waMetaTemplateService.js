import AppState from '../models/AppState.js';
import WaMetaTemplate from '../models/WaMetaTemplate.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { WaError } from './whatsappConfigService.js';
import {
  createMetaTemplateRequest,
  findMetaTemplatesRequest,
  readCreatedTemplate,
  readMetaTemplates,
  sanitizeMetaParam
} from '../utils/wa/evolutionApi.js';

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

// ── Criação de modelo na Meta ────────────────────────────────────────
//
// Os limites são os da Meta (nome em minúsculas com `_`, corpo de até 1024,
// cabeçalho e rodapé de até 60, até três botões de até 25 caracteres) somados
// ao que o painel sabe enviar: variáveis só posicionais e só no corpo, botão
// de URL fixa. Conferir aqui poupa a ida à Meta para uma recusa que já se sabe
// e devolve o CAMPO errado ao formulário, coisa que o erro da Graph API, em
// inglês e às vezes genérico, não faz.

export const META_TEMPLATE_CATEGORIES = Object.freeze(['UTILITY', 'MARKETING']);
const META_BUTTON_TYPES = new Set(['URL', 'QUICK_REPLY']);
const META_NAME = /^[a-z0-9_]{1,512}$/;
const META_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

function recusa(field) {
  return new WaError('whatsapp.error.invalidMetaTemplate', {
    code: 'invalid_meta_template',
    status: 400,
    details: { field },
    vars: { field }
  });
}

/**
 * Confere e normaliza o modelo que o operador quer criar. Pura: nada de banco
 * nem de rede, para a recusa sair antes de qualquer pedido ao servidor.
 *
 * @returns {{ name: string, category: string, language: string, bodyText: string,
 *             examples: string[], headerText: string|null, footerText: string|null,
 *             buttons: { type: 'URL'|'QUICK_REPLY', text: string, url?: string }[],
 *             paramCount: number }}
 */
export function validateMetaTemplateInput(input) {
  const i = input && typeof input === 'object' ? input : {};

  // Nome: a Meta só aceita minúsculas, dígitos e `_`. Espaço vira `_` para o
  // operador poder digitar "aviso fatura" sem errar.
  const name = String(i.name ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!META_NAME.test(name)) throw recusa('name');

  const category = String(i.category ?? '').trim().toUpperCase();
  // AUTHENTICATION fica de fora de propósito: exige botão de código e o
  // painel não envia esse tipo.
  if (!META_TEMPLATE_CATEGORIES.includes(category)) throw recusa('category');

  const language = String(i.language ?? '').trim() || 'pt_BR';
  if (!META_LANGUAGE.test(language)) throw recusa('language');

  // `{{ 1 }}` vira `{{1}}`: a Meta só reconhece a forma colada.
  const bodyText = String(i.bodyText ?? '').trim().replace(/\{\{\s*(\d+)\s*\}\}/g, '{{$1}}');
  if (!bodyText || bodyText.length > 1024) throw recusa('bodyText');

  // Variáveis: só `{{1}}`, `{{2}}`… e sem pular número — a Meta recusa
  // `{{1}} {{3}}` e o envio do painel monta os parâmetros pela posição.
  if (/\{\{\s*[A-Za-z_][\w]*\s*\}\}/.test(bodyText)) throw recusa('variables');
  const usados = [...bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  const paramCount = usados.length ? Math.max(...usados) : 0;
  const distintos = new Set(usados);
  for (let n = 1; n <= paramCount; n += 1) {
    if (!distintos.has(n)) throw recusa('variables');
  }
  if (distintos.has(0)) throw recusa('variables');

  const brutos = Array.isArray(i.examples) ? i.examples : [];
  const examples = brutos.map((v) => sanitizeMetaParam(v));
  if (examples.length !== paramCount || examples.some((v) => !v)) throw recusa('examples');

  const headerText = String(i.headerText ?? '').trim() || null;
  if (headerText && (headerText.length > 60 || /\{\{/.test(headerText))) throw recusa('headerText');

  const footerText = String(i.footerText ?? '').trim() || null;
  if (footerText && footerText.length > 60) throw recusa('footerText');

  const brutosBotoes = Array.isArray(i.buttons) ? i.buttons : [];
  if (brutosBotoes.length > 3) throw recusa('buttons');
  const buttons = brutosBotoes.map((b) => {
    const type = String(b?.type ?? '').trim().toUpperCase();
    const text = String(b?.text ?? '').trim();
    if (!META_BUTTON_TYPES.has(type) || !text || text.length > 25) throw recusa('buttons');
    if (type === 'QUICK_REPLY') return { type, text };
    const url = String(b?.url ?? '').trim();
    let ok = false;
    try {
      ok = new URL(url).protocol === 'https:' && !/\{\{/.test(url);
    } catch {
      ok = false;
    }
    if (!ok) throw recusa('buttons');
    return { type, text, url };
  });

  return { name, category, language, bodyText, examples, headerText, footerText, buttons, paramCount };
}

/**
 * Os modelos (templates) aprovados da Meta e o que liga o painel a eles.
 *
 * Num número oficial, fora da janela de 24 h só sai modelo aprovado. O painel
 * SINCRONIZA a lista da Meta e deixa cada modelo do painel (cobrança, campanha)
 * e cada aviso automático (manutenção, queda, alerta) apontar para um deles.
 * Também pode PEDIR um modelo novo (`create`) — mas quem aprova é a Meta: o
 * modelo nasce PENDING e só vira utilizável quando a revisão passa e uma
 * sincronização traz o APPROVED. Quem decide se
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

  /**
   * Pede à Meta um modelo novo na conta WABA do número.
   *
   * A ordem importa: primeiro a conta (404 para id de fora, 409 para número
   * por QR — a varredura de ids depende de nenhuma validação vir antes), depois
   * o corpo, e só então a rede. Recusa de validação nunca chega ao servidor.
   *
   * Depois de criar, sincroniza: a lista local passa a ter o modelo PENDING com
   * o id da linha. Se a sincronização falhar (a Meta às vezes demora a listar o
   * que acabou de aceitar), o modelo criado não se perde — devolve-se o mínimo
   * que se sabe, e a próxima sincronização traz a linha.
   */
  static async create(accountId, input) {
    const { account, EvolutionInstanceService } = await this.requireCloudAccount(accountId);
    const modelo = validateMetaTemplateInput(input);
    const config = await EvolutionInstanceService.requireConfig();
    const client = EvolutionInstanceService.clientFor(account, config);
    const result = await client.sendOrThrow(createMetaTemplateRequest(account.name, modelo));
    const created = readCreatedTemplate(result.data);

    let rows = [];
    try {
      rows = await this.sync(account.id);
    } catch {
      rows = [];
    }
    const linha = rows.find((r) => r.name === modelo.name && r.language === modelo.language);
    if (linha) return linha;
    return {
      id: null,
      accountId: account.id,
      name: modelo.name,
      language: modelo.language,
      category: created.category || modelo.category,
      status: created.status || 'PENDING',
      bodyText: modelo.bodyText,
      paramCount: modelo.paramCount,
      paramFormat: 'positional',
      supported: true,
      usable: false,
      syncedAt: null,
      metaId: created.id
    };
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
