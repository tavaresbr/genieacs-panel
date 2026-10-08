# Manual de cobrança da plataforma

Este manual explica, passo a passo, como a plataforma cobra os provedores que usam o painel: como ligar o Asaas, montar os planos, criar cupons, acompanhar quem pagou e quem está devendo, e o que fazer em cada situação do dia a dia.

Tudo o que está aqui fica no **console da plataforma** (o painel do dono do SaaS). O provedor tem a tela dele, **Plano**, com um guia próprio no link **Como funciona**.

## Onde fica cada coisa

| O que você quer fazer | Onde fica no console |
| --- | --- |
| Ligar o Asaas, webhook, multa/juros/desconto, nota fiscal | Configurações → Integrações |
| Suspensão automática, indicação e retenção | Configurações → Dados do SaaS |
| Alertas por WhatsApp e e-mail | Configurações → Alertas |
| Criar e editar planos | Planos |
| Ver e mexer na assinatura e nas cobranças de um provedor | Assinaturas |
| Ver quem está devendo e agir em vários de uma vez | Inadimplência |
| MRR, recebido, estornado, cancelamentos | Receita |
| Cupons de desconto | Cupons |
| Registrar pagamento manual, isentar, créditos de indicação | Provedores → botão **Plano** na linha do provedor |
| Ligar o provedor ao cliente dele no Asaas | Provedores → botão **Gateway** na linha do provedor |

## Primeiros passos

Para começar a cobrar, faça nesta ordem:

1. **Configurações → Integrações → Asaas**: cole a chave de API, gere o token do webhook e configure o webhook no Asaas (veja a próxima seção).
2. Clique em **Testar conexão** e confira se aparece "Conectado à conta…".
3. **Configurações → Integrações**: preencha **Multa, juros e desconto** e, se for emitir nota, **Nota fiscal (NFS-e)**.
4. **Planos**: crie os planos que você vende, com preço mensal e, se quiser, preço anual.
5. **Configurações → Dados do SaaS**: confira a **Suspensão automática**, a **Indicação de provedores** e a **Retenção no cancelamento**.
6. Para cada provedor: **Provedores → Gateway → Criar cliente no Asaas**. Sem isso a plataforma não consegue emitir as faturas dele.
7. Se quiser ser avisado de pagamentos e problemas: **Configurações → Alertas**.

> **Dica:** antes de cobrar de verdade, faça tudo isso com uma conta **sandbox** do Asaas e rode o teste automático (seção "Teste no sandbox").

## Integrações → Asaas

O Asaas é o banco/gateway que emite as faturas (Pix, boleto e cartão) e avisa a plataforma quando um pagamento entra.

### Chave de API e ambiente

1. No Asaas, entre em **Integrações → Chaves de API** e gere uma chave. Ela começa com `$aact_`.
2. No console, em **Configurações → Integrações → Asaas → Conexão**, escolha o **Ambiente**: **Sandbox (testes)** ou **Produção**.
3. Cole a chave no campo **Chave de API** e salve.
4. Clique em **Testar conexão**.

Pontos importantes:

- A chave de sandbox só funciona no sandbox, e a de produção só na produção. **Troque os dois juntos.**
- Depois de salva, a chave **nunca volta para a tela**. Para trocar, cole outra; para apagar, use **Apagar a chave gravada no painel**.
- Se o servidor tiver a chave numa variável de ambiente, a tela mostra "por variável de ambiente". Uma chave salva no painel passa a valer no lugar dela.

### Webhook: endereço e token

O webhook é o "aviso" que o Asaas manda para a plataforma a cada pagamento. **Sem ele, nenhum pagamento é creditado sozinho** e você teria de dar baixa à mão.

1. Em **Configurações → Integrações → Asaas → Webhook**, copie o **Endereço do webhook**.
2. Clique em **Gerar novo token**. O token aparece **uma única vez**: copie na hora.
3. No Asaas, vá em **Integrações → Webhooks**, crie um webhook **de cobranças**, cole o endereço e cole o token no campo **Token de autenticação**.
4. Ative os eventos da lista abaixo e salve.

> **Atenção:** gerar um token novo invalida o anterior na hora. Até você colar o novo no Asaas, todas as entregas do webhook serão recusadas.

### Eventos para marcar no Asaas

Marque sempre estes eventos de cobrança:

- `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED`: pagamento confirmado/recebido. Estendem o período pago e reativam um provedor suspenso por falta de pagamento.
- `PAYMENT_OVERDUE`: a fatura venceu.
- `PAYMENT_DELETED`: a fatura foi apagada no Asaas.
- `PAYMENT_REFUNDED`: o pagamento foi estornado.
- `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`: o Asaas não conseguiu cobrar no cartão salvo. A plataforma reemite a fatura como Pix/boleto e avisa o provedor.

Se você emite nota fiscal pelo Asaas, marque também:

- `INVOICE_AUTHORIZED`, `INVOICE_ERROR`, `INVOICE_CANCELED`, `INVOICE_CANCELLATION_DENIED` e `INVOICE_UPDATED`.

### Multa, juros e desconto

Em **Configurações → Integrações**, bloco **Multa, juros e desconto**. Os valores valem para as próximas faturas emitidas pelo Asaas. **Zero desliga** cada um.

- **Multa por atraso (%)**: cobrada uma vez quando a fatura vence.
- **Juros ao mês (%)**: juros proporcionais aos dias de atraso.
- **Desconto por antecipação**: escolha **Percentual** ou **Valor fixo** e **até quantos dias antes do vencimento** ele vale (0 = até o próprio dia do vencimento; no máximo 30).

Regras:

- O desconto **nunca** deixa uma fatura abaixo de **R$ 5,00** (o mínimo do Asaas).
- Faturas pagas no **cartão de crédito** não recebem multa, juros nem desconto.

### Nota fiscal (NFS-e)

No bloco **Nota fiscal (NFS-e)**, a plataforma pede ao Asaas a nota de cada cobrança assim que o pagamento é confirmado. A sua conta Asaas precisa estar habilitada para emitir notas.

1. Marque **Emitir nota fiscal automaticamente**.
2. Preencha a **Descrição do serviço**.
3. Preencha o **serviço municipal**: o **ID** que o Asaas lista para o serviço **ou** o **código** da prefeitura (e o nome, se quiser).
4. Informe a **Alíquota de ISS (%)** e marque **ISS retido pelo tomador** se for o caso.
5. Em **Observações**, escreva o que deve sair impresso (em branco, sai o período da cobrança).
6. Lembre de marcar os eventos `INVOICE_*` no webhook do Asaas.

Na aba **Assinaturas**, cada cobrança mostra a coluna **Nota** (Na fila, Processando, Emitida, Com erro, Cancelada). Dá para abrir o **PDF da nota**, e uma nota com erro pode ser pedida de novo com **Emitir de novo**. Um estorno cancela a nota daquela cobrança.

## Planos

Na aba **Planos** fica o catálogo: o que a plataforma vende. **Mudar um plano só vale para quem assinar depois**; quem já assina continua com o que contratou.

### Criar ou editar um plano

Clique em **Novo plano** e preencha:

- **Código**: identificador fixo (minúsculas, números e hífens). Não muda depois.
- **Nome**: como o plano aparece para o provedor e no site.
- **Preço** e **Moeda**. Para um plano gratuito, digite 0.
- **Período pago (dias)**: 30 é mensal. É quanto tempo um pagamento compra.
- **Dias de teste**: quantos dias grátis o provedor novo ganha.
- **Página pública**: marque **Mostrar na página pública** para o plano aparecer no site, **Destacar como "Mais popular"** e a **Ordem de exibição**. Também há **Descrição curta** e **Recursos** (um por linha).

Para tirar um plano de venda sem afetar quem já assina, use **Desativar**: ele some para novas assinaturas e continua valendo para quem já está nele.

### Mensal e anual

O campo **Preço anual (opcional)** cria a opção anual do plano:

- Vazio: o plano só tem ciclo mensal.
- Preenchido: o provedor pode escolher **Anual** na tela dele e paga esse valor a cada 365 dias. A tela mostra quanto ele economiza.
- Se já houver assinaturas anuais naquele plano, o preço anual **não pode ser removido**.

A troca de ciclo (mensal para anual ou o contrário) vale **na renovação**; até lá o período já pago continua valendo.

### Limites

Cada plano tem **Limite de operadores**, **Limite de assinantes** e **Limite de equipamentos** (ONTs).

- **Campo vazio** = sem limite.
- **Zero** é um limite de zero, que bloqueia tudo.

Também há tetos de **retenção de dados** (trilha de auditoria, mensagens e anexos do WhatsApp). Vazio é sem teto.

O provedor não consegue trocar para um plano que não comporta o uso atual: a tela mostra qual recurso passou e quanto.

### Preço de excedente

No bloco **Preço do excedente** você decide o que acontece quando o provedor passa de um limite:

- **Sem preço** (campo vazio): o limite **bloqueia**, como sempre.
- **Com preço** (por operador, por assinante ou por ONT a mais): o provedor **não é bloqueado** e paga as unidades a mais na fatura.

Como é cobrado:

- **Plano mensal**: as unidades a mais entram na fatura da renovação, pelo **maior uso do período**.
- **Plano anual**: o excedente é cobrado **todo mês**, numa fatura só do excedente, pelo maior uso de cada mês.

Na fatura, o provedor vê a linha "Excedente (recurso): unidades × preço = total".

### Subir e descer de plano

- **Subir de plano** vale na hora. Com um período pago correndo, sai uma fatura de **pró-rata** com a diferença dos dias que faltam. Se essa fatura vencer sem pagamento, o painel do provedor fica só para leitura.
- **Descer de plano** com a assinatura em dia fica **agendado para a renovação**. No teste ou em atraso, vale na hora.

## Cupons

Na aba **Cupons**, clique em **Novo cupom**:

- **Código**: o que o provedor digita (2 a 32 letras, números, hífens ou sublinhados).
- **Tipo de desconto**: **Percentual** (1 a 99%; 100% não é permitido) ou **Valor fixo** (abatido de cada fatura).
- **Duração**: **Só a primeira fatura**, **Várias faturas** (informe quantas) ou **Para sempre**.
- **Limite de usos** (vazio = ilimitado) e **Válido até** (vazio = não vence; vale só para novos resgates).
- **Planos**: marque em quais planos vale. Nenhum marcado = todos.

Regras importantes:

- **Código, desconto e duração não mudam depois de criados.** Depois só dá para **Editar limites**, **Ativar** ou **Desativar**.
- Nenhuma fatura fica abaixo de **R$ 5,00** com cupom.
- Um cupom já usado não é excluído: ele é **desativado**.
- Uma assinatura tem **um cupom por vez**. Aplicar outro substitui o atual.
- No plano anual, cada "fatura" do cupom é uma fatura anual (um ano). Alguns cupons não valem no anual; a tela do provedor avisa antes da troca.

Quem aplica o cupom:

- O **provedor**, em **Plano → Tenho um cupom**. O desconto vale para a fatura em aberto e as próximas.
- **Você**, no console, ao abrir a assinatura (**Assinaturas → Gerenciar** ou **Provedores → Plano**), no campo **Cupom de desconto**. Para tirar, **Remover**: a fatura em aberto volta ao preço cheio.

## Assinaturas

A aba **Assinaturas** mostra todos os provedores do ponto de vista de quem paga.

### A lista

- No topo, o **Resumo da carteira**: quantos estão em cada estado, o **Total em aberto** e as **Cobranças vencidas**.
- **Filtros**: por estado (Em dia, Em teste, Vencido, Suspenso, Cancelado, Sem assinatura), **Só com cobrança em aberto**, **Isentos** e busca pelo nome.
- Cada linha mostra plano, ciclo (anual), prazo (**Pago até** ou **Fim do teste**), a cobrança em aberto com o link da **Fatura**, o cartão salvo e o gateway.
- Clique em **Gerenciar** para abrir a assinatura.

### Plano, estado e prazos

Dentro de **Gerenciar**:

- **Trocar plano**: muda o plano do provedor. O sistema recusa um plano que não comporta o uso atual.
- **Suspender** / **Reativar** / **Cancelar assinatura**: suspenso e cancelado tiram todos os operadores do painel e derrubam o portal do assinante. **Nada é apagado.** Reativar à mão **não estende** o período pago; para isso, registre um pagamento.
- **Prazos → Estender renovação / cortesia**: dá mais dias (**Mais N dias**) ou escolhe uma data (**Escolher data**). Soma ao fim do teste, para quem está em teste, ou à renovação, para os demais. Use para dar prazo a quem pediu.
- **Desfazer cancelamento**: aparece quando o provedor agendou um cancelamento.

Todas as ações pedem um **Motivo**, que vai para o extrato e para a trilha de auditoria.

### Cobranças

Em **Cobranças**, cada fatura tem seus botões:

- **Abrir fatura** / **Copiar link**: para mandar ao provedor.
- **Quitar / dar baixa**: registra um pagamento feito por fora (Pix direto, transferência, dinheiro). Informe data, valor pago e observação. Se o valor for **menor** que o cobrado, o pagamento é guardado mas **não estende** o período pago.
- **Alterar vencimento**: escolhe uma nova data (a partir de hoje). O Asaas envia a fatura com a data nova.
- **Alterar valor / desconto**: novo valor, desconto em R$ ou em %. Para zerar a cobrança, cancele-a.
- **Reemitir**: emite de novo a cobrança do período (por exemplo, depois de cancelada por engano).
- **Cancelar cobrança**: a fatura deixa de valer no Asaas.
- **Estornar**: devolve **integralmente** o pagamento e desfaz o período pago. Se a nova data de "pago até" já passou, o provedor fica vencido e o painel é bloqueado. Se você já devolveu o dinheiro direto no Asaas, marque **"Já estornei fora do Asaas"** para só registrar no painel.

Abaixo das cobranças ficam o **Histórico** e os **Lembretes de cobrança enviados** (antes do vencimento, no vencimento, em atraso, aviso de suspensão e suspensão), com o canal (e-mail ou WhatsApp).

### Isentar de cobrança

Use quando um provedor não deve pagar (parceiro, cortesia, teste longo):

1. Abra a assinatura e ligue **Isento de cobrança — manter ativo sem gerar fatura**.
2. Opcional: informe **Isento até**. Em branco, vale até você desligar; com data, **a cobrança volta sozinha** nesse dia.
3. Confirme.

O que acontece:

- As cobranças abertas são **canceladas no Asaas**.
- O provedor não vence e não recebe fatura enquanto estiver isento.
- Se ele estava suspenso, a isenção o **reativa**.
- A data de fim pode ser trocada depois em **Alterar data** (ou **Sem data de fim**).
- Para voltar a cobrar antes, desligue a isenção (**Voltar a cobrar**).

### Cartão de crédito

O cartão é sempre cadastrado pelo **provedor**: ele paga uma fatura com cartão na página do Asaas e liga **Cobrar automaticamente no cartão** na tela Plano. Os dados do cartão nunca passam pelo painel.

No console você vê o selo do cartão:

- **Cartão •••• 1234**: renovações cobradas automaticamente.
- **Cartão: aguardando pagamento**: ligado, mas ainda sem cartão salvo.
- **Cartão recusado •••• 1234**: houve recusa. A fatura volta a sair como Pix/boleto, e o provedor recebe um aviso. A cobrança automática volta quando ele pagar uma fatura com cartão de novo.

### Registrar pagamento manual

Em **Provedores → Plano**, use **Registrar pagamento** para um pagamento recebido por fora sem cobrança aberta: informe valor e referência (id do Pix, número do boleto) e clique em **Marcar como pago**. Isso estende o período pago pela duração do plano. A mesma referência não é creditada duas vezes.

## Suspensão automática e lembretes

### Lembretes

A plataforma avisa o provedor por **e-mail** (e por **WhatsApp**, se houver telefone de cobrança), sempre com o link para pagar:

1. **Antes do vencimento**: junto com a emissão da fatura, até **5 dias antes**.
2. **No vencimento**.
3. **Em atraso**: **3 dias depois** do vencimento, se ainda não pagou.
4. **Aviso de suspensão**: alguns dias antes da suspensão (configurável).
5. **Suspensão**: no momento em que o painel é suspenso.

Cada lembrete sai **uma vez só** para cada vencimento. Quem tem cartão automático não recebe o "antes do vencimento" (para não pagar duas vezes).

### Suspensão automática

Em **Configurações → Dados do SaaS → Suspensão automática**:

- **Suspender após (dias de atraso)**: padrão **15**. **0 desliga** a suspensão automática.
- **Avisar antes (dias)**: padrão **3**. 0 não manda o aviso. Precisa ser menor que o prazo de suspensão.

Enquanto está vencido, o painel do provedor fica **só para leitura**. Depois do prazo, ele é **suspenso por inadimplência**. **Pagar a fatura reativa o painel na hora**, sem você precisar fazer nada.

Provedores **isentos** ou com assinatura **pausada** não são suspensos.

## Inadimplência

A aba **Inadimplência** do console reúne, numa tela só, todo provedor que está devendo:

- com fatura vencida;
- suspenso por falta de pagamento;
- com fatura de **pró-rata** ou de **excedente** em atraso.

### O que a lista mostra

Para cada provedor:

- **valor devido** (soma das cobranças abertas vencidas);
- **vencido desde** e **dias de atraso**;
- **último lembrete** enviado;
- **previsão da suspensão automática**;
- **cartão** salvo e **estado** da assinatura.

No topo há um **resumo**: o total em atraso e quantos provedores estão em cada faixa (**1–7**, **8–15**, **16–30** e **mais de 30 dias**). Dá para filtrar e ordenar por valor ou por dias de atraso.

### Ações em massa

Marque um ou mais provedores e escolha a ação na barra que aparece. Toda ação pede confirmação, vale para cada provedor separadamente (um que falhe não atrapalha os outros) e fica na trilha de auditoria:

- **Reenviar lembrete**: manda de novo o aviso com o link de pagamento.
- **Suspender**.
- **Isentar**: com data de fim opcional (como em "Isentar de cobrança").
- **Dar prazo**: estende o vencimento em **+N dias**.

Ao final, a tela mostra o resultado de cada provedor. O botão **Exportar CSV** baixa a lista para planilha.

## Receita

A aba **Receita** mostra o dinheiro da plataforma.

### Resumo

Escolha o **Período** (**Últimos 12 meses**, **Este ano** ou datas **De/Até**, até 36 meses) e clique em **Aplicar**.

- **MRR**: receita recorrente mensal das assinaturas pagantes ativas, já com cupons (o anual entra como 1/12). Não contam provedores em teste, vencidos, isentos ou em plano gratuito. É a posição de **agora**, não do período.
- **Recebido no período** e **Estornado no período**: contam pela data do pagamento e do estorno. O recebido mostra também o valor **líquido de estornos**.
- **Em aberto agora** e **Vencido** (com quantos provedores inadimplentes).
- **Descontos concedidos**: aproximado, calculado contra o preço atual de cada plano.

Abaixo vêm o gráfico **Recebido e estornado por mês** e a tabela **Por plano**.

### Exportar CSV

O botão **Exportar CSV** baixa uma planilha do período escolhido, para a contabilidade ou para o Excel.

### Relatório de cancelamentos

No fim da aba **Receita**, o bloco **Cancelamentos** mostra, desde o início do período:

- quantos **pedidos** de cancelamento houve e a **taxa de retenção**;
- quantos **descontos** e **pausas** foram oferecidos e aceitos;
- os pedidos **por motivo** e **por desfecho** (Ficou com o desconto, Pausou, Cancelou, Desfez o cancelamento, Sem decisão);
- a lista dos **pedidos recentes**, com data, provedor, motivo e desfecho.

## Indicação

O programa **Indique e ganhe** dá crédito a um provedor que traz outro provedor.

### Como ligar

Em **Configurações → Dados do SaaS → Indicação de provedores**, informe o **Crédito por indicação (R$)**. **0 desliga** o programa (os saldos que já existem continuam valendo).

### Como funciona

1. O provedor vê em **Plano → Indique e ganhe** o **link de indicação** dele (um endereço de cadastro com o código).
2. Quem se cadastra por esse link fica marcado como "indicado por".
3. Quando o indicado **paga o primeiro período**, quem indicou ganha o crédito.
4. O crédito é **abatido sozinho na próxima fatura** de quem indicou. A fatura nunca fica abaixo de R$ 5,00; o que sobrar vai para a seguinte.

### Créditos e ajuste manual

Em **Provedores → Plano → Indicações e créditos** você vê o código, quem indicou o provedor, os provedores que ele indicou, o **saldo**, o valor **reservado** em cobranças abertas e a lista de créditos.

Para corrigir o saldo, use **Ajustar saldo**: informe o **valor** (negativo tira) e o **motivo**. Não dá para tirar mais do que o saldo livre.

## Retenção

Quando o dono de um provedor clica em **Cancelar assinatura** na tela Plano, o painel pergunta o **motivo** e, antes de cancelar, oferece:

- **Desconto**: X% nas próximas N faturas (no anual, na próxima fatura anual). Oferecido **no máximo uma vez a cada 12 meses**. Se o provedor já tem um cupom melhor, a oferta não aparece; se aceitar, o desconto **substitui** o cupom atual.
- **Pausa**: até N meses sem cobrança, a partir do fim do período já pago. Durante a pausa o painel fica só para leitura, sem fatura, lembrete nem suspensão. Ele volta antes quando quiser, pagando em **Pagar agora**.

Se ele recusar as ofertas, o cancelamento fica **agendado para o fim do período pago** (ou do teste): até lá tudo funciona, sem novas cobranças. Se não houver período pago correndo (atrasado, teste vencido), cancela na hora. O provedor, ou você em **Assinaturas**, pode **Desfazer cancelamento** antes da data.

### Configuração

Em **Configurações → Dados do SaaS → Retenção no cancelamento**:

- **Desconto de retenção (%)**: padrão **20**. 0 desliga.
- **Faturas com desconto**: padrão **3**. 0 desliga.
- **Pausa máxima (meses)**: padrão **2**. 0 desliga a pausa.

Os resultados aparecem em **Receita → Cancelamentos**.

## Alertas

Em **Configurações → Alertas** você escolhe ser avisado, por **WhatsApp**, **e-mail** ou os dois, quando algo importante acontece. Os avisos vão para o **WhatsApp dos avisos** e o **E-mail dos avisos** de **Configurações → Dados do SaaS**.

### Eventos

Cada evento pode ser ligado ou desligado e ter o seu canal:

- **Pagamento recebido** (com o valor).
- **Cartão recusado**.
- **Cancelamento pedido** e **cancelamento agendado**.
- **Novo cadastro por indicação**.
- **Erro na nota fiscal (NFS-e)**.
- **Provedor suspenso automaticamente**.
- **Atraso alto**: quando um provedor passa de um valor em atraso que você define.

### Resumo diário

Em vez de um aviso por evento, você pode ligar o **resumo diário**: uma mensagem só, todo dia às **8h (horário de Brasília)**, com tudo o que aconteceu.

### Testar

Use o botão **Enviar alerta de teste** para conferir se o WhatsApp e o e-mail estão chegando.

Os alertas são enviados pelo agendador da plataforma, com novas tentativas se o envio falhar. O mesmo evento nunca gera dois alertas.

## Teste no sandbox

Antes de cobrar de verdade, dá para testar os fluxos reais contra o **sandbox do Asaas**, sem risco para dinheiro real.

### O que você precisa

- Uma conta **sandbox** no Asaas (sandbox.asaas.com) e a **chave de API** dela.
- Acesso ao servidor (terminal) onde a plataforma está instalada.

### Como rodar

No terminal, dentro da pasta da plataforma:

```
cd backend
ASAAS_SANDBOX_API_KEY=sua_chave_do_sandbox npm run e2e:asaas-sandbox
```

Para só ver o que seria feito, sem chamar o Asaas, acrescente `--dry-run`:

```
cd backend
npm run e2e:asaas-sandbox -- --dry-run
```

O script **se recusa a rodar contra a produção**: ele confere o ambiente e o endereço `sandbox.asaas.com`. Ele usa um banco temporário e um provedor de teste; não mexe nos seus dados.

### O que é testado

1. Criar o cliente no Asaas.
2. Emitir cobrança Pix/boleto e confirmar o pagamento.
3. Multa, juros e desconto na fatura.
4. Cartão de teste aprovado: cartão salvo e renovação cobrada nele.
5. Cartão recusado: a fatura volta para Pix/boleto.
6. Estorno.
7. Nota fiscal (se a conta sandbox estiver habilitada; senão aparece como "pulado").
8. Desconto por antecipação: qual valor o Asaas devolve.

### O relatório

No fim, cada fluxo aparece como **passou**, **falhou** ou **pulado**, na tela e num arquivo `reports/asaas-sandbox-<data>.json`. Se algo falhar, mande esse arquivo para o suporte técnico.

## Perguntas frequentes

### O provedor pagou, mas continua bloqueado. O que fazer?

Confira em **Assinaturas → Gerenciar → Cobranças** se a fatura aparece como paga. Se não aparece, o webhook provavelmente não chegou: verifique em **Configurações → Integrações** se o token está configurado e se os eventos estão marcados no Asaas. Para liberar na hora, use **Quitar / dar baixa** na cobrança.

### Gerei um token novo e os pagamentos pararam de entrar.

O token antigo deixou de valer. Cole o novo no Asaas, em **Integrações → Webhooks → Token de autenticação**. Pagamentos que entraram nesse meio-tempo podem ser baixados à mão com **Quitar / dar baixa**.

### Quero dar um mês grátis para um provedor.

Use **Assinaturas → Gerenciar → Prazos → Estender renovação / cortesia** com **Mais N dias** (por exemplo, 30). Para vários meses sem cobrança, use **Isentar de cobrança** com uma data de fim.

### Posso dar 100% de desconto num cupom?

Não. Toda fatura precisa cobrar pelo menos R$ 5,00. Para não cobrar nada, use a **isenção**.

### Mudei o preço de um plano. Quem já assina vai pagar o novo preço?

Não. Mudar um plano só vale para quem assinar depois.

### Um provedor passou do limite de equipamentos. Ele é bloqueado?

Depende do plano. Sem **preço de excedente**, o limite bloqueia. Com preço, ele não é bloqueado e paga as unidades a mais na fatura.

### Estornei uma cobrança. O que acontece com o provedor?

O dinheiro volta para ele, o período pago é desfeito e a nota fiscal daquela cobrança é cancelada. Se a nova data de "pago até" já passou, o painel dele fica bloqueado até um novo pagamento.

### O cartão do provedor foi recusado. Preciso fazer algo?

Não. A plataforma reemite a fatura como Pix/boleto e avisa o provedor. Se você ligou o alerta **Cartão recusado**, também é avisado.

### Onde vejo quem está devendo e quanto?

Na aba **Inadimplência**, ordenando por valor ou por dias de atraso.

### Como desligo a suspensão automática?

Em **Configurações → Dados do SaaS → Suspensão automática**, coloque **0** em **Suspender após (dias de atraso)**.
