# HyperPremiere

Panel **CEP para Adobe Premiere Pro 2026** que genera gráficos animados por IA
(motor **HyperFrames** → HTML + GSAP) **sobre los marcadores** de tu secuencia y los
**coloca automáticamente en el timeline**, en la secuencia correcta.

Salida por defecto en **ProRes 4444 con alpha** (`.mov`, overlay transparente), o
en **MP4 H.264 1080p opaco** por marcador cuando activás "Con fondo".

Modelo configurable: **Claude (CLI de suscripción o API key)**, cualquier **API
compatible con OpenAI**, o **Ollama local**. Multiplataforma: **macOS (Apple Silicon)
y Windows**. Todo corre **dentro del panel** (motor Node in-process, sin servidor externo).

Versión actual: ver `version.json` (el label también se muestra en el header del panel).
ZXP firmado: `dist/HyperPremiere.zxp`.

## Cómo funciona (flujo)

1. Ponés **marcadores nativos con duración** en tu secuencia donde querés un recurso y
   pulsás **Cargar marcadores** → una **tarjeta** por marcador.
2. Le das **contexto**: el **Objetivo de la clase** (o cargás el transcript JSON y lo
   deriva solo) y un **Prompt general** con estilo/marca/tipografía/colores que aplican
   a TODOS los marcadores (no lo repetís en cada uno).
3. Por marcador escribís una **instrucción**, podés **capturar el frame del programa**
   (📸) y arrastrar **imágenes / PDFs / referencias** (drag & drop).
4. La IA diseña una animación **HyperFrames**, se **renderiza** y se **coloca sobre el
   marcador**, importada a un bin **`HyperPremiere > <secuencia>`** dentro del proyecto.
   Todo pasa por una **cola** que procesa de a uno.
5. Iterás con **Generar / Refinar / Regenerar**, o editás el **HTML a mano** (con
   resaltado de sintaxis) y lo renderizás sin gastar IA.

## Imágenes: referencia vs. usar

Cada imagen adjunta se etiqueta:

- **referencia** (default) — el modelo la **mira** para leer composición, paleta y zonas
  libres, pero **NO la incrusta** en el gráfico.
- **✓ usar** — se **incrusta tal cual** (`<img src="assets/…">`): un logo, ícono o foto,
  respetando su proporción (el motor le pasa al modelo las dimensiones reales en px).

Las imágenes van **numeradas** en orden, así las referenciás en la instrucción:
"imagen 1 arriba, imagen 2 es solo referencia". Las capturas del programa **se acumulan**
(cada 📸 suma una) y se guardan en la carpeta de la secuencia (`_capturas/`).

## Fondo, modo borrador y calidad

- Un marcador se genera **sin fondo** (`.mov` con **alpha**, transparente) o **con fondo**
  (`.mp4` opaco HD, fondo minimalista temático con buen contraste).
- **Modo borrador** = render más liviano para previsualizar, pero **solo afecta a los
  clips con fondo** (baja la compresión del mp4). Los clips con **alpha salen SIEMPRE en
  ProRes 4444** (máxima calidad): para alpha, borrador y HQ son idénticos.
- **Render HQ** re-renderiza en alta los clips **con fondo** hechos en borrador (reusa el
  HTML, sin volver a llamar a la IA). Solo aparece cuando hay algo mejorable (nunca sobre
  alpha, que ya está al máximo).

## Optimización de tokens

- **Refinar / Feedback** usa prompt *lean*: **no reenvía el transcript completo** de la
  clase (el modelo se apoya en el HTML previo + el fragmento del marcador). **Generar** y
  **Regenerar desde cero** sí mandan el contexto completo, porque no hay diseño previo.
- **Reenvío de imágenes por-imagen en feedback**: como estás refinando sobre lo generado,
  las imágenes ya adjuntas aparecen **apagadas (gris)** y **no se reenvían** al modelo (la
  visión es lo más caro en tokens). Tocás **📤 reenviar** en la miniatura que necesites
  que el modelo vea (ej. igualar colores de un logo). Las imágenes **nuevas** que agregás
  en el feedback entran **activas** solas. Las marcadas **✓ usar** se **incrustan igual**,
  se reenvíen o no.
- La **continuidad** con otros marcadores solo se inyecta si la instrucción lo pide
  (retomar/continuar/mismo estilo), no siempre.

## La cola

- **Serial**, con pipeline de 2 carriles (modelo ↔ render): genera el HTML del siguiente
  marcador mientras renderiza el actual. Con Ollama local es estrictamente serial (RAM).
- **Pestañas Marcadores | Cola**: la Cola es una vista completa para lotes largos.
- Controles: **pausar/reanudar** (retoma desde el llamado a la IA o desde el render, según
  dónde estaba), **cancelar** un ítem, **reintentar** ante fallo (si el modelo ya había
  terminado y falló el render, reintenta **solo el render** sin gastar IA), **mover** el
  orden, **vaciar** todo.
- **Enviar a la cola** (staging sin arrancar), **Agregar listos a la cola**, **Generar listos**.
- **Reactivar sin tokens**: si una generación falla por límite/cuota (429, usage limit), el
  job queda **esperando tokens** ⏳ con **↻ Reactivar** (individual o todos).
- **Ver**: clic en el nombre del clip terminado → abre esa secuencia y salta a su marcador
  en la pestaña Marcadores.
- **Estimado** al pie: tiempo, tokens y **costo** aproximados de lo pendiente (el tiempo se
  auto-calibra con el uso real).
- **Persistencia por proyecto**: la cola se guarda en
  `<carpeta-del-.prproj>/HyperPremiere/queue.json` y se recarga al reabrir.

## Acciones por recurso

- **Generar** (1ª vez): crea el recurso desde cero, con todo el contexto.
- **Generar (refinar) / Feedback**: ajusta sobre la versión previa con tu nueva instrucción
  (prompt lean, ver Tokens).
- **Regenerar desde cero**: descarta lo anterior y crea uno nuevo con la instrucción +
  recursos actuales.
- **Editar HTML manualmente**: abrís una versión, la retocás a mano y la renderizás sin IA.
- **🧹 Limpiar versiones viejas**: borra los videos de versiones anteriores (deja la última)
  para liberar disco; primero saca los clips del proyecto/secuencia (evita el "Link Media"
  de Premiere) y pide confirmación mostrando qué borra.

## Arquitectura

- **Panel CEP** (`cep/`) — la interfaz dentro de Premiere (`com.codigo.hyperpremiere`), con
  Node embebido (`--enable-nodejs --mixed-context`), en módulos vanilla (sin bundler,
  cargados en orden por `index.html`): `js/util.js` (helpers puros), `js/log.js` (log de
  diagnóstico), `js/engine-client.js` (carga/llamadas al motor), `js/store.js` (`HPStore`,
  persiste por proyecto+secuencia), `js/transcript.js`, `js/widgets.js` (select propio,
  editor de código, tooltips — CEF no dibuja los `title` nativos), `js/queue.js` (cola
  `HPQueue`, máquina de estados), `js/queue-view.js` (pestaña Cola), `js/config-ui.js`
  (proveedor/modelo/credenciales) y `js/main.js` (tarjetas de marcadores + wiring).
  `css/style.css`.
- **ExtendScript** (`cep/jsx/host.jsx`) — lee marcadores, mueve el playhead, importa y
  coloca/recolorea el clip por nombre, exporta el frame del programa, purga clips al limpiar.
- **Motor Node in-process** (`bridge/`) — corre **dentro del panel** vía `require` (sin
  proceso externo ni servidor):
  - `bridge/engine.js` — orquestación en 2 etapas (`prepareGenerate`/`prepareFeedback` =
    modelo, `renderPrepared` = render), config, self-update, versiones, cola, capturas.
  - `bridge/providers/` — `claude-cli`, `claude-api`, `openai-compat`, `ollama`.
  - `bridge/render/hyperframes.js` — render a `.mov` (ProRes 4444 alpha) o `.mp4` (H.264),
    con `--workers 1 --low-memory-mode` (marcadores largos reventaban RAM sin esto).
  - `bridge/prompt/` — system prompt (incluye la **regla dura anti-solapamiento** de layout)
    + build-context (prompt por marcador, lean en refinamiento, imágenes numeradas).
  - `bridge/store/project-fs.js` — salidas en `<carpeta-del-.prproj>/HyperPremiere/<secuencia>/`;
    `bridge/store/versions.js` — dueño único del esquema de nombres versionados
    (`<slug> vN [modelo].ext`): parse, formato, próxima versión y listados.

## Distribución (autocontenido)

El ZXP viaja con el **código** del motor (`cep/` + `bridge/`, sin `node_modules`). En una
instalación limpia, el panel muestra **"Preparar motor"** y corre `npm install` una sola vez
(baja `hyperframes` + su Chromium) y poda `onnxruntime-node` (~258 MB que no se usan).
**Pendiente real**: sigue necesitando **Node/npm** en el equipo; el "cero-install" total
(bundle por plataforma con Chromium propio) todavía no está.

## Requisitos

- **Premiere Pro 2026** con panel CEP (Node habilitado en el manifest).
- **Node 18+** y **ffmpeg** en el PATH.
- Para render, la primera vez se instala **`hyperframes`** (baja un Chromium).
- Proveedor de IA: sesión de Claude / API key / endpoint OpenAI-compatible, o **Ollama**
  local con un modelo con **visión** (ej. `qwen3-vl:30b`).

## Instalación

**Opción A — ZXP firmado (recomendada):** instalá `dist/HyperPremiere.zxp` con tu gestor de
ZXP (ZXP/UXP Installer o Anastasiy's Extension Manager). Reiniciá Premiere y abrí
**Ventana → Extensiones → HyperPremiere**.

**Opción B — desarrollo (symlink):**

```bash
bash scripts/install-dev.sh   # symlink + PlayerDebugMode
```

Reiniciá Premiere y abrí el panel. Como el panel es un symlink al repo, editar `cep/` y
recargar el panel (⟳) ya trae los cambios.

## Actualización / sync

El botón **⟳** del header compara tu versión con `origin/main`, avisa con un resalte cuando
hay versión nueva y la aplica (`git fetch` + `reset --hard origin/main` + recarga del panel).
Flujo de trabajo entre equipos: se edita el repo → **commit + push** → tocar **⟳** en la
Premiere de destino trae exactamente esos cambios.

## Empaquetar el ZXP

```bash
node scripts/sign-zxp.js          # genera dist/HyperPremiere.zxp (self-signed, pass "hyperpremiere")
# opcional con timestamp: HP_TSA=http://timestamp.digicert.com node scripts/sign-zxp.js
```

El firmador arma un staging con `cep/` + `bridge/` (sin `node_modules`) → ZXP autocontenido
del código. `dist/` está gitignoreado (forzar `git add -f dist/HyperPremiere.zxp` para versionar).

## Diagnóstico

- Botón **⬇ Log** en el header: baja `Hyperpremiere_log_<fecha>.md` a Descargas con todo
  (carga del motor, cola, errores) — útil para depurar cualquier falla.

## Notas

- **Windows**: código multiplataforma (spawns con shell, rutas OS-aware), pero **no probado
  en Windows real** todavía.
- Diseño y plan: `docs/superpowers/specs/` y `docs/superpowers/plans/`. Onboarding para otro
  agente: `docs/HANDOFF.md`.
