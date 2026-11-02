/**
 * Por onde uma mensagem sai do painel.
 *
 * A interface existe pelo mesmo motivo que `BillingProvider`: o que muda entre
 * um SMTP do provedor, uma API de envio e o nada é só isto, e o resto do código
 * não deve saber qual está ligado. Quem chama pergunta se há transporte e, se
 * houver, manda; quem não há segue sem e-mail, que é como o painel sempre
 * funcionou.
 *
 * **O envio nunca é a condição de nada.** O convite existe com ou sem e-mail,
 * e o link continua saindo na resposta da criação. Um SMTP fora do ar não pode
 * transformar "convidei alguém" em erro — e é por isso que quem chama recebe
 * `false` em vez de uma exceção.
 */
export class MailTransport {
  /**
   * Manda uma mensagem. `html` é opcional: quando vem, vai junto do `text`.
   * `attachments` também (a exportação para a contabilidade): cada um com
   * `filename`, `content` (Buffer ou texto) e `contentType` — só isso passa
   * adiante (ver `mailAttachments`).
   * @param {{to: string, subject: string, text: string, html?: string,
   *   attachments?: Array<{filename: string, content: Buffer|string, contentType?: string}>}} _message
   * @returns {Promise<boolean>} entregue ao servidor de e-mail, ou não
   */
  async send(_message) {
    throw new Error('MailTransport.send is not implemented');
  }

  /**
   * Manda uma mensagem E diz por que não saiu. É o que o botão "Enviar e-mail
   * de teste" do console usa: `send` esconde a causa de propósito (quem convida
   * não tem o que fazer com ela), mas quem opera o deploy só consegue corrigir
   * o SMTP sabendo se foi a senha, o endereço ou o remetente.
   * @param {{to: string, subject: string, text: string}} _message
   * @returns {Promise<{ok: boolean, reason?: string}>} `reason` é um código curto
   *   (`not_configured`, `auth`, `connection`, `timeout`, `tls`, `rejected`,
   *   `unknown`) — nunca o texto do erro, que pode trazer o servidor e o usuário.
   */
  async probe(_message) {
    throw new Error('MailTransport.probe is not implemented');
  }

  /** Um nome curto para a linha de log. */
  get name() {
    return 'none';
  }
}

/** O teto de um anexo: o SMTP comum recusa mensagens bem menores que isto. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/**
 * Os anexos de uma mensagem como podem ir ao servidor de e-mail: só nome,
 * conteúdo em memória e tipo. As outras chaves que o nodemailer entende
 * (`path`, `href`, `raw`) leriam um arquivo do disco ou uma URL — e um anexo
 * nunca é isso aqui. Anexo sem nome, sem conteúdo ou grande demais fica de
 * fora. Sem anexo nenhum, uma lista vazia.
 */
export function mailAttachments(lista) {
  if (!Array.isArray(lista)) return [];
  const aceitos = [];
  for (const item of lista) {
    if (!item || typeof item !== 'object') continue;
    const filename = typeof item.filename === 'string'
      ? item.filename.replace(/[\\/\r\n"]/g, '_').slice(0, 120).trim() : '';
    const content = Buffer.isBuffer(item.content) || typeof item.content === 'string' ? item.content : null;
    if (!filename || content === null) continue;
    if (Buffer.byteLength(content) > MAX_ATTACHMENT_BYTES) continue;
    aceitos.push({
      filename,
      content,
      ...(typeof item.contentType === 'string' && item.contentType ? { contentType: item.contentType.slice(0, 120) } : {})
    });
  }
  return aceitos;
}

/**
 * O transporte de um deploy sem e-mail configurado: não manda nada e diz que
 * não mandou. Existe para que quem chama não precise de um `if` — a diferença
 * entre "não há transporte" e "o envio falhou" é a mesma para quem convidou, e
 * é `false` nos dois casos.
 */
export class NullMailTransport extends MailTransport {
  async send() {
    return false;
  }

  async probe() {
    return { ok: false, reason: 'not_configured' };
  }
}

export default MailTransport;
