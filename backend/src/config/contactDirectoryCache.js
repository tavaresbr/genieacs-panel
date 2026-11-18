import { TenantCache } from './tenantCache.js';
import { hasTenantContext } from './tenantContext.js';

/**
 * A memória de `WaContactService.gather`: a lista de contatos inteira de uma
 * busca, por provedor.
 *
 * `gather` é a leitura mais cara da tela de contatos — até 5 mil linhas de
 * `sgp_links`, 50 mil de `sgp_contacts`, as fichas com consulta da TeiaH e os
 * documentos do Asaas, tudo ordenado em memória — e roda de novo a cada
 * página, a cada filtro clicado e a cada exportação, com a mesma resposta.
 * Trinta segundos bastam para paginar e filtrar sem reler o banco.
 *
 * Quem a invalida não é cada escritor, lembrando: é `watchContactDirectoryWrites`,
 * ligado no knex por `getDb`, que vê TODO `INSERT`/`UPDATE`/`DELETE` que sai
 * para as tabelas que a lista lê — pelo modelo, por um `tdb` solto num serviço,
 * por uma importação, pela fixture de um teste. Lembrar em cada escritor já
 * falhou antes neste código (é o argumento do `TenantCache`), e as escritas
 * nessas quatro tabelas estão espalhadas por uma dúzia de arquivos.
 *
 * O que o vigia NÃO vê: a configuração do Asaas, que mora em `app_state` e
 * decide o "também no Asaas" — `AsaasProviderService.invalidateConfigCache`
 * chama `invalidateContactDirectory` à mão. E a escrita dentro de transação é
 * vista ANTES do commit; quem apaga em transação (a exclusão do titular)
 * invalida de novo depois dele. O TTL curto é a rede para o resto.
 */
export const CONTACT_DIRECTORY_TTL_MS = 30_000;

/** Quantas buscas diferentes um provedor guarda — digitar cria uma por letra. */
export const CONTACT_DIRECTORY_MAX_SEARCHES = 8;

export const contactDirectoryCache = new TenantCache(CONTACT_DIRECTORY_TTL_MS);

/**
 * O diretório de contatos mudou: esquece a memória.
 *
 * Do provedor em escopo quando há um; de todos quando não há (trabalho sem
 * provedor — a exclusão pelo console, uma migração), porque aí não dá para
 * saber de quem era a linha, e esquecer demais só custa uma releitura.
 */
export function invalidateContactDirectory() {
  if (hasTenantContext()) contactDirectoryCache.invalidate();
  else contactDirectoryCache.clear();
}

/** As tabelas que `gather` lê. Escrever em qualquer uma muda a lista. */
const DIRECTORY_TABLES = ['sgp_links', 'sgp_contacts', 'sgp_clients', 'asaas_customers'];

// O começo de uma escrita nos três dialetos: aspas duplas (Postgres, SQLite),
// crase (MySQL) ou nenhuma (um `raw` escrito à mão). `insert or replace` e
// `insert ignore` também contam.
const WRITE_TO_DIRECTORY = new RegExp(
  `^\\s*(?:insert(?:\\s+or\\s+\\w+|\\s+ignore)?\\s+into|update|delete\\s+from)\\s+["\`]?(?:${DIRECTORY_TABLES.join('|')})["\`]?(?![A-Za-z0-9_])`,
  'i'
);

/** Se o SQL é uma escrita numa tabela do diretório. Exportado para o teste. */
export function writesContactDirectory(sql) {
  return typeof sql === 'string' && WRITE_TO_DIRECTORY.test(sql);
}

/** Esquece a memória de um provedor pelo id, ou de todos com `null`. */
function forget(tenantId) {
  if (tenantId === null || tenantId === undefined) contactDirectoryCache.clear();
  else contactDirectoryCache.entries.delete(tenantId);
}

/** Onde `tdb`/`tinsert` anotam no construtor o provedor que o montou. */
const DIRECTORY_TENANT = Symbol('contactDirectoryTenant');

/**
 * Anota no construtor o provedor de quem escreve. Chamado por `tdb` e
 * `tinsert`, que montam o construtor DENTRO do escopo do provedor.
 *
 * É preciso porque os eventos do knex chegam do callback do driver (do pool),
 * já fora do contexto assíncrono de quem pediu a consulta: ali
 * `currentTenantId()` não sabe mais de quem era. O `query-response` entrega o
 * construtor junto, e a anotação viaja nele.
 */
export function tagDirectoryBuilder(builder, table, tenantId) {
  if (DIRECTORY_TABLES.includes(table) && builder && typeof builder === 'object') {
    builder[DIRECTORY_TENANT] = tenantId;
  }
  return builder;
}

/**
 * Liga o vigia no knex.
 *
 * `query-response`, DEPOIS que a escrita voltou: invalidar antes deixaria uma
 * janela em que uma leitura começada entre o aviso e a gravação guardaria a
 * lista velha por trinta segundos. Uma leitura que já estava voando é a
 * promessa guardada, e sai junto. A escrita que falhou não mudou nada.
 *
 * O provedor vem da anotação do construtor; sem ela — o `getDb()` cru de uma
 * fixture, um `raw` —, esquece todos: errar para o lado de reler.
 */
export function watchContactDirectoryWrites(knex) {
  knex.on('query-response', (_response, query, builder) => {
    if (!writesContactDirectory(query?.sql)) return;
    forget(builder?.[DIRECTORY_TENANT] ?? null);
  });
  return knex;
}
