import { currentContext, runInTenant } from '../config/tenantContext.js';

/**
 * A fila do que o webhook de entrada faz DEPOIS de responder.
 *
 * POR QUE EXISTE
 * --------------
 * O webhook rodava o bot inteiro — SGP, IA, envio — antes de responder ao
 * Evolution. Uma volta lenta do bot estourava o prazo do servidor do outro
 * lado, que lia o silêncio como falha e REENTREGAVA o evento. A reentrega
 * batia na deduplicação e não fazia mal nenhum, mas cada uma prendia mais um
 * handler, e o operador via no Evolution uma fila de "falhas" que não eram.
 *
 * Agora o webhook autentica, grava a mensagem (é o insert com índice único em
 * `wa_messages.external_id` que deduplica, e ele acontece ANTES da resposta) e
 * responde. O resto — pesquisa, bot, distribuição, push, IA — entra aqui.
 *
 * AS TRÊS GARANTIAS
 * -----------------
 * 1. Ordem por conversa. Cada chave (provedor + conversa) é uma corrente: a
 *    tarefa seguinte só começa quando a anterior termina. Duas mensagens do
 *    mesmo cliente são respondidas na ordem em que foram gravadas, e o bot
 *    nunca decide sobre a segunda antes de ter respondido a primeira. Chaves
 *    diferentes correm em paralelo — a concorrência fica limitada, por
 *    provedor, ao número de conversas com tarefa pendente.
 *
 * 2. O provedor certo. A tarefa roda dentro de `runInTenant` com o id que
 *    quem enfileirou passou, e esse id tem de bater com o escopo em que a
 *    chamada aconteceu: enfileirar a conversa do provedor B de dentro de um
 *    pedido do provedor A é recusado na hora, antes de qualquer coisa rodar.
 *
 * 3. Nada escapa. Toda falha de tarefa é engolida aqui e vira UMA linha de log
 *    com texto fixo — sem mensagem de erro, sem nada que veio do pedido (o
 *    CodeQL já apontou injeção de log neste repositório, e o corpo do evento é
 *    hostil por definição). Nunca há rejeição sem tratamento.
 *
 * O QUE ELA NÃO É
 * ---------------
 * Durável. A fila vive na memória do processo: um processo que morre no meio
 * perde o que estava pendente. É a mesma perda de antes — o que morria entre o
 * insert e a resposta também não voltava, porque a reentrega cai na
 * deduplicação —, só que agora a janela é a da fila. `drain()` existe para o
 * desligamento normal fechar essa janela.
 */

const BACKGROUND_FAILURE_LOG = 'WhatsApp webhook background processing failed';
const STALLED_LOG = 'WhatsApp webhook background task stalled; releasing the conversation queue';

/**
 * Quanto uma tarefa pode segurar a corrente da sua conversa. Uma volta do bot
 * que nunca termina (um fetch sem prazo, uma promessa esquecida) não pode
 * deixar o cliente sem resposta para sempre: vencido o prazo, a corrente anda
 * e a próxima mensagem é atendida. A tarefa travada segue rodando — não há
 * como cancelá-la —, só deixa de bloquear as outras.
 */
export const TASK_STALL_MS = Math.max(1_000, Number(process.env.WA_INBOUND_TASK_STALL_MS) || 120_000);

function comPrazo(promessa, ms) {
  let relogio;
  const prazo = new Promise((resolve) => {
    relogio = setTimeout(() => {
      console.warn(STALLED_LOG);
      resolve();
    }, ms);
    relogio.unref?.();
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(relogio));
}

/** chave → promessa da última tarefa da corrente daquela chave. */
const correntes = new Map();
/** Toda tarefa ainda não terminada, para `whenIdle` e `drain`. */
const pendentes = new Set();

function tenantDaChamada() {
  return currentContext()?.tenantId ?? null;
}

/**
 * Põe `fn` no fim da corrente de `chave`, para rodar como o provedor
 * `tenantId`. Volta na hora; nunca lança depois de aceitar.
 *
 * @param {number} tenantId o provedor dono da conversa
 * @param {string|number} chave a conversa (ou outra coisa que deva ser serial)
 * @param {() => Promise<unknown>} fn o trabalho
 * @returns {Promise<void>} resolve quando ESTA tarefa terminou (com ou sem falha)
 */
export function enqueue(tenantId, chave, fn, { stallMs = TASK_STALL_MS } = {}) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('waInboundQueue.enqueue needs a provider id');
  }
  // Quem enfileira de dentro de um escopo só pode enfileirar para ele mesmo.
  const escopo = tenantDaChamada();
  if (escopo !== null && escopo !== id) {
    throw new Error('waInboundQueue.enqueue: provider does not match the scope in flight');
  }
  if (typeof fn !== 'function') throw new TypeError('waInboundQueue.enqueue needs a function');

  // A chave carrega o provedor: dois provedores com a mesma conversa #7 (ids
  // são por tabela, mas nada aqui deve depender disso) nunca dividem corrente.
  const k = `${id}:${String(chave)}`;
  const anterior = correntes.get(k) ?? Promise.resolve();
  const tarefa = anterior
    .then(() => comPrazo(
      Promise.resolve().then(() => runInTenant(id, fn)).catch(() => {
        console.error(BACKGROUND_FAILURE_LOG);
      }),
      stallMs
    ));
  correntes.set(k, tarefa);
  pendentes.add(tarefa);
  tarefa.finally(() => {
    pendentes.delete(tarefa);
    // Só a última da corrente limpa a chave; uma que chegou depois já a
    // substituiu e continua precisando dela.
    if (correntes.get(k) === tarefa) correntes.delete(k);
  });
  return tarefa;
}

/**
 * Resolve quando não houver tarefa pendente — inclusive as que forem
 * enfileiradas enquanto se espera. Para testes e para o desligamento.
 */
export async function whenIdle() {
  while (pendentes.size) {
    // eslint-disable-next-line no-await-in-loop -- uma tarefa pode enfileirar outra
    await Promise.allSettled([...pendentes]);
  }
}

/**
 * Espera a fila esvaziar, por no máximo `timeoutMs`. Nunca lança.
 *
 * @returns {Promise<boolean>} `true` se esvaziou, `false` se o prazo venceu
 */
export async function drain(timeoutMs = 10_000) {
  if (!pendentes.size) return true;
  let relogio;
  const prazo = new Promise((resolve) => {
    relogio = setTimeout(() => resolve(false), timeoutMs);
    relogio.unref?.();
  });
  try {
    return await Promise.race([whenIdle().then(() => true), prazo]);
  } finally {
    clearTimeout(relogio);
  }
}

/** Quantas tarefas estão pendentes agora. Observabilidade e testes. */
export function pendingCount() {
  return pendentes.size;
}

export default { enqueue, whenIdle, drain, pendingCount };
