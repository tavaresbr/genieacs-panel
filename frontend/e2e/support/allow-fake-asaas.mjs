import { PinnedTransport, bareHostname } from '../../../backend/src/utils/net/pinnedFetch.js';

/**
 * Pré-carregado no backend do e2e (`node --import`), e só nele.
 *
 * Na edição SaaS o cliente do Asaas recusa endereço privado (`asaasClient.js`,
 * `allowPrivateAddresses: !deploymentIsShared()`), e o Asaas de mentira do
 * e2e mora em `127.0.0.1`. Em vez de abrir uma exceção no código que vai para
 * produção, este arquivo — que nunca é carregado fora daqui — deixa passar UM
 * host: o de `ASAAS_BASE_URL`. Qualquer outro destino segue pela guarda de
 * sempre.
 *
 * É o mesmo módulo que o backend importa (mesmo caminho, mesma instância), então
 * trocar o método estático aqui vale para o `asaasClient` também.
 */
if (process.env.APP_ENV !== 'test') {
  throw new Error('allow-fake-asaas.mjs only loads with APP_ENV=test');
}
const base = process.env.ASAAS_BASE_URL;
if (!base) throw new Error('allow-fake-asaas.mjs needs ASAAS_BASE_URL');
const permitido = bareHostname(new URL(base).hostname);

const original = PinnedTransport.vetTarget;
PinnedTransport.vetTarget = function vetTargetE2e(hostname, opcoes = {}) {
  if (bareHostname(hostname) === permitido) {
    return original.call(this, hostname, { ...opcoes, allowPrivateAddresses: true });
  }
  return original.call(this, hostname, opcoes);
};
