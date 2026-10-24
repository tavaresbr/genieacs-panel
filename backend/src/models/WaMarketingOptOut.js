import { tdb, tinsertReturningId } from '../config/database.js';

/** De onde veio o pedido: texto digitado, o botão da Meta, ou a equipe. */
export const MARKETING_OPT_OUT_SOURCES = Object.freeze(['keyword', 'button', 'operator']);

/** `trigger_text` tem 120 de largura. */
const TRIGGER_LIMIT = 120;

function limpo(valor) {
  return String(valor ?? '').trim();
}

/**
 * "Não quero promoção" — o pedido estreito, ao lado do "não perturbe".
 *
 * Bloqueia SÓ o que é promoção: modelo da Meta de categoria MARKETING e
 * campanha marcada como promocional. Cobrança, aviso técnico e atendimento
 * continuam saindo, e é isso que o distingue de `WaOptOut`. Ver o comentário de
 * `waMarketingOptOutsTable` em `config/migrations.js`.
 *
 * Chaveado por telefone e LID, nunca por cliente, como o não perturbe: quem
 * pediu, pediu como um número. As duas identidades são consultadas porque um
 * contato pode ser conhecido por só uma delas.
 */
class WaMarketingOptOut {
  /** O filtro "este endereço", por telefone ou LID; null sem nenhum dos dois. */
  static porEndereco(q, { waPhone, waLid }) {
    const phone = limpo(waPhone);
    const lid = limpo(waLid);
    q.where((sub) => {
      if (phone) sub.orWhere({ wa_phone_e164: phone });
      if (lid) sub.orWhere({ wa_lid: lid });
    });
    return q;
  }

  /** A linha ativa deste endereço, ou null. */
  static async findActive({ waPhone, waLid } = {}) {
    if (!limpo(waPhone) && !limpo(waLid)) return null;
    return (await this.porEndereco(tdb('wa_marketing_opt_outs').whereNull('revoked_at'), { waPhone, waLid })
      .orderBy('id')
      .first()) || null;
  }

  static async isActive(endereco = {}) {
    return Boolean(await this.findActive(endereco));
  }

  /** Os números de um lote que pediram para não receber promoção — uma consulta por bloco. */
  static async activePhones(phones) {
    const lista = [...new Set((phones || []).map(limpo).filter(Boolean))];
    const ativos = new Set();
    for (let i = 0; i < lista.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop -- poucos blocos
      const linhas = await tdb('wa_marketing_opt_outs')
        .whereNull('revoked_at')
        .whereIn('wa_phone_e164', lista.slice(i, i + 500))
        .select('wa_phone_e164');
      for (const linha of linhas) ativos.add(linha.wa_phone_e164);
    }
    return ativos;
  }

  /** Telefone → { since, source } das linhas ativas, para a lista de conversas. */
  static async activeByPhone(phones) {
    const lista = [...new Set((phones || []).map(limpo).filter(Boolean))];
    const mapa = new Map();
    for (let i = 0; i < lista.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop -- poucos blocos
      const linhas = await tdb('wa_marketing_opt_outs')
        .whereNull('revoked_at')
        .whereIn('wa_phone_e164', lista.slice(i, i + 500))
        .orderBy('id')
        .select('wa_phone_e164', 'opted_out_at', 'source');
      for (const linha of linhas) {
        if (!mapa.has(linha.wa_phone_e164)) mapa.set(linha.wa_phone_e164, linha);
      }
    }
    return mapa;
  }

  /**
   * Grava o pedido, a não ser que já haja um ativo — repetir "parar" não pode
   * encher a lista nem fazer o painel responder de novo.
   *
   * @returns {Promise<{ row: object|null, created: boolean }>}
   */
  static async record({ waPhone, waLid, conversationId = null, source = 'keyword', triggerText = null, userId = null } = {}) {
    const phone = limpo(waPhone);
    const lid = limpo(waLid);
    if (!phone && !lid) return { row: null, created: false };
    const existente = await this.findActive({ waPhone: phone, waLid: lid });
    if (existente) return { row: existente, created: false };
    const origem = MARKETING_OPT_OUT_SOURCES.includes(source) ? source : 'keyword';
    const id = await tinsertReturningId('wa_marketing_opt_outs', {
      wa_phone_e164: phone || null,
      wa_lid: lid || null,
      conversation_id: conversationId || null,
      source: origem,
      trigger_text: triggerText ? String(triggerText).slice(0, TRIGGER_LIMIT) : null,
      created_by: userId || null,
      opted_out_at: new Date()
    });
    return { row: (await tdb('wa_marketing_opt_outs').where({ id }).first()) || null, created: true };
  }

  /**
   * Desfaz o pedido ativo deste endereço. Devolve quantas linhas saíram —
   * zero quando não havia nada, que é o que deixa "VOLTAR" de quem nunca saiu
   * passar sem resposta.
   */
  static async revoke({ waPhone, waLid, source = 'keyword', userId = null } = {}) {
    if (!limpo(waPhone) && !limpo(waLid)) return 0;
    const n = await this.porEndereco(tdb('wa_marketing_opt_outs').whereNull('revoked_at'), { waPhone, waLid })
      .update({
        revoked_at: new Date(),
        revoked_source: source === 'operator' ? 'operator' : 'keyword',
        revoked_by: userId || null
      });
    return Number(n) || 0;
  }

  /**
   * Se o modelo da Meta citado numa mensagem é de MARKETING.
   *
   * Pelo nome e idioma, que é o que a mensagem guarda (`meta_template`). Com a
   * conta, olha primeiro o modelo DAQUELE número; sem achar ali, qualquer
   * número do provedor — o mesmo nome em duas contas WABA é quase sempre o
   * mesmo modelo, e na dúvida o lado seguro é tratar como promoção.
   */
  static async isMarketingTemplate(modelo, accountId = null) {
    const name = limpo(modelo?.name);
    if (!name) return false;
    const language = limpo(modelo?.language);
    const base = () => {
      const q = tdb('wa_meta_templates').where({ name });
      if (language) q.where({ language });
      return q;
    };
    if (accountId) {
      const daConta = await base().where({ account_id: accountId }).first('category');
      if (daConta) return String(daConta.category || '').toUpperCase() === 'MARKETING';
    }
    const linhas = await base().select('category');
    return linhas.some((linha) => String(linha.category || '').toUpperCase() === 'MARKETING');
  }
}

export default WaMarketingOptOut;
