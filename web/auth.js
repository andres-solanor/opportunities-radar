/**
 * Autenticación con Google (Google Identity Services - "Sign in with Google").
 *
 * El sitio es 100% estático (GitHub Pages), así que la identidad se obtiene del
 * ID token (JWT) que entrega Google y la sesión vive en localStorage. El token
 * se decodifica pero NO se verifica criptográficamente aquí: sirve para
 * personalizar la experiencia, no para autorizar acceso a datos sensibles.
 * Cuando exista un backend, el campo `credential` debe enviarse al servidor
 * para verificarse con la librería oficial de Google.
 */
(function () {
  const SESSION_KEY = 'secop_session';
  const GSI_SRC = 'https://accounts.google.com/gsi/client';
  const listeners = [];
  let gsiReady = null;

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function decodeJwtPayload(token) {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = decodeURIComponent(
      atob(padded).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(json);
  }

  function getUser() {
    const session = readJson(SESSION_KEY, null);
    if (!session) return null;
    if (session.exp && session.exp * 1000 < Date.now() - 30 * 24 * 3600 * 1000) {
      // Sesiones locales se mantienen 30 días después de expirado el token de Google.
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  }

  function setUser(user) {
    if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    else localStorage.removeItem(SESSION_KEY);
    listeners.forEach(fn => fn(user));
  }

  function handleCredential(response) {
    const claims = decodeJwtPayload(response.credential);
    if (claims.aud !== window.APP_CONFIG.GOOGLE_CLIENT_ID) return;
    setUser({
      id: `google:${claims.sub}`,
      provider: 'google',
      name: claims.name || claims.email,
      givenName: claims.given_name || '',
      email: claims.email,
      emailVerified: !!claims.email_verified,
      picture: claims.picture || '',
      hostedDomain: claims.hd || '',
      exp: claims.exp,
      signedInAt: new Date().toISOString()
    });
  }

  function isConfigured() {
    return !!(window.APP_CONFIG && window.APP_CONFIG.GOOGLE_CLIENT_ID);
  }

  function loadGsi() {
    if (gsiReady) return gsiReady;
    gsiReady = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        window.google.accounts.id.initialize({
          client_id: window.APP_CONFIG.GOOGLE_CLIENT_ID,
          callback: handleCredential,
          auto_select: false,
          cancel_on_tap_outside: true,
          ux_mode: 'popup',
          context: 'signup'
        });
        resolve(window.google.accounts.id);
      };
      script.onerror = () => reject(new Error('No se pudo cargar Google Identity Services'));
      document.head.appendChild(script);
    });
    return gsiReady;
  }

  /**
   * Renderiza el botón oficial de Google dentro de `container`.
   * Sin GOOGLE_CLIENT_ID configurado, muestra un botón de modo demo local.
   */
  function renderButton(container, { text = 'continue_with', onDemo } = {}) {
    if (!container) return;
    container.innerHTML = '';

    if (!isConfigured()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-google';
      btn.innerHTML = '<span class="g-mark">G</span> Continuar con Google <small>(modo demo)</small>';
      btn.title = 'Configura GOOGLE_CLIENT_ID en web/config.js para habilitar Google OAuth real';
      btn.addEventListener('click', () => {
        setUser({
          id: 'demo:local',
          provider: 'demo',
          name: 'Cuenta Demo',
          givenName: 'Demo',
          email: '',
          picture: '',
          hostedDomain: '',
          signedInAt: new Date().toISOString()
        });
        if (onDemo) onDemo();
      });
      container.appendChild(btn);
      return;
    }

    loadGsi()
      .then(gsi => {
        gsi.renderButton(container, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text,
          logo_alignment: 'left',
          locale: 'es'
        });
      })
      .catch(() => {
        container.innerHTML = '<p class="auth-error">No fue posible cargar el inicio de sesión de Google. Revisa tu conexión o bloqueadores de scripts.</p>';
      });
  }

  function signOut() {
    const user = getUser();
    if (user && user.provider === 'google' && window.google && window.google.accounts) {
      window.google.accounts.id.disableAutoSelect();
    }
    setUser(null);
  }

  window.SecopAuth = {
    getUser,
    signOut,
    renderButton,
    isConfigured,
    onChange: fn => listeners.push(fn),
    _decodeJwtPayload: decodeJwtPayload
  };
})();
