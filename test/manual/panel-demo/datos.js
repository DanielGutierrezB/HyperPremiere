/**
 * datos.js — TODO lo falso del panel de demostración, en un solo archivo.
 *
 * Esto NO viaja al ZXP ni lo ve un editor: vive en test/manual/ y el firmador
 * solo empaqueta cep/ + bridge/ (ver scripts/sign-zxp.js). Es una maqueta para
 * mirar el diseño del panel en un navegador, sin Premiere.
 *
 * Editá de acá para abajo: nombres, marcadores, instrucciones, la cola, las
 * correcciones. Nada de esto tiene lógica; la lógica está en doble.js.
 *
 * Escenarios (se eligen por la URL, sin tocar este archivo):
 *   ?e=vacio           proyecto recién abierto: sin marcadores, sin transcript, cola vacía
 *   ?e=motor           el motor Node no cargó (el panel en rojo, "Preparar motor")
 *   ?e=whisper         falta el Whisper local (cartel de instalar + badge)
 *   ?e=otra-secuencia  en Premiere hay OTRA secuencia activa (cartel amarillo)
 *   ?e=conflicto       el prompt general de esta máquina no coincide con el del proyecto
 *   ?e=whisper,otra-secuencia   se pueden combinar con coma
 */
(function (global) {
  "use strict";

  // Nombres largos a propósito: son los que obligan a truncar y los que hacen
  // trabajar a shortenMiddle() y distinguish(). Los dos cortes de la misma
  // clase se diferencian SOLO en el sufijo, que es el caso real.
  var SEQ_ABIERTA = "12_MKA_Automatizaciones_con_IA_ARMADO_FINAL_105875_02";
  var SEQ_ORIGEN = "12_MKA_Automatizaciones_con_IA_ARMADO_FINAL_105875";
  var SEQ_OTRA = "13_MKA_Metricas_que_importan_ARMADO_FINAL_105903";
  var PROYECTO = "/Volumes/Editorial 04/Cursos 2026/Marketing Automatizado con IA/MKA_Modulo_03_ENTREGA.prproj";
  var CARPETA = "/Volumes/Editorial 04/Cursos 2026/Marketing Automatizado con IA/HyperPremiere";

  global.HPDemoDatos = {

    // ── Proyecto y secuencia ────────────────────────────────────────────
    proyectoPath: PROYECTO,
    carpetaSalida: CARPETA,
    secuenciaAbierta: SEQ_ABIERTA,
    secuenciaOrigen: SEQ_ORIGEN,
    secuenciaOtra: SEQ_OTRA,
    // Qué secuencia dice Premiere que está al frente (con ?e=otra-secuencia se
    // cambia por SEQ_OTRA y aparece el cartel de "estás trabajando en otra").
    secuenciaEnPremiere: SEQ_ABIERTA,
    duracionSecuencia: 3418.4,

    version: "1.4.47",

    // ── Contexto de la clase ────────────────────────────────────────────
    objetivo:
      "Que el estudiante pueda armar su primera automatización de punta a punta: " +
      "reconocer los tres componentes (disparador, condición, acción), elegir la " +
      "herramienta según el volumen que maneja, y dejar corriendo un flujo de " +
      "recuperación de carrito abandonado con dos correos y una espera de 24 h.",

    // El "Prompt general" ahora vive al lado del .prproj (una base del proyecto
    // y, si una clase la necesita, uno propio que la pisa).
    promptGeneral: {
      proyecto:
        "Marca ACADEMIA NOVA. Tipografía: Söhne para títulos, Inter para cuerpo. " +
        "Paleta: fondo carbón #12161d, acento cian #35e0d6, texto hueso #efeadf; " +
        "el naranja queda reservado para alertas y no se usa de decoración.\n" +
        "Todo entra por la DERECHA del cuadro: el profe está siempre a la izquierda " +
        "y de la mitad para abajo. Nunca tapar su cara ni el logo del canal (esquina " +
        "inferior derecha, 180×60 px).\n" +
        "Menos es más: máximo 7 palabras por pantalla, un solo elemento en movimiento " +
        "a la vez, y que todo respire 0,4 s antes de salir. Nada de degradados, nada " +
        "de sombras largas, nada de emojis.",
      // El propio de la secuencia abierta, que PISA la base. Vacío = esta clase
      // usa la base; llenalo para ver el panel con la secuencia pisándola. El
      // botón "Usar uno propio para esta secuencia" también lo llena solo.
      secuencia: "",
      // Con ?e=conflicto, este texto aparece como "lo que tenías en esta máquina".
      pendienteLocal:
        "Marca ACADEMIA NOVA. Títulos en Söhne, cuerpo en Inter. Acento cian. " +
        "Todo entra por la derecha. OJO: en este módulo el logo va arriba a la " +
        "izquierda, no abajo — lo cambiaron en la entrega de febrero."
    },

    // ── Transcript de la secuencia ──────────────────────────────────────
    // Fragmentos cortos con los tiempos donde caen los marcadores, para que
    // cada tarjeta tenga su "Ver transcript del marcador" con texto de verdad.
    transcript: [
      { start: 8.2, end: 14.8, text: "Bueno, arrancamos con la clase doce del módulo tres. Hoy vamos a armar la primera automatización completa." },
      { start: 14.8, end: 22.1, text: "Y digo completa porque hasta ahora vimos las piezas sueltas, pero nunca las conectamos entre sí de punta a punta." },
      { start: 218.4, end: 226.0, text: "Toda automatización, no importa la herramienta que uses, tiene los mismos tres componentes." },
      { start: 226.0, end: 234.5, text: "El disparador, que es lo que la enciende. La condición, que decide si sigue o se corta. Y la acción, que es lo que hace." },
      { start: 234.5, end: 241.2, text: "Si te acordás de estos tres, el resto es leer la documentación de la herramienta de turno." },
      { start: 441.0, end: 449.6, text: "Y acá va el número que a mí me voló la cabeza cuando lo vi por primera vez." },
      { start: 449.6, end: 458.0, text: "El sesenta y ocho por ciento de los carritos de compra se abandonan. Sesenta y ocho. De cada diez personas que llenan el carrito, casi siete se van." },
      { start: 458.0, end: 466.4, text: "O sea que la plata más barata que vas a levantar en tu vida ya está adentro de tu tienda, esperando un mail." },
      { start: 770.5, end: 780.0, text: "Miren el embudo entero, porque es lo que vamos a automatizar hoy y conviene tenerlo en la cabeza." },
      { start: 780.0, end: 792.3, text: "Visita, carrito, checkout, compra. En cada escalón se cae gente, y en cada escalón hay una automatización que la recupera." },
      { start: 1258.0, end: 1268.4, text: "Este es el antes y el después de la tienda de Male, que hizo el curso el año pasado y me dejó usar los números." },
      { start: 1268.4, end: 1276.9, text: "Sin automatización recuperaba el cuatro por ciento de los carritos. Con los dos correos y la espera de veinticuatro horas, el diecinueve." },
      { start: 2050.2, end: 2062.8, text: "Antes de cerrar, la lista de las cosas que tenés que revisar sí o sí antes de prender una automatización en producción." },
      { start: 2062.8, end: 2074.1, text: "Porque un flujo mal armado no falla en silencio: le manda catorce correos a la misma persona en una tarde y te quema la lista." },
      { start: 2492.0, end: 2500.6, text: "Y eso es todo por hoy. En la clase que viene conectamos esto con el CRM y armamos el reporte." },
      { start: 2500.6, end: 2508.0, text: "Dejame en los comentarios qué flujo armaste, que los reviso uno por uno." }
    ],

    // ── Marcadores de la secuencia ──────────────────────────────────────
    // `numero` es el que la herramienta le asignó por su guid (no la posición):
    // por eso hay huecos, y está bien — el 4, el 6 y el 7 se borraron.
    // `imagenes`: se dibujan al vuelo como PNG (ver doble.js); `usar: true` es
    // la etiqueta "✓ usar" (se incrusta), sin ella es "referencia".
    marcadores: [
      {
        numero: 1, guid: "mk-8f21a0", name: "Intro / placa de título", start: 12.4, duration: 6.5,
        instruccion:
          "Placa de entrada con el título de la clase: “Tu primera automatización” y abajo, chiquito, " +
          "“Módulo 3 · Clase 12”. Que entre desde la derecha y quede fija hasta el final. Sin fondo, " +
          "va sobre mi cara así que dejá libre la mitad izquierda.",
        generado: true, background: false,
        versiones: [1, 2, 3], modelo: "claude-sonnet-5",
        timings: { modelMs: 185000, renderMs: 67000, totalMs: 252000, version: 3 },
        imagenes: [
          { etiqueta: "logo-nova.png", color: "#35e0d6", fondo: "#12161d", usar: true },
          { etiqueta: "frame-00-12.png", color: "#8b97a8", fondo: "#1f2530" }
        ]
      },
      {
        numero: 2, guid: "mk-31c7de", name: "Los 3 componentes", start: 221.8, duration: 11.2,
        instruccion:
          "Tres bloques que aparecen de a uno mientras los voy nombrando: DISPARADOR, CONDICIÓN, ACCIÓN. " +
          "Cada uno con una línea de descripción de cuatro o cinco palabras. Alineados a la derecha, " +
          "apilados, que no me tapen. El tercero que quede resaltado en cian porque es el que sigo explicando.",
        generado: false, background: false,
        versiones: [], modelo: "",
        imagenes: [
          { etiqueta: "boceto-3-bloques.jpg", color: "#efeadf", fondo: "#2a2119" }
        ]
      },
      {
        numero: 3, guid: "mk-a4b902", name: "Dato 68%", start: 444.0, duration: 8.0,
        instruccion:
          "El 68% enorme, contando hacia arriba desde cero en el primer segundo y medio. " +
          "Abajo chiquito: “de los carritos de compra se abandonan” y la fuente “Baymard Institute, 2025”. " +
          "Con el mismo diseño del Marcador 2, que quedó perfecto.",
        generado: true, background: false,
        versiones: [1, 2], modelo: "claude-sonnet-5",
        timings: { modelMs: 142000, renderMs: 51000, totalMs: 198000, version: 2 },
        imagenes: []
      },
      {
        numero: 5, guid: "mk-77e1bb", name: "Diagrama del embudo", start: 774.5, duration: 14.0,
        instruccion:
          "El embudo completo en cuatro escalones: Visita → Carrito → Checkout → Compra, con el " +
          "porcentaje que sobrevive en cada uno (100 / 32 / 21 / 14). Que se dibuje escalón por escalón " +
          "de arriba hacia abajo. Este va CON fondo porque acá estoy en cámara chica, abajo a la izquierda.",
        generado: true, background: true,
        versiones: [1], modelo: "claude-opus-5",
        timings: { modelMs: 264000, renderMs: 118000, totalMs: 402000, version: 1 },
        imagenes: [
          { etiqueta: "embudo-referencia.png", color: "#35e0d6", fondo: "#0e1116" },
          { etiqueta: "paleta-modulo-3.png", color: "#fbbf24", fondo: "#191b20" },
          { etiqueta: "captura-programa-12-58.png", color: "#8b97a8", fondo: "#242a34" }
        ]
      },
      {
        numero: 8, guid: "mk-d0934c", name: "Antes / después de Male", start: 1261.0, duration: 10.5,
        instruccion:
          "Comparativa de dos columnas: SIN AUTOMATIZAR 4% recuperado / CON AUTOMATIZACIÓN 19% recuperado. " +
          "Que la segunda barra crezca hasta pasar a la primera. Aclarar abajo “tienda real, 6 meses, " +
          "con permiso de la alumna”.",
        generado: false, background: false,
        versiones: [], modelo: "",
        imagenes: [
          { etiqueta: "planilla-male.png", color: "#0ae98d", fondo: "#12161d" }
        ]
      },
      {
        numero: 11, guid: "mk-5a6f18", name: "Checklist de cierre", start: 2054.0, duration: 12.0,
        instruccion:
          "Checklist de cinco puntos que se van tildando uno por uno: límite de envíos por día, " +
          "prueba con tu propio mail, condición de salida, horario permitido, y registro de errores. " +
          "Tipografía chica, alineado a la derecha, sin iconos raros.",
        generado: false, background: false,
        versiones: [], modelo: "",
        imagenes: []
      },
      {
        numero: 12, guid: "mk-2e88a1", name: "Cierre / CTA", start: 2495.0, duration: 7.0,
        // A propósito sin instrucción: es el estado "todavía no está listo".
        instruccion: "",
        generado: false, background: false,
        versiones: [], modelo: "",
        imagenes: []
      }
    ],

    // Comentarios que volvieron de la revisión de Frame.io. NO son trabajo: el
    // panel los ignora y lo dice. El texto es el del caso real (el nombre es
    // quién comentó; la marca está al final del comentario).
    marcadoresFrameIo: [
      {
        name: "Cande", start: 146.0, duration: 0,
        comment: "Texto listado:\n- Abrir navegador\n- Descargar archivos\n- Correr el instalador\n\n" +
          "Frame.io Comment ID: bba94422-efc7-4389-afbd-23a4cb72f65a"
      },
      {
        name: "Candela", start: 204.0, duration: 0,
        comment: "Acá se corta muy seco, ¿le podés dejar medio segundo más de aire?\n\n" +
          "Frame.io Comment ID: 37029c8b-202a-4212-998a-60b349082ce6"
      },
      {
        name: "Juanma", start: 1502.0, duration: 0,
        comment: "El audio pega un salto de nivel en este punto.\n\n" +
          "Frame.io Comment ID: 9d1c40aa-51b0-4b1e-9f30-7c2a6e5b8811"
      }
    ],

    // Referencias que aplican a TODOS los marcadores (Prompt general).
    imagenesGenerales: [
      { etiqueta: "manual-de-marca-nova.png", color: "#35e0d6", fondo: "#12161d" },
      { etiqueta: "logo-canal-180x60.png", color: "#efeadf", fondo: "#0e1116", usar: true }
    ],
    recursosGenerales: [
      { name: "Guia_de_estilo_ACADEMIA_NOVA_v4.pdf", mediaType: "application/pdf" }
    ],

    // ── La cola ─────────────────────────────────────────────────────────
    // `estado` acepta: queued | modeling | running | done | waiting | error.
    // modeling/running se "inyectan" en vivo (queue.json no los guarda: al
    // reabrir el panel vuelven a "queued"), así que se ven con barra y reloj.
    cola: [
      {
        id: "j41", estado: "done", kind: "generate", marcador: 1, secuencia: SEQ_ABIERTA,
        etiqueta: "Marcador 1 · Intro / placa de título", start: 12.4, duracion: 6.5, version: 3,
        msg: "✓ Listo y colocado (v3) · 128.412↑ 6.104↓ · 4m 12s (IA 3m 05s · render 1m 07s)",
        modelMs: 185000, renderMs: 67000,
        uso: { inputTokens: 6, outputTokens: 6104, cacheReadTokens: 84015, cacheCreationTokens: 44391, totalInputTokens: 128412, costUsd: 1.34 },
        conFondo: false
      },
      {
        id: "j42", estado: "modeling", kind: "generate", marcador: 2, secuencia: SEQ_ABIERTA,
        etiqueta: "Marcador 2 · Los 3 componentes", start: 221.8, duracion: 11.2,
        pct: 34, corriendoDesdeSeg: 137,
        msg: "Diseñando la animación con claude-sonnet-5…",
        actividad: "razonando (4.240 tok) · …cómo apilar los tres bloques sin invadir la mitad izquierda",
        conFondo: false
      },
      {
        id: "j43", estado: "running", kind: "generate", marcador: 3, secuencia: SEQ_ABIERTA,
        etiqueta: "Marcador 3 · Dato 68%", start: 444.0, duracion: 8.0,
        pct: 71, corriendoDesdeSeg: 258, modelMs: 194000,
        msg: "Renderizando… 412 de 604 fotogramas",
        conFondo: false
      },
      {
        id: "j44", estado: "done", kind: "generate", marcador: 5, secuencia: SEQ_ABIERTA,
        etiqueta: "Marcador 5 · Diagrama del embudo", start: 774.5, duracion: 14.0, version: 1,
        msg: "⚠ Render OK pero NO lo coloqué (no se tocó tu timeline): no se encontró la secuencia " +
          "“12_MKA_Automatizaciones_con_IA_ARMADO_FINAL_105875_02” en el proyecto del frente " +
          "(leí 63 de 64 secuencias; 1 no se dejó leer). La más parecida: " +
          "“12_MKA_Automatizaciones_con_IA_ARMADO_FINAL_105875”.",
        sinColocar: true,
        movPath: CARPETA + "/12-mka-automatizaciones-con-ia-armado-final-105875-02/Marcador 5 v1 [claude-opus-5].mp4",
        modelMs: 264000, renderMs: 118000,
        uso: { inputTokens: 4, outputTokens: 9812, cacheReadTokens: 96140, cacheCreationTokens: 51002, totalInputTokens: 147146, costUsd: 2.08 },
        conFondo: true
      },
      {
        id: "j45", estado: "error", kind: "generate", marcador: 8, secuencia: SEQ_ABIERTA,
        etiqueta: "Marcador 8 · Antes / después de Male", start: 1261.0, duracion: 10.5,
        msg: "Error: la composición volvió sin el andamiaje que el motor de captura necesita: no declara " +
          "duración (data-duration) y no registra su timeline en window.__timelines. No la mando a " +
          "renderizar: saldría un video congelado. El problema NO está en el hardware. El HTML se guardó " +
          "igual (ya se pagó): mirálo con “Editar HTML” y renderizalo a mano.",
        etapaFallada: "model", conFondo: false
      },
      {
        id: "j46", estado: "waiting", kind: "feedback", marcador: 11, secuencia: SEQ_ABIERTA,
        etiqueta: "Marcador 11 · Checklist de cierre", start: 2054.0, duracion: 12.0,
        msg: "⏳ Sin tokens / límite alcanzado — esperá el reinicio y tocá ↻ Reactivar · " +
          "claude-cli: HTTP 429 · usage limit reached · resets at 6:00 PM (America/Bogota)",
        conFondo: false
      },
      {
        id: "j47", estado: "queued", kind: "generate", marcador: 12, secuencia: SEQ_ABIERTA,
        etiqueta: "Marcador 12 · Cierre / CTA", start: 2495.0, duracion: 7.0,
        msg: "En cola…", conFondo: false
      },
      {
        id: "j48", estado: "queued", kind: "feedback", marcador: 6, secuencia: SEQ_ABIERTA,
        correccion: true, secuenciaOrigen: SEQ_ORIGEN,
        etiqueta: "Marcador 6 (corrección)", start: 968.0, duracion: 9.0,
        msg: "En cola…", conFondo: false
      },
      {
        id: "j49", estado: "queued", kind: "generate", marcador: 2, secuencia: SEQ_OTRA,
        etiqueta: "Marcador 2 · Qué medir y qué ignorar", start: 305.0, duracion: 13.5,
        msg: "En cola…", conFondo: false
      },
      {
        id: "j50", estado: "queued", kind: "generate", marcador: 4, secuencia: SEQ_OTRA,
        etiqueta: "Marcador 4 · Tablero de KPIs", start: 918.0, duracion: 16.0,
        msg: "En cola…", conFondo: true
      }
    ],

    // ── Contador de uso de la sesión ────────────────────────────────────
    uso: {
      inputTokens: 1284,
      outputTokens: 2341682,
      cacheReadTokens: 13774220,
      cacheCreationTokens: 8091455,
      costUsd: 15.37,
      costGenerations: 12,
      costInputTokens: 1704310,
      generations: 164,
      rule: 2,
      legacyMix: false,
      // El mismo gasto, desagregado por proveedor. Es de donde sale el "una
      // generación con X gastó ≈ N" que dice ⚙, y va aparte del total porque
      // las dos puertas consumen distinto: los 128.412 de Cursor son los del
      // job j41 de acá abajo, y arrastran ~31,8k de contexto del propio agente
      // que Claude no paga. `regla: 2` es la marca de que esa entrada se contó
      // entera (con la caché); sin ella el bolsillo se descarta.
      porProveedor: {
        "claude-cli": { entrada: 9912240, salida: 1876500, generaciones: 108, regla: 2 },
        "cursor-cli": { entrada: 1540944, salida: 73248, generaciones: 12, regla: 2 }
      }
    },

    // Calibración del estimado de la cola (para que diga números y no "aprox.").
    calibracion: { modelJobs: 41, modelSec: 8610, renderCompSec: 512, renderSec: 2110 },

    // ── Pestaña Corrections ─────────────────────────────────────────────
    correcciones: {
      // Se lee del corte VIEJO y se coloca en el abierto: ese es el caso real
      // (la clase volvió re-cortada con sufijo _02) y el que hace trabajar al
      // recorte por diferencia de nombres.
      leidoDe: SEQ_ORIGEN,
      elegidoPorNosotros: true,
      recursos: [
        {
          slug: "Marcador 1", nombre: "Intro / placa de título", start: 12.4, duration: 6.5,
          ultima: 3, modelo: "claude-sonnet-5", versiones: [1, 2, 3], fuenteTramo: "ficha",
          encargo: "Placa de entrada con el título de la clase y abajo, chiquito, “Módulo 3 · Clase 12”. Sin fondo.",
          conFondo: false
        },
        {
          slug: "Marcador 3", nombre: "Dato 68%", start: 444.0, duration: 8.0,
          ultima: 4, modelo: "claude-opus-5", versiones: [1, 2, 3, 4], fuenteTramo: "ficha",
          encargo: "El 68% enorme contando hacia arriba, con la fuente Baymard 2025 abajo.",
          conFondo: false
        },
        {
          slug: "Marcador 5", nombre: "Diagrama del embudo", start: 774.5, duration: 14.0,
          ultima: 2, modelo: "claude-opus-5", versiones: [1, 2], fuenteTramo: "ficha",
          encargo: "El embudo en cuatro escalones con el porcentaje que sobrevive en cada uno. Con fondo.",
          conFondo: true
        },
        {
          slug: "Marcador 6", nombre: "Herramientas por volumen", start: 968.0, duration: 9.0,
          ultima: 1, modelo: "claude-sonnet-5", versiones: [1], fuenteTramo: "cola",
          encargo: "Tres logos con el rango de contactos de cada herramienta debajo.",
          conFondo: false
        },
        {
          slug: "Marcador 9", nombre: "Espera de 24 h", start: 1544.0, duration: 6.0,
          ultima: 2, modelo: "claude-sonnet-5", versiones: [1, 2], fuenteTramo: "html",
          encargo: "Un reloj que avanza 24 horas en dos segundos y se congela.",
          conFondo: false
        },
        {
          // Sin ficha: la fila pregunta el tramo una sola vez y lo deja anotado.
          slug: "Marcador 10", nombre: "", start: null, duration: 0,
          ultima: 1, modelo: "claude-sonnet-4-5", versiones: [1], fuenteTramo: "",
          encargo: "Cita de Male sobre el resultado del flujo.",
          conFondo: false
        }
      ],
      // De qué carpetas se puede leer (aparece el desplegable "Leer de").
      fuentes: [
        { seq: SEQ_ORIGEN, cantidad: 6 },
        { seq: SEQ_OTRA, cantidad: 2 }
      ]
    },

    // ── Configuración (⚙) ───────────────────────────────────────────────
    config: {
      provider: "claude-cli",
      model: "claude-sonnet-5",
      effort: "high",
      baseUrl: "",
      hasSession: true,
      concurrencia: 3,
      // El micrófono del dictado, por NOMBRE ('' = el del sistema). Con
      // ?e=mic-perdido se siembra uno que no está en la lista.
      microfono: ""
    },
    // Lo que ffmpeg lista en la máquina de la maqueta: los índices son los de
    // avfoundation (cambian al enchufar algo; por eso se guarda el nombre).
    microfonos: {
      dispositivos: [
        { indice: 0, nombre: "iPhone de Dani Microphone" },
        { indice: 1, nombre: "Auriculares de Dani (2)" },
        { indice: 2, nombre: "MacBook Pro Microphone" }
      ],
      porDefecto: "MacBook Pro Microphone",
      // La prueba de micrófono, en dBFS: sube y baja como alguien hablando de
      // a frases, con silencios entre medio. La compuerta está en −34.
      niveles: [-52, -48, -41, -30, -24, -21, -19, -22, -26, -33, -44, -50, -47, -29, -23, -20, -18, -21, -25, -31, -42, -49],
      veredicto: {
        estado: "ok",
        titulo: "Entra audio por «MacBook Pro Microphone» (índice 2) y pasa la compuerta del dictado.",
        detalle: "Promedio -27.8 dBFS, pico -18.0 dBFS; la compuerta está en -34.0 dBFS. Podés dictar."
      }
    },
    // El dictado por voz, simulado de punta a punta. (Ojo: `D.dictado`, sin
    // "Simulado", es otra cosa: los escenarios de la URL que fuerzan el ESTADO
    // del dictado —sin dictado, dictando— en `dictadoEstado`.)
    //
    // `parciales` es lo que va devolviendo
    // Whisper mientras se habla: cada uno REEMPLAZA al anterior entero, no se
    // agrega al final —el motor retranscribe el buffer completo en cada
    // refresco—, y por eso la frase se corrige sola a medida que crece. El
    // último es el dictado crudo, con sus muletillas; `refinado` es lo que
    // devuelve el modelo chico al soltar el botón.
    dictadoSimulado: {
      parciales: [
        "eh que el título",
        "eh que el título entre desde la izquierda",
        "eh que el título entre desde la izquierda con un fade de medio segundo",
        "eh que el título entre desde la izquierda con un fade de medio segundo y los keyframes",
        "eh que el título entre desde la izquierda con un fade de medio segundo y los keyframes tienen que ser suaves, o sea con easing",
        "eh que el título entre desde la izquierda con un fade de medio segundo y los keyframes tienen que ser suaves, o sea con easing, este… y que el logo quede abajo a la derecha todo el tiempo"
      ],
      refinado: "El título entra desde la izquierda con un fade de medio segundo y easing suave en los keyframes. El logo queda abajo a la derecha durante toda la animación.",
      refinador: "Claude Haiku (CLI de Claude)",
      msRefinado: 1400,
      // Lo que gasta un refinado de verdad: el manual del refinador son ~1.500
      // caracteres que se leen de caché en cada llamada, y ahí está la entrada.
      usage: {
        inputTokens: 180, outputTokens: 44, cacheReadTokens: 12000, cacheCreationTokens: 0,
        totalInputTokens: 12180, costUsd: 0.0004, provider: "claude-cli", model: "haiku"
      }
    },
    // `maxInputTokens` es la ventana que informa la API de Anthropic
    // (`max_input_tokens`), que el motor pasa tal cual. Acá viene puesta para
    // que la maqueta tenga la misma forma que el motor de verdad; el panel solo
    // le hace caso cuando se entra POR la API (proveedor claude-api, o el CLI
    // con una API key), no por suscripción.
    modelosClaude: [
      { id: "claude-opus-5", name: "Claude Opus 5", maxInputTokens: 1000000 },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", maxInputTokens: 1000000 },
      { id: "claude-fable-5", name: "Claude Fable 5", maxInputTokens: 1000000 },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", maxInputTokens: 1000000 },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", maxInputTokens: 200000 }
    ],
    sesionClaude: {
      estado: "con-sesion",
      // `metodo` es el authMethod que contesta `claude auth status`, y no es
      // decorativo: es lo que decide si el panel puede prometer el 1M. Con
      // "claude.ai" (suscripción) no puede, y el selector muestra el piso.
      metodo: "claude.ai",
      resumen: "✓ Sesión de Claude activa · entrás con tu cuenta de claude.ai",
      detalle: "claude 2.1.201 · /Users/dani/.local/bin/claude · authMethod: claude.ai"
    },
    diagnosticoClaude:
      "CLI de Claude en esta máquina\n" +
      "· Ejecutable: /Users/dani/.local/bin/claude (encontrado en el PATH)\n" +
      "· Versión: 2.1.201\n" +
      "· Sistema: darwin arm64 · macOS 26.1\n" +
      "· Sesión: claude.ai (login interactivo, sin token en el panel)\n" +
      "· Se buscó además en: /opt/homebrew/bin, /usr/local/bin, ~/.claude/local, ~/.npm-global/bin\n" +
      "Si algo falla igual: corré `claude setup-token` en tu terminal y pegá el token acá abajo.",

    // ── Whisper ─────────────────────────────────────────────────────────
    whisper: {
      ok: true, available: true, fast: true, managed: true,
      tool: "mlx-whisper", model: "large-v3",
      path: "/Users/dani/.hyperpremiere/whisper/bin/mlx_whisper"
    },

    // Carriles de render que perfiló el motor en esta máquina.
    carrilesDeRender: 2,

    // HTML que devuelve "Editar HTML" / "Ver y editar el HTML" (recortado, pero
    // con la forma real de una composición HyperFrames).
    htmlDeEjemplo: [
      '<!DOCTYPE html>',
      '<html lang="es">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"><\/script>',
      '  <style>',
      '    body { margin:0; background:transparent; font-family:"Söhne","Inter",sans-serif; }',
      '    #stage { width:1920px; height:1080px; position:relative; overflow:hidden; }',
      '    .rail { position:absolute; right:96px; top:210px; width:760px; }',
      '    .bloque { opacity:0; transform:translateX(48px);',
      '      border-left:2px solid #35e0d6; padding:18px 0 18px 26px; margin-bottom:22px; }',
      '    .kicker { font-size:22px; letter-spacing:.18em; color:#8b97a8; text-transform:uppercase; }',
      '    .titulo { font-size:58px; color:#efeadf; line-height:1.05; margin-top:6px; }',
      '    .bajada { font-size:26px; color:#8b97a8; margin-top:10px; }',
      '  </style>',
      '</head>',
      '<body>',
      '  <div id="stage" data-composition-id="marcador-2" data-duration="11.2">',
      '    <div class="rail">',
      '      <div class="bloque" data-i="1">',
      '        <div class="kicker">01</div>',
      '        <div class="titulo">Disparador</div>',
      '        <div class="bajada">Lo que enciende el flujo</div>',
      '      </div>',
      '      <div class="bloque" data-i="2">',
      '        <div class="kicker">02</div>',
      '        <div class="titulo">Condición</div>',
      '        <div class="bajada">Decide si sigue o se corta</div>',
      '      </div>',
      '      <div class="bloque" data-i="3">',
      '        <div class="kicker">03</div>',
      '        <div class="titulo">Acción</div>',
      '        <div class="bajada">Lo que finalmente hace</div>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <script>',
      '    const tl = gsap.timeline({ paused: true });',
      '    gsap.utils.toArray(".bloque").forEach((el, i) => {',
      '      tl.to(el, { opacity: 1, x: 0, duration: .55, ease: "power3.out" }, 0.6 + i * 1.9);',
      '    });',
      '    tl.to(".bloque[data-i=\'3\']", { borderLeftColor: "#35e0d6", color: "#35e0d6", duration: .4 }, 7.4);',
      '    tl.to(".rail", { opacity: 0, duration: .5 }, 10.6);',
      '    window.__timelines = window.__timelines || {};',
      '    window.__timelines["marcador-2"] = tl;',
      '  <\/script>',
      '</body>',
      '</html>'
    ].join("\n")
  };
})(typeof window !== "undefined" ? window : this);
