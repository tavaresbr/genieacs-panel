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

/** Teto da foto, já decodificada: o navegador entrega ~20 KB (192×192), isto é folga. */
export const AVATAR_MAX_BYTES = 96 * 1024;

/** O tipo que os PRIMEIROS BYTES provam, ou null. SVG não entra de propósito. */
export function sniffAvatar(buffer) {
  const b = buffer;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * A foto como o navegador manda: `data:image/<tipo>;base64,<bytes>`.
 * O `Content-Type` e o tipo do prefixo são só declaração — vale o que os bytes
 * provam.
 * @returns {{ buffer: Buffer, mime: string } | { error: { key: string, code: string, status: number } }}
 */
export function parseAvatarDataUrl(value) {
  const bad = (code, status = 400) => ({ error: { key: `users.profile.${code}`, code, status } });
  if (typeof value !== 'string') return bad('avatarInvalid');
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return bad('avatarInvalid');
  // Barra o enorme ANTES de decodificar: três quartos do base64 são os bytes.
  if (Math.floor((match[1].length * 3) / 4) > AVATAR_MAX_BYTES) return bad('avatarTooLarge', 413);
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length === 0) return bad('avatarInvalid');
  if (buffer.length > AVATAR_MAX_BYTES) return bad('avatarTooLarge', 413);
  const mime = sniffAvatar(buffer);
  if (!mime) return bad('avatarInvalid');
  return { buffer, mime };
}
