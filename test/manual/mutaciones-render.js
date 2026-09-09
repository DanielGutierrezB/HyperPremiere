'use strict';

// Un test que no falla cuando rompés el código no está probando nada.
//
// Este script mete a propósito cada regresión que los tests nuevos dicen cubrir,
// corre la suite, y avisa si alguna pasó igual. No corre en CI: se usa a mano
// cuando se toca esta parte.   node test/manual/mutaciones-render.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const raiz = path.join(__dirname, '..', '..');

const MUTACIONES = [
  // --- Lo que recibió este marcador: verlo, ajustarlo, y que no se escape ---
  //
  // Las dos primeras son las que el diseño existe para evitar, y son opuestas: o
  // el ajuste se va de su alcance y reescribe los archivos del proyecto, o se
  // queda tan corto que se muestra y no viaja. Ninguna hace fallar nada a la
  // vista: en la primera el recurso sale bien y el que sale distinto es el de otra
  // clase, la semana que viene; en la segunda el recurso sale igual que antes y
  // parece que el modelo no hizo caso.

  {
    // LA regresión. Tipear en el campo del curso escribe el archivo del curso, que
    // comparten todas las clases y viaja en el .prproj a las otras máquinas. Ya
    // pagamos un bug de esta familia (vaciar el campo de una clase reescribía la
    // base de todas) y este diseño existe para no reintroducirlo por otra puerta.
    nombre: 'editar en Corrections reescribe el archivo del curso',
    archivo: 'cep/js/corrections-contexto.js',
    de: '      ta.addEventListener("input", function () {\n        marcar(o.key);',
    a: '      ta.addEventListener("input", function () {\n' +
       '        if (marcar(o.key) && o.scope) HPGeneral.save(deps.projectPath(), deps.sequenceName(), ta.value, o.scope).catch(function () {});\n' +
       '        marcar(o.key);',
  },
  {
    // El otro extremo: el ajuste es decorativo. Se ve en la fila, se dice que se
    // ajustó, y el pedido sale con el prompt del proyecto igual que siempre.
    nombre: 'el ajuste local se muestra pero no viaja con el pedido',
    archivo: 'cep/js/corrections.js',
    de: '      if (ajuste) job.payload.promptOverride = ajuste;',
    a:  '      if (false) job.payload.promptOverride = ajuste;',
  },
  {
    // Viaja, pero el motor no lo aplica: el mismo síntoma que la anterior, un
    // escalón más abajo, y del lado donde el contexto se combina de verdad.
    nombre: 'el ajuste llega al motor y el motor lo ignora',
    archivo: 'bridge/prompt/build-context.js',
    de: "    if (!ov || typeof ov !== 'object' || typeof ov[nivel] !== 'string') return;",
    a:  '    if (true) return;',
  },
  {
    // Se aplica, pero pisa TODO: los niveles que el editor no tocó salen
    // congelados con el texto de la fila, así que arreglar el prompt del proyecto
    // deja de servir para esa corrección sin que nada lo diga.
    nombre: 'el ajuste pisa también los niveles que el editor no tocó',
    archivo: 'cep/js/corrections-contexto.js',
    de: '          if (!tocado[k]) return;\n          out = out || {};',
    a:  '          out = out || {};',
  },
  {
    // El objetivo ajustado se rellena solo: la cola lo completa cuando el payload
    // no trae ninguno, así que vaciarlo a mano no hace nada.
    nombre: 'el objetivo ajustado lo vuelve a rellenar el del panel',
    archivo: 'bridge/prompt/build-context.js',
    de: "const NIVELES = ['course', 'sequence', 'objective'];",
    a:  "const NIVELES = ['course', 'sequence'];",
  },
  {
    // "Desde cero" arrastra el ajuste: un job encolado con un prompt de otro día
    // se rediseñaría con ese prompt para siempre, incluso después de arreglarlo.
    nombre: '"desde cero" se queda con el ajuste de la corrección anterior',
    archivo: 'cep/js/queue.js',
    de: '        delete j.payload.promptOverride;\n        j.payload.mode = "regen";',
    a:  '        j.payload.mode = "regen";',
  },
  {
    // La relectura al revés: la pestaña manda el contexto ya resuelto en toda
    // corrección, así que arreglar el prompt del proyecto y reintentar sale con el
    // viejo. Es el bug que se arregló a propósito hace unos días.
    nombre: 'la pestaña vuelve a mandar el contexto resuelto en cada corrección',
    archivo: 'cep/js/corrections-contexto.js',
    de: '        var out = null;\n        ["course", "sequence", "objective"].forEach(function (k) {\n          if (!tocado[k]) return;',
    a:  '        var out = {};\n        ["course", "sequence", "objective"].forEach(function (k) {',
  },
  {
    // La ficha deja de anotar los tres niveles: de acá en adelante tampoco se
    // podría saber con qué contexto se generó nada, y no falla nada.
    nombre: 'la ficha vuelve a guardar solo la instrucción',
    archivo: 'bridge/engine.js',
    de: '    prompts: g.prompts,\n',
    a:  '',
  },
  {
    // La otra mitad de la misma promesa: la ficha del final tiene que decir que
    // la generación LLEGÓ, y lo dice por ausencia. Si el campo se arrastra, toda
    // generación exitosa queda marcada como a medias y "esto no terminó" deja de
    // significar algo.
    nombre: 'la ficha del final arrastra el "quedó a medias" del principio',
    archivo: 'bridge/engine.js',
    de: '    pending: g.pending,',
    a:  '    pending: true,',
  },
  {
    // Anotar el tramo a mano se lleva puesto el contexto: la fila pasa de dato a
    // reconstrucción por haber contestado una pregunta que no tiene que ver.
    // Anotar el tramo a mano se lleva puesto el contexto: escribir la ficha
    // entera donde había que mergear sobre lo previo. La fila pasa de dato a
    // reconstrucción por haber contestado una pregunta que no tiene que ver.
    nombre: 'anotar el tramo a mano borra el contexto de la ficha',
    archivo: 'bridge/engine.js',
    de: '    mergeVersionMeta(metaPath, { sequenceName: body.sequenceName, markerSlug, marker });',
    a:  '    writeVersionMeta(metaPath, { sequenceName: body.sequenceName, markerSlug, marker });',
  },
  {
    // El caso que hay que decir y no mezclar: una versión vieja no guardó nada, y
    // los archivos de hoy se muestran como si fueran lo que recibió. El editor
    // rediseña mirando un contexto inventado.
    nombre: 'una reconstrucción se presenta como lo que se mandó',
    archivo: 'cep/js/corrections-contexto.js',
    de: '    var guardado = !!m.prompts;',
    a:  '    var guardado = true;',
  },
  {
    // Del otro lado: el motor rellena lo que no se guardó con los archivos de hoy,
    // así que el panel ya no tiene con qué distinguirlo.
    nombre: 'el motor rellena el contexto que no se guardó con los archivos de hoy',
    archivo: 'bridge/engine.js',
    de: '        prompts: pos.prompts,',
    a:  "        prompts: pos.prompts || { course: ahora.projectText || '', sequence: ahora.sequenceText || '', objective: '' },",
  },
  {
    // Guardar para todo el curso deja de preguntar: la acción que le cambia el
    // estilo a un curso entero se dispara con un clic y sin decir a quién le llega.
    nombre: 'guardar para todo el curso no pregunta nada',
    archivo: 'cep/js/corrections-contexto.js',
    de: '      HPWidgets.confirmOverlay(o.saveTitle, function (body) {',
    a:  '      (function (t, f, l, ok) { return ok(); })(o.saveTitle, function (body) {',
  },
  {
    // EL bug de la 1.5.1, reintroducido: guardar el del curso vuelve a afirmar que
    // el de la clase está vacío sin haber leído su archivo. La cola le cree
    // —ensureGeneralPrompt saltea la lectura cuando dice estar leído— y la próxima
    // generación de esa clase sale sin su prompt de secuencia. No falla nada a la
    // vista: el recurso sale con el estilo del curso a secas.
    nombre: 'guardar el del curso fabrica que la clase ya se leyó',
    archivo: 'cep/js/general-prompt.js',
    de: '      if (scope === "project") {\n        var pKey = String(projectPath || "");',
    a:  '      if (scope === "project") {\n        var pKey = String(projectPath || "");\n' +
        '        var kf = claveDe(projectPath, sequenceName);\n' +
        '        if (!seqCache[kf]) { var vf = seqVacia(); vf.loaded = true; seqCache[kf] = vf; }',
  },
  {
    // La otra punta, y la peor: guardar el de la clase afirma que el proyecto no
    // tiene estilo, así que la generación sale SIN el prompt del curso. Es
    // textualmente el bug que la 1.5.0 vino a matar.
    nombre: 'guardar el de la clase fabrica que el del curso ya se leyó',
    archivo: 'cep/js/general-prompt.js',
    de: '        var sKey = claveDe(projectPath, sequenceName);\n        var previa = seqCache[sKey] || seqVacia();',
    a:  '        var sKey = claveDe(projectPath, sequenceName);\n        var previa = seqCache[sKey] || seqVacia();\n' +
        '        var pkf = String(projectPath || "");\n' +
        '        if (!cursoCache[pkf]) { var cf = cursoVacio(); cf.loaded = true; cursoCache[pkf] = cf; }',
  },
  {
    // La misma fabricación un escalón más arriba: alcanza con haber leído UNO de
    // los dos niveles para que el contexto entero diga estar leído.
    nombre: 'alcanza con leer un nivel para que el contexto diga estar leído',
    archivo: 'cep/js/general-prompt.js',
    de: '      loaded: curso.loaded && seq.loaded,',
    a:  '      loaded: curso.loaded || seq.loaded,',
  },
  {
    // BLOQUEANTE 3: el texto se vuelve a leer cuando se APRIETA el botón y no
    // cuando el editor acepta. Si tocó el campo mientras leía la confirmación de
    // cinco renglones, al archivo va el texto viejo y el campo muestra otro.
    nombre: 'guardar un nivel escribe el texto de antes de la confirmación',
    archivo: 'cep/js/corrections-contexto.js',
    de: '      var c = campos[o.key];\n      var esCurso = o.scope === "project";',
    a:  '      var c = { ta: { value: campos[o.key].ta.value } };\n      var esCurso = o.scope === "project";',
  },
  {
    // Y la segunda mitad del mismo bloqueante: después de guardar se fuerza
    // "no ajustado" sin volver a comparar, así que el campo puede mostrar X, el
    // archivo tener Y, y el pedido salir con Y sin que nada lo diga.
    nombre: 'después de guardar se da por hecho que el campo dejó de estar ajustado',
    archivo: 'cep/js/corrections-contexto.js',
    de: '            marcar(o.key);\n            pintarBoton(o);',
    a:  '            tocado[o.key] = false;\n            pintarBoton(o);',
  },
  {
    // La ficha deja de anotar CUÁL nivel se ajustó a mano, que es el único dato
    // con el que el panel distingue "el archivo cambió" de "esto nunca salió del
    // archivo". Sin él vuelve a echarle la culpa a un archivo que nadie tocó.
    nombre: 'la ficha no anota qué nivel se ajustó a mano',
    archivo: 'bridge/engine.js',
    de: '    rec.adjusted = { course: a.course, sequence: a.sequence, objective: a.objective };',
    a:  '    rec.adjusted = { course: a.course, sequence: a.sequence };',
  },
  {
    // Y del lado del panel: se dice siempre que el archivo cambió, que era la
    // misatribución. El texto se muestra igual, así que solo se ve leyéndolo.
    nombre: 'el panel le echa la culpa al archivo de un ajuste hecho a mano',
    archivo: 'cep/js/corrections-contexto.js',
    de: '        partes.push(ajustadoEntonces[o.key]',
    a:  '        partes.push(false',
  },

  // --- 1.5.1: los dos botones de la caja de feedback, debajo del campo ---
  //
  // Las cuatro son la misma familia de regresión: el rediseño se deshace de a
  // pedacitos y la caja vuelve a tener los botones al costado, o pierde la
  // jerarquía entre los dos. Ninguna rompe el comportamiento (refinar sigue
  // avisando con el cuadro vacío, desde cero sigue preguntando), y por eso hacen
  // falta: son las que solo se ven mirando.

  {
    // El estado de la captura: los dos botones en la misma fila que el campo, en
    // dos columnas angostas, y el cuadro de texto en 57 px con el panel en 320.
    nombre: 'los botones vuelven al costado del campo',
    archivo: 'cep/js/queue-view.js',
    de: '    acciones.appendChild(go);',
    a:  '    inRow.appendChild(go);',
  },
  {
    // Sin el reparto, cada botón vale su etiqueta: "↻ Aplicar el ajuste" queda en su etiqueta
    // pegado a la izquierda y "⟲ Regenerar desde cero" al lado, o sea otra vez
    // dos botones sueltos en vez de dos renglones.
    nombre: 'las acciones dejan de repartirse el ancho y valen su etiqueta',
    archivo: 'cep/css/style.css',
    de: '.qj-fb-actions .qbtn-react {\n  flex: 1 1 100%;',
    a:  '.qj-fb-actions .qbtn-react {',
  },
  {
    // Los dos iguales: se pierde la única señal de que uno descarta el trabajo
    // hecho y el otro no.
    nombre: 'desde cero se ve igual de grande que Refinar',
    archivo: 'cep/css/style.css',
    de: '  font-size: 10.5px; padding: 4px 10px;\n  color: var(--text-secondary); border-color: var(--hairline);',
    a:  '  font-size: 12px; padding: 8px 14px;\n  color: var(--text-secondary); border-color: var(--hairline);',
  },
  {
    // El `align-self: stretch` que hacía las dos columnas altas. Si vuelve, con
    // los botones ya abajo lo que se estira es el renglón, pero es la regla que
    // no tiene que estar y el test la busca donde vivía.
    nombre: 'la fila del campo vuelve a estirar los botones a su alto',
    archivo: 'cep/css/style.css',
    de: '.qj-fb-input:focus { outline: none; border-color: var(--accent); }',
    a:  '.qj-fb-input:focus { outline: none; border-color: var(--accent); }\n.qj-feedback .qbtn-react { align-self: stretch; }',
  },

  // --- 1.5.0: refina el proveedor elegido, y el semáforo se acuerda del cupo ---

  {
    // El bug tal como lo reportó el editor: "si tengo configurado el CLI de
    // Cursor, aún siento que el botón de refinar manda el prompt por Claude".
    // Sin mirar `cfg.provider`, el elegido no va primero y gana la cadena vieja.
    nombre: 'el refinado vuelve a ignorar el proveedor que el editor eligió',
    archivo: 'bridge/dictado-refinar.js',
    de: '  if (refinadorPorId(elegidoId)) orden.push({ id: elegidoId, esElegido: true });',
    a:  '  if (false && refinadorPorId(elegidoId)) orden.push({ id: elegidoId, esElegido: true });',
  },
  {
    // El respaldo dejaría de ser respaldo: Cursor y la API compatible se
    // meterían en la cadena de cualquiera, gastándole plata al editor por una
    // vía que no pidió.
    nombre: 'Cursor y la API compatible se cuelan en el respaldo de todos',
    archivo: 'bridge/dictado-refinar.js',
    de: '    if (r.id === elegidoId || r.soloSiLoEligen) return;',
    a:  '    if (r.id === elegidoId) return;',
  },
  {
    // El elegido se probaría dos veces: dos arranques de CLI para el mismo "no".
    nombre: 'el proveedor elegido se repite abajo como respaldo de sí mismo',
    archivo: 'bridge/dictado-refinar.js',
    de: '    if (r.id === elegidoId || r.soloSiLoEligen) return;',
    a:  '    if (r.soloSiLoEligen) return;',
  },
  {
    // Refinó el respaldo y el panel lo presenta como si fuera el elegido: el
    // editor no se entera de que su texto lo escribió otro modelo.
    nombre: 'no se dice que refinó el respaldo y no el proveedor elegido',
    archivo: 'bridge/dictado-refinar.js',
    de: "  return cual.esElegido ? base : base + ' (respaldo)';",
    a:  '  return base;',
  },
  {
    // El bug de Claude, reintroducido en la versión Cursor: "no se pudo
    // averiguar" dibujado como "no tenés sesión". Es exactamente el que hizo
    // que un editor generara tres recursos seguidos con el cartel puesto.
    nombre: '"no sé si hay sesión de Cursor" se dibuja como "no hay"',
    archivo: 'cep/js/config-ui.js',
    de: '    } else {\n      currentSession = "?";\n    }',
    a:  '    } else {\n      currentSession = "no"; currentSessionWarn = "iniciá sesión en " + opts.marca;\n    }',
  },
  {
    // El caso de la captura: semáforo en verde y `Credit balance is too low`
    // abajo. El motor se entera y no se lo cuenta a nadie.
    nombre: 'el semáforo se queda en verde con la cuenta sin cupo',
    archivo: 'bridge/provider-salud.js',
    de: '  if (!nota || !s || s.estado !== \'con-sesion\') return s;',
    a:  '  if (true) return s;',
  },
  {
    // El cartel de "sin cupo" queda pegado: el editor carga crédito, guarda la
    // config y el panel sigue en ámbar hasta que reinicie Premiere.
    nombre: 'cargar crédito y guardar la config no borra el cartel de "sin cupo"',
    archivo: 'bridge/provider-salud.js',
    de: 'function olvidar(provider) {\n  delete notas[String(provider || \'\').trim()];',
    a:  'function olvidar(provider) {\n  if (provider === undefined) delete notas[String(provider || \'\').trim()];',
  },
  {
    // Un timeout o un modelo inexistente dejarían el indicador en ámbar para
    // siempre, que es cómo un indicador útil se vuelve ruido que nadie mira.
    nombre: 'cualquier falla, no solo la de cupo, mancha el indicador',
    archivo: 'bridge/provider-salud.js',
    de: '  if (!p || !RECORDABLES[c]) return;',
    a:  '  if (!p) return;',
  },
  {
    // Cursor refinaría con el modelo de DISEÑO que el editor tenga elegido
    // (puede ser un Opus con razonamiento) para reordenar dos frases.
    nombre: 'refinar por Cursor usa el modelo de diseño en vez del corto',
    archivo: 'bridge/dictado-refinar.js',
    de: '    model: () => cursorCli.MODELO_CORTO,',
    a:  '    model: () => cursorCli.DEFAULT_MODEL,',
  },
  {
    // El refinado por Cursor pasaría por `stripHtmlFence`, que sobre una
    // instrucción de diseño no hace nada hasta el día que mencione un bloque
    // de código y se la coma.
    nombre: 'el refinado por Cursor vuelve a pasar por el desenvolver-HTML',
    archivo: 'bridge/providers/cursor-cli.js',
    de: 'module.exports = { generate, complete, listModels, DEFAULT_MODEL, MODELO_CORTO };',
    a:  'module.exports = { generate, complete: generate, listModels, DEFAULT_MODEL, MODELO_CORTO };',
  },

  {
    nombre: 'el render se manda igual con la composición rota',
    archivo: 'bridge/compose.js',
    de: '  if (best.problem) {\n    throw Object.assign(new Error(',
    a:  '  if (false && best.problem) {\n    throw Object.assign(new Error(',
  },
  {
    nombre: 'un error de composición se toma como problema de máquina',
    archivo: 'bridge/render/hyperframes.js',
    de: "  return /zero duration|this is permanent|root_missing_|missing `?data-composition-id/i\n    .test(String(salida || ''));",
    a:  "  return false;",
  },
  {
    nombre: 'la escalera reintenta igual un error permanente',
    archivo: 'bridge/render/hyperframes.js',
    de: '      if (esErrorDeComposicion(e.message)) {',
    a:  '      if (false) {',
  },
  {
    nombre: 'el perfil de otra máquina se usa igual',
    archivo: 'bridge/store/render-profile.js',
    de: "    if (!saved || saved.fingerprint !== fingerprint()) return null;",
    a:  "    if (!saved) return null;",
  },
  {
    nombre: 'el perfil de 1 worker no pide captura por pantalla',
    archivo: 'bridge/render/hyperframes.js',
    de: "    a.push('--low-memory-mode');",
    a:  "    a.push('--target-chunk-frames', '300');",
  },
  {
    nombre: 'se comparan marcadores de cualquier tamaño entre sí',
    archivo: 'bridge/store/render-profile.js',
    de: '  return Math.floor((frames || 0) / FOTOGRAMAS_POR_BALDE);',
    a:  '  return 0;',
  },
  {
    nombre: 'alcanza con una sola corrida de cada reparto',
    archivo: 'bridge/store/render-profile.js',
    de: 'const MUESTRAS_MINIMAS = 3;',
    a:  'const MUESTRAS_MINIMAS = 1;',
  },
  {
    nombre: 'cualquier diferencia, por chica que sea, cambia el reparto',
    archivo: 'bridge/store/render-profile.js',
    de: 'const VENTAJA_MINIMA = 0.10;',
    a:  'const VENTAJA_MINIMA = 0;',
  },
  {
    nombre: 'se compara el promedio en vez del mejor tiempo',
    archivo: 'bridge/store/render-profile.js',
    de: '      if (mejores[n][b] === undefined || m.ms < mejores[n][b]) mejores[n][b] = m.ms;',
    a:  '      if (mejores[n][b] === undefined || m.ms > mejores[n][b]) mejores[n][b] = m.ms;',
  },
  {
    nombre: 'gana el que ganó en un tamaño aunque pierda en otro',
    archivo: 'bridge/store/render-profile.js',
    de: '    if (ganador && ganador !== gana) return null; // se contradicen entre tamaños',
    a:  '    if (ganador && ganador !== gana) return ganador;',
  },
  {
    nombre: 'un render sin fotogramas contados se anota igual',
    archivo: 'bridge/store/render-profile.js',
    de: '  if (!(frames > 0) || !(ms > 0)) return null;',
    a:  '  if (false) return null;',
  },
  {
    nombre: 'los dos repartos no se alternan: siempre se prueba el mismo',
    archivo: 'bridge/store/render-profile.js',
    de: '    if (cuantas < menos) { menos = cuantas; mejor = c; }',
    a:  '    void cuantas;',
  },
  {
    nombre: 'los carriles se mueven en medio de la medición',
    archivo: 'bridge/render/hyperframes.js',
    de: '  if (p.aprendido && p.workers === 1) {',
    a:  '  if (p.workers === 1) {',
  },
  // El contador de tokens es el peor lugar para una regresión: sale un número
  // más chico y no hay nada que falle. Estas son las cinco formas de perderlo.
  {
    nombre: 'la entrada vuelve a ser solo el pedazo sin cachear',
    archivo: 'bridge/providers/index.js',
    de: '    totalInputTokens: entrada + cacheLeida + cacheEscrita,',
    a:  '    totalInputTokens: entrada,',
  },
  {
    nombre: 'a Cursor le renombran el campo de caché y nadie se entera',
    archivo: 'bridge/providers/cursor-cli.js',
    de: '        cacheCreationTokens: u.cacheWriteTokens,',
    a:  '        cacheCreationTokens: u.cacheCreationTokens,',
  },
  {
    nombre: 'un proveedor sin el total deja la entrada en cero',
    archivo: 'bridge/compose.js',
    de: '    usage.totalInputTokens += Number(u.totalInputTokens) ||\n' +
        '      // Un proveedor de otra versión puede no traerlo: se recompone.\n' +
        '      ((Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheCreationTokens) || 0));',
    a:  '    usage.totalInputTokens += Number(u.totalInputTokens) || 0;',
  },
  {
    nombre: 'el panel deja de acumular la caché escrita',
    archivo: 'cep/js/store.js',
    de: '      cur.cacheCreationTokens += Number(usage.cacheCreationTokens) || 0;',
    a:  '      void usage.cacheCreationTokens;',
  },
  {
    nombre: 'las generaciones sin costo cuentan como si lo hubieran informado',
    archivo: 'cep/js/store.js',
    de: "      if (typeof usage.costUsd === 'number') {",
    a:  '      if (true) {',
  },
  {
    nombre: 'la línea de la sesión vuelve a mostrar la entrada a medias',
    archivo: 'cep/js/util.js',
    de: '    var entrada = (u.inputTokens || 0) + cache;',
    a:  '    var entrada = (u.inputTokens || 0);',
  },
  {
    nombre: 'el acumulado viejo pasa por bien contado',
    archivo: 'cep/js/store.js',
    de: '          legacyMix: !!u.legacyMix || (Number(u.generations) > 0 && Number(u.rule) !== 2)',
    a:  '          legacyMix: false',
  },
  {
    nombre: 'con dólares y sin repartos se muestra "en 0 de 164"',
    archivo: 'cep/js/util.js',
    de: '    var reparto = u.costGenerations > 0 && u.costGenerations < gens;',
    a:  '    var reparto = u.costGenerations < gens;',
  },
  // Buscar la secuencia y, si no entró, poder colocarla después.
  {
    nombre: 'una secuencia ilegible vuelve a cortar la búsqueda',
    archivo: 'cep/jsx/host.jsx',
    de: '        } catch (eI) {\n            HP_SEQ_SCAN.ilegibles++;\n        }',
    a:  '        } catch (eI) { return null; }',
  },
  {
    nombre: 'con dos candidatas parecidas se elige una al azar',
    archivo: 'cep/jsx/host.jsx',
    de: '    if (casi && cuantasCasi === 1) return casi;',
    a:  '    if (casi) return casi;',
  },
  {
    nombre: 'no se avisa que la secuencia está en otro proyecto abierto',
    archivo: 'cep/jsx/host.jsx',
    de: '    HP_SEQ_SCAN.otroProyecto = hp_seqInOtherProject(want);',
    a:  '    HP_SEQ_SCAN.otroProyecto = "";',
  },
  {
    nombre: 'un render que no entró no queda marcado para colocarse',
    archivo: 'cep/js/queue.js',
    de: '      job.notPlaced = true;\n      job._movPath = res.movPath;',
    a:  '      job.notPlaced = false;\n      job._movPath = res.movPath;',
  },
  {
    nombre: 'la marca de "sin colocar" no se guarda y muere al cerrar el panel',
    archivo: 'cep/js/queue.js',
    de: '      notPlaced: j.notPlaced, _movPath: j._movPath, _placeColor: j._placeColor,',
    a:  '',
  },
  {
    nombre: 'los comentarios de Frame.io se vuelven a buscar solo por el nombre',
    archivo: 'cep/js/util.js',
    de: '    if (FRAMEIO_COMMENT_ID.test(comment) || FRAMEIO_COMMENT_ID.test(name)) return true;',
    a:  '',
  },
  {
    nombre: 'el filtro de Frame.io se pasa de listo y mira la palabra suelta',
    archivo: 'cep/js/util.js',
    de: '  var FRAMEIO_COMMENT_ID = /frame\\.?io[\\s_-]*comment[\\s_-]*id\\s*:/i;',
    a:  '  var FRAMEIO_COMMENT_ID = /frame\\.?io/i;',
  },
  {
    nombre: 'un recurso sin colocar de una versión anterior del panel no se reconoce',
    archivo: 'cep/js/queue.js',
    de: '    return /NO lo coloqu/.test(String(job.msg || ""));',
    a:  '    return false;',
  },
  {
    nombre: 'el video no se busca en el disco cuando el job no trae la ruta',
    archivo: 'cep/js/queue.js',
    de: '      if (r && r.ok && r.movPath) { job._movPath = r.movPath; return r.movPath; }',
    a:  '      if (false) { return ""; }',
  },
  {
    nombre: 'al recolocar, el color de la corrección se pierde',
    archivo: 'cep/js/queue.js',
    de: '      return hostPlace(job, mov, job._placeColor || COLOR_NONE).then(function (place) {',
    a:  '      return hostPlace(job, mov, COLOR_NONE).then(function (place) {',
  },
  {
    // El borrador y su "Render HQ" se fueron: ya no hay dónde pedir otra calidad
    // y el mp4 con fondo tiene que salir SIEMPRE en calidad de lectura. Bajarlo
    // no rompe nada visible —el video sale, se coloca, el job cierra en verde—,
    // se ve recién proyectando la clase.
    nombre: 'el mp4 con fondo vuelve a la compresión del viejo modo borrador',
    archivo: 'bridge/render/hyperframes.js',
    de: "    a.push('--crf', '18');",
    a:  "    a.push('--crf', '28');",
  },
  {
    nombre: 'el render pide una calidad que ya nadie elige',
    archivo: 'bridge/render/hyperframes.js',
    de: "    '--quality', 'high',",
    a:  "    '--quality', 'draft',",
  },
  // ── Mirar y rehacer desde la Cola (v1.4.45) ────────────────────────
  {
    nombre: 'el clic en el nombre vuelve a arrastrar el panel a Marcadores',
    archivo: 'cep/js/queue-view.js',
    de: 'top.addEventListener("click", (function (job) { return function (e) { e.stopPropagation(); deps.showJobInTimeline(job); }; })(j));',
    a:  'top.addEventListener("click", (function (job) { return function (e) { e.stopPropagation(); deps.goToJobMarker(job); }; })(j));',
  },
  {
    nombre: 'refinar con el cuadro vacío vuelve a rediseñar sin avisar',
    archivo: 'cep/js/queue-view.js',
    de: '      if (!t) {\n        deps.setOutput("Escribí qué ajustar, o usá “Regenerar desde cero”.", true);\n        return;\n      }',
    a:  '      if (false) { return; }',
  },
  {
    nombre: 'desde cero vuelve a dispararse de una, sin preguntar',
    archivo: 'cep/js/queue-view.js',
    de: '      }, "Regenerar desde cero", function () { closeFeedback(j.id); HPQueue.regenerateFresh(j.id); });',
    a:  '      }, "Regenerar desde cero", function () {});\n      closeFeedback(j.id); HPQueue.regenerateFresh(j.id);',
  },
  {
    nombre: 'la confirmación no aclara que el feedback escrito no se usa',
    archivo: 'cep/js/queue-view.js',
    de: '        if (t) {\n          var q = document.createElement("p");',
    a:  '        if (false) {\n          var q = document.createElement("p");',
  },
  {
    nombre: 'rediseñar desde cero arrastra la versión previa',
    archivo: 'cep/js/queue.js',
    de: '        delete j.payload.previousHtml;\n        delete j.payload.adjustment;\n        delete j.payload.stillsSend;\n',
    a:  '',
  },
  {
    nombre: 'al reencolar queda ofreciéndose el “Colocar” del render viejo',
    archivo: 'cep/js/queue.js',
    de: '    job.notPlaced = false; job._movPath = "";',
    a:  '    job.pct = 0;',
  },
  {
    nombre: 'el filtro de la cola muestra igual las otras secuencias',
    archivo: 'cep/js/queue-view.js',
    de: '      visibles = jobs.filter(function (j) { return j.seqName === actual; });',
    a:  '      visibles = jobs;',
  },
  {
    nombre: 'la preferencia del filtro no se recuerda',
    archivo: 'cep/js/queue-view.js',
    de: '    try { global.localStorage.setItem(ONLY_CURRENT_KEY, v ? "1" : "0"); } catch (e) {}',
    a:  '    try { void v; } catch (e) {}',
  },
  // ── El cartel de "falta iniciar sesión" cuando la sesión está ──────
  // Todas estas mutaciones tienen el mismo final: un editor que puede generar
  // recibe igual el cartel. Es el modo de falla más caro de los que hay acá,
  // porque no rompe nada — manda a arreglar algo que funciona, y a distancia.
  {
    nombre: 'no saber si hay sesión vuelve a contarse como no tenerla',
    archivo: 'bridge/claude-session.js',
    de: "  return {\n    estado: 'no-se-sabe',\n    metodo: '',\n    como: '',\n    porQue: 'el CLI contestó algo que no supe leer'",
    a:  "  return {\n    estado: 'sin-sesion',\n    metodo: '',\n    como: '',\n    porQue: 'el CLI contestó algo que no supe leer'",
  },
  {
    nombre: 'un CLI viejo, que ni conoce el comando, pasa por máquina sin sesión',
    archivo: 'bridge/claude-session.js',
    de: "  if (NO_CONOCE_RE.test(crudo)) {\n    return { estado: 'no-se-sabe'",
    a:  "  if (NO_CONOCE_RE.test(crudo)) {\n    return { estado: 'sin-sesion'",
  },
  {
    nombre: 'faltar el CLI se confunde con faltar la sesión',
    archivo: 'bridge/claude-session.js',
    de: "      estado: 'sin-cli',\n      metodo: '',",
    a:  "      estado: 'sin-sesion',\n      metodo: '',",
  },
  {
    nombre: 'el token guardado deja de valer cuando el CLI no sabe contestar',
    archivo: 'bridge/claude-session.js',
    de: '  if (hayToken) {',
    a:  '  if (false) {',
  },
  {
    nombre: 'el JSON se busca en el stdout entero y un aviso arriba lo tapa',
    archivo: 'bridge/claude-session.js',
    de: "  const llave = crudo.indexOf('{');",
    a:  '  const llave = 0;',
  },
  {
    nombre: 'sin token propio igual se pisa la variable, y el CLI pierde SU sesión',
    archivo: 'bridge/claude-session.js',
    de: '  if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth;',
    a:  "  env.CLAUDE_CODE_OAUTH_TOKEN = oauth || '';",
  },
  {
    nombre: 'el panel vuelve a avisar cuando todavía no sabe nada (el bug original)',
    archivo: 'cep/js/config-ui.js',
    // Reapuntada de paso: la condición dejó de nombrar al proveedor a mano
    // (ahora es `esCli`), pero la regla que fija es la misma.
    de: '    if (esCli && currentSession === "no") { ok = false; warn = currentSessionWarn; }',
    a:  '    if (esCli && currentSession !== "si") { ok = false; warn = currentSessionWarn; }',
  },
  {
    nombre: 'sin token guardado el panel arranca dando por hecho que falta la sesión',
    archivo: 'cep/js/config-ui.js',
    // Reapuntada de paso: la línea quedó en el `else` de la rama de Cursor.
    de: '    else currentSession = cfg.hasSession ? "si" : "?";',
    a:  '    else currentSession = cfg.hasSession ? "si" : "no";',
  },
  // ── La imagen de referencia que el modelo no miró ──────────────────
  // El modo de falla más mudo del proyecto: la composición sale presentable y
  // no tiene nada que ver con el cuadro que el editor eligió. Estas mutaciones
  // apagan, una por una, las cosas que lo hacen visible.
  {
    nombre: 'el CLI vuelve a arrancar con todas las herramientas',
    archivo: 'bridge/providers/claude-cli.js',
    de: "    if (!viejo && !sinTools) args.push('--tools', TOOLS, '--allowedTools', TOOLS);",
    a:  '    if (false) args.push();',
  },
  {
    nombre: 'leer vuelve a quedar pendiente de un permiso que nadie puede dar',
    archivo: 'bridge/providers/claude-cli.js',
    de: "args.push('--tools', TOOLS, '--allowedTools', TOOLS);",
    a:  "args.push('--tools', TOOLS);",
  },
  {
    nombre: 'una imagen sin abrir no se avisa',
    archivo: 'bridge/providers/claude-cli.js',
    de: '    if (imagePaths.length && streaming) {',
    a:  '    if (false) {',
  },
  {
    nombre: 'se avisa igual cuando el modelo SÍ las abrió todas',
    archivo: 'bridge/providers/agent-stream.js',
    de: '  return (esperados || []).filter((e) => vistos.indexOf(base(e)) === -1);',
    a:  '  return (esperados || []);',
  },
  {
    nombre: 'la ruta se compara entera, así que ./imagen-1.png parece otra imagen',
    archivo: 'bridge/providers/agent-stream.js',
    de: "  const base = (p) => String(p || '').replace(/\\\\/g, '/').split('/').pop().toLowerCase();",
    a:  "  const base = (p) => String(p || '');",
  },
  {
    nombre: 'lo que leyó se busca en los eventos parciales, que llegan sin la ruta',
    archivo: 'bridge/providers/agent-stream.js',
    de: "    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {\n      o.message.content.forEach((b) => {\n        if (!b || b.type !== 'tool_use') return;",
    a:  "    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {\n      o.message.content.forEach((b) => {\n        if (true) return;",
  },
  {
    nombre: 'denegar Write vuelve a decirle al editor que se diseñó a ciegas',
    archivo: 'bridge/providers/claude-cli.js',
    de: "      const deLectura = nombres.filter((n) => /^(read|glob|grep|notebookread)$/i.test(n));",
    a:  "      const deLectura = nombres;",
  },
  {
    nombre: 'un CLI sin --tools se lleva puesto el estado en vivo por el mismo cartelito',
    archivo: 'bridge/providers/claude-cli.js',
    de: '    if (!sinTools && rechazoDeFlag(r) && rechazoDeTools(r)) {',
    a:  '    if (false) {',
  },
  // ── Elegir cuánto piensa el modelo, con Cursor ─────────────────────
  {
    nombre: 'el nivel de pensamiento vuelve a esconderse en Cursor',
    archivo: 'cep/js/config-ui.js',
    de: '    showRow("row-effort", isClaude || isCursor);',
    a:  '    showRow("row-effort", isClaude);',
  },
  {
    nombre: 'el ID se guarda pelado y Cursor se queda sin el nivel elegido',
    archivo: 'cep/js/config-ui.js',
    de: '      return cursorIdFor(currentCursorGroup(), cfgEffortSel ? cfgEffortSel.value : "");',
    a:  '      return currentCursorGroup() ? currentCursorGroup().family : "";',
  },
  {
    nombre: 'se ofrecen niveles que la cuenta no tiene',
    archivo: 'cep/js/config-ui.js',
    de: '      disponibles = EFFORT_LEVELS.filter(function (o) { return !!niveles[o.v]; });',
    a:  '      disponibles = EFFORT_LEVELS;',
  },
  {
    nombre: 'el nivel del ID guardado se pierde y queda el del panel',
    archivo: 'cep/js/config-ui.js',
    de: '      populateEfforts(pick && pick.effort ? pick.effort : (cfgEffortSel ? cfgEffortSel.value : "high"));',
    a:  '      populateEfforts(cfgEffortSel ? cfgEffortSel.value : "high");',
  },
  {
    nombre: 'el motor deja de separar el nivel y el panel no puede agrupar nada',
    archivo: 'bridge/providers/cursor-cli.js',
    de: "      effort: fam ? effortOf(m.id, fam) : '',",
    a:  "      effort: '',",
  },
  {
    nombre: 'el log se queda con el modelo que había al abrir el panel',
    archivo: 'cep/js/config-ui.js',
    de: '    if (body.model) modelNameValue = body.model;',
    a:  '    if (false) modelNameValue = body.model;',
  },
  // ── Los tres niveles del prompt, y que los tres viajen ─────────────
  // Las formas de romper esto no fallan: una deja al compañero generando sin el
  // estilo del curso (el bug original), otra le tira encima lo que el editor
  // había escrito, y las nuevas dejan al modelo eligiendo entre dos
  // indicaciones que se contradicen. Ninguna rompe nada mientras pasa: el
  // recurso sale, distinto, y se descubre viendo el video.
  {
    nombre: 'el prompt del curso vuelve a guardarse por secuencia',
    archivo: 'bridge/store/project-fs.js',
    de: '    project: path.join(projectRootPath(projectPath), COURSE_PROMPT_FILE),',
    a:  '    project: path.join(outputDirPath(projectPath, sequenceName), COURSE_PROMPT_FILE),',
  },
  {
    nombre: 'preguntar por los prompts generales deja creada la carpeta de la secuencia',
    archivo: 'bridge/store/project-fs.js',
    de: "  const seqDir = sequenceName ? outputDirPath(projectPath, sequenceName) : '';",
    a:  "  const seqDir = sequenceName ? ensureOutputDir(projectPath, sequenceName) : '';",
  },
  {
    // Reapuntada: vaciar dejó de tener una rama por nivel (los dos borran), así
    // que la mutación va contra el borrado único.
    nombre: 'vaciar el de una secuencia deja el archivo vacío diciendo que la clase agrega algo',
    archivo: 'bridge/store/project-fs.js',
    de: '      removeIfPresent(file);\n      if (scope === \'sequence\') removeIfPresent(files.sequenceLegacy);\n      return { ok: true, path: file, scope, removed: true, created: false };',
    a:  '      fs.mkdirSync(path.dirname(file), { recursive: true });\n      fs.writeFileSync(file, "", "utf8");\n      return { ok: true, path: file, scope, removed: true, created: false };',
  },
  // ── La combinación de los dos niveles generales ─────────────────
  // Hasta la 1.4.51 el de la secuencia REEMPLAZABA al del curso, y la razón que
  // se daba era buena: dos textos pegados que se contradicen dejan al modelo
  // eligiendo. Lo que faltaba no era reemplazar, era DECIR quién gana. Volver a
  // reemplazar tira el estilo del curso entero sin que nada falle.
  {
    nombre: 'el prompt de la secuencia vuelve a REEMPLAZAR al del curso',
    archivo: 'bridge/prompt/build-context.js',
    de: '    : { course: solo, sequence, unknown: viejo && !!solo && !ctx.generalSource };',
    a:  '    : { course: sequence ? \'\' : solo, sequence, unknown: false };',
  },
  {
    nombre: 'el del curso viaja pero el de la secuencia se queda afuera',
    archivo: 'bridge/prompt/build-context.js',
    de: '  if (levels.sequence) {\n    parts.push',
    a:  '  if (false) {\n    parts.push',
  },
  {
    nombre: 'los dos niveles viajan, pero sin decir quién gana (el modelo elige)',
    archivo: 'bridge/prompt/build-context.js',
    de: "    parts.push(levels.course\n      ? 'Lo propio de ESTA clase, sobre la base del curso. PRECEDENCIA:",
    a:  "    parts.push(levels.course\n      ? 'Lo propio de ESTA clase, sobre la base del curso. (",
  },
  {
    nombre: 'la instrucción del marcador deja de ser la más específica de las tres',
    archivo: 'bridge/prompt/build-context.js',
    de: '  if (levels.course || levels.sequence) {\n    parts.push(\'Es el nivel MÁS específico',
    a:  '  if (false) {\n    parts.push(\'Es el nivel MÁS específico',
  },
  {
    nombre: 'los niveles llegan al revés: primero la clase y después el curso',
    archivo: 'bridge/prompt/build-context.js',
    de: '  styleBlocks(levels).forEach((p) => parts.push(p));',
    a:  '  styleBlocks(levels).reverse().forEach((p) => parts.push(p));',
  },
  {
    nombre: 'el system prompt deja de fijar la regla de precedencia',
    archivo: 'bridge/prompt/system.md',
    de: 'Cuando dos se contradicen, **manda el más específico**',
    a:  'Cuando dos se contradicen, elegí vos cuál conviene',
  },
  {
    nombre: 'el log vuelve a decir solo "sí" y se calla qué niveles entraron',
    archivo: 'bridge/prompt/build-context.js',
    de: "  if (levels.course) return 'del curso';",
    a:  "  if (levels.course) return 'sí';",
  },
  {
    nombre: 'el log dice cuál ganó en vez de que viajaron los dos',
    archivo: 'bridge/prompt/build-context.js',
    de: "    return 'del curso + de esta secuencia (si se contradicen, manda la secuencia)';",
    a:  "    return 'solo de esta secuencia';",
  },
  // ── Los proyectos que ya existen ────────────────────────────────
  // El de la secuencia cambió de nombre. Los archivos que ya están en los
  // proyectos de los editores tienen que seguir andando, sin que nadie renombre
  // nada: romper esto es que una clase pierda su prompt en silencio al
  // actualizar el panel.
  {
    nombre: 'el prompt-general.md que ya estaba adentro de una secuencia deja de leerse',
    archivo: 'bridge/store/project-fs.js',
    de: '    if (sequenceRaw == null && files.sequenceLegacy) {',
    a:  '    if (false) {',
  },
  {
    nombre: 'guardar el de una secuencia deja el del nombre viejo al lado',
    archivo: 'bridge/store/project-fs.js',
    de: "    if (scope === 'sequence') removeIfPresent(files.sequenceLegacy);",
    a:  "    if (false) removeIfPresent(files.sequenceLegacy);",
  },
  {
    // Reapuntada por lo mismo: el legacy se borra en el camino común de vaciar.
    nombre: 'vaciar el de una secuencia del formato viejo no lo borra, y el texto vuelve',
    archivo: 'bridge/store/project-fs.js',
    de: '      if (scope === \'sequence\') removeIfPresent(files.sequenceLegacy);\n      return { ok: true, path: file, scope, removed: true, created: false };',
    a:  '      return { ok: true, path: file, scope, removed: true, created: false };',
  },
  {
    nombre: 'el archivo que cambió de nombre lo hace en silencio, sin dejar rastro en el log',
    archivo: 'cep/js/general-prompt.js',
    de: '      avisarFormatoViejo(projectPath, sequenceName, st);',
    a:  '',
  },
  {
    nombre: 'el aviso del formato viejo se repite en cada lectura',
    archivo: 'cep/js/general-prompt.js',
    de: '    if (!st.sequenceLegacy || avisadoViejo[clave]) return;',
    a:  '    if (!st.sequenceLegacy) return;',
  },
  {
    nombre: 'el nombre viejo le gana al nuevo, y resucita un texto ya reemplazado',
    archivo: 'bridge/store/project-fs.js',
    de: '    let sequenceRaw = files.sequence ? readTextFileOrNull(files.sequence) : null;',
    a:  '    let sequenceRaw = null;',
  },
  // ── La migración de lo que quedó en el localStorage ─────────────
  {
    nombre: 'la migración pisa lo que el compañero ya tenía escrito en el proyecto',
    archivo: 'cep/js/general-prompt.js',
    de: '      if (!st.hasProjectFile && !st.sequenceText) {',
    a:  '      if (true) {',
  },
  {
    nombre: 'lo migrado queda también en el localStorage, y mañana parece un conflicto',
    archivo: 'cep/js/general-prompt.js',
    de: '          borrarLocal(projectPath, sequenceName);\n          hpLog("Prompt general: lo que tenías guardado en esta máquina',
    a:  '          hpLog("Prompt general: lo que tenías guardado en esta máquina',
  },
  {
    nombre: 'dos textos distintos se resuelven en silencio a favor del proyecto',
    archivo: 'cep/js/general-prompt.js',
    de: '      setPending(projectPath, sequenceName, local);\n      borrarLocal(projectPath, sequenceName);',
    a:  '      borrarLocal(projectPath, sequenceName);',
  },
  // ── Cada campo escribe en SU archivo ────────────────────────────
  // Con un solo campo, el destino de escritura salía de qué archivo existiera en
  // el disco, y vaciar el prompt de una secuencia borra el suyo: el tecleo
  // siguiente reescribía el estilo de todo el curso, que les llega a los demás
  // editores. Nada fallaba, el texto se guardaba — en el archivo equivocado. El
  // estado que lo sostenía (`writeScope`) se fue con el botón; la regla no.
  {
    nombre: 'guardar un campo se lleva puesto el otro nivel',
    archivo: 'cep/js/general-prompt.js',
    de: '      if (scope === "project") {\n        var pKey = String(projectPath || "");\n        var previo = cursoCache[pKey] || cursoVacio();',
    a:  '      if (scope === "project") {\n        var pKey = String(projectPath || "");\n        var previo = cursoCache[pKey] || cursoVacio();\n' +
        '        delete seqCache[claveDe(projectPath, sequenceName)];',
  },
  {
    nombre: 'los campos se cruzan: el del curso muestra el de la clase',
    archivo: 'cep/js/general-prompt.js',
    de: '      courseText: st.projectText,\n      sequenceText: st.sequenceText,',
    a:  '      courseText: st.sequenceText || st.projectText,\n      sequenceText: st.sequenceText,',
  },
  {
    nombre: 'el campo de la clase se ofrece sin secuencia abierta, y escribe en ningún lado',
    archivo: 'cep/js/general-prompt.js',
    de: '      sequenceEnabled: !!seq,',
    a:  '      sequenceEnabled: true,',
  },
  {
    nombre: 'el rótulo del campo de la clase deja de nombrar la secuencia',
    archivo: 'cep/js/general-prompt.js',
    de: '        ? "Prompt de secuencia · solo “" + HPUtil.shortenMiddle(seq, 22) + "”"',
    a:  '        ? "Prompt de secuencia"',
  },
  {
    nombre: 'el panel deja de avisar que los dos niveles viajan y quién manda',
    archivo: 'cep/js/general-prompt.js',
    de: '      d.sequenceLine = "Al modelo van los DOS: el del curso (arriba) como base y éste encima, " +\n        "que MANDA donde se contradigan";',
    a:  '      d.sequenceLine = "Prompt de esta secuencia";',
  },

  // ── Los dos bloques, separados y cada uno nombrando al otro ─────
  //
  // El del curso se fue arriba, con el Contexto de la clase, y el de la clase
  // quedó adentro del área de marcadores. Lo que se pagó por separarlos es que
  // la relación entre los dos ya no se ve sola: pegados alcanzaba con mirarlos.
  // Estas tres son la misma familia de regresión —una caja que se lee como si
  // fuera el único prompt que hay— y ninguna rompe nada que se note corriendo el
  // panel: el texto se sigue guardando en su archivo y el modelo sigue
  // recibiendo los dos niveles. Se ven mirando, o no se ven.
  {
    nombre: 'el bloque del curso deja de decir dónde se escribe lo de esta clase',
    archivo: 'cep/js/general-prompt.js',
    de: '    if (d.sequenceEnabled) {\n      d.courseLine += ". Lo de esta clase va abajo, en “" + TITULO_SECUENCIA + "”";\n    }',
    a:  '    if (false) {\n      d.courseLine += ". Lo de esta clase va abajo, en “" + TITULO_SECUENCIA + "”";\n    }',
  },
  {
    // El renglón manda al editor a una sección que en la pantalla se llama de
    // otra manera. Nada falla; simplemente busca un rótulo que no existe.
    nombre: 'el puntero de arriba nombra un bloque que ya no se llama así',
    archivo: 'cep/js/general-prompt.js',
    de: '  var TITULO_SECUENCIA = "Estilo de esta secuencia";',
    a:  '  var TITULO_SECUENCIA = "Prompts generales";',
  },
  {
    // La vista le pone data-hidden al <details> del bloque de la clase; sin la
    // regla queda dibujado sin secuencia abierta, ofreciendo adjuntar
    // referencias y escribir un prompt que no tienen dónde guardarse.
    nombre: 'sin secuencia abierta el bloque de la clase se queda en pantalla',
    archivo: 'cep/css/style.css',
    de: '.general-section[data-hidden="true"] { display: none; }',
    a:  '.general-section[data-hidden="false"] { display: none; }',
  },
  {
    nombre: 'sin motor se da por hecho que no hay estilo (el bug original, otra vez)',
    archivo: 'cep/js/general-prompt.js',
    de: '        cursoCache[pKey] = { text: local, hasFile: false, path: "", loaded: false, failed: true };',
    a:  '        cursoCache[pKey] = { text: "", hasFile: false, path: "", loaded: false, failed: true };',
  },
  // ── La cola, que relee al momento de generar ────────────────────
  {
    nombre: 'leer los prompts generales vuelve a migrar por su cuenta',
    archivo: 'cep/js/queue.js',
    de: '    var p = HPGeneral.load(job.projectPath, seq).catch(function () {})',
    a:  '    var p = HPGeneral.migrate(job.projectPath, seq).catch(function () {})',
  },
  {
    nombre: 'la cola se queda con el prompt viejo pegado al job',
    archivo: 'cep/js/queue.js',
    de: '      if (hayEnDisco || (g.loaded && !trajoResuelto)) {',
    a:  '      if (!dest.generalInstruction) {',
  },
  {
    nombre: 'un proyecto ilegible vacía el estilo con el que se iba a generar',
    archivo: 'cep/js/queue.js',
    de: '      if (hayEnDisco || (g.loaded && !trajoResuelto)) {',
    a:  '      if (true) {',
  },
  {
    nombre: 'la cola relee el del curso pero se queda con el de la clase que traía el job',
    archivo: 'cep/js/queue.js',
    de: '        dest.sequenceInstruction = g.sequenceText;',
    a:  '        dest.sequenceInstruction = dest.sequenceInstruction || g.sequenceText;',
  },
  {
    // LA de esta tanda: la cola vuelve a creerle a la caché del panel. El caso
    // que se pierde es el único que la caché no puede ver —el .md cambiado por
    // AFUERA, sin que ningún save() la refresque— y no falla nada: el reintento
    // sale con el texto viejo justo cuando el editor está arreglando el estilo.
    nombre: 'la cola vuelve a leer una vez por sesión en vez de por job',
    archivo: 'cep/js/queue.js',
    de: '    if (leyendoGeneral[clave]) return leyendoGeneral[clave];',
    a:  '    if (leyendoGeneral[clave]) return leyendoGeneral[clave];\n' +
        '    if (HPGeneral.state(job.projectPath, seq).loaded) return Promise.resolve();',
  },
  {
    // La otra forma de lo mismo: la entrada "en vuelo" sobrevive a la lectura y
    // se convierte en la caché que no queríamos.
    nombre: 'la lectura en vuelo se queda cacheada para siempre',
    archivo: 'cep/js/queue.js',
    de: '      delete leyendoGeneral[clave];',
    a:  '      if (false) delete leyendoGeneral[clave];',
  },
  {
    // El precio de releer por job, si nadie lo cubre: un parpadeo del disco en
    // medio de un lote borra lo que ya se había leído bien y los marcadores que
    // faltan salen sin el prompt de su clase.
    nombre: 'una lectura fallida borra la que había salido bien',
    archivo: 'cep/js/general-prompt.js',
    de: '      if (!seqCache[sKey] || !seqCache[sKey].loaded) {',
    a:  '      if (true) {',
  },
  {
    // Un job de antes de la 1.5.0 trae un solo texto ya resuelto. Una lectura que
    // sale bien y no encuentra NADA —el proyecto no migró— se lo pisaba con el
    // vacío, y el log no miente: dice "prompt general no".
    nombre: 'el proyecto que no migró le borra el prompt a un job viejo',
    archivo: 'cep/js/queue.js',
    de: '      var trajoResuelto = !!dest.generalInstruction && typeof dest.sequenceInstruction === "undefined";',
    a:  '      var trajoResuelto = false;',
  },
  {
    nombre: 'la cola no va a buscar los prompts generales del proyecto antes de generar',
    archivo: 'cep/js/queue.js',
    // REAPUNTADA (estaba obsoleta): a ese Promise.all le entró después la
    // lectura de las referencias, así que el `de` de antes ya no existía.
    de: '      ensureTranscript(job), ensureGeneralPrompt(job), ensureRefs(job)',
    a:  '      ensureTranscript(job), ensureRefs(job)',
  },
  {
    nombre: 'la tarjeta del marcador manda un solo texto ya combinado',
    archivo: 'cep/js/main.js',
    de: '      generalInstruction: genTxt.projectText, sequenceInstruction: genTxt.sequenceText,',
    a:  '      generalInstruction: genTxt.sequenceText || genTxt.projectText,',
  },

  // ── Vaciar un campo: en los dos niveles, y en los cuatro ─────────
  //
  // Vaciar es un ajuste, no "no dije nada". Las dos de acá son la misma familia
  // por dos puertas: el encargo que se borra y viaja el anterior, y el prompt
  // del curso que se borra y deja un archivo de cero bytes al lado del .prproj.
  {
    nombre: 'vaciar el encargo de la corrección manda el anterior',
    archivo: 'cep/js/corrections.js',
    de: '        instruction: encargo === null ? (m.instruction || text) : encargo,',
    a:  '        instruction: encargo || m.instruction || text,',
  },
  {
    nombre: 'el encargo vaciado se pierde antes de salir de la fila',
    archivo: 'cep/js/corrections-contexto.js',
    de: '        if (!tocado.instruction) return null;',
    a:  '        if (!tocado.instruction || !campos.instruction.ta.value.trim()) return null;',
  },
  {
    nombre: 'vaciar el prompt del curso deja un archivo de cero bytes en el proyecto',
    archivo: 'bridge/store/project-fs.js',
    de: "      removeIfPresent(file);\n      if (scope === 'sequence') removeIfPresent(files.sequenceLegacy);\n" +
        "      return { ok: true, path: file, scope, removed: true, created: false };",
    a:  "      if (scope === 'sequence') {\n        removeIfPresent(file);\n        removeIfPresent(files.sequenceLegacy);\n" +
        "        return { ok: true, path: file, scope, removed: true };\n      }\n" +
        "      if (!fs.existsSync(file)) return { ok: true, path: file, scope, created: false };",
  },

  // ── El semáforo de tokens ────────────────────────────────────────
  //
  // Las dos veces que se rompió es la misma: alguien arma A MANO el cuerpo que
  // estima, y ese cuerpo se queda atrás de lo que de verdad viaja. No falla
  // nada; el número queda corto (medido: 47%) y siempre para el mismo lado.
  {
    nombre: 'la tarjeta vuelve a armar a mano el cuerpo que estima',
    archivo: 'cep/js/main.js',
    de: '      hpCall("estimateTokens", buildMarkerPayload(marker, modoDeGeneracion()))',
    a:  '      var d = HPStore.getMarkerData(markerKey);\n' +
        '      hpCall("estimateTokens", { objective: HPStore.getObjective(), instruction: d.instruction || "",\n' +
        '        stills: d.stills || [], resources: d.resources || [] })',
  },
  {
    nombre: 'la Cola estima el payload como está guardado, sin resolver',
    archivo: 'cep/js/queue-view.js',
    de: '      return HPQueue.payloadForEstimate(j).then(function (body) {\n' +
        '        return HPEngine.call("estimateTokens", body);\n' +
        '      }).then(function (r) {',
    a:  '      return HPEngine.call("estimateTokens", j.payload).then(function (r) {',
  },
  {
    nombre: 'el cuerpo del estimado se contesta sin el material ni el estilo',
    archivo: 'cep/js/queue.js',
    de: '      try { aplicarContexto(copia, job); } catch (e) {}',
    a:  '      try { if (false) aplicarContexto(copia, job); } catch (e) {}',
  },
  {
    // Estimar no puede escribirle nada al job: lo que ese job mande se resuelve
    // cuando le toca el turno, con el material de ESE momento.
    nombre: 'estimar deja el contexto pegado al job que sigue en cola',
    archivo: 'cep/js/queue.js',
    de: '      try { aplicarContexto(copia, job); } catch (e) {}\n      return copia;',
    a:  '      try { aplicarContexto(job.payload, job); } catch (e) {}\n      return job.payload;',
  },
  // ── El `flex` de los botones ─────────────────────────────────────────
  //
  // LA regresión de este cambio es la primera: devolver el `button { flex: 1;
  // min-width: 0 }` global, que es el que aplastaba cualquier botón que cayera
  // en una fila flex y le pintaba la etiqueta afuera de la caja. Mordió cuatro
  // veces antes de que se lo invirtiera. Las otras son las formas de deshacer
  // el arreglo a medias, incluida la de volver a tapar un caso con un parche
  // suelto en vez de mirar la causa.
  //
  // Es un desborde de layout, así que lo que se rompe acá es la regla de CSS;
  // medirlo se hace con la maqueta (test/manual/panel-demo/medir-botones.js),
  // que el DOM de mentira no calcula cajas.
  {
    nombre: 'vuelve el `button { flex: 1; min-width: 0 }` global (los cuatro bugs de una)',
    archivo: 'cep/css/style.css',
    de: 'button {\n  appearance: none;\n  flex: 0 1 auto;\n',
    a:  'button {\n  appearance: none;\n  flex: 1;\n  min-width: 0;\n',
  },
  {
    nombre: 'el global recupera solo el `min-width: 0` y los botones se dejan aplastar igual',
    archivo: 'cep/css/style.css',
    de: 'button {\n  appearance: none;\n  flex: 0 1 auto;\n',
    a:  'button {\n  appearance: none;\n  flex: 0 1 auto;\n  min-width: 0;\n',
  },
  {
    nombre: 'la barra de acciones deja de repartir en partes iguales',
    archivo: 'cep/css/style.css',
    de: '.actions button { flex: 1 1 0; }',
    a:  '.actions button { flex: 1 1 auto; }',
  },
  {
    nombre: 'vuelve el piso a mano de 120 px y la barra de acciones no envuelve cuando debe',
    archivo: 'cep/css/style.css',
    de: '.actions { flex-wrap: wrap; }',
    a:  '.actions { flex-wrap: wrap; }\n.actions button { min-width: 120px; }',
  },
  {
    nombre: 'se tapa el cartel "Preparar motor" con un parche suelto en vez de mirar la causa',
    archivo: 'cep/css/style.css',
    de: '.engine-prep .ep-text { flex: 1 1 240px;',
    a:  '.engine-prep .ep-row > button { flex: 0 0 auto; }\n.engine-prep .ep-text { flex: 1 1 240px;',
  },
  {
    nombre: 'se saca el `flex: none` del botón cuadrado, que es el único que hace falta',
    archivo: 'cep/css/style.css',
    de: '.icon-btn {\n  flex: none; width: 26px;',
    a:  '.icon-btn {\n  width: 26px;',
  },
  {
    nombre: 'la fila del cartel deja de envolver y aprieta el texto contra el botón',
    archivo: 'cep/css/style.css',
    de: '.engine-prep .ep-row { display: flex; flex-wrap: wrap; gap: 10px;',
    a:  '.engine-prep .ep-row { display: flex; gap: 10px;',
  },
  {
    nombre: 'el texto del cartel no reclama ancho, así que la fila nunca envuelve',
    archivo: 'cep/css/style.css',
    de: '.engine-prep .ep-text { flex: 1 1 240px;',
    a:  '.engine-prep .ep-text { flex: 1 1 0;',
  },

  // ── Dictado por voz ──────────────────────────────────────────────────
  // Las tres primeras son LA regresión de esta función: el micrófono colgado
  // sin preguntar si el dictado existe. No rompe el micrófono, rompe el campo
  // de prompt entero, que es la diferencia entre "no puedo dictar" y "no puedo
  // trabajar". Pasó de verdad y dejó 44 tests en rojo.
  {
    nombre: 'el micrófono se cuelga sin preguntar y se lleva puesta la caja de feedback',
    archivo: 'cep/js/queue-view.js',
    de: '    var mic = micOpcional(ta, {\n      id: "cola:" + j.id,\n      onChange: function (texto) { feedbackDraft[j.id] = texto; },\n    });\n    if (mic) fb.appendChild(mic);',
    a:  '    fb.appendChild(HPDictado.attachMic(ta, {\n      id: "cola:" + j.id,\n      onChange: function (texto) { feedbackDraft[j.id] = texto; },\n    }).el);',
  },
  {
    nombre: 'el micrófono se cuelga sin preguntar y se lleva puesta la fila de correcciones',
    archivo: 'cep/js/corrections.js',
    de: '    var mic = micOpcional(box, { id: "correccion:" + m.slug });\n    if (mic) row.appendChild(mic);',
    a:  '    row.appendChild(HPDictado.attachMic(box, { id: "correccion:" + m.slug }).el);',
  },
  {
    nombre: 'el micrófono se cuelga sin preguntar en la tarjeta del marcador',
    archivo: 'cep/js/main.js',
    de: '    var mic = micOpcional(instruction, {\n      id: "marcador:" + markerKey,\n      onChange: function (texto) { HPStore.setMarkerInstruction(markerKey, texto); },\n    });\n    if (mic) body.appendChild(mic);',
    a:  '    body.appendChild(HPDictado.attachMic(instruction, {\n      id: "marcador:" + markerKey,\n      onChange: function (texto) { HPStore.setMarkerInstruction(markerKey, texto); },\n    }).el);',
  },
  {
    // La global no está DECLARADA, así que nombrarla tira ReferenceError antes
    // de poder evaluar el `!`. Es el mismo agujero con cara de guarda.
    nombre: 'la guarda pregunta por !HPDictado en vez de por typeof',
    archivo: 'cep/js/util.js',
    de: 'if (typeof HPDictado === "undefined" || !HPDictado || typeof HPDictado.attachMic !== "function") return null;',
    a:  'if (!HPDictado || typeof HPDictado.attachMic !== "function") return null;',
  },
  {
    nombre: 'un attachMic que revienta por dentro vuelve a tumbar el campo',
    archivo: 'cep/js/util.js',
    de: '    try { return HPDictado.attachMic(ta, opts).el; } catch (e) { return null; }',
    a:  '    return HPDictado.attachMic(ta, opts).el;',
  },

  // La compuerta de silencio: si se abre, Whisper inventa frases y el editor se
  // encuentra "¡Suscríbete!" adentro de la instrucción de su marcador.
  {
    nombre: 'la compuerta deja pasar el silencio al modelo',
    archivo: 'bridge/dictado.js',
    de: "  if ((e.rmsTotal || 0) < RMS_MINIMO) {",
    a:  "  if (false) {",
  },
  {
    nombre: 'el umbral de silencio vuelve al que dejaba pasar el "¡Suscríbete!"',
    archivo: 'bridge/dictado.js',
    de: "const RMS_MINIMO = Number(process.env.HYPERPREMIERE_DICTADO_RMS) || 0.02;",
    a:  "const RMS_MINIMO = Number(process.env.HYPERPREMIERE_DICTADO_RMS) || 0.0025;",
  },
  {
    nombre: 'el umbral se pone tan alto que el habla tampoco pasa',
    archivo: 'bridge/dictado.js',
    de: "const RMS_MINIMO = Number(process.env.HYPERPREMIERE_DICTADO_RMS) || 0.02;",
    a:  "const RMS_MINIMO = Number(process.env.HYPERPREMIERE_DICTADO_RMS) || 0.2;",
  },
  {
    nombre: 'la alucinación se descarta por contener la frase, no por SER la frase',
    archivo: 'bridge/dictado.js',
    de: "  if (ALUCINACIONES.indexOf(limpio) !== -1) return true;",
    a:  "  if (ALUCINACIONES.some((f) => limpio.indexOf(f) !== -1)) return true;",
  },

  // El proceso persistente: sin esto cada frase paga ~1,2 s de arranque del CLI,
  // que es entre 8 y 15 veces lo que cuesta transcribir.
  {
    nombre: 'el proceso de Whisper se levanta de nuevo en cada frase',
    archivo: 'bridge/dictado.js',
    de: '  if (motor && motor.listo) { rearmarOcio(); return motor.listo; }\n  if (motor) return motor.listo;',
    a:  '  if (motor) bajarMotor("mutación");',
  },
  {
    nombre: 'usar el dictado no rearma el reloj: se baja en medio de una frase',
    archivo: 'bridge/dictado.js',
    de: '  rearmarOcio();\n  return r;',
    a:  '  return r;',
  },
  {
    nombre: 'se le manda solo el audio nuevo en vez de la ventana entera',
    archivo: 'bridge/dictado.js',
    de: '  fs.writeFileSync(m.pcmPath, buf);',
    a:  '  fs.writeFileSync(m.pcmPath, buf.slice(-32000));',
  },

  // El veredicto de la máquina: en Windows el botón va apagado DICIENDO por qué,
  // no escondido. Que se vea que la función existe fue una decisión explícita.
  {
    nombre: 'en Windows el dictado se ofrece igual y falla al abrir el micrófono',
    archivo: 'bridge/dictado.js',
    de: "  if (m.plataforma !== 'darwin') {",
    a:  "  if (false) {",
  },
  {
    nombre: 'el botón deshabilitado se esconde en vez de decir por qué',
    archivo: 'cep/js/dictado.js',
    de: '        titulo: "Dictado por voz no disponible. " + (d.motivo || "No se pudo averiguar por qué."),',
    a:  '        titulo: "Dictado por voz no disponible.",',
  },

  // La vuelta al dictado crudo tiene que devolver EXACTAMENTE lo dictado: es
  // contra eso que el editor compara el refinado para decidir si le gusta.
  {
    nombre: 'volver al crudo con el campo vacío agrega un salto de línea de más',
    archivo: 'cep/js/dictado.js',
    de: '    if (!a) return b;',
    a:  '    if (!a) return "\\n" + b;',
  },
  {
    nombre: 'el dictado pisa lo que el editor ya tenía escrito',
    archivo: 'cep/js/dictado.js',
    de: '    return a + "\\n" + b;',
    a:  '    return b;',
  },

  // El refinador: puede reordenar, no puede inventar ni perder. Y si no se pudo,
  // el dictado crudo tiene que llegar al campo igual.
  {
    nombre: 'un refinado que se comió la mitad del pedido llega al campo igual',
    archivo: 'bridge/dictado-refinar.js',
    de: '  if (c >= 8 && r < Math.ceil(c * 0.35)) {',
    a:  '  if (false) {',
  },
  {
    nombre: 'un refinado que inventa el triple de texto llega al campo igual',
    archivo: 'bridge/dictado-refinar.js',
    de: '  if (c >= 8 && r > c * 3) {',
    a:  '  if (false) {',
  },
  {
    nombre: 'sin refinador el campo queda vacío en vez de con el dictado',
    archivo: 'bridge/dictado-refinar.js',
    de: "      ok: false, texto: juntos, crudo: crudo, refinador: '', ms: 0,\n      aviso: 'Quedó el dictado sin refinar: no hay ningún refinador disponible en esta máquina. ' +",
    a:  "      ok: false, texto: '', crudo: crudo, refinador: '', ms: 0,\n      aviso: 'Quedó el dictado sin refinar: no hay ningún refinador disponible en esta máquina. ' +",
  },
  {
    nombre: 'si el refinador se cae, el dictado se pierde',
    archivo: 'bridge/dictado-refinar.js',
    de: '      ok: false, texto: juntos, crudo: crudo,\n      refinador: cual.nombre, ms: Date.now() - t0,',
    a:  "      ok: false, texto: '', crudo: crudo,\n      refinador: cual.nombre, ms: Date.now() - t0,",
  },
  {
    nombre: 'no se dice por qué no hay refinador: solo que no lo hay',
    archivo: 'bridge/dictado-refinar.js',
    de: "  return elegido.descartados.map((d) => d.nombre + ': ' + d.motivo).join(' · ');",
    a:  "  return '';",
  },
  {
    nombre: 'cursor-cli vuelve a entrar en la cadena de refinadores',
    archivo: 'bridge/dictado-refinar.js',
    de: "const REFINADORES = [\n  {\n    id: 'claude-api',",
    a:  "const REFINADORES = [\n  { id: 'cursor-cli', nombre: 'Cursor', detectar: async () => ({ disponible: false, motivo: 'x' }) },\n  {\n    id: 'claude-api',",
  },
  {
    nombre: 'se le pregunta al CLI de Claude si hay sesión en cada dictado',
    archivo: 'bridge/dictado-refinar.js',
    de: '  if (elegido && !(opts && opts.forzar)) return elegido.ok ? elegido : null;',
    a:  '  if (false) return null;',
  },
  {
    nombre: 'guardar una API key nueva no cambia con qué se refina',
    archivo: 'bridge/engine.js',
    // REAPUNTADA (estaba obsoleta): entre esas dos líneas entró el olvido de la
    // salud del proveedor, así que el `de` de antes ya no existía en el archivo.
    //
    // Y apuntada a código de verdad SOBREVIVE, que es lo que la obsolescencia
    // estaba tapando: ningún test entra por `engine.setConfig`. El de
    // dictado-refinar ("guardar la config vuelve a preguntar") llama a
    // `olvidarRefinador()` a mano y anota al lado "es lo que hace saveConfig",
    // así que prueba el olvido y no que guardar la config lo dispare. Cerrarlo
    // pide un test que escriba la config de verdad en disco.
    de: '  dictadoRefinar.olvidarRefinador();\n',
    a:  '',
  },
  {
    nombre: 'un modelo local enorme se elige igual y el refinado tarda un minuto',
    archivo: 'bridge/dictado-refinar.js',
    de: '  if (chico && (chico.size || 0) > 10e9) return null;',
    a:  '  void chico;',
  },

  // El gasto del refinado va en su propio bolsillo. Mezclarlo con el de las
  // animaciones hace ilegible el número que el editor mira para saber cuánto le
  // costó una clase: un refinado son cientos de tokens, una generación decenas
  // de miles.
  {
    nombre: 'el gasto del dictado se suma al de las animaciones',
    archivo: 'cep/js/store.js',
    de: '    addDictadoUsage: function (usage) {\n      if (!usage) return this.getSessionUsage();',
    a:  '    addDictadoUsage: function (usage) {\n      if (usage) return this.addSessionUsage(usage);\n      if (!usage) return this.getSessionUsage();',
  },
  {
    nombre: 'el gasto del dictado se cuenta pero no se muestra en ningún lado',
    archivo: 'cep/js/util.js',
    de: '    if (dic.corta) line += \' · \' + dic.corta;',
    a:  '    void dic;',
  },
  {
    nombre: 'un refinado que se descarta no cuenta los tokens que igual se gastaron',
    archivo: 'bridge/dictado-refinar.js',
    de: '      refinador: cual.nombre, ms: ms, usage: salida.usage,\n      aviso:',
    a:  '      refinador: cual.nombre, ms: ms,\n      aviso:',
  },

  // El micrófono del dictado: elegir por nombre, resolver al índice de hoy, caer
  // al del sistema DICIÉNDOLO, y una prueba que use el mismo comando que el
  // dictado y distinga las tres formas de "no anda" que se midieron.
  {
    nombre: 'micrófono: las cámaras entran en la lista de micrófonos',
    archivo: 'bridge/dictado-microfono.js',
    de: '    if (/AVFoundation video devices:/i.test(linea)) { enAudio = false; continue; }',
    a:  '    if (/AVFoundation video devices:/i.test(linea)) { enAudio = true; continue; }',
  },
  {
    nombre: 'micrófono: sin el elegido se cae al PRIMERO de la lista (acá, el iPhone) y no al del sistema',
    archivo: 'bridge/dictado-microfono.js',
    de: "  const r = {\n    entrada: ':default',",
    a:  "  const r = {\n    entrada: lista.length ? ':' + lista[0].indice : ':default',",
  },
  {
    nombre: 'micrófono: la caída al del sistema no dice qué faltaba',
    archivo: 'bridge/dictado-microfono.js',
    de: '  } else if (nombre) {\n    r.aviso = \'El micrófono elegido, «\'',
    a:  '  } else if (false) {\n    r.aviso = \'El micrófono elegido, «\'',
  },
  {
    nombre: 'micrófono: el silencio digital se toma como señal floja',
    archivo: 'bridge/dictado-microfono.js',
    de: '  if (m.cerosPct >= 99.5) {',
    a:  '  if (false) {',
  },
  {
    nombre: 'micrófono: abrir sin entregar ni una muestra se confunde con señal floja',
    archivo: 'bridge/dictado-microfono.js',
    de: "  if (!m.bytes) {\n    return {\n      estado: 'sin-muestras',",
    a:  "  if (false) {\n    return {\n      estado: 'sin-muestras',",
  },
  {
    nombre: 'micrófono: la voz se juzga por el pico y no por el promedio que mira el dictado',
    archivo: 'bridge/dictado-microfono.js',
    de: '  if (m.rmsGlobal >= umbral) {\n    return {\n      estado: \'ok\',',
    a:  '  if (m.pico >= umbral) {\n    return {\n      estado: \'ok\',',
  },
  {
    nombre: 'micrófono: un índice que ya no existe se diagnostica como problema de permisos',
    archivo: 'bridge/dictado-microfono.js',
    de: '  if (/Invalid audio device index|Audio device not found|No AV capture device found/i.test(s)) {',
    a:  '  if (false) {',
  },
  {
    nombre: 'micrófono: la línea de EOS Webcam Utility en stderr cuenta como error de ffmpeg',
    archivo: 'bridge/dictado-microfono.js',
    de: '    .filter((l) => l.trim() && !/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d+ ffmpeg\\[\\d+:\\d+\\]/.test(l))',
    a:  '    .filter((l) => l.trim())',
  },
  {
    nombre: 'micrófono: la prueba abre el micrófono con OTRO comando que el dictado',
    archivo: 'bridge/dictado-microfono.js',
    de: '  const ff = startProcess(ffmpegBin(), argsDeCaptura(usa.entrada));',
    a:  "  const ff = startProcess(ffmpegBin(), ['-f', 'avfoundation', '-i', usa.entrada, '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1']);",
  },
  {
    nombre: 'micrófono: dos pruebas seguidas abren dos ffmpeg sobre el mismo micrófono',
    archivo: 'bridge/dictado-microfono.js',
    de: '  prueba = { t0: Date.now() };\n  try {',
    a:  '  prueba = null;\n  try {',
  },
  {
    nombre: 'micrófono: el dictado no deja en el log qué dispositivo abrió',
    archivo: 'bridge/dictado.js',
    de: "    note: 'Dictado (' + id + '): micrófono ' + microfono.describir(usa) + (usa.aviso ? ' · ' + usa.aviso : ''),",
    a:  "    note: 'Dictado (' + id + '): micrófono listo',",
  },
  // El desplegable del micrófono se mudó de config-ui.js a mic-select.js en la
  // v1.4.49, cuando el mismo control pasó a estar también en el encabezado.
  {
    nombre: 'micrófono: el elegido que no está enchufado desaparece del desplegable',
    archivo: 'cep/js/mic-select.js',
    de: '      opts.push({ value: elegido, label: elegido + " · no conectado ahora", corto: "⚠ " + nombreCorto(elegido) });',
    a:  '      void 0;',
  },
  {
    nombre: 'micrófono: cambiarlo no avisa a los botones 🎙',
    archivo: 'cep/js/mic-select.js',
    de: '      if (typeof HPDictado !== "undefined" && HPDictado && typeof HPDictado.olvidarEstado === "function") HPDictado.olvidarEstado();',
    a:  '      void 0;',
  },
  {
    nombre: 'micrófono: la lista se enumera pero no queda en el log',
    archivo: 'cep/js/mic-select.js',
    de: '      log("Micrófonos (" + porQue + "): " + (r.dispositivos.map(function (d) {',
    a:  '      void ("Micrófonos (" + porQue + "): " + (r.dispositivos.map(function (d) {',
  },

  // ── El encabezado responsive y el micrófono que vive ahí (v1.4.49) ──
  //
  // El desplegable está en DOS lugares (arriba y ⚙) con un solo estado. La
  // regresión que importa es que se desincronicen: elegís arriba y ⚙ sigue
  // mostrando el de antes, que es exactamente lo que pasaría si alguien
  // duplicara el control en vez de montar dos vistas del mismo.
  {
    nombre: 'encabezado: elegir en una vista no repinta la otra (se desincronizan)',
    archivo: 'cep/js/mic-select.js',
    de: '  function pintarTodas() { vistas.forEach(pintar); }',
    a:  '  function pintarTodas() { vistas.slice(0, 1).forEach(pintar); }',
  },
  {
    nombre: 'encabezado: las dos vistas corren ffmpeg una vez cada una',
    archivo: 'cep/js/mic-select.js',
    de: '    if (enVuelo) return enVuelo;',
    a:  '    if (false) return enVuelo;',
  },
  {
    nombre: 'encabezado: se ofrece elegir micrófono en una máquina que no puede dictar',
    archivo: 'cep/js/mic-select.js',
    de: '      var mostrar = vista.dictadoDisponible !== false && hayDeQueElegir(r);',
    a:  '      var mostrar = true;',
  },
  {
    nombre: 'encabezado: no saber si se puede dictar se toma como que no se puede',
    archivo: 'cep/js/mic-select.js',
    de: '      vista.dictadoDisponible = (st && st.disponible === false) ? false : true;',
    a:  '      vista.dictadoDisponible = Boolean(st && st.disponible);',
  },
  {
    nombre: 'encabezado: se muestra un desplegable vacío cuando no hay dispositivos',
    archivo: 'cep/js/mic-select.js',
    de: '    return Boolean(r && r.ok && ((r.dispositivos || []).length || r.elegido));',
    a:  '    return Boolean(r);',
  },
  {
    nombre: 'encabezado: el desplegable de arriba no dice qué micrófono es',
    archivo: 'cep/js/mic-select.js',
    de: '      vista.root.setAttribute("title", tooltip(r));',
    a:  '      vista.root.setAttribute("title", "Micrófono");',
  },
  {
    nombre: 'encabezado: cambiar de micrófono en medio de un dictado no aclara nada',
    archivo: 'cep/js/mic-select.js',
    de: '      if (!st || !st.enCurso) return;',
    a:  '      return;',
  },
  {
    nombre: 'encabezado: el nombre corto no saca el sufijo que repiten todos',
    archivo: 'cep/js/mic-select.js',
    de: '      var sin = corto.replace(SUFIJOS[i], "").trim();',
    a:  '      var sin = corto.trim();',
  },
  {
    nombre: 'encabezado: el nombre del dispositivo se acorta por el FINAL',
    archivo: 'cep/js/mic-select.js',
    de: '    return HPUtil.shortenMiddle(corto, TOPE_CORTO);',
    a:  '    return corto.slice(0, TOPE_CORTO);',
  },
  // Las tres del CSS, que es donde vivía el solapamiento. Los tests leen el
  // archivo real, así que tocar la regla los tiene que hacer fallar.
  {
    nombre: 'encabezado: la marca vuelve a poder aplastarse (se pinta sobre la insignia)',
    archivo: 'cep/css/style.css',
    de: '.brand { flex: 0 0 auto; max-width: 100%; }',
    a:  '.brand { flex: 0 1 auto; min-width: 0; max-width: 100%; }',
  },
  {
    nombre: 'encabezado: el grupo de herramientas vuelve a envolver por el medio (? sobre ⟳)',
    archivo: 'cep/css/style.css',
    de: '.header-tools { flex: 1 1 auto; flex-wrap: nowrap; justify-content: flex-end; min-width: 0; }',
    a:  '.header-tools { flex: 1 1 auto; flex-wrap: wrap; justify-content: flex-end; min-width: 0; }',
  },
  {
    nombre: 'encabezado: vuelve el blindaje del contenedor, que ya no hace falta',
    archivo: 'cep/css/style.css',
    de: '.header-tools { flex: 1 1 auto; flex-wrap: nowrap; justify-content: flex-end; min-width: 0; }',
    a:  '.header-tools { flex: 1 1 auto; flex-wrap: nowrap; justify-content: flex-end; min-width: 0; }\n.header-tools > * { flex: none; }',
  },
  {
    nombre: 'encabezado: el grupo de herramientas deja de llevarse el espacio libre',
    archivo: 'cep/css/style.css',
    de: '.header-tools { flex: 1 1 auto; flex-wrap: nowrap;',
    a:  '.header-tools { flex: 0 1 auto; flex-wrap: nowrap;',
  },
  {
    nombre: 'encabezado: el menú del micrófono se ancla al botón de 34 px',
    archivo: 'cep/css/style.css',
    de: 'max-width: 176px; margin-right: auto; position: static; }',
    a:  'max-width: 176px; margin-right: auto; position: relative; }',
  },
  {
    nombre: 'micrófono: el pico sostenido del medidor sigue al nivel de ahora',
    archivo: 'cep/js/mic-medidor.js',
    de: '        peak.style.left = porcentaje(n.picoDbfs) + "%";',
    a:  '        peak.style.left = porcentaje(n.dbfs) + "%";',
  },
  {
    nombre: 'micrófono: mientras escucha, la línea no dice con qué micrófono',
    archivo: 'cep/js/dictado.js',
    de: '      var por = m.nombre\n        ? " por «"',
    a:  '      var por = false\n        ? " por «"',
  },

  // El campo que crece mientras se dicta. La que importa es la primera: sin el
  // tope, el campo empuja el botón de parar fuera de la vista y el editor queda
  // dictando sin poder frenar, que es peor que no tener la función.
  {
    nombre: 'el campo crece sin tope y se lleva puesto el botón de parar',
    archivo: 'cep/js/dictado.js',
    de: '    var alto = Math.min(Math.max(contenido, minimo), tope);',
    a:  '    var alto = Math.max(contenido, minimo);',
  },
  {
    nombre: 'el tope es un número fijo de píxeles y no mira el alto del panel',
    archivo: 'cep/js/dictado.js',
    de: '    var tope = Math.min(Math.round(altoPanel * FRACCION_PANEL), TOPE_ABSOLUTO, altoPanel - reserva);',
    a:  '    var tope = TOPE_ABSOLUTO;',
  },
  {
    nombre: 'el campo crece pero al terminar queda estirado',
    archivo: 'cep/js/dictado.js',
    de: '      ta.style.height = "auto";\n',
    a:  '',
  },
  {
    nombre: 'con el campo lleno se ve el principio del dictado y no lo último que dijo',
    archivo: 'cep/js/dictado.js',
    de: '      try { ta.scrollTop = ta.scrollHeight; } catch (e) {}',
    a:  '      try { void ta.scrollHeight; } catch (e) {}',
  },
  {
    nombre: 'arrancar el dictado no trae el campo a la vista',
    archivo: 'cep/js/dictado.js',
    de: '      desplegar();\n      altoBase = ta.offsetHeight || 0;\n      traer(ta);\n      traer(bar);',
    a:  '      altoBase = ta.offsetHeight || 0;',
  },

  // ── La ventana de contexto y el consumo real ──────────────────────────
  // La primera es la que más caro sale: el editor lee "1M", arma una generación
  // de medio millón de tokens y se la come la ventana que sí tenía.
  {
    nombre: 'el 1M se promete también por suscripción',
    archivo: 'cep/js/util.js',
    de: '      (provider === "claude-cli" && q.autenticacion === "api_key");',
    a:  '      (provider === "claude-cli");',
  },
  {
    nombre: 'una familia que no está en la tabla se asume de 1M',
    archivo: 'cep/js/util.js',
    de: '    var largo = VENTANA_CLAUDE[familia];\n    if (!largo) return null;',
    a:  '    var largo = VENTANA_CLAUDE[familia] || 1000000;',
  },
  {
    nombre: 'en Cursor se promete 1M aunque el nombre no lo diga',
    archivo: 'cep/js/util.js',
    de: '      if (!/\\b1M\\b/i.test(String(q.nombre || ""))) return null;',
    a:  '      void q.nombre;',
  },
  {
    nombre: 'lo que informa la API habilita el 1M por cualquier puerta',
    archivo: 'cep/js/util.js',
    de: '    if (largo <= PISO_CLAUDE) return { tokens: largo, texto: fmtVentana(largo), piso: false, largo: largo };',
    a:  '    if (Number(q.reportado) > 0) return { tokens: Number(q.reportado), texto: fmtVentana(q.reportado), piso: false, largo: largo };\n    if (largo <= PISO_CLAUDE) return { tokens: largo, texto: fmtVentana(largo), piso: false, largo: largo };',
  },
  {
    nombre: 'un acumulado de la contabilidad vieja sirve igual de promedio',
    archivo: 'cep/js/store.js',
    de: "      if (!b || typeof b !== 'object' || Number(b.regla) !== 2) return;",
    a:  "      if (!b || typeof b !== 'object') return;",
  },
  {
    nombre: 'sin generaciones medidas se muestra un promedio igual',
    archivo: 'cep/js/util.js',
    de: '    if (gens < 1 || entrada <= 0) return null;',
    a:  '    if (false) return null;',
  },
  {
    nombre: 'todos los proveedores comparten el mismo bolsillo',
    archivo: 'cep/js/store.js',
    de: "      var quien = String(usage.provider || '');",
    a:  "      var quien = 'todos';",
  },
  {
    nombre: 'el gasto no se anota por proveedor: solo queda el total',
    archivo: 'cep/js/store.js',
    de: '      if (quien) {\n        var b = cur.porProveedor[quien] ||',
    a:  '      if (false) {\n        var b = cur.porProveedor[quien] ||',
  },
  {
    nombre: 'las etiquetas no se rearman cuando el CLI dice con qué entra',
    archivo: 'cep/js/config-ui.js',
    de: '        if (antes !== currentAuthMethod) populateModels("claude-cli", effectiveModel());',
    a:  '        void antes;',
  },

  // ── El refinador del dictado, apoyado en los proveedores de verdad ────
  // La primera es la que más caro sale: el mensaje de error del CLI termina en
  // el campo del editor haciéndose pasar por su prompt refinado.
  {
    nombre: 'refinar: el CLI cierra con código 0 y is_error, y su error pasa por refinado',
    archivo: 'bridge/providers/claude-cli.js',
    de: '      if (parsed.is_error) {',
    a:  '      if (false) {',
  },
  {
    nombre: 'refinar: el refinado se lee de un campo que el proveedor no devuelve',
    archivo: 'bridge/dictado-refinar.js',
    de: '  const texto = limpiar(salida.text);',
    a:  '  const texto = limpiar(salida.texto);',
  },
  {
    nombre: 'refinar: el CLI vuelve a poder usar herramientas para refinar dos frases',
    archivo: 'bridge/dictado-refinar.js',
    de: "      tools: '',",
    a:  "      tools: 'Read',",
  },

  // ── El ⟳ del panel a mitad de un dictado ──────────────────────────────
  // Las dos formas de volver al bug: que el estado vivo vuelva a ser del módulo
  // (una instancia por recarga, cada una con su micrófono), y que adoptarlo no
  // baje lo que quedó corriendo.
  {
    nombre: 'dictado: el estado vivo vuelve a ser del módulo y no del proceso',
    archivo: 'bridge/dictado.js',
    de: "const vivos = vivosDe.adoptar('dictado', { motor: null, sesion: null });",
    a:  'const vivos = { motor: null, sesion: null };',
  },
  {
    nombre: 'dictado: la instancia nueva adopta el estado pero no baja lo que quedó corriendo',
    archivo: 'bridge/dictado.js',
    de: 'vivos.bajarTodo = function (porQue) {\n  cortarSesion(porQue);\n  bajarMotor(porQue);\n};',
    a:  'vivos.bajarTodo = function () {};',
  },
  {
    nombre: 'dictado: adoptar la caja no baja la anterior (vale para todos los módulos)',
    archivo: 'bridge/vivos.js',
    de: "    try { previo.bajarTodo('el panel se recargó y este módulo quedó huérfano'); } catch (e) {}",
    a:  '    void previo;',
  },

  // ── La fase del dictado, explícita ────────────────────────────────────
  // Si el motor no la manda, o el panel no la mira, el botón no pasa a "■" y el
  // editor se queda con el micrófono abierto y sin forma de frenarlo.
  {
    nombre: 'dictado: el motor no dice en qué fase está y hay que adivinarla del texto',
    archivo: 'bridge/dictado.js',
    de: "informar({ fase: 'escuchando', msg: 'Escuchando por «'",
    a:  "informar({ msg: 'Escuchando por «'",
  },
  {
    nombre: 'dictado: el panel ignora la fase que le manda el motor',
    archivo: 'cep/js/dictado.js',
    de: '        if (p.fase === "escuchando" && fase !== "escuchando") {',
    a:  '        if (false) {',
  },
  {
    nombre: 'dictado: los procesos largos vuelven a no ser líderes de grupo',
    archivo: 'bridge/exec.js',
    de: '    env: opts.env,\n    detached: !IS_WIN,\n  });',
    a:  '    env: opts.env,\n  });',
  },

  // ── El ✨ de refinar lo escrito a mano ────────────────────────────────
  // Las dos primeras son las que duelen. La de arriba le pisa al editor un
  // párrafo que escribió con las manos —el único daño de esta función que no se
  // puede deshacer—, y la de abajo esconde el botón exactamente en las máquinas
  // donde es la única forma de refinar (Windows, sin ffmpeg, sin Whisper).
  {
    nombre: 'refinar a mano: un refinado que falla pisa el texto del editor',
    archivo: 'cep/js/dictado.js',
    de: '        mostrarFase("sin-refinar", { aviso: r.aviso || "No se pudo refinar lo que escribiste; tu texto quedó como estaba." });',
    a:  '        escribir(textoSinRefinar(r.texto || original, ""));\n        mostrarFase("sin-refinar", { aviso: r.aviso || "No se pudo refinar lo que escribiste; tu texto quedó como estaba." });',
  },
  {
    nombre: 'refinar a mano: el ✨ vuelve a colgarse de "¿se puede dictar?"',
    archivo: 'cep/js/dictado.js',
    de: '        puedeRefinar: info.puedeRefinar,',
    a:  '        puedeRefinar: info.puedeRefinar && info.disponible !== false,',
  },
  {
    nombre: 'refinar a mano: el botón no se cuelga de la barra',
    archivo: 'cep/js/dictado.js',
    de: '    bar.appendChild(btn);\n    bar.appendChild(refBtn);',
    a:  '    bar.appendChild(btn);',
  },
  {
    nombre: 'refinar a mano: el motor deriva "se puede refinar" de "se puede dictar"',
    archivo: 'bridge/engine.js',
    de: '  estado.puedeRefinar = Boolean(cual);',
    a:  '  estado.puedeRefinar = Boolean(cual) && estado.disponible !== false;',
  },
  {
    nombre: 'refinar a mano: se puede refinar lo ya refinado, una vez y otra',
    archivo: 'cep/js/dictado.js',
    de: '    if (o.yaRefinado) return "ya-refinado";',
    a:  '    void o.yaRefinado;',
  },
  {
    nombre: 'refinar a mano: el ✨ no se entera de que el editor teclea',
    archivo: 'cep/js/dictado.js',
    de: '    ta.addEventListener("input", function () { pintarElDeRefinar(); });',
    a:  '    void ta;',
  },
  {
    nombre: 'refinar a mano: el volver al original le recorta lo que escribió',
    archivo: 'cep/js/dictado.js',
    de: '      escribir(viendoOriginal ? original : refinado);',
    a:  '      escribir(viendoOriginal ? String(original).trim() : refinado);',
  },
  {
    nombre: 'refinar a mano: se arranca un refinado encima de otro',
    archivo: 'cep/js/dictado.js',
    de: '      if (refinando.length) {\n        pintar({ error: "Ya hay un refinado andando en otro campo. Esperá a que termine: se refina de a uno." });\n        return;\n      }',
    a:  '      if (false) { return; }',
  },
  {
    // Con un id solo en vez de una lista, el que termina primero suelta la
    // guarda del otro y quedan dos refinados encimados.
    nombre: 'refinar a mano: la guarda vuelve a ser un id solo y la suelta el equivocado',
    archivo: 'cep/js/dictado.js',
    de: '  function soltarRefinado(id) { refinando = refinando.filter(function (x) { return x !== id; }); }',
    a:  '  function soltarRefinado(id) { void id; refinando = []; }',
  },
  {
    nombre: 'refinar a mano: mientras se dicta, el ✨ queda apretable',
    archivo: 'cep/js/dictado.js',
    de: '        dictando: fase === "preparando" || fase === "escuchando",',
    a:  '        dictando: false,',
  },
  {
    nombre: 'refinar a mano: el gasto se cuenta como una generación',
    archivo: 'cep/js/dictado.js',
    de: '        // El MISMO bolsillo que el del dictado, aparte del de las animaciones:\n        // refinar es refinar, lo haya escrito una persona o Whisper.\n        if (r.usage) HPStore.addDictadoUsage(r.usage);',
    a:  '        if (r.usage) HPStore.addSessionUsage(r.usage);',
  },
  {
    nombre: 'refinar a mano: un dictado que no se pudo refinar apaga el ✨',
    archivo: 'cep/js/dictado.js',
    de: '        refinado = "";\n        escribir(original);',
    a:  '        refinado = original;\n        escribir(original);',
  },
  {
    nombre: 'refinar a mano: al modelo se le dice que el texto lo transcribió Whisper',
    archivo: 'cep/js/dictado.js',
    de: '      HPEngine.call("dictadoRefinar", { crudo: texto, origen: "escrito" })',
    a:  '      HPEngine.call("dictadoRefinar", { crudo: texto })',
  },
  {
    nombre: 'refinar a mano: el motor no distingue el origen al armar el pedido',
    archivo: 'bridge/dictado-refinar.js',
    de: "  if (origen === 'escrito') {",
    a:  '  if (false) {',
  },

  // ── La palabra "Refinar" del ✨ ───────────────────────────────────────
  // La primera es LA que importa: sin el corte, la palabra aparece también en
  // el panel mínimo, que es donde se midió que le cuesta un renglón a la línea
  // de estado —el único lugar donde se lee por qué falló un refinado— con el
  // panel pudiendo tener 400 px de alto.
  {
    nombre: 'la palabra: el corte desaparece y aparece hasta en el panel mínimo',
    archivo: 'cep/css/style.css',
    de: '@media (max-width: 380px) {\n  .mic-refine-txt { display: none; }\n}',
    a:  '@media (max-width: 0px) {\n  .mic-refine-txt { display: none; }\n}',
  },
  {
    nombre: 'la palabra: el corte se pasa del ancho con el que abre el panel',
    archivo: 'cep/css/style.css',
    de: '@media (max-width: 380px) {\n  .mic-refine-txt { display: none; }\n}',
    a:  '@media (max-width: 470px) {\n  .mic-refine-txt { display: none; }\n}',
  },
  {
    nombre: 'la palabra: el repintado escribe sobre el botón y se la lleva puesta',
    archivo: 'cep/js/dictado.js',
    de: '      refIco.textContent = p.texto;',
    a:  '      refBtn.textContent = p.texto;',
  },
  {
    nombre: 'la palabra: no se cuelga del botón y el ✨ vuelve a no nombrar nada',
    archivo: 'cep/js/dictado.js',
    de: '    refBtn.appendChild(refIco);\n    refBtn.appendChild(refTxt);',
    a:  '    refBtn.appendChild(refIco);',
  },

  // ── Las referencias de los dos niveles generales ─────────────────────
  //
  // Las dos primeras son las que este cambio existe para evitar, y son las dos
  // que ya costaron caro en esta familia: el ALCANCE que se va de su nivel y la
  // migración que PISA lo que ya estaba. Ninguna hace fallar nada a la vista —
  // en la primera el recurso sale bien y el que sale distinto es el de otra
  // clase; en la segunda no sale nada distinto: falta trabajo del compañero.
  {
    // El bug de alcance que la 1.5.1 acaba de matar en los prompts, con otra
    // ropa: las del CURSO guardadas adentro de la carpeta de una secuencia. El
    // manual de marca deja de valer para el resto del curso y nadie se entera
    // hasta ver los otros videos.
    nombre: 'las referencias del curso se guardan por secuencia',
    archivo: 'bridge/store/references.js',
    de: "  const scope = body.scope === 'sequence' ? 'sequence' : 'course';\n" +
        '  if (scope === \'sequence\' && !body.sequenceName) return \'\';\n' +
        "  return referencesDirPath(body.projectPath, scope === 'sequence' ? body.sequenceName : '');",
    a: '  return referencesDirPath(body.projectPath, body.sequenceName || \'\');',
  },
  {
    // La otra mitad del mismo bug, del lado del panel: la caché del curso
    // guardada contra proyecto::secuencia. Abrir otra clase deja de ver las del
    // curso, que es exactamente lo que el bloque promete que no pasa.
    nombre: 'la caché del curso se guarda por secuencia, no por proyecto',
    archivo: 'cep/js/refs.js',
    de: '    var pKey = String(projectPath || "");\n    var sKey = claveDe(projectPath, sequenceName);',
    a:  '    var pKey = claveDe(projectPath, sequenceName);\n    var sKey = claveDe(projectPath, sequenceName);',
  },
  {
    // LA regresión de la migración: lo que esta máquina tenía se sube igual,
    // encima de lo que ya estaba en el proyecto. Del otro lado hay trabajo del
    // compañero, y desaparece sin que nada falle.
    nombre: 'la migración pisa las referencias que ya estaban en el proyecto',
    archivo: 'cep/js/refs.js',
    de: '      if (!st.sequence.length) {',
    a:  '      if (true) {',
  },
  {
    // El mismo daño por la puerta de al lado: el cartel de conflicto REEMPLAZA
    // en vez de sumar, así que contestarlo tira lo del proyecto.
    nombre: 'resolver el conflicto reemplaza en vez de sumar',
    archivo: 'cep/js/refs.js',
    de: '      var scope = choice === "course" ? "course" : "sequence";\n' +
        '      return subir(projectPath, sequenceName, scope, locales).then(function () {',
    a: '      var scope = choice === "course" ? "course" : "sequence";\n' +
       '      var previas = estado(projectPath, sequenceName)[scope === "course" ? "course" : "sequence"];\n' +
       '      return previas.reduce(function (c) { return c.then(function () {\n' +
       '        return HPEngine.call("removeReference", { projectPath: projectPath, sequenceName: sequenceName, scope: scope, index: 0 });\n' +
       '      }); }, Promise.resolve()).then(function () { return load(projectPath, sequenceName); })\n' +
       '      .then(function () { return subir(projectPath, sequenceName, scope, locales); }).then(function () {',
  },
  {
    // Vaciar el localStorage ANTES de que el proyecto confirme. Si la escritura
    // falla —disco desmontado, permisos— las referencias no están en ningún
    // lado. Es la misma forma de perder trabajo que el bug del prompt.
    nombre: 'la migración borra lo local antes de que el proyecto confirme',
    archivo: 'cep/js/refs.js',
    de: '        return subir(projectPath, sequenceName, "sequence", locales).then(function (nuevo) {\n' +
        '          borrarLocales(projectPath, sequenceName);',
    a: '        borrarLocales(projectPath, sequenceName);\n' +
       '        return subir(projectPath, sequenceName, "sequence", locales).then(function (nuevo) {',
  },
  {
    // Migrar desde la LECTURA: encolar una corrección de un corte que el editor
    // no tiene adelante le subiría al proyecto —para los dos editores— material
    // que estaba en una sola máquina, desde un camino que nadie mira.
    nombre: 'la cola migra al leer, y sube al proyecto lo de esta máquina',
    archivo: 'cep/js/queue.js',
    de: '    var p = HPRefs.load(job.projectPath, seq).catch(function () {}).then(function () {',
    a:  '    var p = HPRefs.migrate(job.projectPath, seq).catch(function () {}).then(function () {',
  },
  {
    // Rehidratar VACÍA en vez de completar: un fallo de lectura del proyecto
    // deja al job sin las referencias que ya traía. Un recurso generado sin la
    // marca no falla, sale distinto, y se descubre viendo el video.
    nombre: 'un fallo de lectura vacía las referencias que el job traía',
    archivo: 'cep/js/queue.js',
    de: '      var hayRefs = refsSt.loaded || gen.images.length || gen.docs.length;',
    a:  '      var hayRefs = true;',
  },
  {
    // Las de la clase salen de la secuencia ABIERTA y no de la de origen: una
    // corrección de otro corte se rediseña sin las referencias que hicieron
    // bueno al original, y con las de una clase que no es la suya.
    nombre: 'una corrección de otro corte lee las referencias de la clase abierta',
    archivo: 'cep/js/queue.js',
    de: '      var gen = HPRefs.forModel(job.projectPath, job.storeSeqName || job.seqName);',
    a:  '      var gen = HPRefs.forModel(job.projectPath, job.seqName);',
  },
  {
    // Quitar una referencia borra el renglón del manifiesto y deja el archivo:
    // en la próxima lectura se adopta de vuelta y la referencia que el editor
    // sacó vuelve sola.
    nombre: 'quitar una referencia deja el archivo y vuelve sola',
    archivo: 'bridge/store/references.js',
    de: "      try { fs.unlinkSync(fuera.file); } catch { /* ya no estaba */ }",
    a:  '      void fuera;',
  },
  {
    // Un archivo que el manifiesto nombra y no está se saltea: el panel dibuja
    // una lista más corta sin explicación y el modelo diseña sin esa referencia.
    // Es el proyecto en un disco externo desmontado.
    nombre: 'una referencia que falta se saltea en vez de reportarse',
    archivo: 'bridge/store/references.js',
    de: '    try { bytes = fs.statSync(abs).size; } catch { missing = true; }',
    a:  '    try { bytes = fs.statSync(abs).size; } catch { return; }',
  },
  {
    // El desempate de nombres desaparece: dos capturas del mismo día se llaman
    // igual y la segunda se come a la primera. El panel muestra dos miniaturas
    // y el disco tiene un archivo.
    nombre: 'dos referencias con el mismo nombre se pisan',
    archivo: 'bridge/store/references.js',
    de: '  while (fs.existsSync(path.join(dir, intento))) {',
    a:  '  while (false) {',
  },
  {
    // Los cinco proveedores tratados igual: el PDF se le nombra también a los
    // tres que hablan por HTTP y no tienen disco. El editor adjunta el manual de
    // marca, el modelo compone sin haberlo visto, y nada avisa.
    nombre: 'el PDF se le manda también a los proveedores que no abren archivos',
    archivo: 'bridge/providers/index.js',
    de: "const LEEN_ARCHIVOS = ['claude-cli', 'cursor-cli'];",
    a:  "const LEEN_ARCHIVOS = ['claude-cli', 'cursor-cli', 'claude-api', 'openai-compat', 'ollama'];",
  },
  {
    // A cursor-agent se le nombra la ruta del proyecto, que le queda AFUERA de
    // su --workspace: el PDF aparece en el pedido y fuera de su alcance, y
    // compone igual.
    nombre: 'a cursor-agent el documento no se le copia adentro del workspace',
    archivo: 'bridge/providers/cursor-cli.js',
    de: '      docPaths.push(destino);',
    a:  '      docPaths.push(String(src));',
  },

  // ── Que no se genere en silencio sin el material sin migrar ──────────
  //
  // La primera es LA regresión: la generación sale, se ve presentable y no tiene
  // la marca. No falla nada, no hay ningún renglón, y es la primera generación
  // después de actualizar —justo la que nadie mira con desconfianza. Las otras
  // son las formas de perder el aviso de a poco: mirar la clase equivocada, no
  // contar lo que quedó esperando una decisión, o frenar para siempre.
  {
    // El chequeo dice que sí sin mirar nada: se vuelve al defecto entero.
    nombre: 'se genera igual con material sin migrar, y en silencio',
    archivo: 'cep/js/main.js',
    de: '    var st = HPRefs.unmigrated(projectPath, seqName);\n    if (!st.total) return true;',
    a:  '    var st = HPRefs.unmigrated(projectPath, seqName);\n    if (true) return true;',
  },
  {
    // El mismo daño un escalón más arriba: el chequeo existe y nadie lo llama.
    nombre: 'el chequeo previo no le pregunta por las referencias',
    archivo: 'cep/js/main.js',
    de: '    var refs = refsListasPara(job, dryRun);',
    a:  '    var refs = true;',
  },
  {
    // Lo que la migración APARTÓ no se cuenta: el conflicto es justo el caso que
    // no se resuelve solo esperando, y es el que quedaría pasando de largo.
    nombre: 'el material que espera una decisión no cuenta como pendiente',
    archivo: 'cep/js/refs.js',
    de: '        total: locales + apartadas,',
    a:  '        total: locales,',
  },
  {
    // La clase equivocada: se mira la que el editor tiene abierta y no la de
    // donde sale el material. Una corrección de otro corte pasa en silencio, que
    // es el pedido más caro (la clase ya salió).
    nombre: 'el chequeo mira la clase abierta y no la de origen del material',
    archivo: 'cep/js/main.js',
    de: '    var seqName = (job && (job.storeSeqName || job.seqName)) || currentSequenceName;\n' +
        '    var projectPath = (job && job.projectPath) || currentProjectPath;\n' +
        '    var st = HPRefs.unmigrated(projectPath, seqName);',
    a: '    var seqName = (job && job.seqName) || currentSequenceName;\n' +
       '    var projectPath = (job && job.projectPath) || currentProjectPath;\n' +
       '    var st = HPRefs.unmigrated(projectPath, seqName);',
  },
  {
    // Esperar deja de servir: la migración que está EN VUELO no se espera y se
    // frena igual. El día de la actualización todo el mundo ve un cartel por
    // algo que se resolvía solo, y aprende a apretar Iniciar dos veces.
    nombre: 'la migración en vuelo no se espera: se frena igual',
    archivo: 'cep/js/main.js',
    de: '    if (st.migrating && !yaEspere) {',
    a:  '    if (false) {',
  },
  {
    // Frena y no suelta: el editor que tiene el material en otra máquina no
    // puede generar nunca, y un cartel del que no se sale es un panel roto.
    nombre: 'insistir no alcanza: la cola queda frenada para siempre',
    archivo: 'cep/js/main.js',
    de: '    if (refsDecidido[clave] === "sin ellas") return true;',
    a:  '    if (false) return true;',
  },

  // ── El estimado: que cuente lo que DE VERDAD va a viajar ─────────────
  //
  // Las tres son la misma familia y ya se pagó tres veces: un fijo donde había
  // que mirar el contenido. Ninguna falla: el semáforo dice un número y la
  // factura dice otro, y el usuario pidió explícitamente que fuera preciso.
  {
    // El documento de texto se cobra por un fijo, sin mirar cuánto se pega en el
    // prompt. Con un .md de marca de 26.600 caracteres el semáforo decía 5.131 y
    // se mandaban 8.679: 41% corto, y siempre para el mismo lado.
    nombre: 'el estimado cobra el documento por un fijo y no por lo que se pega',
    archivo: 'bridge/engine.js',
    de: '      bloqueDeDocumentos(docs.textuales) +',
    a:  '      "" + (docs.textuales.length ? "x".repeat(6000) : "") +',
  },
  {
    // Se cobran las imágenes que el manifiesto nombra y el disco no tiene: el
    // semáforo dice tres y viajan dos, 2.064 tokens de más. Y miente sobre lo
    // mismo que el WARN de al lado ya está avisando: que ese archivo no está.
    nombre: 'el estimado cobra las imágenes que el disco no tiene',
    archivo: 'bridge/engine.js',
    de: '    const imagenes = stills.filter(imagenViaja);',
    a:  '    const imagenes = stills.slice();',
  },
  {
    // El PDF se cobra igual para los cinco proveedores, cuando solo dos pueden
    // abrirlo. Con Ollama se paga por un archivo que no viaja de ninguna forma.
    nombre: 'el estimado cobra el PDF igual para el proveedor que no lo puede abrir',
    archivo: 'bridge/engine.js',
    de: "    const docs = repartirDocumentos(resources, body.provider || loadConfig().provider);",
    a:  "    const docs = repartirDocumentos(resources, 'claude-cli');",
  },
  {
    // El bloque que nombra las imágenes a INCRUSTAR lo agrega prepareGeneration
    // después de armar el cuerpo, así que el estimado no lo veía: 710 caracteres
    // que el semáforo no contaba, ~177 tokens por marcador con assets.
    nombre: 'el estimado no ve el bloque de las imágenes a incrustar',
    archivo: 'bridge/engine.js',
    de: '    userPrompt += bloqueDeAssets(assetInfos) +',
    a:  '    userPrompt += "" +',
  },

  // ── La carpeta del proyecto: cuándo aparece ──────────────────────────
  //
  // Las tres son la misma decisión mirada desde sus tres lados, y las tres son
  // mudas. La primera es LA regresión que se acaba de arreglar: una lectura que
  // pide la carpeta creada, y entonces abrir un .prproj donde nunca se generó
  // nada deja una carpeta vacía que después viaja con el proyecto. La tercera es
  // el precio de arreglarla mal: sacarle la creación a la escritura que sí la
  // necesita rompe el PRIMER uso —y solo el primero, así que en la máquina donde
  // ya se generó una vez no se nota nunca—.
  {
    // Exactamente el bug del reporte: loadTranscript es de lo primero que el
    // panel pregunta al abrir una secuencia.
    nombre: 'una lectura vuelve a crear la carpeta: abrir el panel la deja hecha',
    archivo: 'bridge/engine.js',
    de: 'function transcriptCandidates(projectPath, sequenceName) {\n  const dir = outputDirPath(projectPath, sequenceName);',
    a:  'function transcriptCandidates(projectPath, sequenceName) {\n  const dir = ensureOutputDir(projectPath, sequenceName);',
  },
  {
    // La misma familia, por otra puerta: la vista de la cola mira si hay videos
    // viejos que limpiar, y mirar no puede dejar la carpeta hecha.
    nombre: 'preguntar si hay versiones viejas crea la carpeta de la secuencia',
    archivo: 'bridge/engine.js',
    de: '  const bySlug = groupMarkerVideos(outputDirPath(projectPath, sequenceName));',
    a:  '  const bySlug = groupMarkerVideos(ensureOutputDir(projectPath, sequenceName));',
  },
  {
    // El otro extremo: la escritura se queda sin la carpeta. Guardar el
    // transcript falla con un ENOENT en el proyecto donde todavía no hay nada,
    // que es justo la primera vez que se usa la herramienta.
    nombre: 'la escritura del transcript se queda sin la carpeta y el primer uso falla',
    archivo: 'bridge/engine.js',
    de: '  return path.join(ensureOutputDir(projectPath, sequenceName), TRANSCRIPT_FILE);',
    a:  '  return path.join(outputDirPath(projectPath, sequenceName), TRANSCRIPT_FILE);',
  },
];

// Solo los tests de esta parte: si corriera la suite entera, cualquier falla
// ajena haría parecer que la mutación fue atrapada.
const SUITES = ['render-no-imposible', 'render-perfil-medido', 'composicion-raiz',
  'rescate-composicion', 'contador-uso', 'colocar-secuencia-no-encontrada',
  'marcadores-frameio', 'cola-mirar-y-rehacer', 'correcciones-encolar',
  'correcciones-listar',
  'claude-session', 'panel-cartel-sesion', 'panel-cartel-cursor',
  'provider-salud', 'imagen-de-referencia',
  'selector-pensamiento', 'ventana-de-contexto', 'prompt-general-proyecto',
  'estimado-tokens', 'cola-feedback-otra-secuencia', 'referencias-proyecto',
  'panel-cartel-preparar-motor', 'panel-encabezado-microfono', 'panel-botones-flex',
  'panel-caja-feedback',
  'dictado-motor', 'dictado-refinar', 'dictado-panel',
  'dictado-microfono', 'dictado-microfono-panel', 'dictado-recarga',
  'carpeta-solo-cuando-se-usa'];

function correrSuite() {
  const guion = "const {runAll,group}=require('./test/harness');" +
    SUITES.map(function (s) { return "group('" + s + "');require('./test/" + s + ".test.js');"; }).join('') +
    'runAll();';
  try {
    const out = execFileSync('node', ['-e', guion], { cwd: raiz, encoding: 'utf8', stdio: 'pipe' });
    const m = out.match(/^Fallaron: (.+)$/m);
    return m ? m[1] : null; // runAll no corta el proceso: hay que mirar la salida
  } catch (e) {
    const salida = String(e.stdout || '') + String(e.stderr || '');
    const m = salida.match(/^Fallaron: (.+)$/m);
    return m ? m[1] : '(falló sin decir cuál)';
  }
}

// Un filtro por nombre para cuando se toca UNA parte: correr las cuarenta y
// pico para ver dos es media hora de espera.
//   node test/manual/mutaciones-render.js sesión
const filtro = String(process.argv[2] || '').toLowerCase();
const elegidas = filtro
  ? MUTACIONES.filter((m) => m.nombre.toLowerCase().indexOf(filtro) !== -1)
  : MUTACIONES;

let sobrevivientes = 0;
for (const mut of elegidas) {
  const p = path.join(raiz, mut.archivo);
  const original = fs.readFileSync(p, 'utf8');
  if (original.indexOf(mut.de) === -1) {
    console.log('  ??   ' + mut.nombre + '  → el código cambió, esta mutación ya no aplica');
    continue;
  }
  fs.writeFileSync(p, original.replace(mut.de, mut.a), 'utf8');
  let atrapada;
  try {
    atrapada = correrSuite();
  } finally {
    fs.writeFileSync(p, original, 'utf8');
  }
  if (atrapada) {
    console.log('  ok   ' + mut.nombre + '\n         la atrapa: ' + atrapada);
  } else {
    sobrevivientes++;
    console.log('  SOBREVIVE  ' + mut.nombre + '  → nadie se dio cuenta');
  }
}

console.log('\n' + (elegidas.length - sobrevivientes) + '/' + elegidas.length + ' mutaciones atrapadas');
process.exitCode = sobrevivientes ? 1 : 0;
