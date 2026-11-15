import crypto from 'node:crypto';
import { getDb, tdb, tinsertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';
import { normalizeRole, roleHas } from '../config/permissions.js';
import TenantUser from './TenantUser.js';
import PlatformAdmin from './PlatformAdmin.js';

/**
 * O convite para entrar na equipe de um provedor.
 *
 * Existe por causa do que a onda 12 recusou, com razão: o administrador de um
 * provedor não pode anexar alguém que já existe no deploy, porque aquele
 * request carrega uma SENHA e há uma senha por pessoa — "adicionar a maria"
 * digitado aqui trocaria o login de uma estranha que trabalha para outro ISP,
 * derrubaria as sessões dela em todo lugar, e entregaria a este administrador
 * credenciais válidas no painel do vizinho. O convite inverte a direção: quem
 * administra OFERECE o vínculo, e quem entra é a pessoa convidada, com a conta
 * que já tem ou com uma que ela mesma cria.
 *
 * Um convite é uma credencial: quem tem o link entra na equipe com o papel
 * escrito nele. Por isso a tabela guarda o `sha256` do token e nunca o token, o
 * valor é mostrado uma vez só na resposta da criação, e a comparação abaixo é
 * feita sobre o digest.
 */
class TenantInvite {
  /** Quanto tempo um convite vale, se ninguém disser outra coisa. */
  static DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * O digest que a tabela guarda.
   *
   * sha256 puro e não bcrypt, ao contrário de uma senha, e a diferença é o que
   * está sendo protegido: uma senha é curta, escolhida por gente e reaproveitada
   * em outros lugares, então o custo por tentativa é a defesa. Um token daqui
   * são 32 bytes de `randomBytes` — não há dicionário que o alcance, e o que o
   * hash protege é o vazamento do banco, não a força bruta. Bcrypt aqui só
   * tornaria cada abertura de link mais lenta sem tirar nada de ninguém.
   */
  static hash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  /** Um token novo. 32 bytes: o que vai no link e some daqui. */
  static mintToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Cria o convite e devolve `{ invite, token }` — o token uma vez só.
   *
   * A expiração é obrigatória na coluna e default aqui: convite que não expira
   * é credencial permanente esquecida num histórico de conversa.
   */
  static async create({ role, label = null, createdBy = null, ttlMs = TenantInvite.DEFAULT_TTL_MS }) {
    const token = TenantInvite.mintToken();
    const id = await tinsertReturningId('tenant_invites', {
      token_hash: TenantInvite.hash(token),
      role,
      label: label ? String(label).slice(0, 255) : null,
      created_by: createdBy,
      expires_at: new Date(Date.now() + ttlMs)
    });
    return { invite: await TenantInvite.findById(id), token };
  }

  static async findById(id) {
    return (await tdb('tenant_invites').where({ id }).first()) || null;
  }

  /**
   * O convite que um token nomeia, sem provedor em escopo.
   *
   * tenant-scope-exempt: é esta busca que descobre o provedor.
   *
   * Quem abre o link não tem sessão e ainda não disse quem é: apresentou um
   * token, e é o token que diz para qual provedor ele vale. Filtrar por provedor
   * aqui seria já saber a resposta. É a mesma exceção, pelo mesmo motivo, que
   * `WhatsAppAccount.getByName` declara para o webhook do Evolution — e é por
   * isso que `token_hash` é único no deploy inteiro e não por provedor.
   *
   * `runUnscoped` diz isso à sentinela de SQL, que lê o SQL e não o comentário.
   * Declarar aqui, e não ensinar a sentinela a tolerar um formato de query,
   * mantém a exceção com exatamente uma busca de largura: a próxima leitura sem
   * filtro desta tabela continua falhando.
   *
   * Devolve a linha crua, inclusive expirada, aceita ou revogada. Quem chama
   * decide — e decide respondendo a mesma coisa para os quatro casos, que é o
   * que impede o link de virar um oráculo de "este token existiu".
   */
  static async findByToken(token) {
    if (!token) return null;
    const digest = TenantInvite.hash(token);
    // tenant-scope-exempt: é esta busca que descobre o provedor (ver acima).
    return runUnscoped(
      'quem abre um convite não tem sessão; é o token que nomeia o provedor',
      async () => (await getDb()('tenant_invites').where({ token_hash: digest }).first()) || null
    );
  }

  /** Os convites em aberto deste provedor, do mais novo para o mais velho. */
  static async listOpen() {
    return tdb('tenant_invites')
      .whereNull('accepted_at')
      .whereNull('revoked_at')
      .orderBy('id', 'desc');
  }

  /**
   * Marca o convite como aceito, e só se ele ainda estiver aberto.
   *
   * A condição vai no WHERE e não num `if` antes do UPDATE, de propósito. O
   * caminho sequencial já para antes daqui — quem lê o convite pela segunda vez
   * o encontra aceito e `isOpen` recusa. O que só o WHERE alcança é a janela
   * entre ler e escrever: dois cliques no mesmo link chegam juntos, os dois
   * leem o convite aberto, e é o banco que diz a um deles que nenhuma linha
   * casou. `tenant-invites.test.js` reproduz isso, e só em PostgreSQL e MySQL:
   * em SQLite o driver é síncrono e serializa as duas requisições, de modo que
   * a janela não abre. A proteção vale para os três.
   *
   * Não passa por `tdb` porque quem aceita ainda não tem provedor em escopo —
   * mas o filtro do provedor está aqui mesmo assim, escrito à mão a partir do
   * `tenant_id` da linha que `findByToken` devolveu. Não é formalidade: uma
   * exceção declarada seria o segundo lugar deste arquivo lendo a tabela sem
   * filtro, e a única razão para isso era não ter o provedor à mão. Aqui se
   * tem. O `id` sozinho bastaria para acertar a linha; o par é o que faz o
   * UPDATE dizer a mesma coisa que a leitura disse.
   */
  static async markAccepted({ id, tenantId }, userId, trx = null) {
    const db = trx || getDb();
    // tenant-scope-exempt: o filtro do provedor está aqui, escrito à mão — o
    // que falta é o escopo de onde `tdb` o leria, porque quem aceita ainda não
    // tem provedor em sessão. Não é uma leitura sem filtro; é a mesma condição
    // por outro caminho.
    const changed = await db('tenant_invites')
      .where({ id, tenant_id: tenantId })
      .whereNull('accepted_at')
      .whereNull('revoked_at')
      .where('expires_at', '>', new Date())
      .update({ accepted_at: new Date(), accepted_user_id: userId, updated_at: new Date() });
    return changed > 0;
  }

  /** Revoga um convite ainda aberto. `false` quando não havia o que revogar. */
  static async revoke(id) {
    const changed = await tdb('tenant_invites')
      .where({ id })
      .whereNull('accepted_at')
      .whereNull('revoked_at')
      .update({ revoked_at: new Date(), updated_at: new Date() });
    return changed > 0;
  }

  /**
   * Se quem cunhou o convite AINDA poderia cunhá-lo, agora.
   *
   * O convite carrega a autoridade de quem o criou, e essa autoridade não é
   * congelada no dia da criação: um `admin` prestes a ser desligado cunharia um
   * convite de `admin` com trinta dias de validade, guardaria o link, e depois
   * de removido (ou rebaixado) entraria de volta com uma conta nova e o mesmo
   * papel. Por isso a regra é reaplicada no aceite, e é a mesma da criação em
   * `inviteController.create`: precisa administrar a equipe
   * (`operators.manage`) e, para um convite de `owner`, ser `owner`.
   *
   * Quem está no cadastro da plataforma passa: é o console
   * (`platformMemberController.invite`) que entrega o provedor ao primeiro
   * dono, e quem cunhou por lá não tem — nem precisa ter — vínculo com o
   * provedor. A conferência é fresca, então tirar a pessoa do cadastro também
   * mata os convites que ela cunhou pelo console.
   *
   * `created_by` nulo recusa: a coluna é `ON DELETE SET NULL`, então nulo é
   * "quem convidou não existe mais", e um convite sem ninguém por trás não tem
   * autoridade de quem herdar.
   */
  static async creatorCanGrant({ createdBy, tenantId, role }) {
    const userId = Number(createdBy);
    if (!Number.isInteger(userId) || userId <= 0) return false;
    if (await PlatformAdmin.has(userId)) return true;
    const membership = await TenantUser.find(tenantId, userId);
    if (!membership) return false;
    const creatorRole = normalizeRole(membership.role);
    if (!roleHas(creatorRole, 'operators.manage')) return false;
    if (normalizeRole(role) === 'owner' && creatorRole !== 'owner') return false;
    return true;
  }

  /** `creatorCanGrant` sobre a linha do convite. */
  static async creatorStillGrants(invite) {
    if (!invite) return false;
    return TenantInvite.creatorCanGrant({
      createdBy: invite.created_by,
      tenantId: invite.tenant_id,
      role: invite.role
    });
  }

  /**
   * Revoga os convites em aberto que `userId` cunhou neste provedor e que ele
   * não poderia mais cunhar — chamado quando o vínculo dele some ou o papel
   * cai. É a metade "arrumar a casa" da regra de cima: o aceite já recusaria
   * esses convites, mas deixá-los na lista como abertos mentiria para quem
   * administra a tela. Devolve quantos foram revogados.
   */
  static async revokeUngrantableBy(userId, tenantId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return 0;
    const abertos = await tdb('tenant_invites')
      .where({ created_by: id })
      .whereNull('accepted_at')
      .whereNull('revoked_at')
      .select('id', 'role');
    let revogados = 0;
    for (const invite of abertos) {
      if (await TenantInvite.creatorCanGrant({ createdBy: id, tenantId, role: invite.role })) continue;
      if (await TenantInvite.revoke(invite.id)) revogados += 1;
    }
    return revogados;
  }

  /** Se a linha ainda pode ser usada. */
  static isOpen(invite) {
    if (!invite) return false;
    if (invite.accepted_at || invite.revoked_at) return false;
    return new Date(invite.expires_at).getTime() > Date.now();
  }
}

export default TenantInvite;
