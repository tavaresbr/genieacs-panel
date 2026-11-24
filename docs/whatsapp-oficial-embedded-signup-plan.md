# Plano: conectar o WhatsApp API Oficial pelo painel (Evolution + Embedded Signup)

Status: **Fases 1 (backend) e 2 (popup) implementadas**; Fases 0, 3, 4 e 5 (parte) pendentes. Escrito a partir do código em `main` (v1.66.0).

## O que já existe (não refazer)

O número oficial **já funciona** de ponta a ponta quando alguém cola as credenciais à mão:

| Peça | Onde |
| --- | --- |
| Criar instância `WHATSAPP-BUSINESS` no Evolution v2 (`kind: 'cloud'`) | `EvolutionInstanceService.createAccount` |
| Trocar token vencido (recria a instância, mesmo `instanceName`) | `updateCloudToken`, `POST /accounts/:id/meta-token` |
| Registrar o webhook da WABA na Meta (`subscribed_apps` + `override_callback_uri`) | `metaWebhookService.js`, `POST /accounts/:id/meta-webhook` |
| Saúde do número (qualidade, limite, nome verificado) | `metaNumberHealthService.js` |
| Modelos aprovados: sincronizar, criar, editar, apagar | `waMetaTemplateService.js`, `/accounts/:id/templates` |
| Janela de 24 h / envio por modelo | `utils/wa/waJanelaMeta.js` |
| Cliente da Graph (host fixo, token no cabeçalho, erro sanitizado) | `metaGraphClient.js` |
| Colunas `integration`, `meta_phone_number_id`, `meta_waba_id`, `meta_*` | `whatsapp_accounts` |
| Login do Facebook dentro do painel (padrão a copiar) | `messengerFacebookLoginService.js` + `messenger-connect.html` |

## O que falta (o problema real)

1. **Cadastro manual e frágil.** O provedor cria app na Meta, gera token de usuário do sistema, copia
   Phone Number ID e WABA ID e cola três campos (`whatsapp-connection.tsx`). É onde a maioria trava.
2. **`whatsapp-signup.html` é só um visor de IDs.** `APP_ID` e `CONFIG_ID` estão fixos no JS, o
   `code` (expira em 30 s) é mostrado na tela e **nada chama o backend**. Na coexistência o provedor
   ainda roda `curl` na mão para `subscribed_apps` e `smb_app_data`, com **prazo de 24 h**.
3. **Um app da Meta por provedor** (contrato, linha ~296). Escala mal na SaaS; o app único da plataforma
   exige virar Tech Provider, que o contrato deixa "para depois".
4. **Coexistência incompleta:** `smb_message_echoes` (mensagens enviadas pelo celular) pode ser ignorado
   pelo `/webhook/meta` do Evolution e não aparecer no painel (`whatsapp-coexistencia.md`).

## Meta do plano

Botão **"Conectar número oficial"** na tela Conexão WhatsApp → popup do Embedded Signup → o painel
termina sozinho (token, conta, webhook, modelos, saúde e, na coexistência, a sincronização) → o
provedor só vê "conectado". O caminho manual atual **continua** como alternativa (self-host sem app
único; não remover).

## Fases

### Fase 0 — Pré-requisitos na Meta (fora do código; bloqueia a Fase 2)

- Decidir **app único da plataforma** (recomendado) vs app por provedor. O app único exige verificação
  da empresa + **Tech Provider** + `whatsapp_business_management` / `whatsapp_business_messaging` com
  Advanced Access. Sem isso o Embedded Signup só funciona para quem tem papel no app (modo dev).
- Config do Embedded Signup **v4** (a v2 morre em 15/10/2026), com os dois fluxos: número novo e
  coexistência (`whatsapp_business_app_onboarding`).
- Webhook do app: `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`, `account_update`.
- Variáveis da plataforma: reutilizar `META_APP_ID` / `META_APP_SECRET` (já usadas pelo Messenger);
  acrescentar `META_WA_CONFIG_ID`. **Tirar `APP_ID`/`CONFIG_ID` fixos do JS** — a página passa a
  receber do backend.

### Fase 1 — Backend: terminar o cadastro no servidor

Novo `services/whatsappEmbeddedSignupService.js`, no molde de `messengerFacebookLoginService.js`:

1. `POST /api/whatsapp/embedded-signup/start` (`whatsapp.config`) → devolve `{ appId, configId, state }`.
   `state` é um nonce **de uso único, curto (≈10 min), preso a tenant + usuário** (guardar em
   `app_state` ou tabela própria). Sem `META_APP_ID`/`META_WA_CONFIG_ID` → `503 embedded_signup_unconfigured`
   e a tela cai no formulário manual.
2. `POST /api/whatsapp/embedded-signup/complete` com `{ state, code, wabaId, phoneNumberId, event }`:
   - consome o `state` (reuso/expirado/outro tenant → recusa);
   - troca o `code` por token **no servidor** (`GET /oauth/access_token` com `META_APP_SECRET`; o
     segredo nunca vai ao navegador; o `code` vale 30 s, então é a primeira coisa a fazer);
   - confere que `phoneNumberId` pertence a `wabaId` (`GET /{phone}?fields=...` com o token novo) —
     não confiar nos IDs que vieram do navegador;
   - **reaproveita** `EvolutionInstanceService.createAccount({ kind: 'cloud', metaToken, phoneNumberId, wabaId })`
     (já registra webhook, sincroniza modelos e lê saúde — não duplicar);
   - rejeita número já ligado a **outro** tenant (`meta_phone_number_id` único globalmente, como o
     `getByName` do webhook) e deve ser idempotente se for o mesmo tenant (cai em `updateCloudToken`).
3. **Coexistência** (`event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'`): depois do create, em fila
   e com retentativa, chamar `subscribed_apps` e então `smb_app_data` (`smb_app_state_sync`, depois
   `history`). **Cada `sync_type` só vale uma vez**: gravar o `request_id` e o estado
   (`pending|ok|error`) em colunas novas e nunca repetir sozinho. **Nunca** chamar `/register` num
   número em coexistência (derruba o vínculo). Guardar `coexistence_deadline_at` (= conexão + 24 h)
   e alertar a tela antes de vencer.
4. Webhook `account_update` (`ACCOUNT_OFFBOARDED` / `ACCOUNT_RECONNECTED`) marcando a conta
   `disconnected`/`connected` e acendendo o alerta técnico existente (`waAlertService`).
5. Migração nova (próximo número depois da última em `config/migrations.js`): em `whatsapp_accounts`
   `meta_onboarding` (`embedded|manual`), `meta_coexistence` (bool), `meta_sync_state`/`meta_sync_error`,
   `meta_coexistence_deadline_at`. Tenant-scoped + RLS como as demais; `publicAccount()` expõe só o
   estado, nunca token.
6. Auditoria (`auditController`) e LGPD: registrar a conexão e atualizar `lista-de-compartilhamento.md`
   / `lgpd-inventario-de-dados.md` (Meta já consta; conferir que o fluxo novo não cria dado novo).

### Fase 2 — Popup do Embedded Signup devolvendo o resultado ao painel

Restrição: o SDK só roda no domínio cadastrado no app (`tr69.com.br`), mas o painel de cada provedor
roda em **outro** domínio (e, na SaaS, em subdomínios). Portanto:

- O painel abre o popup `https://tr69.com.br/whatsapp-signup.html?state=…&return=<origem do painel>`.
- A página roda `FB.login` com `appId`/`configId` vindos do `start` (não fixos), captura
  `WA_EMBEDDED_SIGNUP` + `code` e faz `window.opener.postMessage(payload, <origem validada>)`.
- **Validar `return` no servidor** (a página é estática, então: o `start` devolve a origem já
  assinada/atada ao `state`, e a página só aceita postar para ela) — um `targetOrigin: '*'` vazaria o
  `code` para qualquer janela. Verificar também `event.origin` do lado do painel e o `state` na volta.
- CSP e COOP: já resolvidos para `/whatsapp-signup.html` em `app.js` (rota própria, `connect.facebook.net`,
  `crossOriginOpenerPolicy: false`); só garantir que o `postMessage` cross-origin continua funcionando
  depois de qualquer mudança de helmet.
- O painel envia o resultado para `/complete` **antes** de 30 s do `code`.

### Fase 3 — Frontend (`whatsapp-connection.tsx`)

- Botão primário **Conectar número oficial** (popup) com os dois caminhos: *número novo* e *já uso o
  WhatsApp Business no celular (coexistência)*. Formulário manual vira "Avançado / colar token".
- Estados claros: aguardando popup → trocando código → criando número → registrando webhook →
  sincronizando contatos/histórico (barra + contagem regressiva das 24 h) → conectado.
- Erros traduzidos por `code` (padrão `whatsapp.error.*`) em **todos os locales**; novos códigos no
  contrato: `embedded_signup_unconfigured`, `signup_state_invalid`, `signup_code_expired`,
  `meta_phone_waba_mismatch`, `meta_number_in_use`, `coexistence_sync_failed`.
- Reaproveitar `health-strip` / card de saúde e o status do webhook que já existem.
- Atualizar a copy de `whatsapp.cloud.guideTitle/step*` (hoje manda o provedor criar app e usuário
  do sistema).

### Fase 4 — Lacunas do Evolution (validar antes de prometer)

- Testar numa conta real se o `/webhook/meta` do Evolution repassa `smb_message_echoes` e `history`.
  Se **não**, escolher entre: (a) correção/versão do Evolution; (b) o painel assinar esses campos
  direto da Meta (`/webhook/meta` próprio do painel só para eco/histórico) e gravar em `wa_messages`
  pelo mesmo caminho de `waInboundService`. Decidir só depois do teste — é o item de maior risco.
- Confirmar versão mínima do Evolution v2 (a `WA_BUSINESS_VERSION` casando com `META_GRAPH_VERSION`).

### Fase 5 — Testes e documentação

- Backend (`backend/test/`), com `setMetaGraphFetcher` e o helper `evolutionRoute.js`: `start`/`complete`
  felizes; `state` reutilizado/expirado/de outro tenant; número de outro tenant; `phone`↔`waba`
  divergente; `code` recusado; coexistência com `request_id` persistido e **sem** segunda chamada de
  `smb_app_data`; `account_update` offboard; segredos nunca no payload público; RLS.
- Frontend (`frontend/test/`): máquina de estados do popup, validação de origem no `postMessage`.
- Atualizar `docs/whatsapp-api-contract.md` (rotas + códigos **primeiro**, como o próprio doc manda),
  `docs/whatsapp-coexistencia.md` (passos 1–3 passam a ser automáticos) e o `CHANGELOG`.
- Rodar `npm run verify` e o e2e; migração testada nos dois bancos que o projeto suporta.

## Segurança (resumo do que não pode escorregar)

- `META_APP_SECRET` e o token da Meta só no servidor, cifrados como os demais (`encryptSecret`, com
  rotação em `rotate-secret-key.js`). Nada disso no log, na URL ou na resposta.
- `state` de uso único + origem validada nas duas pontas; IDs vindos do navegador sempre reconferidos
  na Graph com o token trocado no servidor.
- Rate limit nas duas rotas novas; `whatsapp.config` obrigatório; auditoria de quem conectou.
- Exclusão de dados / desautorização do usuário pela Meta (como o Messenger já trata em
  `bc209c6`) — avaliar se o app único exige os mesmos callbacks.

## Ordem de entrega sugerida

1. Fase 0 (em paralelo, é a de maior prazo) → 2. Fase 1 + testes → 3. Fases 2–3 → 4. Fase 4 (assim que
houver conta de teste) → 5. docs. Dá para entregar 1+2+3 só para **número novo** e deixar a
coexistência para uma segunda entrega, se a Fase 4 mostrar que o eco precisa de trabalho.

## Decisões em aberto (precisam de você)

1. **Já existe** conta Meta verificada / Tech Provider, ou ainda vai começar a verificação? Sem isso,
   a primeira entrega serve só para você e para quem tem papel no app.
2. **App único da plataforma** (recomendado) ou manter **um app por provedor** (o contrato atual)?
3. **Coexistência entra na primeira entrega** ou numa segunda, depois de validar o eco no Evolution?
4. O Evolution é **o da plataforma (SaaS)** ou **self-host** em cada provedor? Muda quem tem a chave
   admin necessária para recriar a instância (`adminKey`).
