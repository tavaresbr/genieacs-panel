/**
 * Validação e normalização do cadastro da equipe (`operator_profiles`).
 *
 * Tudo é opcional: um campo ausente não muda nada, `null` ou texto vazio
 * apaga. `validateProfileInput` devolve só o que veio no corpo, já normalizado,
 * ou o primeiro problema — `{ error: { key, code } }` com a chave de i18n.
 */

const UFS = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
]);

/** Campo de texto livre → { coluna: tamanho máximo }. */
const TEXT_FIELDS = Object.freeze({
  fullName: ['full_name', 160],
  rg: ['rg', 32],
  street: ['street', 160],
  number: ['number', 20],
  complement: ['complement', 80],
  district: ['district', 100],
  city: ['city', 100],
  jobTitle: ['job_title', 100],
  emergencyName: ['emergency_name', 120],
  notes: ['notes', 2000]
});

const PHONE_FIELDS = Object.freeze({
  phone: 'phone',
  whatsapp: 'whatsapp',
  emergencyPhone: 'emergency_phone'
});

const DATE_FIELDS = Object.freeze({
  birthDate: 'birth_date',
  admittedAt: 'admitted_at'
});

export const PROFILE_FIELDS = Object.freeze([
  ...Object.keys(TEXT_FIELDS), ...Object.keys(PHONE_FIELDS), ...Object.keys(DATE_FIELDS),
  'cpf', 'personalEmail', 'zip', 'state'
]);

export function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** CPF com os dois dígitos verificadores; recusa as sequências repetidas (111.111.111-11). */
export function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const tamanho of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i += 1) soma += Number(cpf[i]) * (tamanho + 1 - i);
    const digito = ((soma * 10) % 11) % 10;
    if (digito !== Number(cpf[tamanho])) return false;
  }
  return true;
}

function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const blank = (value) => value === null || value === undefined || String(value).trim() === '';

/**
 * @returns {{ values: object, cpf?: string|null, error?: { key: string, code: string } }}
 *   `values` com as colunas; `cpf` só os dígitos (ou null para apagar) quando veio.
 */
export function validateProfileInput(body) {
  const values = {};
  const out = { values };
  const fail = (code) => ({ values: {}, error: { key: `users.profile.${code}`, code } });

  for (const [field, [column, max]] of Object.entries(TEXT_FIELDS)) {
    if (body[field] === undefined) continue;
    if (blank(body[field])) { values[column] = null; continue; }
    const text = String(body[field]).trim();
    if (text.length > max) return fail('tooLong');
    values[column] = text;
  }

  for (const [field, column] of Object.entries(PHONE_FIELDS)) {
    if (body[field] === undefined) continue;
    if (blank(body[field])) { values[column] = null; continue; }
    const digits = onlyDigits(body[field]);
    // Com DDD (10 ou 11 dígitos), ou com o 55 na frente (12 ou 13).
    if (digits.length < 10 || digits.length > 13) return fail('phoneInvalid');
    values[column] = digits;
  }

  for (const [field, column] of Object.entries(DATE_FIELDS)) {
    if (body[field] === undefined) continue;
    if (blank(body[field])) { values[column] = null; continue; }
    const text = String(body[field]).trim();
    const futureBirth = field === 'birthDate' && text > new Date().toISOString().slice(0, 10);
    if (!isRealDate(text) || futureBirth) return fail('dateInvalid');
    values[column] = text;
  }

  if (body.personalEmail !== undefined) {
    if (blank(body.personalEmail)) values.personal_email = null;
    else {
      const email = String(body.personalEmail).trim().toLowerCase();
      if (email.length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('emailInvalid');
      values.personal_email = email;
    }
  }

  if (body.zip !== undefined) {
    if (blank(body.zip)) values.zip = null;
    else {
      const zip = onlyDigits(body.zip);
      if (zip.length !== 8) return fail('zipInvalid');
      values.zip = zip;
    }
  }

  if (body.state !== undefined) {
    if (blank(body.state)) values.state = null;
    else {
      const uf = String(body.state).trim().toUpperCase();
      if (!UFS.has(uf)) return fail('stateInvalid');
      values.state = uf;
    }
  }

  if (body.cpf !== undefined) {
    if (blank(body.cpf)) out.cpf = null;
    else {
      if (!isValidCpf(body.cpf)) return fail('cpfInvalid');
      out.cpf = onlyDigits(body.cpf);
    }
  }

  return out;
}

/** "***.***.*78-90": o suficiente para reconhecer, sem expor o número. */
export function maskCpf(last4) {
  if (!last4 || !/^\d{4}$/.test(last4)) return null;
  return `***.***.*${last4.slice(0, 2)}-${last4.slice(2)}`;
}
