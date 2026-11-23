/*
 * Login do Facebook para conectar Páginas ao Messenger. Esta página é aberta
 * pelo painel (window.open, mesma origem), faz o FB.login e devolve ao painel
 * SÓ o token de curta duração do usuário, por postMessage para a própria
 * origem. Quem troca por token de longa duração, lista as Páginas e guarda o
 * token da Página é o servidor; este arquivo nunca vê o segredo do app.
 *
 * O id do app vem na URL (`?app=`), vindo do servidor; só dígitos é aceito.
 * Como na página do WhatsApp, o SDK só funciona nas origens cadastradas no app
 * da Meta. Arquivo clássico, sem nada inline (CSP com `script-src-attr 'none'`).
 */
(function () {
  'use strict';

  var GRAPH_VERSION = 'v25.0';
  var SCOPE = 'pages_show_list,pages_messaging,pages_manage_metadata';
  var MESSAGE_TYPE = 'messenger-fb-login';

  var btn = document.getElementById('btn');
  var statusEl = document.getElementById('status');
  var appId = new URLSearchParams(window.location.search).get('app') || '';
  var valid = /^\d{5,32}$/.test(appId);

  function setStatus(msg, isError) {
    statusEl.className = isError ? 'err' : '';
    statusEl.textContent = msg;
  }

  // Devolve o resultado ao painel que abriu esta janela, e só a ele.
  function reply(payload) {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(Object.assign({ type: MESSAGE_TYPE }, payload), window.location.origin);
    }
  }

  if (!valid) {
    btn.disabled = true;
    setStatus('Abra esta página pelo painel (aplicativo da Meta não informado).', true);
    return;
  }

  window.fbAsyncInit = function () {
    FB.init({ appId: appId, xfbml: false, version: GRAPH_VERSION });
  };

  btn.addEventListener('click', function () {
    if (typeof FB === 'undefined') {
      setStatus('SDK do Facebook ainda carregando, tente de novo em alguns segundos.', true);
      return;
    }
    btn.disabled = true;
    setStatus('Aguardando o login na janela do Facebook...');
    FB.login(function (response) {
      btn.disabled = false;
      var auth = response && response.authResponse;
      if (auth && auth.accessToken) {
        reply({ accessToken: auth.accessToken });
        window.close();
      } else {
        reply({ error: 'cancelled' });
        setStatus('Login cancelado. Você pode fechar esta janela ou tentar de novo.', true);
      }
    }, { scope: SCOPE });
  });
})();
