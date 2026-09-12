/**
 * Toda rota do painel endereçada por um id de linha, numa lista só.
 *
 * Mora aqui e não dentro da suíte porque dois testes a leem: a varredura em
 * `tenant-id-sweep.test.js`, que faz cada chamada de verdade, e a cobertura em
 * `route-coverage.test.js`, que confere que nenhuma rota endereçada por id
 * ficou de fora dela. Ler a lista de dentro do arquivo de teste faria o
 * segundo subir os servidores do primeiro só para contar casos.
 *
 * Cada caso diz:
 *
 * - `chave`   qual linha semeada usar (o seed devolve um objeto com estas chaves);
 * - `tabela`  onde conferir, depois, que a linha do vizinho ficou intacta;
 * - `coluna`  por qual coluna a rota endereça a linha (`id`, salvo quando a
 *             chave natural é que vai na URL, como o `node_id` do mapa);
 * - `esperado` o status que a rota tem que dar ao id do vizinho — 404 quase
 *             sempre, e o que não for 404 tem o motivo escrito ao lado;
 * - `controleSoNaoAchou` para as rotas que alcançam a rede quando o id resolve:
 *             o controle exige que a instância tenha sido encontrada, não que a
 *             chamada tenha dado certo.
 */
export const casos = [
  {
    // O dossiê LGPD de um assinante. A rota mais perigosa da lista: devolve
    // tudo o que existe sobre uma pessoa, e apontá-la para o id do vizinho
    // entregaria o dossiê de um assinante de outro ISP.
    chave: 'customerAccount',
    label: 'GET /api/customers/:accountId/export',
    method: 'GET',
    path: (id) => `/api/customers/${id}/export`,
    tabela: 'customer_accounts'
  },
  {
    // E a exclusão do mesmo assinante. O id do vizinho tem que dar 404 antes de
    // qualquer validação de corpo: um 409 dizendo "aposente a conta primeiro"
    // já teria confirmado que a linha existe.
    //
    // No controle, o id do próprio beta dá 409 e não 404 — a conta semeada está
    // ativa, e a rota exige aposentar antes. É o controle que se quer: um 409
    // só se chega DEPOIS de a conta ter sido encontrada, e a varredura não
    // destrói a linha que usa.
    chave: 'customerAccount',
    label: 'DELETE /api/customers/:accountId',
    method: 'DELETE',
    path: (id) => `/api/customers/${id}`,
    tabela: 'customer_accounts'
  },
  {
    chave: 'user',
    label: 'PATCH /api/users/:id',
    method: 'PATCH',
    path: (id) => `/api/users/${id}`,
    body: { role: 'viewer' },
    tabela: 'users'
  },
  {
    chave: 'user',
    label: 'DELETE /api/users/:id',
    method: 'DELETE',
    path: (id) => `/api/users/${id}`,
    tabela: 'users'
  },
  {
    chave: 'template',
    label: 'PUT /api/whatsapp/templates/:id',
    method: 'PUT',
    path: (id) => `/api/whatsapp/templates/${id}`,
    body: { name: 'segunda-via', body: 'Outro texto', category: 'cobranca' },
    tabela: 'wa_templates'
  },
  {
    chave: 'template',
    label: 'DELETE /api/whatsapp/templates/:id',
    method: 'DELETE',
    path: (id) => `/api/whatsapp/templates/${id}`,
    tabela: 'wa_templates'
  },
  {
    chave: 'optOut',
    label: 'DELETE /api/whatsapp/opt-outs/:id',
    method: 'DELETE',
    path: (id) => `/api/whatsapp/opt-outs/${id}`,
    tabela: 'wa_opt_outs'
  },
  {
    chave: 'broadcast',
    label: 'POST /api/whatsapp/broadcasts/:id/status',
    method: 'POST',
    path: (id) => `/api/whatsapp/broadcasts/${id}/status`,
    body: { status: 'canceled' },
    tabela: 'wa_broadcasts'
  },
  {
    chave: 'account',
    label: 'GET /api/whatsapp/accounts/:id/qr',
    method: 'GET',
    path: (id) => `/api/whatsapp/accounts/${id}/qr`,
    tabela: 'whatsapp_accounts',
    // O beta chegaria à rede se o id resolvesse, e a porta 9 está fechada: o
    // controle abaixo aceita o erro de transporte, e o que ele exige é que a
    // resposta não seja `account_not_found`.
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'GET /api/whatsapp/accounts/:id/status',
    method: 'GET',
    path: (id) => `/api/whatsapp/accounts/${id}/status`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/restart',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/restart`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/disconnect',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/disconnect`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'GET /api/whatsapp/accounts/:id/webhook',
    method: 'GET',
    path: (id) => `/api/whatsapp/accounts/${id}/webhook`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/webhook',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/webhook`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/webhook/probe',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/webhook/probe`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'PATCH /api/whatsapp/accounts/:id',
    method: 'PATCH',
    path: (id) => `/api/whatsapp/accounts/${id}`,
    body: { label: 'Renomeado pelo vizinho' },
    tabela: 'whatsapp_accounts'
  },
  {
    chave: 'event',
    label: 'GET /api/sgp/events/:id',
    method: 'GET',
    path: (id) => `/api/sgp/events/${id}`,
    tabela: 'sgp_events'
  },
  {
    chave: 'event',
    label: 'POST /api/sgp/events/:id/retry',
    method: 'POST',
    path: (id) => `/api/sgp/events/${id}/retry`,
    tabela: 'sgp_events'
  },
  {
    chave: 'profile',
    label: 'PUT /api/provisioning/profiles/:id',
    method: 'PUT',
    path: (id) => `/api/provisioning/profiles/${id}`,
    body: { name: 'perfil-padrao', priority: 20, enabled: true },
    tabela: 'provisioning_profiles'
  },
  {
    chave: 'profile',
    label: 'DELETE /api/provisioning/profiles/:id',
    method: 'DELETE',
    path: (id) => `/api/provisioning/profiles/${id}`,
    tabela: 'provisioning_profiles'
  },
  {
    chave: 'swap',
    label: 'POST /api/devices/swaps/:id/acknowledge',
    method: 'POST',
    path: (id) => `/api/devices/swaps/${id}/acknowledge`,
    tabela: 'device_swaps'
  },
  {
    chave: 'vendor',
    label: 'GET /api/vendor-management/:id',
    method: 'GET',
    path: (id) => `/api/vendor-management/${id}`,
    tabela: 'vendors'
  },
  {
    chave: 'vendor',
    label: 'PUT /api/vendor-management/:id',
    method: 'PUT',
    path: (id) => `/api/vendor-management/${id}`,
    body: {
      name: 'Fabricante Comum',
      manufacturer_patterns: ['ACME'],
      product_patterns: ['AC-1000'],
      parameter_prefix: 'InternetGatewayDevice'
    },
    tabela: 'vendors'
  },
  {
    chave: 'vendor',
    label: 'POST /api/vendor-management/:vendorId/wifi-security',
    method: 'POST',
    path: (id) => `/api/vendor-management/${id}/wifi-security`,
    body: { raw_security_value: '11i-vizinho', normalized_security: 'WPA3', description: 'escrito de fora' },
    tabela: 'vendors'
  },
  {
    chave: 'mapping',
    label: 'PUT /api/vendor-management/wifi-security/:id',
    method: 'PUT',
    path: (id) => `/api/vendor-management/wifi-security/${id}`,
    body: { raw_security_value: '11i', normalized_security: 'WPA3', description: 'trocado' },
    tabela: 'wifi_security_mappings'
  },
  {
    chave: 'mapping',
    label: 'DELETE /api/vendor-management/wifi-security/:id',
    method: 'DELETE',
    path: (id) => `/api/vendor-management/wifi-security/${id}`,
    tabela: 'wifi_security_mappings'
  },
  {
    chave: 'wifiConfig',
    label: 'GET /api/vendor-management/wifi-security-configs/:id',
    method: 'GET',
    path: (id) => `/api/vendor-management/wifi-security-configs/${id}`,
    tabela: 'wifi_security_config'
  },
  {
    chave: 'wifiConfig',
    label: 'PUT /api/vendor-management/wifi-security-configs/:id',
    method: 'PUT',
    path: (id) => `/api/vendor-management/wifi-security-configs/${id}`,
    body: {
      product_class: 'AC-1000',
      security_types: ['WPA2'],
      password_param_path: 'WLANConfiguration.1.KeyPassphrase'
    },
    tabela: 'wifi_security_config'
  },
  {
    chave: 'wifiConfig',
    label: 'DELETE /api/vendor-management/wifi-security-configs/:id',
    method: 'DELETE',
    path: (id) => `/api/vendor-management/wifi-security-configs/${id}`,
    tabela: 'wifi_security_config'
  },
  // A leitura do caminho `/:vendorId/wifi-security`. O POST irmão já estava na
  // varredura; esta respondia 200 com lista VAZIA para o fabricante do
  // vizinho — indistinguível de "este fabricante não tem mapeamento nenhum",
  // que é uma resposta sobre um registro de outro provedor. Passou a responder
  // 404, como o POST no mesmo caminho e como `GET /api/vendor-management/:id`
  // já respondiam, e com isso sai das exceções e entra aqui.
  {
    chave: 'vendor',
    label: 'GET /api/vendor-management/:vendorId/wifi-security',
    method: 'GET',
    path: (id) => `/api/vendor-management/${id}/wifi-security`,
    tabela: 'vendors'
  },
  // O fabricante por último entre os do catálogo: apagá-lo leva os mapeamentos
  // junto pela chave estrangeira, e os casos acima precisam da linha de pé.
  {
    chave: 'vendor',
    label: 'DELETE /api/vendor-management/:id',
    method: 'DELETE',
    path: (id) => `/api/vendor-management/${id}`,
    tabela: 'vendors'
  },

  // --- O mapa da planta. A URL leva a chave natural (`node_id`, `edge_id`) e
  // não o id da linha, e é justamente por isso que os dois provedores podem
  // nomear o mesmo poste: a unique é composta desde a onda que escopou a
  // tabela. O cabo vem antes do poste porque apagar o poste leva o cabo junto,
  // pela estrangeira composta com ON DELETE CASCADE.
  {
    chave: 'edge',
    label: 'GET /api/mapping-data/edges/:edgeId',
    method: 'GET',
    path: (id) => `/api/mapping-data/edges/${id}`,
    tabela: 'mapping_edges',
    coluna: 'edge_id'
  },
  {
    chave: 'edge',
    label: 'PUT /api/mapping-data/edges/:edgeId',
    method: 'PUT',
    path: (id) => `/api/mapping-data/edges/${id}`,
    body: (ids) => ({
      source: ids.nodeA, target: ids.nodeB, fiber_type: 'drop', distance: 42, notes: 'trocado pelo vizinho'
    }),
    tabela: 'mapping_edges',
    coluna: 'edge_id'
  },
  {
    chave: 'edge',
    label: 'DELETE /api/mapping-data/edges/:edgeId',
    method: 'DELETE',
    path: (id) => `/api/mapping-data/edges/${id}`,
    tabela: 'mapping_edges',
    coluna: 'edge_id'
  },
  {
    chave: 'nodeA',
    label: 'GET /api/mapping-data/nodes/:nodeId',
    method: 'GET',
    path: (id) => `/api/mapping-data/nodes/${id}`,
    tabela: 'mapping_nodes',
    coluna: 'node_id'
  },
  {
    chave: 'nodeA',
    label: 'PUT /api/mapping-data/nodes/:nodeId',
    method: 'PUT',
    path: (id) => `/api/mapping-data/nodes/${id}`,
    body: { type: 'odp', name: 'Renomeado pelo vizinho', latitude: -15.79, longitude: -47.88 },
    tabela: 'mapping_nodes',
    coluna: 'node_id'
  },
  {
    chave: 'nodeA',
    label: 'DELETE /api/mapping-data/nodes/:nodeId',
    method: 'DELETE',
    path: (id) => `/api/mapping-data/nodes/${id}`,
    tabela: 'mapping_nodes',
    coluna: 'node_id'
  },
  // --- O convite. Revogar o do vizinho seria fechar a porta de entrada da
  // equipe dele; o link continua valendo até o dono revogar.
  {
    chave: 'invite',
    label: 'DELETE /api/invites/:id',
    method: 'DELETE',
    path: (id) => `/api/invites/${id}`,
    tabela: 'tenant_invites'
  },
  // --- A caixa de entrada. A conversa carrega contrato e device id do
  // assinante, então lê-la de fora é ler o cadastro do vizinho.
  {
    chave: 'conversation',
    label: 'GET /api/whatsapp/conversations/:id/messages',
    method: 'GET',
    path: (id) => `/api/whatsapp/conversations/${id}/messages`,
    tabela: 'wa_conversations'
  },
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/status',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/status`,
    body: { status: 'closed' },
    tabela: 'wa_conversations'
  },
  // 409 e não 404, e está certo: a rota não distingue "não existe" de "não dá
  // para reenfileirar", e a leitura por baixo é escopada — o vizinho recebe a
  // mesma recusa que receberia para uma mensagem já entregue. O que se exige
  // aqui é o de sempre: a linha do outro provedor não pode ter sido tocada.
  {
    chave: 'conversation',
    label: 'POST /api/whatsapp/conversations/:id/messages',
    method: 'POST',
    path: (id) => `/api/whatsapp/conversations/${id}/messages`,
    body: { body: 'Escrito na conversa do vizinho' },
    tabela: 'wa_conversations',
    // Com o id próprio a rota vai à Evolution, que aqui é uma porta fechada:
    // o controle exige que a CONVERSA tenha sido encontrada, não que o envio
    // tenha dado certo.
    controleSoNaoAchou: true,
    codigoDeNaoAchou: 'conversation_not_found'
  },
  {
    chave: 'failedMessage',
    label: 'POST /api/whatsapp/messages/:id/requeue',
    method: 'POST',
    path: (id) => `/api/whatsapp/messages/${id}/requeue`,
    tabela: 'wa_messages',
    esperado: 409
  },
  // A conta do WhatsApp por último: apagá-la leva as conversas junto, e os
  // casos acima precisam delas de pé.
  {
    chave: 'account',
    label: 'DELETE /api/whatsapp/accounts/:id',
    method: 'DELETE',
    path: (id) => `/api/whatsapp/accounts/${id}`,
    tabela: 'whatsapp_accounts'
  }
];
