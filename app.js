/*
 * Lector de archivos .sor (Telcordia SR-4731, formatos Bellcore 1.x y 2.x)
 * Corre entero en el navegador: el archivo nunca sale de la maquina.
 *
 * parseSOR(arrayBuffer) -> {
 *   formato, version, gen, fxd, sup, eventos[], resumen{}
 * }
 */
const SOL = 299792.458 / 1.0e6; // km/us

class Lector {
  constructor(buffer) {
    this.dv = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.pos = 0;
  }
  get length() { return this.bytes.length; }
  seek(p) { this.pos = p; }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v += this.bytes[this.pos + i] * 2 ** (8 * i);
    this.pos += n;
    return v;
  }
  s(n) {
    const bits = 8 * n;
    let v = this.u(n);
    if (v >= 2 ** (bits - 1)) v -= 2 ** bits;
    return v;
  }
  texto(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += String.fromCharCode(this.bytes[this.pos + i]);
    this.pos += n;
    return out;
  }
  cadena() {
    let out = '';
    while (this.pos < this.length) {
      const b = this.bytes[this.pos++];
      if (b === 0) break;
      out += String.fromCharCode(b);
    }
    return out;
  }
}

function tipoFibra(v) {
  const t = {
    651: 'G.651 (multimodo 50um)', 652: 'G.652 (SMF estandar)',
    653: 'G.653 (dispersion desplazada)', 654: 'G.654 (optimizada 1550)',
    655: 'G.655 (dispersion desplazada no nula)', 657: 'G.657',
  };
  return t[v] || `${v} (desconocida)`;
}

function tipoEvento(codigo) {
  const m = /^(.)(.)9999LS/.exec(codigo);
  if (!m) return codigo.trim();
  const sub = { '0': 'perdida', '1': 'reflectivo', '2': 'multiple' }[m[1]] || 'desconocido';
  return `${sub} (${m[2] === 'A' ? 'manual' : 'automatico'})`;
}

function leerMapa(r) {
  const res = { bloques: {} };
  const cabecera = r.cadena();
  if (cabecera === 'Map') {
    res.formato = 2;
  } else {
    res.formato = 1;
    r.seek(0);
  }
  res.version = (r.u(2) * 0.01).toFixed(2);
  const nbytes = r.u(4);
  const nbloques = r.u(2) - 1;
  let inicio = nbytes;
  for (let i = 0; i < nbloques; i++) {
    const nombre = r.cadena();
    const version = (r.u(2) * 0.01).toFixed(2);
    const tam = r.u(4);
    res.bloques[nombre] = { nombre, version, tam, pos: inicio, orden: i };
    inicio += tam;
  }
  return res;
}

function irABloque(r, mapa, nombre) {
  const b = mapa.bloques[nombre];
  if (!b) return false;
  r.seek(b.pos);
  if (mapa.formato === 2) {
    const cab = r.texto(nombre.length + 1);
    if (cab !== nombre + '\0') return false;
  }
  return true;
}

function leerGenParams(r, mapa) {
  if (!irABloque(r, mapa, 'GenParams')) return {};
  const g = {};
  g.idioma = r.texto(2);
  const campos = mapa.formato === 2
    ? ['cable', 'fibra', 'tipoFibra', 'longitudOnda', 'ubicacionA', 'ubicacionB',
       'codigoCable', 'condicion', 'offset', 'offsetDistancia', 'operador', 'comentarios']
    : ['cable', 'fibra', 'longitudOnda', 'ubicacionA', 'ubicacionB', 'codigoCable',
       'condicion', 'offset', 'operador', 'comentarios'];
  for (const campo of campos) {
    if (campo === 'condicion') g[campo] = r.texto(2);
    else if (campo === 'tipoFibra') g[campo] = tipoFibra(r.u(2));
    else if (campo === 'longitudOnda') g[campo] = r.u(2);
    else if (campo === 'offset' || campo === 'offsetDistancia') g[campo] = r.s(4);
    else g[campo] = r.cadena().trim();
  }
  return g;
}

function leerFxdParams(r, mapa) {
  if (!irABloque(r, mapa, 'FxdParams')) return {};
  const base = r.pos;
  const v2 = mapa.formato === 2;
  const campos = v2
    ? [['fecha', 0, 4, 'u', 1], ['unidad', 4, 2, 's', 1], ['longitudOnda', 6, 2, 'u', 0.1],
       ['anchoPulso', 18, 2, 'u', 1], ['espaciado', 20, 4, 'u', 1e-8],
       ['puntos', 24, 4, 'u', 1], ['ior', 28, 4, 'u', 1e-5], ['bc', 32, 2, 'u', -0.1],
       ['promedios', 34, 4, 'u', 1], ['tiempoPromedio', 38, 2, 'u', 1],
       ['alcance', 40, 4, 'u', 2e-5], ['umbralPerdida', 58, 2, 'u', 0.001],
       ['umbralReflexion', 60, 2, 'u', -0.001], ['umbralFin', 62, 2, 'u', 0.001],
       ['tipoTraza', 64, 2, 's', 1]]
    : [['fecha', 0, 4, 'u', 1], ['unidad', 4, 2, 's', 1], ['longitudOnda', 6, 2, 'u', 0.1],
       ['anchoPulso', 14, 2, 'u', 1], ['espaciado', 16, 4, 'u', 1e-8],
       ['puntos', 20, 4, 'u', 1], ['ior', 24, 4, 'u', 1e-5], ['bc', 28, 2, 'u', -0.1]];
  const f = {};
  for (const [nombre, off, largo, tipo, mult] of campos) {
    r.seek(base + off);
    f[nombre] = tipo === 's' ? r.texto(largo).replace(/\0/g, '').trim()
                             : r.u(largo) * mult;
  }
  return f;
}

function leerSupParams(r, mapa) {
  if (!irABloque(r, mapa, 'SupParams')) return {};
  return {
    proveedor: r.cadena().trim(),
    equipo: r.cadena().trim(),
    serie: r.cadena().trim(),
    modulo: r.cadena().trim(),
    serieModulo: r.cadena().trim(),
    software: r.cadena().trim(),
  };
}

function leerKeyEvents(r, mapa, ior) {
  if (!irABloque(r, mapa, 'KeyEvents')) return { eventos: [], resumen: {} };
  const factor = 1e-4 * SOL / ior;
  const n = r.u(2);
  const eventos = [];
  for (let i = 0; i < n; i++) {
    const numero = r.u(2);
    const distancia = r.u(4) * factor;          // km
    const pendiente = r.s(2) * 0.001;           // dB/km
    const perdida = r.s(2) * 0.001;             // dB
    const reflectancia = r.s(4) * 0.001;        // dB
    const codigo = r.texto(8);
    if (mapa.formato === 2) { r.u(4); r.u(4); r.u(4); r.u(4); r.u(4); }
    const comentarios = r.cadena();
    eventos.push({
      numero, distancia, posicion_m: distancia * 1000, pendiente,
      perdida, reflectancia, tipo: tipoEvento(codigo), codigo, comentarios,
    });
  }
  const resumen = {
    perdidaTotal: r.s(4) * 0.001,
    inicio: r.s(4) * factor,
    fin: r.u(4) * factor,
    orl: r.u(2) * 0.001,
  };
  return { eventos, resumen };
}

/**
 * Deduce los nodos del tramo a partir de los datos del .sor.
 * Ej: fiber ID "Garabato-Los Amores-25" -> {nodoA:"GARABATO", nodoB:"LOS AMORES"}
 */
function nombresDeTramo(gen, nombreArchivo = '', carpeta = '') {
  const a = (gen.ubicacionA || '').trim();
  const b = (gen.ubicacionB || '').trim();
  if (a && b) return { nodoA: a.toUpperCase(), nodoB: b.toUpperCase() };

  // el nombre del archivo primero: "San Justo a Calchaqui-33.sor"
  for (const origen of [nombreArchivo, carpeta, gen.fibra, gen.cable]) {
    let texto = String(origen || '').trim();
    if (!texto) continue;
    texto = texto.replace(/\.sor$/i, '');
    texto = texto.replace(/[\s_-]*(a-?b|b-?a|ab|ba|ida|vuelta)$/i, '');  // sufijo de sentido
    texto = texto.replace(/[\s_-]*\d{1,3}$/, '');            // numero de pelo
    texto = texto.replace(/[\s_-]*(a-?b|b-?a)$/i, '');
    texto = texto.replace(/\d{3,4}\s*nm/gi, ' ').trim();
    // "Calchaqui_a_San_Justo" y "Calchaqui a San Justo" son lo mismo
    const plano = texto.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    const separadores = [[plano, /\s+a\s+/i], [plano, /\s+hacia\s+/i],
                         [plano, /\s+to\s+/i], [plano, /\s*[-–]\s*/],
                         [texto, /\s*_\s*/]];
    for (const [base, sep] of separadores) {
      const partes = base.split(sep).map((x) => x.trim()).filter(Boolean);
      if (partes.length >= 2) {
        return {
          nodoA: partes[0].toUpperCase(),
          nodoB: partes.slice(1).join(' - ').toUpperCase(),
        };
      }
    }
  }
  return { nodoA: '', nodoB: '' };
}

/**
 * Perdida de tramo reconstruida desde la tabla de eventos: suma de la perdida
 * de cada evento mas la atenuacion de cada seccion. Equivale a la columna
 * "Acumulativo" del informe y no depende de donde quedaron los marcadores.
 */
function perdidaReconstruida(eventos) {
  let acum = 0;
  let previo = 0;
  for (const e of eventos) {
    acum += (e.pendiente || 0) * (e.distancia - previo);
    if (e.perdida) acum += e.perdida;
    previo = e.distancia;
  }
  return Math.round(acum * 1000) / 1000;
}

/**
 * Curva de la traza (bloque DataPts). Se guarda cruda, en 16 bits, para no
 * ocupar memoria de más: nivel en dB = (max - crudo) x fs.
 */
function leerDataPts(r, mapa, fxd, ior) {
  try {
    if (!irABloque(r, mapa, 'DataPts')) return null;
    const b = mapa.bloques.DataPts;
    const fin = b.tam > 0 ? Math.min(r.length, b.pos + b.tam) : r.length;
    let n = r.u(4);
    r.s(2);                       // cantidad de factores de escala
    const n2 = r.u(4);            // puntos que usan este factor
    const escala = r.u(2) / 1000;
    if (n2 && n2 < n) n = n2;
    n = Math.min(n, Math.floor((fin - r.pos) / 2), 4000000);
    if (!(n > 1)) return null;
    const raw = new Uint16Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      const v = r.dv.getUint16(r.pos + 2 * i, true);
      raw[i] = v;
      if (v > max) max = v;
    }
    const dx = (fxd.espaciado || 0) * SOL / ior;     // km entre puntos
    if (!(dx > 0)) return null;
    return { n, raw, max, fs: 0.001 * (escala || 1), dx };
  } catch (e) {
    return null;
  }
}

function parseSOR(buffer) {
  const r = new Lector(buffer);
  const mapa = leerMapa(r);
  const gen = leerGenParams(r, mapa);
  const fxd = leerFxdParams(r, mapa);
  const sup = leerSupParams(r, mapa);
  const ior = fxd.ior || 1.4682;
  const { eventos, resumen } = leerKeyEvents(r, mapa, ior);
  return {
    formato: mapa.formato, version: mapa.version,
    gen, fxd, sup, eventos, resumen,
    traza: leerDataPts(r, mapa, fxd, ior),
    perdidaTramo: perdidaReconstruida(eventos),
    longitud_m: (resumen.fin || (eventos.length ? eventos[eventos.length - 1].distancia : 0)) * 1000,
  };
}
/*
 * Motor de deteccion de empalmes: misma metodologia que el script Python.
 *  - progresivas tal cual las mide el OTDR en cada sentido
 *  - histograma con bin de 20 m y suavizado de +/-40 m
 *  - separacion minima = max(130 m, ancho de pulso x 0,1021)
 *  - ventana de captura de +/-250 m acotada por el empalme vecino
 *  - confirmacion cruzada entre sentidos
 */
const BIN_M = 20;
const SUAVIZADO_M = 40;
const SEPARACION_PISO_M = 130;
const VENTANA_M = 250;
// margen en los extremos: el primer conector y el fin de fibra no son empalmes
const MARGEN_EXTREMOS_M = 150;
const FACTOR_PULSO_M_NS = 0.1021;

function separacionMinima(pulsoNs, fija) {
  if (fija) return fija;
  if (!pulsoNs) return SEPARACION_PISO_M;
  return Math.max(SEPARACION_PISO_M, pulsoNs * FACTOR_PULSO_M_NS);
}

const media = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const mediana = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function coincidencia(a, b) {
  if (!a.length || !b.length) return Infinity;
  return media(a.map((x) => Math.min(...b.map((y) => Math.abs(y - x)))));
}

/**
 * Dos mediciones del mismo pelo no pueden estar en el mismo sentido. Si el
 * nombre no alcanzo para distinguirlas, se comparan las posiciones: si encajan
 * mejor espejadas que directas, son sentidos opuestos.
 */
function corregirSentidosDelPar(mediciones, longitud) {
  const grupos = new Map();
  for (const m of mediciones) {
    if (m.numero == null || m.manual) continue;
    const k = `${m.numero}|${m.onda || 1550}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(m);
  }
  let corregidas = 0;
  for (const par of grupos.values()) {
    if (par.length !== 2) continue;
    const [m1, m2] = par;
    if (m1.sentido !== m2.sentido) continue;      // ya están bien
    const p1 = m1.eventos.map((e) => e.posicion_m);
    const p2 = m2.eventos.map((e) => e.posicion_m);
    const largo = m2.longitud_m || longitud;
    if (coincidencia(p2.map((p) => largo - p), p1) < coincidencia(p2, p1)) {
      m2.sentido = m1.sentido === 'A' ? 'B' : 'A';
      m2.corregido = true;
      corregidas += 1;
    }
  }
  return corregidas;
}

/**
 * Sentido por los nodos que declara cada medicion. Si un archivo dice
 * "Garabato - Los Amores" y otro "Los Amores - Garabato", el segundo es el
 * sentido inverso aunque el nombre no lo aclare.
 */
function sentidosPorTramo(mediciones, orientacionA = null) {
  const clave = (m) => {
    const t = m.tramo || {};
    const a = (t.nodoA || '').trim().toUpperCase();
    const b = (t.nodoB || '').trim().toUpperCase();
    return a && b ? `${a}|${b}` : null;
  };
  const cuenta = new Map();
  for (const m of mediciones) {
    const k = clave(m);
    if (k) cuenta.set(k, (cuenta.get(k) || 0) + 1);
  }
  if (cuenta.size < 2) return 0;
  // manda la orientacion declarada en pantalla; si no, la mas frecuente
  const invertida = orientacionA
    ? orientacionA.split('|').reverse().join('|') : null;
  const refA = (orientacionA && (cuenta.has(orientacionA) || cuenta.has(invertida)))
    ? (cuenta.has(orientacionA) ? orientacionA : invertida)
    : [...cuenta.entries()].sort((x, y) => y[1] - x[1])[0][0];
  const inverso = refA.split('|').reverse().join('|');
  if (!cuenta.has(inverso)) return 0;
  let asignados = 0;
  for (const m of mediciones) {
    const k = clave(m);
    if (k === refA) { m.sentido = 'A'; m.porTramo = true; asignados += 1; }
    else if (k === inverso) { m.sentido = 'B'; m.porTramo = true; asignados += 1; }
  }
  return asignados;
}

/** Asigna sentido A/B a cada medicion y devuelve la longitud del tramo. */
function detectarSentidos(mediciones) {
  const largos = mediciones.map((m) => m.longitud_m).filter(Boolean);
  const longitud = largos.length ? mediana(largos) : 0;
  let referencia = mediciones.find((m) => m.sentido === 'A');
  if (!referencia) {
    referencia = mediciones.reduce((a, b) =>
      b.eventos.length > a.eventos.length ? b : a);
    referencia.sentido = 'A';
  }
  const ref = referencia.eventos.map((e) => e.posicion_m);
  for (const m of mediciones) {
    if (m.sentido === 'A' || m.sentido === 'B') continue;
    const pos = m.eventos.map((e) => e.posicion_m);
    const directo = coincidencia(pos, ref);
    const espejado = coincidencia(pos.map((p) => longitud - p), ref);
    m.sentido = directo <= espejado ? 'A' : 'B';
  }
  return longitud;
}

/** Progresivas de empalme por sentido, en el marco del sentido A. */
/**
 * Eventos utiles de una medicion: se descartan el primero (conector de
 * inyeccion) y el ultimo (fin de fibra), y todo lo que caiga dentro del
 * margen de los extremos del tramo.
 */
function eventosUtiles(m, longitud, margen = MARGEN_EXTREMOS_M) {
  const orden = [...m.eventos].sort((a, b) => a.posicion_m - b.posicion_m);
  const fin = m.longitud_m || longitud;
  return orden.filter((e, i) => {
    if (i === 0 || i === orden.length - 1) return false;      // conector y fin
    if (e.posicion_m < margen) return false;
    if (fin - e.posicion_m < margen) return false;
    return true;
  });
}

function detectarEmpalmes(mediciones, longitud, separacion, minFibras,
                                 margen = MARGEN_EXTREMOS_M, umbral = 0) {
  const marco = [];
  for (const m of mediciones) {
    const largo = m.longitud_m || longitud;
    for (const e of eventosUtiles(m, longitud, margen)) {
      // el evento del sentido B se lleva al marco de A con la longitud
      // optica de esa misma medicion: 20 km - 16 km = 4 km
      const p = m.sentido === 'A' ? e.posicion_m : largo - e.posicion_m;
      if (p > margen && p < longitud - margen)
        marco.push({ p, perdida: e.perdida == null ? 0 : e.perdida });
    }
  }
  if (!marco.length) return { A: [], B: [] };

  // Agrupamiento por cercania: las lecturas del mismo empalme no caen en el
  // mismo metro. Lejos del equipo la dispersion crece, asi que agrupar por
  // hueco encuentra empalmes que un histograma de bins fijos se pierde.
  const hueco = Math.max(BIN_M * 2, Math.min(separacion * 0.6, VENTANA_M));
  const orden = [...marco].sort((a, b) => a.p - b.p);
  const grupos = [];
  let actual = [orden[0]];
  for (let i = 1; i < orden.length; i++) {
    if (orden[i].p - orden[i - 1].p <= hueco) actual.push(orden[i]);
    else { grupos.push(actual); actual = [orden[i]]; }
  }
  grupos.push(actual);

  const centro = (g) => {
    const s = g.map((x) => x.p).sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // Se aceptan los grupos con confirmacion suficiente Y ademas, siempre,
  // los que tengan alguna lectura por encima del umbral: un empalme fuera de
  // norma no se puede perder por falta de confirmacion.
  const candidatos = grupos
    .filter((g) => g.length >= minFibras
      || (umbral > 0 && g.some((x) => x.perdida > umbral)))
    .map((g) => ({ centro: centro(g), n: g.length,
                   pico: Math.max(...g.map((x) => x.perdida)),
                   soloPorUmbral: g.length < minFibras }))
    .sort((a, b) => (b.pico > umbral) - (a.pico > umbral) || b.n - a.n);

  const elegidos = [];
  for (const c of candidatos) {
    if (elegidos.every((e) => Math.abs(c.centro - e.centro) >= separacion))
      elegidos.push(c);
  }
  elegidos.sort((a, b) => a.centro - b.centro);
  const picos = elegidos.map((e) => e.centro);

  return {
    A: picos,
    B: picos.map((p) => longitud - p).reverse(),
    // datos de cada empalme, en el mismo orden que A
    detalle: elegidos.map((e) => ({ centro: e.centro, vistas: e.n,
                                    pico: e.pico, soloPorUmbral: e.soloPorUmbral })),
  };
}

/**
 * Ventana de captura de cada empalme: +/-250 m, acotada a la mitad de la
 * distancia al empalme vecino. Se calcula UNA vez en el marco del sentido A,
 * porque la distancia entre empalmes es la misma se mida desde donde se mida.
 */
function ventanasPorEmpalme(progresivasA, ventana) {
  return progresivasA.map((p, i) => {
    const vecinos = progresivasA.filter((_, j) => j !== i);
    if (!vecinos.length) return ventana;
    const d = Math.min(...vecinos.map((q) => Math.abs(p - q)));
    return Math.min(ventana, d / 2);
  });
}

/** Empalmes numerados y matriz {fibra|n|sentido -> {perdida, progresiva}}. */
function armarMatriz(mediciones, picos, longitud, eventoMinimo = 0,
                            margen = MARGEN_EXTREMOS_M) {
  const empalmes = picos.A.map((pa, i) => ({
    n: i + 1, prog_a: pa, prog_b: picos.B[picos.B.length - 1 - i],
  }));
  const ventanas = ventanasPorEmpalme(picos.A, VENTANA_M);
  const valores = new Map();
  for (const m of mediciones) {
    const largo = m.longitud_m || longitud;
    for (const [i, emp] of empalmes.entries()) {
      // en B se busca el mismo punto fisico: longitud optica - progresiva de A
      const objetivo = m.sentido === 'A' ? emp.prog_a : largo - emp.prog_a;
      const v = ventanas[i];
      const cerca = eventosUtiles(m, longitud, margen)
        .filter((e) => Math.abs(e.posicion_m - objetivo) <= v);
      if (!cerca.length) continue;
      const ev = cerca.reduce((a, b) =>
        Math.abs(b.posicion_m - objetivo) < Math.abs(a.posicion_m - objetivo) ? b : a);
      if (eventoMinimo && ev.perdida != null && ev.perdida < eventoMinimo) continue;
      valores.set(`${m.fibra}|${emp.n}|${m.sentido}`,
                  { perdida: ev.perdida, progresiva: ev.posicion_m });
    }
  }
  return { empalmes, valores };
}

/** Pelos que no llegan al fin de traza. */
function detectarCortadas(mediciones, longitud, tolerancia = 0.05) {
  const cortadas = new Map();
  for (const m of mediciones) {
    if (m.longitud_m && m.longitud_m < longitud * (1 - tolerancia)) {
      const previo = cortadas.get(m.fibra);
      cortadas.set(m.fibra, previo ? Math.min(previo, m.longitud_m) : m.longitud_m);
    }
  }
  return cortadas;
}

/**
 * Numero de pelo a partir del ID interno del .sor o del nombre del archivo.
 * maxPelos acota el resultado: un "1550" de la longitud de onda o un "2026"
 * de la fecha nunca son un numero de pelo.
 */
function numeroDeFibra(idInterno, nombreArchivo, maxPelos = 0) {
  const patrones = [
    /(?:fibra|fiber|fib|pelo|hilo|fo)[\s_\-]*0*(\d{1,3})(?!\d)/i,
    /(?<![a-z0-9])[fp]0*(\d{1,3})(?!\d)/i,
    /[-_\s]0*(\d{1,3})(?:[-_\s.]|$)/,
    /(?<![a-z0-9])0*(\d{1,3})(?![\d])/,   // numero suelto en el nombre
    /^0*(\d{1,3})(?!\d)/,   // numero al principio: 051EO -> 51
    /(\d{1,3})$/,          // ultimo recurso: numero pegado al final
  ];
  const limpiar = (t) => t
    .replace(/\.m?sor$/i, '')
    .replace(/[\s_-]*(a-?b|b-?a|ida|vuelta)$/i, '')   // sufijo de sentido
    .replace(/\d{3,4}\s*nm/gi, ' ')              // 1310 nm, 1550nm
    .replace(/(?<!\d)(1310|1383|1490|1550|1625)(?!\d)/g, ' ')  // longitudes de onda
    .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ')   // fechas
    .replace(/(?<!\d)(19|20)\d{2}(?!\d)/g, ' ');            // años
  const candidatos = [];
  for (const texto of [idInterno || '', nombreArchivo || '']) {
    const t = limpiar(String(texto));
    for (const p of patrones) {
      const m = p.exec(t);
      if (m) candidatos.push(parseInt(m[1], 10));
    }
  }
  const validos = candidatos.filter((n) => n >= 1 && (!maxPelos || n <= maxPelos));
  if (validos.length) return validos[0];
  return candidatos.length ? candidatos[0] : null;
}

/** Sentido a partir del nombre del archivo o de la carpeta. */
function sentidoDesdeTexto(texto) {
  const t = (texto || '').toLowerCase();
  if (/(?<![a-z0-9])(a[\s_\-]*(hacia|2|to)?[\s_\-]*b|ida|directo|a-b|ab)(?![a-z0-9])/.test(t)) return 'A';
  if (/(?<![a-z0-9])(b[\s_\-]*(hacia|2|to)?[\s_\-]*a|vuelta|retorno|reverso|b-a|ba)(?![a-z0-9])/.test(t)) return 'B';
  return null;
}

/**
 * Contrasta las botellas declaradas a mano contra los empalmes detectados.
 * No se asumen cada 4000 m: dependen de enlaces, cortes y botellas de obra.
 */
function contrasteBotellas(botellas, progresivas, tolerancia = 250) {
  const declaradas = [...botellas].sort((a, b) => a.progresiva_m - b.progresiva_m);
  const libres = [...progresivas].sort((a, b) => a - b);
  const emparejadas = [];
  const sinMedicion = [];
  for (const b of declaradas) {
    const cerca = libres.filter((x) => Math.abs(x - b.progresiva_m) <= tolerancia);
    if (cerca.length) {
      const x = cerca.reduce((p, q) =>
        Math.abs(q - b.progresiva_m) < Math.abs(p - b.progresiva_m) ? q : p);
      libres.splice(libres.indexOf(x), 1);
      emparejadas.push({ botella: b, medida: x, diferencia: x - b.progresiva_m });
    } else {
      sinMedicion.push(b);
    }
  }
  return { emparejadas, sinMedicion, sinDeclarar: libres };
}

/**
 * Compara la planilla actual contra una anterior del mismo tramo.
 * anterior: { empalmes:[{n,prog_a}], lecturas: Map "fibra|n" -> valor }
 */
function compararPlanillas(anterior, empalmes, valores, medidos, bidiPorFibra,
                                  toleranciaM = 250, saltoDb = 0.05) {
  const lectura = (f, n) => {
    const a = valores.get(`${f}|${n}|A`);
    const b = valores.get(`${f}|${n}|B`);
    const va = a && a.perdida != null ? a.perdida : null;
    const vb = b && b.perdida != null ? b.perdida : null;
    if (bidiPorFibra[f] && va != null && vb != null) return (va + vb) / 2;
    return va != null ? va : vb;
  };
  const filas = [];
  let peores = 0;
  let mejores = 0;
  for (const emp of empalmes) {
    const par = anterior.empalmes.find(
      (e) => Math.abs(e.prog_a - emp.prog_a) <= toleranciaM);
    for (const f of medidos) {
      const ahora = lectura(f, emp.n);
      if (ahora == null) continue;
      const antes = par ? anterior.lecturas.get(`${f}|${par.n}`) : undefined;
      if (antes == null) {
        filas.push({ n: emp.n, prog: emp.prog_a, fibra: f, antes: null,
                     ahora, delta: null, estado: 'NUEVO' });
        continue;
      }
      const delta = ahora - antes;
      if (Math.abs(delta) < saltoDb) continue;
      if (delta > 0) peores++; else mejores++;
      filas.push({ n: emp.n, prog: emp.prog_a, fibra: f, antes, ahora, delta,
                   estado: delta > 0 ? 'EMPEORO' : 'MEJORO' });
    }
  }
  filas.sort((a, b) => (b.delta || 0) - (a.delta || 0));
  return { filas, peores, mejores };
}

/**
 * Diagnostico de corte cruzando los dos sentidos.
 *
 * En una fibra cortada, cada sentido llega hasta el corte: lo medido desde A
 * mas lo medido desde B da la longitud del tramo. Si la suma da menos, hay mas
 * de un corte y lo que falta es el pedazo que no ve ninguno.
 */
function diagnosticarCortes(mediciones, longitud, tolerancia = 0.02) {
  const porPelo = new Map();
  for (const m of mediciones) {
    if (m.numero == null || !m.longitud_m) continue;
    const d = porPelo.get(m.numero) || { A: null, B: null };
    const k = m.sentido === 'B' ? 'B' : 'A';
    if (d[k] == null || m.longitud_m > d[k]) d[k] = m.longitud_m;
    porPelo.set(m.numero, d);
  }
  const margen = longitud * tolerancia;
  const salida = [];
  for (const [pelo, d] of [...porPelo].sort((x, y) => x[0] - y[0])) {
    const completaA = d.A != null && Math.abs(d.A - longitud) <= margen;
    const completaB = d.B != null && Math.abs(d.B - longitud) <= margen;
    if (completaA && completaB) continue;                 // fibra sana
    if (d.A == null && d.B == null) continue;
    if (d.A != null && d.B != null) {
      const suma = d.A + d.B;
      if (Math.abs(suma - longitud) <= margen) {
        salida.push({ pelo, tipo: 'corte', desdeA: d.A, desdeB: d.B,
          texto: `Corte a ${Math.round(d.A).toLocaleString('es-AR')} m desde A `
            + `(${Math.round(d.B).toLocaleString('es-AR')} m desde B).` });
      } else if (suma < longitud - margen) {
        salida.push({ pelo, tipo: 'varios', desdeA: d.A, desdeB: d.B,
          faltante: longitud - suma,
          texto: `Más de un corte: llega a `
            + `${Math.round(d.A).toLocaleString('es-AR')} m desde A y a `
            + `${Math.round(d.B).toLocaleString('es-AR')} m desde B; quedan `
            + `${Math.round(longitud - suma).toLocaleString('es-AR')} m sin ver.` });
      } else {
        salida.push({ pelo, tipo: 'revisar', desdeA: d.A, desdeB: d.B,
          texto: 'Las dos longitudes no cierran con la del tramo: revisar el '
            + 'índice de refracción o si son de tramos distintos.' });
      }
    } else {
      // medido en un solo sentido: si llega al final, la fibra esta sana y lo
      // unico que falta es la medicion del otro extremo
      const unico = d.A != null ? d.A : d.B;
      const lado = d.A != null ? 'A' : 'B';
      if (Math.abs(unico - longitud) <= margen) continue;
      salida.push({ pelo, tipo: 'un-sentido', desdeA: d.A, desdeB: d.B,
        texto: `Llega a ${Math.round(unico).toLocaleString('es-AR')} m desde `
          + `${lado} y el tramo tiene ${Math.round(longitud).toLocaleString('es-AR')} m. `
          + 'Falta medir desde el otro extremo para confirmar el corte: debería dar '
          + `unos ${Math.round(longitud - unico).toLocaleString('es-AR')} m.` });
    }
  }
  return salida;
}
/*
 * Genera el libro Excel con el formato de obra usando ExcelJS.
 * Mismas solapas que el modelo: Registro Med FO, AT. EMPALMES por tubo,
 * CD PMD Y PWR.
 */
const AZUL = 'FF1F4E79';
const AZUL2 = 'FF2E5FA3';
const ROSA = 'FFFFC7CE';
const GRIS = 'FFF2F2F2';
const AMBAR = 'FFFFEB9C';

// [fondo del tubo, letra del tubo, tinte claro para las columnas de cada pelo]
const COLOR_TUBO = {
  azul: ['FF1F4E79', 'FFFFFFFF', 'FFDCE6F1'], naranja: ['FFED7D31', 'FF000000', 'FFFCE4D6'],
  verde: ['FF548235', 'FFFFFFFF', 'FFE2EFDA'], marron: ['FF843C0C', 'FFFFFFFF', 'FFF2E0D5'],
  gris: ['FF808080', 'FFFFFFFF', 'FFEDEDED'], blanco: ['FFFFFFFF', 'FF000000', 'FFFAFAFA'],
  rojo: ['FFC00000', 'FFFFFFFF', 'FFF8DCDC'], negro: ['FF262626', 'FFFFFFFF', 'FFE4E4E4'],
  violeta: ['FF7030A0', 'FFFFFFFF', 'FFEADFF2'], rosa: ['FFFF99CC', 'FF000000', 'FFFDE7F1'],
  aguamarina: ['FF31859C', 'FFFFFFFF', 'FFDDEEF2'], amarillo: ['FFFFD966', 'FF000000', 'FFFFF3D4'],
};
const COLORES = ['Azul', 'Naranja', 'Verde', 'Marron', 'Gris', 'Blanco',
  'Rojo', 'Negro', 'Violeta', 'Rosa', 'Aguamarina', 'Amarillo'];

const fino = { style: 'thin', color: { argb: 'FF808080' } };
const grueso = { style: 'medium', color: { argb: 'FF404040' } };
const BORDE = { top: fino, left: fino, bottom: fino, right: fino };
const BORDE_MARCADO = { top: fino, left: grueso, bottom: fino, right: grueso };
const CENTRO = { horizontal: 'center', vertical: 'middle' };
const IZQ = { horizontal: 'left', vertical: 'middle' };

const sinTilde = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const relleno = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function celda(ws, fila, col, valor, opciones = {}) {
  const c = ws.getCell(fila, col);
  if (valor !== undefined) c.value = valor;
  c.font = { name: 'Arial', size: opciones.size || 9, bold: !!opciones.bold,
             italic: !!opciones.italic, color: { argb: opciones.color || 'FF000000' } };
  c.alignment = opciones.alin || CENTRO;
  if (opciones.fill) c.fill = relleno(opciones.fill);
  if (opciones.borde !== false) c.border = opciones.marcado ? BORDE_MARCADO : BORDE;
  if (opciones.formato) c.numFmt = opciones.formato;
  return c;
}

function tubos(fibrasTotales, porTubo) {
  const out = [];
  for (let i = 0; i < fibrasTotales; i += porTubo) {
    const n = i / porTubo + 1;
    out.push({ n, desde: i + 1, hasta: Math.min(i + porTubo, fibrasTotales),
               color: COLORES[(n - 1) % COLORES.length] });
  }
  return out;
}

/**
 * Politica de At Prom segun lo que haya medido cada pelo:
 *   'siempre'  la formula va en todas las celdas (como la planilla de obra)
 *   'sin-cero' promedia solo con las dos lecturas; si falta una toma la que hay
 *   'vacio'    sin las dos lecturas la celda queda vacia
 */
function politicaProm(cfg, bidi, hayA, hayB, cA, cB, fila) {
  if (!bidi) return null;
  const modo = (cfg.estructura && cfg.estructura.atProm) || 'siempre';
  const promedio = { formula: `(${cA}${fila}+${cB}${fila})/2` };
  if (modo === 'siempre' || (hayA && hayB)) return promedio;
  if (modo === 'sin-cero') {
    if (hayA) return { formula: `${cA}${fila}` };
    if (hayB) return { formula: `${cB}${fila}` };
  }
  return null;
}

const tipoDeFibra = (cfg, n) =>
  cfg.tiposFibra.find((t) => n >= t.desde && n <= t.hasta) || null;


// ------------------------------------------------------------ estetica
const medio = { style: 'medium', color: { argb: 'FF1F4E79' } };
const doble = { style: 'double', color: { argb: 'FF1F4E79' } };

/** Recuadro de borde grueso alrededor de un rango. */
function recuadro(ws, r1, c1, r2, c2, lado = medio) {
  for (let c = c1; c <= c2; c++) {
    const arriba = ws.getCell(r1, c);
    const abajo = ws.getCell(r2, c);
    arriba.border = { ...(arriba.border || {}), top: lado };
    abajo.border = { ...(abajo.border || {}), bottom: lado };
  }
  for (let r = r1; r <= r2; r++) {
    const izq = ws.getCell(r, c1);
    const der = ws.getCell(r, c2);
    izq.border = { ...(izq.border || {}), left: lado };
    der.border = { ...(der.border || {}), right: lado };
  }
}

/** Banda de titulo a todo el ancho, con el color institucional. */
function banda(ws, fila, colFin, texto, opciones = {}) {
  const c = ws.getCell(fila, 1);
  c.value = texto;
  c.font = { name: 'Arial', size: opciones.size || 12, bold: true,
             color: { argb: opciones.color || 'FFFFFFFF' } };
  c.alignment = { horizontal: opciones.alin || 'left', vertical: 'middle',
                  indent: 1 };
  for (let i = 1; i <= colFin; i++) {
    ws.getCell(fila, i).fill = relleno(opciones.fill || AZUL);
  }
  ws.mergeCells(fila, 1, fila, colFin);
  ws.getRow(fila).height = opciones.alto || 24;
  return c;
}

/** Subtitulo de seccion: banda clara con letra azul. */
function seccion(ws, fila, c1, c2, texto) {
  const c = ws.getCell(fila, c1);
  c.value = texto;
  c.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FF1F4E79' } };
  c.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  for (let i = c1; i <= c2; i++) ws.getCell(fila, i).fill = relleno('FFDCE6F1');
  ws.mergeCells(fila, c1, fila, c2);
  ws.getRow(fila).height = 18;
  return c;
}

/** Impresion lista para entregar: apaisado, ajustado al ancho y con pie. */
function prepararImpresion(ws, cfg, titulosFila) {
  ws.pageSetup = {
    orientation: 'landscape', paperSize: 9, fitToPage: true,
    fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5,
               header: 0.2, footer: 0.2 },
    printTitlesRow: titulosFila || undefined,
  };
  ws.headerFooter = {
    oddFooter: `&L&8${(cfg.registro.contratista || '').replace(/&/g, '&&')}`
      + `&C&8${(cfg.registro.tramo || '').replace(/&/g, '&&')}`
      + '&R&8Página &P de &N',
    oddHeader: cfg.pieLicencia
      ? `&R&7${cfg.pieLicencia.replace(/&/g, '&&')}` : undefined,
  };
}

// ---------------------------------------------------------------- Registro
function agregarLogo(wb, ws, dataURL, celda) {
  if (!dataURL) return;
  const m = /^data:image\/(png|jpeg|jpg|gif);base64,(.+)$/i.exec(dataURL);
  if (!m) return;
  const id = wb.addImage({ base64: m[2], extension: m[1] === 'jpg' ? 'jpeg' : m[1] });
  ws.addImage(id, { tl: celda, ext: { width: 150, height: 46 } });
}

function hojaRegistro(wb, cfg, longitud, nEmpalmes, medidos, detectados) {
  const ws = wb.addWorksheet('Registro Med FO');
  ws.views = [{ showGridLines: false, state: 'normal' }];
  [3, 24, 32, 16, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // espacio para los logos, uno a cada lado
  for (let r = 1; r <= 4; r++) ws.getRow(r).height = 20;
  agregarLogo(wb, ws, cfg.logos && cfg.logos.empresa, { col: 1.1, row: 0.4 });
  agregarLogo(wb, ws, cfg.logos && cfg.logos.cliente, { col: 3.6, row: 0.4 });

  banda(ws, 6, 5, 'REGISTRO DE MEDICIONES SOBRE FIBRAS ÓPTICAS',
        { size: 14, alin: 'center', alto: 30 });
  const sub = ws.getCell(7, 1);
  sub.value = 'ATENUACIÓN DE LOS EMPALMES  ·  LONGITUD ÓPTICA A CADA EMPALME '
    + 'Y TOTAL DEL TRAMO';
  sub.font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF1F4E79' } };
  sub.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(7, 1, 7, 5);
  ws.getRow(7).height = 18;

  const tipos = [...new Set(medidos.map((f) => tipoDeFibra(cfg, f)?.tipo).filter(Boolean))];
  seccion(ws, 9, 2, 5, 'DATOS DEL TRAMO');
  for (let r = 10; r <= 15; r++) ws.getRow(r).height = 6;
  ws.getRow(26).height = 6;
  ws.getRow(32).height = 6;
  const filas = [
    ['TIPO DE FIBRA:', cfg.registro.tipoFibra || tipos.join(' / ')],
    ['NODO Origen (A)', cfg.registro.nodoA],
    ['NODO Destino (B)', cfg.registro.nodoB],
    ['CANTIDAD EMPALMES:', cfg.neManual || nEmpalmes],
    ['LONG. OPTICA TOTAL:', Number((longitud / 1000).toFixed(4))],
    ['CABLE:', cfg.registro.cable],
    ['CONTRATISTA:', cfg.registro.contratista],
    ['FECHA PRESENTACIÓN:', { formula: 'TODAY()' }],
    ['Tramo:', cfg.registro.tramo],
    ['Sección:', cfg.registro.seccion],
  ];
  filas.forEach(([k, v], i) => {
    celda(ws, 16 + i, 2, k, { bold: true, fill: 'FFEDF2F8', alin: IZQ });
    celda(ws, 16 + i, 3, v, { alin: IZQ, bold: i === 3 || i === 4 });
    ws.getRow(16 + i).height = 17;
  });
  ws.getCell('C23').numFmt = 'dd/mm/yyyy';
  // si el Ne de la formula se cargo a mano, queda a la vista cuantos detectó
  const nota19 = cfg.neManual && cfg.neManual !== nEmpalmes
    ? `declarado a mano · confirmados ${nEmpalmes}`
    : (detectados && detectados !== nEmpalmes
        ? `confirmados por varias fibras · ${detectados - nEmpalmes} evento(s) más `
          + 'sin confirmar, marcados en ámbar' : '');
  if (nota19) celda(ws, 19, 4, nota19, { size: 8, italic: true, alin: IZQ, borde: false });
  recuadro(ws, 16, 2, 15 + filas.length, 3);

  const ap = cfg.aprobacion || {};
  seccion(ws, 27, 2, 5, 'APROBACIÓN');
  [['APROBADO POR:', ap.responsable || ''],
   ['CARGO / ACLARACIÓN:', ap.cargo || ''],
   ['OPERADOR:', ap.operador || ''],
   ['FIRMA:', '']].forEach(([k, v], i) => {
    celda(ws, 28 + i, 2, k, { bold: true, fill: 'FFEDF2F8', alin: IZQ });
    celda(ws, 28 + i, 3, v, { alin: IZQ });
    ws.getRow(28 + i).height = 17;
  });
  ws.getRow(31).height = 30;
  recuadro(ws, 28, 2, 31, 3);

  seccion(ws, 33, 2, 5, 'CÓDIGO DE COLORES DE BUFFER');
  ['Tubo', 'Color', 'Pelos', 'Tipo'].forEach((h, k) =>
    celda(ws, 34, 2 + k, h, { bold: true, fill: AZUL, color: 'FFFFFFFF' }));
  ws.getColumn(4).width = 14;
  ws.getColumn(5).width = 14;
  tubos(cfg.estructura.fibrasTotales, cfg.estructura.fibrasPorTubo)
    .forEach((t, i) => {
      const [fondo, letra] = COLOR_TUBO[sinTilde(t.color)] || [AZUL2, 'FFFFFFFF'];
      celda(ws, 35 + i, 2, `B${t.n}`, { bold: true });
      celda(ws, 35 + i, 3, t.color.toUpperCase(), { bold: true, fill: fondo, color: letra });
      celda(ws, 35 + i, 4, `${t.desde} a ${t.hasta}`);
      celda(ws, 35 + i, 5, tipoDeFibra(cfg, t.desde)?.tipo || '');
      ws.getRow(35 + i).height = 16;
    });
  const nTubos = tubos(cfg.estructura.fibrasTotales, cfg.estructura.fibrasPorTubo).length;
  recuadro(ws, 34, 2, 34 + nTubos, 5);
  // referencias de color, para que el que recibe la planilla sepa qué mira
  const fRef = 36 + nTubos;
  seccion(ws, fRef, 2, 5, 'REFERENCIAS DE COLOR');
  const refs = [
    ['FFC00000', 'Rojo', 'La pérdida medida supera el umbral de aceptación, o la pérdida '
      + 'total del pelo supera el valor teórico (At). Hay que revisar ese punto.'],
    [AMBAR, 'Ámbar', 'El promedio se calculó con un solo sentido: el otro no detectó '
      + 'el evento. Revisar si corresponde tomarlo como válido.'],
    [ROSA, 'Rosa', 'Pelo cortado o que no llega de punta a punta.'],
    ['FFDCE6F1', 'Celeste', 'Bloque de datos cargados: encabezado, aprobación y fórmula.'],
  ];
  refs.forEach(([color, nombre, texto], i) => {
    const f = fRef + 1 + i;
    const c = celda(ws, f, 2, nombre, { bold: true, fill: color, size: 8 });
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    const d = celda(ws, f, 3, texto, { size: 8, alin: IZQ });
    d.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    ws.mergeCells(f, 3, f, 5);
    ws.getRow(f).height = 20;
  });
  recuadro(ws, fRef, 2, fRef + refs.length, 5);

  if (cfg.pieLicencia) {
    const c = ws.getCell(42 + nTubos, 2);
    c.value = cfg.pieLicencia;
    c.font = { name: 'Arial', size: 8, italic: true, color: { argb: 'FF8A94A0' } };
    c.alignment = { horizontal: 'left', vertical: 'middle' };
    ws.mergeCells(42 + nTubos, 2, 42 + nTubos, 5);
  }
  prepararImpresion(ws, cfg);
  ws.pageSetup.orientation = 'portrait';
  return ws;
}

// ------------------------------------------------------- AT. EMPALMES
function hojaTubo(wb, cfg, tubo, empalmes, valores, longitud, bidiPorFibra,
                  medidos, cortadas, observaciones, equipo) {
  const { n, desde, hasta, color } = tubo;
  const ncol = 3;
  const ultima = 3 + (hasta - desde + 1) * ncol;
  const ws = wb.addWorksheet(`AT. EMPALMES fibras ${desde} a ${hasta}`);

  ws.views = [{ showGridLines: false, state: 'normal' }];
  agregarLogo(wb, ws, cfg.logos && cfg.logos.empresa, { col: 0.2, row: 0.2 });
  agregarLogo(wb, ws, cfg.logos && cfg.logos.cliente,
              { col: Math.max(ultima - 6, 4), row: 0.2 });
  for (let r = 1; r <= 3; r++) ws.getRow(r).height = 18;

  banda(ws, 4, ultima, 'REGISTRO DE MEDICIONES SOBRE FIBRAS ÓPTICAS',
        { size: 13, alin: 'center', alto: 28 });
  const sub = ws.getCell(5, 1);
  sub.value = 'ATENUACIÓN DE LOS EMPALMES  ·  LONGITUD ÓPTICA A CADA EMPALME '
    + 'Y TOTAL DEL TRAMO';
  sub.font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF1F4E79' } };
  sub.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.mergeCells(5, 1, 5, ultima);
  ws.getRow(5).height = 17;
  ws.getRow(6).height = 6;

  [['TIPO DE FIBRA', 'C16'], ['NODO ORIGEN (A)', 'C17'], ['NODO DESTINO (B)', 'C18'],
   ['CANTIDAD EMPALMES', 'C19'], ['LONG. OPTICA TOTAL (m)', 'C20']]
    .forEach(([etiqueta, ref], i) => {
      celda(ws, 8 + i, 1, etiqueta, { bold: true, fill: GRIS, alin: IZQ });
      ws.mergeCells(8 + i, 1, 8 + i, 3);
      celda(ws, 8 + i, 4, { formula: `'Registro Med FO'!${ref}` }, { alin: IZQ });
      ws.mergeCells(8 + i, 4, 8 + i, 11);
    });
  celda(ws, 8, 12, 'CABLE', { bold: true, fill: GRIS, alin: IZQ });
  celda(ws, 8, 13, { formula: "'Registro Med FO'!C21" }, { alin: IZQ });
  ws.mergeCells(8, 13, 8, 19);
  celda(ws, 9, 12, 'Tramo', { bold: true, fill: GRIS, alin: IZQ });
  celda(ws, 9, 13, { formula: "'Registro Med FO'!C24" }, { alin: IZQ });
  ws.mergeCells(9, 13, 9, 19);

  // bloque de identificacion del instrumento y criterio de aceptacion
  celda(ws, 8, 20, 'OTDR marca/mod/SN:', { bold: true, fill: GRIS, alin: IZQ });
  ws.mergeCells(8, 20, 8, 23);
  celda(ws, 8, 24, equipo || '', { italic: true, alin: IZQ });
  ws.mergeCells(8, 24, 8, 29);
  celda(ws, 9, 20, 'Long. de onda (nm)', { bold: true, fill: GRIS, alin: IZQ });
  ws.mergeCells(9, 20, 9, 22);
  celda(ws, 9, 23, cfg.parametros.longitudOndaNm);
  celda(ws, 9, 24, 'Operador', { bold: true, fill: GRIS, alin: IZQ });
  ws.mergeCells(9, 24, 9, 25);
  celda(ws, 9, 26, (cfg.aprobacion && cfg.aprobacion.operador) || '', { alin: IZQ });
  ws.mergeCells(9, 26, 9, 29);
  celda(ws, 10, 20, 'VALORES ACEPTABLES', { bold: true, fill: 'FFBDD7EE' });
  ws.mergeCells(10, 20, 10, 29);
  celda(ws, 11, 20, 'PROMEDIO DE EMPALME', { bold: true, italic: true, fill: 'FFFFFF00' });
  ws.mergeCells(11, 20, 11, 26);
  celda(ws, 11, 27, `≤ ${cfg.parametros.umbralEmpalmeDb.toFixed(2).replace('.', ',')} dB`,
        { bold: true, fill: 'FFFF0000', color: 'FFFFFFFF' });
  ws.mergeCells(11, 27, 11, 29);

  const tf = tipoDeFibra(cfg, desde);
  const [fondo, letra, tinte] = COLOR_TUBO[sinTilde(color)] || [AZUL2, 'FFFFFFFF', GRIS];
  celda(ws, 13, 4, `TUBO ${n} ${color.toUpperCase()}${tf ? '   -   ' + tf.tipo : ''}`,
        { bold: true, size: 10, fill: fondo, color: letra });
  ws.mergeCells(13, 4, 13, ultima);

  celda(ws, 14, 1, 'EVENTO Nro.:', { bold: true, fill: AZUL, color: 'FFFFFFFF' });
  ws.mergeCells(14, 1, 15, 1);
  celda(ws, 14, 2, 'Progresiva óptica (m)', { bold: true, fill: AZUL, color: 'FFFFFFFF' });
  ws.mergeCells(14, 2, 14, 3);
  celda(ws, 15, 2, 'De A→B', { bold: true, fill: AZUL, color: 'FFFFFFFF' });
  celda(ws, 15, 3, 'De B→A', { bold: true, fill: AZUL, color: 'FFFFFFFF' });

  const columnas = {};
  const coloresPelo = {};
  let col = 4;
  for (let f = desde; f <= hasta; f++) {
    columnas[f] = col;
    // cada pelo lleva el color que le corresponde dentro del tubo
    const nombreColor = COLORES[(f - desde) % COLORES.length];
    const [fPelo, lPelo, tPelo] = COLOR_TUBO[sinTilde(nombreColor)]
      || [AZUL2, 'FFFFFFFF', GRIS];
    coloresPelo[f] = tPelo;
    const cortada = cortadas.has(f);
    celda(ws, 14, col, `Fibra Nro.: ${f}${cortada ? ' CORTADA' : ''}`,
          { bold: true, fill: cortada ? ROSA : fPelo,
            color: cortada ? 'FF9C0006' : lPelo });
    ws.mergeCells(14, col, 14, col + ncol - 1);
    ['De A→B', 'De B→A', 'At Prom'].forEach((s, k) =>
      celda(ws, 15, col + k, s, { bold: true, fill: tPelo, color: 'FF1C2430' }));
    col += ncol;
  }

  const umbral = cfg.parametros.umbralEmpalmeDb;
  const unaSolaLectura = [];
  let fila = 16;
  for (const emp of empalmes) {
    const celEv = celda(ws, fila, 1, emp.n,
      { bold: true, fill: emp.soloPorUmbral ? AMBAR : GRIS, marcado: true });
    if (emp.soloPorUmbral)
      celEv.note = 'Evento no confirmado por el resto de las fibras. Puede ser una '
        + 'atenuación de la traza (macrocurvatura, estrangulamiento) y no una botella '
        + 'de empalme. No se cuenta en el Ne del cálculo teórico.';
    celda(ws, fila, 2, Math.round(emp.prog_a),
          { bold: true, fill: GRIS, marcado: true, formato: '#,##0' });
    celda(ws, fila, 3, Math.round(emp.prog_b),
          { bold: true, fill: GRIS, marcado: true, formato: '#,##0' });
    for (let f = desde; f <= hasta; f++) {
      const c0 = columnas[f];
      const corte = cortadas.get(f);
      if (!medidos.includes(f) || (corte != null && emp.prog_a > corte)) {
        for (let k = 0; k < ncol; k++)
          celda(ws, fila, c0 + k, null, { fill: corte != null ? ROSA : GRIS });
        continue;
      }
      const va = valores.get(`${f}|${emp.n}|A`);
      const vb = valores.get(`${f}|${emp.n}|B`);
      const hayA = !!(va && va.perdida != null);
      const hayB = !!(vb && vb.perdida != null);
      const a = hayA ? Number(va.perdida.toFixed(3)) : 0;
      const b = hayB ? Number(vb.perdida.toFixed(3)) : 0;
      const tintePelo = coloresPelo[f] || tinte;
      celda(ws, fila, c0, a, { formato: '0.000', fill: a > umbral ? ROSA : tintePelo });
      celda(ws, fila, c0 + 1, b, { formato: '0.000', fill: b > umbral ? ROSA : tintePelo });
      const letra0 = ws.getColumn(c0).letter;
      const letra1 = ws.getColumn(c0 + 1).letter;
      celda(ws, fila, c0 + 2,
            politicaProm(cfg, bidiPorFibra[f], hayA, hayB, letra0, letra1, fila),
            { bold: true, marcado: true, formato: '0.000',
              fill: bidiPorFibra[f] && !(hayA && hayB) ? AMBAR : tintePelo });
      if (bidiPorFibra[f] && !(hayA && hayB)) {
        unaSolaLectura.push(`F${String(f).padStart(2, '0')} emp. ${emp.n}`);
        ws.getCell(fila, c0 + 2).note = 'Un solo sentido detectó este evento: '
          + 'el promedio se calcula contra un cero, no contra una lectura real.';
      }
    }
    fila++;
  }

  const nota = unaSolaLectura.length
    ? ` ${unaSolaLectura.length} celda(s) de At Prom se calcularon con lectura de `
      + 'un solo sentido (marcadas en ámbar): el otro sentido no detectó el evento, '
      + 'así que el promedio se hace contra un cero y queda por debajo del valor real.'
    : '';
  const primera = 16;
  const ultimaFila = fila - 1;

  recuadro(ws, 13, 1, ultimaFila, ultima);
  recuadro(ws, 8, 1, 11, ultima, { style: 'thin', color: { argb: 'FF1F4E79' } });

  celda(ws, fila + 1, 1, 'OBSERVACIONES:  ' + observaciones + nota,
        { size: 8, italic: true, borde: false,
          alin: { horizontal: 'left', vertical: 'top', wrapText: true } });
  ws.mergeCells(fila + 1, 1, fila + 1, ultima);
  ws.getRow(fila + 1).height = 46;
  celda(ws, fila + 2, 1, 'APROBADO', { bold: true, alin: IZQ, borde: false });
  celda(ws, fila + 5, 5, 'Firma y Aclaración', { borde: false });

  ws.getColumn(1).width = 12;
  ws.getColumn(2).width = 14;
  ws.getColumn(3).width = 14;
  for (let c = 4; c <= ultima; c++) ws.getColumn(c).width = 9;
  ws.getRow(13).height = 20;
  ws.getRow(14).height = 20;
  ws.getRow(15).height = 18;
  ws.views = [{ showGridLines: false, state: 'frozen', xSplit: 3, ySplit: 15 }];
  prepararImpresion(ws, cfg, '13:15');

  for (let f = 13; f < fila; f++)
    for (let c = 1; c <= ultima; c++) {
      const cel = ws.getCell(f, c);
      if (!cel.border || !cel.border.left) cel.border = BORDE;
    }
  return ws;
}

// ------------------------------------------------------- CD, PMD Y PWR
function hojaCD(wb, cfg, mediciones, medidos, cortadas) {
  const ws = wb.addWorksheet('CD, PMD Y PWR');
  ws.views = [{ showGridLines: false, state: 'normal' }];
  agregarLogo(wb, ws, cfg.logos && cfg.logos.empresa, { col: 2.1, row: 0.3 });
  const p = cfg.parametros;
  [[3, 12], [4, 18], [5, 18], [6, 16], [7, 3], [8, 12], [9, 18], [10, 18], [11, 16]]
    .forEach(([c, w]) => { ws.getColumn(c).width = w; });

  banda(ws, 3, 13, 'CD  ·  PMD  ·  PWR', { alin: 'center' });
  celda(ws, 6, 3, 'REGISTRO DE MEDICIONES SOBRE FIBRAS ÓPTICAS',
        { size: 11, bold: true, alin: IZQ, borde: false });
  celda(ws, 7, 3, 'MEDICION DE:', { bold: true, alin: IZQ, borde: false });
  celda(ws, 7, 5, 'CD - PMD - PWR', { alin: IZQ, borde: false });
  [['TIPO DE FIBRA:', "'Registro Med FO'!C16"],
   ['SITIO ORIGEN (A):', "'Registro Med FO'!C17"],
   ['SITIO DESTINO (B):', "'Registro Med FO'!C18"],
   ['TIPO DE CABLE:', "'Registro Med FO'!C21"],
   ['FECHA MEDICION:', 'TODAY()'],
   ['CONTRATISTA:', "'Registro Med FO'!C22"]].forEach(([k, ref], i) => {
    celda(ws, 9 + i, 3, k, { bold: true, alin: IZQ, borde: false });
    celda(ws, 9 + i, 5, { formula: ref }, { alin: IZQ, borde: false });
  });
  ws.getCell('E13').numFmt = 'dd/mm/yyyy';
  celda(ws, 21, 3, 'Operador:', { bold: true, alin: IZQ, borde: false });

  celda(ws, 8, 8, 'VALORES ACEPTABLES', { bold: true, fill: GRIS });
  ws.mergeCells('H8:J8');
  celda(ws, 8, 11, 'At > Ar', { bold: true, fill: GRIS });
  celda(ws, 9, 8, 'Pérdida total del tramo en dB = A', { alin: IZQ });
  ws.mergeCells('H9:J9');
  celda(ws, 10, 8, 'Ateórica > Areal (a.L + Ne.ae + Nc.ac)', { alin: IZQ });
  ws.mergeCells('H10:J10');
  celda(ws, 11, 11, 'VALOR TEORICO', { bold: true, fill: GRIS });
  ws.mergeCells('K11:K12');
  [[`a: Aten. nominal FO (dB/Km) ${p.longitudOndaNm} nm`, p.atenuacionDbKm],
   ['L: Longitud óptica total del tramo (km).', { formula: "'Registro Med FO'!C20" }],
   ['Ne: Número total de empalmes.', { formula: "'Registro Med FO'!C19" }],
   ['ae: atenuación por empalme (dB).', p.perdidaEmpalmeDb],
   ['Nc: Número de conectores', p.cantidadConectores],
   ['ac: Pérdida del conector en ODF', p.perdidaConectorDb]].forEach(([k, v], i) => {
    celda(ws, 13 + i, 8, k, { alin: IZQ });
    ws.mergeCells(13 + i, 8, 13 + i, 10);
    celda(ws, 13 + i, 11, v);
  });
  celda(ws, 19, 8, 'At: Pérdida total del tramo (dB)', { bold: true, alin: IZQ });
  ws.mergeCells('H19:J19');
  celda(ws, 19, 11, { formula: 'K13*K14+K15*K16+K17*K18' },
        { bold: true, fill: GRIS, formato: '0.000' });
  celda(ws, 22, 8, 'Cada longitud es el tramo visto desde ese extremo. En una fibra '
        + 'continua las dos dan la longitud total. En una fibra cortada, cada sentido '
        + 'llega hasta el corte y la suma de ambas da la longitud total; si la suma da '
        + 'menos, hay más de un corte. Rojo: pérdida mayor que el valor teórico (At) o '
        + 'fibra que no es continua.',
        { size: 8, italic: true, alin: IZQ, borde: false });
  ws.mergeCells('H22:N22');

  const perdidas = new Map();      // pelo -> { A, B, LA, LB }
  for (const m of mediciones) {
    if (m.numero == null) continue;
    const d = perdidas.get(m.numero) || { A: null, B: null, LA: null, LB: null };
    if (m.perdidaTotal != null && d[m.sentido] == null) d[m.sentido] = m.perdidaTotal;
    const clave = m.sentido === 'B' ? 'LB' : 'LA';
    if (m.longitud_m && d[clave] == null) d[clave] = m.longitud_m / 1000;
    perdidas.set(m.numero, d);
  }
  const fibras = [...medidos].sort((a, b) => a - b);
  const mitad = Math.ceil(fibras.length / 2);
  for (const [col0, grupo] of [[3, fibras.slice(0, mitad)], [13, fibras.slice(mitad)]]) {
    if (!grupo.length) continue;
    ['FIBRA N°', 'CD  ps/nm km', 'PMD  ps/nm √km', 'Aten. A→B (dB)',
     'Aten. B→A (dB)', 'Long. medida desde A (km)', 'Long. medida desde B (km)',
     'Estado de la fibra']
      .forEach((h, k) => celda(ws, 24, col0 + k, h,
                               { bold: true, fill: AZUL, color: 'FFFFFFFF' }));
    grupo.forEach((f, i) => {
      const fila = 25 + i;
      const d = perdidas.get(f) || { A: null, B: null };
      celda(ws, fila, col0, f);
      celda(ws, fila, col0 + 1, null);
      celda(ws, fila, col0 + 2, null);
      celda(ws, fila, col0 + 3, d.A == null ? null : Number(d.A.toFixed(3)),
            { formato: '0.000' });
      celda(ws, fila, col0 + 4, d.B == null ? null : Number(d.B.toFixed(3)),
            { formato: '0.000' });
      celda(ws, fila, col0 + 5, d.LA == null ? null : Number(d.LA.toFixed(4)),
            { formato: '0.0000' });
      celda(ws, fila, col0 + 6, d.LB == null ? null : Number(d.LB.toFixed(4)),
            { formato: '0.0000' });
      // Estado: si el pelo esta cortado, lo medido desde A mas lo medido desde B
      // tiene que dar la longitud del tramo. Si da menos, hay mas de un corte.
      const cA = ws.getColumn(col0 + 5).letter;
      const cB = ws.getColumn(col0 + 6).letter;
      celda(ws, fila, col0 + 7, { formula:
        `IF(OR(${cA}${fila}="",${cB}${fila}=""),"FALTA UN SENTIDO",`
        + `IF(AND(ABS(${cA}${fila}-$K$14)<=$K$14*0.02,`
        + `ABS(${cB}${fila}-$K$14)<=$K$14*0.02),"CONTINUA",`
        + `IF(ABS(${cA}${fila}+${cB}${fila}-$K$14)<=$K$14*0.02,`
        + `"CORTE A "&TEXT(${cA}${fila},"0.000")&" km DE A",`
        + `"MÁS DE UN CORTE: FALTAN "&TEXT($K$14-${cA}${fila}-${cB}${fila},"0.000")&" km")))`
      }, { bold: true });
      if (cortadas.has(f))
        for (let k = 0; k < 8; k++) ws.getCell(fila, col0 + k).fill = relleno(ROSA);
    });
    // el estado se pinta cuando no es una fibra continua
    {
      const letra = ws.getColumn(col0 + 7).letter;
      ws.addConditionalFormatting({
        ref: `${letra}25:${letra}${24 + grupo.length}`,
        rules: [{
          type: 'expression', priority: 1,
          formulae: [`AND(${letra}25<>"",${letra}25<>"CONTINUA")`],
          style: { fill: relleno(ROSA) },
        }],
      });
    }
    // longitud optica que no coincide con la del tramo: la fibra esta cortada
    [5, 6].forEach((k) => {
      const letra = ws.getColumn(col0 + k).letter;
      ws.addConditionalFormatting({
        ref: `${letra}25:${letra}${24 + grupo.length}`,
        rules: [{
          type: 'expression', priority: 1,
          formulae: [`AND(${letra}25<>"",ABS(${letra}25-$K$14)>$K$14*0.02)`],
          style: { fill: relleno(ROSA) },
        }],
      });
    });
    // Areal > Ateorica -> la fibra no cumple. La perdida de tramo NO se promedia.
    [3, 4].forEach((k) => {
      const letra = ws.getColumn(col0 + k).letter;
      ws.addConditionalFormatting({
        ref: `${letra}25:${letra}${24 + grupo.length}`,
        rules: [{
          type: 'expression', priority: 1,
          formulae: [`AND(${letra}25<>"",${letra}25>$K$19)`],
          style: { fill: relleno(ROSA) },
        }],
      });
    });
  }
  return ws;
}


// -------------------------------------------------- Unifilar y Botellas
function hojaUnifilar(wb, cfg) {
  if (!cfg.epis || !cfg.epis.length) return null;
  const ws = wb.addWorksheet('Unifilar');
  ws.views = [{ showGridLines: false, state: 'normal' }];
  banda(ws, 1, 6, `UNIFILAR  ·  ${cfg.traza || cfg.registro.tramo}`, { alin: 'center' });
  ['Orden', 'Localidad / EPI', 'Progresiva (m)', 'Buffers entran',
   'Buffers salen', 'Observaciones'].forEach((h, k) =>
    celda(ws, 3, 1 + k, h, { bold: true, fill: AZUL, color: 'FFFFFFFF' }));
  cfg.epis.forEach((e, i) => {
    celda(ws, 4 + i, 1, e.orden ?? i + 1);
    celda(ws, 4 + i, 2, e.nombre, { alin: IZQ });
    celda(ws, 4 + i, 3, e.progresiva_m ?? null, { formato: '#,##0' });
    celda(ws, 4 + i, 4, e.buffersEntrada ?? null);
    celda(ws, 4 + i, 5, e.buffersSalida ?? null);
    celda(ws, 4 + i, 6, e.observaciones || '', { alin: IZQ });
  });
  [8, 30, 16, 15, 15, 34].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  prepararImpresion(ws, cfg);
  ws.pageSetup.orientation = 'portrait';
  return ws;
}

function hojaBotellas(wb, cfg, contraste) {
  if (!cfg.botellas || !cfg.botellas.length) return null;
  const ws = wb.addWorksheet('Botellas');
  ws.views = [{ showGridLines: false, state: 'normal' }];
  banda(ws, 1, 8, 'BOTELLAS DECLARADAS vs EMPALMES MEDIDOS', { alin: 'center' });
  celda(ws, 2, 1, 'Las botellas se cargan a mano. No se asumen cada 4000 m: '
        + 'dependen de enlaces, cortes y botellas agregadas en obra.',
        { size: 8, italic: true, alin: IZQ, borde: false });
  ['Botella', 'Prog. declarada (m)', 'Tipo', 'EPI', 'Prog. medida (m)',
   'Diferencia (m)', 'Estado', 'Motivo'].forEach((h, k) =>
    celda(ws, 4, 1 + k, h, { bold: true, fill: AZUL, color: 'FFFFFFFF' }));
  let r = 5;
  for (const e of contraste.emparejadas) {
    const b = e.botella;
    celda(ws, r, 1, `BOT-${String(b.n).padStart(2, '0')}`);
    celda(ws, r, 2, b.progresiva_m, { formato: '#,##0' });
    celda(ws, r, 3, b.tipo || 'paso');
    celda(ws, r, 4, b.epi || '');
    celda(ws, r, 5, Math.round(e.medida), { formato: '#,##0' });
    celda(ws, r, 6, Math.round(e.diferencia), { formato: '#,##0' });
    celda(ws, r, 7, 'CONFIRMADA');
    celda(ws, r, 8, b.motivo || '', { alin: IZQ });
    r++;
  }
  for (const b of contraste.sinMedicion) {
    ['BOT-' + String(b.n).padStart(2, '0'), b.progresiva_m, b.tipo || 'paso',
     b.epi || '', null, null, 'SIN MEDICION', b.motivo || '']
      .forEach((v, k) => celda(ws, r, 1 + k, v, { fill: ROSA,
        formato: k === 1 ? '#,##0' : undefined }));
    r++;
  }
  for (const x of contraste.sinDeclarar) {
    ['-', null, '', '', Math.round(x), null, 'MEDIDA SIN DECLARAR', '']
      .forEach((v, k) => celda(ws, r, 1 + k, v, { fill: 'FFFFEB9C',
        formato: k === 4 ? '#,##0' : undefined }));
    r++;
  }
  [12, 20, 14, 18, 18, 16, 22, 30].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  prepararImpresion(ws, cfg);
  return ws;
}

function hojaComparacion(wb, cfg, comparacion) {
  if (!comparacion || !comparacion.filas.length) return null;
  const ws = wb.addWorksheet('Comparación');
  ws.views = [{ showGridLines: false, state: 'normal' }];
  banda(ws, 1, 7, 'COMPARACIÓN CONTRA LA MEDICIÓN ANTERIOR', { alin: 'center' });
  celda(ws, 2, 1, `${comparacion.peores} lecturas empeoraron · `
        + `${comparacion.mejores} mejoraron · umbral de cambio 0,05 dB`,
        { size: 8, italic: true, alin: IZQ, borde: false });
  ['Empalme', 'Progresiva (m)', 'Pelo', 'Antes (dB)', 'Ahora (dB)',
   'Diferencia (dB)', 'Estado'].forEach((h, k) =>
    celda(ws, 4, 1 + k, h, { bold: true, fill: AZUL, color: 'FFFFFFFF' }));
  comparacion.filas.forEach((f, i) => {
    const r = 5 + i;
    const peor = f.estado === 'EMPEORO';
    celda(ws, r, 1, f.n, { fill: peor ? ROSA : undefined });
    celda(ws, r, 2, Math.round(f.prog), { formato: '#,##0', fill: peor ? ROSA : undefined });
    celda(ws, r, 3, f.fibra, { fill: peor ? ROSA : undefined });
    celda(ws, r, 4, f.antes, { formato: '0.000', fill: peor ? ROSA : undefined });
    celda(ws, r, 5, f.ahora, { formato: '0.000', fill: peor ? ROSA : undefined });
    celda(ws, r, 6, f.delta, { formato: '+0.000;-0.000', fill: peor ? ROSA : undefined });
    celda(ws, r, 7, f.estado, { bold: true, fill: peor ? ROSA : undefined });
  });
  [12, 16, 10, 14, 14, 16, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  prepararImpresion(ws, cfg);
  return ws;
}

// ---------------------------------------------------------------- entrada
async function generarLibro(ExcelJS, datos, cfg, extras = {}) {
  const { empalmes, valores, mediciones, longitud, cortadas } = datos;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Generador de planillas de empalme';

  const medidos = [...new Set(mediciones.map((m) => m.numero).filter((n) => n != null))];
  const conA = new Set(mediciones.filter((m) => m.sentido === 'A').map((m) => m.numero));
  const conB = new Set(mediciones.filter((m) => m.sentido === 'B').map((m) => m.numero));
  const bidiPorFibra = {};
  medidos.forEach((f) => { bidiPorFibra[f] = conA.has(f) && conB.has(f); });
  const bidi = Object.values(bidiPorFibra).some(Boolean);

  const equipos = [...new Set(mediciones.map((m) => m.equipo).filter(Boolean))];
  let obs = bidi
    ? `Medición bidireccional ${cfg.registro.tramo}${equipos.length ? ' (' + equipos.join(', ') + ')' : ''}. `
      + "Progresivas tal cual medidas por el OTDR en cada sentido. 'At Prom' = promedio de ambos sentidos."
    : `Medición unidireccional ${cfg.registro.tramo}${equipos.length ? ' (' + equipos.join(', ') + ')' : ''}. `
      + "No se dispone de la curva del extremo opuesto: las columnas 'De B→A' y 'At Prom' quedan sin "
      + "completar. La progresiva 'De B→A' es la complementaria: longitud óptica total menos la medida.";
  if (cortadas.size)
    obs += ' Pelos cortados: ' + [...cortadas.entries()]
      .map(([f, v]) => `F${String(f).padStart(2, '0')} a ${(v / 1000).toFixed(3)} km`).join(', ')
      + ', marcados en rojo y con las celdas posteriores al corte sin completar.';

  hojaRegistro(wb, cfg, longitud,
               extras.neConfirmados != null ? extras.neConfirmados : empalmes.length,
               medidos, empalmes.length);
  for (const tubo of tubos(cfg.estructura.fibrasTotales, cfg.estructura.fibrasPorTubo)) {
    if (medidos.some((f) => f >= tubo.desde && f <= tubo.hasta))
      hojaTubo(wb, cfg, tubo, empalmes, valores, longitud, bidiPorFibra,
               medidos, cortadas, obs, equipos[0] || '');
  }
  hojaCD(wb, cfg, mediciones, medidos, cortadas);
  hojaUnifilar(wb, cfg);
  if (extras.contraste) hojaBotellas(wb, cfg, extras.contraste);
  hojaComparacion(wb, cfg, extras.comparacion);
  return wb;
}

/** Revision de todas las hojas antes de descargar. */
function revisar(wb, cfg, empalmes, medidos, cortadas, teorica,
                        neConfirmados) {
  const hallazgos = [];
  const solapas = wb.worksheets.filter((w) => w.name.startsWith('AT. EMPALMES'));
  if (!solapas.length) return ['No se genero ninguna solapa de empalmes.'];
  let referencia = null;
  for (const ws of solapas) {
    const progresivas = [];
    let fila = 16;
    while (typeof ws.getCell(fila, 1).value === 'number') {
      progresivas.push(ws.getCell(fila, 2).value);
      fila++;
    }
    if (progresivas.length !== empalmes.length)
      hallazgos.push(`${ws.name}: ${progresivas.length} eventos, se esperaban ${empalmes.length}.`);
    if (!referencia) referencia = progresivas;
    else {
      const distintas = progresivas.filter((v, i) => v !== referencia[i]).length;
      if (distintas) hallazgos.push(`${ws.name}: ${distintas} progresivas no coinciden con la primera solapa.`);
    }
  }
  const reg = wb.getWorksheet('Registro Med FO');
  [[16, 'tipo de fibra'], [17, 'nodo origen'], [18, 'nodo destino'],
   [21, 'cable'], [22, 'contratista'], [24, 'tramo']].forEach(([f, etiqueta]) => {
    const v = reg.getCell(f, 3).value;
    if (v == null || String(v).trim() === '') hallazgos.push(`Registro Med FO: falta ${etiqueta}.`);
  });
  if (reg.getCell(19, 3).value !== (cfg.neManual || neConfirmados || empalmes.length))
    hallazgos.push('Registro Med FO: la cantidad de empalmes no coincide con lo declarado.');

  const umbral = cfg.parametros.umbralEmpalmeDb;
  const excedidos = new Set();
  let ambar = 0;
  for (const ws of solapas) {
    let fila = 16;
    while (typeof ws.getCell(fila, 1).value === 'number') {
      for (let c = 4; c <= ws.columnCount; c += 3) {
        for (const k of [0, 1]) {
          const v = ws.getCell(fila, c + k).value;
          if (typeof v === 'number' && v > umbral)
            excedidos.add(`${ws.getCell(fila, 1).value}`);
        }
        const prom = ws.getCell(fila, c + 2);
        if (prom.fill && prom.fill.fgColor
            && prom.fill.fgColor.argb === 'FFFFEB9C') ambar++;
      }
      fila++;
    }
  }
  if (excedidos.size)
    hallazgos.push(`${excedidos.size} empalme(s) con alguna lectura por encima del `
      + `umbral de ${umbral.toFixed(2).replace('.', ',')} dB: N° `
      + [...excedidos].join(', ') + ' (pintados en rojo).');
  if (ambar)
    hallazgos.push(`${ambar} celda(s) de At Prom se calcularon con un solo sentido `
      + '(marcadas en ámbar): revisar si corresponde tomarlas como válidas.');

  const cd = wb.getWorksheet('CD, PMD Y PWR');
  const excedidas = [];
  for (const col of [3, 13])
    for (let f = 25; f <= 24 + medidos.length; f++) {
      const pelo = cd.getCell(f, col).value;
      const val = cd.getCell(f, col + 3).value;
      if (typeof val === 'number' && teorica && val > teorica) excedidas.push(pelo);
    }
  if (excedidas.length)
    hallazgos.push(`Pérdida medida mayor que la teórica (${teorica.toFixed(3)} dB) en `
      + `${excedidas.length} pelos: ${excedidas.join(', ')} (pintados en rojo, hay que revisarlos).`);
  return hallazgos;
}

/**
 * Verificacion profunda del libro ya generado. Recorre celda por celda lo que
 * tendria que estar y devuelve los problemas encontrados. Se corre varias
 * veces antes de habilitar la descarga.
 */
function verificarLibro(wb, cfg, datos, extra) {
  const { empalmes, valores, mediciones, cortadas } = datos;
  const { medidos, bidiPorFibra } = extra;
  const fallas = [];
  const solapas = wb.worksheets.filter((w) => w.name.startsWith('AT. EMPALMES'));
  if (!solapas.length) return ['No se generó ninguna solapa de empalmes.'];

  const modo = (cfg.estructura && cfg.estructura.atProm) || 'siempre';
  let refProg = null;

  for (const ws of solapas) {
    // pelos que esta solapa deberia mostrar
    const pelos = {};
    for (let c = 4; c <= ws.columnCount; c += 3) {
      const v = ws.getCell(14, c).value;
      const m = /(\d{1,3})/.exec(typeof v === 'string' ? v : '');
      if (m) pelos[c] = parseInt(m[1], 10);
    }
    const filas = [];
    let fila = 16;
    while (typeof ws.getCell(fila, 1).value === 'number') {
      filas.push(fila);
      fila += 1;
    }
    if (filas.length !== empalmes.length) {
      fallas.push(`${ws.name}: ${filas.length} eventos cargados y `
        + `${empalmes.length} detectados.`);
      continue;
    }
    const progresivas = filas.map((f) => ws.getCell(f, 2).value);
    if (!refProg) refProg = progresivas;
    else if (progresivas.some((v, i) => v !== refProg[i]))
      fallas.push(`${ws.name}: las progresivas no coinciden con la primera solapa.`);

    for (const [c, f] of Object.entries(pelos)) {
      if (!medidos.includes(f) || cortadas.has(f)) continue;
      const col = Number(c);
      let conValorA = 0;
      let conValorB = 0;
      let sinFormula = 0;
      filas.forEach((r, i) => {
        const emp = empalmes[i];
        const a = ws.getCell(r, col).value;
        const b = ws.getCell(r, col + 1).value;
        const prom = ws.getCell(r, col + 2).value;
        if (typeof a === 'number' && a !== 0) conValorA += 1;
        if (typeof b === 'number' && b !== 0) conValorB += 1;
        const hayA = !!valores.get(`${f}|${emp.n}|A`);
        const hayB = !!valores.get(`${f}|${emp.n}|B`);
        const esperaFormula = bidiPorFibra[f]
          && (modo === 'siempre' || (hayA && hayB)
              || (modo === 'sin-cero' && (hayA || hayB)));
        const tieneFormula = prom && typeof prom === 'object' && prom.formula;
        if (esperaFormula && !tieneFormula) sinFormula += 1;
      });
      if (sinFormula)
        fallas.push(`${ws.name}: la fibra ${f} tiene ${sinFormula} celda(s) de `
          + 'At Prom sin la fórmula del promedio.');
      const midioA = mediciones.some((m) => m.numero === f && m.sentido === 'A');
      const midioB = mediciones.some((m) => m.numero === f && m.sentido === 'B');
      if (midioA && !conValorA)
        fallas.push(`${ws.name}: la fibra ${f} se midió en A→B pero no cargó ningún valor.`);
      if (midioB && !conValorB)
        fallas.push(`${ws.name}: la fibra ${f} se midió en B→A pero no cargó ningún valor.`);
    }
  }

  // hoja CD: perdida total de tramo por sentido
  const cd = wb.getWorksheet('CD, PMD Y PWR');
  if (!cd) fallas.push('Falta la hoja CD, PMD Y PWR.');
  else {
    const ubicado = new Map();
    for (const col0 of [3, 13]) {
      for (let r = 25; r <= 25 + medidos.length; r++) {
        const pelo = cd.getCell(r, col0).value;
        if (typeof pelo === 'number')
          ubicado.set(pelo, { A: cd.getCell(r, col0 + 3).value,
                              B: cd.getCell(r, col0 + 4).value });
      }
    }
    for (const f of medidos) {
      if (!ubicado.has(f)) {
        fallas.push(`CD, PMD Y PWR: falta la fibra ${f} en la tabla.`);
        continue;
      }
      const fila = ubicado.get(f);
      for (const sentido of ['A', 'B']) {
        const midio = mediciones.some((m) => m.numero === f && m.sentido === sentido
          && m.perdidaTotal != null);
        if (midio && typeof fila[sentido] !== 'number')
          fallas.push(`CD, PMD Y PWR: falta la pérdida total de la fibra ${f} `
            + `en el sentido ${sentido === 'A' ? 'A→B' : 'B→A'}.`);
      }
    }
    if (!String(cd.getCell(19, 11).value?.formula || '').includes('K13'))
      fallas.push('CD, PMD Y PWR: el valor teórico no quedó por fórmula.');
  }

  const reg = wb.getWorksheet('Registro Med FO');
  if (!reg) fallas.push('Falta la hoja Registro Med FO.');
  else if (reg.getCell(19, 3).value
      !== (cfg.neManual || extra.neConfirmados || empalmes.length))
    fallas.push('Registro Med FO: la cantidad de empalmes no coincide.');

  return fallas;
}
/*
 * Salida PDF de la planilla de empalme, pensada para presentar al cliente.
 * Usa jsPDF + autoTable (ambos cargados como globales desde el CDN).
 *
 *   Hoja 1        caratula: cabecera del registro, calculo teorico y
 *                 tabla de atenuacion por pelo con su estado
 *   Hojas siguen  un bloque por tubo, de a 6 pelos por tabla para que
 *                 entre legible en A4 apaisado
 */
const COLOR_PDF = {
  azul: [31, 78, 121], naranja: [237, 125, 49], verde: [84, 130, 53],
  marron: [132, 60, 12], gris: [128, 128, 128], blanco: [235, 235, 235],
  rojo: [192, 0, 0], negro: [38, 38, 38], violeta: [112, 48, 160],
  rosa: [255, 153, 204], aguamarina: [49, 133, 156], amarillo: [255, 217, 102],
};
const CLARO = ['blanco', 'amarillo', 'rosa'];
const GAMA = ['azul', 'naranja', 'verde', 'marron', 'gris', 'blanco', 'rojo',
              'negro', 'violeta', 'rosa', 'aguamarina', 'amarillo'];
const ROJO_SUAVE = [255, 199, 206];
const GRIS_SUAVE = [242, 242, 242];
const AZUL_TITULO = [31, 78, 121];

const sinTildePdf = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const miles = (n) => Math.round(n).toLocaleString('es-AR');
// formato argentino: coma decimal. Helvetica no trae la flecha unicode.
const dec = (n, d = 3) => (n == null || isNaN(n) ? '' : n.toFixed(d).replace('.', ','));
const FA = 'A->B';
const FB = 'B->A';

function generarPDF(jsPDFCtor, datos, cfg, extra) {
  // jsPDF 2.x expone autoTable como metodo; algunas builds solo como funcion suelta
  const suelta = (typeof extra.autoTable === 'function' && extra.autoTable)
    || (globalThis.jspdf && globalThis.jspdf.autoTable)
    || globalThis.autoTable;
  const tabla = (doc, opciones) => {
    if (typeof doc.autoTable === 'function') return doc.autoTable(opciones);
    if (typeof suelta === 'function') return suelta(doc, opciones);
    throw new Error('No se pudo cargar jsPDF autoTable. Revisá la conexión: '
      + 'la librería se descarga del CDN en la primera carga.');
  };
  const { empalmes, valores, mediciones, longitud, cortadas } = datos;
  const { teorica, tubos, medidos, bidiPorFibra, pulso } = extra;
  const p = cfg.parametros;
  const doc = new jsPDFCtor({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const ancho = doc.internal.pageSize.getWidth();

  const logos = cfg.logos || {};
  const ponerLogo = (dataURL, x, y, ancho2, alto2) => {
    if (!dataURL) return false;
    const m = /^data:image\/(png|jpeg|jpg)/i.exec(dataURL);
    if (!m) return false;
    try {
      doc.addImage(dataURL, m[1].toUpperCase() === 'JPG' ? 'JPEG' : m[1].toUpperCase(),
                   x, y, ancho2, alto2);
      return true;
    } catch (e) { return false; }
  };

  const encabezado = (titulo, subtitulo) => {
    doc.setFillColor(...AZUL_TITULO);
    doc.rect(0, 0, ancho, 16, 'F');
    doc.setTextColor(255).setFontSize(11).setFont('helvetica', 'bold');
    doc.text(titulo, 10, 8);
    doc.setFontSize(8).setFont('helvetica', 'normal');
    doc.text(subtitulo, 10, 13);
    doc.setTextColor(0);
  };

  // ------------------------------------------------------------- caratula
  const conLogos = !!(logos.empresa || logos.cliente);
  if (conLogos) {
    doc.setFillColor(255, 255, 255);
    doc.rect(0, 0, ancho, 24, 'F');
    ponerLogo(logos.empresa, 10, 4, 42, 16);
    ponerLogo(logos.cliente, ancho - 52, 4, 42, 16);
    doc.setDrawColor(...AZUL_TITULO).setLineWidth(0.6);
    doc.line(10, 23, ancho - 10, 23);
    doc.setTextColor(...AZUL_TITULO).setFontSize(13).setFont('helvetica', 'bold');
    doc.text('PLANILLA DE EMPALME', ancho / 2, 11, { align: 'center' });
    doc.setFontSize(9).setFont('helvetica', 'normal').setTextColor(80);
    doc.text(`${cfg.registro.tramo || ''}   |   ${(longitud / 1000).toFixed(4)} km`
             .replace('.', ','), ancho / 2, 18, { align: 'center' });
    doc.setTextColor(0);
  }
  if (!conLogos) encabezado('PLANILLA DE EMPALME  -  ' + (cfg.registro.tramo || ''),
             `${cfg.registro.nodoA}  ->  ${cfg.registro.nodoB}   |   `
             + `${dec(longitud / 1000, 4)} km   |   ${empalmes.length} empalmes`);

  const tipos = [...new Set(medidos
    .map((f) => (cfg.tiposFibra.find((t) => f >= t.desde && f <= t.hasta) || {}).tipo)
    .filter(Boolean))];
  const equipos = [...new Set(mediciones.map((m) => m.equipo).filter(Boolean))];

  tabla(doc, {
    startY: conLogos ? 28 : 22,
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: AZUL_TITULO, fontSize: 8 },
    columnStyles: { 0: { fontStyle: 'bold', fillColor: GRIS_SUAVE, cellWidth: 42 },
                    2: { fontStyle: 'bold', fillColor: GRIS_SUAVE, cellWidth: 42 } },
    head: [[{ content: 'Datos del tramo', colSpan: 4, styles: { halign: 'left' } }]],
    body: [
      ['Tipo de fibra', tipos.join(' / '), 'Cable', cfg.registro.cable],
      ['Nodo origen (A)', cfg.registro.nodoA, 'Nodo destino (B)', cfg.registro.nodoB],
      ['Cantidad de empalmes', String(empalmes.length),
       'Longitud óptica total', `${dec(longitud / 1000, 4)} km`],
      ['Contratista', cfg.registro.contratista, 'Fecha',
       new Date().toLocaleDateString('es-AR')],
      ['Equipo', equipos.join(', ') || '-', 'Ancho de pulso',
       pulso ? `${pulso} ns` : '-'],
      ['Medición',
       Object.values(bidiPorFibra).some(Boolean) ? 'Bidireccional' : 'Unidireccional',
       'Umbral de aceptación', `${dec(p.umbralEmpalmeDb, 2)} dB por empalme`],
    ],
    margin: { left: 10, right: ancho / 2 + 2 },
    tableWidth: ancho / 2 - 12,
  });

  tabla(doc, {
    startY: conLogos ? 28 : 22,
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: AZUL_TITULO, fontSize: 8 },
    columnStyles: { 0: { cellWidth: 'auto' }, 1: { halign: 'right', cellWidth: 26 } },
    head: [[{ content: 'Pérdida teórica del tramo    At = a·L + Ne·ae + Nc·ac',
              colSpan: 2, styles: { halign: 'left' } }]],
    body: [
      [`a - atenuación nominal a ${p.longitudOndaNm} nm`, `${dec(p.atenuacionDbKm, 2)} dB/km`],
      ['L - longitud óptica total', `${dec(longitud / 1000, 4)} km`],
      ['Ne - cantidad de empalmes', String(empalmes.length)],
      ['ae - pérdida por empalme', `${dec(p.perdidaEmpalmeDb, 2)} dB`],
      ['Nc - cantidad de conectores', String(p.cantidadConectores)],
      ['ac - pérdida por conector', `${dec(p.perdidaConectorDb, 2)} dB`],
      [{ content: 'At - pérdida teórica del tramo', styles: { fontStyle: 'bold' } },
       { content: `${dec(teorica)} dB`, styles: { fontStyle: 'bold' } }],
      [{ content: 'Criterio de aceptación: At > Ar (la medida debe ser menor que la teórica)',
         colSpan: 2, styles: { fontSize: 7, textColor: [110, 110, 110] } }],
    ],
    margin: { left: ancho / 2 + 2, right: 10 },
    tableWidth: ancho / 2 - 12,
  });

  // tabla de atenuacion por pelo, en tres columnas
  const filas = medidos.map((f) => {
    const vA = (mediciones.find((x) => x.numero === f && x.sentido === 'A'
                                 && x.perdidaTotal != null) || {}).perdidaTotal;
    const vB = (mediciones.find((x) => x.numero === f && x.sentido === 'B'
                                 && x.perdidaTotal != null) || {}).perdidaTotal;
    // la perdida de tramo no se promedia: se evalua cada sentido por separado
    const peor = [vA, vB].filter((v) => v != null);
    const maximo = peor.length ? Math.max(...peor) : null;
    return [String(f), vA == null ? '-' : dec(vA), vB == null ? '-' : dec(vB),
            cortadas.has(f) ? 'CORTADA' : maximo == null ? '-'
              : maximo > teorica ? 'REVISAR' : 'CUMPLE'];
  });
  const vacia = ['', '', '', ''];
  const mitadF = Math.ceil(filas.length / 2);
  const cuerpo = [];
  for (let i = 0; i < mitadF; i++) {
    cuerpo.push([...(filas[i] || vacia), ...(filas[i + mitadF] || vacia)]);
  }
  tabla(doc, {
    startY: Math.max(doc.lastAutoTable.finalY, conLogos ? 28 : 22) + 6,
    theme: 'grid',
    styles: { fontSize: 7.5, cellPadding: 1.2, halign: 'center' },
    headStyles: { fillColor: AZUL_TITULO, fontSize: 7.5 },
    head: [Array(2).fill(['Pelo', 'A->B (dB)', 'B->A (dB)', 'Estado']).flat()],
    body: cuerpo,
    margin: { left: 10, right: 10 },
    didParseCell: (d) => {
      if (d.section !== 'body') return;
      if (d.column.index % 4 !== 3) return;
      if (d.cell.raw === 'REVISAR' || d.cell.raw === 'CORTADA') {
        d.cell.styles.fillColor = ROJO_SUAVE;
        d.cell.styles.textColor = [156, 0, 6];
        d.cell.styles.fontStyle = 'bold';
      }
    },
  });

  // ------------------------------------------------------- solapas por tubo
  const POR_TABLA = 6;
  for (const tubo of tubos) {
    const pelos = [];
    for (let f = tubo.desde; f <= tubo.hasta; f++) if (medidos.includes(f)) pelos.push(f);
    if (!pelos.length) continue;
    const color = COLOR_PDF[sinTildePdf(tubo.color)] || AZUL_TITULO;
    const claro = CLARO.includes(sinTildePdf(tubo.color));

    for (let i = 0; i < pelos.length; i += POR_TABLA) {
      const grupo = pelos.slice(i, i + POR_TABLA);
      doc.addPage();
      encabezado(`ATENUACIÓN DE EMPALMES  -  ${cfg.registro.tramo || ''}`,
                 `Tubo ${tubo.n} ${tubo.color.toUpperCase()}  |  pelos `
                 + `${grupo[0]} a ${grupo[grupo.length - 1]}  |  umbral `
                 + `${dec(p.umbralEmpalmeDb, 2)} dB`);

      const cabecera1 = [
        { content: 'Evento', rowSpan: 2 },
        { content: 'Progresiva óptica (m)', colSpan: 2 },
        ...grupo.map((f) => {
          const nombre = GAMA[(f - tubo.desde) % GAMA.length];
          const c = COLOR_PDF[nombre] || color;
          return {
            content: `Fibra ${f}${cortadas.has(f) ? ' CORTADA' : ''}`,
            colSpan: 3,
            styles: { fillColor: cortadas.has(f) ? ROJO_SUAVE : c,
                      textColor: cortadas.has(f) ? [156, 0, 6]
                        : (CLARO.includes(nombre) ? [0, 0, 0] : [255, 255, 255]) },
          };
        }),
      ];
      const cabecera2 = [`De ${FA}`, `De ${FB}`,
        ...grupo.flatMap(() => [FA, FB, 'Prom'])];

      const cuerpoTubo = empalmes.map((emp) => {
        const fila = [String(emp.n), miles(emp.prog_a), miles(emp.prog_b)];
        for (const f of grupo) {
          const corte = cortadas.get(f);
          if (corte != null && emp.prog_a > corte) { fila.push('', '', ''); continue; }
          const va = valores.get(`${f}|${emp.n}|A`);
          const vb = valores.get(`${f}|${emp.n}|B`);
          const hayA = !!(va && va.perdida != null);
          const hayB = !!(vb && vb.perdida != null);
          const a = hayA ? va.perdida : 0;
          const b = hayB ? vb.perdida : 0;
          const modo = (cfg.estructura && cfg.estructura.atProm) || 'siempre';
          let prom = '';
          if (bidiPorFibra[f]) {
            if (modo === 'siempre' || (hayA && hayB)) prom = dec((a + b) / 2);
            else if (modo === 'sin-cero') prom = hayA ? dec(a) : (hayB ? dec(b) : '');
          }
          fila.push(dec(a), dec(b), prom);
        }
        return fila;
      });

      tabla(doc, {
        startY: 20,
        theme: 'grid',
        styles: { fontSize: 7, cellPadding: 0.9, halign: 'center', lineWidth: 0.1,
                  lineColor: [150, 150, 150] },
        headStyles: { fillColor: AZUL_TITULO, fontSize: 7, halign: 'center' },
        columnStyles: { 0: { fontStyle: 'bold', fillColor: GRIS_SUAVE },
                        1: { fontStyle: 'bold', fillColor: GRIS_SUAVE },
                        2: { fontStyle: 'bold', fillColor: GRIS_SUAVE } },
        head: [cabecera1, cabecera2],
        body: cuerpoTubo,
        margin: { left: 8, right: 8 },
        didParseCell: (d) => {
          if (d.section !== 'body' || d.column.index < 3) return;
          const rel = (d.column.index - 3) % 3;
          const f = grupo[Math.floor((d.column.index - 3) / 3)];
          if (cortadas.get(f) != null && d.cell.raw === '') {
            d.cell.styles.fillColor = ROJO_SUAVE;
            return;
          }
          if (rel === 2) { d.cell.styles.fontStyle = 'bold'; return; }
          const v = parseFloat(String(d.cell.raw).replace(',', '.'));
          if (!isNaN(v) && v > p.umbralEmpalmeDb) {
            d.cell.styles.fillColor = ROJO_SUAVE;
            d.cell.styles.textColor = [156, 0, 6];
          }
        },
      });
    }
  }


  // ------------------------------------------------- grafico de empalmes
  const promedios = empalmes.map((emp) => {
    const lecturas = [];
    for (const f of medidos) {
      const va = valores.get(`${f}|${emp.n}|A`);
      const vb = valores.get(`${f}|${emp.n}|B`);
      const vals = [va, vb].filter((v) => v && v.perdida != null).map((v) => v.perdida);
      if (vals.length) lecturas.push(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    return { n: emp.n, prog: emp.prog_a,
             valor: lecturas.length ? Math.max(...lecturas) : 0 };
  });

  if (promedios.length) {
    doc.addPage();
    encabezado('PERDIDA POR EMPALME  -  ' + (cfg.registro.tramo || ''),
               `Peor lectura de cada empalme entre todos los pelos  |  umbral `
               + `${dec(p.umbralEmpalmeDb, 2)} dB  |  ${empalmes.length} empalmes`);

    const x0 = 16;
    const y0 = 36;
    const anchoG = ancho - 32;
    const altoG = 110;
    const maximo = Math.max(p.umbralEmpalmeDb * 1.4,
                            ...promedios.map((e) => e.valor)) * 1.1;
    const escala = (v) => altoG - (v / maximo) * altoG;

    doc.setDrawColor(200).setLineWidth(0.2);
    for (let i = 0; i <= 4; i++) {
      const v = (maximo / 4) * i;
      const y = y0 + escala(v);
      doc.line(x0, y, x0 + anchoG, y);
      doc.setFontSize(6.5).setTextColor(130);
      doc.text(dec(v, 2), x0 - 2, y + 1, { align: 'right' });
    }
    doc.setTextColor(0);

    const paso = anchoG / promedios.length;
    const barra = Math.min(paso * 0.65, 7);
    promedios.forEach((e, i) => {
      const x = x0 + i * paso + (paso - barra) / 2;
      const alto = altoG - escala(e.valor);
      const excede = e.valor > p.umbralEmpalmeDb;
      doc.setFillColor(...(excede ? [192, 0, 0] : AZUL_TITULO));
      doc.rect(x, y0 + escala(e.valor), barra, Math.max(alto, 0.3), 'F');
      if (promedios.length <= 40 || i % 2 === 0) {
        doc.setFontSize(5.5).setTextColor(110);
        doc.text(String(e.n), x + barra / 2, y0 + altoG + 4, { align: 'center' });
      }
      if (excede) {
        doc.setFontSize(5.5).setTextColor(156, 0, 6);
        doc.text(dec(e.valor), x + barra / 2, y0 + escala(e.valor) - 1.5,
                 { align: 'center' });
      }
    });
    doc.setTextColor(0);

    const yUmbral = y0 + escala(p.umbralEmpalmeDb);
    doc.setDrawColor(192, 0, 0).setLineWidth(0.5).setLineDashPattern([1.5, 1.2], 0);
    doc.line(x0, yUmbral, x0 + anchoG, yUmbral);
    doc.setLineDashPattern([], 0);
    doc.setFontSize(7).setTextColor(192, 0, 0);
    doc.text(`umbral ${dec(p.umbralEmpalmeDb, 2)} dB`, x0 + anchoG, yUmbral - 1.5,
             { align: 'right' });
    doc.setTextColor(0).setDrawColor(120).setLineWidth(0.3);
    doc.line(x0, y0 + altoG, x0 + anchoG, y0 + altoG);
    doc.setFontSize(7).setTextColor(110);
    doc.text('Número de empalme', x0 + anchoG / 2, y0 + altoG + 9, { align: 'center' });
    doc.text('dB', x0 - 8, y0 + altoG / 2, { align: 'center' });
    doc.setTextColor(0);

    const fuera = promedios.filter((e) => e.valor > p.umbralEmpalmeDb);
    doc.setFontSize(8);
    doc.text(fuera.length
      ? `${fuera.length} empalme(s) por encima del umbral: `
        + fuera.map((e) => `N° ${e.n} (${dec(e.valor)} dB)`).join(', ')
      : 'Ningún empalme supera el umbral de aceptación.',
      x0, y0 + altoG + 18, { maxWidth: anchoG });
  }

  // --------------------------------------------------------- botellas
  if (extra.contraste && cfg.botellas && cfg.botellas.length) {
    const c = extra.contraste;
    doc.addPage();
    encabezado('BOTELLAS DECLARADAS vs EMPALMES MEDIDOS  -  '
               + (cfg.registro.tramo || ''),
               `${c.emparejadas.length} confirmadas  |  ${c.sinMedicion.length} sin `
               + `medición  |  ${c.sinDeclarar.length} medidas sin declarar`);
    const cuerpoBot = [
      ...c.emparejadas.map((e) => [`BOT-${String(e.botella.n).padStart(2, '0')}`,
        miles(e.botella.progresiva_m), e.botella.tipo || 'paso', e.botella.epi || '',
        miles(e.medida), miles(e.diferencia), 'CONFIRMADA', e.botella.motivo || '']),
      ...c.sinMedicion.map((b) => [`BOT-${String(b.n).padStart(2, '0')}`,
        miles(b.progresiva_m), b.tipo || 'paso', b.epi || '', '', '',
        'SIN MEDICION', b.motivo || '']),
      ...c.sinDeclarar.map((x) => ['-', '', '', '', miles(x), '',
        'MEDIDA SIN DECLARAR', '']),
    ];
    tabla(doc, {
      startY: 22, theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.4, halign: 'center' },
      headStyles: { fillColor: AZUL_TITULO, fontSize: 8 },
      head: [['Botella', 'Prog. declarada (m)', 'Tipo', 'EPI', 'Prog. medida (m)',
              'Diferencia (m)', 'Estado', 'Motivo']],
      body: cuerpoBot,
      margin: { left: 10, right: 10 },
      didParseCell: (d) => {
        if (d.section !== 'body' || d.column.index !== 6) return;
        if (d.cell.raw === 'SIN MEDICION') {
          d.cell.styles.fillColor = ROJO_SUAVE;
          d.cell.styles.textColor = [156, 0, 6];
        } else if (d.cell.raw === 'MEDIDA SIN DECLARAR') {
          d.cell.styles.fillColor = [255, 235, 156];
        }
      },
    });
  }

  // --------------------------------------------------------- unifilar
  if (cfg.epis && cfg.epis.length) {
    {
      doc.addPage();
      encabezado('UNIFILAR  -  ' + (cfg.registro.tramo || ''),
                 `${cfg.epis.length} localidades declaradas  |  entrada de buffers por EPI`);
      tabla(doc, {
        startY: 22, theme: 'grid',
        styles: { fontSize: 8, cellPadding: 1.4, halign: 'center' },
        headStyles: { fillColor: AZUL_TITULO, fontSize: 8 },
        head: [['Orden', 'Localidad / EPI', 'Progresiva (m)', 'Buffers entran',
                'Buffers salen', 'Observaciones']],
        body: cfg.epis.map((e, i) => [String(e.orden ?? i + 1), e.nombre,
          e.progresiva_m == null ? '' : miles(e.progresiva_m),
          String(e.buffersEntrada ?? ''), String(e.buffersSalida ?? ''),
          e.observaciones || '']),
        margin: { left: 10, right: 10 },
      });
    }
  }

  // ------------------------------------------------------- comparacion
  if (extra.comparacion && extra.comparacion.filas.length) {
    const cmp = extra.comparacion;
    doc.addPage();
    encabezado('COMPARACION CONTRA LA MEDICION ANTERIOR  -  '
               + (cfg.registro.tramo || ''),
               `${cmp.peores} lecturas empeoraron  |  ${cmp.mejores} mejoraron  |  `
               + 'se listan los cambios mayores a 0,05 dB');
    tabla(doc, {
      startY: 22, theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 1.2, halign: 'center' },
      headStyles: { fillColor: AZUL_TITULO, fontSize: 7.5 },
      head: [['Empalme', 'Progresiva (m)', 'Pelo', 'Antes (dB)', 'Ahora (dB)',
              'Diferencia (dB)', 'Estado']],
      body: cmp.filas.slice(0, 120).map((f) => [String(f.n), miles(f.prog),
        String(f.fibra), f.antes == null ? '-' : dec(f.antes), dec(f.ahora),
        f.delta == null ? '-' : (f.delta > 0 ? '+' : '') + dec(f.delta), f.estado]),
      margin: { left: 10, right: 10 },
      didParseCell: (d) => {
        if (d.section !== 'body') return;
        const estado = cmp.filas[d.row.index];
        if (estado && estado.estado === 'EMPEORO') {
          d.cell.styles.fillColor = ROJO_SUAVE;
          if (d.column.index === 6) d.cell.styles.textColor = [156, 0, 6];
        }
      },
    });
  }

  // ------------------------------------------------------------ firma
  const ap = cfg.aprobacion || {};
  doc.addPage();
  encabezado('APROBACION  -  ' + (cfg.registro.tramo || ''),
             'Conformidad de la medición de atenuación de empalmes');
  doc.setFontSize(9);
  const yF = 46;
  doc.text('Los valores consignados corresponden a las mediciones OTDR realizadas '
    + 'sobre el tramo indicado.', 14, 30, { maxWidth: ancho - 28 });
  [['Por el contratista', cfg.registro.contratista || ''],
   ['Por el cliente', ''],
   ['Responsable técnico', ap.responsable || '']].forEach(([rol, nombre], i) => {
    const x = 14 + i * ((ancho - 28) / 3);
    const w = (ancho - 28) / 3 - 12;
    doc.setDrawColor(120).setLineWidth(0.3);
    doc.line(x, yF + 34, x + w, yF + 34);
    doc.setFontSize(8).setTextColor(110);
    doc.text('Firma y aclaración', x, yF + 39);
    doc.setFontSize(9).setTextColor(0).setFont('helvetica', 'bold');
    doc.text(rol, x, yF);
    doc.setFont('helvetica', 'normal');
    if (nombre) doc.text(nombre, x, yF + 6);
  });
  doc.setFontSize(8).setTextColor(110);
  doc.text(`Fecha: ${new Date().toLocaleDateString('es-AR')}`, 14, yF + 52);
  if (ap.cargo) doc.text(ap.cargo, 14 + 2 * ((ancho - 28) / 3), yF + 6);
  doc.setTextColor(0);

  // pie de pagina en todas las hojas
  const total = doc.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFontSize(7).setTextColor(120);
    doc.text(cfg.registro.contratista || '', 10,
             doc.internal.pageSize.getHeight() - 6);
    if (cfg.pieLicencia)
      doc.text(cfg.pieLicencia.replace(/—/g, '-'), ancho / 2,
               doc.internal.pageSize.getHeight() - 6, { align: 'center' });
    doc.text(`Página ${i} de ${total}`, ancho - 10,
             doc.internal.pageSize.getHeight() - 6, { align: 'right' });
  }
  return doc;
}
/*
 * Licencia de uso: firma ECDSA P-256 verificada en el navegador.
 *
 * La aplicación solo lleva la clave PÚBLICA: puede comprobar que una licencia
 * fue firmada por el titular, pero no puede fabricar ninguna.
 *
 * La licencia queda atada al correo y al código de equipo, y vence en la fecha
 * que trae adentro, con los días de gracia que se le hayan dado.
 */

// Clave pública del titular. Se reemplaza si se genera un par nuevo.
const CLAVE_PUBLICA = {
  kty: 'EC',
  crv: 'P-256',
  x: 'E3i4iLQIf3WNW0Qy32vUvFiQ4cKe2jsyYPJmj9VdqHY',
  y: 'ecZ7goZflZwrRTOQefPJ87sxU1OWpE0cUe5-vFfVOdI',
};

const ALMACEN = 'licencia_planillas';
const RELOJ = 'licencia_ultima_fecha';

const desdeB64u = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const texto = (s) => new TextEncoder().encode(s);
const hoy = () => new Date().toISOString().slice(0, 10);

async function sha256Hex(cadena) {
  const h = await crypto.subtle.digest('SHA-256', texto(cadena));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Código del equipo. El navegador no da acceso a la MAC, así que se arma con
 * rasgos estables de la máquina: plataforma, núcleos, memoria, zona horaria,
 * idioma y familia de navegador. No incluye versiones ni resolución de
 * pantalla, que cambian solos y romperían la licencia.
 */
async function codigoEquipo() {
  const ua = navigator.userAgent || '';
  const familia = /Edg\//.test(ua) ? 'edge'
    : /OPR\//.test(ua) ? 'opera'
    : /Firefox\//.test(ua) ? 'firefox'
    : /Chrome\//.test(ua) ? 'chrome'
    : /Safari\//.test(ua) ? 'safari' : 'otro';
  const partes = [
    (navigator.platform || navigator.userAgentData?.platform || '').toLowerCase(),
    navigator.hardwareConcurrency || 0,
    navigator.deviceMemory || 0,
    Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    (navigator.language || '').slice(0, 2),
    familia,
  ];
  return (await sha256Hex(partes.join('|'))).slice(0, 12);
}

/** Verifica la firma y devuelve los datos de la licencia. */
async function leerLicencia(cadena) {
  const partes = String(cadena || '').trim().replace(/\s+/g, '').split('.');
  if (partes.length !== 2) throw new Error('la clave está incompleta o mal copiada');
  const [cuerpo, firma] = partes;
  const clave = await crypto.subtle.importKey('jwk', CLAVE_PUBLICA,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valida = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' },
    clave, desdeB64u(firma), texto(cuerpo));
  if (!valida) throw new Error('la clave no es válida para esta aplicación');
  return JSON.parse(new TextDecoder().decode(desdeB64u(cuerpo)));
}

/** Estado de la licencia contra el equipo, el correo y la fecha. */
async function evaluar(datos, equipo) {
  if (datos.d !== equipo)
    return { ok: false, motivo: 'La licencia fue emitida para otro equipo.' };

  const ultima = localStorage.getItem(RELOJ);
  const dia = hoy();
  if (ultima && dia < ultima)
    return { ok: false, motivo: 'La fecha del equipo está atrasada respecto de la '
      + 'última vez que se usó la aplicación. Corregí la fecha y volvé a intentar.' };
  try { localStorage.setItem(RELOJ, dia); } catch (e) {}

  const vence = new Date(datos.v + 'T23:59:59');
  const gracia = Number.isFinite(datos.g) ? datos.g : 0;
  const limite = new Date(vence.getTime() + gracia * 86400000);
  const ahora = new Date();
  const dias = Math.ceil((vence - ahora) / 86400000);

  if (ahora > limite)
    return { ok: false, vencida: true, dias,
             motivo: `La licencia venció el ${fecha(datos.v)}.` };
  if (ahora > vence)
    return { ok: true, gracia: true, dias,
             motivo: `La licencia venció el ${fecha(datos.v)}. Estás dentro de los `
               + `${gracia} días de gracia.` };
  return { ok: true, dias };
}

const fecha = (iso) => (iso || '').split('-').reverse().join('/');

function guardar(cadena) {
  try { localStorage.setItem(ALMACEN, cadena); } catch (e) {}
}
function guardada() {
  try { return localStorage.getItem(ALMACEN) || ''; } catch (e) { return ''; }
}
function borrar() {
  try { localStorage.removeItem(ALMACEN); } catch (e) {}
}

/** Texto para el pie de las planillas. */
function pieLicencia(datos) {
  if (!datos) return '';
  return `Licencia: ${datos.n} — ${datos.e} — vence ${fecha(datos.v)}`;
}
/*
 * Planilla de reparaciones.
 *
 * Dos cosas distintas:
 *  1. Control de configuración del equipo contra la tabla del pliego.
 *  2. Diagnóstico de cada evento fuera de norma, cruzando la infraestructura
 *     declarada (botellas, cruces de ganancia, suspensiones, retenciones,
 *     cruces de calle) con lo que muestran las mediciones.
 */

// ------------------------------------------------------- tabla del pliego
// distancia del tramo (km) -> combinaciones válidas de pulso (ns) y duración (s)
const TABLA_PLIEGO = [
  { desde: 0, hasta: 5, opciones: [[10, 90]] },
  { desde: 5, hasta: 10, opciones: [[10, 90], [30, 30]] },
  { desde: 10, hasta: 20, opciones: [[30, 45], [100, 30]] },
  { desde: 20, hasta: 40, opciones: [[100, 60], [275, 45]] },
  { desde: 40, hasta: 80, opciones: [[275, 90], [1000, 60]] },
  { desde: 80, hasta: 120, opciones: [[1000, 90], [2500, 60]] },
  { desde: 120, hasta: 160, opciones: [[2500, 120], [10000, 90]] },
  { desde: 160, hasta: 200, opciones: [[10000, 120], [20000, 90]] },
  { desde: 200, hasta: 260, opciones: [[20000, 120]] },
];

const BOBINA_MINIMA_M = 800;      // lanzamiento y terminación exigidos

const pulsoTexto = (ns) => (ns >= 1000 ? `${ns / 1000} µs` : `${ns} ns`);
const nominal = (v) => [1310, 1383, 1490, 1550, 1625]
  .reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), 1550);

function ondaNominal(m) {
  return nominal(m.longitudOnda || 1550);
}

/**
 * Pelos cuya ida y vuelta estan en ventanas distintas. Ese promedio no es
 * comparable: la fibra atenua distinto en 1310 que en 1550.
 */
function pelosConVentanasCruzadas(mediciones) {
  const porPelo = new Map();
  for (const m of mediciones) {
    if (m.numero == null) continue;
    if (!porPelo.has(m.numero)) porPelo.set(m.numero, new Map());
    const ondas = porPelo.get(m.numero);
    const onda = ondaNominal(m);
    if (!ondas.has(onda)) ondas.set(onda, new Set());
    ondas.get(onda).add(m.sentido === 'B' ? 'B' : 'A');
  }
  const salida = [];
  for (const [pelo, ondas] of [...porPelo].sort((x, y) => x[0] - y[0])) {
    const completa = [...ondas.values()].some((s) => s.has('A') && s.has('B'));
    if (completa) continue;
    const enA = [...ondas].filter(([, s]) => s.has('A')).map(([o]) => o);
    const enB = [...ondas].filter(([, s]) => s.has('B')).map(([o]) => o);
    if (!enA.length || !enB.length) continue;      // le falta un sentido, no es mezcla
    salida.push({ pelo, ondasA: enA, ondasB: enB,
      motivo: `A→B en ${enA.join(' y ')} nm, B→A en ${enB.join(' y ')} nm` });
  }
  return salida;
}

/**
 * Control de configuración. Devuelve una lista de hallazgos con su gravedad:
 * 'critico' invalida la medición, 'aviso' hay que revisarlo.
 */
function controlarConfiguracion(mediciones, opciones = {}) {
  const hallazgos = [];
  const bobina = opciones.bobinaMinima ?? BOBINA_MINIMA_M;
  if (!mediciones.length) return hallazgos;

  const km = (m) => (m.longitud_m || 0) / 1000;
  const fila = (d) => TABLA_PLIEGO.find((f) => d > f.desde && d <= f.hasta);

  // pulso y duración contra la tabla
  const fuera = [];
  for (const m of mediciones) {
    const f = fila(km(m));
    if (!f) continue;
    const pulsos = f.opciones.map((o) => o[0]);
    if (!pulsos.includes(Math.round(m.pulsoNs))) {
      fuera.push({ m, esperado: pulsos.map(pulsoTexto).join(' o ') });
      continue;
    }
    const duracionMin = Math.min(...f.opciones
      .filter((o) => o[0] === Math.round(m.pulsoNs)).map((o) => o[1]));
    if (m.duracionS && m.duracionS < duracionMin)
      hallazgos.push({ gravedad: 'aviso', titulo: 'Duración de adquisición corta',
        detalle: `${m.archivo}: ${m.duracionS} s con pulso de `
          + `${pulsoTexto(m.pulsoNs)}. El pliego pide ${duracionMin} s.`,
        accion: 'Repetir la medición con la duración que corresponde.' });
  }
  if (fuera.length) {
    const ej = fuera.slice(0, 4).map((x) => `${x.m.archivo} `
      + `(${km(x.m).toFixed(1)} km con ${pulsoTexto(x.m.pulsoNs)}, `
      + `corresponde ${x.esperado})`).join('; ');
    hallazgos.push({ gravedad: 'critico',
      titulo: `Ancho de pulso fuera del pliego en ${fuera.length} medición(es)`,
      detalle: ej + (fuera.length > 4 ? ' y otras.' : '.'),
      accion: 'Con un pulso más largo del que corresponde, dos eventos cercanos se '
        + 'ven como uno solo y la progresiva queda corrida. Reconfigurar el OTDR '
        + 'según la tabla del pliego y volver a medir.' });
  }

  // el pliego exige la misma configuración en los dos sentidos
  const porSentido = { A: new Set(), B: new Set() };
  mediciones.forEach((m) => {
    if (m.pulsoNs) porSentido[m.sentido === 'B' ? 'B' : 'A'].add(Math.round(m.pulsoNs));
  });
  const pa = [...porSentido.A];
  const pb = [...porSentido.B];
  if (pa.length && pb.length && (pa.length > 1 || pb.length > 1
      || pa[0] !== pb[0])) {
    hallazgos.push({ gravedad: 'critico',
      titulo: 'Los dos sentidos están medidos con pulsos distintos',
      detalle: `A→B: ${pa.map(pulsoTexto).join(', ')} · `
        + `B→A: ${pb.map(pulsoTexto).join(', ')}.`,
      accion: 'El pliego exige configuración idéntica en ambos extremos. Con pulsos '
        + 'distintos el promedio bidireccional no es comparable: hay que repetir '
        + 'el sentido mal configurado.' });
  }

  // bobina de lanzamiento y de terminación
  const sinLanzamiento = mediciones.filter((m) => {
    const primero = [...m.eventos].sort((a, b) => a.posicion_m - b.posicion_m)[0];
    return primero && primero.posicion_m < bobina;
  });
  if (sinLanzamiento.length)
    hallazgos.push({ gravedad: 'critico',
      titulo: `Sin bobina de lanzamiento en ${sinLanzamiento.length} medición(es)`,
      detalle: 'El primer evento aparece en la progresiva 0, así que el OTDR se '
        + 'conectó directo a la fibra bajo prueba.',
      accion: 'El pliego pide una bobina de lanzamiento de 1 km y otra de '
        + 'terminación. Sin ellas, el primer y el último empalme quedan en la zona '
        + 'muerta del equipo y no se miden. Agregar las bobinas y repetir.' });

  const cruzadas = pelosConVentanasCruzadas(mediciones);
  if (cruzadas.length)
    hallazgos.push({ gravedad: 'critico',
      titulo: `${cruzadas.length} pelo(s) con la ida y la vuelta en ventanas distintas`,
      detalle: cruzadas.slice(0, 8).map((c) => `pelo ${c.pelo}: ${c.motivo}`).join('; ')
        + (cruzadas.length > 8 ? ' y otros.' : '.'),
      accion: 'La fibra atenúa distinto en cada ventana, así que el promedio '
        + 'bidireccional de esos pelos no es comparable. Hay que remedir el sentido '
        + 'que falta en la misma ventana que el otro.' });

  // longitudes de onda mezcladas o faltantes
  const ondas = [...new Set(mediciones.map(ondaNominal))];
  if (ondas.length === 1)
    hallazgos.push({ gravedad: 'aviso',
      titulo: `Se midió solo a ${ondas[0]} nm`,
      detalle: 'No hay mediciones en la otra ventana.',
      accion: 'Con 1310 y 1550 se distingue una macrocurvatura de un empalme: la '
        + 'curvatura pierde bastante más en 1550. Medir las dos ventanas.' });

  // índice de refracción dispar
  const iores = [...new Set(mediciones.map((m) => m.ior).filter(Boolean)
    .map((v) => v.toFixed(5)))];
  if (iores.length > 1)
    hallazgos.push({ gravedad: 'aviso', titulo: 'Índice de refracción distinto',
      detalle: `Se usaron ${iores.join(' y ')}.`,
      accion: 'Con IOR distinto las progresivas no coinciden entre mediciones. '
        + 'Unificarlo antes de comparar.' });

  return hallazgos;
}

// --------------------------------------------------- infraestructura
const TIPOS = {
  botella: { etiqueta: 'Botella de empalme', color: 'FF2E7D32', claro: 'FFE8F5E9' },
  reserva: { etiqueta: 'Cruz de ganancia', color: 'FF1F4E79', claro: 'FFDCE6F1' },
  suspension: { etiqueta: 'Suspensión', color: 'FF7030A0', claro: 'FFEADFF2' },
  retencion: { etiqueta: 'Retención', color: 'FFB26A00', claro: 'FFFDF0D5' },
  cruce: { etiqueta: 'Cruce de calle', color: 'FF31859C', claro: 'FFDDEEF2' },
  otro: { etiqueta: 'Otro', color: 'FF808080', claro: 'FFEDEDED' },
};

const SINONIMOS = {
  botella: 'botella', empalme: 'botella', caja: 'botella', manga: 'botella',
  reserva: 'reserva', cruz: 'reserva', ganancia: 'reserva', rulo: 'reserva',
  suspension: 'suspension', suspensión: 'suspension', herraje: 'suspension',
  retencion: 'retencion', retención: 'retencion',
  cruce: 'cruce', calle: 'cruce', ruta: 'cruce', puente: 'cruce',
};

/** Texto libre a lista de elementos: "botella, 4186, empalme troncal". */
function leerInfraestructura(texto) {
  return String(texto || '').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l, i) => {
      const c = l.split(',').map((x) => x.trim());
      const clave = (c[0] || '').toLowerCase().split(/\s+/)[0];
      const tipo = SINONIMOS[clave] || (TIPOS[clave] ? clave : 'otro');
      const prog = parseFloat(String(c[1] || '').replace(',', '.'));
      return { n: i + 1, tipo, progresiva_m: prog,
               obs: c.slice(2).join(', ') || (tipo === 'otro' ? c[0] : '') };
    })
    .filter((e) => Number.isFinite(e.progresiva_m))
    .sort((a, b) => a.progresiva_m - b.progresiva_m);
}

/**
 * Botellas que deberían existir según el largo de bobina, para avisar cuando
 * faltan empalmes declarados o detectados.
 */
function botellasEsperadas(longitud, largoBobina = 4000) {
  return Math.max(0, Math.ceil(longitud / largoBobina) - 1);
}

// --------------------------------------------------------- diagnóstico
const cerca = (elementos, prog, tolerancia) => {
  let mejor = null;
  for (const e of elementos) {
    const d = Math.abs(e.progresiva_m - prog);
    if (d <= tolerancia && (!mejor || d < Math.abs(mejor.progresiva_m - prog)))
      mejor = e;
  }
  return mejor;
};

/**
 * Arma la orden de trabajo de cada evento que supera el umbral elegido.
 *
 * lecturas: (fibra, empalme, sentido) -> { perdida, progresiva }
 * porOnda:  (fibra, empalme, onda) -> peor pérdida medida en esa ventana
 */
function diagnosticar(empalmes, valores, mediciones, cfg, opciones = {}) {
  const infra = opciones.infraestructura || [];
  const umbral = opciones.umbral ?? cfg.parametros.umbralEmpalmeDb;
  const tolerancia = opciones.tolerancia ?? 100;
  const longitud = opciones.longitud || 0;
  const porOnda = opciones.porOnda || new Map();
  const medidos = [...new Set(mediciones.map((m) => m.numero).filter((n) => n != null))];

  const ordenes = [];
  for (const emp of empalmes) {
    const lecturas = [];
    let reflectivo = false;
    for (const f of medidos) {
      for (const sen of ['A', 'B']) {
        const v = valores.get(`${f}|${emp.n}|${sen}`);
        if (!v || v.perdida == null) continue;
        lecturas.push({ fibra: f, sentido: sen, perdida: v.perdida,
                        reflectancia: v.reflectancia });
        if (v.reflectancia) reflectivo = true;
      }
    }
    // Igual que la planilla de empalme: se evalúa el At Prom de cada pelo.
    // Si falta un sentido (el OTDR no tomó evento ahí) se completa con 0 y se
    // promedia igual.
    const porFibra = new Map();
    for (const l of lecturas) {
      if (!porFibra.has(l.fibra)) porFibra.set(l.fibra, { A: null, B: null });
      porFibra.get(l.fibra)[l.sentido] = l.perdida;
    }
    const promedios = [...porFibra.entries()].map(([fibra, x]) => ({
      fibra,
      perdida: ((x.A ?? 0) + (x.B ?? 0)) / 2,
      sentido: x.A != null && x.B != null ? 'prom' : (x.A != null ? 'A' : 'B'),
    }));
    const fuera = promedios.filter((l) => l.perdida >= umbral);
    if (!fuera.length) continue;

    const pelos = [...new Set(fuera.map((l) => l.fibra))].sort((a, b) => a - b);
    const peor = fuera.reduce((a, b) => (b.perdida > a.perdida ? b : a));
    const elemento = cerca(infra, emp.prog_a, tolerancia);
    const proporcion = pelos.length / Math.max(1, medidos.length);

    // 1310 contra 1550: la macrocurvatura castiga mucho más la ventana larga
    let delta = null;
    for (const f of pelos) {
      const a = porOnda.get(`${f}|${emp.n}|1550`);
      const b = porOnda.get(`${f}|${emp.n}|1310`);
      if (a != null && b != null) {
        const d = a - b;
        if (delta == null || d > delta) delta = d;
      }
    }

    // Los empalmes viven en botellas: si el evento no cae sobre una botella
    // declarada, es daño del tendido y no hay nada que refusionar ahí.
    const botellas = infra.filter((e) => e.tipo === 'botella'
      || e.tipo === 'reserva');
    const sobreBotella = elemento
      && (elemento.tipo === 'botella' || elemento.tipo === 'reserva');
    const fueraDeBotella = botellas.length ? !sobreBotella : null;

    // --------------------------------------------- diagnóstico y acción
    let diagnostico;
    let accion;
    const donde = elemento
      ? `${TIPOS[elemento.tipo].etiqueta.toLowerCase()} de la progresiva `
        + `${Math.round(elemento.progresiva_m).toLocaleString('es-AR')} m`
        + (elemento.obs ? ` (${elemento.obs})` : '')
      : null;

    if (delta != null && delta >= 0.3) {
      diagnostico = `Macrocurvatura: pierde ${delta.toFixed(2)} dB más en 1550 que `
        + 'en 1310.';
      accion = donde
        ? `Ir a la ${donde}. Revisar radio de curvatura, aplastamiento del cable y `
          + 'ataduras. No abrir la botella hasta descartar esto.'
        : 'Punto del tendido sin elemento declarado cerca. Recorrer el vano: rama '
          + 'apoyada, cable aplastado, atadura sobreapretada o grampa mal puesta.';
    } else if (delta != null && delta < 0.15 && proporcion < 0.25) {
      diagnostico = 'Pérdida pareja en las dos ventanas y en pocos pelos: empalme '
        + 'mal fusionado o fibra maltratada en la bandeja.';
      accion = donde
        ? `Abrir la ${donde} y refusionar los pelos ${pelos.join(', ')}.`
        : (fueraDeBotella
          ? `Recorrer la traza en esa progresiva: no hay botella ahí, así que el `
            + `daño está en el tendido y afecta a los pelos ${pelos.join(', ')}.`
          : `Empalme sin botella declarada cerca. Ubicarla y refusionar los pelos `
            + `${pelos.join(', ')}.`);
    } else if (reflectivo) {
      diagnostico = 'Evento reflectivo: conector, fisura o rotura.';
      accion = donde
        ? `Ir a la ${donde}: limpiar y revisar conectores, o buscar fisura.`
        : 'Revisar conectores del ODF y empalmes mecánicos en ese punto.';
    } else if (proporcion >= 0.6) {
      diagnostico = `Afecta a ${pelos.length} de ${medidos.length} pelos: el problema `
        + 'es del cable, no de la fibra.';
      accion = donde
        ? `Ir a la ${donde}. Si es una botella, revisar montaje y sujeción; si es `
          + 'una cruz de ganancia o un herraje, revisar que el cable no esté '
          + 'estrangulado ni con radio menor al admitido.'
        : 'Punto del tendido sin elemento declarado. Recorrer el vano buscando rama '
          + 'caída, cable tensionado, grampa sobreapretada o daño de terceros.';
    } else if (pelos.length === 1) {
      diagnostico = 'Un solo pelo afectado: problema propio de esa fibra.';
      accion = donde
        ? `Abrir la ${donde} y refusionar el pelo ${pelos[0]}. Revisar cómo quedó `
          + 'alojado en la bandeja.'
        : (fueraDeBotella
          ? `Recorrer la traza en esa progresiva: no hay botella ahí, así que el `
            + `pelo ${pelos[0]} está dañado en el tendido.`
          : `Ubicar el empalme más cercano y refusionar el pelo ${pelos[0]}.`);
    } else {
      diagnostico = `Afecta a ${pelos.length} de ${medidos.length} pelos.`;
      accion = donde
        ? `Ir a la ${donde} y revisar los pelos ${pelos.join(', ')}.`
        : 'Sin elemento declarado cerca: remedir el tramo con pulso corto para '
          + 'ubicar el punto con precisión antes de mandar cuadrilla.';
    }

    // avisos que se suman al diagnóstico
    const notas = [];
    if (!elemento && infra.length)
      notas.push(`Sin elemento declarado a menos de ${tolerancia} m.`);
    if (delta == null && porOnda.size)
      notas.push('Sin medición en las dos ventanas para este punto.');
    const unSentido = new Set(fuera.map((l) => l.sentido));
    if (unSentido.size === 1 && !unSentido.has('prom'))
      notas.push(`Solo se ve desde ${unSentido.has('A') ? 'A→B' : 'B→A'}: confirmar `
        + 'midiendo desde el otro extremo.');
    if (longitud && (emp.prog_a < 1000 || longitud - emp.prog_a < 1000))
      notas.push('Está en el primer o último kilómetro: puede ser el conector del '
        + 'ODF o el pigtail.');

    ordenes.push({
      fueraDeBotella,
      alerta: fueraDeBotella
        ? 'POSIBLE EVENTO FUERA DE BOTELLA — verificar la traza en la progresiva '
          + `${Math.round(emp.prog_a).toLocaleString('es-AR')} m desde A `
          + `(${Math.round(emp.prog_b).toLocaleString('es-AR')} m desde B). `
          + `La botella declarada más cercana está a `
          + `${botellas.length ? Math.round(Math.min(...botellas
              .map((b) => Math.abs(b.progresiva_m - emp.prog_a))))
              .toLocaleString('es-AR') : '—'} m.`
        : (fueraDeBotella === null && proporcion < 0.6
          ? 'POSIBLE EVENTO FUERA DE BOTELLA — no se declaró infraestructura, así '
            + 'que no se puede confirmar. Verificar la traza en la progresiva '
            + `${Math.round(emp.prog_a).toLocaleString('es-AR')} m desde A.`
          : null),
      n: emp.n,
      prog_a: emp.prog_a,
      prog_b: emp.prog_b,
      pelos,
      medidos: medidos.length,
      peor: peor.perdida,
      peorPelo: peor.fibra,
      sentido: peor.sentido,
      elemento,
      distancia: elemento ? emp.prog_a - elemento.progresiva_m : null,
      delta,
      reflectivo,
      diagnostico,
      accion,
      notas: notas.join(' '),
      prioridad: peor.perdida >= umbral * 2 || proporcion >= 0.6 ? 'ALTA'
        : (peor.perdida >= umbral * 1.4 ? 'MEDIA' : 'BAJA'),
    });
  }
  ordenes.sort((a, b) => (b.prioridad === 'ALTA') - (a.prioridad === 'ALTA')
    || b.peor - a.peor);
  return ordenes;
}

/**
 * Todas las lecturas de cada punto, pelo por pelo.
 *
 * Las ordenes de trabajo dicen que pelos estan fuera de norma, pero la cuadrilla
 * va una sola vez al punto: necesita ver TODOS los pelos que tienen evento ahi,
 * incluso los que estan al limite, para tocarlos en la misma visita.
 */
function lecturasPorPunto(ordenes, valores, medidos, cfg, opciones = {}) {
  const umbral = opciones.umbral ?? cfg.parametros.umbralEmpalmeDb;
  const desde = opciones.desde ?? 0.10;          // corte para listar el pelo
  const limite = umbral * 0.7;                   // "al limite" desde aca

  const porTubo = cfg.estructura.fibrasPorTubo || 12;
  const tubo = (f) => Math.ceil(f / porTubo);

  return ordenes.map((o) => {
    const filas = [];
    let bajoCorte = 0;
    let sumaBajo = 0;
    for (const f of medidos) {
      const a = valores.get(`${f}|${o.n}|A`);
      const b = valores.get(`${f}|${o.n}|B`);
      const va = a && a.perdida != null ? a.perdida : null;
      const vb = b && b.perdida != null ? b.perdida : null;
      if (va == null && vb == null) continue;    // este pelo no ve el evento
      // sentido faltante = 0, como en la planilla de empalme
      const prom = ((va ?? 0) + (vb ?? 0)) / 2;
      const pico = Math.max(va ?? -99, vb ?? -99);
      if (pico < desde) {
        bajoCorte += 1;
        sumaBajo += prom;
        continue;
      }
      filas.push({
        pelo: f,
        tubo: tubo(f),
        a: va,
        b: vb,
        prom,
        unSentido: (va == null) !== (vb == null),
        estado: prom >= umbral ? 'FUERA' : (prom >= limite ? 'AL LÍMITE' : 'normal'),
      });
    }
    filas.sort((x, y) => y.prom - x.prom);
    return {
      orden: o,
      filas,
      bajoCorte,
      promedioBajo: bajoCorte ? sumaBajo / bajoCorte : null,
      desde,
    };
  });
}

/**
 * Cruza los puntos de ahora con los de la planilla anterior.
 * Un punto se reconoce por su progresiva: despues de reparar puede correrse unos
 * metros, asi que se admite una tolerancia.
 */
function cruzarConAnterior(puntos, anterior, tolerancia = 150) {
  if (!anterior || !anterior.length) return 0;
  let cruzados = 0;
  for (const p of puntos) {
    const prog = p.orden.prog_a;
    const cerca = anterior.filter((x) => Math.abs(x.prog_a - prog) <= tolerancia);
    if (!cerca.length) continue;
    for (const fila of p.filas) {
      const previo = cerca.find((x) => x.pelo === fila.pelo);
      if (!previo || previo.prom == null) continue;
      fila.promAntes = previo.prom;
      fila.aAntes = previo.a;
      fila.bAntes = previo.b;
      cruzados += 1;
    }
  }
  return cruzados;
}

/**
 * Puntos que estaban en la campaña anterior y ya no son orden de trabajo.
 *
 * Si se repara un punto, deja de superar el umbral y desapareceria de la
 * planilla: justo el resultado que hay que poder ver. Estos vuelven como puntos
 * VERIFICADO, con la lectura de ahora al lado de la de antes.
 */
function puntosVerificados(puntos, empalmes, valores, medidos, cfg,
                                  anterior, opciones = {}) {
  if (!anterior || !anterior.length) return [];
  const tol = opciones.tolerancia ?? 150;
  const umbral = opciones.umbral ?? cfg.parametros.umbralEmpalmeDb;
  const limite = umbral * 0.7;
  const porTubo = cfg.estructura.fibrasPorTubo || 12;
  const infra = opciones.infraestructura || [];
  const longitud = opciones.longitud || 0;

  const progs = [...new Set(anterior.map((x) => Math.round(x.prog_a)))]
    .sort((a, b) => a - b);
  const salida = [];
  for (const prog of progs) {
    // ya cubierto por un punto de esta campaña
    if (puntos.some((p) => Math.abs(p.orden.prog_a - prog) <= tol)) continue;
    const previas = anterior.filter((x) => Math.abs(x.prog_a - prog) <= tol);
    if (!previas.length) continue;
    const emp = empalmes.find((e) => Math.abs(e.prog_a - prog) <= tol);

    const filas = [];
    let peor = 0;
    for (const previo of previas.sort((a, b) => (b.prom || 0) - (a.prom || 0))) {
      const f = previo.pelo;
      if (!medidos.includes(f)) continue;
      let va = null;
      let vb = null;
      if (emp) {
        const a = valores.get(`${f}|${emp.n}|A`);
        const b = valores.get(`${f}|${emp.n}|B`);
        va = a && a.perdida != null ? a.perdida : null;
        vb = b && b.perdida != null ? b.perdida : null;
      }
      const hay = va != null || vb != null;
      const prom = hay
        ? ((va ?? 0) + (vb ?? 0)) / 2
        : null;
      const pico = hay ? Math.max(va ?? -99, vb ?? -99) : null;
      if (prom != null && prom > peor) peor = prom;
      filas.push({
        pelo: f,
        tubo: Math.ceil(f / porTubo),
        a: va,
        b: vb,
        prom,
        unSentido: hay && ((va == null) !== (vb == null)),
        estado: !hay ? 'SIN EVENTO'
          : (prom >= umbral ? 'FUERA' : (prom >= limite ? 'AL LÍMITE' : 'normal')),
        promAntes: previo.prom,
        aAntes: previo.a,
        bAntes: previo.b,
      });
    }
    if (!filas.length) continue;

    const elemento = cerca(infra, prog, opciones.toleranciaObra ?? tol);
    const sinEvento = filas.every((x) => x.estado === 'SIN EVENTO');
    const fuera = filas.filter((x) => x.estado === 'FUERA').length;
    const alLimite = filas.filter((x) => x.estado === 'AL LÍMITE').length;
    salida.push({
      orden: {
        n: previas[0].punto != null ? previas[0].punto : 0,
        prog_a: prog,
        prog_b: Math.max(0, longitud - prog),
        pelos: filas.filter((x) => x.estado === 'FUERA').map((x) => x.pelo),
        medidos: medidos.length,
        peor,
        prioridad: 'VERIFICADO',
        elemento,
        distancia: elemento ? prog - elemento.progresiva_m : null,
        diagnostico: sinEvento
          ? 'El OTDR ya no detecta evento en esta progresiva.'
          : (fuera
            ? `Quedan ${fuera} pelo(s) por encima del umbral`
              + (alLimite ? ` y ${alLimite} al límite.` : '.')
            : (alLimite
              ? `Ningún pelo supera el umbral. Quedan ${alLimite} al límite.`
              : 'Todos los pelos quedaron por debajo del umbral.')),
        accion: sinEvento
          ? 'Reparación confirmada: no hay nada más que hacer en este punto.'
          : (fuera
            ? 'Volver al punto: la reparación no alcanzó en esos pelos.'
            : (alLimite
              ? 'Reparación confirmada. Los pelos al límite conviene mirarlos en '
                + 'la próxima campaña.'
              : 'Reparación confirmada. Solo queda dejar registro en la planilla '
                + 'final.')),
        notas: 'Punto de la campaña anterior, se incluye para verificar la reparación.',
        verificado: true,
      },
      filas,
      bajoCorte: 0,
      promedioBajo: null,
      desde: opciones.desde ?? 0.10,
    });
  }
  return salida;
}

/**
 * Puntos de corte: los pelos que no llegan de punta a punta, agrupados por la
 * progresiva donde cortan.
 *
 * Un pelo cortado esta fuera de servicio, asi que es lo primero de la lista.
 * La progresiva del corte es donde el OTDR lee el fin de fibra: es un dato
 * firme incluso con un solo sentido medido.
 */
function puntosDeCorte(cortes, cfg, opciones = {}) {
  if (!cortes || !cortes.length) return [];
  const longitud = opciones.longitud || 0;
  const tol = opciones.tolerancia ?? 150;
  const infra = opciones.infraestructura || [];
  const medidos = opciones.medidos || [];
  const porTubo = cfg.estructura.fibrasPorTubo || 12;

  // un corte puede aportar una o dos posiciones (cuando hay mas de uno)
  const posiciones = [];
  for (const c of cortes) {
    if (c.tipo === 'revisar') {
      posiciones.push({ pelo: c.pelo, prog: null, tipo: c.tipo, texto: c.texto });
      continue;
    }
    if (c.desdeA != null && c.desdeB != null && c.tipo === 'varios') {
      posiciones.push({ pelo: c.pelo, prog: c.desdeA, tipo: 'varios',
                        faltante: c.faltante, lado: 'A' });
      posiciones.push({ pelo: c.pelo, prog: longitud - c.desdeB, tipo: 'varios',
                        faltante: c.faltante, lado: 'B' });
      continue;
    }
    const prog = c.desdeA != null ? c.desdeA
      : (c.desdeB != null ? longitud - c.desdeB : null);
    posiciones.push({ pelo: c.pelo, prog, tipo: c.tipo,
                      unSentido: c.tipo === 'un-sentido' });
  }

  // se agrupan los que cortan en el mismo lugar: es el mismo corte
  const conProg = posiciones.filter((x) => x.prog != null)
    .sort((a, b) => a.prog - b.prog);
  const grupos = [];
  for (const x of conProg) {
    const g = grupos[grupos.length - 1];
    if (g && Math.abs(x.prog - g.centro) <= tol) {
      g.items.push(x);
      g.centro = g.items.reduce((acc, y) => acc + y.prog, 0) / g.items.length;
    } else {
      grupos.push({ centro: x.prog, items: [x] });
    }
  }
  const sinProg = posiciones.filter((x) => x.prog == null);

  const salida = [];
  for (const [i, g] of grupos.entries()) {
    const prog = Math.round(g.centro);
    const pelos = [...new Set(g.items.map((x) => x.pelo))].sort((a, b) => a - b);
    const elemento = cerca(infra, prog, tol);
    const proporcion = medidos.length ? pelos.length / medidos.length : 0;
    const hayVarios = g.items.some((x) => x.tipo === 'varios');
    const soloUno = g.items.every((x) => x.unSentido);

    let diagnostico;
    if (proporcion >= 0.8)
      diagnostico = `Cable cortado: ${pelos.length} de ${medidos.length} pelos `
        + 'cortan en el mismo punto.';
    else if (pelos.length > 1)
      diagnostico = `${pelos.length} pelos cortan en el mismo punto `
        + `(${pelos.join(', ')}). El resto del cable pasa.`;
    else
      diagnostico = `El pelo ${pelos[0]} corta acá. El resto del cable pasa, `
        + 'así que no es un corte de cable.';

    let accion;
    if (elemento && (elemento.tipo === 'botella' || elemento.tipo === 'reserva')) {
      accion = `El corte cae sobre la ${(TIPOS[elemento.tipo] || TIPOS.otro)
        .etiqueta.toLowerCase()} de la progresiva `
        + `${Math.round(elemento.progresiva_m).toLocaleString('es-AR')} m`
        + (elemento.obs ? ` (${elemento.obs})` : '')
        + `. Abrir la ${(TIPOS[elemento.tipo] || TIPOS.otro).etiqueta.toLowerCase()}`
        + ` y FUSIONAR el pelo ${pelos.join(', ')} para dar continuidad.`;
    } else if (proporcion >= 0.8) {
      accion = 'Ir a la progresiva del corte, empalmar el cable y FUSIONAR todos '
        + 'los pelos para dar continuidad. Dejar reserva y botella nueva.';
    } else {
      accion = `Ir a la progresiva ${prog.toLocaleString('es-AR')} m desde A, `
        + `ubicar el corte y FUSIONAR el pelo ${pelos.join(', ')} para dar `
        + 'continuidad.'
        + (elemento ? ` Hay una ${(TIPOS[elemento.tipo] || TIPOS.otro)
            .etiqueta.toLowerCase()} a ${Math.abs(Math.round(
            prog - elemento.progresiva_m))} m: revisar ahí primero.` : '');
    }

    const notas = [];
    if (soloUno)
      notas.push('Medido en un solo sentido: la progresiva del corte es firme, '
        + 'pero conviene medir desde el otro extremo para descartar un segundo corte.');
    if (hayVarios) {
      const f = g.items.find((x) => x.faltante);
      notas.push('Hay más de un corte en estos pelos: '
        + `${Math.round(f ? f.faltante : 0).toLocaleString('es-AR')} m del tramo no `
        + 'los ve ningún sentido. Reparar este corte y volver a medir.');
    }

    salida.push({
      orden: {
        n: `C${i + 1}`,
        prog_a: prog,
        prog_b: Math.max(0, longitud - prog),
        pelos,
        medidos: medidos.length,
        peor: 0,
        prioridad: 'CORTE',
        elemento,
        distancia: elemento ? prog - elemento.progresiva_m : null,
        diagnostico,
        accion,
        notas: notas.join(' '),
        esCorte: true,
      },
      filas: pelos.map((f) => {
        const propio = g.items.filter((x) => x.pelo === f)
          .sort((a, b) => Math.abs(a.prog - prog) - Math.abs(b.prog - prog))[0];
        const pc = propio ? Math.round(propio.prog) : prog;
        return {
          pelo: f,
          tubo: Math.ceil(f / porTubo),
          a: pc,                                  // corta a X m desde A
          b: Math.max(0, Math.round(longitud - pc)),
          prom: null,
          unSentido: false,
          estado: 'CORTADO',
          progCorte: pc,
        };
      }),
      bajoCorte: 0,
      promedioBajo: null,
      desde: opciones.desde ?? 0.10,
    });
  }

  // los que no se pudieron ubicar igual tienen que figurar
  if (sinProg.length) {
    const pelos = [...new Set(sinProg.map((x) => x.pelo))].sort((a, b) => a - b);
    salida.push({
      orden: {
        n: 'C?',
        prog_a: 0,
        prog_b: 0,
        pelos,
        medidos: medidos.length,
        peor: 0,
        prioridad: 'CORTE',
        elemento: null,
        distancia: null,
        diagnostico: `${pelos.length} pelo(s) no llegan de punta a punta y no se `
          + 'pudo ubicar el corte.',
        accion: 'Las longitudes de los dos sentidos no cierran con la del tramo: '
          + 'revisar el índice de refracción del equipo y que las mediciones sean '
          + 'del mismo tramo, y volver a medir.',
        notas: sinProg.map((x) => x.texto).filter(Boolean).slice(0, 3).join(' '),
        esCorte: true,
      },
      filas: pelos.map((f) => ({ pelo: f, tubo: Math.ceil(f / porTubo),
        a: null, b: null, prom: null, unSentido: false, estado: 'CORTADO' })),
      bajoCorte: 0,
      promedioBajo: null,
      desde: opciones.desde ?? 0.10,
    });
  }
  return salida;
}
/*
 * Solapa REPARACIONES: de un vistazo, dónde está el problema y qué hacer.
 *
 *   1. Bloque de control de configuración, lo crítico en rojo.
 *   2. Franja de la traza kilómetro por kilómetro, pintada por severidad,
 *      con la infraestructura declarada debajo y su referencia de colores.
 *   3. Órdenes de trabajo: dónde ir, qué revisar, con qué prioridad.
 */

const AZULRep = 'FF1F4E79';
const ROJORep = 'FFC00000';
const ROSARep = 'FFFFC7CE';
const AMBARRep = 'FFFFEB9C';
const VERDERep = 'FFE8F5E9';
const GRISRep = 'FFF2F2F2';

const finoRep = { style: 'thin', color: { argb: 'FF9DB2C6' } };
const BORDERep = { top: finoRep, left: finoRep, bottom: finoRep, right: finoRep };
const CENTRORep = { horizontal: 'center', vertical: 'middle' };
const IZQRep = { horizontal: 'left', vertical: 'middle' };
const AJUSTERep = { horizontal: 'left', vertical: 'top', wrapText: true };

const rellenoRep = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const milesRep = (n) => Math.round(n).toLocaleString('es-AR');

function celRep(ws, f, c, v, o = {}) {
  const x = ws.getCell(f, c);
  if (v !== undefined) x.value = v;
  x.font = { name: 'Arial', size: o.size || 9, bold: !!o.bold, italic: !!o.italic,
             color: { argb: o.color || 'FF1C2430' } };
  x.alignment = o.alin || CENTRORep;
  if (o.fill) x.fill = rellenoRep(o.fill);
  if (o.borde !== false) x.border = BORDERep;
  if (o.formato) x.numFmt = o.formato;
  return x;
}

function bandaRep(ws, fila, c1, c2, texto, fondo = AZULRep, size = 11) {
  for (let c = c1; c <= c2; c++) ws.getCell(fila, c).fill = rellenoRep(fondo);
  const x = ws.getCell(fila, c1);
  x.value = texto;
  x.font = { name: 'Arial', size, bold: true, color: { argb: 'FFFFFFFF' } };
  x.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.mergeCells(fila, c1, fila, c2);
  ws.getRow(fila).height = size === 11 ? 24 : 20;
}

function recuadroBloque(ws, f1, c1, f2, c2) {
  const grueso = { style: 'medium', color: { argb: 'FF1F4E79' } };
  for (let f = f1; f <= f2; f++) {
    for (let c = c1; c <= c2; c++) {
      const cel = ws.getCell(f, c);
      const b = { ...(cel.border || {}) };
      if (f === f1) b.top = grueso;
      if (f === f2) b.bottom = grueso;
      if (c === c1) b.left = grueso;
      if (c === c2) b.right = grueso;
      cel.border = b;
    }
  }
}

function hojaReparaciones(wb, datos) {
  const { cfg, longitud, hallazgos, infraestructura, ordenes, umbral,
          medidos, empalmes, cortes = [], equipo, pulsoNs, onda, confirmados,
          hojaDePelo } = datos;
  const ws = wb.addWorksheet('REPARACIONES');
  ws.views = [{ showGridLines: false, state: 'normal' }];

  const kmTotal = Math.ceil(longitud / 1000);
  const COL_MAPA = Math.min(Math.max(kmTotal, 20), 130);   // una celda por km
  const ULTIMA = Math.max(COL_MAPA + 1, 14);

  ws.getColumn(1).width = 3;
  for (let c = 2; c <= ULTIMA; c++) ws.getColumn(c).width = 3.2;

  bandaRep(ws, 2, 2, ULTIMA, `PLANILLA DE REPARACIONES  ·  ${cfg.registro.tramo || ''}`, AZULRep, 13);
  celRep(ws, 3, 2, `Tramo de ${(longitud / 1000).toFixed(3)} km  ·  ${medidos.length} pelos `
    + `medidos  ·  criterio ${umbral.toFixed(2).replace('.', ',')} dB  ·  `
    + `${ordenes.length} punto(s) a revisar`,
    { italic: true, alin: IZQRep, borde: false, color: 'FF5A6472', size: 9 });
  ws.mergeCells(3, 2, 3, ULTIMA);

  // -------------------------------------------------------- datos del tramo
  let f = 5;
  bandaRep(ws, f, 2, ULTIMA, 'DATOS DEL TRAMO', AZULRep, 10);
  f += 1;
  const pulsoTxt = pulsoNs
    ? (pulsoNs >= 1000 ? `${pulsoNs / 1000} µs` : `${pulsoNs} ns`) : '';
  const campos = [
    ['Tramo', cfg.registro.tramo || ''],
    ['Nodo origen (A)', cfg.registro.nodoA || ''],
    ['Nodo destino (B)', cfg.registro.nodoB || ''],
    ['LONGITUD ÓPTICA TOTAL DEL TRAMO',
     `${milesRep(longitud)} m   (${(longitud / 1000).toFixed(3)} km)`],
    ['Cable', cfg.registro.cable || ''],
    ['Contratista', cfg.registro.contratista || ''],
    ['Pelos medidos', `${medidos.length}`],
    ['Empalmes confirmados', `${confirmados != null ? confirmados : empalmes.length}`],
    ['Umbral de reparación', `${umbral.toFixed(2).replace('.', ',')} dB`],
    ['Equipo', equipo || ''],
    ['Pulso · longitud de onda',
     [pulsoTxt, onda ? `${onda} nm` : ''].filter(Boolean).join('  ·  ')],
    ['Fecha de este informe', new Date().toLocaleDateString('es-AR')],
  ];
  // dos columnas de pares etiqueta/valor para que no ocupe media hoja
  const mitad = Math.ceil(campos.length / 2);
  const anchoEtq = 10;
  const anchoVal = 16;
  for (let i = 0; i < mitad; i++) {
    const fila = f + i;
    [[0, 2], [mitad, 2 + anchoEtq + anchoVal + 1]].forEach(([desplaz, col]) => {
      const par = campos[i + desplaz];
      if (!par) return;
      const destacado = par[0].startsWith('LONGITUD');
      celRep(ws, fila, col, par[0], { bold: true, fill: GRISRep, alin: IZQRep,
        size: destacado ? 9 : 8 });
      ws.mergeCells(fila, col, fila, col + anchoEtq - 1);
      celRep(ws, fila, col + anchoEtq, par[1],
        { alin: IZQRep, bold: destacado, size: destacado ? 10 : 9,
          color: destacado ? AZULRep : undefined });
      ws.mergeCells(fila, col + anchoEtq, fila, col + anchoEtq + anchoVal - 1);
    });
    ws.getRow(fila).height = 15;
  }
  recuadroBloque(ws, f, 2, f + mitad - 1, 2 + anchoEtq + anchoVal * 2 + 0);
  f += mitad + 1;

  // ------------------------------------------------- control de configuración
  bandaRep(ws, f, 2, ULTIMA, 'CONTROL DE CONFIGURACIÓN DE LAS MEDICIONES', AZULRep, 10);
  f += 1;
  if (!hallazgos.length) {
    celRep(ws, f, 2, 'Sin observaciones: pulso, duración, bobinas y longitudes de onda '
      + 'coinciden con lo que pide el pliego.', { fill: VERDERep, alin: IZQRep });
    ws.mergeCells(f, 2, f, ULTIMA);
    ws.getRow(f).height = 18;
    f += 2;
  } else {
    for (const h of hallazgos) {
      const critico = h.gravedad === 'critico';
      celRep(ws, f, 2, (critico ? 'CRÍTICO · ' : 'AVISO · ') + h.titulo,
        { bold: true, fill: critico ? ROJORep : AMBARRep,
          color: critico ? 'FFFFFFFF' : 'FF7A4E00', alin: IZQRep });
      ws.mergeCells(f, 2, f, ULTIMA);
      ws.getRow(f).height = 17;
      f += 1;
      celRep(ws, f, 2, `${h.detalle}   →   ${h.accion}`,
        { alin: AJUSTERep, fill: critico ? ROSARep : 'FFFDF6E3', size: 8 });
      ws.mergeCells(f, 2, f, ULTIMA);
      ws.getRow(f).height = 30;
      f += 1;
    }
    f += 1;
  }

  // ------------------------------------------------------------- mapa de traza
  bandaRep(ws, f, 2, ULTIMA, 'MAPA DE LA TRAZA  ·  cada celda es un kilómetro', AZULRep, 10);
  f += 1;
  const filaEscala = f;
  const filaSev = f + 1;
  const filaInfra = f + 2;
  const filaKm = f + 3;

  celRep(ws, filaSev, 1, 'dB', { bold: true, size: 8, borde: false });
  celRep(ws, filaInfra, 1, 'Obra', { bold: true, size: 8, borde: false });

  // severidad de cada kilómetro
  const peorKm = new Array(kmTotal + 1).fill(0);
  const pelosKm = new Array(kmTotal + 1).fill(0);
  for (const o of ordenes) {
    const k = Math.min(kmTotal, Math.floor(o.prog_a / 1000));
    if (o.peor > peorKm[k]) peorKm[k] = o.peor;
    pelosKm[k] = Math.max(pelosKm[k], o.pelos.length);
  }
  const escala = COL_MAPA / Math.max(1, kmTotal);
  for (let k = 0; k < kmTotal; k++) {
    const c = 2 + Math.floor(k * escala);
    const v = peorKm[k];
    const color = v === 0 ? GRISRep
      : v >= umbral * 2 ? ROJORep
      : v >= umbral * 1.4 ? 'FFED7D31'
      : AMBARRep;
    const x = celRep(ws, filaSev, c, null, { fill: color });
    if (v) x.note = `km ${k} a ${k + 1}: peor lectura ${v.toFixed(3)} dB en `
      + `${pelosKm[k]} pelo(s).`;
  }
  ws.getRow(filaSev).height = 16;

  // infraestructura declarada
  for (const e of infraestructura) {
    const k = Math.floor(e.progresiva_m / 1000);
    const c = 2 + Math.floor(k * escala);
    if (c > ULTIMA) continue;
    const t = TIPOS[e.tipo] || TIPOS.otro;
    const x = celRep(ws, filaInfra, c, null, { fill: t.color });
    x.note = `${t.etiqueta} · ${milesRep(e.progresiva_m)} m`
      + (e.obs ? `\n${e.obs}` : '');
  }
  ws.getRow(filaInfra).height = 14;

  // escala de kilómetros cada 10
  for (let k = 0; k <= kmTotal; k += 10) {
    const c = 2 + Math.floor(k * escala);
    if (c > ULTIMA) continue;
    celRep(ws, filaKm, c, k, { size: 7, color: 'FF808080', borde: false });
  }
  ws.getRow(filaKm).height = 12;
  f = filaKm + 2;

  // referencia de colores
  celRep(ws, f, 2, 'REFERENCIAS', { bold: true, size: 8, alin: IZQRep, borde: false });
  f += 1;
  const refs = [
    [ROJORep, `≥ ${(umbral * 2).toFixed(2).replace('.', ',')} dB`],
    ['FFED7D31', `≥ ${(umbral * 1.4).toFixed(2).replace('.', ',')} dB`],
    [AMBARRep, `≥ ${umbral.toFixed(2).replace('.', ',')} dB`],
    [GRISRep, 'sin eventos fuera de norma'],
    ...Object.entries(TIPOS).map(([, t]) => [t.color, t.etiqueta]),
  ];
  let c = 2;
  for (const [color, texto] of refs) {
    celRep(ws, f, c, null, { fill: color });
    celRep(ws, f, c + 1, texto, { size: 8, alin: IZQRep, borde: false });
    ws.mergeCells(f, c + 1, f, c + 5);
    c += 7;
    if (c + 6 > ULTIMA) { c = 2; f += 1; }
  }
  f += 3;

  // ---- pelos cortados: van antes de las órdenes porque están fuera de servicio
  if (cortes.length) {
    bandaRep(ws, f, 2, ULTIMA,
      'PELOS CORTADOS — PRIORIDAD: NO LLEGAN DE PUNTA A PUNTA', 'FFC00000', 10);
    f += 1;
    for (const c of cortes) {
      const ref = hojaDePelo ? hojaDePelo.get(c.pelo) : null;
      celRep(ws, f, 2, `Pelo ${c.pelo}`
        + (ref ? `\n${ref.n} · hoja ${ref.hoja}` : ''),
        { bold: true, fill: ROSARep, alin: AJUSTERep, size: 8 });
      ws.mergeCells(f, 2, f, 6);
      celRep(ws, f, 7, c.texto, { alin: AJUSTERep, fill: 'FFFDF0EF' });
      ws.mergeCells(f, 7, f, ULTIMA);
      ws.getRow(f).height = 26;
      f += 1;
    }
    f += 2;
  }

  // ------------------------------------------------------- órdenes de trabajo
  bandaRep(ws, f, 2, ULTIMA, 'ÓRDENES DE TRABAJO', AZULRep, 10);
  f += 1;
  const cols = [
    ['Prio.', 4], ['N°', 3], ['Hoja', 5], ['Prog. A (m)', 9], ['Prog. B (m)', 9],
    ['Pelos', 12], ['Peor (dB)', 7], ['Elemento más cercano', 20],
    ['Diagnóstico', 26], ['Qué hacer', 32],
  ];
  let c0 = 2;
  const anchos = [];
  for (const [titulo, ancho] of cols) {
    celRep(ws, f, c0, titulo, { bold: true, fill: AZULRep, color: 'FFFFFFFF' });
    ws.mergeCells(f, c0, f, c0 + ancho - 1);
    anchos.push([c0, ancho]);
    c0 += ancho;
  }
  const finTabla = c0 - 1;
  ws.getRow(f).height = 18;
  f += 1;

  if (!ordenes.length) {
    celRep(ws, f, 2, `Ningún evento supera ${umbral.toFixed(2).replace('.', ',')} dB. `
      + 'No hay reparaciones pendientes.', { fill: VERDERep, alin: IZQRep });
    ws.mergeCells(f, 2, f, finTabla);
    f += 1;
  }
  for (const o of ordenes) {
    const fondo = o.prioridad === 'ALTA' ? ROSARep
      : (o.prioridad === 'MEDIA' ? 'FFFDF6E3' : undefined);
    const valores = [
      o.prioridad,
      o.n,
      // en qué solapa PUNTOS A INTERVENIR está el detalle pelo por pelo
      o.hoja ? (o.hojas > 1 ? `${o.hoja} de ${o.hojas}` : 'única') : '—',
      milesRep(o.prog_a),
      milesRep(o.prog_b),
      o.pelos.length > 6 ? `${o.pelos.length} de ${o.medidos}`
        : o.pelos.join(', ') + ` (de ${o.medidos})`,
      Number(o.peor.toFixed(3)),
      o.elemento
        ? `${TIPOS[o.elemento.tipo].etiqueta} ${milesRep(o.elemento.progresiva_m)} m`
          + ` (${o.distancia >= 0 ? '+' : ''}${Math.round(o.distancia)} m)`
        : 'sin elemento cerca',
      o.diagnostico,
      (o.alerta ? '⚠ ' + o.alerta + '  ' : '')
        + o.accion + (o.notas ? ' ' + o.notas : ''),
    ];
    let celdaAccion = null;
    valores.forEach((v, i) => {
      const [ci, ancho] = anchos[i];
      const x = celRep(ws, f, ci, v, {
        fill: i === 0
          ? (o.prioridad === 'ALTA' ? ROJORep : o.prioridad === 'MEDIA' ? AMBARRep : GRISRep)
          : fondo,
        color: i === 0 && o.prioridad === 'ALTA' ? 'FFFFFFFF' : undefined,
        bold: i === 0 || i === 2 || i === 6,
        alin: i >= 7 ? AJUSTERep : CENTRORep,
        formato: i === 6 ? '0.000' : undefined,
        size: i === 2 ? 8 : undefined,
      });
      if (i === 7 && o.elemento && o.elemento.obs) x.note = o.elemento.obs;
      if (i === 9) celdaAccion = x;
      ws.mergeCells(f, ci, f, ci + ancho - 1);
    });
    // la alerta va resaltada dentro de la misma celda, sin robar una columna
    if (o.alerta && celdaAccion) {
      celdaAccion.value = { richText: [
        { font: { name: 'Arial', size: 9, bold: true, color: { argb: 'FF7A4E00' } },
          text: '⚠ ' + o.alerta + '  ' },
        { font: { name: 'Arial', size: 9, color: { argb: 'FF1C2430' } },
          text: o.accion + (o.notas ? ' ' + o.notas : '') },
      ] };
    }
    // alto adaptado al texto mas largo: diagnostico o que hacer
    const renglones = Math.max(
      Math.ceil(String(valores[8]).length / 100),
      Math.ceil(String(valores[9]).length / 150), 1);
    ws.getRow(f).height = Math.min(96, Math.max(34, renglones * 13 + 8));
    f += 1;
  }

  // ------------------------------------------------------------- pie de control
  f += 1;
  const esperadas = botellasEsperadas(longitud, cfg.largoBobina || 4000);
  const botellas = infraestructura.filter((e) => e.tipo === 'botella').length;
  const texto = infraestructura.length
    ? `Infraestructura declarada: ${infraestructura.length} elementos, `
      + `${botellas} botellas. Con bobinas de `
      + `${milesRep(cfg.largoBobina || 4000)} m se esperan al menos ${esperadas}.`
      + (botellas && botellas < esperadas
        ? ' Faltan botellas por declarar.' : '')
    : 'No se declaró infraestructura. Cargando botellas, cruces de ganancia, '
      + 'suspensiones, retenciones y cruces de calle, cada evento queda asociado '
      + 'al elemento más cercano y el diagnóstico es mucho más preciso.';
  celRep(ws, f, 2, texto, { size: 8, italic: true, alin: AJUSTERep,
    fill: infraestructura.length ? undefined : AMBARRep });
  ws.mergeCells(f, 2, f, finTabla);
  ws.getRow(f).height = 26;

  ws.pageSetup = {
    orientation: 'landscape', paperSize: 9, fitToPage: true,
    fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };
  return ws;
}
/*
 * Solapa PUNTOS A INTERVENIR.
 *
 * Un bloque por punto de la traza, con TODOS los pelos que tienen evento ahi,
 * para que la cuadrilla vaya una sola vez y toque todo lo que hay que tocar.
 * Si se cargo la planilla de reparaciones anterior, cada pelo trae el valor
 * previo y el resultado de la reparacion.
 */

const AZULp = 'FF1F4E79';
const CELESTEp = 'FFDCE6F1';
const VERDEp = 'FFE8F5E9';
const ROSAp = 'FFFCEBEB';
const AMBARp = 'FFFDF6E3';
const GRISp = 'FFF2F2F2';
const ROJOTXTPt = 'FFA32D2D';
const AMBARTXTPt = 'FF854F0B';
const VERDETXTPt = 'FF3B6D11';

// fondo y letra de cada tubo, en el orden de los buffers
const TUBOSPt = [
  ['FF1F4E79', 'FFFFFFFF', 'Azul'], ['FFED7D31', 'FF000000', 'Naranja'],
  ['FF548235', 'FFFFFFFF', 'Verde'], ['FF843C0C', 'FFFFFFFF', 'Marrón'],
  ['FF808080', 'FFFFFFFF', 'Gris'], ['FFFFFFFF', 'FF000000', 'Blanco'],
  ['FFC00000', 'FFFFFFFF', 'Rojo'], ['FF262626', 'FFFFFFFF', 'Negro'],
  ['FF7030A0', 'FFFFFFFF', 'Violeta'], ['FFFF99CC', 'FF000000', 'Rosa'],
  ['FF31859C', 'FFFFFFFF', 'Aguamarina'], ['FFFFD966', 'FF000000', 'Amarillo'],
];

const finoPt = { style: 'thin', color: { argb: 'FF9DB2C6' } };
const BORDEPt = { top: finoPt, left: finoPt, bottom: finoPt, right: finoPt };
const CENTROPt = { horizontal: 'center', vertical: 'middle' };
const IZQPt = { horizontal: 'left', vertical: 'middle' };
const AJUSTEPt = { horizontal: 'left', vertical: 'top', wrapText: true };
const BANDAPt = { horizontal: 'left', vertical: 'middle', wrapText: true };
const rellenoPt = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const milesPt = (n) => Math.round(n).toLocaleString('es-AR');
const decPt = (n) => (n == null ? null : Number(n.toFixed(3)));

function celPt(ws, f, c, v, o = {}) {
  const x = ws.getCell(f, c);
  if (v !== undefined) x.value = v;
  x.font = { name: 'Arial', size: o.size || 9, bold: !!o.bold, italic: !!o.italic,
             color: { argb: o.color || 'FF1C2430' } };
  x.alignment = o.alin || CENTROPt;
  if (o.fill) x.fill = rellenoPt(o.fill);
  if (o.borde !== false) x.border = BORDEPt;
  if (o.formato) x.numFmt = o.formato;
  return x;
}

/** Columnas: sin comparacion son 6, con comparacion 9. */
const ANCHOSPt = [7, 14, 9, 9, 9, 17, 11, 9, 16];

/** Cuantos caracteres entran por renglon en el ancho del bloque. */
function anchoRenglonPt(nCols, size) {
  const total = ANCHOSPt.slice(0, nCols).reduce((a, b) => a + b, 0);
  const porUnidad = size <= 8 ? 1.35 : (size <= 9 ? 1.18 : 1.02);
  return Math.max(24, Math.floor(total * porUnidad));
}

/**
 * Escribe una banda que ocupa todo el ancho del bloque, con ajuste de texto
 * y la altura necesaria para que no se corte nada. Sin esto el texto largo
 * de una celda combinada queda recortado al imprimir.
 */
function bandaPt(ws, f, ULT, nCols, texto, o = {}) {
  const size = o.size || 9;
  const renglones = Math.max(1,
    Math.ceil(String(texto).length / anchoRenglonPt(nCols, size)));
  celPt(ws, f, 2, texto,
    { ...o, size, alin: o.alin || (renglones > 1 ? AJUSTEPt : BANDAPt) });
  ws.mergeCells(f, 2, f, ULT);
  ws.getRow(f).height = Math.min(110, renglones * (size + 4.5) + 6);
  return renglones;
}

/**
 * Cuantos puntos entran en cada solapa.
 *
 * Una traza larga puede tener 40 botellas o mas: todo en una sola solapa es
 * inmanejable. De dos en dos cada solapa entra en una hoja impresa y la
 * cuadrilla se lleva la que le toca.
 */
const PORHOJAPt = 2;

/** Como se nombra el punto en el indice de la solapa. */
const rotuloPt = (o) => (o.esCorte ? `CORTE ${o.n}` : `PUNTO ${o.n}`)
  + (o.prog_a ? ` (${milesPt(o.prog_a)} m)` : '');

/**
 * Marca en cada orden en qué solapa va a quedar su detalle.
 *
 * Se llama antes de armar la solapa REPARACIONES, para que la tabla de
 * órdenes de trabajo diga a qué solapa ir a buscar el pelo por pelo.
 */
function marcarHojas(puntos) {
  const hojas = Math.max(1, Math.ceil(puntos.length / PORHOJAPt));
  puntos.forEach((p, i) => {
    if (!p.orden) return;
    p.orden.hoja = Math.floor(i / PORHOJAPt) + 1;
    p.orden.hojas = hojas;
  });
  return hojas;
}

function hojaPuntos(wb, datos) {
  const { puntos } = datos;
  const grupos = [];
  for (let i = 0; i < puntos.length; i += PORHOJAPt) {
    grupos.push(puntos.slice(i, i + PORHOJAPt));
  }
  if (!grupos.length) grupos.push([]);
  return grupos.map((g, i) => unaHojaPt(wb, datos, g, i + 1, grupos.length));
}

function unaHojaPt(wb, datos, grupo, nro, total) {
  const { cfg, puntos, umbral, longitud, hayComparacion, fechaAnterior } = datos;
  const ws = wb.addWorksheet(total > 1 ? `PUNTOS A INTERVENIR ${nro}`
    : 'PUNTOS A INTERVENIR');
  ws.views = [{ showGridLines: false, state: 'frozen', ySplit: 4 }];

  const nCols = hayComparacion ? 9 : 6;
  ANCHOSPt.slice(0, nCols).forEach((w, i) => { ws.getColumn(i + 2).width = w; });
  ws.getColumn(1).width = 2.5;
  const ULT = 1 + nCols;

  // --------------------------------------------------------------- cabecera
  for (let c = 2; c <= ULT; c++) ws.getCell(2, c).fill = rellenoPt(AZULp);
  const t = ws.getCell(2, 2);
  // el "hoja N de M" va primero: si el nombre del tramo es largo, que recorte
  // el nombre y no la referencia de la hoja
  t.value = 'PUNTOS A INTERVENIR'
    + (total > 1 ? `  ·  hoja ${nro} de ${total}` : '')
    + `  ·  ${cfg.registro.tramo || ''}`;
  t.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  t.alignment = { horizontal: 'left', vertical: 'middle', indent: 1,
                  shrinkToFit: true };
  ws.mergeCells(2, 2, 2, ULT);
  ws.getRow(2).height = 22;

  const nCortes = puntos.filter((p) => p.orden.esCorte).length;
  bandaPt(ws, 3, ULT, nCols, (grupo.length
    ? `En esta hoja: ${grupo.map((p) => rotuloPt(p.orden)).join('  y  ')}`
      + `  ·  de ${puntos.length} punto(s) a intervenir en total`
      + `${nCortes ? `, de los cuales ${nCortes} son cortes de fibra` : ''}  ·  `
    : '')
    + `longitud óptica del tramo ${milesPt(longitud)} m `
    + `(${(longitud / 1000).toFixed(3)} km)`
    + `  ·  criterio ${umbral.toFixed(2).replace('.', ',')} dB  ·  `
    + `se listan los pelos desde ${(puntos[0] ? puntos[0].desde : 0.1)
      .toFixed(2).replace('.', ',')} dB`
    + (hayComparacion ? `  ·  comparado contra la planilla del ${fechaAnterior
      || 'campaña anterior'}` : ''),
    { size: 9, italic: true, borde: false, color: 'FF5A6472' });

  let f = 5;
  for (const p of grupo) {
    const o = p.orden;

    // ------------------------------------------------- encabezado del punto
    for (let c = 2; c <= ULT; c++) ws.getCell(f, c).fill = rellenoPt(AZULp);
    const h = ws.getCell(f, 2);
    h.value = o.esCorte
      ? `CORTE ${o.n}  ·  ${o.prog_a ? `progresiva ${milesPt(o.prog_a)} m desde A`
        + `  ·  ${milesPt(o.prog_b)} m desde B` : 'progresiva sin determinar'}`
      : `PUNTO ${o.n}  ·  progresiva ${milesPt(o.prog_a)} m desde A  ·  `
        + `${milesPt(o.prog_b)} m desde B`;
    h.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    if (o.esCorte) {
      for (let c = 2; c <= ULT; c++) ws.getCell(f, c).fill = rellenoPt('FFC00000');
    }
    h.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    ws.mergeCells(f, 2, f, ULT);
    ws.getRow(f).height = 18;
    f += 1;

    const fondo = o.prioridad === 'CORTE' ? 'FFF7C1C1'
      : (o.prioridad === 'VERIFICADO' ? VERDEp
        : (o.prioridad === 'ALTA' ? ROSAp
          : (o.prioridad === 'MEDIA' ? AMBARp : GRISp)));
    const donde = o.elemento
      ? `${(TIPOS[o.elemento.tipo] || TIPOS.otro).etiqueta} `
        + `${milesPt(o.elemento.progresiva_m)} m (${o.distancia >= 0 ? '+' : ''}`
        + `${Math.round(o.distancia)} m)`
      : 'sin elemento declarado cerca';
    bandaPt(ws, f, ULT, nCols, o.prioridad === 'CORTE'
      ? `PELO CORTADO — FUERA DE SERVICIO  ·  ${donde}  ·  `
        + `${o.pelos.length} pelo(s): ${o.pelos.join(', ')}`
      : o.prioridad === 'VERIFICADO'
      ? `VERIFICADO  ·  ${donde}  ·  reparado en la campaña anterior`
        + (o.peor ? `  ·  peor lectura ahora ${o.peor.toFixed(3)} dB`
          : '  ·  sin evento detectado')
      : `${o.prioridad}  ·  ${donde}  ·  afecta a ${o.pelos.length} de `
        + `${o.medidos} pelos  ·  peor lectura ${o.peor.toFixed(3)} dB`,
      { bold: true, fill: fondo,
        color: o.prioridad === 'CORTE' ? 'FF7F1010'
          : (o.prioridad === 'VERIFICADO' ? VERDETXTPt
            : (o.prioridad === 'ALTA' ? ROJOTXTPt : AMBARTXTPt)) });
    f += 1;
    if (o.alerta) {
      bandaPt(ws, f, ULT, nCols, '⚠  ' + o.alerta,
        { bold: true, size: 8, fill: 'FFFFEB9C', color: 'FF7A4E00' });
      f += 1;
    }
    bandaPt(ws, f, ULT, nCols, `${o.diagnostico}   →   ${o.accion}`
      + (o.notas ? ` ${o.notas}` : ''),
      { size: 8, alin: AJUSTEPt, fill: fondo });
    f += 1;

    // ------------------------------------------------------ encabezado tabla
    if (hayComparacion) {
      celPt(ws, f, 2, 'MEDICIÓN ACTUAL', { bold: true, fill: CELESTEp,
        color: 'FF0C447C', size: 8 });
      ws.mergeCells(f, 2, f, 7);
      celPt(ws, f, 8, 'CONTRA LA CAMPAÑA ANTERIOR', { bold: true, fill: VERDEp,
        color: 'FF1B5E20', size: 8 });
      ws.mergeCells(f, 8, f, ULT);
      f += 1;
    }
    const titulos = o.esCorte
      ? ['Pelo', 'Tubo', 'Corta a\n(m desde A)', 'Corta a\n(m desde B)', '—', 'Estado']
      : ['Pelo', 'Tubo', 'A→B', 'B→A', 'At Prom', 'Estado'];
    if (hayComparacion) titulos.push('Prom antes', 'Δ', 'Resultado');
    titulos.forEach((tt, i) => celPt(ws, f, 2 + i, tt,
      { bold: true, fill: AZULp, color: 'FFFFFFFF', size: 8,
        alin: { horizontal: 'center', vertical: 'middle', wrapText: true } }));
    ws.getRow(f).height = o.esCorte ? 26 : 16;
    const filaTit = f;
    f += 1;

    // ------------------------------------------------------ una fila por pelo
    if (!p.filas.length) {
      bandaPt(ws, f, ULT, nCols,
        'Ningún pelo llega al corte de listado en este punto.',
        { italic: true, size: 8, color: 'FF6B7480' });
      f += 1;
    }
    for (const fila of p.filas) {
      const tint = fila.estado === 'CORTADO' ? 'FFF7C1C1'
        : (fila.estado === 'FUERA' ? ROSAp
          : (fila.estado === 'AL LÍMITE' ? AMBARp
            : (fila.estado === 'SIN EVENTO' ? VERDEp : undefined)));
      celPt(ws, f, 2, fila.pelo, { bold: true, fill: tint });
      const [bg, fg, nombre] = TUBOSPt[(fila.tubo - 1) % TUBOSPt.length];
      celPt(ws, f, 3, `B${fila.tubo} ${nombre.toLowerCase()}`,
        { fill: bg, color: fg, size: 8, bold: true });
      // el sentido que no tomó evento se muestra en 0, en gris
      const ceroA = !o.esCorte && fila.unSentido && fila.a == null;
      const ceroB = !o.esCorte && fila.unSentido && fila.b == null;
      celPt(ws, f, 4, o.esCorte ? fila.a : decPt(ceroA ? 0 : fila.a),
        { formato: o.esCorte ? '#,##0' : '0.000', fill: tint, bold: !!o.esCorte,
          italic: ceroA, color: ceroA ? 'FF8A8F98' : undefined });
      celPt(ws, f, 5, o.esCorte ? fila.b : decPt(ceroB ? 0 : fila.b),
        { formato: o.esCorte ? '#,##0' : '0.000', fill: tint,
          italic: ceroB, color: ceroB ? 'FF8A8F98' : undefined });
      celPt(ws, f, 6, decPt(fila.prom), { formato: '0.000', bold: true, fill: tint });
      celPt(ws, f, 7, fila.estado + (fila.unSentido
        ? ` · 1 sentido (0 en ${fila.a == null ? 'A→B' : 'B→A'})` : ''),
        { bold: fila.estado !== 'normal', fill: tint, size: 8,
          color: fila.estado === 'CORTADO' ? 'FF7F1010'
            : (fila.estado === 'FUERA' ? ROJOTXTPt
              : (fila.estado === 'AL LÍMITE' ? AMBARTXTPt : VERDETXTPt)) });

      if (hayComparacion) {
        const F = ws.getColumn(6).letter;     // At Prom de ahora
        const G = ws.getColumn(8).letter;     // At Prom de antes
        celPt(ws, f, 8, decPt(fila.promAntes), { formato: '0.000', fill: tint });
        celPt(ws, f, 9, { formula: `IF(${G}${f}="","",${F}${f}-${G}${f})` },
            { formato: '+0.000;-0.000;0.000', fill: tint });
        // el veredicto se recalcula si se corrige un valor a mano
        // el veredicto se pinta con lo ya calculado y la fórmula lo recalcula
        // si se corrige un valor a mano
        let fondoRes;
        let letraRes;
        if (fila.promAntes == null) { fondoRes = GRISp; letraRes = 'FF6B7480'; }
        else if (fila.prom == null
                 || (fila.promAntes >= umbral && fila.prom < umbral)) {
          fondoRes = 'FFE8F5E9'; letraRes = VERDETXTPt;
        } else if (fila.promAntes - fila.prom > 0.02) {
          fondoRes = 'FFDCE6F1'; letraRes = 'FF0C447C';
        } else if (fila.prom - fila.promAntes > 0.02) {
          fondoRes = 'FFFFC7CE'; letraRes = ROJOTXTPt;
        } else { fondoRes = 'FFFDF6E3'; letraRes = AMBARTXTPt; }
        celPt(ws, f, 10, { formula:
          `IF(${G}${f}="","SIN DATO ANTERIOR",`
          + `IF(${F}${f}="","REPARADO",`
          + `IF(AND(${G}${f}>=${umbral},${F}${f}<${umbral}),"REPARADO",`
          + `IF(${G}${f}-${F}${f}>0.02,"MEJORÓ",`
          + `IF(${F}${f}-${G}${f}>0.02,"EMPEORÓ","SIN CAMBIO")))))` },
          { bold: true, size: 8, fill: fondoRes, color: letraRes });
      }
      f += 1;
    }
    if (p.bajoCorte) {
      bandaPt(ws, f, ULT, nCols, `Otros ${p.bajoCorte} pelo(s) con lectura por debajo de `
        + `${p.desde.toFixed(2).replace('.', ',')} dB en este punto`
        + (p.promedioBajo != null
          ? ` · promedio ${p.promedioBajo.toFixed(3)} dB` : '')
        + '. No hace falta tocarlos.',
        { italic: true, size: 8, color: 'FF6B7480' });
      f += 1;
    }

    // pinta el resultado según lo que diga la fórmula
    if (hayComparacion && p.filas.length) {
      const letra = ws.getColumn(10).letter;
      const desdeF = filaTit + 1;
      const hastaF = filaTit + p.filas.length;
      const reglas = [
        ['REPARADO', 'FFE8F5E9', VERDETXTPt],
        ['MEJORÓ', 'FFDCE6F1', 'FF0C447C'],
        ['EMPEORÓ', 'FFFFC7CE', ROJOTXTPt],
        ['SIN CAMBIO', 'FFFDF6E3', AMBARTXTPt],
      ];
      ws.addConditionalFormatting({
        ref: `${letra}${desdeF}:${letra}${hastaF}`,
        rules: reglas.map(([texto, bg, fg], i) => ({
          type: 'containsText', operator: 'containsText', text: texto,
          priority: i + 1,
          style: { fill: rellenoPt(bg), font: { color: { argb: fg }, bold: true } },
        })),
      });
    }
    f += 2;
  }

  if (!grupo.length) {
    bandaPt(ws, 5, ULT, nCols,
      `Ningún evento supera ${umbral.toFixed(2).replace('.', ',')} dB. `
      + 'No hay puntos para intervenir.', { fill: VERDEp });
  }

  ws.pageSetup = { orientation: 'portrait', paperSize: 9, fitToPage: true,
    fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5,
               header: 0.2, footer: 0.2 } };
  ws.headerFooter = {
    oddFooter: `&L&8${(cfg.registro.contratista || '').replace(/&/g, '&&')}`
      + `&C&8${(cfg.registro.tramo || '').replace(/&/g, '&&')}`
      + (total > 1 ? `  ·  hoja ${nro} de ${total}` : '')
      + '&R&8Página &P de &N',
  };
  return ws;
}

/**
 * Solapa plana con los mismos datos, una fila por punto y pelo.
 *
 * Es la que lee la aplicacion cuando se carga esta planilla como campaña
 * anterior: parsear los bloques visuales seria fragil, esto no.
 */
function hojaDatos(wb, datos) {
  const { cfg, puntos, longitud, umbral, fecha } = datos;
  const ws = wb.addWorksheet('DATOS');
  ws.views = [{ state: 'frozen', ySplit: 5 }];

  celPt(ws, 1, 1, 'DATOS PARA COMPARAR CAMPAÑAS', { bold: true, borde: false, size: 11,
    color: AZULp, alin: IZQPt });
  celPt(ws, 2, 1, 'No borrar esta solapa: es la que lee la aplicación cuando se carga '
    + 'esta planilla para comparar contra una remedición.',
    { italic: true, size: 8, borde: false, alin: IZQPt, color: 'FF6B7480' });
  celPt(ws, 3, 1, 'tramo', { bold: true, borde: false, alin: IZQPt });
  celPt(ws, 3, 2, cfg.registro.tramo || '', { borde: false, alin: IZQPt });
  celPt(ws, 3, 3, 'longitud_m', { bold: true, borde: false, alin: IZQPt });
  celPt(ws, 3, 4, Math.round(longitud), { borde: false });
  celPt(ws, 3, 5, 'umbral_db', { bold: true, borde: false, alin: IZQPt });
  celPt(ws, 3, 6, umbral, { borde: false, formato: '0.00' });
  celPt(ws, 3, 7, 'fecha', { bold: true, borde: false, alin: IZQPt });
  celPt(ws, 3, 8, fecha || new Date().toISOString().slice(0, 10),
      { borde: false, alin: IZQPt });

  const cab = ['punto', 'prog_a', 'prog_b', 'pelo', 'tubo', 'a_b', 'b_a', 'prom',
               'estado', 'prioridad', 'elemento', 'diagnostico'];
  cab.forEach((c, i) => celPt(ws, 5, 1 + i, c,
    { bold: true, fill: AZULp, color: 'FFFFFFFF', size: 8 }));
  [8, 10, 10, 7, 6, 9, 9, 9, 11, 9, 24, 40]
    .forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  let f = 6;
  for (const p of puntos) {
    const o = p.orden;
    const elem = o.elemento
      ? `${(TIPOS[o.elemento.tipo] || TIPOS.otro).etiqueta} `
        + `${Math.round(o.elemento.progresiva_m)} m` : '';
    for (const fila of p.filas) {
      const vals = [o.n, Math.round(o.prog_a), Math.round(o.prog_b), fila.pelo,
        fila.tubo, decPt(fila.a), decPt(fila.b), decPt(fila.prom), fila.estado,
        o.prioridad, elem, o.diagnostico];
      vals.forEach((v, i) => celPt(ws, f, 1 + i, v,
        { size: 8, alin: i >= 8 ? IZQPt : CENTROPt,
          formato: i >= 5 && i <= 7 ? '0.000' : undefined }));
      f += 1;
    }
  }
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, f - 1), column: 12 } };
  return ws;
}

/**
 * Lee la solapa DATOS de una planilla de reparaciones anterior.
 * Devuelve una fila por punto y pelo, para cruzar contra la medicion de ahora.
 */
async function leerAnterior(ExcelJS, buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('DATOS');
  if (!ws) return { filas: [], fecha: null, error: 'sin-datos' };
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'object' ? (v.result ?? v.value) : v;
    return Number.isFinite(Number(n)) ? Number(n) : null;
  };
  const fechaCelda = ws.getCell(3, 8).value;
  const filas = [];
  for (let f = 6; f <= ws.rowCount; f++) {
    const prog = num(ws.getCell(f, 2).value);
    const pelo = num(ws.getCell(f, 4).value);
    if (prog == null || pelo == null) continue;
    filas.push({
      punto: num(ws.getCell(f, 1).value),
      prog_a: prog,
      pelo,
      a: num(ws.getCell(f, 6).value),
      b: num(ws.getCell(f, 7).value),
      prom: num(ws.getCell(f, 8).value),
    });
  }
  return { filas, fecha: fechaCelda ? String(fechaCelda).slice(0, 10) : null };
}
/*
 * Gráfico de atenuación contra progresiva, dibujado en un canvas y embebido
 * como imagen en el Excel. ExcelJS no crea gráficos nativos, así que se dibuja
 * a mano: a cambio se puede mostrar exactamente lo que hace falta.
 *
 *   · todos los eventos medidos, en gris, como contexto
 *   · los que superan el umbral, coloreados por prioridad
 *   · el tamaño del punto crece con la cantidad de pelos afectados
 *   · líneas de umbral y de crítico
 *   · la infraestructura declarada sobre el eje, con su color
 */

const COLORESGr = { ALTA: '#c62828', MEDIA: '#ed7d31', BAJA: '#2e7d32' };

const milesGr = (n) => Math.round(n).toLocaleString('es-AR');

/**
 * Valor de un evento en un pelo según el modo de vista:
 *   'A'         solo lo medido de A hacia B
 *   'B'         solo lo medido de B hacia A
 *   'promedio'  (A + B) / 2, que es la pérdida real del empalme
 *   'ambos'     los dos sentidos por separado
 */
function valorEvento(valores, f, n, modo) {
  const a = valores.get(`${f}|${n}|A`);
  const b = valores.get(`${f}|${n}|B`);
  const va = a && a.perdida != null ? a.perdida : null;
  const vb = b && b.perdida != null ? b.perdida : null;
  if (modo === 'A') return va == null ? [] : [{ v: va, sentido: 'A' }];
  if (modo === 'B') return vb == null ? [] : [{ v: vb, sentido: 'B' }];
  if (modo === 'ambos') {
    const r = [];
    if (va != null) r.push({ v: va, sentido: 'A' });
    if (vb != null) r.push({ v: vb, sentido: 'B' });
    return r;
  }
  if (va != null && vb != null) return [{ v: (va + vb) / 2, sentido: 'prom' }];
  // un solo sentido: el otro va en 0 y se promedia, como en la planilla
  const u = va != null ? va : vb;
  return u == null ? [] : [{ v: u / 2, sentido: va != null ? 'A' : 'B' }];
}

const TITULO_MODO = {
  A: 'lecturas del sentido A→B',
  B: 'lecturas del sentido B→A',
  promedio: 'promedio bidireccional de cada evento',
  ambos: 'los dos sentidos por separado',
};

function dibujarGrafico(canvas, datos) {
  const { ordenes, empalmes, valores, medidos, infraestructura = [],
          longitud, umbral, tramo, mediciones = [], teorica = null } = datos;
  const modo = datos.modo || 'promedio';
  const cortadas = datos.cortadas || new Map();
  const ANCHO = canvas.width;
  const ALTO = canvas.height;
  const ctx = canvas.getContext('2d');

  // paneles de abajo: qué pelo tiene cada evento, y el resumen por pelo
  const altoPelos = Math.min(320, 60 + medidos.length * 14);
  const altoResumen = Math.min(300, 70 + medidos.length * 13);
  const izq = 78;
  const der = ANCHO - 210;
  const arriba = 56;
  const abajo = ALTO - 86 - altoPelos - altoResumen;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ANCHO, ALTO);

  // ---------------------------------------------------------- datos de fondo
  const todos = [];
  for (const emp of empalmes) {
    for (const f of medidos) {
      for (const p of valorEvento(valores, f, emp.n, modo))
        if (p.v > 0) todos.push({ x: emp.prog_a, y: p.v, sentido: p.sentido });
    }
  }
  const maxY = Math.max(umbral * 2.2, ...todos.map((p) => p.y),
    ...ordenes.map((o) => o.peor)) * 1.12;
  const maxX = longitud || Math.max(...empalmes.map((e) => e.prog_a), 1);

  const px = (m) => izq + (m / maxX) * (der - izq);
  const py = (db) => abajo - (db / maxY) * (abajo - arriba);

  // --------------------------------------------------------------- títulos
  ctx.fillStyle = '#1f4e79';
  ctx.font = 'bold 20px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('Atenuación por evento a lo largo de la traza', izq, 30);
  ctx.fillStyle = '#6b7480';
  ctx.font = '13px Arial';
  ctx.fillText(`${tramo || ''}   ·   ${(maxX / 1000).toFixed(3)} km   ·   `
    + `${medidos.length} pelos medidos   ·   umbral `
    + `${umbral.toFixed(2).replace('.', ',')} dB   ·   `
    + `vista: ${TITULO_MODO[modo]}`, izq, 48);

  // ----------------------------------------------------------- grilla y ejes
  ctx.strokeStyle = '#e3e7ec';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#6b7480';
  ctx.font = '11px Arial';
  ctx.textAlign = 'right';
  const pasoY = maxY > 1 ? 0.2 : 0.05;
  for (let v = 0; v <= maxY; v += pasoY) {
    const y = py(v);
    ctx.beginPath();
    ctx.moveTo(izq, y);
    ctx.lineTo(der, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(2).replace('.', ','), izq - 8, y + 4);
  }
  ctx.textAlign = 'center';
  const pasoX = maxX > 60000 ? 10000 : (maxX > 20000 ? 5000 : 1000);
  for (let m = 0; m <= maxX; m += pasoX) {
    const x = px(m);
    ctx.beginPath();
    ctx.moveTo(x, arriba);
    ctx.lineTo(x, abajo);
    ctx.stroke();
    ctx.fillText((m / 1000).toFixed(0), x, abajo + 18);
  }
  ctx.strokeStyle = '#98a2ae';
  ctx.beginPath();
  ctx.moveTo(izq, arriba);
  ctx.lineTo(izq, abajo);
  ctx.lineTo(der, abajo);
  ctx.stroke();

  ctx.fillStyle = '#1c2430';
  ctx.font = '12px Arial';
  ctx.fillText('Progresiva desde A (km)', (izq + der) / 2, abajo + 38);
  ctx.save();
  ctx.translate(22, (arriba + abajo) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Pérdida del evento (dB)', 0, 0);
  ctx.restore();

  // ------------------------------------------------------ líneas de criterio
  const linea = (v, color, texto) => {
    if (v > maxY) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(izq, py(v));
    ctx.lineTo(der, py(v));
    ctx.stroke();
    ctx.restore();
    // la etiqueta va adentro del área del gráfico, para no pisar la leyenda
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'right';
    const ancho = ctx.measureText(texto).width + 10;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(der - ancho - 2, py(v) - 9, ancho, 14);
    ctx.fillStyle = color;
    ctx.fillText(texto, der - 8, py(v) + 3);
    ctx.textAlign = 'center';
  };
  linea(umbral, '#b26a00', `umbral ${umbral.toFixed(2).replace('.', ',')} dB`);
  linea(umbral * 2, '#c62828', `crítico ${(umbral * 2).toFixed(2).replace('.', ',')} dB`);

  // ------------------------------------------------------ pelos cortados
  for (const [f, hasta] of cortadas) {
    const x = px(hasta);
    if (x < izq || x > der) continue;
    ctx.save();
    ctx.strokeStyle = '#c62828';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 4]);
    ctx.beginPath();
    ctx.moveTo(x, arriba);
    ctx.lineTo(x, abajo);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#c62828';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    const texto = `CORTE F${String(f).padStart(2, '0')}`;
    const w = ctx.measureText(texto).width + 12;
    ctx.fillRect(x - w / 2, arriba - 16, w, 15);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(texto, x, arriba - 5);
    ctx.fillStyle = '#c62828';
    ctx.font = '10px Arial';
    ctx.fillText(milesGr(hasta) + ' m', x, arriba + 14);
  }

  // ------------------------------------------- infraestructura sobre el eje
  for (const e of infraestructura) {
    const x = px(e.progresiva_m);
    if (x < izq || x > der) continue;
    const t = TIPOS[e.tipo] || TIPOS.otro;
    ctx.fillStyle = '#' + t.color.slice(2);
    ctx.fillRect(x - 3, abajo + 2, 6, 9);
  }

  // ------------------------------------------------------------ los eventos
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#98a2ae';
  for (const p of todos) {
    ctx.beginPath();
    ctx.arc(px(p.x), py(p.y), 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const etiquetas = [];
  for (const o of ordenes) {
    const x = px(o.prog_a);
    const y = py(o.peor);
    const r = 5 + Math.min(7, Math.sqrt(o.pelos.length) * 2.2);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORESGr[o.prioridad] || '#2e7d32';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (o.prioridad !== 'BAJA') etiquetas.push({ o, x, y });
    else {
      ctx.fillStyle = '#3b4654';
      ctx.font = '10px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(o.pelos.length <= 3 ? o.pelos.join(',') : `${o.pelos.length}p`,
                   x, y - r - 5);
    }
  }

  // etiquetas de los puntos importantes, sin encimarse
  ctx.font = 'bold 11px Arial';
  ctx.textAlign = 'center';
  const usadas = [];
  for (const { o, x, y } of etiquetas) {
    const listaPelos = o.pelos.length <= 5 ? `pelo ${o.pelos.join(', ')}`
      : `${o.pelos.length} pelos (peor: ${o.peorPelo})`;
    const lineas = [`OT ${o.n} · ${milesGr(o.prog_a)} m`,
                    `${o.peor.toFixed(3)} dB`,
                    listaPelos];
    const ancho = 148;
    const alto = 42;
    let cy = y - 18 - alto;
    // el cartel no puede salirse del área del gráfico
    const cx = Math.min(Math.max(x, izq + ancho / 2 + 2), der - ancho / 2 - 2);
    while (usadas.some((u) => Math.abs(u.x - cx) < ancho && Math.abs(u.y - cy) < alto + 4))
      cy -= alto + 6;
    if (cy < arriba) cy = y + 20;
    usadas.push({ x: cx, y: cy });
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = COLORESGr[o.prioridad];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(cx - ancho / 2, cy, ancho, alto);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1c2430';
    ctx.font = 'bold 11px Arial';
    ctx.fillText(lineas[0], cx, cy + 13);
    ctx.font = 'bold 11px Arial';
    ctx.fillStyle = COLORESGr[o.prioridad];
    ctx.fillText(lineas[1], cx, cy + 26);
    ctx.font = '10px Arial';
    ctx.fillStyle = '#5a6472';
    ctx.fillText(lineas[2], cx, cy + 38);
    ctx.strokeStyle = COLORESGr[o.prioridad];
    ctx.beginPath();
    ctx.moveTo(cx, cy + alto);
    ctx.lineTo(x, y - 8);
    ctx.stroke();
  }

  // ----------------------------------------------------------------- leyenda
  let ly = arriba + 6;
  const lx = der + 22;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1c2430';
  ctx.font = 'bold 12px Arial';
  ctx.fillText('Prioridad', lx, ly);
  ly += 18;
  ctx.font = '11px Arial';
  for (const [nombre, color] of Object.entries(COLORESGr)) {
    const n = ordenes.filter((o) => o.prioridad === nombre).length;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx + 6, ly - 4, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1c2430';
    ctx.fillText(`${nombre} (${n})`, lx + 18, ly);
    ly += 18;
  }
  ctx.fillStyle = '#98a2ae';
  ctx.beginPath();
  ctx.arc(lx + 6, ly - 4, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1c2430';
  ctx.fillText('resto de los eventos', lx + 18, ly);
  ly += 18;
  if (cortadas.size) {
    ctx.strokeStyle = '#c62828';
    ctx.lineWidth = 2;
    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(lx, ly - 4);
    ctx.lineTo(lx + 12, ly - 4);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#c62828';
    ctx.font = 'bold 11px Arial';
    ctx.fillText(`pelo cortado (${cortadas.size})`, lx + 18, ly);
    ctx.font = '11px Arial';
    ctx.fillStyle = '#1c2430';
    ly += 18;
  }
  ly += 8;

  if (infraestructura.length) {
    ctx.font = 'bold 12px Arial';
    ctx.fillText('Obra', lx, ly);
    ly += 18;
    ctx.font = '11px Arial';
    const usados = [...new Set(infraestructura.map((e) => e.tipo))];
    for (const tipo of usados) {
      const t = TIPOS[tipo] || TIPOS.otro;
      ctx.fillStyle = '#' + t.color.slice(2);
      ctx.fillRect(lx, ly - 9, 12, 10);
      ctx.fillStyle = '#1c2430';
      ctx.fillText(t.etiqueta, lx + 18, ly);
      ly += 17;
    }
  }
  ctx.font = '10px Arial';
  ctx.fillStyle = '#6b7480';
  ctx.fillText('El tamaño del punto', lx, ly + 14);
  ctx.fillText('crece con la cantidad', lx, ly + 28);
  ctx.fillText('de pelos afectados.', lx, ly + 42);

  // ------------------------------------------------- panel: evento por pelo
  const pArriba = abajo + 66;
  const pAbajo = pArriba + altoPelos - 60;
  const pelosOrden = [...medidos].sort((a, b) => a - b);
  const fila = (f) => pArriba + (pelosOrden.indexOf(f) + 0.5)
    * ((pAbajo - pArriba) / Math.max(1, pelosOrden.length));

  ctx.textAlign = 'left';
  ctx.fillStyle = '#1f4e79';
  ctx.font = 'bold 14px Arial';
  ctx.fillText('Qué pelo tiene cada evento', izq, pArriba - 18);
  ctx.fillStyle = '#6b7480';
  ctx.font = '11px Arial';
  ctx.fillText('una fila por pelo · solo los eventos que superan el umbral',
               izq + 215, pArriba - 18);

  // renglón de cada pelo
  ctx.strokeStyle = '#eef1f5';
  ctx.lineWidth = 1;
  ctx.font = '10px Arial';
  for (const f of pelosOrden) {
    const y = fila(f);
    const corte = cortadas.get(f);
    if (corte != null) {
      // desde el corte hasta el final no hay fibra: se pinta el tramo muerto
      ctx.fillStyle = 'rgba(198,40,40,0.13)';
      ctx.fillRect(px(corte), y - 6, der - px(corte), 12);
      ctx.strokeStyle = '#c62828';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(izq, y);
      ctx.lineTo(px(corte), y);
      ctx.stroke();
      ctx.fillStyle = '#c62828';
      ctx.font = 'bold 10px Arial';
      ctx.textAlign = 'left';
      ctx.fillText(`CORTADA a ${milesGr(corte)} m`, px(corte) + 8, y + 3);
      // cruz en el punto del corte
      const x = px(corte);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
      ctx.stroke();
      ctx.strokeStyle = '#eef1f5';
      ctx.lineWidth = 1;
    } else {
      ctx.beginPath();
      ctx.moveTo(izq, y);
      ctx.lineTo(der, y);
      ctx.stroke();
    }
    ctx.fillStyle = corte != null ? '#c62828' : '#5a6472';
    ctx.font = corte != null ? 'bold 10px Arial' : '10px Arial';
    ctx.textAlign = 'right';
    ctx.fillText('F' + String(f).padStart(2, '0'), izq - 6, y + 3);
  }
  // divisiones de kilómetros
  ctx.strokeStyle = '#f2f4f7';
  for (let m = 0; m <= maxX; m += pasoX) {
    ctx.beginPath();
    ctx.moveTo(px(m), pArriba);
    ctx.lineTo(px(m), pAbajo);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#6b7480';
  for (let m = 0; m <= maxX; m += pasoX)
    ctx.fillText((m / 1000).toFixed(0), px(m), pAbajo + 16);
  ctx.fillStyle = '#1c2430';
  ctx.font = '12px Arial';
  ctx.fillText('Progresiva desde A (km)', (izq + der) / 2, pAbajo + 36);

  // un punto por pelo afectado
  for (const o of ordenes) {
    for (const f of o.pelos) {
      let peorPelo = 0;
      for (const p of valorEvento(valores, f, o.n, modo))
        if (p.v > peorPelo) peorPelo = p.v;
      const y = fila(f);
      const x = px(o.prog_a);
      const color = peorPelo >= umbral * 2 ? COLORESGr.ALTA
        : peorPelo >= umbral * 1.4 ? COLORESGr.MEDIA : COLORESGr.BAJA;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  // los eventos que afectan a varios pelos se unen con una línea vertical
  for (const o of ordenes) {
    if (o.pelos.length < 2) continue;
    const x = px(o.prog_a);
    const ys = o.pelos.map(fila);
    ctx.strokeStyle = 'rgba(198,40,40,0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, Math.min(...ys) - 6);
    ctx.lineTo(x, Math.max(...ys) + 6);
    ctx.stroke();
    ctx.fillStyle = '#3b4654';
    ctx.font = 'bold 10px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('OT ' + o.n, x, Math.min(...ys) - 10);
  }


  // ------------------------------- resumen por pelo: total del tramo y promedio
  const rArriba = pAbajo + 62;
  const rAbajo = rArriba + altoResumen - 84;
  const filaR = (f) => rArriba + (pelosOrden.indexOf(f) + 0.5)
    * ((rAbajo - rArriba) / Math.max(1, pelosOrden.length));
  const altoBarra = Math.max(6, (rAbajo - rArriba) / Math.max(1, pelosOrden.length) - 4);

  // pérdida total del tramo por pelo, según el modo elegido
  const totales = new Map();
  for (const m of mediciones) {
    if (m.numero == null || m.perdidaTotal == null) continue;
    const d = totales.get(m.numero) || { A: null, B: null };
    if (d[m.sentido] == null) d[m.sentido] = m.perdidaTotal;
    totales.set(m.numero, d);
  }
  const totalDe = (f) => {
    const d = totales.get(f);
    if (!d) return null;
    if (modo === 'A') return d.A;
    if (modo === 'B') return d.B;
    if (d.A != null && d.B != null) return (d.A + d.B) / 2;
    return d.A != null ? d.A : d.B;
  };
  // promedio por empalme de cada pelo
  const promedioDe = (f) => {
    const vs = [];
    for (const emp of empalmes)
      for (const p of valorEvento(valores, f, emp.n, modo)) vs.push(p.v);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  };

  const tot = pelosOrden.map(totalDe).filter((v) => v != null);
  const maxTot = Math.max(teorica || 0, ...tot, 1) * 1.12;
  const proms = pelosOrden.map(promedioDe).filter((v) => v != null);
  const maxProm = Math.max(umbral * 1.6, ...proms, 0.1) * 1.12;

  const anchoBloque = (der - izq) / 2 - 30;
  const x1 = izq;
  const x2 = izq + anchoBloque + 60;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#1f4e79';
  ctx.font = 'bold 14px Arial';
  ctx.fillText('Pérdida total del tramo por pelo (dB)', x1, rArriba - 18);
  ctx.fillText('Promedio por empalme de cada pelo (dB)', x2, rArriba - 18);

  const barras = (x0, ancho, valorDe, maximo, limite, textoLimite) => {
    // eje y referencia
    ctx.strokeStyle = '#e3e7ec';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const x = x0 + (ancho / 4) * i;
      ctx.beginPath();
      ctx.moveTo(x, rArriba - 6);
      ctx.lineTo(x, rAbajo + 4);
      ctx.stroke();
      ctx.fillStyle = '#98a2ae';
      ctx.font = '9px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(((maximo / 4) * i).toFixed(2).replace('.', ','), x, rAbajo + 16);
    }
    for (const f of pelosOrden) {
      const v = valorDe(f);
      const y = filaR(f) - altoBarra / 2;
      const cortada = cortadas.has(f);
      ctx.fillStyle = cortada ? '#c62828' : '#5a6472';
      ctx.font = cortada ? 'bold 10px Arial' : '10px Arial';
      ctx.textAlign = 'right';
      ctx.fillText('F' + String(f).padStart(2, '0'), x0 - 6, y + altoBarra - 1);
      if (cortada) {
        ctx.fillStyle = 'rgba(198,40,40,0.18)';
        ctx.fillRect(x0, y, ancho, altoBarra);
        ctx.fillStyle = '#c62828';
        ctx.font = 'bold 9px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('CORTADA — no se puede comparar contra el At del tramo',
                     x0 + 4, y + altoBarra - 1);
        continue;
      }
      if (v == null) continue;
      const w = Math.max(1, (v / maximo) * ancho);
      ctx.fillStyle = limite != null && v > limite ? COLORESGr.ALTA : '#2e5fa3';
      ctx.fillRect(x0, y, w, altoBarra);
      ctx.fillStyle = '#1c2430';
      ctx.font = 'bold 9px Arial';
      ctx.textAlign = 'left';
      ctx.fillText(v.toFixed(3).replace('.', ','), x0 + w + 4, y + altoBarra - 1);
    }
    if (limite != null && limite <= maximo) {
      const x = x0 + (limite / maximo) * ancho;
      ctx.save();
      ctx.strokeStyle = '#c62828';
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, rArriba - 6);
      ctx.lineTo(x, rAbajo + 4);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#c62828';
      ctx.font = 'bold 9px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(textoLimite, x, rArriba - 12);
    }
  };

  barras(x1, anchoBloque, totalDe, maxTot, teorica,
         teorica ? `At teórico ${teorica.toFixed(2).replace('.', ',')}` : '');
  barras(x2, anchoBloque, promedioDe, maxProm, umbral,
         `umbral ${umbral.toFixed(2).replace('.', ',')}`);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#6b7480';
  ctx.font = '10px Arial';
  ctx.fillText('Barra roja: supera el límite. Los valores siguen el modo de vista '
    + 'elegido.', x1, rAbajo + 34);

  return canvas;
}

/** Solapa con el gráfico y la tabla de datos que lo respalda. */
function hojaGrafico(wb, imagenBase64, datos) {
  const { ordenes, umbral } = datos;
  const ws = wb.addWorksheet('GRÁFICO');
  ws.views = [{ showGridLines: false, state: 'normal' }];
  ws.getColumn(1).width = 3;
  [12, 14, 14, 12, 12, 26, 12].forEach((w, i) => { ws.getColumn(i + 2).width = w; });

  if (imagenBase64) {
    const id = wb.addImage({ base64: imagenBase64, extension: 'png' });
    ws.addImage(id, { tl: { col: 1, row: 1 }, ext: { width: 1180, height: 1196 } });
  }

  const inicio = 36;
  const cabecera = ['N° OT', 'Progresiva A', 'Progresiva B', 'Peor (dB)',
                    'Pelos afectados', 'Elemento más cercano', 'Prioridad'];
  cabecera.forEach((t, i) => {
    const c = ws.getCell(inicio, 2 + i);
    c.value = t;
    c.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  ordenes.forEach((o, i) => {
    const f = inicio + 1 + i;
    const valores = [o.n, Math.round(o.prog_a), Math.round(o.prog_b),
      Number(o.peor.toFixed(3)), o.pelos.length,
      o.elemento ? `${(TIPOS[o.elemento.tipo] || TIPOS.otro).etiqueta} `
        + `${milesGr(o.elemento.progresiva_m)} m` : 'sin elemento cerca',
      o.prioridad];
    valores.forEach((v, k) => {
      const c = ws.getCell(f, 2 + k);
      c.value = v;
      c.font = { name: 'Arial', size: 9,
                 bold: k === 6 || k === 3 };
      c.alignment = { horizontal: k === 5 ? 'left' : 'center', vertical: 'middle' };
      if (k === 3) c.numFmt = '0.000';
      if (k === 1 || k === 2) c.numFmt = '#,##0';
      if (o.prioridad === 'ALTA')
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
      else if (o.prioridad === 'MEDIA')
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF6E3' } };
    });
  });
  const nota = ws.getCell(inicio + ordenes.length + 2, 2);
  nota.value = 'Los datos de esta tabla son los que dibuja el gráfico. Si querés un '
    + 'gráfico nativo de Excel, seleccionalos e insertá un gráfico de dispersión.';
  nota.font = { name: 'Arial', size: 8, italic: true, color: { argb: 'FF6B7480' } };
  ws.mergeCells(inicio + ordenes.length + 2, 2, inicio + ordenes.length + 2, 8);

  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true,
                   fitToWidth: 1, fitToHeight: 0 };
  return ws;
}
const lic = { CLAVE_PUBLICA, codigoEquipo, leerLicencia, evaluar, fecha, guardar, guardada, borrar, pieLicencia };
const rep = { TABLA_PLIEGO, TIPOS, controlarConfiguracion, leerInfraestructura, botellasEsperadas, diagnosticar, ondaNominal, pelosConVentanasCruzadas, lecturasPorPunto, cruzarConAnterior, puntosVerificados, puntosDeCorte };
const motor = { coincidencia, detectarSentidos, sentidosPorTramo, corregirSentidosDelPar, detectarEmpalmes, armarMatriz, detectarCortadas, diagnosticarCortes, numeroDeFibra, sentidoDesdeTexto, separacionMinima, eventosUtiles, contrasteBotellas, compararPlanillas };


const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- licencia
let licencia = null;          // datos de la licencia vigente
let equipoId = '';

function pintarEstadoLicencia(estado) {
  if (!licencia) return;
  const base = `${licencia.n} · ${licencia.e} · vence ${lic.fecha(licencia.v)}`;
  const restan = estado && estado.dias != null ? estado.dias : null;
  $('estadoLicencia').textContent = estado && estado.gracia
    ? `${base} · VENCIDA, dentro de los días de gracia`
    : (restan != null && restan <= 30
        ? `${base} · quedan ${restan} día(s)`
        : base);
  $('estadoLicencia').style.color = estado && (estado.gracia || (restan != null
    && restan <= 30)) ? '#c62828' : '';
}

async function pedirLicencia(mensaje, tipo = 'mal') {
  equipoId = equipoId || await lic.codigoEquipo();
  $('codigoEquipo').value = equipoId;
  $('pantallaLicencia').classList.remove('oculto');
  $('avisoLicencia').innerHTML = mensaje
    ? `<div class="aviso ${tipo}" style="margin-top:12px">${mensaje}</div>` : '';
}

async function validar(cadena, guardar) {
  const datos = await lic.leerLicencia(cadena);      // lanza si la firma no sirve
  const estado = await lic.evaluar(datos, equipoId);
  if (!estado.ok) throw new Error(estado.motivo);
  licencia = datos;
  if (guardar) lic.guardar(cadena.trim());
  pintarEstadoLicencia(estado);
  return estado;
}

async function arrancarLicencia() {
  equipoId = await lic.codigoEquipo();
  const guardada = lic.guardada();
  if (!guardada) {
    await pedirLicencia('');
    return;
  }
  try {
    const estado = await validar(guardada, false);
    $('pantallaLicencia').classList.add('oculto');
    if (estado.gracia) alert(estado.motivo + ' Renová la licencia para seguir usándola.');
  } catch (e) {
    await pedirLicencia(e.message, 'mal');
  }
}

$('copiarCodigo').onclick = async () => {
  const texto = $('codigoEquipo').value;
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(texto);
    else throw new Error('sin portapapeles');
  } catch (e) {
    $('codigoEquipo').select();
    if (document.execCommand) document.execCommand('copy');
  }
};
$('activar').onclick = async () => {
  try {
    await validar($('claveLicencia').value, true);
    $('pantallaLicencia').classList.add('oculto');
  } catch (e) {
    $('avisoLicencia').innerHTML =
      `<div class="aviso mal" style="margin-top:12px">${e.message}</div>`;
  }
};
$('cambiarLicencia').onclick = async () => {
  lic.borrar();
  licencia = null;
  $('claveLicencia').value = '';
  await pedirLicencia('');
};
arrancarLicencia();
let archivos = [];
let libro = null;
let resultado = null;
let autocompletado = false;
let tramoCargado = '';
let nodosManual = false;
// logo de Trans Advanced Technologies, embebido: sale en la planilla sin
// tener que cargarlo cada vez. Se puede reemplazar desde el campo de arriba.
const LOGO_TRANS = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAOQAAABIBAMAAAAUp0QrAAAAMFBMVEX////+///+/v77/P7u8/i7y+J9l8MjhNwAfucAe+cAe+MAe+ImcsYnUpsCOowBKoMS25N/AAAKn0lEQVR42rVYfVBU1xX/vftWFqLAe4sxMc4+7u5mrI3ssuyzjpk0QqapJml1kibiaBONCbhKYvhoGxu0fmTSVqc1Io0YqFHjTCJqTJjYGWuCDqPpZ1xYWYRKsstjATHG3X2IH2vKvtc/gIXF1YXF3j/uvHPux++de+4593cv48Zti/ptTfj7vOQEyD1XZAC4oVcQf9Hwt2ngAz4pIIZbzwMAN5HhVZmHlsF4IG/X4P/SSSgCA1I/htxrxypqh0LdpmQnyVLrQaiHtfokkCy1fpyQyhmXqMojlUoVbm5vrQOIG0RwwOhRPETvMIJYHLDVjwtSOdObGbhVzVrBIU1kuL5r05ydi9SPaGfO5XOLvqJoWqR+ZHWOB/JMb6ocRR1yWGX45I7uVXuv2loN6j/msgdXfcx1W5jV5Yp9z3is/HdHVMTBksBPpY1LDG52TvaX/NT0nhnZE3e0JFZedkpxQ4ZcmfKdh5XZlc0X8pL3C5ewZf4DZSnpF5dOqB7P9jkRCxHNVaR9Yt0EDmAKapP3AaoT9pNK3JDf9ZIYo5j1Yuhz9nGdDKhXxJsAkvI9taPcPtEm358ee1jIpSk4fBAAFEiAh6s6lNeIeCG/M8gxhynQLynvXhyWjxXKusq5NF7IU6mjGXf1zeaHPuEGxYxd9oYrlIsTMtQuj2Ic00P/MGtI7Mo4tBhFcpyQjsxRDWTw4pknBjAY9rgVbXLcQeKKvXkQAFQ1Y+UWADKAgMrvnpBIn4lzYUMxBnAcAB4hoTitci0HhgcYXrH3VpV3n4ozx7rvnAbkFjsCN+2yLFXcUPcy8n/sciBol+sWU7Sm+EfnkpHdzkRFZD6QRppAJdBwTjV6ADYUny+VszFcaeIcIFk+CV5RdYo+b5ZPIlk+j4mDTxodJKNGypfrIhRhIrJTcuIuFY09Un55+KnFpNbi7peRxGndsKhkJr0nQ4UMYNSrNhorxciYyR5m5KTKQVLJcGFWQqgygG70jyL4CfXcAumI4DbDw5TZ/alNxkjOpXCDrKpnNOlGUW8lUJHL/OBTwbAwcYPQEgjIwWAwGAxrWc0pb+JFAKDPPRCMCcpovvjbxTtmH2HY8cP82RrFf6lzjCUDaeglcKPYKt+LkfC4yUP/PakjWjIRDG3GRgCMcZhSRwf8NiT014RCHhUrGPBCdL7Gv61jAJLpIf0YhMLo99pADCbBSwGj32sdrFlBojGzDxfuw3yujwbp+niVVgUE1+O1QD0ARSKeWZPqoEiqZu4psJ5ZkwZr6DuzT8c6SWQM/VV7NE+xRDjZs5CSzoJDTfuw5hlKNM1K7mdH8tiEptmtRxZSfe5nRxYa+mvS1XrkxdhWDu2TQPT8flPZzHEwl63+dVExSeU6SPqU6lXadxtchuotb7yTeaVybeKHyaR6lfbDSZbs+4veGMPNK/qxoDe3CfKvLIby/D17L6GtwpI+7asnW6o0JXpX4u92O+sCz1+v0hQvSG2uYl9aeG77z2qkYzEgY8aZTvdHnd/AewWnGJJwUddDjWUX1onJZRyCu8UGKPw6MbSWLVr/o8DGt54KHhVPjsHK29w6izbXNzEye/NsyAY0aM1KYUkdwGQCqslphGbjcz6vU1NVA7TqbP70BtN4IUmncPVxRpv9pZruUQCLl/5lxinrvTOKyGYwEiQwqX4JJsKtBLQ841cgjReSIfzngJyC/qlCZRxRmXOtN7YmDe8lEWYtAIlTxnZxj1rSpykFwBv8YHi1Vbg9mRkJj0nLhw5BTqZEmU2B5HTcBUjF2FIF3PztB4zBrQDsX3njNoV/JS0t/IjSrpOvuDU9Vl+jpW7hZAKKMSS86Ixym81o8+tUbZvYxAFqYqHU8yKBYzCe+3YIaZYFy7x61tK8IqBrz5LGC9lbJPs9Z48nqN4VjifSERLaZ5xO3cc75m0anK5tp6Op3L+9ItS0Gv/ULnAsGefCsl7BK0FV2Z9u2JdUehZI3vE67fHvS9o8CMkcu9QcnHKUbP7oyowf6kuOFK0ed1yuOgsoBjs5wBWXXpdltKwPeTu54l9cuEctVIFCdaZ9F35ihn1XylKnUqEU/nKKfGe6xb0SZlvJW6U7MCzqtTQOhgDtMIe/QRRW71WIwpobBcnqGtYSpy+JDQAgUq/VZTFRwGQFvOZGi4kSG0BsUEx6VoBi0rssElxmlyDiLlkJJn2olQjDe+pSpLAusiU+Xw69Yg6bS4mY1+8f0ikSxhskd4c6j82XWRhJ3dnMW18LWXPkBcaU7Iw/4TluPcqjvE+GRlyZ3PFbSdgVAIBLQ+SPsMv3jIwDOl2/V7m9PCZIhqkEAKzghql27L2lX9LmCB03tXhvvFaqSi4SK5fj2xiERZXv2vZRlMNYoB4GTEYmJIFYZe4sAFtPSDKF0gJcPYhV5vv9LQZ4nwQ2U+Z6cGGDAjHAu2XGFuB9cexYEbIbIIClHjB1wNygErhZCaCSUA9YZQCsAyAg+sHNpXMARpl3AISMccf6AKcjNM/dPJeSpjVf50nAuVeb51pzH81153nZzufd+Y0AkJzrzrfQlK41X+fN/mLey8Sf6873GwK57nxLPNmHdDV0J+00C3PLnJVf/x0Fr+neeX4qDrRXevz6951V/3UCzPXqttJrFsNy+45K77WpxXunVNeXqu/94MDq0mvxZB/L0gsPTb8/p6vs2Vkl7yBppWmZwYldz073CpryPHHZTieQvLrZtPj7WR2/f+hPKyZkqEhfsnLW/PLMh/OqphvjgezdtE6cWSLM0R7N2iUj+IjpOAO8/mlGGRrv2y8eCOYAVze8Kl4q0c/3s2I1D6Dz7XrxnvO0qE2ctiyehfUKNUBK+Xa3uSF9rkbt7TUB8FmIzMz3U4f1TU4BSTodssmbfhOwDoRvsB4o42TTe6wUDySjLgISJ+NtqF5DB6gkASBQAF0gAALOjwSVugOByeeNDiwIUEDLLAK4Z8r2kK9Ox3V4kUoA17keQJHYAULen9FCKX5FZgAGbVBVeL7J79m6noOKxEoAjR9urGopjQsymAtAMROAWF2RP8OAcD2ACt4HBn2b9kkX9gtgcCMXQN/MXOPWnfFAqqgFAP2KegiOhIh3Wh3Tb+53jAzCByZsmXfZafMDN/uHEOGMfCwuyItPd6DxEf+DLvFs/vsRjIBvF50flwCqFmKI2zaH47nJtVZA1abR0L0K/4nY6o0nSDJ2vOVwFNDjUx91PFkW0fKvxAUO9v4aQPC+4Di3Qer+5tDhg3kyIHQsdDRVkYOPOrpSRloZfprsuz1k4/XtK7XbfpxRUrFp688jrvwzSyoSttZTwP1aTUJS8LR4YzGnfXcWg9BrNRMS7/OUVGycGhwBebl2yGG3OYEkqJeWlyv2OsZVWN1ylJWgqhIUGbLCXqkoPNjyKqeCHCuq7C4wP1xaA00J9W/v6Cyq9C8NVRQe6i4Y8VI5jHU6oiOmZZ6Esf0x9QT1CpO5Wqsr+yTYnBOzLkt4cJLT2pRzuVFhzU7a8Vjfaf2J2RSh7PaOkJN25vSdDlmbcvpOxUfSrIANYIGR93KWgu1/17KCUGvD04DGnTMgW4eax1Y4ADD2z2sEQAFwIAM0nAw+tDFGCsMLffmL1nSR/gYarv+PhdGs8fubc0ag/A8ziUc7PagXygAAAABJRU5ErkJggg==';
let logos = { empresa: LOGO_TRANS };
let previa = null;
let previaRep = null;

function leerLineas(id) {
  return $(id).value.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(',').map((x) => x.trim()));
}

function leerEpis() {
  return leerLineas('epis').map((c, i) => ({
    orden: i + 1, nombre: c[0] || `EPI ${i + 1}`,
    progresiva_m: c[1] === undefined || c[1] === '' ? null : parseFloat(c[1]),
    buffersEntrada: c[2] ? parseInt(c[2], 10) : null,
    buffersSalida: c[3] ? parseInt(c[3], 10) : null,
    observaciones: c.slice(4).join(', '),
  }));
}

function leerBotellas() {
  return leerLineas('botellas').map((c, i) => ({
    n: i + 1, progresiva_m: parseFloat(c[0]),
    tipo: c[1] || 'paso', motivo: c.slice(2).join(', '), epi: '',
  })).filter((b) => !isNaN(b.progresiva_m));
}

function leerConfig() {
  const num = (id) => parseFloat($(id).value) || 0;
  return {
    traza: $('traza').value,
    logos,
    aprobacion: { responsable: $('aprobadoPor').value, cargo: $('cargo').value,
                  operador: $('operador').value },
    pieLicencia: lic.pieLicencia(licencia),
    epis: leerEpis(),
    botellas: leerBotellas(),
    estructura: { fibrasTotales: num('pelos'), fibrasPorTubo: num('porTubo'),
                  atProm: $('atProm').value },
    tiposFibra: [
      { tipo: $('t1tipo').value, desde: num('t1desde'), hasta: num('t1hasta') },
      { tipo: $('t2tipo').value, desde: num('t2desde'), hasta: num('t2hasta') },
    ].filter((t) => t.tipo && t.hasta),
    registro: {
      tipoFibra: '', nodoA: $('nodoA').value, nodoB: $('nodoB').value,
      cable: $('cable').value, contratista: $('contratista').value,
      tramo: $('tramo').value, seccion: $('tramo').value,
    },
    // Ne declarado a mano: manda sobre los eventos detectados en el cálculo
    // teórico. Sirve cuando el instrumento marca eventos que no son botellas
    // (macrocurvaturas, estrangulamientos) o cuando faltan por no detectarse.
    neManual: parseInt($('ne').value, 10) || null,
    largoBobina: parseInt($('largoBobina').value, 10) || 4000,
    pasoReserva: parseInt($('pasoReserva').value, 10) || 1000,
    parametros: {
      umbralEmpalmeDb: num('umbral'), atenuacionDbKm: num('a'),
      perdidaEmpalmeDb: num('ae'), cantidadConectores: num('nc'),
      perdidaConectorDb: num('ac'), longitudOndaNm: num('onda'),
      eventoMinimoDb: num('minimo'),
      separacionFijaM: $('sep').value ? parseFloat($('sep').value) : null,
    },
  };
}

async function expandir(lista) {
  const salida = [];
  for (const f of lista) {
    if (/\.zip$/i.test(f.name)) {
      // se pasa el contenido, no el File: funciona igual con Blob o con buffer
      const zip = await JSZip.loadAsync(
        typeof f.arrayBuffer === 'function' ? await f.arrayBuffer() : f);
      const entradas = Object.keys(zip.files)
        .filter((n) => !zip.files[n].dir && /\.m?sor$/i.test(n));
      // si adentro hay carpetas de los dos sentidos, conviene descomprimir
      const sentidos = new Set(entradas
        .map((n) => motor.sentidoDesdeTexto(n.split('/').slice(0, -1).join(' ')))
        .filter(Boolean));
      const mezclado = sentidos.size > 1;
      for (const nombre of entradas)
        salida.push({ nombre, mezclado,
                      buffer: await zip.files[nombre].async('arraybuffer') });
    } else if (/\.m?sor$/i.test(f.name)) {
      salida.push({ nombre: f.name, buffer: await f.arrayBuffer() });
    }
  }
  return salida;
}

/**
 * Revisa el conjunto de archivos subidos y devuelve las inconsistencias:
 * repetidos, longitudes fuera de lugar, pulsos o longitudes de onda mezclados,
 * tramos distintos y perdidas de tramo que no coinciden con el resumen del .sor.
 */
function revisarArchivos() {
  const avisos = [];
  const mediana = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };

  // dos archivos con el mismo nombre en carpetas distintas no son el mismo
  // el mismo nombre en los dos sentidos es la ida y la vuelta, no un duplicado
  const nombres = new Map();
  archivos.forEach((m) => {
    const k = `${m.ruta || m.archivo}|${m.sentido || '?'}`;
    nombres.set(k, (nombres.get(k) || 0) + 1);
  });
  const repetidosNombre = [...nombres].filter(([, n]) => n > 1)
    .map(([k]) => k.split('|')[0]);
  if (repetidosNombre.length)
    avisos.push(`Archivos subidos dos veces: ${repetidosNombre.join(', ')}.`);

  const pares = new Map();
  archivos.forEach((m) => {
    const k = `${m.numero}|${m.sentido}|${m.onda || 1550}`;
    pares.set(k, (pares.get(k) || 0) + 1);
  });
  const dobles = [...pares].filter(([, n]) => n > 1)
    .map(([k]) => { const [p, sen, onda] = k.split('|');
      return `pelo ${p} en ${sen === 'B' ? 'B→A' : 'A→B'} a ${onda} nm`; });
  if (dobles.length)
    avisos.push(`Dos mediciones para el mismo pelo y sentido: ${dobles.join(', ')}. `
      + 'Se toma una sola: revisá cuál corresponde.');

  for (const sentido of ['A', 'B']) {
    const grupo = archivos.filter((m) => m.sentido === sentido && m.longitud_m);
    if (grupo.length < 3) continue;
    const med = mediana(grupo.map((m) => m.longitud_m));
    const raros = grupo.filter((m) => Math.abs(m.longitud_m - med) > med * 0.02);
    if (raros.length)
      avisos.push(`Longitud óptica fuera de lugar en ${sentido === 'B' ? 'B→A' : 'A→B'}: `
        + raros.slice(0, 6).map((m) => `${m.archivo} (${(m.longitud_m / 1000).toFixed(3)} km`
          + ` contra ${(med / 1000).toFixed(3)})`).join(', ')
        + '. Suele ser que el equipo no encontró el fin de fibra.');
  }

  const pulsos = [...new Set(archivos.map((m) => m.pulsoNs).filter(Boolean))];
  if (pulsos.length > 1)
    avisos.push(`Hay mediciones con pulsos distintos: ${pulsos.join(' y ')} ns.`);
  const ondas = [...new Set(archivos.map((m) => Math.round(m.longitudOnda || 0))
    .filter(Boolean))];
  if (ondas.length > 1)
    avisos.push(`Hay mediciones a longitudes de onda distintas: ${ondas.join(' y ')} nm.`);

  const tramos = new Map();
  archivos.forEach((m) => {
    const t = m.tramo || {};
    if (!t.nodoA || !t.nodoB) return;
    const k = [t.nodoA, t.nodoB].sort().join(' / ');
    tramos.set(k, (tramos.get(k) || 0) + 1);
  });
  if (tramos.size > 1)
    avisos.push('Hay archivos de tramos distintos: '
      + [...tramos].map(([k, n]) => `${k} (${n})`).join(', ') + '.');

  const zonaContraria = archivos.filter((m) => m.zona && m.sentidoArchivo
    && m.sentidoArchivo !== m.zona);
  if (zonaContraria.length)
    avisos.push(`${zonaContraria.length} archivo(s) cargados en `
      + `${zonaContraria[0].zona === 'A' ? 'A→B' : 'B→A'} dicen lo contrario en su `
      + 'nombre o en sus nodos. Se respeta la zona donde los soltaste: revisá si '
      + 'están en la correcta. Ej.: '
      + zonaContraria.slice(0, 3).map((m) => m.archivo).join(', '));

  // un ZIP con los dos sentidos adentro no se puede repartir solo
  const mezclados = archivos.filter((m) => m.zipMezclado);
  if (mezclados.length)
    avisos.push('El ZIP trae los dos sentidos adentro. Descomprimilo y cargá cada '
      + 'sentido en su recuadro, así queda claro cuál es cuál.');

  const topePelos = maxPelos();
  const largosTodos = archivos.map((m) => m.longitud_m).filter(Boolean)
    .sort((a, b) => a - b);
  if (largosTodos.length >= 2) {
    const L = largosTodos[Math.floor(largosTodos.length * 0.75)];
    const cortados = motor.diagnosticarCortes(archivos, L);
    if (cortados.length)
      avisos.push(`${cortados.length} pelo(s) no llegan de punta a punta: `
        + cortados.slice(0, 6).map((c) => `pelo ${c.pelo} — ${c.texto}`).join(' ')
        + (cortados.length > 6 ? ' …' : ''));
  }

  const discordantes = archivos.filter((m) => !m.peloManual && m.peloPorNombre != null
    && m.peloPorId != null && m.peloPorNombre !== m.peloPorId
    && m.peloPorId >= 1 && m.peloPorId <= topePelos);
  if (discordantes.length)
    avisos.push(`${discordantes.length} archivo(s) donde el número de pelo del nombre `
      + 'no coincide con el que grabó el equipo. Se usa el del nombre. Ej.: '
      + discordantes.slice(0, 3).map((m) => `${m.archivo} → ${m.peloPorNombre} `
        + `(el equipo grabó ${m.peloPorId})`).join('; '));

  const desviadas = archivos.filter((m) => m.perdidaResumen != null
    && m.perdidaCalculada != null
    && Math.abs(m.perdidaResumen - m.perdidaCalculada)
       > Math.max(0.5, m.perdidaResumen * 0.1));
  if (desviadas.length)
    avisos.push(`${desviadas.length} medición(es) donde la pérdida del resumen del `
      + 'equipo no coincide con la suma de la tabla de eventos. Se está usando '
      + `${$('origenPerdida').value === 'tabla' ? 'la suma de la tabla' : 'el resumen'}`
      + ': revisá cuál corresponde en el campo "Pérdida de tramo". Ej.: '
      + desviadas.slice(0, 3).map((m) => `${m.archivo}: resumen `
        + `${m.perdidaResumen.toFixed(3)} contra tabla `
        + `${m.perdidaCalculada.toFixed(3)} dB`).join('; '));
  return avisos;
}

/** 1,2,3,7,8 -> "1 a 3, 7 y 8": la lista completa sin ocupar diez renglones. */
function rangos(ns) {
  if (!ns.length) return '';
  const partes = [];
  let ini = ns[0];
  let prev = ns[0];
  for (let i = 1; i <= ns.length; i++) {
    const n = ns[i];
    if (n === prev + 1) { prev = n; continue; }
    partes.push(ini === prev ? `${ini}`
      : (prev === ini + 1 ? `${ini}, ${prev}` : `${ini} a ${prev}`));
    ini = n;
    prev = n;
  }
  if (partes.length === 1) return partes[0];
  return partes.slice(0, -1).join(', ') + ' y ' + partes[partes.length - 1];
}

/** Qué pelos hay y cuáles no, por sentido. */
function resumenPelos() {
  const tope = maxPelos();
  for (const [z, id] of [['A', 'cuentaA'], ['B', 'cuentaB']]) {
    const deZona = archivos.filter((m) => m.sentido === z);
    const pelos = [...new Set(deZona.map((m) => m.numero)
      .filter((n) => n >= 1 && n <= tope))].sort((x, y) => x - y);
    if (!deZona.length) { $(id).textContent = ''; continue; }
    if (!pelos.length) {
      $(id).textContent = `${deZona.length} archivo(s) · sin número de pelo`;
      continue;
    }
    const faltan = [];
    for (let n = 1; n <= tope; n++) if (!pelos.includes(n)) faltan.push(n);
    const rango = `pelos ${pelos[0]} a ${pelos[pelos.length - 1]}`;
    $(id).innerHTML = `${deZona.length} archivo(s) · ${pelos.length} pelo(s) · ${rango}`
      + (faltan.length
        ? `<br><span style="font-weight:400">sin medir (${faltan.length}): `
          + `${rangos(faltan)} · pueden estar en servicio</span>`
        : '<br><span style="font-weight:400">no falta ninguno</span>');
  }
}

function pintarListado(errores = []) {
  $('limpiar').classList.toggle('oculto', !archivos.length);
  for (const [z, idC, idN, idV] of
       [['A', 'cuentaA', 'nodosA', 'vaciarA'], ['B', 'cuentaB', 'nodosB', 'vaciarB']]) {
    const n = archivos.filter((m) => m.sentido === z).length;
    $(idC).textContent = n ? `${n} archivo(s)` : '';
    $(idV).classList.toggle('oculto', !archivos.some((m) => m.zona === z));
  }
  pintarNodosZonas();
  resumenPelos();
  actualizarVisor();
  if (errores.length)
    $('salida').innerHTML = errores
      .map((e) => `<div class="aviso mal">No se pudo leer ${escHtml(e)}</div>`).join('');
  if (!archivos.length) {
    $('listado').classList.add('oculto');
    $('resumenArchivos').textContent = '';
    estadoCarga();
    return;
  }
  const tope = maxPelos();
  // nombres que aparecen más de una vez: se muestran con su carpeta
  const cuentaBase = new Map();
  archivos.forEach((m) => {
    const k = `${m.archivo}|${m.sentido || '?'}`;
    cuentaBase.set(k, (cuentaBase.get(k) || 0) + 1);
  });
  const baseRepetida = new Set([...cuentaBase].filter(([, n]) => n > 1)
    .map(([k]) => k.split('|')[0]));
  const repetidos = new Set();
  const vistos = new Set();
  archivos.forEach((m) => {
    const clave = `${m.numero}|${m.sentido}|${m.onda || 1550}`;
    if (vistos.has(clave)) repetidos.add(clave);
    vistos.add(clave);
  });
  const nombresVistos = new Map();
  archivos.forEach((m) => {
    const k = `${m.ruta || m.archivo}|${m.sentido || '?'}`;
    nombresVistos.set(k, (nombresVistos.get(k) || 0) + 1);
  });
  const medianaPorSentido = {};
  for (const sen of ['A', 'B']) {
    const largos = archivos.filter((m) => m.sentido === sen && m.longitud_m)
      .map((m) => m.longitud_m).sort((x, y) => x - y);
    medianaPorSentido[sen] = largos.length ? largos[Math.floor(largos.length / 2)] : null;
  }
  // que tiene de malo cada medicion, si es que tiene algo
  const problema = (m) => {
    if (m.numero == null) return 'sin número de pelo';
    if (m.numero < 1 || m.numero > tope) return `pelo fuera de 1 a ${tope}`;
    if (nombresVistos.get(`${m.ruta || m.archivo}|${m.sentido || '?'}`) > 1)
      return 'archivo repetido';
    if (repetidos.has(`${m.numero}|${m.sentido}|${m.onda || 1550}`))
      return 'pelo, sentido y ventana repetidos';
    const med = medianaPorSentido[m.sentido];
    if (med && Math.abs(m.longitud_m - med) > med * 0.02) return 'longitud fuera de lugar';
    return '';
  };

  const filas = archivos.map((m, i) => {
    const mal = problema(m);
    return `<tr class="${m.sentido === 'B' ? 'filaB' : 'filaA'}"${
      mal ? ' style="background:#fdecea"' : ''} title="${mal}">
      <td>${(baseRepetida.has(m.archivo) && m.carpeta)
        ? `<span style="color:#6b7480">${escHtml(m.carpeta)}/</span>${escHtml(m.archivo)}`
        : escHtml(m.archivo)}${mal ? ` <span class="pill b">${mal}</span>` : ''}</td>
      <td><input class="pelo" data-i="${i}" type="number" min="1" value="${m.numero ?? ''}"
        style="width:62px;padding:2px 4px;font-size:12px${m.numero == null
          || m.numero > tope ? ';background:#fdecea;border-color:#c62828' : ''}"
        title="${m.peloManual ? 'cargado a mano'
          : (m.peloDesde || 'nombre del archivo')}"></td>
      <td>${m.peloPorId != null && m.peloPorId !== m.numero && !m.peloManual
        && m.peloPorId >= 1 && m.peloPorId <= tope
        ? `<span class="pill b" title="el archivo tiene grabado el pelo ${m.peloPorId}">≠${m.peloPorId}</span>`
        : ''}</td>
      <td>${m.onda || 1550}</td>
      <td><select data-i="${i}" class="sentido" style="padding:2px 4px;font-size:12px;width:auto">
        <option value="A"${m.sentido === 'A' ? ' selected' : ''}>A→B</option>
        <option value="B"${m.sentido === 'B' ? ' selected' : ''}>B→A</option>
      </select>${m.corregido && !m.manual
        ? ' <span class="pill b" title="estaban los dos en el mismo sentido: se corrigió por la geometría de la traza">corregido</span>'
        : ''}${m.manual ? '' : (m.porTramo
        ? ' <span class="pill" title="por el nombre del archivo">nombre</span>'
        : (m.deducido ? ' <span class="pill b" title="deducido por la traza">auto</span>' : ''))}</td>
      <td>${m.eventos.length}</td>
      <td>${(m.longitud_m / 1000).toFixed(3)} km</td>
      <td>${m.perdidaTotal?.toFixed(3) ?? '-'} dB</td>
      <td><button class="quitar" data-i="${i}" title="Quitar esta medición"
        style="background:none;border:0;color:#c62828;font-size:16px;cursor:pointer;
        padding:0 6px;width:auto">&times;</button></td></tr>`;
  }).join('');
  $('listado').innerHTML = `<table><thead><tr><th>Archivo</th><th>Pelo</th>
      <th></th><th>λ nm</th><th>Sentido</th><th>Eventos</th><th>Longitud</th><th>Pérdida</th>
      <th></th></tr></thead>
      <tbody>${filas}</tbody></table>`;
  $('listado').classList.remove('oculto');
  const sinPelo = archivos.filter((m) => m.numero == null || m.numero < 1
    || m.numero > tope).length;
  const a = archivos.filter((m) => m.sentido === 'A').length;
  const b = archivos.filter((m) => m.sentido === 'B').length;
  const sin = archivos.length - a - b;
  $('resumenArchivos').textContent =
    `${archivos.length} mediciones · ${a} en A→B · ${b} en B→A`
    + (sin ? ` · ${sin} sin sentido asignado` : '')
    + (repetidos.size ? ` · ${repetidos.size} pelo(s) repetidos en el mismo sentido` : '')
    + (sinPelo ? ` · ${sinPelo} sin número de pelo válido (corregilo en la columna Pelo)` : '');
  $('invertir').classList.toggle('oculto', !archivos.length);
  $('invertir').onclick = () => {
    archivos.forEach((m) => {
      m.sentido = m.sentido === 'A' ? 'B' : 'A';
      if (m.zona) m.zona = m.zona === 'A' ? 'B' : 'A';
      m.manual = true;
    });
    const a = $('nodoA').value;
    $('nodoA').value = $('nodoB').value;
    $('nodoB').value = a;
    if (!tramoManual && $('nodoA').value && $('nodoB').value)
      $('tramo').value = `${$('nodoA').value} / ${$('nodoB').value}`;
    pintarListado();
  };
  const conProblema = archivos.filter((m) => problema(m)).length;
  $('quitarMalos').classList.toggle('oculto', !conProblema);
  $('quitarMalos').textContent = `Quitar los ${conProblema} marcados`;
  $('quitarMalos').onclick = () => {
    archivos = archivos.filter((m) => !problema(m));
    pintarListado();
  };
  $('listado').querySelectorAll('button.quitar').forEach((btn) => {
    btn.onclick = () => {
      archivos.splice(+btn.dataset.i, 1);
      pintarListado();
    };
  });
  $('listado').querySelectorAll('input.pelo').forEach((inp) => {
    inp.onchange = () => {
      const n = parseInt(inp.value, 10);
      archivos[+inp.dataset.i].numero = Number.isFinite(n) ? n : null;
      archivos[+inp.dataset.i].fibra = archivos[+inp.dataset.i].numero;
      archivos[+inp.dataset.i].peloManual = true;
      pintarListado();
    };
  });
  const avisos = revisarArchivos();
  if (repartoMixto) {
    const { a, b, sin } = repartoMixto;
    avisos.unshift(`Reparto automático: ${a} archivo(s) a A→B y ${b} a B→A`
      + (sin ? `. ${sin} no decían el sentido en el nombre: se asignaron por la `
        + 'geometría de la traza y quedaron marcados "auto" en la tabla. Revisalos '
        + 'o movelos al recuadro que corresponda.' : '. Ninguno quedó sin clasificar.'));
    repartoMixto = null;
  }
  if (avisos.length)
    $('salida').innerHTML = avisos.map((a) => `<div class="aviso ${
      a.startsWith('Reparto') ? 'info' : 'mal'}">${escHtml(a)}</div>`).join('');
  $('listado').querySelectorAll('select.sentido').forEach((sel) => {
    sel.onchange = () => {
      archivos[+sel.dataset.i].sentido = sel.value;
      archivos[+sel.dataset.i].manual = true;
      pintarListado();
    };
  });
  estadoCarga();
  window.archivos = archivos;
}

let tramoManual = false;
$('tramo').addEventListener('input', () => { tramoManual = true; });
const sincronizarTramo = () => {
  pintarNodosZonas();
  if (tramoManual) return;
  const a = $('nodoA').value.trim();
  const b = $('nodoB').value.trim();
  if (a && b) $('tramo').value = `${a} / ${b}`;
};
$('nodoA').addEventListener('input', sincronizarTramo);
$('nodoB').addEventListener('input', sincronizarTramo);
$('nodoA').addEventListener('change', () => { nodosManual = true; pintarNodosZonas(); });
$('nodoB').addEventListener('change', () => { nodosManual = true; pintarNodosZonas(); });

const maxPelos = () => parseInt($('pelos').value, 10) || 96;

/**
 * El número de pelo sale del nombre del archivo. Solo si los nombres no dan
 * ningún número, o dan todos el mismo, se recurre al "ID de fibra" del equipo.
 */
/** Pasos que siguen a leer los archivos: pelo, nodos y sentidos. */
function finalizarCarga(errores = []) {
  resolverPelos();
  autocompletar();
  // 1) los nodos que declara cada .sor: Garabato→Los Amores vs Los Amores→Garabato
  const previos = archivos.map((m) => m.sentido);
  archivos.forEach((m) => { if (!m.manual) m.porTramo = false; });
  const orientacion = ($('nodoA').value.trim() && $('nodoB').value.trim())
    ? `${$('nodoA').value.trim().toUpperCase()}|${$('nodoB').value.trim().toUpperCase()}`
    : null;
  const porTramo = sentidosPorTramo(archivos.filter((m) => !m.manual), orientacion);
  // 2) lo que quede sin sentido se deduce por correlacion geometrica
  if (archivos.some((m) => !m.sentido && !m.manual)) detectarSentidos(archivos);
  // 3) si un pelo quedo con sus dos mediciones en el mismo sentido, se revisa
  //    cual encaja mejor espejada: son ida y vuelta, no dos idas
  const largos = archivos.map((m) => m.longitud_m).filter(Boolean).sort((a, b) => a - b);
  const corregidas = largos.length
    ? corregirSentidosDelPar(archivos, largos[Math.floor(largos.length / 2)]) : 0;
  if (corregidas) archivos.forEach((m) => { if (m.corregido) m.deducido = true; });
  archivos.forEach((m, i) => { m.deducido = !previos[i] && !m.porTramo; });
  pintarListado(errores);
}

function resolverPelos() {
  const auto = archivos.filter((m) => !m.peloManual);
  if (!auto.length) return;
  const porNombre = new Set(auto.map((m) => m.peloPorNombre).filter((n) => n != null));
  const porId = new Set(auto.map((m) => m.peloPorId).filter((n) => n != null));
  const usarId = porNombre.size === 0
    || (auto.length >= 3 && porNombre.size === 1 && porId.size > 1);
  auto.forEach((m) => {
    const n = usarId ? (m.peloPorId ?? m.peloPorNombre)
                     : (m.peloPorNombre ?? m.peloPorId);
    if (n == null) return;            // sin candidato, se deja lo que ya tenía
    m.numero = n;
    m.fibra = n;
    m.peloDesde = usarId ? 'ID del equipo' : (m.peloPorNombre != null
      ? 'nombre del archivo' : 'ID del equipo');
  });
}

/** Los recuadros muestran siempre los nodos que están cargados arriba. */
function pintarNodosZonas() {
  const a = $('nodoA').value.trim();
  const b = $('nodoB').value.trim();
  $('nodosA').textContent = a && b ? `${a} → ${b}` : '';
  $('nodosB').textContent = a && b ? `${b} → ${a}` : '';
}

function autocompletar() {
  if (!archivos.length) return;
  // si los archivos son de otro tramo, se vuelve a completar salvo edición manual
  const refA0 = archivos.find((m) => m.tramo && m.tramo.nodoA && m.tramo.nodoB);
  const clave = refA0 ? `${refA0.tramo.nodoA}|${refA0.tramo.nodoB}` : '';
  if (autocompletado && clave === tramoCargado) return;
  if (nodosManual) { tramoCargado = clave; pintarNodosZonas(); return; }
  tramoCargado = clave;
  const refA = archivos.find((m) => m.sentido === 'A' && m.tramo
    && m.tramo.nodoA && m.tramo.nodoB) || archivos[0];
  const { nodoA, nodoB } = refA.tramo || {};
  if (!nodoA || !nodoB) { pintarNodosZonas(); return; }
  $('nodoA').value = nodoA;
  $('nodoB').value = nodoB;
  if (!tramoManual) $('tramo').value = `${nodoA} / ${nodoB}`;
  autocompletado = true;
  pintarNodosZonas();
}

let tipoPlanilla = 'final';
let colaCarga = Promise.resolve();
let cargando = 0;

function estadoCarga(texto) {
  $('generar').disabled = cargando > 0 || !archivos.length;
  $('generar').textContent = cargando > 0 ? 'Leyendo archivos…'
    : (tipoPlanilla === 'reparacion' ? 'Generar planilla de reparación'
                                     : 'Generar planilla final');
  if (texto) $('resumenArchivos').textContent = texto;
}

/** Encola la carga: dos tandas seguidas no se pisan entre si. */
function cargar(lista, zona) {
  cargando += 1;
  estadoCarga('Leyendo archivos…');
  colaCarga = colaCarga.then(() => cargarAhora(lista, zona)).catch((e) => {
    console.error(e);
    $('salida').innerHTML =
      `<div class="aviso mal">Error al leer los archivos: ${e.message}</div>`;
  }).finally(() => {
    cargando -= 1;
    estadoCarga();
  });
  return colaCarga;
}

async function cargarAhora(lista, zona) {
  const erroresCarga = [];
  const crudos = await expandir(lista);
  let leidos = 0;
  for (const { nombre, buffer, mezclado } of crudos) {
    leidos += 1;
    if (leidos % 10 === 0)
      estadoCarga(`Leyendo archivos… ${leidos} de ${crudos.length}`);
    try {
      const t = parseSOR(buffer);
      const base = nombre.split('/').pop();
      const carpeta = nombre.includes('/') ? nombre.split('/').slice(-2)[0] : '';
      archivos.push({
        archivo: base,
        ruta: nombre,
        carpeta,
        zona,
        zipMezclado: !!mezclado,
        // el sentido lo declara la zona donde se soltó el archivo
        sentidoZona: zona || null,
        // el nombre del archivo manda: es lo que el técnico controla.
        // El "ID de fibra" que graba el equipo queda como respaldo.
        numero: motor.numeroDeFibra(base, t.gen.fibra, maxPelos()),
        fibra: motor.numeroDeFibra(base, t.gen.fibra, maxPelos()),
        peloPorId: motor.numeroDeFibra(t.gen.fibra, '', maxPelos()),
        peloPorNombre: motor.numeroDeFibra(base, '', maxPelos()),
        sentido: zona || motor.sentidoDesdeTexto(
          `${carpeta} ${base} ${t.gen.ubicacionA} ${t.gen.ubicacionB}`),
        manual: !!zona,
        repartido: !zona,
        sentidoArchivo: motor.sentidoDesdeTexto(
          `${carpeta} ${base} ${t.gen.ubicacionA} ${t.gen.ubicacionB}`),
        eventos: t.eventos, longitud_m: t.longitud_m,
        // por defecto se usa la perdida del resumen del equipo, que es la que
        // figura en el informe del OTDR. Se puede recalcular desde la tabla de
        // eventos cuando el operador midio entre marcadores.
        perdidaTotal: $('origenPerdida').value === 'tabla'
          ? (t.perdidaTramo != null ? t.perdidaTramo : t.resumen.perdidaTotal)
          : (t.resumen.perdidaTotal != null ? t.resumen.perdidaTotal : t.perdidaTramo),
        perdidaResumen: t.resumen.perdidaTotal,
        perdidaCalculada: t.perdidaTramo,
        longitudOnda: t.fxd.longitudOnda,
        onda: rep.ondaNominal({ longitudOnda: t.fxd.longitudOnda }),
        duracionS: t.fxd.tiempoPromedio, ior: t.fxd.ior,
        pulsoNs: t.fxd.anchoPulso,
        equipo: [t.sup.modulo, t.sup.serieModulo].filter(Boolean).join(' S/N '),
        tramo: nombresDeTramo(t.gen, base, carpeta),
        traza: t.traza, fechaMed: t.fxd.fecha, orl: t.resumen.orl,
      });
    } catch (e) {
      console.error(nombre, e);
      erroresCarga.push(`${nombre}: ${e.message}`);
    }
  }
  if (!zona) {
    const nuevos = archivos.filter((m) => m.repartido);
    const a = nuevos.filter((m) => m.sentido === 'A').length;
    const b = nuevos.filter((m) => m.sentido === 'B').length;
    const sin = nuevos.filter((m) => !m.sentido).length;
    repartoMixto = { a, b, sin };
    nuevos.forEach((m) => {
      m.repartido = false;
      if (m.sentido) { m.zona = m.sentido; m.manual = true; }
    });
  }
  finalizarCarga(erroresCarga);
}

/*
 * Visor de trazas: dibuja la curva del .sor (bloque DataPts) con sus eventos.
 * Todo corre en el navegador. Los datos del archivo se tratan como números y
 * texto plano: nada de lo que trae el .sor se inserta como HTML.
 */
var visor = { x0: 0, x1: 1, m1: null, m2: null, turno: 1, hover: null,
              claveA: '', arrastre: null, geo: null };
const escHtml = (t) => String(t == null ? '' : t).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const vzNum = (n, d) => (n == null || !Number.isFinite(n) ? '—'
  : n.toFixed(d).replace('.', ','));
const vzClave = (m) => `${m.ruta || m.archivo}|${m.sentido || '?'}`;
const vzRotulo = (m) => `${m.numero != null ? 'F' + String(m.numero).padStart(2, '0') : 'F??'}`
  + ` · ${m.sentido === 'B' ? 'B→A' : 'A→B'} · ${m.onda || 1550} nm · ${m.archivo}`;
const vzY = (t, i) => (t.max - t.raw[i]) * t.fs;

function vzMediana(t, kmDesde, kmHasta) {
  const i0 = Math.max(0, Math.floor(kmDesde / t.dx));
  const i1 = Math.min(t.n - 1, Math.ceil(kmHasta / t.dx));
  const v = [];
  for (let i = i0; i <= i1; i++) v.push(vzY(t, i));
  if (!v.length) return 0;
  v.sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)];
}

function vzMedA() { return archivos.find((m) => vzClave(m) === visor.claveA) || null; }
function vzMedB(a) {
  const v = $('visorB').value;
  if (!a || v === 'no') return null;
  if (v === 'auto')
    return archivos.find((m) => m !== a && m.numero != null && m.numero === a.numero
      && m.sentido && a.sentido && m.sentido !== a.sentido
      && (m.onda || 1550) === (a.onda || 1550)) || null;
  const b = archivos.find((m) => vzClave(m) === v);
  return b && b !== a ? b : null;
}

/** Cada serie es la curva más una transformación lineal: x = ax + bx·i, y = ay + by·dB. */
function vzSeries() {
  const a = vzMedA();
  const b = vzMedB(a);
  const ta = a && a.traza;
  const tb = b && b.traza;
  const sA = ta ? { t: ta, ax: 0, bx: ta.dx, ay: 0, by: 1, iMax: ta.n - 1 } : null;
  let sB = null;
  if (tb) {
    const Lb = b.longitud_m ? b.longitud_m / 1000 : tb.n * tb.dx;
    if ($('visorModoB').value === 'espejo') {
      // se da vuelta en distancia y en nivel, y se hace coincidir con la
      // primera en la mitad del tramo, lejos de las zonas muertas
      const La = a && a.longitud_m ? a.longitud_m / 1000 : Lb;
      const xm = La / 2;
      const refB = vzMediana(tb, Lb - xm - 0.1, Lb - xm + 0.1);
      const refA = ta ? vzMediana(ta, xm - 0.1, xm + 0.1) : refB;
      sB = { t: tb, ax: Lb, bx: -tb.dx, ay: refA + refB, by: -1,
             iMax: Math.min(tb.n - 1, Math.floor(Lb / tb.dx)), espejo: true, L: Lb };
    } else {
      sB = { t: tb, ax: 0, bx: tb.dx, ay: 0, by: 1, iMax: tb.n - 1, L: Lb };
    }
  }
  return { a, b, sA, sB };
}

function vzYen(s, xKm) {
  const i = Math.max(0, Math.min(s.iMax, Math.round((xKm - s.ax) / s.bx)));
  return s.ay + s.by * vzY(s.t, i);
}

function vzReiniciar() {
  const a = vzMedA();
  const t = a && a.traza;
  const L = a && a.longitud_m ? a.longitud_m / 1000 : 0;
  const total = t ? t.n * t.dx : (L || 1);
  visor.x0 = 0;
  visor.x1 = L ? Math.min(total, L * 1.05) : total;
  visor.m1 = visor.m2 = null;
  visor.turno = 1;
}

function vzPaso(rango, n) {
  const bruto = rango / n;
  const p = Math.pow(10, Math.floor(Math.log10(bruto)));
  const f = bruto / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
const vzDecimales = (paso) => (paso >= 1 ? 0 : paso >= 0.1 ? 1 : paso >= 0.01 ? 2 : 3);

function vzTrazar(ctx, s, X, Y, x0, x1, color) {
  const t = s.t;
  let iLo = (x0 - s.ax) / s.bx;
  let iHi = (x1 - s.ax) / s.bx;
  if (iLo > iHi) [iLo, iHi] = [iHi, iLo];
  iLo = Math.max(0, Math.floor(iLo));
  iHi = Math.min(s.iMax, Math.ceil(iHi));
  if (iHi <= iLo) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const pxPorPunto = Math.abs(X(s.ax + s.bx) - X(s.ax));
  if (pxPorPunto >= 0.5) {
    for (let i = iLo; i <= iHi; i++) {
      const px = X(s.ax + s.bx * i);
      const py = Y(s.ay + s.by * vzY(t, i));
      if (i === iLo) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
  } else {
    // más puntos que píxeles: por cada columna se dibuja el mínimo y el máximo
    let col = null;
    let pri = 0, mn = 0, mx = 0, ult = 0, inicio = true;
    const cerrar = () => {
      if (col == null) return;
      if (inicio) { ctx.moveTo(col, pri); inicio = false; } else ctx.lineTo(col, pri);
      ctx.lineTo(col, mn); ctx.lineTo(col, mx); ctx.lineTo(col, ult);
    };
    for (let i = iLo; i <= iHi; i++) {
      const px = Math.round(X(s.ax + s.bx * i));
      const py = Y(s.ay + s.by * vzY(t, i));
      if (px !== col) { cerrar(); col = px; pri = mn = mx = ult = py; }
      else { if (py < mn) mn = py; if (py > mx) mx = py; ult = py; }
    }
    cerrar();
  }
  ctx.stroke();
}

function vzDibujar() {
  const cv = $('visorCanvas');
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const { a, b, sA, sB } = vzSeries();
  const base = sA || sB;
  visor.geo = null;
  ctx.font = '12px Arial';
  if (!base) {
    ctx.fillStyle = '#6b7480';
    ctx.textAlign = 'center';
    ctx.fillText(a ? 'Este archivo no trae la curva, solo la tabla de eventos.'
      : 'Elegí una traza.', w / 2, h / 2);
    $('visorLectura').textContent = '';
    return;
  }
  if (!(visor.x1 > visor.x0)) vzReiniciar();
  const { x0, x1 } = visor;
  const izq = 54, der = w - 14, arr = 14, aba = h - 30;
  const X = (km) => izq + ((km - x0) / (x1 - x0)) * (der - izq);

  // escala vertical: lo que se ve de la traza principal
  let yMin = Infinity, yMax = -Infinity;
  {
    let iLo = (x0 - base.ax) / base.bx, iHi = (x1 - base.ax) / base.bx;
    if (iLo > iHi) [iLo, iHi] = [iHi, iLo];
    iLo = Math.max(0, Math.floor(iLo));
    iHi = Math.min(base.iMax, Math.ceil(iHi));
    for (let i = iLo; i <= iHi; i++) {
      const v = base.ay + base.by * vzY(base.t, i);
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 40; }
  if (yMax - yMin < 0.2) { yMax += 0.1; yMin -= 0.1; }
  const margen = (yMax - yMin) * 0.08;
  yMin -= margen; yMax += margen;
  const Y = (db) => aba - ((db - yMin) / (yMax - yMin)) * (aba - arr);
  visor.geo = { izq, der, arr, aba, x0, x1, sA, sB, a, b };

  // grilla
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#e3e7ec';
  ctx.fillStyle = '#6b7480';
  ctx.font = '11px Arial';
  const pX = vzPaso(x1 - x0, 8);
  const dX = vzDecimales(pX);
  ctx.textAlign = 'center';
  for (let v = Math.ceil(x0 / pX) * pX; v <= x1 + 1e-9; v += pX) {
    ctx.beginPath(); ctx.moveTo(X(v), arr); ctx.lineTo(X(v), aba); ctx.stroke();
    ctx.fillText(vzNum(v, dX), X(v), aba + 14);
  }
  const pY = vzPaso(yMax - yMin, 6);
  const dY = vzDecimales(pY);
  ctx.textAlign = 'right';
  for (let v = Math.ceil(yMin / pY) * pY; v <= yMax + 1e-9; v += pY) {
    ctx.beginPath(); ctx.moveTo(izq, Y(v)); ctx.lineTo(der, Y(v)); ctx.stroke();
    ctx.fillText(vzNum(v, dY), izq - 6, Y(v) + 4);
  }
  ctx.strokeStyle = '#98a2ae';
  ctx.strokeRect(izq, arr, der - izq, aba - arr);
  ctx.textAlign = 'center';
  ctx.fillText('km', (izq + der) / 2, h - 3);
  ctx.save();
  ctx.translate(11, (arr + aba) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('dB', 0, 0);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(izq, arr, der - izq, aba - arr);
  ctx.clip();

  if (sB) vzTrazar(ctx, sB, X, Y, x0, x1, '#ed7d31');
  if (sA) vzTrazar(ctx, sA, X, Y, x0, x1, '#1f4e79');

  // eventos de la segunda traza: marcas chicas
  if (sB && b) {
    ctx.strokeStyle = '#ed7d31';
    ctx.lineWidth = 1.5;
    for (const e of b.eventos) {
      const xe = sB.espejo ? sB.L - e.distancia : e.distancia;
      if (xe < x0 || xe > x1) continue;
      const ye = Y(vzYen(sB, xe + (sB.espejo ? 3 : -3) * sB.t.dx));
      ctx.beginPath(); ctx.moveTo(X(xe), ye - 7); ctx.lineTo(X(xe), ye + 7); ctx.stroke();
    }
  }
  // eventos de la traza principal, numerados
  if (sA && a) {
    ctx.strokeStyle = '#c62828';
    ctx.fillStyle = '#1c2430';
    ctx.lineWidth = 1.5;
    ctx.textAlign = 'center';
    let ultimoRotulo = -99;
    a.eventos.forEach((e, k) => {
      const xe = e.distancia;
      if (xe < x0 || xe > x1) return;
      const px = X(xe);
      const ye = Y(vzYen(sA, xe - 3 * sA.t.dx));
      ctx.beginPath(); ctx.moveTo(px, ye - 14); ctx.lineTo(px, ye + 14); ctx.stroke();
      if (px - ultimoRotulo >= 15) {
        ctx.fillText(String(e.numero || k + 1), px, Math.min(aba - 4, ye + 27));
        ultimoRotulo = px;
      }
    });
  }

  // marcadores y cursor
  const ref = sA || sB;
  const marca = (xm, rot) => {
    if (xm == null || xm < x0 || xm > x1) return;
    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = '#2e7d32';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(xm), arr); ctx.lineTo(X(xm), aba); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#2e7d32';
    ctx.font = 'bold 12px Arial';
    ctx.fillText(rot, X(xm) + 8, aba - 8);
    ctx.font = '11px Arial';
  };
  marca(visor.m1, '1');
  marca(visor.m2, '2');
  if (visor.hover != null && visor.hover >= izq && visor.hover <= der) {
    ctx.strokeStyle = 'rgba(28,36,48,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(visor.hover, arr); ctx.lineTo(visor.hover, aba); ctx.stroke();
  }
  ctx.restore();

  // leyenda
  ctx.textAlign = 'right';
  ctx.font = '11px Arial';
  let ly = arr + 14;
  for (const [m, color] of [[sA && a, '#1f4e79'], [sB && b, '#ed7d31']]) {
    if (!m) continue;
    const txt = vzRotulo(m) + (m === b && sB.espejo ? ' (espejada)' : '');
    const ancho = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(der - ancho - 34, ly - 11, ancho + 30, 15);
    ctx.fillStyle = color;
    ctx.fillRect(der - ancho - 30, ly - 5, 18, 3);
    ctx.fillStyle = '#1c2430';
    ctx.fillText(txt, der - 6, ly);
    ly += 16;
  }

  // lectura
  const partes = [];
  if (visor.hover != null && visor.hover >= izq && visor.hover <= der) {
    const xk = x0 + ((visor.hover - izq) / (der - izq)) * (x1 - x0);
    partes.push(`Cursor ${vzNum(xk, 4)} km · ${vzNum(vzYen(ref, xk), 2)} dB`);
    if (sA && a) {
      let mejor = null;
      for (const e of a.eventos) {
        const d = Math.abs(X(e.distancia) - visor.hover);
        if (d <= 6 && (!mejor || d < mejor.d)) mejor = { e, d };
      }
      if (mejor) partes.push(`Evento ${mejor.e.numero}: ${vzNum(mejor.e.perdida, 3)} dB`
        + (mejor.e.reflectancia ? `, refl. ${vzNum(mejor.e.reflectancia, 1)} dB` : ''));
    }
  }
  if (visor.m1 != null && visor.m2 != null) {
    const p = Math.min(visor.m1, visor.m2);
    const q = Math.max(visor.m1, visor.m2);
    const dKm = q - p;
    const dDb = vzYen(ref, p) - vzYen(ref, q);
    partes.push(`Entre marcadores: ${vzNum(dKm, 4)} km · ${vzNum(dDb, 3)} dB`
      + (dKm > 0 ? ` · ${vzNum(dDb / dKm, 3)} dB/km` : ''));
  } else if (visor.m1 != null) {
    partes.push(`Marcador 1 en ${vzNum(visor.m1, 4)} km: hacé clic en otro punto para medir`);
  }
  $('visorLectura').textContent = partes.join('   |   ');
}

function vzTipoEvento(e, k, total) {
  const c = String(e.codigo || '');
  if (c[1] === 'E' || (k === total - 1 && total > 1)) return 'Fin de fibra';
  if (k === 0 && e.distancia < 0.001) return 'Inicio';
  const base = c[0] === '1' ? 'Reflectivo' : c[0] === '2' ? 'Reflectivo saturado'
    : 'No reflectivo';
  return base + (c[1] === 'A' ? ' (manual)' : '');
}

function vzInfo(a, b) {
  const p = $('visorInfo');
  if (!a) { p.textContent = ''; return; }
  const pulso = a.pulsoNs ? (a.pulsoNs >= 1000 ? `${String(a.pulsoNs / 1000).replace('.', ',')} µs` : `${a.pulsoNs} ns`) : '—';
  const fecha = a.fechaMed > 0 ? new Date(a.fechaMed * 1000).toLocaleDateString('es-AR') : '—';
  const t = a.traza;
  const partes = [
    `Pelo ${a.numero != null ? a.numero : '—'}`,
    a.sentido === 'B' ? 'B→A' : 'A→B',
    `${a.onda || 1550} nm`,
    `pulso ${pulso}`,
    `IOR ${a.ior ? a.ior.toFixed(5).replace('.', ',') : '—'}`,
    `longitud ${vzNum(a.longitud_m / 1000, 4)} km`,
    `pérdida total ${vzNum(a.perdidaTotal, 3)} dB`,
    `ORL ${a.orl ? vzNum(a.orl, 2) + ' dB' : '—'}`,
    `medido el ${fecha}`,
    a.equipo || '',
    t ? `${t.n.toLocaleString('es-AR')} puntos, uno cada ${vzNum(t.dx * 1000, 2)} m` : 'sin curva',
  ].filter(Boolean);
  p.textContent = partes.join(' · ')
    + (b ? `   —   comparada con: ${vzRotulo(b)}` : '');
}

function vzTabla(a) {
  const caja = $('visorTabla');
  caja.replaceChildren();
  if (!a || !a.eventos.length) return;
  const umbral = parseFloat($('umbral').value) || 0;
  const tabla = document.createElement('table');
  const cab = tabla.createTHead().insertRow();
  ['N°', 'Tipo', 'Posición (km)', 'Pérdida (dB)', 'Reflectancia (dB)',
   'Aten. tramo previo (dB/km)', 'Acumulado (dB)'].forEach((t) => {
    const th = document.createElement('th');
    th.textContent = t;
    cab.appendChild(th);
  });
  const cuerpo = tabla.createTBody();
  const orden = [...a.eventos].sort((x, y) => x.distancia - y.distancia);
  let acum = 0;
  let previo = 0;
  orden.forEach((e, k) => {
    acum += (e.pendiente || 0) * (e.distancia - previo);
    if (e.perdida) acum += e.perdida;
    previo = e.distancia;
    const fila = cuerpo.insertRow();
    const interior = k > 0 && k < orden.length - 1;
    if (interior && umbral && e.perdida > umbral) fila.style.background = '#fdecea';
    fila.style.cursor = 'pointer';
    fila.title = 'Clic para acercar a este evento';
    [String(e.numero || k + 1), vzTipoEvento(e, k, orden.length), vzNum(e.distancia, 4),
     vzNum(e.perdida, 3), e.reflectancia ? vzNum(e.reflectancia, 1) : '—',
     e.pendiente ? vzNum(e.pendiente, 3) : '—', vzNum(acum, 3)]
      .forEach((v) => { fila.insertCell().textContent = v; });
    fila.onclick = () => {
      const L = a.longitud_m ? a.longitud_m / 1000 : 10;
      const media = Math.max(0.25, L * 0.02);
      visor.x0 = e.distancia - media;
      visor.x1 = e.distancia + media;
      vzDibujar();
      $('visorCanvas').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
  });
  caja.appendChild(tabla);
}

function vzPintar() {
  const a = vzMedA();
  vzInfo(a, vzMedB(a));
  vzTabla(a);
  vzDibujar();
}

/** Se llama cada vez que cambia la lista de archivos cargados. */
function actualizarVisor() {
  const hay = archivos.length > 0;
  $('visorVacio').classList.toggle('oculto', hay);
  $('visorCuerpo').classList.toggle('oculto', !hay);
  if (!hay) { visor.claveA = ''; return; }
  const orden = archivos.map((m, i) => ({ m, i })).sort((p, q) =>
    (p.m.numero == null ? 9999 : p.m.numero) - (q.m.numero == null ? 9999 : q.m.numero)
    || String(p.m.sentido).localeCompare(String(q.m.sentido)) || p.i - q.i);
  const selA = $('visorA');
  const selB = $('visorB');
  const antesB = selB.value || 'auto';
  selA.replaceChildren(...orden.map(({ m }) => new Option(vzRotulo(m), vzClave(m))));
  selB.replaceChildren(
    new Option('Automático: el mismo pelo en el otro sentido', 'auto'),
    new Option('Ninguna', 'no'),
    ...orden.map(({ m }) => new Option(vzRotulo(m), vzClave(m))));
  const claves = orden.map(({ m }) => vzClave(m));
  if (claves.includes(visor.claveA)) {
    selA.value = visor.claveA;
  } else {
    visor.claveA = claves[0];
    selA.value = claves[0];
    vzReiniciar();
  }
  selB.value = [...selB.options].some((o) => o.value === antesB) ? antesB : 'auto';
  vzPintar();
}

(() => {
  const cv = $('visorCanvas');
  const total = () => {
    const g = visor.geo;
    const s = g && (g.sA || g.sB);
    return s ? s.t.n * s.t.dx : 1;
  };
  const acotar = () => {
    const T = total();
    const s = visor.geo && (visor.geo.sA || visor.geo.sB);
    const minimo = s ? s.t.dx * 20 : 0.01;
    let ancho = Math.min(Math.max(visor.x1 - visor.x0, minimo), T * 1.04);
    let c = (visor.x0 + visor.x1) / 2;
    c = Math.min(Math.max(c, -T * 0.02 + ancho / 2), T * 1.02 - ancho / 2);
    visor.x0 = c - ancho / 2;
    visor.x1 = c + ancho / 2;
  };
  const zoom = (factor, centroKm) => {
    const c = centroKm == null ? (visor.x0 + visor.x1) / 2 : centroKm;
    visor.x0 = c - (c - visor.x0) * factor;
    visor.x1 = c + (visor.x1 - c) * factor;
    acotar();
    vzDibujar();
  };
  const kmEn = (px) => {
    const g = visor.geo;
    return g ? g.x0 + ((px - g.izq) / (g.der - g.izq)) * (g.x1 - g.x0) : null;
  };
  const pxDe = (ev) => ev.clientX - cv.getBoundingClientRect().left;

  $('visorA').onchange = () => { visor.claveA = $('visorA').value; vzReiniciar(); vzPintar(); };
  $('visorB').onchange = vzPintar;
  $('visorModoB').onchange = vzPintar;
  $('visorTodo').onclick = () => {
    const m1 = visor.m1, m2 = visor.m2, turno = visor.turno;
    vzReiniciar();
    visor.m1 = m1; visor.m2 = m2; visor.turno = turno;
    vzDibujar();
  };
  $('visorMas').onclick = () => zoom(0.5);
  $('visorMenos').onclick = () => zoom(2);
  $('visorSinMarcas').onclick = () => { visor.m1 = visor.m2 = null; visor.turno = 1; vzDibujar(); };

  cv.addEventListener('wheel', (ev) => {
    if (!visor.geo) return;
    ev.preventDefault();
    zoom(ev.deltaY < 0 ? 0.8 : 1.25, kmEn(pxDe(ev)));
  }, { passive: false });
  cv.addEventListener('mousedown', (ev) => {
    if (!visor.geo || ev.button !== 0) return;
    visor.arrastre = { px: pxDe(ev), x0: visor.x0, x1: visor.x1, movido: false };
  });
  window.addEventListener('mousemove', (ev) => {
    const d = visor.arrastre;
    if (d && visor.geo) {
      const dx = pxDe(ev) - d.px;
      if (Math.abs(dx) > 3) d.movido = true;
      if (d.movido) {
        const g = visor.geo;
        const km = (dx / (g.der - g.izq)) * (d.x1 - d.x0);
        visor.x0 = d.x0 - km;
        visor.x1 = d.x1 - km;
        acotar();
        vzDibujar();
      }
    }
  });
  window.addEventListener('mouseup', (ev) => {
    const d = visor.arrastre;
    visor.arrastre = null;
    if (!d || d.movido || !visor.geo) return;
    const g = visor.geo;
    if (d.px < g.izq || d.px > g.der) return;
    const km = kmEn(d.px);
    if (visor.turno === 1) { visor.m1 = km; visor.m2 = null; visor.turno = 2; }
    else { visor.m2 = km; visor.turno = 1; }
    vzDibujar();
  });
  cv.addEventListener('mousemove', (ev) => {
    if (visor.arrastre && visor.arrastre.movido) return;
    visor.hover = pxDe(ev);
    vzDibujar();
  });
  cv.addEventListener('mouseleave', () => { visor.hover = null; vzDibujar(); });
  let pendiente = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(pendiente);
    pendiente = requestAnimationFrame(vzDibujar);
  });
})();

function limpiarTodo() {
  archivos = [];
  previa = null;
  previaRep = null;
  $('previaArchivo').value = '';
  $('avisoPrevia').textContent = 'Se compara empalme por empalme y pelo por pelo, '
    + 'y se marca lo que empeoró.';
  libro = null;
  resultado = null;
  ['entradaA', 'entradaB', 'entradaMixta'].forEach((id) => { $(id).value = ''; });
  $('listado').innerHTML = '';
  $('salida').innerHTML = '';
  ['bajarExcel', 'bajarPdf', 'bajarReparaciones', 'otra']
    .forEach((id) => $(id).classList.add('oculto'));
  ['quitarMalos', 'invertir', 'vaciarA', 'vaciarB']
    .forEach((id) => $(id).classList.add('oculto'));
  pintarListado();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('limpiar').onclick = limpiarTodo;
$('otra').onclick = limpiarTodo;

const CAMPOS = ['traza', 'nodoA', 'nodoB', 'cable', 'contratista', 'tramo', 'pelos',
  'porTubo', 't1desde', 't1hasta', 't1tipo', 't2desde', 't2hasta', 't2tipo', 'a', 'ae',
  'nc', 'ac', 'umbral', 'minimo', 'onda', 'sep', 'confirmacion', 'ne', 'origenPerdida', 'infra', 'largoBobina', 'pasoReserva',
  'tolerancia', 'umbralRep', 'desdeListar', 'modoGrafico', 'aprobadoPor', 'cargo', 'operador',
  'atProm', 'epis', 'botellas'];

$('guardarCfg').onclick = () => {
  const datos = { version: 1,
    logos: { ...logos,
      empresa: logos.empresa === LOGO_TRANS ? undefined : logos.empresa } };
  CAMPOS.forEach((id) => { datos[id] = $(id).value; });
  const url = URL.createObjectURL(new Blob([JSON.stringify(datos, null, 2)],
    { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `config_${($('traza').value || 'traza').replace(/[^\w]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

function aplicarConfig(datos) {
  CAMPOS.forEach((id) => { if (datos[id] !== undefined) $(id).value = datos[id]; });
  logos = { empresa: LOGO_TRANS, ...(datos.logos || {}) };
  if (!logos.empresa) logos.empresa = LOGO_TRANS;
  autocompletado = true;          // la configuracion manda sobre el .sor
  pintarLogos();

// control de arranque: si una libreria no cargo, se avisa antes de trabajar
(() => {
  const faltan = [];
  if (typeof ExcelJS === 'undefined') faltan.push('ExcelJS (Excel)');
  if (typeof JSZip === 'undefined') faltan.push('JSZip (archivos .zip)');
  if (typeof window.jspdf === 'undefined') faltan.push('jsPDF (PDF)');
  if (faltan.length)
    window.__alerta('No cargaron: ' + faltan.join(', ')
      + '. La página necesita descargarlas de internet la primera vez. '
      + 'Usá la versión sin internet (index-sin-internet.html) o revisá el firewall.');
})();
}

$('abrirCfg').onclick = () => $('cfgArchivo').click();
$('cfgArchivo').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const datos = JSON.parse(await f.text());
    aplicarConfig(datos);
    $('avisoCfg').textContent = `Configuración cargada desde ${f.name}.`;
  } catch (err) {
    $('avisoCfg').textContent = `No se pudo leer la configuración: ${err.message}`;
  }
};

function pintarLogos() {
  const propio = logos.empresa && logos.empresa !== LOGO_TRANS;
  const partes = [];
  partes.push(propio ? 'logo de empresa propio'
    : (logos.empresa ? 'logo de Trans incluido por defecto' : 'sin logo de empresa'));
  if (logos.cliente) partes.push('logo del cliente cargado');
  $('avisoLogos').textContent = partes.join(' · ')
    + '. Van en el encabezado de las tres solapas del Excel y en la carátula del PDF.';
}
pintarLogos();

async function cargarLogo(input, clave) {
  const f = input.files[0];
  if (!f) return;
  logos[clave] = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('no se pudo leer la imagen'));
    r.readAsDataURL(f);
  });
  pintarLogos();
}
window.fijarLogos = (l) => { logos = l || { empresa: LOGO_TRANS }; pintarLogos(); };
window.__repintar = () => pintarListado();
window.cargarDirecto = (lista) => {   // util para pruebas automaticas
  archivos = lista;
  finalizarCarga();
};
$('logoEmpresa').onchange = () => cargarLogo($('logoEmpresa'), 'empresa');
$('logoCliente').onchange = () => cargarLogo($('logoCliente'), 'cliente');

// --- planilla anterior para comparar ---
$('abrirPrevia').onclick = () => $('previaArchivo').click();
$('previaArchivo').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  let avisos = [];
  const buffer = await f.arrayBuffer();
  // una planilla final sirve para comparar empalmes; una de reparación, para
  // comparar punto por punto y pelo por pelo despues de una reparación
  try {
    previa = await leerPlanillaPrevia(buffer);
    window.previa = previa;
    avisos.push(`${previa.empalmes.length} empalmes y ${previa.lecturas.size} `
      + 'lecturas de la planilla final');
  } catch (err) {
    previa = null;
  }
  try {
    const r = await leerAnterior(ExcelJS, buffer);
    previaRep = r.filas.length ? r : null;
    if (previaRep)
      avisos.push(`${r.filas.length} lecturas por punto para comparar la `
        + `reparación${r.fecha ? ` (campaña del ${r.fecha})` : ''}`);
  } catch (err) {
    previaRep = null;
  }
  $('avisoPrevia').textContent = avisos.length
    ? `${f.name}: ${avisos.join(' · ')}.`
    : `${f.name}: no se encontraron datos para comparar. Para comparar una `
      + 'reparación hay que cargar la planilla de REPARACIÓN anterior, que trae '
      + 'la solapa DATOS.';
};

/** Lee una planilla generada por esta misma app y devuelve sus lecturas. */
async function leerPlanillaPrevia(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const empalmes = [];
  const lecturas = new Map();
  for (const ws of wb.worksheets) {
    if (!ws.name.startsWith('AT. EMPALMES')) continue;
    const pelos = {};
    for (let c = 4; c <= ws.columnCount; c += 3) {
      const v = ws.getCell(14, c).value;
      const m = /(\d{1,3})/.exec(typeof v === 'string' ? v : '');
      if (m) pelos[c] = parseInt(m[1], 10);
    }
    let fila = 16;
    while (typeof ws.getCell(fila, 1).value === 'number') {
      const n = Number(ws.getCell(fila, 1).value);
      const prog = Number(ws.getCell(fila, 2).value);
      if (!empalmes.some((e) => e.n === n)) empalmes.push({ n, prog_a: prog });
      for (const [c, f] of Object.entries(pelos)) {
        const a = ws.getCell(fila, +c).value;
        const b = ws.getCell(fila, +c + 1).value;
        const va = typeof a === 'number' ? a : null;
        const vb = typeof b === 'number' ? b : null;
        const valor = va != null && vb ? (va + vb) / 2 : (va != null ? va : vb);
        if (valor != null) lecturas.set(`${f}|${n}`, valor);
      }
      fila++;
    }
  }
  if (!empalmes.length) throw new Error('no se encontraron solapas AT. EMPALMES');
  return { empalmes, lecturas };
}

for (const [zona, idZona, idEntrada] of
     [['A', 'zonaA', 'entradaA'], ['B', 'zonaB', 'entradaB'],
      [null, 'zonaMixta', 'entradaMixta']]) {
  const caja = $(idZona);
  caja.onclick = () => $(idEntrada).click();
  $(idEntrada).onchange = (e) => { cargar([...e.target.files], zona); e.target.value = ''; };
  ['dragenter', 'dragover'].forEach((ev) => caja.addEventListener(ev, (e) => {
    e.preventDefault(); caja.classList.add('activa');
  }));
  ['dragleave', 'drop'].forEach((ev) => caja.addEventListener(ev, (e) => {
    e.preventDefault(); caja.classList.remove('activa');
  }));
  caja.addEventListener('drop', (e) => cargar([...e.dataTransfer.files], zona));
}

$('vaciarA').onclick = () => { archivos = archivos.filter((m) => m.zona !== 'A');
  finalizarCarga(); };
$('vaciarB').onclick = () => { archivos = archivos.filter((m) => m.zona !== 'B');
  finalizarCarga(); };

let libroRep = null;
let repartoMixto = null;

function pintarTipo() {
  const final = tipoPlanilla === 'final';
  $('tituloPaso3').textContent = final
    ? 'Comparar con la medición anterior'
    : 'Comparar el resultado de una reparación';
  $('ayudaPaso3').innerHTML = final
    ? 'Se compara empalme por empalme y pelo por pelo, y se marca lo que empeoró.'
    : '<b>Cómo se compara una reparación:</b> primero generás la planilla de '
      + 'reparación con las mediciones de ahora y la guardás. Vas a obra, reparás '
      + 'y volvés a medir. Después cargás las mediciones nuevas en el paso 2, '
      + 'elegís acá la planilla de reparación <i>anterior</i> y generás de nuevo: '
      + 'cada pelo va a mostrar el valor de antes, el de ahora y si quedó '
      + 'REPARADO, MEJORÓ, SIN CAMBIO o EMPEORÓ. Los puntos que ya quedaron bien '
      + 'siguen figurando como VERIFICADO para que quede constancia.';
  $('tipoFinal').className = final ? '' : 'sec';
  $('tipoReparacion').className = final ? 'sec' : '';
  $('generar').textContent = final ? 'Generar planilla final'
                                   : 'Generar planilla de reparación';
  $('explicaTipo').textContent = final
    ? 'La planilla que se entrega: Registro, una solapa por tubo con la atenuación '
      + 'de cada empalme y la hoja CD, PMD y PWR.'
    : 'Para trabajar en obra: control de configuración de las mediciones, mapa de '
      + 'la traza, gráfico de eventos y órdenes de trabajo con el diagnóstico de '
      + 'cada punto fuera de norma.';
  ['bajarExcel', 'bajarPdf', 'bajarReparaciones', 'otra']
    .forEach((id) => $(id).classList.add('oculto'));
  $('salida').innerHTML = '';
  libroRep = null;
}
$('tipoFinal').onclick = () => { tipoPlanilla = 'final'; pintarTipo(); };
$('tipoReparacion').onclick = () => { tipoPlanilla = 'reparacion'; pintarTipo(); };
pintarTipo();

/**
 * Ordena el panel de resultados: un veredicto arriba y el resto plegado.
 * Con muchos pelos y muchos avisos, lo importante se pierde en la pila.
 */
function ordenarPanel(resumen) {
  const caja = $('salida');
  const avisos = [...caja.querySelectorAll('.aviso')];
  const peso = (a) => (a.classList.contains('mal') ? 0
    : a.classList.contains('alerta') ? 1 : a.classList.contains('ok') ? 3 : 2);
  avisos.sort((x, y) => peso(x) - peso(y)).forEach((a) => caja.appendChild(a));

  // los avisos largos se pliegan: se ve el título y se abre si hace falta
  for (const a of avisos) {
    const texto = a.textContent.trim();
    if (texto.length < 190 || a.querySelector('details')) continue;
    const corte = Math.max(texto.indexOf('. ') + 1, texto.indexOf(':') + 1);
    const titulo = corte > 20 && corte < 150 ? texto.slice(0, corte)
      : texto.slice(0, 110) + '…';
    const cuerpo = a.innerHTML;
    a.innerHTML = `<details><summary style="cursor:pointer;font-weight:600">`
      + `${titulo}</summary><div style="margin-top:6px;font-weight:400">`
      + `${cuerpo}</div></details>`;
  }

  if (!resumen) return;
  const { confirmados, sobreUmbral, cortados, unSentido, criticos, ambar } = resumen;
  const grave = criticos > 0 || cortados > 0;
  const obs = sobreUmbral > 0 || unSentido > 0 || ambar > 0;
  const estado = grave ? 'CON PROBLEMAS' : (obs ? 'CON OBSERVACIONES' : 'SIN OBSERVACIONES');
  const color = grave ? '#c62828' : (obs ? '#b26a00' : '#2e7d32');
  const fondo = grave ? '#fdecea' : (obs ? '#fdf6e3' : '#e8f5e9');
  const partes = [];
  if (sobreUmbral) partes.push(`${sobreUmbral} de ${confirmados} empalmes superan el umbral`);
  if (cortados) partes.push(`${cortados} pelo(s) no llegan de punta a punta`);
  if (unSentido) partes.push(`${unSentido} pelo(s) medidos en un solo sentido`);
  if (ambar) partes.push(`${ambar} promedio(s) con una sola lectura`);
  if (criticos) partes.push(`${criticos} problema(s) críticos de medición`);
  caja.insertAdjacentHTML('afterbegin',
    `<div style="background:${fondo};border-left:4px solid ${color};border-radius:8px;
      padding:12px 16px;margin-bottom:12px">
      <div style="font-size:15px;font-weight:700;color:${color}">${estado}</div>
      <div style="font-size:13px;margin-top:3px">${partes.length
        ? partes.join(' · ') : 'No hay nada para observar.'}</div>
      <div style="font-size:12px;color:#6b7480;margin-top:5px">Cada línea de abajo se
        abre haciendo clic. Están ordenadas de lo más grave a lo informativo.</div>
    </div>`);
}

let generando = false;
$('generar').onclick = async () => {
  if (generando || cargando) return;
  if (!licencia) { await pedirLicencia('Activá la licencia para generar planillas.'); return; }
  try {
    const estado = await lic.evaluar(licencia, equipoId);
    if (!estado.ok) { licencia = null; await pedirLicencia(estado.motivo); return; }
    pintarEstadoLicencia(estado);
  } catch (e) { await pedirLicencia(e.message); return; }
  generando = true;
  $('generar').disabled = true;
  $('generar').textContent = 'Generando y verificando…';
  try {
  const cfg = leerConfig();
  const todas = archivos.map((m) => ({ ...m, fibra: m.numero,
    onda: m.onda || rep.ondaNominal(m) }));
  // la planilla se arma con una sola ventana: la que tenga más mediciones.
  // La otra se guarda para distinguir macrocurvatura de empalme.
  const conteoOnda = new Map();
  todas.forEach((m) => conteoOnda.set(m.onda, (conteoOnda.get(m.onda) || 0) + 1));
  const ondaPrincipal = [...conteoOnda.entries()]
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const mediciones = todas.filter((m) => m.onda === ondaPrincipal);
  const otraVentana = todas.filter((m) => m.onda !== ondaPrincipal);

  // La planilla final no se emite si hay pelos con la ida en una ventana y la
  // vuelta en otra: ese promedio no es comparable.
  const cruzadas = rep.pelosConVentanasCruzadas(todas);
  if (tipoPlanilla === 'final' && cruzadas.length) {
    $('salida').innerHTML =
      `<div class="aviso mal"><b>No se generó la planilla final.</b><br>`
      + `${cruzadas.length} pelo(s) tienen la ida y la vuelta medidas en ventanas `
      + 'distintas. La fibra atenúa distinto en 1310 que en 1550, así que el '
      + 'promedio bidireccional de esos pelos no sería comparable y la planilla '
      + 'quedaría mal.<br><br><b>Pelos fuera:</b><br>'
      + cruzadas.slice(0, 25).map((c) => `Pelo ${c.pelo} — ${c.motivo}`).join('<br>')
      + (cruzadas.length > 25 ? `<br>… y ${cruzadas.length - 25} más.` : '')
      + '<br><br>Remedí el sentido que falta en la misma ventana que el otro. '
      + 'Mientras tanto podés sacar la planilla de REPARACIÓN, que sí se genera '
      + 'y deja documentado el problema.</div>';
    ['bajarExcel', 'bajarPdf', 'bajarReparaciones']
      .forEach((id) => $(id).classList.add('oculto'));
    $('otra').classList.remove('oculto');
    return;
  }

  const longitud = motor.detectarSentidos(mediciones);
  const pulsos = mediciones.map((m) => m.pulsoNs).filter(Boolean);
  const pulso = pulsos.length ? pulsos.sort((a, b) => a - b)[Math.floor(pulsos.length / 2)] : null;
  const sep = motor.separacionMinima(pulso, cfg.parametros.separacionFijaM);
  const porcentaje = Math.min(100,
    Math.max(1, parseFloat($('confirmacion').value) || 10)) / 100;
  const minF = Math.max(1, Math.round(porcentaje * mediciones.length));
  const picos = motor.detectarEmpalmes(mediciones, longitud, sep, minF,
    undefined, cfg.parametros.umbralEmpalmeDb);
  const { empalmes, valores } = motor.armarMatriz(
    mediciones, picos, longitud, cfg.parametros.eventoMinimoDb);
  // los que entraron solo por superar el umbral no son botellas confirmadas
  (picos.detalle || []).forEach((d, i) => {
    if (empalmes[i]) empalmes[i].soloPorUmbral = d.soloPorUmbral;
  });
  const confirmados = empalmes.filter((e) => !e.soloPorUmbral).length;
  const noConfirmados = empalmes.length - confirmados;
  const cortadas = motor.detectarCortadas(mediciones, longitud);
  const pelosCortados = motor.diagnosticarCortes(todas, longitud);
  // peor lectura de cada pelo y empalme en cada ventana
  const porOnda = new Map();
  const cargarOnda = (lista, onda) => {
    if (!lista.length) return;
    const v = motor.armarMatriz(lista, picos, longitud, 0).valores;
    for (const [clave, dato] of v) {
      if (dato.perdida == null) continue;
      const [f, n] = clave.split('|');
      const k = `${f}|${n}|${onda}`;
      if (!porOnda.has(k) || dato.perdida > porOnda.get(k))
        porOnda.set(k, dato.perdida);
    }
  };
  cargarOnda(mediciones, ondaPrincipal);
  cargarOnda(otraVentana, otraVentana.length ? otraVentana[0].onda : 0);
  const p = cfg.parametros;
  // Ne del cálculo teórico: solo los empalmes confirmados por varias fibras
  const ne = cfg.neManual || confirmados;
  const teorica = p.atenuacionDbKm * (longitud / 1000) + ne * p.perdidaEmpalmeDb
                + p.cantidadConectores * p.perdidaConectorDb;

  const datos = { empalmes, valores, mediciones, longitud, cortadas };
  const medidosPrevio = [...new Set(mediciones.map((m) => m.numero))]
    .filter((n) => n != null).sort((x, y) => x - y);
  const eventosMax = Math.max(...mediciones.map((m) => m.eventos.length));
  const validos = mediciones.filter((m) => m.numero >= 1
    && m.numero <= cfg.estructura.fibrasTotales);
  if (!validos.length) {
    $('salida').innerHTML = '<div class="aviso mal"><b>No se puede armar la planilla.'
      + '</b> Ninguna medición tiene un número de pelo entre 1 y '
      + `${cfg.estructura.fibrasTotales}. Revisá la columna Pelo en la tabla de `
      + 'archivos y la cantidad de pelos declarada en el paso 1.</div>';
    ['bajarExcel', 'bajarPdf', 'bajarReparaciones']
      .forEach((id) => $(id).classList.add('oculto'));
    $('otra').classList.remove('oculto');
    return;
  }
  const soloUnSentido = medidosPrevio.filter((f) => {
    const a = mediciones.some((m) => m.numero === f && m.sentido === 'A');
    const b = mediciones.some((m) => m.numero === f && m.sentido === 'B');
    return !(a && b);
  });
  const contraste = cfg.botellas.length
    ? contrasteBotellas(cfg.botellas, empalmes.map((e) => e.prog_a)) : null;
  const medidos = [...new Set(mediciones.map((m) => m.numero))].sort((x, y) => x - y);
  const conA = new Set(mediciones.filter((m) => m.sentido === 'A').map((m) => m.numero));
  const conB = new Set(mediciones.filter((m) => m.sentido === 'B').map((m) => m.numero));
  const bidiPorFibra = {};
  medidos.forEach((f) => { bidiPorFibra[f] = conA.has(f) && conB.has(f); });
  const comparacion = previa
    ? compararPlanillas(previa, empalmes, valores, medidos, bidiPorFibra) : null;
  libro = await generarLibro(ExcelJS, datos, cfg,
    { contraste, comparacion, neConfirmados: confirmados });
  // se genera y se verifica hasta tres veces antes de habilitar la descarga
  let fallas = [];
  let intentos = 0;
  do {
    intentos += 1;
    if (intentos > 1)
      libro = await generarLibro(ExcelJS, datos, cfg,
        { contraste, comparacion, neConfirmados: confirmados });
    fallas = verificarLibro(libro, cfg, datos,
      { medidos, bidiPorFibra, neConfirmados: confirmados });
  } while (fallas.length && intentos < 3);

  // cuantas mediciones vieron cada empalme: sirve para elegir el corte
  const detalle = picos.detalle || [];
  const confirmacion = empalmes.map((emp, i) => {
    let n = 0;
    let maximo = 0;
    for (const m of mediciones) {
      const v = valores.get(`${m.numero}|${emp.n}|${m.sentido}`);
      if (v) {
        n += 1;
        if (v.perdida != null && v.perdida > maximo) maximo = v.perdida;
      }
    }
    return { n: emp.n, prog: emp.prog_a, vistas: n, maximo,
             soloPorUmbral: !!(detalle[i] && detalle[i].soloPorUmbral),
             pct: Math.round(100 * n / mediciones.length) };
  });
  const sospechosos = confirmacion.filter((x) => x.soloPorUmbral);
  const cortes = [25, 40, 50, 60, 75].map((c) => ({
    c, quedan: confirmacion.filter((x) => x.pct >= c).length }));

  const hallazgos = revisar(libro, cfg, empalmes, medidos, cortadas, teorica,
                            confirmados);
  resultado = { datos, cfg, teorica, medidos, bidiPorFibra, pulso, contraste, comparacion,
    confirmados, longitud, empalmes, valores, mediciones, cortadas, porOnda,
    todas, ondaPrincipal, otraVentana,
    tubos: tubos(cfg.estructura.fibrasTotales, cfg.estructura.fibrasPorTubo) };
  window.resultado = resultado;      // util para diagnosticar desde la consola
  window.aplicarConfig = aplicarConfig;
  window.leerPlanillaPrevia = leerPlanillaPrevia;
  window.fijarPrevia = (x) => { previa = x; window.previa = x; };
  window.libro = libro;

  const bidi = mediciones.some((m) => m.sentido === 'B');
  $('salida').innerHTML = `
    <div class="tarjetas" style="margin-bottom:14px">
      <div class="tarjeta"><b>${confirmados}</b><span>empalmes confirmados</span></div>
      ${noConfirmados ? `<div class="tarjeta"><b>${noConfirmados}</b><span>eventos no confirmados</span></div>` : ''}
      ${cfg.neManual ? `<div class="tarjeta"><b>${cfg.neManual}</b><span>Ne usado en la fórmula</span></div>` : ''}
      <div class="tarjeta"><b>${medidos.length}</b><span>pelos medidos</span></div>
      <div class="tarjeta"><b>${(longitud / 1000).toFixed(3)}</b><span>km de traza</span></div>
      <div class="tarjeta"><b>${ondaPrincipal}</b><span>nm de la planilla${
        otraVentana.length ? ` (+${otraVentana.length} en ${otraVentana[0].onda})` : ''}</span></div>
      <div class="tarjeta"><b>${teorica.toFixed(2)}</b><span>dB teóricos (At)</span></div>
      <div class="tarjeta"><b>${sep.toFixed(0)}</b><span>m de separación mínima</span></div>
      <div class="tarjeta"><b>${minF}</b><span>mediciones para confirmar</span></div>
      <div class="tarjeta"><b>${cortadas.size}</b><span>pelos cortados</span></div>
      ${contraste ? `<div class="tarjeta"><b>${contraste.emparejadas.length}/${cfg.botellas.length}</b><span>botellas confirmadas</span></div>` : ''}
      ${comparacion ? `<div class="tarjeta"><b>${comparacion.peores}</b><span>lecturas que empeoraron</span></div>` : ''}
    </div>
    <div class="aviso info">Pulso ${pulso ?? '—'} ns · medición
      ${bidi ? 'bidireccional' : 'unidireccional (At Prom sin completar)'}</div>
    ` + (cfg.neManual && cfg.neManual !== empalmes.length
      ? `<div class="aviso info">El cálculo teórico usa Ne = ${cfg.neManual} `
        + `(declarado a mano) en vez de los ${confirmados} empalmes confirmados. `
        + `At pasa de ${(p.atenuacionDbKm * (longitud / 1000)
            + empalmes.length * p.perdidaEmpalmeDb
            + p.cantidadConectores * p.perdidaConectorDb).toFixed(3)} a `
        + `${teorica.toFixed(3)} dB.</div>`
      : '')
    + (fallas.length
      ? `<div class="aviso mal"><b>Verificación ${intentos}/3: quedaron `
        + `${fallas.length} problema(s).</b><br>${fallas.slice(0, 8).join('<br>')}`
        + `${fallas.length > 8 ? '<br>…' : ''}</div>`
      : `<div class="aviso ok">Verificación ${intentos}/3 superada: todas las `
        + 'fórmulas de At Prom, las pérdidas totales por sentido y las progresivas '
        + 'están completas.</div>')
    + (empalmes.length > eventosMax * 1.4
      ? `<div class="aviso mal"><b>Revisá los sentidos.</b> Se detectaron `
        + `${empalmes.length} empalmes y la medición con más eventos tiene `
        + `${eventosMax}. Eso pasa cuando una medición del sentido inverso quedó `
        + 'cargada como A→B: sus eventos no se espejan y se suman como empalmes '
        + 'nuevos. Corregí el sentido en la tabla de archivos y volvé a generar.</div>'
      : '')
    + (sospechosos.length
      ? `<div class="aviso mal"><b>${sospechosos.length} evento(s) entraron solo por `
        + 'superar el umbral, no por confirmación.</b> NO se cuentan como botellas en '
        + `el cálculo teórico (Ne = ${confirmados}), pero sí figuran en las solapas de `
        + 'empalme, marcados en ámbar. Pueden ser atenuaciones de la traza y no '
        + 'botellas: una macrocurvatura, un estrangulamiento o un tramo dañado. '
        + 'Progresivas: '
        + sospechosos.map((x) => `${Math.round(x.prog).toLocaleString('es-AR')} m `
          + `(${x.maximo.toFixed(3)} dB, ${x.pct}%)`).join(', ')
        + '. Si no son botellas, cargá a mano el Ne para la fórmula.</div>'
      : '')
    + (pelosCortados.length
      ? `<div class="aviso mal"><b>${pelosCortados.length} pelo(s) no llegan de `
        + 'punta a punta.</b><br>'
        + pelosCortados.slice(0, 12).map((c) => `Pelo ${c.pelo}: ${c.texto}`)
          .join('<br>')
        + (pelosCortados.length > 12 ? '<br>…' : '') + '</div>'
      : '')
    + (soloUnSentido.length
      ? `<div class="aviso mal">Pelos cargados en un solo sentido: `
        + `${soloUnSentido.join(', ')}. Sin las dos mediciones no hay promedio `
        + 'posible. Revisá si falta subir esos archivos.</div>'
      : '')
    + (contraste && contraste.sinMedicion.length
      ? `<div class="aviso mal">${contraste.sinMedicion.length} botella(s) declaradas sin `
        + `empalme medido cerca: ${contraste.sinMedicion.map((b) => Math.round(b.progresiva_m) + ' m').join(', ')}</div>`
      : '')
    + (comparacion && comparacion.peores
      ? `<div class="aviso mal">${comparacion.peores} lectura(s) empeoraron respecto de la medición anterior.</div>`
      : '')
    + `<details style="margin-bottom:9px"><summary style="cursor:pointer;font-size:13px">
        Confirmación de cada empalme (cuántas de las ${mediciones.length} mediciones lo vieron)
       </summary>
       <p class="nota">Un empalme real lo ve casi toda la fibra del cable. Los que
       aparecen en pocas mediciones suelen ser eventos de una sola traza, no una botella.
       Subiendo "Confirmación mínima" quedarían:
       ${cortes.map((x) => `<b>${x.c}% → ${x.quedan}</b>`).join(' · ')}</p>
       <div class="archivos" style="max-height:220px"><table><thead><tr>
       <th>N°</th><th>Progresiva (m)</th><th>Mediciones</th><th>%</th>
       <th>Peor lectura</th></tr></thead><tbody>
       ${confirmacion.map((x) => `<tr${x.soloPorUmbral ? ' style="background:#fdecea"'
         : (x.pct < 50 ? ' style="background:#fdf6e3"' : '')}>
         <td>${x.n}${x.soloPorUmbral
           ? ' <span class="pill b">solo por superar el umbral</span>' : ''}</td>
         <td>${Math.round(x.prog).toLocaleString('es-AR')}</td>
         <td>${x.vistas}</td><td>${x.pct}%</td>
         <td>${x.maximo ? x.maximo.toFixed(3) + ' dB' : ''}</td></tr>`).join('')}
       </tbody></table></div></details>`
    + (hallazgos.length
      ? hallazgos.map((h) => `<div class="aviso mal">${h}</div>`).join('')
      : '<div class="aviso ok">Revisión completa: progresivas iguales en todas las hojas, '
        + 'recuadros cerrados, cabecera y fórmulas completas.</div>');
  // números para el veredicto del panel
  let sobreUmbral = 0;
  let ambarTotal = 0;
  for (const emp of empalmes) {
    let malo = false;
    for (const f of medidos) {
      const a = valores.get(`${f}|${emp.n}|A`);
      const b = valores.get(`${f}|${emp.n}|B`);
      const va = a && a.perdida != null ? a.perdida : null;
      const vb = b && b.perdida != null ? b.perdida : null;
      if ((va != null && va > cfg.parametros.umbralEmpalmeDb)
          || (vb != null && vb > cfg.parametros.umbralEmpalmeDb)) malo = true;
      if (bidiPorFibra[f] && ((va == null) !== (vb == null))) ambarTotal += 1;
    }
    if (malo) sobreUmbral += 1;
  }
  ordenarPanel({
    confirmados,
    sobreUmbral,
    cortados: pelosCortados.length,
    unSentido: soloUnSentido.length,
    criticos: rep.controlarConfiguracion(todas)
      .filter((h) => h.gravedad === 'critico').length,
    ambar: ambarTotal,
  });
  $('otra').classList.remove('oculto');
  if (tipoPlanilla === 'final') {
    ['bajarExcel', 'bajarPdf'].forEach((id) => $(id).classList.remove('oculto'));
  } else {
    const aviso = await construirReparaciones();
    $('salida').insertAdjacentHTML('afterbegin', aviso);
    $('bajarReparaciones').classList.remove('oculto');
  }
  if (tipoPlanilla === 'final') {
    $('bajarExcel').textContent = fallas.length
      ? 'Descargar Excel igual' : 'Descargar Excel';
    $('bajarExcel').className = (fallas.length ? '' : 'sec');
  }
  } finally {
    generando = false;
    $('generar').disabled = false;
    $('generar').textContent = tipoPlanilla === 'final'
      ? 'Generar planilla final' : 'Generar planilla de reparación';
  }
};

function nombreArchivo(ext) {
  const base = ($('tramo').value || 'planilla').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
  return `Planilla_Empalme_${base}.${ext}`;
}

$('bajarExcel').onclick = async () => {
  if (!libro) return;
  const datos = await libro.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([datos],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo('xlsx');
  a.click();
  URL.revokeObjectURL(url);
};

/** Arma el libro de reparaciones y devuelve el aviso para la pantalla. */
async function construirReparaciones() {
  try {
    const { datos, cfg, teorica, medidos, longitud, empalmes, valores,
            mediciones, cortadas, porOnda, todas } = resultado;
    const umbralRep = parseFloat($('umbralRep').value) || cfg.parametros.umbralEmpalmeDb;
    const infra = rep.leerInfraestructura($('infra').value);
    const hallazgos = rep.controlarConfiguracion(todas || mediciones);
    const ordenes = rep.diagnosticar(empalmes, valores, mediciones, cfg, {
      infraestructura: infra, umbral: umbralRep, longitud, porOnda,
      tolerancia: parseInt($('tolerancia').value, 10) || 150,
    });

    const desdeListar = parseFloat($('desdeListar').value) || 0.10;
    const cortes = motor.diagnosticarCortes(todas, longitud);
    // todos los pelos con evento en cada punto, no solo los fuera de norma
    const puntos = rep.lecturasPorPunto(ordenes, valores, medidos, cfg, {
      umbral: umbralRep, desde: desdeListar,
    });
    // los pelos cortados van primero: están fuera de servicio
    const puntosCorte = rep.puntosDeCorte(cortes, cfg, {
      longitud, tolerancia: parseInt($('tolerancia').value, 10) || 150,
      infraestructura: infra, medidos, desde: desdeListar,
    });
    puntos.unshift(...puntosCorte);
    const tol = parseInt($('tolerancia').value, 10) || 150;
    let cruzados = 0;
    let verificados = [];
    if (previaRep) {
      cruzados = rep.cruzarConAnterior(puntos, previaRep.filas, tol);
      // los puntos reparados dejan de superar el umbral: vuelven como
      // VERIFICADO para que se vea el resultado de la reparación
      verificados = rep.puntosVerificados(puntos, empalmes, valores, medidos, cfg,
        previaRep.filas, { tolerancia: tol, umbral: umbralRep,
          infraestructura: infra, longitud,
          desde: parseFloat($('desdeListar').value) || 0.10 });
      verificados.forEach((v) => { cruzados += v.filas.length; });
      puntos.push(...verificados);
    }

    const equipos = [...new Set((todas || mediciones).map((m) => m.equipo)
      .filter(Boolean))];
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Generador de planillas de empalme';
    // se reparte de dos en dos: cada solapa entra en una hoja impresa
    const hojasPuntos = marcarHojas(puntos);
    // para que la lista de pelos cortados diga a qué solapa ir
    const hojaDePelo = new Map();
    puntos.filter((p) => p.orden.esCorte).forEach((p) => {
      p.filas.forEach((x) => hojaDePelo.set(x.pelo,
        { n: `CORTE ${p.orden.n}`, hoja: p.orden.hoja }));
    });
    hojaReparaciones(wb, { cfg, longitud, hallazgos, infraestructura: infra,
      ordenes, umbral: umbralRep, medidos, empalmes,
      cortes, hojaDePelo,
      equipo: equipos.join(' · '), pulsoNs: resultado.pulso,
      onda: resultado.ondaPrincipal, confirmados: resultado.confirmados });
    hojaPuntos(wb, { cfg, puntos, umbral: umbralRep, longitud,
      hayComparacion: cruzados > 0,
      fechaAnterior: previaRep ? previaRep.fecha : null });

    // el gráfico se dibuja en un canvas y se incrusta como imagen
    const canvas = document.createElement('canvas');
    canvas.width = 1400;
    canvas.height = 1420;
    dibujarGrafico(canvas, { ordenes, empalmes, valores, medidos,
      infraestructura: infra, longitud, umbral: umbralRep,
      tramo: cfg.registro.tramo, mediciones, teorica, cortadas,
      modo: $('modoGrafico').value });
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    hojaGrafico(wb, base64, { ordenes, umbral: umbralRep });
    // solapa plana: es la que se lee al cargar esta planilla como campaña anterior
    hojaDatos(wb, { cfg, puntos, longitud, umbral: umbralRep,
      fecha: new Date().toISOString().slice(0, 10) });

    libroRep = wb;
    const criticos = hallazgos.filter((h) => h.gravedad === 'critico').length;
    return `<div class="aviso ${criticos ? 'mal' : 'ok'}">Planilla de reparación: `
      + `${ordenes.length} punto(s) a revisar con umbral `
      + `${umbralRep.toFixed(2).replace('.', ',')} dB`
      + (criticos ? ` · ${criticos} problema(s) críticos de configuración de las `
        + 'mediciones' : '')
      + (hojasPuntos > 1
        ? `. El detalle pelo por pelo está repartido en ${hojasPuntos} solapas `
          + `PUNTOS A INTERVENIR, de dos puntos cada una para que cada solapa `
          + 'entre en una hoja impresa. La columna "Hoja" de las órdenes de '
          + 'trabajo dice a cuál ir.'
        : '. En la solapa PUNTOS A INTERVENIR está el detalle pelo por pelo de '
          + 'cada progresiva, con los que están fuera de norma y los que están '
          + 'al límite.')
      + (puntosCorte.length
        ? ` Hay ${puntosCorte.length} corte(s) de fibra, listados primero con la `
          + 'progresiva y la instrucción de fusionar para dar continuidad.' : '')
      + (ordenes.filter((o) => o.fueraDeBotella).length
        ? ` ${ordenes.filter((o) => o.fueraDeBotella).length} evento(s) no caen `
          + 'sobre ninguna botella declarada: quedan marcados como posible evento '
          + 'fuera de botella, para recorrer la traza en esa progresiva.' : '')
      + (cruzados
        ? ` Se compararon ${cruzados} lectura(s) contra la campaña anterior`
          + (verificados.length
            ? `, incluidos ${verificados.length} punto(s) ya reparados que se `
              + 'incluyen como VERIFICADO para dejar constancia del resultado.'
            : '.')
        : (previaRep === null && previa
          ? ' La planilla que cargaste en el paso 3 es una planilla final: para '
            + 'comparar una reparación hay que cargar la planilla de REPARACIÓN '
            + 'anterior.' : ''))
      + '</div>';
  } catch (e) {
    libroRep = null;
    return `<div class="aviso mal">No se pudo armar la planilla de reparación: `
      + `${e.message}</div>`;
  }
}

$('bajarReparaciones').onclick = async () => {
  if (!libroRep) return;
  const buf = await libroRep.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo('xlsx').replace('Planilla_Empalme_', 'Reparaciones_');
  a.click();
  URL.revokeObjectURL(url);
};

$('bajarPdf').onclick = () => {
  if (!resultado) return;
  try {
    const { jsPDF } = window.jspdf;
    const doc = generarPDF(jsPDF, resultado.datos, resultado.cfg, resultado);
    doc.save(nombreArchivo('pdf'));
  } catch (e) {
    $('salida').insertAdjacentHTML('afterbegin',
      `<div class="aviso mal">No se pudo generar el PDF: ${e.message}</div>`);
  }
};

/* ===================================================================
 * Interfaz: panel de configuración, resumen del tramo, pasos y ayuda.
 * No toca el cálculo: solo muestra y ordena lo que ya existe.
 * =================================================================== */
(() => {
  const ICO = {
    tramo: '<path d="M4 18c4 0 4-12 8-12s4 12 8 12"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="18" r="1.5"/>',
    fibra: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
    formula: '<path d="M5 19l5-14M9 13h7M14 19l5-14"/>',
  };
  const icono = (k) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '20'); s.setAttribute('height', '20');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round');
    s.innerHTML = ICO[k];          // texto fijo de esta misma función, no datos externos
    return s;
  };
  const v = (id) => ($(id).value || '').trim();

  function abrirCfg(tab) {
    if (tab) elegirTab(tab);
    $('uiFondo').classList.remove('oculto');
    $('uiPanel').classList.add('abierto');
  }
  function cerrarCfg() {
    $('uiFondo').classList.add('oculto');
    $('uiPanel').classList.remove('abierto');
    pintarNodosZonas();
    pintarResumen();
  }
  function elegirTab(tab) {
    document.querySelectorAll('#uiTabs button').forEach((b) =>
      b.classList.toggle('activa', b.dataset.tab === tab));
    document.querySelectorAll('#uiPanes .pane').forEach((p) =>
      p.classList.toggle('activa', p.dataset.pane === tab));
    $('uiPanes').scrollTop = 0;
  }

  function pintarResumen() {
    const tipos = [[v('t1tipo'), v('t1desde'), v('t1hasta')], [v('t2tipo'), v('t2desde'), v('t2hasta')]]
      .filter((t) => t[0] && t[2]).map((t) => `${t[0]} ${t[1]}–${t[2]}`).join(' · ');
    const coma = (x) => String(x).replace('.', ',');
    const chips = [
      ['tramo', 'Tramo', v('nodoA') && v('nodoB') ? `${v('nodoA')} → ${v('nodoB')}` : 'Sin definir',
       [v('traza'), v('cable'), v('contratista')].filter(Boolean).join(' · ')],
      ['fibra', 'Fibra óptica', `${v('pelos') || '—'} pelos · ${v('porTubo') || '—'} por buffer`,
       [tipos, v('onda') ? `${v('onda')} nm` : ''].filter(Boolean).join(' · ')],
      ['formula', 'Criterio', `≤ ${coma(v('umbral') || '—')} dB por empalme`,
       `a ${coma(v('a'))} · ae ${coma(v('ae'))} · Nc ${v('nc')} · ac ${coma(v('ac'))}`],
    ];
    const caja = $('uiResumen');
    caja.replaceChildren(...chips.map(([tab, titulo, principal, detalle]) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.title = 'Tocá para cambiarlo';
      const ic = document.createElement('span');
      ic.className = 'ico';
      ic.appendChild(icono(tab));
      const tx = document.createElement('span');
      const s = document.createElement('small'); s.textContent = titulo;
      const st = document.createElement('strong'); st.textContent = principal;
      const d = document.createElement('small');
      d.style.textTransform = 'none'; d.style.letterSpacing = '0';
      d.textContent = detalle;
      tx.append(s, st, d);
      const lap = document.createElement('span');
      lap.className = 'lap'; lap.textContent = 'Cambiar ›';
      b.append(ic, tx, lap);
      b.onclick = () => abrirCfg(tab);
      return b;
    }));
  }

  function pintarPasos() {
    const hay = archivos.length > 0;
    const listo = ['bajarExcel', 'bajarReparaciones', 'bajarPdf']
      .some((id) => !$(id).classList.contains('oculto'));
    $('uiP1').className = 'pasoInd ' + (hay ? 'hecho' : 'activo');
    $('uiP2').className = 'pasoInd ' + (listo ? 'hecho' : (hay ? 'activo' : ''));
    $('uiP3').className = 'pasoInd ' + (listo ? 'activo' : '');
  }

  // se enganchan las funciones existentes para refrescar la interfaz
  const nodosOriginal = pintarNodosZonas;
  pintarNodosZonas = function () { nodosOriginal(); pintarResumen(); };
  const listadoOriginal = pintarListado;
  pintarListado = function (...args) { listadoOriginal(...args); pintarPasos(); };
  const configOriginal = aplicarConfig;
  aplicarConfig = function (d) { configOriginal(d); pintarNodosZonas(); };

  let estabaListo = false;
  new MutationObserver(() => {
    pintarPasos();
    const listo = $('uiP3').classList.contains('activo');
    if (listo && !estabaListo)
      $('uiGenerar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    estabaListo = listo;
  }).observe($('uiGenerar'), { attributes: true, subtree: true, attributeFilter: ['class'] });

  $('uiAbrirCfg').onclick = () => abrirCfg();
  $('uiCerrarCfg').onclick = cerrarCfg;
  $('uiListo').onclick = cerrarCfg;
  $('uiFondo').onclick = cerrarCfg;
  $('uiTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) elegirTab(b.dataset.tab);
  });
  $('uiPanes').addEventListener('input', pintarResumen);
  $('uiAbrirAyuda').onclick = () => $('uiAyuda').classList.remove('oculto');
  $('uiCerrarAyuda').onclick = () => $('uiAyuda').classList.add('oculto');
  $('uiAyuda').addEventListener('click', (e) => {
    if (e.target === $('uiAyuda')) $('uiAyuda').classList.add('oculto');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $('uiAyuda').classList.add('oculto');
    if ($('uiPanel').classList.contains('abierto')) cerrarCfg();
  });
  // el visor está plegado: al abrirlo hay que dibujar con el ancho real
  $('pasoVisor').addEventListener('toggle', () => { if ($('pasoVisor').open) vzPintar(); });

  pintarResumen();
  pintarPasos();

  // sin conexión: la app queda guardada en el equipo después de la primera visita
  if ('serviceWorker' in navigator && location.protocol === 'https:')
    navigator.serviceWorker.register('sw.js').catch(() => {});
})();
