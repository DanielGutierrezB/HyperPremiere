#!/usr/bin/env node
'use strict';

// Calcula la tabla de contrastes del tema contra WCAG 2.2, y la imprime en
// markdown. No es un adorno del reporte: es la herramienta con la que se
// eligieron los colores. Cada token salió de acá, no del ojo.
//
// Fórmula: la de WCAG 2.x (luminancia relativa sRGB + (L1+0.05)/(L2+0.05)),
// con los umbrales de 1.4.3 (4.5:1 texto chico, 3:1 texto grande) y 1.4.11
// (3:1 para el borde que identifica un control o un estado).
//
//   node test/manual/panel-demo/temas/estudiado/contrastes.js
//   node .../contrastes.js --buscar "#34d399"   → contra las cuatro superficies

function hex2rgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function lum(c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function ratio(a, b) {
  const l1 = lum(hex2rgb(a)), l2 = lum(hex2rgb(b));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** Mezcla `fg` con alpha sobre `bg` opaco (es lo que hace un rgba() en el CSS). */
function mezcla(fg, bg, a) {
  const f = hex2rgb(fg), b = hex2rgb(bg);
  const h = (v) => ('0' + Math.round(v).toString(16)).slice(-2);
  return '#' + h(f.r * a + b.r * (1 - a)) + h(f.g * a + b.g * (1 - a)) + h(f.b * a + b.b * (1 - a));
}

// ── Las superficies del tema ──────────────────────────────────────────
const S = {
  'base': '#0f1115',
  'raised': '#1c2027',
  'sunken': '#090a0d',
  'overlay': '#252b33',
};

// ── Los colores de texto y de estado ──────────────────────────────────
const T = {
  '--t-1 primario (nivel 1: identidad de fila)': '#e9edf2',
  '--t-2 secundario (nivel 2: estado y dato)': '#a8b3c1',
  '--t-3 terciario (nivel 3: metadato, rótulos, Y LO DESHABILITADO)': '#8e97a3',
  '--c-ok listo': '#3ed890',
  '--c-warn atención / sin cupo / rehacer': '#f5b43c',
  '--c-error error': '#ff8a8a',
  '--c-accent foco · acción principal · en curso': '#7ab4ff',
};

// Los bordes que IDENTIFICAN un control o un estado: piden 3:1 (SC 1.4.11).
const B = {
  '--linea-campo (borde de campo, anillo de foco, seleccionado)': '#737c86',
};
// Y la decorativa, que NO pide 3:1 y se mide aparte para dejarlo dicho.
const BD = {
  '--linea-suave (divisores, borde de tarjeta y de botón)': '#2b3138',
};

function tabla(titulo, mapa, umbral, nota) {
  console.log('\n### ' + titulo + '\n');
  const cab = umbral ? ' veredicto |' : ' peor caso |';
  console.log('| color | ' + Object.keys(S).join(' | ') + ' |' + cab);
  console.log('| --- | ' + Object.keys(S).map(() => '---').join(' | ') + ' | --- |');
  Object.keys(mapa).forEach((k) => {
    const rs = Object.keys(S).map((s) => ratio(mapa[k], S[s]));
    const min = Math.min.apply(null, rs);
    console.log('| `' + mapa[k] + '` ' + k + ' | ' +
      rs.map((r) => r.toFixed(2) + ':1').join(' | ') + ' | ' +
      (umbral ? ((min >= umbral ? '**pasa** ' : '**NO** ') + '(pide ' + umbral + ':1)')
              : (min.toFixed(2) + ':1')) + ' |');
  });
  if (nota) console.log('\n' + nota);
}

const buscar = process.argv.indexOf('--buscar');
if (buscar !== -1) {
  const c = process.argv[buscar + 1];
  Object.keys(S).forEach((s) => console.log(c + ' sobre ' + S[s] + ' (' + s + '): ' + ratio(c, S[s]).toFixed(2) + ':1'));
  process.exit(0);
}

console.log('# Contrastes del tema «estudiado» — medidos, no elegidos');
console.log('\nSuperficies: ' + Object.keys(S).map((k) => '`' + S[k] + '` ' + k).join(' · '));

tabla('Texto (SC 1.4.3, AA: 4.5:1 — acá no hay texto “grande”, así que nada usa el 3:1)', T, 4.5,
  'El peor caso de cada fila es el que manda: un mismo token se pinta sobre las cuatro superficies.');

tabla('Bordes que identifican un control o un estado (SC 1.4.11, 3:1)', B, 3,
  'El propio documento de 1.4.11 aclara que un botón CON etiqueta no necesita borde para ' +
  'identificarse («Pass: A button without a visual boundary – the button\'s text is sufficient ' +
  'to indicate the presence of the control»). Un campo de texto vacío sí: su borde es lo único ' +
  'que dice que ahí se escribe. Por eso el 3:1 se le exige al borde de campo, al anillo de foco ' +
  'y al estado seleccionado, y no a cada divisor.');

tabla('Líneas decorativas (NO piden 3:1)', BD, 0,
  'Si todo divisor estuviera a 3:1, la retícula competiría con el contenido — «if everything is ' +
  'contrasted, then nothing stands out» (NN/g). El umbral de esta tabla es 0 porque el criterio ' +
  'no aplica: lo que está midiéndose es cuánto NO se ve, y a propósito.');

// Las tintas sobre relleno de color.
console.log('\n### Tintas sobre relleno de color (la etiqueta de un botón lleno)\n');
console.log('| tinta | sobre | contraste | AA |');
console.log('| --- | --- | --- | --- |');
[['--on-accent `#0a1220`', '#0a1220', '#7ab4ff', 'el acento (botón Generar, badge de la pestaña)'],
 ['--on-ok `#06180f`', '#06180f', '#3ed890', 'el verde (etiqueta ✓ usar)'],
 ['--on-warn `#2a1e00`', '#2a1e00', '#f5b43c', 'el ámbar (contador de trabajos esperando)']]
  .forEach(([n, fg, bg, q]) => {
    const r = ratio(fg, bg);
    console.log('| ' + n + ' | `' + bg + '` ' + q + ' | ' + r.toFixed(2) + ':1 | ' + (r >= 4.5 ? '**pasa**' : '**NO**') + ' |');
  });

// ── Los chips de estado: texto de estado sobre su propio tinte ────────
console.log('\n### Chips de estado (el texto sobre su propio fondo tintado)\n');
console.log('| chip | fondo compuesto | texto | contraste | AA |');
console.log('| --- | --- | --- | --- | --- |');
[['listo', '--c-ok listo', 0.14], ['atención', '--c-warn atención / sin cupo / rehacer', 0.14],
 ['error', '--c-error error', 0.14], ['en curso', '--c-accent foco · acción principal · en curso', 0.14]]
  .forEach(([n, k, a]) => {
    const col = T[k];
    ['raised', 'base'].forEach((s) => {
      const fondo = mezcla(col, S[s], a);
      const r = ratio(col, fondo);
      console.log('| ' + n + ' sobre ' + s.split(' ')[0] + ' | `' + fondo + '` (' + Math.round(a * 100) + '% de ' + col + ') | `' + col + '` | ' +
        r.toFixed(2) + ':1 | ' + (r >= 4.5 ? '**pasa**' : '**NO**') + ' |');
    });
  });

// ── Lo que hay hoy, con la misma regla ────────────────────────────────
console.log('\n### Lo de hoy, medido con la misma fórmula\n');
const HOY_S = { 'bg-base #0e1116': '#0e1116', 'bg-panel #12161d': '#12161d', 'bg-inset #10141a': '#10141a', 'bg-surface #1a1f28': '#1a1f28', 'marker-card #161b22': '#161b22' };
const HOY_T = {
  '--text-primary': '#e8e6df',
  '--text-secondary': '#8b97a8',
  '--text-muted': '#5c6675',
};
console.log('| color | ' + Object.keys(HOY_S).join(' | ') + ' | AA |');
console.log('| --- | ' + Object.keys(HOY_S).map(() => '---').join(' | ') + ' | --- |');
Object.keys(HOY_T).forEach((k) => {
  const rs = Object.keys(HOY_S).map((s) => ratio(HOY_T[k], HOY_S[s]));
  const min = Math.min.apply(null, rs);
  console.log('| `' + HOY_T[k] + '` ' + k + ' | ' + rs.map((r) => r.toFixed(2) + ':1').join(' | ') + ' | ' +
    (min >= 4.5 ? 'pasa' : '**NO (' + min.toFixed(2) + ':1)**') + ' |');
});

console.log('\nY los `opacity` del deshabilitado, compuestos como los compone el navegador:\n');
console.log('Un elemento con `opacity < 1` pinta su subárbol en una capa y la compone sobre lo que');
console.log('hay atrás. O sea que el glifo NO se tiñe del fondo de su propio botón (adentro de la');
console.log('capa lo tapa): glifo y fondo se desvanecen JUNTOS contra la superficie. Esa es la');
console.log('cuenta de abajo, y es la que coincide con lo que mide `auditar.js` sobre el DOM real.\n');
console.log('| regla | texto | fondo del botón | sobre | glifo visible | fondo visible | contraste | AA |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
[
  ['`button:disabled` opacity .45 (`style.css:168`)', '#e8e6df', null, '#12161d', 0.45],
  ['`.btn-secondary:disabled` opacity .45 (682)', '#e8e6df', null, '#161b22', 0.45],
  ['`.icon-btn:disabled` opacity .45 (168)', '#8b97a8', null, '#12161d', 0.45],
  ['`.btn-generate:disabled` opacity .5 (643)', '#0e1116', '#60a5fa', '#161b22', 0.5],
  ['`.mic-btn.is-off` opacity .4 (1823)', '#e8e6df', null, '#10141a', 0.4],
  ['`.qbtn:disabled` opacity .45 (168)', '#5c6675', null, '#0e1116', 0.45],
].forEach(([n, fg, relleno, sup, a]) => {
  const glifo = mezcla(fg, sup, a);
  const fondo = relleno ? mezcla(relleno, sup, a) : sup;
  const r = ratio(glifo, fondo);
  console.log('| ' + n + ' | `' + fg + '` | ' + (relleno ? '`' + relleno + '`' : '—') + ' | `' + sup +
    '` | `' + glifo + '` | `' + fondo + '` | ' + r.toFixed(2) + ':1 | ' + (r >= 4.5 ? 'pasa' : '**NO**') + ' |');
});
console.log('\nEn el tema, lo deshabilitado no usa `opacity`: usa `--t-3` (4.83:1 en el peor caso) y');
console.log('pierde la caja. Medido sobre el DOM con `auditar.js --tema estudiado`, las seis familias');
console.log('de botón apagado quedan entre 5.53:1 y 6.70:1.\n');

console.log('\nLas hairlines de hoy, contra el 3:1 de 1.4.11:\n');
console.log('| regla | compuesto sobre #161b22 | contraste | 1.4.11 |');
console.log('| --- | --- | --- | --- |');
[['--hairline rgba(255,255,255,.08)', 0.08], ['--hairline-strong rgba(255,255,255,.14)', 0.14]]
  .forEach(([n, a]) => {
    const c = mezcla('#ffffff', '#161b22', a);
    const r = ratio(c, '#161b22');
    console.log('| `' + n + '` | `' + c + '` | ' + r.toFixed(2) + ':1 | ' + (r >= 3 ? 'pasa' : '**NO**') + ' |');
  });
