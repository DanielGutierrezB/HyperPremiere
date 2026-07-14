# HyperPremiere — Traspaso a un nuevo agente

Sos ahora responsable de **HyperPremiere**, un plugin **CEP para Adobe Premiere Pro 2026** que genera gráficos animados por IA (motor **HyperFrames**, HTML+GSAP) sobre los marcadores de la secuencia y los coloca en el timeline. Salida **ProRes 4444 con alpha** (`.mov`) o **MP4 HD opaco** (marcador "con fondo"). El único usuario es **Daniel Gutiérrez** (español colombiano, informal, conciso, mostrar resultados antes que teoría; NO usar "parcero").

## Dónde vive
- **Repo local (Mac de Daniel, donde corre Premiere):** `~/Desktop/Codigo/HyperPremiere`
- **GitHub (privado):** `DanielGutierrezB/HyperPremiere`
- La extensión instalada es un **symlink a `cep/`** → editar el repo + recargar el panel (⟳) trae los cambios.

## Cómo llegan tus cambios a la Premiere de Daniel (sync)
El motor de render corre en la Mac de Daniel; vos (en el Mac mini) editás. Flujo:
1. Editás el repo → **commit + push** a `origin/main`.
2. Daniel toca **⟳** en el panel → hace `git fetch` + `reset --hard origin/main` y recarga (`selfUpdate`). Ya ve tus cambios.

Alternativa directa: SSH sobre Tailscale a la Mac de Daniel, editar `~/Desktop/Codigo/HyperPremiere` y él recarga el panel. (Requiere Sesión remota activada en ese equipo.)

## Reglas de build (aprendidas, respetalas)
- **Construí/revisá DIRECTO** con edición de archivos. NO lances subagentes `claude -p` pesados: se mueren por OOM (exit 137) en este entorno.
- **Verificá siempre antes de pushear:**
  - `for f in cep/js/*.js; do node --check "$f"; done` (el panel son varios módulos, no solo main.js)
  - `node -e "require('./bridge/engine.js')"` (y `require('./bridge/render/hyperframes.js')` si tocaste render)
  - `cep/jsx/host.jsx` es ExtendScript: copialo a `.js` y `node --check` para validar sintaxis.
  - Balance de llaves en `cep/css/style.css` (contá `{` vs `}`).
- **Versionado:** cada cambio sube el **patch** (1.0.x) en `version.json` **y** el label en `cep/index.html` (`<span id="version-label">vX.Y.Z</span>`). Minor/major solo si Daniel lo pide. **Decile la versión nueva en cada cambio.**
- **Firma del ZXP:** `node scripts/sign-zxp.js` (cert self-signed en `dist/`, pass `"hyperpremiere"`). `dist/` está gitignoreado → forzá `git add -f dist/HyperPremiere.zxp` para el link raw de descarga. El sign arma un staging con `cep/` + `bridge/` (sin `node_modules`) → ZXP autocontenido del código (~pocos cientos de KB).
- **Commits:** terminá el mensaje con `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Windows:** el código es multiplataforma pero **NUNCA se probó en Windows real** — sé honesto.

## Formato Telegram (con Daniel)
Solo markdown simple: negrita, listas, `código`, bloques de código, links. **Nada** de tablas, blockquotes, `<details>`, spoilers ni rich text nuevo (le rompe la vista). Emoji 🎬.

## Arquitectura (resumen)
- `cep/` — panel en módulos vanilla cargados en orden por `index.html`: `js/util.js`, `js/log.js`, `js/engine-client.js` (`HPEngine`), `js/store.js` (`HPStore`), `js/transcript.js`, `js/widgets.js`, `js/queue.js` (`HPQueue`, máquina de estados), `js/queue-view.js`, `js/config-ui.js` y `js/main.js` (tarjetas de marcadores + wiring); `jsx/host.jsx` (ExtendScript: leer marcadores, mover playhead, insertar/recolorear clips, exportar frame), `css/style.css`.
- `bridge/` — motor Node que corre **dentro del panel** vía CEP `--enable-nodejs`: `engine.js` (orquesta generate/feedback en 2 etapas: `prepareGenerate`/`prepareFeedback` = modelo, `renderPrepared` = render), `providers/` (claude-cli, claude-api, openai-compat, ollama), `render/hyperframes.js` (spawnea el binario local de hyperframes), `prompt/` (system + build-context), `store/project-fs.js` (salidas en `<dir .prproj>/HyperPremiere/<secuencia>/`).
- El panel hace `require(engine.js)` directo (sin HTTP). `main.js` prueba varias rutas candidatas y usa la primera que carga.
- **Modelo configurable** (Claude CLI/suscripción, Claude API key, API compatible OpenAI/Gemini, Ollama local). Meta: minimizar tokens (1 request bien armado por marcador).
- **Cola (`HPQueue`)**: serial (uno a la vez), pipeline de 2 carriles (modelo/render), persiste en `<proyecto>/HyperPremiere/queue.json`, pausar/reanudar, cancelar, vaciar, reintentar (desde el punto de fallo), limpiar versiones viejas.

## Estado actual (v1.0.39)
- **E2E validado** en Premiere real (marcadores → modelo → render → clip en timeline). El render funciona.
- **Render**: `--workers 1` + `--low-memory-mode` (marcadores largos ~1000+ frames reventaban por RAM sin esto).
- **Autocontenido**: el ZXP ya trae el `bridge/`; en instalación limpia el panel corre `npm install` una vez (banner "Preparar motor") y poda `onnxruntime-node` (258 MB, no se usa). **Pendiente**: sigue necesitando Node/npm en el equipo; el "cero-install real" (bundle por plataforma con Chromium, o render con Chromium propio) NO está hecho.
- **Imágenes**: cada still tiene etiqueta **referencia** (solo contexto visual) vs **✓ usar** (se incrusta con `<img src="assets/…">`); van numeradas (imagen 1, 2…) y con dimensiones px al modelo.
- **Diagnóstico**: botón **⬇ Log** baja `Hyperpremiere_log_<fecha>.md` a Descargas — pedíselo a Daniel ante cualquier falla, ahí está todo (carga del motor, cola, errores).
- Tooltips propios (CEF no dibuja los `title` nativos).

## Límites honestos (importante)
- Un agente headless **no puede correr Premiere/CEF** → no podés validar el render ni el ExtendScript vos mismo. Verificá lo que puedas (parse/require/load) y sé claro con Daniel sobre qué queda sin probar; usá el **log ⬇** para diagnosticar.
- No inventes precios de modelos (el costo se auto-calibra con el uso real).

## Estilo
Español colombiano informal. Conciso, directo, **honestidad total** (si algo no lo probaste, decilo; si un test falla, mostralo). Emoji 🎬. Mostrá resultados antes que teoría. Cada cambio: pusheado + versión nueva + "dale ⟳".
