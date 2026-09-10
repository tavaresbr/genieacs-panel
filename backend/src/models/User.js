import { getDb, insertReturningId, tinsert } from '../config/database.js';
import { currentTenantId } from '../config/tenantContext.js';
import { IS_SAAS } from '../config/edition.js';

class User {
  /**
   * O endereço como a tabela o guarda: sem espaço nas pontas e em minúsculas.
   *
   * Normalizado na aplicação e não deixado para a colação do banco, de
   * propósito. SQLite compara `VARCHAR` com sensibilidade a caixa, MySQL com a
   * colação `_ci` não, e Postgres depende do que foi configurado — de modo que
   * `Joao@ISP.com` e `joao@isp.com` seriam a mesma conta num banco e duas
   * noutro. Duas contas para o mesmo endereço é o começo de uma tomada de
   * conta, e "depende do banco" não é resposta para isso.
   *
   * O local-part de um e-mail é, pela RFC, sensível a caixa — mas nenhum
   * provedor de verdade trata assim, e quem digita o próprio endereço com uma
   * maiúscula a mais espera entrar. A escolha é deliberada e vale para os três
   * bancos igualmente.
   */
  static normalizeEmail(email) {
    const texto = String(email ?? '').trim().toLowerCase();
    return texto || null;
  }

  static async findByUsername(username) {
    return (await getDb()('users').where({ username }).first()) || null;
  }

  static async findByEmail(email) {
    const normalizado = User.normalizeEmail(email);
    if (!normalizado) return null;
    return (await getDb()('users').where({ email: normalizado }).first()) || null;
  }

  /**
   * A conta que um identificador de login nomeia — nome OU e-mail.
   *
   * Uma consulta só, com `orWhere`, e não "tenta por nome, senão por e-mail":
   * o `username` não proíbe `@`, então não dá para decidir pelo formato qual
   * dos dois foi digitado. Tentar em sequência daria duas idas ao banco e,
   * pior, uma janela em que o mesmo texto acha contas diferentes conforme a
   * ordem.
   *
   * **Nome e e-mail vivem no MESMO espaço de nomes**, e é o que torna esta
   * consulta inequívoca: `assertLoginAvailable` recusa um e-mail igual ao nome
   * de alguém e um nome igual ao e-mail de alguém. Sem essa regra, um
   * identificador poderia casar duas linhas — e escolher uma das duas seria
   * escolher em qual conta a senha vai ser conferida.
   *
   * A defesa em profundidade está no `limit(2)`: se duas linhas casarem apesar
   * da regra (uma escrita direta no banco, uma linha anterior a esta versão),
   * a resposta é null e ninguém entra. Falhar fechado é a única direção segura
   * quando a pergunta "de quem é esta senha?" fica ambígua.
   */
  static async findByLogin(identifier) {
    const texto = String(identifier ?? '').trim();
    if (!texto) return null;
    const email = User.normalizeEmail(texto);
    const linhas = await getDb()('users')
      .where({ username: texto })
      .orWhere({ email })
      .limit(2);
    if (linhas.length !== 1) return null;
    return linhas[0];
  }

  /**
   * Confere que um nome e um e-mail estão livres, contando os dois como um
   * espaço de nomes só.
   *
   * @returns {Promise<null|'username_taken'|'email_taken'>}
   */
  static async loginConflict({ username = null, email = null, exceptId = null }) {
    const nome = username === null ? null : String(username).trim();
    const endereco = User.normalizeEmail(email);
    if (!nome && !endereco) return null;

    let query = getDb()('users').select('id', 'username', 'email');
    // `exceptId` coagido com `Number`: parâmetro de rota chega como string, e
    // comparar `'7' !== 7` faria toda edição que mantém o próprio valor ser
    // recusada como duplicata de si mesma. Já custou um defeito antes.
    const ignorar = exceptId === null || exceptId === undefined ? null : Number(exceptId);
    if (ignorar !== null && Number.isFinite(ignorar)) query = query.whereNot({ id: ignorar });

    const candidatos = [nome, endereco].filter(Boolean);
    const linhas = await query.where((q) => {
      q.whereIn('username', candidatos).orWhereIn('email', candidatos);
    });
    if (!linhas.length) return null;

    // Qual dos dois colidiu decide a mensagem, e a ordem importa: quem está
    // cadastrando um e-mail precisa ouvir que o e-mail está tomado, mesmo que
    // ele tenha batido no `username` de outra pessoa. "Nome de usuário em uso"
    // para quem digitou um endereço é uma pista que não ajuda ninguém.
    if (endereco && linhas.some((l) => l.email === endereco || l.username === endereco)) {
      return 'email_taken';
    }
    return 'username_taken';
  }

  static async findById(id) {
    return (
      (await getDb()('users')
        .select('id', 'username', 'email', 'role', 'password', 'token_version', 'created_at', 'updated_at')
        .where({ id })
        .first()) || null
    );
  }

  /** Quantas contas ainda não têm e-mail — o número que decide o passo 3. */
  static async countWithoutEmail() {
    const row = await getDb()('users')
      .where((q) => q.whereNull('email').orWhere('email', ''))
      .count({ n: '*' })
      .first();
    return Number(row?.n || 0);
  }

  static async count() {
    const row = await getDb()('users').count({ n: '*' }).first();
    return Number(row?.n || 0);
  }

  /**
   * The person only. Their membership is the caller's to write.
   *
   * A person with no membership cannot sign in, so this is half of an act
   * rather than a whole one — but the other half belongs to `/api/users`, which
   * creates the membership straight after and deletes the person again if that
   * fails. Doing it here as well would insert the same row twice.
   */
  /**
   * `trx` opcional porque o aceite de convite cria a pessoa, consome o convite
   * e grava o vínculo como um ato só: se o convite já tiver sido usado entre um
   * passo e outro, a pessoa criada não pode sobrar no deploy com o nome tomado
   * e nenhum provedor a que pertencer.
   */
  static async create(userData, trx = null) {
    const { username, password, role = 'viewer', email = null } = userData;
    const id = await insertReturningId('users', {
      username, password, role, email: User.normalizeEmail(email)
    }, trx);
    return id;
  }

  /** Grava o endereço de login de alguém. Sempre normalizado. */
  static async updateEmail(id, email) {
    const changed = await getDb()('users')
      .where({ id })
      .update({ email: User.normalizeEmail(email), updated_at: new Date() });
    return changed > 0;
  }

  static async list() {
    return getDb()('users')
      .select('id', 'username', 'email', 'role', 'created_at', 'updated_at')
      .orderBy('id', 'asc');
  }

  static async countByRole(role) {
    const row = await getDb()('users').where({ role }).count({ n: '*' }).first();
    return Number(row?.n || 0);
  }

  /**
   * The person's deployment-wide role, and a revocation so a change bites now.
   *
   * Not the role anything authorises with any more — that is the membership's,
   * and `/api/users` writes it through `TenantUser.setRole` before calling
   * here. This column is what the migration's backfill reads and what an
   * install rolled back to the previous code still authorises from, so it is
   * kept in step where keeping it in step is meaningful; the caller decides
   * when that is, because with two memberships one column cannot hold both.
   */
  static async updateRole(id, role) {
    await getDb()('users')
      .where({ id })
      .update({
        role,
        token_version: getDb().raw('token_version + 1'),
        updated_at: new Date()
      });
  }

  static async remove(id) {
    return getDb()('users').where({ id }).del();
  }

  /**
   * The first administrator of a provider, and their membership at it.
   *
   * Returns the membership as well as the id because the caller has to mint a
   * token for it, and because the two are one fact: an admin row without a
   * membership is a fresh install nobody can sign in to — right password,
   * refused login, no explanation on screen. It is the case that breaks first
   * if the two ever come apart, so they are written in the same transaction as
   * the setup latch: either this provider has a first admin who can sign in, or
   * it still needs setup.
   *
   * The provider is the request's, the same one `tinsert` files the latch
   * under. Setup is per provider since 0014, which is the semantics we want.
   */
  static async createInitialAdmin(userData) {
    const { username, password, email = null } = userData;
    const db = getDb();
    const tenantId = currentTenantId();

    return db.transaction(async (trx) => {
      const existing = await trx('users').count({ n: '*' }).first();
      if (Number(existing?.n || 0) > 0) {
        const error = new Error('Setup already completed');
        error.code = 'SETUP_COMPLETED';
        throw error;
      }

      try {
        // The collision IS the lock: two setups racing, only one row lands.
        // Per provider since 0014, which is the semantics we want — each
        // provider does its own first admin.
        await tinsert('app_state', { key: 'setup_completed', value: '1' }, trx);
      } catch (error) {
        if (
          error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
          error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          error.code === 'ER_DUP_ENTRY' ||
          // Postgres names neither code above. Without this the race answered a
          // raw 500 instead of "setup already completed" on the one dialect
          // added last — the same message fallback the rest of the codebase
          // uses for exactly this reason.
          /duplicate key|unique/i.test(error.message)
        ) {
          const setupError = new Error('Setup already completed');
          setupError.code = 'SETUP_COMPLETED';
          throw setupError;
        }
        throw error;
      }

      const id = await insertReturningId('users', {
        username,
        password,
        email: User.normalizeEmail(email),
        role: 'admin'
      }, trx);

      await trx('tenant_users').insert({ tenant_id: tenantId, user_id: id, role: 'admin' });

      // On the hosted edition the first administrator also gets the control
      // plane, because otherwise a SaaS deployment comes up with nobody able to
      // create the SECOND provider — the whole install would be one ISP with a
      // control plane no key opens. It is written in this transaction with the
      // other two rows for the reason they are: a first admin without it is the
      // failure nobody notices until the day they need a second provider.
      //
      // Never on self-hosted. There is one provider there and no control plane,
      // so the grant would be a role that should not exist on that install, and
      // an upgrade path that quietly promoted the local administrator to it is
      // exactly what the migration refuses to do. The edition is read from the
      // environment at import, so this is decided by how the install is
      // configured and not by anything the request can say.
      if (IS_SAAS) {
        await trx('platform_admins').insert({ user_id: id });
      }

      return { id, tenantId, role: 'admin' };
    });
  }

  static async updatePassword(id, hashedPassword) {
    await getDb()('users')
      .where({ id })
      .update({
        password: hashedPassword,
        token_version: getDb().raw('token_version + 1'),
        updated_at: new Date()
      });
  }

  static async updateUsername(id, newUsername) {
    await getDb()('users')
      .where({ id })
      .update({ username: newUsername, updated_at: new Date() });
  }

  static async revokeSessions(id) {
    await getDb()('users')
      .where({ id })
      .update({
        token_version: getDb().raw('token_version + 1'),
        updated_at: new Date()
      });
  }
}

export default User;
