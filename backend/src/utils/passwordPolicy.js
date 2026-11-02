/**
 * A regra da senha NOVA — a que alguém escolhe agora.
 *
 * Só vale na hora de escolher: cadastro, instalação, convite de quem ainda não
 * tem conta, troca, redefinição e as senhas que um administrador define para
 * outra pessoa. O login NÃO passa por aqui, de propósito: quem tem uma senha de
 * oito caracteres de antes desta regra continua entrando com ela, e só
 * esbarra no mínimo novo no dia em que trocar. Endurecer o login trancaria do
 * lado de fora gente que não fez nada de errado.
 *
 * Três recusas, nesta ordem:
 * - tamanho: de 10 a 128 caracteres (o teto é o de antes, e existe porque o
 *   bcrypt só olha os primeiros 72 bytes e um corpo gigante é custo à toa);
 * - comum: as senhas que aparecem no topo de todo vazamento, comparadas sem
 *   diferenciar maiúsculas, mais as sequências e os caracteres repetidos;
 * - igual à identidade: o nome de usuário, o e-mail ou a parte do e-mail antes
 *   do `@` — a primeira coisa que quem ataca tenta.
 *
 * A lista é pequena de propósito. Como o mínimo é 10, só entram nela as
 * comuns com 10 ou mais caracteres: as de 6 a 9 (`123456`, `senha123`) já caem
 * no tamanho. Uma lista de cem mil entradas pesaria no pacote e na memória
 * para pegar quase nada a mais do que esta pega.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

// Em minúsculas. Fontes: os topos públicos de vazamentos (RockYou, listas de
// "senhas mais usadas") filtrados para 10+ caracteres, e as variantes
// brasileiras que esses topos não trazem (times, "senha", "mudar", provedor).
const COMMON_PASSWORDS = new Set([
  '1234567890', '0123456789', '0987654321', '9876543210', '12345678910',
  '123456789012', '1234567891', '1234512345', '1122334455', '1212121212',
  '1231231231', '123123123123', '1234554321', '1111111111', '0000000000',
  '123456789a', 'a123456789', '123456789q', 'q123456789', 'abc1234567',
  'abcd123456', 'abcde12345', 'abcdefghij', 'abcdefg123', 'abc123456789',
  'qwertyuiop', 'qwertyuiop123', 'qwerty1234', 'qwerty12345', 'qwerty123456',
  'qwert12345', '12345qwert', 'qwe1234567', '1234qwerty', '1234qwer', '1234qwerasdf',
  'q1w2e3r4t5', 'q1w2e3r4t5y6', '1q2w3e4r5t', '1q2w3e4r5t6y', '1qaz2wsx3edc',
  '1qaz2wsx3e', '!qaz2wsx3edc', 'zaq1xsw2cde3', 'zaq12wsxcde3', 'qazwsxedc123',
  'qazwsxedcrfv', 'qweasdzxc123', '123qweasdzxc', 'asdfghjkl1', 'asdfghjkl123',
  'asdf123456', '123456asdf', 'zxcvbnm123', 'zxcvbnm1234', 'asdfghjklz',
  'password10', 'password12', 'password123', 'password1234', 'password12345',
  'password!1', 'password01', 'passw0rd123', 'p@ssw0rd123', 'p@ssword123',
  'p@ssw0rd12', 'mypassword', 'mypassword1', 'passwordpassword', 'iloveyou12',
  'iloveyou123', 'welcome123', 'welcome1234', 'letmein123', 'letmein1234',
  'changeme123', 'changeme12', 'default123', 'default1234', 'trustno1234',
  'monkey1234', 'dragon1234', 'master1234', 'master12345', 'sunshine12',
  'sunshine123', 'princess12', 'princess123', 'football12', 'football123',
  'baseball12', 'baseball123', 'basketball', 'basketball1', 'superman12',
  'superman123', 'starwars12', 'starwars123', 'whatever12', 'whatever123',
  'computer12', 'computer123', 'michael123', 'jennifer12', 'charlie123',
  'liverpool1', 'liverpool12', 'manchester', 'manchester1', 'chelsea123',
  'arsenal123', 'barcelona1', 'barcelona10', 'realmadrid', 'realmadrid1',
  'samsung123', 'samsung1234', 'mercedes12', 'mercedes123', 'unknown123',
  'administrator', 'administrador', 'admin12345', 'admin123456', 'admin@1234',
  'admin@12345', 'adminadmin', 'adminadmin1', 'adminadmin123', 'rootroot12',
  'root123456', 'toor123456', 'useruser12', 'user123456', 'test123456',
  'testtest12', 'teste12345', 'teste123456', 'guest12345', 'support123',
  'senha12345', 'senha123456', 'senha@1234', 'senha@12345', 'senhasenha',
  'senhasenha1', 'minhasenha', 'minhasenha1', 'minhasenha123', 'mudar12345',
  'mudar@1234', 'mudarsenha', 'trocar1234', 'trocarsenha', 'novasenha1',
  'novasenha123', 'brasil1234', 'brasil12345', 'brasil2014', 'brasil2022',
  'flamengo10', 'flamengo123', 'flamengo1895', 'corinthians', 'corinthians1',
  'corinthians10', 'palmeiras1', 'palmeiras10', 'palmeiras123', 'saopaulo10',
  'saopaulo123', 'santos1234', 'santosfc10', 'gremio1234', 'vasco12345',
  'vascodagama', 'cruzeiro10', 'cruzeiro123', 'botafogo10', 'fluminense',
  'internacional', 'atleticomg', 'internet123', 'internet@123', 'internet12',
  'wifi123456', 'fibra12345', 'provedor123', 'provedor1234', 'genieacs123',
  'skygenpanel', 'tr69controle', 'deusefiel1', 'jesus12345', 'jesuscristo',
  'deus123456', 'amor123456', 'teamo12345', 'familia123', 'felicidade'
]);

/** Toda a senha é o mesmo caractere repetido (`aaaaaaaaaa`). */
function oneRepeatedChar(text) {
  return /^(.)\1+$/u.test(text);
}

/**
 * Uma corrida de vizinhos na tabela: `abcdefghij`, `9876543210`, `3456789012`
 * (dando a volta). Só para senhas inteiras feitas disso — um trecho em
 * sequência dentro de uma senha longa não é motivo de recusa.
 */
function straightRun(text) {
  if (!/^[0-9]+$/.test(text) && !/^[a-z]+$/.test(text)) return false;
  const alfabeto = /^[0-9]+$/.test(text) ? '0123456789' : 'abcdefghijklmnopqrstuvwxyz';
  const n = alfabeto.length;
  for (const passo of [1, -1]) {
    let ok = true;
    for (let i = 1; i < text.length && ok; i += 1) {
      const antes = alfabeto.indexOf(text[i - 1]);
      const agora = alfabeto.indexOf(text[i]);
      ok = agora === (antes + passo + n) % n;
    }
    if (ok) return true;
  }
  return false;
}

/** Comum: na lista, uma sequência inteira ou um caractere só. */
export function isCommonPassword(password) {
  const lower = String(password ?? '').toLowerCase();
  return COMMON_PASSWORDS.has(lower) || oneRepeatedChar(lower) || straightRun(lower);
}

/** Igual ao nome de usuário, ao e-mail ou à parte do e-mail antes do `@`. */
export function matchesIdentity(password, { username, email } = {}) {
  const lower = String(password ?? '').trim().toLowerCase();
  if (!lower) return false;
  const candidatos = [];
  if (username) candidatos.push(String(username).trim().toLowerCase());
  if (email) {
    const e = String(email).trim().toLowerCase();
    candidatos.push(e);
    const local = e.split('@')[0];
    if (local) candidatos.push(local);
  }
  return candidatos.some((c) => c && c === lower);
}

/**
 * O problema da senha nova, ou null quando ela serve.
 *
 * Devolve `{ code, key }`: o `code` é estável e vai na resposta para o cliente
 * ramificar; a `key` é a mensagem no catálogo do backend. `lengthKey` deixa
 * cada rota manter a frase de tamanho que já usava (`auth.passwordLength` ou
 * `auth.newPasswordLength`).
 */
export function newPasswordProblem(password, identity = {}, { lengthKey = 'auth.passwordLength' } = {}) {
  const text = typeof password === 'string' ? password : String(password ?? '');
  if (text.length < PASSWORD_MIN_LENGTH || text.length > PASSWORD_MAX_LENGTH) {
    return { code: 'password_length', key: lengthKey };
  }
  if (isCommonPassword(text)) {
    return { code: 'password_too_common', key: 'auth.passwordTooCommon' };
  }
  if (matchesIdentity(text, identity)) {
    return { code: 'password_matches_identity', key: 'auth.passwordMatchesIdentity' };
  }
  return null;
}

/**
 * As mesmas recusas em inglês fixo, para o plano de controle (console), cujas
 * respostas não passam pelo catálogo de idiomas.
 */
export const PASSWORD_PROBLEM_TEXT_EN = Object.freeze({
  password_length: `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
  password_too_common: 'This password is too common; choose another one',
  password_matches_identity: 'The password cannot be the same as the username or e-mail'
});
