'use strict';

// QUÉ SE LE PUEDE PEDIR AL CLI DE CLAUDE, y cómo se escribe.
//
// Es la mitad pura del selector de ⚙ para "Claude (CLI / suscripción)": no
// lanza procesos ni toca el disco. La otra mitad —preguntarle al CLI instalado—
// vive en claude-medir.js.
//
// ── Por qué no hay una lista de modelos escrita acá ──────────────────
//
// La había, en el panel: Opus 5, Sonnet 5, Fable 5, Opus 4.8. Con Opus 5.5 ya
// publicado el selector seguía ofreciendo esos cuatro como lo último, y no por
// descuido de quien la escribió: CADA VERSIÓN DEL CLI TRAE FIJA SU TABLA DE
// ALIAS. Medido en esta máquina con Claude Code 2.1.288: `opus` contesta Opus
// 5.5, `sonnet` Sonnet 5.5 y `fable` Fable 5.1; con un CLI más viejo, los
// mismos alias contestan otros modelos. Ninguna lista del panel puede saber
// eso. El CLI sí.
//
// Así que todo sale de él:
//   - los MODELOS: el alias de cada familia (avanza solo cuando se actualiza el
//     CLI) o una versión fija de las que ofrece su menú /model, que viene
//     escrito adentro del binario (ver `opcionDelMenu`);
//   - QUÉ VERSIÓN hay detrás de cada alias, y si cada versión fija sigue viva:
//     se mide con una llamada mínima y se guarda junto a la versión del CLI con
//     que se midió. Con otro CLI esa medida no vale, y sin medida se dice
//     "Opus" a secas: nunca una versión que nadie midió;
//   - la VENTANA DE CONTEXTO, que también se mide (ver `ventanasDe`).
//
// Es el diseño del selector de Editor Pro, con una diferencia que salió de
// medir. Allá la ventana se elige con una tabla por familia (Opus: 200k o 1M).
// Acá se midió que los modelos actuales ya vienen con 1M —`opus`, `opus[1m]`,
// `sonnet` y `fable` contestan los cuatro `contextWindow: 1000000`— y que el
// `[1m]` solo cambia algo en versiones viejas: Opus 4.6 trae 200k de serie y
// 1M pidiéndolo. Con la tabla, el selector le ofrecía "200k" a un modelo que
// no lo tiene.

// Cambia cuando cambia la FORMA de lo guardado. Una medición de otro formato
// se ignora y se vuelve a medir: leerla a medias es peor que no tenerla.
const FORMATO = 1;

const UN_MILLON = 1000000;

/**
 * Las familias, en el orden del selector. `acerca` es la descripción que el
 * propio CLI pone en su menú, en el idioma del panel.
 *
 * `admite1m` y `deSerie1m` se usan SOLO mientras no hay medición: son lo que
 * se puede afirmar de una familia sin preguntarle nada al CLI. En cuanto hay
 * medida, mandan los números medidos.
 */
const FAMILIAS = [
  { id: 'fable', nombre: 'Fable', acerca: 'El más capaz, para lo más difícil y lo que más tarda',
    admite1m: true, deSerie1m: true },
  { id: 'opus', nombre: 'Opus', acerca: 'El mejor para tareas complejas de todos los días',
    admite1m: true, deSerie1m: false },
  { id: 'sonnet', nombre: 'Sonnet', acerca: 'Rápido y capaz para la mayoría de las tareas',
    admite1m: true, deSerie1m: false },
  // Antes el panel lo escondía: rápido, pero diseñando animaciones es el que
  // peor rinde. Ahora se ve —el pedido fue ver todos los modelos— y lo dice.
  { id: 'haiku', nombre: 'Haiku', acerca: 'El más rápido, para respuestas cortas; diseñando animaciones es el que peor rinde',
    admite1m: false, deSerie1m: false },
];

/**
 * Los niveles de pensamiento, tal como los acepta `--effort`, más el que no
 * manda nada. 'default' no es un nivel del CLI: es "no le pases el flag".
 */
const ESFUERZOS = [
  { id: 'default', etiqueta: 'Predeterminado', acerca: 'no se lo indico y decide el modelo (el default de Anthropic es Alto)' },
  { id: 'low', etiqueta: 'Bajo', acerca: 'el más rápido y barato, casi no piensa; alcanza para diseños simples' },
  { id: 'medium', etiqueta: 'Medio', acerca: 'piensa un poco antes de diseñar' },
  { id: 'high', etiqueta: 'Alto', acerca: 'piensa con cuidado: mejor en lo difícil, más lento. Es el recomendado' },
  { id: 'xhigh', etiqueta: 'Muy alto', acerca: 'piensa más tiempo, para diseños exigentes' },
  { id: 'max', etiqueta: 'Máximo', acerca: 'piensa todo lo que necesite: la mejor calidad, lo más lento y lo que más gasta de tu plan' },
];

const ACERCA_1M = 'Ventana extendida, para entradas muy largas. Puede gastar créditos extra de tu plan.';

function familia(id) {
  for (const f of FAMILIAS) if (f.id === id) return f;
  return null;
}

/** "claude-opus-4-8[1m]" → "claude-opus-4-8"; "claude-haiku-4-5-20251001" → "claude-haiku-4-5". */
function idBase(id) {
  return String(id == null ? '' : id).toLowerCase().trim().replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
}

/** La familia de un nombre completo de versión ("claude-opus-4-8" → "opus"), o "". */
function familiaDeVersion(id) {
  const m = /^claude-([a-z]+)-\d/.exec(idBase(id));
  return m && familia(m[1]) ? m[1] : '';
}

/** "claude-opus-5-5" → "Opus 5.5"; "claude-haiku-4-5-20251001" → "Haiku 4.5"; "" si no es un ID de versión. */
function etiquetaDeVersion(id) {
  const m = /^claude-([a-z]+)-(\d+(?:-\d{1,2})*)$/.exec(idBase(id));
  if (!m) return '';
  const f = familia(m[1]);
  const nombre = f ? f.nombre : (m[1].charAt(0).toUpperCase() + m[1].slice(1));
  return nombre + ' ' + m[2].replace(/-/g, '.');
}

/**
 * Lee un `--model` guardado: { familia, version, extendida, propio }.
 *
 * `version` es la versión fija ("" si es el alias de la familia), `extendida`
 * si pide la ventana de 1M con el sufijo. Entiende lo que había antes de este
 * selector (IDs completos como "claude-sonnet-5", que ahora son versiones
 * fijas) y deja en `propio` lo que no reconoce, para no perderlo.
 */
function leer(modelo) {
  const m = String(modelo == null ? '' : modelo).trim().toLowerCase();
  if (!m || m === 'default') return { familia: '', version: '', extendida: false, propio: '' };
  const extendida = /\[1m\]$/.test(m);
  const base = m.replace(/\[1m\]$/, '');
  if (familia(base)) return { familia: base, version: '', extendida: extendida, propio: '' };
  const fam = familiaDeVersion(base);
  if (fam) return { familia: fam, version: base, extendida: extendida, propio: '' };
  return { familia: '', version: '', extendida: false, propio: String(modelo).trim() };
}

/**
 * Una opción del menú /model del CLI, tal como viene escrita en su código:
 *
 *   {value:!id()?BS().opus48:"claude-opus-4-8",label:"Opus 4.8",
 *    description:"Opus 4.8 \xB7 Legacy",descriptionForModel:"Opus 4.8 - previous Opus version"
 *
 * Devuelve { familia, id, etiqueta, legacy } o null. Solo interesan las
 * versiones ANTERIORES: la última de cada familia es su alias, que se mide
 * aparte. Las variantes "(1M context)" tampoco, porque la ventana tiene su
 * propio selector.
 *
 * `legacy` se lee de lo que el CLI le MUESTRA al usuario (`description`) y no
 * solo de lo que le dice al modelo: Claude Code marca "Legacy" a las 4.x y
 * "Previous version" a las 5, y el selector tiene que decir lo mismo que él.
 *
 * El ID sale del literal del objeto, y si no lo trae (`value:BS().opus41`), de
 * la etiqueta: "Opus 4.1" → "claude-opus-4-1".
 */
function opcionDelMenu(texto) {
  const t = String(texto || '');
  const m = /label:"((Fable|Opus|Sonnet|Haiku) (\d+(?:\.\d+)?))( \(1M context\))?",description:"([^"]*)",descriptionForModel:"([^"]*)"$/.exec(t);
  if (!m || m[4] || !/previous|legacy/i.test(m[6])) return null;
  const fam = m[2].toLowerCase();
  const lit = /"(claude-[a-z]+-\d+(?:-\d+)*)(?:\[1m\])?",label:"/.exec(t);
  const id = (lit && familiaDeVersion(lit[1]) === fam) ? lit[1] : 'claude-' + fam + '-' + m[3].replace(/\./g, '-');
  return { familia: fam, id: id, etiqueta: m[1], legacy: /legacy/i.test(m[5]) || /legacy/i.test(m[6]) };
}

function numeroDeVersion(etiqueta) {
  const m = /(\d+(?:\.\d+)*)\s*$/.exec(String(etiqueta || ''));
  return m ? m[1] : '';
}

/** Tramo a tramo como números: "Opus 4.10" va después de "Opus 4.8", que como texto iría antes. */
function compararVersiones(a, b) {
  const pa = numeroDeVersion(a).split('.');
  const pb = numeroDeVersion(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] || 0);
    const y = Number(pb[i] || 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Qué modelo contestó, de entre los que lista `modelUsage`.
 *
 * El CLI puede usar Haiku por dentro en una llamada (títulos, resúmenes), y si
 * aparece primero, tomar la primera clave dice "Haiku" aunque haya contestado
 * Opus: Editor Pro lo pagó así. Se busca el de la familia pedida y, si no se
 * pidió ninguna, el que más tokens movió sin contar a ese ayudante.
 *
 * Devuelve { id, ventana, salida } —el ID tal como lo escribe el CLI, con su
 * `[1m]` si lo trae— o null.
 */
function cualContesto(modelUsage, pedido) {
  const uso = (modelUsage && typeof modelUsage === 'object') ? modelUsage : {};
  const claves = Object.keys(uso);
  if (!claves.length) return null;
  const fam = leer(pedido).familia;
  let elegida = '';
  if (fam) elegida = claves.find((k) => k.indexOf('claude-' + fam) === 0) || '';
  if (!elegida) {
    let mas = -1;
    for (const k of claves) {
      if (k.indexOf('claude-haiku') === 0 && claves.length > 1) continue;
      const u = uso[k] || {};
      const tokens = Number(u.outputTokens || 0) + Number(u.inputTokens || 0);
      if (tokens > mas) { mas = tokens; elegida = k; }
    }
  }
  if (!elegida) elegida = claves[0];
  const u = uso[elegida] || {};
  return {
    id: elegida,
    ventana: Number(u.contextWindow) > 0 ? Math.round(Number(u.contextWindow)) : 0,
    salida: Number(u.maxOutputTokens) > 0 ? Math.round(Number(u.maxOutputTokens)) : 0,
  };
}

// ─── La medición ──────────────────────────────────────────────────────

/** Lo primero que se mide: el alias de cada familia y cada versión fija del menú. */
function objetivosAMedir(menu) {
  const out = FAMILIAS.map((f) => f.id);
  for (const o of menu || []) if (o && o.id && out.indexOf(o.id) === -1) out.push(o.id);
  return out;
}

/**
 * Lo segundo: el `[1m]` de los que contestaron con MENOS de 1M.
 *
 * A los que ya vienen con 1M no se les pregunta —no hay nada que elegir— y a
 * los que no contestaron, tampoco: una versión retirada no va a tener una
 * variante viva. Así la segunda tanda son dos o tres llamadas, no once.
 */
function objetivosDe1M(medicion) {
  const res = (medicion && medicion.resultados) || {};
  return Object.keys(res).filter((k) => {
    const r = res[k];
    return !/\[1m\]$/.test(k) && r && !r.noDisponible && r.ventana > 0 && r.ventana < UN_MILLON;
  }).map((k) => k + '[1m]');
}

function recortar(texto) {
  return String(texto || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Arma lo que se guarda a partir de lo que contestó cada llamada.
 *
 * @param {string} cli - la versión del CLI con la que se midió
 * @param {object} crudos - { pedido: { contesto: {id, ventana, salida} | null, error } }
 * @param {string} cuando - fecha ISO (la pasa quien llama, para poder probar esto)
 *
 * Responder no alcanza para contar como disponible, y es lo que más importa de
 * esta función: UNA VERSIÓN RETIRADA NO DA ERROR, LA CONTESTA LA ACTUAL. Medido:
 * pedir `claude-opus-4-1` lo contestó Opus 5.5. Tomarlo como "disponible"
 * dejaría al editor creyendo que genera con Opus 4.1. Solo cuenta si contestó
 * ESA versión; si no, queda no disponible y se dice quién contesta en su lugar.
 */
function registrarMedicion(cli, crudos, cuando) {
  const med = { formato: FORMATO, cli: String(cli || ''), at: String(cuando || ''), resultados: {} };
  for (const pedido of Object.keys(crudos || {})) {
    const r = crudos[pedido] || {};
    const p = leer(pedido);
    const c = r.contesto;
    if (!c || !c.id) {
      med.resultados[pedido] = { noDisponible: recortar(r.error) || 'no contestó' };
      continue;
    }
    const quien = etiquetaDeVersion(c.id) || c.id;
    let motivo = '';
    if (p.version && idBase(c.id) !== idBase(p.version)) {
      motivo = 'Retirada: la contesta ' + quien;
    } else if (!p.version && familiaDeVersion(c.id) !== p.familia) {
      motivo = 'La contesta ' + quien + ', que es de otra familia';
    }
    med.resultados[pedido] = motivo
      ? { noDisponible: motivo, contesta: idBase(c.id) }
      : { resuelto: idBase(c.id), ventana: c.ventana || 0, salida: c.salida || 0 };
  }
  return med;
}

/**
 * ¿Sirve para guardarla? Si no contestó NADA, no es que ningún modelo esté
 * disponible: es la sesión o la red. Guardarla deshabilitaría el selector
 * entero por un corte de Wi-Fi.
 */
function sirve(medicion) {
  const res = (medicion && medicion.resultados) || {};
  return Object.keys(res).some((k) => res[k] && res[k].resuelto);
}

/**
 * ¿Lo medido ya no vale? Sin medición, de otro formato, o medida con otro CLI.
 * Si no se sabe qué CLI hay ahora (`cli` vacío), vale la última: no saber no
 * es motivo para borrar lo que sí se sabe.
 */
function vencida(medicion, cli) {
  if (!medicion || medicion.formato !== FORMATO || !medicion.cli || !medicion.resultados) return true;
  if (!cli) return false;
  return medicion.cli !== String(cli);
}

// ─── Lo que ve el editor ──────────────────────────────────────────────

/**
 * 1000000 → "1M", 200000 → "200k". La "k" minúscula es la del resto del panel
 * (HPUtil.fmtVentana, "≈ 128k de entrada"): el selector y el renglón de abajo
 * están en la misma pantalla y no pueden escribir el mismo número de dos formas.
 */
function fmtVentana(tokens) {
  const n = Number(tokens) || 0;
  if (n >= UN_MILLON) return (n / UN_MILLON === Math.round(n / UN_MILLON) ? String(n / UN_MILLON) : (n / UN_MILLON).toFixed(1)) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

/**
 * Las ventanas que tiene sentido elegir para un modelo, cada una con el
 * `--model` EXACTO que hay que mandar. El panel no compone nada: elige una
 * celda y se lleva su string.
 *
 * Los ids son dos y dicen QUÉ variante es, no cuánto mide: 'serie' (el modelo
 * tal cual) y '1m' (el mismo con el sufijo). Es lo que deja arrastrar la
 * elección al cambiar de modelo sin arrastrar un número que el otro no tiene.
 *
 *   - Medido con 1M de serie → una sola, "1M (de serie)": no hay nada que
 *     elegir, y ofrecer un "200k" sería mentir.
 *   - Medido con menos → la de serie con su número, y el 1M con lo que dijo
 *     su propia llamada: su número, o deshabilitada con el motivo (Haiku con
 *     esta suscripción contesta "the long context beta is not yet available").
 *   - Sin medir → lo que se puede afirmar de la familia, sin números: "La de
 *     serie" no dice "200k" porque no se sabe.
 */
function ventanasDe(base, fam, medicion) {
  const res = (medicion && medicion.resultados) || {};
  const f = familia(fam) || { admite1m: false, deSerie1m: false };
  const plano = res[base];
  if (plano && plano.ventana > 0) {
    if (plano.ventana >= UN_MILLON) {
      return [{ id: 'serie', etiqueta: fmtVentana(plano.ventana) + ' (de serie)', modelo: base,
        tokens: plano.ventana, deSerie: true, acerca: 'Viene con la ventana de ' + fmtVentana(plano.ventana) + ' de serie.' }];
    }
    const out = [{ id: 'serie', etiqueta: fmtVentana(plano.ventana), modelo: base, tokens: plano.ventana, acerca: '' }];
    const largo = res[base + '[1m]'];
    if (largo && largo.resuelto) {
      out.push({ id: '1m', etiqueta: fmtVentana(largo.ventana || UN_MILLON), modelo: base + '[1m]',
        tokens: largo.ventana || 0, acerca: ACERCA_1M });
    } else if (largo && largo.noDisponible) {
      out.push({ id: '1m', etiqueta: '1M', modelo: base + '[1m]', tokens: 0, acerca: ACERCA_1M,
        noDisponible: largo.noDisponible });
    } else if (f.admite1m) {
      out.push({ id: '1m', etiqueta: '1M', modelo: base + '[1m]', tokens: 0, acerca: ACERCA_1M });
    }
    return out;
  }
  if (f.deSerie1m) {
    return [{ id: 'serie', etiqueta: '1M (de serie)', modelo: base, tokens: 0, deSerie: true,
      acerca: 'Viene con la ventana de 1M de serie.' }];
  }
  const out = [{ id: 'serie', etiqueta: 'La de serie', modelo: base, tokens: 0, acerca: '' }];
  if (f.admite1m) out.push({ id: '1m', etiqueta: '1M', modelo: base + '[1m]', tokens: 0, acerca: ACERCA_1M });
  return out;
}

/**
 * Las opciones del selector de modelo, agrupadas por familia como el menú
 * /model de Claude Code: primero el último de cada una (su alias, que avanza
 * solo al actualizar el CLI) y después las versiones anteriores que ofrece el
 * CLI instalado, de la más nueva a la más vieja. Esas son fijas: no cambian
 * aunque el CLI se actualice.
 *
 * Una versión elegida que el CLI ya no ofrece se sigue mostrando en su
 * familia: si no, el desplegable enseñaría otra y el editor no sabría qué
 * tiene puesto. Por lo mismo la elegida nunca se deshabilita (eso lo decide el
 * panel con `noDisponible`).
 */
function gruposDeModelo(menu, medicion, actual) {
  const med = medicion || null;
  const res = (med && med.resultados) || {};
  const cur = leer(actual);
  const grupos = [];
  for (const f of FAMILIAS) {
    const ahora = res[f.id] && res[f.id].resuelto ? res[f.id].resuelto : '';
    const ahoraEtiqueta = ahora ? etiquetaDeVersion(ahora) : '';
    const opciones = [{
      valor: f.id,
      etiqueta: (ahoraEtiqueta || f.nombre) + ' · último',
      ultimo: true,
      legacy: false,
      noDisponible: (res[f.id] && res[f.id].noDisponible) || '',
      acerca: f.acerca + '. Siempre el último ' + f.nombre + ' de tu Claude Code' +
        (ahoraEtiqueta ? ' (hoy ' + ahoraEtiqueta + ').' : '.'),
      ventanas: ventanasDe(f.id, f.id, med),
    }];
    const vistos = {};
    const fijas = [];
    for (const o of menu || []) {
      if (!o || o.familia !== f.id || vistos[o.id]) continue;
      // La que hoy contesta el alias ya está arriba como "último": el menú la
      // llama "versión anterior" y repetirla abajo sería contradecirlo.
      if (ahora && idBase(o.id) === ahora) continue;
      vistos[o.id] = true;
      fijas.push(o);
    }
    if (cur.familia === f.id && cur.version && !vistos[cur.version]) {
      fijas.push({ familia: f.id, id: cur.version, etiqueta: etiquetaDeVersion(cur.version) || cur.version, legacy: false });
    }
    fijas.sort((a, b) => compararVersiones(b.etiqueta, a.etiqueta));
    for (const o of fijas) {
      opciones.push({
        valor: o.id,
        etiqueta: o.etiqueta + (o.legacy ? ' · legacy' : ''),
        ultimo: false,
        legacy: !!o.legacy,
        noDisponible: (res[o.id] && res[o.id].noDisponible) || '',
        acerca: 'Fijado en ' + o.etiqueta + ': no cambia cuando se actualiza Claude Code.',
        ventanas: ventanasDe(o.id, f.id, med),
      });
    }
    grupos.push({ familia: f.id, nombre: f.nombre, opciones: opciones });
  }
  return grupos;
}

/** Dónde está parado el modelo guardado: { valor, ventana } dentro de los grupos. */
function ubicar(grupos, predeterminado, propio, modelo) {
  const todas = [predeterminado].concat(propio ? [propio] : []);
  for (const g of grupos) for (const o of g.opciones) todas.push(o);
  const m = String(modelo == null ? '' : modelo).trim();
  // Primero la celda exacta: es lo que se manda de verdad.
  for (const o of todas) {
    for (const v of o.ventanas) if (v.modelo === m) return { valor: o.valor, ventana: v.id };
  }
  // Si no está (un "opus[1m]" guardado cuando `opus` ya trae 1M de serie), el
  // modelo es el mismo y la ventana, la que haya: no se inventa una celda.
  const p = leer(m);
  const valor = p.propio ? p.propio : (p.version || p.familia || 'default');
  for (const o of todas) {
    if (o.valor !== valor) continue;
    const quiere = p.extendida ? '1m' : 'serie';
    const v = o.ventanas.find((x) => x.id === quiere) || o.ventanas[0];
    return { valor: o.valor, ventana: v.id };
  }
  return { valor: 'default', ventana: predeterminado.ventanas[0].id };
}

/** El renglón que cuenta si lo medido sigue valiendo. */
function estadoDeMedicion(medicion, cli) {
  if (!medicion || medicion.formato !== FORMATO) {
    return 'Tocá «Verificar» para ver qué versión hay detrás de cada modelo.';
  }
  if (vencida(medicion, cli)) {
    return 'Las versiones se comprobaron con Claude Code ' + medicion.cli +
      '. Tocá «Verificar» para ver los modelos de esta versión.';
  }
  return 'Comprobado con Claude Code ' + medicion.cli + '.';
}

/**
 * TODO lo que necesita el panel para dibujar el selector, en una respuesta.
 *
 * Cada opción trae su `acerca`, cada ventana el suyo y cada esfuerzo el suyo:
 * el panel pinta los renglones de abajo concatenando, sin decidir nada. Así la
 * redacción vive en un solo lugar, y ese lugar se prueba en Node.
 *
 * @param {object} q - { menu, medicion, cli, modelo, esfuerzo }
 *   `medicion` puede venir vencida (de otro CLI). Se descarta ACÁ, una vez, y
 *   lo de abajo trabaja como si no hubiera: solo el renglón de estado la mira,
 *   para decir con qué versión se había medido.
 */
function catalogo(q) {
  q = q || {};
  const cli = String(q.cli || '');
  const valida = vencida(q.medicion, cli) ? null : q.medicion;
  const grupos = gruposDeModelo(q.menu, valida, q.modelo);
  const predeterminado = {
    valor: 'default', etiqueta: 'Predeterminado de tu plan', ultimo: false, legacy: false, noDisponible: '',
    acerca: 'Usa el que tu plan de Claude tenga como predeterminado.',
    ventanas: [{ id: 'serie', etiqueta: 'La del plan', modelo: 'default', tokens: 0, acerca: '' }],
  };
  const p = leer(q.modelo);
  const propio = p.propio ? {
    valor: p.propio, etiqueta: p.propio, ultimo: false, legacy: false, noDisponible: '',
    acerca: 'Un modelo escrito a mano: va al CLI tal cual.',
    ventanas: [{ id: 'serie', etiqueta: 'La de serie', modelo: p.propio, tokens: 0, acerca: '' }],
  } : null;
  const esfuerzo = ESFUERZOS.some((e) => e.id === q.esfuerzo) ? q.esfuerzo : 'high';
  return {
    cli: cli,
    medido: valida ? { cli: valida.cli, at: valida.at } : null,
    vencida: !valida,
    predeterminado: predeterminado,
    propio: propio,
    grupos: grupos,
    esfuerzos: ESFUERZOS.map((e) => Object.assign({}, e)),
    actual: Object.assign(ubicar(grupos, predeterminado, propio, q.modelo), { esfuerzo: esfuerzo }),
    estado: estadoDeMedicion(q.medicion, cli),
  };
}

/** Una línea para el resumen: "Opus 5.5 · 1M · pensamiento Alto". */
function resumen(cat) {
  if (!cat || !cat.actual) return '';
  const todas = [cat.predeterminado].concat(cat.propio ? [cat.propio] : []);
  for (const g of cat.grupos) for (const o of g.opciones) todas.push(o);
  const o = todas.find((x) => x.valor === cat.actual.valor);
  if (!o) return '';
  const v = o.ventanas.find((x) => x.id === cat.actual.ventana) || o.ventanas[0];
  const e = cat.esfuerzos.find((x) => x.id === cat.actual.esfuerzo);
  const nombre = o.ultimo ? o.etiqueta.replace(/ · último$/, '') : o.etiqueta.replace(/ · legacy$/, '');
  const partes = [nombre];
  if (v && v.tokens > 0) partes.push(fmtVentana(v.tokens));
  if (e) partes.push('pensamiento ' + e.etiqueta);
  return partes.join(' · ');
}

module.exports = {
  FORMATO, FAMILIAS, ESFUERZOS, UN_MILLON,
  familia, idBase, familiaDeVersion, etiquetaDeVersion, leer,
  opcionDelMenu, compararVersiones, cualContesto,
  objetivosAMedir, objetivosDe1M, registrarMedicion, sirve, vencida,
  ventanasDe, gruposDeModelo, catalogo, resumen, fmtVentana,
};
