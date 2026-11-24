/*
 * Embedded Signup da Meta (WhatsApp oficial). Esta página roda no domínio
 * cadastrado no app da Meta (tr69.com.br), que NÃO é o do painel do provedor;
 * o painel a abre num popup (`window.open`) e recebe o resultado por
 * `postMessage`. O SDK recusa o FB.login com "domain not allowed" em qualquer
 * outro domínio.
 *
 * Dois modos, pela URL:
 *
 *  - Painel: `?app=…&config=…&state=…&return=<origem do painel>[&mode=coexistence]`.
 *    Devolve ao painel `{ type, state, event, code, wabaId, phoneNumberId, businessId }`
 *    e fecha. O `code` NÃO é mostrado na tela. O painel o entrega ao servidor,
 *    que o troca pelo token — o segredo do app nunca passa por aqui.
 *  - Diagnóstico: `?app=…&config=…` sem `state`/`return`. Mostra os ids na tela,
 *    como a página sempre fez, para quem confere o cadastro à mão.
 *
 * `app`, `config` e `state` são validados por formato; `return` tem de ser uma
 * ORIGEM (https, ou http em localhost), sem caminho nem credencial — é o
 * `targetOrigin` do postMessage, e `*` entregaria o `code` a qualquer janela.
 * O `code` sozinho não vale nada sem o segredo do app e sem o `state`, que o
 * servidor consome uma única vez.
 *
 * Arquivo clássico (não módulo) e sem nada inline no HTML: a CSP do painel
 * mantém `script-src-attr 'none'`, então o clique é ligado aqui, por
 * `addEventListener`, e não por `onclick=`.
 */
(function () {
  'use strict';

  var GRAPH_VERSION = 'v25.0';
  var MESSAGE_TYPE = 'wa-embedded-signup';
  var COEXISTENCE_EVENT = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
  // Só a Meta de verdade: `endsWith('facebook.com')` aceitaria `evilfacebook.com`.
  var FACEBOOK_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?facebook\.com$/;
  var ID_PATTERN = /^\d{5,32}$/;
  var STATE_PATTERN = /^[a-f0-9]{64}$/;
  // O callback do FB.login pode chegar antes da mensagem do popup; espera um pouco.
  var CANCEL_GRACE_MS = 1500;

  var btn = document.getElementById('btn');
  var statusEl = document.getElementById('status');
  var resultEl = document.getElementById('result');
  var rawEl = document.getElementById('raw');
  var rawPre = document.getElementById('rawpre');
  var params = new URLSearchParams(window.location.search);

  var appId = params.get('app') || '';
  var configId = params.get('config') || '';
  var state = params.get('state') || '';
  var returnOrigin = cleanOrigin(params.get('return'));
  var coexistence = params.get('mode') === 'coexistence';
  var panelMode = Boolean(state || params.get('return'));
  var captured = {};
  var sent = false;

  /** `https://painel.exemplo.com` → ela mesma; qualquer outra coisa → ''. */
  function cleanOrigin(value) {
    if (!value) return '';
    var url;
    try {
      url = new URL(value);
    } catch (e) {
      return '';
    }
    var local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return '';
    if (url.username || url.password) return '';
    if (FACEBOOK_ORIGIN.test(url.origin)) return '';
    return url.origin === value ? url.origin : '';
  }

  function setStatus(msg, cls) {
    statusEl.className = cls || '';
    statusEl.textContent = msg;
  }

  // Diagnóstico: a tabela de ids. No modo do painel o `code` nunca é impresso.
  function render() {
    if (panelMode) return;
    var labels = {
      event: 'Resultado', waba_id: 'WABA ID', phone_number_id: 'Phone Number ID',
      business_id: 'Portfólio (Business ID)', code: 'Código de troca (expira em 30s)',
      current_step: 'Parou na etapa', error_message: 'Erro', error_code: 'Código do erro', session_id: 'Sessão'
    };
    resultEl.innerHTML = '';
    Object.keys(captured).forEach(function (k) {
      var tr = document.createElement('tr');
      var th = document.createElement('td');
      th.textContent = labels[k] || k;
      var td = document.createElement('td');
      var code = document.createElement('code');
      code.textContent = String(captured[k]);
      td.appendChild(code);
      tr.appendChild(th);
      tr.appendChild(td);
      resultEl.appendChild(tr);
    });
    resultEl.hidden = false;
    rawEl.hidden = false;
    rawPre.textContent = JSON.stringify(captured, null, 2);
  }

  // Entrega ao painel que abriu esta janela, e só a ele, UMA vez.
  function reply(payload) {
    if (sent) return;
    sent = true;
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(Object.assign({ type: MESSAGE_TYPE, state: state }, payload), returnOrigin);
    }
  }

  function finishError(reason) {
    reply({ error: reason, event: captured.event || null, step: captured.current_step || null });
    setStatus('Cadastro não concluído. Você pode fechar esta janela e tentar de novo pelo painel.', 'err');
    window.setTimeout(function () { window.close(); }, 1200);
  }

  // Só entrega quando há o evento de término E o `code` (chegam por caminhos diferentes).
  function maybeFinish() {
    if (!panelMode || sent) return;
    var ev = captured.event || '';
    if (ev.indexOf('FINISH') === 0 && captured.code) {
      reply({
        event: ev,
        code: captured.code,
        wabaId: captured.waba_id || null,
        phoneNumberId: captured.phone_number_id || null,
        businessId: captured.business_id || null
      });
      setStatus('Pronto. Voltando ao painel…', 'ok');
      window.setTimeout(function () { window.close(); }, 800);
    }
  }

  if (!ID_PATTERN.test(appId) || !ID_PATTERN.test(configId)) {
    btn.disabled = true;
    setStatus('Abra esta página pelo painel (aplicativo da Meta não informado).', 'err');
    return;
  }
  if (panelMode && (!STATE_PATTERN.test(state) || !returnOrigin)) {
    btn.disabled = true;
    setStatus('Abra esta página pelo painel (endereço de retorno inválido).', 'err');
    return;
  }

  window.fbAsyncInit = function () {
    FB.init({ appId: appId, autoLogAppEvents: true, xfbml: true, version: GRAPH_VERSION });
  };

  // Dados da sessão (IDs do WABA e do número), via postMessage do popup da Meta.
  window.addEventListener('message', function (event) {
    if (!FACEBOOK_ORIGIN.test(event.origin)) return;
    var data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return; // mensagens que não são JSON são ignoradas
    }
    if (!data || data.type !== 'WA_EMBEDDED_SIGNUP') return;
    captured.event = data.event;
    Object.assign(captured, data.data || {});
    if (panelMode) {
      if (data.event === 'CANCEL' || data.event === 'ERROR') finishError(data.event === 'CANCEL' ? 'cancelled' : 'error');
      else maybeFinish();
    } else if (data.event === COEXISTENCE_EVENT) {
      setStatus('Número conectado em coexistência. Copie os IDs abaixo. Você tem 24 horas para sincronizar contatos e histórico.', 'ok');
    } else if (data.event && data.event.indexOf('FINISH') === 0) {
      setStatus('Cadastro concluído (' + data.event + '). Atenção: não foi o fluxo de coexistência.', 'err');
    } else if (data.event === 'CANCEL') {
      setStatus('Cadastro cancelado ou com erro. Veja a etapa abaixo.', 'err');
    } else if (data.event === 'ERROR') {
      setStatus('Erro no cadastro. Veja os detalhes abaixo.', 'err');
    }
    render();
  });

  function fbLoginCallback(response) {
    btn.disabled = false;
    if (response && response.authResponse && response.authResponse.code) {
      captured.code = response.authResponse.code;
      render();
      maybeFinish();
    } else if (panelMode) {
      // Pode ser só a ordem: o CANCEL/ERROR da Meta chega logo depois.
      window.setTimeout(function () { if (!sent) finishError('cancelled'); }, CANCEL_GRACE_MS);
    } else if (!captured.event) {
      setStatus('Janela fechada sem concluir o cadastro.', 'err');
    }
  }

  function launchWhatsAppSignup() {
    if (typeof FB === 'undefined') {
      setStatus('SDK do Facebook ainda carregando, tente de novo em alguns segundos.', 'err');
      return;
    }
    btn.disabled = true;
    setStatus('Aguardando o cadastro na janela do Facebook...');
    var extras = { setup: {}, sessionInfoVersion: '3' };
    // Coexistência: o número continua no app WhatsApp Business do celular.
    if (coexistence) extras.featureType = 'whatsapp_business_app_onboarding';
    FB.login(fbLoginCallback, {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: extras
    });
  }

  btn.addEventListener('click', launchWhatsAppSignup);
})();
