/**
 * Consulta um CNPJ na BrasilAPI para PREENCHER o cadastro do provedor.
 *
 * Só sugere: não grava nada, e o cadastro continua terminando sem ela — a
 * regra de `utils/taxId.js` (um cadastro não pode depender de um terceiro
 * para terminar) vale igual. Se a BrasilAPI cair, o operador digita.
 *
 * Roda no servidor e não no navegador porque a CSP do painel só deixa a tela
 * falar com a própria origem, e porque assim o painel escolhe o que devolve:
 * só os campos do cadastro, já no tamanho que a rota de gravação aceita.
 */

const BASE_URL = 'https://brasilapi.com.br/api/cnpj/v1';
const TIMEOUT_MS = 8000;

/** Os limites de `CAMPOS_FATURAMENTO` do controlador — o que não cabe, corta. */
const LIMITES = {
  legalName: 160,
  postalCode: 8,
  addressLine: 160,
  addressNumber: 16,
  addressExtra: 80,
  district: 80,
  city: 80,
  state: 2,
  email: 160,
  phone: 32
};

function texto(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/\s+/g, ' ').trim();
}

/** A resposta da BrasilAPI no formato do cadastro, só com o que veio preenchido. */
export function mapBrasilApiCnpj(dados) {
  const logradouro = [texto(dados?.descricao_tipo_de_logradouro), texto(dados?.logradouro)]
    .filter(Boolean)
    .join(' ');
  const cep = texto(dados?.cep).replace(/\D/g, '');
  const bruto = {
    legalName: texto(dados?.razao_social),
    postalCode: cep ? cep.padStart(8, '0') : '',
    addressLine: logradouro,
    addressNumber: texto(dados?.numero),
    addressExtra: texto(dados?.complemento),
    district: texto(dados?.bairro),
    city: texto(dados?.municipio),
    state: texto(dados?.uf).toUpperCase(),
    email: texto(dados?.email).toLowerCase(),
    phone: texto(dados?.ddd_telefone_1)
  };
  const saida = {};
  for (const [chave, valor] of Object.entries(bruto)) {
    if (valor) saida[chave] = valor.slice(0, LIMITES[chave]);
  }
  return saida;
}

/**
 * `{ found: true, data }`, `{ found: false }` quando a Receita não conhece o
 * número, ou lança quando a consulta em si falhou (rede, tempo, 5xx).
 */
export async function lookupCnpj(cnpj) {
  const response = await fetch(`${BASE_URL}/${cnpj}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (response.status === 404) return { found: false };
  if (!response.ok) throw new Error(`BrasilAPI respondeu ${response.status}`);
  return { found: true, data: mapBrasilApiCnpj(await response.json()) };
}

export default { lookupCnpj, mapBrasilApiCnpj };
