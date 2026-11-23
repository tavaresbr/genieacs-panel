# Plano: integração com Facebook Messenger

Status: Fase 1 implementada no backend (migração `0144_messenger`, webhook, entrada, envio, conexão da Página,
API `/api/messenger`, LGPD e testes). A tela (`/messenger`: caixa de entrada e Páginas conectadas) também está pronta. Falta o
a revisão da Meta. O vínculo com o assinante é manual (ver abaixo). Desvios do plano original estão em "Como ficou" no fim.

## O que o código atual diz

- O WhatsApp do painel passa pelo **Evolution API** (`utils/wa/evolutionApi.js`), exceto o número oficial
  (`integration = 'cloud'`), que também passa pelo Evolution. Já existe cliente direto da Graph API:
  `services/metaGraphClient.js` (host fixo, token no cabeçalho, erros sanitizados) — é a base do Messenger.
- `wa_conversations` / `wa_messages` são **centradas em telefone**: `account_id` NOT NULL
  → `whatsapp_accounts`, `wa_phone_e164`, `wa_lid`, `external_thread_id`, e `WaOptOut` é chaveado por telefone.
  Outbox (`waOutboxWorker`), envio (`waSendService`), bot, IA, cobrança e campanhas assumem esse formato.
- Segredos de conta são cifrados com `encryptSecret/decryptSecret` (`whatsappConfigService`), com
  rotação em `scripts/rotate-secret-key.js`. Multi-tenant com RLS (`tdb`, `runInTenant`, sentinela SQL).
- Webhooks públicos ficam montados antes de `authenticateToken` (`app.js`) com rate limit próprio.

## Decisão revisada

A ideia inicial (coluna `channel` nas tabelas do WhatsApp) é **arriscada**: tocaria outbox, envio, IA,
cobrança e opt-out, todos presos a telefone/Evolution. Recomendação em duas fases:

1. **Fase 1 — canal isolado.** Tabelas próprias `messenger_pages`, `messenger_conversations`,
   `messenger_messages`, serviços próprios e uma tela de inbox simples. Zero risco ao WhatsApp.
2. **Fase 2 — unificar.** Só depois que a Fase 1 estiver em produção: visão única de inbox (união no
   nível da API/UI), reaproveitando atribuição, tags e IA via uma interface `Channel`. Instagram DM
   entra aqui quase de graça (mesma API, outro `object`).

## Fase 1 — escopo

### Banco (nova migração, tenant-scoped + RLS como as demais)
- `messenger_pages`: `id`, `tenant_id`, `page_id` (unique global — resolve o tenant no webhook),
  `page_name`, `page_token` (cifrado, `token_key_version`), `status`, `subscribed_at`, `webhook_error`,
  `webhook_refused_at/reason` (mesmo padrão de observabilidade do WhatsApp).
- `messenger_conversations`: `page_id_fk`, `psid`, `name`, `contract`, `customer_account_id`,
  `last_message_at`, `last_inbound_at`, `unread_count`, `closed_at`; unique (`page_id_fk`, `psid`).
- `messenger_messages`: `conversation_id`, `direction`, `external_id` (= `mid`, unique → deduplicação),
  `body`, anexo, `delivery_status`, `attempts`, `claimed_at`, `sent_by`, `source`.
- Opt-out: tabela própria por PSID (um opt-out vale por canal, e é o lado perigoso se faltar).

### Backend
- `config/messengerWebhookPath.js` → `/api/messenger-webhook` (constante isolada, como `waWebhookPath.js`).
- `routes/messengerWebhook.js` (público, `waWebhookLimiter`):
  - `GET`: confere `hub.verify_token` e devolve `hub.challenge`.
  - `POST`: valida `X-Hub-Signature-256` (HMAC-SHA256 do **body bruto** com o app secret; `timingSafeEqual`),
    responde 200 logo e processa assíncrono (fila no padrão `waInboundQueue`); resolve tenant por
    `entry[].id` (page_id) via lookup não escopado declarado com `runUnscoped`, como `WhatsAppAccount.getByName`.
- `services/messengerInboundService.js`: `messages`, `message_deliveries`, `message_reads`,
  `messaging_postbacks`; ignora `is_echo` de outros apps ou os grava como saída; dedup por `mid`.
- `services/messengerSendService.js` + worker de outbox (reaproveitar `retryDelayMs`/`MAX_ATTEMPTS`):
  `POST /{page-id}/messages` via `graphRequest`, `messaging_type: RESPONSE`.
  **Janela de 24 h** (análoga a `waJanelaMeta.js`): fora dela, bloquear no backend com erro claro;
  tag `HUMAN_AGENT` (7 dias) só se a Meta aprovar.
- `services/messengerPageService.js`: conectar Página (Facebook Login → troca por token de longa duração →
  token da Página), `POST /{page-id}/subscribed_apps` com `subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads`.
- Rotas autenticadas `/api/messenger/*` atrás de `requireAddon('messenger')` e permissão
  `messenger.read` / `messenger.send` (`config/permissions.js`).
- Variáveis de ambiente (plataforma, não por tenant): `META_APP_ID`, `META_APP_SECRET`,
  `MESSENGER_VERIFY_TOKEN`. O app secret nunca vai ao navegador.

### Frontend
- Tela de configuração (conectar/desconectar Página, estado do webhook) junto de `platform-integrations`.
- Inbox: lista + thread + composer, indicando "janela fechada" quando passar de 24 h.

### Vínculo com assinante
O PSID não traz telefone. Opções: link `https://m.me/<PAGINA>?ref=<token>` emitido na fatura/portal
(`ref` chega no evento `referral`/`postback`), ou fluxo de bot pedindo CPF/contrato com validação.

### Testes
Padrão de `backend/test/*.test.js`: assinatura HMAC (válida/inválida/body adulterado), challenge GET,
dedup de `mid`, janela de 24 h, isolamento entre tenants, cifra do token da Página.

## Fora do código (caminho crítico)
- App Meta com produto Messenger; **App Review** de `pages_messaging` (+ `pages_manage_metadata`,
  `pages_show_list`) e Business Verification — é o que mais demora; começar já.
- Política de privacidade (URL no app da Meta) e inclusão do canal em `docs/lgpd-inventario-de-dados.md`.
  Os callbacks de desautorização e exclusão de dados já existem (ver "Avisos da Meta sobre o usuário do Facebook").
- Cobrança ativa por Messenger é muito limitada (sem templates): manter WhatsApp para isso.

## Ordem de implementação
1. Migração + modelos  2. Webhook (GET/POST + HMAC)  3. Inbound + dedup  4. Conexão da Página
5. Envio + outbox + janela 24 h  6. API/permissões/add-on  7. UI  8. Testes + docs  9. Fase 2.

## Como ficou (Fase 1, backend)

- **Webhook síncrono e idempotente**, não assíncrono: `POST /api/messenger-webhook` valida a assinatura sobre o
  corpo bruto, grava e só então responde 200. Um 500 faz a Meta reentregar, e o `mid` único impede duplicar.
  Assinatura inválida → 401 sem ler o corpo; Página desconhecida ou corpo ilegível → 200 (reentregar não conserta).
- **Envio direto, sem outbox**: `messengerSendService` chama a Graph na hora e grava `sent` ou `failed` com o
  motivo. O outbox com retry fica para quando houver envio automático (bot/avisos); hoje todo envio é de um
  operador olhando a tela.
- **Sem tabela de opt-out**: a Fase 1 só responde a quem escreveu (janela de 24 h) e nunca inicia contato, que é
  o que o opt-out bloqueia. Entra junto com qualquer envio proativo.
- **Permissões e add-on do WhatsApp** (`whatsapp.read/send/config`, `requireAddon('whatsapp')`) em vez de
  `messenger.*`: o atendimento é um só e não exige mexer na matriz de papéis.
- **Segredos da plataforma**: `META_APP_SECRET` e `MESSENGER_VERIFY_TOKEN` (ver `backend/.env.example`).
  Sem eles o webhook recusa tudo e a conexão de Página responde 503.
- **Conexão de Página** recebe `pageId` + `pageToken` (a tela fará o login do Facebook e entregará o token da
  Página); o painel confere o token na Graph, assina `messages, message_deliveries, message_reads,
  messaging_postbacks` e guarda o token cifrado.
- **LGPD**: `messenger_conversations`/`messenger_messages` entram no dossiê e na exclusão do assinante (por
  `customer_account_id` ou `contract`); `messenger_pages` está em `SEM_DADO_DE_ASSINANTE`. Como ainda não há
  vínculo, hoje nenhuma conversa casa com um assinante — o alcance passa a valer quando o vínculo existir.

### Tela (`/messenger`)
- Caixa de entrada com abertas/arquivadas, conversa com recibos, aviso da janela de 24 h (o campo de resposta
  fecha, e o servidor continua sendo quem recusa), arquivar/reabrir. Atualiza por polling (15 s a lista, 8 s a
  conversa aberta).
- Painel "Páginas do Facebook" (só com `whatsapp.config`): conectar por ID + token da Página, estado da
  assinatura, desconectar com confirmação. O token só vai do campo ao servidor.
- Item de menu "Messenger" (`whatsapp.read`); textos nos 13 idiomas (pt-BR e es traduzidos; os demais em
  inglês, como as outras chaves novas do projeto).
- A lista mostra a prévia da última mensagem (texto numa linha, limitado a 120 caracteres no servidor; "Você:" para
  o que a equipe mandou; o tipo do anexo quando não há texto) e a hora (hoje) ou a data. "Última" é a última
  gravada (maior `id`), não a de maior hora: a Meta pode entregar fora de ordem. A URL do anexo não vai na lista.
- O token da Página também pode ser colado à mão (ver "Login do Facebook" para o caminho sem colar).

### Vínculo com o assinante (manual)
- O PSID não traz telefone, então não há vínculo automático como no WhatsApp: o atendente busca o cliente
  no cadastro (a mesma busca de contatos do WhatsApp) e vincula pela conversa. O vínculo é o mesmo do WhatsApp
  — contrato do SGP (`contract`, com `customer_account_id` quando a ONT do contrato tem conta no portal) ou o
  cliente sem contrato (`sgp_contact_id`, migração `0145`) —, e `bound_via = 'operator'`.
- `POST/DELETE /api/messenger/conversations/:id/subscriber` (`whatsapp.send`). Contrato de outro provedor, ou
  inexistente, dá o mesmo 404 `subscriber_not_found`.
- A lista e a conversa mostram o nome do cliente (o da ONT vence o do cadastro, como no WhatsApp); o dossiê e a
  exclusão do assinante alcançam a conversa por conta, contrato ou `sgp_contact_id`.
- Vínculo automático por link: ver abaixo. Ainda fora: fluxo de bot que pede CPF/contrato.

### Vínculo automático por link (`?ref=`)
- O painel emite `https://m.me/<id da Página>?ref=<token>` e, quando o assinante o abre, o evento chega ao
  webhook como `referral` (quem já tinha conversa), dentro de `postback` (quem a abre agora) ou na primeira
  mensagem; a conversa é vinculada ao contrato do link (`bound_via = 'link'`). A assinatura da Página passa a
  incluir `messaging_referrals` (Páginas já conectadas usam "Atualizar inscrição", `POST /pages/:id/subscribe`).
- **Token:** 16 bytes aleatórios em base64url; só o SHA-256 fica guardado (`messenger_link_tokens`, migração
  `0146`). **Uso único** e vence em 7 dias (resgate atômico, `used_at is null` no UPDATE, numa transação com o
  vínculo). O resgate roda no provedor dono da Página e a leitura é escopada: token de outro provedor não existe.
  **Nunca sobrescreve** um vínculo já feito (o do atendente vale mais). O que o link NÃO prova é quem o abriu —
  quem o tem, vincula —, por isso fica marcado e o atendente pode desvincular.
- **Quem emite:** o atendente, em "Link do Messenger" na tela do contato (`POST /api/messenger/links`,
  `whatsapp.send`); e o próprio assinante logado no portal, pelo botão "Messenger" do cartão de contato do
  provedor (`POST /api/customer/messenger-link`, contrato da ONT dele — o vínculo de maior confiança). O botão
  do portal só aparece com o cartão de contato ligado e uma Página conectada (`provider.messenger`).
- **LGPD/retenção:** os links entram no dossiê e na exclusão do assinante; registros vencidos há mais de 30 dias
  são podados pelo agendador (`MESSENGER_LINK_TOKEN_RETENTION_DAYS`).
- A confirmação à pessoa no Messenger: ver abaixo.

### Link do Messenger na cobrança do WhatsApp (`{{link_messenger}}`)
- Variável **opcional** dos modelos de cobrança: o provedor escolhe onde ela vai (e em quais modelos) escrevendo-a
  no texto, numa linha só dela. Cada cobrança leva um link de uso único para o contrato daquela pessoa; quando ela
  o abre no Messenger, a conversa nasce vinculada (`bound_via = 'link'`, `source = 'invoice'` no token).
- **Opcional de verdade:** a regra 1 do renderizador (variável vazia recusa a mensagem) abre uma exceção só para
  ela — vazia, a linha que a cita sai e a cobrança vai. Sem isso, uma Página fora do ar bloquearia a cobrança.
- Onde vale: régua automática, campanha de cobrança e segunda via. Na régua o link é emitido só no instante em
  que a mensagem vai para a fila (depois da simulação, do intervalo mínimo e da corrida entre passadas), então
  nenhum deles deixa link emitido à toa. O modelo aprovado da Meta (número oficial fora da janela) vai como foi
  aprovado, sem a variável. O "Enviar na conversa" (mensagens fixas de resumo, PIX e linha) não leva o link: lá o
  atendente usa o botão "Link do Messenger" da tela do contato.
- Limite: numa campanha de cobrança o link é emitido ao montar o rascunho; um rascunho parado por mais de 7 dias
  tem links vencidos.

### Confirmação à pessoa depois do vínculo por link
- Quando um link é resgatado e a conversa é vinculada, a própria pessoa recebe uma mensagem no Messenger
  ("Recebemos o seu contato… já vinculamos esta conversa ao seu cadastro… Como podemos ajudar?"). Só quando
  ESTE evento vinculou: link inválido, já gasto, vencido ou conversa já vinculada não confirmam, e a reentrega do
  mesmo evento não confirma de novo (o link já foi gasto).
- **Nunca leva nome, contrato nem dado do cadastro.** O link não prova quem o abriu; um link repassado não pode
  entregar esses dados a quem o recebeu. O texto não tem variáveis de propósito.
- É resposta a uma ação da pessoa, então cabe na janela de 24 h: o clique no link conta como a última interação
  dela (`last_inbound_at`), mesmo quando o evento não traz mensagem (`referral`, `postback`). Se a Meta recusar, a
  tentativa fica gravada como falha, com o motivo, e o webhook responde 200 do mesmo jeito (o vínculo já está
  feito; a Meta não deve reentregar um evento tratado). A mensagem fica com `source = 'system'` e a conversa a
  mostra como "Mensagem automática".
- **Configuração do provedor** (`GET/PUT /api/messenger/settings`, `whatsapp.config`): ligar/desligar (ligada por
  padrão) e trocar o texto (até 500 caracteres; vazio volta ao de fábrica), na tela do Messenger.
- A confirmação passa pela fila de saída (abaixo): uma falha passageira da Meta é tentada de novo.

### Fila de reenvio (saída)
- `messenger_messages` É a fila (como `wa_messages`): estados `queued` (espera a vez ou o recuo), `sending` e depois
  `sent`/`failed`; colunas `attempts`, `claimed_at` e `next_attempt_at` (migração `0147`).
- **O envio tenta já.** `MessengerSendService.sendText` valida o que dá para dizer na hora (texto, janela, Página),
  grava a mensagem como `queued` e chama a mesma `deliver()` do laço de fundo: o caso comum sai na hora (201). O que
  a Meta ou a rede não aguentaram fica na fila (202) e é reenviado pelo `MessengerOutboxWorker` (passada a cada 5 s,
  iniciada por `server.js`); recusa da Meta por motivo dela fica `failed` com o motivo (502, código `send_refused`).
- **Recuo:** a mesma curva da fila do WhatsApp — 30 s, 1, 2, 4, 8 e 16 min, sete tentativas, teto de 30 min (um teste
  confere que as duas não divergem).
- **O que é passageiro e o que não é:** rede fora, 5xx, 429 e os códigos de cota da Graph (1, 2, 4, 17, 32, 341, 613)
  tentam de novo; token inválido (190/102/401) e qualquer outra recusa nomeada pela Meta (janela, pessoa
  indisponível, permissão, parâmetro) não mudam com o tempo e falham na hora. Token inválido também põe a Página em
  "requer atenção", e novas respostas são recusadas até ela ser reconectada. Diferente da fila do WhatsApp (que na
  dúvida tenta de novo), aqui a Meta diz o que houve, então só a dúvida sobre o transporte cai para tentar de novo.
- **O que a fila nunca faz:**
  - mandar uma mensagem duas vezes — o claim é um UPDATE condicional (duas passadas ao mesmo tempo: uma só pega) e o
    `mid` é único por provedor;
  - desrespeitar a janela — conferida de novo a cada tentativa, e uma mensagem que esperou o recuo e viu a janela
    fechar falha na hora, sem chamar a Meta;
  - passar na frente: uma resposta espera a irmã mais antiga da mesma conversa que aguarda nova tentativa (até 10
    min; depois disso uma falha não segura a conversa);
  - criar uma segunda bolha quando o eco da Meta (`is_echo`) chega antes da confirmação: a linha do eco é adotada
    (ganha a origem e o autor da mensagem) e a da fila sai.
- Uma mensagem "enviando" há mais de 5 min é considerada abandonada (o processo caiu) e retomada. Limite: se o
  processo cair DEPOIS de a Meta aceitar e ANTES de gravar o `mid`, a retomada pode mandar a mensagem de novo — a
  Meta não oferece chave de idempotência no Send API.
- A conversa mostra "Na fila" / "Vai tentar de novo (tentativa N de 7)" e passa a se atualizar a cada 3 s enquanto
  houver resposta a caminho. Sem botão de reenviar à mão: uma mensagem `failed` se digita de novo.

## Login do Facebook

Em vez de colar o ID e o token, quem configura clica em **Entrar com o Facebook** na tela do Messenger.

- Liga com `META_APP_ID` (id do app, público) além de `META_APP_SECRET` e `MESSENGER_VERIFY_TOKEN`. Sem o id, a tela
  só mostra o formulário manual; `GET /api/messenger/status` traz `facebookLogin: { available, appId }`.
- O painel abre o popup `/messenger-connect.html?app=<id>` (arquivo estático, como o do WhatsApp; a CSP da rota é a
  mesma, só com os domínios do Facebook). O SDK da Meta faz o `FB.login` com `pages_show_list`, `pages_messaging` e
  `pages_manage_metadata` e a página devolve ao painel **só o token de curta duração do usuário**, por
  `postMessage` para a própria origem; o painel só aceita a mensagem da janela que ele abriu.
- `POST /messenger/facebook/pages` troca esse token pelo de longa duração (`fb_exchange_token`, com o segredo do app,
  só no servidor), lê `/me/accounts` e devolve `{ id, name, connected }` por Página — nenhum token.
- `POST /messenger/facebook/connect` (`userToken` + `pageId`) repete a troca, pega o token que a Meta entregou para
  aquela Página (sem prazo quando o do usuário é de longa duração) e passa por `MessengerPageService.connect`: o mesmo
  caminho da conexão manual (confere identidade, assina o webhook, guarda cifrado). Página que o usuário não
  administra dá 403 `page_not_administered`. Nada é guardado entre os dois passos; o navegador reenvia o token.
- Como no Embedded Signup do WhatsApp, o SDK só funciona nos domínios cadastrados no app da Meta; em outro o popup
  abre e o login falha.
- Continua valendo a revisão da Meta: sem `pages_messaging` aprovado o app só fala com quem tem função nele.

## Avisos da Meta sobre o usuário do Facebook

A Meta exige, para aprovar um app com Login do Facebook, uma URL de **desautorização** e outra de **exclusão de
dados**. No painel do app (Configurações → Básico / Login do Facebook → Configurações) cadastre:

| Campo | URL |
|---|---|
| Callback de desautorização | `https://<painel>/api/messenger-webhook/deauthorize` |
| URL de solicitação de exclusão de dados | `https://<painel>/api/messenger-webhook/data-deletion` |

- Os dois recebem `POST` (formulário) com `signed_request`; a credencial é a assinatura HMAC-SHA256 com
  `META_APP_SECRET` (falha fechada: sem segredo ou assinatura ruim, 401, e nada é tocado).
- O `user_id` é o do usuário NO APP, gravado em `messenger_pages.facebook_user_id` (migração `0148`) quando a Página é
  conectada pelo login do Facebook; só esse número, sem nome nem e-mail. Página colada à mão não guarda o id de ninguém.
- **Desautorização**: as Páginas daquele usuário (em todos os provedores) vão para "requer atenção"
  (`facebook_deauthorized`); nada é apagado.
- **Exclusão de dados**: apaga o token e o id no app dessas Páginas (`facebook_data_deleted`; ficam sem assinatura até
  alguém reconectar). Responde `{ url, confirmation_code }`. As conversas **não** são apagadas: são do provedor e dos
  clientes dele, e o pedido de titular delas segue o fluxo LGPD do provedor.
- A `url` aponta para `/api/messenger-webhook/deletion-status?code=…`: página de texto fixo que só confirma códigos
  emitidos pelo painel (o código leva a data e um HMAC, sem guardar nada em banco) e nunca imprime o que veio na URL.
