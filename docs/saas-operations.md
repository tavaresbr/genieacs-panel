# Operar a edição SaaS

Como subir, observar, guardar e desfazer um deploy do SkyGenPanel que serve vários
provedores. É o documento da Fase 7 do `saas-multi-tenant-plan.md`, escrito para quem
está de plantão e não para quem desenhou o sistema: cada seção diz o que fazer e onde
olhar, e o *porquê* fica em uma linha quando importa para não fazer errado.

As duas edições rodam **o mesmo código**. Tudo que muda entre elas vem de `EDITION`:

| `EDITION=selfhosted` (padrão) | `EDITION=saas` |
| --- | --- |
| Um provedor, resolvido sem olhar o `Host` | Provedor pelo subdomínio; host que não nomeia ninguém é 404 |
| `Configuração → Banco` troca o banco pela tela | A rota não é montada; o banco vem de `DATABASE_URL` |
| ACS em endereço privado permitido | Egresso do ACS recusa faixas privadas e portas fora da lista |
| Sem plano de controle | `/api/platform/*`, cadastro, assinatura, limites de plano |
| `deploy/install.sh` + CLI `skygenpanel` + SQLite/MySQL | `Dockerfile` + Postgres gerenciado + migrations no boot |

## 1. Subir

### Variáveis

Todas estão em `deploy/saas.env.example`, com comentário. As que não podem faltar:

- `EDITION=saas`.
- `TENANT_BASE_DOMAIN` e `PORTAL_BASE_DOMAIN`: `alfa.painel.exemplo.com` é o painel do
  provedor `alfa`; `alfa.portal.exemplo.com` é o portal do assinante dele.
- `DATABASE_URL`: `postgres://user:pass@host:5432/db?schema=painel&sslmode=require`.
  Vence o `db-config.json` quando os dois existem, para uma imagem nunca ser apontada
  para o banco errado por um volume velho. `schema` é o `search_path`, que é como um
  Postgres gerenciado guarda mais de um painel; `sslmode=no-verify` mantém TLS e tira a
  verificação de cadeia.
- `JWT_SECRET`, `PORTAL_JWT_SECRET`, `SECRET_BOX_KEY`: três valores **diferentes**, de
  `openssl rand -hex 48`. O boot recusa segredo fraco em `APP_ENV=production` (que é o
  padrão da imagem). `SECRET_BOX_KEY` cifra a credencial NBI e a senha de portal; trocá-la
  torna esses dados ilegíveis — ver §6.
- `TRUST_PROXY=1`: o proxy na frente é o único salto confiável. É o que dá a cada
  provedor o seu balde de rate limit e marca os cookies do portal como `Secure`.
- `METRICS_TOKEN` (opcional, ≥ 32 caracteres): quem coleta `/api/platform/metrics`.
- `SMTP_URL` e `MAIL_FROM` (opcionais): por onde sai o convite de equipe. Sem as duas não
  há envio, e o link continua saindo na tela — ver §8.

### DNS e proxy

Três registros, dois deles curinga:

```
painel.exemplo.com       A/AAAA  → proxy
*.painel.exemplo.com     CNAME   → painel.exemplo.com
*.portal.exemplo.com     CNAME   → painel.exemplo.com
```

O proxy termina TLS (certificado curinga para cada base) e encaminha **preservando o
`Host`**: `*.painel…` e `painel…` para a porta 5890, `*.portal…` para a 5891. É o
`Host` que diz ao painel qual provedor está falando; um proxy que o reescreve entrega
todo mundo no mesmo lugar, e o resolvedor responde 404 para todos.

O apex `painel.exemplo.com` (e `www.`) é **o endereço da plataforma**, e é onde o
console vive. Ele não pertence a provedor nenhum, e serve exatamente isto:

| Caminho | Para quê |
|---|---|
| `GET /api/tenant/public` | dizer que aqui é a plataforma, e onde os provedores vivem |
| `POST /api/auth/signup` | o ISP que ainda não existe se cadastrar |
| `/api/platform/*` | o console: provedores, planos, assinaturas, cadastro do console |
| `/api/auth/login`, `/user`, `/logout`, `/refresh`, `/change-password`, `/setup-status` | a sessão do console |

**Nada de nenhum provedor é servido nesse host** — `/api/devices`, `/api/settings`,
`/api/users`, a redefinição de senha e o resgate de personificação respondem 404 ali, e
um token de provedor que chegue no apex é recusado com `tenant_mismatch`. O contrário
também vale: onde há domínio-base, `/api/platform/*` **não existe** no host de um
provedor. O apex do portal não serve nada.

### Compose

```bash
cp deploy/saas.env.example deploy/saas.env   # preencher
docker compose -f deploy/docker-compose.saas.yml up -d --build
docker compose -f deploy/docker-compose.saas.yml logs -f panel
```

O compose traz um Postgres ao lado para homologação. Em produção o banco é gerenciado:
apague o serviço `db`, aponte `DATABASE_URL` para fora e o resto fica igual. As
**migrations rodam no boot** (`ensureSchema`), são idempotentes e ficam registradas em
`schema_migrations`; um deploy é `up -d --build` e nada mais. Se uma migration falhar o
processo não sobe, o `HEALTHCHECK` da imagem fica vermelho e o orquestrador não troca a
versão antiga — que é o comportamento desejado.

O CI constrói a imagem e a sobe até `/api/health` responder (job `image`), então um
`Dockerfile` quebrado não chega à `main`.

### Primeiro acesso

A primeira conta da plataforma nasce **no servidor**, e não por uma tela:

```bash
PLATFORM_ADMIN_PASSWORD='...' \
  node backend/scripts/grant-platform-admin.js quem-opera \
    --create --email quem-opera@exemplo.com
```

Ela não tem vínculo com provedor nenhum — que é o ponto: quem opera a plataforma não
trabalha em nenhum ISP. Entre em `https://painel.exemplo.com` com ela e crie o primeiro
provedor pelo console. Daí em diante, quem já está no cadastro concede a outros pela aba
**Acesso à plataforma** — ninguém ganha o plano de controle sozinho, e a concessão fica
na trilha com quem deu a quem.

Duas consequências de a conta não ter provedor, e as duas são desejadas: ela **não entra
em `slug.painel.exemplo.com`** (o login de lá recusa quem não tem vínculo) e a senha
dela se recupera com `node backend/scripts/reset-password.js`, porque o endereço da
plataforma não serve a redefinição por e-mail — aquela grava na trilha de um provedor.

É script e não rota de propósito: quem pode rodá-lo é quem tem o servidor, que é
exatamente quem deveria decidir quem cunha provedores. Uma tela de criação no apex seria
pública, criando a conta de maior privilégio do deploy, trancada só por "ainda não
existe ninguém" — e num SaaS onde ISPs se cadastram sozinhos esse contador não fica em
zero.

**O provedor `default`** que a migração cria num banco novo é um provedor comum: pode
ser renomeado, suspenso e apagado pelo console como qualquer outro. Onde há domínio-base
ele pode inclusive ser o último a sair — um SaaS sem clientes é um estado coerente, e o
console continua de pé porque não pertence a provedor nenhum.

**Num install que começou self-hosted e virou SaaS**, `platform_admins` está vazia e
nenhuma migração promove ninguém — de propósito: um upgrade não pode transformar o
administrador local de um ISP em operador da plataforma. Aí a conta já existe e só falta
a chave:

```bash
node backend/scripts/grant-platform-admin.js quem-opera
```

Nesse caso a conta continua sendo membro do ISP dela, o que é legítimo: a mesma pessoa
opera a plataforma e trabalha no provedor. A diferença entre os dois modos é essa.

### As três sessões

Três audiências de token, e cada uma vale num lugar só. Confundi-las é o erro que este
desenho existe para tornar impossível:

| Sessão | Audiência | Nomeia provedor? | Papel | Onde vale |
|---|---|---|---|---|
| Painel | `skygenpanel-admin` | sim | o do vínculo | `slug.painel…` daquele provedor |
| Console | `skygenpanel-console` | **não** | nenhum | só o apex |
| Personificação | `skygenpanel-platform` | sim | `viewer` imposto | só o host do provedor personificado |

A do console roda **sem escopo de provedor**: qualquer leitura escopada que escape para
ela estoura alto em vez de servir o provedor errado. A de personificação é só leitura,
barrada por método acima de toda rota, e não alcança o console de volta.

## 2. Ver: logs

Uma linha por evento, e **o provedor em toda linha**. Uma linha sem provedor num
deploy compartilhado é uma linha que ninguém consegue transformar em ação.

```
2026-09-10T18:40:12.331Z INFO  tenant=7 http req=3f1c… method=GET path=/api/devices status=200 ms=41.2 ip=203.0.113.9 host=alfa.painel.exemplo.com
2026-09-10T18:40:12.902Z ERROR tenant=7 unhandled_error req=8a9e… method=POST path=/api/sgp/sync err="connect ETIMEDOUT" errName=Error errCode=ETIMEDOUT
[tenant=7] SGP sync error: connect ETIMEDOUT
```

- `LOG_FORMAT=json` troca para um objeto por linha (`tenant_id` como campo), que é o
  que um coletor prefere. `LOG_LEVEL=debug|info|warn|error`.
- `tenant=-` é uma requisição recusada antes de resolver o provedor (host errado) ou o
  boot. As linhas `[tenant=N] …` são as antigas do `console.*`, etiquetadas no boot com o
  mesmo contexto; jobs de fundo rodam por provedor e saem etiquetados do mesmo jeito.
- Toda requisição tem `req=<uuid>`, devolvido em `X-Request-Id`. Uma captura de tela com
  o cabeçalho e um `grep` no log se encontram.
- `path` nunca traz a query string, então um token colado na URL não vai para o log.
- `/api/health` só aparece quando falha.

## 3. Ver: métricas

`GET /api/platform/metrics`, formato de exposição do Prometheus, **`tenant_id` em toda
série**. Lê quem tem sessão de administrador da plataforma ou quem manda
`Authorization: Bearer $METRICS_TOKEN`.

```
skygenpanel_http_requests_total{method="GET",status="2xx",tenant_id="7"} 1284
skygenpanel_http_request_duration_ms_bucket{le="250",tenant_id="7"} 1270
skygenpanel_acs_requests_total{outcome="refused",tenant_id="7"} 3
```

- `http_requests_total` por provedor, método e classe de status. O caminho **não** é
  rótulo: é ilimitado, e uma série por caminho é como um registro come a memória.
- `http_request_duration_ms` por provedor, com baldes grossos (25/100/250/1000/5000 ms).
  A pergunta que responde é "o painel deste provedor está lento", não a forma do p99.
- `acs_requests_total` por provedor e resultado: `ok`, `refused` (a guarda de egresso
  disse não antes de abrir socket — configuração do provedor) e `error` (rede ou o ACS).
  `refused` subindo é ticket para o provedor; `error` subindo é o ACS dele fora.

Contadores vivem no processo: reiniciou, zerou; duas réplicas são dois alvos de scrape.
Um `scrape_config` mínimo:

```yaml
- job_name: skygenpanel
  scheme: https
  metrics_path: /api/platform/metrics
  authorization: { credentials: "<METRICS_TOKEN>" }
  static_configs: [{ targets: ["default.painel.exemplo.com"] }]
```

Qualquer host de provedor serve; o caminho está isento da porta de assinatura e da
resolução de provedor não depende — mas o apex não o serve.

## 4. Guardar: backup

O que existe em três lugares, e cada um tem seu backup:

| O quê | Onde | Como guardar |
| --- | --- | --- |
| Tudo que é dado | Postgres | `pg_dump` diário, retenção 30 dias, um por semana guardado 1 ano |
| Anexos do WhatsApp | volume `paneldata` (`/var/lib/skygenpanel`) | snapshot do volume no mesmo horário |
| Os três segredos + `saas.env` | cofre da equipe | uma cópia; sem eles o dump é ilegível na parte cifrada |

```bash
# diário, fora do horário de pico
pg_dump "$DATABASE_URL" --format=custom --file="skygp-$(date -u +%F).dump"
# teste de restauração, mensal, num banco vazio
createdb skygp_restore && pg_restore --dbname=skygp_restore --no-owner skygp-2026-09-10.dump
```

### O que o painel agenda sozinho

A tabela acima descreve a edição hospedada, onde o Postgres é gerenciado e o snapshot é do
provedor. Para o **self-hosted** — que é o install do ISP, em SQLite, na máquina dele — o
`deploy/install.sh` instala e liga `skygenpanel-backup.timer`, diário às 03:17 com atraso
aleatório e `Persistent=true`. Timer e não cron por causa do `Persistent`: máquina
desligada às 3h roda o backup ao ligar, em vez de pular o dia em silêncio; e um `oneshot`
que falha fica `failed` e aparece em `systemctl --failed`, enquanto um cron que falha manda
um e-mail que ninguém lê.

Cada passada escreve um diretório em `/var/backups/skygenpanel` com o dump do banco (o
dialeto que o install usa, descoberto por `backend/scripts/backup-target.js`, que é o
único lugar que conhece a precedência `DATABASE_URL` > `db-config.json` > SQLite), o
`tar.gz` de `wa-media`, o `db-config.json`, e um `manifest.json` com tamanhos, `sha256`, a
versão do painel e **em que migração o dump foi tirado**. Retenção: 30 diárias mais o
domingo de cada uma das últimas 52 semanas.

**O `.env` não entra no backup.** O que entra é a impressão digital de `SECRET_BOX_KEY` e
de `JWT_SECRET` — os doze primeiros hex de um SHA-256 salgado com o nome da variável, nunca
o valor. A razão é o modo de falha de `secretBox.decrypt`, que devolve `null` em vez de
levantar: restaurar o banco com a chave errada sobe um painel que responde 200 e em que
toda senha de portal, senha de WiFi e token de API volta nula — o operador vê "o dado
sumiu" quando o que falta é a chave. `skygenpanel backup verify` compara as impressões do
backup mais novo com as do `.env` vivo e recusa em voz alta quando divergem, que é a hora
certa de descobrir isso: antes do restore, e não durante.

`SKYGP_BACKUP_INCLUDE_SECRETS=1` inclui o `.env` em claro, e o script avisa. Só vale se o
destino já for cifrado: o backup passa a carregar a chave mestra e a senha do banco ao lado
do dado, o que troca "perdi o dado" por "vazou o painel inteiro".

Duas decisões continuam sendo de quem opera, e o painel não as toma: **para onde a cópia
sai da máquina** (nada disto é backup enquanto vive no mesmo disco) e **instalar
`postgresql-client` ou `mariadb-client`** quando o install não usa SQLite — o script morre
dizendo qual pacote falta, em vez de escrever um arquivo vazio e sair zero.

Restauração de verdade: parar o painel, restaurar, subir. As migrations no boot
reconhecem o schema restaurado pelo `schema_migrations` e não refazem nada. Se o dump
for de uma versão mais antiga do painel, o boot aplica o que falta — é o caminho de
upgrade normal.

**Por provedor**, sem tocar no banco, o próprio provedor tem `GET /api/tenant/export`
(capacidade `tenant.export`, auditada): todas as tabelas dele na ordem que as chaves
estrangeiras pedem, sem segredo cifrado e sem hash de senha, com um manifesto dizendo o
que ficou de fora. É o que se entrega numa solicitação da LGPD e o que se guarda antes de
apagar um provedor.

**Por assinante**, na ficha do aparelho, o provedor atende o titular dele sem passar por
nós: `GET /api/customers/:accountId/export` (capacidade `customers.dossier`) monta o
dossiê de uma pessoa, e `DELETE /api/customers/:accountId` (capacidade `customers.erase`,
com o "ID do Cliente" digitado de volta) apaga. As duas ficam em `audit_log`; na exclusão
a linha da trilha é gravada **antes** e é condição para que ela aconteça. Dois avisos para
o plantão, porque chegam como chamado: o CPF que o SGP do ISP guarda não sai daqui, e uma
exclusão feita sem o serviço ter sido cancelado se desfaz na próxima `syncFleet` — a ONT
continua informando e a conta renasce com um ID do Cliente novo.

## 5. Desfazer: suspender, apagar

Ambos no console (`/platform`), ambos gravados em `platform_audit`, que é compartilhada e
**não tem chave estrangeira para `tenants`** — de propósito, para a linha que diz "este
provedor foi apagado" sobreviver ao provedor.

1. **Suspender** (`PATCH /api/platform/tenants/:id`): o provedor para de resolver na
   hora — todo host dele responde 404, os jobs de fundo pulam ele, os tokens existentes
   deixam de servir. Reversível.
2. **Apagar** (`DELETE /api/platform/tenants/:id`): exige estar no plano de controle, o
   provedor estar **suspenso** (o que faz da exclusão um segundo passo, com um estado
   reversível no meio) e o slug digitado de volta, exato. A linha da trilha é gravada
   **antes**, com a contagem do que vai sumir; se ela não puder ser gravada, nada é
   apagado. Numa instalação **sem** domínio-base há uma quarta condição — não ser o
   último provedor —, porque lá é ele que a resolução por padrão devolve, e sem nenhum o
   deployment inteiro responde 503. Onde o host nomeia o provedor essa condição não
   existe: o console vive no apex e continua de pé com zero clientes.

A assinatura é outra chave: `suspended`/`canceled` na assinatura derruba o painel e o
portal com 402 e mantém tudo no banco; `past_due` deixa ler. Um provedor inadimplente
não precisa ter o alerta de ONT caída parado.

### O console por dentro

Em `https://painel.exemplo.com/platform` — o endereço da plataforma, não o de um
provedor. Quatro abas:

- **Provedores** — criar, suspender, reativar, apagar, ver e mudar a equipe e a
  assinatura de cada um, e abrir o painel de um cliente em modo leitura.
- **Planos** — o catálogo: criar, editar preço, limites e período de teste, ativar e
  desativar. **O código de um plano não muda depois de criado** (é por ele que as
  assinaturas apontam), e mudar um plano só vale para quem assinar DEPOIS: a assinatura
  guarda o plano, não uma cópia dos números dele. Desativar não apaga — some da lista de
  escolha e continua valendo para quem já assina, que é como se para de vender um plano
  sem mexer em contrato de ninguém. Por isso não há botão de excluir plano.
- **Acesso à plataforma** — quem tem o plano de controle. O último não pode ser
  removido: um cadastro vazio tranca todo mundo para fora e só SQL recupera.
- **Trilha da plataforma** — o que a plataforma fez com cada provedor, paginado.

## 6. Trocar segredos

- `JWT_SECRET` / `PORTAL_JWT_SECRET`: trocar e reiniciar. Toda sessão cai; nenhum dado
  se perde.
- `SECRET_BOX_KEY`: **não** trocar sem plano. O que ela cifra (credencial NBI de cada
  provedor, senha de portal) fica ilegível. O `key_version` gravado junto de cada valor
  existe para a rotação com as duas chaves vivas, que é trabalho de uma onda própria e
  ainda não tem comando.
- `METRICS_TOKEN`: trocar, reiniciar, atualizar o coletor.

## 7. Entrar no painel de um cliente

O console tem, em cada provedor ativo, um botão que abre uma **sessão de atendimento**: o
painel daquele ISP, como os operadores dele o veem.

- **Só leitura.** Toda escrita é recusada com 403 `impersonation_read_only`, em qualquer
  rota. Quando um cliente precisa que alguém mexa em alguma coisa, quem mexe é a equipe
  dele — ou o console, que age em nome da plataforma e assina como tal.
- **Meia hora, sem renovação.** Continuar é voltar ao console e abrir outra.
- **Registrada dos dois lados.** Na nossa trilha (`platform_audit`, ação
  `tenant.impersonated`) e na trilha DO PROVEDOR (`audit_log`, ação
  `platform.impersonated`), que é onde ele vai olhar quando perguntar se entraram no painel
  dele. Conte com isso: o cliente pode ver, e é para poder.
- **Acaba sozinha** se quem a abriu sair de `platform_admins` ou trocar a senha.
- Uma faixa vermelha fica no alto de toda tela enquanto ela dura. "Sair" joga o token fora.

Um provedor **suspenso** não é personificável: o painel dele está fora do ar para os
operadores dele, e é isso que a sessão mostraria.

## 8. E-mail

Opcional, e o painel funciona sem. Com `SMTP_URL` e `MAIL_FROM` configurados, o convite de
equipe vai por e-mail quando quem convida informa um endereço; sem eles, o link sai na tela
para ser entregue como sempre foi.

O link precisa de um endereço absoluto. Com `TENANT_BASE_DOMAIN`, ele é derivado do slug de
cada provedor. Sem subdomínios, é `PUBLIC_BASE_URL` — e sem ela não há envio, porque o
painel não inventa o próprio endereço a partir do que a requisição disser.

Um SMTP fora do ar não quebra nada: o convite existe, a resposta diz `emailed: false` e o
link está ali.

### O que mais sai por e-mail

**A redefinição de senha** (`/forgot-password` no painel de cada provedor). Quem pede
recebe sempre a mesma resposta — exista a conta ou não —, porque a rota é pública e uma
resposta que variasse diria a um estranho quais identificadores têm conta ali. O link vale
trinta minutos, serve uma vez, só funciona no host onde foi cunhado e morre se o endereço da
conta mudar antes de ele ser usado. Concluir derruba todas as sessões daquela conta.

**A prova do endereço** (`/verify-email`). Um endereço cadastrado prova que alguém controla
a CONTA — a senha atual é exigida —, não que controla o ENDEREÇO. A diferença não custava
nada enquanto só a senha abria a conta e passa a custar tudo com a redefinição por e-mail:
um endereço digitado errado seria um caminho para dentro. Por isso **só endereço verificado
recebe redefinição**, e a verificação é desfeita a cada troca de endereço.

Consequência prática do upgrade: **todo endereço já cadastrado entra como não verificado**.
Ninguém fica trancado do lado de fora — a verificação não é condição de login, só de
redefinição —, mas até cada pessoa confirmar o seu, "esqueci minha senha" não funciona para
ela. A tela de conta mostra o aviso e o botão que manda a prova. Vale avisar a equipe na
janela do upgrade, e sem SMTP configurado nenhum dos dois caminhos existe: nesse deploy a
senha esquecida continua sendo resolvida por quem administra.

Nenhuma das duas mensagens carrega dado de provedor — nome de operador, contagem de
assinantes, nada. Uma caixa de entrada alheia não é lugar onde isso mora.

## 9. O que este documento não cobre, porque ainda não existe

- Gateway de cobrança, **a metade que emite**. A metade que RECEBE já existe: ver
  a seção 10.
- O **comando de re-cifra** da rotação da `SECRET_BOX_KEY`. As duas chaves vivas
  já existem e já funcionam: pôr a chave antiga em `SECRET_BOX_KEY_PREVIOUS` faz
  o painel LER o que foi cifrado com ela e ESCREVER só com a nova. O que não
  existe é o passo que percorre as linhas antigas e as reescreve — sem ele, uma
  linha só migra quando alguém a edita, e a chave antiga tem que continuar no
  `.env` indefinidamente.

## 10. Receber pagamento sozinho

Até aqui o pagamento de um provedor era um botão no console: alguém conferindo extrato e
marcando à mão. Com dez clientes passa; com cinquenta é uma pessoa por dia, e é uma pessoa
que erra.

`POST /api/billing-webhook` recebe a entrega do gateway e credita a assinatura. Três coisas
para ligar:

1. **`BILLING_WEBHOOK_TOKEN` no `.env` do deploy.** É a credencial que o gateway devolve
   no cabeçalho `asaas-access-token` de toda entrega, e é do **deploy** e não de um
   provedor: há uma conta no gateway e ela é nossa. Sem a variável configurada a rota
   responde **404** — uma rota que mexe em dinheiro não pode ficar aberta porque alguém
   esqueceu uma linha.
2. **O endereço, no painel do gateway:** `https://<apex>/api/billing-webhook`. A rota é
   montada acima do resolvedor de provedor de propósito: o apex não nomeia provedor
   nenhum, e resolvida por host a entrega levaria 404 antes do controlador.
3. **A correlação, no console**, aba *Gateway* de cada provedor: o nome do gateway
   (`asaas`) e o id do cliente lá dentro (`cus_…`). É por ela que a entrega volta ao
   provedor certo. Enquanto ela não existir, o pagamento vira uma linha de log dizendo
   `no provider for payment …` e a cobrança segue manual. **Só o console escreve** esses
   dois campos: um provedor que pudesse escrever o próprio id apontaria para o cliente de
   outro e receberia o crédito alheio.

O caminho de volta tem duas chaves, nesta ordem: a nossa própria referência
(`externalReference` no formato `tenant:<id>`, quando fomos nós que criamos a cobrança) e o
id do cliente no gateway (para a cobrança emitida lá dentro, à mão — que é como os
primeiros contratos vão ser cobrados). Provedor suspenso ou apagado não resolve por
nenhuma das duas.

**A disciplina de status, que é o que impede uma fila de reentrega infinita:** 401 uniforme
para credencial que não presta, 404 para deploy sem gateway ligado, 500 só para falha
genuína deste lado — e **200 para tudo que se escolhe não fazer**: reentrega, evento que
não é dinheiro entrando, pagamento que não resolve provedor nenhum. Um não-2xx faz o
gateway reentregar em laço para sempre.

**A mesma referência credita uma vez só**, e a chave é o id do **pagamento**, não o do
evento. O gateway manda dois eventos para um pagamento de cartão — `PAYMENT_CONFIRMED`
quando a operadora aprova e `PAYMENT_RECEIVED` quando o dinheiro cai, trinta dias depois.
Os dois falam do mesmo `payment.id`, então o segundo responde `duplicate` e não empurra a
data. Com a chave no id do evento, todo cartão ganharia dois períodos e ninguém perceberia
por meses.

**O que conferir antes da primeira cobrança de verdade.** O formato do corpo é a única
coisa aqui que não se verifica sem uma conta no gateway: ele está lido de uma função pura
(`AsaasBillingProvider.interpretar`) e falha FECHANDO — um campo que mudou de nome devolve
"não faço nada" e ninguém é creditado, em vez de creditar errado. Mande uma entrega de
teste pelo painel do gateway e confira no log do processo: `nothing to do with event "…"`
significa que o corpo chegou e não foi reconhecido.

**O que continua manual:** emitir a cobrança. A cobrança se cria hoje no painel do
gateway; o que o painel faz sozinho é receber a notícia e creditar. Periodicidade em
`plans` (hoje o período pago é 30 dias cravados), a régua de emissão e o link de pagamento
no e-mail de vencimento são a metade que falta.
