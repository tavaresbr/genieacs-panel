# WhatsApp / Evolution API — contrato interno

Este documento congela as rotas, os payloads e os códigos de erro da integração
de WhatsApp. Ele existe porque a integração é construída em ondas e em paralelo:
quem escreve o backend de uma onda e quem escreve a tela da onda seguinte
programam contra este arquivo, não contra o código um do outro.

**Se uma onda precisar mudar algo aqui, muda aqui primeiro.** Uma divergência
silenciosa entre o que o servidor devolve e o que a tela espera é exatamente o
tipo de falha que não tem aparência.

Estado: **Ondas 0 e 1 implementadas** — ciclo de vida das instâncias, webhook de
entrada e envio (fila + worker) — mais os **alertas técnicos** da onda 2.
As linhas marcadas ⏳ estão especificadas mas ainda não existem; a onda indicada
as implementa.

---

## Forma geral

Todas as rotas do painel respondem no envelope do projeto:

```json
{ "success": true,  "message": "…", "data": … }
{ "success": false, "message": "…", "code": "host_not_allowed" }
```

`code` só aparece em erro e é a chave de máquina — a tela traduz por
`whatsapp.error.*` e nunca mostra o corpo cru da resposta do servidor Evolution.

Todas exigem `authenticateToken` + `requireRole(['admin'])`, exceto o webhook,
que é público e tem credencial própria.

---

## Códigos de erro

| `code` | Significado | Chave i18n |
| --- | --- | --- |
| `not_configured` | integração desligada | `whatsapp.error.notConfigured` |
| `incomplete_config` | falta a URL do webhook | `whatsapp.error.incompleteConfig` |
| `invalid_webhook_url` | URL do webhook inválida | `whatsapp.error.invalidWebhookUrl` |
| `invalid_base_url` | URL do Evolution inválida | `whatsapp.error.invalidBaseUrl` |
| `host_not_allowed` | fora da allowlist do admin | `whatsapp.error.hostNotAllowed` |
| `blocked_host` | endereço interno, barrado pelo guard SSRF | `whatsapp.error.blockedHost` |
| `unauthorized` | o Evolution recusou a credencial | `whatsapp.error.unauthorized` |
| `license_required` | licença do Evolution não ativada | `whatsapp.error.licenseRequired` |
| `timeout` / `unreachable` | o Evolution não respondeu | `whatsapp.error.timeout` / `…unreachable` |
| `no_session` | reiniciar sem sessão viva | `whatsapp.error.noSession` |
| `no_account` | nenhum número conectado | `whatsapp.error.noAccount` |
| `no_destination` | contato sem telefone nem LID | `whatsapp.error.noDestination` |
| `message_empty` | sem texto e sem anexo | `whatsapp.error.messageEmpty` |
| `conversation_not_found` | `:id` não existe | `common.routeNotFound` |
| `no_recipients` | nenhum número recebe alerta técnico | `whatsapp.alerts.noRecipients` |
| `invalid_phone` | telefone de plantão que não dá para discar | `whatsapp.error.invalidPhone` |

---

## Configuração global — `/api/whatsapp/config`

`GET` devolve, e `PUT` aceita, este objeto. **Nenhum segredo sai daqui.**

```ts
{
  enabled: boolean
  allowedHosts: string[]        // PUT aceita string (uma por linha) ou array
  webhookBaseUrl: string        // absoluta, http(s), sem query nem credencial
  rejectCallMessage: string
  rateLimitPerMin: number       // 1..120
  managedUrl: string
  managed: boolean              // derivado: managedUrl preenchido
  managedAdminKeyConfigured: boolean
  ready: boolean
  updatedAt: string | null
}
```

`PUT` aceita também `managedAdminKey`. **Omitir mantém a chave guardada; `""`
apaga.** É a mesma regra do token do SGP, e a razão é a mesma: salvar o
formulário não pode revogar a integração sem querer.

Ativar (`enabled: true`) sem `webhookBaseUrl` responde `400 incomplete_config` —
sem webhook o servidor não devolve QR, mensagem nem recibo, e a integração
ficaria ligada e muda.

---

## Números — `/api/whatsapp/accounts`

`GET /accounts` → array de:

```ts
{
  id: number
  name: string                  // nome da instância no servidor Evolution
  label: string | null
  purpose: 'general'|'billing'|'support'|'sales'|'alerts'
  flavor: 'go' | 'v2'           // detectado por sonda, nunca configurado à mão
  baseUrl: string
  status: 'pending'|'connecting'|'connected'|'disconnected'|'expired'
  qrCode: string | null         // data URI, rotaciona ~20 s
  qrUpdatedAt: string | null
  phoneE164: string | null
  isDefault: boolean
  lastSeenAt: string | null
  lastError: string | null
  createdAt: string | null
  updatedAt: string | null
}
```

O objeto é montado campo a campo no servidor
(`whatsappConfigService.publicAccount`). **Nunca devolva a linha do banco**: ela
carrega os dois segredos cifrados, e uma coluna acrescentada depois vazaria por
padrão.

### ✅ Onda 1 — ciclo de vida (implementado)

Serviço: `services/evolutionInstanceService.js`. Toda resposta de sucesso traz
`data.account` já passado por `publicAccount()`.

| Rota | Faz | `data` |
| --- | --- | --- |
| `POST /accounts` | cria a instância, assina o webhook e devolve o primeiro QR. Body: `{ baseUrl?, adminKey?, label?, purpose? }` — `baseUrl`/`adminKey` só no modo self-host. Responde `201` | `{ account, qr, pending }` |
| `GET /accounts/:id/qr` | busca um QR novo | `{ account, qr, pending }` |
| `GET /accounts/:id/status` | pergunta ao servidor e **promove** para `connected`; só rebaixa quem já estava conectado | `{ account, state }` |
| `POST /accounts/:id/restart` | `reconnect` (GO) / `restart` (v2). Sem sessão viva → `409 no_session` | `{ account }` |
| `POST /accounts/:id/disconnect` | logout; é o único jeito de forçar um QR novo | `{ account }` |
| `DELETE /accounts/:id` | logout + delete no servidor + remove a linha. Body opcional `{ adminKey }` no self-host | `{ removedOnServer, serverError }` |
| `PATCH /accounts/:id` | `{ label?, purpose?, isDefault? }` | `{ account }` |
| `POST /accounts/check-number` | `{ numbers: string[] }`, no máximo 100 | `[{ number, exists }]` |

O que o `POST /accounts` faz, na ordem — a sequência importa e cada passo já
custou um bug no sistema de origem:

1. sonda o sabor (`detectFlavor`) **antes** de montar qualquer payload;
2. cunha `name` (`skygp_<8 hex>_<base36>`), `instanceId`, o token da instância e
   o token do webhook;
3. cria a instância. Resposta com `already exists`/`already in use` **não é
   falha**: é o caminho de reconexão, e o id real vem da listagem;
4. **só no GO**, `POST /instance/connect` — é ele que grava o webhook e sobe o
   cliente. Sem essa chamada a instância existe e nunca conecta;
5. primeiro QR: o da resposta do create, ou uma leitura à parte.

`pending: true` com `qr: null` **não é erro**: o Evolution GO responde
`400 "no QR code available"` nos primeiros segundos, enquanto o cliente sobe. A
conta fica em `connecting` e a tela pede o QR de novo.

Se o create funciona mas a conexão ou o QR falham, a linha é gravada mesmo
assim, em `connecting` e com `lastError` preenchido: a instância já existe no
servidor, e a linha é a única alça que o painel terá sobre ela — sem ela não dá
nem para apagar.

`DELETE` remove a linha local **sempre**, e conta a verdade sobre o servidor em
`removedOnServer`/`serverError`. Recusar a remoção local porque um servidor que
talvez nem exista mais não confirmou deixaria o operador com uma linha
impossível de tirar; dizer que deu certo deixaria uma instância rodando sem ele
saber. No GO o delete é por id e com a chave global: sem uma das duas,
`serverError` explica qual faltou.

`GET /status` grava só quando `state === 'connected'` ou quando o servidor diz
`disconnected` para quem estava `connected`. A promoção é a saída de emergência
para um `connection_update` perdido, que deixaria um número pareado eternamente
em amarelo; a assimetria evita que um `disconnected` passageiro apague um
pareamento em andamento — quem ainda não conectou aparece como desconectado no
servidor o tempo todo em que o QR está na tela.

`purpose` fora da lista responde `400`. `isDefault: true` passa por
`setDefault()`, porque exatamente uma linha carrega a marca.

Além dos códigos da tabela lá em cima, estas rotas devolvem `account_not_found`
(`404`, id que não existe), `invalid_purpose` (`400`), `http_error` (`502`, com
as palavras do próprio servidor) e, quando falta credencial para a rota pedida,
`admin_key_missing` / `instance_token_missing` (`400`).

---

## Webhook — `POST /api/whatsapp-webhook?t=<token>`

Público. Montado **antes** do `apiLimiter` e do `authenticateToken`, com bucket
próprio de 600/min.

Autenticação, nesta ordem:

1. `?t=` comparado em tempo constante com o token de webhook da conta;
2. sem `?t=`, o header `apikey` (ou `body.apikey`) comparado com o token da
   instância — compatibilidade com instância criada antes do `?t=`.

**Ausência de credencial é recusa.** O Evolution GO não manda header nenhum, e
a forma anterior (`if (guardado && enviado && !igual) → 401`) passava direto
nesse caso.

Resolve a conta por `body.instance`. Instância desconhecida e credencial errada
respondem o mesmo `401`: a diferença diria a um sondador quais nomes existem.

Responde `200` para tudo que reconhece, inclusive o que ignora de propósito —
os dois servidores reenviam em não-2xx, e reenviar um evento que descartamos de
propósito vira laço.

Evento canonicalizado para quatro nomes (`utils/wa/waEventos.js`):
`qrcode_updated`, `connection_update`, `messages_upsert`, `messages_update`.

**Onda 1 implementada:** os quatro tratadores estão ligados
(`services/waInboundService.js`, `services/waMediaService.js`).

### O corpo da resposta

A resposta é a ÚNICA observabilidade deste caminho — não há tela, não há alerta,
e um evento gravado e um evento descartado respondem os dois `200`. Por isso ela
diz o que aconteceu:

```json
{ "success": true, "event": "messages_upsert", "handled": true }
{ "success": true, "event": "messages_upsert", "handled": false, "skipped": "group" }
```

Os motivos de `skipped` são estáveis e a tela de diagnóstico pode contá-los:

| `skipped` | Quando |
| --- | --- |
| `group` · `broadcast` | endereço de grupo (`@g.us`) ou de status (`@broadcast`) |
| `unknown_domain` | domínio de JID que ainda não conhecemos — melhor perder a mensagem que gravar a parte local como telefone |
| `no_address` · `no_identity` | evento sem JID utilizável, ou sem telefone **e** sem LID |
| `no_external_id` · `external_id_too_long` | sem `key.id`/`Info.ID`, ou id maior que a coluna (truncar casaria duas mensagens numa linha só) |
| `no_receipt` | `messages_update` sem estado — edição de texto é o caso legítimo |
| `no_qr` · `no_state` | evento de QR ou de conexão que não carrega nada de novo |
| `unsupported_event` | evento que os servidores publicam e nós não assinamos |
| `no_data` | envelope sem `data` |

Uma reentrega devolve `{ handled: true, duplicate: true }`: o índice único de
`wa_messages.external_id` É a deduplicação, e os dois servidores reenviam.
**Chegar duas vezes é sucesso, não erro** — responder não-2xx aí faria o servidor
reenviar o mesmo evento em laço.

`500` fica reservado ao que vale a pena reenviar de verdade (banco fora, disco
cheio). Nada que a gente escolhe ignorar sai por ele.

### O que cada tratador faz

**`qrcode_updated`** — grava `qr_code` + `qr_updated_at` e põe a conta em
`connecting`: ter QR na tela é, por definição, estar no meio do pareamento.

**`connection_update`** — mapeia por `readStatus(flavor, data)` e, quando o
`data` não carrega estado (o GO manda `Connected` com corpo vazio), cai para o
nome cru do evento — sem isso `readStatus('go', {})` leria um `Connected` como
`disconnected`. Ao conectar: `last_seen_at`, `qr_code` limpo (um QR de sessão já
pareada não abre mais nada) e o telefone pareado quando o evento traz JID.

**`messages_upsert`** — endereço, identidade dupla, conversa, linha, anexo,
opt-out, contadores. Três regras que a tela pode assumir:

- **LID não é telefone.** Um contato `@lid` grava `wa_lid` e deixa
  `wa_phone_e164` NULL. A classificação é por domínio, nunca por comprimento.
- **Numa mensagem `fromMe`, `key.senderPn` e `Info.SenderAlt` são o número do
  PROVEDOR**, não o do cliente. Só entram na identidade quando `fromMe` é falso.
- **`pushName` cujos dígitos são o telefone ou o LID é descartado.** O Evolution
  GO manda o identificador como nome, e gravá-lo põe quinze dígitos onde vai o
  nome do cliente.

`external_thread_id` é a forma canônica `<dígitos>@<domínio>`: o sufixo de device
(`:22`) de uma sessão de WhatsApp Web abriria uma segunda conversa com a mesma
pessoa.

**`messages_update`** — `lerRecibo` nos três formatos (v2 plano, v1 aninhado, GO
em lote com o estado fora do `data`) e `WaMessage.applyReceipt`, que nunca anda
para trás.

### Anexo recebido

`waMediaService` tenta, nesta ordem: `base64` no evento → `mediaUrl` do storage
do servidor (por `urlBaixavel`, e pelo guard de SSRF) → `POST
/chat/getBase64FromMediaMessage`. **`*Message.url` nunca é baixado**: é o objeto
cifrado no CDN do WhatsApp.

O terceiro passo usa `services/evolutionClient.js`: `clientForAccount(account, config, token).send(evoRequest)`, que devolve
`{ ok, status, data }`. Ele é pulado no sabor GO — o GO não publica rota
equivalente e sempre manda o base64 no evento — e na prática quase nunca é
exercido no v2, porque o nosso `createInstanceRequest` liga `webhook.base64`.
Ele existe para a instância criada à mão ou por uma versão anterior.

Arquivo em `DATA_DIR/wa-media/<conversationId>/<externalId>-<nome>`, teto de
25 MB, e `attachment_path` gravado RELATIVO a `DATA_DIR` — o volume muda de lugar
entre a máquina do provedor e o container. Anexo que não desceu grava a mensagem
**sem** anexo: `attachment_name` preenchido com `attachment_path` vazio
desenharia um anexo que não abre.

### Opt-out

Só em mensagem de ENTRADA (`direction === 'in'`) e só quando a mensagem INTEIRA é
o pedido (`pedeSaida`). O eco de saída fica de fora de propósito: o provedor
digitando "sair" no próprio celular não pode descadastrar o cliente dele.

---

## Envio — `POST /api/whatsapp/conversations/:id/messages`

Onda 1. `authenticateToken` + `requireRole(['admin'])`.

```ts
// corpo
{
  body?: string
  attachment?: { url: string, type?: string, name?: string }  // `type` é o MIME
  isNote?: boolean
}
```

**A rota enfileira e responde; ela não fala com o Evolution.** Esperar o servidor
aqui deixaria a caixa de resposta tão lenta quanto o elo mais lento da corrente,
e um timeout deixaria o operador sem mensagem nenhuma. Responde `201` com a
linha criada:

```ts
{
  id: number
  conversationId: number
  direction: 'in' | 'out'
  body: string | null
  attachment: { url: string, type: string|null, name: string|null } | null
  isNote: boolean
  externalId: string | null        // só depois que o servidor aceita
  deliveryStatus: 'queued'|'sending'|'sent'|'delivered'|'read'|'failed'|null
  deliveryError: string | null
  attempts: number
  sentBy: number | null
  readAt: string | null
  createdAt: string | null
  updatedAt: string | null
}
```

Recusas, todas **antes** de a linha existir — mensagem que nunca vai sair é pior
como linha permanentemente falhada do que como erro na tela, com o texto ainda
na caixa:

| Situação | `code` | HTTP |
| --- | --- | --- |
| nenhum número conectado | `no_account` | 409 |
| conversa sem telefone e sem LID | `no_destination` | 409 |
| sem texto e sem anexo | `message_empty` | 400 |
| `:id` inexistente | `conversation_not_found` | 404 |

**A lista de opt-out NÃO é consultada aqui.** Opt-out significa que o provedor
não *inicia* contato; ele nunca pode impedir o operador de responder quem
escreveu. Quem aplica a lista é o disparo em massa e o alerta (onda 2).

`isNote: true` grava a linha com `deliveryStatus: null` e o worker nunca a
enxerga — é a única forma de garantir que uma anotação interna não chegue ao
cliente. Uma nota é aceita mesmo em conversa sem endereço e com o número
desconectado: recusá-la perderia as palavras do operador sem proteger ninguém.

### O worker do outbox

`services/waOutboxWorker.js`, um `setInterval` iniciado em `server.js` e parado
no shutdown. `wa_messages` **é** a fila; não existe tabela paralela.

- Cada passada: `WaMessage.listSendable(n)` e `WaMessage.claim(id)` por
  mensagem. Claim nulo = outra passada já pegou a linha — silêncio, não erro. É
  isso que torna duas passadas simultâneas seguras, e por isso nada aqui
  serializa os ticks.
- Teto de `rateLimitPerMin` envios por minuto corrido, **uma janela para o
  worker inteiro** — o que o WhatsApp observa é o tráfego do provedor, e um
  limite por número multiplicaria pelo número de instâncias conectadas.
- Roteamento: a conta da conversa primeiro (quem escreveu para o suporte tem de
  ser respondido pelo suporte); só se ela não estiver `connected` cai para
  `WhatsAppAccount.getForPurpose()`, **no mesmo purpose**.
- Texto → `sendText`. Anexo → `sendMedia`. **Áudio → `sendWhatsAppAudio`
  primeiro**, para sair como balão de voz e não como arquivo para baixar; cai
  para `sendMedia` **só em resposta não-2xx** (ou quando `sendAudioRequest`
  devolve `null`, que é o caso do Evolution GO). Repetir depois de um 2xx manda
  o áudio duas vezes, e ninguém desmanda o segundo.
- Sucesso: `external_id = readSentId(data)`, `delivery_status: 'sent'`. Quem
  promove para `delivered`/`read` é o webhook.
- Falha: `delivery_error` (500 chars) e **três tentativas** — o contador é o
  `attempts`, incrementado pelo `claim`. Abaixo do teto a linha volta para
  `queued`, porque `listSendable` procura `queued`: deixá-la `failed` a poria
  fora do alcance do worker e faria "três tentativas" significar uma. Na
  terceira ela fica `failed` e ninguém mais a toca.
- Uma passada **nunca lança**: uma mensagem impossível não pode parar a fila.

---

## ⏳ Onda 2 e 3 — rotas previstas

Especificadas aqui para que as telas possam ser escritas contra elas.

| Rota | Onda | Faz |
| --- | --- | --- |
| `GET /api/whatsapp/conversations` | 3 | lista paginada, ordenada por `lastMessageAt` |
| `GET /api/whatsapp/conversations/:id/messages` | 3 | histórico |
| `GET/POST/PUT/DELETE /api/whatsapp/templates` | 2 | CRUD de modelos |
| `GET /api/whatsapp/opt-outs` · `POST` · `DELETE /:id` | 2 | não perturbe |
| `GET /api/whatsapp/broadcasts` · `POST` · `POST /:id/status` | 2 | campanhas |
| `GET /api/whatsapp/billing/overdue` | 2 | inadimplentes, janela simétrica |
| `POST /api/whatsapp/billing/campaign` | 2 | monta a campanha **em `draft`** |

Duas regras de produto que a API precisa preservar:

- **Montar disparo nunca envia.** `POST /billing/campaign` cria a campanha em
  `draft` e devolve `{ broadcastId, recipients, skipped: { … } }`. Quem aperta o
  play é o operador, depois de ver a lista pronta.
- **Os pulados são explicados por motivo**, nunca por um número só:
  `{ noPhone, optOut, noInvoice, futureOnly, sgpRefused, templateIncomplete }`.

---

## Alertas técnicos — `/api/whatsapp/alerts`

Quem recebe estes alertas é a **equipe do provedor**, não o assinante: uma lista
de telefones nas configurações, não uma consulta ao cadastro. Nada aqui sabe de
quem é a ONT que caiu, e não deve saber — um alerta nomeia equipamento.

| Rota | Faz |
| --- | --- |
| `GET /api/whatsapp/alerts/settings` | as regras e seus limiares |
| `PUT /api/whatsapp/alerts/settings` | grava |
| `POST /api/whatsapp/alerts/scan` | roda uma passada agora |

### O objeto de configuração

Guardado como um blob JSON em `app_state` (`whatsapp_alert_settings`), com o
mesmo cache de 30 s do `whatsappConfigService`.

```json
{
  "enabled": false,
  "intervalSeconds": 300,
  "recipients": ["5593981110001"],
  "rules": {
    "ont_offline":      { "enabled": true, "threshold": 30,  "cooldownMinutes": 120 },
    "rx_power_low":     { "enabled": true, "threshold": -27, "cooldownMinutes": 360 },
    "temperature_high": { "enabled": true, "threshold": 70,  "cooldownMinutes": 360 },
    "mass_outage":      { "enabled": true, "threshold": 5,   "cooldownMinutes": 120 }
  },
  "hasAlertsNumber": true,
  "ready": true
}
```

`hasAlertsNumber` e `ready` são somente leitura: a tela precisa poder mostrar
**por que** os alertas estão calados sem disparar uma varredura.

`PUT` aceita qualquer subconjunto. `rules` é **mesclado** sobre o que está
gravado — uma tela que manda uma regra não pode zerar as outras três. Um número
que `normalizarTelefoneBr` não consegue usar é **recusado** (`invalid_phone`,
400): guardá-lo faria a falha acontecer uma vez por alerta, para sempre, num log
que ninguém lê — enquanto quem digitou ainda está olhando o formulário.

`POST /alerts/scan` devolve `{ fired, cleared, notified, skipped }`. Sem número
de purpose `alerts` conectado, ou sem destinatários, responde **409
`no_recipients`** — quem apertou o botão apertou justamente para descobrir se
isto funciona, e um `{fired: 0}` alegre esconderia a resposta.

### As quatro regras

| Regra | Dispara quando | Assunto (`subject`) |
| --- | --- | --- |
| `ont_offline` | `_lastInform` mais velho que o limiar, **em minutos** | id do device |
| `rx_power_low` | potência óptica **≤** o limiar (dBm, negativo) | id do device |
| `temperature_high` | temperatura **≥** o limiar (°C) | id do device |
| `mass_outage` | N ONTs do mesmo nó caem juntas | `node_id` do nó |

**No limiar já dispara.** Quem digita 30 quer dizer "trinta minutos já é demais";
uma comparação estrita faria do único número que a pessoa escolheu o único que
nunca alerta.

A telemetria vem dos leitores que já existem — `DeviceService.getDashboardDevices()`
e `DeviceService.isDeviceOnline()`. **Óptica e temperatura só são julgadas em
device que está informando**: uma ONT apagada devolve a última leitura que
conseguiu mandar, e "potência baixa" empilhado em "ONT offline" é o mesmo
incidente dito duas vezes.

### As regras que impedem isto de virar ruído

`wa_alert_state` é uma tabela de **estado**, não de log: uma linha por
`(rule, subject)` enquanto a condição dura, apagada quando ela passa.

- **Uma condição fala uma vez.** Depois só volta a falar quando
  `cooldownMinutes` passa, contado de `last_notified_at`. Um alerta que repete a
  cada varredura deixa de ser lido, e o que importava deixa de ser lido junto.
- **Recuperação também é mensagem**, uma só, e a linha vai embora com ela. Quem
  recebeu "ONT offline" e nunca mais ouviu nada não consegue distinguir fibra
  consertada de alertador quebrado.
- **Surto em massa cala os alertas individuais.** N ONTs do mesmo nó caindo
  juntas é um rompimento, não N incidentes: sai **uma** mensagem nomeando o nó e
  a contagem, e os `ont_offline` daqueles devices ficam retidos — não são
  limpos, o que mandaria "ONT recuperada" no meio de um rompimento. Quarenta
  mensagens às 3 da manhã é como um sistema de alerta é silenciado para sempre.
- **"Não sei" nunca vira "recuperou".** Leitura ilegível, device apagado,
  device retido por um surto: a linha fica exatamente como estava.
- **Leitura de frota vazia aborta a passada** (`skipped: 'no_devices'`). É muito
  mais provável ser um GenieACS quebrado que um provedor sem ONTs, e tratá-la
  como "tudo certo" dispararia uma recuperação por linha aberta.
- **A lista de opt-out vale aqui.** Um alerta é o provedor *iniciando* contato,
  que é exatamente o que um opt-out recusa.
- **Uma passada nunca lança.** O motivo de não ter feito nada volta em
  `skipped` (`disabled`, `no_recipients`, `no_devices`, `error`).

O agrupamento do surto é pelo nó de agregação **mais próximo** — a ODP em que a
ONT está pendurada, não a OLT no fim da cadeia. Alerta de OLT inteira seria uma
mensagem para o que normalmente é um drop, e mandaria o técnico para a ponta
errada da rede. Um rompimento mais acima simplesmente vira uma mensagem por ODP
afetada. O elo entre device e nó é o **PPPoE**: `mapping_nodes.pppoe` de um nó
`type: 'ont'`, casado com o PPPoE que `DeviceService.getCustomerIdentityDevices()`
devolve — lido só quando a frota já parece quebrada.

`threshold` de `mass_outage` é o N. O padrão é **5**: uma ODP atende 8 ou 16
assinantes, duas ou três fora é uma noite normal em qualquer rede, cinco na
**mesma** ODP ao mesmo tempo não é coincidência.

### O texto das mensagens

Composto no serviço e traduzido pelo **locale padrão do painel** (`pt-BR`) — um
job de fundo não tem locale de requisição.

| Chave | Variáveis |
| --- | --- |
| `whatsapp.alerts.ontOffline` · `…ontOfflineCleared` | `device`, `minutes` |
| `whatsapp.alerts.rxPowerLow` · `…rxPowerLowCleared` | `device`, `value`, `threshold` |
| `whatsapp.alerts.temperatureHigh` · `…temperatureHighCleared` | `device`, `value`, `threshold` |
| `whatsapp.alerts.massOutage` · `…massOutageCleared` | `node`, `count` |

A metade `*Cleared` não é enfeite: quem olha o celular às 3 da manhã lê a
primeira linha e mais nada, e "ONT offline ✔" é lido como um segundo alarme, não
como um fim de alarme. A recuperação ganha frase própria.

### O laço

`WaAlertService.start()` em `server.js`, parado no shutdown. Um `setInterval` de
60 s que só roda a varredura quando `intervalSeconds` passou. O `enabled` é lido
**dentro** do tick — mesma escolha do `schedulerService` e do `waOutboxWorker`,
para um botão em Configurações valer em um minuto sem ciclo de vida a manter em
sincronia. O "quando foi a última" fica em memória, não em `app_state`: um painel
que acabou de voltar **deve** varrer na hora, e as linhas de cooldown já impedem
que uma condição já anunciada seja anunciada de novo.

Envio: uma conversa por número de plantão (`WaConversation.ensure`, do mesmo
jeito que uma mensagem de entrada faria) e `WaSendService.enqueue`. O worker do
outbox entrega.

---

## Modelos de cobrança

Variáveis aceitas: `nome`, `valor`, `vencimento`, `dias_atraso`,
`dias_para_vencer`, `pix`, `linha_digitavel`, `link_boleto`.

Duas regras que o renderizador impõe, e que não dependem da disciplina de quem
opera:

1. **Variável vazia recusa a mensagem inteira** (o render devolve `null`). Um
   "PIX: {{pix}}" literal chegando a um inadimplente é pior que não mandar nada.
2. **`dias_atraso` e `dias_para_vencer` são espelhos mutuamente exclusivos.**
   Fatura vencida preenche o primeiro e esvazia o segundo, e vice-versa. Somado
   à regra 1, um texto de cobrança não tem como chegar a quem ainda não venceu.

Um modelo que cita `{{dias_para_vencer}}` é, por definição, um lembrete — é
assim que o disparo sabe que pode incluir faturas a vencer.
