/**
 * Quem pode ter assinado uma entrega de webhook (SGP, Asaas): a lista de
 * provedores ativos com a entrega ligada e o segredo de cada um.
 *
 * A pergunta é feita a cada POST que chega, e respondê-la era ler `tenants` e
 * abrir um escopo e a configuração de CADA provedor ativo — trabalho que cresce
 * com o deploy, não com o tráfego, e que um ERP que reenvia em rajada repete
 * centenas de vezes por minuto com a mesma resposta. Uma cópia por processo,
 * por trinta segundos, e esquecida quando alguém salva a configuração do SGP ou
 * do Asaas ou muda o status de um provedor.
 *
 * Por processo, e NÃO por provedor como o `TenantCache`: a lista é justamente
 * o que atravessa provedores — a rota é pública e o provedor é o resultado da
 * conferência, não uma entrada. Não há escopo em que guardá-la.
 *
 * O que continua igual: a conferência contra TODOS os candidatos, em tempo
 * constante, e a recusa quando dois casam. A memória só poupa a montagem da
 * lista.
 */
export const DELIVERY_CANDIDATES_TTL_MS = 30_000;

class ProcessCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entry = null;
  }

  get() {
    if (!this.entry || this.entry.expiresAt <= Date.now()) return null;
    return this.entry.value;
  }

  set(value) {
    this.entry = { value, expiresAt: Date.now() + this.ttlMs };
    return value;
  }

  clear() {
    this.entry = null;
  }

  /**
   * A lista guardada, ou a montada por `load` — e guardada como promessa, para
   * que a rajada que chega junta espere uma leitura só. A que falha não fica.
   *
   * A promessa entra na memória ANTES de resolver, e por isso a corrida com a
   * invalidação se resolve sozinha: se alguém salvou a configuração enquanto a
   * leitura voava, o `clear()` a tirou dali, e ela termina para quem a pediu
   * sem voltar para a memória — seria a lista de antes do salvar.
   */
  async remember(load) {
    const cached = this.get();
    if (cached) return cached;
    const promise = load();
    this.set(promise);
    const entry = this.entry;
    promise.catch(() => {
      if (this.entry === entry) this.clear();
    });
    return promise;
  }
}

export const sgpDeliveryCandidates = new ProcessCache(DELIVERY_CANDIDATES_TTL_MS);
export const asaasDeliveryCandidates = new ProcessCache(DELIVERY_CANDIDATES_TTL_MS);

/** Um provedor mudou de status ou sumiu: as duas listas ficam velhas. */
export function invalidateDeliveryCandidates() {
  sgpDeliveryCandidates.clear();
  asaasDeliveryCandidates.clear();
}
