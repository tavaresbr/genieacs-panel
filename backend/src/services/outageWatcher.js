import MappingNode from '../models/MappingNode.js';
import { TENANT_JOB_CONCURRENCY, forEachTenant } from '../config/tenantJobs.js';
import MapStatusService from './mapStatusService.js';

/**
 * Mantém o histórico de rompimentos em dia mesmo sem ninguém olhando o mapa
 * e com os alertas de WhatsApp desligados.
 *
 * A cada poucos minutos, para cada provedor que tem cliente com PPPoE no
 * mapa, pede o estado ao vivo — o mesmo de `GET /api/mapping-data/status`,
 * que já grava o histórico (`OutageEvent.observe`). Provedor sem cliente no
 * mapa não custa uma consulta ao GenieACS.
 */
const TICK_MS = 5 * 60 * 1000;

class OutageWatcher {
  static timer = null;

  /**
   * A volta em andamento: a leitura da frota de um ACS lento pode passar dos
   * cinco minutos do relógio, e a volta seguinte não deve começar por cima.
   */
  static tickPromise = null;

  static start() {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.warn(`Outage watcher tick failed: ${error.message}`);
      });
    }, TICK_MS);
    this.timer.unref();
    return this.timer;
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  static async tick() {
    if (this.tickPromise) return this.tickPromise;
    // Lado a lado, até `TENANT_JOB_CONCURRENCY`: o estado é todo do provedor
    // em escopo (mapa, histórico, cache do mapa), e em série o ACS lento de
    // um atrasava o histórico de todos.
    const work = forEachTenant(async () => {
      const mapped = (await MappingNode.getAll()).some((node) => node.type === 'ont' && String(node.pppoe ?? '').trim());
      if (!mapped) return null;
      return MapStatusService.status();
    }, {
      concurrency: TENANT_JOB_CONCURRENCY,
      onError: (error, tenant) => {
        console.warn(`Outage watcher skipped provider ${tenant.slug}: ${error.message}`);
      }
    }).then(() => undefined).finally(() => {
      if (this.tickPromise === work) this.tickPromise = null;
    });
    this.tickPromise = work;
    return work;
  }
}

export default OutageWatcher;
