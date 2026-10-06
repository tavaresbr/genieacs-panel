# Inventário de dados pessoais

Levantado do código, não da memória. Cada afirmação aqui aponta para o arquivo que a
sustenta, e a divisão central é fechada por teste (`backend/test/lgpd-inventario.test.js`) —
ver *Como isto continua verdadeiro*, no fim.

**O que este documento é:** o mapa de que dado pessoal o painel guarda, onde, por quê, quem
alcança e por quanto tempo fica. É o insumo factual de uma política de privacidade, de um
contrato de operador e de uma resposta a incidente.

**O que ele não é:** não é política, não é contrato, e não é parecer jurídico. Quem assina
documento deve passar por advogado — este arquivo existe para que esse advogado trabalhe
sobre o sistema real em vez de sobre texto genérico.

---

## 1. Os dois papéis, e a linha que os separa

A LGPD pergunta primeiro **quem decide** o tratamento. Neste produto a resposta não é uma só,
e a divisória está no schema, não numa opinião:

| Dado | Controlador | Operador | Onde está |
| --- | --- | --- | --- |
| Assinante de um ISP (quem tem a ONT) | **o ISP** | **nós** | as 50 tabelas escopadas por `tenant_id` |
| Operador do painel (quem faz login) | **nós** | — | `users`, `tenant_users` |
| Interessado que pediu contato na vitrine | **nós** | — | `leads` |
| Cadastro fiscal do ISP | **nós** | — | colunas `billing_*` de `tenants` |

A primeira linha é a que governa o volume: o ISP decide coletar, nós só processamos. As três
de baixo são nossas e de mais ninguém — e é por isso que a política de privacidade do
**site** e o contrato de operador com o **ISP** são documentos diferentes, com obrigações
diferentes.

A fronteira técnica dessa divisão é `tenant_id`: toda tabela escopada
(`backend/src/config/tenantScope.js`) carrega um provedor em cada linha, e `tdb()` **lança**
se for lida fora de escopo. Não existe linha de assinante sem dono.

---

## 2. Dado de assinante — as 50 tabelas escopadas

As 50 se dividem em exatamente dois grupos, sem sobra (é o que o teste fixa):

### 2.1 As 27 que alcançam um titular

São as que o dossiê percorre quando um assinante exerce o direito de acesso
(`backend/src/services/customerDataExportService.js`). Agrupadas pelo que guardam:

| Grupo | Tabelas | Dado pessoal |
| --- | --- | --- |
| **Cadastro e acesso** | `customer_accounts`, `customer_wifi_credentials` | identificador do cliente, senha do portal (cifrada), senha de WiFi (cifrada) |
| **Contrato no ERP** | `sgp_links`, `sgp_contacts`, `sgp_clients`, `sgp_events` | nome, documento, telefone, login PPPoE, plano, situação |
| **O aparelho** | `device_profiles`, `device_swaps`, `device_samples`, `device_sample_hours` | id da ONT, telemetria, histórico de troca |
| **Rede** | `mapping_nodes`, `mapping_edges` | posição do assinante na planta de fibra |
| **Atendimento (WhatsApp)** | `wa_conversations`, `wa_messages`, `wa_opt_outs`, `wa_satisfaction`, `wa_bot_events`, `wa_conversation_tags`, `wa_alert_state`, `wa_broadcast_recipients`, `wa_dunning_sends`, `wa_dunning_pauses` | telefone, conteúdo das mensagens, anexos, avaliação |
| **Operação** | `provisioning_runs`, `outage_incident_devices`, `maintenance_window_devices` | que aparelho foi ativado, atingido por queda ou avisado |
| **Trilha** | `audit_log` | quem fez o quê sobre aquele assinante |
| **Exportação** | `teiah_exports` | o que já saiu do painel sobre ele |

**O dado de um titular não se junta por uma coluna só.** O código explica por quê
(`customerDataExportService.js`, docblock do topo): liga-se por `account_id` em quatro
tabelas, por `device_id` em oito, por contrato em quatro, por telefone em três e por login
PPPoE no mapa. Quem trocou de ONT tem telemetria sob o **id antigo**, recuperável só via
`device_swaps` — exportar pelo id atual perderia justamente o histórico de quem tem mais
história.

### 2.2 As 23 que não alcançam titular nenhum

Declaradas uma a uma em `SEM_DADO_DE_ASSINANTE`, cada qual com o motivo escrito ao lado:
configuração do provedor (`settings`, `app_state`, `map_settings`), catálogo
(`vendors`, `wifi_security_config`), equipe (`tenant_invites`, `wa_agents`), modelos e
campanhas (`wa_templates`, `wa_meta_templates`, `wa_broadcasts` — o destinatário sai na
tabela de recipients, que está no grupo acima), a conta do provedor conosco (`subscriptions`,
`billing_*`, `coupon_redemptions`, `subscription_reminder_sends`) e os eventos de rede por
**nó do mapa**, não por pessoa (`outage_events`, `outage_incidents`, `maintenance_windows`).

---

## 3. Dado fora do escopo do provedor — as 12 tabelas globais

Estas não têm `tenant_id` e não pertencem a ISP nenhum. **Aqui o controlador somos nós.**

| Tabela | Dado pessoal | Observação |
| --- | --- | --- |
| `users` | nome de usuário, e-mail, hash de senha, data de verificação | quem opera o painel, de qualquer provedor |
| `tenant_users` | vínculo pessoa ↔ provedor, papel | — |
| `platform_admins` | quem tem a chave do plano de controle | — |
| `platform_audit` | trilha do console | ações sobre provedores |
| `user_recovery_codes` | códigos de recuperação | credencial |
| `auth_tickets`, `impersonation_tickets` | bilhetes de sessão | efêmeros |
| `account_lockouts` | `subject` do bloqueio por tentativa | identificador de quem errou a senha |
| **`leads`** | **nome, empresa, e-mail, telefone, cidade, mensagem, notas e `ip`** | **quem pediu contato na vitrine e nunca foi cliente de ninguém** |
| `tenants` (colunas `billing_*`) | razão social, CNPJ/CPF, endereço, e-mail e telefone de cobrança | cadastro fiscal do ISP |
| `plans`, `coupons` | — | sem dado pessoal |

`leads` merece destaque por três razões: o titular **não tem relação com ISP nenhum**, a
tabela guarda **endereço IP** (dado pessoal pela LGPD), e ela **não é podada por nada** — ver
a seção seguinte.

---

## 4. Retenção: o que some sozinho, e o que não some

O que o painel poda hoje, em `SchedulerService.retentionPass()`
(`backend/src/services/schedulerService.js:457`), provedor a provedor:

| Dado | Prazo | Configurável |
| --- | --- | --- |
| Trilha de auditoria (`audit_log`) | **365 dias** | sim, por provedor (mín. 30, máx. 3650) |
| Eventos do bot (`wa_bot_events`) | **180 dias** | não, fixo no código |
| Execuções de ativação (`provisioning_runs`) | pela configuração do provedor | sim |
| Eventos do SGP (`sgp_events`) | pela configuração do provedor | sim |
| Telemetria crua (`device_samples`) | **14 dias** | sim (1–365) |
| Telemetria por hora (`device_sample_hours`) | **90 dias** | sim (1–3650) |

**O que não tem prazo nenhum**, e portanto fica para sempre até alguém apagar à mão:

- `leads` — com IP, de gente que nunca virou cliente;
- `wa_messages` e `wa_conversations` — o conteúdo do atendimento;
- `sgp_links`, `sgp_contacts`, `sgp_clients` — nome, documento e telefone vindos do ERP;
- `customer_accounts` e as credenciais cifradas;
- `platform_audit`.

Isso não é defeito por si só — retenção é decisão de negócio, e a LGPD pede que ela seja
**declarada**, não que seja curta. Mas hoje ela não está declarada em lugar nenhum, e é a
primeira lacuna que uma política de retenção precisa fechar.

---

## 5. Os direitos do titular, e o que o painel já faz

| Direito (art. 18) | Implementado | Onde |
| --- | --- | --- |
| Acesso / portabilidade | **sim** | botão *Baixar o dossiê*, na tela do aparelho (`customer-lgpd.tsx`) |
| Eliminação | **sim** | botão *Apagar os dados*, mesma tela (`customerErasureService.js`) |
| Confirmação de tratamento | sim, pelo dossiê | — |
| Correção | parcial | pela tela do aparelho e pelo ERP |
| Informação sobre compartilhamento | **não** | não há documento que liste os terceiros |
| Revogação de consentimento | **não se aplica diretamente** | a base legal do dado de assinante é contrato, não consentimento |

Duas propriedades do que já existe valem registro, porque são as que tornam o par confiável:

1. **O dossiê e a exclusão respondem à mesma pergunta por construção.** As duas chamam
   `alcanceDoAssinante`, uma função só. O comentário dela explica o motivo: se cada uma
   reconstruísse o conjunto por conta própria, o dia em que uma ganhasse um caminho novo a
   outra ficaria para trás em silêncio — e o silêncio tem duas formas ruins, um export que
   entrega menos do que existe e uma exclusão que deixa para trás o que o export mostrou.
2. **Os dois atos entram na trilha de auditoria.** Quem pediu, quando, sobre quem.

E uma limitação que o próprio arquivo declara: a conta **aposentada** perde `device_id` e
`identity_hash`, então o dossiê de quem foi aposentado é estruturalmente incompleto. O
manifesto do arquivo diz isso em `notCollected`, para que ninguém conclua daqui a dois anos
que o painel escondeu algo.

---

## 6. Terceiros que recebem dado pessoal

Levantado dos serviços que fazem chamada externa:

| Destino | O que sai | Quando |
| --- | --- | --- |
| **GenieACS** do provedor | identificadores de ONT, parâmetros TR-069 | toda operação sobre aparelho |
| **SGP** (ERP do provedor) | contrato, documento, telefone | sincronização e abertura de chamado |
| **Evolution API** (WhatsApp) | telefone, conteúdo das mensagens, anexos | todo atendimento |
| **Asaas** (gateway) | cadastro fiscal do **provedor** | cobrança da assinatura — não envolve assinante |
| **Provedor de IA** (API compatível com OpenAI) | conteúdo da conversa | só com o atendimento por IA ligado |
| **SMTP** configurado | e-mail de operador | convite, recuperação de senha, avisos |

Os três primeiros são sistemas **do próprio ISP** — não são subcontratação nossa. Os três
últimos são escolha do deployment, e são os que um contrato de operador precisa nomear.

---

## 7. O que este levantamento achou

**Confirmado e correto:** as 50 tabelas escopadas se dividem exatamente em 23 sem titular +
27 alcançadas pelo dossiê. Nenhuma órfã. Conferido por script contra o código, não por
leitura.

**As lacunas, em ordem de risco:**

1. **Nada mantinha essa divisão verdadeira.** Não havia teste. A próxima tabela escopada que
   alguém acrescentasse cairia em nenhum dos dois baldes **em silêncio** — e o efeito seria
   um dossiê que entrega menos do que existe e uma exclusão que deixa dado para trás. É a
   lacuna que este trabalho fecha, com `backend/test/lgpd-inventario.test.js`.
2. **`leads` não tem retenção e guarda IP.** Dado pessoal de quem nunca foi cliente,
   acumulando sem prazo.
3. **A retenção não está declarada.** Os prazos existem no código; nenhum documento os diz ao
   titular.
4. **Não há lista de compartilhamento publicada.** A seção 6 acima é a matéria-prima dela.

---

## 8. Como isto continua verdadeiro

Um inventário escrito à mão envelhece no primeiro commit depois dele. O que impede isso aqui
é `backend/test/lgpd-inventario.test.js`: ele exige que **toda** tabela escopada esteja em
exatamente um dos dois lugares — declarada em `SEM_DADO_DE_ASSINANTE`, ou alcançada pelo
dossiê. Acrescentar uma tabela escopada sem classificá-la quebra a suíte, com a mensagem
dizendo qual é e o que fazer.

O teste fixa a **divisão**, não os números: ele não afirma "são 50", porque travar a contagem
faria toda tabela nova quebrar a suíte por motivo errado. O que ele não deixa passar é uma
tabela em nenhum dos dois lados — e a mensagem de falha manda atualizar este documento.

As contagens aqui (50 / 23 / 27) são, portanto, uma fotografia de hoje. Para refazê-la:

```
cd backend && node --input-type=module -e "
const { SCOPED_TABLES } = await import('./src/config/tenantScope.js');
const { SEM_DADO_DE_ASSINANTE } = await import('./src/services/customerDataExportService.js');
console.log('escopadas:', SCOPED_TABLES.size, '| sem titular:', Object.keys(SEM_DADO_DE_ASSINANTE).length);
"
```
