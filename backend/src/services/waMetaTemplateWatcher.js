import WaMetaTemplate from '../models/WaMetaTemplate.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import { forEachTenant } from '../config/tenantJobs.js';
import WaMetaTemplateService, { META_PENDING_STATUSES } from './waMetaTemplateService.js';

/**
 * O vigia dos modelos da Meta em análise.
 *
 * Um modelo pedido pelo painel nasce PENDING, e quem decide é a revisão da
 * Meta — minutos ou horas depois. Antes disto o provedor só sabia o resultado
 * apertando "Sincronizar". Agora, a cada dez minutos, cada número oficial que
 * tem algum modelo ainda em análise (ou que nunca sincronizou) é sincronizado
 * de novo; a sincronização grava o status novo, o motivo da recusa e quando
 * mudou, e registra a decisão na trilha.
 *
 * Por que olhar em vez de ouvir: a Meta avisa a mudança pelo evento
 * `message_template_status_update` do webhook da WABA, mas esse webhook aponta
 * para o servidor Evolution (`<servidor>/webhook/meta`, ver
 * `metaWebhookService.js`), e o Evolution só repassa ao painel os eventos de
 * conexão, QR e mensagens (`V2_WEBHOOK_EVENTS`). O evento de modelo morre lá.
 * Inventar um tratamento para um evento que não chega seria código morto — o
 * vigia cobre o caso com uma pergunta barata, e só para quem tem pendência.
 *
 * Número sem modelo em análise não é consultado: uma conta com tudo aprovado
 * não gasta pedido ao Evolution nem à Graph.
 *
 * Por provedor (`forEachTenant`): `wa_meta_templates` e `whatsapp_accounts`
 * são escopadas, então cada volta só enxerga os números do provedor da vez, e
 * a falha de um não para os outros.
 */

/** Dez minutos: a revisão da Meta leva de minutos a um dia; ninguém espera menos que isso. */
const TICK_INTERVAL_MS = 10 * 60 * 1000;

class WaMetaTemplateWatcher {
  static timer = null;
  static running = false;

  /**
   * Ligado só pelo `server.js`, nunca como efeito do import — a suíte de
   * testes não tem relógio rodando por trás, e chama `tick` direto.
   */
  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.warn(`Meta template watcher failed: ${error.message}`);
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma volta por todos os provedores. Devolve quantos números foram sincronizados. */
  static async tick() {
    if (this.running) return { synced: 0, skipped: true };
    this.running = true;
    try {
      const porProvedor = await forEachTenant(() => this.tickTenant(), {
        onError: (error, tenant) => {
          console.warn(`Meta template watcher skipped provider ${tenant.slug}: ${error.message}`);
        }
      });
      return { synced: porProvedor.reduce((total, n) => total + (Number(n) || 0), 0), skipped: false };
    } finally {
      this.running = false;
    }
  }

  /** Os números do provedor em escopo que têm o que perguntar à Meta. */
  static async dueAccounts() {
    const comPendencia = new Set(await WaMetaTemplate.accountIdsWithStatus(META_PENDING_STATUSES));
    const contas = (await WhatsAppAccount.getAll()).filter((row) => WhatsAppAccount.isCloud(row));
    // Nunca sincronizado: o modelo pode ter sido criado e a sincronização logo
    // depois ter falhado — a linha PENDING ainda nem existe aqui.
    return contas.filter((row) => comPendencia.has(Number(row.id)) || !row.meta_templates_synced_at);
  }

  static async tickTenant() {
    let synced = 0;
    for (const conta of await this.dueAccounts()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- um ou dois números por provedor
        await WaMetaTemplateService.sync(conta.id);
        synced += 1;
      } catch (error) {
        // A falha já fica em `meta_templates_error`, que a tela mostra.
        console.warn(`Meta template watcher: account ${conta.id} not synced: ${error.code || error.message}`);
      }
    }
    return synced;
  }
}

export default WaMetaTemplateWatcher;
