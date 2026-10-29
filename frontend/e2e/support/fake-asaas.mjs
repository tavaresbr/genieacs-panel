import http from 'node:http';

/**
 * Um Asaas de mentira para os testes no navegador.
 *
 * O painel só fala com o gateway pelo servidor, então o navegador não precisa
 * saber disto: o backend do e2e sobe com `ASAAS_BASE_URL` apontado para cá (e
 * com `allow-fake-asaas.mjs`, que deixa ESTE endereço passar pela guarda de
 * rede da edição SaaS).
 *
 * Sem estado de verdade, ao contrário de `backend/test/helpers/asaasSandboxMock.js`:
 * as cobranças do seed (`backend/scripts/seed-demo.js`) nunca foram criadas
 * aqui, e a segunda via lê justamente uma delas. A situação sai do próprio id —
 * `_paid_` é paga, o resto está em aberto —, e o que o painel mudar
 * (vencimento empurrado pelo "Dar prazo") fica guardado por id.
 *
 * Responde também o que o agendador do backend pode pedir enquanto o teste
 * roda (criar cliente, criar cobrança, listar), para que um minuto a mais de
 * relógio não vire um erro no log que ninguém pediu.
 */

// 1×1 transparente: o QR do Pix só precisa ser uma imagem que carrega.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const FAKE_PIX_PAYLOAD = '00020101021226820014br.gov.bcb.pix2560pix.e2e.test/qr/v2/demo5204000053039865406199.005802BR';
export const FAKE_BOLETO_LINE = '23793381286000000000300000000401184340000019900';

const hoje = () => new Date().toISOString().slice(0, 10);

/**
 * @param {{ apiKey: string }} opcoes
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: Array<{ method: string, path: string }> }>}
 */
export async function startFakeAsaas({ apiKey }) {
  const requests = [];
  /** O que o painel mudou numa cobrança (vencimento, valor), por id. */
  const mudancas = new Map();
  let seq = 0;

  const pagamento = (id) => ({
    object: 'payment',
    id,
    status: id.includes('_paid_') ? 'RECEIVED' : id.includes('overdue') ? 'OVERDUE' : 'PENDING',
    value: 199,
    billingType: 'UNDEFINED',
    dueDate: hoje(),
    invoiceUrl: `https://sandbox.asaas.test/i/${id}`,
    bankSlipUrl: `https://sandbox.asaas.test/b/${id}.pdf`,
    ...mudancas.get(id)
  });

  const server = http.createServer((req, res) => {
    let bruto = '';
    req.on('data', (parte) => { bruto += parte; });
    req.on('end', () => {
      let payload = null;
      try { payload = bruto ? JSON.parse(bruto) : null; } catch { payload = null; }
      const caminho = req.url.split('?')[0];
      requests.push({ method: req.method, path: caminho });
      const responder = (status, corpo) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (req.headers.access_token !== apiKey) {
        return responder(401, { errors: [{ code: 'invalid_access_token', description: 'chave errada' }] });
      }

      const umPagamento = /^\/payments\/([^/]+)(?:\/(pixQrCode|identificationField))?$/.exec(caminho);
      if (umPagamento) {
        const id = decodeURIComponent(umPagamento[1]);
        if (req.method === 'GET' && umPagamento[2] === 'pixQrCode') {
          return responder(200, { encodedImage: PNG, payload: FAKE_PIX_PAYLOAD, expirationDate: `${hoje()} 23:59:59` });
        }
        if (req.method === 'GET' && umPagamento[2] === 'identificationField') {
          return responder(200, { identificationField: FAKE_BOLETO_LINE, nossoNumero: '6543', barCode: '23799840000019900' });
        }
        if (req.method === 'GET') return responder(200, pagamento(id));
        if (req.method === 'POST') {
          const patch = {};
          if (payload?.dueDate) patch.dueDate = payload.dueDate;
          if (payload?.value !== undefined) patch.value = payload.value;
          mudancas.set(id, { ...mudancas.get(id), ...patch });
          return responder(200, pagamento(id));
        }
        if (req.method === 'DELETE') return responder(200, { deleted: true, id });
      }

      if (req.method === 'POST' && caminho === '/payments') {
        seq += 1;
        const id = `pay_fake_${String(seq).padStart(4, '0')}`;
        mudancas.set(id, { value: payload?.value ?? 0, dueDate: payload?.dueDate ?? hoje() });
        return responder(200, pagamento(id));
      }
      if (req.method === 'POST' && caminho === '/customers') {
        seq += 1;
        return responder(200, { object: 'customer', id: `cus_fake_${seq}`, ...payload, deleted: false });
      }
      const umCliente = /^\/customers\/([^/]+)$/.exec(caminho);
      if (umCliente && req.method === 'GET') {
        return responder(200, { object: 'customer', id: decodeURIComponent(umCliente[1]), deleted: false });
      }
      if (req.method === 'GET' && ['/payments', '/customers', '/invoices'].includes(caminho)) {
        return responder(200, { object: 'list', hasMore: false, totalCount: 0, limit: 100, offset: 0, data: [] });
      }
      if (req.method === 'GET' && caminho === '/myAccount/commercialInfo') {
        return responder(200, { companyName: 'Asaas de mentira (e2e)' });
      }
      return responder(404, { errors: [{ code: 'not_found', description: `${req.method} ${caminho} não existe no Asaas do e2e` }] });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
