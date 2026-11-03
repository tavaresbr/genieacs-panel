/**
 * O mínimo da senha NOVA, o mesmo de `backend/src/utils/passwordPolicy.js`.
 *
 * A tela só confere o tamanho, para avisar antes de ir ao servidor; a lista
 * das senhas comuns e a comparação com o login ficam no backend, que responde
 * com a mensagem já traduzida (`password_too_common`,
 * `password_matches_identity`). O login não usa isto: senhas antigas de 8
 * caracteres continuam entrando.
 */
export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_LENGTH = 128
