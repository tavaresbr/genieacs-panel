import { currentTenantId } from '../../config/tenantContext.js';
import DirectConnector from './direct.js';

/**
 * Por onde o painel fala com o GenieACS daquele provedor.
 *
 * Até aqui `DeviceService` montava a URL, escolhia os headers, abria o
 * `AbortController`, pegava a vaga de concorrência e chamava o egresso — **em
 * sete lugares**, cada um repetindo os cinco passos. Repetição de cinco passos
 * em sete lugares não é estilo: é a oitava chamada nascendo sem um deles, e a
 * onda 19 já mostrou qual (a credencial, que some em silêncio porque um ACS sem
 * autenticação aceita a requisição do mesmo jeito).
 *
 * O que muda de fato é outra coisa, e é o motivo de a Fase 4 pedir isto antes
 * de qualquer segundo modo: **`DeviceService` deixa de saber que existe URL.**
 * Ele pede um caminho ao conector do provedor; como aquele caminho chega ao ACS
 * — HTTP direto, um agente que abriu WebSocket de saída, um túnel, uma
 * instância que nós hospedamos — é problema do conector. Sem essa separação,
 * cada modo novo seria um `if` a mais nos sete lugares.
 *
 * ## O que NÃO tem, e por quê
 *
 * O plano previa uma tabela `tenant_genieacs_connections` com `mode`,
 * `verify_tls`, `allow_private_ranges`, `status` e `last_check_at`. Ela não
 * entra aqui, e a diferença é deliberada: hoje `mode` só poderia valer
 * `'direct'`, e `allow_private_ranges` não teria leitor — a decisão de faixa
 * privada é da edição, em `genieacsEgress`. Uma tabela cujas colunas nenhum
 * código lê é generalização especulativa com custo de migração num produto em
 * produção, e o dia em que o segundo modo existir é o dia em que aquelas
 * colunas passam a significar alguma coisa.
 *
 * O que ESTE arquivo entrega é a fronteira. Trocar a origem da configuração
 * — de `settings`/`app_state` para uma tabela — passa a ser mudança de uma
 * função (`connectorFor`), e não dos sete lugares de novo.
 */

/**
 * O conector do provedor em escopo.
 *
 * Assíncrono desde já, ainda que hoje não precise: quando o modo vier de uma
 * linha do banco, esta função lê o banco, e uma assinatura que muda de síncrona
 * para assíncrona muda todo mundo que a chama. O custo de já ser assíncrona é
 * zero; o de virar assíncrona depois é o refactor inteiro outra vez.
 */
export async function connectorFor() {
  // Chamado fora de escopo, isto lança — e lançar é certo. Um conector sem
  // provedor é uma requisição ao ACS de ninguém, que é exatamente o que a
  // tenancy existe para impedir.
  currentTenantId();
  return DirectConnector;
}

export { DirectConnector };
