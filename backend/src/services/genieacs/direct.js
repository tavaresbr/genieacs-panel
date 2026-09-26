import { AsyncLocalStorage } from 'node:async_hooks';
import Setting from '../../models/Setting.js';
import { getDb } from '../../config/database.js';
import { TranslatableError } from '../../i18n/index.js';
import GenieAcsEgress from '../genieacsEgress.js';
import GenieAcsAuthService from '../genieacsAuthService.js';
import { withAcsSlot } from './concurrency.js';

/**
 * O modo `direct`: o painel fala HTTP com a NBI do provedor.
 *
 * É o único modo que existe hoje, e é o caso normal do self-hosted — a NBI na
 * mesma rede, alcançável. Os outros três do plano (agente, túnel, hospedagem
 * própria) entram como irmãos deste arquivo, implementando a mesma superfície,
 * sem que `DeviceService` saiba da diferença.
 *
 * Aqui moram os cinco passos que estavam repetidos em sete lugares: montar a
 * URL a partir da raiz configurada, pôr a credencial, abrir o prazo, pegar a
 * vaga de concorrência e sair pelo egresso com pinagem de DNS. Cada um deles
 * tem uma razão escrita no seu ponto de origem; o que este arquivo acrescenta é
 * que agora eles acontecem **sempre**, e não sempre-que-alguém-lembrar.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A tag de equipamentos do provedor, num GenieACS COMPARTILHADO.
 *
 * O desenho original é um ACS por provedor, e nele o endereço basta para
 * separar as frotas. Quando vários provedores apontam para o MESMO ACS, o
 * endereço não separa nada: cada um veria — e poderia reiniciar, apagar,
 * resetar — a frota de todos. A tag é o que separa: com ela definida, o
 * provedor só enxerga e só age em equipamento que carrega essa tag.
 *
 * Quem grava é a plataforma, pelo console (`platformGenieAcsController`). Vazia
 * é o comportamento de sempre: ACS exclusivo, ou instalação própria.
 */
export const DEVICE_SCOPE_KEY = 'deviceScopeTag';
export const DEVICE_SCOPE_TAG_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** `{ ...query }` com a busca original E a tag, ou só a tag. */
export function mergeScopeQuery(rawQuery, tag) {
  let base = null;
  if (rawQuery !== undefined && rawQuery !== null && String(rawQuery).trim() !== '') {
    base = typeof rawQuery === 'string' ? JSON.parse(rawQuery) : rawQuery;
  }
  const escopo = { _tags: tag };
  const temBase = base && typeof base === 'object' && Object.keys(base).length > 0;
  return JSON.stringify(temBase ? { $and: [base, escopo] } : escopo);
}

/**
 * Sem o escopo do provedor, só dentro de `fn`. Existe para UMA coisa: a
 * ferramenta da plataforma que marca com a tag os equipamentos que ainda não
 * têm dono — que, por definição, o filtro não deixaria ver.
 */
const semEscopo = new AsyncLocalStorage();
export function withoutDeviceScope(fn) {
  return semEscopo.run(true, fn);
}

const naoEncontrado = () => new TranslatableError('device.notFound', null, { status: 404, code: 'device_not_found' });

class DirectConnector {
  static mode = 'direct';

  /** A URL configurada para este provedor, sem normalizar. */
  static async baseUrl() {
    const settings = await Setting.getAll();
    return settings.genieAcsUrl;
  }

  /**
   * A raiz da NBI: esquema, host e porta, sem caminho, busca ou fragmento.
   *
   * Recusa credenciais embutidas na URL e esquema que não seja HTTP(S). As duas
   * recusas são antigas e continuam aqui e não no chamador, porque é aqui que a
   * URL vira destino — quem chama passa um caminho e não escolhe host nenhum.
   */
  static async rootUrl() {
    const baseUrl = await this.baseUrl();
    if (!baseUrl) {
      throw new Error('GenieACS URL not configured');
    }
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('GenieACS URL must use HTTP or HTTPS');
    }
    if (url.username || url.password) {
      throw new Error('Credentials in the GenieACS URL are not supported');
    }
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  }

  /**
   * O destino de um caminho relativo à raiz.
   *
   * **A raiz decide o host; o caminho nunca.** O `endpoint` que chega aqui já
   * teve seus segmentos escapados por quem o montou, e é concatenado depois de
   * ter as barras iniciais removidas — de modo que um caminho absoluto, ou um
   * que comece com `//`, não consegue trocar o servidor. Foi exatamente esse o
   * buraco fechado quando o branch de URL absoluta saiu de `buildGenieAcsUrl`:
   * qualquer chamador que deixasse passar um endpoint controlado por terceiro
   * alcançava um host que o operador nunca configurou.
   */
  static async urlFor(endpoint = '', query = {}) {
    const root = await this.rootUrl();
    const caminho = String(endpoint ?? '').replace(/^\/+/, '');
    const url = new URL(caminho ? `${root}/${caminho}` : root);
    for (const [chave, valor] of Object.entries(query || {})) {
      if (valor !== undefined && valor !== null) {
        url.searchParams.set(chave, String(valor));
      }
    }
    return url;
  }

  /**
   * Uma requisição à NBI, com os cinco passos aplicados.
   *
   * Devolve a `Response` crua de propósito. Três dos sete chamadores precisam
   * de mais do que o corpo — um lê um header de contagem, dois toleram 404 —, e
   * um conector que só devolvesse JSON os obrigaria a montar a requisição por
   * fora, que é como os cinco passos se perdem de novo.
   */
  static async request(endpoint = '', {
    query = {},
    method = 'GET',
    body = null,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    unscoped = false
  } = {}) {
    // O escopo do provedor vem ANTES de montar a URL: é aqui, e só aqui, que
    // toda conversa com o ACS passa — lista, detalhe, tarefa, tag, falha.
    // `unscoped` é só para o próprio conector (a conferência de posse) e para
    // a ferramenta da plataforma que marca equipamentos ainda sem dono.
    if (!unscoped && !semEscopo.getStore()) {
      const tag = await this.scopeTag();
      if (tag) query = await this.applyScope(tag, endpoint, String(method || 'GET').toUpperCase(), query);
    }
    const url = await this.urlFor(endpoint, query);

    // O prazo E a credencial ficam DEPOIS de a vaga sair, dentro do callback.
    //
    // Antes ele era armado aqui em cima, e a vaga só era pedida no `withAcsSlot`
    // lá embaixo — mas a fila de concorrência espera sem prazo nenhum. Com seis
    // vagas por provedor e uma varredura de frota segurando as suas por
    // segundos, a sétima requisição gastava os 15 s inteiros ESPERANDO e era
    // abortada sem nunca ter aberto socket. Nada distingue esse aborto de um
    // ACS mudo, então o operador lia "o ACS não respondeu" sobre um ACS que
    // ninguém tinha perguntado nada.
    //
    // O prazo mede o que ele diz medir: a requisição.
    //
    // A credencial desceu junto pelo mesmo motivo, e agora importa mais: com a
    // espera na fila podendo ser longa, lê-la antes de entrar na fila seria
    // usar o valor de quando a requisição foi ENFILEIRADA. Ela é lida quando a
    // requisição vai sair — e continua vindo de `nbiHeaders`, que é o único
    // lugar que a monta.
    return withAcsSlot(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const options = {
          method,
          headers: await GenieAcsAuthService.nbiHeaders(headers),
          signal: controller.signal,
          // Nunca seguir 3xx: um host autorizado que responde com redirecionamento
          // está tentando levar a requisição a um lugar que ninguém autorizou, e
          // seguir seria desfazer a guarda de egresso depois de ela ter passado.
          redirect: 'manual'
        };
        if (body !== null && body !== undefined) {
          options.headers['Content-Type'] = 'application/json';
          options.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        return await GenieAcsEgress.fetch(url, options);
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  /** A tag de equipamentos deste provedor, ou `null` quando o ACS é só dele. */
  static async scopeTag() {
    const raw = String((await Setting.getByKey(DEVICE_SCOPE_KEY)) ?? '').trim();
    return DEVICE_SCOPE_TAG_PATTERN.test(raw) ? raw : null;
  }

  /**
   * As tags de TODOS os provedores. Leitura fora do escopo de propósito: é o
   * que impede um provedor de pôr (ou tirar) a tag de outro num equipamento.
   */
  static async allScopeTags() {
    // tenant-scope-exempt: as tags de TODOS os provedores, para que um não ponha
    // nem tire a de outro. Atravessa provedores de propósito, e o filtro por
    // `tenant_id` diz quais — os que existem.
    const rows = await getDb()('settings')
      .where({ key: DEVICE_SCOPE_KEY })
      .whereIn('tenant_id', getDb()('tenants').select('id'))
      .select('value');
    return new Set(rows.map((row) => String(row.value ?? '').trim()).filter(Boolean));
  }

  /** O equipamento é deste provedor? Senão, "não encontrado" — nunca "é de outro". */
  static async assertOwned(tag, deviceId) {
    const id = String(deviceId ?? '');
    if (!id) throw naoEncontrado();
    const response = await this.request(this.collectionPath('devices'), {
      unscoped: true,
      query: { query: JSON.stringify({ _id: id, _tags: tag }), projection: '_id' }
    });
    if (!response.ok) throw naoEncontrado();
    const text = await response.text();
    const rows = text ? JSON.parse(text) : [];
    if (!Array.isArray(rows) || rows.length === 0) throw naoEncontrado();
  }

  /**
   * Aplica a tag do provedor a uma requisição.
   *
   * - Leitura da coleção de equipamentos: a busca ganha `_tags = tag`.
   * - Qualquer coisa num equipamento (`devices/<id>/...`: tarefa, tag, apagar):
   *   antes, o equipamento tem que ser do provedor.
   * - Tag de provedor num equipamento: ninguém põe nem tira pela API do painel.
   * - Falha (`faults/<device>:<canal>`): o equipamento da falha tem que ser dele.
   * - Fila de tarefas de um equipamento: idem.
   */
  static async applyScope(tag, endpoint, method, query = {}) {
    const caminho = String(endpoint ?? '').replace(/^\/+/, '');
    const partes = caminho.split('/');

    if (partes[0] === 'devices') {
      if (partes.length === 1 || partes[1] === '') {
        if (method !== 'GET') throw naoEncontrado();
        return { ...query, query: mergeScopeQuery(query?.query, tag) };
      }
      const deviceId = decodeURIComponent(partes[1]);
      if (partes[2] === 'tags' && partes[3] !== undefined) {
        const alvo = decodeURIComponent(partes[3]);
        if ((await this.allScopeTags()).has(alvo) || alvo === tag) {
          throw new TranslatableError('device.scopeTagProtected', null, { status: 403, code: 'scope_tag_protected' });
        }
      }
      await this.assertOwned(tag, deviceId);
      return query;
    }

    if (partes[0] === 'faults' && partes[1]) {
      const faultId = decodeURIComponent(partes[1]);
      const corte = faultId.lastIndexOf(':');
      await this.assertOwned(tag, corte > 0 ? faultId.slice(0, corte) : faultId);
      return query;
    }

    if (partes[0] === 'tasks' && query?.query) {
      let filtro = {};
      try { filtro = JSON.parse(query.query); } catch { filtro = {}; }
      if (typeof filtro.device === 'string') await this.assertOwned(tag, filtro.device);
      return query;
    }

    return query;
  }

  /**
   * O caminho de uma coleção, com o nome conferido.
   *
   * O nome vem de código nosso em todos os chamadores de hoje, e a conferência
   * existe para o dia em que não vier: um nome com barra ou ponto-ponto sairia
   * da coleção e viraria outro caminho na mesma NBI.
   */
  static collectionPath(collection) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(collection))) {
      throw new Error('Invalid GenieACS collection name');
    }
    return String(collection);
  }
}

export default DirectConnector;
