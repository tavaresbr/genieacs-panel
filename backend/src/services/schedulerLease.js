import crypto from 'node:crypto';
import os from 'node:os';
import { getDb, isUniqueViolation } from '../config/database.js';

/**
 * A vez de um passo do agendador que está ACIMA dos provedores (as
 * verificações da página de status, a passada dos lotes de afiliados), quando
 * o painel roda em mais de uma instância.
 *
 * Cada instância tem o próprio relógio em memória (`lastRunAt`), e duas delas
 * fariam as verificações duas vezes por minuto — e consultariam o gateway
 * pelos mesmos Pix duas vezes. A vez é uma linha em `app_state` da caixa da
 * plataforma (`lease:<nome>`), com quem a tem e até quando: tomá-la é
 * inserir a linha ou trocá-la por atualização condicional sobre o valor
 * lido (compare-and-swap), e só quando a anterior já venceu. Quem perde
 * pula a passada; a vez vence sozinha, então uma instância que caiu não
 * prende o passo de ninguém.
 *
 * Sem a caixa da plataforma (a instalação própria, um teste sem ela) não há
 * com quem disputar: responde sim.
 */

/** Quem é esta instância — fixo enquanto o processo vive. */
export const LEASE_HOLDER = `${os.hostname().slice(0, 40)}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

const PREFIXO = 'lease:';

function lerValor(bruto) {
  try {
    const valor = JSON.parse(String(bruto ?? ''));
    return valor && typeof valor === 'object' ? valor : null;
  } catch {
    return null;
  }
}

async function caixaDaPlataforma(db) {
  // tenant-scope-exempt: a vez é da plataforma, lida fora de qualquer provedor.
  const linha = await db('tenants').where({ kind: 'platform' }).orderBy('id', 'asc').first('id');
  return linha ? Number(linha.id) : null;
}

/**
 * Tenta tomar a vez `name` por `ttlMs`. Devolve `true` quando esta instância
 * a tem agora (e deve rodar o passo), `false` quando outra a tem.
 */
export async function acquireLease(name, { ttlMs, now = new Date(), holder = LEASE_HOLDER } = {}) {
  const db = getDb();
  const tenantId = await caixaDaPlataforma(db);
  if (!tenantId) return true;
  const key = `${PREFIXO}${String(name).slice(0, 100)}`;
  const novo = JSON.stringify({ holder, until: now.getTime() + Math.max(1000, Number(ttlMs) || 0) });
  // tenant-scope-exempt: a linha é da caixa da plataforma, escrita por id.
  const tabela = () => db('app_state');
  const atual = await tabela().where({ tenant_id: tenantId, key }).first();
  if (!atual) {
    try {
      await tabela().insert({ tenant_id: tenantId, key, value: novo, updated_at: now });
      return true;
    } catch (error) {
      // Outra instância inseriu no mesmo instante: a vez é dela. (No SQLite
      // a chave de `app_state` é a primária, e a colisão tem outro código.)
      if (isUniqueViolation(error) || String(error?.code ?? '') === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
      throw error;
    }
  }
  const lido = lerValor(atual.value);
  if (lido && Number(lido.until) > now.getTime()) return false;
  const trocou = await tabela().where({ tenant_id: tenantId, key, value: atual.value })
    .update({ value: novo, updated_at: now });
  return Number(trocou) === 1;
}

/** Devolve a vez antes de vencer (o passo terminou e quer que outro possa rodar). */
export async function releaseLease(name, { holder = LEASE_HOLDER } = {}) {
  const db = getDb();
  const tenantId = await caixaDaPlataforma(db);
  if (!tenantId) return false;
  const key = `${PREFIXO}${String(name).slice(0, 100)}`;
  // tenant-scope-exempt: a linha é da caixa da plataforma, escrita por id.
  const atual = await db('app_state').where({ tenant_id: tenantId, key }).first();
  const lido = lerValor(atual?.value);
  if (!lido || lido.holder !== holder) return false;
  const apagou = await db('app_state').where({ tenant_id: tenantId, key, value: atual.value }).del();
  return Number(apagou) === 1;
}

/**
 * Estende a vez `name` por mais `ttlMs` a partir de agora, só se ESTA
 * instância ainda a tem — o "batimento" de um passo que pode durar mais que a
 * própria vez (o envio de um backup grande). Atualização condicional sobre o
 * valor lido: se outra instância a tomou no meio, não a rouba de volta e
 * devolve `false`. Sem a caixa da plataforma, não há disputa: `true`.
 */
export async function renewLease(name, { ttlMs, now = new Date(), holder = LEASE_HOLDER } = {}) {
  const db = getDb();
  const tenantId = await caixaDaPlataforma(db);
  if (!tenantId) return true;
  const key = `${PREFIXO}${String(name).slice(0, 100)}`;
  // tenant-scope-exempt: a linha é da caixa da plataforma, escrita por id.
  const atual = await db('app_state').where({ tenant_id: tenantId, key }).first();
  const lido = lerValor(atual?.value);
  if (!lido || lido.holder !== holder) return false;
  const novo = JSON.stringify({ holder, until: now.getTime() + Math.max(1000, Number(ttlMs) || 0) });
  // tenant-scope-exempt: a linha é da caixa da plataforma, escrita por id.
  const trocou = await db('app_state').where({ tenant_id: tenantId, key, value: atual.value })
    .update({ value: novo, updated_at: now });
  return Number(trocou) === 1;
}
