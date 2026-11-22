# Plano: integração com Facebook Messenger

Status: Fase 1 implementada no backend (migração `0144_messenger`, webhook, entrada, envio, conexão da Página,
API `/api/messenger`, LGPD e testes). A tela (`/messenger`: caixa de entrada e Páginas conectadas) também está pronta. Falta o
vínculo com o assinante, o outbox com retry e a revisão da Meta. Desvios do plano original estão em "Como ficou" no fim.

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
- Política de privacidade/exclusão de dados (callback de data deletion) e inclusão do canal em
  `docs/lgpd-inventario-de-dados.md` (retenção, opt-out).
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
- Não há ainda prévia da última mensagem na lista (o endpoint não a devolve) nem login do Facebook: o token da
  Página é colado.
