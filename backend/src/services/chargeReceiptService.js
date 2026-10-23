import BillingCharge from '../models/BillingCharge.js';
import Plan from '../models/Plan.js';
import Tenant from '../models/Tenant.js';
import { currentTenantId } from '../config/tenantContext.js';
import { DEFAULT_LOCALE, resolveLocale, translatorFor } from '../i18n/index.js';
import { readProfile } from './platformProfileService.js';
import { readBrandingImage } from './platformBrandingService.js';
import { paymentFactsFor, TenantChargeError } from './tenantChargeService.js';

/**
 * O recibo de uma cobrança paga, em HTML para imprimir.
 *
 * Gerado aqui, e não na tela, porque é um documento: quem emite é a
 * plataforma, com os dados dela e os do provedor, e o mesmo pedido tem de dar
 * o mesmo papel em qualquer navegador. Sem script nenhum — a rota manda uma
 * CSP que não deixa rodar nada (`RECEIPT_CSP`), e o próprio documento repete
 * a regra num `<meta>`, porque a tela o abre como `blob:` e ali o cabeçalho
 * da resposta já ficou para trás.
 *
 * TODO texto que entra no HTML passa por `esc`, inclusive os que "não podem"
 * ter `<`: o nome do provedor é digitado por ele, e o da plataforma, pelo
 * console. Um nome com `<script>` tem de sair impresso, não executado.
 */

export const RECEIPT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

/** As imagens que podem ir embutidas como logo. SVG num `<img>` não roda script. */
const LOGO_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);

const MEIOS = new Set(['PIX', 'BOLETO', 'CREDIT_CARD', 'DEBIT_CARD', 'TRANSFER', 'DEPOSIT', 'MANUAL']);

/** O escape de HTML — texto e atributo, os cinco caracteres. */
export function esc(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatarValor(locale, cents, currency) {
  const valor = Number(cents) / 100;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency || 'BRL' }).format(valor);
  } catch {
    return `${currency || ''} ${valor.toFixed(2)}`.trim();
  }
}

/**
 * Uma data para o papel. O dia puro (`YYYY-MM-DD`) é lido ao meio-dia UTC e
 * formatado em UTC — senão o fuso de Brasília o empurraria para o dia anterior.
 * O instante completo vai no horário de Brasília, que é o da plataforma.
 */
function formatarData(locale, valor, { withTime = false } = {}) {
  if (!valor) return null;
  const texto = valor instanceof Date ? valor.toISOString() : String(valor);
  const soDia = /^\d{4}-\d{2}-\d{2}$/.test(texto.slice(0, 10)) && texto.length <= 10;
  const data = soDia ? new Date(`${texto.slice(0, 10)}T12:00:00Z`) : new Date(/^\d+$/.test(texto) ? Number(texto) : texto);
  if (Number.isNaN(data.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: soDia ? 'UTC' : 'America/Sao_Paulo',
      dateStyle: 'short',
      ...(withTime && !soDia ? { timeStyle: 'short' } : {})
    }).format(data);
  } catch {
    return texto.slice(0, 10);
  }
}

/** O CPF/CNPJ com a máscara de sempre, quando tem o tamanho de um. */
function formatarDocumento(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length === 14) return digitos.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (digitos.length === 11) return digitos.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return valor ? String(valor) : null;
}

function enderecoDoProvedor(tenant) {
  const rua = [tenant.billing_address_line, tenant.billing_address_number].filter(Boolean).join(', ');
  const cidade = [tenant.billing_city, tenant.billing_state].filter(Boolean).join('/');
  const partes = [rua, tenant.billing_address_extra, tenant.billing_district, cidade,
    tenant.billing_postal_code ? `CEP ${String(tenant.billing_postal_code).replace(/^(\d{5})(\d{3})$/, '$1-$2')}` : null];
  const texto = partes.filter(Boolean).join(' — ');
  return texto || null;
}

async function logoEmbutida() {
  try {
    const imagem = await readBrandingImage('logo');
    if (!imagem || !LOGO_MIMES.has(imagem.mime) || imagem.buffer.length > 512 * 1024) return null;
    return `data:${imagem.mime};base64,${imagem.buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Tudo o que o recibo mostra, já decidido — sem HTML. Separado do desenho
 * para que o teste confira os dados sem ler marcação.
 */
export async function receiptData(chargeId) {
  const linha = await BillingCharge.findById(chargeId);
  if (!linha) throw new TenantChargeError('charge not found', { status: 404, code: 'charge_not_found' });
  if (linha.status !== 'paid') {
    throw new TenantChargeError('the charge is not paid', { status: 409, code: 'not_paid', detail: { status: linha.status } });
  }
  const fato = (await paymentFactsFor([linha])).get(Number(linha.id)) ?? {};
  const tenant = await Tenant.findById(currentTenantId());
  const plano = linha.plan_id ? await Plan.findById(linha.plan_id).catch(() => null) : null;
  const perfil = (await readProfile().catch(() => null))?.values ?? {};
  return {
    charge: linha,
    kind: linha.kind || 'renewal',
    planName: plano?.name ?? null,
    periodEnd: BillingCharge.periodEndOf(linha),
    amountCents: Number.isInteger(fato.paidCents) && fato.paidCents > 0 ? fato.paidCents : Number(linha.amount_cents),
    chargedCents: Number(linha.amount_cents),
    currency: linha.currency || 'BRL',
    creditCents: BillingCharge.creditReservedOf(linha),
    earlyDiscountCents: fato.earlyDiscountCents ?? 0,
    couponCode: fato.couponCode ?? null,
    paidAt: fato.paidAt ?? null,
    paymentMethod: fato.paymentMethod ?? null,
    payer: {
      name: tenant?.billing_legal_name || tenant?.name || null,
      tradeName: tenant?.billing_legal_name && tenant?.name !== tenant?.billing_legal_name ? tenant?.name : null,
      taxId: formatarDocumento(tenant?.billing_tax_id),
      address: tenant ? enderecoDoProvedor(tenant) : null,
      email: tenant?.billing_email || null
    },
    issuer: {
      name: perfil.legalName || perfil.tradeName || null,
      tradeName: perfil.legalName && perfil.tradeName && perfil.tradeName !== perfil.legalName ? perfil.tradeName : null,
      taxId: formatarDocumento(perfil.taxId),
      address: perfil.address || null,
      email: perfil.contactEmail || null
    },
    logo: await logoEmbutida()
  };
}

/** O HTML do recibo, no idioma pedido (pt-BR quando não há um suportado). */
export function renderReceipt(dados, { locale = DEFAULT_LOCALE, now = new Date() } = {}) {
  const idioma = resolveLocale(locale) || DEFAULT_LOCALE;
  const t = translatorFor(idioma);
  const moeda = (cents) => formatarValor(idioma, cents, dados.currency);
  const descricao = [
    t(`receipt.kind.${['renewal', 'proration', 'overage'].includes(dados.kind) ? dados.kind : 'renewal'}`),
    dados.planName ? `${t('receipt.plan')} ${dados.planName}` : null
  ].filter(Boolean).join(' — ');
  const periodo = dados.periodEnd && /^\d{4}-\d{2}-\d{2}/.test(String(dados.periodEnd))
    ? t('receipt.periodUntil', { date: formatarData(idioma, String(dados.periodEnd).slice(0, 10)) })
    : null;
  const meio = MEIOS.has(dados.paymentMethod) ? t(`receipt.method.${dados.paymentMethod}`) : t('receipt.method.unknown');
  const pagoEm = formatarData(idioma, dados.paidAt) ?? '—';

  const linhaDe = (rotulo, valor) => (valor === null || valor === undefined || valor === ''
    ? ''
    : `<tr><th scope="row">${esc(rotulo)}</th><td>${esc(valor)}</td></tr>`);

  const parte = (titulo, quem) => `
      <section class="party">
        <h2>${esc(titulo)}</h2>
        <p class="name">${esc(quem.name || '—')}</p>
        ${quem.tradeName ? `<p>${esc(quem.tradeName)}</p>` : ''}
        ${quem.taxId ? `<p>${esc(t('receipt.taxId'))}: ${esc(quem.taxId)}</p>` : ''}
        ${quem.address ? `<p>${esc(quem.address)}</p>` : ''}
        ${quem.email ? `<p>${esc(quem.email)}</p>` : ''}
      </section>`;

  const descontos = [
    dados.earlyDiscountCents > 0 ? linhaDe(t('receipt.discount'), moeda(dados.earlyDiscountCents)) : '',
    dados.creditCents > 0 ? linhaDe(t('receipt.credit'), moeda(dados.creditCents)) : '',
    linhaDe(t('receipt.coupon'), dados.couponCode)
  ].join('');

  const declaracao = t('receipt.statement', {
    payer: dados.payer.name || '—',
    amount: moeda(dados.amountCents),
    description: descricao
  });

  const rtl = idioma === 'ar';
  return `<!doctype html>
<html lang="${esc(idioma)}"${rtl ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(RECEIPT_CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(t('receipt.number', { id: dados.charge.id }))}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f4f5; color: #18181b; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 24px auto; background: #fff; padding: 32px; border: 1px solid #e4e4e7; border-radius: 8px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #18181b; padding-bottom: 16px; }
  header img { max-height: 56px; max-width: 200px; object-fit: contain; }
  h1 { margin: 0; font-size: 22px; }
  h2 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #52525b; }
  .number { color: #52525b; margin: 4px 0 0; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 24px 0; }
  .party p { margin: 0; }
  .party .name { font-weight: 600; }
  .statement { background: #fafafa; border: 1px solid #e4e4e7; border-radius: 6px; padding: 12px 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { text-align: start; padding: 8px 4px; border-bottom: 1px solid #e4e4e7; vertical-align: top; }
  th { width: 40%; font-weight: 500; color: #52525b; }
  .total td { font-size: 18px; font-weight: 700; }
  footer { margin-top: 24px; font-size: 12px; color: #71717a; }
  .hint { margin-top: 8px; }
  @media (max-width: 600px) { main { margin: 0; border: 0; border-radius: 0; padding: 20px 16px; } .parties { grid-template-columns: 1fr; } }
  @media print { body { background: #fff; } main { margin: 0; border: 0; padding: 0; max-width: none; } .hint { display: none; } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${esc(t('receipt.title'))}</h1>
      <p class="number">${esc(t('receipt.number', { id: dados.charge.id }))}</p>
    </div>
    ${dados.logo ? `<img src="${esc(dados.logo)}" alt="${esc(dados.issuer.name || '')}">` : ''}
  </header>
  <div class="parties">
    ${parte(t('receipt.issuer'), dados.issuer)}
    ${parte(t('receipt.payer'), dados.payer)}
  </div>
  <p class="statement">${esc(declaracao)}</p>
  <table>
    <tbody>
      ${linhaDe(t('receipt.description'), descricao)}
      ${linhaDe(t('receipt.period'), periodo)}
      ${dados.chargedCents !== dados.amountCents ? linhaDe(t('receipt.charged'), moeda(dados.chargedCents)) : ''}
      ${descontos}
      ${linhaDe(t('receipt.paidAt'), pagoEm)}
      ${linhaDe(t('receipt.method'), meio)}
      ${linhaDe(t('receipt.chargeId'), `#${dados.charge.id}`)}
      <tr class="total"><th scope="row">${esc(t('receipt.amount'))}</th><td>${esc(moeda(dados.amountCents))}</td></tr>
    </tbody>
  </table>
  <footer>
    <p>${esc(t('receipt.issuedAt', { date: formatarData(idioma, now, { withTime: true }) ?? '' }))}</p>
    <p class="hint">${esc(t('receipt.printHint'))}</p>
  </footer>
</main>
</body>
</html>
`;
}

export default { receiptData, renderReceipt, esc, RECEIPT_CSP };
