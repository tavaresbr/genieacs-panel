import 'dotenv/config';
import { IS_SAAS } from './edition.js';
import { isProduction } from './runtimeEnv.js';

/**
 * Se o console da plataforma exige o login em duas etapas de quem o opera.
 *
 * O console é o plano de controle da SaaS: cria e suspende provedores, mexe em
 * cobrança, abre personificação no painel de qualquer cliente. Até aqui ele
 * honrava o 2FA só de quem o tivesse ligado por conta própria — a senha de uma
 * pessoa do cadastro da plataforma bastava para tudo isso.
 *
 * `PLATFORM_REQUIRE_MFA`:
 *
 * - **`true`** / **`false`** decidem, explícitos;
 * - **ausente**, vale LIGADO em produção na SaaS e desligado no resto (testes,
 *   desenvolvimento). Ligado por padrão é a decisão: um interruptor de
 *   segurança que o operador precisa lembrar de virar fica desligado em quem
 *   mais precisava dele.
 *
 * Ligar não tranca ninguém do lado de fora: quem entra no console sem o 2FA
 * cai na ativação obrigatória (a mesma que o provedor usa com `require_mfa`),
 * que só deixa alcançar `/api/auth/` até a ativação terminar. A senha de antes
 * continua servindo para entrar; o que deixa de servir é operar o console só
 * com ela.
 *
 * No self-hosted não há console, e a chave não faz nada — por isso o `IS_SAAS`
 * vem primeiro, mesmo com a variável em `true`.
 *
 * Lido a cada chamada, e não no import, para um teste poder ligá-lo em
 * `process.env` sem reiniciar o módulo.
 */
export function platformRequiresMfa(env = process.env) {
  if (!IS_SAAS) return false;
  const valor = String(env.PLATFORM_REQUIRE_MFA ?? '').trim().toLowerCase();
  if (valor === 'true' || valor === '1') return true;
  if (valor === 'false' || valor === '0') return false;
  return isProduction();
}
