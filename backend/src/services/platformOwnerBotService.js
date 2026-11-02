import crypto from 'node:crypto';
import { getDb, tdb } from '../config/database.js';
import { currentTenantId, hasTenantContext, runInTenant, runUnscoped } from '../config/tenantContext.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import BillingCharge from '../models/BillingCharge.js';
import PlatformAudit from '../models/PlatformAudit.js';
import Tenant from '../models/Tenant.js';
import { panelBaseDomain } from '../middleware/tenantResolver.js';
import { normalizeTaxId } from '../utils/taxId.js';
import { signReceiptToken } from '../utils/receiptLinkToken.js';
import { variantesTelefoneBr } from '../utils/wa/waDestino.js';
import { normalizarTexto } from '../utils/wa/waOptOutTexto.js';
import { comoReal } from '../utils/wa/waCobranca.js';
import { receiptData } from './chargeReceiptService.js';
import SubscriptionService from './subscriptionService.js';
import { paymentInfo as lerSegundaVia } from './tenantChargeService.js';

/**
 * O atendimento dos DONOS de provedor pelo WhatsApp da plataforma.
 *
 * O número da plataforma é a conta Evolution da caixa (`tenants.kind =
 * 'platform'`). O que chega nele passa pelo mesmo `WaInboundService` →
 * `WaBotService` de qualquer provedor, com as mesmas travas (deduplicação,
 * humano na conversa, teto por hora, pausa) — e, no lugar do fluxo do SGP, que
 * não conhece provedor nenhum, cai aqui.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A LINHA, e ela é o desenho inteiro
 *
 * O telefone NÃO autentica. Ele só diz de quem PODE ser a conversa: o número
 * bate com o `billing_phone` do provedor ou com o `users.phone` de um dono.
 * Antes de qualquer dado de cobrança, o bot pede os 5 primeiros dígitos do
 * CNPJ/CPF de cobrança daquele provedor; a confirmação vale 30 minutos, e três
 * erros numa hora travam a conversa por uma hora.
 *
 * Toda leitura de cobrança roda em `runInTenant` do provedor CONFIRMADO, e só
 * dele: a cobrança de outro provedor simplesmente não existe ali. E todo envio
 * de dado de cobrança deixa uma linha na trilha da plataforma — sem o Pix e
 * sem a linha digitável, que são de quem paga e não de quem audita.
 *
 * O estado mora na própria conversa (`bot_step`, `bot_step_data`,
 * `bot_doc_attempts`, `bot_doc_window_at`, da 0064), que já é uma por telefone
 * dentro da caixa: nenhuma tabela nova.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O GANCHO NUMÉRICO (para a pesquisa de satisfação)
 *
 * `registerNumericHandler(fn)` deixa outra funcionalidade reclamar uma
 * resposta que é SÓ um número ("9", "10") — a nota de uma pesquisa pendente.
 * O gancho roda depois da identificação pelo telefone e antes do menu, e
 * nunca no meio de um passo (escolhendo o provedor ou digitando o documento),
 * onde o número é a resposta do passo. Ele recebe
 *
 *   { conversation, text, number, tenantIds, phone }
 *
 * — `tenantIds` são os provedores que o telefone nomeia, NÃO confirmados — e
 * devolve `null` para não reclamar, ou `{ consumed: true, reply?, intent? }`.
 * `reply` (texto) sai pela fila do bot; `intent` vai para o relatório. Quem
 * registra só deve reclamar quando há pesquisa dele pendente para um desses
 * provedores. Um gancho que lança é ignorado e a mensagem segue o fluxo.
 */

const t = (chave, vars) => translate(DEFAULT_LOCALE, chave, vars);

/** Os passos, em `wa_conversations.bot_step` (32 caracteres). */
const PASSO_ESCOLHA = 'po_escolha';
const PASSO_DOCUMENTO = 'po_documento';
const PASSO_MENU = 'po_menu';
const PASSO_BLOQUEIO = 'po_bloqueado';

/** Um passo em andamento (escolha, documento) vale meia hora, como no SGP. */
const PASSO_VALIDADE_MS = 30 * 60 * 1000;
/** A confirmação do documento vale 30 minutos, contados dela — não deslizam. */
const CONFIRMACAO_MS = 30 * 60 * 1000;
/** Três erros numa hora travam por uma hora. */
const TENTATIVAS = 3;
const JANELA_TENTATIVAS_MS = 60 * 60 * 1000;
const BLOQUEIO_MS = 60 * 60 * 1000;
/** Quantos dígitos do documento se pedem. */
const DIGITOS_PEDIDOS = 5;
/** Um dígito por opção na lista de provedores. */
const MAX_PROVEDORES_NA_LISTA = 9;

/**
 * O índice telefone → provedores, guardado por cinco minutos.
 *
 * O cadastro é pequeno (um telefone de cobrança e os donos de cada provedor)
 * e muda pouco, e a pergunta vem a cada mensagem: ler tudo e normalizar no JS
 * a cada uma seria a varredura que o índice evita. O telefone é texto livre no
 * cadastro ("(11) 98888-7777"), então a comparação no banco não serve — é a
 * normalização daqui (`variantesTelefoneBr`) que decide.
 *
 * Velho, o índice só pode ERRAR PARA MENOS: todo provedor que ele aponta é
 * relido do banco e conferido de novo antes de ser usado (ver `candidatos`).
 * Um telefone tirado do cadastro deixa de valer na hora; um recém-posto, em
 * até cinco minutos.
 */
const INDICE_MS = 5 * 60 * 1000;
let indice = null;

/** Os ganchos registrados por outras funcionalidades. */
const ganchosNumericos = [];

/** Dependências trocáveis pelos testes (o gateway real não aceita 127.0.0.1 na SaaS). */
const padrao = { paymentInfo: lerSegundaVia, now: () => Date.now() };
let deps = { ...padrao };

/** Cada grafia do telefone, para casar. */
function grafias(telefone) {
  return variantesTelefoneBr(telefone);
}

/** Os telefones dos provedores e dos donos, sem escopo: o índice cobre todos. */
async function lerTelefones(ids = null) {
  // tenant-scope-exempt: `tenants`, `tenant_users` e `users` são cadastro
  // compartilhado; a pergunta "de quem é este telefone" é acima dos provedores.
  return runUnscoped('the platform bot matches a phone against every provider', async () => {
    const db = getDb();
    let provedores = db('tenants').where({ kind: 'provider' }).select('id', 'billing_phone');
    let donos = db('tenant_users as tu')
      .join('users as u', 'u.id', 'tu.user_id')
      .join('tenants as tn', 'tn.id', 'tu.tenant_id')
      .where('tu.role', 'owner')
      .where('tn.kind', 'provider')
      .whereNotNull('u.phone')
      .select('tu.tenant_id as tenant_id', 'u.phone as phone');
    if (ids) {
      provedores = provedores.whereIn('id', ids);
      donos = donos.whereIn('tu.tenant_id', ids);
    }
    const [linhas, deDonos] = await Promise.all([provedores, donos]);
    const pares = [];
    for (const l of linhas) if (l.billing_phone) pares.push([Number(l.id), l.billing_phone]);
    for (const d of deDonos) if (d.phone) pares.push([Number(d.tenant_id), d.phone]);
    return pares;
  });
}

async function indiceDeTelefones(agora) {
  if (indice && indice.ate > agora) return indice.mapa;
  const mapa = new Map();
  for (const [tenantId, telefone] of await lerTelefones()) {
    for (const g of grafias(telefone)) {
      if (!mapa.has(g)) mapa.set(g, new Set());
      mapa.get(g).add(tenantId);
    }
  }
  indice = { mapa, ate: agora + INDICE_MS };
  return mapa;
}

/**
 * Os provedores que este telefone nomeia, relidos e conferidos agora.
 *
 * @returns {Promise<Array<{ id: number, name: string, slug: string, taxId: string }>>}
 */
async function candidatos(telefone, agora) {
  const minhas = new Set(grafias(telefone));
  if (!minhas.size) return [];
  const mapa = await indiceDeTelefones(agora);
  const ids = new Set();
  for (const g of minhas) for (const id of mapa.get(g) ?? []) ids.add(id);
  if (!ids.size) return [];

  // A reconferência: o índice pode estar velho, o banco não.
  const lista = [...ids];
  const confirmados = new Set();
  for (const [tenantId, fone] of await lerTelefones(lista)) {
    if (grafias(fone).some((g) => minhas.has(g))) confirmados.add(tenantId);
  }
  if (!confirmados.size) return [];
  // tenant-scope-exempt: `tenants` é cadastro compartilhado.
  const linhas = await getDb()('tenants')
    .whereIn('id', [...confirmados])
    .where({ kind: 'provider' })
    .orderBy('id', 'asc')
    .select('id', 'name', 'slug', 'billing_tax_id');
  return linhas.map((l) => ({
    id: Number(l.id),
    name: l.name || l.slug,
    slug: l.slug,
    taxId: normalizeTaxId(l.billing_tax_id)
  }));
}

/** O que está gravado na conversa, se é deste fluxo. */
function lerEstado(conversation) {
  const passo = conversation?.bot_step;
  if (!passo || !String(passo).startsWith('po_')) return { passo: null, dados: {} };
  let dados = {};
  try { dados = JSON.parse(conversation.bot_step_data || '{}') || {}; } catch { dados = {}; }
  return { passo, dados, desde: conversation.bot_step_at ? new Date(conversation.bot_step_at).getTime() : 0 };
}

/** Pedido de gente, pelas palavras — o "4" só vale no menu. */
const TERMOS_ATENDENTE = [
  'atendente', 'atendimento humano', 'humano', 'pessoa', 'falar com alguem', 'falar com uma pessoa',
  'falar com a equipe', 'equipe', 'suporte', 'operador'
].map((termo) => new RegExp(`(?:^| )${termo}(?: |$)`));

function pedeAtendente(texto) {
  const limpo = normalizarTexto(texto);
  return Boolean(limpo) && TERMOS_ATENDENTE.some((re) => re.test(limpo));
}

/** A opção do menu: "1", "opção 2", ou as palavras de cada uma. */
function opcaoDoMenu(texto) {
  const limpo = normalizarTexto(texto);
  const numero = /^(?:opcao )?([1-4])(?: |$)/.exec(limpo);
  if (numero) return Number(numero[1]);
  if (/(?:^| )(?:segunda via|boleto|fatura|pix|pagar)(?: |$)/.test(limpo)) return 1;
  if (/(?:^| )(?:status|situacao|assinatura|plano|vencimento)(?: |$)/.test(limpo)) return 2;
  if (/(?:^| )(?:recibo|comprovante)(?: |$)/.test(limpo)) return 3;
  return null;
}

/** Os 5 primeiros dígitos, comparados em tempo constante. */
function digitosConferem(digitados, documento) {
  if (documento.length < DIGITOS_PEDIDOS || digitados.length < DIGITOS_PEDIDOS) return false;
  const a = Buffer.from(digitados.slice(0, DIGITOS_PEDIDOS), 'utf8');
  const b = Buffer.from(documento.slice(0, DIGITOS_PEDIDOS), 'utf8');
  return crypto.timingSafeEqual(a, b);
}

/** Uma data para a mensagem: o dia puro como está, o instante no horário de Brasília. */
function dataBr(valor) {
  if (!valor) return '';
  const texto = valor instanceof Date ? valor.toISOString() : String(valor);
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    const [a, m, d] = texto.split('-');
    return `${d}/${m}/${a}`;
  }
  const data = valor instanceof Date ? valor : new Date(/^\d+$/.test(texto) ? Number(texto) : texto);
  if (Number.isNaN(data.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(data);
}

/** O dia de vencimento da cobrança como `YYYY-MM-DD`, para ordenar e mostrar. */
function diaDe(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  const texto = String(valor);
  return /^\d{4}-\d{2}-\d{2}/.test(texto) ? texto.slice(0, 10) : null;
}

const reais = (cents) => comoReal(Number(cents) / 100);

/** O telefone na trilha: só os quatro últimos dígitos. */
const telefoneMascarado = (telefone) => {
  const d = String(telefone || '').replace(/\D/g, '');
  return d ? `***${d.slice(-4)}` : null;
};

/**
 * O endereço público da plataforma: o domínio-base, senão `PUBLIC_BASE_URL`.
 * Nunca o `Host` de uma requisição — aqui nem há uma.
 */
function enderecoDaPlataforma() {
  const base = panelBaseDomain();
  if (base) return `https://${base}`;
  const publico = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!publico) return null;
  try {
    const parsed = new URL(publico);
    return ['http:', 'https:'].includes(parsed.protocol) ? publico : null;
  } catch {
    return null;
  }
}

/** A linha da trilha de um envio de dado de cobrança. Nunca o Pix, nunca a linha digitável. */
async function auditar(provedor, conversation, detail) {
  await PlatformAudit.record({
    action: PlatformAudit.ACTIONS.BOT_BILLING_DISCLOSED,
    actorUsername: 'bot-whatsapp',
    tenant: { id: provedor.id, slug: provedor.slug, name: provedor.name },
    detail: {
      ...detail,
      conversationId: conversation?.id ?? null,
      phone: telefoneMascarado(conversation?.wa_phone_e164)
    }
  });
}

class PlatformOwnerBotService {
  static PASSO_ESCOLHA = PASSO_ESCOLHA;
  static PASSO_DOCUMENTO = PASSO_DOCUMENTO;
  static PASSO_MENU = PASSO_MENU;
  static PASSO_BLOQUEIO = PASSO_BLOQUEIO;
  static TENTATIVAS = TENTATIVAS;
  static BLOQUEIO_MS = BLOQUEIO_MS;
  static CONFIRMACAO_MS = CONFIRMACAO_MS;

  /**
   * A conversa é da caixa da plataforma? Uma consulta à tabela pequena de
   * provedores; fora de um escopo de provedor, nunca.
   */
  static async isPlatformScope() {
    if (!hasTenantContext()) return false;
    const caixa = await Tenant.platform();
    return Boolean(caixa) && Number(caixa.id) === currentTenantId();
  }

  /**
   * Registra quem pode reclamar uma resposta que é só um número (ver o
   * cabeçalho). Devolve a função que desfaz o registro.
   *
   * @param {(ctx: { conversation: object, text: string, number: number,
   *   tenantIds: number[], phone: string|null }) =>
   *   Promise<null | { consumed: boolean, reply?: string, intent?: string }>} fn
   */
  static registerNumericHandler(fn) {
    if (typeof fn !== 'function') throw new TypeError('numeric handler must be a function');
    ganchosNumericos.push(fn);
    return () => {
      const i = ganchosNumericos.indexOf(fn);
      if (i >= 0) ganchosNumericos.splice(i, 1);
    };
  }

  /** O mesmo gancho, pelo nome que o plano da pesquisa de satisfação usa. */
  static onNumber(fn) {
    return this.registerNumericHandler(fn);
  }

  /** O índice de telefones esquecido — para testes e para quem mudou o cadastro. */
  static clearCache() {
    indice = null;
  }

  /** Testes: troca a leitura da segunda via e o relógio. Sem argumento, volta ao padrão. */
  static setDepsForTests(patch = null) {
    deps = patch ? { ...padrao, ...patch } : { ...padrao };
  }

  /**
   * Responde UMA mensagem já passada pelas travas do `WaBotService`.
   *
   * @param {object} p
   * @param {object} p.conversation a conversa, na caixa da plataforma
   * @param {string} p.texto o texto, já aparado
   * @param {object} p.bot as ferramentas do `WaBotService` (responder, pausar,
   *   gravar o passo, o texto de passagem) — por parâmetro, para não haver ciclo
   *   de importação
   * @returns {Promise<{ replied: boolean, intent?: string, reason?: string }>}
   */
  static async atender({ conversation, texto, bot }) {
    const agora = deps.now();
    // Relida: o passo mora na linha, e a conversa em mãos pode ser de antes.
    const atual = (await tdb('wa_conversations').where({ id: conversation.id }).first()) || conversation;
    const { passo, dados, desde } = lerEstado(atual);
    const falar = (mensagem) => bot.responderCom(atual, mensagem);

    const passarParaEquipe = async () => {
      await bot.pausar(atual, new Date(agora + bot.PAUSA_ATENDENTE_MS));
      await falar(await bot.textoPassagem('handoffQueued'));
      return { replied: true, intent: 'atendente' };
    };

    // Um bloqueio ativo vale antes de tudo, menos do pedido de gente: quem
    // errou o documento ainda pode falar com a equipe, que confere à mão.
    if (passo === PASSO_BLOQUEIO && Number(dados.ate) > agora) {
      if (pedeAtendente(texto)) return passarParaEquipe();
      await falar(t('whatsapp.platformBot.locked'));
      return { replied: true, intent: 'poLocked' };
    }

    const provedores = await candidatos(atual.wa_phone_e164, agora);
    if (provedores.length === 0) {
      // Um número que não é de provedor nenhum — um interessado, um dono que
      // cadastrou outro telefone: gente resolve, e o bot sai da frente.
      await bot.pausar(atual, new Date(agora + bot.PAUSA_ATENDENTE_MS));
      await falar(t('whatsapp.platformBot.unknownNumber'));
      return { replied: true, intent: 'atendente', from: 'unknownNumber' };
    }
    const porId = new Map(provedores.map((p) => [p.id, p]));

    const escolhendo = passo === PASSO_ESCOLHA && agora - desde < PASSO_VALIDADE_MS;
    const noDocumento = passo === PASSO_DOCUMENTO && agora - desde < PASSO_VALIDADE_MS && porId.has(Number(dados.t));
    const confirmado = passo === PASSO_MENU && Number(dados.ate) > agora && porId.has(Number(dados.t));

    if (pedeAtendente(texto) || (confirmado && opcaoDoMenu(texto) === 4)) return passarParaEquipe();

    // O gancho numérico, fora de um passo em andamento (ver o cabeçalho).
    const soNumero = /^\s*(\d{1,2})\s*$/.exec(texto);
    if (soNumero && !escolhendo && !noDocumento && ganchosNumericos.length) {
      for (const gancho of [...ganchosNumericos]) {
        let resultado = null;
        try {
          // eslint-disable-next-line no-await-in-loop -- um gancho por vez: o primeiro que reclamar leva
          resultado = await gancho({
            conversation: atual,
            text: texto,
            number: Number(soNumero[1]),
            tenantIds: provedores.map((p) => p.id),
            phone: atual.wa_phone_e164 ?? null
          });
        } catch (error) {
          console.warn('platformBot gancho:', error?.message || error);
          resultado = null;
        }
        if (resultado?.consumed) {
          const resposta = typeof resultado.reply === 'string' && resultado.reply.trim() ? resultado.reply : null;
          // eslint-disable-next-line no-await-in-loop
          if (resposta) await falar(resposta);
          return { replied: Boolean(resposta), intent: String(resultado.intent || 'numericHook').slice(0, 32) };
        }
      }
    }

    if (confirmado) return this.menu(atual, porId.get(Number(dados.t)), texto, falar);

    if (escolhendo) {
      const opcoes = Array.isArray(dados.opcoes) ? dados.opcoes.map(Number) : [];
      const escolhida = /^\s*(\d{1,2})(?:\D|$)/.exec(texto);
      const id = escolhida ? opcoes[Number(escolhida[1]) - 1] : null;
      if (id && porId.has(id)) return this.pedirDocumento(atual, porId.get(id), bot, falar, agora);
      return this.listar(atual, provedores, bot, falar, agora);
    }

    if (noDocumento) return this.conferir(atual, porId.get(Number(dados.t)), texto, bot, falar, agora);

    // Começo: um provedor só vai direto ao documento; vários, à lista.
    if (provedores.length === 1) return this.pedirDocumento(atual, provedores[0], bot, falar, agora);
    return this.listar(atual, provedores, bot, falar, agora);
  }

  static async listar(conversation, provedores, bot, falar, agora) {
    const lista = provedores.slice(0, MAX_PROVEDORES_NA_LISTA);
    await bot.gravarPasso(conversation, {
      bot_step: PASSO_ESCOLHA,
      bot_step_data: JSON.stringify({ opcoes: lista.map((p) => p.id) }),
      bot_step_at: new Date(agora)
    });
    const linhas = [t('whatsapp.platformBot.chooseProvider')];
    lista.forEach((p, i) => linhas.push(t('whatsapp.platformBot.providerOption', { n: i + 1, name: p.name })));
    await falar(linhas.join('\n'));
    return { replied: true, intent: 'poChooseProvider' };
  }

  static async pedirDocumento(conversation, provedor, bot, falar, agora) {
    if (provedor.taxId.length < DIGITOS_PEDIDOS) {
      // Sem documento de cobrança não há o que conferir: gente confere.
      await bot.gravarPasso(conversation, { bot_step: null, bot_step_data: null, bot_step_at: null });
      await bot.pausar(conversation, new Date(agora + bot.PAUSA_ATENDENTE_MS));
      await falar(t('whatsapp.platformBot.noTaxId', { name: provedor.name }));
      return { replied: true, intent: 'atendente', from: 'noTaxId' };
    }
    await bot.gravarPasso(conversation, {
      bot_step: PASSO_DOCUMENTO,
      bot_step_data: JSON.stringify({ t: provedor.id }),
      bot_step_at: new Date(agora)
    });
    await falar(t('whatsapp.platformBot.askTaxId', { name: provedor.name }));
    return { replied: true, intent: 'poAskTaxId' };
  }

  /** Os dígitos digitados: tentativa contada, conferência e, certa, o menu. */
  static async conferir(conversation, provedor, texto, bot, falar, agora) {
    const digitos = normalizeTaxId(texto);
    if (digitos.length < DIGITOS_PEDIDOS) {
      // Não é tentativa: "oi", "não sei", um número curto. Pede de novo.
      await falar(t('whatsapp.platformBot.askTaxIdAgain', { name: provedor.name }));
      return { replied: true, intent: 'poAskTaxId' };
    }

    if (digitosConferem(digitos, provedor.taxId)) {
      await bot.gravarPasso(conversation, {
        bot_step: PASSO_MENU,
        bot_step_data: JSON.stringify({ t: provedor.id, ate: agora + CONFIRMACAO_MS }),
        bot_step_at: new Date(agora),
        bot_doc_attempts: 0,
        bot_doc_window_at: null
      });
      await falar(t('whatsapp.platformBot.menu', { name: provedor.name }));
      return { replied: true, intent: 'poVerified' };
    }

    const janela = conversation.bot_doc_window_at ? new Date(conversation.bot_doc_window_at).getTime() : 0;
    const anteriores = agora - janela < JANELA_TENTATIVAS_MS ? Number(conversation.bot_doc_attempts || 0) : 0;
    const tentativas = anteriores + 1;
    if (tentativas >= TENTATIVAS) {
      await bot.gravarPasso(conversation, {
        bot_step: PASSO_BLOQUEIO,
        bot_step_data: JSON.stringify({ ate: agora + BLOQUEIO_MS }),
        bot_step_at: new Date(agora),
        bot_doc_attempts: 0,
        bot_doc_window_at: null
      });
      await falar(t('whatsapp.platformBot.locked'));
      return { replied: true, intent: 'poLocked' };
    }
    await bot.gravarPasso(conversation, {
      bot_doc_attempts: tentativas,
      bot_doc_window_at: anteriores > 0 ? new Date(janela) : new Date(agora)
    });
    await falar(t('whatsapp.platformBot.wrongTaxId', { remaining: TENTATIVAS - tentativas }));
    return { replied: true, intent: 'poWrongTaxId' };
  }

  /** O menu de quem já confirmou. */
  static async menu(conversation, provedor, texto, falar) {
    const opcao = opcaoDoMenu(texto);
    let mensagens = null;
    let intent = 'poMenu';
    try {
      if (opcao === 1) ({ mensagens, intent } = await this.segundaVia(conversation, provedor));
      else if (opcao === 2) ({ mensagens, intent } = await this.situacao(conversation, provedor));
      else if (opcao === 3) ({ mensagens, intent } = await this.recibo(conversation, provedor));
    } catch (error) {
      console.error(`platformBot opção ${opcao}:`, error?.message || error);
      mensagens = [t('whatsapp.platformBot.unavailable')];
      intent = 'poUnavailable';
    }
    if (!mensagens) {
      // Qualquer outra coisa ("menu", "oi", uma frase): o menu de novo.
      mensagens = [t('whatsapp.platformBot.menu', { name: provedor.name })];
    }
    for (const m of mensagens) {
      // eslint-disable-next-line no-await-in-loop -- a ordem das mensagens é a da leitura
      await falar(m);
    }
    return { replied: true, intent };
  }

  /** 1 — a segunda via da cobrança em aberto de vencimento mais próximo. */
  static async segundaVia(conversation, provedor) {
    const lido = await runInTenant(provedor.id, async () => {
      const abertas = (await BillingCharge.openAll())
        .filter((c) => ['pending', 'overdue'].includes(c.status) && c.gateway_charge_id)
        .sort((a, b) => String(diaDe(a.due_date) || '9999').localeCompare(String(diaDe(b.due_date) || '9999'))
          || Number(a.id) - Number(b.id));
      if (!abertas.length) return { abertas };
      try {
        return { abertas, info: await deps.paymentInfo(abertas[0].id) };
      } catch (error) {
        return { abertas, erro: error };
      }
    });
    if (!lido.abertas.length) {
      return { mensagens: [t('whatsapp.platformBot.noOpenInvoice', { name: provedor.name })], intent: 'poNoInvoice' };
    }
    const cobranca = lido.abertas[0];
    if (!lido.info) {
      console.warn('platformBot segunda via:', lido.erro?.code || lido.erro?.message);
      return { mensagens: [t('whatsapp.platformBot.unavailable')], intent: 'poUnavailable' };
    }
    const { info } = lido;
    const codigos = [
      ['whatsapp.platformBot.pixName', info.pix?.payload],
      ['whatsapp.platformBot.digitableName', info.boleto?.identificationField]
    ].filter(([, valor]) => valor);

    const topo = [t('whatsapp.platformBot.invoice', {
      name: provedor.name,
      amount: reais(info.amountCents),
      dueDate: dataBr(diaDe(info.dueDate) || diaDe(cobranca.due_date))
    })];
    if (info.invoiceUrl) topo.push('', t('whatsapp.platformBot.invoiceLink', { link: info.invoiceUrl }));
    if (lido.abertas.length > 1) topo.push('', t('whatsapp.platformBot.moreOpen', { count: lido.abertas.length }));
    if (codigos.length) {
      topo.push('', t('whatsapp.platformBot.invoiceSplitIntro', { list: codigos.map(([chave]) => t(chave)).join(', ') }));
    }

    await auditar(provedor, conversation, {
      what: 'invoice',
      chargeId: Number(cobranca.id),
      amountCents: Number(info.amountCents),
      sent: [info.invoiceUrl ? 'link' : null, info.pix?.payload ? 'pix' : null, info.boleto?.identificationField ? 'boleto' : null]
        .filter(Boolean)
    });
    return { mensagens: [topo.join('\n'), ...codigos.map(([, valor]) => String(valor))], intent: 'poInvoice' };
  }

  /** 2 — a situação da assinatura: plano, estado, próximo vencimento e valor. */
  static async situacao(conversation, provedor) {
    const lido = await runInTenant(provedor.id, async () => {
      const estado = await SubscriptionService.current();
      if (!estado?.subscription) return null;
      const visto = SubscriptionService.present(estado);
      const aberta = await BillingCharge.currentOpen();
      const preco = await SubscriptionService.effectivePriceCents(estado.subscription, estado.plan, { coupon: estado.coupon });
      return { visto, aberta, preco };
    });
    if (!lido) {
      return { mensagens: [t('whatsapp.platformBot.noSubscription', { name: provedor.name })], intent: 'poNoSubscription' };
    }
    const { visto, aberta, preco } = lido;
    const situacao = visto.reason === 'paused' ? 'paused' : visto.status;
    const chaveEstado = `whatsapp.platformBot.statusLabel.${situacao}`;
    const rotulo = t(chaveEstado);
    const linhas = [t('whatsapp.platformBot.status', {
      name: provedor.name,
      plan: visto.plan?.name || '—',
      status: rotulo === chaveEstado ? String(situacao) : rotulo
    })];
    const proximo = aberta?.due_date
      ? dataBr(diaDe(aberta.due_date))
      : dataBr(visto.status === 'trial' ? visto.trialEndsAt : visto.renewsAt);
    if (proximo) linhas.push(t('whatsapp.platformBot.statusNextDue', { date: proximo }));
    if (visto.billingExempt) linhas.push(t('whatsapp.platformBot.statusExempt'));
    else {
      const cents = aberta ? Number(aberta.amount_cents) : Number(preco);
      if (Number.isFinite(cents)) linhas.push(t('whatsapp.platformBot.statusAmount', { amount: reais(cents) }));
    }
    if (visto.cancelAt) linhas.push(t('whatsapp.platformBot.statusCancelAt', { date: dataBr(visto.cancelAt) }));
    if (visto.pausedUntil) linhas.push(t('whatsapp.platformBot.statusPausedUntil', { date: dataBr(visto.pausedUntil) }));
    linhas.push('', t('whatsapp.platformBot.footer'));

    await auditar(provedor, conversation, { what: 'status', status: situacao, openChargeId: aberta ? Number(aberta.id) : null });
    return { mensagens: [linhas.join('\n')], intent: 'poStatus' };
  }

  /** 3 — o recibo do último pagamento, por um link assinado de sete dias. */
  static async recibo(conversation, provedor) {
    const base = enderecoDaPlataforma();
    const lido = await runInTenant(provedor.id, async () => {
      const pagas = await tdb('billing_charges')
        .where({ status: 'paid' })
        .orderBy('period_end', 'desc')
        .orderBy('id', 'desc')
        .limit(1);
      if (!pagas.length) return null;
      // `receiptData` confere de novo que está paga, e dá o valor e a data.
      return receiptData(pagas[0].id);
    });
    if (!lido) return { mensagens: [t('whatsapp.platformBot.noReceipt', { name: provedor.name })], intent: 'poNoReceipt' };
    if (!base) return { mensagens: [t('whatsapp.platformBot.unavailable')], intent: 'poUnavailable' };

    const chargeId = Number(lido.charge.id);
    const token = signReceiptToken({ tenantId: provedor.id, chargeId }, deps.now());
    const link = `${base}/api/public/receipt/${token}`;
    await auditar(provedor, conversation, { what: 'receipt', chargeId });
    return {
      mensagens: [[
        t('whatsapp.platformBot.receipt', {
          amount: reais(lido.amountCents),
          date: dataBr(lido.paidAt) || '—',
          link
        }),
        '',
        t('whatsapp.platformBot.footer')
      ].join('\n')],
      intent: 'poReceipt'
    };
  }
}

export default PlatformOwnerBotService;
