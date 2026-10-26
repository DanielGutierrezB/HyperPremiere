'use strict';

// LA TIPOGRAFÍA DE LAS ANIMACIONES: Bricolage Grotesque y Plus Jakarta Sans.
//
// El pedido, con la guía de marca: «Bricolage Grotesque, para titulares y
// frases destacadas. Plus Jakarta Sans, para texto de apoyo, cuerpo y UI». Hasta
// la 1.9.2 era DM Sans, escrita en el sistema de diseño común, la plantilla de
// HyperFrames, la lista de imports de Remotion, los módulos de su proyecto y su
// ejemplo. Lo que se fija acá es que todos digan lo mismo, que los dos motores
// pidan las fuentes IGUAL, y que lo hecho con DM Sans se siga pudiendo
// renderizar.
//
// Que las dos fuentes de verdad lleguen al video —se bajan de Google Fonts al
// renderizar— lo mide test/manual/tipografia-render.js.

const fs = require('fs');
const path = require('path');
const { test, ok, eq, has } = require('./harness');

const motores = require('../bridge/render');
const { PERMITIDOS, HEREDADOS, permitido } = require('../bridge/remotion-host/src/permitidos');
const { CSS_FUENTES, FAMILIAS, TEXTO } = require('../bridge/remotion-host/src/fuentes');

const PROMPT = path.join(__dirname, '..', 'bridge', 'prompt');
const HUESPED = path.join(__dirname, '..', 'bridge', 'remotion-host', 'src');
const COMUN = fs.readFileSync(path.join(PROMPT, 'system-comun.md'), 'utf8');
const HYPERFRAMES = fs.readFileSync(path.join(PROMPT, 'system-hyperframes.md'), 'utf8');

const DMSANS = '@remotion/google-fonts/DMSans';

// ── El sistema de diseño ──────────────────────────────────────────────

test('el sistema de diseño nombra las dos familias, cada una con su uso', function () {
  has(COMUN, '**Bricolage Grotesque** para titulares y frases destacadas');
  has(COMUN, '**Plus Jakarta Sans** para el texto de apoyo, el cuerpo y la UI');
  has(COMUN, 'Nunca al revés', 'y que no se intercambian');
  // El curso puede pedir otra: los tres niveles del prompt mandan sobre el
  // sistema de diseño, que es la base.
  has(COMUN, 'salvo que el prompt del curso, el de la secuencia o la instrucción pidan otra');
});

test('los dos motores la reciben, y ninguno sigue hablando de DM Sans', function () {
  motores.ids().forEach(function (id) {
    const sistema = motores.motor(id).systemPrompt();
    has(sistema, 'Bricolage Grotesque', id);
    has(sistema, 'Plus Jakarta Sans', id);
    eq(sistema.indexOf('DM Sans'), -1, id + ': un prompt con las dos fuentes viejas y nuevas es un modelo eligiendo');
    eq(sistema.indexOf('DMSans'), -1, id);
  });
});

// ── HyperFrames ───────────────────────────────────────────────────────

test('la plantilla de HyperFrames carga las dos y deja cada una en su lugar', function () {
  const link = HYPERFRAMES.split('\n').filter((l) => l.indexOf('fonts.googleapis.com') !== -1);
  eq(link.length, 1, 'UN solo <link>: las dos familias en un pedido');
  has(HYPERFRAMES, "body{font-family:'Plus Jakarta Sans',sans-serif;", 'el cuerpo, por herencia');
  has(HYPERFRAMES, ".titular{font-family:'Bricolage Grotesque',sans-serif}", 'y los titulares, por clase');
  has(HYPERFRAMES, 'llevan la clase `titular`', 'con la regla dicha en palabras');
});

// ── El mismo pedido en los dos motores ────────────────────────────────

test('los dos motores le piden a Google Fonts exactamente lo mismo', function () {
  // Pedidos distintos son fuentes distintas con el mismo nombre: la de
  // @remotion/google-fonts no traía el corte de titular de Bricolage, y el mismo
  // titular salía más ancho en Remotion que en HyperFrames.
  has(HYPERFRAMES, '<link href="' + CSS_FUENTES + '" rel="stylesheet">', 'la plantilla trae el pedido de fuentes.js, tal cual');
  has(CSS_FUENTES, 'family=Bricolage+Grotesque:opsz,', 'con el eje de tamaño óptico: es el corte de titular');
  has(CSS_FUENTES, 'family=Plus+Jakarta+Sans:');
  eq(FAMILIAS.join(' · '), 'Bricolage Grotesque · Plus Jakarta Sans');
});

test('el proyecto de Remotion las carga antes del primer cuadro, y hereda Plus Jakarta Sans', function () {
  // Sin navegador acá: lo que se puede mirar es que el `Marco` —que envuelve la
  // animación en el render del panel y en Studio— haga el pedido y espere.
  const comp = fs.readFileSync(path.join(HUESPED, 'Composicion.tsx'), 'utf8');
  has(comp, "import {CSS_FUENTES, FAMILIAS, TEXTO} from './fuentes';");
  has(comp, 'link.href = CSS_FUENTES;');
  has(comp, "document.fonts.load('400 100px \"' + familia + '\"')", 'espera cada familia');
  has(comp, 'cargarFuentes()\n      .then(', 'antes de soltar el primer cuadro (la llamada, no la definición)');
  has(comp, 'fontFamily: TEXTO', 'y lo que no diga otra cosa sale en Plus Jakarta Sans');
  eq(TEXTO, "'Plus Jakarta Sans', sans-serif");
  has(fs.readFileSync(path.join(HUESPED, 'RaizStudio.tsx'), 'utf8'), '<Marco conFondo=', 'Studio usa el mismo Marco');
});

// ── Remotion ──────────────────────────────────────────────────────────

test('Remotion no ofrece fuentes para importar: la tipografía la pone el proyecto', function () {
  eq(PERMITIDOS.filter((n) => n.indexOf('google-fonts') !== -1).length, 0,
    'una fuente importada de @remotion/google-fonts es otra versión de Bricolage con el mismo nombre');
  eq(motores.motor('remotion').reglas.join('\n').indexOf('google-fonts'), -1);
  const rem = fs.readFileSync(path.join(PROMPT, 'system-remotion.md'), 'utf8');
  has(rem, '**La tipografía NO se importa**');
  has(rem, "fontFamily: \"'Bricolage Grotesque', sans-serif\"", 'se usa por su nombre');
});

test('lo hecho con DM Sans se sigue aceptando', function () {
  // Las versiones de antes la importan: sacarla dejaría sin poder
  // re-renderizarlas, corregirlas ni abrirlas en Studio.
  ok(HEREDADOS.indexOf(DMSANS) !== -1);
  ok(permitido(DMSANS));
  const r = motores.motor('remotion').revisar(
    "import {loadFont} from '" + DMSANS + "';\nexport default function M() { return null; }");
  eq(r.problema, null, 'una versión vieja pasa la validación: ' + (r.detalle || ''));
});

test('cada import aceptado tiene su módulo en el bundle, y al revés', function () {
  // permitidos.js dice qué se puede importar y modulos.ts lo trae al bundle. Si
  // no coinciden, el validador acepta algo que en el render no existe, o
  // rechaza algo que estaba.
  const modulos = fs.readFileSync(path.join(HUESPED, 'modulos.ts'), 'utf8');
  const cuerpo = modulos.slice(modulos.indexOf('export const MODULOS'));
  const enElBundle = (cuerpo.match(/^\s+'?([@a-z][^':]*)'?: [A-Za-z]+,$/gm) || [])
    .map((l) => l.trim().replace(/: [A-Za-z]+,$/, '').replace(/^'|'$/g, ''));
  const aceptados = PERMITIDOS.concat(HEREDADOS);
  aceptados.forEach(function (n) { ok(enElBundle.indexOf(n) !== -1, n + ' se acepta y no está en el bundle'); });
  enElBundle.forEach(function (n) { ok(aceptados.indexOf(n) !== -1, n + ' está en el bundle y el validador lo rechaza'); });
});

test('el ejemplo del contrato de Remotion solo importa lo que se acepta, y usa el titular por su nombre', function () {
  // Es el código que el modelo copia: un import de fuera en el ejemplo es una
  // composición que falla la validación en cada generación.
  const rem = fs.readFileSync(path.join(PROMPT, 'system-remotion.md'), 'utf8');
  // El ejemplo entero, que es la valla al principio de una línea: antes hay un
  // fragmento indentado de dos líneas.
  const desde = rem.indexOf('\n```tsx\n');
  const ejemplo = rem.slice(desde, rem.indexOf('\n```', desde + 8));
  const imports = (ejemplo.match(/from '([^']+)'/g) || []).map((s) => s.slice(6, -1));
  ok(imports.length >= 1, 'el ejemplo importa algo: ' + imports.join(', '));
  imports.forEach(function (n) { ok(permitido(n), 'el ejemplo importa ' + n); });
  eq(imports.filter((n) => n.indexOf('google-fonts') !== -1).length, 0, 'y ninguna fuente');
  has(ejemplo, "const TITULAR = \"'Bricolage Grotesque', sans-serif\";");
  has(ejemplo, 'fontFamily: TITULAR', 'el titular, en Bricolage');
});
