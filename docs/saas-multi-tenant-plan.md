# Plano: transformar o SkyGenPanel em SaaS multi-tenant

## Contexto

O SkyGenPanel hoje é **single-tenant por construção**: um install = um provedor. Vamos
comercializá-lo como SaaS, onde cada cliente é um **provedor de internet (tenant)** com seus
próprios operadores, seus próprios assinantes, seu próprio GenieACS e seu próprio plano.

Não existe hoje **nenhuma** noção de tenant no código — nenhuma coluna, nenhum middleware,
nenhuma query filtrada por dono. Tudo é global: um `.env`, um banco, uma linha
`settings.genieAcsUrl`, um blob `app_state.sgp_integration_config`, um `map_settings` com
`id=1` fixo, e uma tabela `users` cujo `username` é único globalmente e cujo `role` só
recebe `'admin'`. Não há nem API de gestão de usuários.

O objetivo é chegar a um deploy único capaz de atender dois provedores diferentes **sem
qualquer possibilidade de um enxergar dados do outro**, com onboarding self-service,
planos com limites e suspensão por inadimplência.

### Decisões já tomadas

| Tema | Decisão |
| --- | --- |
| Isolamento | **Banco compartilhado + `tenant_id`** (pool model) |
| GenieACS | **Todos os modos**: URL+credenciais, agente conector, VPN/túnel e hospedagem própria → conector **plugável**, MVP com modo direto |
| Domínio | **Subdomínio por tenant** (`provedor.dominio` / `portal.provedor.dominio`) |
| Cobrança | **Planos e limites no código agora; gateway de pagamento depois** |

### Licença

O upstream (`skydashnet/genieacs-panel`) é **MIT** — uso comercial é permitido, mas o
arquivo `LICENSE` e o aviso de copyright da SkydashNET devem ser mantidos no produto.

---

## Estado atual relevante

- **Backend**: Node ESM + Express 5 + **Knex 3** (sem ORM, **sem sistema de migrations**).
  Schema aplicado imperativamente no boot por `ensureSchema()` em `backend/src/config/schema.js`.
- **Dois listeners no mesmo processo**: painel (`app`, 5890) e portal do assinante
  (`portalApp`, 5891) — `backend/src/app.js`, `backend/src/server.js`.
- **Banco**: SQLite padrão, MySQL opcional, **trocado em runtime pela UI de Settings**
  (`backend/src/services/dbManagementService.js`, `backend/src/routes/database.js`).
- **Acesso a dados**: 13 classes estáticas finas em `backend/src/models/*.js`, todas sobre
  um único `getDb()` (`backend/src/config/database.js`). Isso é a boa notícia: os pontos de
  inserção do filtro de tenant são poucos e bem definidos.
- **GenieACS**: URL única em `settings.genieAcsUrl`, resolvida em
  `DeviceService.getGenieAcsRootUrl()` (`backend/src/services/deviceService.js:117`).
  **Nenhum header de autenticação é enviado** e credenciais na URL são explicitamente
  rejeitadas — assume-se NBI em loopback/rede privada.
- **Auth operador**: JWT bearer, `backend/src/middleware/auth.js`, payload
  `{userId, username, role, tokenVersion}`, `audience: 'skygenpanel-admin'`.
- **Auth assinante**: cookie `skygp_portal_session`, `backend/src/middleware/portalAuth.js`,
  login resolve **só por `customer_id`** (`customerPortalController.login:27`).

### Achados críticos para o multi-tenant

1. **Três caches globais em memória** que hoje vazariam dados entre provedores:
   - `DeviceService.dashboardCache` (`deviceService.js:28`) — objeto único, serviria o
     dashboard do provedor A para o B. Persistido em `app_state.dashboard_snapshot`.
   - `CustomerPortalController.overviewCache` (`customerPortalController.js:16`) — chaveado
     só por `account.id`.
   - `SgpService.configCache` (`sgpService.js:163`) — config SGP única.
2. **Uniques globais** que se tornam colisão entre tenants: `users.username`,
   `customer_accounts.customer_id` / `device_id` / `identity_hash`, `device_profiles.device_id`,
   `sgp_links.device_id`, `mapping_nodes.node_id`, `mapping_edges.edge_id`.
3. **Login do portal cruzaria tenants**: dois provedores com o mesmo `customer_id` gerado
   (o prefixo `CSG` é só cosmético) autenticariam no lugar errado.
4. **Sequestro de conta via `identity_hash`** — pior que a colisão acima.
   `identity_hash = sha256(softwareId, pppoe_username)` (`customerService.js:41`) e
   `CustomerService.ensureAccount` (`customerService.js:110`) faz
   `getByIdentityHash(...)` → `CustomerAccount.touch(existente.id, deviceId)`, ou seja
   **re-aponta a conta encontrada para o novo `device_id`**. Dois provedores rodando o mesmo
   firmware Huawei com um assinante `cliente01` geram o mesmo hash — sem unique composta, o
   sync do provedor B sequestra a conta do provedor A. Não é vazamento de leitura: é
   corrupção de dados.
5. **`dbManagementService.copyData` apaga o destino inteiro**
   (`dbManagementService.js:78` — `trx(table).del()` em toda `COPY_TABLES` antes do insert).
   Num deploy compartilhado, um admin de **um** provedor clicando "migrar para MySQL"
   truncaria os dados de **todos**. Isso torna a remoção dessa rota da edição SaaS um item de
   Fase 0, não de Fase 7.
6. **`secretBox` deriva a chave do `JWT_SECRET`** (`backend/src/utils/secretBox.js:12`) e
   `decrypt` **retorna `null` silenciosamente** em falha — rotacionar o `JWT_SECRET`
   destruiria de forma irreversível e sem erro toda senha de portal, toda senha de WiFi
   guardada e todo token SGP, de todos os tenants.
7. **SSRF já presente no código atual**, três pontos concretos em
   `backend/src/services/deviceService.js`:
   `buildGenieAcsUrl` aceita `endpoint` absoluto e **ignora a base configurada**
   (`if (/^https?:\/\//i.test(endpoint)) { urlStr = endpoint }`, :183);
   `fetchGenieAcsCollection` devolve o **corpo do erro upstream ao cliente** (:158), o que é
   um oráculo de leitura; e nenhum `redirect: 'manual'` é definido, então um host público
   permitido pode redirecionar para `127.0.0.1`.
8. **Obstáculos de schema para as uniques compostas**:
   `mapping_edges.source/target` são FKs **string** apontando para `mapping_nodes.node_id`
   (`schema.js:101-102`) — tornar `node_id` único só por `(tenant_id, node_id)` quebra essas
   FKs; e `wifi_security_config.product_class` **não tem unique nenhuma** hoje
   (`schema.js:69`), um bug latente de duplicata.

---

## Arquitetura alvo

```
                      ┌─────────────────────────────────────┐
  *.painel.dominio ──▶│  tenantResolver (Host → tenant)     │
  *.portal.dominio ──▶│  auth (JWT com tenantId)            │
                      │  requireActiveSubscription          │
                      │  tenantStore.run({tenantId}, ...)   │  ← AsyncLocalStorage
                      └──────────────┬──────────────────────┘
                                     │
                     ┌───────────────┴───────────────┐
                     │  tdb(table) → sempre filtrado │  ← models nunca chamam getDb() direto
                     └───────────────┬───────────────┘
                                     │
                       PostgreSQL (todos os tenants)
                                     │
                     ┌───────────────┴───────────────┐
                     │  GenieACS Connector (por tenant)│
                     │  direct | agent | tunnel | hosted│
                     └───────────────────────────────┘
```

Duas **edições** a partir de um só código, chaveadas por `EDITION=saas|selfhosted`:
a edição self-hosted preserva o instalador, o wizard de primeiro uso, o seletor de banco
e o GenieACS em rede privada; a edição SaaS desliga tudo isso.

---

## Fases

### Fase 0 — Fundação: migrations reais e banco do SaaS *(esforço: médio)*

Sem migrations versionadas não dá para evoluir o schema de um SaaS em produção.

- Introduzir **knex migrations**: `backend/knexfile.js` + `backend/migrations/`.
- Migration `001_baseline` reproduz exatamente o schema atual. Para installs existentes,
  o boot roda `ensureSchema()` uma última vez e marca a baseline como aplicada
  (`knex.migrate.latest()` a partir daí). `ensureSchema()` deixa de crescer.
- **Banco do SaaS: PostgreSQL.** Motivo principal: `RLS` (Row Level Security) é a única
  defesa estrutural real contra vazamento no modelo de banco compartilhado, e Postgres tem
  índices parciais/uniques compostos com `NULL` que vamos precisar nos catálogos.
  Custo honesto: é um terceiro dialeto. Ajustes concretos necessários:
  - `insert()` retornando id — hoje `const [id] = await getDb()(...).insert(...)` funciona em
    sqlite/mysql; no Postgres exige `.returning('id')`. Criar helper
    `insertReturningId(table, row)` em `backend/src/config/database.js` e trocar nos ~13 models.
  - booleanos (`active`, `enabled`) e `db.fn.now()` — validar por dialeto.
- Manter SQLite/MySQL apenas na edição self-hosted.

**Dois itens de segurança que precisam entrar já aqui, antes de existir um segundo tenant:**

- **Desmontar `/api/database` na edição SaaS.** Pelo achado 5 acima, essa rota apaga o banco
  inteiro. Introduzir a flag `EDITION` (`backend/src/config/edition.js`) já na Fase 0 e usá-la
  para não montar `backend/src/routes/database.js` no SaaS — assim nunca há uma janela em que
  ela exista num deploy compartilhado.
- **Separar `SECRET_BOX_KEY` do `JWT_SECRET`** em `backend/src/utils/secretBox.js`, com
  fallback para o `JWT_SECRET` nos installs existentes, e adicionar `key_version` em todo
  conjunto de colunas cifradas (`customer_accounts`, `customer_wifi_credentials`, e a nova
  `tenant_genieacs_connections`). É uma coluna inteira hoje e uma retro-migration horrível
  daqui a dois anos.

- Arquivos: `backend/src/config/schema.js`, `backend/src/config/database.js`,
  `backend/src/config/dbConfig.js`, `backend/src/utils/secretBox.js`,
  `backend/src/app.js`, novo `backend/src/config/edition.js`, todos os `backend/src/models/*.js`.

**Breaking para self-hosted?** Não, se a baseline for aplicada corretamente.

---

### Fase 1 — Modelo de tenant e scoping estrutural *(esforço: alto — é o coração)*

#### Novas tabelas

| Tabela | Conteúdo |
| --- | --- |
| `tenants` | id, slug (UNIQUE, vira o subdomínio), nome, cnpj, status, branding (nome, logo, cores), created_at |
| `tenant_users` | tenant_id, user_id, role (`owner`/`admin`/`tech`/`viewer`), status, UNIQUE(tenant_id,user_id) |
| `tenant_invites` | tenant_id, email, role, token_hash, expires_at, accepted_at |
| `plans` | code, nome, max_devices, max_operators, max_subscribers, features (json) |
| `subscriptions` | tenant_id, plan_id, status, trial_ends_at, current_period_end |
| `platform_admins` | user_id — plano de controle do SaaS (nós) |
| `audit_log` | tenant_id, actor_user_id, ação, alvo, ip, payload, created_at |
| `tenant_genieacs_connections` | ver Fase 4 |

#### `users` continua global, membership é a ponte

`users` vira **identidade** (email UNIQUE global, não mais `username`), e `tenant_users`
liga a pessoa ao provedor com um papel. Isso permite que um consultor/revenda atenda vários
provedores com um só login — cenário comum no mercado de ISP brasileiro.

#### Tabelas que ganham `tenant_id NOT NULL`

`customer_accounts`, `device_profiles`, `sgp_links`, `customer_wifi_credentials`
(desnormalizado a partir de `account_id`, para o filtro ser direto), `mapping_nodes`,
`mapping_edges`, `map_settings` (deixa de ser singleton `id=1`), `settings` (PK vira
`(tenant_id, key)`), `app_state` (PK vira `(tenant_id, key)`).

#### Uniques que viram compostos

`(tenant_id, customer_id)`, `(tenant_id, device_id)`, `(tenant_id, identity_hash)`,
`(tenant_id, node_id)`, `(tenant_id, edge_id)`, `(tenant_id, device_id)` em `device_profiles`
e `sgp_links`. Aproveitar para criar a unique que falta em
`wifi_security_config`: `(tenant_id, product_class)`.

Duas consequências que não são opcionais:

- **`mapping_edges` precisa trocar de FK.** Hoje `source` e `target` são strings referenciando
  `mapping_nodes.node_id` (`schema.js:101-102`). Assim que `node_id` deixar de ser único
  sozinho, essas FKs não têm mais alvo válido. Substituir por FK inteira para
  `mapping_nodes.id` (mais limpo) ou por FK composta `(tenant_id, node_id)`.
- **`identity_hash` não deve ser re-salgado com o tenant.** A unique composta já resolve a
  colisão; re-salgar forçaria reescrever todas as linhas existentes sem ganho.

Regra geral a seguir em toda migration nova: **toda unique e todo índice de tabela de tenant
começa por `tenant_id`** — a Fase 8 tem um teste que verifica isso por introspecção.

#### Catálogos: cópia por tenant no provisionamento

`vendors`, `wifi_security_mappings`, `wifi_security_config` recebem `tenant_id NOT NULL`, e
o catálogo de fabricantes é **copiado para o tenant quando ele é criado**.

A alternativa tentadora — `tenant_id NULL` significando "global", com override por tenant —
é melhor de produto (corrigimos um path de parâmetro ZTE uma vez e todo mundo recebe), mas
custa a invariante que sustenta todo o mecanismo anti-vazamento: *toda linha de toda tabela
de tenant tem `tenant_id NOT NULL`*. Com a exceção do `NULL`, cada query escopada vira
`WHERE (tenant_id = ? OR tenant_id IS NULL)` — exatamente o tipo de nuance que depois
cresce um vazamento, e que quebra o teste estrutural da Fase 8.

São ~30 linhas por tenant. O preço é que melhorias no catálogo chegam aos tenants existentes
por migration de backfill ou por um botão "atualizar catálogo" no console de plataforma —
aceitável. Reavaliar para o modelo global+override só depois que o console existir.

#### Migração do install existente

Migration de dados que cria `tenants` id=1 a partir do `settings.appName` atual, seta
`tenant_id = 1` em tudo, move `genieAcsUrl` para `tenant_genieacs_connections`, cria a
`subscription` e converte o admin atual em `owner`. Nenhum dado perdido.

**Armadilha do SQLite — a parte mais arriscada da migration.** O SQLite não faz
`DROP CONSTRAINT`; o knex emula `dropUnique` recriando a tabela. Como o pool liga
`PRAGMA foreign_keys = ON` no `afterCreate` (`backend/src/config/dbConfig.js:63`), recriar
`mapping_nodes` dispara o `ON DELETE CASCADE` e **apaga todas as arestas do mapa do cliente**.
A migration precisa, só no dialeto SQLite:

1. `PRAGMA foreign_keys = OFF` **fora de qualquer transação** (dentro de uma, o pragma é no-op);
2. criar `*_new` com o schema alvo e `INSERT INTO ... SELECT ..., 1 AS tenant_id FROM antiga`;
3. `DROP` + `ALTER TABLE ... RENAME`;
4. `PRAGMA foreign_key_check`, e só então `PRAGMA foreign_keys = ON`.

Postgres e MySQL seguem o caminho fácil de `ALTER TABLE`. Escrever com um switch em
`knex.client.config.client` e **exercitar contra um dump real de um install 1.13 no CI**,
não só contra um fixture sintético — `backend/test/migration.test.js` já tem o padrão
(`startTestServers({ beforeSchema })`).

#### Mecanismo anti-vazamento — o ponto mais importante do plano

Confiar em lembrar de escrever `.where('tenant_id')` em 13 arquivos **não é aceitável**
para um produto comercial. Proposta em três camadas:

**(a) Contexto implícito por requisição** — `backend/src/config/tenantContext.js`:

```js
import { AsyncLocalStorage } from 'node:async_hooks'

export const tenantStore = new AsyncLocalStorage()

export function currentTenantId() {
  const id = tenantStore.getStore()?.tenantId
  if (!id) throw new Error('Operação sem tenant no contexto')  // falha fechado
  return id
}
```

**(b) Handle de banco já escopado** — em `backend/src/config/database.js`:

```js
const TENANT_TABLES = new Set([
  'settings', 'app_state', 'map_settings', 'mapping_nodes', 'mapping_edges',
  'customer_accounts', 'device_profiles', 'sgp_links', 'customer_wifi_credentials'
])
const CATALOG_TABLES = new Set(['vendors', 'wifi_security_mappings', 'wifi_security_config'])

export function tdb(table) {
  const q = getDb()(table)
  if (TENANT_TABLES.has(table)) return q.where(`${table}.tenant_id`, currentTenantId())
  if (CATALOG_TABLES.has(table)) {
    const t = currentTenantId()
    return q.where((b) => b.where(`${table}.tenant_id`, t).orWhereNull(`${table}.tenant_id`))
  }
  return q
}

export function tinsert(table, row) {           // injeta tenant_id em todo insert
  return getDb()(table).insert(
    Array.isArray(row)
      ? row.map((r) => ({ ...r, tenant_id: currentTenantId() }))
      : { ...row, tenant_id: currentTenantId() }
  )
}
```

Todos os models trocam `getDb()('tabela')` por `tdb('tabela')`. Como o `where` já vem
aplicado, esquecer o filtro deixa de ser possível — e uma chamada fora de contexto
**lança exceção** em vez de retornar dados de todo mundo.

Escopo real dessa troca: **65 chamadas `getDb()(...)`, todas confinadas aos 13 arquivos de
`backend/src/models/`**. Nenhum controller ou service acessa o banco direto — é por isso que
essa abordagem é viável aqui e o guarda automatizado da letra (c) consegue ser absoluto.

**(c) Guardas automatizados**
- Teste de análise estática (`backend/test/tenant-scoping.test.js`) que varre
  `backend/src/models/` e `backend/src/services/` e **falha** se encontrar
  `getDb()('<tabela de tenant>')`.
- Regra ESLint `no-restricted-syntax` equivalente no lint do backend.
- **RLS no Postgres** como segunda linha (recomendado, pode ficar na Fase 8): `SET LOCAL
  app.tenant_id` por transação + policies por tabela. Custo: exige transação/conexão dedicada
  por requisição — avaliar impacto no pool antes de ligar.

#### Caches globais → por tenant (obrigatório nesta fase)

- `DeviceService.dashboardCache` → `Map<tenantId, cache>`; `app_state.dashboard_snapshot`
  já fica por tenant via PK composta.
- `CustomerPortalController.overviewCache` → chave `${tenantId}:${accountId}`.
- `SgpService.configCache` → `Map<tenantId, config>`, com `invalidateConfigCache(tenantId)`.

#### `dbManagementService.COPY_TABLES`

O array em `dbManagementService.js:7` precisa listar toda tabela nova — ou o serviço inteiro
sai da edição SaaS (ver Fase 7). Recomendo **remover da edição SaaS** e manter no self-hosted.

---

### Fase 2 — Autenticação, RBAC e gestão de equipe *(esforço: médio-alto)*

- `backend/src/middleware/auth.js`: payload do JWT ganha `tenantId`, `role` (do
  `tenant_users`, não mais de `users.role`) e `membershipVersion` para revogação.
  `authenticateToken` passa a carregar a membership e a abrir o `tenantStore`.
- Papéis reais substituindo a string `'admin'`: `owner` (dono, cobrança), `admin`,
  `tech` (opera ONTs, não mexe em configuração), `viewer`. `requireRole` vira
  `requirePermission` com um mapa papel→permissões.
- **Plano de plataforma** (nós, operando o SaaS): audience separada
  `skygenpanel-platform`, rotas `/api/platform/*`, capaz de listar/suspender tenants e de
  fazer *impersonation* auditada. Nunca compartilha o mesmo token do operador.
- **API de usuários que hoje não existe**: convidar, listar, trocar papel, remover —
  `backend/src/routes/team.js` + `backend/src/controllers/teamController.js`.
- **Portal do assinante**: `CustomerAccount.getByCustomerId` passa a receber o tenant;
  login resolve `(tenant_id, customer_id)`. O cookie precisa ser **host-only** (sem
  `domain=.dominio`) para não vazar sessão entre subdomínios de provedores diferentes —
  ajustar `portalCookieOptions` em `backend/src/middleware/portalAuth.js`, e incluir
  `tenantId` no payload assinado.
- `rateLimit.js`: chavear por `${tenantId}:${ip}` para um provedor barulhento não derrubar
  o limite dos outros.
**Quebra para os self-hosted atuais:** o login sai de `username` para `email`. Mitigação: a
migration preenche `email = username` quando parecer e-mail e `username@local.invalid` caso
contrário, e o endpoint de login aceita os dois formatos por uma release, com aviso de
"confirme seu e-mail" na interface.

---

### Fase 3 — Resolução de tenant por subdomínio *(esforço: baixo-médio)*

- Novo `backend/src/middleware/tenantResolver.js`, montado em `backend/src/app.js`
  **antes das rotas**, nos dois apps (`app` e `portalApp`):
  resolve o slug do header `Host` → carrega o tenant → 404 se não existir → guarda no
  `tenantStore`. Se o JWT também trouxer `tenantId` e ele **divergir** do host, retorna 403
  (impede trocar de tenant só reusando o token em outro subdomínio).
- Rotas públicas por host: `/api/tenant/public` devolve branding (nome, logo, cores) para a
  tela de login carregar já com a marca do provedor.
- Infra: DNS wildcard `*.painel.dominio` e `*.portal.dominio` + TLS wildcard.
  `CORS_ORIGINS` vira validação por padrão de host, não lista fixa
  (`isAllowedOrigin` em `backend/src/app.js`).
- Domínio próprio do provedor (`painel.provedor.com.br`) fica para depois: tabela
  `tenant_domains` + emissão automática de certificado.
- **Frontend praticamente não muda aqui**: `frontend/src/lib/api.ts` já usa base relativa
  (mesma origem), então o subdomínio resolve sozinho.

---

### Fase 4 — Conectividade GenieACS plugável *(esforço: alto — maior risco técnico)*

Como você quer suportar os quatro modos, o certo é abstrair antes de implementar o segundo.

Nova tabela `tenant_genieacs_connections`: `tenant_id`, `mode`
(`direct`|`agent`|`tunnel`|`hosted`), `base_url`, `auth_type` (`none`|`basic`|`bearer`),
`username`, segredo cifrado com `createSecretBox('genieacs-nbi')`, `verify_tls`,
`allow_private_ranges` (só liberável por nós), `status`, `last_check_at`.

Novo módulo `backend/src/services/genieacs/` com a interface
`connector.fetch(collection, query, method, body)`; `DeviceService` deixa de montar URL e
passa a pedir o conector do tenant. Pontos exatos a refatorar em
`backend/src/services/deviceService.js`: `getGenieAcsUrl` (:112), `getGenieAcsRootUrl` (:117),
`getDevicesBaseUrl` (:144), `fetchGenieAcsCollection` (:148), `buildGenieAcsUrl` (:189),
`fetchFromGenieAcs` (:203) — mais `getVirtualParameters` (:133), que passa a ler do
`settings` já escopado.

**MVP — modo `direct`**, com endurecimento obrigatório (hoje inexistente):
- Enviar `Authorization` (Basic/Bearer) — o código atual **não manda header nenhum**.
- **Fechar os três buracos de SSRF já presentes** (achado 7): remover o branch de URL
  absoluta em `buildGenieAcsUrl` (:183), truncar/omitir o corpo do erro upstream devolvido ao
  cliente em `fetchGenieAcsCollection` (:158), e definir `redirect: 'manual'` rejeitando 3xx.
- **Guarda de egresso**: resolver o DNS nós mesmos, **bloquear faixas privadas, loopback,
  link-local, CGNAT e ULA IPv6**, e então conectar ao **IP resolvido e fixado** enviando o
  `Host` — só checar se o hostname "parece privado" não fecha DNS rebinding. Mais allowlist
  de portas e o timeout já existente (15s). Na edição self-hosted a faixa privada continua
  liberada (é o caso normal lá) — daí o flag por edição.
- Em produção, rotear todo o egresso ACS por um proxy/NAT dedicado sem acesso à nossa VPC.
  Além de defesa em profundidade, dá ao provedor um IP fixo para colocar em allowlist — o que
  é argumento de venda.
- Botão "testar conexão" já existe (`POST /api/settings/test-genieacs`) e passa a validar
  também credenciais e alcance.

**Muro de escala que precisa ser resolvido nesta fase.** `refreshDashboardData` →
`getDashboardDevices()` (`deviceService.js:288`) busca a **coleção inteira de dispositivos** do
GenieACS, com TTL de 60s e um prewarm no boot (`server.js:37`). Um provedor com 20 mil ONTs já
é um parse de vários MB por minuto; multiplicado por dezenas de tenants, um processo Node não
sustenta. Antes do décimo tenant:
- tirar o refresh do caminho da requisição para um job agendado com **offset por tenant**
  (hash do id no minuto) e **TTL adaptativo** (60s com operador logado, 5 min ocioso);
- teto de concorrência de fetch ACS global e por tenant;
- não atualizar tenants suspensos nem sem login nas últimas 24h;
- avaliar uma tabela `devices_summary` para o dashboard ler do banco, não do ACS.

**Roadmap dos outros modos** (mesma interface, sem reescrever o `DeviceService`):
- `agent`: agente instalado no provedor abre WebSocket **de saída** para o SaaS; o conector
  multiplexa requisição/resposta por cima. Nada exposto na internet — é o modo mais seguro e
  o que eu recomendaria como padrão comercial depois do MVP.
- `tunnel`: WireGuard/Cloudflare Tunnel — reutiliza o conector `direct` com
  `allow_private_ranges` ligado. Custo é operacional (setup manual por cliente), não de código.
- `hosted`: nós provisionamos o GenieACS; o conector `direct` aponta para a nossa rede interna.

---

### Fase 5 — Planos, limites e ciclo de vida da assinatura *(esforço: médio)*

- Middleware `requireActiveSubscription` logo após o `tenantResolver`: `trial` e `active`
  passam; `past_due` passa em modo somente-leitura; `suspended`/`canceled` retornam 402 com
  código legível para o frontend mostrar a tela de bloqueio.
  **O portal do assinante deve continuar de pé em `past_due`** — derrubar o autoatendimento
  dos clientes finais do provedor por atraso de fatura é um tiro no pé comercial.
- Limites verificados nos pontos de escrita: criação de operador (`teamController`), criação
  de conta de assinante (`backend/src/services/customerService.js` → `syncDevices`), e
  contagem de ONTs vinda do GenieACS (query de count no conector).
- Tabela `billing_events` e uma interface `BillingProvider` já definidas agora, com
  implementação `ManualBillingProvider` (nós marcamos pago). Quando o gateway entrar,
  recomendo **Asaas** (Pix + boleto + cartão, é o padrão do mercado de ISP brasileiro) com
  webhook chamando o mesmo `subscriptions.status`.
- Console de plataforma para nós: criar tenant, mudar plano, suspender, ver uso.

---

### Fase 6 — Frontend *(esforço: médio-alto)*

- `frontend/src/contexts/tenant-context.tsx`: carrega `/api/tenant/public` no boot e provê
  branding + plano + limites.
- Branding por tenant substitui o `settings.appName` global —
  `frontend/src/components/brand-mark.tsx` passa a ler do contexto.
- Telas novas: **cadastro/onboarding** (nome do provedor, escolha do subdomínio, conexão
  GenieACS, convite da equipe), **configurações do provedor**, **equipe/usuários**,
  **plano e uso**, **console de plataforma** (rota protegida por papel de plataforma;
  não vale a pena um terceiro bundle Vite agora).
- `frontend/src/pages/setup.tsx` (wizard de primeiro uso) fica **só na edição self-hosted**;
  no SaaS o equivalente é o onboarding pós-cadastro.
- A seção de troca de banco em `frontend/src/pages/settings.tsx` sai da edição SaaS.
- i18n: as strings novas entram em `frontend/src/lib/i18n/locales/{pt-BR,en,es}.ts`, com
  pt-BR como idioma primário; o tipo em `dictionary.ts` faz o `npm run typecheck` acusar
  chave faltando nos outros dois.
- **Resíduos do upstream indonésio a corrigir junto**, já que são texto e metadado que o
  cliente final do provedor vê: as mensagens hardcoded em
  `backend/src/controllers/customerPortalController.js`
  (`'ID Customer atau password salah'`, `'Login pelanggan berhasil'`), o
  `<html lang="id">` em **`frontend/index.html` e `frontend/portal.html`**, e o centro padrão
  do mapa em Jacarta (`-6.2088, 106.8456`, `backend/src/config/seed.js:56`) — que no
  provisionamento passa a ser definido por tenant no onboarding.

---

### Fase 7 — Operação e as duas edições *(esforço: médio)*

- Flag `EDITION=saas|selfhosted` lida em `backend/src/app.js`, controlando: rotas de cadastro,
  `backend/src/routes/database.js` (troca de banco), wizard de setup, permissão de faixas IP
  privadas no conector, e o console de plataforma.
- Self-hosted continua com `deploy/install.sh` + CLI `deploy/skygenpanel` + SQLite/MySQL.
  SaaS usa o `Dockerfile` + Postgres gerenciado + migrations no CI.
- Observabilidade: `tenant_id` em toda linha de log e em toda métrica; `audit_log` para ações
  sensíveis (troca de senha de portal, alteração de conexão GenieACS, impersonation).
- Backup e **procedimento de exportação/exclusão por tenant** — necessário para LGPD e para
  cancelamento de contrato.

---

### Fase 8 — Provar o isolamento *(esforço: médio — não é opcional)*

Nada vai para dois provedores reais antes disto passar.

**Suíte de vazamento** (`backend/test/tenant-isolation.test.js`), sobre o
`backend/test/helpers/harness.js` existente: cria **dois tenants com chaves naturais
deliberadamente colidindo** — mesmo `customer_id`, mesmo `device_id`, mesmo `identity_hash`,
mesmo `node_id` nos dois — e então, para cada recurso:

1. listagem como A nunca contém id de B;
2. `GET /:id` com id de B, como A → **404, não 403** (403 confirma que o recurso existe);
3. `PUT`/`DELETE` com id de B, como A → 404 e a linha de B intacta;
4. login no portal de A com o `customer_id` **e a senha** de B → 401;
5. cookie de sessão de A replayado no host do portal de B → 401;
6. token de operador de A enviado ao host de B → 403;
7. **regressão de cache**: A abre o dashboard, depois B — o payload de B tem que vir do ACS
   de B, não do cache de A;
8. **regressão de cache SGP**: A grava uma config SGP; B lê `/api/sgp/config` e não pode ver
   nada de A.

**Testes estruturais** — baratos e pegam classes inteiras de bug de uma vez:

- introspecção após `migrate:latest`: **toda tabela** existe em `TENANT_TABLES ∪ GLOBAL_TABLES`
  (uma migration que esquecer de classificar uma tabela nova falha o CI);
- **toda tabela de tenant** tem `tenant_id NOT NULL`, FK para `tenants` e índice começando por
  `tenant_id`;
- **toda unique de tabela de tenant começa por `tenant_id`** — só esse teste teria pego as seis
  uniques compostas da Fase 1;
- **sentinela de SQL**: em `APP_ENV=test`, `db.on('query')` lança se o SQL tocar uma tabela de
  tenant sem `tenant_id` nos bindings. Ligar para a **suíte inteira já existente**
  (`auth.test.js`, `customer-portal.test.js`, `sgp.test.js`, `portal-password-admin.test.js`,
  `rate-limit.test.js`), de modo que todo teste legado vira também teste de escopo.

**Testes por model** (`backend/test/tenant-scoping.test.js`): para cada um dos 13 models,
gravar em A e em B e conferir a leitura cruzada; e afirmar que **todo método público lança
`TenantScopeError` fora de contexto de tenant**. Essa última asserção é o teste de melhor
custo-benefício da suíte inteira.

`backend/test/helpers/harness.js` ganha `seedTenant({slug})` e `asTenant(tenantId, fn)`; o
`Host` pode ser enviado no `fetch` porque os listeners sobem em 127.0.0.1.

---

## Riscos principais

1. **Uma leitura cruzada silenciosa.** E o caminho mais provável não é um `WHERE` esquecido —
   é um cache estático ou um job de fundo que não herda contexto nenhum. Por isso o
   `currentTenantId()` **lança** quando não há contexto, e por isso os testes 7 e 8 da Fase 8
   existem. Um incidente desses encerra o negócio: provedores concorrentes conversam nos
   mesmos grupos.
2. **Sequestro de conta por `identity_hash`** (achado 4) — não é vazamento de leitura, é
   corrupção: o sync de um provedor re-aponta a conta de outro. Resolvido pela unique composta
   na Fase 1, mas é o motivo de essa migration não poder sair pela metade.
3. **`/api/database` num deploy compartilhado** (achado 5) — um clique de um cliente apaga os
   dados de todos. Por isso está na Fase 0 e não na 7.
4. **Conectividade GenieACS é ao mesmo tempo a maior objeção de venda e a maior superfície de
   ataque.** "Preciso abrir a 7557 pra internet?" perde negócios; e liberar URL arbitrária sem
   a guarda de egresso com IP fixado constrói um proxy de SSRF com tela de login. Tratar o
   agente conector como *quando*, não *se*.
5. **`JWT_SECRET` é hoje a chave de cifra de todos os segredos** e a decifra falha em silêncio
   (`decrypt` devolve `null`). Rotacionar o segredo — operação de rotina — destruiria de forma
   irreversível senhas de portal, senhas de WiFi e tokens SGP de todos os tenants. Fase 0.
6. **O muro de escala do dashboard** (`deviceService.js:288` + `server.js:37`): a coleção
   inteira de dispositivos a cada 60s por tenant. Chega por volta de 15–25 tenants, ou seja,
   exatamente quando o negócio começa a funcionar.
7. **A migration de rebuild no SQLite** — seis tabelas com FK, o `PRAGMA foreign_keys` e dados
   reais de cliente. Tem que ser exercitada contra um dump 1.13 real no CI.
8. **A Fase 2 quebra o login dos self-hosted atuais** (username → e-mail). Precisa da janela de
   compatibilidade e de uma nota de release clara.
9. **LGPD** — passamos a ser **operador** de dados pessoais de assinantes de terceiros (nome,
   CPF/CNPJ via `sgp_links.document`, endereço, credenciais PPPoE, senhas de WiFi recuperáveis
   em claro), sendo o provedor o **controlador**. Contrato com cláusula de operador, política
   de retenção/exclusão e compromisso de notificação de incidente precisam estar prontos
   **antes do primeiro contrato**. Some-se a isso a emissão de **NFS-e** para vender B2B a
   CNPJ — resolver com emissor terceiro, não construir.
10. **Escopo escapando para hospedar o GenieACS.** É o melhor produto de longo prazo e a via
    mais rápida para nunca lançar. Manter fora até depois da Fase 7.

## Dimensionamento

Os arquivos que concentram o trabalho, por tamanho atual:
`backend/src/services/deviceService.js` (1583 linhas — Fase 4),
`frontend/src/pages/settings.tsx` (1579 — Fases 5/6/7),
`frontend/src/pages/device-detail.tsx` (1939 — pouco afetado),
`frontend/src/pages/customer-portal.tsx` (964 — Fase 2),
`backend/src/services/sgpService.js` (654 — cache e config por tenant).
Os 13 models são pequenos e a troca para `tdb()` é mecânica.

## Ordem recomendada de entrega

Fase 0 → 1 → 2 → 3 → 8 (isolamento provado) → 4 → 5 → 6 → 7.

Vale notar que a Fase 1 sai para os installs self-hosted existentes como um upgrade normal —
e isso é proposital: o código de tenancy é testado em produção real, com um tenant só, antes
de existir um segundo. Pela mesma razão as duas edições devem rodar **o mesmo caminho de
código**: self-hosted é simplesmente um tenant único com plano ilimitado e resolução por host
desligada. É o que impede as edições de divergirem.

### Checklist antes de vender acesso ao segundo provedor

Nada disso é negociável:

1. Toda tabela de tenant: `tenant_id NOT NULL`, FK para `tenants`, toda unique e todo índice
   começando por `tenant_id`.
2. Nenhum código de aplicação alcança tabela de tenant sem contexto — `currentTenantId()`
   lança, o ESLint bloqueia `getDb`, e o CI verifica os dois.
3. Login e sessão do portal do assinante escopados por tenant.
4. Os três caches em memória e o blob `app_state.dashboard_snapshot` separados por tenant.
5. JWT do operador e do assinante carregam o tenant, e ambos são conferidos contra o host.
6. Credenciais ACS por tenant, cifradas, com a guarda de egresso no lugar e o branch de URL
   absoluta removido.
7. `/api/database` não montada na edição SaaS.
8. Rate limit e concorrência de fetch ACS chaveados por tenant.
9. A suíte de vazamento verde no CI e obrigatória para merge.
10. `SECRET_BOX_KEY` separada do `JWT_SECRET`, com `key_version` nas colunas cifradas.
11. `audit_log` registrando revelação de senha de portal, troca de credencial ACS, remoção de
    membro e impersonation de plataforma.
12. Exportação por tenant funcionando — para o primeiro chamado de "apaguei tudo, socorro" e
    para a portabilidade da LGPD.

---

## Verificação

```bash
npm run verify          # check backend + testes + lint + typecheck + build (já existe na raiz)
cd backend && npm test  # inclui a nova suíte de isolamento
```

Validação end-to-end manual, após as fases 0–3:

1. Subir com `EDITION=saas` e Postgres; rodar `knex migrate:latest`.
2. Criar dois tenants (`alfa`, `beta`) pelo console de plataforma.
3. Em cada um, criar operador, contas de assinante com **o mesmo `customer_id`** nos dois,
   e nós de mapa com o mesmo `node_id`.
4. Logar em `alfa.dominio`, copiar o token, e chamar `beta.dominio` com ele → deve dar 403.
5. Chamar todas as listagens em cada tenant → nenhum registro do outro pode aparecer.
6. Logar no portal `portal.alfa.dominio` com o `customer_id` compartilhado → deve autenticar
   a conta do `alfa` e nunca a do `beta`.
7. Abrir o dashboard de `alfa`, depois o de `beta`, e conferir que os números diferem
   (prova de que o cache foi separado).
8. Suspender a assinatura de `beta` e confirmar 402 no painel com o portal ainda no ar.
