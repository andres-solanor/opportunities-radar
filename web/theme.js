/**
 * Tema de la web: sistema, claro, oscuro o Matrix.
 *
 * Se carga en el <head>, antes de style.css, para poner `data-theme` en <html> antes del primer
 * pintado: así la página no parpadea en el tema equivocado. La elección se guarda en
 * localStorage (`secop_theme`); "sistema" sigue a `prefers-color-scheme` y cambia en vivo si el
 * sistema operativo cambia. Los colores de cada tema están en style.css (tokens de :root).
 *
 * La lógica pura (`normalize`, `resolve`) se exporta también como módulo CommonJS para las
 * pruebas con Node; lo del navegador solo corre si hay `document`.
 */
(function (root) {
  const STORAGE_KEY = 'secop_theme';
  const THEMES = ['system', 'light', 'dark', 'matrix'];
  const LABELS = { system: 'Sistema', light: 'Claro', dark: 'Oscuro', matrix: 'Matrix' };
  const DEFAULT = 'system';

  /** Elección válida; cualquier otro valor (vacío, viejo o manipulado) vuelve a "sistema". */
  function normalize(choice) {
    return THEMES.includes(choice) ? choice : DEFAULT;
  }

  /** Tema que se pinta: "sistema" se resuelve a claro u oscuro según el sistema operativo. */
  function resolve(choice, prefersLight) {
    const c = normalize(choice);
    if (c === 'system') return prefersLight ? 'light' : 'dark';
    return c;
  }

  const api = { STORAGE_KEY, THEMES, LABELS, DEFAULT, normalize, resolve };

  if (typeof document !== 'undefined') {
    const html = document.documentElement;
    const media = typeof root.matchMedia === 'function' ? root.matchMedia('(prefers-color-scheme: light)') : null;

    // localStorage puede fallar (navegación privada, almacenamiento bloqueado): el tema sigue
    // funcionando, solo que no se recuerda.
    const read = () => {
      try { return normalize(root.localStorage.getItem(STORAGE_KEY)); } catch (e) { return DEFAULT; }
    };
    const write = (choice) => {
      try { root.localStorage.setItem(STORAGE_KEY, choice); } catch (e) { /* sin persistencia */ }
    };

    let choice = read();
    const apply = () => { html.dataset.theme = resolve(choice, !!(media && media.matches)); };

    api.get = () => choice;
    api.set = (next) => {
      choice = normalize(next);
      write(choice);
      apply();
    };

    /** Llena un <select> con los temas y lo mantiene sincronizado. */
    api.bindSelect = (select) => {
      if (!select) return;
      select.innerHTML = '';
      THEMES.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = LABELS[t];
        select.appendChild(opt);
      });
      select.value = choice;
      select.addEventListener('change', () => api.set(select.value));
    };

    if (media) {
      const onSystemChange = () => { if (choice === 'system') apply(); };
      if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemChange);
      else if (typeof media.addListener === 'function') media.addListener(onSystemChange);
    }

    apply();
    document.addEventListener('DOMContentLoaded', () => api.bindSelect(document.getElementById('themeSelect')));
  }

  root.SecopTheme = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
