/**
 * O caminho do webhook da conta Asaas DO PROVEDOR, numa constante.
 *
 * Pelo mesmo motivo de `BILLING_WEBHOOK_PATH` e `WA_WEBHOOK_PATH`: quem monta a
 * rota e quem mostra o endereço na tela de configuração saem do mesmo lugar.
 *
 * Fora de `/api/asaas`, que é o prefixo das rotas AUTENTICADAS desta conta: uma
 * rota pública sob um prefixo autenticado é o tipo de vizinhança que um
 * `app.use` reordenado desfaz sem avisar. E sem `:parâmetro`: o provedor a quem
 * a entrega pertence sai do TOKEN, não do caminho.
 */
export const ASAAS_WEBHOOK_PATH = '/api/asaas-webhook';

export default ASAAS_WEBHOOK_PATH;
