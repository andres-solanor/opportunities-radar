/**
 * Perfiles de empresa: onboarding guiado, revelación de inteligencia de mercado
 * ("momento wow") y cuenta con Google.
 *
 * Flujo de activación:
 *   1. Cualquier visitante construye su perfil sin registrarse (borrador local).
 *   2. Mientras responde, ve en vivo cuánto mercado público coincide con su oferta.
 *   3. Al terminar recibe su Perfil de Oportunidades; los nombres de contactos y
 *      las oportunidades concretas se desbloquean al guardar con Google.
 */
(function () {
  const DRAFT_KEY = 'secop_profile_draft';
  const PROFILES_KEY = 'secop_profiles';
  // Empresas cliente por usuario (ProfileEngine.clientBook): { userId: { active, clients } }.
  const CLIENTS_KEY = 'secop_client_book';
  const E = window.ProfileEngine;
  const Auth = window.SecopAuth;
  const DATA = window.PROSPECTS_DATA || [];
  const TAXONOMY = window.SECTOR_TAXONOMY || {};

  const DEPARTMENTS = [
    'Amazonas', 'Antioquia', 'Arauca', 'Atlántico', 'Bolívar', 'Boyacá', 'Caldas', 'Caquetá',
    'Casanare', 'Cauca', 'Cesar', 'Chocó', 'Córdoba', 'Cundinamarca', 'Distrito Capital de Bogotá',
    'Guainía', 'Guaviare', 'Huila', 'La Guajira', 'Magdalena', 'Meta', 'Nariño', 'Norte de Santander',
    'Putumayo', 'Quindío', 'Risaralda', 'San Andrés, Providencia y Santa Catalina', 'Santander',
    'Sucre', 'Tolima', 'Valle del Cauca', 'Vaupés', 'Vichada'
  ];

  const STEPS = [
    { title: '¿Quién eres en el mercado público?', hint: 'Así sabremos qué tipo de oportunidades y conexiones priorizar.' },
    { title: '¿Qué ofreces?', hint: 'Escríbelo como se lo contarías a un cliente. Detectamos tu sector en tiempo real.' },
    { title: '¿Qué necesitas y a quién buscas?', hint: 'Convertimos tus necesidades en conexiones concretas.' },
    { title: '¿Dónde y de qué tamaño?', hint: 'Afinamos el mercado a tu capacidad real.' }
  ];

  const listeners = [];
  let wizardStep = 0;
  let wizardDraft = null;
  // true cuando el asistente crea una empresa cliente nueva (no edita el perfil activo).
  let wizardNewClient = false;
  let analysisCache = null;

  // ---------- Persistencia ----------
  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch (_) {
      return fallback;
    }
  }

  /** Libreta de empresas cliente del usuario con sesión (vacía sin sesión). */
  function readBook() {
    const user = Auth.getUser();
    return E.clientBook(user ? readJson(CLIENTS_KEY, {})[user.id] : null);
  }

  function writeBook(book) {
    const user = Auth.getUser();
    if (!user) return;
    const all = readJson(CLIENTS_KEY, {});
    all[user.id] = book;
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(all));
  }

  /** Perfil de la empresa propia (sin empresas cliente). */
  function getOwnProfile() {
    const user = Auth.getUser();
    if (user) return readJson(PROFILES_KEY, {})[user.id] || null;
    return readJson(DRAFT_KEY, null);
  }

  /** Perfil activo: la empresa cliente elegida o, si no hay, la propia. Todo lo demás lo usa. */
  function getProfile() {
    return E.activeClient(readBook()) || getOwnProfile();
  }

  function profileChanged() {
    analysisCache = null;
    const profile = getProfile();
    listeners.forEach(fn => fn(profile));
  }

  function saveProfile(profile) {
    profile.updatedAt = new Date().toISOString();
    const user = Auth.getUser();
    const book = readBook();
    if (user && book.active !== E.OWN_PROFILE) {
      writeBook(E.updateClient(book, book.active, profile));
    } else if (user) {
      const all = readJson(PROFILES_KEY, {});
      all[user.id] = profile;
      localStorage.setItem(PROFILES_KEY, JSON.stringify(all));
    } else {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(profile));
    }
    profileChanged();
  }

  function saveNewClient(profile) {
    profile.updatedAt = new Date().toISOString();
    writeBook(E.addClient(readBook(), profile).book);
    profileChanged();
  }

  function setActiveClient(id) {
    writeBook(E.setActiveClient(readBook(), id));
    profileChanged();
  }

  /** Al iniciar sesión, el borrador anónimo se convierte en el perfil de la cuenta. */
  function adoptDraft(user) {
    const draft = readJson(DRAFT_KEY, null);
    const all = readJson(PROFILES_KEY, {});
    if (draft && !all[user.id]) {
      all[user.id] = { ...draft, ownerEmail: user.email || '' };
      localStorage.setItem(PROFILES_KEY, JSON.stringify(all));
    }
    localStorage.removeItem(DRAFT_KEY);
  }

  function getAnalysis() {
    const profile = getProfile();
    if (!profile) return null;
    if (!analysisCache) analysisCache = E.analyzeProfile(profile, DATA, TAXONOMY);
    return analysisCache;
  }

  function matchItem(item) {
    const profile = getProfile();
    const analysis = getAnalysis();
    if (!profile || !analysis) return null;
    return E.matchOpportunity(profile, item, analysis.detected);
  }

  // ---------- Utilidades de UI ----------
  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function toast(message, type) {
    if (window.showAppToast) window.showAppToast(message, type);
  }

  /** Catálogo de sugerencias agrupado por familia de sectores (window.SECTOR_GROUPS). */
  function catalogFamilies() {
    const catalog = E.offerCatalog(TAXONOMY);
    const families = (window.SECTOR_GROUPS || []).map(g => ({
      name: g.name,
      sectors: catalog.filter(sec => TAXONOMY[sec.id].grupo === g.id)
    }));
    const grouped = new Set(families.flatMap(f => f.sectors.map(s => s.id)));
    const rest = catalog.filter(sec => !grouped.has(sec.id));
    if (rest.length) families.push({ name: 'Otros sectores', sectors: rest });
    return families.filter(f => f.sectors.length);
  }

  function chip(label, { active = false, attrs = '' } = {}) {
    return `<button type="button" class="chip ${active ? 'active' : ''}" ${attrs}>${esc(label)}</button>`;
  }

  const modal = document.getElementById('profileModal');
  const modalBody = document.getElementById('profileModalBody');

  function openModal(html) {
    modalBody.innerHTML = html;
    modal.classList.add('active');
    modal.querySelector('.modal-content').scrollTop = 0;
  }

  function closeModal() {
    modal.classList.remove('active');
  }

  document.getElementById('profileModalClose').addEventListener('click', closeModal);
  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal();
  });

  // ---------- Onboarding ----------
  function emptyProfile() {
    const user = Auth.getUser();
    const domain = user && user.hostedDomain ? user.hostedDomain : '';
    return {
      role: '',
      companyName: '',
      nit: '',
      website: domain ? `https://${domain}` : '',
      offerText: '',
      offerTags: [],
      sectors: [],
      needs: [],
      connections: [],
      departments: [],
      nationwide: false,
      tickets: [],
      experienceYears: '',
      hasRup: false,
      unspscCodes: [],
      excludeTerms: [],
      excludeSectors: []
    };
  }

  function openWizard(step = 0, { newClient = false } = {}) {
    wizardNewClient = newClient;
    wizardDraft = newClient ? { ...emptyProfile(), website: '' } : { ...emptyProfile(), ...(getProfile() || {}) };
    wizardStep = step;
    renderWizard();
  }

  function liveMarketLine(profile) {
    const detected = E.detectSectors(profile, TAXONOMY);
    if (!detected.length) {
      return '<span class="live-dot"></span> Cuéntanos qué ofreces y calcularemos tu mercado en SECOP II…';
    }
    const a = E.analyzeProfile(profile, DATA, TAXONOMY);
    const zone = profile.nationwide || !(profile.departments || []).length ? 'en el país' : 'en tu zona';
    return `<span class="live-dot on"></span> <b>${a.market.total}</b> procesos por <b>${E.formatCopShort(a.market.totalValue)}</b> ${zone} ya coinciden con tu perfil · <b>${a.matchCount}</b> con alta afinidad`;
  }

  function detectedHtml(profile) {
    const detected = E.detectSectors(profile, TAXONOMY);
    if (!detected.length) {
      return '<div class="detect-empty">Aún no detectamos tu sector. Menciona productos concretos (ej. "estructuras metálicas", "cocinas industriales", "paneles solares") o elige sugerencias abajo.</div>';
    }
    return detected.map(d => `
      <div class="detect-row">
        <div class="detect-name">✓ ${esc(d.name)}</div>
        <div class="strength-bar"><span style="transform:scaleX(${Math.max(0, Math.min(100, Number(d.strength) || 0)) / 100})"></span></div>
        <div class="detect-kw">${d.keywords.slice(0, 6).map(k => `<span class="mini-tag">${esc(k)}</span>`).join('')}</div>
      </div>`).join('');
  }

  function wizardStepHtml(p) {
    if (wizardStep === 0) {
      return `
        <div class="role-grid">
          ${Object.entries(E.ROLES).map(([id, r]) => `
            <button type="button" class="role-card ${p.role === id ? 'active' : ''}" data-role="${id}">
              <span class="role-icon">${r.icon}</span>
              <span class="role-label">${esc(r.label)}</span>
              <span class="role-desc">${id === 'proveedor' ? 'Vendo insumos, equipos o materiales a quienes ejecutan contratos públicos.' : id === 'contratista' ? 'Me presento a licitaciones y ejecuto obras, suministros o servicios.' : 'Ayudo a otros a estructurar ofertas, consorcios y requisitos.'}</span>
            </button>`).join('')}
        </div>
        <div class="form-grid">
          <label>Nombre de tu empresa<input class="input" data-field="companyName" value="${esc(p.companyName)}" placeholder="Ej. Aceros del Caribe S.A.S."></label>
          <label>NIT <small>(opcional)</small><input class="input" data-field="nit" value="${esc(p.nit)}" placeholder="900123456-7"></label>
          <label class="span-2">Sitio web <small>(opcional)</small><input class="input" data-field="website" value="${esc(p.website)}" placeholder="https://"></label>
        </div>`;
    }

    if (wizardStep === 1) {
      const tags = new Set(p.offerTags || []);
      const detected = new Set(E.detectSectors(p, TAXONOMY).map(d => d.id));
      return `
        <label class="block-label">Describe tu oferta
          <textarea class="input textarea" data-field="offerText" rows="4" placeholder="Ej. Fabricamos y montamos estructuras metálicas, cerchas y cubiertas para colegios y escenarios deportivos. Entregamos en todo Antioquia en 15 días.">${esc(p.offerText)}</textarea>
        </label>
        <div class="detect-box" id="detectBox">${detectedHtml(p)}</div>
        <div class="catalog">
          <div class="catalog-title">Sugerencias rápidas: abre tu familia de sectores y toca lo que ofreces</div>
          ${catalogFamilies().map(fam => {
            // Abierta si ya eligió algo o detectamos uno de sus sectores; si no, cerrada para no abrumar.
            const open = fam.sectors.some(sec => detected.has(sec.id) || sec.tags.some(t => tags.has(t)));
            return `
            <details class="catalog-family" data-sectors="${esc(fam.sectors.map(s => s.id).join(','))}" ${open ? 'open' : ''}>
              <summary><span>${esc(fam.name)}</span><small>${esc(fam.sectors.map(s => s.name).join(' · '))}</small></summary>
              ${fam.sectors.map(sec => `
                <div class="catalog-group">
                  <div class="catalog-sector">${esc(sec.name)}</div>
                  <div class="chips">${sec.tags.map(t => chip(t, { active: tags.has(t), attrs: `data-tag="${esc(t)}"` })).join('')}</div>
                </div>`).join('')}
            </details>`;
          }).join('')}
        </div>
        <details class="exclude-box section-gap" ${(p.excludeTerms || []).length || (p.excludeSectors || []).length ? 'open' : ''}>
          <summary>🚫 Lo que no te interesa <small>(opcional)</small></summary>
          <p class="exclude-hint">Los procesos que lo mencionan bajan de afinidad y salen de "Para Ti". Siguen en las demás pestañas.</p>
          <label class="block-label" for="excludeTerms">Palabras o temas, separados por comas</label>
          <input class="input" id="excludeTerms" value="${esc((p.excludeTerms || []).join(', '))}" placeholder="Ej. interventoría, software, alimentación escolar">
          <div class="block-label">Sectores que no trabajas</div>
          <div class="chips">${catalogFamilies().flatMap(f => f.sectors).map(sec => chip(sec.name, { active: (p.excludeSectors || []).includes(sec.id), attrs: `data-exclude-sector="${esc(sec.id)}"` })).join('')}</div>
        </details>`;
    }

    if (wizardStep === 2) {
      return `
        <div class="block-label">Lo que necesitas para crecer <small>(elige varias)</small></div>
        <div class="chips">${Object.entries(E.NEEDS).map(([id, label]) => chip(label, { active: p.needs.includes(id), attrs: `data-need="${id}"` })).join('')}</div>
        <div class="block-label section-gap">Conexiones que buscas</div>
        <div class="chips">${Object.entries(E.CONNECTIONS).map(([id, label]) => chip(label, { active: p.connections.includes(id), attrs: `data-conn="${id}"` })).join('')}</div>`;
    }

    return `
      <div class="block-label">Cobertura geográfica</div>
      <div class="chips">
        ${chip('🇨🇴 Todo el país', { active: p.nationwide, attrs: 'data-nationwide="1"' })}
        ${DEPARTMENTS.map(d => chip(d, { active: !p.nationwide && p.departments.includes(d), attrs: `data-dept="${esc(d)}"` })).join('')}
      </div>
      <div class="block-label section-gap">Tamaño de contratos que puedes atender <small>(COP)</small></div>
      <div class="chips">${Object.entries(E.TICKETS).map(([id, t]) => chip(t.label, { active: p.tickets.includes(id), attrs: `data-ticket="${id}"` })).join('')}</div>
      <div class="form-grid section-gap">
        <label>Años de experiencia<input class="input" type="number" min="0" max="80" data-field="experienceYears" value="${esc(p.experienceYears)}" placeholder="Ej. 8"></label>
        <label class="check-label"><input type="checkbox" data-field="hasRup" ${p.hasRup ? 'checked' : ''}> Inscrito en el RUP (Registro Único de Proponentes)</label>
      </div>
      <div class="rup-codes section-gap">
        <label class="block-label" for="rupSearch">Códigos UNSPSC de tu RUP <small>(opcional: búscalos por nombre o escribe el código de tu certificado)</small></label>
        <div class="chips" id="rupChips">${rupChipsHtml(p)}</div>
        <input class="input" id="rupSearch" type="search" autocomplete="off" placeholder="Ej. carreteras o 721410" aria-controls="rupResults" aria-autocomplete="list">
        <ul class="rup-results" id="rupResults" role="listbox" aria-label="Códigos UNSPSC encontrados"></ul>
      </div>`;
  }

  function rupChipsHtml(p) {
    return E.rupCodes(p).map(c => `
      <span class="rup-chip" title="${esc(c.nombre ? `${c.codigo} · ${c.nombre}${c.prestado ? ' (nombre de su clase)' : ''}` : c.codigo)}">
        <b>${esc(c.codigo)}</b>${c.nombre ? ` ${esc(c.nombre)}` : ''}
        <button type="button" class="rup-remove" data-rup-remove="${esc(c.codigo)}" aria-label="Quitar ${esc(c.codigo)}">×</button>
      </span>`).join('');
  }

  function rupResultsHtml(results) {
    return results.map(r => `
      <li><button type="button" class="rup-option" role="option" data-rup-add="${esc(r.codigo)}">
        <b>${esc(r.codigo)}</b> <span>${esc(r.nombre || 'Sin nombre público')}</span> <small>${esc(r.nivel)}</small>
      </button></li>`).join('');
  }

  function canAdvance(p) {
    if (wizardStep === 0) return !!p.role;
    if (wizardStep === 1) return E.detectSectors(p, TAXONOMY).length > 0;
    return true;
  }

  function renderWizard() {
    const p = wizardDraft;
    const step = STEPS[wizardStep];
    openModal(`
      <div class="wizard">
        <div class="wizard-progress">
          ${STEPS.map((_, i) => `<span class="${i <= wizardStep ? 'done' : ''}"></span>`).join('')}
        </div>
        <div class="wizard-step-label">${wizardNewClient ? 'Nueva empresa cliente · ' : ''}Paso ${wizardStep + 1} de ${STEPS.length}</div>
        <h2 class="wizard-title">${step.title}</h2>
        <p class="wizard-hint">${step.hint}</p>
        <div class="wizard-body">${wizardStepHtml(p)}</div>
        <div class="live-market" id="liveMarket">${liveMarketLine(p)}</div>
        <div class="wizard-actions">
          ${wizardStep > 0 ? '<button type="button" class="btn btn-outline" id="wizBack">← Atrás</button>' : '<span></span>'}
          <button type="button" class="btn btn-primary" id="wizNext" ${canAdvance(p) ? '' : 'disabled'}>
            ${wizardStep === STEPS.length - 1 ? '✨ Ver mi Perfil de Oportunidades' : 'Continuar →'}
          </button>
        </div>
      </div>`);
    bindWizard();
  }

  function refreshLive() {
    document.getElementById('liveMarket').innerHTML = liveMarketLine(wizardDraft);
    // Mientras escribe: se abre la familia del sector detectado (nunca se cierra una que abrió él).
    const detected = new Set(E.detectSectors(wizardDraft, TAXONOMY).map(d => d.id));
    modalBody.querySelectorAll('details.catalog-family').forEach(fam => {
      if (fam.dataset.sectors.split(',').some(id => detected.has(id))) fam.open = true;
    });
    const detectBox = document.getElementById('detectBox');
    if (detectBox) detectBox.innerHTML = detectedHtml(wizardDraft);
    document.getElementById('wizNext').disabled = !canAdvance(wizardDraft);
  }

  function toggleIn(list, value) {
    const i = list.indexOf(value);
    if (i >= 0) list.splice(i, 1);
    else list.push(value);
  }

  function bindWizard() {
    const p = wizardDraft;

    modalBody.querySelectorAll('[data-role]').forEach(btn => btn.addEventListener('click', () => {
      p.role = btn.dataset.role;
      modalBody.querySelectorAll('[data-role]').forEach(b => b.classList.toggle('active', b === btn));
      refreshLive();
    }));

    modalBody.querySelectorAll('[data-field]').forEach(input => {
      const evt = input.type === 'checkbox' ? 'change' : 'input';
      input.addEventListener(evt, () => {
        p[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
        refreshLive();
      });
    });

    const chipHandlers = {
      tag: (btn) => toggleIn(p.offerTags, btn.dataset.tag),
      need: (btn) => toggleIn(p.needs, btn.dataset.need),
      conn: (btn) => toggleIn(p.connections, btn.dataset.conn),
      ticket: (btn) => toggleIn(p.tickets, btn.dataset.ticket),
      'exclude-sector': (btn) => {
        if (!Array.isArray(p.excludeSectors)) p.excludeSectors = [];
        toggleIn(p.excludeSectors, btn.dataset.excludeSector);
      },
      dept: (btn) => {
        toggleIn(p.departments, btn.dataset.dept);
        p.nationwide = false;
        const nat = modalBody.querySelector('[data-nationwide]');
        if (nat) nat.classList.remove('active');
      },
      nationwide: () => {
        p.nationwide = !p.nationwide;
        if (p.nationwide) {
          p.departments = [];
          modalBody.querySelectorAll('[data-dept]').forEach(b => b.classList.remove('active'));
        }
      }
    };
    Object.entries(chipHandlers).forEach(([key, handler]) => {
      modalBody.querySelectorAll(`[data-${key}]`).forEach(btn => btn.addEventListener('click', () => {
        handler(btn);
        if (key !== 'dept' && key !== 'nationwide') btn.classList.toggle('active');
        else if (key === 'dept') btn.classList.toggle('active', p.departments.includes(btn.dataset.dept));
        else btn.classList.toggle('active', p.nationwide);
        refreshLive();
      }));
    });

    bindRupCodes(p);

    const excludeInput = document.getElementById('excludeTerms');
    if (excludeInput) excludeInput.addEventListener('input', () => {
      p.excludeTerms = E.parseExcludeTerms(excludeInput.value);
      refreshLive();
    });

    const back = document.getElementById('wizBack');
    if (back) back.addEventListener('click', () => {
      wizardStep -= 1;
      renderWizard();
    });

    document.getElementById('wizNext').addEventListener('click', () => {
      if (!canAdvance(p)) return;
      if (wizardStep < STEPS.length - 1) {
        wizardStep += 1;
        renderWizard();
        return;
      }
      if (wizardNewClient) saveNewClient({ ...p });
      else saveProfile({ ...p });
      wizardNewClient = false;
      openProfileView({ celebrate: true });
    });
  }

  /** Buscador de códigos del RUP (último paso). Pinta solo su bloque para no perder el foco. */
  function bindRupCodes(p) {
    const search = document.getElementById('rupSearch');
    if (!search) return;
    const chips = document.getElementById('rupChips');
    const results = document.getElementById('rupResults');
    let current = [];
    const showResults = () => {
      current = E.searchUnspsc(search.value, { exclude: p.unspscCodes || [] });
      results.innerHTML = rupResultsHtml(current);
    };
    const add = code => {
      p.unspscCodes = E.addRupCode(p.unspscCodes, code);
      // Quien escribe los códigos de su RUP está inscrito en el RUP.
      p.hasRup = true;
      const rup = modalBody.querySelector('[data-field="hasRup"]');
      if (rup) rup.checked = true;
      chips.innerHTML = rupChipsHtml(p);
      search.value = '';
      results.innerHTML = '';
      search.focus();
    };
    search.addEventListener('input', showResults);
    search.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (current.length) add(current[0].codigo);
    });
    results.addEventListener('click', e => {
      const btn = e.target.closest('[data-rup-add]');
      if (btn) add(btn.dataset.rupAdd);
    });
    chips.addEventListener('click', e => {
      const btn = e.target.closest('[data-rup-remove]');
      if (!btn) return;
      p.unspscCodes = (p.unspscCodes || []).filter(c => c !== btn.dataset.rupRemove);
      chips.innerHTML = rupChipsHtml(p);
      search.focus();
    });
  }

  // ---------- Perfil de Oportunidades (momento wow) ----------
  function strengthRing(score) {
    const deg = Math.round((score / 100) * 360);
    return `<div class="strength-ring" style="--deg:${deg}deg"><span>${score}%</span></div>`;
  }

  /** Escapa el texto y, si el perfil no está guardado, difumina solo los nombres de empresas. */
  function maskNames(text, names, locked) {
    let html = esc(text);
    if (!locked) return html;
    names.filter(Boolean).forEach(n => {
      html = html.split(esc(n)).join(`<span class="soft-lock">${esc(n)}</span>`);
    });
    return html;
  }

  function lockedList(examples, locked) {
    if (!examples.length) return '';
    return `<ul class="example-list ${locked ? 'locked' : ''}">
      ${examples.map(x => `<li>${locked ? '██████ ████████' : esc(x)}</li>`).join('')}
    </ul>`;
  }

  /**
   * Texto que el usuario puede reescribir (propuesta de valor, pitch). `t` viene de
   * analysis.texts: lo editado reemplaza al sugerido, y si el perfil cambió desde la edición se
   * avisa y se muestra el sugerido nuevo.
   */
  function editableTextHtml(key, t, { viewHtml, extraActions = '' }) {
    return `
      <div class="editable-text" data-edit-key="${esc(key)}">
        ${viewHtml}
        ${t.edited ? `
        <div class="edit-meta">
          <span class="mini-tag">Editado por ti</span>
          ${t.suggestionChanged ? '<span class="edit-warn">Tu perfil cambió desde que lo editaste: el texto sugerido también.</span>' : ''}
        </div>
        ${t.suggestionChanged ? `<details class="edit-suggested"><summary>Ver el sugerido</summary><p>${esc(t.suggested)}</p></details>` : ''}` : ''}
        <div class="edit-actions">
          <button type="button" class="btn btn-outline btn-sm" data-edit-start>✏️ Editar</button>
          ${t.edited ? '<button type="button" class="btn btn-outline btn-sm" data-edit-restore>↺ Usar el sugerido</button>' : ''}
          ${extraActions}
        </div>
      </div>`;
  }

  /** Vuelve a pintar el perfil sin perder la posición del scroll. */
  function refreshProfileView() {
    const content = modal.querySelector('.modal-content');
    const y = content.scrollTop;
    openProfileView();
    content.scrollTop = y;
  }

  function bindEditableTexts(a) {
    modalBody.querySelectorAll('.editable-text').forEach(box => {
      const key = box.dataset.editKey;
      const t = a.texts[key];
      const save = text => {
        saveProfile(E.setCustomText(getProfile(), key, text, t.suggested));
        refreshProfileView();
      };
      const restore = box.querySelector('[data-edit-restore]');
      if (restore) restore.addEventListener('click', () => {
        save('');
        toast('Volviste al texto sugerido', 'info');
      });
      box.querySelector('[data-edit-start]').addEventListener('click', () => {
        box.innerHTML = `
          <textarea class="input textarea edit-input" rows="${key === 'elevatorPitch' ? 8 : 4}" maxlength="${E.CUSTOM_TEXT_MAX}" aria-label="Escribe tu texto">${esc(t.text)}</textarea>
          <div class="edit-actions">
            <button type="button" class="btn btn-primary btn-sm" data-edit-save>Guardar</button>
            <button type="button" class="btn btn-outline btn-sm" data-edit-cancel>Cancelar</button>
          </div>`;
        const input = box.querySelector('.edit-input');
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        box.querySelector('[data-edit-save]').addEventListener('click', () => {
          save(input.value);
          toast('Texto guardado en tu perfil', 'success');
        });
        box.querySelector('[data-edit-cancel]').addEventListener('click', refreshProfileView);
      });
    });
  }

  function openProfileView({ celebrate = false } = {}) {
    const profile = getProfile();
    if (!profile) {
      openWizard();
      return;
    }
    const a = getAnalysis();
    const user = Auth.getUser();
    const locked = !user;
    const m = a.market;
    const rupList = E.rupCodes(profile);
    const sectorNames = Object.fromEntries(E.offerCatalog(TAXONOMY).map(s => [s.id, s.name]));
    const excludeList = [...(profile.excludeSectors || []).map(id => sectorNames[id]).filter(Boolean), ...(profile.excludeTerms || [])];
    const zoneLabel = profile.nationwide || !(profile.departments || []).length ? 'Colombia' : (profile.departments.length > 2 ? `${profile.departments.length} departamentos` : profile.departments.join(' y '));

    openModal(`
      <div class="reveal">
        ${celebrate ? '<div class="reveal-kicker">✨ Listo. Esto es lo que vemos de tu negocio en SECOP II</div>' : ''}
        <div class="reveal-header">
          <div>
            <div class="reveal-role">${a.role.icon} ${esc(a.role.label)}</div>
            <h2 class="reveal-title">${esc(profile.companyName || 'Tu Perfil de Oportunidades')}</h2>
            <div class="reveal-sectors">${a.detected.map(d => `<span class="sector-pill">${esc(d.name)}</span>`).join('')}</div>
          </div>
          <div class="strength-box">
            ${strengthRing(a.strength.score)}
            <div class="strength-caption">Fuerza del perfil</div>
          </div>
        </div>

        <section class="reveal-block highlight">
          <div class="block-kicker">Tu propuesta de valor${a.texts.valueProp.edited ? '' : ', clarificada'}</div>
          ${editableTextHtml('valueProp', a.texts.valueProp, { viewHtml: `<p class="value-prop">${esc(a.valueProp)}</p>` })}
        </section>

        <section class="reveal-kpis">
          <div class="rk"><div class="rk-value">${E.formatCopShort(m.totalValue)}</div><div class="rk-label">Mercado direccionable en ${esc(zoneLabel)}</div></div>
          <div class="rk"><div class="rk-value">${m.total}</div><div class="rk-label">Procesos que piden lo que ofreces</div></div>
          <div class="rk"><div class="rk-value">${m.open}</div><div class="rk-label">Aún abiertos: llegas a tiempo</div></div>
          <div class="rk"><div class="rk-value">${m.entities}</div><div class="rk-label">Entidades compradoras</div></div>
        </section>
        ${m.total === 0 && m.nationalTotal > 0 ? `<p class="reveal-note">En ${esc(zoneLabel)} no vemos procesos recientes, pero a nivel nacional hay <b>${m.nationalTotal}</b> por <b>${E.formatCopShort(m.nationalValue)}</b>. Considera ampliar tu cobertura.</p>` : ''}
        ${m.topDepartments.length ? `<p class="reveal-note">📍 Donde más se compra tu sector: ${m.topDepartments.map(d => `<b>${esc(d.name)}</b> (${E.formatCopShort(d.value)})`).join(' · ')}</p>` : ''}

        <section class="reveal-block">
          <div class="block-kicker">🎯 Tu cliente ideal</div>
          <p>${maskNames(a.idealClient, [...m.topWinners, ...m.topEntities].map(x => x.name), locked)}</p>
        </section>

        ${a.connections.length ? `
        <section class="reveal-block">
          <div class="block-kicker">🔗 Las conexiones que buscas, ya identificadas</div>
          <div class="conn-grid">
            ${a.connections.map(c => `
              <div class="conn-card">
                <div class="conn-head"><span>${esc(c.label)}</span><span class="conn-count">${c.count}</span></div>
                <p>${esc(c.insight)}</p>
                ${lockedList(c.examples, locked)}
              </div>`).join('')}
          </div>
        </section>` : ''}

        ${a.recommendations.length ? `
        <section class="reveal-block">
          <div class="block-kicker">🧭 Lo que necesitas → cómo lo resolvemos</div>
          <div class="need-list">
            ${a.recommendations.map(r => `<div class="need-item"><div class="need-label">${esc(r.label)}</div><div class="need-advice">${esc(r.advice)}</div></div>`).join('')}
          </div>
        </section>` : ''}

        <section class="reveal-block">
          <div class="block-kicker">🎤 Tu pitch de 30 segundos</div>
          ${editableTextHtml('elevatorPitch', a.texts.elevatorPitch, {
            viewHtml: `<div class="pitch-box" id="elevatorPitch">${esc(a.elevatorPitch)}</div>`,
            extraActions: '<button type="button" class="btn btn-outline btn-sm" id="copyElevator">📋 Copiar pitch</button>'
          })}
        </section>

        ${rupList.length ? `
        <section class="reveal-block">
          <div class="block-kicker">📋 Tu RUP: ${rupList.length} ${rupList.length === 1 ? 'código UNSPSC' : 'códigos UNSPSC'}</div>
          <ul class="rup-list">${rupList.map(c => `<li><b>${esc(c.codigo)}</b> ${esc(c.nombre || 'Sin nombre público')}${c.prestado ? ' <small>(nombre de su clase)</small>' : ''}</li>`).join('')}</ul>
        </section>` : ''}

        ${excludeList.length ? `
        <section class="reveal-block">
          <div class="block-kicker">🚫 No te interesa</div>
          <div class="chips exclude-list">${excludeList.map(t => `<span class="mini-tag">${esc(t)}</span>`).join('')}</div>
          <p class="exclude-hint">Esos procesos bajan de afinidad y no salen en "Para Ti". Cámbialo en "Editar perfil", paso 2.</p>
        </section>` : ''}

        <section class="reveal-block">
          <div class="block-kicker">🔔 Palabras clave para tus alertas</div>
          <div class="chips">${a.alertKeywords.map(k => `<span class="mini-tag">${esc(k)}</span>`).join('')}</div>
        </section>

        ${a.topMatches.length ? `
        <section class="reveal-block">
          <div class="block-kicker">⚡ Tus mejores oportunidades hoy (${a.matchCount} con alta afinidad)</div>
          <div class="top-matches">
            ${a.topMatches.map(t => `
              <div class="tm-row">
                <span class="match-pill">${t.score}%</span>
                <span class="tm-entity ${locked ? 'soft-lock' : ''}">${esc(t.item.entidad)}</span>
                <span class="tm-value">${esc(E.formatCopShort(t.item.precio || 0))}</span>
              </div>`).join('')}
          </div>
        </section>` : ''}

        ${a.strength.missing.length ? `
        <section class="reveal-block">
          <div class="block-kicker">📈 Sube la fuerza de tu perfil</div>
          <ul class="tips">${a.strength.missing.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
        </section>` : ''}

        <div class="reveal-cta">
          ${locked ? `
            <div class="cta-copy">
              <strong>Guarda tu perfil y desbloquea ${a.matchCount} oportunidades, los nombres de tus conexiones y tu radar diario.</strong>
              <span>Gratis. Con tu cuenta de Google, en un clic.</span>
            </div>
            <div id="revealGoogleBtn" class="google-slot"></div>
          ` : `
            <button type="button" class="btn btn-outline" id="editProfileBtn">✏️ Editar perfil</button>
            <button type="button" class="btn btn-primary" id="goMatchesBtn">⚡ Ver mis ${a.matchCount} oportunidades</button>
          `}
        </div>
        ${locked ? '<button type="button" class="link-btn" id="editProfileBtn">✏️ Ajustar respuestas</button>' : ''}
      </div>`);

    document.getElementById('copyElevator').addEventListener('click', () => {
      navigator.clipboard.writeText(a.elevatorPitch).then(() => toast('Pitch copiado al portapapeles', 'success'));
    });
    bindEditableTexts(a);
    document.getElementById('editProfileBtn').addEventListener('click', () => openWizard(0));
    const go = document.getElementById('goMatchesBtn');
    if (go) go.addEventListener('click', () => {
      closeModal();
      if (window.showForYouTab) window.showForYouTab();
    });
    if (locked) Auth.renderButton(document.getElementById('revealGoogleBtn'), { text: 'signup_with' });
  }

  // ---------- Empresas cliente y lista corta ----------
  function profileLabel(profile, fallback) {
    return (profile && profile.companyName) || fallback;
  }

  function openClientsView() {
    const book = readBook();
    const own = getOwnProfile();
    const row = (id, profile, label) => {
      const active = book.active === id;
      const sectors = profile ? E.detectSectors(profile, TAXONOMY).map(d => d.name).slice(0, 3).join(' · ') : 'Sin perfil todavía';
      return `
        <li class="client-row${active ? ' active' : ''}">
          <div class="client-info">
            <div class="client-name">${esc(label)}${active ? ' <span class="client-active">En uso</span>' : ''}</div>
            <div class="client-sectors">${esc(sectors || 'Sin sector detectado')}</div>
          </div>
          <div class="client-actions">
            ${active ? '' : `<button type="button" class="btn btn-outline btn-sm" data-use="${esc(id)}">Usar</button>`}
            ${profile ? `<button type="button" class="btn btn-outline btn-sm" data-shortlist="${esc(id)}">📄 Lista corta</button>` : ''}
            ${id !== E.OWN_PROFILE ? `<button type="button" class="btn btn-outline btn-sm" data-remove="${esc(id)}" aria-label="Quitar ${esc(label)}">Quitar</button>` : ''}
          </div>
        </li>`;
    };
    openModal(`
      <div class="clients">
        <h2 class="wizard-title">🏢 Empresas cliente</h2>
        <p class="wizard-hint">Prepara a varias empresas para licitar desde una sola cuenta. La que está en uso define "Para Ti", la afinidad de las fichas y la lista corta.</p>
        <ul class="client-list">
          ${row(E.OWN_PROFILE, own, profileLabel(own, 'Mi empresa'))}
          ${book.clients.map(c => row(c.id, c, profileLabel(c, 'Empresa sin nombre'))).join('')}
        </ul>
        <button type="button" class="btn btn-primary" id="addClientBtn">＋ Agregar empresa cliente</button>
      </div>`);
    modalBody.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => {
      setActiveClient(b.dataset.use);
      toast(`Ahora trabajas para ${profileLabel(getProfile(), 'tu empresa')}`, 'success');
      openClientsView();
    }));
    modalBody.querySelectorAll('[data-shortlist]').forEach(b => b.addEventListener('click', () => {
      setActiveClient(b.dataset.shortlist);
      openShortList();
    }));
    modalBody.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
      const name = profileLabel(readBook().clients.find(c => c.id === b.dataset.remove), 'esta empresa');
      writeBook(E.removeClient(readBook(), b.dataset.remove));
      profileChanged();
      toast(`${name} salió de tus empresas cliente`, 'info');
      openClientsView();
    }));
    document.getElementById('addClientBtn').addEventListener('click', () => openWizard(0, { newClient: true }));
  }

  /** Lista corta imprimible de la empresa en uso: lo que conviene revisar con ella esta semana. */
  function openShortList() {
    const profile = getProfile();
    const a = getAnalysis();
    if (!profile || !a) {
      openWizard(0);
      return;
    }
    const now = new Date();
    const rows = E.shortList(profile, DATA, a.detected, { now });
    const updated = window.PROSPECTS_UPDATED_AT ? new Date(window.PROSPECTS_UPDATED_AT) : null;
    const dateText = d => d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
    const windowText = r => {
      const w = r.window;
      if (w.state === 'abierta') return w.date ? `Abierta · cierra ${dateText(w.date)}` : 'Abierta';
      if (w.state === 'borrador') return 'Borrador de pliegos';
      if (w.state === 'cerrada') return 'Cerrada, en evaluación';
      return w.date ? `Adjudicada ${dateText(w.date)}` : 'Adjudicada';
    };
    // Mientras el proceso está abierto, SECOP no muestra las ofertas: "0 ofertas" se leería como
    // "sin competencia". El número solo se muestra si es positivo o si el proceso ya cerró.
    const competition = r => {
      const n = (r.item.competencia || {}).ofertas;
      if (typeof n !== 'number' || (n === 0 && (r.window.state === 'abierta' || r.window.state === 'borrador'))) return '';
      return `${n} ${n === 1 ? 'oferta' : 'ofertas'}`;
    };
    document.body.classList.add('print-shortlist');
    openModal(`
      <div class="shortlist">
        <div class="shortlist-head">
          <div>
            <div class="block-kicker">Lista corta · SECOP II</div>
            <h2 class="reveal-title">${esc(profileLabel(profile, 'Mi empresa'))}</h2>
            <p class="wizard-hint">${esc(a.detected.map(d => d.name).join(' · ') || 'Sin sector detectado')} · generada el ${esc(dateText(now))}${updated ? ` con datos del ${esc(dateText(updated))}` : ''}</p>
          </div>
          <button type="button" class="btn btn-primary no-print" id="printShortList">🖨️ Imprimir o guardar PDF</button>
        </div>
        ${rows.length ? `
        <ol class="shortlist-rows">
          ${rows.map(r => `
            <li class="shortlist-row">
              <div class="sl-top">
                <span class="match-pill">${r.match.score}%</span>
                <span class="sl-entity">${esc(r.item.entidad || '')}</span>
                <span class="sl-value">${esc(E.formatCopShort(r.item.precio || 0))}</span>
              </div>
              <p class="sl-desc">${esc((r.item.descripcion || '').slice(0, 220))}</p>
              <div class="sl-meta">${esc([windowText(r), [r.item.ciudad, r.item.departamento].filter(Boolean).join(', '), competition(r)].filter(Boolean).join(' · '))}</div>
              <div class="sl-step">→ ${esc(r.step.text)}${r.step.date ? ` · <b>${esc(dateText(r.step.date))}</b>` : ''}</div>
              ${r.item.url_secop ? `<a class="sl-link" href="${esc(r.item.url_secop)}" target="_blank" rel="noopener noreferrer">${esc(r.item.referencia || 'Ver en SECOP II')}</a>` : ''}
            </li>`).join('')}
        </ol>` : '<p class="reveal-note">Hoy no hay procesos en el tablero con afinidad suficiente para esta empresa. Ajusta su oferta o su zona en el perfil.</p>'}
        <p class="fine-print">Afinidad calculada con el perfil de la empresa sobre el tablero publicado; los requisitos habilitantes están en el pliego de cada proceso en SECOP II.</p>
      </div>`);
    document.getElementById('printShortList').addEventListener('click', () => window.print());
  }

  // Al cerrar el modal, la página vuelve a imprimirse completa.
  new MutationObserver(() => {
    if (!modal.classList.contains('active')) document.body.classList.remove('print-shortlist');
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });

  // ---------- Cuenta y banner ----------
  function openSignIn() {
    openModal(`
      <div class="signin">
        <div class="brand-icon">⚡</div>
        <h2 class="wizard-title">Entra a tu radar de contratación pública</h2>
        <p class="wizard-hint">Tu perfil, tus oportunidades con afinidad y tu pipeline, guardados en tu cuenta.</p>
        <div id="signinGoogleBtn" class="google-slot"></div>
        <p class="fine-print">Solo usamos tu nombre, correo y foto de Google. No publicamos nada en tu nombre.</p>
      </div>`);
    Auth.renderButton(document.getElementById('signinGoogleBtn'), { text: 'continue_with' });
  }

  function renderAccountArea() {
    const area = document.getElementById('accountArea');
    const user = Auth.getUser();
    if (!user) {
      area.innerHTML = '<button type="button" class="btn btn-outline" id="btnSignIn"><span class="g-mark">G</span> Iniciar sesión</button>';
      document.getElementById('btnSignIn').addEventListener('click', openSignIn);
      return;
    }
    const initials = (user.name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    area.innerHTML = `
      <div class="account-menu">
        <button type="button" class="account-btn" id="accountBtn" aria-haspopup="true" aria-expanded="false">
          ${user.picture ? `<img src="${esc(user.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar-fallback">${esc(initials)}</span>`}
          <span class="account-name">${esc(user.givenName || user.name)}</span>
        </button>
        <div class="account-dropdown" id="accountDropdown">
          <div class="account-email">${esc(user.email || 'Modo demo local')}</div>
          <button type="button" data-action="profile">👤 Mi perfil de oportunidades</button>
          <button type="button" data-action="edit">✏️ Editar perfil</button>
          <button type="button" data-action="clients">🏢 Empresas cliente</button>
          <button type="button" data-action="shortlist">📄 Lista corta</button>
          <button type="button" data-action="signout">↩︎ Cerrar sesión</button>
        </div>
      </div>`;
    const btn = document.getElementById('accountBtn');
    const dd = document.getElementById('accountDropdown');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = dd.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
    dd.querySelectorAll('[data-action]').forEach(item => item.addEventListener('click', () => {
      dd.classList.remove('open');
      if (item.dataset.action === 'profile') openProfileView();
      if (item.dataset.action === 'edit') openWizard(0);
      if (item.dataset.action === 'clients') openClientsView();
      if (item.dataset.action === 'shortlist') openShortList();
      if (item.dataset.action === 'signout') {
        Auth.signOut();
        toast('Sesión cerrada', 'info');
      }
    }));
  }

  function renderHero() {
    const hero = document.getElementById('profileHero');
    const user = Auth.getUser();
    const profile = getProfile();

    if (!profile) {
      hero.innerHTML = `
        <div class="hero-copy">
          <div class="hero-kicker">Nuevo · Perfil de Oportunidades</div>
          <h2>Descubre cuánto mercado público hay para lo que ofreces</h2>
          <p>Responde 4 preguntas y en 2 minutos te mostramos tu propuesta de valor clarificada, tu mercado en pesos, tu cliente ideal y las empresas con las que deberías conectar. Sin registro para empezar.</p>
        </div>
        <div class="hero-actions">
          <button type="button" class="btn btn-primary btn-lg" id="heroStart">✨ Crear mi perfil gratis</button>
          ${user ? '' : '<button type="button" class="link-btn" id="heroSignIn">Ya tengo cuenta</button>'}
        </div>`;
      document.getElementById('heroStart').addEventListener('click', () => openWizard(0));
      const si = document.getElementById('heroSignIn');
      if (si) si.addEventListener('click', openSignIn);
      return;
    }

    const a = getAnalysis();
    const forClient = readBook().active !== E.OWN_PROFILE;
    hero.innerHTML = `
      <div class="hero-profile">
        ${strengthRing(a.strength.score)}
        <div>
          <div class="hero-kicker">${forClient ? '🏢 Empresa cliente: ' : a.role.icon + ' '}${esc(profile.companyName || a.role.short)}${user ? '' : ' · perfil sin guardar'}</div>
          <h2>${a.matchCount} oportunidades con alta afinidad · ${E.formatCopShort(a.market.totalValue)} en tu mercado</h2>
          <p>${esc(a.valueProp)}</p>
        </div>
      </div>
      <div class="hero-actions">
        ${user
          ? `<button type="button" class="btn btn-primary" id="heroMatches">⚡ Ver para ti</button><button type="button" class="btn btn-outline" id="heroProfile">👤 ${forClient ? 'Perfil' : 'Mi perfil'}</button>${forClient || readBook().clients.length ? '<button type="button" class="btn btn-outline" id="heroClients">🏢 Cambiar empresa</button>' : ''}`
          : '<div id="heroGoogleBtn" class="google-slot"></div><button type="button" class="link-btn" id="heroProfile">Ver mi perfil</button>'}
      </div>`;
    document.getElementById('heroProfile').addEventListener('click', () => openProfileView());
    const hm = document.getElementById('heroMatches');
    if (hm) hm.addEventListener('click', () => window.showForYouTab && window.showForYouTab());
    const hc = document.getElementById('heroClients');
    if (hc) hc.addEventListener('click', openClientsView);
    if (!user) Auth.renderButton(document.getElementById('heroGoogleBtn'), { text: 'signup_with' });
  }

  document.addEventListener('click', () => {
    const dd = document.getElementById('accountDropdown');
    if (dd) dd.classList.remove('open');
  });

  // ---------- Ciclo de vida ----------
  Auth.onChange(user => {
    analysisCache = null;
    if (user) adoptDraft(user);
    renderAccountArea();
    renderHero();
    listeners.forEach(fn => fn(getProfile()));

    if (user) {
      toast(`Bienvenido, ${user.givenName || user.name}. Tu perfil quedó guardado.`, 'success');
      if (getProfile()) openProfileView();
      else openWizard(0);
    }
  });

  listeners.push(() => renderHero());

  window.SecopProfile = {
    getProfile,
    getAnalysis,
    matchItem,
    openWizard,
    openProfileView,
    openClientsView,
    openShortList,
    openSignIn,
    /** Guarda la plantilla del mensaje de contacto en el perfil activo. Sin perfil, no guarda. */
    saveContactTemplate(kind, text) {
      const profile = getProfile();
      if (!profile) return false;
      saveProfile(E.setContactTemplate(profile, kind, text));
      return true;
    },
    onChange: fn => listeners.push(fn)
  };

  renderAccountArea();
  renderHero();
})();
