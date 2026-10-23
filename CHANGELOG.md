# Changelog

TR69 Controle follows [Semantic Versioning](https://semver.org/). Release versions
are calculated from conventional commits since the previous release commit
(`chore(release): vX.Y.Z`); a `v*` Git tag counts too, when it names a newer version.

## [1.19.0] - 2026-10-23

### New

- Importador da TeiaH Valid para inadimplentes cancelados (`595ff4d0`)
- Preenche o campo aluguel (equipamento em comodato) (`e2b866b7`)
- Régua de cobrança automática, com parada no pagamento (`99b967b5`)
- Novo cliente pelo CPF/CNPJ, com cadastro no SGP (`488b8c7f`)
- Novo cliente preenchido pela TeiaH quando não está no SGP (`20db9880`)
- Botão "Usar modelos prontos" na régua automática (`0d0d6d76`)
- Colocar todos no mapa pelo endereço do SGP (`ccdd4e79`)
- Isento de cobrança no painel Plano e na aba Assinaturas (`f5d94304`)
- Isento de cobrança — manter o provedor ativo sem gerar fatura (`b56f7975`)
- Botão "Duplicar" nos modelos (`1719c99a`)
- Caixa mais próxima, ligar todos, viabilidade e sinal fraco por caixa (`951a7ccc`)
- Atualizar o token da Meta de um número oficial (`1e84134c`)
- Envio pelo painel e reatribuição dos sem dono no ACS compartilhado (`da02c76d`)
- Multa, juros e desconto por antecipação nas cobranças do Asaas (`a118810d`)
- Painel cadastra o webhook da Meta; token some da tela do provedor (`4836aa7e`)
- Provedor escolhe a API de IA (Claude ou compatível com OpenAI) (`1915dbd3`)
- Preencher mensagens com sugestões e melhorar texto com IA (`e1f2c7a9`)
- Link para comprar créditos do provedor de IA escolhido (`d3e1354f`)
- Campo opcional de workspace para chaves Anthropic sem workspace (`d5d7159c`)
- Logo e favicon do sistema em Configurações > Dados do SaaS (`e7277109`)
- Botão 'Enviar e-mail de teste' para provar o SMTP do deploy (`e4e81cea`)
- Search contracts and link from the synced contacts (`0fbc7bea`)
- Link an ONT to a contract from the contract list (`eda38dd9`)
- Reduzir e converter logo e favicon no envio (`3e631fb2`)
- Ícone da tela de início do celular (apple-touch-icon) (`2e979096`)
- Desbloqueio em confiança só depois do 'sim' do cliente (`cf78af7e`)
- Show every ONT of a contract, flag wrong links, swap/unlink from the contact (`da6a2c78`)
- A IA entrega quem quer contratar à equipe comercial (`5aae051e`)
- Group the open invoices by contract with a contract filter (`0fbd1a1b`)

### Fixed

- Provedor não define a senha de quem administra a plataforma (`48af97ad`)
- Dossiê e exclusão recortam a ONT pelo período de posse (`d5f72abb`)
- Token salvo do SGP só vai para o endereço salvo (`80990280`)
- A própria senha não se troca pela rota da equipe (`da8e6dc9`)
- Provedor suspenso derruba sessões, refresh e login (`b4c0c945`)
- Tipo e nome do anexo do WhatsApp saem do arquivo gravado (`508d2a69`)
- Erro 500 não expõe texto interno sem APP_ENV (`5a353007`)
- Segredos fora da imagem e do git, e sem valor de exemplo (`85abb2f9`)
- Muro da personificação compara o caminho sem caixa (`94822eeb`)
- Cortar window.opener da aba de personificação (`83b6aea5`)
- Guarda de egresso do SGP e do Asaas usa deploymentIsShared (`f19ab3a0`)
- Ler a senha do reset-password só do ambiente ou da entrada padrão (`f70b2564`)
- Teste de conexão de banco passa pelo portão de provedor único (`b1c3e409`)
- Mudar o segundo fator derruba as outras sessões (`3cdaf520`)
- Redefinir a senha do portal encerra a sessão aberta (`d8493c4e`)
- Bloqueio por conta após tentativas de senha e 2FA erradas (`95910f5b`)
- Tela diz que a conta está bloqueada, e não que a senha está errada (`5f84b276`)
- Cliente Evolution conecta ao endereço que conferiu (`1ff44d66`)
- Não mostrar dados de outro provedor ao trocar de painel (`8456fa81`)
- Régua usa o celular do contato sincronizado do SGP (`2165904a`)
- Isento de cobrança — fatura do período volta ao desligar e corrida com a emissão (`3eb395a2`)
- "Simular hoje" roda em segundo plano, com progresso (`65210645`)
- Consulta de viabilidade abre no meio das caixas (`89d0d4ec`)
- Fechar outros caminhos de dado entre provedores na aba (`b2fd0ce2`)
- Reconhecer o ACS compartilhado por IP/alias, não por texto (`f1856b22`)
- Diagnóstico não conta instâncias de outros provedores (`b9cffa8c`)
- No ACS compartilhado, cada provedor vê só o próprio firmware (`ab7ee458`)
- Correções da revisão — cupons, lembretes, NFS-e e receita (`030eefc5`)
- Pendências entre provedores (catálogo, conflito de login, cache de slug, avisos) (`a0db36d1`)
- Integração das quatro melhorias de cobrança (`215f74e4`)
- Correções das revisões — cartão, desconto, pró-rata e suspensão (`4d0a4266`)
- Notificações do WhatsApp e sessão entre abas por dono (`071ca0f4`)
- Chave salva só vale para o mesmo endereço (`6772faf5`)
- Corrige chamadas ao Claude e à OpenAI oficial (`3a5e38e7`)
- Choose the contract whose login matches the ONT's PPPoE login (`8121722f`)
- Rolar até o formulário ao clicar em Editar modelo (`e12e19a9`)
- Confirmação do desbloqueio compara por id de mensagem, não por horário (`068384fb`)

### Maintenance

- Configurações: salvar não para mais numa chave interna (`90ffa4d0`)
- Tell the operator when "Solicitar Inform" could not reach the ONT (`99e479e0`)
- Portal do cliente: andamento da sincronização de IDs (`9738763b`)
- Bot do WhatsApp, etapa 2: identificação por CPF/CNPJ e liberação em confiança (`c633c090`)
- Exportar em KML (`dcf634b9`)
- Só um owner troca a senha de um owner (`7cd2cb82`)
- Estado ao vivo dos pontos com PPPoE (`a699fce2`)
- Dashboard, dispositivos, auditoria, plano e gráficos (`47c45396`)
- Detalhe do dispositivo e cards (`de7c5a20`)
- Configurações (`5921b05c`)
- Casca do painel, CSS global e telas de acesso (`39a60d12`)
- Portal do cliente, mapa de rede e console da plataforma (`7ab4f446`)
- Clientes e portas livres por caixa (`9e25d464`)
- WhatsApp, contatos e detalhe do contato (`926dbdf3`)
- Aba Chatbot em Configurações: opções, mensagens e horário do bot (`aa8ca76c`)
- Viewport-fit=cover e margens de segurança (`71076b45`)
- Find active contracts whose ONT went silent for days, and move the link (`a30a5edd`)
- Interactive-widget=resizes-content (`deb811b3`)
- Alerta de rompimento: caixa pequena, mensagem completa e aviso no mapa (`ca08a712`)
- Aba Integrações com configuração do Asaas (`ad4a38d2`)
- O primeiro usuário é o dono; provedor sem dono ganha dono (`be291e4b`)
- Tabela de operadores cabe no desktop (`f4973115`)
- Cobrança: Asaas configurável pelo console, criação de cliente e ciclo da cobrança (`bcb568a0`)
- Aviso de queda em massa aos clientes afetados (`15b72ae7`)
- Tabelas mais baixas em telas estreitas (`5632253d`)
- CEP da fixture só com dígitos, como a coluna guarda (`43b41b11`)
- Portal do cliente: nome do provedor inteiro no cabeçalho (`607c499a`)
- Colocar cliente no mapa, ocupação das caixas, histórico de rompimentos e como chegar (`ddb8d8d5`)
- Gráfico de tendência: id do degradê por instância (`42031f91`)
- Relatório do chatbot do WhatsApp (`8cc1d150`)
- Aviso abaixo do cabeçalho e URL do webhook sempre completa (`f2712faa`)
- Sincronização de IDs: segundo clique não ouve "em andamento" à toa; histórico ao segundo no MySQL (`1c8004b1`)
- Modo túnel por provedor e a tabela de conexão (`fb90d464`)
- Fixar actions por SHA e auditar dependências do frontend (`19790272`)
- Fixar a imagem base node:22-alpine por digest e ligar o Dependabot (`f5c21b3e`)
- Plano do provedor: catálogo, troca de plano e pagar agora (tela) (`1a8edd51`)
- "Solicitar Inform" says since when an unreachable ONT has been silent (`d5a63980`)
- Plano do provedor: rotas de troca de plano e pagar agora, e correções da revisão (`27148f44`)
- Plano do provedor: tela do downgrade agendado (`054e7c97`)
- Configuração: aba "Painel e ACS" de volta para o provedor na SaaS (`0531ae16`)
- Plano do provedor: downgrade só na renovação (`ad6acc54`)
- Dependência ws: o servidor WebSocket do agente do GenieACS (`08e6338f`)
- Modais compartilhados, rodapé do console, abas do WhatsApp (`a08b6854`)
- Modo agente, o lado do painel (`4eb53c82`)
- Agente do GenieACS: o programa que o provedor instala na rede dele (`8efc76f3`)
- Tela do agente do GenieACS: modo Agente no console e nas Configurações (`51a3042c`)
- Cartão da conexão do GenieACS: o título é o rótulo do seletor (`a60ed292`)
- Instalador do agente do GenieACS (deploy/install-agent.sh) (`339452a6`)
- O painel serve o instalador e o programa do agente (`532fdddf`)
- Proxy e documentação do agente do GenieACS (`8aaaa54a`)
- Agente do GenieACS: as duas pontas juntas, e o que a integração mostrou (`e7c2e742`)
- "Sincronizar SGP" button on the device inventory (`c294a66b`)
- Plano do provedor: esconde ações recusadas e trata agendamento travado (`ce451a97`)
- Plano do provedor: fecha as brechas de cobrança da revisão final (`eeb667ac`)
- Manutenção programada: aviso automático, silêncio dos alertas e "concluída" (`8ae8cd4d`)
- Provedor com servidor próprio na SaaS (`568e871e`)
- "Solicitar Inform" as a batch action on the device inventory (`62c6c027`)
- Aba Assinaturas (tela) (`e1f30184`)
- Rotas da aba Assinaturas (`38ba71bb`)
- Console Assinaturas: ações conforme as regras do backend, datas de São Paulo (`c9a42a25`)
- Console Assinaturas: correções de cobrança da revisão (`dcf5d2c3`)
- Prazo do PUT sem milissegundos, como o MySQL grava (`18a634f4`)
- Módulo SGP: "Enviar na conversa" em cada fatura em aberto (`9b5e08b2`)
- O Módulo SGP não cobre mais a conversa (`4e16162b`)
- Console Assinaturas: botão Estornar (tela) (`a21de376`)
- Sino na linha das abas, sem o título (`e5cabfd6`)
- Console Assinaturas: estorno de pagamento (`5074c6b5`)
- Console Assinaturas: estorno recusado por estado divergente no gateway (`21616935`)
- Correções da revisão (`6549023d`)
- Colocar no mapa: abrir na casa do cliente, pelo endereço do SGP (`287635c7`)
- Página pública com planos do banco, cadastro com plano e leads (`651e7358`)
- PLATFORM_EXTRA_HOSTS: domínio de marketing servindo como o ápice (`31c50dbd`)
- PLATFORM_EXTRA_HOSTS também sem TENANT_BASE_DOMAIN (endereço único) (`0835e8f6`)
- Página pública: hero com ilustração do painel, faixa de números, rodapé completo (`73206fec`)
- Respostas rápidas na conversa com "/" (`35e9296f`)
- Comentário do serviço de modelos: validação pela categoria final (`2d81b7d0`)
- Intervalo entre mensagens automáticas para não bloquear o número (`ef23294c`)
- Cobrança automática não enche a caixa de entrada (`b3619d6f`)
- Comparar last_message_at em segundos inteiros (MySQL) (`dc8de7cd`)
- Nome do assinante abre o cadastro na régua de cobrança (`d2817f0a`)
- Nodemailer 10.0.13 (GHSA-g57g-f23g-4646, GHSA-v53p-9fqp-m79j) (`829851c9`)
- Configurações → Dados do SaaS, usados no site (`8ae53ed1`)
- Dados do SaaS: preencher o cadastro pelo CNPJ (`f0f26d84`)
- Datas das faturas do SGP no padrão brasileiro (`99399681`)
- Módulo "Nova campanha" (avisos para grupos de clientes) (`46a6188c`)
- Variável que faltou, detalhe da campanha e não cobrar quem já pagou (`b6cf2b0f`)
- Número preso em "conectando" não bloqueia mais a resposta (`effa8414`)
- Configuração: aba Integrações com cards (SGP, TeiaH, WhatsApp, Chatbot) (`a91e847b`)
- Alerta de número de WhatsApp caído: faixa no painel e aviso à equipe (`e5c40be7`)
- Pesquisa de satisfação no WhatsApp ao encerrar a conversa (`75652d37`)
- Número oficial da Meta pela integração WHATSAPP-BUSINESS do Evolution (`7ec8ea4d`)
- WhatsApp oficial: modelos aprovados da Meta fora da janela de 24 h (`abd7f7c6`)
- WhatsApp oficial: links para criar o app, gerar o token e gerenciar modelos na Meta (`a5185316`)
- Configurações: formato da data para todo o painel e o portal (`d8ef25d6`)
- Filtro "Sem telefone" (`8805d71b`)
- Distribuição de conversas do WhatsApp entre atendentes (`b1a03b12`)
- Quedas em massa: filtros de período, situação, ponto do mapa e aviso (`6bba945a`)
- Teclado do iPhone não cobre mais a caixa de escrever (`75c1f7a0`)
- Relatório de tempo de resposta do WhatsApp (`6e0ae7c9`)
- Relatório de receita no console: MRR, recebido, estornado, em aberto, por plano e CSV (`b899ed17`)
- Isenção de cobrança com data de fim (0091) (`e436229f`)
- NFS-e pelo Asaas: fila, emissão pelo agendador, webhook e console (`7fceb5d1`)
- Cupom de desconto na assinatura (migração 0093) (`ecd57c88`)
- Régua de lembretes de cobrança (antes, no vencimento e em atraso) (`ea1a52c0`)
- Modelos da Meta com mídia no cabeçalho e botão de URL dinâmica (`fc73ffcd`)
- WhatsApp oficial: relatório de modelos da Meta enviados por mês (`10c075a0`)
- Alertas técnicos: sub-abas "Quedas em massa" e "Configuração" (`da992c06`)
- WhatsApp oficial: criar modelos da Meta pelo painel (`2663ac48`)
- Prazo no segundo inteiro no teste de expiry_warned_for (MySQL arredonda ms) (`9cd29e1f`)
- Gravar e enviar áudio, e ouvir áudio na conversa (`f4cd4f57`)
- Etiquetas nas conversas do WhatsApp (`1e5387e9`)
- Etiqueta automática pelo bot (`482198c1`)
- Aviso de conversa esperando atendente (`23d1e1b7`)
- Notificação no navegador para mensagem nova no WhatsApp (`4f539ace`)
- Sino do navegador: cursor por id da mensagem, não por hora (`254cb611`)
- Régua de cobrança: pausa ao receber comprovante e reconfere o SGP antes de enviar (`3c69f119`)
- Não perturbe: buscar cliente e escolher os tipos de comunicação (`52171059`)
- Importar a agenda do WhatsApp conectado (`c7d5dde9`)
- Atendimento por IA no WhatsApp (API compatível com OpenAI, como a z.ai) (`d8919928`)
- Teste da caixa de entrada: folga de 1 minuto contra o arredondamento do TIMESTAMP no MySQL (`707c5aa5`)
- Teste da espera: folga para o segundo arredondado do MySQL (`0753c5fe`)
- Filtro "Importados" para separar quem veio de importação (`25ad4516`)
- Número de contatos em cada filtro (`d31686fd`)
- Estabilizar a fila de espera no MySQL (`d3adec1b`)
- Mostrar por que o provedor recusou (status e mensagem) (`d4f68296`)
- Npm audit fix no frontend (source-map-js e brace-expansion) (`e4bec78e`)
- Tabela cabe no tablet sem rolar de lado (`789f0e90`)
- Console → Integrações: a Asaas dividida em balões (`424ed079`)
- Suspensão automática por inadimplência (0102) (`2ce853d6`)
- Inventário de dados pessoais e mapa do painel, com o teste que os mantém (`2bf43aa0`)
- Fatura de pró-rata na subida de plano no meio do período (0101) (`cfff4ddc`)
- Cartão recorrente nas assinaturas (migração 0100) (`a4213d32`)
- O navegador não preenche mais a chave, e a tela mostra o fim dela (`5e416714`)
- WhatsApp no celular: cabeçalho da conversa em uma linha com o teclado aberto (`d26efb92`)
- A tela do mapa do painel, e o robots.txt que mantém o painel fora das buscas (`8e6acf4f`)
- Migrar para o Tailwind CSS 4 (`853be190`)
- Telas do WhatsApp e do Inventário cabem em notebook (`f6c10a9e`)
- Caixa de entrada: marca piscando em quem falou e não teve resposta (`55e81bba`)
- Mensagem com texto sem espaço não corta mais a conversa (`7cc8f4f2`)
- Espaçamentos que a migração para o Tailwind 4 mudou (`90478deb`)
- Abas e tabelas que escondiam conteúdo em notebook (`6f974eae`)
- Cobrança por excedente: preço por unidade acima do teto, pico de uso por período e excedente na fatura da renovação (0104) (`63bae603`)
- Plano anual com desconto: ciclo de cobrança mensal ou anual (0103) (`43519702`)
- O IP do lead, que era gravado e nunca lido, e um prazo para os pedidos antigos (`7cffe696`)
- Indicação de provedores e créditos na fatura (migração 0105) (`d4ebf132`)
- Retenção no cancelamento: motivo, desconto ou pausa, e cancelamento no fim do período (0106) (`411748ec`)
- Corrige achados da revisão de anual, excedente, indicação e retenção (0103–0106) (`24bb9a92`)
- Id da cobrança inserida pelo returning (Postgres) (`e838a398`)
- Cor da situação financeira: verde em dia, amarelo vence hoje, vermelho atrasado (`1b2465c4`)
- Import the contacts exported from Google Contacts (Gmail) (`ef0b3c69`)
- Régua de cobrança: abrir em "Histórico e resultados" (`d1ee43a7`)
- Alinha Situação com a aba Contatos (Ativos/Suspensos/Cancelados/Sem contrato) (`b7deed60`)
- Google contacts import: read phone books the way Brazilian ones are written (`4afb68b9`)
- Contacts import: send the file gzipped, so a 1 MB proxy limit does not stop it (`1776106a`)
- Campo de resposta: botões só com ícone quando o campo é estreito (`dbfd3be2`)
- Botão "Modelos" na caixa de mensagem da conversa (`b983403d`)
- Abas da caixa de entrada numa linha só, com ícones no celular (`5c10da7c`)
- Busca, categoria e tipo de cobrança com o número de cada filtro (`1731ed6b`)
- Botão Sincronizar na ficha do cliente (SGP + TR-069) (`68502b7f`)
- Nome do cliente na conversa leva ao cadastro dele (`9b544412`)
- Contrato selecionado no Módulo SGP abre o cadastro no SGP (`92602e1a`)
- WhatsApp no celular: compositor compacto com o teclado aberto (`242c4f0b`)
- Botão Receber em cada título da ficha (baixa no SGP) (`616fa633`)
- Número do contrato na lista de conversas abre o cadastro no SGP (`7dd3db7e`)
- Contrato no cabeçalho da conversa abre o cadastro no SGP (`eb37bb5d`)
- Baixa com resposta vazia do SGP conta como feita (`7a88c966`)
- Ficha do cliente: botão Equipamento no topo (`ae485ca6`)
- Página do equipamento: nome do cliente leva à ficha (`56488225`)
- Página do Embedded Signup da Meta (coexistência) servida pelo painel (`f54adf10`)
- Escolher o número de WhatsApp que envia (`bec0f44b`)
- Escrever e melhorar o texto com IA (`7863a11a`)
- Lista de mensagens que a z.ai aceita (corrige 400 · 1214 no Sugerir (IA)) (`a1be6376`)
- Ritmo de envio próprio (padrão, lento, muito lento) (`4a8fd860`)
- Detalhe do equipamento (nova varredura) e rótulo da LGPD (`f3651f8b`)
- Painel, inventário, auditoria, plano, quedas e manutenções (nova varredura) (`5fc8b871`)
- Configurações (nova varredura) (`7b894659`)
- Casca, telas de acesso e página pública (nova varredura) (`00de2a1c`)
- WhatsApp e contatos (nova varredura) (`570d2a86`)
- Detalhe do equipamento: breakpoint dos seletores do histórico em rem (`22dcd3c5`)
- Portal do cliente, mapa de rede e console da plataforma (nova varredura) (`a5cccc97`)
- Voltar para a lista clicando em "Conversas" ou em "WhatsApp" no menu (`5b29a044`)
- Alertas técnicos: juntar vários alertas em um resumo a cada 5/10/15/30 min (`f12de3fa`)
- Editar rascunho ou campanha agendada (`1a335d90`)
- Varredura por id: cobre PUT /whatsapp/broadcasts/:id (`b61eb7a1`)
- Indique e ganhe: link por cliente, página pública e lista de indicações (`654ed7a8`)
- Histórico da régua: filtro "Falhou" (entrega que falhou) (`73f2aa6c`)
- Cliente trocou de número no cadastro: a conversa antiga sai do contrato (`d7c57cc5`)
- Troca de número: a verificação começa pela consulta barata (`411896e4`)
- Importar contatos do Focus Chat (`8461fd30`)
- Coluna Equipamento e filtros com/sem equipamento (`612a0c92`)
- Histórico da régua: botão Exportar (CSV do filtro atual) (`829fcf33`)
- Dois testes de cobrança deixam de quebrar quando o job atravessa 00:00 UTC (`34f15560`)
- Teste ponta a ponta da cobrança no sandbox do Asaas (npm run e2e:asaas-sandbox) (`4df81972`)
- Manual de cobrança no painel: aba Ajuda no console e "Como funciona" no Plano (`340b1030`)
- Alertas para o admin da plataforma (0112) (`38ac0a6b`)
- Painel de inadimplência no console: lista e ações em massa (`1400827d`)
- Máscara no número de telefone da lista (`fa6b4871`)
- Alertas e inadimplência: correções da revisão e manuais alinhados (`d2e36c69`)
- Política de privacidade do site em /privacidade, com aviso na coleta (`dd927e72`)
- Ficha do cliente: cartão Status do serviço (ONT, TR-069) (`51207e36`)
- Registro de retenção: os prazos num lugar só, e o documento gerado dele (`e4aebaf3`)
- Inventário: são 14 as tabelas globais (`e8b9dc13`)
- Mensagem sem texto deixa de aparecer só como "Anexo" (`3635e66f`)
- Botão "Ligar" na conversa (`d4438cad`)
- Manter os filtros ao voltar para a página (`a3070056`)
- Anexo de operador, lista de compartilhamento e modelo de aviso ao assinante (`0870469d`)
- Lista de contatos: botão Abrir no SGP em cada linha (`0092b5cc`)
- Novo cliente pela TeiaH: completar o endereço (varredura da resposta, CEP e Receita) (`fae4a89a`)
- Conversas do WhatsApp: número com máscara e botão copiar no cabeçalho (`4eba3bdd`)
- Módulo SGP lista todos os contratos do cliente, mesmo sem ONT (`6f10e407`)
- Lista do WhatsApp: filtros de atendente e etiqueta num botão Filtros, com chips (`9ad52e09`)
- Selo de não lidas e faixa de espera viram atalhos clicáveis (`394bfbbc`)
- Conversa do WhatsApp: links no texto das mensagens ficam clicáveis (`9db3f130`)
- Conversa do WhatsApp: menu da mensagem com Responder, Copiar e Encaminhar (`bab409cf`)
- Conversa do WhatsApp: Reagir e Apagar nas mensagens (`36f1a08c`)
- Varredura de ids: casos de reação e exclusão de mensagem (`a789eddc`)
- Dados de pagamento em mensagens separadas para copiar e colar (`09cb756b`)
- Composer do WhatsApp no celular: nota, ações e Enviar numa linha só (`b47c531e`)
- Links de compra de créditos não são destino de dados (`abd4e15d`)
- TeiaH na ficha: score, mãe, endereços, telefones e e-mails; adicionar à ficha (`ff155aad`)
- Cabeçalho da conversa no celular em duas linhas (`dfe430e8`)
- Buscar telefones na TeiaH dos ativos sem telefone, com prévia e Aplicar (`1e109a23`)
- Não consultar de novo o que foi consultado há menos de 30 dias (`553281f1`)
- Trocar o WhatsApp solta a conversa do número anterior (`97b44cb3`)
- Abrir conversa: só reaproveita a conversa no número atual do cliente (`fd71e369`)
- Conversa do WhatsApp: a mensagem nova sempre leva ao fim da conversa (`e8913651`)
- Data do auto_suspended no fuso de Brasília (`db06182d`)
- Novo cliente no SGP: mostra o motivo da recusa e não preenche logradouro que é só o tipo (`0ed8af0c`)
- Erros do SGP: mensagem por status (400, 404, 429, 5xx) com o que fazer, nos 13 idiomas (`4ab648a6`)
- Preencher o endereço pelo CEP na edição e guardar outros endereços (`e4b03a69`)
- Teclado do iPhone: o cartão da conversa termina logo acima do teclado (`ba36dfe1`)
- Inventário cita o provedor de IA do atendimento (`2e337722`)
- Máscara no número do contato no módulo SGP (`967cc6fd`)
- WhatsApp (celular): só o cartão da conversa rola, o resto fica fixo (`77dadbba`)
- Módulo SGP da conversa: achar e vincular o cadastro do cliente sem contrato (`047e43d1`)
- Partes de uma resposta do robô saem na ordem mesmo se a primeira falhar (`3d845a17`)
- Apagar e reagir a mensagem entram na trilha de auditoria (`126a3cb2`)
- Régua de cobrança: PIX e linha digitável saem em mensagens separadas, para copiar e colar (`2597ca18`)
- Definir um dos outros endereços como o principal (`43c5b423`)
- Anexos do WhatsApp: nginx com teto de 17 MB na rota e aviso claro quando o proxy recusa por tamanho (`c4406689`)
- Módulo SGP: o nome do cadastro sem contrato abre a ficha do contato (`58833714`)
- Contrato vinculado sem nome herda o nome do cliente do SGP (`d1da6346`)
- Refuse a shallow clone, and check a release before writing any of it (`92ebb6d0`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/72362c25a7a2...92ebb6d0faf4)

## [1.18.0] - 2026-09-26

### New

- Filter SSIDs by enabled/disabled on the device WiFi tab (`51e145f`)
- Contatos dos assinantes do SGP na caixa de entrada (`9eeb119`)
- Contatos de assinantes do SGP sem ONT no painel (`570a711`)
- Remember WiFi filter and add it to the customer portal (`87f9e14`)
- Filter device invoices by open / cancelled / other (`64030f1`)
- Sincroniza todos os clientes do SGP para os contatos do WhatsApp (`87d4f1d`)
- Usa /api/ura/clientes/ como listagem padrão de clientes (`5ff2bc3`)
- Open the WiFi tab on "Ativas" by default (`a3aca17`)
- Reorder the menu and give Plano its own icon (`92de914`)
- Escolher o centro do mapa clicando no mapa (`5e422ad`)
- Show the build commit next to the version; wrap invoice filter on mobile (`7980c92`)
- Show the session's provider (name and slug) in the menu header (`15e49f4`)
- Centro do mapa editável nas Configurações (`2403c9d`)
- Clearer WiFi password gap; console header says platform administrator (`d32cd46`)
- Endereço principal do provedor com ponto no mapa (`dee80bd`)
- Aba Geral própria para o endereço principal do provedor (`6164f82`)
- Cadastro completo do provedor na aba Geral (`f0ae6cf`)
- Preencher o cadastro do provedor pelo CNPJ (`04a80f7`)
- CEP, localizar no mapa, sede na Topologia e CNPJ no onboarding (`924f69c`)
- Remove an ONT from GenieACS from its device page (`d1f9977`)

### Fixed

- Know which networks are on, and stop counting unknown as disabled (`8b96264`)
- Torna a sincronização de contatos do SGP fácil de achar (`3143fc1`)
- Trocar tiles escuros do CARTO por OSM com filtro escuro (`2ce62cd`)
- Consulta de CNPJ com três fontes em cascata e motivo no log (`303e17c`)
- Longitude fora de ±180 ao arrastar para outra cópia do mundo (`5662fea`)
- Centro padrão em Brasília, não Jacarta (`6d01127`)
- Stop the old ONT from taking the account back after a swap (`0cebf6b`)
- Salvar da aba Geral grava só a aba, sem sincronizar IDs (`42469dc`)

### Maintenance

- O servidor que respondeu sem dizer o sabor não é "Respondeu ()" (`77d5af9`)
- O que o prazo zero custa, dito onde a decisão é tomada (`f0d036a`)
- O prazo da trilha deixa de ser uma constante no agendador (`2e647b6`)
- Apagar os mapeamentos de segurança WiFi, que nunca foram ligados (`46632e9`)
- Teto próprio para quem enfileira, e outro para quem enfileira em bloco (`13f9ca1`)
- O prazo da trilha ganha campo na tela (`e94e475`)
- Os números do painel que faltavam viram recorte da lista (`bc6f8f7`)
- Keep an unstable ONT pair dismissed while it keeps trading the login (`fc4fdce`)
- Dotenv 17→18, express-rate-limit 7→8 (`0538004`)
- O minuto gasto do envio passa a atravessar o processo (`c760bcb`)
- Reach the SGP contract for ONTs whose login the panel could not match (`c682609`)
- O provedor que sai leva os dados dele: exportação pelo console (`66513f1`)
- Há quanto tempo, e não desde quando (`17eb206`)
- Tag each ONT in GenieACS with its contract, customer ID, store and technician (`5b029b1`)
- O módulo SGP vem para o lado da conversa do WhatsApp (`9fa3514`)
- Show the ONT's WAN and LAN MAC on the device page (`24569d4`)
- Três leituras escritas duas vezes, e a segunda cópia errava (`8e95363`)
- A 2ª via e o número do assinante, a partir do módulo SGP da conversa (`410649f`)
- A fila ociosa do WhatsApp deixa de visitar provedor sem nada a enviar (`e20208a`)
- Liberação em confiança pela rota que o SGP atende: /api/ura/liberacaopromessa/ (`638df1d`)
- Código morto sai; e uma função "morta" era a que a tela devia usar (`3b556fe`)
- Read Nokia optics and WAN VLAN by name, and show what GenieACS holds (`b55e76f`)
- Fatura cancelada deixa de contar como "em aberto" (`6e4554c`)
- Drop a pasted Postman {{url}} from endpoint paths (`75e72b6`)
- SGP contacts: own deadline for the listing, background sync (`28a833e`)
- Botão "Abrir no SGP" no lugar de "Abrir roteador" no módulo SGP (`29d2881`)
- Cada número do WhatsApp tem a sua cor na caixa de entrada (`6924c9e`)
- Read the temperature from DeviceInfo.TemperatureStatus (`339f93f`)
- SGP contacts: read more listing shapes, keep partial runs, time each page (`850c415`)
- Save the contacts section's settings through PUT /config (`acd5b7e`)
- O topo da página de WhatsApp cabe numa linha (`27e10f9`)
- Read the PPPoE login off ZTE ONTs that never reported it (`234993d`)
- Contacts entry below the device inventory (`4544666`)
- O que o operador faz na ONT passa a deixar linha na trilha (`d13b984`)
- Read Nokia optics from X_ALU_OntOpticalParam (`5d6f892`)
- Reset de fábrica da ONT, confirmado pelo número de série (`65104b8`)
- Botões "Abrir no SGP" e "Chamar no WhatsApp" na tela do equipamento (`0c43a91`)
- Ping e traceroute pela ONT, no modelo de dados que ela fala (`f96037d`)
- Tela do equipamento: botões do topo em ordem alfabética (`89bad19`)
- Full SGP client record, editable in the panel (`7830723`)
- Reset de fábrica: exigir a senha do operador duas vezes (`4a7a82b`)
- Firmware da ONT pelo painel, com os arquivos do GenieACS (`253b0d9`)
- Export and import the base as a CSV spreadsheet (`604ca0e`)
- Boas-vindas: checklist "Primeiros passos" e conclusão guardada no provedor (`965880b`)
- Retry SGP link/contact upserts the database dropped for deadlock (`6252600`)
- Separar a configuração da plataforma da configuração de cada provedor (`3f6e87e`)
- Reiniciar vários equipamentos de uma vez (`f7fbe78`)
- Firmware em lote, com cada ONT conferida contra o arquivo (`ec4a478`)
- Assistente de boas-vindas: tela inicial, progresso, SGP, WhatsApp e resumo (`ec200ee`)
- Bot de autoatendimento: menu numerado, pedir atendente e liga/desliga (`99445ba`)
- Esconder "Painel e ACS" e "Parâmetros TR-069" do provedor na SaaS (`f04eead`)
- Login em duas etapas com app autenticador (`ae9d3cb`)
- O dono exige o login em duas etapas da equipe, e a equipe destrava quem perdeu tudo (`1ed75a1`)
- Send an open invoice to the client over WhatsApp (`2b7dc83`)
- Planilha do inventário: o recorte da lista de equipamentos em CSV (`fde9268`)
- Open the menu entry on the active subscribers (`8b9e76a`)
- Enviar o slug de confirmação ao apagar um provedor (`c3cd766`)
- Inventário: buscar pelo nome do assinante e pelo contrato SGP (`9ec1a01`)
- Alertas técnicos também por e-mail (`3d15c00`)
- Client record: one masked field per phone in the edit form (`44553e3`)
- Alertas técnicos também pelo Telegram, com o bot do próprio provedor (`dcf7b0b`)
- Configuração: aba "Sobre" com as informações do painel (`9207a0b`)
- Renomear o produto para "TR69 Controle" (`5029851`)
- Client record: open the client's WhatsApp conversation from the record (`ada0c00`)
- Separa provedores que dividem o mesmo GenieACS por tag de equipamentos (`2b41c6d`)
- Editar membro da equipe e mandar o link de senha pelo WhatsApp (`f7e8966`)
- Open the conversation on the number the client record shows (`d5414f5`)
- Marca sozinho as ONTs novas com a tag do provedor pelo prefixo PPPoE (`1576fe6`)
- Mais tipos de arquivo, colar print, arrastar e vários anexos de uma vez (`3a557f2`)
- Provedor sem tag num GenieACS compartilhado não vê mais a frota alheia (`fc3d942`)
- Contacts list: show the number the client record shows for ONT contracts (`204857f`)
- "Está funcionando?" vira um sino no canto superior (`d0fc752`)
- Link de senha e convite com endereço mesmo sem domínio-base (`0106a55`)
- Client record: open a WhatsApp conversation with any of the client's numbers (`4d1d4c6`)
- Corrige "Abrir o painel" do console num deploy de host único (`996e335`)
- WhatsApp no celular: lista ou conversa, botões em ícone, caixa de escrever enxuta (`6d05fe2`)
- Sessão de atendimento da plataforma com acesso total ao painel do provedor (`aaf0406`)
- Botões da conversa só em ícone também no notebook (`9870b95`)
- Sincronização de IDs de cliente: motivo real e frotas grandes (`ee53b8d`)
- Buscar endereço e adicionar ponto no lugar achado (`be67f72`)
- Portal do cliente: contato do provedor (`b4a076b`)
- Importar KML/KMZ (`5843707`)
- Find the previous release by its release commit, not by a tag (`a7185a5`)
- Exclude every release already cut, and run through a symlinked path (`793edcc`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/2771df9a8985...793edcc6cf0f)

## [1.17.0] - 2026-09-22

### New

- Let the bell ask the ONT for the optical object itself (`413dd6a`)
- Add Arabic, and make the layout direction-aware (`327b2a6`)

### Fixed

- Read the subscriber and the optical RX off the ONT itself (`f5ed5ee`)
- Block IPv4-mapped IPv6 in the SSRF guard (`a157a76`)
- Confine a request-supplied attachment path to the provider's outbox (`b6dda33`)
- Give every safeFetch a deadline (`9d0a617`)
- Cap the Evolution response body before it is buffered (`c3624df`)
- Authenticate an attachment upload before buffering its body (`875ac72`)
- Find the optical reading by its name, not by a guessed path (`c8297c8`)
- Count every provider, not the active ones, before sweeping the legacy area (`1b851af`)
- Refuse a database switch once a second provider exists (`0253f6b`)
- Require TLS for the Evolution server (`3f09a7b`)
- Honour NODE_ENV in the secret-box guard, and give a rotation a read window (`67cd4c7`)
- Keep the tenant insert guard across a chained builder (`60c2b89`)
- Put the name resolution under the request deadline (`d9a84be`)
- Translate the SGP blocked-host refusal into Hindi (`02ae65f`)
- Link by the login the ONT reports, not the one an account holds (`e347d7b`)

### Changed

- Delete the unreachable copy of the Evolution target check (`fb58445`)

### Maintenance

- Atualizar o plano de SaaS multi-tenant contra o que existe (`7f42926`)
- Onda 13: o plano de controle, e o contrato de quem tem a chave (`eea5421`)
- Resolve the provider from the host, and refuse a token replayed on another's (`bd1d13c`)
- Close the three SSRF holes before the ACS URL becomes customer data (`b31543b`)
- Onda 13: a tela do plano de controle, e a navegação que ela ainda não tem (`46f4258`)
- Onda 13: recusar catálogo duplicado dentro de um provedor (`262139e`)
- Onda 13: vincular alguém a um provedor, do plano de controle (`33a17ed`)
- Onda 13: quem tem a chave do plano de controle (`c9c960b`)
- Onda 13: o registro de provedores, e nascer igual a um do boot (`b0bbcbf`)
- Finish the session half of Phase 2, now that a host names a provider (`f78e174`)
- Show the membership row is already the revocation, instead of adding a counter (`2374450`)
- Arm a SQL sentinel under APP_ENV=test, so every test is a scoping test (`c07043c`)
- Onda 13: a sessão diz se a pessoa tem a chave (`518b0fc`)
- Onda 13: as costuras entre as quatro faixas (`e39b51f`)
- Pin the resolved IP for GenieACS, and let the login screen learn the name (`9a31863`)
- Onda 14: o contrato do provedor por subdomínio (`d3db129`)
- Give each provider its own GenieACS, with a credential and a ceiling (`546bfc2`)
- Onda 16: o portão da Fase 8 — 404 e não 403, varrido sobre as 24 rotas por id (`5e10de4`)
- Prove the switch guard let a lone provider through without opening a socket (`b136a5b`)
- Record the handful of actions that leave no trace in the data (`c1e1043`)
- Hand a provider its own data back, without handing over its secrets (`a530c85`)
- Onda 17 (backend): papéis reais, e a guarda dizendo o que a rota faz (`2b5ddf7`)
- Stop the outbound-limit tests from depending on the machine's resolver (`3e21b17`)
- Onda 17 (frontend): quatro papéis na tela, e a guarda perguntando o que a pessoa alcança (`9742d03`)
- Onda 18: o convite, e o buraco que a onda 17 deixou no papel de owner (`f4d6d65`)
- Onda 17 (teste): o alcance de cada papel, provado por HTTP (`9baa307`)
- Onda 19 (backend): a credencial com que o painel se apresenta à NBI (`46a82e1`)
- Onda 19 (frontend): a credencial da NBI na tela, e o campo de segredo sem ambiguidade (`6d2e789`)
- Onda 20: a trilha das ações sensíveis (`3b1a821`)
- Onda 21: levar o cadastro embora, e o "flake" da suíte finalmente diagnosticado (`aa738da`)
- Onda 22: apagar um provedor, com um registro que sobrevive a ele (`a92da4e`)
- The checklist has no open line left, and say what the order of delivery became (`e76ddac`)
- Pin the DNS case to a name, so an IP literal cannot mute it (`912188c`)
- Login por e-mail (backend), em três passos e sem dia de virada (`7d2d51f`)
- Decide "is this production?" in one place, and honour both variables (`afd3c21`)
- Make suspending a provider take effect without a restart (`5a93d35`)
- Record who was put into an ISP's team, and who took them out (`e887306`)
- Fecha o espaço de nomes nas três portas que faltavam (`c01c3fd`)
- Login por e-mail (painel), sem dia de virada na tela (`4918578`)
- Add Hindi to the panel, the portal and the API (`bb7c250`)
- Fase 5: planos, limites e o ciclo de vida da assinatura (`0d11989`)
- Close both SSRF holes, on one table and one pinned transport (`f284343`)
- Add the Hindi string for the blocked-host SGP error (`352597f`)
- Give Hindi the key that landed while it was being written (`4750a99`)
- Print which tests failed, and keep the stream that says so (`676aca6`)
- Frontend do login por e-mail, e o merge com a main que o CI já testava (`1dbf9e8`)
- Fase 6: the provider's own frontend — name, sign-up, onboarding, plan (`e09e577`)
- Segundo merge com a main, e a lacuna de i18n que era dela (`2a1f2a8`)
- Drop the duplicate Hindi blocked-host key (`e39a7a4`)
- Put the clock, the operator's choice and the generated password back in charge (`69d57b2`)
- Fase 4: o conector do GenieACS, e o fim das sete cópias (`f8e2596`)
- Fase 7: operate the hosted edition — logs and metrics per provider, front door, deploy (`cfadc49`)
- Fase 4: o painel deixa de ser atualizado para quem não está olhando (`43d4058`)
- Avalia a devices_summary e fecha o muro de escala (`958dae3`)
- Compile the backend's native dependency in its own image stage (`34ea59d`)
- Make the email switch one switch, and the operators screen speak every language (`12252a5`)
- Give the new switch cases their own file, and the old one its tests back (`38518c5`)
- Fase 8: count the doors, and answer for every one of them (`7e7908d`)
- Give the backend's postinstall the file it needs to decline (`1151b26`)
- Fase 5: o portão comercial, e onde ele NÃO pode ficar (`116e277`)
- Fase 5: os limites, e o convite por onde eles escapariam (`76982ca`)
- Fase 5: o extrato comercial, e a coluna que precede o gateway (`943ed3b`)
- A porta da assinatura sai de cima do 401 (`bf5d6a0`)
- Impersonation, with its own audience and a ticket to carry it across hosts (`2c174fb`)
- Send the invite by email, where a deployment has somewhere to send it (`556552b`)
- Credit a payment reference once, and seed only the provider being born (`e4c93ac`)
- Ask Postgres for the index by name, not by scanning every schema (`35459df`)
- Give the frontend a test runner, and the first tests worth having (`eab6a93`)
- The screens the invite and the impersonation were missing (`d1a0654`)
- Tell Postgres the parameter is text (`9cb7dad`)
- RLS no Postgres: implementado, e desligado por padrão (`f693f33`)
- Read the provider before filtering the menu by it, and never show a black page again (`0952fb4`)
- Let the webhook's own pass settle an SGP event before the test reads the link (`6a23298`)
- Redefinir a senha por e-mail, e provar o endereço antes de mandar (`d6bd503`)
- O webhook do Evolution deixa de ser suposto (`4192351`)
- A volta: o painel se chama pela porta da frente (`30761f4`)
- Gerenciar planos, acesso e a trilha pelo console — as telas que faltavam (`c3d63eb`)
- Console da plataforma em russo, chinês e japonês (`62565c7`)
- Console da plataforma em espanhol, francês, alemão e italiano (`faebc44`)
- Console da plataforma em coreano, árabe e híndi — os treze fechados (`29811d9`)
- A tela pedia um host e o código exigia um caminho (`e8cccf0`)
- O cadastro do console se administra pela tela, e o último não sai (`d470a90`)
- O campo mostra o que ficou gravado, não o que foi digitado (`dc73f94`)
- O fallback do SPA resolve sob root, e não por caminho absoluto (`621363a`)
- A trilha do provedor ganha tela, e os dados do provedor ganham botão (`b9c7ba6`)
- O painel do provedor abre em outra aba, e o console fica onde estava (`eab385b`)
- O período pago vence, como o teste já vencia (`0067d7f`)
- E a tela para de prometer o que o painel já não cumpre (`d8da7f9`)
- A personificação abre sempre em outra aba, e a sessão dela é só da aba (`117a930`)
- O provedor ganha cadastro fiscal, e ele sai junto quando o provedor sai (`c733bda`)
- O cadastro manda a prova do endereço, e a poda deixa de ser promessa (`51d27b3`)
- O cadastro de um provedor deixa de ser definitivo (`c08224e`)
- A campanha parava de garrar no dia em que alguém revisava o rascunho (`5866a8d`)
- O eco do próprio envio era lido como falha, e a mensagem saía de novo (`8922e4e`)
- Duas credenciais que saíam por onde não deviam (`d4a4749`)
- O teto de assinantes valia só na varredura, e o pagamento repetido não se via (`c4a7883`)
- Os documentos param de mentir, e a guarda de egresso para de depender do .env (`97b9de5`)
- Um provedor bloqueava os outros, e a tela mentia em três lugares (`25d0202`)
- O lote do webhook não tinha prazo, e o anexo sem linha ficava no disco (`1b8b284`)
- A personificação vale para qualquer provedor, e não só para o primeiro (`79d4dc5`)
- Um provedor novo passa a ter como receber a primeira conta (`da5cd2f`)
- O GET que aposentava conta de assinante sem trilha e sob personificação (`98ec89b`)
- O painel avisa antes de bloquear (`691d95b`)
- A ação nova da trilha não tinha frase, e o portão local não olhava o frontend (`6e1d8da`)
- O endereço da plataforma roteia o console, e recusa sessão de provedor (`6d757d5`)
- O assinante ganha os dois direitos que a LGPD lhe dá (`0df18dc`)
- A trilha e a exclusão passam a dizer quem, e a exclusão passa a levar o disco (`a16c864`)
- O prazo corria na fila, o teto era do processo, e havia uma porta sem muro (`272d860`)
- O backup deixa de ser um parágrafo do runbook (`c2f136a`)
- O pagamento de um provedor deixa de ser um botão (`890db55`)
- A sessão do console existe, e ela não pertence a provedor nenhum (`a730cf4`)
- O console ganha casca própria, e o painel de um provedor não a empresta (`5fe7471`)
- O eco da nossa própria mensagem virava uma segunda bolha na conversa (`ce25127`)
- O console deixa de ser servido no host de um provedor (`7e78cc6`)
- A retenção passa a valer para provedor suspenso, que guardava para sempre (`4b80c84`)
- A rotação da SECRET_BOX_KEY passa a ter a metade que faltava (`c6feb69`)
- O painel passa a pedir o dinheiro, e não só a recebê-lo (`39f8068`)
- O proxy que o SaaS exige deixa de ser exercício do leitor (`1db6a92`)
- A conta que opera a plataforma não é membro de provedor nenhum (`416d5a4`)
- Desde quando o provedor está suspenso, que ninguém conseguia responder (`288e127`)
- Os dois documentos voltam a dizer a verdade sobre o que existe (`4fa5cb3`)
- O valor pago deixa de ser enfeite do extrato (`8c3da7d`)
- O endereço de um provedor novo, em um comando (`2721dd7`)
- Dois testes da cadência paravam de correr contra o relógio (`09ae84b`)
- O relógio parado tem de parar no presente, não em 1970 (`fd35c76`)
- O script achava o arquivo de ambiente de um só dos dois deploys (`2ea605d`)
- O script deixa de exigir um nginx já preparado para o desafio (`55128ed`)
- O prazo do teste da fila tinha 40 ms para uma ida ao banco (`cdca88d`)
- No host único, o que é anônimo apontava para o primeiro provedor (`abdb3ea`)
- O login pergunta onde entrar, e a porta não veste o primeiro provedor (`e576d48`)
- O SQLite sai do modo em que um leitor tranca um escritor (`b0fb165`)
- O provedor bloqueado passa a ter onde pagar (`73d5e98`)
- A plataforma ganha o próprio provedor (`848403e`)
- A barra lateral diz qual chapéu se está usando (`8b4902e`)
- O console passa a mostrar a saúde do deploy (`b37fea5`)
- O console passa a criar a conta de um provedor administrado (`fa7b6aa`)
- O onboarding sugere o GenieACS do provedor (`a9edb5b`)
- O runbook da migração ganha o caminho de quem não tem curinga (`d195034`)
- O catálogo padrão de equipamentos é o da plataforma (`880eed1`)
- A sonda de configuração ganha credencial própria, senão ela mentiria (`d640274`)
- Testar a integração com o Evolution, com zero números conectados (`912c962`)
- O caminho do webhook nas linhas gravadas antes da garantia existir (`38abcf5`)
- O diagnóstico passa a dizer quando os dois lados não batem (`1599d6d`)
- O webhook que a tela dizia saudável e não entregava nada (`ff7a116`)
- A faixa do cliente no topo da tela do aparelho (`7cfc5c3`)
- Liberação em confiança e Abrir chamado também no topo (`03655f6`)
- Os números do painel levam à lista que eles contam (`f397f01`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/v1.16.0...v1.17.0)

## [1.16.0] - 2026-09-10

### New

- Record device signal and uptime over time (`b9125dc`)
- Chart a device's readings on its page (`928d790`)
- Carry a subscriber's SGP link onto the ONT that replaced theirs (`f5ba01b`)
- Add an in-repo QR encoder with golden vectors from an independent oracle (`afb21d6`)
- Draw the Pix QR code and give Pix its own field (`68808c3`)
- Open a support ticket in the ERP from an ONT's page (`bb8b570`)

### Fixed

- Complete the Russian dictionary (`27500c9`)
- Truncate the inform to whole seconds before storing it (`6f85f9b`)
- Drop the Russian keys the last two merges each added (`39ce403`)

### Maintenance

- I18n: traduzir para russo as chaves da onda 7 (`5077277`)
- Onda 8: contrato, configuração e traduções compartilhadas (`af2aa4d`)
- Onda 8: sgp_links por provedor (`1a8944c`)
- Onda 8: retenção do histórico e o botão que a varredura nunca teve (`ff2af73`)
- Onda 8: subárvore de mídia por provedor, e a varredura por provedor (`dafb791`)
- Onda 8: remover as duas chaves de backend sem consumidor (`207e54c`)
- Onda 8: o botão de limpeza varre só o provedor que o apertou (`b2ffcf6`)
- Onda 8: cobrir o upgrade de sgp_links num banco que já tem linhas (`40551a2`)
- Onda 9: base compartilhada — recuo, índices e o contrato (`eb4d5ef`)
- Onda 9: a saúde tem de distinguir recuo de fila parada (`a77ecb2`)
- Onda 9: reenviar é devolver a linha à fila (`d0df4bc`)
- Toda mensagem recebida era arquivada no primeiro provedor (`a84d687`)
- Onda 9 (faixa A): a fila recua em vez de queimar as tentativas (`e27e36d`)
- Onda 9: a campanha também espera, e a costura do lote (`9b9d668`)
- Onda 10: as quatro migrações por provedor (`07e569b`)
- Onda 10: o mapa por provedor (`1ccbe2e`)
- Onda 10: provisionamento por provedor (`e0f7b9e`)
- Onda 10: o log de eventos do SGP por provedor, e a entrega que se identifica (`207f4c2`)
- Onda 10: as datas de instalação por provedor, e a varredura de Customer ID em laço (`5472e17`)
- Onda 10: o reaper de boot passa a rodar por provedor (`e607404`)
- Onda 10: o agendador inteiro passa a rodar por provedor (`ad3844f`)
- Onda 11: a migração do catálogo de equipamentos (`76a0c01`)
- `whereLike` quebra no MySQL contra coluna utf8mb4 (`ca3f0f2`)
- Onda 11: as credenciais de WiFi do assinante, por provedor (`ea2bb6d`)
- Onda 11: o catálogo de equipamentos por provedor (`f8a80fa`)
- Onda 11: validada nos três bancos antes de empurrar (`9caa1cd`)
- Onda 12: a ponte de vínculo, e o contrato do que o token carrega (`2b2c9b1`)
- Onda 12: a espinha de autenticação — o token nomeia o provedor (`eefcb15`)
- Onda 12: /api/users passa a ser a equipe de um provedor (`cb04538`)
- Onda 12: fechar a brecha do vínculo encerrado, e reconciliar com a faixa B (`b6a7ff0`)
- Onda 12: dizer que a guarda do último admin não é alcançável pela rota (`b02f965`)
- Onda 12: `users` e `tenant_users` são do deploy, e agora está escrito (`134a319`)
- Cover the upgrade path of the last three tenancy steps (`2fe76d1`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/v1.15.0...v1.16.0)

## [1.15.0] - 2026-09-09

### New

- Add provisioning and SGP event storage (`7490fae`)
- Read the PPPoE password and normalize SGP events (`b4067b6`)
- Add the write primitives provisioning composes (`8a8d18a`)
- Apply the SGP contract profile to a CPE (`4ca67f2`)
- Ingest SGP events by webhook and by reconciliation (`fb0d246`)
- Add Italian (`c7107e4`)
- Add the activation and SGP event surfaces (`6f74052`)
- Lay the foundation for the Evolution API integration (`b76cace`)
- Run the backend on PostgreSQL, and prove it in CI (`d10daa1`)
- Add the Evolution HTTP client and the wave 1 message keys (`c7766dd`)
- The Evolution instance lifecycle (`314df6d`)
- Inbound handlers and the outbox worker (`efa7042`)
- Make customer accounts belong to a provider (`4dbe6b7`)
- The dunning renderer, the SGP phone, and the wave 2 surface (`2bc7817`)
- Conversation reads and the subscriber resolver (`67c2e3c`)
- Technical alerts, and the rules that keep them readable (`6cf7f82`)
- Technical alerts, and the message bodies they were missing (`7090e0d`)
- The billing cadence — templates, campaigns and the flush loop (`ab71cb7`)
- O bot de autoatendimento (`8a0dff5`)
- The settings tab, the number cards and the QR pairing (`36fa2e1`)
- The portal URL on the settings form, and a delete warning that says what to do (`73eee6e`)
- The inbox route, and the vocabulary its screen will need (`22a813e`)
- The mechanism that scopes a query to one provider (`bc24934`)
- Scope the three tables that delete without a where clause (`bf53a7b`)
- The operator's inbox screen (`0b2c487`)
- The two refusals the inbox could provoke but not name (`8a87dde`)
- Make subscriber accounts answer only to their own provider (`061616f`)
- The two screens where a campaign's text is decided (`f92c3b4`)
- The alerts screen, where four thresholds are four different units (`a4009d8`)
- Give the WhatsApp inbox and send queue a provider (`088e951`)
- The billing cadence and the campaigns list (`f02b1f5`)
- Campaigns and the alert cooldown belong to a provider (`1c3c5a8`)
- One page, six tabs — the operator's whole WhatsApp surface (`4bf39f4`)
- The shared ground for wave 5 — a message's origin, and the words for the rest (`b57f2cf`)
- Closing a thread, and finding one (`3dd452a`)
- Let an operator correct a subscriber's number (`97137a2`)
- Give the configuration pair a provider (`c542636`)
- The shared ground for wave 6 — attachments, and where each audience fetches them (`5c3f809`)
- The operator's file — upload, allowlist, and a composer that carries it (`392c43a`)
- A stored attachment becomes one somebody can open (`2930786`)
- A real page back through a thread (`d3e959e`)
- Add Korean and repair the Traditional Chinese drift (`69e0f5b`)
- The shared ground for wave 7 — a retention window and one honest health read (`c373702`)
- Add Russian, and undo the zh-TW duplication two merges caused (`9151ccd`)
- Give each provider its own caches, and release the two jobs that can go (`a0d9527`)
- The attachment sweep — the first thing here that deletes (`640a71e`)
- One read that answers "is this working?", and a strip that says it (`718bf28`)
- The sweep tells the strip, and the strip stops scanning (`21609c1`)

### Fixed

- Close the gaps found in the second codebase analysis (`756a29a`)
- Make MySQL usable and JWT_SECRET rotatable (`689efbe`)
- Derive the copied-table list from the schema, and refresh the plan (`9bc490c`)
- Three ways the alerts and the templates lied, and the codes that hid it (`4f77c28`)
- The alerts form was about to speak the campaign's sentence (`5a00cd0`)
- The reason a build refused, and a timestamp typed as a lie (`977ceda`)
- The bot's ceiling counts the bot, and nothing else (`d12dc3f`)
- The dedupe belt was also mistaking a campaign for an answer (`e2867fb`)
- The panel could not serve itself from a path containing a dot (`3f3376f`)
- One error map for everybody, and a file with nothing in it (`9c1062c`)
- The limiter next to its sibling, and a disk path the browser never needed (`8f235a6`)
- Twenty-one keys that were declared twice, and the check that would have caught them (`af09eb2`)
- Wire the retention window the config was only pretending to have (`06ec4c3`)
- MySQL keeps whole seconds, and three health tests were asserting milliseconds (`8efb5ca`)
- Complete the Russian dictionary (`37f0b90`)
- Point the comparison links at this repository (`e0d3ff1`)

### Maintenance

- Deepen the multi-tenant plan with verified code findings (`7b3e05f`)
- Drop the stale note about hardcoded portal messages (`bdd16e7`)
- Cover activation and SGP event handling (`5241ad2`)
- Document activation and event handling (`e9fc591`)
- Merge branch 'main' and translate the new strings into Italian (`305c27f`)
- Name the migration that creates the tables (`011c107`)
- Add German as a fifth interface and API language (`f16fdc1`)
- Ignore the harness agent worktrees (`f7575b2`)
- Add French as a sixth interface and API language (`e395bcb`)
- I18n: French for everything this branch added (`5ce9880`)
- Add Japanese as a seventh interface and API language (`fdc12b3`)
- I18n: the vocabulary for the screens of wave 4 (`f69408c`)
- Add Simplified Chinese as an eighth interface and API language (`030dff3`)
- Add Traditional Chinese as a ninth interface and API language (`32d137c`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/v1.14.0...v1.15.0)

## [1.14.0] - 2026-09-08

### New

- Issue an independent password for each customer account (`ac6157c`)
- Integrate subscriber contracts and billing from SGP (`675f2dc`)
- Add multi-language support with pt-BR, en and es (`ab7b32b`)
- Translate network map and customer portal (`61d9831`)
- Translate the settings page (`5d4574f`)
- Translate the device detail page and document languages (`74744a3`)
- Translate the API responses (`2cf15ca`)
- Surface contract state across the device fleet (`00dd64b`)
- Reconcile the ONT fleet against SGP contracts (`a88e62d`)

### Maintenance

- Add the multi-tenant SaaS conversion plan (`7071b38`)

[Full comparison](https://github.com/tavaresbr/genieacs-panel/compare/v1.13.1...v1.14.0)

## [1.13.1] - 2026-07-26

### Fixed

- Bootstrap legacy CLI updates (`5e2c9d5`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.13.0...v1.13.1)

## [1.13.0] - 2026-07-26

### New

- Added explicit Customer ID synchronization when settings are saved, with immutable identity preservation and accurate generated, preserved, and pending counts.
- Added writable WAN parameter discovery across ZTE, Huawei, CMCC, and FiberHome conventions, including name, VLAN, PPPoE credentials, service list, connection mode, NAT, and interface bindings.

### Changed

- Migrated the frontend to React 19 and React Router 8.
- Raised the supported runtime to Node.js 22.22 and updated both install and CLI update flows to replace older runtimes automatically.

### Fixed

- Fixed disabled or read-only WAN fields when the ONT reports writable parameters.
- Fixed misleading WAN task responses when no values changed.
- Fixed Customer ID preservation counts when a stable SoftwareID and PPPoE identity moves to a new GenieACS device ID.

### Security

- Removed the affected React Router 7 dependency line and verified zero production dependency vulnerabilities.

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.12.0...v1.13.0)

## [1.12.0] - 2026-07-25

### New

- Expand customer operations and device management (`6bf6a8e`)

### Maintenance

- Redesign project readme (`feea67e`)
- Add product screenshots and community badges (`97ef8d6`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.11.0...v1.12.0)

## [1.11.0] - 2026-07-24

### New

- Added customer self-service controls for changing the SSID and WiFi password reported by each ONT.
- Added encrypted recovery of the last password changed through the portal, with explicit eye controls for on-demand reveal.

### Fixed

- Normalized GenieACS boolean variants so enabled WiFi radios no longer appear disabled in the operator panel or customer portal.

### Security

- Bound every portal WiFi mutation and password reveal to the authenticated customer account, with dedicated rate limits and no client-supplied device target.
- Protected saved WiFi passwords with AES-256-GCM and kept decrypted values out of overview responses and process caches.

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.10.2...v1.11.0)

## [1.10.2] - 2026-07-24

### Fixed

- Bind overview cache independently of request context (`d940608`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.10.1...v1.10.2)

## [1.10.1] - 2026-07-24

### Fixed

- Deduplicate global toast notifications (`f10067e`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.10.0...v1.10.1)

## [1.10.0] - 2026-07-24

### New

- Added an isolated customer portal on port 5891 with safe ONT and WiFi status.
- Added immutable, database-backed Customer IDs bound to SoftwareVersion and PPPoE identity.

### Fixed

- Loaded the map engine and topology concurrently, bundled Leaflet CSS locally, and centered existing assets at zoom 15.

### Security

- Hardened session revocation, route isolation, origin checks, rate limits, CSP, and deployment secrets.

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.2...v1.10.0)

## [1.9.2] - 2026-07-24

### Improved

- Render cached charts without Recharts (`321ab4b`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.1...v1.9.2)

## [1.9.1] - 2026-07-24

### Fixed

- Keep desktop sidebar anchored while scrolling (`9eef4fd`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.9.0...v1.9.1)

## [1.9.0] - 2026-07-24

### New

- Add Git-derived version and changelog UI (`ffae6ab`)

[Full comparison](https://github.com/skydashnet/genieacs-panel/compare/v1.8.5...v1.9.0)

## [1.8.5] - 2026-07-24

### New

- Rebuilt the panel as a lightweight Vite single-page application.
- Added production installer and self-updating `skygenpanel` management CLI.
- Added branded navigation, responsive operator UI, and selectable map layers.
- Added full physical topology management for HTB, OLT, ODC, ODP, ONT, and fiber cables.
- Added typed WiFi configuration tasks compatible with installer virtual parameters.
- Added fleet analytics and the GenieACS fault queue.

### Fixed

- Prevented blank screens caused by GenieACS metadata objects reaching React.
- Preserved the Leaflet map and viewport across topology refreshes.
- Removed stale Next.js artifacts during updates.
- Hardened production headers, dependency bootstrapping, and static asset delivery.

[Full history](https://github.com/skydashnet/genieacs-panel/commits/main)
