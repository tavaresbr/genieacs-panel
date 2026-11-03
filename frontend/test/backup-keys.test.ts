import { describe, expect, it } from 'vitest'
import {
  PUBLIC_KEY_PREFIX, generateBrowserKeyPair, privateKeyFile, privateKeyFileName, supportsBrowserKeygen
} from '@/lib/backup-keys'
import { PLATFORM_ALERT_EVENTS, type ExternalBackupSettings } from '@/lib/api'
import { ALERT_EVENT_LABELS } from '@/lib/platform-alerts'
import { backupPatch, formatBytes } from '@/components/platform/external-backup-card'
// O lado que decifra é o do servidor/CLI: a prova de que o par gerado aqui
// abre o que o backend cifra é usar o código dele. Por caminho calculado, como
// em `audit-actions.test.ts`, para o TypeScript não tipar um módulo do backend.
const backendUrl = new URL('../../backend/src/services/backup/backupCrypto.js', import.meta.url).href
interface BackendCrypto {
  encryptBuffer(buffer: Buffer, publicKey: string): Promise<Buffer>
  decryptBuffer(buffer: Buffer, privateKey: string): Promise<Buffer>
  parsePublicKey(text: string): { keyId: string }
  parsePrivateKey(text: string): { keyId: string }
}
const { decryptBuffer, encryptBuffer, parsePrivateKey, parsePublicKey } = (await import(/* @vite-ignore */ backendUrl)) as BackendCrypto

/**
 * Integrações → Backup externo: o par de chaves nasce no navegador e o
 * formato tem de ser exatamente o que `backend/scripts/backup-crypto.js` lê.
 */
describe('o par de chaves do navegador', () => {
  it('gera X25519 no formato do backend, e o backend cifra para ela e decifra com o arquivo baixado', async () => {
    expect(await supportsBrowserKeygen()).toBe(true)
    const par = await generateBrowserKeyPair()
    expect(par.publicKey.startsWith(PUBLIC_KEY_PREFIX)).toBe(true)
    expect(par.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/)
    expect(parsePublicKey(par.publicKey).keyId).toBe(par.keyId)

    const arquivo = privateKeyFile(par, new Date('2026-11-03T12:00:00Z'))
    expect(arquivo).toContain(`key id: ${par.keyId}`)
    expect(parsePrivateKey(arquivo).keyId).toBe(par.keyId)
    expect(privateKeyFileName(par.keyId)).toBe(`skygp-backup-private-key-${par.keyId}.pem`)

    const cifrado = await encryptBuffer(Buffer.from('backup do painel'), par.publicKey)
    expect((await decryptBuffer(cifrado, arquivo)).toString()).toBe('backup do painel')
  })
})

describe('o cartão', () => {
  const info: ExternalBackupSettings = {
    configured: true, platformBox: true, enabled: true, runner: 'panel', hour: 3, keepDaily: 7, keepWeekly: 4,
    includeMedia: true, endpoint: '', region: 'us-east-1', bucket: 'b', prefix: 'p/', forcePathStyle: false,
    accessKeyIdHint: '••••1234', secretAccessKeyConfigured: true, connectionReadable: true, publicKey: null, keyId: null,
    keyCreatedAt: null, keyOrigin: null, updatedAt: null, running: false,
    status: { lastRun: null, lastSuccess: null, lastVerification: null, hostFailure: null }
  }
  const form = {
    endpoint: '', region: 'us-east-1', bucket: 'b', prefix: 'p/', forcePathStyle: false, accessKeyId: '', secretAccessKey: '',
    enabled: true, runner: 'panel' as const, hour: 3, keepDaily: 7, keepWeekly: 4, includeMedia: true
  }

  it('manda só o que mudou; a access key e a secret só quando digitadas', () => {
    expect(backupPatch(info, form)).toEqual({})
    expect(backupPatch(info, { ...form, hour: 5, secretAccessKey: ' s3cr3t ' })).toEqual({ hour: 5, secretAccessKey: 's3cr3t' })
  })

  it('formata tamanhos', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(undefined)).toBe('-')
  })

  it('o alerta backup_failed tem rótulo', () => {
    expect(PLATFORM_ALERT_EVENTS).toContain('backup_failed')
    expect(ALERT_EVENT_LABELS.backup_failed).toBe('platform.alerts.event.backup_failed')
  })
})
