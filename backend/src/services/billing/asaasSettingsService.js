import crypto from 'node:crypto';
import AppState from '../../models/AppState.js';
import Tenant from '../../models/Tenant.js';
import { runInTenant } from '../../config/tenantContext.js';
import { createSecretBox } from '../../utils/secretBox.js';

/**
 * A conta da plataforma no Asaas, configurada pelo console — e não só pelo
 * `.env`.
 *
 * ## Por que sair do ambiente
 *
 * Até aqui a chave da API e o token do webhook eram variáveis de ambiente, e a
 * única maneira de trocar a chave (que o gateway obriga a trocar quando alguém
 * a vaza, e que muda de família ao sair do sandbox para produção) era abrir um
 * terminal no servidor e reiniciar o processo. Quem opera a cobrança é quem
 * opera o console, e essa pessoa não tem — nem deveria ter — ssh.
 *
 * ## O banco ganha, o ambiente continua valendo
 *
 * O valor guardado pelo console tem precedência; a variável de ambiente é o
 * que vale quando o console nunca gravou nada. É o que mantém de pé o deploy
 * que já cobrava antes desta tela existir: ninguém precisa migrar nada no dia
 * da atualização, e o dia em que alguém grava pelo console é o dia em que o
 * `.env` deixa de mandar — visível na própria tela, que diz de onde cada valor
 * vem (`db` ou `env`).
 *
 * ## Onde mora
 *
 * No `app_state` da caixa da plataforma, que é o molde do servidor Evolution
 * compartilhado (`whatsappConfigService.readEffectiveConfig`): um segredo que é
 * da PLATAFORMA e não de provedor nenhum precisa de um dono no schema, e a
 * caixa existe exatamente para isso. Sem caixa — um self-hosted, ou uma SaaS
 * que ainda não a criou — só o ambiente vale, e gravar é recusado com um erro
 * que diz o porquê em vez de guardar o segredo no provedor errado.
 *
 * Os dois segredos vão cifrados, cada um no envelope `{ v: 1, ...box.encrypt() }`
 * que `secretRotationService` sabe re-cifrar — a entrada dele está em `BLOBS`,
 * e esquecê-la seria o primeiro segredo do painel a ficar de fora da rotação.
 * Uma caixa só para os dois: eles moram no mesmo blob, são da mesma conta e
 * têm o mesmo raio de estrago — quem lê um lê o outro.
 */

export const CONFIG_KEY = 'asaas_gateway_config';
export const SECRET_CONTEXT = 'skygenpanel-asaas-gateway-v1';

export const ENVIRONMENTS = Object.freeze(['sandbox', 'production']);

/** As duas bases, conferidas na documentação do gateway em setembro de 2026. */
export const BASE_URLS = Object.freeze({
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3'
});

/** Tetos de tamanho. Uma chave do Asaas tem perto de 170 caracteres. */
const API_KEY_MAX = 1024;
const WEBHOOK_TOKEN_MAX = 255;

/**
 * Quanto tempo o blob lido fica em memória.
 *
 * Curto de propósito: o job de emissão pergunta por isto a cada provedor, a
 * cada minuto, e cada pergunta seria uma leitura no banco — mas num deploy com
 * mais de um processo a gravação invalida só o processo que gravou, e quinze
 * segundos é o tempo máximo que os outros ficam falando com a chave velha.
 */
const CACHE_TTL_MS = 15_000;

const box = createSecretBox(SECRET_CONTEXT);

let cache = null;

/** Esquece o que foi lido. Exportado para os testes e para quem grava. */
export function invalidateAsaasSettings() {
  cache = null;
}

export class AsaasSettingsError extends Error {
  constructor(message, { code = 'invalid', status = 400 } = {}) {
    super(message);
    this.name = 'AsaasSettingsError';
    this.code = code;
    this.status = status;
  }
}

function envValue(nome) {
  const valor = String(process.env[nome] ?? '').trim();
  return valor.length ? valor : null;
}

function selar(valor) {
  return { v: 1, ...box.encrypt(valor) };
}

/** O segredo aberto, ou nulo — inclusive quando a chave da caixa não o abre. */
function abrir(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const valor = box.decrypt(envelope);
  return valor ? String(valor) : null;
}

/**
 * O blob guardado, e de qual caixa. `platformId` nulo quer dizer "não há onde
 * guardar", que é diferente de "não há nada guardado".
 */
async function lerGuardado() {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const caixa = await Tenant.platform();
  let stored = null;
  if (caixa) {
    const bruto = await runInTenant(caixa.id, () => AppState.get(CONFIG_KEY));
    if (bruto) {
      try {
        const lido = JSON.parse(bruto);
        stored = lido && typeof lido === 'object' ? lido : null;
      } catch {
        // Um blob ilegível é tratado como ausente: o ambiente volta a valer, e
        // a próxima gravação pelo console o reescreve inteiro.
        stored = null;
      }
    }
  }
  const value = { platformId: caixa?.id ?? null, stored };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/**
 * Os valores que valem agora, com a origem de cada um.
 *
 * O ambiente PADRÃO é a parte com história. Um deploy que já cobrava pelo
 * `.env` falava com `api.asaas.com` — produção —, porque era a base fixa do
 * cliente; então uma chave vinda do ambiente, sem ambiente escolhido no
 * console, continua sendo produção. Sem chave nenhuma, o padrão é o sandbox:
 * quem está configurando pela primeira vez está testando, e errar para o lado
 * do sandbox custa uma cobrança de mentira, não uma de verdade.
 */
async function resolver() {
  const { platformId, stored } = await lerGuardado();

  const chaveDb = abrir(stored?.apiKey);
  const chaveEnv = envValue('ASAAS_API_KEY');
  const tokenDb = abrir(stored?.webhookToken);
  const tokenEnv = envValue('BILLING_WEBHOOK_TOKEN');

  const apiKey = chaveDb ?? chaveEnv;
  const apiKeySource = chaveDb ? 'db' : chaveEnv ? 'env' : null;
  const webhookToken = tokenDb ?? tokenEnv;
  const webhookTokenSource = tokenDb ? 'db' : tokenEnv ? 'env' : null;

  let environment;
  if (ENVIRONMENTS.includes(stored?.environment)) environment = stored.environment;
  else if (apiKeySource === 'env') environment = 'production';
  else environment = 'sandbox';

  return {
    platformId,
    environment,
    apiKey,
    apiKeySource,
    webhookToken,
    webhookTokenSource,
    updatedAt: stored?.updatedAt ?? null
  };
}

/** O que a tela pode ver: de onde vem cada coisa, nunca o valor. */
export async function readPublic() {
  const efetivo = await resolver();
  return {
    environment: efetivo.environment,
    apiKeyConfigured: Boolean(efetivo.apiKey),
    apiKeySource: efetivo.apiKeySource,
    webhookTokenConfigured: Boolean(efetivo.webhookToken),
    webhookTokenSource: efetivo.webhookTokenSource,
    updatedAt: efetivo.updatedAt
  };
}

/** A chave com que o painel CHAMA o gateway, ou nulo. */
export async function effectiveApiKey() {
  return (await resolver()).apiKey;
}

/** O token que o gateway manda de volta na entrega do webhook, ou nulo. */
export async function effectiveWebhookToken() {
  return (await resolver()).webhookToken;
}

/** O ambiente que vale, `sandbox` ou `production`. */
export async function effectiveEnvironment() {
  return (await resolver()).environment;
}

/**
 * A base da API, sem barra no fim.
 *
 * `ASAAS_BASE_URL` ganha de tudo, e continua sendo o que era: a porta para o
 * teste apontar o cliente para um servidor de mentira em `127.0.0.1`. Fora
 * disso a base sai do ambiente escolhido — que é o motivo de o ambiente ser um
 * campo da tela e não uma URL: a URL errada para a chave certa dá 401, e dois
 * valores fixos não têm como sair errados.
 */
export async function effectiveBaseUrl() {
  const forcada = envValue('ASAAS_BASE_URL');
  if (forcada) return forcada.replace(/\/+$/, '');
  return BASE_URLS[await effectiveEnvironment()];
}

/**
 * Normaliza um segredo recebido da tela. `undefined` mantém, `''` (ou nulo)
 * apaga, e o resto é o valor novo, aparado.
 */
function segredoDoPatch(valor, { nome, max }) {
  if (valor === undefined) return undefined;
  if (valor === null) return '';
  if (typeof valor !== 'string') throw new AsaasSettingsError(`${nome} must be a string`);
  const aparado = valor.trim();
  if (aparado.length > max) throw new AsaasSettingsError(`${nome} is too long`);
  // Um segredo com espaço ou quebra de linha no meio é quase sempre uma colagem
  // que levou junto o texto em volta — e ele iria para um cabeçalho HTTP, onde
  // uma quebra de linha nem é permitida.
  if (/\s/.test(aparado)) throw new AsaasSettingsError(`${nome} must not contain whitespace`);
  return aparado;
}

/**
 * Grava. Campo ausente não é tocado; presente e vazio apaga — e apagar aqui
 * devolve a palavra ao `.env`, se ele tiver o valor.
 *
 * @returns o mesmo que `readPublic`, já com o que foi gravado, mais o que mudou.
 */
export async function save(patch = {}) {
  const environment = patch.environment === undefined ? undefined : patch.environment;
  if (environment !== undefined && !ENVIRONMENTS.includes(environment)) {
    throw new AsaasSettingsError(`environment must be one of ${ENVIRONMENTS.join(', ')}`, {
      code: 'invalid_environment'
    });
  }
  const apiKey = segredoDoPatch(patch.apiKey, { nome: 'apiKey', max: API_KEY_MAX });
  const webhookToken = segredoDoPatch(patch.webhookToken, { nome: 'webhookToken', max: WEBHOOK_TOKEN_MAX });

  // Lido sem o cache: a gravação parte do que está no banco agora, e não do
  // que estava há quinze segundos — senão duas gravações seguidas de campos
  // diferentes perderiam a primeira.
  invalidateAsaasSettings();
  const { platformId, stored } = await lerGuardado();
  if (!platformId) {
    throw new AsaasSettingsError(
      'There is no platform box in this deployment to store the gateway settings in',
      { code: 'no_platform_tenant', status: 409 }
    );
  }

  const anterior = stored ?? {};
  const proximo = {
    v: 1,
    environment: ENVIRONMENTS.includes(anterior.environment) ? anterior.environment : null,
    apiKey: anterior.apiKey ?? null,
    webhookToken: anterior.webhookToken ?? null,
    updatedAt: anterior.updatedAt ?? null
  };
  if (environment !== undefined) proximo.environment = environment;
  if (apiKey !== undefined) proximo.apiKey = apiKey ? selar(apiKey) : null;
  if (webhookToken !== undefined) proximo.webhookToken = webhookToken ? selar(webhookToken) : null;
  proximo.updatedAt = new Date().toISOString();

  await runInTenant(platformId, () => AppState.upsert(CONFIG_KEY, JSON.stringify(proximo)));
  invalidateAsaasSettings();

  return {
    settings: await readPublic(),
    changed: {
      environment: environment !== undefined && environment !== anterior.environment,
      apiKey: apiKey !== undefined,
      webhookToken: webhookToken !== undefined
    }
  };
}

/**
 * Cunha um token de webhook novo, grava e o devolve — a única vez em que ele
 * sai do servidor. 32 bytes do CSPRNG em base64url: cabe num cabeçalho sem
 * escapar nada e está dentro do tamanho que o gateway aceita.
 */
export async function generateWebhookToken() {
  const webhookToken = crypto.randomBytes(32).toString('base64url');
  const { settings } = await save({ webhookToken });
  return { webhookToken, settings };
}

export default {
  readPublic,
  effectiveApiKey,
  effectiveWebhookToken,
  effectiveEnvironment,
  effectiveBaseUrl,
  save,
  generateWebhookToken,
  invalidateAsaasSettings
};
