import { PRODUCT_NAME } from '../config/brand.js';

/**
 * O que a vitrine pública diz de si mesma, para quem a lê sem executar
 * JavaScript: buscadores, pré-visualização de links e os robôs de IA que
 * respondem perguntas citando páginas.
 *
 * É o mesmo texto da vitrine em português (`frontend/src/components/landing/
 * content.ts`), repetido aqui de propósito: a vitrine é uma SPA e o servidor
 * não importa código do frontend. `test/seo-head.test.js` lê o `content.ts` e
 * reprova se as perguntas, as respostas ou os recursos daqui divergirem dele.
 */

export const SITE_NAME = PRODUCT_NAME;
export const SITE_LOCALE = 'pt-BR';
export const SITE_TAGLINE = 'Gestão TR-069 para provedores de internet: ACS, painel, portal do assinante e WhatsApp.';

/** Título e descrição de cada página pública; `noindex` é página que só serve a quem já chegou. */
export const SEO_PAGES = Object.freeze({
  '/': {
    title: `${PRODUCT_NAME} · Gestão TR-069 para provedores de internet`,
    description: 'Plataforma completa de gestão TR-069 para provedores: ACS, painel de operações, portal do assinante e integração com SGP e WhatsApp. Pronta em 24 horas, sem obra na sua rede.',
    heading: 'Gerencie os roteadores dos seus assinantes sem rolar caminhão'
  },
  '/signup': {
    title: `Criar conta · ${PRODUCT_NAME}`,
    description: `Cadastre o seu provedor no ${PRODUCT_NAME} em 2 minutos e use a plataforma completa durante o período de teste, sem fidelidade.`,
    heading: 'Criar conta'
  },
  '/privacidade': {
    title: `Política de privacidade · ${PRODUCT_NAME}`,
    description: `Como o ${PRODUCT_NAME} trata dados pessoais, para que servem e quais são os direitos do titular (LGPD).`,
    heading: 'Política de privacidade'
  },
  '/login': { noindex: true }
});

export const FEATURES = Object.freeze([
  { title: 'ACS TR-069 gerenciado', text: 'GenieACS hospedado e monitorado por nós. Você aponta as ONTs e começa a operar.' },
  { title: 'Painel do operador', text: 'Sinal óptico, Wi-Fi, WAN, reboot, reset e troca de equipamento a um clique, com histórico e trilha de auditoria.' },
  { title: 'Portal do assinante', text: 'O cliente troca a senha do Wi-Fi, vê a fatura e desbloqueia a conexão sozinho.' },
  { title: 'Integração com SGP', text: 'Contratos, planos e bloqueios sincronizados. Provisionamento automático por plano.' },
  { title: 'WhatsApp integrado', text: 'Alertas de queda, cobrança e atendimento pelo mesmo número, com bot e caixa de conversas.' },
  { title: 'Mapa da rede', text: 'Veja CTOs, clientes e quedas no mapa e descubra em segundos o que foi afetado.' }
]);

export const STEPS = Object.freeze([
  { title: 'Escolha o plano', text: 'Cadastre seu provedor em 2 minutos e ganhe o período de teste.' },
  { title: 'Aponte as ONTs', text: 'Configure a URL do ACS no seu provisionamento ou na OLT. Sem obra na rede.' },
  { title: 'Conecte o SGP e o WhatsApp', text: 'Integre seu ERP e seu número para automatizar o suporte.' },
  { title: 'Opere de qualquer lugar', text: 'Resolva pelo painel o que antes pedia visita técnica.' }
]);

export const VENDORS = Object.freeze(['Nokia', 'ZTE', 'Huawei', 'Fiberhome', 'Intelbras', 'TP-Link', 'Parks']);

export const FAQ = Object.freeze([
  { q: 'Preciso instalar alguma coisa no meu servidor?', a: 'Não. O ACS e o painel rodam na nossa infraestrutura. Você só aponta as ONTs para o endereço do ACS.' },
  { q: 'Quais marcas de ONT e roteador são compatíveis?', a: 'Qualquer equipamento com TR-069: Nokia, ZTE, Huawei, Fiberhome, Intelbras, TP-Link, Parks e outros. Mantemos um catálogo de parâmetros por fabricante.' },
  { q: 'Como funciona o período de teste?', a: 'Você usa a plataforma completa durante o teste. Ao final, a cobrança é gerada por PIX ou boleto e o painel continua funcionando após o pagamento.' },
  { q: 'Funciona com o meu SGP?', a: 'Temos integração nativa com o SGP: contratos, planos, bloqueio e desbloqueio. Para outros ERPs, fale com a gente.' },
  { q: 'Posso trocar de plano depois?', a: 'Sim, a qualquer momento, pelo próprio painel. A mudança vale a partir do próximo ciclo.' }
]);
