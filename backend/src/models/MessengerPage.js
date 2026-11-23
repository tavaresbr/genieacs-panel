import { getDb, tdb, tinsertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';

/**
 * As Páginas do Facebook que o provedor conectou ao Messenger.
 *
 * O token da Página fica cifrado na coluna e não sai do servidor: quem entrega
 * uma Página ao navegador passa por `MessengerPageService.publicPage()`.
 */
class MessengerPage {
  static async getAll() {
    return tdb('messenger_pages').orderBy('id');
  }

  static async getById(id) {
    return (await tdb('messenger_pages').where({ id }).first()) || null;
  }

  /**
   * O webhook resolve a Página pelo id que a Meta põe no evento.
   *
   * Sem escopo, e tem de continuar assim: a entrega chega sem sessão, e esta
   * leitura é justamente o que diz de que provedor ela é. `page_id` é único em
   * todo o painel por isso.
   *
   * tenant-scope-exempt: this lookup is how the provider is discovered.
   */
  static async getByPageId(pageId) {
    return runUnscoped(
      'the Messenger webhook arrives with no session; the page id names the provider',
      async () => (await getDb()('messenger_pages').where({ page_id: String(pageId) }).first()) || null
    );
  }

  /**
   * Existe esta Página em OUTRO provedor? Responde só sim ou não, para o
   * provedor que tenta conectar uma Página que já é de alguém não aprender de quem.
   */
  static async existsAnywhere(pageId) {
    return Boolean(await this.getByPageId(pageId));
  }

  /**
   * As Páginas que ESTE usuário do Facebook conectou, de todos os provedores:
   * a Meta avisa a desautorização e a exclusão de dados por usuário, sem
   * sessão nenhuma.
   *
   * tenant-scope-exempt: the notice names a Facebook user, not a provider.
   */
  static async listByFacebookUser(facebookUserId) {
    return runUnscoped(
      'Meta deauthorization/deletion notices arrive with no session; the Facebook user id names the pages',
      async () => getDb()('messenger_pages').where({ facebook_user_id: String(facebookUserId) })
    );
  }

  /** tenant-scope-exempt: same as `listByFacebookUser` — one Facebook user, every provider they connected. */
  static async updateByFacebookUser(facebookUserId, patch) {
    return runUnscoped(
      'Meta deauthorization/deletion notices arrive with no session; the Facebook user id names the pages',
      async () => getDb()('messenger_pages')
        .where({ facebook_user_id: String(facebookUserId) })
        .update({ ...patch, updated_at: new Date() })
    );
  }

  static async create(row) {
    const id = await tinsertReturningId('messenger_pages', row);
    return this.getById(id);
  }

  static async update(id, patch) {
    await tdb('messenger_pages').where({ id }).update({ ...patch, updated_at: new Date() });
    return this.getById(id);
  }

  static async remove(id) {
    return tdb('messenger_pages').where({ id }).del();
  }
}

export default MessengerPage;
