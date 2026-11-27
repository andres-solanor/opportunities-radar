/**
 * Consultas en vivo a SECOP II (datos.gov.co) desde el navegador, solo de lectura.
 *
 * El tablero publica todo el cruce de sus 500 procesos. Para lo que no está en el tablero
 * (fuera del tablero, PAA y enlaces compartidos que ya salieron) el detalle se consulta aquí, al
 * abrirlo: no pesa en los archivos ni alarga la corrida diaria. datos.gov.co responde CORS con
 * `Access-Control-Allow-Origin: *` (verificado el 2026-10-01). La primera consulta tarda de 5 a
 * 7 s y las repetidas menos de 1 s.
 *
 * Las formas de salida son las del pipeline (`contrato`, `ofertas`, `entidad_stats`), para que
 * la vista de detalle las pinte igual. Mismos datasets y columnas que
 * src/enrichers/contract_enricher.py y open_sources.py. Nunca se leen teléfonos ni correos.
 *
 * Sin DOM. Se expone como window.SecopLive y como módulo CommonJS para las pruebas con Node.
 */
(function (root) {
  const BASE = 'https://www.datos.gov.co/resource/';
  const DATASETS = { procesos: 'p6dx-8zbt', contratos: 'jbjy-vk9h', ofertas: 'wi7w-2nvm' };
  const TIMEOUT_MS = 15000;
  const EMPTY = [null, undefined, '', 'No Definido', 'No definido', 'NO DEFINIDO', 'N/A', 'Sin Descripcion'];

  // ---------- Consultas ----------
  function soqlString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  function buildUrl(dataset, params) {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return `${BASE}${dataset}.json?${query}`;
  }

  /** Contratos firmados de un proceso: la llave es el portafolio (CO1.BDOS…), como en el pipeline. */
  function contractUrl(portfolio) {
    return buildUrl(DATASETS.contratos, { $where: `proceso_de_compra = ${soqlString(portfolio)}`, $limit: 20 });
  }

  function offersUrl(portfolio) {
    return buildUrl(DATASETS.ofertas, { $where: `id_del_proceso_de_compra = ${soqlString(portfolio)}`, $limit: 500 });
  }

  /** Comportamiento de la entidad en 12 meses: una fila agregada. */
  function entityUrl(nit, now = new Date()) {
    const since = new Date(now.getTime() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return buildUrl(DATASETS.contratos, {
      $select: 'count(*) as contratos, sum(valor_del_contrato) as valor, sum(valor_facturado) as facturado, sum(valor_pagado) as pagado',
      $where: `nit_entidad = ${soqlString(nit)} AND fecha_de_firma >= '${since}T00:00:00'`
    });
  }

  /**
   * Quién le gana a una entidad en una modalidad: los mismos filtros que el perfil del proponente
   * del pipeline (`meta.perfil_proponente`: desde, valor mínimo y tipos de contrato), para que la
   * cifra de la entidad y la nacional se comparen. Dos consultas agregadas: totales y contratistas.
   */
  function winnersWhere({ nitEntidad, modalities, desde, valorMin, tipos }) {
    const list = values => values.map(soqlString).join(', ');
    return [
      `nit_entidad = ${soqlString(nitEntidad)}`,
      `modalidad_de_contratacion in (${list(modalities)})`,
      `fecha_de_firma >= '${desde}T00:00:00'`,
      `valor_del_contrato >= ${Number(valorMin) || 0}`,
      tipos && tipos.length ? `tipo_de_contrato in (${list(tipos)})` : null
    ].filter(Boolean).join(' AND ');
  }

  function entityWinnersUrls(params) {
    const where = winnersWhere(params);
    return {
      totales: buildUrl(DATASETS.contratos, { $select: 'count(*) as n, sum(valor_del_contrato) as v', $where: where }),
      top: buildUrl(DATASETS.contratos, {
        $select: 'proveedor_adjudicado, tipodocproveedor, count(*) as n, sum(valor_del_contrato) as v',
        $where: where, $group: 'proveedor_adjudicado, tipodocproveedor', $order: 'n DESC, v DESC', $limit: 10
      })
    };
  }

  // Como src/enrichers/open_sources.py (NATURAL_PERSON_DOCS): la empresa usa NIT.
  const NATURAL_PERSON_DOCS = ['cédula', 'cedula', 'pasaporte', 'permiso', 'registro civil', 'tarjeta de identidad'];

  /** Filas agregadas → { contratos, valor, rows } con la forma de `perfil_proponente.modalidades[].top`. */
  function parseWinners(totalRows, topRows) {
    const total = totalRows && totalRows[0];
    return {
      contratos: total ? Math.round(toNumber(total.n) || 0) : 0,
      valor: total ? toNumber(total.v) : null,
      rows: (topRows || []).map(r => {
        const doc = String(r.tipodocproveedor || '').trim().toLowerCase();
        return {
          nombre: cleanName(r.proveedor_adjudicado),
          contratos: Math.round(toNumber(r.n) || 0),
          valor: toNumber(r.v) || 0,
          persona_natural: doc !== 'nit' && NATURAL_PERSON_DOCS.some(k => doc.includes(k))
        };
      }).filter(r => r.nombre)
    };
  }

  function entityWinners(params, opts = {}) {
    if (!params || !params.nitEntidad || !(params.modalities || []).length || !params.desde) return Promise.resolve(null);
    const urls = entityWinnersUrls(params);
    return Promise.all([getJson(urls.totales, opts), getJson(urls.top, opts)]).then(([t, r]) => parseWinners(t, r));
  }

  /** Un proceso por su id (para enlaces compartidos que ya no están en el tablero). */
  function processUrl(id) {
    return buildUrl(DATASETS.procesos, { $where: `id_del_proceso = ${soqlString(id)}`, $limit: 1 });
  }

  // ---------- Lectura de filas (espejo de contract_enricher.py) ----------
  function isEmpty(value) {
    return EMPTY.includes(value);
  }

  /** Primer valor no vacío entre los nombres conocidos o, si no, entre las columnas con ese prefijo. */
  function firstValue(row, names, prefix) {
    for (const name of names) if (!isEmpty(row[name])) return row[name];
    for (const key of Object.keys(row).sort()) if (key.startsWith(prefix) && !isEmpty(row[key])) return row[key];
    return null;
  }

  function toNumber(value) {
    if (isEmpty(value)) return null;
    const n = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function toIso(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const text = value.trim().replace('Z', '').slice(0, 19);
    const d = new Date(text.length === 10 ? `${text}T00:00:00` : text);
    return isNaN(d.getTime()) || d.getFullYear() < 2000 ? null : text.length === 10 ? `${text}T00:00:00` : text;
  }

  function toBool(value) {
    if (isEmpty(value)) return null;
    return ['si', 'sí', 'true', '1', 'yes'].includes(String(value).trim().toLowerCase());
  }

  /** 'V1.72141000' → '72141000' (como normalize_unspsc en Python); 'UNSPECIFIED' → null. */
  function toUnspsc(value) {
    const digits = String(value || '').trim().replace(/^[A-Za-z]\d*\./, '');
    return /^\d{4,8}$/.test(digits) ? digits : null;
  }

  function cleanName(value) {
    if (isEmpty(value) || typeof value !== 'string') return null;
    const name = value.replace(/\s+/g, ' ').trim();
    return name.length > 2 ? name : null;
  }

  function normalizeNit(value) {
    if (isEmpty(value)) return null;
    const digits = String(value).split('-')[0].replace(/\D/g, '');
    return digits || null;
  }

  function urlOf(value) {
    return value && typeof value === 'object' ? value.url || null : value || null;
  }

  /** Uno o varios contratos (lotes) de un proceso → el bloque `contrato` del pipeline. */
  function parseContract(rows) {
    if (!rows || !rows.length) return null;
    const f = (row, names, prefix) => firstValue(row, names, prefix);
    const sum = (names, prefix) => {
      const values = rows.map(r => toNumber(f(r, names, prefix))).filter(v => v !== null);
      return values.length ? values.reduce((a, b) => a + b, 0) : null;
    };
    const dates = (names, prefix) => rows.map(r => toIso(f(r, names, prefix))).filter(Boolean).sort();
    const main = rows[0];
    const valor = sum(['valor_del_contrato'], 'valor_del_contrato');
    const pagado = sum(['valor_pagado'], 'valor_pagado');
    const dias = sum(['dias_adicionados'], 'dias_adicionados');
    const start = dates(['fecha_de_inicio_de_ejecucion'], 'fecha_de_inicio_de_ejecuci');
    const startContract = dates(['fecha_de_inicio_del_contrato'], 'fecha_de_inicio_del_contrato');
    const end = dates(['fecha_de_fin_de_ejecucion'], 'fecha_de_fin_de_ejecuci');
    const endContract = dates(['fecha_de_fin_del_contrato'], 'fecha_de_fin_del_contrato');
    const origin = cleanName(f(main, ['origen_de_los_recursos'], 'origen_de_los_recursos'));
    return {
      cantidad: rows.length,
      estado: f(main, ['estado_contrato'], 'estado_contrato'),
      fecha_firma: dates(['fecha_de_firma'], 'fecha_de_firma')[0] || null,
      inicio_ejecucion: start[0] || startContract[0] || null,
      fin_ejecucion: end[end.length - 1] || endContract[endContract.length - 1] || null,
      valor,
      valor_facturado: sum(['valor_facturado'], 'valor_facturado'),
      valor_pagado: pagado,
      dias_adicionados: dias ? Math.round(dias) : 0,
      es_pyme: toBool(f(main, ['es_pyme'], 'es_pyme')),
      es_grupo: toBool(f(main, ['es_grupo'], 'es_grupo')),
      destino_gasto: f(main, ['destino_gasto'], 'destino_gasto'),
      origen_recursos: origin && origin.toLowerCase() !== 'distribuido' ? [origin] : [],
      direccion_ejecucion: cleanName(f(main, ['direcci_n_de_ejecuci_n_del_contrato'], 'direcci_n_de_ejecuci')),
      proveedor: cleanName(f(main, ['proveedor_adjudicado'], 'proveedor_adjudicado')),
      nit_proveedor: normalizeNit(f(main, ['documento_proveedor'], 'documento_proveedor')),
      url: urlOf(f(main, ['urlproceso'], 'urlproceso')),
      // Código UNSPSC del contrato ('V1.72141000' → '72141000'): suple al del proceso cuando SECOP II no lo publicó.
      unspsc: toUnspsc(f(main, ['codigo_de_categoria_principal'], 'codigo_de_categoria')),
      // Nombres por rol, como en el tablero (datos públicos de la contratación). Sin teléfonos ni correos.
      contactos: {
        representante_legal: cleanName(f(main, ['nombre_representante_legal'], 'nombre_representante_legal')),
        ordenador_gasto: cleanName(f(main, ['nombre_ordenador_del_gasto'], 'nombre_ordenador_del_gasto')),
        supervisor: cleanName(f(main, ['nombre_supervisor'], 'nombre_supervisor')),
        ordenador_pago: cleanName(f(main, ['nombre_ordenador_de_pago'], 'nombre_ordenador_de_pago'))
      }
    };
  }

  /** Ofertas de un proceso → el bloque `ofertas` del pipeline (sin repetidas, de menor a mayor valor). */
  function parseOffers(rows, winnerNit) {
    if (!rows || !rows.length) return null;
    const winner = normalizeNit(winnerNit);
    const seen = new Set();
    const bidders = [];
    [...rows].sort((a, b) => (toNumber(a.valor_de_la_oferta) || 0) - (toNumber(b.valor_de_la_oferta) || 0)).forEach(row => {
      const key = row.identificador_de_la_oferta || `${row.nit_del_proveedor}|${row.valor_de_la_oferta}`;
      if (seen.has(key)) return;
      seen.add(key);
      const nit = normalizeNit(row.nit_del_proveedor);
      bidders.push({
        proveedor: cleanName(row.nombre_proveedor),
        nit: nit && nit !== '0000' ? nit : null,
        valor: toNumber(row.valor_de_la_oferta),
        ganador: Boolean(winner && nit === winner)
      });
    });
    return { cantidad: bidders.length, proveedores: bidders.slice(0, 15) };
  }

  /** Fila agregada de la entidad → las cifras de `entidad_stats` que usan las fichas. */
  function parseEntity(rows) {
    const row = rows && rows[0];
    const count = row ? Math.round(toNumber(row.contratos) || 0) : 0;
    if (!count) return null;
    const facturado = toNumber(row.facturado);
    const pagado = toNumber(row.pagado);
    return {
      contratos_12m: count,
      valor_12m: toNumber(row.valor),
      pagado_sobre_facturado_pct: facturado && pagado !== null ? Math.round((1000 * pagado) / facturado) / 10 : null
    };
  }

  /** Proceso de SECOP II → ficha mínima para un enlace que ya no está en el tablero. */
  function parseProcess(rows) {
    const row = rows && rows[0];
    if (!row) return null;
    const awarded = String(row.adjudicado || '').trim().toLowerCase() === 'si';
    return {
      id: row.id_del_proceso,
      id_portafolio: row.id_del_portafolio || null,
      referencia: row.referencia_del_proceso || null,
      entidad: cleanName(row.entidad),
      nit_entidad: normalizeNit(row.nit_entidad),
      departamento: cleanName(row.departamento_entidad),
      ciudad: cleanName(row.ciudad_entidad),
      descripcion: cleanName(row.descripci_n_del_procedimiento) || cleanName(row.nombre_del_procedimiento) || '',
      // Como en el tablero: adjudicado → valor adjudicado; si no, precio base.
      precio: (awarded && toNumber(row.valor_total_adjudicacion)) || toNumber(row.precio_base) || 0,
      modalidad: row.modalidad_de_contratacion || null,
      tipo_contrato: row.tipo_de_contrato || null,
      estado_secop: row.estado_del_procedimiento || null,
      etapa_comercial: awarded ? 'Adjudicado (consulta en vivo)' : 'Proceso en SECOP II (consulta en vivo)',
      fecha_publicacion: toIso(row.fecha_de_publicacion_del),
      fecha_adjudicacion: awarded ? toIso(row.fecha_adjudicacion) : null,
      contratista: awarded && cleanName(row.nombre_del_proveedor)
        ? { nombre: cleanName(row.nombre_del_proveedor), es_consorcio: /consorcio|uni[oó]n temporal/i.test(row.nombre_del_proveedor) }
        : null,
      sectores: [],
      url_secop: urlOf(row.urlproceso),
      en_vivo: true
    };
  }

  // ---------- Red ----------
  const cache = new Map();

  /** GET con tiempo límite y caché de la sesión. `fetchFn` se inyecta en las pruebas. */
  function getJson(url, { fetchFn = root.fetch, timeoutMs = TIMEOUT_MS } = {}) {
    if (cache.has(url)) return cache.get(url);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const promise = Promise.resolve()
      .then(() => fetchFn(url, { signal: controller ? controller.signal : undefined, headers: { Accept: 'application/json' } }))
      .then(res => {
        if (!res.ok) throw new Error(`SECOP II respondió ${res.status}`);
        return res.json();
      })
      .finally(() => { if (timer) clearTimeout(timer); });
    cache.set(url, promise);
    promise.catch(() => cache.delete(url)); // un error no queda en caché: se puede reintentar
    return promise;
  }

  /**
   * Detalle en vivo de un proceso: { contrato, ofertas, entidad_stats, errores }. Cada consulta es
   * independiente: si una falla, las demás se muestran igual.
   */
  function processDetail({ portfolio, nitEntidad, winnerNit, now } = {}, opts = {}) {
    const jobs = {
      contrato: portfolio ? getJson(contractUrl(portfolio), opts).then(parseContract) : Promise.resolve(null),
      ofertas: portfolio ? getJson(offersUrl(portfolio), opts).then(rows => parseOffers(rows, winnerNit)) : Promise.resolve(null),
      entidad_stats: nitEntidad ? getJson(entityUrl(nitEntidad, now), opts).then(parseEntity) : Promise.resolve(null)
    };
    const keys = Object.keys(jobs);
    return Promise.allSettled(keys.map(k => jobs[k])).then(results => {
      const out = { errores: [] };
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') out[keys[i]] = r.value;
        else { out[keys[i]] = null; out.errores.push(keys[i]); }
      });
      return out;
    });
  }

  /** Código UNSPSC del contrato firmado de un proceso (por su portafolio); null si no hay contrato o código. */
  function contractCode(portfolio, opts = {}) {
    if (!portfolio) return Promise.resolve(null);
    return getJson(contractUrl(portfolio), opts).then(rows => (parseContract(rows) || {}).unspsc || null);
  }

  /** Un proceso por id, para enlaces compartidos que ya salieron del tablero; null si no existe. */
  function lookupProcess(id, opts = {}) {
    return getJson(processUrl(id), opts).then(parseProcess);
  }

  const api = {
    DATASETS,
    contractUrl,
    offersUrl,
    entityUrl,
    processUrl,
    entityWinnersUrls,
    parseWinners,
    entityWinners,
    parseContract,
    parseOffers,
    parseEntity,
    parseProcess,
    processDetail,
    contractCode,
    lookupProcess,
    clearCache: () => cache.clear()
  };

  root.SecopLive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
