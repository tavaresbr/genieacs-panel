# Plano: transformar o SkyGenPanel em SaaS multi-tenant

## Contexto

O SkyGenPanel nasceu **single-tenant por construção**: um install = um provedor. Estamos
comercializando-o como SaaS, onde cada cliente é um **provedor de internet (tenant)** com
seus próprios operadores, seus próprios assinantes, seu próprio GenieACS e seu próprio plano.

Quando este documento foi escrito não existia **nenhuma** noção de tenant no código —
nenhuma coluna, nenhum middleware, nenhuma query filtrada por dono. Tudo era global: um
`.env`, um banco, uma linha `settings.genieAcsUrl`, um blob
`app_state.sgp_integration_config`, um `map_settings` com `id=1` fixo, e uma tabela `users`
cujo `username` era único globalmente.

**Isso mudou.** As linhas do banco pertencem a um provedor e as queries são filtradas por
ele; o que falta para vender ao segundo provedor está listado no *Estado* abaixo e no
*Checklist* no fim. O objetivo continua o mesmo: um deploy único capaz de atender dois
provedores diferentes **sem qualquer possibilidade de um enxergar dados do outro**, com
onboarding self-service, planos com limites e suspensão por inadimplência.

> **Como ler este documento.** As Fases 0 e 1 estão marcadas ✅ e descrevem o que **existe**;
> onde a entrega divergiu do plano, o texto conta a divergência em vez de a esconder. As
> Fases 2 a 8 continuam sendo plano, e o que já entrou delas está marcado dentro de cada uma.

### Estado: Fases 0 e 1 concluídas

**Fase 0** (fundação e segurança) entrou pelos PRs
[#12](https://github.com/tavaresbr/genieacs-panel/pull/12) e
[#16](https://github.com/tavaresbr/genieacs-panel/pull/16): flag `EDITION` com o seletor de
banco fora da edição hospedada, `SECRET_BOX_KEY` separada do `JWT_SECRET` com versão de chave
por segredo, PostgreSQL, `insertReturningId`, e a suíte rodando nos três dialetos no CI.

**Fase 1** (modelo de tenant e scoping estrutural) está **completa**. Foi entregue por duas
frentes trabalhando em paralelo — uma em fatias numeradas de PR, outra em "ondas" — o que
custou trabalho duplicado em `sgp_links` e três colisões de id de migration, mas chegou ao
fim. Hoje, na `main`:

| | Primeiro rascunho | Levantamento em `0127f49` | **Hoje (`226088d`)** |
| --- | --- | --- | --- |
| Tabelas no schema | 13 | 24 | **29** |
| Tabelas escopadas por provedor | 0 | 0 | **26** |
| Tabelas deliberadamente compartilhadas | — | — | **3** (`tenants`, `users`, `tenant_users`) |
| Tabelas pendentes | — | 24 | **0** |
| Models | 13 | 20 | **27** |
| `getDb()(...)` cru nos models | 65 | 121 | **18** |
| Caches globais em memória | 3 | 5 | **0** |

Os 18 `getDb()` restantes nos models não são resíduo: 10 tocam `users` e 7 `tenant_users`,
que são do deploy por decisão (ver *Onda 12* no fim), e 1 é o
`WhatsAppAccount.getByName` — a busca que **descobre** de qual provedor é um webhook que
chega sem sessão. Escopá-la exigiria já saber a resposta. Está marcada no código com
`tenant-scope-exempt` e a guarda estática exige essa marcação.

#### O que existe hoje como mecanismo

- **`backend/src/config/tenantContext.js`** — `AsyncLocalStorage` com `runInTenant()` e
  `currentTenantId()`, que **lança** fora de escopo. Falhar fechado é o que expôs, mais de
  uma vez, código novo de uma frente alcançando tabela que a outra acabara de escopar.
- **`backend/src/config/database.js`** — `tdb()`, `tinsert()`, `tinsertReturningId()` e
  `tbatchInsert()`. O `tdb()` devolve um Proxy que **lança se alguém chamar `.insert()`**
  nele: knex ignora `where` em insert, então essa porta precisava ser fechada no mecanismo,
  não na convenção.
- **`backend/src/config/tenantScope.js`** — `SCOPED_TABLES` e `SHARED_TABLES`, com o
  porquê de cada grupo escrito ao lado. `pendingTables()` hoje devolve vazio.
- **`backend/src/config/tenantJobs.js`** — `forEachTenant()` (uma passagem por provedor) e
  `forSoleTenant()` (roda uma vez e **recusa** quando existe um segundo provedor). Todo job
  de fundo já migrou para `forEachTenant`; o `forSoleTenant` **não tem mais nenhum chamador**
  e fica como mecanismo para o próximo job cuja query motriz ainda não seja escopada.
- **`backend/src/config/tenantCache.js`** — `TenantCache`, uma entrada por provedor, com
  `invalidate()` (este provedor) separado de `clear()` (todos).
- **Guarda estática** em `backend/test/tenant-scoping.test.js`, que varre `backend/src` e
  falha ao encontrar handle cru numa tabela escopada sem a marcação de isenção.

#### O que a Fase 1 entregou além do previsto

Escopar as tabelas expôs bugs que já estavam em produção com **um** provedor, e que o plano
original não previa:

- **Mensagem de WhatsApp entrante descartada em silêncio** por colisão de `external_id`.
- **Opt-out de um provedor silenciando o número de outro** para a mesma pessoa.
- **Evento SGP do segundo provedor descartado como duplicata** — `dedupe_key` era único no
  deploy e `insertIfNew` lê antes de inserir, então o webhook era respondido com sucesso e o
  evento nunca processado. Nada era registrado.
- **Contrato de um provedor gravado na conversa de outro**: `resolveSubscriber` buscava o
  vínculo pelo telefone em todo o deploy e `bindSubscriber` carimbava a thread com ele.
- **A guarda do "último admin" contava o deploy inteiro** — errada nas duas direções ao mesmo
  tempo.
- Um endpoint `/api/health` que perdia o diagnóstico por estar atrás do resolvedor.

#### O que ainda não foi feito

- **Fase 3 (subdomínio) não começou.** `backend/src/middleware/tenantResolver.js` resolve
  sempre o **primeiro** provedor da tabela. Está escrito para que a troca seja de uma função
  só: tudo abaixo já lê o provedor do contexto.
- **A espinha da Fase 2 entrou** (o token carrega `tenantId` e o papel vem de `tenant_users`),
  mas o convite por e-mail, os papéis `tech`/`owner`, o plano de plataforma e a troca de
  `username` para e-mail **não**.
- **Fases 4 a 7 inteiras**: conector GenieACS plugável, planos e limites, frontend e operação.

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

- **Backend**: Node ESM + Express 5 + **Knex 3**, sem ORM. Migrations em
  `backend/src/config/migrations.js`, aplicadas no boot por `ensureSchema()`
  (`backend/src/config/schema.js`), com ledger em `schema_migrations`.
- **Dois listeners no mesmo processo**: painel (`app`, 5890) e portal do assinante
  (`portalApp`, 5891) — `backend/src/app.js`, `backend/src/server.js`.
- **Banco**: SQLite padrão; MySQL e PostgreSQL suportados. A troca em runtime pela UI de
  Settings (`backend/src/services/dbManagementService.js`, `backend/src/routes/database.js`)
  existe **só na edição self-hosted** desde a Fase 0.
- **Acesso a dados**: 27 classes estáticas finas em `backend/src/models/*.js`, hoje sobre
  `tdb()`/`tinsert()` (`backend/src/config/database.js`). O `getDb()` cru sobrevive em 18
  pontos, todos justificados: `users` e `tenant_users`, que são do deploy, e a busca que
  descobre o provedor de um webhook. A aposta do plano original — de que os pontos de
  inserção do filtro seriam muitos mas ficariam todos num diretório — se confirmou.
- **GenieACS**: URL em `settings.genieAcsUrl` — que **já é por provedor**, porque
  `settings` é escopada; o que falta é a tabela de conexões e o conector plugável da Fase 4.
  Resolvida em `DeviceService.getGenieAcsRootUrl()`.
  **Nenhum header de autenticação é enviado** e credenciais na URL são explicitamente
  rejeitadas — assume-se NBI em loopback/rede privada.
- **Auth operador**: JWT bearer, `backend/src/middleware/auth.js`. Desde a onda 12 o
  payload carrega `tenantId` e o papel vem do **vínculo** em `tenant_users`, não de
  `users.role`. `authenticateToken` reabre o escopo no provedor que o token nomeia, depois
  de conferir a membership contra a tabela. Token antigo, sem `tenantId`, continua valendo
  quando a pessoa tem um vínculo só — a transição não derruba o plantão.
- **Resolução de provedor**: `backend/src/middleware/tenantResolver.js` roda antes das rotas
  e abre um escopo **provisório** — hoje sempre o primeiro provedor da tabela. É o escopo do
  que acontece sem sessão (login, setup, refresh, portal). A Fase 3 troca essa única função
  pela leitura do `Host`.
- **Integrações que guardam segredos**: SGP, provisionamento automático e WhatsApp via
  Evolution API. Todas cifram com `secretBox`, e desde a Fase 0 registram a versão da chave.
- **Auth assinante**: cookie `skygp_portal_session`, `backend/src/middleware/portalAuth.js`.
  O login resolve por `customer_id` através de `CustomerAccount.getByCustomerId`, que passa
  por `tdb` — ou seja, já é escopado pelo provedor em contexto. Falta o cookie ser
  **host-only** e o payload assinado carregar o provedor, ambos itens da Fase 2 que só
  passam a importar quando houver subdomínio.

### Achados críticos para o multi-tenant

O levantamento original listou oito. **Seis estão fechados**; o registro fica porque cada um
explica por que uma peça do mecanismo tem a forma que tem, e porque um deles pode voltar.

| # | Achado | Estado |
| --- | --- | --- |
| 1 | Cinco caches globais em memória, três deles com segredo decifrado | ✅ fechado — `TenantCache` e `Map` por provedor |
| 2 | Uniques globais virando colisão entre provedores | ✅ fechado — compostas, com teste de upgrade |
| 3 | Login do portal cruzando provedores | ✅ fechado — a busca passa por `tdb` |
| 4 | Sequestro de conta via `identity_hash` | ✅ fechado — `(tenant_id, identity_hash)` |
| 5 | `/api/database` apagando o banco de todos | ✅ fechado — só na edição self-hosted |
| 6 | `secretBox` derivando a chave do `JWT_SECRET` | ✅ fechado — `SECRET_BOX_KEY` + `key_version` |
| 7 | **Três buracos de SSRF no `deviceService`** | ⚠️ **aberto** — Fase 4 |
| 8 | Obstáculos de schema para as uniques compostas | ✅ fechado ao longo da Fase 1 |

**O achado 7 continua exatamente como estava** e é o mais sério dos que restam, porque a
Fase 4 vai transformar a URL do GenieACS em dado por provedor — ou seja, em entrada
controlada pelo cliente. Em `backend/src/services/deviceService.js`: `buildGenieAcsUrl`
aceita `endpoint` absoluto e **ignora a base configurada**; `fetchGenieAcsCollection`
devolve o **corpo do erro upstream ao cliente**, o que é um oráculo de leitura; e não há
`redirect: 'manual'`, então um host permitido pode redirecionar para `127.0.0.1`. Hoje o
alcance disso é limitado porque a URL é do operador do próprio install. Deixar de ser não
pode acontecer antes da guarda de egresso.

#### Duas garantias que são de construção, não de constraint

Estas duas valem registro porque **não** têm coluna que as sustente, e um `listAll()` novo
as quebraria em silêncio:

- **`customer_wifi_credentials`** era o exemplo original disso, e a decisão mudou: a tabela
  **ganhou `tenant_id`** no `0027`. A garantia por construção foi trocada por uma coluna, e
  foi a escolha certa — uma invariante que depende de ninguém escrever a query errada não é
  uma invariante.
- **`CustomerPortalController.overviewCache`** ainda é um `Map` chaveado só por
  `account.id`. É seguro porque `account.id` é surrogate de `customer_accounts`, que é
  escopada, então o id só chega ali por uma linha que o provedor em escopo já possui. É a
  mesma garantia que a tabela acima acabou de abandonar — vale reavaliar quando alguém mexer
  nesse controlador.

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

### Fase 0 — Fundação: banco do SaaS e segurança ✅ *(concluída)*

- **Migrations**: construídas em paralelo por outra frente, em
  `backend/src/config/migrations.js` — array ordenado de passos com id estável e `isApplied`
  para baselinear um install anterior ao runner. Este documento propunha o migrator do knex;
  o que existe é melhor e chegou primeiro.
- **PostgreSQL**, porque `RLS` é a única defesa estrutural real contra vazamento no modelo de
  banco compartilhado. Helper `insertReturningId` (`backend/src/config/database.js`) porque
  `const [id] = ...insert()` só devolve id em sqlite e mysql.
- **Suíte nos três dialetos no CI.** É o que impede a próxima migration de depender de algo
  que só um banco aceita — e foi o que revelou quatro defeitos que já estavam no repositório,
  incluindo uma FK entre coluna com e sem sinal que tornava **impossível criar um banco MySQL
  novo**.
- **`SECRET_BOX_KEY`** separada do `JWT_SECRET`, com a versão da chave gravada em cada
  segredo, para que rotacionar o segredo de sessão deixe de destruir os dados cifrados.
- **`EDITION`**, tirando o seletor de banco da edição hospedada.

**Os dois itens de segurança que esta fase antecipou, e por quê:**

- **`/api/database` desmontada na edição SaaS.** Pelo achado 5, essa rota apaga o banco
  inteiro antes de copiar. A flag entrou aqui e não na Fase 7 justamente para nunca existir
  uma janela em que a rota estivesse montada num deploy compartilhado. Hoje é um
  `if (IS_SELF_HOSTED)` em `backend/src/app.js`.
- **`SECRET_BOX_KEY` separada do `JWT_SECRET`**, com fallback para os installs existentes e
  `key_version` em todo conjunto de colunas cifradas. Antecipado porque adicionar a coluna
  depois seria uma retro-migration sobre dados já cifrados — impossível de fazer sem saber
  qual chave cifrou o quê, que é exatamente a informação que a coluna guarda.

**Breaking para self-hosted?** Não foi — a baseline adotou os installs existentes sem perda.

---

### Fase 1 — Modelo de tenant e scoping estrutural ✅ *(concluída)*

Era o coração do plano e foi. O que segue é **o que existe**, com as divergências em
relação ao previsto ditas onde houve.

#### O que foi entregue

- **`tenants`** e **`tenant_users`** existem. As outras tabelas que a Fase 1 previa
  (`tenant_invites`, `plans`, `subscriptions`, `platform_admins`, `audit_log`,
  `tenant_genieacs_connections`) **não** — elas pertencem às Fases 2, 4 e 5 e ficaram lá.
- **26 das 29 tabelas ganharam `tenant_id NOT NULL`**, com FK para `tenants` e as uniques
  refeitas em cima do par. As três de fora são `tenants`, `users` e `tenant_users`, e o
  porquê está na *Onda 12*, no fim deste documento.
- **Todas as uniques sobre valor que o painel não gera viraram compostas**:
  `customer_accounts` (`customer_id`, `device_id`, `identity_hash`), `device_profiles` e
  `sgp_links` (`device_id`), `sgp_events` (`dedupe_key`), `provisioning_profiles` e
  `wa_templates` (`name`), `mapping_nodes`/`mapping_edges`, `map_settings` (que deixou de
  ser singleton `id=1`). `settings` e `app_state` tiveram a PK trocada para
  `(tenant_id, key)`.
- **Catálogos** (`vendors`, `wifi_security_mappings`, `wifi_security_config`) foram pelo
  caminho previsto: `tenant_id NOT NULL` com cópia por provedor, e **não** pelo
  `tenant_id NULL` significando global. A invariante "toda linha de tabela de provedor tem
  `tenant_id`" sobreviveu inteira, e é ela que faz a guarda estática ser uma regra e não uma
  heurística.
- **Os cinco caches globais** viraram por provedor, e apareceu um sexto pelo caminho
  (`deviceHistoryService`). Quatro usam o `TenantCache`; o dashboard usa um `Map` porque
  precisa guardar também a promessa da atualização em voo — sem isso, o segundo provedor
  aguardava a atualização do primeiro e recebia o resultado dela.
- **`dbManagementService.COPY_TABLES`** passou a ser derivada de `SCHEMA_TABLES`, com teste
  que falha se deixar de cobrir o schema. Estava oito tabelas atrás quando foi escrita à mão.

#### O mecanismo, como ficou

Igual ao proposto em espírito, com três diferenças que valem registro:

1. **`tdb()` devolve um Proxy que lança em `.insert()`.** O plano descrevia `tdb` e `tinsert`
   como duas funções ao lado uma da outra; na prática, nada impedia alguém de escrever
   `tdb('x').insert(...)` — knex ignora `where` em insert e a linha entraria sem provedor,
   parecendo perfeitamente razoável. Fechar essa porta é a diferença entre um mecanismo e
   uma convenção.
2. **Não há tratamento especial de catálogo no `tdb`.** O `CATALOG_TABLES` com
   `orWhereNull` do rascunho desapareceu junto com a decisão de copiar o catálogo por
   provedor. Uma função, uma regra.
3. **`forEachTenant` e `forSoleTenant`** não estavam no plano e foram o achado mais útil da
   fase. Todo job de fundo perde o contexto de requisição, e a pergunta *"rodar uma vez por
   provedor divide o trabalho ou o repete?"* tem resposta diferente por job — e errar para o
   lado do "repete" significa, no caso do outbox de WhatsApp, **mandar a mesma mensagem N
   vezes para o telefone de um assinante real**. O `forSoleTenant` roda uma vez e **recusa**
   assim que existe um segundo provedor: uma fila que para é notada e consertada; uma fila
   que envia tudo em dobro é notada pelo cliente.

#### A migração do install existente

Foi feita em ~19 passos de migration em vez de um, e essa foi a decisão mais importante da
fase: **cada passo escopa um grupo pequeno de tabelas e entra sozinho**, com a tabela só
entrando em `SCOPED_TABLES` no mesmo commit em que o model passa por `tdb`. Antes disso a
tabela ficaria filtrada com escritas que não gravam `tenant_id`; depois, a conversão ficaria
sem o teste que a prova.

O `id` da migration é a chave do ledger, então **duas frentes não podem usar o mesmo
número** — aconteceu três vezes e o conserto é renumerar, barato mas obrigatório.

**A armadilha do SQLite era real e apareceu como previsto**: trocar um único global obriga o
knex a reconstruir a tabela, com os dados dentro. O que o plano *não* previa é que a suíte
de tenancy nunca passa por esse caminho — todas partem de um banco que o runner já terminou.
A cobertura dele vive em `backend/test/schema-migrations.test.js`, em blocos que rodam as
migrations pré-tenancy, plantam linhas e só então deixam o `ensureSchema` correr.

Uma armadilha que o plano não previa, e que custou caro: **um byte NUL literal num arquivo
fonte** faz o git classificá-lo como binário e descartar um dos lados num merge, em silêncio.

### Fase 2 — Autenticação, RBAC e gestão de equipe *(a espinha entrou; o resto não)*

**Já existe** (onda 12): o payload do JWT carrega `tenantId` e o papel do vínculo em
`tenant_users`; `authenticateToken` lê a membership e reabre o escopo no provedor que o
token nomeia; `/api/users` opera sobre os vínculos do provedor que pediu, e a guarda do
"último admin" conta admins **daquele** provedor. A revogação continua sendo o
`token_version` na pessoa — trocar a senha derruba as sessões dela em todos os provedores,
que é o certo.

**Não é preciso, e vale dizer por quê:** o plano pedia um `membershipVersion` no
token para revogar um vínculo sem derrubar as outras sessões da pessoa.
`hydrateAuthenticatedUser` lê `tenant_users` **a cada requisição autenticada**, então a
própria linha é a revogação — tirar alguém da equipe mata a sessão dela naquele provedor
na requisição seguinte, e uma troca de papel morde na mesma hora. Um contador seria cópia
em cache de um fato que já é lido fresco: estritamente mais fraco, e mais uma coisa para
alguém esquecer de incrementar. Coberto por
`backend/test/auth-tenancy.test.js`, "a session open when the membership ends".

**Falta:**
- Papéis reais substituindo a string `'admin'`: `owner` (dono, cobrança), `admin`,
  `tech` (opera ONTs, não mexe em configuração), `viewer`. `requireRole` vira
  `requirePermission` com um mapa papel→permissões.
- **Plano de plataforma** (nós, operando o SaaS): audience separada
  `skygenpanel-platform`, rotas `/api/platform/*`, capaz de listar/suspender tenants e de
  fazer *impersonation* auditada. Nunca compartilha o mesmo token do operador.
- **API de usuários**: já escopada por provedor. Falta o fluxo de **convite por e-mail**
  (`tenant_invites`).
- **Portal do assinante**: a busca já é escopada (`getByCustomerId` passa por `tdb`), então
  o que falta é o cookie ser **host-only** (sem
  `domain=.dominio`), para não vazar sessão entre subdomínios de provedores diferentes —
  ajustar `portalCookieOptions` em `backend/src/middleware/portalAuth.js` — e incluir
  `tenantId` no payload assinado. Ambos só passam a importar quando houver subdomínio, ou
  seja, junto com a Fase 3.
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
- i18n: são **11 idiomas** hoje, não três. Uma chave nova entra em todos, e o tipo em
  `dictionary.ts` faz o `npm run typecheck` acusar a que faltar. O que o typecheck **não**
  pega é a chave declarada **duas vezes** — o literal fica com a última, o conjunto de
  chaves continua batendo e o teste de paridade passa. Isso aconteceu quatro vezes nesta
  fase, sempre por dois branches acrescentando as mesmas chaves; em duas delas as cópias
  divergiam na redação. É para isso que existe o teste "declara cada chave exatamente uma
  vez" em `backend/test/i18n.test.js`, e ele varre as duas metades do app.
- O backend já ganhou sua própria camada de i18n (`backend/src/i18n/`) e o
  `customerPortalController` já responde por `req.t('portal.*')` — as mensagens novas de
  limite de plano e de suspensão entram por lá, não hardcoded.
- **Resíduos do upstream indonésio, ainda pendentes** (confirmados na `main` de hoje), e são
  metadado e dado que o cliente final do provedor vê: o `<html lang="id">` em
  **`frontend/index.html` e `frontend/portal.html`**, e o centro padrão do mapa em Jacarta
  (`-6.2088, 106.8456`, `backend/src/config/seed.js`). O segundo já é **por provedor** desde
  que `map_settings` foi escopada — falta só passar a defini-lo no onboarding em vez de
  semear Jacarta.

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

### Fase 8 — Provar o isolamento *(a suíte existe; a lista de portas ainda não está toda coberta)*

Nada vai para dois provedores reais antes disto passar. **Boa parte já passa.**

#### O que existe

A suíte não ficou num arquivo só, e ficou melhor assim: `backend/test/tenant-leak.test.js`
guarda os casos que atravessam recursos, e **14 suítes `*-tenancy`** cobrem uma tabela ou um
subsistema cada — `sgp-links`, `sgp-events`, `device-profiles`, `provisioning`,
`map-settings`, `vendor-catalogue`, `wifi-credentials`, `whatsapp-media`,
`whatsapp-inbound`, `users`, `auth`, entre outras. São 937 testes no total, verdes nos três
dialetos no CI.

O padrão em todas: **dois provedores com as chaves naturais deliberadamente colidindo** —
mesmo `customer_id`, mesmo `device_id`, mesmo `identity_hash`, mesmo `dedupe_key`, mesmo
nome de perfil — e então a asserção de que nenhum enxerga ou altera a linha do outro.

E uma disciplina que não estava no plano e passou a valer para toda fatia: **um teste de
vazamento só conta depois de ter sido visto falhar**, com a sua tabela fora da allowlist.
Ela pegou pelo menos dois testes que passavam pelo motivo errado — um porque a tabela ainda
estava escopada naquela rodada, outro porque a falha do teste anterior o mascarava. E pegou
também a versão errada da própria disciplina: reverter *por coluna* em vez de *por passo de
migration* reverte a migration errada quando duas derrubam um único com o mesmo nome de
coluna, e o teste "falha" provando nada.

Os testes estruturais existem em `backend/test/tenant-scoping.test.js`: a guarda estática
que varre `backend/src` atrás de handle cru numa tabela escopada, a exigência de que toda
tabela do schema esteja classificada como escopada ou compartilhada, e a marcação
`tenant-scope-exempt` obrigatória para as poucas exceções legítimas.

#### O que ainda falta

- **Os itens 5, 6 e 2 da lista original** — cookie de portal de A replayado no host de B,
  token de operador de A enviado ao host de B, e `GET /:id` com id de B respondendo 404 e
  não 403 — dependem de existir subdomínio. São da Fase 3, não desta.
- **A sentinela de SQL** em `APP_ENV=test` (`db.on('query')` lançando se o SQL tocar tabela
  escopada sem `tenant_id` nos bindings), que transformaria toda a suíte legada em teste de
  escopo de graça. É o item de melhor custo-benefício que sobrou.
- **RLS no Postgres** como segunda linha, ainda não avaliado.

## Riscos principais

Dos dez originais, cinco foram fechados pela Fase 1. Ficam registrados porque explicam
decisões de desenho, e porque o primeiro **não se fecha, só se contém**.

1. **Uma leitura cruzada silenciosa.** Continua sendo o risco que encerra o negócio, e o
   mecanismo o contém em vez de o eliminar: `currentTenantId()` lança fora de escopo, a
   guarda estática recusa handle cru, e as 14 suítes de tenancy provam por tabela. O caminho
   mais provável nunca foi um `WHERE` esquecido — foi cache estático e job de fundo, e foi
   exatamente ali que os problemas apareceram. **Contido, não resolvido.**
2. ~~Sequestro de conta por `identity_hash`~~ — ✅ fechado, unique composta.
3. ~~`/api/database` num deploy compartilhado~~ — ✅ fechado, rota só na edição self-hosted.
4. **Conectividade GenieACS** — inalterado, e é o maior risco que resta. É ao mesmo tempo a
   maior objeção de venda ("preciso abrir a 7557 pra internet?") e a maior superfície de
   ataque. Com os três buracos de SSRF do achado 7 ainda abertos, transformar a URL do ACS em
   dado por provedor **antes** da guarda de egresso constrói um proxy de SSRF com tela de
   login. A ordem aqui não é negociável.
5. ~~`JWT_SECRET` como chave de cifra de tudo~~ — ✅ fechado, `SECRET_BOX_KEY` + `key_version`.
6. **O muro de escala do dashboard.** Inalterado e mais próximo: a coleção inteira de
   dispositivos do ACS a cada 60s, agora **por provedor**, já que o prewarm roda em
   `forEachTenant`. Escopar o job não reduziu o trabalho, dividiu-o — e multiplicou o número
   de passagens pelo número de provedores. Chega por volta de 15–25 provedores.
7. ~~A migration de rebuild no SQLite~~ — ✅ fechado, e coberto por teste que planta linhas
   antes de rodar as migrations.
8. **A troca de `username` para e-mail** ainda não aconteceu e ainda quebra o login dos
   self-hosted. Continua precisando da janela de compatibilidade e da nota de release.
9. **LGPD** — inalterado, e agora concreto: o banco guarda CPF/CNPJ em `sgp_links.document`,
   payload de eventos SGP com dado pessoal, credenciais PPPoE e senhas de WiFi recuperáveis
   em claro, de assinantes de terceiros. Somos **operador**, o provedor é **controlador**.
   Contrato com cláusula de operador, política de retenção e compromisso de notificação de
   incidente precisam existir **antes do primeiro contrato**.
10. **Escopo escapando para hospedar o GenieACS** — inalterado. Manter fora até depois da
    Fase 7.

**Um risco novo, aprendido na Fase 1: duas frentes trabalhando no mesmo alvo.** A fatia de
SGP e provisionamento foi construída duas vezes, em paralelo, por duas sessões que não se
viam. Uma delas foi descartada inteira. Custou também três colisões de id de migration e
quatro consertos independentes do mesmo dicionário de idioma — em dois deles as cópias
divergiam na redação, e qual o operador via era decidido pela ordem em que os merges caíram.
O que barateia isso não é coordenação em tempo real, é **fatia pequena que entra rápido**:
quanto menos tempo um PR fica aberto, menos tempo ele tem para colidir.

## Dimensionamento

Os arquivos que concentram o trabalho **restante**, por tamanho atual:
`backend/src/services/deviceService.js` (Fase 4 — conector e as três correções de SSRF),
`frontend/src/pages/settings.tsx` (Fases 5/6/7),
`frontend/src/pages/customer-portal.tsx` (Fase 2),
`backend/src/middleware/tenantResolver.js` (Fase 3 — é uma função só).

Os 27 models já estão convertidos; aquele trabalho, que era o volume da Fase 1, acabou.

## Ordem recomendada de entrega

Original: Fase 0 → 1 → 2 → 3 → 8 → 4 → 5 → 6 → 7.
**Percorrido:** 0 ✅ → 1 ✅ → 2 (espinha) → 8 (boa parte).

**Daqui em diante, e a ordem importa:**

1. **Fase 3 — subdomínio.** É a menor peça restante e a que destrava mais coisa: sem ela,
   os itens de vazamento que dependem de host (cookie replayado, token de A no host de B)
   não podem sequer ser testados, e o portal continua resolvendo o primeiro provedor. O
   `tenantResolver` foi escrito para que a troca seja de uma função.
2. **O resto da Fase 2**, já com host: cookie host-only, `tenantId` no payload do portal,
   rate limit por provedor, convite por e-mail.
3. **Fechar a Fase 8** com os testes que passam a ser possíveis, e a sentinela de SQL.
4. **Fase 4 — conector**, começando pelas três correções de SSRF e pela guarda de egresso,
   **antes** de a URL virar dado do cliente.
5. Fases 5 → 6 → 7.

Vale repetir o que o plano dizia e que se confirmou: a Fase 1 saiu para os installs
self-hosted como upgrade normal, e o código de tenancy rodou em produção real com um
provedor só antes de existir um segundo. As duas edições rodam **o mesmo caminho de código**
— self-hosted é um provedor único com resolução por host desligada. É o que impede as
edições de divergirem.

### Checklist antes de vender acesso ao segundo provedor

Nada disso é negociável. **Sete dos doze estão cumpridos.**

| | Item | Estado |
| --- | --- | --- |
| 1 | Toda tabela de provedor: `tenant_id NOT NULL`, FK, uniques começando por `tenant_id` | ✅ |
| 2 | Nenhum código alcança tabela de provedor sem contexto (`currentTenantId()` lança, guarda estática no CI) | ✅ |
| 3 | Login e sessão do portal escopados por provedor | ⚠️ a busca sim; o cookie e o payload não (Fases 2/3) |
| 4 | Caches em memória e `app_state.dashboard_snapshot` separados por provedor | ✅ |
| 5 | JWT do operador e do assinante carregam o provedor e são conferidos contra o host | ⚠️ o do operador carrega; a conferência contra o host é Fase 3 |
| 6 | Credenciais ACS por provedor, cifradas, guarda de egresso, branch de URL absoluta removido | ❌ Fase 4 |
| 7 | `/api/database` não montada na edição SaaS | ✅ |
| 8 | Rate limit e concorrência de fetch ACS chaveados por provedor | ❌ Fases 2/4 |
| 9 | Suíte de vazamento verde no CI e obrigatória para merge | ✅ 937 testes, três dialetos |
| 10 | `SECRET_BOX_KEY` separada do `JWT_SECRET`, com `key_version` | ✅ |
| 11 | `audit_log` registrando ações sensíveis | ❌ Fase 7 |
| 12 | Exportação por provedor funcionando (LGPD e "apaguei tudo, socorro") | ❌ Fase 7 |

Os cinco que faltam concentram-se em **subdomínio (3)**, **conector GenieACS (6, 8)** e
**operação (11, 12)**. Nenhum deles é do mecanismo de isolamento de dados, que é o que a
Fase 1 entregou.

## Verificação

```bash
npm run verify          # check backend + testes + lint + typecheck + build (raiz)
cd backend && npm test  # 937 testes, incluindo as 14 suítes de tenancy
```

A suíte roda nos três dialetos, e **isso não é zelo**: cada uma das armadilhas abaixo passou
em dois bancos e falhou no terceiro.

```bash
cd backend
TEST_DB_CLIENT=mysql2 TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3306 \
  TEST_DB_USER=skygp TEST_DB_PASSWORD=skygp TEST_DB_NAME=skygp_test npm test
TEST_DB_CLIENT=pg TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=5432 \
  TEST_DB_USER=skygp TEST_DB_PASSWORD=skygp TEST_DB_NAME=skygp_test npm test
```

**Diferenças de dialeto que já custaram caro nesta fase**, todas em migration:

- **`onConflict` com o alvo errado é invisível no MySQL** e lança no SQLite e no Postgres.
  O MySQL ignora o alvo do `ON DUPLICATE KEY`, então um `onConflict('device_id')` que
  deveria ser `onConflict(['tenant_id','device_id'])` passa nos testes de MySQL enquanto
  mescla sobre a linha do provedor errado.
- **`.alter()` numa coluna que ainda está numa PK quebra no Postgres.** O knex emite
  `drop not null` incondicionalmente antes do retipo, e o Postgres recusa. Pior: o knex fixa
  a ordem — toda alteração de coluna sai antes de toda instrução de tabela —, então mover o
  `dropPrimary()` para cima no código não ajuda.
- **`timestamp` do MySQL não tem precisão de sub-segundo.** Um valor com milissegundos é
  arredondado na entrada, e comparar o valor original com o que volta os encontra diferentes
  — uma linha duplicada por passagem, para sempre, só naquele banco.
- **`DELETE ... LIMIT` não existe no Postgres**, e `date_trunc`/`DATE_FORMAT`/`strftime` são
  três coisas diferentes. Bucketização vai em JavaScript.

Validação end-to-end manual, quando a Fase 3 entrar:

1. Subir com `EDITION=saas` e Postgres.
2. Criar dois provedores (`alfa`, `beta`).
3. Em cada um, criar operador, contas de assinante com **o mesmo `customer_id`** nos dois, e
   nós de mapa com o mesmo `node_id`.
4. Logar em `alfa.dominio`, copiar o token, e chamar `beta.dominio` com ele → 403.
5. Chamar todas as listagens em cada provedor → nenhum registro do outro.
6. Logar no portal `portal.alfa.dominio` com o `customer_id` compartilhado → autentica a
   conta do `alfa`, nunca a do `beta`.
7. Abrir o dashboard de `alfa`, depois o de `beta` → os números diferem.
8. Suspender a assinatura de `beta` → 402 no painel, portal ainda no ar.

## Onda 12 — `users` como identidade, `tenant_users` como ponte ✅ *(implementada)*

A última tabela por converter, e a única que **não** ganhou `tenant_id`. Entrou no
`0028_tenant_users`. O que segue são as decisões como foram tomadas e por quê — é a parte do
desenho que menos se explica sozinha lendo o código.

### Por que não `users.tenant_id`

Uma linha em `users` é uma **pessoa**. Um consultor ou revenda que atende
várias ISPs com um login só é o arranjo comum neste mercado, e uma coluna de
provedor em `users` fecha isso para sempre. Pior: as três chaves estrangeiras
que apontam para `users.id` — quem enviou a mensagem (`wa_messages.sent_by`),
quem revogou o opt-out, quem criou a campanha — continuariam apontando só para
o id. Com `tenant_id` em `users` e nada mais, nada no esquema impediria
registrar o operador do provedor A como remetente da mensagem do B.

`users` fica global e único por `username`. `tenant_users` diz quem trabalha
para quem, e com que papel lá.

### O papel é do vínculo, não da pessoa

Alguém pode ser admin na ISP que é dele e operador comum na que ele presta
serviço. `users.role` fica onde está e mantém o valor — é o que o backfill lê
e o que um install rodando o código anterior ainda usa —, mas deixa de ser
consultado assim que o token passa a carregar o papel do vínculo.

### O token nomeia o provedor

- O login resolve a pessoa por `username` (global), depois os vínculos dela.
  Com um vínculo, é esse. Com vários, o token carrega o escolhido.
- O token de acesso ganha `tenantId` e o papel **do vínculo**. O escopo da
  requisição autenticada passa a sair do token, não do "primeiro provedor" que
  o `resolveTenant` responde hoje.
- **Token sem `tenantId` continua valendo**, resolvido pelo vínculo único da
  pessoa. É a transição: derrubar toda sessão aberta num upgrade seria o painel
  deslogando o plantão inteiro sem motivo. Com mais de um vínculo e nenhum
  `tenantId`, recusa — aí a ambiguidade é real.
- `token_version` continua sendo a única revogação, e continua na pessoa: trocar
  a senha derruba as sessões dela em todos os provedores, que é o certo.

### `/api/users` passa a ser a equipe de um provedor

Hoje ele lista **todos os operadores do deploy** e aceita qualquer id global em
`update` e `remove`. Passa a operar sobre vínculos do provedor que pediu.

- Remover alguém é **encerrar o vínculo**, nunca apagar a pessoa: ela pode
  trabalhar para outro provedor, e o nome dela está em histórico que aponta para
  `users.id`.
- A guarda do "último admin" conta admins **do provedor**. Contando o deploy
  inteiro ela estava errada nas duas direções ao mesmo tempo: os admins de outra
  ISP impediam esta de remover o último dela, e o último desta podia sair com a
  contagem ainda positiva por causa da equipe de outra.
- Um id que não tem vínculo aqui responde como inexistente, nunca como proibido:
  a diferença conta a quem pergunta que a pessoa existe em outro lugar.

### O que NÃO entra nesta onda

O plano quer `users` chaveado por e-mail no lugar de `username`. Muda como todo
operador entra no painel, não traz isolamento nenhum, e feito junto com a espinha
de autenticação seriam duas mudanças arriscadas de uma vez. Passo próprio.
