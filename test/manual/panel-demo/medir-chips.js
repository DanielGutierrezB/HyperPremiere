#!/usr/bin/env node
'use strict';

// ¿Los CHIPS de mención hacen lo que tienen que hacer, en un navegador de verdad?
// Con número, no a ojo.
//
//   node test/manual/panel-demo/abrir.js --no-open &
//   node test/manual/panel-demo/medir-chips.js
//
// Acá vivía `medir-espejo.js`, que medía si el ESPEJO de resaltado cortaba las
// líneas en el mismo lugar que el campo. Ese mecanismo no existe más: el campo pasó
// a ser un `contenteditable` que pinta los chips de verdad, y un chip dice OTROS
// caracteres que el texto guardado (`@Imagen_1` donde el token tiene 38), así que no
// hay nada que alinear. Lo que este arnés mide en su lugar es lo que ahora sí
// importa y la suite del repo NO puede fijar, porque su DOM no tiene layout ni la
// edición nativa de un `contenteditable`:
//
//   1. QUE EL CHIP DIGA EL NÚMERO CORRECTO. Se compara la etiqueta que se ve con la
//      posición de esa referencia entre las que viajan, contada sobre la tira que
//      está arriba del campo. Un chip que dice «Imagen_2» sobre lo que le va a
//      llegar al modelo como «imagen 3» es peor que el token largo.
//   2. QUE `value` SIGA SIENDO EL TEXTO CANÓNICO. Es la condición de la que
//      dependen los seis lugares por donde viaja una instrucción, y acá se mide
//      contra el DOM de verdad, con Chromium editando.
//   3. QUE EL PREVIEW APAREZCA, y arriba del chip cuando hay lugar: abajo taparía el
//      renglón que se está escribiendo.
//   4. QUE EL BORRADO SE LLEVE EL TOKEN ENTERO. Es lo que de verdad no se puede
//      fijar sin navegador: `contenteditable="false"` hace la mitad y la fachada la
//      otra, y lo que no se puede dejar pasar es medio token suelto en el texto —
//      medio token viaja al modelo como texto y el gráfico sale sin la referencia.
//   5. QUE TECLEAR NO LOS REDIBUJE. Con el foco adentro, redibujar se come el undo
//      nativo. Se mide escribiendo de verdad y mirando si el chip sigue siendo el
//      mismo nodo.
//   6. QUE NADA DESBORDE a 320 y a 400 px, con chips y con el preview abierto.
//   7. QUE BORRAR UN CHIP SE PUEDA DESHACER. El undo de un `contenteditable` lo
//      lleva el navegador y no se le puede empujar nada a mano, así que lo que este
//      módulo cambia por su cuenta Cmd+Z lo saltea. El borrado se hace pasar por el
//      comando de edición del navegador para que entre en su pila (ver `borrarChip`
//      en cep/js/campo.js), y eso sólo se puede comprobar acá.
//   8. EL MENÚ DEL `@`: que se abra tecleando, que filtre, que no quede cortado y
//      —la trampa— que el Enter con el que se elige no deje un salto de línea en la
//      instrucción. Es la misma familia de defecto que el doble clic del número, y
//      ningún test del repo la puede ver: hace falta que Chromium esté editando.
//
// Y en los TRES campos con menciones, no en uno: la instrucción de un marcador, la
// ronda de feedback de la Cola y la fila de Corrections. Ya pasó antes que un
// arreglo entrara sólo en la ficha y los otros dos quedaran a medias.

const path = require('path');
const RAIZ = path.join(__dirname, '..', '..', '..');
const puppeteer = require(path.join(RAIZ, 'bridge', 'node_modules', 'puppeteer-core'));
const CHROME = process.env.HP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(n, d) { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; }

const BASE = arg('--base', 'http://localhost:4599/');
const ALTO = Number(arg('--alto', 700));
const ANCHOS = String(arg('--anchos', '320,400,600,900')).split(',').map(Number);

// El texto de prueba. Lleva las cinco cosas que pueden pasar: una mención de cada
// nivel, un documento, una que el disco no tiene y una que ya no está en la lista.
// Una mención que existe en los TRES campos: la primera imagen propia del marcador.
// Sirve de sujeto para el undo, que necesita un chip que de verdad apunte a algo.
const TOKEN_1 = '@[marcador/logo-nova.png]';

const TEXTO = 'Placa de entrada con el título de la clase. Copiá la disposición de ' +
  '@[marcador/boceto-3-columnas.jpg], la tipografía de @[curso/manual-de-marca-nova.png] y el ' +
  'encuadre de @[clase/captura-programa-00-03-41.png]. Las reglas están en ' +
  '@[curso/Guia_de_estilo_ACADEMIA_NOVA_v4.pdf]. Respetá @[curso/paleta-institucional.png], que ' +
  'es la que no está en el disco, y NO uses @[curso/no-existe.png], que ya no está en la lista.';

/** Corre dentro de la página: mide un campo con sus chips. */
const MEDIR = function (o) {
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const conTexto = (t) => [].slice.call(document.querySelectorAll('button, .qbtn'))
    .filter((b) => (b.textContent || '').indexOf(t) !== -1);
  return (async function () {
    /** Abre la ficha que se va a medir y devuelve su caja. */
    async function abrir() {
      if (o.donde === 'cola') {
        document.getElementById('tab-queue').click();
        await espera(1500);
        const b = conTexto('Feedback')[0];
        if (!b) throw new Error('ningún trabajo terminado ofrece feedback');
        b.click();
        await espera(900);
        const fila = document.querySelector('.queue-job[open]');
        if (!fila) throw new Error('la ronda de feedback no se abrió');
        return fila;
      }
      if (o.donde === 'corrections') {
        document.getElementById('tab-corrections').click();
        await espera(2000);
        const fila = document.querySelector('details.corr-row');
        if (!fila) throw new Error('Corrections no dibujó ninguna fila');
        fila.open = true;
        await espera(700);
        return fila;
      }
      const fichas = [].slice.call(document.querySelectorAll('details.marker-card'));
      fichas.forEach((d) => { d.open = false; });
      const cual = fichas.filter((d) => (d.textContent || '').indexOf(o.marcador) === 0)[0];
      if (!cual) throw new Error('no encontré la ficha de ' + o.marcador);
      cual.open = true;
      await espera(400);
      return cual;
    }

    const cual = await abrir();
    const campo = cual.querySelector('.hp-campo-input');
    if (!campo) throw new Error('la ficha no tiene campo');

    /** Escribe por el mismo camino que el dictado y el ✨: el valor, por código. */
    function poner(t) {
      campo.value = t;
      campo.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * EL NÚMERO QUE LE TOCA A CADA REFERENCIA, contado sobre lo que se ve arriba del
     * campo, y no sobre el mismo inventario que usó el chip: si los dos salieran de
     * la misma función, este arnés comprobaría que una función es igual a sí misma.
     * La tira dice el orden del pedido (las propias numeradas, después las heredadas
     * del curso y de la clase, salteando las que el disco no tiene).
     */
    function numerosDeLaTira() {
      const out = {};
      let n = 0;
      [].slice.call(cual.querySelectorAll('.still-thumb')).forEach(function (t) {
        const num = t.querySelector('.still-num');
        const nombre = (t.querySelector('img') || {}).title || '';
        if (num) { n = Number(num.textContent) || (n + 1); out[nombre] = n; }
      });
      [].slice.call(cual.querySelectorAll('.hp-heredada')).forEach(function (h) {
        const num = h.querySelector('.hp-heredada-num');
        const m = /«([^»]+)»/.exec(h.title || '');
        if (num && m) out[m[1]] = Number(num.textContent);
      });
      return out;
    }

    const out = [];
    function anotar(caso, extra) {
      const chips = [].slice.call(campo.querySelectorAll('.hp-chip'));
      const cajaCampo = campo.getBoundingClientRect();
      out.push(Object.assign({
        caso: caso,
        // Lo GUARDADO: tiene que ser el texto canónico, carácter por carácter.
        valor: campo.value,
        chips: chips.map(function (c) {
          const r = c.getBoundingClientRect();
          return {
            etiqueta: c.textContent,
            token: c.title.split(' · ')[0],
            estado: String(c.className).replace('hp-chip', '').trim(),
            editable: c.getAttribute('contenteditable'),
            // Si el chip se pinta afuera del campo, el número que dice no se lee.
            desborda: Math.round(r.right - cajaCampo.right) > 1 ||
              Math.round(cajaCampo.left - r.left) > 1,
          };
        }),
        // El alto del campo: con chips y a 320 px es donde algo se puede escapar.
        alto: campo.scrollHeight,
        cabe: campo.scrollHeight <= campo.clientHeight + 1 ||
          getComputedStyle(campo).overflowY === 'auto',
      }, extra || {}));
    }

    poner(o.texto);
    await espera(150);
    anotar('con las seis menciones', { numeros: numerosDeLaTira() });

    // EL PREVIEW: se pasa el mouse por el primer chip QUE APUNTA A ALGO. Uno roto no
    // tiene de dónde sacar una miniatura —esa referencia ya no está en la lista— así
    // que medir el preview sobre él sería medir que no aparece.
    const primero = [].slice.call(campo.querySelectorAll('.hp-chip'))
      .filter((c) => String(c.className).indexOf('is-') === -1)[0];
    if (primero) {
      primero.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await espera(120);
      const prev = document.querySelector('.hp-chip-preview');
      const r = primero.getBoundingClientRect();
      const p = prev ? prev.getBoundingClientRect() : null;
      anotar('preview del primer chip', {
        preview: !!prev && prev.getAttribute('data-hidden') === 'false',
        previewImagen: !!(prev && prev.querySelector('img')),
        previewArriba: !!(p && p.bottom <= r.top + 1),
        previewDentro: !!(p && p.left >= 0 && p.right <= window.innerWidth + 1),
      });
      primero.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    }

    // BORRAR EL CHIP ENTERO: el cursor pegado a su derecha y un Backspace de verdad.
    // No se puede simular con un evento (Chromium no edita por un `dispatchEvent`),
    // así que lo aprieta el teclado de Puppeteer: acá sólo se deja el cursor puesto.
    const antesDeBorrar = campo.value;
    const chip0 = campo.querySelector('.hp-chip');
    if (chip0) {
      const i = [].slice.call(campo.childNodes).indexOf(chip0);
      const r = document.createRange();
      r.setStart(campo, i + 1);
      r.setEnd(campo, i + 1);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      campo.focus();
    }
    return { filas: out, antesDeBorrar: antesDeBorrar, hayChip: !!chip0 };
  })();
};

/** Segunda pasada, después de que el teclado de verdad apretó teclas. */
const DESPUES = function (o) {
  const cual = document.querySelector(o.sel);
  const campo = cual.querySelector('.hp-campo-input');
  return {
    valor: campo.value,
    chips: [].slice.call(campo.querySelectorAll('.hp-chip')).map((c) => c.textContent),
    // El nodo del primer chip, marcado antes de teclear: si sigue marcado, nadie
    // redibujó el campo mientras se escribía (y el undo nativo sigue entero).
    mismoNodo: !!(campo.querySelector('.hp-chip') && campo.querySelector('.hp-chip')._hpMarca),
    aviso: (cual.querySelector('.hp-aviso') || {}).textContent || '',
    // ¿Hay un chip con un NÚMERO que no apunta a nada? Es lo que el editor pidió
    // ver: «que aparezca rojo avisando que no referencia a nada». Se mira esa clase
    // y no "cualquier chip rojo": el texto de la maqueta ya trae una mención colgada
    // a propósito, que también es roja y que no tiene nada que ver con esto.
    sinNumero: !!campo.querySelector('.hp-chip.is-sin-numero'),
  };
};

/**
 * Deja un chip listo para el doble clic: el primero que apunte a algo, con su
 * etiqueta, su número y su token, y lo devuelve ya en modo edición.
 *
 * El doble clic se dispara acá y no con `page.mouse.click` dos veces porque lo que
 * hay que medir es lo que pasa DESPUÉS —que el chip quede editable con el foco
 * adentro, y que Enter confirme sin meter un salto de línea en el campo—, y para eso
 * el navegador tiene que estar editando de verdad, que es lo que sigue.
 */
const ABRIR_CHIP = function (o) {
  const campo = document.querySelector(o.sel).querySelector('.hp-campo-input');
  const chip = [].slice.call(campo.querySelectorAll('.hp-chip'))
    .filter((c) => String(c.className).indexOf('is-') === -1 &&
      c.getAttribute('data-tipo') === 'imagen')[0];
  if (!chip) return null;
  const antes = {
    valor: campo.value,
    token: chip.title.split(' · ')[0],
    etiqueta: chip.textContent,
    numero: Number((/@Imagen_(\d+)/.exec(chip.textContent) || [])[1]) || 0,
  };
  chip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  // Lo que hay que mirar es el `<input>`: que exista, que tenga el foco y que el
  // número esté SELECCIONADO. Eso último es lo que el editor pidió («que abra
  // completo como si fuera un campo de texto») y lo único que prueba que la edición
  // no es simulada: un `selectionEnd` en un elemento que no es un control de
  // formulario no existe.
  const inp = chip.querySelector('input');
  return Object.assign(antes, {
    editable: chip.getAttribute('contenteditable'),
    hayInput: !!inp,
    conFoco: !!inp && document.activeElement === inp,
    valorInput: inp ? inp.value : null,
    selDesde: inp ? inp.selectionStart : null,
    selHasta: inp ? inp.selectionEnd : null,
  });
};

/** El estado del `<input>` del chip en edición, después de teclear de verdad. */
const LEER_INPUT = function (o) {
  const campo = document.querySelector(o.sel).querySelector('.hp-campo-input');
  const inp = campo.querySelector('.hp-chip.is-editando input');
  return {
    hay: !!inp,
    valor: inp ? inp.value : null,
    cursor: inp ? inp.selectionStart : null,
    chips: campo.querySelectorAll('.hp-chip').length,
    valorCampo: campo.value,
  };
};

const SELECTOR = {
  marcador: 'details.marker-card[open]',
  cola: '.queue-job[open]',
  corrections: 'details.corr-row[open]',
};

/**
 * Deja el campo con el cursor al final de `texto`, listo para que el teclado de
 * verdad escriba el `@`. Devuelve dónde quedó, para poder comparar después.
 */
const PREPARAR = function (o) {
  const campo = document.querySelector(o.sel).querySelector('.hp-campo-input');
  campo.value = o.texto;
  campo.dispatchEvent(new Event('input', { bubbles: true }));
  campo.focus();
  campo.setSelectionRange(o.texto.length, o.texto.length);
  return { valor: campo.value, cursor: campo.selectionStart };
};

/** Qué está mostrando el menú del `@` y dónde cayó. */
const LEER_MENU = function (o) {
  const campo = document.querySelector(o.sel).querySelector('.hp-campo-input');
  const menu = document.querySelector('.hp-arroba');
  const visible = !!menu && menu.getAttribute('data-hidden') === 'false';
  const r = visible ? menu.getBoundingClientRect() : null;
  const c = campo.getBoundingClientRect();
  return {
    valor: campo.value,
    chips: [].slice.call(campo.querySelectorAll('.hp-chip')).map((x) => x.textContent),
    visible: visible,
    filas: visible ? [].slice.call(menu.querySelectorAll('.hp-arroba-op')).map(function (f) {
      return {
        etiqueta: (f.querySelector('.hp-arroba-num') || {}).textContent || '',
        nombre: (f.querySelector('.hp-arroba-nombre') || {}).textContent || '',
        sel: /is-sel/.test(f.className),
        conImagen: !!f.querySelector('img'),
      };
    }) : [],
    rotulos: visible ? [].slice.call(menu.querySelectorAll('.hp-arroba-rotulo')).map((x) => x.textContent) : [],
    // Que NO quede cortado: es la otra trampa de este pedido. El campo puede estar
    // en el medio de una lista con scroll y el panel medir 320 px.
    dentro: !r || (r.left >= -1 && r.top >= -1 &&
      r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1),
    caja: r ? { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), w: Math.round(r.width) } : null,
    // Hacia arriba o hacia abajo del `@`, tal como lo decidió `colocarMenu`. Se lee
    // el atributo y no se deduce de las cajas: el ancla es el `@`, que está ADENTRO
    // del campo, así que "arriba del `@`" puede seguir estando abajo del borde de
    // arriba del campo.
    arriba: !!(menu && menu.getAttribute('data-arriba') === 'true'),
    // Y cuánto se le dejó de alto: en un lugar apretado el menú se acota y scrollea
    // en vez de salirse de la pantalla.
    techo: menu ? menu.style.maxHeight : '',
    huecoAbajo: Math.round(window.innerHeight - c.bottom),
  };
};

(async function () {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--hide-scrollbars'],
  });
  let malas = 0, total = 0;
  const errores = [];
  const DONDE = [
    { donde: 'marcador', que: 'la instrucción de un marcador' },
    { donde: 'cola', que: 'la ronda de feedback de la Cola' },
    { donde: 'corrections', que: 'la corrección de una fila' },
  ];
  for (const w of ANCHOS) {
    console.log('\n══ ' + w + ' px ' + '═'.repeat(46));
    for (const d of DONDE) {
      const page = await browser.newPage();
      page.on('pageerror', (e) => errores.push(w + 'px ' + d.donde + ': ' + e.message));
      await page.setViewport({ width: w, height: ALTO, deviceScaleFactor: 1 });
      await page.goto(BASE, { waitUntil: 'networkidle2' });
      await new Promise((r) => setTimeout(r, 4500));
      const r = await page.evaluate(MEDIR, { donde: d.donde, marcador: 'Marcador 1', texto: TEXTO });
      console.log('── ' + d.que);

      r.filas.forEach(function (f) {
        total++;
        const valorOk = f.valor === TEXTO;
        // El número de cada chip contra el de la tira, que es el orden del pedido.
        const numeros = (f.numeros || {});
        const numerosOk = f.chips.every(function (c) {
          const nombre = (/@\[[^/\]]*\/?([^\]]*)\]/.exec(c.token) || [])[1];
          const esperado = numeros[nombre];
          if (c.estado) return true;                 // roto: muestra el nombre, no un número
          if (!esperado) return true;                // no está en la tira (documento)
          return c.etiqueta === '@Imagen_' + esperado;
        });
        const atomicos = f.chips.every((c) => c.editable === 'false');
        const sinDesborde = f.chips.every((c) => !c.desborda);
        const bien = valorOk && numerosOk && atomicos && sinDesborde && f.cabe &&
          (f.preview === undefined || (f.preview && f.previewArriba && f.previewDentro));
        if (!bien) malas++;
        console.log((bien ? '  ok   ' : '  MAL  ') + f.caso.padEnd(26) +
          ' · ' + f.chips.length + ' chips [' + f.chips.map((c) => c.etiqueta).join(' ') + ']' +
          ' · valor ' + (valorOk ? 'canónico' : 'DISTINTO') +
          ' · números ' + (numerosOk ? 'coinciden' : 'NO COINCIDEN') +
          (f.preview === undefined ? '' :
            ' · preview ' + (f.preview ? (f.previewImagen ? 'con miniatura' : 'sin miniatura') : 'NO APARECIÓ') +
            ' ' + (f.previewArriba ? 'arriba' : 'ABAJO del chip')) +
          ' · alto ' + f.alto + (f.cabe ? '' : ' DESBORDA'));
        if (!valorOk) console.log('         valor: ' + JSON.stringify(f.valor));
      });

      // ── Borrar el chip entero, con el teclado de verdad ──
      if (r.hayChip) {
        total++;
        await page.keyboard.press('Backspace');
        await new Promise((res) => setTimeout(res, 120));
        const b = await page.evaluate(DESPUES, { sel: SELECTOR[d.donde] });
        // Se fue el token ENTERO: ni un corchete, ni media ruta.
        const esperado = r.antesDeBorrar.replace(/@\[[^\]]*\]/, '');
        const entero = b.valor === esperado;
        const sinBasura = b.valor.indexOf('@[') === -1 || /@\[[^\]]*\]/.test(b.valor);
        console.log((entero && sinBasura ? '  ok   ' : '  MAL  ') +
          'Backspace se lleva el chip entero'.padEnd(26) +
          ' · quedan ' + b.chips.length + ' chips · ' +
          (entero ? 'el token completo' : 'QUEDÓ ALGO: ' + JSON.stringify(b.valor.slice(0, 90))));
        if (!(entero && sinBasura)) malas++;

        // ── Y tecleando, los chips NO se redibujan ──
        total++;
        // Se marca un chip DESPUÉS de borrar (borrar saca un nodo, así que marcar
        // antes mediría el borrado y no el tecleo) y se escribe de verdad.
        await page.evaluate(function (sel) {
          const c = document.querySelector(sel).querySelector('.hp-chip');
          if (c) c._hpMarca = true;
        }, SELECTOR[d.donde]);
        await page.keyboard.type(' y grande');
        await new Promise((res) => setTimeout(res, 150));
        const t = await page.evaluate(DESPUES, { sel: SELECTOR[d.donde] });
        const tecleoOk = t.mismoNodo && t.valor.indexOf(' y grande') !== -1;
        if (!tecleoOk) malas++;
        console.log((tecleoOk ? '  ok   ' : '  MAL  ') +
          'tecleando no se redibujan'.padEnd(26) +
          ' · ' + (t.mismoNodo ? 'el chip sigue siendo el mismo nodo (el undo nativo, entero)'
            : 'EL CHIP SE RECREÓ: se pierde el undo'));

        // ── EL DOBLE CLIC, que es el punto donde el número se vuelve significado ──
        const abierto = await page.evaluate(ABRIR_CHIP, { sel: SELECTOR[d.donde] });
        if (abierto) {
          total += 5;
          await new Promise((res) => setTimeout(res, 150));

          // 1. UN CAMPO DE TEXTO DE VERDAD. Es lo que el editor pidió después de
          // probar la primera versión: *"solo me abre el número pero no me pone sobre
          // el lugar de cambiarlo, que abra completo como si fuera un campo de
          // texto"*. Lo que lo prueba es que el `<input>` tenga el foco y que su
          // selección cubra el número: un `selectionEnd` no existe en un elemento que
          // no es un control de formulario.
          const campoDeVerdad = abierto.hayInput && abierto.conFoco &&
            abierto.selDesde === 0 && abierto.selHasta === String(abierto.valorInput).length &&
            String(abierto.valorInput).length > 0;
          if (!campoDeVerdad) malas++;
          console.log((campoDeVerdad ? '  ok   ' : '  MAL  ') +
            'doble clic da un campo real'.padEnd(26) +
            ' · ' + (abierto.hayInput ? '<input> con «' + abierto.valorInput + '»' : 'SIN <input>') +
            ' · ' + (abierto.conFoco ? 'con el foco' : 'SIN FOCO') +
            ' · selección [' + abierto.selDesde + ',' + abierto.selHasta + ']');

          // 2. LAS FLECHAS Y EL BACKSPACE SON DEL INPUT. Es el defecto de la vuelta
          // anterior, al revés: entonces el Backspace se lo llevaba el campo y
          // borraba el chip entero. La flecha se aprieta primero para DESELECCIONAR
          // —con el número seleccionado, un Backspace borraría la selección y no
          // probaría nada del cursor— y el Backspace después, que ahí sí tiene un
          // dígito a la izquierda.
          await page.keyboard.press('ArrowRight');
          const conFlecha = await page.evaluate(LEER_INPUT, { sel: SELECTOR[d.donde] });
          await page.keyboard.press('Backspace');
          const conBorrado = await page.evaluate(LEER_INPUT, { sel: SELECTOR[d.donde] });
          const largo = String(abierto.valorInput).length;
          const tecladoNativo = conFlecha.hay && conBorrado.hay &&
            conFlecha.cursor === largo && conBorrado.chips === conFlecha.chips &&
            conBorrado.valor.length === largo - 1;
          if (!tecladoNativo) malas++;
          console.log((tecladoNativo ? '  ok   ' : '  MAL  ') +
            'flechas y Backspace nativos'.padEnd(26) +
            ' · cursor tras →: ' + conFlecha.cursor + ' de ' + largo +
            ' · Backspace: «' + abierto.valorInput + '» → «' + conBorrado.valor + '»' +
            ' · ' + conBorrado.chips + ' chips (no se llevó el chip)');

          // 3. Y repunta. Se apunta a OTRO número del que tenía: repuntar al mismo no
          // cambiaría nada y el test pasaría sin haber movido nada.
          const objetivo = abierto.numero === 1 ? 2 : 1;
          await page.keyboard.type(String(objetivo));
          await page.keyboard.press('Enter');
          await new Promise((res) => setTimeout(res, 150));
          const c1 = await page.evaluate(DESPUES, { sel: SELECTOR[d.donde] });
          const repunto = c1.valor !== abierto.valor && c1.valor.indexOf('@[') !== -1 &&
            c1.chips.indexOf('@Imagen_' + objetivo) !== -1 && c1.valor.indexOf('\n') === -1;
          if (!repunto) malas++;
          console.log((repunto ? '  ok   ' : '  MAL  ') +
            'doble clic repunta el chip'.padEnd(26) +
            ' · ' + abierto.etiqueta + ' → ' + objetivo + ' → [' + c1.chips.join(' ') + ']' +
            (c1.valor.indexOf('\n') === -1 ? '' : ' · EL ENTER METIÓ UN SALTO EN EL CAMPO'));

          // 4. UN NÚMERO QUE NO EXISTE: no se deshace, queda EN ROJO con el número
          // que el editor escribió, y el renglón de abajo lo dice. La regla anterior
          // era la contraria (el chip volvía solo) y el editor la corrigió.
          const otra = await page.evaluate(ABRIR_CHIP, { sel: SELECTOR[d.donde] });
          await new Promise((res) => setTimeout(res, 120));
          await page.keyboard.type('99');
          await page.keyboard.press('Enter');
          await new Promise((res) => setTimeout(res, 150));
          const c2 = await page.evaluate(DESPUES, { sel: SELECTOR[d.donde] });
          const enRojo = c2.valor.indexOf('@[Imagen_99]') !== -1 &&
            c2.chips.indexOf('@Imagen_99') !== -1 &&
            /imagen 99/.test(c2.aviso) && c2.sinNumero;
          if (!enRojo) malas++;
          console.log((enRojo ? '  ok   ' : '  MAL  ') +
            'el número que no existe: rojo'.padEnd(26) +
            ' · ' + JSON.stringify(c2.valor.slice(-14)) + ' · [' + c2.chips.join(' ') + ']' +
            ' · ' + (c2.sinNumero ? 'chip en rojo' : 'EL CHIP NO SE PUSO ROJO') +
            ' · aviso: ' + JSON.stringify(c2.aviso.slice(0, 60)));

          // 5. Y se ARREGLA con el mismo gesto: el chip rojo se vuelve a abrir con el
          // número que se escribió, y con uno válido vuelve a azul guardando el nombre.
          await page.evaluate(function (sel) {
            const rojo = document.querySelector(sel).querySelector('.hp-chip.is-sin-numero');
            if (rojo) rojo.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          }, SELECTOR[d.donde]);
          await new Promise((res) => setTimeout(res, 120));
          const reabierto = await page.evaluate(LEER_INPUT, { sel: SELECTOR[d.donde] });
          await page.keyboard.type('1');
          await page.keyboard.press('Enter');
          await new Promise((res) => setTimeout(res, 150));
          const c3 = await page.evaluate(DESPUES, { sel: SELECTOR[d.donde] });
          const arreglado = reabierto.valor === '99' && !c3.sinNumero &&
            c3.chips.indexOf('@Imagen_1') !== -1 && c3.valor.indexOf('@[Imagen_') === -1;
          if (!arreglado) malas++;
          console.log((arreglado ? '  ok   ' : '  MAL  ') +
            'y el rojo se arregla'.padEnd(26) +
            ' · reabre con «' + reabierto.valor + '» → 1 → [' + c3.chips.join(' ') + ']' +
            ' · ' + (c3.sinNumero ? 'SIGUE EN ROJO' : 'de vuelta en azul'));
        }

        // ── EL UNDO, que es lo que el editor pierde cuando borra un chip ──
        total++;
        await page.evaluate(PREPARAR, { sel: SELECTOR[d.donde], texto: 'copiá ' + TOKEN_1 + ' arriba' });
        await page.keyboard.press('ArrowLeft');   // el cursor entre el chip y el espacio
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Backspace');
        await new Promise((res) => setTimeout(res, 120));
        const borrado = await page.evaluate(LEER_MENU, { sel: SELECTOR[d.donde] });
        // El undo se pide por el comando de edición y no con Meta+Z: es EXACTAMENTE
        // la misma pila (la del navegador), y así la medición no depende de que el
        // atajo del sistema llegue a un Chromium sin ventana.
        const deshecho = await page.evaluate(function (sel) {
          document.execCommand('undo');
          const campo = document.querySelector(sel).querySelector('.hp-campo-input');
          campo.dispatchEvent(new Event('input', { bubbles: true }));
          return { valor: campo.value, chips: campo.querySelectorAll('.hp-chip').length };
        }, SELECTOR[d.donde]);
        const undoOk = borrado.chips.length === 0 && deshecho.valor.indexOf(TOKEN_1) !== -1 &&
          deshecho.chips === 1;
        if (!undoOk) malas++;
        console.log((undoOk ? '  ok   ' : '  MAL  ') +
          'borrar un chip se DESHACE'.padEnd(26) +
          ' · borrado: ' + JSON.stringify(borrado.valor.slice(0, 26)) +
          ' → undo: ' + JSON.stringify(deshecho.valor.slice(0, 40)) +
          ' · ' + deshecho.chips + ' chip');

        // ── EL MENÚ DEL `@` ──
        total += 3;
        await page.evaluate(PREPARAR, { sel: SELECTOR[d.donde], texto: 'copiá ' });
        await page.keyboard.type('@');
        await new Promise((res) => setTimeout(res, 150));
        const menuAbierto = await page.evaluate(LEER_MENU, { sel: SELECTOR[d.donde] });
        const abreBien = menuAbierto.visible && menuAbierto.filas.length > 1 &&
          menuAbierto.dentro && menuAbierto.rotulos.length > 0;
        if (!abreBien) malas++;
        console.log((abreBien ? '  ok   ' : '  MAL  ') +
          'el `@` abre el menú'.padEnd(26) +
          ' · ' + menuAbierto.filas.length + ' filas [' + menuAbierto.rotulos.join(' / ') + ']' +
          ' · hacia ' + (menuAbierto.arriba ? 'arriba' : 'abajo') + ' (hueco abajo ' +
          menuAbierto.huecoAbajo + 'px, techo ' + (menuAbierto.techo || 'el del CSS') + ')' +
          ' · ' + (menuAbierto.dentro ? 'entero en pantalla' : 'CORTADO: ' + JSON.stringify(menuAbierto.caja)));

        // FILTRA TECLEANDO. La consulta sale del nombre de la PRIMERA fila, así que
        // la cuenta esperada se puede calcular acá y compararla exacta: escribir una
        // letra cualquiera («a») dejaba las nueve filas y el test pasaba sin haber
        // filtrado nada.
        const q = (menuAbierto.filas[0].nombre.split('.')[0] || '').slice(0, 6);
        const pliega = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const esperadas = menuAbierto.filas.filter((f) => pliega(f.nombre).indexOf(pliega(q)) !== -1).length;
        await page.keyboard.type(q);
        await new Promise((res) => setTimeout(res, 180));
        const filtrado = await page.evaluate(LEER_MENU, { sel: SELECTOR[d.donde] });
        const filtraBien = filtrado.visible && filtrado.filas.length === esperadas &&
          filtrado.filas.length >= 1 && filtrado.dentro &&
          filtrado.filas.every((f) => pliega(f.nombre).indexOf(pliega(q)) !== -1);
        if (!filtraBien) malas++;
        console.log((filtraBien ? '  ok   ' : '  MAL  ') +
          'y filtra tecleando'.padEnd(26) +
          ' · «' + q + '» · ' + menuAbierto.filas.length + ' → ' + filtrado.filas.length +
          ' filas (esperadas ' + esperadas + ') [' + filtrado.filas.map((f) => f.etiqueta).join(' ') + ']');

        // ── Y EL ENTER, que es LA trampa: no puede dejar un salto de línea ──
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await new Promise((res) => setTimeout(res, 180));
        const elegido = await page.evaluate(LEER_MENU, { sel: SELECTOR[d.donde] });
        const sinSalto = elegido.valor.indexOf('\n') === -1;
        const entroChip = elegido.chips.length === 1 && /@\[/.test(elegido.valor);
        const enterOk = sinSalto && entroChip && !elegido.visible;
        if (!enterOk) malas++;
        console.log((enterOk ? '  ok   ' : '  MAL  ') +
          'Enter elige, sin salto'.padEnd(26) +
          ' · ' + JSON.stringify(elegido.valor) +
          (sinSalto ? '' : ' · EL ENTER DEJÓ UN SALTO DE LÍNEA') +
          (elegido.visible ? ' · EL MENÚ QUEDÓ ABIERTO' : ''));
      }
      await page.close();
    }
  }
  await browser.close();
  console.log('\n' + (total - malas) + '/' + total + ' comprobaciones en verde');
  if (errores.length) { console.log('\nerrores de JS:'); errores.forEach((e) => console.log('  ' + e)); }
  process.exitCode = (malas || errores.length) ? 1 : 0;
})();
