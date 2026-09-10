import Setting from '../../models/Setting.js';
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
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    const url = await this.urlFor(endpoint, query);
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
      return await withAcsSlot(async () => GenieAcsEgress.fetch(url, options));
    } finally {
      clearTimeout(timeoutId);
    }
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
