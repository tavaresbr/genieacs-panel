import { PinnedTransport } from '../../utils/net/pinnedFetch.js';
import { IS_SAAS } from '../../config/edition.js';
import { effectiveApiKey, effectiveBaseUrl } from './asaasSettingsService.js';

/**
 * O cliente HTTP do gateway de pagamento — a única coisa deste repositório que
 * pede dinheiro a alguém.
 *
 * ## A credencial de SAÍDA não é a de entrada
 *
 * A entrega do webhook chega com `asaas-access-token`; a chamada que sai leva
 * `access_token`. São dois cabeçalhos diferentes com nomes parecidos, e
 * confundi-los dá 401 numa direção só — a direção que só é exercitada quando
 * alguém tenta cobrar de verdade. Conferido na documentação do gateway em
 * setembro de 2026, junto com as duas URLs base: `api.asaas.com/v3` em
 * produção e `api-sandbox.asaas.com/v3` no ambiente de testes, cada uma com a
 * sua família de chaves (`$aact_prod_…` e `$aact_hmlg_…`).
 *
 * ## Por que `PinnedTransport` e não `safeFetch`
 *
 * `safeFetch` destrói as opções que não conhece — `maxBytes` e `timeoutMs` ele
 * aceita, mas o destructuring dele é a lista inteira, e não há como pedir nada
 * além. Aqui é preciso o mesmo que o cliente do SGP precisa: resolver o nome
 * com prazo, conferir os endereços, e conectar NO ENDEREÇO conferido, para que
 * um DNS que muda de resposta entre a conferência e a conexão não mande a
 * chave da API para outro lugar.
 *
 * ## Sem retentativa aqui dentro
 *
 * A insistência é do job, que tem `attempts` no banco e sabe parar. Um retry
 * escondido no cliente transformaria "o gateway está fora do ar" em três
 * cobranças criadas quando ele voltar — que é o pior resultado possível, porque
 * quem paga é o cliente.
 */

/** Prazo da chamada inteira, da resolução do nome ao último byte. */
const TIMEOUT_MS = 20_000;

/** A resposta de uma cobrança é um objeto pequeno; um megabyte é folga larga. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** O corpo do erro refletido, truncado: é diagnóstico, não é log de tudo. */
const ERROR_BODY_LIMIT = 500;

export class AsaasError extends Error {
  constructor(message, { status = null, code = 'gateway_error' } = {}) {
    super(message);
    this.name = 'AsaasError';
    this.status = status;
    this.code = code;
  }
}

/**
 * A chave da API deste deploy, ou nulo. Lida a cada chamada: não se guarda.
 *
 * Assíncrona desde que a chave passou a poder vir do console — a caixa da
 * plataforma guarda o valor e o ambiente é só o que vale quando ela não tem
 * nada (ver `asaasSettingsService`). O cache curto de lá é o que impede isto
 * de virar uma leitura no banco por chamada.
 */
export async function apiKey() {
  return effectiveApiKey();
}

/**
 * A base da API, sem barra no fim: `ASAAS_BASE_URL` quando posta (é a porta do
 * teste), senão a do ambiente escolhido no console.
 */
export async function baseUrl() {
  return effectiveBaseUrl();
}

/**
 * Uma chamada à API do gateway.
 *
 * Quatro resultados distintos, e a distinção é o que decide o que o job faz:
 * credencial recusada (não adianta insistir), pedido recusado (idem, e o motivo
 * é do operador), erro do gateway (insistir adianta) e falha de transporte
 * (idem). O job trata todos como falha, mas o `last_error` da linha guarda qual
 * — e é o que alguém vai ler.
 */
async function chamar(caminho, { method = 'POST', payload = null } = {}) {
  const chave = await apiKey();
  if (!chave) throw new AsaasError('the Asaas API key is not configured', { code: 'not_configured' });

  const base = await baseUrl();
  let url;
  try {
    url = new URL(`${base}${caminho}`);
  } catch {
    throw new AsaasError(`ASAAS_BASE_URL is not a valid URL: ${base}`, { code: 'invalid_base_url' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AsaasError('ASAAS_BASE_URL must be http or https', { code: 'invalid_base_url' });
  }

  const corpo = payload === null ? null : JSON.stringify(payload);
  const sinal = AbortSignal.timeout(TIMEOUT_MS);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  // A recusa NOMEIA o que aprendeu, ao contrário da do SGP: lá o leitor é um
  // inquilino e "resolve para 10.0.0.5" seria o painel mapeando a rede privada
  // dele a pedido; aqui o leitor é quem opera a plataforma, e o endereço é a
  // informação que resolve o chamado.
  //
  // `allowPrivateAddresses` só fora do SaaS, que é o que deixa um teste apontar
  // a base para `127.0.0.1` sem abrir a porta no deploy hospedado.
  const addresses = await PinnedTransport.vetTarget(hostname, {
    signal: sinal,
    allowPrivateAddresses: !IS_SAAS,
    refuse: (motivo) => new AsaasError(motivo, { code: 'blocked_host' })
  });
  sinal.throwIfAborted();
  if (!addresses.length) {
    throw new AsaasError(`${hostname} did not resolve`, { code: 'unreachable' });
  }

  let resposta;
  try {
    resposta = await PinnedTransport.request({
      url,
      hostname,
      addresses,
      method,
      headers: {
        'Content-Type': 'application/json',
        // O painel se identifica: o gateway registra isso e é o que aparece do
        // lado de lá quando alguém pergunta quem abriu a cobrança.
        'User-Agent': 'TR69-Controle',
        access_token: chave
      },
      body: corpo,
      signal: sinal,
      maxBytes: MAX_RESPONSE_BYTES
    });
  } catch (error) {
    throw new AsaasError(`could not reach the gateway: ${error.message}`, { code: 'unreachable' });
  }

  // Um 3xx é erro duro e não se segue: a chave da API iria junto no salto.
  if (resposta.status >= 300 && resposta.status < 400) {
    throw new AsaasError(`gateway answered with a redirect (${resposta.status})`, {
      status: resposta.status, code: 'redirect'
    });
  }

  const texto = await resposta.text();
  if (!resposta.ok) {
    const codigo = resposta.status === 401 || resposta.status === 403
      ? 'unauthorized'
      : resposta.status < 500 ? 'refused' : 'gateway_error';
    throw new AsaasError(
      `gateway answered ${resposta.status}: ${texto.slice(0, ERROR_BODY_LIMIT)}`,
      { status: resposta.status, code: codigo }
    );
  }

  try {
    return JSON.parse(texto || '{}');
  } catch {
    throw new AsaasError('gateway answered with something that is not JSON', {
      status: resposta.status, code: 'bad_response'
    });
  }
}

/**
 * Cria a cobrança e devolve o que o painel precisa guardar.
 *
 * `billingType: 'UNDEFINED'` de propósito: devolve uma página onde quem paga
 * escolhe entre Pix e boleto, então um endereço só responde pelos dois meios —
 * e um ISP que prefere um ou outro não precisa que a plataforma adivinhe. Pedir
 * `PIX` fecharia a porta do boleto, que é como metade deste mercado paga.
 */
export async function createCharge({ customerRef, amountCents, currency = 'BRL', dueDate, description, reference }) {
  // O gateway é brasileiro e cobra em reais; ele não tem campo de moeda. Um
  // plano em outra moeda gravaria essa moeda na tabela e cobraria reais no
  // gateway — a cobrança sairia com o número certo e a unidade errada. Recusar
  // é a única resposta honesta enquanto não houver um gateway que aceite.
  const moeda = String(currency || 'BRL').toUpperCase();
  if (moeda !== 'BRL') {
    throw new AsaasError(`this gateway only charges in BRL; the plan is in ${moeda}`, {
      code: 'unsupported_currency'
    });
  }

  const resposta = await chamar('/payments', {
    payload: {
      customer: customerRef,
      billingType: 'UNDEFINED',
      // O gateway fala em reais; o painel guarda centavos, como toda coluna de
      // dinheiro daqui. A conversão mora neste ponto e em nenhum outro.
      value: Number((amountCents / 100).toFixed(2)),
      dueDate,
      description,
      externalReference: reference
    }
  });

  const chargeId = String(resposta?.id ?? '').trim();
  if (!chargeId) {
    throw new AsaasError('gateway created something without an id', { code: 'bad_response' });
  }
  return {
    chargeId,
    invoiceUrl: resposta?.invoiceUrl ? String(resposta.invoiceUrl) : null,
    dueDate: resposta?.dueDate ? String(resposta.dueDate).slice(0, 10) : null,
    status: resposta?.status ? String(resposta.status) : null
  };
}

/**
 * Cancela (apaga) uma cobrança no gateway — `DELETE /payments/{id}`.
 *
 * Existe para a troca de plano feita pelo próprio provedor: a cobrança do
 * período já emitida saiu com o preço velho, e deixá-la viva ao lado da nova
 * seria pôr duas faturas do mesmo mês na mão de quem paga — e a primeira a ser
 * paga, pelo valor errado.
 *
 * **404 é sucesso.** O que se quer é que a cobrança não exista mais do lado de
 * lá, e "não existe" é exatamente isso: alguém a apagou no painel do gateway,
 * ou uma tentativa anterior apagou e a resposta se perdeu. Tratar como erro
 * travaria a troca de plano por uma cobrança que já não incomoda ninguém.
 *
 * O id vai codificado no caminho: ele veio do gateway, mas mora no nosso banco,
 * e um caractere de caminho nele mudaria QUAL recurso se apaga.
 *
 * @returns {Promise<{ deleted: boolean, alreadyGone: boolean }>}
 */
export async function cancelCharge(chargeId) {
  const id = String(chargeId ?? '').trim();
  if (!id) throw new AsaasError('no gateway charge id to cancel', { code: 'bad_request' });
  try {
    const resposta = await chamar(`/payments/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { deleted: resposta?.deleted !== false, alreadyGone: false };
  } catch (error) {
    if (error instanceof AsaasError && error.status === 404) return { deleted: true, alreadyGone: true };
    throw error;
  }
}

/**
 * Confere se a chave responde, e em nome de quem — o botão "Testar conexão" do
 * console.
 *
 * `GET /myAccount/commercialInfo` é a leitura que devolve o NOME da conta, e o
 * nome é o que faz o teste valer alguma coisa: "conectou" com a chave do
 * sandbox de um colega também conecta, e só o nome mostra que a chave é da
 * conta certa. Se o gateway não conhecer esse caminho (404), o saldo serve de
 * segunda leitura: autentica igual, só não diz de quem é. Qualquer outra
 * recusa — 401 sobretudo — sobe como está, porque é ela a resposta do teste.
 *
 * @returns {Promise<{accountName: string|null}>}
 */
export async function testConnection() {
  try {
    const conta = await chamar('/myAccount/commercialInfo', { method: 'GET' });
    const nome = conta?.companyName || conta?.name || conta?.tradingName || null;
    return { accountName: nome ? String(nome) : null };
  } catch (error) {
    if (!(error instanceof AsaasError) || error.status !== 404) throw error;
  }
  await chamar('/finance/balance', { method: 'GET' });
  return { accountName: null };
}

/**
 * Cria o cliente no gateway e devolve o id dele — o `billing_customer_ref` que
 * o console grava no provedor.
 *
 * O corpo vem pronto de quem chama (o cadastro fiscal, traduzido para os nomes
 * do gateway): este arquivo é transporte e não sabe o que é um CNPJ. O que ele
 * garante é o mesmo de `createCharge` — um id na volta, ou um erro.
 *
 * @returns {Promise<{customerId: string}>}
 */
export async function createCustomer(payload) {
  const resposta = await chamar('/customers', { payload });
  const customerId = String(resposta?.id ?? '').trim();
  if (!customerId) {
    throw new AsaasError('gateway created a customer without an id', { code: 'bad_response' });
  }
  return { customerId };
}

export default { createCharge, cancelCharge, createCustomer, testConnection, apiKey, baseUrl, AsaasError };
