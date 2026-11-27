# Plano: a ponte de eventos da Meta (coexistência com mensagens do celular)

Status: **desenho**, nada implementado. Continua `whatsapp-oficial-embedded-signup-plan.md` (Fase 4)
e `whatsapp-coexistencia.md`. Escrito a partir do código em `main` (v1.69.4).

## O problema, com a evidência

Na coexistência o número continua no app WhatsApp Business do celular. O que o atendente digita **no
celular** chega à API como `smb_message_echoes`; o histórico antigo, como `history`; os contatos, como
`smb_app_state_sync`; e a Meta avisa a desconexão por `account_update` (`ACCOUNT_OFFBOARDED`).

O painel recebe os eventos da Meta **pelo Evolution**: o callback da WABA aponta para o
`/webhook/meta` do servidor (`MetaWebhookService.register`, `override_callback_uri`). Lendo o código
público do Evolution (branch `main`, `src/api/integrations/channel/meta/`):

- `meta.controller.ts` só trata um `field` pelo nome, `message_template_status_update`; os outros
  quatro **não aparecem no código**.
- Todo o resto vai para `whatsapp.business.service.ts`, que só entende `value.messages` e
  `value.statuses`; sem nenhum dos dois, registra um aviso e **ignora**.
- O `POST /webhook/meta` **não confere assinatura** (só o `GET` confere o token de verificação).

Consequência: em coexistência, o que o atendente escreve no celular **não aparece no painel** (a conversa
fica de um lado só), o histórico e os contatos não entram, e o painel nunca fica sabendo que a Meta
desconectou o número. Fica por verificar com payloads reais (ver B0), mas a leitura do código é inequívoca.

## A ideia: o painel no meio do caminho

```
                    HOJE                                   COM A PONTE
 Meta ──► Evolution /webhook/meta ──► painel      Meta ──► painel /api/meta-webhook ──┬─► Evolution /webhook/meta
          (ignora eco, histórico,                          (confere a assinatura)     │   (messages, statuses, modelos:
           contatos e account_update)                                                 │    exatamente como hoje)
                                                                                      └─► tratamento local
                                                                                          (eco, histórico, contatos,
                                                                                           account_update)
```

Regra de ouro: **o que o painel não conhece vai para onde sempre foi** (o Evolution). A ponte só tira
do caminho do Evolution o que ele já ignorava. Um campo novo ou desconhecido é encaminhado e registrado,
nunca descartado.

## O que o código atual já dá (reaproveitar, não refazer)

| Peça | Onde | Para que serve aqui |
| --- | --- | --- |
| Entrada já trata mensagem `fromMe` | `waInboundService.gravarMensagem` | O eco do celular é o `fromMe` que o número por QR já gera: dedupa, adota a linha se foi o painel que enviou (`WaMessage.adoptEcho`), tira a conversa de "Sem resposta" (`engaged_at`) e **não** aciona bot, opt-out, atribuição nem push |
| Dedupe por `external_id` único | `WaMessage.getByExternalId` + índice único | Reentrega da Meta é inofensiva |
| Fila por conversa | `waInboundQueue.js` | Ordem de chegada preservada |
| Assinatura da Meta | `utils/messenger/messengerSignature.js` (`verifyMetaSignature`) | HMAC do corpo bruto com `META_APP_SECRET`, falha fechada |
| Webhook público com corpo bruto | `app.js` (padrão do Messenger) e `routes/messengerWebhook.js` | Molde da rota nova |
| Achar o provedor sem sessão | `WhatsAppAccount.getMetaPhoneOwner` (`runUnscoped`) | `phone_number_id` → conta e provedor |
| Registro do callback na Meta | `MetaWebhookService.register` | Passa a escolher o destino |
| Varredor de retenção | `waMessageSweeper.js`, `config/retention.js` | Purga dos eventos guardados |

## Decisões de desenho

### D1. Quem entra na ponte: só número do cadastro guiado (`meta_onboarding = 'embedded'`)
A assinatura é do **app da plataforma** (`META_APP_SECRET`, o mesmo do Messenger e do Embedded Signup). O
número colado à mão (`manual`) usa o app do próprio provedor, cujo segredo o painel não tem: não dá para
conferir a assinatura, então **continua apontando direto para o Evolution e não ganha o recurso**.
Isso é uma limitação declarada, não um defeito. Alternativa descartada: patch ou fork do Evolution — põe a
manutenção de um fork na conta de quem só quer conectar um número.

### D2. Autenticação
- `POST`: `X-Hub-Signature-256` sobre o corpo **bruto**; sem assinatura válida, 401 e nada é lido.
- `GET` (a Meta confere o callback ao registrar): token próprio da ponte, `META_WA_VERIFY_TOKEN`, **diferente**
  do `cloudVerifyToken` do Evolution (o Evolution continua com o dele para os números que ficam direto).
  Devolve só dígitos do `hub.challenge` (a regra anti-XSS do webhook do Messenger).

### D3. Roteamento por mudança (`entry[].changes[]`), com padrão seguro

| `field` | Destino |
| --- | --- |
| `messages` | encaminha ao Evolution (como hoje) |
| `message_template_status_update` | encaminha ao Evolution (como hoje) |
| `account_update` | local |
| `smb_message_echoes` | local (B2) |
| `history` | local (B4) |
| `smb_app_state_sync` | local (B5) |
| qualquer outro | **encaminha** ao Evolution e registra o nome do campo |

Um corpo traz várias `changes`. Se **nenhuma** é local, o corpo bruto original é encaminhado byte a byte (o
caso comum: sem reserializar). Se há mistura, o painel monta um corpo só com as `changes` encaminháveis,
mantendo `object` e `entry.id`, e o **assina de novo** com o segredo do app: o Evolution de hoje não confere,
mas uma versão futura que conferisse continuaria aceitando.

### D4. Entrega: pelo menos uma vez, com idempotência
A Meta reenvia o que não recebe 200 (com recuo, por vários dias — **confirmar prazo e política na documentação da Meta** antes de B1). A ponte aproveita isso em vez de criar fila própria para o encaminhamento:

1. **Persiste** as `changes` locais em `wa_meta_events` (durável) **antes** de responder.
2. **Encaminha** ao Evolution, de forma síncrona, com prazo curto (5 s). Falhou ou estourou → **500**, e a Meta
   reentrega o corpo inteiro com recuo. A parte local já está persistida e é idempotente.
3. Responde 200. O tratamento local roda **depois**, a partir da tabela, por um worker com recuo exponencial
   (mesmo desenho de `waOutboxWorker`), para uma falha local não devolver 500 a quem só queria a mensagem.

Idempotência em duas camadas: `wa_meta_events.event_key = sha256(corpo bruto + índice da change)` único (uma
reentrega não duplica o evento) e `external_id` único nas mensagens (um evento reprocessado não duplica a
bolha). Atenção ao custo: a ponte passa a ser **ponto único de falha da entrada** dos números dela; as
mitigações estão em "Riscos".

### D5. Descobrir o provedor
`phone_number_id` → `whatsapp_accounts.meta_phone_number_id` (`getMetaPhoneOwner`, já único entre provedores
pelo `meta_number_in_use`). `account_update` traz o id da WABA em `entry.id` → `meta_waba_id`. Número
**desconhecido**: encaminha e responde 200 (comportamento de hoje), nunca 4xx — a Meta pode desativar callbacks que
falham com frequência (**a confirmar**).

### D6. Eco do celular → mensagem de saída, pelo caminho que já existe
Um **tradutor** converte a `change` `smb_message_echoes` no evento que o Evolution já entrega ao painel
(`messages.upsert`, `key.fromMe = true`, `remoteJid = <to>@s.whatsapp.net`, `message.conversation = <texto>`,
`messageTimestamp`) e chama `WaInboundService.handle(account, 'messages.upsert', corpo)`. Zero lógica nova de
conversa: tudo o que o `fromMe` já faz vale (dedupe, adoção, `engaged_at`, sem bot/opt-out/atribuição).
- **Tipos:** `text` na v1. Mídia entra sem bytes e com o resumo do tipo (o caminho "sem anexo" que já existe);
  baixar a mídia pela Graph (`GET /{media-id}` com o token do número, URL temporária) é a B3.
- **Se o painel mandou a mensagem**, o eco pode chegar também: o `external_id` e o `adoptEcho` cobrem.
- **Endereço do cliente:** se `to` não for um telefone (a Meta está introduzindo identificadores sem número),
  a mensagem é pulada com motivo registrado, em vez de gravar lixo como telefone (a razão de `waJid.js`).
- A janela de 24 h **não** muda: o eco não é mensagem do cliente (`last_inbound_at` só anda na entrada).
- Coluna nova em `wa_messages` para a origem (`phone`, `history`, nula = ao vivo) — confirmar na
  implementação se já existe campo equivalente — para a tela mostrar "enviada pelo celular".

### D7. Histórico (`history`)
Importador idempotente: por `thread` (o cliente), `WaConversation.ensure` e as mensagens com `external_id`,
direção por `from`. Diferenças deliberadas em relação ao tempo real:
- `created_at` = o carimbo **original** (aqui a ordem real importa; no tempo real o painel usa a chegada porque
  um servidor que reconecta despeja carimbos antigos).
- **Não** mexe em `last_inbound_at` (senão reabre a janela de 24 h de todo cliente antigo), não conta como não
  lida, não aciona bot, atribuição, push nem IA, e só avança `last_message_at` se for mais novo.
- Progresso por conta (`fase`, `parte`, `%` vêm em `history[].metadata`) e o estado **`declined`** quando o
  provedor não compartilhou o histórico (erro `2593109`). Mostrado na tela da coexistência.
- Corpo grande: o limite do corpo bruto desta rota é configurável e **medido em modo sombra** antes de
  prometer; um 413 faria a Meta reentregar em laço.

### D8. Contatos (`smb_app_state_sync`)
Baixa prioridade: `contact add/remove` preenchem o nome de exibição da conversa quando o `pushName` está vazio.
Não cria conversa nem contato novo.

### D9. `account_update`
- `ACCOUNT_OFFBOARDED` → conta `disconnected`, `last_error = meta_offboarded`, alerta técnico
  (`waAlertService`) e a tela mostra por quê.
- `ACCOUNT_RECONNECTED` → `connected` e nova leitura de saúde. Outros eventos: só registro.
É o item de maior valor e menor custo, e entra junto com o eco.

### D10. Registro e migração dos números existentes
`MetaWebhookService.register` escolhe o destino: `embedded` + ponte configurada → o callback é
`<URL pública da plataforma>/api/meta-webhook` com `META_WA_VERIFY_TOKEN`; senão, o comportamento de hoje.
Números já cadastrados migram pelo botão **"registrar de novo"** que já existe. **Reverter** = desligar
`META_WA_BRIDGE` e registrar de novo; a rota continua encaminhando para quem ainda apontar para ela.

### D11. Encaminhar ao Evolution com segurança
Destino: `<account.base_url>/webhook/meta`, pelo mesmo cliente do Evolution (resolve e fixa o endereço, guarda
de SSRF e allowlist), sem redirecionar, com prazo de 5 s e sem credencial própria (o Evolution não exige).

### D12. Dado pessoal, retenção e guardas do projeto
`wa_meta_events` guarda o corpo recebido (texto de mensagem e telefones): é dado de assinante. Então:
- tabela escopada por provedor com RLS; o `tenant_id` vem da conta resolvida e o trabalho roda em `runInTenant`;
- **retenção curta** (padrão 7 dias, só dos já tratados) pelo varredor, registrada em `config/retention.js`;
- entra no inventário LGPD; a lista de compartilhamento não muda (Meta e o Evolution do provedor já constam);
- guardas que uma tabela e uma rota públicas novas precisam satisfazer (as mesmas que pegaram a Fase 1):
  `tenantScope.js`, `rls.js`, `retention-registry`, `lgpd-inventario`, a lista de webhooks públicos de
  `route-coverage`, e a próxima migração depois da `0154`.
- limite próprio de requisições (a Meta chama de muitos endereços e o histórico vem em rajada); a assinatura é
  a autenticação, e a recusa por assinatura conta à parte.

### D13. Observabilidade
`waHealthService` ganha `metaBridge`: último evento, contagem das últimas 24 h (recebidos, encaminhados, locais
ok, falhas de encaminhamento, falhas locais) e um veredito. Falhas de encaminhamento seguidas disparam alerta
técnico. Por conta, `meta_bridge_last_event_at` (equivalente ao "nunca chegou nada" do webhook do Evolution).

## Fases de entrega

| Fase | Entrega | Risco |
| --- | --- | --- |
| **B0** | **Capturar payloads reais** (conta de coexistência): modo `META_WA_CAPTURE` guarda por 48 h o corpo bruto dos campos locais. Sai um conjunto de *fixtures*. Sem isto, nenhum tradutor é escrito | nenhum (só leitura) |
| **B1** | **Ponte em modo sombra:** rota, assinatura, resolução do provedor, `wa_meta_events`, encaminhamento de **tudo** (inclusive os campos locais, como hoje) e métricas. Comportamento idêntico ao de hoje; liga por conta | baixo; prova a confiabilidade do encaminhamento |
| **B2** | `account_update` + eco de texto (D6, D9) e o selo "enviada pelo celular" | médio |
| **B3** | Mídia do eco (baixar pela Graph e reaproveitar o armazenamento) | médio |
| **B4** | Histórico (D7), progresso e a faixa de importação na tela | maior (volume) |
| **B5** | Contatos (D8) | baixo |

Cada fase é um PR independente e reversível. B1 sozinha já entrega as métricas de que as outras dependem.

## Testes

- **Assinatura:** vetores válidos, adulterados, sem cabeçalho e sem segredo; `GET` com token certo e errado,
  e `hub.challenge` que não é número.
- **Roteamento:** a tabela de D3, inclusive campo desconhecido (encaminha) e corpo misto (parte local persiste,
  parte encaminhável sai, reassinada).
- **Encaminhamento:** Evolution falso respondendo 200, 500 e estourando o prazo → a ponte responde 200, 500 e 500;
  a mesma entrega duas vezes não duplica evento nem mensagem.
- **Provedor:** número desconhecido (encaminha e 200), número de **outro** provedor (isolamento), `account_update`
  pela WABA.
- **Eco:** adota a linha quando o painel já enviou; mensagem do celular vira bolha de saída sem acionar bot,
  opt-out nem atribuição; `to` que não é telefone é pulado; a janela de 24 h não muda.
- **Histórico:** vários *chunks*, reentrega, `last_inbound_at` e não lidas intactos, `declined`.
- **Guardas do projeto** e o *shadow equivalence*: com a ponte em sombra, o que o painel grava é idêntico ao de hoje.

## Riscos

| Risco | Mitigação |
| --- | --- |
| A ponte vira ponto único de falha da entrada dos números dela | modo sombra primeiro; liga **por conta**; 500 faz a Meta reentregar (prazo a confirmar); alerta de falha seguida; reverter é um botão |
| Formato real dos payloads difere do esperado | B0 antes de qualquer tradutor; campo desconhecido é encaminhado, nunca descartado |
| Histórico grande estoura o limite do corpo | medir em sombra; limite configurável; 413 só depois de medido |
| Um Evolution futuro passar a tratar esses campos | o `external_id` único e o `adoptEcho` evitam a bolha dobrada |
| Identificador do cliente que não é telefone | o tradutor pula com motivo; nunca grava como telefone |
| Prazo da Meta no encaminhamento | prazo curto de 5 s e 500 para reentrega, em vez de segurar a conexão |
| Número `manual` sem o recurso | declarado na tela e na documentação; o cadastro guiado é o caminho |

## Decisões que precisam de você

1. A ponte só para números do **cadastro guiado** (D1) está bom, ou há provedor que precisa do recurso com o
   **app dele** (então a ponte teria de conhecer o segredo de cada app)?
2. **Retenção** de 7 dias para o corpo dos eventos tratados (D12) está bom?
3. **Mídia do eco** na primeira entrega (B3 junto de B2) ou depois?
4. A **URL pública** da ponte é a da plataforma (`PUBLIC_BASE_URL`), uma só para todos os provedores — a Meta
   aceita um único callback por app — confere com o domínio que vocês usam para a Meta?
