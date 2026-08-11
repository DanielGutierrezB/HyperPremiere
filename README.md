# HyperPremiere

Panel **CEP para Adobe Premiere Pro 2026** que genera gráficos animados por IA
(motor **HyperFrames** → HTML + GSAP) **sobre los marcadores** de tu secuencia y los
**coloca automáticamente en el timeline**, en la secuencia correcta.

Salida por defecto en **ProRes 4444 con alpha** (`.mov`, overlay transparente), o
en **MP4 H.264 1080p opaco** por marcador cuando activás "Con fondo".

Modelo configurable: **Claude (CLI de suscripción o API key)**, **Cursor (CLI de
suscripción)**, cualquier **API compatible con OpenAI**, o **Ollama local**. Multiplataforma: **macOS (Apple Silicon)
y Windows**. Todo corre **dentro del panel** (motor Node in-process, sin servidor externo).

Versión actual: ver `version.json` (el label también se muestra en el header del panel).
ZXP firmado: `dist/HyperPremiere.zxp`.

## Cómo funciona (flujo)

1. Ponés **marcadores nativos con duración** en tu secuencia donde querés un recurso y
   pulsás **Cargar marcadores** → una **tarjeta** por marcador.
2. Le das **contexto**: el **Objetivo de la clase** y el transcript. Lo más directo es
   **🎙 Transcribir esta secuencia**: Premiere exporta el audio de la secuencia a un
   **.wav temporal** (mono 16 kHz), lo transcribe con tu **Whisper local** (sin nube ni
   tokens) y lo **borra**. Detecta el idioma solo (sirve mezclando español
   e inglés) y, como transcribe la *mezcla de la secuencia*, los tiempos ya coinciden
   con el timeline: **desfase 0**, sin ajustes a mano.
   Si la secuencia termina con una cola sin narración (overlays, cierre), se recorta
   antes de transcribir: ahí Whisper alucina y entra en **bucle** repitiendo la última
   frase. Por si igual aparece, las repeticiones se colapsan al guardar y al importar.
   Requiere un Whisper local en el PATH (ver **Requisitos**: `mlx_whisper` en Mac,
   Faster-Whisper-XXL en Windows); el modelo se cambia con `HYPERPREMIERE_WHISPER_MODEL`.
   También podés **cargar un transcript JSON**: si viene del video original y editaste
   el timeline, corregí el corrimiento con **Desfase (s)** o **Detectar del timeline**
   (los fragmentos se actualizan en vivo; se guarda por secuencia).
   **El transcript queda guardado en la carpeta de la secuencia** (`transcript.json`),
   tanto el que genera Whisper como el que importás de un JSON. Al abrir el panel se
   lee de ahí, así que si cerrás Premiere y volvés, la secuencia **ya lo tiene**: no hay
   que transcribir ni importar de nuevo. Generar otra vez o importar otro JSON lo
   **reemplaza** por el más actual. Si cambiás de secuencia en Premiere, el panel te
   avisa (con un botón para **pasarte** a ella con su transcript y su objetivo):
   mientras no te pases, lo que hagas va a la secuencia del PANEL, no a la que ves.
   Transcribir siempre abre en el timeline la secuencia que dice el panel y confirma
   con Premiere que el audio exportado sea de ésa antes de guardarlo — así no se
   pisa el transcript de una clase con el audio de otra — y después te devuelve a la
   que tenías abierta.
   **No hace falta acordarse de este paso**: si mandás a generar en una secuencia sin
   transcript, el panel lo transcribe y deriva el objetivo **antes** de gastar tokens, y
   ahí arranca la cola (una sola vez, aunque mandes 20 marcadores juntos). Sin transcript
   el modelo no sabe qué se dice en cada marcador y las animaciones salen genéricas.
   Si no se puede transcribir (secuencia muda, Whisper sin instalar) **no genera a
   ciegas**: te lo dice y deja los marcadores en la cola; si insistís con **▶ Iniciar
   cola** genera igual, avisando que va sin transcript. Mientras prepara el contexto,
   la pestaña **Cola** muestra la barra de progreso y el estado de Whisper (con
   **✕ cancelar**), y los marcadores en espera dicen que esperan el transcript.
   Con **varias secuencias en la cola** cada una lleva su marca: **✓ transcript +
   objetivo** si ya está lista o **falta transcript** si hay que hacerlo. Solo se
   transcribe la que tenga marcadores en cola sin transcript, nunca todas, y de a
   una (Premiere exporta el audio de la secuencia abierta, así que el panel la abre
   y después **te devuelve a la que estabas**). Las secuencias que ya están listas
   **no esperan**: se van generando mientras otra se transcribe.
   Al final, el
   **Prompt general** lleva estilo/marca/tipografía/colores que aplican a TODOS los
   marcadores (no lo repetís en cada uno).
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

**Viajan en toda generación, también al refinar.** Cada llamada al modelo es nueva y no
recuerda la anterior: lo único que sobrevive es el HTML previo que le mandamos. Cuando
las imágenes no se reenviaban "porque ya las había visto", al refinar rediseñaba a ciegas
y se le iba encima de la cara o del logo. Medido con un cuadro de referencia con una zona
ocupada abajo a la izquierda y la misma instrucción: **sin la imagen puso los 2 elementos
justo ahí; con la imagen puso los 4 afuera** y escribió en su plan las coordenadas exactas
que estaba esquivando. Antes de cada llamada, el ⬇ Log dice qué entró ("Entra al modelo:
2 img de referencia · … · objetivo sí"), y **avisa fuerte si una referencia no se pudo
leer del disco** — con el proyecto en un disco externo desmontado, el panel te muestra la
miniatura desde su caché y el modelo diseña sin ella, sin que nada lo delate.

## Repetir el diseño de otro marcador

Si un recurso te quedó como querías, **nombralo en la instrucción del siguiente**: "un
título con el mismo diseño del **Marcador 3**". La herramienta detecta el número, busca la
**última versión** de ese marcador en la secuencia y le manda **ese HTML entero** al
modelo, junto con la consigna de repetir su sistema visual —paleta, tipografía, ritmo,
transiciones— y cambiar solo el contenido. Podés nombrar más de uno ("los marcadores 2 y
5"); van los dos y nada más.

Nombrar un marcador **ya es pedir continuidad**: no hace falta ninguna otra palabra clave.
Y si no nombrás a ninguno pero pedís continuidad en general ("mantené el mismo estilo"),
sigue el comportamiento viejo: entran los primeros marcadores que quepan en un presupuesto
chico, recortados.

El ⬇ Log te dice cuál se usó de referencia (`sigue el diseño de Marcador 3 v4`) y **te
avisa si el marcador que nombraste todavía no tiene ninguna versión generada** — antes eso
se generaba igual y parecía que la referencia se había ignorado. Cuesta ~1.100 tokens
extra, solo cuando lo usás.

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
- **Las imágenes NO son un lugar donde ahorrar**: se reenvían siempre (ver arriba). En la
  caja de feedback de la Cola cada miniatura tiene su **📤** por si querés dejar alguna
  afuera a propósito; las marcadas **✓ usar** se **incrustan igual**, viajen o no.
- La **continuidad** con otros marcadores solo se inyecta si la instrucción lo pide
  (retomar/continuar/mismo estilo, o nombrar un marcador), no siempre. Nombrando el
  marcador gastás **más por recurso pero en el correcto**: va uno entero (~3k tok) en vez
  de dos ajenos recortados a la mitad.

## La cola

- **Pipeline de 2 carriles (modelo ↔ render):** el **modelo (LLM)** corre **varios en
  paralelo** (configurable, "Diseños en paralelo (IA)" en ⚙; default 3, máximo 8) porque el
  trabajo en la nube no compite por recursos locales → para un lote, los diseños se
  resuelven solapados y el render nunca espera. El **render** también paraleliza, pero solo
  hasta donde aguanta **tu** máquina: el motor perfila RAM y cores y decide los carriles
  (2 en equipos con ≥ 24 GB y ≥ 8 cores; **1** en los flojos, donde un segundo Chrome
  dispara el "Set maximum size exceeded"). Medido en un M3 Max de 48 GB con dos marcadores
  reales: en serie 69s, en paralelo 47s (**-32%**) sin que ninguno se ralentice, y los
  `.mov` salen **idénticos byte a byte** — el carril extra acelera el lote, no toca la
  calidad. Lo ves en el ⬇ Log al abrir el panel ("Carriles de render en esta máquina: N").
  Con **Ollama local** todo vuelve a 1 (comparte la máquina) y no se solapa con el render.
  El carril extra **no pide más máquina**: los workers de captura son un presupuesto que
  se **reparte** entre los carriles (con 2 carriles, 3 workers cada uno en vez de 6). Y
  repartir salió gratis, incluso mejor — medido con el mismo HTML y salida idéntica byte a
  byte, bajar de 6 a 3 workers dio **51s → 38s (-26%)** en un marcador de 54s: la captura
  no era el cuello, cada worker extra era otro Chrome que arrancar.
- **Lo que toca Premiere va de a uno.** Importar el video, colocarlo y agregar pistas
  comparten el bin de la secuencia y las pistas, así que esas escrituras se serializan
  aunque los renders vayan en paralelo (cuesta ~1s por clip y la ganancia queda intacta).
  Sin eso, dos colocaciones simultáneas podían dejar el video de un marcador en otro,
  sin ningún error: Premiere no siempre materializa el import de inmediato. Por lo mismo
  el clip importado se busca por su **ruta de media** y no por nombre ni por posición.
- **Pestañas Marcadores | Cola**: la Cola es una vista completa para lotes largos.
- **Qué está haciendo, en vivo, y cuánto lleva.** La barra ya no dice una sola frase
  durante tres minutos. Debajo de la etapa va una línea que se refresca sola con lo
  que el modelo está haciendo **ahora** —"razonando (4.200 tok) · …dónde poner el
  título", "leyendo un archivo · imagen-2.png", "escribiendo la composición · 8.400
  caracteres"— y al lado del marcador corre un **⏱ reloj** con lo que lleva. El texto
  no lo inventa el panel: lo va contando el propio CLI mientras trabaja (Claude y
  Cursor). Los proveedores que no saben contarlo —API de Claude, OpenAI-compatible,
  Ollama— lo **dicen** ("este proveedor no informa el detalle de lo que hace") y
  siguen mostrando la etapa y el reloj, que nunca se frena: callar sería igual que
  parecer colgado. Y si pasa un minuto sin una sola novedad, la línea lo aclara, así
  un CLI trabado deja de parecerse a un modelo pensando. Cada marcador lleva lo suyo
  aunque haya tres generándose a la vez. Si en alguna máquina molesta, se apaga sin
  tocar código: `HYPERPREMIERE_STREAM=0` (todo) o `HYPERPREMIERE_STREAM_THINKING=0`
  (solo el texto del razonamiento). Apagado, vuelve el comportamiento viejo; el
  estado en vivo **nunca** puede voltear una generación: si el CLI no entiende los
  flags, el motor reintenta sin ellos antes de gastar un token.
- **Cuánto tardó cada recurso.** Al terminar, el job cierra con el total y el
  desglose: `✓ Listo y colocado (v3) · 12.400↑ 6.100↓ · 4m 12s (IA 3m 05s · render
  1m 07s)`. Separado a propósito, porque son dos trabajos distintos: si el tiempo se
  fue en la **IA**, la palanca es el nivel de pensamiento; si se fue en el **render**,
  es la duración del marcador o la máquina. El número **queda en el marcador**:
  cerrás Premiere, volvés la semana que viene y la tarjeta sigue diciendo
  `⏱ v3: 4m 12s · IA 3m 05s · render 1m 07s`.
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
  `<carpeta-del-.prproj>/HyperPremiere/queue.json` y se recarga al reabrir. El transcript
  va aparte, por secuencia, en `HyperPremiere/<secuencia>/transcript.json`.

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
  diagnóstico), `js/engine-client.js` (`HPEngine`, carga/llamadas al motor Node),
  `js/host-client.js` (`HPHost`, frontera única con ExtendScript), `js/store.js`
  (`HPStore`, persiste por proyecto+secuencia), `js/transcript.js`, `js/widgets.js`
  (select propio, editor de código, tooltips — CEF no dibuja los `title` nativos),
  `js/stills.js` (control de imágenes/recursos por marcador), `js/queue.js` (cola
  `HPQueue`, máquina de estados), `js/queue-view.js` (pestaña Cola + limpieza),
  `js/config-ui.js` (proveedor/modelo/credenciales) y `js/main.js` (tarjetas de
  marcadores + wiring). `css/style.css`.
- **ExtendScript** (`cep/jsx/host.jsx`) — lee marcadores, mueve el playhead, importa y
  coloca/recolorea el clip por nombre, exporta el frame del programa, purga clips al limpiar.
- **Motor Node in-process** (`bridge/`) — corre **dentro del panel** vía `require` (sin
  proceso externo ni servidor):
  - `bridge/engine.js` — orquestación en 2 etapas (`prepareGenerate`/`prepareFeedback` =
    modelo, `renderPrepared` = render), config, self-update, versiones, cola, capturas.
  - `bridge/providers/` — `claude-cli`, `claude-api`, `cursor-cli`, `openai-compat`, `ollama`.
  - `bridge/composition.js` — dueño del **contrato** de la composición: lo lee y sobre todo
    **completa el andamiaje en código** (id, `data-duration` con la duración real del
    marcador, atributos del esqueleto) en vez de pedirle otro diseño al modelo. Antes, un
    atributo suelto costaba una tanda entera de razonamiento —minutos— y devolvía un diseño
    **distinto**, sin la auditoría del primero. También arregla algo que la validación no
    veía: que el id del `#stage` y el del registro en `window.__timelines` no coincidan, que
    pasaba el chequeo y salía un **video congelado**. No usa un parser de HTML (el archivo
    tiene que volver **idéntico** si no hay nada que arreglar, porque se guarda en disco y
    se edita a mano): escanea el tag respetando comillas, lee los atributos con sus
    posiciones y escribe por índice. Devuelve **códigos** de lo que no pudo completar, no
    frases: la redacción vive en quien arma el prompt. Ignora los comentarios, porque el
    modelo cierra cada composición describiendo en prosa lo que hizo y eso parecía código.
  - `bridge/compose.js` — la **política** de cuándo vale gastar otra llamada al modelo:
    hasta tres (diseño → arreglo de estructura → falla que el modelo mismo declaró en su
    `AUDIT`), cada arreglo sobre **su propio HTML** para no rediseñar, y la regla de nunca
    adoptar algo que quede peor que lo que ya había. Está aparte de `engine.js` para poder
    leerla completa y probarla sin tocar Premiere ni el disco.
  - `bridge/render/hyperframes.js` — render a `.mov` (ProRes 4444 alpha) o `.mp4` (H.264).
    Es el único lugar que mira el hardware: de ahí salen el `--low-memory-mode` de las
    máquinas flojas (donde los marcadores largos reventaban la RAM), los carriles paralelos
    (`renderLanes`) y los workers de cada render, que **se reparten el mismo presupuesto**
    en vez de ser dos diales sueltos sobre los mismos cores. Al terminar deja en el ⬇ Log
    con qué configuración renderizó y cuánto tardó, así un render lento se distingue de uno
    que cayó al modo software.
  - `bridge/prompt/` — system prompt con el sistema de diseño ("menos es más",
    acompañar sin ilustrar literal, coreografía del motion) y el protocolo
    **PLAN → CÓDIGO → AUDITORÍA**: el modelo diseña regiones que no se pisan,
    codea, y se auto-audita con checklist; si declara `AUDIT: FALLA`, el motor
    pide UNA corrección dirigida (solo gasta llamada extra cuando hay falla).
    + build-context (prompt por marcador, lean en refinamiento, imágenes numeradas).
    Lo que **no** dice es cómo llegan las imágenes, porque no lo sabe: eso depende de
    quién atienda. Cuando lo afirmaba ("se adjuntan N imágenes a este mensaje"), con los
    proveedores de línea de comandos le mentía al modelo — no hay adjuntos ahí, hay
    archivos al lado — y el modelo salía a buscar un adjunto que no existía.
  - `bridge/providers/agent-stream.js` — traduce la salida en vivo de los CLI de
    agente (Claude y Cursor, dos dialectos distintos) al vocabulario que muestra el
    panel. Es **solo para el cartel**: el HTML y los tokens se siguen leyendo de la
    salida completa al terminar, así que un CLI que cambie el formato se lleva
    puesto el estado en vivo, nunca la generación.
  - `bridge/providers/` — un proveedor por backend, mismo contrato. Cada uno pone la
    mitad del prompt que le corresponde: **cómo llegan las imágenes**. Los de API las
    adjuntan al mensaje; los de línea de comandos (Claude Code, Cursor) no pueden, así
    que las dejan en disco y lo dicen. El nombre del archivo es el número que usa el
    editor (`imagen-1.png`), para que "usá la imagen 2" no necesite traducción, y se
    nombra por **ruta absoluta**: el buscador del agente no indexa su directorio
    temporal, así que con el nombre suelto a veces contestaba "no encuentro la imagen"
    en vez de componer.
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
- **Modelos de Claude (⚙):** la lista se pide a Anthropic (`/v1/models`) con tu propia
  sesión, así que un modelo nuevo aparece solo, sin actualizar el plugin. Haiku queda
  fuera a propósito (rápido pero no da buenos diseños). Sin red se usa una lista de
  respaldo y el panel lo avisa.
- **Nivel de pensamiento (⚙):** cuánto razona el modelo antes de diseñar — `bajo`,
  `medio`, `alto` (default), `muy alto` o `máximo`. Es la palanca de **calidad**: diseñar
  una animación es trabajo de razonamiento, así que subirlo mejora el resultado a costa
  de tiempo y tokens. Aplica a los dos proveedores Claude (CLI y API).
- **Cursor (⚙):** genera con tu **suscripción de Cursor** en vez de la de Claude — útil
  cuando el cupo de Claude se agota. Requiere el CLI en cada máquina:
  `curl https://cursor.com/install -fsS | bash` y después `cursor-agent login`
  (o la variable `CURSOR_API_KEY`). La lista de modelos se pide a tu cuenta
  (`cursor-agent --list-models`) y se **cura**: quedan fuera las variantes `-fast`
  (pagan prioridad con más consumo), las `-none` (sin razonamiento) y la gama chica.
  Acá el nivel de pensamiento **va dentro del ID del modelo** (`…-thinking-high`,
  `-xhigh`), así que el selector de esfuerzo no aparece.
  A tener en cuenta: cada generación arrastra ~30k tokens de contexto del propio
  agente y tarda ~1,5–3 min, más que Claude directo. Corre en modo **solo lectura**
  y con un directorio temporal como workspace, así que no puede tocar tus proyectos.
- **Login de Claude (⚙):** abre la página de autorización en el navegador; autorizás,
  copiás el **código** que te muestra la página y lo pegás en el panel. Requiere el CLI
  `claude` instalado. Alternativa universal: pegá directamente el token (`sk-ant-oat…`)
  en "…o pegá el token directamente" (corré `claude setup-token` en tu terminal y copialo).
- **Transcripción local (🎙, opcional):** en **Mac (Apple Silicon)**, `pip install mlx-whisper`:
  usa la GPU y es lo más rápido. En **Windows**, bajá
  [Faster-Whisper-XXL](https://github.com/Purfview/whisper-standalone-win/releases),
  descomprimilo y dejá esa carpeta en el PATH — es un **ejecutable suelto**: no hace falta
  Python ni pelearse con CUDA (trae las librerías adentro, detecta la placa NVIDIA solo y
  baja el modelo solo). Alternativa por pip en cualquier sistema:
  `pip install whisper-ctranslate2`. El CLI clásico `pip install openai-whisper` funciona
  pero es lento en CPU. La herramienta elige el más rápido que encuentre; forzá uno con
  `HYPERPREMIERE_WHISPER_BIN` y el modelo con `HYPERPREMIERE_WHISPER_MODEL`.
  El modelo por defecto **depende del sistema**: `large-v3` en Mac (la GPU de Apple lo
  banca sin despeinarse) y `large-v3-turbo` fuera de Mac, que es ~4× más rápido con
  prácticamente la misma calidad — sin eso, una clase de una hora en una notebook sin
  placa dedicada tarda demasiado.

## Windows

El panel corre en Windows, pero **el sistema operativo cambia cosas que se notan**. Lo que
hay que saber, y lo que la herramienta ya resuelve sola:

- **Instalar las herramientas externas.** Node 18+, ffmpeg y el Whisper de arriba. Lo más
  cómodo es `winget install OpenJS.NodeJS.LTS` y `winget install Gyan.FFmpeg`, o bajar
  ffmpeg a mano y dejarlo en `C:\ffmpeg\bin`.
- **El PATH que ve el panel no es el tuyo.** Premiere arranca desde el Explorador y le pasa
  al panel un entorno recortado: aunque en tu consola `ffmpeg` funcione, adentro del panel
  puede "no existir". Por eso, en Windows el motor **agrega solo** los lugares donde esas
  cosas suelen estar (`%APPDATA%\npm`, `Program Files\nodejs`, los `Scripts` de cada Python
  instalado, chocolatey, scoop, `C:\ffmpeg\bin`). Se agregan **al final**, así que si tenés
  una versión propia en el PATH, esa gana.
- **Las rutas con espacios ya no rompen nada.** `C:\Users\Juan Pérez\...` o
  `Marcador 1 v2 [claude-sonnet-5].mov` se pasan entre comillas al lanzar cada proceso.
- **Los CLI de Claude y Cursor reciben el prompt por la entrada estándar.** En Windows hay
  que invocarlos a través de `cmd.exe` (son `.cmd`), y ahí la línea de comandos **se corta a
  los 8191 caracteres**: un prompt con transcript y contexto los pasa de largo. Mandarlo por
  stdin evita el límite y de paso cualquier problema de comillas.
- **Render:** la aceleración por GPU del H.264 es de Mac (VideoToolbox), así que en Windows
  el MP4 se codifica por software. El **ProRes con alpha**, que es el que se usa para llevar
  a Premiere, no cambia: sale idéntico en las dos plataformas.
- **Instalación en modo desarrollo:** `scripts/install-dev.sh` es solo para Mac. En Windows,
  usá el **ZXP** (Opción A).

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

## Tests

```bash
node test/run.js          # sin dependencias, sin red, sin tokens
```

Cubren sobre todo el **estado en vivo**: el traductor de la salida de los CLI —con
salidas **reales** capturadas de `claude` y `cursor-agent`, que están en
`test/fixtures/`—, que el diseño no se pierda si el stream se corta antes del
final, que el prompt por stdin (el camino de Windows) y el stream **convivan**, y
que dos marcadores generándose a la vez no se mezclen el estado.

Aparte, `node test/manual/live-providers.js` habla con los CLI de verdad (gasta
tokens y tarda): es lo que hay que correr cuando un CLI se actualiza, para ver si
sigue hablando el mismo idioma.

## Diagnóstico

- Botón **⬇ Log** en el header: baja `Hyperpremiere_log_<fecha>.md` a Descargas con todo
  (carga del motor, cola, errores) — útil para depurar cualquier falla.

## Notas

- **Windows**: código multiplataforma (spawns con shell, rutas OS-aware), pero **no probado
  en Windows real** todavía.
- Diseño y plan: `docs/superpowers/specs/` y `docs/superpowers/plans/`. Onboarding para otro
  agente: `docs/HANDOFF.md`.
