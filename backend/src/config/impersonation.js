/**
 * Entrar no painel de um provedor para dar suporte — e por que isto é a coisa
 * mais perigosa do produto.
 *
 * Um administrador da plataforma somos nós. Entrar no painel de um ISP é
 * alcançar o cadastro inteiro de assinantes dele: nomes, documentos, contratos,
 * o que a rede daquele cliente está fazendo agora. É indispensável para
 * suporte, e é exatamente o acesso que ninguém deveria ter sem que ficasse
 * registrado — inclusive para o próprio ISP.
 *
 * As quatro decisões abaixo existem porque abuso aqui não se previne, se
 * limita e se mostra.
 *
 * ## 1. Não se toma a identidade de ninguém
 *
 * A sessão não é a de um operador do provedor. Não há "entrar como a Maria":
 * emprestar o crachá dela suja a trilha dela — no dia em que ela contestar uma
 * ação, o registro não distingue o que ela fez do que fizemos. A sessão é
 * anônima do lado do provedor e nominal do nosso: a trilha grava QUEM da
 * plataforma entrou, e nenhum operador de lá aparece como autor de nada.
 *
 * ## 2. Entra com o menor papel que existe, e só lê
 *
 * `viewer`, que é o piso já existente: lista de aparelhos, mapa e catálogo.
 * Papel novo seria papel que alguém pode conceder por engano na tela de
 * operadores; reusar o menor não acrescenta nada ao que se pode dar a ninguém.
 *
 * Isso deixa de fora, de propósito, duas coisas que o suporte pode querer:
 * `devices.inspect` (o aparelho aberto, com o assinante atrás dele) e
 * `customers.secrets` — a rota que devolve a senha do portal de um assinante,
 * que é `GET` e portanto passaria por qualquer regra de "só leitura". Ler a
 * credencial do cliente do nosso cliente não é suporte.
 *
 * E só leitura por cima do papel: um `POST` que o `viewer` alcançasse ainda
 * seria uma mudança na produção de um ISP feita por alguém de fora, e a trilha
 * explicaria depois em vez de impedir antes.
 *
 * ## 3. Quinze minutos, e não se renova
 *
 * Sem refresh token, e a ausência é a decisão: com um, isto vira sessão
 * durável e o "suporte entrou um instante" passa a durar uma semana. Precisar
 * de mais tempo é emitir de novo — e cada emissão é uma linha nova nas duas
 * trilhas, que é justamente o que queremos que apareça.
 *
 * ## 4. A permissão é relida a cada requisição
 *
 * O token diz quem entrou; quem autoriza é a tabela. Tirar alguém de
 * `platform_admins` derruba a sessão de impersonação na requisição seguinte, e
 * não quando os quinze minutos vencerem — que é a mesma regra que
 * `requirePlatformAdmin` já aplica, e vale ainda mais aqui, onde o motivo de
 * tirar a pessoa da lista pode ser exatamente o que ela está fazendo.
 */

/** A audiência própria. Um token destes NUNCA é lido como sessão comum. */
export const IMPERSONATION_AUDIENCE = 'skygenpanel-impersonation';

/** Quinze minutos. Ver a decisão 3. */
export const IMPERSONATION_TTL = '15m';

/** O papel com que se entra. Ver a decisão 2. */
export const IMPERSONATION_ROLE = 'viewer';

/** Métodos que uma sessão de impersonação pode usar. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isReadOnlyMethod(method) {
  return SAFE_METHODS.has(String(method ?? '').toUpperCase());
}

/** O código que o frontend lê para dizer por que a ação foi recusada. */
export const IMPERSONATION_CODES = Object.freeze({
  READ_ONLY: 'impersonation_read_only',
  NO_CONTROL_PLANE: 'impersonation_no_control_plane'
});
