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
4. **`secretBox` deriva a chave do `JWT_SECRET`** (`backend/src/utils/secretBox.js:12`) —
   rotacionar o `JWT_SECRET` inutilizaria os segredos de **todos** os tenants de uma vez.

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
- Arquivos: `backend/src/config/schema.js`, `backend/src/config/database.js`,
  `backend/src/config/dbConfig.js`, todos os `backend/src/models/*.js`.

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
e `sgp_links`.

#### Catálogos permanecem globais com override

`vendors`, `wifi_security_mappings`, `wifi_security_config` recebem `tenant_id NULLABLE`:
`NULL` = catálogo global mantido por nós, valor = customização do provedor. A leitura faz
`where(tenant_id = :t OR tenant_id IS NULL)` com precedência do específico. Isso evita
duplicar o catálogo de fabricantes para cada cliente novo.

#### Migração do install existente

Migration de dados que cria `tenants` id=1 a partir do `settings.appName` atual, seta
`tenant_id = 1` em tudo, cria a `subscription` e converte o admin atual em `owner`. Nenhum
dado perdido.

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
- **Rotação de segredos**: introduzir `SECRET_ENCRYPTION_KEY` dedicada (com versão da chave
  gravada na linha) em `backend/src/utils/secretBox.js`, para desacoplar do `JWT_SECRET`.

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
- **Proteção contra SSRF**: o tenant fornece a URL, então nosso servidor vira um proxy para
  qualquer coisa que ele apontar. Resolver o DNS, **bloquear faixas privadas,
  loopback e link-local** na edição SaaS, fixar o IP resolvido, `redirect: 'manual'`,
  allowlist de portas, timeout já existente (15s). Na edição self-hosted a faixa privada
  continua liberada (é o caso normal lá) — daí o flag por edição.
- Botão "testar conexão" já existe (`POST /api/settings/test-genieacs`) e passa a validar
  também credenciais e alcance.

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
- i18n: as três strings novas de cada tela entram em
  `frontend/src/lib/i18n/locales/{pt-BR,en,es}.ts`. **Nota**: as mensagens do
  `customerPortalController` estão hardcoded em indonésio (`'ID Customer atau password salah'`)
  — vale corrigir junto, já que é texto que o cliente final do provedor vê.

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

- `backend/test/tenant-isolation.test.js` sobre o `backend/test/helpers/harness.js` existente:
  cria dois tenants com dados, e para **cada rota** verifica que o token do tenant A nunca
  enxerga nem altera recurso do tenant B (404/403, nunca 200).
- Teste específico da colisão de `customer_id` entre tenants no login do portal.
- Teste de cache: dashboard do tenant A não pode aparecer para o B.
- Teste de análise estática do scoping (Fase 1c).
- `backend/test/helpers/harness.js` ganha um `startTestServers({ tenants: [...] })`.

---

## Riscos principais

1. **Vazamento entre tenants** — risco número um do modelo de banco compartilhado. Mitigado
   pelas três camadas da Fase 1 e pela suíte da Fase 8. Um vazamento entre dois provedores
   concorrentes é um evento de fim de produto.
2. **Caches globais em memória** — três já identificados; é o tipo de bug que passa em todo
   teste de rota e vaza mesmo assim. Tratado explicitamente na Fase 1.
3. **SSRF no modo `direct`** — o tenant nos dá uma URL arbitrária. Sem o bloqueio de faixas
   privadas, o painel vira porta de entrada para a rede interna do SaaS.
4. **NBI do GenieACS sem autenticação** — hoje o código nem envia header. Se um provedor
   publicar a NBI na internet para nos alcançar, expõe o ACS inteiro. Por isso o modo
   `agent` deve virar o padrão recomendado logo após o MVP.
5. **Chave de segredos acoplada ao `JWT_SECRET`** — rotação quebraria os segredos de todos os
   tenants simultaneamente. Resolver na Fase 2.
6. **Quebra para os self-hosted atuais** — mitigado pela flag de edição e pela migração que
   converte o install existente em tenant #1.
7. **LGPD** — dados de assinantes de vários provedores no mesmo banco exige contrato de
   operador/controlador, política de retenção e exclusão por tenant (Fase 7).

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

As fases 0–3 + 8 são o **mínimo inegociável** antes de vender acesso ao segundo provedor.
As fases 4–6 são o que torna o produto vendável self-service. A fase 7 pode acompanhar.

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
