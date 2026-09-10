import 'dotenv/config';

/**
 * Como se entra no painel: por e-mail, e — enquanto durar a transição —
 * também pelo nome de usuário.
 *
 * A troca de `username` para e-mail é a última peça da Fase 2 do plano, e a
 * única que quebra contrato com quem já usa o produto: num install em produção,
 * um dia de virada em que o login passa a exigir e-mail tranca do lado de fora
 * todo operador que ainda não cadastrou o dele — inclusive quem cadastraria.
 *
 * Por isso a troca acontece em três passos, e este arquivo é o interruptor do
 * terceiro:
 *
 * 1. A coluna existe e é anulável; **toda conta nova nasce com e-mail**;
 *    quem já existe cadastra o seu em `POST /api/auth/email`. (feito)
 * 2. O login aceita os dois, com nome e e-mail num espaço de nomes só para que
 *    um identificador nunca case duas contas. (feito)
 * 3. `LOGIN_REQUIRES_EMAIL=true` desliga o login por nome. É uma linha de
 *    ambiente, e a decisão de quando virá-la é de quem opera o painel — não do
 *    código, que não sabe se todo mundo já cadastrou o endereço.
 *
 * O painel tem como responder se já dá para virar: `GET /api/users` mostra
 * quem ainda está sem e-mail. Virar a chave antes disso é trancar essa gente
 * do lado de fora, e o passo 3 não tem volta pela tela — só pelo ambiente.
 */
export const LOGIN_REQUIRES_EMAIL =
  String(process.env.LOGIN_REQUIRES_EMAIL || '').trim().toLowerCase() === 'true';

/** Se um identificador de login serve neste deployment. */
export function acceptsIdentifier(identifier, user) {
  if (!user) return false;
  if (!LOGIN_REQUIRES_EMAIL) return true;
  // Com a chave virada, só o e-mail entra — e uma conta sem e-mail não entra
  // por nada. É a definição do passo 3, e é o que o aviso acima descreve.
  const email = String(user.email ?? '').trim().toLowerCase();
  if (!email) return false;
  return String(identifier ?? '').trim().toLowerCase() === email;
}
