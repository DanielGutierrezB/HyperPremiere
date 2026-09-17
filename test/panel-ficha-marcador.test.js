'use strict';

// EL INTERIOR DE LA FICHA, y que sea UNO para los tres lugares donde se le pide
// algo al modelo.
//
// Lo que el editor dijo, textual: "No me gusta mucho esta distribución, dejamos
// mucho espacio vacío. […] Creo que deberíamos tener un área de controles y otra
// de input." Y de un mensaje anterior: las dos tarjetas de estilo comparten esta
// misma interfaz "en su versión de lo que piden".
//
// Así que acá se fija la forma —qué va arriba de qué— y sobre todo que sea LA
// MISMA en los tres: una maqueta pegada a los marcadores es lo que este cambio
// vino a no ser. Lo que estos tests NO hacen es medir cajas: el DOM de mentira
// del repo no tiene motor de layout. Eso se mide con la maqueta
// (`test/manual/panel-demo/medir-botones.js` y `temas/estudiado/auditar.js`).

const fs = require('fs');
const path = require('path');
const { test, ok, eq, has } = require('./harness');

const RAIZ = path.join(__dirname, '..');
const CEP = path.join(RAIZ, 'cep', 'js');
const HTML = fs.readFileSync(path.join(RAIZ, 'cep', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(RAIZ, 'cep', 'css', 'style.css'), 'utf8');
const CARD = fs.readFileSync(path.join(CEP, 'prompt-card.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(CEP, 'main.js'), 'utf8');
const VISTA = fs.readFileSync(path.join(CEP, 'general-view.js'), 'utf8');

function reglas(css) {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const abiertos = [];
  let selDesde = 0;
  for (let i = 0; i < limpio.length; i++) {
    if (limpio[i] === '{') {
      abiertos.push({ selector: limpio.slice(selDesde, i).trim(), desde: i + 1, prof: abiertos.length });
      selDesde = i + 1;
    } else if (limpio[i] === '}') {
      const b = abiertos.pop();
      if (b) {
        const cuerpo = limpio.slice(b.desde, i);
        if (cuerpo.indexOf('{') === -1) {
          out.push({ selector: b.selector.replace(/\s+/g, ' '), cuerpo: cuerpo, dentroDeMedia: b.prof > 0 });
        }
      }
      selDesde = i + 1;
    }
  }
  return out;
}
const REGLAS = reglas(CSS);

function declaraciones(selector, incluirMedia) {
  const d = {};
  REGLAS.filter((r) => r.selector === selector && (incluirMedia || !r.dentroDeMedia)).forEach((r) => {
    r.cuerpo.split(';').forEach((par) => {
      const i = par.indexOf(':');
      if (i !== -1) d[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    });
  });
  return d;
}

/** El índice de una marca en el archivo. Falla si no está (para no comparar -1). */
function donde(txt, marca, quien) {
  const i = txt.indexOf(marca);
  ok(i !== -1, (quien || '') + ' tiene que tener «' + marca + '»');
  return i;
}

// ── 1. El orden de arriba a abajo ────────────────────────────────────

test('el cuerpo va: referencias, campo, aviso, controles', function () {
  // Es el orden del pedido, y cada paso tiene su motivo escrito en la cabecera de
  // prompt-card.js. El que el editor pidió con nombre y apellido es que las
  // referencias vayan ARRIBA del campo ("para que se entienda que van con el
  // prompt").
  const tira = donde(CARD, 'caja.appendChild(tira)', 'prompt-card');
  const campo = donde(CARD, 'envoltorio.appendChild(campo)', 'prompt-card');
  const aviso = donde(CARD, 'caja.appendChild(aviso)', 'prompt-card');
  const barra = donde(CARD, 'caja.appendChild(barra)', 'prompt-card');
  ok(tira < campo, 'las referencias ARRIBA del campo');
  ok(campo < aviso, 'el aviso de menciones pegado abajo del campo, que es donde se mira');
  ok(aviso < barra, 'y los controles al final');
});

test('el cuerpo NO tiene renglón de metadatos: eso vive en el encabezado', function () {
  // Estuvieron un rato acá arriba y el editor los quiso en el `<summary>`: "esto
  // debería estar en el cabecero […], no acá ocupando espacio vertical". Se fueron
  // enteros, con su opción y su CSS: dejar la opción sin nadie que la use es dejar
  // dos lugares donde puede vivir el mismo dato.
  ok(CARD.indexOf('hp-meta') === -1, 'prompt-card no arma ningún renglón de metadatos');
  ok(CSS.indexOf('.hp-meta') === -1, 'y no quedó CSS huérfano');
});

test('el desplegable Avanzado y el pie de acciones van al final, en ese orden', function () {
  const barra = donde(CARD, 'caja.appendChild(barra)', 'prompt-card');
  const adv = donde(CARD, 'caja.appendChild(adv)', 'prompt-card');
  const pie = donde(CARD, 'caja.appendChild(pie)', 'prompt-card');
  ok(barra < adv && adv < pie, 'controles → Avanzado → acciones');
});

// ── 2. Un solo cuerpo para los tres ──────────────────────────────────

test('los tres lugares donde se le pide algo al modelo usan el MISMO cuerpo', function () {
  has(MAIN, 'HPPromptCard.montar({', 'la ficha del marcador');
  has(VISTA, 'HPPromptCard.montar({', 'y los dos bloques de estilo');
  // Y no hay un segundo armado en paralelo: si el marcador se dibujara solo, la
  // gramática duraría hasta el próximo cambio en uno de los dos.
  eq((MAIN.match(/HPPromptCard\.montar\(/g) || []).length, 1);
  eq((VISTA.match(/HPPromptCard\.montar\(/g) || []).length, 1,
    'uno por vista: la de estilo lo llama una vez por nivel, en un solo lugar');
});

test('los bloques de estilo NO tienen pie de acciones, y el marcador sí', function () {
  // "Sin los botones de generar, que no les corresponden": un Estilo del curso no
  // genera nada, así que un pie vacío ahí sería una fila que promete un clic.
  has(MAIN, 'acciones: { izquierda: [regenBtn], derecha: [queueBtn, genBtn] }');
  const opciones = VISTA.slice(VISTA.indexOf('HPPromptCard.montar({'));
  ok(opciones.slice(0, opciones.indexOf('});')).indexOf('acciones:') === -1,
    'los de estilo no le pasan ninguna acción');
  has(CARD, 'if (opts.acciones)', 'y el pie solo se dibuja si le mandan acciones');
});

test('el campo de los bloques de estilo se DECLARA en el HTML, con su id', function () {
  // El `<textarea>` de index.html es la declaración del campo —su id, su
  // placeholder y su rótulo— y HPCampo lo reemplaza heredando las tres, en el lugar
  // donde ya estaba: un campo que pinta las menciones como chips no puede ser un
  // textarea (ver cep/js/campo.js). El id importa porque lo nombran HPGeneralView y
  // cuatro tests.
  has(HTML, 'id="general-instruction"');
  has(HTML, 'id="general-sequence-instruction"');
  has(VISTA, 'campo: declarado', 'la ficha recibe el textarea declarado…');
  has(VISTA, 'n.input = n.ficha.campo', '…y el campo que queda en pantalla es el que ella devuelve');
  has(VISTA, 'padre.insertBefore(n.ficha.el, ancla)',
    'la ficha entra donde estaba el campo, no al final del bloque');
  // Y el rótulo lo nombra con `aria-labelledby`: el `for=` de un `<label>` sólo
  // alcanza a un control de formulario, y esto ya no lo es. Dejarle el `for=`
  // apuntando a un id que ahora es un `<div>` habría dejado el campo sin nombre sin
  // que nada falle.
  ok(HTML.indexOf('for="general-instruction"') === -1, 'sin `for=` colgando de un div');
  ok(HTML.indexOf('for="general-sequence-instruction"') === -1);
  has(HTML, 'id="general-label"');
  has(HTML, 'id="general-sequence-label"');
  has(VISTA, 'rotulo: n.rotulo');
  has(fs.readFileSync(path.join(CEP, 'campo.js'), 'utf8'),
    'campo.setAttribute("aria-labelledby", opts.rotulo)');
});

// ── 3. Lo que se fue, y lo que se ganó con eso ───────────────────────

test('la zona de arrastre no existe más: se suelta sobre el campo', function () {
  // 52 px permanentes, también con seis referencias adentro, para repetir una
  // instrucción que se aprende la primera vez.
  const stills = fs.readFileSync(path.join(CEP, 'stills.js'), 'utf8');
  const refs = fs.readFileSync(path.join(CEP, 'refs-view.js'), 'utf8');
  ok(refs.indexOf('class="dropzone"') === -1,
    'los bloques de estilo ya no dibujan zona de arrastre');
  ok(MAIN.indexOf('dropzone') === -1, 'ni la ficha del marcador');
  has(CARD, 'campo.addEventListener("drop"', 'el campo recibe el archivo');
  has(CARD, 'tira.addEventListener("drop"', 'y también la tira, que es donde se está mirando');
  // Y desde la 1.6.x tampoco la tienen la Cola ni Corrections: las dos pasaron al
  // mismo cuerpo de ficha, así que la zona de arrastre se fue del panel entero
  // —con ella se fue `createControl`, la caja que la dibujaba, y sus dos reglas de
  // CSS—. Era el último layout que quedaba del cuerpo viejo.
  ok(stills.indexOf('dropzone') === -1, 'ni la tira de referencias, que es la única caja que quedó');
  ok(stills.indexOf('function createControl') === -1, 'la caja completa vieja se fue entera');
  ok(CSS.indexOf('.dropzone {') === -1, 'y no quedó CSS huérfano');
  // Y las dos siguen dibujando la tira y recibiendo el archivo en el campo, pero
  // ya no lo escriben ellas: las tres fichas de marcador lo pedían con el MISMO
  // cableado copiado entero, así que ahora lo arma la ficha a partir de `stills`
  // (ver `cablearStills` en cep/js/prompt-card.js). Lo que se fija es que las dos
  // lo PIDAN: con una copia a mano vuelve la divergencia que esto vino a matar.
  const cola = fs.readFileSync(path.join(CEP, 'queue-view.js'), 'utf8');
  const corr = fs.readFileSync(path.join(CEP, 'corrections.js'), 'utf8');
  has(CARD, 'cont.appendChild(HPStills.crearTira(clave, hoja()).el)', 'la ficha dibuja la tira');
  has(CARD, 'soltar: function (files) { HPStills.ingerir(files, clave, hoja()); }',
    'y recibe el archivo en el campo');
  [['la Cola', cola], ['Corrections', corr]].forEach(function (par) {
    has(par[1], 'stills: { clave:', par[0] + ' le pide las referencias a la ficha');
    ok(par[1].indexOf('HPStills.crearTira(') === -1, par[0] + ' no se arma la tira a mano');
    ok(par[1].indexOf('soltar:') === -1, par[0] + ' ni el arrastre');
  });
});

test('con la tira vacía no ocupa NADA, y no hay ningún renglón de ayuda', function () {
  // Hubo uno («Sin imágenes propias: arrastrá una sobre el campo») y el editor no lo
  // quiso: sobra dos veces, porque el `placeholder` del propio campo ya lo dice y
  // cuando la tira está vacía el campo suele estarlo también, así que el placeholder
  // se está viendo. Y la tira entera se esconde: no son 16 px, son 0.
  ok(CSS.indexOf('.hp-tira-vacia') === -1, 'la clase del renglón no existe más');
  const stills = fs.readFileSync(path.join(CEP, 'stills.js'), 'utf8');
  const refs = fs.readFileSync(path.join(CEP, 'refs-view.js'), 'utf8');
  ok(stills.indexOf('hp-tira-vacia') === -1 && refs.indexOf('hp-tira-vacia') === -1,
    'ni en el JS de los dos dueños de la tira');
  eq(declaraciones('.hp-tira[data-vacia="true"]').display, 'none',
    'y la tira vacía se esconde entera: cero píxeles');
  has(CARD, 'tira.setAttribute("data-vacia"', 'lo decide la ficha, que es la que sabe si hay algo');
  // Y el `placeholder` que la reemplaza dice lo que hay que saber, en los tres campos.
  has(HTML, 'Arrastrá acá el logo o el manual de marca', 'el del curso');
  has(HTML, 'Arrastrá acá una imagen o un PDF', 'el de la clase');
  has(MAIN, 'Arrastrá una imagen acá para adjuntarla y mencionarla', 'y el del marcador');
});

test('el renglón de estado de la tira vive AFUERA de la tira', function () {
  // Si viviera adentro, un error de captura quedaría invisible: la tira se esconde
  // cuando está vacía, y ése es justo el momento en que ese error aparece —el
  // marcador todavía sin imágenes—. Va debajo de la barra de controles, o sea al
  // lado del botón que lo escribe.
  has(CARD, 'if (estado) caja.appendChild(estado)');
  const barra = donde(CARD, 'caja.appendChild(barra)', 'prompt-card');
  ok(barra < donde(CARD, 'var estado = opts.estado', 'prompt-card'), 'y después de la barra');
  // Las tres fichas de marcador lo tienen porque lo arma el cableado de las
  // referencias, que es el dueño del 📸 que lo escribe. Las dos rondas de feedback
  // lo tenían ADENTRO de la tira, o sea invisible justo cuando hacía falta: ése era
  // el precio de tener el cableado copiado en tres lugares y editado en uno.
  has(CARD, 'estado.className = "still-status"', 'lo arma el cableado de las referencias');
  has(CARD, 'HPStills.capturar(clave, hoja(), b, estado)', 'y es el que el 📸 escribe');
  has(VISTA, 'estado: n.estadoRefs', 'y los dos bloques de estilo pasan el suyo');
});

test('el techo de 108 px con scroll de la caja de referencias se fue', function () {
  // Era lo peor del sistema y lo decía su propio autor: esconde contenido detrás de
  // una barra cuya única señal es la barra. Y 90 de esos 108 px eran el botón de
  // capturar y la zona de arrastre, que ya no están.
  const conTecho = REGLAS.filter(function (r) {
    return /general-course-refs|general-stills-mount/.test(r.selector);
  });
  eq(conTecho.length, 0, 'ninguna regla acota ya el inventario: ' + conTecho.map((r) => r.selector).join(' | '));
  ok(CSS.indexOf('max-height: 108px') === -1, 'y el número no vuelve por otra puerta');
});

test('el campo del marcador arranca en cinco renglones', function () {
  // 13 px × 1.5 × 5 = 97.5 de texto + 10 de padding + 2 de borde = 110. Eran tres
  // (72). Los 38 px extra son parte de los 90 que dejaron libres la zona de
  // arrastre (52), el botón de capturar (30) y su separación (8).
  eq(declaraciones('.marker-body .marker-instruction')['min-height'], '110px');
});

test('los dos chips que no apuntan a nada se pintan en rojo, y con UNA regla', function () {
  // El editor lo pidió para el número que no existe: «que aparezca rojo avisando que
  // no referencia a nada». No es un color nuevo: es el rojo que ya usaba la mención
  // colgada, y los dos van en la misma regla justamente para que no puedan
  // separarse — son lo mismo para el ojo, y lo que los distingue son las palabras
  // del tooltip y del renglón de abajo.
  const rojo = declaraciones('.hp-chip.is-colgada, .hp-chip.is-sin-numero');
  eq(rojo.color, 'var(--error)');
  ok(rojo.background, 'con su superficie tenue: ' + rojo.background);
  // Y no hay una segunda regla que le dé otro color a uno de los dos.
  const sueltas = REGLAS.filter(function (r) {
    return /is-sin-numero/.test(r.selector) && r.selector.indexOf('is-colgada') === -1;
  });
  eq(sueltas.length, 0, 'sin reglas propias: ' + sueltas.map((r) => r.selector).join(' | '));
});

test('el `<input>` del chip no se ve como un formulario en medio de la frase', function () {
  // El doble clic abre un campo de texto DE VERDAD (cursor, selección y flechas
  // nativas, que es lo que el editor pidió), y lo que esta regla cuida es que ese
  // control no se dibuje como un control: sin fondo, sin borde propio y con la
  // tipografía del campo. El borde del acento lo pone el chip que lo contiene.
  const d = declaraciones('.hp-chip-num');
  eq(d.background, 'transparent');
  eq(d.border, '0');
  eq(d['font-family'], 'inherit');
  eq(d['font-size'], 'inherit');
  eq(d.outline, 'none', 'el anillo de foco lo pone el chip, no el input');
  ok(declaraciones('.hp-chip.is-editando').outline, 'y el chip sí lo tiene');
});

test('el campo no se separa a sí mismo: el aire lo pone la ficha', function () {
  // Con `margin-top` propio Y el `gap` de la ficha, el campo quedaba 8 px más lejos
  // de su tira de referencias que del resto. Es la misma familia de bug que el
  // doble padding y la doble separación de la tarjeta.
  const d = declaraciones('.marker-instruction', true);
  eq(d['margin-top'], undefined, 'sin margen propio');
  ok(declaraciones('.hp-ficha').gap, 'lo pone el gap de .hp-ficha: ' + declaraciones('.hp-ficha').gap);
});

// ── 4. El encabezado: identificar a la izquierda, confirmar a la derecha ──

test('el encabezado lleva nombre y tiempos a la izquierda, y el resto a la derecha', function () {
  // Los dos datos de confirmación (lo que tardó y lo que va a costar) vivían en un
  // renglón del cuerpo: se veían solo con la ficha abierta y costaban una fila de
  // alto. El editor los quiso arriba, y de paso ahora se leen con la ficha PLEGADA.
  const nombre = donde(MAIN, 'summary.appendChild(sName)', 'main');
  const tiempos = donde(MAIN, 'summary.appendChild(times)', 'main');
  const der = donde(MAIN, 'summary.appendChild(sDer)', 'main');
  ok(nombre < tiempos, 'el nombre primero, y los tiempos a su lado');
  ok(tiempos < der, 'y el grupo de la derecha al final');
  // El grupo de la derecha lleva tramo, estimado y estado, en ese orden.
  const meta = donde(MAIN, 'sDer.appendChild(sMeta)', 'main');
  const est = donde(MAIN, 'sDer.appendChild(estimate)', 'main');
  const badge = donde(MAIN, 'sDer.appendChild(sBadge)', 'main');
  ok(meta < est && est < badge, 'tramo · estimado · estado');
});

test('el grupo de la derecha envuelve ENTERO, no de a una pieza', function () {
  // Con las cuatro sueltas, a 320 px bajaba solo el estimado y el estado se quedaba
  // arriba: la fila se leía como dos filas de cosas distintas.
  // Desde la 1.6.x el encabezado es el de las TRES listas (`.hp-sumario`, sección
  // 9 del CSS): la ficha de un marcador, la fila de un trabajo de la Cola y la de
  // una corrección se dibujan con la misma regla.
  const d = declaraciones('.hp-sumario-der');
  eq(d.display, 'flex');
  // NO se parte (envuelve entero), pero SÍ se encoge. Fue `0 0 auto` hasta que
  // Corrections empezó a usar el mismo encabezado: ahí el grupo lleva el tramo,
  // las versiones con el nombre del modelo y la pastilla, y sin poder encogerse
  // eso no entra en un renglón de 340 px — y lo que no entra se pinta afuera de la
  // tarjeta, porque los hijos nunca llegan a recortar.
  eq(d.flex, '0 1 auto', 'se encoge como grupo…');
  eq(d['min-width'], '0', '…y deja que sus datos recorten');
  eq(d['margin-left'], 'auto', 'y se va contra el borde derecho');
  eq(declaraciones('.hp-sumario')['flex-wrap'], 'wrap', 'la fila puede envolver');
});

test('el orden de prioridad: el nombre y el estado no se caen nunca', function () {
  // A 320 px no entra todo, así que quién cede está escrito y no se deja al azar.
  const nombre = declaraciones('.hp-sumario .hp-nombre');
  eq(nombre.flex, '1 1 80px', 'el nombre cede ancho hasta 80 px, y ahí recorta');
  eq(nombre['text-overflow'], 'ellipsis');
  // El estado era un glifo de 14 px de ancho fijo y ahora es una PASTILLA con la
  // palabra («listo», «diseñando», «sin cupo»), la misma que usan las otras dos
  // pestañas: `flex: none` es lo que la hace no caerse nunca.
  eq(declaraciones('.hp-estado').flex, 'none', 'el estado no cede ancho');
  eq(declaraciones('.hp-estado')['white-space'], 'nowrap', 'ni se parte en dos renglones');
  // Y los datos de confirmación son los primeros en recortarse.
  const datos = declaraciones('.hp-dato');
  eq(datos.flex, '0 1 auto', 'ceden ancho antes que el nombre');
  eq(datos['text-overflow'], 'ellipsis');
});

test('el estado se dice con PALABRAS, y las escribe un solo lugar', function () {
  // Era un glifo (✓ ⏳ … ⚠) y los cuatro se dibujaban del mismo gris salvo el ✓,
  // así que lo que de verdad distinguía "listo" de "falló" era el dibujito de la
  // fuente del sistema. Ahora es la palabra, y la escribe `HPUtil.estadoDeTrabajo`
  // —el mismo lugar del que la pide la Cola—, así que el mismo trabajo no puede
  // llamarse de dos maneras según en qué pestaña lo mires.
  const util = fs.readFileSync(path.join(CEP, 'util.js'), 'utf8');
  has(util, 'function estadoDeTrabajo(status, sinColocar)');
  has(MAIN, 'HPUtil.estadoDeTrabajo(job.status, HPQueue.needsPlacing(job))');
  const cola = fs.readFileSync(path.join(CEP, 'queue-view.js'), 'utf8');
  has(cola, 'HPUtil.estadoDeTrabajo(j.status, HPQueue.needsPlacing(j))');
  ok(MAIN.indexOf('sBadge.textContent = generated ? "✓"') === -1, 'el ✓ se fue');
  has(MAIN, 'sBadge.className = "marker-badge hp-estado"', 'y la pastilla es la de las tres');
});

test('el desglose de los dos datos arranca escondido y aparece con ancho', function () {
  // Es lo que hace que la fila plegada siga midiendo 32.8 px en el panel que el
  // editor usa: con «v3: 4m 12s · IA 3m 05s · render 1m 07s» y «≈ 41k tok (7 img,
  // 2 rec)» puestos, la fila pide 570 px y a 400 envuelve a dos renglones — en los
  // siete marcadores, para mostrar un detalle que se lee una vez.
  eq(declaraciones('.hp-dato-largo').display, 'none', 'escondido por defecto');
  const ancho = (CSS.match(/@media \(min-width: 640px\) \{[\s\S]*?\n\}/) || [''])[0];
  has(ancho, '.hp-dato-largo { display: inline; }', 'y aparece a partir de 640 px');
  // El número, en cambio, no se cae nunca.
  has(MAIN, 'corto.className = "hp-dato-corto"');
  has(MAIN, 'largo.className = "hp-dato-largo"');
  // Y el detalle completo queda en el tooltip, que es donde se puede leer siempre.
  has(MAIN, 'times.title =');
  has(MAIN, 'estimate.title =');
});

test('el estimado se pide con la ficha plegada, no solo al abrirla', function () {
  // Vive en el encabezado, así que si esperara la apertura la ficha plegada
  // mostraría un hueco donde tiene que haber un dato.
  const montar = donde(MAIN, 'ficha = HPPromptCard.montar({', 'main');
  const pedido = MAIN.indexOf('updateEstimate();', montar);
  ok(pedido !== -1, 'se pide después de montar la ficha');
  // Y se vuelve a pedir al abrir: si las referencias del proyecto no habían llegado
  // del disco cuando se dibujó la lista, el número de la apertura es el que vale.
  const toggle = donde(MAIN, 'card.addEventListener("toggle"', 'main');
  ok(MAIN.indexOf('updateEstimate();', toggle) !== -1);
});

// ── 5. El pie: la posición es la jerarquía ───────────────────────────

test('lo que se aprieta va a la derecha y lo destructivo a la izquierda', function () {
  // Eran tres botones en fila, en el orden en que se escribieron, así que el que
  // TIRA el trabajo anterior quedaba pegado al que lo continúa.
  has(MAIN, 'izquierda: [regenBtn]', 'Regenerar desde cero, solo, a la izquierda');
  has(MAIN, 'derecha: [queueBtn, genBtn]', 'y Generar en el vértice, con Enviar a la cola a su izquierda');
  const d = declaraciones('.hp-acciones');
  eq(d['justify-content'], 'space-between');
  eq(d['flex-wrap'], 'wrap-reverse',
    'al envolver, lo destructivo queda ARRIBA: sigue lejos del dedo que aprieta Generar');
});

test('"Regenerar desde cero" de la ficha PREGUNTA siempre', function () {
  // El de la caja de feedback de la Cola preguntaba desde la 1.5.1 y el de la ficha
  // no, y acá el riesgo es mayor: está en la MISMA fila que Generar. Están en las dos
  // puntas —eso se arregló en esta etapa— pero un clic de más sigue tirando una
  // animación que estaba bien y arrancando una generación entera.
  //
  // Se fija sobre el texto y no apretando el botón, que es lo que hace el test de la
  // Cola: montar una ficha de marcador pide el panel entero (header, pestañas,
  // config, host de Premiere). Lo que se fija es lo que importa: que el `regen` NO
  // salga del handler directo sino de adentro de la confirmación. La mutación que lo
  // saca de ahí está en `test/manual/mutaciones-render.js`.
  const desde = donde(MAIN, 'regenBtn.addEventListener("click"', 'main');
  const hasta = MAIN.indexOf('queueBtn.addEventListener', desde);
  const handler = MAIN.slice(desde, hasta);
  has(handler, 'HPWidgets.confirmOverlay("Regenerar desde cero"', 'abre la confirmación');
  // Y la generación sale de ADENTRO del "sí", no al lado. Se compara la forma exacta
  // del callback y no solo el orden de los índices: con la generación puesta DESPUÉS
  // de la confirmación (o sea, preguntando y generando igual) los índices siguen
  // saliendo bien, y eso es exactamente lo que hay que atrapar.
  eq((handler.match(/enqueueMarkerGeneration\(marker, "regen"\)/g) || []).length, 1,
    'una sola vez, y adentro del sí');
  has(handler.replace(/\s+/g, ' '),
    '"Regenerar desde cero", function () { enqueueMarkerGeneration(marker, "regen"); });',
    'el "sí" es lo único que genera');
  // Las mismas tres cosas que dice la de la Cola, no una versión resumida.
  has(handler, 'Se descarta el diseño anterior');
  has(handler, 'es una generación completa, con su costo y su espera');
  has(handler, 'if (escrito)', 'y el tercer renglón solo si hay algo escrito en el campo');
  has(handler, 'NO como un ajuste sobre la versión anterior',
    'que es el que atrapa el error de puntería de verdad');
});

test('la fila de acciones vieja no quedó dando vueltas', function () {
  const viejas = REGLAS.filter(function (r) { return /\.marker-actions/.test(r.selector); });
  eq(viejas.length, 0, 'sin reglas huérfanas: ' + viejas.map((r) => r.selector).join(' | '));
  ok(MAIN.indexOf('marker-actions') === -1, 'ni en el JS');
});

// ── 6. Avanzado ──────────────────────────────────────────────────────

test('el transcript y el editor de HTML viven en Avanzado', function () {
  // "Abajo que esté un pequeño desplegable de Advance o algo así, dentro debo poder
  // ver el transcript o editar el HTML." Los dos ocupaban una fila fija cada uno en
  // el medio de la ficha, y los dos se miran una vez cada tanto.
  has(MAIN, 'avanzado: [tDetails && { el: tDetails }, { el: editor }]');
  has(CARD, 's.textContent = "Avanzado"');
});

test('un transcript que llega después entra ADENTRO de Avanzado', function () {
  // La tarjeta puede nacer sin transcript (se transcribe o se importa después). Ese
  // camino colgaba el bloque antes de la fila de acciones, y esa fila ya no está en
  // el medio de la ficha: está en el pie.
  has(MAIN, 'c.querySelector(".hp-avanzado-body")');
  ok(MAIN.indexOf('c.querySelector(".marker-actions")') === -1);
});

// ── 7. La tira: las referencias del pedido, en el orden del pedido ───

test('la ficha del marcador muestra TODAS las que viajan, no solo las propias', function () {
  // Es lo que hace que el número que se ve sea el número que ve el modelo. Con
  // solo las propias, el editor veía dos de cinco y el "imagen 1" del bloque del
  // curso era, casi siempre, la imagen 3 del pedido.
  has(MAIN, 'HPStills.crearTira(markerKey', 'las propias, como miniaturas');
  has(MAIN, 'HPRefsView.crearHeredadas({', 'y las heredadas del curso y de la clase');
  has(MAIN, 'desde: tiraPropia.cuantasImagenes()',
    'numeradas a continuación de las propias, que es el orden del pedido');
});

test('una heredada que el disco no tiene no gasta número', function () {
  // No viaja, así que el modelo no la va a ver: darle número correría toda la tira
  // contra lo que él recibe, que es justo lo que esta tira viene a arreglar.
  const refs = fs.readFileSync(path.join(CEP, 'refs-view.js'), 'utf8');
  has(refs, 'if (esImagen && !it.missing) numero += 1;',
    'el número solo avanza con las que VIAJAN');
  has(refs, 'esImagen && !it.missing ? numero : 0',
    'y la que no viaja se dibuja sin número, con el triángulo de aviso en su lugar');
});

test('las heredadas no ofrecen ✕ ni ✓ usar: eso se decide en su propio bloque', function () {
  // Borrar una del curso le llega a todas las clases y a la otra máquina. Se toma
  // en el bloque del curso, viendo lo que se saca.
  const refs = fs.readFileSync(path.join(CEP, 'refs-view.js'), 'utf8');
  const desde = refs.indexOf('function chipHeredado');
  const hasta = refs.indexOf('function ingerir');
  const bloque = refs.slice(desde, hasta > desde ? hasta : refs.length);
  ok(bloque.indexOf('HPRefs.remove') === -1, 'el chip heredado no borra');
  ok(bloque.indexOf('HPRefs.setUse') === -1, 'ni cambia la etiqueta');
});

test('el número desapareció de los bloques de estilo, donde era mentira', function () {
  // El que mostraban era el de la referencia DENTRO de su nivel, y el que ve el
  // modelo es el del pedido entero (marcador → curso → clase). Con dos capturas en
  // el marcador, la "imagen 1" del curso era la 3 del pedido. No se puede arreglar
  // ahí —depende de qué marcador esté generando—, así que se saca: lo que queda es
  // tocarla y que quede mencionada por su nombre.
  const refs = fs.readFileSync(path.join(CEP, 'refs-view.js'), 'utf8');
  const desde = refs.indexOf('function miniatura');
  const hasta = refs.indexOf('function chip(');
  const bloque = refs.slice(desde, hasta);
  ok(bloque.indexOf('still-num') === -1, 'la miniatura de un bloque de estilo no numera');
  has(refs, 'deps.mencionar(caja._scope, nombre)', 'y en su lugar menciona');
});

// ── 8. Que la guarda del dictado siga entera ─────────────────────────

test('sin dictado, el campo y sus controles se dibujan igual', function () {
  // La barra de controles ES la barra del micrófono, así que si el camino sin
  // dictado no armara una barra, en Windows la ficha se quedaría sin capturar del
  // programa y sin adjuntar — que no tienen nada que ver con el micrófono.
  has(CARD, 'HPUtil.micOpcional');
  has(CARD, 'if (!barra) {');
  has(CARD, 'barra.className = "mic-bar"');
  ok(CARD.indexOf('HPDictado') === -1 || CARD.indexOf('HPDictado.attachMic(') === -1,
    'y nunca llama al micrófono sin la guarda');
});

test('los controles propios viajan DENTRO de la barra del micrófono', function () {
  // En una fila aparte, la línea de estado del dictado —que reclama su ancho y se
  // lleva el sobrante— los empujaría al renglón de abajo siempre.
  const dictado = fs.readFileSync(path.join(CEP, 'dictado.js'), 'utf8');
  has(dictado, '(opts.extras || []).forEach');
  ok(dictado.indexOf('(opts.extras || []).forEach') < dictado.indexOf('bar.appendChild(linea)'),
    'los extras entran ANTES de la línea de estado');
  has(CARD, 'extras: extras');
});
