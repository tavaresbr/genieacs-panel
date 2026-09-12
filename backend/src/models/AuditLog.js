import { tdb, tinsert } from '../config/database.js';

/**
 * A trilha das ações sensíveis.
 *
 * Três regras, e as três existem porque a alternativa é pior de um jeito que só
 * aparece meses depois:
 *
 * 1. **Gravar nunca derruba a ação.** Se a trilha falhar, a revelação de senha
 *    que ela ia registrar já aconteceu — devolver 500 ali faria o operador
 *    tentar de novo e produzir duas revelações e zero registros. O erro vai
 *    para o log do processo e a resposta segue.
 * 2. **Nada de segredo em `detail`.** A trilha registra que a senha foi
 *    revelada, não qual era. A primeira coisa é o que permite auditar; a
 *    segunda faria da auditoria o maior repositório de segredos em claro do
 *    produto — e um que ninguém pensa em proteger, porque "é só log".
 * 3. **Só leitura depois.** Não existe update nem delete linha a linha aqui, de
 *    propósito. O que existe é a poda por idade, que apaga em bloco pelo tempo
 *    e não escolhe o quê — uma trilha em que se apaga uma linha específica não
 *    serve para nada.
 */
class AuditLog {
  /** As ações que o painel registra. Nome estável: a tela filtra por ele. */
  static ACTIONS = Object.freeze({
    PORTAL_PASSWORD_REVEALED: 'portal_password.revealed',
    PORTAL_PASSWORD_RESET: 'portal_password.reset',
    GENIEACS_URL_CHANGED: 'genieacs.url_changed',
    GENIEACS_AUTH_CHANGED: 'genieacs.auth_changed',
    OPERATOR_ROLE_CHANGED: 'operator.role_changed',
    OPERATOR_REMOVED: 'operator.removed',
    OPERATOR_CREATED: 'operator.created',
    INVITE_CREATED: 'invite.created',
    INVITE_ACCEPTED: 'invite.accepted',
    INVITE_REVOKED: 'invite.revoked',
    TENANT_STATUS_CHANGED: 'tenant.status_changed',
    TENANT_EXPORTED: 'tenant.exported',
    // O cadastro fiscal do provedor mudou — razão social, CNPJ, endereço,
    // contato de cobrança. Registra QUAIS campos, nunca os valores: a trilha
    // responde "quem mexeu no meu cadastro", e para isso o nome do campo basta.
    // Guardar os valores faria dela uma segunda cópia do cadastro, com
    // retenção maior que a do original.
    TENANT_BILLING_CHANGED: 'tenant.billing_changed',
    // A assinatura mudou de plano ou de estado. Gravada NO provedor, com
    // `actorKind: 'platform'`, pelo mesmo motivo da suspensão: quem vai
    // perguntar "por que meu painel ficou só leitura" é o ISP, e a resposta
    // tem que estar onde ele olha.
    SUBSCRIPTION_CHANGED: 'subscription.changed',
    // O provedor mudou o próprio nome — o que aparece na barra lateral, na
    // tela de login e na aba do navegador.
    TENANT_RENAMED: 'tenant.renamed',
    // E o endereço em que o painel dele responde mudou — feito de fora, pelo
    // plano de controle, porque o slug é o subdomínio e só o console o troca.
    // Ação própria e não `TENANT_RENAMED`: a frase "provedor renomeado" não
    // descreve um endereço que mudou, e é a frase que o ISP vai ler na trilha
    // dele quando o painel parar de responder no lugar de sempre.
    TENANT_SLUG_CHANGED: 'tenant.slug_changed',
    LOGIN_EMAIL_CHANGED: 'login_email.changed',
    // O endereço de login foi PROVADO — alguém abriu o que foi mandado para
    // ele. É o que separa "esta conta tem um endereço" de "este endereço é
    // desta pessoa", e é a linha que a redefinição de senha exige antes de
    // mandar qualquer coisa.
    LOGIN_EMAIL_VERIFIED: 'login_email.verified',
    // Pediram uma senha nova para esta conta. Registrada mesmo quando ninguém
    // completa: para quem é dono da conta, "alguém pediu para redefinir minha
    // senha" é o aviso, e ele só serve se estiver escrito no momento do pedido.
    PASSWORD_RESET_REQUESTED: 'password_reset.requested',
    // E a senha de fato mudou por esse caminho. Duas linhas e não uma porque
    // respondem a perguntas diferentes, e a distância entre elas é a informação:
    // um pedido sem conclusão é ruído, um pedido concluído que ninguém fez é
    // uma invasão.
    PASSWORD_RESET_COMPLETED: 'password_reset.completed',
    // Alguém do plano de controle abriu uma sessão de leitura NESTE provedor.
    // Gravada aqui, e não só na trilha da plataforma, porque quem tem direito
    // de saber que entraram no painel dele é o dono do painel — e a trilha da
    // plataforma é a nossa, ele não a lê.
    PLATFORM_IMPERSONATED: 'platform.impersonated'
  });

  /**
   * A troca de banco em runtime NÃO é auditada, e vale dizer por quê antes que
   * alguém a acrescente achando que foi esquecimento.
   *
   * A linha teria que ser escrita depois da troca, e depois da troca o banco é
   * outro: o provedor em escopo veio do banco ANTIGO, e num banco novo aquele
   * id ou não existe (a FK recusa) ou pertence a outro provedor (a linha nasce
   * no lugar errado, que é pior). Escrever antes registraria uma ação que pode
   * não acontecer.
   *
   * O que torna isso aceitável é onde a rota existe: só na edição self-hosted,
   * onde há um provedor e quem opera o painel é dono da máquina — a mesma
   * pessoa que poderia trocar o arquivo do SQLite por fora. Auditar ali
   * protegeria alguém de si mesmo. Se um dia a rota existir no SaaS, isto tem
   * que ser resolvido ANTES, e não com um `record` no fim do handler.
   */

  /**
   * Escreve uma linha. Não lança: ver a regra 1.
   *
   * `detail` é serializado aqui e não pelo chamador, para que a checagem de
   * tamanho e o `JSON.stringify` aconteçam num lugar só — e para que um objeto
   * com referência circular vindo de um controlador vire uma linha sem detalhe
   * em vez de uma exceção no meio de uma resposta que já foi decidida.
   */
  static async record({
    action, actorUserId = null, actorUsername = null, actorKind = 'operator',
    subjectType = null, subjectId = null, detail = null, ip = null
  }) {
    try {
      await tinsert('audit_log', {
        actor_user_id: actorUserId,
        actor_username: actorUsername ? String(actorUsername).slice(0, 64) : null,
        actor_kind: actorKind,
        action,
        subject_type: subjectType ? String(subjectType).slice(0, 32) : null,
        subject_id: subjectId === null || subjectId === undefined
          ? null
          : String(subjectId).slice(0, 128),
        detail: AuditLog.serializeDetail(detail),
        ip: ip ? String(ip).slice(0, 64) : null
      });
      return true;
    } catch (error) {
      console.error('Audit log write failed:', action, error.message);
      return false;
    }
  }

  static serializeDetail(detail) {
    if (detail === null || detail === undefined) return null;
    try {
      return JSON.stringify(detail).slice(0, 2000);
    } catch {
      return null;
    }
  }

  /**
   * A partir de um request: preenche o ator sozinho.
   *
   * Existe para que nenhum controlador precise lembrar de copiar três campos do
   * `req.user` — e para que a próxima ação auditada não nasça com o ator vazio
   * porque quem a escreveu copiou de um exemplo que só passava `action`.
   */
  static async fromRequest(req, entrada) {
    // O try/catch se repete aqui, e não é redundância. A regra 1 tem que valer
    // para a API INTEIRA e não para um caminho dela: com o catch só em
    // `record`, qualquer coisa que estourasse antes de chegar lá — um `req`
    // com getter que lança, um `record` substituído em teste, um erro
    // acrescentado neste método um dia — propagaria para o controlador e
    // transformaria a trilha na causa de um 500 numa ação que já aconteceu.
    // Foi exatamente o que um teste pegou.
    try {
      return await AuditLog.record({
        ...entrada,
        actorUserId: req?.user?.userId ?? null,
        actorUsername: req?.user?.username ?? null,
        actorKind: entrada.actorKind ?? (req?.user?.isPlatformAdmin ? 'platform' : 'operator'),
        ip: req?.ip ?? null
      });
    } catch (error) {
      console.error('Audit log write failed:', entrada?.action, error.message);
      return false;
    }
  }

  /**
   * A trilha deste provedor, da mais recente para a mais antiga.
   *
   * Paginada por `before` (o id da última linha já vista) e não por `offset`:
   * a tabela cresce enquanto alguém a lê, e um offset entrega a mesma linha
   * duas vezes ou pula uma. O cursor é imune a isso.
   */
  static async list({ action = null, limit = 50, before = null } = {}) {
    let query = tdb('audit_log').orderBy('id', 'desc').limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
    if (action) query = query.where({ action });
    if (before) query = query.where('id', '<', Number(before));
    return query;
  }

  /**
   * Apaga o que passou da janela de retenção. Devolve quantas linhas saíram.
   *
   * Em bloco e por tempo — nunca linha a linha. Ver a regra 3.
   */
  static async prune(cutoff) {
    return tdb('audit_log').where('created_at', '<', cutoff).del();
  }
}

export default AuditLog;
