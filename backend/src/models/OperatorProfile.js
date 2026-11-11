import crypto from 'node:crypto';
import { tdb, tinsert } from '../config/database.js';
import { DEVELOPMENT_FALLBACK, developmentFallbackAllowed } from '../config/runtimeEnv.js';
import { createSecretBox } from '../utils/secretBox.js';
import { maskCpf } from '../utils/operatorProfileValidation.js';

/**
 * O cadastro de cada pessoa da equipe NESTE provedor (`operator_profiles`, 0134).
 *
 * Escopado por provedor (`tdb`/`tinsert` aplicam o `tenant_id`): a pessoa é
 * compartilhada entre provedores, o que cada um sabe dela não é.
 *
 * O CPF nunca fica legível em repouso. O envelope do secretBox (`cpf_*`) só é
 * aberto por `get`, que serve a tela de edição; a lista usa `cpf_last4`. O
 * `cpf_hash` é um HMAC, não um sha256 puro — o CPF tem só ~10^9 valores e um
 * hash simples se inverte por força bruta — e serve APENAS para avisar de CPF
 * repetido na equipe. Girar a chave muda o hash: a checagem volta a funcionar
 * em cada perfil na próxima vez que ele for salvo.
 */

const CPF_CONTEXT = 'skygenpanel-operator-cpf-v1';
const HASH_CONTEXT = 'skygenpanel-operator-cpf-hash-v1';

let box = null;
const cpfBox = () => {
  box ??= createSecretBox(CPF_CONTEXT);
  return box;
};

function hashKey() {
  const base = process.env.SECRET_BOX_KEY || process.env.JWT_SECRET;
  if (!base && !developmentFallbackAllowed()) {
    throw new Error('SECRET_BOX_KEY (or JWT_SECRET) must be set to protect operator documents');
  }
  return crypto.createHmac('sha256', base || DEVELOPMENT_FALLBACK).update(HASH_CONTEXT).digest();
}

export function cpfHash(digits) {
  return crypto.createHmac('sha256', hashKey()).update(String(digits)).digest('hex');
}

/** As colunas devolvidas sem o envelope do CPF. */
const PUBLIC_COLUMNS = [
  'id', 'user_id', 'full_name', 'birth_date', 'rg', 'cpf_last4', 'phone', 'whatsapp',
  'personal_email', 'zip', 'street', 'number', 'complement', 'district', 'city', 'state',
  'job_title', 'admitted_at', 'emergency_name', 'emergency_phone', 'notes',
  'created_at', 'updated_at'
];

/** Quanto do cadastro conta como "completo" na lista. */
const REQUIRED_FOR_COMPLETE = ['full_name', 'cpf_last4', 'phone', 'zip', 'street', 'city', 'state'];

export function isComplete(row) {
  return Boolean(row) && REQUIRED_FOR_COMPLETE.every((column) => row[column]);
}

/** O que a lista mostra: sem CPF decifrado, sem observações. */
export function summary(row) {
  if (!row) return { fullName: null, jobTitle: null, phone: null, cpfMasked: null, profileComplete: false };
  return {
    fullName: row.full_name ?? null,
    jobTitle: row.job_title ?? null,
    phone: row.phone ?? null,
    cpfMasked: maskCpf(row.cpf_last4),
    profileComplete: isComplete(row)
  };
}

function present(row, cpf) {
  return {
    userId: row.user_id,
    fullName: row.full_name ?? null,
    birthDate: row.birth_date ?? null,
    rg: row.rg ?? null,
    cpf: cpf ?? null,
    cpfMasked: maskCpf(row.cpf_last4),
    phone: row.phone ?? null,
    whatsapp: row.whatsapp ?? null,
    personalEmail: row.personal_email ?? null,
    zip: row.zip ?? null,
    street: row.street ?? null,
    number: row.number ?? null,
    complement: row.complement ?? null,
    district: row.district ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    jobTitle: row.job_title ?? null,
    admittedAt: row.admitted_at ?? null,
    emergencyName: row.emergency_name ?? null,
    emergencyPhone: row.emergency_phone ?? null,
    notes: row.notes ?? null,
    profileComplete: isComplete(row),
    updatedAt: row.updated_at ?? null
  };
}

class OperatorProfile {
  /** As linhas (sem o envelope do CPF) de toda a equipe, por `user_id`, para a lista. */
  static async summaries() {
    const rows = await tdb('operator_profiles').select(PUBLIC_COLUMNS);
    return new Map(rows.map((row) => [Number(row.user_id), row]));
  }

  /** O cadastro completo, com o CPF decifrado — só para a tela de edição. */
  static async get(userId) {
    const row = await tdb('operator_profiles').where({ user_id: userId }).first();
    if (!row) return null;
    const cpf = row.cpf_ciphertext
      ? cpfBox().decrypt({
        password_ciphertext: row.cpf_ciphertext,
        password_iv: row.cpf_iv,
        password_tag: row.cpf_tag,
        password_key_version: row.cpf_key_version
      })
      : null;
    return present(row, cpf);
  }

  /** Outra pessoa da equipe com este CPF? Devolve o `user_id` dela, ou null. */
  static async findCpfConflict(digits, exceptUserId) {
    const row = await tdb('operator_profiles')
      .where({ cpf_hash: cpfHash(digits) })
      .whereNot({ user_id: exceptUserId })
      .first('user_id');
    return row ? Number(row.user_id) : null;
  }

  /**
   * Grava só o que veio. `cpf` é `undefined` (não mexe), `null` (apaga) ou os
   * onze dígitos (cifra, e guarda o hash e os quatro últimos).
   * @returns {Promise<string[]>} os nomes das colunas que mudaram — para a
   *   auditoria, que registra campos e nunca valores.
   */
  static async upsert(userId, values, cpf) {
    const patch = { ...values };
    if (cpf === null) {
      Object.assign(patch, {
        cpf_ciphertext: null, cpf_iv: null, cpf_tag: null, cpf_key_version: null,
        cpf_hash: null, cpf_last4: null
      });
    } else if (cpf !== undefined) {
      const sealed = cpfBox().encrypt(cpf);
      Object.assign(patch, {
        cpf_ciphertext: sealed.password_ciphertext,
        cpf_iv: sealed.password_iv,
        cpf_tag: sealed.password_tag,
        cpf_key_version: sealed.password_key_version,
        cpf_hash: cpfHash(cpf),
        cpf_last4: cpf.slice(-4)
      });
    }

    const existing = await tdb('operator_profiles').where({ user_id: userId }).first();
    const now = new Date();
    if (!existing) {
      await tinsert('operator_profiles', { user_id: userId, ...patch, created_at: now, updated_at: now });
      return Object.keys(values).concat(cpf === undefined ? [] : ['cpf']);
    }

    const changed = Object.keys(values).filter((column) => (existing[column] ?? null) !== (values[column] ?? null));
    if (cpf !== undefined && (cpf === null ? existing.cpf_hash : existing.cpf_hash !== cpfHash(cpf))) changed.push('cpf');
    if (changed.length) {
      await tdb('operator_profiles').where({ user_id: userId }).update({ ...patch, updated_at: now });
    }
    return changed;
  }

  /** O vínculo acabou: o cadastro deste provedor sai junto. */
  static async remove(userId) {
    return tdb('operator_profiles').where({ user_id: userId }).del();
  }
}

export default OperatorProfile;
