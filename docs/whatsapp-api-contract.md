# WhatsApp / Evolution API — contrato interno

Este documento congela as rotas, os payloads e os códigos de erro da integração
de WhatsApp. Ele existe porque a integração é construída em ondas e em paralelo:
quem escreve o backend de uma onda e quem escreve a tela da onda seguinte
programam contra este arquivo, não contra o código um do outro.

**Se uma onda precisar mudar algo aqui, muda aqui primeiro.** Uma divergência
silenciosa entre o que o servidor devolve e o que a tela espera é exatamente o
tipo de falha que não tem aparência.

Estado: **Ondas 0 e 1 implementadas** — ciclo de vida das instâncias, webhook de
entrada e envio (fila + worker).
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

## ✅ Onda 2 — modelos, não perturbe, cobrança e campanhas (implementado)

Tudo abaixo é `authenticateToken` + `requireRole(['admin'])`, montado em
`routes/whatsappBilling.js`.

| `code` | Significado | HTTP | Chave i18n |
| --- | --- | --- | --- |
| `unknown_variable` | o corpo cita variável que o disparo não sabe preencher | 400 | `whatsapp.error.unknownVariable` |
| `template_empty` | modelo sem nome ou sem corpo | 400 | `whatsapp.error.templateEmpty` |
| `name_taken` | já existe modelo com esse nome | 409 | `whatsapp.templates.nameTaken` |
| `template_not_found` | `:id` não existe | 404 | `whatsapp.templates.notFound` |
| `invalid_phone` | não dá para usar como telefone | 400 | `whatsapp.error.invalidPhone` |
| `too_many_recipients` | mais de 300 contratos no disparo | 400 | `whatsapp.error.tooManyRecipients` |
| `no_recipients` | ninguém sobrou depois dos filtros | 409 | `whatsapp.error.noRecipients` |
| `rate_limited` | mais de 3 montagens em 5 minutos | 429 | `whatsapp.error.rateLimited` |
| `invalid_status` | a campanha não pode ir para lá de onde está | 409 | `whatsapp.error.invalidStatus` |
| `broadcast_not_found` | `:id` não existe | 404 | `whatsapp.broadcast.notFound` |

### Modelos — `/api/whatsapp/templates`

`GET` (`?category=`, `?includeInactive=1`), `POST`, `PUT /:id`, `DELETE /:id`.

```ts
{ id, name, body, category: 'cobranca'|'alerta'|'suporte'|'geral', active, createdAt, updatedAt }
```

**Um corpo que cita variável fora da lista é recusado na entrada, em qualquer
categoria**, com `unknown_variable` e os nomes ofensores no texto do erro. A
categoria não entra no teste de propósito: ela pode ser trocada depois por um
`PUT`, então aceitar `{{fatura_anterior}}` num modelo 'suporte' só adiaria a
falha. Recusar só na hora do envio seria pior ainda — lá o render devolve
`null` e o operador vê uma campanha que pulou todo mundo sem dizer por quê.

Um `PUT` que omite um campo mantém o guardado: renomear não pode ser lido como
"e apague o corpo".

### Não perturbe — `/api/whatsapp/opt-outs`

`GET` lista os ativos, `POST { phone, reasonText? }` acrescenta,
`DELETE /:id` revoga (revogação é soft; o histórico de quem pediu fica).

```ts
{ id, waPhoneE164, waLid, origin: 'customer'|'operator', reasonText, createdAt }
```

O telefone é **normalizado na entrada** (`normalizarTelefoneBr`), porque é
nessa forma que a campanha pergunta: um registro salvo como `(93) 98111-0449`
não casaria com nada, e o preço da divergência é uma mensagem enviada a quem
pediu silêncio. `POST` de um número já ativo devolve `200` com a linha
existente em vez de erro — o resultado que o operador pediu é o resultado que
ele tem.

### Inadimplentes — `GET /api/whatsapp/billing/overdue`

`?daysMin=&daysMax=&search=&limit=` → `WhatsAppOverdueSubscriber[]`:

```ts
{ contract, clientName, document, phone, phoneSource: 'manual'|'sgp'|null,
  deviceId, amount, dueDate, daysOverdue }
```

**A janela é simétrica.** `daysOverdue` é positivo para fatura vencida e
negativo para fatura a vencer, numa reta só — então `daysMin: -5` lê-se
"incluindo quem vence nos próximos cinco dias". É o que permite a mesma tela
preparar uma cobrança e um lembrete. Padrões: `daysMin=1`, `daysMax=90`,
`limit=50` (teto 300).

O endereço vem de `sgp_links`: `phone_manual` (a correção do operador) ganha de
`phone_e164` (o que o SGP devolveu), e um contrato sem nenhum dos dois aparece
na lista com `phone: null` — esconder seria esconder justamente o cadastro que
precisa de conserto.

É a rota mais lenta do painel de propósito: um round trip ao SGP por assinante,
com **~150 ms entre chamadas**. O SGP do provedor é o mesmo sistema que está,
naquele instante, atendendo a URA de quem ligou.

### Montar a campanha — `POST /api/whatsapp/billing/campaign`

```ts
// corpo
{ template: string, contracts: string[], title?: string }
// resposta 201
{ broadcast: WhatsAppBroadcast, recipients: number, skipped: WhatsAppSkipCounts }
```

`template` é o **nome** (ou o id) de um modelo guardado, ou o corpo digitado
direto na caixa para um disparo único. Seja qual for, o texto passa pela mesma
validação de variáveis antes de virar mensagem.

**Montar NUNCA envia.** A campanha nasce `draft` e a rota devolve. Nenhuma linha
entra no outbox aqui. Mandar mensagem para centenas de pessoas não pode ser o
efeito colateral de um clique numa tela de listagem: o operador abre a campanha,
lê os corpos já renderizados, e aperta o play.

**Os pulados são contados por motivo**, nunca num número só, e a soma
`recipients + Σ skipped` é sempre o total de contratos pedidos (deduplicados):

| Contador | O que aconteceu |
| --- | --- |
| `noPhone` | sem celular no cadastro — ou contrato que o painel nunca vinculou |
| `optOut` | pediu para não ser contatado |
| `noInvoice` | nada em aberto |
| `futureOnly` | só tem fatura a vencer, e o modelo é de cobrança (`soFuturas`) |
| `sgpRefused` | o SGP recusou aquele contrato; os outros seguem |
| `templateIncomplete` | o render devolveu `null` — variável citada sem valor |

"412 pulados" não diz nada a quem opera; "83 sem celular no cadastro, 12
pediram para não ser contatados" diz o que dá para consertar.

Detalhes que a tela pode contar com:

- **A lista de opt-out é aplicada aqui** — isto é contato iniciado pelo
  provedor, ao contrário da caixa de resposta. Uma consulta só para a campanha
  inteira (`WaOptOut.activePhones`), não uma por destinatário.
- **Os códigos são buscados vivos**, um round trip por destinatário, com os
  mesmos ~150 ms de intervalo. Boleto reemitido tem linha digitável e PIX
  novos, e uma mensagem com o código velho manda o cliente a um banco que vai
  recusar.
- **Teto de 300 destinatários** por campanha, e **3 montagens por 5 minutos**
  (`rate_limited`/429) — cada montagem custa um round trip por destinatário.
- `renderCobranca` devolvendo `null` **descarta** o destinatário. Nunca há
  mensagem parcial: "PIX: " sem nada depois manda o cliente pagar um
  placeholder.
- Sem ninguém para contatar, a resposta é `409 no_recipients` — **com o
  `skipped` junto**, porque "todos estão na lista de não perturbe" é a resposta
  que o operador precisa.

### Campanhas — `/api/whatsapp/broadcasts`

`GET` lista (mais recente primeiro), `POST /:id/status { status }` move.

```ts
{ id, title, body, status, totalCount, sentCount, failedCount,
  rateLimitPerMin, startAt, createdAt, updatedAt }
```

Transições aceitas — só `running`, `paused` e `canceled` podem ser pedidos:

| De | Para |
| --- | --- |
| `draft` | `running`, `canceled` |
| `queued` | `running`, `paused`, `canceled` |
| `paused` | `running`, `canceled` |
| `running` | `paused`, `canceled` |
| `done` · `canceled` · `failed` | nada |

`draft` não pula para `paused`: pausar o que nunca começou não é estado. Os três
terminais não aceitam nada — recomeçar uma campanha encerrada reenviaria para
quem ela já alcançou. **Só o start exige número conectado** (`no_account`): um
rascunho é um plano, e recusá-lo porque ninguém pareou o telefone jogaria fora
o trabalho do operador por uma condição de um minuto.

### O laço de disparo

`services/waBroadcastService.js`, um `setInterval` iniciado em `server.js` e
parado no shutdown. Um minuto por passada — o orçamento da campanha é escrito
por minuto, e ninguém está esperando por ele como se espera por uma resposta.

- Cada passada percorre as campanhas em `running` e reclama até
  `rate_limit_per_min` destinatários de cada uma, com o mesmo UPDATE
  condicional do outbox (`claimRecipient`); claim nulo = outra passada pegou.
- Guardas, **nesta ordem**: opt-out → endereço → envio.
- **O opt-out é conferido dentro do laço, não como filtro na consulta dos
  pendentes.** Um destinatário filtrado pela consulta nunca sairia de
  `pending`, e a campanha ficaria em `running` para sempre sem ter o que fazer.
  Ele vira `skipped` com `error_msg: 'opt_out'` — estado terminal.
- Número que não normaliza vira `failed` na primeira tentativa: não é falha de
  transporte, é endereço que nunca vai existir.
- O envio é um **enqueue**: `WaSendService.enqueue` numa conversa garantida por
  `WaConversation.ensure` (mesmo `external_thread_id` canônico da entrada, para
  cair no fio que já existe). Quem fala com o Evolution é o worker do outbox,
  sob o mesmo teto e as mesmas três tentativas de todo o resto. Campanha com
  transporte próprio seria um segundo lugar onde uma mensagem trava.
- Três tentativas por destinatário; abaixo do teto a linha volta para `pending`.
- Sem número conectado a campanha é **deixada em `running`** e tentada na
  passada seguinte — queimar as três tentativas por um número que estava só
  repareando perderia a campanha inteira.
- Quando não sobra nenhum `pending`/`sending`, a campanha vira `done`;
  `sent_count` e `failed_count` são recontados das linhas a cada passada
  (um `skipped` conta como não entregue no cabeçalho).
- Uma passada **nunca lança**: uma campanha quebrada não pode parar as outras.

---

## ⏳ Onda 2 e 3 — rotas previstas

Especificadas aqui para que as telas possam ser escritas contra elas.

| Rota | Onda | Faz |
| --- | --- | --- |
| `GET /api/whatsapp/conversations` | 3 | lista paginada, ordenada por `lastMessageAt` |
| `GET /api/whatsapp/conversations/:id/messages` | 3 | histórico |
| `GET/PUT /api/whatsapp/alerts/rules` | 2 | regras de alerta técnico |

As rotas de modelos, não perturbe, cobrança e campanhas saíram desta tabela
porque estão implementadas — a seção acima é o contrato delas.

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
