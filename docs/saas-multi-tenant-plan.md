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

- **A Fase 3 entrou.** `backend/src/middleware/tenantResolver.js` lê o provedor do `Host`
  quando o deployment configura `TENANT_BASE_DOMAIN`/`PORTAL_BASE_DOMAIN`, e cai no primeiro
  provedor da tabela só quando não configura nenhum — que é todo install self-hosted. A
  aposta do plano se confirmou: foi troca de uma função, porque tudo abaixo já lia o provedor
  do contexto.
- **A espinha da Fase 2 entrou** (o token carrega `tenantId` e o papel vem de `tenant_users`),
  mas o convite por e-mail, os papéis `tech`/`owner` e a troca de `username` para e-mail
  **não**. O plano de plataforma entrou na onda 13 (`platform_admins`, o console e o
  `requirePlatformAdmin` que responde 404 com o corpo idêntico ao de rota inexistente).
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
  e abre um escopo **provisório** lido do `Host`. É o escopo do que acontece sem sessão
  (login, setup, refresh, portal); uma requisição autenticada é reescopada por
  `authenticateToken` no provedor que o token nomeia, depois de conferir a membership. Onde o
  deployment não configura domínio base — todo self-hosted — o escopo provisório é o primeiro
  provedor da tabela, que ali é o único. Onde configura, host que não nomeia provedor é
  recusado em vez de servido: cair no primeiro seria responder com os dados de um provedor a
  quem não perguntou por nenhum.
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

**Entrou (ondas 17 e 18):**
- ✅ **Papéis reais**: `owner`, `admin`, `tech`, `viewer`, e `requireRole` virou
  `requirePermission` com **24 capacidades** numa matriz só
  (`backend/src/config/permissions.js`). A regra que fixou o recorte: nenhuma rota fica
  alcançável por quem não a alcança hoje — o `viewer` recebe exatamente o conjunto que
  antes não pedia papel nenhum, e o `tech` é papel novo, então nenhum install perde acesso
  na migração. `owner` e `admin` carregam as mesmas capacidades: a diferença é quem mexe no
  papel de quem, e essa regra vive no controlador de operadores, nas TRÊS portas — promover,
  rebaixar e encerrar o vínculo (a terceira ficou de fora na primeira escrita e foi achada
  na revisão: um `admin` não podia rebaixar o dono, mas podia apagar a membership dele).
- ✅ **Convite** (`tenant_invites`): quem administra oferece o vínculo, e quem entra é a
  pessoa convidada — com a conta que já tem, provando quem é com a senha que já usa, ou com
  uma nova cuja senha o administrador nunca vê. É o que a onda 12 não conseguia fazer.
  **Por link e não por e-mail**: o painel não tem transporte de correio nenhum, e prometer
  um envio que não acontece é pior que entregar o link na mão. O transporte entra depois,
  sem mudar nada do que está feito.

**Falta:**
- **Plano de plataforma** (nós, operando o SaaS): audience separada
  `skygenpanel-platform`, rotas `/api/platform/*`, capaz de listar/suspender tenants e de
  fazer *impersonation* auditada. Nunca compartilha o mesmo token do operador.
- **API de usuários**: escopada por provedor, com convite (onda 18) e com **login por
  e-mail**. Nome e e-mail vivem no mesmo espaço de nomes — cadastrar um e-mail igual ao nome
  de alguém, ou o contrário, é recusado —, o que é o que torna `findByLogin` inequívoco: o
  `username` nunca proibiu `@`, então não dá para decidir pelo formato qual dos dois foi
  digitado. **Não há verificação do endereço**, e isso é aceitável só enquanto não existir
  redefinição de senha por e-mail: naquele dia a verificação passa a ser pré-requisito
  daquele recurso. Falta o **transporte de e-mail**, que é decisão de produto: qual provedor
  de envio, credencial de quem, por deploy ou por provedor.
- **Portal do assinante**: a busca já é escopada (`getByCustomerId` passa por `tdb`), então
  O cookie é **host-only** (`portalCookieOptions` não define `domain`) e o payload assinado
  carrega `tenantId`, conferido contra o provedor da requisição em `portalAuth.js`. As duas
  coisas entraram juntas e são independentes de propósito: a primeira impede o navegador de
  mandar o cookie ao subdomínio vizinho, a segunda recusa o cookie que chegar assim mesmo —
  copiado à mão, ou por um cliente que não é navegador.
- `rateLimit.js`: chavear por `${tenantId}:${ip}` para um provedor barulhento não derrubar
  o limite dos outros.
**Quebra para os self-hosted atuais:** o login sai de `username` para `email`.

A mitigação que este plano propunha — a migration preenchendo `email = username` quando
parecesse e-mail e `username@local.invalid` caso contrário — **não foi seguida**, e vale
dizer por quê, porque a ideia é sedutora: ela deixa a coluna `NOT NULL` de imediato e faz
todo mundo "já ter" um endereço.

Ela dá a cada conta existente um endereço que **ninguém controla**. Hoje isso não custa
nada, porque só a senha abre a conta. No dia em que existir redefinição de senha por e-mail
— e ela vai existir, é o que todo painel acaba tendo —, `fulano@local.invalid` é um domínio
que qualquer um pode registrar, e cada conta pré-preenchida vira um caminho para dentro
dela. Uma migração não tem como saber o endereço de ninguém, e inventar um é pior que
deixar nulo, porque um nulo se vê e um endereço plausível não.

**O que foi feito** (onda de login por e-mail): a coluna nasce **anulável e vazia**; toda
conta NOVA exige e-mail; o login aceita nome ou e-mail; quem já usava cadastra o próprio
endereço em `POST /api/auth/email`, provando a senha atual; e `LOGIN_REQUIRES_EMAIL=true`
desliga o nome quando o install quiser. `GET /api/auth/email-readiness` diz quantas contas
ainda ficariam de fora, para que virar a chave seja uma decisão e não uma aposta.

Nome e e-mail vivem no **mesmo espaço de nomes**: cadastrar um e-mail igual ao nome de
alguém, ou trocar o próprio nome para o e-mail de um colega, é recusado. Sem essa regra um
identificador casaria duas contas — e a consequência não recai sobre quem fez, e sim sobre a
vítima, que simplesmente deixa de conseguir entrar sem nada na tela explicando por quê.

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
- ✅ **Enviar `Authorization` (Basic/Bearer)** — entrou na onda 19
  (`backend/src/services/genieacsAuthService.js`), com `none` como padrão para nenhum
  install passar a mandar header de repente. Uma função só monta os headers das sete
  chamadas ao ACS, e uma varredura estática falha quando a oitava nascer sem credencial —
  a falha é silenciosa nas duas direções, e a rota que esquece é justamente a que ninguém
  pensou em cobrir. O botão de testar conexão só leva a credencial para a MESMA origem já
  salva: a URL vem no corpo do request, então mandá-la para qualquer endereço faria dele
  um jeito de LER o segredo.
- **Fechar os três buracos de SSRF já presentes** (achado 7): remover o branch de URL
  absoluta em `buildGenieAcsUrl` (:183), truncar/omitir o corpo do erro upstream devolvido ao
  cliente em `fetchGenieAcsCollection` (:158), e definir `redirect: 'manual'` rejeitando 3xx.
- **Guarda de egresso**: resolver o DNS nós mesmos, **bloquear faixas privadas, loopback,
  link-local, CGNAT e ULA IPv6**, e então conectar ao **IP resolvido e fixado** enviando o
  `Host` — só checar se o hostname "parece privado" não fecha DNS rebinding. Mais allowlist
  de portas e o timeout já existente (15s). Na edição self-hosted a faixa privada continua
  liberada (é o caso normal lá) — daí o flag por edição. A allowlist (80, 443, 7557, 8080)
  alarga-se por `GENIEACS_ALLOWED_PORTS`, e é variável de ambiente e não coluna de propósito:
  é o **deployment** dizendo em quais portas a própria rede tolera ser sondada, decisão que
  não cabe a quem sonda.
- Em produção, rotear todo o egresso ACS por um proxy/NAT dedicado sem acesso à nossa VPC.
  Além de defesa em profundidade, dá ao provedor um IP fixo para colocar em allowlist — o que
  é argumento de venda.
- Botão "testar conexão" já existe (`POST /api/settings/test-genieacs`) e passa a validar
  também credenciais e alcance.

**Muro de escala desta fase — ✅ fechado, nas quatro peças.** `refreshDashboardData` →
`getDashboardDevices()` busca a **coleção inteira de dispositivos** do GenieACS. Um provedor
com 20 mil ONTs já era um parse de vários MB por minuto; multiplicado por dezenas de tenants,
um processo Node não sustentava, e o limite estimado era o décimo tenant.

O que o derrubou não foi tornar a passagem mais rápida — foi **deixar de fazê-la**. As quatro
peças:
- ✅ **refresh agendado, com defasagem por provedor e cadência adaptativa** —
  `backend/src/services/dashboardSchedule.js` decide quem, quando e com que folga; o job vive
  em `SchedulerService.refreshDashboard`. Três decisões: a cadência segue a atenção (60s com
  operador da última hora, 5 min ocioso, e o prazo do cache acompanha — senão a primeira tela
  aberta desfazia, do caminho da requisição, a decisão que o job tinha acabado de tomar); a
  defasagem vem de um FNV-1a do id, então é estável entre reinícios e não precisa ser
  guardada; e a conta de "está na hora" é de **janela com fase**, não de prazo decorrido —
  com prazo, um provedor que atrasa dez segundos carrega o atraso e todos convergem de volta
  para a mesma virada de minuto, que é o pico que a defasagem existe para evitar. A marca de
  atenção é gravada no login e na renovação de token — os dois pontos em que se SABE que há
  alguém do outro lado — com folga de 5 min, e nunca derruba um login;
- ✅ **teto de concorrência de fetch ACS global e por provedor** —
  `backend/src/services/genieacs/concurrency.js`. As sete chamadas ao ACS em
  `deviceService.js` passam por `withAcsSlot`, que segura uma vaga do provedor e depois uma
  global, sempre nessa ordem (duas travas em ordens opostas é o deadlock clássico). O teto por
  provedor é o que isola; o global é o que limita sockets e heap. `GENIEACS_MAX_CONCURRENCY`
  (32) e `GENIEACS_MAX_CONCURRENCY_PER_TENANT` (6). Foi a primeira das quatro peças do muro;
- ✅ **não atualizar tenants suspensos nem sem login nas últimas 24h** — suspensos já estavam
  fora: `forEachTenant` visita só quem está `active`, e uma segunda checagem dizendo o mesmo
  seria a que ficaria para trás. O que faltava era a dormência, agora em `isDormant`, e ela
  vale também para o **prewarm do boot**: subir o processo era buscar a coleção de
  dispositivos de TODO provedor da instalação, dormente ou não — o pior minuto do dia, e o
  único em que ninguém está olhando para reclamar;
- ✅ **avaliada** a tabela `devices_summary` — e a decisão é **não construir agora**. Três
  achados, na ordem em que mudam a conclusão:
  1. **Sozinha, ela não economiza nada mensurável.** O que está em cache hoje é o *resumo*
     (`buildDashboardSummary`), não a lista de dispositivos: `getDashboardData` devolve
     `cache.data` e não recalcula nada por requisição. Ou seja, o custo por requisição já é
     zero. Uma tabela acrescentaria N escritas de linha por ciclo para poupar um agregado que
     ninguém recalcula.
  2. **A alavanca é o refresh incremental; a tabela é pré-requisito dele, não substituto.** O
     que continua caro é a varredura: ler a coleção inteira e fazer o parse de vários MB, por
     provedor ativo, por ciclo. Isso só cai lendo **apenas quem informou desde o último
     ciclo** — e aí os atributos de quem não informou precisam morar em algum lugar. Esse
     lugar é a tabela. Construí-la sem o incremental é pagar o custo e não colher o ganho.
  3. **O incremental tem um risco específico, que precisa ser desenhado e não presumido.**
     `$gte` sobre `_lastInform` já é usado pelo filtro online/offline da lista de dispositivos
     (`buildDeviceStatusQuery`), então o operador funciona nas instalações reais — o aviso em
     `provisioningService.findCandidates` é mais cauteloso do que a evidência exige. Mas a
     assimetria que ele aponta continua de pé, e é ela que importa aqui: na lista, um filtro
     que devolve vazio é **visível** (o operador filtra "online", vê nada e reclama); num job
     de fundo, um delta vazio é indistinguível de uma frota quieta, e o painel mostraria uma
     foto congelada com cara de saudável. Um incremental honesto precisa, portanto, de uma
     **reconciliação completa periódica** para limitar a deriva — e é isso que torna o desenho
     não-trivial, não a tabela.

  **Quando revisitar:** quando um único provedor, sozinho, tornar um ciclo caro. O que tirou a
  urgência foi a peça anterior desta mesma lista: o multiplicador que assustava (*todo*
  provedor, *todo* minuto) já não existe — dormentes não são varridos e ociosos são varridos a
  cada 5 min. O custo que sobra é O(frota) por provedor ativo, e ele escala com o tamanho de
  um cliente, não com o número deles.

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
- Observabilidade: `tenant_id` em toda linha de log e em toda métrica. O **`audit_log` entrou
  na onda 20** — senha de portal revelada e redefinida, URL e credencial do GenieACS, papéis,
  vínculos, convites e suspensão de provedor. Falta a impersonação, que ainda não existe.
- Backup e **procedimento de exportação/exclusão por tenant**. A **exclusão entrou na onda
  22**: exige quatro coisas ao mesmo tempo — estar no plano de controle, o provedor estar
  **suspenso** (o que faz dela um segundo passo, com um estado reversível no meio, e não um
  clique), o slug digitado de volta exato, e não ser o último provedor do deployment —, e a
  linha da trilha é gravada ANTES, com a contagem do que vai sumir: se ela não puder ser
  gravada, não se apaga. A **exportação entrou na onda 21** (`GET /api/tenant/export`, capacidade `tenant.export`, auditada): todas as tabelas
  escopadas na ordem de criação do schema — que é a ordem que as FKs pedem, e o que faz o
  arquivo poder ser reinserido de cima para baixo —, sem nenhum segredo cifrado nem hash de
  senha, com um manifesto que diz o que ficou de fora e por quê.

---

### Fase 8 — Provar o isolamento *(a suíte existe; a lista de portas ainda não está toda coberta)*

Nada vai para dois provedores reais antes disto passar. **Boa parte já passa.**

#### O que existe

A suíte não ficou num arquivo só, e ficou melhor assim: `backend/test/tenant-leak.test.js`
guarda os casos que atravessam recursos, e **14 suítes `*-tenancy`** cobrem uma tabela ou um
subsistema cada — `sgp-links`, `sgp-events`, `device-profiles`, `provisioning`,
`map-settings`, `vendor-catalogue`, `wifi-credentials`, `whatsapp-media`,
`whatsapp-inbound`, `users`, `auth`, entre outras, mais `tenant-subdomain` e
`tenant-id-sweep`, que provam o isolamento por host, e `role-reach`, que prova por HTTP o
alcance de cada papel sobre uma amostra de 31 rotas. São 1403 testes no total, verdes nos
três dialetos no CI.

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

#### O "flake" da suíte, resolvido

A suíte carregava havia meses um vermelho intermitente no CI, sempre num arquivo sem relação
com o que estava sendo mudado, e sempre resolvido por re-rodar. Já tinham sido descartadas as
suspeitas óbvias: interferência entre arquivos pelo banco (o harness cria um schema/database
por arquivo), `describe` assíncrono (não existe nenhum) e esgotamento de conexões (medido: 5
conexões de pico com e sem limite no pool). Rodando a suíte cinco vezes seguidas com o log
inteiro guardado, **eram duas causas, nenhuma delas de infraestrutura**:

1. **Um teste dependente do relógio.** `device-history` gravava uma leitura em
   `Date.now() - 60_000` e afirmava que o rollup deixava a hora corrente em paz. Rodando no
   primeiro minuto de uma hora, um minuto atrás é a hora ANTERIOR, que já fechou — o rollup a
   agrupa e o teste falha. Um minuto em cada sessenta: ~1,7% das rodadas.
2. **Uma porta fixa sem tratamento de erro.** `genieacs-egress` é o único arquivo da suíte que
   precisa de porta fixa (a edição SaaS só deixa o egresso sair por 80, 443, 7557 e 8080, então
   `listen(0)` daria uma porta que o próprio guarda recusaria). O `listen` não tinha
   `once('error')`, então um `EADDRINUSE` deixava a Promise **nunca resolver**: o `before`
   pendurava, o event loop esvaziava, e o runner cancelava o arquivo com "Promise resolution is
   still pending but the event loop has already resolved" — mensagem que não nomeia porta,
   arquivo nem causa. Era isso que produzia a cascata de "cancelled" que parecia aleatória.

A lição que fica: **"cancelled" nunca é a falha, é o rastro dela.** A causa está no topo do log
do job, num `before` — e um `before` que pendura em vez de falhar é o que torna esse topo
inútil. Todo `listen` de porta fixa precisa de `once('error', reject)`.

Os testes estruturais existem em `backend/test/tenant-scoping.test.js`: a guarda estática
que varre `backend/src` atrás de handle cru numa tabela escopada, a exigência de que toda
tabela do schema esteja classificada como escopada ou compartilhada, e a marcação
`tenant-scope-exempt` obrigatória para as poucas exceções legítimas.

#### O que ainda falta

- **RLS no Postgres** como segunda linha, ainda não avaliado. É o único item que sobrou.

#### Os três itens que dependiam do subdomínio — fechados

Os itens 5, 6 e 2 da lista original esperavam a Fase 3. Com ela no lugar, os três existem:

- **Cookie de portal de A replayado no host de B** — `backend/test/tenant-subdomain.test.js`.
  Três asserções, não uma: o cookie recusado no portal do outro provedor, o mesmo cookie
  ainda válido no seu, e a ausência de `domain=` no `Set-Cookie` — que é o que impede o
  navegador de mandá-lo para o subdomínio vizinho antes de qualquer verificação. A quarta
  põe a requisição onde a leitura escopada *funcionaria* (rodando como A, com a requisição
  dizendo ser de B) para que o provedor assinado no payload possa ser visto fazendo alguma
  coisa: sem isso as duas primeiras passariam com ou sem `tenantId` assinado.
- **Token de operador de A enviado ao host de B** — mesmo arquivo: 403 `tenant_mismatch`,
  nas duas direções, com o controle de que o token funciona no host para o qual foi cunhado.
  403 e não 404 aqui de propósito: quem manda o token já sabe que o provedor existe, porque
  o host resolveu antes de a rota rodar.
- **`GET /:id` com id de B respondendo 404 e não 403** —
  `backend/test/tenant-id-sweep.test.js`, e varrido sobre **as 24 rotas do painel
  endereçadas por id de linha**, não sobre uma. A prova anterior cobria duas
  (`portal-password` e `users`); a diferença não é de quantidade, é que cada rota tem seu
  próprio caminho até o banco e é a rota acrescentada depois — copiando o controlador
  vizinho — que vaza. Cada caso roda duas vezes com o mesmo token, o mesmo host e o mesmo
  corpo, mudando só o id: com o id do vizinho tem que dar 404 e a linha do vizinho tem que
  continuar intacta; com o id próprio tem que dar qualquer coisa menos 404. Sem a segunda
  metade o arquivo passaria inteiro com as rotas desmontadas — e passou, na primeira
  rodada, em quatro casos cujo caminho eu tinha escrito errado.

Tirando o `where` de `tdb()`, 22 dos 24 ficam vermelhos. Os dois que não são os de
`/api/users/:id`, e estão certos: `users` é tabela do deploy, e quem responde 404 ali é a
leitura do vínculo em `tenant_users`, outro mecanismo, com prova própria em
`users-tenancy.test.js`.

- **A sentinela de SQL** em `APP_ENV=test` entrou (`backend/src/config/sqlSentinel.js`):
  toda query que toca tabela escopada sem filtro de provedor lança, com o `from:` do call
  site no erro. Ela é a segunda linha e apareceu como tal — na reversão acima ela sozinha
  derruba o seed antes de qualquer rota rodar, e foi preciso desarmá-la também para ver as
  asserções falharem.

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
6. ~~**O muro de escala do dashboard**~~ — ✅ fechado, nas quatro peças. Escopar o job por
   provedor tinha **multiplicado** o número de passagens em vez de reduzir o trabalho, e o
   limite estimado era de 15–25 provedores. O que o afastou não foi otimizar a passagem, foi
   deixar de fazê-la: dormentes não são varridos, ociosos são varridos a cada 5 min, o teto de
   concorrência limita o que corre junto, e a defasagem por provedor tira o pico da virada de
   minuto. O custo que resta é O(frota) por provedor **ativo** — escala com o tamanho de um
   cliente, não com o número deles. A `devices_summary` foi avaliada e recusada por ora; o
   porquê está na Fase 4.
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
`backend/src/middleware/tenantResolver.js` (Fase 3 ✅ — foi uma função só).

Os 27 models já estão convertidos; aquele trabalho, que era o volume da Fase 1, acabou.

## Ordem recomendada de entrega

Original: Fase 0 → 1 → 2 → 3 → 8 → 4 → 5 → 6 → 7.
**Percorrido:** 0 ✅ → 1 ✅ → 2 (espinha) → 8 (boa parte).

**Daqui em diante, e a ordem importa:**

1. ~~**Fase 3 — subdomínio.**~~ ✅ Entrou, e destravou o que se esperava: o resolvedor lê o
   host, o portal deixou de resolver o primeiro provedor, e os itens de vazamento que
   dependiam de host puderam enfim ser escritos.
2. **O resto da Fase 2.** Cookie host-only, `tenantId` no payload do portal, rate limit por
   provedor, os **papéis reais** com `requirePermission` e o **convite** ✅ entraram. Falta a
   audiência separada `skygenpanel-platform` com impersonação auditada — `platform_audit`,
   a peça que faltava, entrou na onda 22 —, e o **transporte de e-mail** do convite. A troca
   de `username` para e-mail ✅ entrou, em três passos e sem dia de virada: a coluna é
   anulável, toda conta nova nasce com e-mail, o login aceita os dois, e
   `LOGIN_REQUIRES_EMAIL=true` desliga o nome quando o install decidir. O painel responde
   quantas contas ainda ficariam de fora, para que essa decisão seja tomada olhando um
   número em vez de na esperança.
3. ~~**Fechar a Fase 8**~~ ✅ com os três testes que passaram a ser possíveis e a sentinela
   de SQL. Sobrou avaliar **RLS no Postgres** como segunda linha.
4. ~~**Fase 4 — conector.**~~ ✅ na ordem certa: as três correções de SSRF e a guarda de
   egresso com IP fixado entraram **antes** de a URL virar dado do cliente; depois a
   credencial NBI (onda 19) e o teto de concorrência. Do desenho original ficaram de fora,
   e continuam em aberto: `mode` (`agent`/`tunnel`/`hosted`), `verify_tls` e
   `allow_private_ranges` por provedor — a credencial vive num blob em `app_state`, sem
   essas três colunas. O muro de escala, esse, fechou nas quatro peças.
5. **Fase 5** (planos, assinatura, `requireActiveSubscription`, limites nos pontos de
   escrita, `billing_events`) → o resto da **Fase 6** (onboarding, plano e uso, branding
   pelo contexto, `<html lang>` e o centro do mapa) → o que sobrou da **2** (impersonação
   auditada com audiência própria, transporte de e-mail do convite) e da **7** (exclusão
   já entrou; `tenant_id` em log e métrica).

Vale repetir o que o plano dizia e que se confirmou: a Fase 1 saiu para os installs
self-hosted como upgrade normal, e o código de tenancy rodou em produção real com um
provedor só antes de existir um segundo. As duas edições rodam **o mesmo caminho de código**
— self-hosted é um provedor único com resolução por host desligada. É o que impede as
edições de divergirem.

### Checklist antes de vender acesso ao segundo provedor

Nada disso é negociável. **Os doze estão cumpridos.**
o rate limit é por provedor, mas a concorrência de fetch ao ACS ainda não — e essa
metade é da Fase 4.

| | Item | Estado |
| --- | --- | --- |
| 1 | Toda tabela de provedor: `tenant_id NOT NULL`, FK, uniques começando por `tenant_id` | ✅ |
| 2 | Nenhum código alcança tabela de provedor sem contexto (`currentTenantId()` lança, guarda estática no CI) | ✅ |
| 3 | Login e sessão do portal escopados por provedor | ✅ busca, cookie host-only e `tenantId` assinado no payload |
| 4 | Caches em memória e `app_state.dashboard_snapshot` separados por provedor | ✅ |
| 5 | JWT do operador e do assinante carregam o provedor e são conferidos contra o host | ✅ os dois carregam; divergência com o host é 403 `tenant_mismatch` |
| 6 | Credenciais ACS por provedor, cifradas, guarda de egresso, branch de URL absoluta removido | ✅ credencial NBI por provedor (onda 19), egresso com pinning de DNS, branch de URL absoluta removido |
| 7 | `/api/database` não montada na edição SaaS | ✅ |
| 8 | Rate limit e concorrência de fetch ACS chaveados por provedor | ✅ `tenantIpKey` no limite; `withAcsSlot` no fetch — vaga por provedor e vaga global, nessa ordem |
| 9 | Suíte de vazamento verde no CI e obrigatória para merge | ✅ 1403 testes, três dialetos |
| 10 | `SECRET_BOX_KEY` separada do `JWT_SECRET`, com `key_version` | ✅ |
| 11 | `audit_log` registrando ações sensíveis | ✅ onda 20 — senha de portal, GenieACS, papéis, vínculos, convites, suspensão |
| 12 | Exportação por provedor funcionando (LGPD e "apaguei tudo, socorro") | ✅ exportação (onda 21) e exclusão (onda 22), com trilha que sobrevive ao provedor apagado |

Nenhuma linha vermelha resta. Isso **não** quer dizer produto pronto — a Fase 5 inteira e
boa parte da 6 estão por fazer — quer dizer que a lista do que não se pode vender sem já
não tem item aberto. O que a fecha por último é o teto de concorrência de fetch ao ACS
(`withAcsSlot`), a primeira das quatro peças do muro de escala da Fase 4 — as outras três
entraram depois, e o muro está fechado.

A exclusão entrou na onda 22, e o que a destravou foi `platform_audit`: apagar um provedor
tem que deixar registro, e registrar no `audit_log` DELE é inútil porque a trilha vai junto.
A tabela é compartilhada, guarda `tenant_id` como inteiro simples com o slug e o nome
desnormalizados, e **não tem chave estrangeira para `tenants`** — uma FK apagaria em cascata,
ou impediria, exatamente a linha que existe para dizer que aquele provedor foi apagado. É
também a tabela de que a impersonação da plataforma vai precisar.

## Verificação

```bash
npm run verify          # check backend + testes + lint + typecheck + build (raiz)
cd backend && npm test  # 1403 testes, incluindo as suítes de tenancy
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

Validação end-to-end manual, agora possível — a automatizada equivalente está em
`tenant-subdomain.test.js` e `tenant-id-sweep.test.js`:

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

---

## Onda 13 — tornar a tenancy alcançável (decisões congeladas)

Doze ondas isolaram o painel por provedor, e **nada no painel cria um segundo
provedor**. Não é uma tela faltando: faltava uma autoridade. O administrador de
um provedor não pode cunhar provedores nem alcançar outro, então "quem pode"
precisava existir antes de "como".

### Quem tem a chave

`platform_admins` é criada **vazia**, e a migração não promove ninguém. Uma
migração que entregasse o plano de controle ao administrador de menor id seria
um upgrade promovendo alguém em silêncio — e na edição self-hosted, onde há um
provedor e nenhum plano de controle, promovendo a um papel que nem deveria
existir lá.

O bootstrap é explícito, das duas formas que fazem sentido:

- **Instalação nova em `EDITION=saas`**: o primeiro administrador criado pelo
  `setup` também vira administrador de plataforma. Sem isso, uma instalação SaaS
  nasce sem ninguém que possa criar o segundo provedor.
- **Instalação que já tem usuários**: `scripts/grant-platform-admin.js`, rodado
  por quem tem o servidor — que é exatamente quem deve estar decidindo isso. Há
  precedente no repositório: `scripts/reset-password.js`.

Com a tabela vazia, as rotas de plataforma são inúteis, e isso é o lado seguro
de falhar.

### As rotas são da edição SaaS

Montadas sob `IS_SAAS`, do mesmo jeito que a troca de banco é montada sob
`IS_SELF_HOSTED`. Numa instalação self-hosted elas não existem — não respondem
403, **não existem**, porque um 403 conta a quem perguntou que o plano de
controle está ali.

### O que a API faz, e o que ela não faz

- **Criar** provedor: `slug` e `name`. O slug é o subdomínio da Fase 3, único
  desde a origem.
- **Listar** e **suspender/reativar**. `tenants.status` já tem comportamento real
  em todo o painel: `forEachTenant` só visita `active`, a varredura de mídia não
  passa por suspenso, e o webhook do SGP não aceita entrega de suspenso. A rota
  dá o controle de algo que já vale.
- **NÃO apaga provedor.** As tabelas escopadas apontam para `tenants` sem
  cascata, então apagar um provedor com dado falharia na chave estrangeira — e
  se não falhasse seria pior. Suspender é a operação, e ela é reversível.

### Provedor criado em tempo de execução nasce igual a um do boot

`seedDefaults` roda no boot sobre todos os provedores: dá as configurações
padrão e, desde a onda 11, copia o catálogo de equipamentos para quem não tem.
Criar um provedor pela API **tem de passar pelo mesmo caminho**, ou o provedor
novo nasce sem configuração e com detecção de equipamento inerte — que não falha
alto, apenas não casa nada.

### Vincular alguém a um provedor é do plano de controle

A onda 12 recusou, de propósito, que o administrador de um provedor anexasse uma
pessoa que já existe: a criação carrega senha, e anexar resetaria o login de um
estranho e entregaria credenciais em outra ISP a partir de adivinhar um nome.

Um administrador de plataforma é outro nível de confiança — ele já pode criar
provedores. Então **é ele** quem vincula uma pessoa existente a um provedor, e
essa operação **nunca toca a senha**: ela cria o vínculo e nada mais.

---

## Onda 14 — provedor por subdomínio (decisões congeladas)

Hoje o token nomeia o provedor, mas o **endereço não**. Todo mundo chega pelo
mesmo host e o resolvedor sempre responde o primeiro provedor. É o que falta
para a tenancy valer na prática.

### A compatibilidade vem antes de tudo

**Sem domínio base configurado, nada muda.** Nenhum install self-hosted tem DNS
curinga, e o comportamento atual — o provedor próprio do install — continua
sendo a resposta. Essa garantia é absoluta: quem não configurar nada não pode
notar diferença nenhuma. É por isso que o domínio base é opt-in por ambiente e
não um padrão.

### Como o host vira provedor

- `PANEL_BASE_DOMAIN` e `PORTAL_BASE_DOMAIN`. Um host `alfa.painel.exemplo.com`
  com base `painel.exemplo.com` resolve o slug `alfa`.
- O slug é comparado como o DNS compara: sem diferenciar maiúsculas, e a porta
  do `Host` é descartada.

### O que acontece quando não resolve

Com domínio base configurado e um host que não nomeia provedor nenhum — sem
subdomínio, slug inexistente, ou **provedor suspenso** — a resposta é **404**,
a mesma para os três casos.

Distinguir "suspenso" de "nunca existiu" conta a quem perguntou quais slugs são
reais, e um slug é o nome de uma ISP. É o mesmo raciocínio que a onda 13 usou
para o plano de controle, e a onda 12 para uma linha que o chamador não pode
ver.

### Token que discorda do host: 403

Uma sessão válida do provedor A apontada para o subdomínio de B é **recusada
com 403**, não servida. Sem isso, trocar de provedor seria reusar o token em
outro endereço — e todo o trabalho das ondas 10 a 13 seria contornável por
edição de URL.

403 e não 404 aqui, ao contrário do caso acima, e o motivo é que não há o que
esconder: quem chegou até aqui já provou ter sessão, e o passo do host já teria
respondido 404 se B não existisse. Um 403 nesse ponto não conta nada que a
requisição anterior não tenha contado.

### O cache do resolvedor precisa morrer

O `cachedId` de hoje guarda **um** provedor num módulo. Com o host decidindo,
isso passa de otimização a defeito: o primeiro host a chegar decidiria o
provedor de todo mundo. O comentário atual do arquivo já avisa disso.

### Marca na tela de login: só o nome

`/api/tenant/public` devolve `slug` e `name` do provedor do host, e nada mais.
Logo e cores exigem colunas que `tenants` não tem e um caminho de upload;
ficam para uma onda própria, junto com `tenant_domains` e domínio próprio do
provedor. O que resolve hoje é a tela de login dizer o nome certo em vez do
nome do painel.

A rota é pública por necessidade — ela existe para ser lida antes de haver
sessão — então devolve exatamente esses dois campos e nada que sirva para
enumerar: um host que não resolve responde o mesmo 404 de qualquer outro.

### O que NÃO entra

- DNS curinga e TLS curinga são infraestrutura do lado de quem opera, não código.
- `CORS_ORIGINS` **não muda**: `isAllowedOrigin` já aceita uma origem cujo host
  é o host da própria requisição, que é exatamente o caso do subdomínio.
- Domínio próprio do provedor (`painel.provedor.com.br`) continua adiado.
