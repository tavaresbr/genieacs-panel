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
- **GenieACS**: conexão em `tenant_genieacs_connections`, uma linha por provedor, resolvida
  por `GenieAcsConnector.forCurrentTenant()`. Carrega o modo, a URL, o tipo de autenticação e
  o segredo cifrado, e é ela que decide se a faixa privada é permitida e se o certificado é
  verificado. O header `Authorization` (Basic/Bearer) **é enviado** desde a Fase 4;
  credenciais dentro da URL continuam explicitamente rejeitadas, porque a URL é logada,
  mostrada na tela e devolvida pela API de settings.
  `settings.genieAcsUrl` sobrevive como o campo que a tela edita, escrevendo na linha.
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

O levantamento original listou oito. **Os oito estão fechados**; o registro fica porque cada
um explica por que uma peça do mecanismo tem a forma que tem, e porque alguns podem voltar.

| # | Achado | Estado |
| --- | --- | --- |
| 1 | Cinco caches globais em memória, três deles com segredo decifrado | ✅ fechado — `TenantCache` e `Map` por provedor |
| 2 | Uniques globais virando colisão entre provedores | ✅ fechado — compostas, com teste de upgrade |
| 3 | Login do portal cruzando provedores | ✅ fechado — a busca passa por `tdb` |
| 4 | Sequestro de conta via `identity_hash` | ✅ fechado — `(tenant_id, identity_hash)` |
| 5 | `/api/database` apagando o banco de todos | ✅ fechado — só na edição self-hosted |
| 6 | `secretBox` derivando a chave do `JWT_SECRET` | ✅ fechado — `SECRET_BOX_KEY` + `key_version` |
| 7 | Três buracos de SSRF no `deviceService` | ✅ fechado — guarda de egresso com IP fixado |
| 8 | Obstáculos de schema para as uniques compostas | ✅ fechado ao longo da Fase 1 |

**O achado 7 era o mais sério dos oito** e fechou em três partes, na ordem em que tinham de
fechar. Os três buracos originais — `buildGenieAcsUrl` aceitando `endpoint` absoluto e
ignorando a base configurada, `fetchGenieAcsCollection` devolvendo o corpo do erro upstream
ao cliente (um oráculo de leitura), e a ausência de `redirect: 'manual'` — saíram primeiro.
Depois veio `GenieAcsEgress`: resolução própria, bloqueio das faixas privadas na edição
hospedada, allowlist de portas, e **conexão ao IP já verificado**, com o hostname ainda no
`Host` e no SNI. Essa última parte não é zelo: um teste com dois servidores no mesmo porto e
um resolvedor roteirizado mostrou o rebinding **executando** antes dela.

Só então a URL virou dado por provedor, com credencial — que é o que o achado dizia que não
podia vir antes. A ordem inversa teria aberto a porta e construído a fechadura depois.

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

### Fase 4 — Conectividade GenieACS plugável ✅ *(o modo `direct` concluído)*

A abstração veio antes do segundo modo, como o plano pedia — e o que ela revelou é que três
dos quatro modos são o mesmo transporte, não quatro transportes.

**`tenant_genieacs_connections`** (migration `0029`, escopada): `tenant_id` único, `mode`
(`direct`|`agent`|`tunnel`|`hosted`), `base_url`, `auth_type` (`none`|`basic`|`bearer`),
`username`, o segredo cifrado com `createSecretBox('genieacs-nbi')` e sua `key_version`,
`verify_tls`, `allow_private_ranges`, `status`, `last_check_at` e `last_error`. A migration
dá a cada provedor existente uma linha com a URL que ele já tinha, em `direct` e sem
credencial — ou seja, o upgrade não muda nada em como o painel alcança o ACS.

**`backend/src/services/genieacs/`** com `GenieAcsConnector`. Os sete pontos que o plano
listava em `deviceService.js` deixaram de montar URL e de falar com a guarda de egresso
diretamente: pedem o conector do provedor, e ele acrescenta o que uma URL crua não carrega —
o header, a decisão de TLS, a decisão de faixa privada e o teto de concorrência.
`getGenieAcsUrl` sumiu; `getGenieAcsRootUrl` e `getDevicesBaseUrl` viraram uma linha cada
sobre o conector; `buildGenieAcsUrl` virou `buildDeviceUrl(connector, …)`, síncrona, porque
quem já tem o conector não deve resolvê-lo de novo.

Uma diferença deliberada em relação ao plano: a interface é `request(url, options)` +
`collectionUrl(collection, query)`, não `fetch(collection, query, method, body)`. O conector
responde **como alcançar**; decodificar a resposta e classificar a falha continua em
`DeviceService.genieAcsError`, que é onde já estava. Juntar os dois criaria import circular
e moveria a política de erro para longe de quem a usa.

**O header `Authorization`, que o painel nunca mandou.** Basic ou Bearer, montado a partir
da linha do provedor. Era defensável enquanto o NBI ficava no loopback do próprio operador;
hospedado, um NBI sem autenticação alcançável pelo nosso egresso é a frota inteira de um ISP
disponível para quem mais o encontrar.

**Onde o segredo NÃO vai.** O botão "testar conexão" recebe a URL no corpo — é o que ele
serve para fazer — e por isso é a única chamada cuja destinação quem chama nomeia. Mandar a
senha guardada para lá seria um jeito de lê-la em texto claro: aponte para um servidor seu e
leia o header. A credencial só viaja quando a origem sob teste é a mesma a que ela pertence.
`current()` também não devolve o segredo: quem precisa dele pede por nome, para que vazá-lo
exija um ato deliberado e não um descuido.

**`verify_tls` e `allow_private_ranges` não são do provedor.** São pedidos para enfraquecer
uma guarda que existe porque a entrada do provedor não é confiável — uma guarda que o
guardado desliga não é guarda. São nossas, por cliente, e são exatamente o que `tunnel` e
`hosted` precisam. Na edição self-hosted `allow_private_ranges` não diz nada: lá não há parte
não confiável, e as faixas nunca são bloqueadas.

**Um modo sem transporte é recusado pelo nome.** `agent` é o ISP discando **para fora** até
nós; não há nada escutando na `base_url`. Tratado como `direct`, ele alcançaria o que quer
que responda ali e reportaria a diferença como indisponibilidade.

**O teto de concorrência (item 8 do checklist).** `withAcsSlot` segura uma vaga do provedor
e uma global, sempre nessa ordem — duas travas tomadas em ordens opostas é o jeito clássico
de travar o processo. O teto por provedor é o que isola; o global é o que limita sockets e
heap. Sem eles a falha não é um dashboard lento: é o painel inteiro atrás da frota de um
provedor só, que é precisamente o vizinho barulhento que a edição hospedada não pode ter.
Configuráveis por `GENIEACS_MAX_CONCURRENCY` (32) e `GENIEACS_MAX_CONCURRENCY_PER_TENANT` (6).

**Duas fontes para um fato, por enquanto.** A URL vive na linha de conexão e ainda em
`settings.genieAcsUrl`, que é o campo que a tela edita. A linha ganha quando tem valor;
salvar o setting escreve na linha, para que as duas não divirjam — e divergir aqui é
invisível: a tela mostra um ACS e o painel fala com outro. A Fase 6 aposenta o setting e isso
vira uma leitura só.

#### O que a Fase 4 deixou explicitamente para depois

O **muro de escala** continua de pé, e o teto de concorrência é só a primeira das quatro
peças. `refreshDashboardData` → `getDashboardDevices()` ainda busca a coleção inteira de
dispositivos, com TTL de 60 s e prewarm no boot. Antes do décimo provedor faltam:

- tirar o refresh do caminho da requisição para um job agendado com **offset por provedor**
  (hash do id no minuto) e **TTL adaptativo** (60 s com operador logado, 5 min ocioso);
- não atualizar provedores suspensos nem sem login nas últimas 24 h;
- avaliar uma tabela `devices_summary` para o dashboard ler do banco, não do ACS.

**Roadmap dos outros modos**, agora atrás da mesma interface e sem tocar no `DeviceService`:

- `agent`: agente no provedor abre WebSocket **de saída**; o conector multiplexa
  requisição/resposta por cima. Nada exposto na internet — é o modo mais seguro e o que eu
  recomendaria como padrão comercial depois do MVP. É o único que precisa de transporte novo.
- `tunnel`: WireGuard/Cloudflare Tunnel — **já funciona**, é `direct` com
  `allow_private_ranges` ligado. O custo é operacional (setup por cliente), não de código.
- `hosted`: nós provisionamos o GenieACS; **já funciona** pelo mesmo caminho.

**Em produção**, rotear o egresso ACS por um proxy/NAT dedicado sem acesso à nossa VPC.
Defesa em profundidade, e dá ao provedor um IP fixo para colocar em allowlist — argumento de
venda. Continua sendo trabalho de infraestrutura, não de código.

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

### Fase 7 — Operação e as duas edições *(os dois itens do checklist entregues)*

Os dois que o checklist exigia saíram junto com a Fase 4, fora de ordem de propósito: são os
que decidem se dá para **operar** com dezenas de provedores, não os que decidem se dois cabem
no mesmo deploy.

**`audit_log` (migration `0030`, escopada) — item 11.** Onze ações, todas coisas que o painel
faz hoje e que **não deixam rastro no próprio dado**: revelar uma senha guardada não muda
nada, e encerrar um vínculo ou rotacionar uma credencial destrói justamente a linha que diria
o que havia antes.

Três regras dão forma a tudo:

- **Nunca o segredo.** Um log que guarda a senha revelada é uma segunda cópia de todas as
  senhas do painel, numa tabela cujo acesso de leitura se distribui muito mais livremente que
  o da tabela de contas — e que, ao contrário dela, ninguém cifrou. A linha diz que houve uma
  revelação, de quem, por quem e de onde.
- **Registrar não pode quebrar a ação.** `record` engole a própria falha: a revelação já
  aconteceu, e devolver erro faria o operador repetir — uma segunda exposição causada pelo
  log. O custo é honesto e está escrito no código: um deploy com escrita falhando continua
  servindo ação sensível sem registro, e só o log do processo diz isso.
- **O `metadata` é onde dado pessoal se acumula sem ninguém decidir coletar**, um `...body`
  bem-intencionado de cada vez. Só escalares, poucos e curtos; chave que *soe* como segredo é
  descartada — com uma exceção que não é brecha: um **booleano** sob essa chave passa, porque
  booleano não é segredo. É o que deixa `tokenChanged: true` entrar e `token: '…'` não.

A FK do ator é `ON DELETE SET NULL`, **nunca CASCADE**: em cascata, apagar uma pessoa apagaria
o registro do que ela fez, e a ação mais digna de auditoria — alguém apagando o próprio
rastro — seria a única que destrói a própria evidência. O `actor_label` é desnormalizado para
a linha continuar legível depois.

Não vem rota de leitura. Quem pode ler o log é outra concessão que a de escrevê-lo — um
administrador pode encerrar um vínculo, então lê-lo revelando cada linha não decorre disso — e
a resposta pertence ao plano de plataforma.

**Exportação por provedor — item 12.** `GET /api/export`, `authenticateToken` +
`requireRole(['admin'])`, NDJSON em stream com contrapressão. Percorre `SCHEMA_TABLES` — a
mesma lista e a mesma ordem que o `dbManagementService` usa, então pai antes de filho, e uma
tabela nova não pode ficar de fora. A leitura é paginada por chave (`where id > cursor`), não
por `OFFSET`, e o gerador segura uma página de cada vez.

A decisão central era o que fazer com as colunas cifradas, e a resposta é **ciphertext com a
`key_version`, nada decifrado, em lugar nenhum**. Os dois motivos querem coisas diferentes e
só um deles quer os segredos: **restaurar não quer texto claro** — o painel que recoloca o
arquivo tem o mesmo segredo base, então o ciphertext volta idêntico, e decifrar significaria
recifrar na entrada com o texto claro num arquivo no meio do caminho, de graça. E
**portabilidade não precisa** — o que se deve ao provedor são os registros dele, e um segredo
de autenticação guardado não é um. A leitura legítima da senha WiFi de um assinante (um
operador ao telefone) já existe no painel, uma conta por vez, atrás de sessão.

O flag `?decrypt=true` foi recusado de propósito: é uma opção que acaba sendo ligada, e ligada
exatamente por quem está na ligação do "apaguei tudo" na pior hora.

A `key_version` é o que faz do ciphertext uma resposta que funciona em vez de uma recusa, e é
a parte que se perderia em silêncio: `secretBox.decrypt` reporta chave ausente devolvendo
`null` — indistinguível de "não havia senha" — então ciphertext restaurado sem a versão não é
erro, é uma frota de assinantes cujas senhas evaporaram.

`users` sai projetado a `id, username, created_at, updated_at`. **Não** o hash: um login abre
o painel em todo ISP para o qual a pessoa trabalha, então esse hash não é deste provedor para
entregar. **Não** o `role`: é coluna do deploy e o painel deixou de acreditar nela — quem
autoriza é o vínculo.

**O que continua de pé nesta fase:** `tenant_id` em toda linha de log e em toda métrica, a
rota de leitura do `audit_log` junto do plano de plataforma, o console de plataforma, e o
procedimento de **exclusão** por provedor (a exportação é a metade que existe).

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
`frontend/src/pages/settings.tsx` (Fases 5/6/7) e o que a Fase 5 ainda não tem arquivo para
citar — planos, assinaturas e o console da plataforma.

Os 27 models já estão convertidos; aquele trabalho, que era o volume da Fase 1, acabou. O
`deviceService.js`, que era o outro grande, saiu na Fase 4: as sete funções que montavam URL
viraram chamadas ao conector.

## Ordem recomendada de entrega

Original: Fase 0 → 1 → 2 → 3 → 8 → 4 → 5 → 6 → 7.
**Percorrido:** 0 ✅ → 1 ✅ → 2 (espinha) → 8 (boa parte).

**Percorrido desde então, na ordem em que foi feito:** Fase 3 (subdomínio) → resto da
Fase 2 (cookie host-only, provedor no payload do portal, rate limit por provedor) → Fase 8
(sentinela de SQL e os testes que o host tornou possíveis) → Fase 4 (as três correções de
SSRF e a guarda de egresso **antes** de a URL virar dado do cliente, depois o conector).

A ordem importava e se pagou: cada uma dessas fases só pôde ser testada de verdade porque a
anterior já estava lá.

Depois vieram os dois itens de operação da Fase 7 que o checklist exigia — `audit_log` e
exportação por provedor — porque são os que decidem se dá para operar com dezenas de
provedores, não os que decidem se dois cabem no mesmo deploy.

**O que resta:** Fases 5 → 6 — planos, limites e ciclo de assinatura, e o frontend.

Vale repetir o que o plano dizia e que se confirmou: a Fase 1 saiu para os installs
self-hosted como upgrade normal, e o código de tenancy rodou em produção real com um
provedor só antes de existir um segundo. As duas edições rodam **o mesmo caminho de código**
— self-hosted é um provedor único com resolução por host desligada. É o que impede as
edições de divergirem.

### Checklist antes de vender acesso ao segundo provedor

Nada disso é negociável. **Os doze estão cumpridos.**

| | Item | Estado |
| --- | --- | --- |
| 1 | Toda tabela de provedor: `tenant_id NOT NULL`, FK, uniques começando por `tenant_id` | ✅ |
| 2 | Nenhum código alcança tabela de provedor sem contexto (`currentTenantId()` lança, guarda estática no CI) | ✅ |
| 3 | Login e sessão do portal escopados por provedor | ✅ a busca por `tdb`, o cookie host-only, o provedor no payload assinado |
| 4 | Caches em memória e `app_state.dashboard_snapshot` separados por provedor | ✅ |
| 5 | JWT do operador e do assinante carregam o provedor e são conferidos contra o host | ✅ `tokenMatchesHost` responde 403 `tenant_mismatch` |
| 6 | Credenciais ACS por provedor, cifradas, guarda de egresso, branch de URL absoluta removido | ✅ `tenant_genieacs_connections` + `GenieAcsEgress` + conector |
| 7 | `/api/database` não montada na edição SaaS | ✅ |
| 8 | Rate limit e concorrência de fetch ACS chaveados por provedor | ✅ `tenantIpKey` no limite, `withAcsSlot` no fetch |
| 9 | Suíte de vazamento verde no CI e obrigatória para merge | ✅ 1150 testes, três dialetos |
| 10 | `SECRET_BOX_KEY` separada do `JWT_SECRET`, com `key_version` | ✅ |
| 11 | `audit_log` registrando ações sensíveis | ✅ onze ações, sem nunca guardar o segredo |
| 12 | Exportação por provedor funcionando (LGPD e "apaguei tudo, socorro") | ✅ `GET /api/export`, NDJSON em stream |

Nenhum item do checklist está em aberto. Isso **não** quer dizer que o produto está pronto —
faltam as Fases 5 e 6 inteiras, planos, limites e frontend — mas quer dizer que a lista de
coisas que não se pode vender sem já não tem linha vermelha.

## Verificação

```bash
npm run verify          # check backend + testes + lint + typecheck + build (raiz)
cd backend && npm test  # 1150 testes, incluindo as suítes de tenancy
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
