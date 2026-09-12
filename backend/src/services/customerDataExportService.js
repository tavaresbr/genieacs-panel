import { tdb } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';
import CustomerAccount from '../models/CustomerAccount.js';
import Tenant from '../models/Tenant.js';
import { exportaColuna } from './tenantExportService.js';

/**
 * O dossiê de UM assinante, num arquivo.
 *
 * A exportação do provedor (`tenantExportService`) responde "leve o meu
 * cadastro embora". Esta responde outra pergunta, e é a pergunta que a LGPD
 * faz: **um titular pediu para ver o que existe sobre ele.** O ISP é o
 * controlador desse dado e nós somos operadores — quando o pedido chega, quem
 * tem que ter o botão é o ISP, e até aqui ele não tinha nenhum.
 *
 * ## Por que é um mapa escrito à mão, e não um laço sobre o schema
 *
 * A exportação do provedor pode enumerar as tabelas escopadas porque TODA linha
 * delas é do provedor — o `tenant_id` é o critério, e ele está em todas. Aqui
 * não existe critério único: o dado de um assinante se liga por `account_id` em
 * quatro tabelas, por `device_id` em oito, por contrato em quatro, por telefone
 * em três, e por login PPPoE no mapa da rede. Um laço genérico ou traria linhas
 * de outros assinantes ou não traria nada; o mapa abaixo é o preço de estar
 * certo, e cada linha dele é uma decisão que alguém pode conferir.
 *
 * ## As três reconstruções
 *
 * Nada disso sai de uma coluna só:
 *
 * 1. **Os device ids.** Uma ONT trocada deixa a anterior em `device_swaps`, e a
 *    telemetria dela continua em `device_samples` sob o id ANTIGO. Exportar só
 *    pelo `device_id` atual perderia o histórico inteiro de quem já trocou de
 *    aparelho — que é justamente quem tem mais história.
 * 2. **Os contratos.** `sgp_links.account_id` é anulável e é `SET NULL`, então
 *    nem toda linha de contrato aponta para a conta; o caminho de volta é pelo
 *    device id.
 * 3. **Os telefones.** A caixa de entrada do WhatsApp se liga por número, e o
 *    número mora em `sgp_links` (dois campos) e nas próprias conversas.
 *
 * ## O que NÃO está no arquivo, e é dito no arquivo
 *
 * Uma conta aposentada perde o `device_id` e o `identity_hash`: `retire()` os
 * sobrescreve com `retired:<id>`, e `retireAccount` apaga o vínculo de contrato
 * junto. O dossiê de quem foi aposentado é estruturalmente incompleto, e isso
 * não é consertável depois do fato — nenhum serviço recupera uma linha
 * destruída. O manifesto diz isso em `notCollected`, porque quem abrir o
 * arquivo daqui a dois anos precisa saber o que falta antes de concluir que o
 * painel escondeu alguma coisa.
 */

/** As tabelas escopadas que não guardam dado de assinante, e por quê. */
const SEM_DADO_DE_ASSINANTE = Object.freeze({
  settings: 'configuração do provedor',
  app_state: 'relógios dos jobs do provedor',
  vendors: 'catálogo de fabricantes',
  wifi_security_mappings: 'catálogo de segurança WiFi',
  wifi_security_config: 'política de WiFi do provedor',
  map_settings: 'preferências do mapa',
  tenant_invites: 'convites da equipe do provedor',
  provisioning_profiles: 'perfis de provisionamento',
  whatsapp_accounts: 'instâncias de WhatsApp do provedor',
  wa_templates: 'modelos de mensagem',
  wa_broadcasts: 'campanhas — o destinatário sai em wa_broadcast_recipients',
  subscriptions: 'assinatura do provedor conosco',
  billing_events: 'extrato do provedor conosco',
  billing_charges: 'as cobranças que a plataforma emitiu ao provedor'
});

/**
 * Tudo a que UM assinante alcança, reconstruído — e a razão de ser uma função
 * exportada e não um trecho dentro do `build`.
 *
 * O export e a exclusão (`customerErasureService.js`) têm que responder
 * **exatamente a mesma pergunta**: o que, neste banco, é desta pessoa. Se cada
 * um reconstruísse o conjunto por conta própria, o dia em que um deles ganhasse
 * um caminho novo — mais uma tabela de telefone, mais um jeito de casar
 * contrato — o outro ficaria para trás em silêncio. E o silêncio aqui tem duas
 * formas, as duas ruins: um export que entrega menos do que existe, e uma
 * exclusão que deixa para trás o que o export acabou de mostrar ao titular.
 *
 * Uma função só, e as duas metades do direito da LGPD só discordam se alguém as
 * fizer discordar de propósito.
 */
export async function alcanceDoAssinante(account) {
  const deviceIds = await CustomerDataExportService.deviceIdsOf(account);

  const vinculos = await tdb('sgp_links').where((q) => {
    q.where({ account_id: account.id });
    if (deviceIds.length) q.orWhereIn('device_id', deviceIds);
  }).orderBy('id');
  const contratos = [...new Set(vinculos.map((v) => v.contract).filter(Boolean))];
  const telefones = vinculos.flatMap((v) => [v.phone_e164, v.phone_manual]).filter(Boolean);

  const conversas = (deviceIds.length || contratos.length || telefones.length)
    ? await tdb('wa_conversations').where((q) => {
      q.where({ customer_account_id: account.id });
      if (deviceIds.length) q.orWhereIn('device_id', deviceIds);
      if (contratos.length) q.orWhereIn('contract', contratos);
      if (telefones.length) q.orWhereIn('wa_phone_e164', [...new Set(telefones)]);
    }).orderBy('id')
    : [];

  // O número da conversa também é telefone do titular, e pode não estar em
  // `sgp_links` — o assinante escreve do celular da esposa e a conversa nasce
  // ligada ao contrato pelo device id.
  for (const conversa of conversas) {
    if (conversa.wa_phone_e164) telefones.push(conversa.wa_phone_e164);
  }

  const nos = account.pppoe_username
    ? await tdb('mapping_nodes')
      .whereRaw('LOWER(pppoe) = ?', [String(account.pppoe_username).toLowerCase()])
      .orderBy('id')
    : [];

  return {
    deviceIds,
    contratos,
    telefones: [...new Set(telefones)],
    vinculos,
    conversas,
    conversaIds: conversas.map((c) => c.id),
    nos,
    noIds: nos.map((n) => n.node_id)
  };
}

class CustomerDataExportService {
  static FORMAT_VERSION = 1;

  /** Toda ONT que já foi desta conta: a atual e as que ficaram em `device_swaps`. */
  static async deviceIdsOf(account) {
    const ids = new Set();
    // `retired:<id>` não é device id nenhum — é o que `retire()` escreve por
    // cima do original, e procurar por ele não acharia linha alguma.
    if (account.device_id && !/^retired:/.test(account.device_id)) ids.add(account.device_id);
    const trocas = await tdb('device_swaps').where({ account_id: account.id });
    for (const troca of trocas) {
      if (troca.device_id) ids.add(troca.device_id);
      if (troca.previous_device_id) ids.add(troca.previous_device_id);
    }
    return [...ids];
  }

  static async build(accountId) {
    const account = await CustomerAccount.getById(accountId);
    if (!account) return null;

    const { deviceIds, contratos, telefones: todosTelefones, vinculos, conversas, conversaIds, nos, noIds }
      = await alcanceDoAssinante(account);

    const dados = {};
    const contagem = {};
    const guardar = (tabela, linhas) => {
      dados[tabela] = linhas.map((linha) => Object.fromEntries(
        Object.entries(linha).filter(([coluna]) => exportaColuna(coluna))
      ));
      contagem[tabela] = dados[tabela].length;
    };

    guardar('customer_accounts', [account]);
    guardar('customer_wifi_credentials', await tdb('customer_wifi_credentials')
      .where({ account_id: account.id }).orderBy('id'));
    guardar('sgp_links', vinculos);
    guardar('device_swaps', await tdb('device_swaps').where((q) => {
      q.where({ account_id: account.id });
      if (deviceIds.length) q.orWhereIn('device_id', deviceIds);
    }).orderBy('id'));

    for (const [tabela, coluna] of [
      ['device_profiles', 'device_id'],
      ['device_samples', 'device_id'],
      ['device_sample_hours', 'device_id'],
      ['provisioning_runs', 'device_id']
    ]) {
      guardar(tabela, deviceIds.length
        ? await tdb(tabela).whereIn(coluna, deviceIds).orderBy('id')
        : []);
    }

    guardar('sgp_events', (deviceIds.length || contratos.length)
      ? await tdb('sgp_events').where((q) => {
        if (deviceIds.length) q.whereIn('device_id', deviceIds);
        if (contratos.length) q.orWhereIn('contract', contratos);
      }).orderBy('id')
      : []);

    // `wa_alert_state.subject` guarda um device id OU um nó do mapa, conforme a
    // regra — por isso a busca é pelo conjunto de devices e não por uma coluna
    // chamada `device_id`, que não existe nessa tabela.
    guardar('wa_alert_state', deviceIds.length
      ? await tdb('wa_alert_state').whereIn('subject', deviceIds).orderBy('id')
      : []);

    guardar('wa_conversations', conversas);
    guardar('wa_messages', conversaIds.length
      ? await tdb('wa_messages').whereIn('conversation_id', conversaIds).orderBy('id')
      : []);
    guardar('wa_opt_outs', (todosTelefones.length || conversaIds.length)
      ? await tdb('wa_opt_outs').where((q) => {
        if (todosTelefones.length) q.whereIn('wa_phone_e164', todosTelefones);
        if (conversaIds.length) q.orWhereIn('conversation_id', conversaIds);
      }).orderBy('id')
      : []);
    guardar('wa_broadcast_recipients', (todosTelefones.length || contratos.length)
      ? await tdb('wa_broadcast_recipients').where((q) => {
        if (todosTelefones.length) q.whereIn('phone_e164', todosTelefones);
        if (contratos.length) q.orWhereIn('contract', contratos);
      }).orderBy('id')
      : []);

    guardar('mapping_nodes', nos);
    guardar('mapping_edges', noIds.length
      ? await tdb('mapping_edges').where((q) => {
        // `source`/`target`, e não `source_node_id`: as colunas guardam o
        // `node_id` do nó, e o nome curto é o que o schema usa.
        q.whereIn('source', noIds).orWhereIn('target', noIds);
      }).orderBy('id')
      : []);

    // A trilha do provedor, só as linhas que falam DESTA conta. O ator fica:
    // quem revelou a senha do portal de alguém é exatamente o que o titular tem
    // direito de saber.
    guardar('audit_log', await tdb('audit_log')
      .where({ subject_type: 'customer_account', subject_id: String(account.id) })
      .orderBy('id'));

    const provedor = await Tenant.findById(currentTenantId());
    const aposentada = !account.active || /^retired:/.test(String(account.device_id ?? ''));

    return {
      manifest: {
        formatVersion: CustomerDataExportService.FORMAT_VERSION,
        generatedAt: new Date().toISOString(),
        subject: {
          accountId: account.id,
          customerId: account.customer_id,
          active: Boolean(account.active),
          retired: aposentada
        },
        // Sem o cadastro fiscal: ele é do ISP, não do titular, e este arquivo
        // vai para as mãos do titular.
        tenant: provedor ? { id: provedor.id, slug: provedor.slug, name: provedor.name } : null,
        tables: Object.keys(dados),
        rowCounts: contagem,
        omittedTables: SEM_DADO_DE_ASSINANTE,
        omittedColumns: {
          why: 'Segredos cifrados e hashes de senha não são exportados: são inúteis '
            + 'fora deste deployment e perigosos dentro de um arquivo que circula.'
        },
        notCollected: [
          {
            what: 'genieacs',
            why: 'O estado ao vivo do aparelho vive no GenieACS, que é de fora deste banco.'
          },
          {
            what: 'attachment-bytes',
            why: 'Os arquivos das conversas ficam em disco; o arquivo traz o nome e o '
              + 'caminho de cada um, não os bytes.'
          },
          ...(aposentada ? [{
            what: 'retired-account-history',
            why: 'Esta conta foi aposentada. A aposentadoria sobrescreve o identificador do '
              + 'aparelho e apaga o vínculo de contrato, então o que existia antes dela não '
              + 'pode mais ser reunido — não está escondido aqui, deixou de existir no banco.'
          }] : [])
        ]
      },
      data: dados
    };
  }
}

export default CustomerDataExportService;
