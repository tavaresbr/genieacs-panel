import { tdb } from '../config/database.js';
import AppState from '../models/AppState.js';
import WaMetaTemplate from '../models/WaMetaTemplate.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { deleteMetaTemplate, editMetaTemplate, isMetaId } from './metaGraphClient.js';
import {
  createMetaTemplateRequest,
  findMetaTemplatesRequest,
  metaTemplateComponents,
  readCreatedTemplate,
  readMetaTemplateDraft,
  readMetaTemplates,
  sanitizeMetaFilename,
  sanitizeMetaLink,
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

function lerJson(raw, padrao) {
  if (!raw) return padrao;
  try {
    return JSON.parse(raw) ?? padrao;
  } catch {
    return padrao;
  }
}

/** Formatos de cabeçalho que saem por link de mídia. */
const MIDIA = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);
/** Origens do cabeçalho de mídia na ligação de um modelo do painel. */
const ORIGENS = new Set(['attachment', 'variable', 'url']);

/** Os botões guardados de um modelo da Meta: `[{index, type, urlHasParam}]`. */
export function metaButtons(row) {
  const lista = lerJson(row?.buttons_json, []);
  return (Array.isArray(lista) ? lista : []).map((b) => ({
    index: Number(b?.index) || 0,
    type: String(b?.type ?? ''),
    urlHasParam: Boolean(b?.urlHasParam)
  }));
}

/** O formato do cabeçalho de um modelo guardado (`NONE` sem cabeçalho). */
export function metaHeaderFormat(row) {
  return String(row?.header_format || 'NONE').toUpperCase();
}

/**
 * O nome do documento no cabeçalho: o do fim do link quando ele tem extensão;
 * senão um nome pela variável (`link_boleto` → `boleto.pdf`).
 */
export function metaFilename(variavel, link) {
  try {
    const ultimo = decodeURIComponent(new URL(link).pathname.split('/').pop() || '');
    if (/^[^.]+\.[A-Za-z0-9]{2,5}$/.test(ultimo)) return sanitizeMetaFilename(ultimo);
  } catch {
    // link já conferido; sem nome no caminho, cai no padrão abaixo
  }
  const base = String(variavel || '').replace(/^link_/, '').replace(/[^A-Za-z0-9_-]/g, '') || 'documento';
  return `${base}.pdf`;
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

/** Os estados em que a Meta deixa editar um modelo. */
const EDITAVEIS = new Set(['APPROVED', 'REJECTED', 'PAUSED']);
/**
 * Recusa da Meta por limite de edição (aprovado: uma por 24 h, dez por 30
 * dias). Os subcódigos não são documentados com estabilidade, então o texto
 * também conta.
 */
const LIMITE_EDICAO = /edit(s|ed|ing)?\b.*\b(limit|24 hours|30 days)|(limit|maximum).*\bedit/i;
const SUBCODIGOS_LIMITE = new Set([2388023, 2388024, 2388025]);
/** "Modelo não existe" na hora de apagar: já foi apagado no Gerenciador. */
const NAO_EXISTE = /not\s*found|does not exist|doesn't exist|no template/i;
/** As colunas da ligação de um modelo do painel (`wa_templates`) a um da Meta. */
const LIGACAO_VAZIA = Object.freeze({
  meta_template_name: null,
  meta_language: null,
  meta_params: null,
  meta_header: null,
  meta_button_param: null,
  meta_button_index: null
});

function recusaDaMeta(result) {
  const erro = result?.data?.error;
  const texto = [erro?.message, erro?.error_user_title, erro?.error_user_msg].filter(Boolean).join(' ');
  if (SUBCODIGOS_LIMITE.has(Number(erro?.error_subcode)) || LIMITE_EDICAO.test(texto)) {
    return new WaError('whatsapp.error.metaTemplateEditLimit', { code: 'meta_template_edit_limit', status: 409 });
  }
  return new WaError('whatsapp.error.metaRefused', {
    code: 'meta_refused',
    status: 502,
    vars: { reason: result?.error || 'meta_refused' }
  });
}

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
 * Na edição (`fixed`), nome e idioma vêm do modelo guardado e o que veio no
 * corpo é ignorado: a Meta não deixa trocar nenhum dos dois.
 *
 * @returns {{ name: string, category: string, language: string, bodyText: string,
 *             examples: string[], headerText: string|null, footerText: string|null,
 *             buttons: { type: 'URL'|'QUICK_REPLY', text: string, url?: string }[],
 *             paramCount: number }}
 */
export function validateMetaTemplateInput(input, { fixed = null } = {}) {
  const base = input && typeof input === 'object' ? input : {};
  const i = fixed ? { ...base, name: fixed.name, language: fixed.language } : base;

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
      metaId: created.id,
      hasMetaId: false,
      editable: false,
      draft: null
    };
  }

  // ── Editar e apagar (Graph API direto) ─────────────────────────────
  //
  // O servidor Evolution só sabe listar e criar modelo; editar e apagar vão
  // direto à Graph, com o token da Meta do próprio número (o mesmo que o
  // servidor guarda como chave da instância) — ver `metaGraphClient.js`.

  /**
   * O número oficial e o modelo dele, na ordem que a varredura de ids pede:
   * conta (404 de outro provedor, 409 de número por QR), depois o modelo
   * (404 se não é deste número), e só então o que falta para falar com a Meta.
   */
  static async loadOwned(accountId, templateId) {
    const { account } = await this.requireCloudAccount(accountId);
    const id = Number.parseInt(String(templateId ?? ''), 10);
    const row = Number.isInteger(id) && id > 0
      ? (await tdb('wa_meta_templates').where({ id, account_id: account.id }).first()) || null
      : null;
    if (!row) {
      throw new WaError('whatsapp.error.metaTemplateNotFound', { code: 'meta_template_not_found', status: 404 });
    }
    return { account, row };
  }

  /** O token e a conta WABA do número, ou a recusa que diz o que falta. */
  static credentials(account, row) {
    if (!isMetaId(row.meta_id)) {
      throw new WaError('whatsapp.error.metaTemplateNotSynced', { code: 'meta_template_not_synced', status: 409 });
    }
    const token = WhatsAppConfigService.decryptInstanceToken(account);
    if (!isMetaId(account.meta_waba_id) || !token) {
      throw new WaError('whatsapp.error.metaWabaMissing', { code: 'meta_waba_missing', status: 409 });
    }
    return { token, wabaId: String(account.meta_waba_id).trim() };
  }

  /**
   * Quem depende deste modelo: modelos do painel (`wa_templates`) e avisos
   * automáticos. A ligação é por nome + idioma e vale para qualquer número
   * oficial — se OUTRO número ainda tem o mesmo modelo aprovado, ela continua
   * de pé e não entra na lista.
   *
   * @returns {Promise<{ kind: 'template'|'notice', id?: number, name?: string, key?: string }[]>}
   */
  static async findLinks(row) {
    const outro = await tdb('wa_meta_templates')
      .where({ name: row.name, language: row.language, status: 'APPROVED', supported: true })
      .whereNot({ account_id: row.account_id })
      .first();
    if (outro) return [];
    const modelos = await tdb('wa_templates')
      .where({ meta_template_name: row.name, meta_language: row.language })
      .orderBy('name');
    const avisos = await this.getNoticeBindings();
    return [
      ...modelos.map((m) => ({ kind: 'template', id: m.id, name: m.name })),
      ...NOTICE_KEYS
        .filter((key) => avisos[key]?.name === row.name && avisos[key]?.language === row.language)
        .map((key) => ({ kind: 'notice', key }))
    ];
  }

  /**
   * Edita o modelo na Meta: `POST /{id do modelo}` com os `components` novos.
   *
   * A Meta só aceita APPROVED, REJECTED ou PAUSED, e um aprovado tem limite
   * (uma edição por 24 h, dez por 30 dias); o modelo volta a PENDING e fica
   * fora do envio até a nova aprovação. A categoria só vai quando o modelo
   * não está aprovado — num aprovado a Meta recusa a troca.
   *
   * As ligações não mudam (nome e idioma são os mesmos), mas a resposta as
   * lista: enquanto a Meta revisa, elas não saem fora da janela de 24 h.
   */
  static async update(accountId, templateId, input) {
    const { account, row } = await this.loadOwned(accountId, templateId);
    const status = String(row.status || '').toUpperCase();
    if (!EDITAVEIS.has(status)) {
      throw new WaError('whatsapp.error.metaTemplateNotEditable', {
        code: 'meta_template_not_editable', status: 409, vars: { status: status || '—' }
      });
    }
    const modelo = validateMetaTemplateInput(input, { fixed: { name: row.name, language: row.language } });
    const { token } = this.credentials(account, row);
    const atual = String(row.category || '').toUpperCase();
    const result = await editMetaTemplate({
      templateId: row.meta_id,
      token,
      components: metaTemplateComponents(modelo),
      category: status !== 'APPROVED' && modelo.category !== atual ? modelo.category : null
    });
    if (!result.ok) throw recusaDaMeta(result);

    const links = await this.findLinks(row);
    let rows = [];
    try {
      rows = await this.sync(account.id);
    } catch {
      rows = [];
    }
    const linha = rows.find((r) => r.name === row.name && r.language === row.language)
      ?? { ...this.publicMetaTemplate(row), status: 'PENDING', usable: false };
    return { template: linha, links };
  }

  /**
   * Apaga o modelo na Meta (só este idioma: vai o `hsm_id`) e a cópia local.
   *
   * Com ligações, recusa com 409 `meta_template_in_use` e a lista — sem ir à
   * Meta. Apagar em silêncio deixaria a régua, a cobrança e os avisos pulando
   * envio fora da janela sem ninguém saber por quê. Com `unlink`, desfaz as
   * ligações depois que a Meta apagou, e diz quantas.
   *
   * "Não existe" da Meta conta como apagado: o modelo já tinha saído pelo
   * Gerenciador do WhatsApp e só a cópia daqui estava atrasada.
   */
  static async remove(accountId, templateId, { unlink = false } = {}) {
    const { account, row } = await this.loadOwned(accountId, templateId);
    const links = await this.findLinks(row);
    if (links.length && !unlink) {
      throw Object.assign(
        new WaError('whatsapp.error.metaTemplateInUse', {
          code: 'meta_template_in_use', status: 409, vars: { count: links.length }
        }),
        { extra: { metaLinks: links } }
      );
    }
    const { token, wabaId } = this.credentials(account, row);
    const result = await deleteMetaTemplate({ wabaId, token, name: row.name, hsmId: row.meta_id });
    if (!result.ok) {
      const erro = result.data?.error;
      const texto = [erro?.message, erro?.error_user_msg].filter(Boolean).join(' ');
      if (!(result.status === 404 || (Number(erro?.code) === 100 && NAO_EXISTE.test(texto)))) {
        throw recusaDaMeta(result);
      }
    }

    await tdb('wa_meta_templates').where({ id: row.id, account_id: account.id }).del();
    const ids = links.filter((l) => l.kind === 'template').map((l) => l.id);
    if (ids.length) {
      await tdb('wa_templates').whereIn('id', ids).update({ ...LIGACAO_VAZIA, updated_at: new Date() });
    }
    const avisos = links.filter((l) => l.kind === 'notice').map((l) => l.key);
    if (avisos.length) {
      const atual = await this.getNoticeBindings();
      for (const key of avisos) atual[key] = null;
      await AppState.upsert(NOTICE_BINDINGS_KEY, JSON.stringify(atual));
    }
    return { id: row.id, name: row.name, language: row.language, unlinked: { templates: ids.length, notices: avisos.length } };
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
    // O formulário de edição só abre para o que ele sabe representar; o resto
    // se edita no Gerenciador do WhatsApp (ver `readMetaTemplateDraft`).
    const draft = readMetaTemplateDraft(lerJson(row.components_json, []));
    const status = String(row.status || '').toUpperCase();
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
      headerFormat: metaHeaderFormat(row),
      headerParamCount: Number(row.header_param_count) || 0,
      buttons: metaButtons(row),
      supported: Boolean(row.supported),
      usable: row.status === 'APPROVED' && Boolean(row.supported),
      syncedAt: row.synced_at || null,
      // O id do modelo na Meta: sem ele não há como editar nem apagar daqui.
      hasMetaId: isMetaId(row.meta_id),
      editable: EDITAVEIS.has(status) && isMetaId(row.meta_id) && draft !== null,
      draft
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
   * Além do corpo, o modelo pode pedir:
   *
   *   - cabeçalho de mídia: uma origem — `attachment` (o anexo da campanha,
   *     resolvido no envio), `variable` (uma variável com o link, ex.
   *     `link_boleto`) ou `url` (um endereço https fixo);
   *   - cabeçalho de texto com variável: a variável que o preenche;
   *   - botão de URL dinâmica: a variável que completa o fim da URL.
   *
   * O que o modelo não pede é descartado, para uma ligação trocada de modelo
   * não carregar a origem do anterior.
   *
   * @param {string[]} variaveis as variáveis que a categoria do modelo aceita
   * @returns {Promise<{ meta_template_name: string|null, meta_language: string|null, meta_params: string|null,
   *   meta_header: string|null, meta_button_param: string|null, meta_button_index: number|null }>}
   */
  static async validateMapping({ metaTemplateName, metaLanguage, metaParams, metaHeader, metaButtonParam }, variaveis) {
    const nome = String(metaTemplateName ?? '').trim();
    if (!nome) {
      return {
        meta_template_name: null,
        meta_language: null,
        meta_params: null,
        meta_header: null,
        meta_button_param: null,
        meta_button_index: null
      };
    }
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
    const header = this.validateHeader(modelo, metaHeader, variaveis);
    const dinamico = metaButtons(modelo).find((b) => b.urlHasParam) ?? null;
    let botao = null;
    if (dinamico) {
      botao = String(metaButtonParam ?? '').trim();
      if (!variaveis.includes(botao)) {
        throw new WaError('whatsapp.error.metaButtonMismatch', { code: 'meta_button_mismatch', status: 400 });
      }
    }
    return {
      meta_template_name: modelo.name,
      meta_language: modelo.language,
      meta_params: JSON.stringify(params),
      meta_header: header ? JSON.stringify(header) : null,
      meta_button_param: botao,
      meta_button_index: dinamico ? dinamico.index : null
    };
  }

  /** A origem do cabeçalho conferida contra o modelo, ou `null` se ele não pede. */
  static validateHeader(modelo, metaHeader, variaveis) {
    const formato = metaHeaderFormat(modelo);
    const recusa = () => new WaError('whatsapp.error.metaHeaderMismatch', { code: 'meta_header_mismatch', status: 400 });
    const source = String(metaHeader?.source ?? '').trim();
    const value = String(metaHeader?.value ?? '').trim();
    if (formato === 'TEXT' && Number(modelo.header_param_count) > 0) {
      // Cabeçalho é curto (60 caracteres): o texto inteiro não serve ali.
      if (source !== 'variable' || !variaveis.includes(value)) throw recusa();
      return { source, value, type: 'text' };
    }
    if (!MIDIA.has(formato)) return null;
    const type = formato.toLowerCase();
    if (!ORIGENS.has(source)) throw recusa();
    if (source === 'attachment') return { source, value: null, type };
    if (source === 'variable') {
      if (!variaveis.includes(value)) throw recusa();
      return { source, value, type };
    }
    const link = sanitizeMetaLink(value);
    if (!link) throw recusa();
    return { source, value: link, type };
  }

  /**
   * A foto do modelo Meta para UMA mensagem: nome, idioma, os parâmetros já
   * preenchidos e, quando o modelo pede, o cabeçalho e o sufixo do botão.
   * `null` quando o modelo do painel não aponta para nenhum; `{ incomplete }`
   * quando falta o valor de uma variável — a mesma regra do texto, que não sai
   * com buraco. Um link de variável que não é https conta como faltando.
   *
   * Origem `attachment` vai como `{ type, source: 'attachment' }`: o link do
   * anexo é assinado por mensagem e por quinze minutos, e só existe no envio.
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
    const header = this.buildHeader(lerJson(waTemplate.meta_header, null), vars, vazias);
    let buttons = null;
    if (waTemplate.meta_button_param) {
      const sufixo = sanitizeMetaParam(vars[waTemplate.meta_button_param]);
      if (!sufixo) vazias.push(waTemplate.meta_button_param);
      buttons = [{ index: Number(waTemplate.meta_button_index) || 0, param: sufixo }];
    }
    if (vazias.length) return { incomplete: vazias };
    return {
      name: waTemplate.meta_template_name,
      language: waTemplate.meta_language,
      params,
      ...(header ? { header } : {}),
      ...(buttons ? { buttons } : {})
    };
  }

  static buildHeader(ligacao, vars, vazias) {
    if (!ligacao || typeof ligacao !== 'object') return null;
    const { source, value, type } = ligacao;
    if (type === 'text') {
      const texto = sanitizeMetaParam(vars[value]);
      if (!texto) vazias.push(value);
      return { type, params: [texto] };
    }
    if (!['image', 'video', 'document'].includes(type)) return null;
    if (source === 'attachment') return { type, source: 'attachment' };
    const link = sanitizeMetaLink(source === 'variable' ? vars[value] : value);
    if (!link) {
      vazias.push(source === 'variable' ? value : 'url');
      return null;
    }
    return type === 'document'
      ? { type, link, filename: metaFilename(source === 'variable' ? value : '', link) }
      : { type, link };
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
      // O aviso só tem o texto: modelo que pede cabeçalho ou sufixo de botão
      // não teria de onde tirar o resto.
      if (Number(modelo.param_count) > 1 || this.needsExtras(modelo)) {
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

  /** Se o modelo pede mais que o corpo: cabeçalho de mídia ou com variável, ou sufixo de botão. */
  static needsExtras(row) {
    const formato = metaHeaderFormat(row);
    return MIDIA.has(formato)
      || (formato === 'TEXT' && Number(row.header_param_count) > 0)
      || metaButtons(row).some((b) => b.urlHasParam);
  }

  /**
   * O modelo de um envio do operador, conferido contra o número que vai enviar:
   * os parâmetros do corpo, o cabeçalho que o modelo pede (mídia do mesmo tipo,
   * por link — o atendente não usa a origem `attachment`) e o sufixo de cada
   * botão dinâmico, nem mais nem menos.
   */
  static async checkForAccount(account, metaTemplate) {
    if (!metaTemplate) return null;
    const row = await WaMetaTemplate.find(account.id, metaTemplate.name, metaTemplate.language);
    const recusa = () => new WaError('whatsapp.error.metaTemplateUnavailable', { code: 'meta_template_unavailable', status: 400 });
    if (!row || row.status !== 'APPROVED' || !row.supported
      || metaTemplate.params.length !== Number(row.param_count)
      || metaTemplate.params.some((p) => !p)) {
      throw recusa();
    }
    const formato = metaHeaderFormat(row);
    const header = metaTemplate.header ?? null;
    if (MIDIA.has(formato)) {
      if (!header || header.type !== formato.toLowerCase() || !header.link) throw recusa();
    } else if (formato === 'TEXT' && Number(row.header_param_count) > 0) {
      if (header?.type !== 'text' || header.params.length !== 1) throw recusa();
    } else if (header) {
      throw recusa();
    }
    const pedidos = metaButtons(row).filter((b) => b.urlHasParam).map((b) => b.index).sort((a, b) => a - b);
    const enviados = (metaTemplate.buttons ?? []).map((b) => b.index);
    if (pedidos.join(',') !== enviados.join(',')) throw recusa();
    return row;
  }

  /** O texto do modelo com os parâmetros, para a conversa mostrar o que saiu. */
  static renderBody(row, params) {
    return String(row?.body_text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => params[Number(n) - 1] ?? m);
  }
}

export default WaMetaTemplateService;
