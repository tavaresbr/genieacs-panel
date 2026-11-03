import PlatformAudit from '../models/PlatformAudit.js';
import ExternalBackupService from '../services/backup/externalBackupService.js';
import { BackupSettingsError, effectiveConfig, readPublic, save } from '../services/backup/externalBackupSettings.js';
import { BackupError } from '../services/backup/localBackup.js';
import { generateKeyPair } from '../services/backup/backupCrypto.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * Integrações → Backup externo, no console da plataforma.
 *
 * As regras são as do cartão da Asaas (`platformIntegrationsController`):
 *
 * 1. **Nenhum segredo sai.** A secret do S3 nunca volta; a access key volta
 *    mascarada (os quatro últimos caracteres). A chave pública volta inteira —
 *    é pública.
 * 2. **A chave privada não mora aqui.** O par nasce no navegador (WebCrypto
 *    X25519) e só a pública sobe. Sem WebCrypto, `POST .../keypair` gera o par
 *    no servidor e devolve a privada UMA vez, nesta resposta, sem gravá-la nem
 *    registrá-la em lugar nenhum — a trilha diz que o par foi gerado no
 *    servidor, para quem audita saber que ela passou por aqui.
 * 3. **Toda mudança na trilha da plataforma, sem valor nenhum.**
 */

function erro(res, error) {
  if (error instanceof BackupSettingsError) {
    return res.status(error.status || 400).json(createErrorResponse(error.message, null, error.code));
  }
  if (error instanceof BackupError) {
    const status = error.code === 'busy' ? 409 : 400;
    return res.status(status).json(createErrorResponse(error.message, null, error.code));
  }
  return null;
}

async function present() {
  return { ...(await readPublic()), running: Boolean(ExternalBackupService.current) };
}

const CONEXAO = ['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'accessKeyId', 'secretAccessKey'];
const AJUSTES = ['enabled', 'runner', 'hour', 'keepDaily', 'keepWeekly', 'includeMedia'];

class PlatformBackupController {
  /** `GET /api/platform/integrations/backup` */
  static async get(req, res) {
    try {
      return res.json(createResponse('External backup retrieved', await present()));
    } catch (error) {
      console.error('Get external backup error:', error.message);
      return res.status(500).json(createErrorResponse('Failed to read the external backup settings'));
    }
  }

  /**
   * `PUT /api/platform/integrations/backup` — `{ endpoint?, region?, bucket?,
   * prefix?, forcePathStyle?, accessKeyId?, secretAccessKey?, enabled?,
   * runner?, hour?, keepDaily?, keepWeekly?, includeMedia? }`. Ausente
   * mantém; a secret vazia apaga.
   */
  static async update(req, res) {
    try {
      const corpo = req.body ?? {};
      const patch = Object.fromEntries([...CONEXAO, ...AJUSTES].map((c) => [c, corpo[c]]).filter(([, v]) => v !== undefined));
      const { changed } = await save(patch);
      const atual = await present();
      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_INTEGRATION_CHANGED,
        detail: {
          integration: 'external_backup',
          // O QUE mudou, nunca o valor. Os ajustes não são segredo e vão.
          changed: Object.keys(changed).sort(),
          enabled: atual.enabled,
          runner: atual.runner,
          hour: atual.hour,
          keepDaily: atual.keepDaily,
          keepWeekly: atual.keepWeekly
        }
      });
      if (!registrada) console.warn('External backup settings changed without a platform trail line');
      return res.json(createResponse('External backup updated', atual));
    } catch (error) {
      if (erro(res, error)) return undefined;
      console.error('Update external backup error:', error.message);
      return res.status(500).json(createErrorResponse('Failed to update the external backup settings'));
    }
  }

  /** `POST /api/platform/integrations/backup/public-key` — `{ publicKey, origin?: 'browser'|'imported' }` */
  static async setPublicKey(req, res) {
    try {
      const { publicKey, origin } = req.body ?? {};
      if (typeof publicKey !== 'string' || !publicKey.trim()) {
        return res.status(400).json(createErrorResponse('publicKey is required', null, 'invalid_public_key'));
      }
      const anterior = (await effectiveConfig()).keyId;
      await save({ publicKey, keyOrigin: origin === 'browser' ? 'browser' : 'imported' });
      const atual = await present();
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_BACKUP_KEY_CHANGED,
        detail: { keyId: atual.keyId, previousKeyId: anterior, origin: atual.keyOrigin }
      });
      return res.json(createResponse('Backup public key saved', atual));
    } catch (error) {
      if (erro(res, error)) return undefined;
      console.error('Set backup public key error:', error.message);
      return res.status(500).json(createErrorResponse('Failed to save the backup public key'));
    }
  }

  /**
   * `POST /api/platform/integrations/backup/keypair` — o caminho sem WebCrypto.
   * Devolve `{ privateKeyPem, publicKey, keyId }`; a privada só existe nesta
   * resposta.
   */
  static async generateKeyPair(req, res) {
    try {
      const anterior = (await effectiveConfig()).keyId;
      const par = generateKeyPair();
      await save({ publicKey: par.publicKey, keyOrigin: 'server' });
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_BACKUP_KEY_CHANGED,
        detail: { keyId: par.keyId, previousKeyId: anterior, origin: 'server' }
      });
      res.set('Cache-Control', 'no-store');
      return res.json(createResponse('Backup key pair generated', {
        privateKeyPem: par.privateKeyPem, publicKey: par.publicKey, keyId: par.keyId, settings: await present()
      }));
    } catch (error) {
      if (erro(res, error)) return undefined;
      console.error('Generate backup key pair error:', error.message);
      return res.status(500).json(createErrorResponse('Failed to generate the backup key pair'));
    }
  }

  /**
   * `POST /api/platform/integrations/backup/test` — `HeadBucket`, um objeto
   * pequeno posto e apagado. A recusa do S3 é 200 com `ok: false`: a rota
   * funcionou, a resposta é "não".
   */
  static async test(req, res) {
    try {
      const r = await ExternalBackupService.testConnection();
      return res.json(createResponse(r.ok ? 'S3 answered' : (r.error || 'S3 refused'), r, r.ok ? undefined : r.code));
    } catch (error) {
      if (erro(res, error)) return undefined;
      console.error('Test external backup error:', error.message);
      return res.status(500).json(createErrorResponse('Failed to test the S3 connection'));
    }
  }

  /** `POST /api/platform/integrations/backup/run` — 202; 409 `busy`; 400 `not_configured`. */
  static async run(req, res) {
    try {
      await ExternalBackupService.runNow();
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_BACKUP_REQUESTED, detail: { kind: 'backup' }
      });
      return res.status(202).json(createResponse('Backup started', { started: true }));
    } catch (error) {
      if (erro(res, error)) return undefined;
      console.error('Run external backup error:', error.message);
      return res.status(500).json(createErrorResponse('Failed to start the backup'));
    }
  }

  /** `POST /api/platform/integrations/backup/verify` — 202; 409 `busy`; 400 `not_configured`. */
  static async verify(req, res) {
    try {
      await ExternalBackupService.verifyNow();
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_BACKUP_REQUESTED, detail: { kind: 'verify' }
      });
      return res.status(202).json(createResponse('Verification started', { started: true }));
    } catch (error) {
      if (erro(res, error)) return undefined;
      console.error('Verify external backup error:', error.message);
      return res.status(500).json(createErrorResponse('Failed to start the verification'));
    }
  }
}

export default PlatformBackupController;
