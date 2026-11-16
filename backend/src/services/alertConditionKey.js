/**
 * Chave de uma condição de alerta (`regra` + `assunto`) nos mapas `firing` e
 * `unknown` da varredura. Mora num módulo próprio porque o `waAlertService`
 * monta as chaves e o `outageIncidentService` as consulta: com uma cópia do
 * formato em cada lado, as duas pontas já divergiram (um incidente cuja caixa
 * entrou em manutenção era lido como resolvido, e o cliente recebia
 * "normalizado" ainda sem serviço).
 */
// The separator is escaped, not typed. A literal NUL in the source makes git
// treat this file as BINARY: it then refuses to merge it and silently keeps
// one side, which is how a merge quietly drops the other side's changes.
export const conditionKey = (rule, subject) => `${rule}\u0000${subject}`;
