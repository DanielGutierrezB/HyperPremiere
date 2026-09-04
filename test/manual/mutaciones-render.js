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
    de: '      if (!t) {\n        deps.setOutput("Escribí qué ajustar para refinar, o usá “Regenerar desde cero”.", true);\n        return;\n      }',
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
    de: '        delete j.payload.previousHtml;\n        delete j.payload.adjustment;\n        delete j.payload.stillsSend;\n        j.payload.mode = "regen";',
    a:  '        j.payload.mode = "regen";',
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
    de: '    if (p === "claude-cli" && currentSession === "no") { ok = false; warn = currentSessionWarn; }',
    a:  '    if (p === "claude-cli" && currentSession !== "si") { ok = false; warn = currentSessionWarn; }',
  },
  {
    nombre: 'sin token guardado el panel arranca dando por hecho que falta la sesión',
    archivo: 'cep/js/config-ui.js',
    de: '    currentSession = cfg.hasSession ? "si" : "?";',
    a:  '    currentSession = cfg.hasSession ? "si" : "no";',
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
  // ── El prompt general que no viajaba con el proyecto ───────────────
  // Las dos formas de romper esto no fallan: una deja al compañero generando
  // sin el estilo del curso (el bug original) y la otra le tira encima lo que
  // el editor había escrito. Ninguna de las dos rompe nada mientras pasa.
  {
    nombre: 'la base del prompt vuelve a guardarse por secuencia',
    archivo: 'bridge/store/project-fs.js',
    de: '    project: path.join(projectRootPath(projectPath), GENERAL_PROMPT_FILE),',
    a:  '    project: path.join(outputDirPath(projectPath, sequenceName), GENERAL_PROMPT_FILE),',
  },
  {
    nombre: 'el prompt de la secuencia se le SUMA a la base en vez de pisarla',
    archivo: 'bridge/store/project-fs.js',
    de: '      text: sequenceText || projectText,',
    a:  "      text: [projectText, sequenceText].filter(Boolean).join('\\n'),",
  },
  {
    nombre: 'preguntar por el prompt general deja creada la carpeta de la secuencia',
    archivo: 'bridge/store/project-fs.js',
    de: '      ? path.join(outputDirPath(projectPath, sequenceName), GENERAL_PROMPT_FILE)',
    a:  '      ? path.join(ensureOutputDir(projectPath, sequenceName), GENERAL_PROMPT_FILE)',
  },
  {
    nombre: 'volver a la base deja el archivo vacío diciendo que la clase tiene el suyo',
    archivo: 'bridge/store/project-fs.js',
    de: "        try { fs.unlinkSync(file); } catch { /* no estaba: ya está en la base */ }\n        return { ok: true, path: file, scope, removed: true };",
    a:  '        fs.mkdirSync(path.dirname(file), { recursive: true });\n        fs.writeFileSync(file, "", "utf8");\n        return { ok: true, path: file, scope, removed: true };',
  },
  {
    nombre: 'el log vuelve a decir solo "sí" y se calla de dónde salió',
    archivo: 'bridge/engine.js',
    de: "  if (source === 'project') return 'de la base del proyecto';",
    a:  "  if (source === 'project') return 'sí';",
  },
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
  // ── En qué archivo escribe el campo ──────────────────────────────
  // El destino de escritura salía de qué archivo existiera en el disco, y
  // vaciar el prompt de una secuencia borra el suyo: el tecleo siguiente
  // reescribía la base de todo el proyecto, que le llega a los demás editores.
  // Nada fallaba, el texto se guardaba — en el archivo equivocado.
  {
    nombre: 'el destino de escritura vuelve a deducirse de qué archivo hay en el disco',
    archivo: 'cep/js/general-prompt.js',
    de: '      scope: st.writeScope,',
    a:  '      scope: st.sequenceText ? "sequence" : "project",',
  },
  {
    nombre: 'vaciar el campo mueve el destino a la base del proyecto',
    archivo: 'cep/js/general-prompt.js',
    de: '        writeScope: previo.writeScope,',
    a:  '        writeScope: (scope === "sequence" && !w.removed) ? "sequence" : "project",',
  },
  {
    nombre: 'el campo muestra lo que viaja al modelo y no el archivo que edita',
    archivo: 'cep/js/general-prompt.js',
    de: '      fieldText: st.failed ? st.text : (propio ? st.sequenceText : st.projectText),',
    a:  '      fieldText: st.text,',
  },
  {
    nombre: 'leer el prompt general vuelve a migrar por su cuenta',
    archivo: 'cep/js/queue.js',
    de: '    return HPGeneral.load(job.projectPath, seq).then(function () {}).catch(function () {});',
    a:  '    return HPGeneral.migrate(job.projectPath, seq).then(function () {}).catch(function () {});',
  },
  {
    nombre: 'sin motor se da por hecho que no hay estilo (el bug original, otra vez)',
    archivo: 'cep/js/general-prompt.js',
    de: '      st.text = local;',
    a:  "      st.text = '';",
  },
  {
    nombre: 'el panel deja de avisar que la secuencia está pisando la base',
    archivo: 'cep/js/general-prompt.js',
    de: '      d.line = "Propio de esta secuencia · PISA la base del proyecto";',
    a:  '      d.line = "Prompt general";',
  },
  {
    nombre: 'la cola se queda con el prompt viejo pegado al job',
    archivo: 'cep/js/queue.js',
    de: '        if (g.loaded || g.text) {',
    a:  '        if (!job.payload.generalInstruction) {',
  },
  {
    nombre: 'un proyecto ilegible vacía el estilo con el que se iba a generar',
    archivo: 'cep/js/queue.js',
    de: '        if (g.loaded || g.text) {',
    a:  '        if (true) {',
  },
  {
    nombre: 'la cola no va a buscar el prompt general del proyecto antes de generar',
    archivo: 'cep/js/queue.js',
    de: '    Promise.all([ensureTranscript(job), ensureGeneralPrompt(job)]).then(function () { runModel(job); });',
    a:  '    ensureTranscript(job).then(function () { runModel(job); });',
  },
  // El cartel de "Preparar motor": las tres formas de que su botón vuelva a
  // aplastarse contra el borde del panel. Es un desborde de layout, así que lo
  // que se rompe acá es la regla de CSS; medirlo se hace con la maqueta
  // (test/manual/panel-demo), que el DOM de mentira no calcula cajas.
  {
    nombre: 'el botón de "Preparar motor" vuelve a encogerse hasta el padding',
    archivo: 'cep/css/style.css',
    de: '.engine-prep .ep-row > button { flex: 0 0 auto; }',
    a:  '.engine-prep .ep-row > button { flex: 1 1 auto; }',
  },
  {
    nombre: 'el blindaje del botón se pone donde el global se lo lleva por delante',
    archivo: 'cep/css/style.css',
    de: '.engine-prep .ep-row > button { flex: 0 0 auto; }',
    a:  '.engine-prep .ep-row > div > button { flex: 0 0 auto; }',
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
    archivo: 'cep/js/queue-view.js',
    de: 'if (typeof HPDictado === "undefined" || !HPDictado || typeof HPDictado.attachMic !== "function") return null;',
    a:  'if (!HPDictado || typeof HPDictado.attachMic !== "function") return null;',
  },
  {
    nombre: 'un attachMic que revienta por dentro vuelve a tumbar el campo',
    archivo: 'cep/js/corrections.js',
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
    de: '  dictadoRefinar.olvidarRefinador();\n  return maskConfig(loadConfig());',
    a:  '  return maskConfig(loadConfig());',
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
    nombre: 'encabezado: se saca el blindaje del contenedor y vuelve a mandar el `button { flex: 1 }`',
    archivo: 'cep/css/style.css',
    de: '.header-tools > * { flex: none; }',
    a:  '.header-tools > * { min-width: 0; }',
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
];

// Solo los tests de esta parte: si corriera la suite entera, cualquier falla
// ajena haría parecer que la mutación fue atrapada.
const SUITES = ['render-no-imposible', 'render-perfil-medido', 'composicion-raiz',
  'rescate-composicion', 'contador-uso', 'colocar-secuencia-no-encontrada',
  'marcadores-frameio', 'cola-mirar-y-rehacer', 'correcciones-encolar',
  'claude-session', 'panel-cartel-sesion', 'imagen-de-referencia',
  'selector-pensamiento', 'ventana-de-contexto', 'prompt-general-proyecto',
  'panel-cartel-preparar-motor', 'panel-encabezado-microfono',
  'dictado-motor', 'dictado-refinar', 'dictado-panel',
  'dictado-microfono', 'dictado-microfono-panel', 'dictado-recarga'];

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
