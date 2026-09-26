import CustomerAccount from '../models/CustomerAccount.js';
import CustomerService from './customerService.js';
import DeviceService from './deviceService.js';

/**
 * A sincronização de IDs de cliente pedida pelo botão das configurações.
 *
 * Cada conta nova nasce com a sua senha do portal, e a senha é um bcrypt —
 * dezenas de milissegundos cada, numa thread só. Com mil ONTs sem conta a
 * passada leva minutos, e o proxy na frente do painel corta a requisição
 * muito antes: o operador via "não foi possível sincronizar" enquanto o
 * servidor continuava trabalhando. Por isso a requisição espera no máximo
 * `BUDGET_MS`; o que passar disso continua aqui, em segundo plano, e quem
 * pedir de novo nesse meio-tempo ouve "em andamento" em vez de abrir uma
 * segunda passada sobre as mesmas contas.
 */
const running = new Map();
const TIMED_OUT = Symbol('timed-out');

async function syncOnce() {
  const devices = await DeviceService.getCustomerIdentityDevices();
  const deviceIds = devices.map((device) => String(device?._id || '')).filter(Boolean);
  const identityHashes = devices
    .filter((device) => device?._id && device?.softwareId && device?.pppoe)
    .map((device) => CustomerService.identityHash(device.softwareId, device.pppoe));
  const existingRows = await CustomerAccount.getExistingForIdentities(deviceIds, identityHashes);
  const customerIds = await CustomerService.syncDevices(devices, { enabled: true });
  return {
    enabled: true,
    total: deviceIds.length,
    existing: Math.min(existingRows.length, customerIds.size),
    generated: Math.max(customerIds.size - existingRows.length, 0),
    pending: Math.max(new Set(deviceIds).size - customerIds.size, 0)
  };
}

class CustomerIdSyncJob {
  /** Quanto a requisição espera antes de responder "continua em segundo plano". */
  static BUDGET_MS = 20_000;

  static isRunning(key) {
    return running.has(key);
  }

  /**
   * Roda (ou encontra rodando) a passada do provedor `key`.
   *
   * Devolve `{ running: true }` se ela já estava em curso ou não terminou no
   * prazo, ou o resumo se terminou. Uma falha dentro do prazo é relançada,
   * para o chamador dizer o motivo; depois do prazo, só vai para o log.
   */
  static async run(key) {
    if (running.has(key)) return { running: true };
    const job = syncOnce();
    running.set(key, job);
    // Dentro do prazo, quem loga e responde é o chamador; depois dele, não há
    // mais ninguém esperando e o log é o único lugar onde a falha aparece.
    let detached = false;
    job
      .catch((error) => { if (detached) console.error('Customer ID sync (background) error:', error); })
      .finally(() => { running.delete(key); });

    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), this.BUDGET_MS);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([job, deadline]);
      if (outcome !== TIMED_OUT) return outcome;
      detached = true;
      return { running: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Para os testes: espera toda passada em curso terminar. */
  static async idle() {
    await Promise.allSettled([...running.values()]);
  }
}

export default CustomerIdSyncJob;
