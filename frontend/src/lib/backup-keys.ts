/**
 * O par de chaves do backup externo, gerado NO NAVEGADOR.
 *
 * O ponto do backup cifrado é o servidor conseguir cifrar e nunca decifrar:
 * a chave privada não pode passar por ele. Então ela nasce aqui (WebCrypto
 * X25519), vira um arquivo que a pessoa baixa e guarda fora do servidor, e só
 * a pública sobe. O formato é o que `backend/scripts/backup-crypto.js` lê:
 * PKCS#8 em PEM para a privada, `skygp-backup-pub-1:<base64url dos 32 bytes>`
 * para a pública. O id da chave (8 bytes do sha256 da pública, em hex) é o
 * mesmo que o servidor calcula e grava no cabeçalho de cada arquivo.
 *
 * Navegador sem X25519 no WebCrypto (Chrome antes do 133, Safari antes do 17):
 * `supportsBrowserKeygen` diz que não, e a tela cai no `POST .../keypair`, que
 * gera no servidor e devolve a privada uma vez.
 */

export const PUBLIC_KEY_PREFIX = 'skygp-backup-pub-1:'

export interface BackupKeyPair {
  publicKey: string
  privateKeyPem: string
  keyId: string
}

function base64(bytes: Uint8Array): string {
  let binario = ''
  for (const b of bytes) binario += String.fromCharCode(b)
  return btoa(binario)
}

export function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** O PEM de um PKCS#8, em linhas de 64 como o OpenSSL escreve. */
export function pkcs8Pem(der: Uint8Array): string {
  const corpo = base64(der).match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN PRIVATE KEY-----\n${corpo}\n-----END PRIVATE KEY-----\n`
}

/** O id da chave: os 8 primeiros bytes do sha256 da pública bruta, em hex. */
export async function keyIdOf(rawPublic: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawPublic as BufferSource))
  return hex(digest.slice(0, 8))
}

/** Este navegador gera X25519? Testado gerando, que é a única resposta honesta. */
export async function supportsBrowserKeygen(): Promise<boolean> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return false
    await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    return true
  } catch {
    return false
  }
}

/** Gera o par. Lança quando o navegador não sabe X25519. */
export async function generateBrowserKeyPair(): Promise<BackupKeyPair> {
  const par = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair
  const bruta = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey))
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', par.privateKey))
  return {
    publicKey: `${PUBLIC_KEY_PREFIX}${base64Url(bruta)}`,
    privateKeyPem: pkcs8Pem(pkcs8),
    keyId: await keyIdOf(bruta)
  }
}

/**
 * O conteúdo do arquivo que a pessoa baixa: um cabeçalho que diz o que é e o
 * que fazer com ele, e o PEM. O `backup-crypto.js` acha o bloco PEM no meio do
 * texto.
 */
export function privateKeyFile(par: { privateKeyPem: string; keyId: string; publicKey: string }, when = new Date()): string {
  return [
    '# TR69 Controle — external backup PRIVATE key',
    `# key id: ${par.keyId}`,
    `# public key: ${par.publicKey}`,
    `# generated: ${when.toISOString()}`,
    '# Keep this file OFF the server (password manager, offline vault).',
    '# Without it, no backup can be decrypted. With it, every backup can.',
    '# Restore: skygenpanel-backup restore --from-s3 latest --private-key <this file>',
    par.privateKeyPem.trimEnd(),
    ''
  ].join('\n')
}

/** O nome do arquivo baixado. */
export function privateKeyFileName(keyId: string): string {
  return `skygp-backup-private-key-${keyId}.pem`
}
