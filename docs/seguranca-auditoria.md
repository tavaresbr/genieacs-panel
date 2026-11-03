# Auditoria de segurança do painel (rodada D, 2026-11)

Este documento registra a revisão de segurança feita sobre a `main` em `f9c4eab` (v1.20.0, última migração `0123_platform_nps`). Ele lista o que foi encontrado, o que foi corrigido nesta rodada e o que fica proposto para depois.

Nesta rodada só entraram correções de risco baixo: nenhuma migração e nenhuma mudança que tranque usuários existentes ou quebre integrações que já funcionam.

## 1. Escopo

| Área | Arquivos principais |
|---|---|
| Autenticação do painel e do console | `backend/src/middleware/auth.js`, `backend/src/controllers/authController.js`, `backend/src/services/mfaService.js`, `backend/src/models/AccountLockout.js`, `backend/src/models/AuthTicket.js`, `backend/src/config/login.js` |
| Portal do assinante | `backend/src/middleware/portalAuth.js`, `backend/src/services/customerPortalPasswordService.js`, `portalApp` em `backend/src/app.js` |
| Limitadores | `backend/src/middleware/rateLimit.js` e a montagem em `backend/src/app.js` |
| Cabeçalhos, CORS e CSP | `backend/src/app.js` (helmet, `isAllowedOrigin`, `portalOriginGuard`) |
| Uploads | anexos do WhatsApp (`waAttachmentService`, `sniffAttachment`), firmware (`firmwareStore`), branding (`platformBrandingService`) |
| Segredos em repouso | `backend/src/utils/secretBox.js`, `backend/src/config/runtimeEnv.js`, `secretRotationService` |
| Webhooks | `backend/src/controllers/billingWebhookController.js` (Asaas), `backend/src/utils/wa/waWebhookAuth.js` (Evolution), `backend/src/utils/webhookSignature.js` e `sgpEventController` (SGP) |
| SSRF e egresso | `backend/src/utils/net/*` (`blockedRanges`, `pinnedFetch`), `backend/src/utils/wa/ssrfGuard.js`, `backend/src/services/genieacsEgress.js` |
| Logs | `backend/src/utils/logger.js` (logger estruturado e `console` embrulhado) |
| LGPD | `customerDataExportService`, `customerErasureService`, `backend/src/config/retention.js` |
| Rotas públicas | a lista `PUBLICAS` de `backend/test/route-coverage.test.js` (34 rotas sem sessão) |
| Cadeia de entrega | `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml`, `Dockerfile` |

Ficaram fora desta rodada o agente do GenieACS (`backend/agent/`), a infraestrutura de quem hospeda (proxy, TLS, firewall, backups) e testes de intrusão dinâmicos.

## 2. Método

1. **Leitura dirigida do código.** Cada área da tabela foi lida procurando estes pontos:
   - falha de autenticação ou autorização;
   - oráculos de enumeração;
   - comparação de segredo fora de tempo constante;
   - falta de limite de taxa;
   - entrada que chega a rede, disco ou banco sem validação;
   - vazamento em log ou em resposta de erro.
2. **Conferência com os testes existentes.** Para cada ponto, verificamos se há um teste que prende o comportamento. Exemplos: `route-coverage.test.js` para as rotas públicas, `account-lockout.test.js`, `password-reset.test.js`, `sgp-events.test.js` e `observability.test.js`.
3. **Classificação de severidade:**
   - **Alta:** explorável sem credencial, com impacto em dados ou contas.
   - **Média:** exige uma pré-condição (sessão roubada, XSS, configuração errada) ou amplia muito o dano.
   - **Baixa:** endurecimento ou defesa em profundidade.
   - **Info:** registro de decisão, sem ação.
4. **Correção só do que é seguro.** O que muda contrato, sessão ou integração em produção ficou como proposta, com o desenho escrito (seção 5).

## 3. Achados

Os status possíveis são:
- **corrigido:** entrou nesta rodada, com teste;
- **proposto:** desenho na seção 4 ou 5, sem código;
- **aceito:** o risco é conhecido e a decisão é manter;
- **outra rodada:** entra em outra seção do plano.

| ID | Severidade | Área | Arquivo:linha | Descrição | Status |
|---|---|---|---|---|---|
| SEC-01 | Média | Autenticação | `backend/src/routes/auth.js:57` | `POST /api/auth/change-password` só tinha o `apiLimiter` genérico (300/min). A senha atual pedida ali é um oráculo para quem tem só o token. A trava por conta (`AccountLockout`) já contava os erros, mas não havia teto de custo: cada chamada roda um bcrypt. | **corrigido**: `passwordChangeLimiter`, com 20 chamadas a cada 15 min por pessoa, montado depois da sessão. O teto fica acima da trava de 10, para que quem esbarra nela continue recebendo a resposta da trava. |
| SEC-02 | Baixa | Autenticação | `backend/src/routes/auth.js:68` | `POST /api/auth/change-username` não tinha limitador. O 409 "nome em uso" é um oráculo sobre o espaço de logins da plataforma inteira, o mesmo do `emailChangeLimiter`. | **corrigido**: `usernameChangeLimiter`, com 10 chamadas a cada 15 min por pessoa. |
| SEC-03 | Média | Senhas | `backend/src/utils/passwordPolicy.js` e as rotas que escolhem senha | A senha só tinha regra de tamanho (8 a 128). Aceitava `password1`, `12345678` e a senha igual ao login. | **corrigido**: veja o detalhe abaixo da tabela. |
| SEC-04 | Média | Webhook SGP | `backend/src/services/sgpService.js:854` | A proteção contra repetição (carimbo de tempo assinado e recente) vinha desligada por padrão. A deduplicação (`sgpEventService.ingestWebhook`, pelo id do evento ou pelo hash do corpo) só vale enquanto a linha do evento existe. Depois da poda por `eventRetentionDays`, uma entrega capturada pode ser reenviada e reprocessada (desbloqueio, baixa). | **corrigido para integrações novas**: veja o detalhe abaixo da tabela. |
| SEC-05 | Média | CORS | `backend/src/app.js:98`, `backend/src/config/runtimeEnv.js` | Com `CORS_ORIGINS=*`, `isAllowedOrigin` deixa de checar a origem. Em produção, qualquer site aberto no navegador de um operador poderia chamar a API. | **corrigido**: em produção (`APP_ENV` ou `NODE_ENV=production`), o processo recusa subir com `*` e mostra uma mensagem clara. Em desenvolvimento nada muda. |
| SEC-06 | Baixa | CORS | `backend/src/app.js:162` | `isAllowedOrigin` aceita a origem cujo host é igual ao `Host` da requisição. É necessário para o modelo multi-provedor (subdomínio por ISP). Atrás de um proxy que reescreve o `Host`, a confiança passa a ser a do proxy. | **aceito**: documentado em `docs/saas-multi-tenant-plan.md`. A proteção real das rotas autenticadas é o `Authorization: Bearer`, que um site de fora não tem. |
| SEC-07 | Baixa | CSP | `backend/src/app.js:109` | `style-src` é o padrão do helmet (`'self' https: 'unsafe-inline'`). | **proposto**: veja a seção 4.1. Não dá para remover agora sem quebrar o mapa. |
| SEC-08 | Baixa | CSP | `backend/src/app.js:116` | `upgrade-insecure-requests` estava sempre desligado, porque o servidor embutido fala HTTP. | **corrigido (opt-in)**: `CSP_UPGRADE_INSECURE_REQUESTS=true` liga a diretiva para deploys atrás de proxy TLS. O padrão continua desligado para não deixar em branco o painel acessado por `http://IP:porta`. |
| SEC-09 | Média | Logs | `backend/src/utils/logger.js:141`, `:220` | A redação de log era parcial: só a query e o segmento do recibo. Um `console.error('…', err)` com um erro do axios imprimia `config.headers.Authorization`, o corpo enviado (`password`, `apikey`) e `response.data`. | **corrigido**: veja o detalhe abaixo da tabela. |
| SEC-10 | Baixa | CI | `.github/workflows/security.yml` | Não havia SAST nem varredura de segredos no CI. | **corrigido**: veja o detalhe abaixo da tabela. |
| SEC-11 | Baixa | JWT | `backend/src/middleware/auth.js:135`, `backend/src/middleware/portalAuth.js:140` | `jwt.verify` não fixava o algoritmo. O `jsonwebtoken` 9 já recusa `none` e algoritmos assimétricos quando recebe um segredo, mas a lista explícita é defesa em profundidade. | **corrigido**: `algorithms: ['HS256']`, o mesmo que o `jwt.sign` usa. |
| SEC-12 | Média | Sessão | `frontend/src/lib/api.ts:262` | O token de acesso e o refresh ficam no `localStorage`. Um XSS lê os dois, e o refresh vale 7 dias. | **proposto**: PR separado, desenho na seção 5. |
| SEC-13 | Média | Sessão | `backend/src/middleware/auth.js:15`, `backend/src/controllers/authController.js:1165` | O refresh dura 7 dias e cada renovação emite um refresh novo, mas o anterior continua válido até vencer. Não há detecção de reuso. O logout e a troca de senha derrubam tudo (`token_version`), mas um refresh vazado vive até o logout. | **proposto**: rotação com família e detecção de reuso, na seção 5. |
| SEC-14 | Baixa | Exposição | `backend/src/app.js:314`, `:630` | `/api/health` (painel e portal) devolve a versão exata. Isso facilita mirar uma versão vulnerável. | **outra rodada**: a seção C (página de status) remove a versão. |
| SEC-15 | Baixa | Webhook Evolution | `backend/src/utils/wa/waWebhookAuth.js:47` | O token do webhook pode chegar na query (`?t=`). O `requestLogger` corta a query, mas proxies reversos costumam logar a URL inteira. | **aceito**: é uma limitação da Evolution, e a comparação é em tempo constante. Recomendado: o proxy não logar a query nesse caminho. |
| SEC-16 | Baixa | Senhas | `backend/scripts/init-db.js:9` | `ADMIN_PASSWORD` do `init-db.js` não passa pela regra nova. | **aceito**: é usado por instaladores automatizados, e endurecer aqui poderia quebrar uma instalação desassistida. Recomendado: o instalador gerar a senha aleatória (o `install.sh` já gera os segredos) e a pessoa trocá-la pela tela, que aplica a regra. |
| SEC-17 | Info | Portal | `backend/src/services/customerPortalPasswordService.js:7` | As senhas do portal são geradas pela máquina: 10 símbolos de um alfabeto de 32, cerca de 50 bits. O limite de login é por cliente e IP (`portalLoginLimiter`). | **aceito**: a entropia torna inútil a força bruta distribuída. Não há senha escolhida por pessoa no portal, então a regra de SEC-03 não se aplica. |
| SEC-18 | Info | Webhook Asaas | `backend/src/controllers/billingWebhookController.js:331` | O token `asaas-access-token` é comparado em tempo constante (SHA-256 e `timingSafeEqual`). Sem token configurado, a rota recusa. A idempotência é por evento. | ok |
| SEC-19 | Info | SSRF | `backend/src/utils/net/blockedRanges.js`, `backend/src/utils/net/pinnedFetch.js`, `backend/src/utils/wa/ssrfGuard.js` | Faixas privadas, loopback e link-local são bloqueadas. O DNS é resolvido uma vez e fixado na conexão (anti-rebinding). O GenieACS tem uma regra própria de egresso por deploy (`genieacsEgress.js`). | ok |
| SEC-20 | Info | Segredos | `backend/src/utils/secretBox.js:90` | AES-256-GCM com chave versionada e rotação (`secretRotationService`). Em produção, os segredos de exemplo são recusados (`assertNotPlaceholderSecret`) e o `JWT_SECRET` precisa ter 32 ou mais caracteres. | ok |
| SEC-21 | Info | Uploads | `backend/src/app.js` (parsers `raw` reservados), `waAttachmentService.js:47` | O limitador é montado antes de o corpo ser lido. Há teto por rota (16 MB para anexo e 64 MB para firmware), lista de tipos permitidos e conferência por assinatura do conteúdo (`sniffAttachment`). | ok |
| SEC-22 | Info | CSV | `backend/src/utils/csv.js:16` | O CSV exportado neutraliza fórmulas (`=`, `+`, `-`, `@` no início). | ok |
| SEC-23 | Info | LGPD | `customerDataExportService.js`, `customerErasureService.js`, `config/retention.js` | Há exportação por titular, apagamento com trilha e prazos de retenção registrados num único lugar, com documentação gerada e teste (`retention-registry.test.js`). | ok |
| SEC-24 | Info | Rotas públicas | `backend/test/route-coverage.test.js:48` | Todas as 34 rotas sem sessão estão declaradas com o motivo. Toda rota pública de escrita tem limitador próprio ou credencial no corpo, e o teste falha se aparecer uma nova sem declaração. | ok |
| SEC-25 | Baixa | Cadeia de entrega | `.github/dependabot.yml` | O Dependabot já cobre actions, npm e Docker, com as actions fixadas por SHA. Falta um `npm audit` no CI. | **proposto**: um job `npm audit --omit=dev --audit-level=high`, não bloqueante, junto da varredura de SEC-10. |

**Detalhe de SEC-03 (política de senha):**
- mínimo de 10 caracteres para senha **nova**;
- lista embutida das senhas mais comuns com 10 ou mais caracteres (as menores já caem no tamanho), além de sequências e caractere repetido;
- recusa da senha igual ao usuário, ao e-mail ou à parte do e-mail antes do `@`.

A regra vale no cadastro (signup), na instalação (setup), na criação e edição de operador, na criação e edição de membro pelo console, no aceite de convite **de quem ainda não tem conta**, na troca de senha, na redefinição e nos scripts `reset-password` e `grant-platform-admin`. O **login não muda**: senhas antigas de 8 ou 9 caracteres continuam entrando, e a senha atual pedida na troca é aceita como estiver. As mensagens estão nos 13 idiomas, com códigos estáveis: `password_length`, `password_too_common` e `password_matches_identity`.

**Detalhe de SEC-04 (repetição no webhook do SGP):**
- `webhookRequireTimestamp` passa a valer `true` quando não há configuração gravada, ou seja, numa integração nova;
- configuração gravada sem o campo (anterior à exigência) é lida como `false`;
- configuração gravada com o campo explícito é respeitada.

Ver a seção 4.2.

**Detalhe de SEC-09 (redação de logs):** `redactSecrets` e `redactText` trabalham em duas frentes:
- **por nome de campo:** `authorization`, `cookie`, `token`, `apikey`, `password`, `senha`, `secret`, chave Pix, assinaturas de webhook etc.;
- **por forma, dentro de texto:** `Bearer …`, `chave=valor` e `"chave":"valor"`.

A redação é aplicada nos campos e no erro do logger estruturado e em cada argumento do `console` embrulhado no arranque. O original nunca é alterado.

**Detalhe de SEC-10 (segredos e SAST no CI):** o workflow novo `Security` traz dois jobs:
- gitleaks (`gitleaks/gitleaks-action`, sobre o histórico inteiro);
- CodeQL `javascript-typescript` com `security-extended`.

As duas actions estão fixadas por SHA. Os jobs são **não bloqueantes** (`continue-on-error`) até a primeira triagem. O `ci.yml` não foi alterado.

## 4. Detalhes das correções e decisões

### 4.1 CSP: por que o `style-src` continua com `'unsafe-inline'`

Os `style={…}` do React **não** dependem de `'unsafe-inline'`: o React aplica o estilo pelo CSSOM (`element.style`), e a CSP não bloqueia isso. O que depende são os **atributos `style="…"` em HTML montado como texto**:

- os marcadores do mapa (`L.divIcon({ html })`) em `frontend/src/pages/network-map.tsx:768` e `frontend/src/components/location-picker.tsx:17`;
- as dicas `bindTooltip` com `<strong style=…>`;
- o `<style>` embutido de `frontend/public/whatsapp-signup.html`.

Sem `'unsafe-inline'` (ou `style-src-attr 'unsafe-inline'`), os marcadores do mapa somem. Por isso a diretiva ficou como estava.

Caminho para remover depois:
1. Trocar os estilos inline dos marcadores por classes CSS. As cores dinâmicas viram variáveis CSS aplicadas pelo CSSOM depois que o Leaflet cria o elemento (`marker.getElement().style.setProperty('--cor', …)`), ou classes por estado.
2. Mover o `<style>` de `whatsapp-signup.html` para um `.css` externo.
3. Trocar o `style-src` por `'self'` (e tirar o `https:`, que hoje aceita folha de estilo de qualquer host HTTPS). Para o caso de escapar algum ponto, manter por um ciclo `style-src-attr 'unsafe-inline'` separado de `style-src-elem 'self'`.
4. Conferir no e2e (`npm run e2e`) o mapa, o seletor de localização e a página do Embedded Signup.

### 4.2 Proteção contra repetição do SGP: como ligar nas integrações antigas

Integrações já configuradas **não mudam**: quem já recebe eventos continua recebendo. Para ligar a proteção numa delas:

1. Confirme que o SGP manda o cabeçalho de carimbo de tempo (`X-SGP-Timestamp` ou equivalente) e que assina `<timestamp>.<corpo>` ou só o corpo. Os formatos aceitos estão em `docs/sgp-integration.md`.
2. Em **Configurações → Integração SGP → Eventos e reconciliação**, ligue **Exigir carimbo de tempo assinado**. A tolerância padrão é de 300 s e é configurável entre 30 e 3600.
3. Faça uma entrega de teste. Se voltar 401, o log do painel mostra `Rejected an SGP webhook delivery: missing_timestamp` (ou `stale_timestamp`). Se o SGP não envia o carimbo, desligue de novo.

Pela API, o mesmo resultado sai de `PUT /api/sgp/config` com `{ "webhookRequireTimestamp": true }`.

Uma integração **nova** já nasce exigindo o carimbo. Se o SGP daquele provedor não envia o cabeçalho, as entregas voltam 401 até a opção ser desligada na mesma tela. A tabela de solução de problemas de `docs/sgp-integration.md` já cobre esse sintoma.

### 4.3 O que a política de senha não faz, de propósito

- **Não força a troca de quem já tem senha curta.** Isso trancaria gente sem aviso. Se for desejado, o caminho é marcar no login (sem bloquear) quem entrou com uma senha fora da regra e mostrar um aviso para trocar, num PR próprio.
- **Não exige "maiúscula, número e símbolo".** Regras de composição empurram para `Senha@123`. O mínimo de 10 caracteres com a lista das comuns segue a NIST SP 800-63B.
- **Não consulta serviços externos de senhas vazadas** (k-anonymity do HIBP). Seria uma dependência de rede no caminho do cadastro. Pode entrar como opção desligada por padrão.

### 4.4 Push: um aparelho inscrito de novo, noutro provedor, passa para o provedor atual

O endpoint de push é **um aparelho** (um navegador), e não uma conta. Em `PushService.subscribe`, uma inscrição com um endpoint que já existe apaga a linha antiga, **em qualquer provedor e de qualquer pessoa** (`runUnscoped`, pelo `endpoint_hash`), e grava a nova no provedor e na pessoa da sessão atual. Na prática:

- quem usa o mesmo navegador em dois provedores (ou entrega o celular a outra pessoa) passa a receber só os avisos da sessão que se inscreveu por último. O provedor anterior perde o aparelho sem aviso, e a pessoa anterior para de receber;
- é de propósito: um celular passado de mão em mão não pode continuar recebendo avisos do dono anterior, e duas linhas com o mesmo endpoint mandariam avisos de dois provedores para o mesmo aparelho;
- não é um vazamento entre provedores: só quem tem a inscrição do navegador (endpoint e chaves, que só a página daquela origem lê) consegue movê-la, e a linha antiga é apagada, não lida;
- para voltar a receber os avisos do provedor anterior, basta reativar as notificações numa sessão dele. A linha volta para lá.

Prova em `backend/test/push-notifications.test.js`.

## 5. Proposta (PR separado): tokens em cookie httpOnly com rotação do refresh

**Decisão do usuário: só o desenho entra agora, a implementação vai num PR separado.**

**Implementado na migração `0129_refresh_tokens`**, com estas diferenças em relação ao desenho abaixo:

- O prefixo do cookie em HTTPS é `__Secure-` (`__Secure-skg_rt`), e não `__Host-`. O navegador só aceita `__Host-` com `Path=/`, e o `Path=/api/auth` é a metade da proteção que importa. Sem `Domain`, o cookie continua preso ao host.
- O console tem o próprio cookie (`skg_crt` / `__Secure-skg_crt`) com `Path=/api/auth/console` e rotas próprias: `POST /api/auth/console/refresh` e `/console/logout`.
- O sucessor de cada refresh é o HMAC do anterior com uma chave do servidor. É isso que deixa a folga de 10 s devolver o MESMO sucessor à aba atrasada sem guardar valor em claro.
- O token de acesso leva o `sid` (a família), e a hidratação confere que a família está viva. "Sair" e "Encerrar" valem na próxima requisição, e não só quando os 15 minutos acabam.
- "Sair" encerra só este aparelho. "Sair de todos" (`POST /api/auth/sessions/revoke-all`) sobe o `token_version` e revoga todas as famílias. A tela "Sessões ativas" fica em Configurações › Acesso da conta.
- O refresh responde 401 a toda recusa e tem um limite próprio (`refreshLimiter`), mais folgado que o do login.
- **A folga de 10 s (`REFRESH_GRACE_MS`) é idempotente.** Reenviar o token já girado dentro dela — duas abas juntas, ou a resposta que se perdeu e o navegador tentou de novo com o cookie antigo — devolve o sucessor atual da família: nada é revogado, nenhum galho novo é aberto e nenhuma linha de reuso vai para a trilha. Depois da folga é reuso: a família cai e o `SESSION_REFRESH_REUSE` é gravado.
- **O refresh antigo (JWT no corpo, de antes da 0129)** é convertido uma vez numa família com **teto** (`family_expires_at`): o `exp` do próprio JWT. A conversão não ganha sete dias novos e nenhuma rotação seguinte passa do teto. A linha do JWT fica até o teto vencer, mesmo revogada, e é ela que faz o mesmo JWT ser recusado em vez de convertido de novo. "Sair" de uma sessão convertida (ou com um token de acesso sem `sid`) sobe o `token_version`, como o "Sair" de antes: é a única coisa que derruba o JWT sem estado. O custo, uma vez na transição, é sair de todos os aparelhos.
- `JWT_EXPIRES_IN=15m` no `install.sh`, no `deploy/saas.env.example` e no `backend/.env.example`. Um `.env` antigo com `1h` deve ser corrigido à mão.
- Prova em `backend/test/session-cookies.test.js` e `frontend/e2e/session.spec.ts`.

### Problema

- O `localStorage` (`frontend/src/lib/api.ts:262`) é legível por qualquer script da origem. Um XSS, mesmo bloqueado em parte pela CSP de `script-src 'self'`, leva o token de acesso e o refresh de 7 dias.
- Hoje cada renovação emite um refresh novo sem invalidar o anterior, então um refresh vazado continua valendo em paralelo.

### Desenho

1. **Cookie do refresh.** O nome é `__Host-skg_rt` quando a requisição é HTTPS e `skg_rt` em HTTP, para não quebrar o deploy por `http://IP:porta`.
   - Atributos: `HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=7d`.
   - O `Path` restrito faz o cookie só viajar para `/api/auth/refresh` e `/api/auth/logout`.
2. **Token de acesso só em memória**, numa variável do módulo `api.ts`, com vida curta: 15 minutos em vez de 1 hora. Ao recarregar a página, o frontend chama `POST /api/auth/refresh` logo no início. O cookie autentica, a resposta traz o token de acesso, e o `Authorization: Bearer` continua como hoje. Como não há cookie de **acesso**, as rotas autenticadas continuam imunes a CSRF.
3. **Rotação com família e detecção de reuso.** Uma tabela nova, `refresh_tokens` (será **migração**, com número reservado no PR), guarda:

   | Campo | Conteúdo |
   |---|---|
   | `id` | identificador do refresh |
   | `family_id` | a família de rotações a que ele pertence |
   | `user_id`, `tenant_id`, `audience` | dono e escopo da sessão |
   | `token_hash` | SHA-256 do valor do refresh |
   | `expires_at` | vencimento |
   | `rotated_at` | quando foi trocado por um novo |
   | `revoked_at` | quando foi revogado |
   | `user_agent`, `ip` | contexto, para a lista de sessões |

   - A cada `/refresh`, o refresh apresentado é marcado `rotated_at` e um novo da mesma família é emitido, num `UPDATE` condicional, como em `AuthTicket.redeem`.
   - Se um refresh **já rotacionado** for apresentado, há reuso: a família inteira é revogada, um `AuditLog` (`SESSION_REFRESH_REUSE`) é gravado e a resposta é 401.
   - Uma janela de tolerância de cerca de 10 s cobre duas abas renovando juntas.
4. **CSRF no `/refresh` e no `/logout`**, que passam a autenticar por cookie:
   - `SameSite=Strict`;
   - checagem de `Origin`/`Sec-Fetch-Site`, igual ao `portalOriginGuard`;
   - cabeçalho próprio obrigatório (`X-Requested-With: skygenpanel`), que um formulário de fora não consegue mandar.
5. **Logout** revoga a família da sessão atual e limpa o cookie. O "sair de todos os dispositivos" continua sendo o `token_version`.
6. **Console da plataforma e personificação:**
   - o console usa o mesmo esquema, com outra audiência e outro `Path`;
   - a personificação continua **sem** refresh (30 min).
7. **Migração suave:**
   - durante uma versão, `/refresh` aceita o refresh no corpo (cliente antigo em cache) **e** no cookie;
   - o frontend novo apaga `token` e `refreshToken` do `localStorage` na primeira carga;
   - na versão seguinte, o corpo deixa de ser aceito.
8. **Testes:**
   - rotação emite um token novo e o antigo vira reuso, que revoga a família;
   - duas abas dentro da janela não revogam nada;
   - cookie ausente dá 401;
   - origem de fora em `/refresh` dá 403;
   - logout revoga a família;
   - o e2e recarrega a página e continua logado.

### Riscos e custos

- Precisa de migração e muda o contrato do `/refresh`. Por isso fica fora desta rodada.
- Deploys em HTTP puro ficam com cookie sem `Secure`, o mesmo nível de hoje, mas fora do alcance de scripts.
- Integrações que usam a API com token, e não o navegador, não mudam: o `Authorization: Bearer` continua.

## 6. Recomendações (próximos passos, por prioridade)

1. **Tokens em cookie httpOnly com rotação** (seção 5, SEC-12 e SEC-13).
2. **Tornar bloqueantes o gitleaks e o CodeQL** depois da triagem do primeiro lote (SEC-10). Se houver falsos positivos em fixtures de teste, criar um `.gitleaks.toml` com uma allowlist restrita a `backend/test/`.
3. **Tirar o `'unsafe-inline'` do `style-src`** pelo caminho da seção 4.1 (SEC-07).
4. **`npm audit` no CI**, não bloqueante no início (SEC-25).
5. **Tirar a versão do `/api/health`**, a cargo da seção C (SEC-14).
6. **Ligar `CSP_UPGRADE_INSECURE_REQUESTS=true`** no SaaS e em todo deploy atrás de TLS (SEC-08), e incluir a variável no `deploy/saas.env.example` na próxima revisão de deploy.
7. **Aviso de "senha fora da regra" no login**, sem bloquear, para incentivar a troca das senhas antigas (seção 4.3).
8. **Proxy:** não logar a query de `/api/whatsapp-webhook` (SEC-15).

## 7. Como verificar

```bash
npm run verify                                # backend + frontend completos
cd backend && node --test test/password-policy.test.js test/log-redaction.test.js \
  test/sgp-events.test.js test/password-reset.test.js test/reset-password-script.test.js
APP_ENV=production CORS_ORIGINS='*' JWT_SECRET=$(openssl rand -hex 32) node backend/src/server.js
# → Error: CORS_ORIGINS='*' is not allowed in production: …
```
