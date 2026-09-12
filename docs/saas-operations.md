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

O apex `painel.exemplo.com` (e `www.`) é a **porta de entrada da plataforma**: só
responde `GET /api/tenant/public` e `POST /api/auth/signup`, e a tela ali é o cadastro.
Nada de nenhum provedor é servido nesse host. O apex do portal não serve nada.

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

Um deploy novo tem um provedor (`default`) e ninguém dentro. Abra
`https://default.painel.exemplo.com`, e o assistente de instalação cria o primeiro
`owner`. Na edição SaaS esse primeiro usuário entra também em `platform_admins`: é a
chave do console. Daí em diante, quem já está no cadastro concede a outros pela aba
**Acesso à plataforma** do console — ninguém ganha o plano de controle sozinho, e a
concessão fica na trilha com quem deu a quem.

**Num install que começou self-hosted e virou SaaS**, `platform_admins` está vazia e
nenhuma migração promove ninguém — de propósito: um upgrade não pode transformar o
administrador local de um ISP em operador da plataforma. Aí a primeira chave é uma
inserção na mão, uma vez:

```sql
INSERT INTO platform_admins (user_id) SELECT id FROM users WHERE username = 'quem-opera';
```

Depois disso o console se administra sozinho.

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

Restauração de verdade: parar o painel, restaurar, subir. As migrations no boot
reconhecem o schema restaurado pelo `schema_migrations` e não refazem nada. Se o dump
for de uma versão mais antiga do painel, o boot aplica o que falta — é o caminho de
upgrade normal.

**Por provedor**, sem tocar no banco, o próprio provedor tem `GET /api/tenant/export`
(capacidade `tenant.export`, auditada): todas as tabelas dele na ordem que as chaves
estrangeiras pedem, sem segredo cifrado e sem hash de senha, com um manifesto dizendo o
que ficou de fora. É o que se entrega numa solicitação da LGPD e o que se guarda antes de
apagar um provedor.

## 5. Desfazer: suspender, apagar

Ambos no console (`/platform`), ambos gravados em `platform_audit`, que é compartilhada e
**não tem chave estrangeira para `tenants`** — de propósito, para a linha que diz "este
provedor foi apagado" sobreviver ao provedor.

1. **Suspender** (`PATCH /api/platform/tenants/:id`): o provedor para de resolver na
   hora — todo host dele responde 404, os jobs de fundo pulam ele, os tokens existentes
   deixam de servir. Reversível.
2. **Apagar** (`DELETE /api/platform/tenants/:id`): exige quatro coisas ao mesmo tempo —
   estar no plano de controle, o provedor estar **suspenso** (o que faz da exclusão um
   segundo passo, com um estado reversível no meio), o slug digitado de volta, e não ser o
   último provedor. A linha da trilha é gravada **antes**, com a contagem do que vai
   sumir; se ela não puder ser gravada, nada é apagado.

A assinatura é outra chave: `suspended`/`canceled` na assinatura derruba o painel e o
portal com 402 e mantém tudo no banco; `past_due` deixa ler. Um provedor inadimplente
não precisa ter o alerta de ONT caída parado.

### O console por dentro

Quatro abas em `/platform`:

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

- Gateway de cobrança: hoje o `ManualBillingProvider` registra o pagamento pelo
  console. Asaas ou similar entra quando houver contrato para cobrar.
- O **comando de re-cifra** da rotação da `SECRET_BOX_KEY`. As duas chaves vivas
  já existem e já funcionam: pôr a chave antiga em `SECRET_BOX_KEY_PREVIOUS` faz
  o painel LER o que foi cifrado com ela e ESCREVER só com a nova. O que não
  existe é o passo que percorre as linhas antigas e as reescreve — sem ele, uma
  linha só migra quando alguém a edita, e a chave antiga tem que continuar no
  `.env` indefinidamente.
