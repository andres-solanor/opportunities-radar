/**
 * Motor del tablero: funciones puras (sin DOM) para filtrar, ordenar, resumir y exportar
 * oportunidades. `app.js` solo lee los controles, llama a estas funciones y pinta.
 *
 * Se expone como window.DashboardEngine y como módulo CommonJS para pruebas con Node.
 */
(function (root) {
  const EMPTY_NAMES = ['Pendiente por Adjudicar', 'No Definido', 'No definido'];
  const SIN_CLASIFICAR = 'sin_clasificar';
  // "Otros" en el filtro de sector: no son sectores de la taxonomía, salen de hidden.js.
  // Los seguros van aparte e identificados: solo una aseguradora puede ofertar en ellos.
  const SEGUROS = 'seguros';
  const OTHER_OPTIONS = [
    { id: SIN_CLASIFICAR, name: 'Otros: sin sector' },
    { id: SEGUROS, name: 'Otros: seguros (solo aseguradoras)' }
  ];

  function isInsurance(item) {
    return (item.tipo_contrato || '') === 'Seguros';
  }

  function isOtherSector(sector) {
    return sector === SIN_CLASIFICAR || sector === SEGUROS;
  }

  /**
   * Controles de filtro que se apartan de su valor por defecto, para resaltarlos.
   * Recibe [{ id, value, defaultValue }] y devuelve los ids activos, en el mismo orden.
   * Un texto de búsqueda con solo espacios no cuenta como filtro.
   */
  function activeFilters(controls) {
    return (controls || [])
      .filter(c => String(c.value ?? '').trim() !== String(c.defaultValue ?? '').trim())
      .map(c => c.id);
  }

  /** Prefijo de la URL pública de un proceso; la lista liviana (hidden.js) solo trae el noticeUID. */
  const SECOP_NOTICE_URL = 'https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?noticeUID=';

  /** URL del proceso en SECOP II: la completa si viene, o la reconstruida desde notice_uid. */
  function secopUrl(item) {
    if (!item) return '';
    if (item.url_secop) return item.url_secop;
    return item.notice_uid ? SECOP_NOTICE_URL + item.notice_uid : '';
  }

  /**
   * Registro completo para el detalle: los bloques de details.js (contrato, historial del
   * contratista, ofertas y cifras de la entidad) van encima de los recortados de la ficha.
   */
  function withDetails(item, details) {
    const extra = item && details && Object.prototype.hasOwnProperty.call(details, item.id) ? details[item.id] : null;
    return extra ? { ...item, ...extra } : item;
  }

  /** Fichas por página: el tablero pinta las primeras y un botón "Ver más" agrega las siguientes. */
  const PAGE_SIZE = 60;

  /**
   * Paginación de las fichas: cuántas se pintan con el límite actual, cuántas faltan y cuántas
   * agrega el siguiente "Ver más".
   */
  function pageInfo(total, limit = PAGE_SIZE) {
    const shown = Math.max(0, Math.min(total, limit));
    const remaining = Math.max(0, total - shown);
    return { shown, remaining, next: Math.min(PAGE_SIZE, remaining) };
  }

  /** Límite mínimo (en páginas completas) para que la ficha de la posición `index` quede pintada. */
  function limitToShow(index) {
    return index < 0 ? PAGE_SIZE : (Math.floor(index / PAGE_SIZE) + 1) * PAGE_SIZE;
  }

  /** ¿La oportunidad pertenece al sector elegido? Incluye las dos opciones de "Otros". */
  function matchesSector(item, sector) {
    if (!sector || sector === 'todos') return true;
    if (sector === SEGUROS) return isInsurance(item);
    const inSector = (item.sectores || []).some(s => s.id === sector);
    return sector === SIN_CLASIFICAR ? inSector && !isInsurance(item) : inSector;
  }

  function isAwarded(item) {
    return (item.etapa_comercial || '').toLowerCase().includes('adjudicado');
  }

  /** Oportunidades que pertenecen a una pestaña, antes de aplicar los filtros del usuario. */
  function tabItems(items, tab, ctx = {}) {
    if (tab === 'proveedores') return items.filter(isAwarded);
    if (tab === 'observatorio') return items.filter(i => !isAwarded(i));
    if (tab === 'parati') return items.filter(i => (ctx.matchScore ? ctx.matchScore(i) : 0) >= (ctx.minMatch || 0));
    if (tab === 'crm') return items.filter(i => ctx.crmState && ctx.crmState[i.id]);
    return items;
  }

  /** Minúsculas y sin tildes: SECOP escribe la misma modalidad con y sin tildes, y el PAA en MAYÚSCULAS. */
  function normalize(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  }

  // ---------- Modalidad de contratación ----------
  // Valores reales (2026-10-01): "Selección abreviada subasta inversa", "Licitación pública Obra
  // Publica", "Contratación régimen especial (con ofertas)", "Mínima cuantía"; en el PAA,
  // "SELECCION ABREVIADA CON SUBASTA INVERSA", "LICITACION PUBLICA (OBRA PUBLICA)" o vacío.
  // "Enajenación de bienes con subasta" no es subasta inversa: cae en "Otras modalidades".
  const MODALITIES = [
    { id: 'licitacion', label: 'Licitación pública', match: 'licitacion publica' },
    { id: 'menor_cuantia', label: 'Menor cuantía', match: 'menor cuantia' },
    { id: 'subasta', label: 'Subasta inversa', match: 'subasta inversa' },
    { id: 'minima_cuantia', label: 'Mínima cuantía', match: 'minima cuantia' },
    { id: 'concurso', label: 'Concurso de méritos', match: 'concurso de meritos' },
    { id: 'regimen_especial', label: 'Régimen especial', match: 'regimen especial' },
    { id: 'directa', label: 'Contratación directa', match: 'contratacion directa' },
    { id: 'otra', label: 'Otras modalidades' },
    { id: 'sin_dato', label: 'Sin modalidad reportada' }
  ];
  const EMPTY_MODALITY = ['', 'no definido', 'null'];

  function modalityOf(item) {
    const m = normalize(item.modalidad);
    if (EMPTY_MODALITY.includes(m)) return 'sin_dato';
    const found = MODALITIES.find(x => x.match && m.includes(x.match));
    return found ? found.id : 'otra';
  }

  /** Etiqueta corta para la ficha; las modalidades poco comunes conservan su texto original. */
  function modalityLabel(item) {
    const id = modalityOf(item);
    if (id === 'sin_dato') return '';
    if (id === 'otra') return item.modalidad;
    return MODALITIES.find(x => x.id === id).label;
  }

  // ---------- Persona natural ----------
  // Del perfil del proponente que publica el pipeline (meta.perfil_proponente): por modalidad,
  // qué parte de los contratos parecidos a los del tablero la ganó una persona natural.
  // Umbral elegido por el dueño el 2026-10-01 viendo la tabla calculada (mínima cuantía 18,8 %,
  // subasta 14,7 %, menor cuantía 14,3 %, régimen especial 12,8 %, licitación < 5 %).
  const PERSONA_NATURAL = 'persona_natural';
  const PERSONA_NATURAL_MIN_PCT = 12;
  const PROFILE_MIN_CONTRACTS = 100; // con menos contratos con dato, el porcentaje no es estable

  /** { idModalidad: { pct, natural, juridica, contratos } }; las filas se agrupan como el filtro. */
  function bidderShares(profile) {
    const acc = {};
    ((profile && profile.modalidades) || []).forEach(row => {
      const id = modalityOf({ modalidad: row.modalidad });
      if (id === 'otra' || id === 'sin_dato') return;
      const a = acc[id] || (acc[id] = { natural: 0, juridica: 0 });
      a.natural += row.persona_natural || 0;
      a.juridica += row.juridica || 0;
    });
    const out = {};
    Object.entries(acc).forEach(([id, a]) => {
      const known = a.natural + a.juridica;
      if (known >= PROFILE_MIN_CONTRACTS) {
        out[id] = { pct: Math.round((a.natural / known) * 1000) / 10, natural: a.natural, juridica: a.juridica, contratos: known };
      }
    });
    return out;
  }

  /** La cifra de la modalidad de la oportunidad, o null si no hay dato suficiente. */
  /**
   * Orden de los bloques del detalle según el estado del proceso, de lo que más decide a lo que
   * menos (pedido del dueño del 2026-10-02: "lo menos valioso estaba arriba"). Un bloque sin datos
   * no se pinta. "Quién gana" es contexto de mercado: va al final en todos los estados.
   *  - Abierto o en borrador (¿me presento?): qué piden, para cuándo, quién compite, cómo es la entidad.
   *  - Cerrado, en evaluación: lo nuevo son las ofertas, así que la competencia sube.
   *  - Adjudicado (¿le vendo al ganador?): quién ganó, si es riesgoso, qué necesita, a quién llamar.
   */
  const DETAIL_ORDER = {
    abierta: ['objeto', 'cronograma', 'competencia', 'entidad', 'contrato', 'contratista', 'integrantes', 'sanciones', 'contactos', 'necesidades', 'quien_gana'],
    cerrada: ['objeto', 'competencia', 'cronograma', 'entidad', 'contrato', 'contratista', 'integrantes', 'sanciones', 'contactos', 'necesidades', 'quien_gana'],
    adjudicado: ['objeto', 'contratista', 'sanciones', 'necesidades', 'contactos', 'integrantes', 'contrato', 'cronograma', 'competencia', 'entidad', 'quien_gana']
  };

  /** Ids de los bloques del detalle en orden para un estado de `ProfileEngine.bidWindow`. */
  function detailOrder(state) {
    if (state === 'adjudicado' || state === 'cerrada') return DETAIL_ORDER[state];
    return DETAIL_ORDER.abierta; // abierta y borrador
  }

  /** Nombres exactos de SECOP II · Contratos que caen en el grupo de modalidad del proceso. */
  function rawModalities(profile, item) {
    const id = modalityOf(item);
    if (id === 'otra' || id === 'sin_dato') return [];
    return ((profile && profile.modalidades) || [])
      .map(r => r.modalidad)
      .filter(m => modalityOf({ modalidad: m }) === id);
  }

  /** Concentración según la parte de los contratos que se llevan los 3 primeros. */
  function concentration(sharePct) {
    if (sharePct >= 50) return 'concentrado';
    if (sharePct >= 20) return 'repartido';
    return 'atomizado';
  }

  /**
   * Quién gana: suma por contratista las filas de varias modalidades (con y sin ofertas) y devuelve
   * los 3 primeros por número de contratos (desempate por valor), qué parte de los contratos se
   * llevan y cómo de concentrado está el mercado. `total` es el número de contratos del universo.
   */
  function summarizeWinners(rows, total, valor = null, size = 3) {
    const merged = new Map();
    (rows || []).forEach(r => {
      if (!r || !r.nombre) return;
      const key = normalize(r.nombre);
      const acc = merged.get(key) || { nombre: r.nombre, contratos: 0, valor: 0, persona_natural: Boolean(r.persona_natural) };
      acc.contratos += r.contratos || 0;
      acc.valor += r.valor || 0;
      merged.set(key, acc);
    });
    const top = [...merged.values()].sort((a, b) => b.contratos - a.contratos || b.valor - a.valor).slice(0, size);
    if (!total || !top.length) return null;
    const share = Math.round((100 * top.reduce((s, t) => s + t.contratos, 0)) / total);
    return { contratos: total, valor, top, share, concentracion: concentration(share) };
  }

  /** Quién gana en la modalidad del proceso en todo el país (perfil publicado por el pipeline). */
  function modalityWinners(profile, item) {
    const names = new Set(rawModalities(profile, item));
    const rows = ((profile && profile.modalidades) || []).filter(r => names.has(r.modalidad));
    if (!rows.some(r => Array.isArray(r.top))) return null; // perfil de una corrida anterior al 2026-10-02
    const total = rows.reduce((s, r) => s + (r.persona_natural || 0) + (r.juridica || 0) + (r.sin_dato || 0), 0);
    const valor = rows.reduce((s, r) => s + (r.valor || 0), 0);
    return summarizeWinners(rows.flatMap(r => r.top || []), total, valor);
  }

  function personaNaturalShare(shares, item) {
    return (shares && shares[modalityOf(item)]) || null;
  }

  /**
   * La cifra si la modalidad supera el umbral (para el badge y el filtro); si no, null.
   * Un adjudicado ya no admite proponentes: no se marca (el detalle sigue mostrando la cifra).
   */
  function personaNaturalFriendly(shares, item) {
    if (isAwarded(item)) return null;
    const share = personaNaturalShare(shares, item);
    return share && share.pct >= PERSONA_NATURAL_MIN_PCT ? share : null;
  }

  function modalityCounts(items) {
    const counts = {};
    items.forEach(item => {
      const id = modalityOf(item);
      counts[id] = (counts[id] || 0) + 1;
    });
    return counts;
  }

  // ---------- Fecha del estado actual ----------
  // Un solo filtro de tiempo para todas las pestañas: mide la fecha que importa según el estado.
  //   adjudicado → fecha de adjudicación; publicado o en borrador → fecha de publicación;
  //   compra planeada (PAA) → primer día del mes esperado (fecha futura).
  const AGE_PAST = [
    { id: '7', label: 'últimos 7 días', maxDays: 7 },
    { id: '30', label: 'últimos 30 días', maxDays: 30 },
    { id: '90', label: 'últimos 90 días', maxDays: 90 },
    { id: 'gt90', label: 'hace más de 90 días', minDays: 91 }
  ];
  const AGE_FUTURE = [
    { id: 'mes', label: 'este mes', maxMonths: 0 },
    { id: '3m', label: 'próximos 3 meses', maxMonths: 2 }
  ];

  function toDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  function isPlanned(item) {
    return item.mes_esperado != null && item.anio != null;
  }

  /**
   * Fecha del estado actual, o null si no se conoce. Un adjudicado sin fecha de adjudicación
   * devuelve null (no la de publicación): "adjudicado hace 7 días" no puede ser una suposición.
   */
  function stateDate(item) {
    if (isPlanned(item)) return new Date(Number(item.anio), Number(item.mes_esperado) - 1, 1);
    const fechas = item.fechas || {};
    if (isAwarded(item)) return toDate(fechas.adjudicacion || item.fecha_adjudicacion);
    return toDate(fechas.publicacion || item.fecha_publicacion);
  }

  /** Opciones del filtro de tiempo para una pestaña: el PAA mira hacia adelante; el CRM no filtra. */
  function ageOptions(tab) {
    if (tab === 'crm') return [];
    return tab === 'paa' ? AGE_FUTURE : AGE_PAST;
  }

  function matchesAge(item, age, now = new Date()) {
    if (!age || age === 'todas') return true;
    const d = stateDate(item);
    if (!d) return false;
    const future = AGE_FUTURE.find(o => o.id === age);
    if (future) {
      const months = (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth();
      return months >= 0 && months <= future.maxMonths;
    }
    const past = AGE_PAST.find(o => o.id === age);
    if (!past) return true;
    const startOfDay = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(d)) / (24 * 3600 * 1000));
    if (past.maxDays != null) return days <= past.maxDays;
    return days >= past.minDays;
  }

  /** Cuántas oportunidades no tienen fecha para el filtro de tiempo (no aparecen al filtrar). */
  function countUndated(items) {
    return items.filter(item => !stateDate(item)).length;
  }

  function matchesStage(item, stage) {
    if (!stage || stage === 'todos') return true;
    const text = (item.etapa_comercial || '').toLowerCase();
    if (stage === 'adjudicado') return text.includes('adjudicado');
    if (stage === 'ofertas') return text.includes('ofertas') || text.includes('abierta');
    if (stage === 'borrador') return text.includes('borrador');
    return true;
  }

  function searchCorpus(item) {
    return [
      item.referencia,
      item.entidad,
      item.descripcion,
      item.modalidad,
      item.contratista && item.contratista.nombre,
      item.contratista && item.contratista.nit,
      ...(item.materiales_detectados || [])
    ].join(' ').toLowerCase();
  }

  /**
   * Filtros del usuario. `filters`: { query, sector, stage, minBudget, department, onlyNew,
   * modality, age, bidderShares, now }. Los campos ausentes o en su valor neutro ('todos',
   * 'todas', 0, '') no filtran. `modality: 'persona_natural'` usa `bidderShares` (bidderShares()).
   * `now` solo existe para las pruebas.
   */
  function applyFilters(items, filters = {}) {
    const query = (filters.query || '').toLowerCase().trim();
    const sector = filters.sector || 'todos';
    const department = filters.department || 'todos';
    const modality = filters.modality || 'todas';
    const minBudget = Number(filters.minBudget) || 0;
    const now = filters.now || new Date();

    return items.filter(item => {
      if (filters.onlyNew && !item.nueva) return false;
      if (query && !searchCorpus(item).includes(query)) return false;
      if (!matchesSector(item, sector)) return false;
      if (!matchesStage(item, filters.stage)) return false;
      if (modality === PERSONA_NATURAL) {
        if (!personaNaturalFriendly(filters.bidderShares, item)) return false;
      } else if (modality !== 'todas' && modalityOf(item) !== modality) return false;
      if (!matchesAge(item, filters.age, now)) return false;
      const value = item.precio != null ? item.precio : item.valor;
      if (minBudget > 0 && (value || 0) < minBudget) return false;
      if (department !== 'todos' && item.departamento !== department) return false;
      return true;
    });
  }

  function isFiltered(filters = {}) {
    return Boolean(
      (filters.query || '').trim() ||
      (filters.sector && filters.sector !== 'todos') ||
      (filters.stage && filters.stage !== 'todos') ||
      (Number(filters.minBudget) || 0) > 0 ||
      (filters.department && filters.department !== 'todos') ||
      (filters.modality && filters.modality !== 'todas') ||
      (filters.age && filters.age !== 'todas') ||
      filters.onlyNew
    );
  }

  /** Cifras de las tarjetas KPI: todas salen de las listas, ninguna se escribe a mano. */
  function kpis(filtered, baseline) {
    const sum = list => list.reduce((acc, it) => acc + (it.precio || 0), 0);
    const filteredSum = sum(filtered);
    const baselineSum = sum(baseline);
    const scored = filtered.filter(it => typeof it.score_calidad === 'number');
    const pct = baselineSum > 0 ? Math.round((filteredSum / baselineSum) * 100) : null;
    return {
      count: filtered.length,
      baselineCount: baseline.length,
      sum: filteredSum,
      baselineSum,
      pct,
      // Texto del porcentaje: una parte positiva que redondea a 0 se muestra "<1%", no "0%".
      pctLabel: pct === null ? null : (pct === 0 && filteredSum > 0 ? '<1%' : `${pct}%`),
      avgScore: scored.length ? Math.round(scored.reduce((acc, it) => acc + it.score_calidad, 0) / scored.length) : null
    };
  }

  function formatCop(val) {
    if (val >= 1_000_000_000_000) {
      return `$${(val / 1_000_000_000_000).toFixed(2).replace('.', ',')} Billones COP`;
    } else if (val >= 1_000_000_000) {
      return `$${(val / 1_000_000_000).toFixed(1).replace('.', ',')} Mil Millones COP`;
    }
    return `$${Math.round(val / 1_000_000).toLocaleString('es-CO')} Millones COP`;
  }

  function departments(items) {
    return Array.from(new Set(items.map(i => i.departamento).filter(d => d && d !== 'No Definido'))).sort();
  }

  /** Opciones del filtro de sector, generadas desde la taxonomía del pipeline. */
  function sectorOptions(taxonomy) {
    return Object.keys(taxonomy || {}).map(id => ({ id, name: taxonomy[id].name }));
  }

  /**
   * Sectores agrupados por familia, en el orden de `groups` (window.SECTOR_GROUPS). Un sector
   * con un grupo desconocido (o una taxonomía vieja sin grupos) va a "Otros sectores".
   */
  function sectorGroups(taxonomy, groups) {
    const known = (groups || []).map(g => ({ id: g.id, name: g.name, sectors: [] }));
    const byId = new Map(known.map(g => [g.id, g]));
    const rest = { id: 'otros_sectores', name: 'Otros sectores', sectors: [] };
    sectorOptions(taxonomy).forEach(s => {
      (byId.get(taxonomy[s.id].grupo) || rest).sectors.push(s);
    });
    return [...known, rest].filter(g => g.sectors.length);
  }

  /** Cuántas oportunidades hay por sector (una oportunidad cuenta en cada uno de sus sectores). */
  function sectorCounts(items) {
    const counts = {};
    const add = id => { counts[id] = (counts[id] || 0) + 1; };
    items.forEach(item => {
      // Un seguro sin sector cuenta en "Otros: seguros", no en "Otros: sin sector".
      (item.sectores || []).forEach(s => { if (!(s.id === SIN_CLASIFICAR && isInsurance(item))) add(s.id); });
      if (isInsurance(item)) add(SEGUROS);
    });
    return counts;
  }

  /**
   * "Otros" en Radar B2B y Observatorio: los procesos sin sector de hidden.js, repartidos igual
   * que el tablero (adjudicados al Radar, el resto al Observatorio). Es una muestra: hidden.js
   * trae los de mayor puntaje, no todos.
   */
  function otherItems(hiddenItems, tab) {
    const unclassified = (hiddenItems || []).filter(i => i.motivo === 'sin_sector');
    return tab === 'proveedores' || tab === 'observatorio' ? tabItems(unclassified, tab) : [];
  }

  /** Sectores con más valor en una lista, para la tarjeta KPI (valor en COP, de mayor a menor). */
  function topSectors(items, taxonomy, n) {
    const acc = new Map();
    items.forEach(item => (item.sectores || []).forEach(s => {
      if (!taxonomy || !taxonomy[s.id]) return;
      const cur = acc.get(s.id) || { id: s.id, name: taxonomy[s.id].name, value: 0, count: 0 };
      cur.value += item.precio || 0;
      cur.count += 1;
      acc.set(s.id, cur);
    }));
    return [...acc.values()].sort((a, b) => b.value - a.value || b.count - a.count).slice(0, n);
  }

  /** El CRM guarda ids; una oportunidad puede salir del dataset en una sincronización posterior. */
  function crmSummary(crmState, items) {
    const present = new Set(items.map(i => i.id));
    const ids = Object.keys(crmState || {});
    const active = ids.filter(id => present.has(id));
    return { total: ids.length, active: active.length, missing: ids.length - active.length };
  }

  // ---------- Seguimiento de lo guardado en el CRM ----------
  // Guardar en el CRM es seguir el proceso: se guarda una foto de estos campos y, en cada
  // visita, se compara con la sincronización del día. `kind` le dice a la web cómo mostrarlo.
  const FOLLOW_FIELDS = [
    { key: 'cierre', label: 'Cierre de ofertas', kind: 'date', get: i => i.fechas && i.fechas.cierre_ofertas },
    { key: 'apertura', label: 'Apertura de ofertas', kind: 'date', get: i => i.fechas && i.fechas.apertura_ofertas },
    { key: 'adjudicacion', label: 'Fecha de adjudicación', kind: 'date', get: i => i.fechas && i.fechas.adjudicacion },
    { key: 'fase', label: 'Fase', kind: 'text', get: i => i.fase },
    { key: 'estado', label: 'Estado en SECOP II', kind: 'text', get: i => i.estado_secop },
    { key: 'precio', label: 'Valor', kind: 'money', get: i => i.precio },
    { key: 'ofertas', label: 'Ofertas recibidas', kind: 'count', get: i => i.competencia && i.competencia.ofertas },
    { key: 'contratista', label: 'Contratista', kind: 'text', get: i => (EMPTY_NAMES.includes(i.contratista && i.contratista.nombre) ? null : i.contratista && i.contratista.nombre) }
  ];
  // Aviso aparte cuando al cierre le quedan estos días o menos (como Nuntaria: tres días).
  const FOLLOW_CLOSING_DAYS = 3;

  function followValue(field, item) {
    const v = field.get(item);
    return v === undefined || v === '' ? null : v;
  }

  /** Foto de los campos seguidos de una oportunidad. */
  function followSnapshot(item) {
    const snap = {};
    FOLLOW_FIELDS.forEach(f => { snap[f.key] = followValue(f, item); });
    return snap;
  }

  /**
   * Qué cambió entre la foto y la oportunidad de hoy. Un campo que la foto no tiene (una foto
   * anterior a que existiera ese campo) no cuenta como cambio.
   */
  function followChanges(snap, item) {
    if (!snap || !item) return [];
    return FOLLOW_FIELDS
      .filter(f => Object.prototype.hasOwnProperty.call(snap, f.key))
      .map(f => ({ key: f.key, label: f.label, kind: f.kind, before: snap[f.key], after: followValue(f, item) }))
      .filter(c => c.before !== c.after);
  }

  /**
   * Las entradas del CRM sin foto (guardadas antes del seguimiento) reciben la de hoy, sin
   * reportar cambios. Devuelve un estado nuevo y si hubo que agregar alguna foto.
   */
  function followInit(crmState, items) {
    const byId = new Map(items.map(i => [i.id, i]));
    const next = {};
    let added = false;
    Object.entries(crmState || {}).forEach(([id, entry]) => {
      const item = byId.get(id);
      if (entry && !entry.snap && item) {
        next[id] = { ...entry, snap: followSnapshot(item) };
        added = true;
      } else {
        next[id] = entry;
      }
    });
    return { state: next, added };
  }

  /**
   * Entrada del CRM al guardar o mover de estado: conserva la foto, o la toma si no hay.
   * Sin la oportunidad no hay foto: `followInit` la toma cuando vuelva a estar en el tablero.
   */
  function followEntry(previous, status, item, now = new Date()) {
    const entry = { ...(previous || {}), status, updatedAt: now.toISOString() };
    if (!entry.snap && item) entry.snap = followSnapshot(item);
    return entry;
  }

  /** "Visto": la foto pasa a ser la de hoy. */
  function followAck(entry, item, now = new Date()) {
    return { ...entry, snap: followSnapshot(item), seenAt: now.toISOString() };
  }

  /**
   * Resumen para el tablero: lo seguido que cambió desde la última foto y lo que cierra pronto.
   * `windowOf(item)` es ProfileEngine.bidWindow (estado real y días al cierre).
   */
  function followDigest(crmState, items, windowOf) {
    const byId = new Map(items.map(i => [i.id, i]));
    const changed = [];
    const closingSoon = [];
    Object.entries(crmState || {}).forEach(([id, entry]) => {
      const item = byId.get(id);
      if (!item || !entry) return;
      const changes = followChanges(entry.snap, item);
      if (changes.length) changed.push({ id, item, changes });
      const bw = windowOf ? windowOf(item) : null;
      if (bw && bw.state === 'abierta' && typeof bw.days === 'number' && bw.days >= 0 && bw.days < FOLLOW_CLOSING_DAYS + 1) {
        closingSoon.push({ id, item, days: Math.floor(bw.days) });
      }
    });
    return { changed, closingSoon };
  }

  // ---------- CSV ----------
  function csvCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return String(value);
    let text = String(value);
    // Una celda que empieza por = + - @ se ejecuta como fórmula al abrir el CSV en Excel.
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function buildCsv(headers, rows) {
    const lines = [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))];
    return '﻿' + lines.join('\r\n');
  }

  // ---------- Fuera del tablero ----------
  function familyOf(item) {
    return item.unspsc ? item.unspsc.slice(0, 4) : 'sin código';
  }

  /** `filters` agrega a los del tablero: { reason: 'todos'|'sin_sector'|'fuera_de_corte', family }. */
  function filterHidden(items, filters = {}) {
    const reason = filters.reason || 'todos';
    const family = filters.family || 'todas';
    const base = items.filter(item => {
      if (reason !== 'todos' && item.motivo !== reason) return false;
      if (family !== 'todas' && familyOf(item) !== family) return false;
      return true;
    });
    return applyFilters(base, filters);
  }

  /** Familias UNSPSC presentes, de mayor a menor número de procesos. */
  function hiddenFamilies(items) {
    const groups = new Map();
    items.forEach(item => {
      const key = familyOf(item);
      const g = groups.get(key) || { family: key, count: 0, value: 0 };
      g.count += 1;
      g.value += item.precio || 0;
      groups.set(key, g);
    });
    return Array.from(groups.values()).sort((a, b) => b.count - a.count || b.value - a.value);
  }

  // ---------- Enlaces para compartir (#op=<id>) ----------
  // El hash no viaja al servidor y funciona en GitHub Pages sin backend.
  const DEEP_LINK_KEY = 'op';

  /** "#op=CO1.REQ.123" → "CO1.REQ.123"; null si el hash no es un enlace a una oportunidad. */
  function parseDeepLink(hash) {
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const id = (params.get(DEEP_LINK_KEY) || '').trim();
    return id || null;
  }

  function deepLinkHash(id) {
    return `#${DEEP_LINK_KEY}=${encodeURIComponent(id)}`;
  }

  /**
   * Busca una oportunidad compartida: tablero, luego PAA, luego lo oculto (si ya se cargó).
   * Devuelve { item, source: 'board'|'paa'|'hidden', tab } o null.
   */
  function findOpportunity(id, sources = {}) {
    if (!id) return null;
    const board = (sources.board || []).find(i => i.id === id);
    if (board) return { item: board, source: 'board', tab: isAwarded(board) ? 'proveedores' : 'observatorio' };
    const paa = (sources.paa || []).find(i => String(i.id) === id);
    if (paa) return { item: paa, source: 'paa', tab: 'paa' };
    const hidden = (sources.hidden || []).find(i => i.id === id);
    if (hidden) return { item: hidden, source: 'hidden', tab: 'hidden' };
    return null;
  }

  const api = {
    parseDeepLink,
    deepLinkHash,
    findOpportunity,
    EMPTY_NAMES,
    SIN_CLASIFICAR,
    SEGUROS,
    OTHER_OPTIONS,
    isAwarded,
    isInsurance,
    isOtherSector,
    activeFilters,
    SECOP_NOTICE_URL,
    secopUrl,
    withDetails,
    PAGE_SIZE,
    pageInfo,
    limitToShow,
    matchesSector,
    tabItems,
    MODALITIES,
    modalityOf,
    modalityLabel,
    modalityCounts,
    PERSONA_NATURAL,
    PERSONA_NATURAL_MIN_PCT,
    bidderShares,
    personaNaturalShare,
    detailOrder,
    rawModalities,
    concentration,
    summarizeWinners,
    modalityWinners,
    personaNaturalFriendly,
    stateDate,
    ageOptions,
    matchesAge,
    countUndated,
    applyFilters,
    isFiltered,
    kpis,
    formatCop,
    departments,
    sectorOptions,
    sectorGroups,
    sectorCounts,
    otherItems,
    topSectors,
    crmSummary,
    FOLLOW_FIELDS,
    FOLLOW_CLOSING_DAYS,
    followSnapshot,
    followChanges,
    followInit,
    followEntry,
    followAck,
    followDigest,
    csvCell,
    buildCsv,
    familyOf,
    filterHidden,
    hiddenFamilies
  };

  root.DashboardEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
