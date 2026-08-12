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
   Requiere un Whisper local, y si no lo tenés **el panel lo instala solo**: el
   cartel de arriba (el mismo de "Preparar motor") muestra **Instalar Whisper**,
   te dice qué va a bajar y cuánto pesa, y recién ahí arranca (ver **Instalar
   Whisper desde el panel**). El modelo se cambia con `HYPERPREMIERE_WHISPER_MODEL`.
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
- **Una generación ya pagada no se tira por un cierre raro del CLI.** Pasa cuando el
  agente da más de una vuelta y la última termina sin texto: el CLI cierra con el
  resultado **en blanco** aunque la composición ya estaba escrita en la vuelta anterior.
  Antes eso perdía la generación entera —minutos de razonamiento cobrados— y volvía como
  "respuesta vacía". Ahora el motor la **rescata de los mensajes del modelo** y sigue
  como si nada; en el ⬇ Log queda una advertencia diciendo que hubo rescate y si el
  **conteo de tokens** de esa llamada llegó igual (cuando el CLI alcanzó a cerrar, sí) o
  si ese total sale corto. Vale para los dos CLI, Claude y Cursor. Y si de verdad no hay
  **nada** que rescatar, se dice con todas las letras en vez de devolver un vacío mudo.
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
  `js/host-client.js` (`HPHost`, frontera única con ExtendScript), `js/seq-watch.js`
  (`HPSeqWatch`, se entera de que cambiaste de secuencia en Premiere), `js/store.js`
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
    puesto el estado en vivo, nunca la generación. De paso es la red de abajo: como
    guardó todos los mensajes del modelo, puede **rearmar la respuesta** cuando el
    cierre del CLI no trae nada, y redacta el aviso que va al log (uno solo para los
    dos proveedores, que aclara si el conteo de tokens se salvó o no).
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
  - `bridge/transcribe.js` **detecta** el Whisper que hay y `bridge/whisper-install.js`
    lo **instala**; están separados a propósito y no se conocen entre sí. Lo que
    comparten es `bridge/store/whisper-home.js`: la carpeta propia y el registro de qué
    quedó instalado y en qué ruta. Ese registro se valida contra el disco cada vez que se
    lee, así borrar la carpeta a mano vuelve a dar "falta Whisper" en vez de apuntar a un
    ejecutable fantasma. La política de "qué se instala en esta máquina" es una función
    pura (`_planFor`) que recibe plataforma, arquitectura y si hay Python: por eso se
    puede probar un Mac Intel sin Python sin tener uno.
  - `bridge/claude-login.js` hace el login de Claude en dos fases (URL → código) y
    `bridge/claude-doctor.js` contesta **dónde está el CLI y qué versión es** en esta
    máquina. Están separados porque el diagnóstico se pide **también sin fallar** (el
    botón "Diagnóstico"), y porque así el login puede empezar sabiendo con qué binario
    habla en vez de descubrirlo cuando ya perdió un minuto. El doctor **no toca nada**:
    `which`/`where`, las rutas donde cada instalador deja el ejecutable, y `--version`.

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
  **Cuando no anda, ahora dice por qué** (ver **Cuando el login de Claude falla**).
- **Transcripción local (🎙, opcional):** lo más cómodo es el botón **Instalar Whisper**
  del panel (ver la sección siguiente). A mano: en **Mac (Apple Silicon)**,
  `pip install mlx-whisper` (usa la GPU, es lo más rápido); en **Windows**, bajá
  [Faster-Whisper-XXL](https://github.com/Purfview/whisper-standalone-win/releases)
  y descomprimilo — es un **ejecutable suelto**: no hace falta Python ni pelearse con
  CUDA (trae las librerías adentro, detecta la placa NVIDIA solo y baja el modelo solo).
  Alternativa por pip en cualquier sistema: `pip install whisper-ctranslate2`. El CLI
  clásico `pip install openai-whisper` funciona pero es lento en CPU. La herramienta usa
  primero el que instaló el panel (por ruta absoluta) y si no, el más rápido que
  encuentre en el PATH; forzá uno con `HYPERPREMIERE_WHISPER_BIN` y el modelo con
  `HYPERPREMIERE_WHISPER_MODEL`.
  El modelo por defecto **depende del sistema**: `large-v3` en Mac (la GPU de Apple lo
  banca sin despeinarse) y `large-v3-turbo` fuera de Mac, que es ~4× más rápido con
  prácticamente la misma calidad — sin eso, una clase de una hora en una notebook sin
  placa dedicada tarda demasiado.
  **Con placa NVIDIA se transcribe en la placa**, y si la placa no puede, se **rehace
  en CPU** sin que tengas que hacer nada (ver **Cuando la GPU no puede transcribir**).

## Instalar Whisper desde el panel

Cuando falta el Whisper local, el badge junto a 🎙 dice **"sin whisper local · instalar"**
y arriba, en el mismo cartel de **Preparar motor**, aparece **Instalar Whisper**. Antes de
bajar un solo byte te muestra **qué** se instala, **cuánto pesa** y **dónde** va, y pide
confirmación. Se instala en una carpeta del propio panel
(`~/.hyperpremiere/whisper`, o `%USERPROFILE%\.hyperpremiere\whisper`) y se guarda la
**ruta absoluta** del ejecutable: **no depende del PATH**, que dentro de Premiere no es el
tuyo (ver la sección **Windows**).

- **Mac (Apple Silicon):** arma un entorno de Python propio e instala `mlx-whisper`
  (~260 MB). No toca tu Python ni tus paquetes.
- **Mac Intel / Linux:** el mismo entorno propio con `whisper-ctranslate2` (~220 MB),
  porque mlx solo corre en Apple Silicon.
- **Windows:** baja **Faster-Whisper-XXL** del release de GitHub (**~1,36 GB**) y lo
  descomprime. Es un ejecutable suelto: sin Python y sin instalar CUDA.

Qué hace para no dejarte a mitad de camino:

- **Solo HTTPS y solo hosts de GitHub**, verificado en cada redirección; se compara el
  **tamaño exacto** que publica el release y la **firma sha256** si la hay. Si algo no
  cuadra, aborta y no deja el archivo.
- **Se reanuda.** Si se corta la descarga, volvés a apretar el botón y sigue desde donde
  iba en vez de bajar todo de nuevo. Un pedazo de otra versión no se reusa.
- **Se verifica que CORRA**, no que el archivo exista: primero su `--help`, después una
  **transcripción real de un audio de prueba de 1 segundo** con el modelo más chico. Recién
  ahí queda anotado como instalado. Si falla algo, el panel vuelve a decir "falta Whisper"
  y el botón se puede apretar de nuevo.
- **Si acá no se puede** (un sistema raro, un Mac sin Python 3), muestra el motivo y las
  **instrucciones a mano**. Y **Cargar JSON** —un transcript ya hecho— sigue a la vista
  como alternativa en todos los casos.

El modelo grande (varios GB) **no** se baja acá: lo baja Whisper solo la primera vez que
transcribís de verdad.

## Cuando la GPU no puede transcribir

Faster-Whisper-XXL (y `whisper-ctranslate2`, que usa el mismo motor) agarran la placa
NVIDIA **solos** si la encuentran. Lo que hay que elegirles es la **precisión**, y ahí
había una trampa: `int8` es lo más rápido en CPU, pero las placas **RTX 50xx (Blackwell)
no saben multiplicar en int8**. Como nosotros pedíamos `int8` fijo —pensando en CPU—, en
esas máquinas la transcripción moría con `cuBLAS failed with status
CUBLAS_STATUS_NOT_SUPPORTED` recién al detectar el idioma, o sea después de exportar el
audio y cargar el modelo. La máquina más potente era la única que no podía transcribir.

Ahora la precisión se elige según lo que haya:

- **Con placa NVIDIA** (se pregunta una vez por sesión con `nvidia-smi`): `float16`, que
  anda en toda GPU con CUDA de hoy, Blackwell incluida.
- **Sin placa:** `int8`, que en CPU es varias veces más rápido que `float32`.
- **Si la GPU falla igual** —CUDA a medio instalar, cuDNN que no carga, memoria— la
  corrida se **rehace en CPU** forzando `--device cpu`. Tarda bastante más, pero la
  calidad es la misma y el editor termina con su transcript en vez de con un error. El
  panel lo avisa mientras pasa.

Solo se reintenta **una vez**: si en CPU también falla, el problema no era la placa y el
mensaje lo dice.

## Cuando el login de Claude falla

Antes, cualquier problema terminaba en el mismo cartel después de esperar un minuto:
*"Timeout esperando la URL (60s)"*. Con eso no se podía saber nada, y menos a distancia:
el panel corre dentro de Premiere, **en tu máquina**, y lo único que llega acá es una
captura de pantalla.

Ahora el panel **pregunta primero** dónde está el CLI y qué versión es (dos comandos de
lectura, menos de un segundo) y recién después arranca el login. Con eso, cada falla tiene
nombre propio y el paso siguiente escrito:

- **No está instalado** → se dice al instante, con la línea exacta para instalarlo y la
  lista de los lugares donde se buscó (ya no hay que esperar el minuto).
- **Está pero no contesta** → se muestra lo que llegó a escribir; casi siempre es que
  `claude setup-token` quiere una terminal de verdad y desde el panel no la tiene.
- **Cerró con error** → se cita su salida y el código con el que cerró.
- **Es una versión vieja** que no conoce `setup-token` → manda a `claude update`.

En **todos** los mensajes viaja la **ficha del binario**: ruta, de dónde salió (PATH o una
ruta conocida), versión y sistema. Y el botón **Diagnóstico**, al lado de "Iniciar sesión",
muestra esa misma ficha **sin tener que fallar antes**: es la captura que conviene mandar
cuando algo no anda. Todas las salidas terminan recordando el camino que siempre funciona:
`claude setup-token` en tu terminal y pegar el token en el panel.

Dos arreglos concretos que salieron de ahí: en Windows faltaba
`%USERPROFILE%\.local\bin` en las rutas que el panel agrega, que es **justo** donde el
instalador nativo de Claude deja el ejecutable (estaba instalado y el panel no lo veía); y
la URL de autorización ahora se reconoce por ser **de Claude**, porque algunos errores del
CLI traen un link adentro y el panel abría esa página ajena a pedir un código que no
existía.

## Cuando la generación se cae

Un editor en Windows apretó Generar y recibió esto entero: *"Error: claude-cli: salio con
codigo 1. stderr: (vacio)"*. El mensaje decía que algo falló y **escondía qué**, y encima
no por falta de información: el motivo había llegado y lo tirábamos a la basura antes de
mostrarlo. Los CLI de agente corren con `--output-format json`, y en ese modo escriben sus
errores **en la salida estándar, adentro del JSON** — no en `stderr`, que es lo único que
se miraba.

Ahora se mira todo lo que escribió el CLI, se saca la **frase** de adentro del JSON (un
bloque crudo no es un mensaje de error, es un volcado) y, cuando el modo de falla es de los
conocidos, se dice con nombre propio y con el paso siguiente:

- **La máquina no tiene sesión** → se dice que el CLI arrancó, no encontró con qué
  autenticarse y cerró en el acto; y se manda a `claude setup-token` en una terminal
  (en Windows, PowerShell o CMD) o a pegar el token en *"…o pegá el token directamente"*.
  Es, de lejos, la causa más común de un código 1 en una máquina nueva.
- **Se acabó el cupo** → esperar a que se renueve, o cambiar de proveedor en Configuración
  (Cursor, o la API de Anthropic) para seguir generando mientras tanto.
- **El modelo no existe** → se nombra cuál es el modelo del problema y dónde se cambia.
- **Permisos** → qué ejecutable revisar, y el recordatorio del antivirus (que en Windows es
  la causa buena la mitad de las veces).

Y si el CLI de verdad no dijo nada, el mensaje **lo admite** en vez de simular un motivo.
El mismo descuido —reportar `stderr` y olvidarse de `stdout`— estaba repetido en el
descompresor de la actualización, en el instalador de Whisper, en la transcripción y en el
watchdog del render: todos miran ahora los dos lados.

## Windows

El panel corre en Windows, pero **el sistema operativo cambia cosas que se notan**. Lo que
hay que saber, y lo que la herramienta ya resuelve sola:

- **Instalar las herramientas externas.** Node 18+ y ffmpeg. Lo más cómodo es
  `winget install OpenJS.NodeJS.LTS` y `winget install Gyan.FFmpeg`, o bajar ffmpeg a mano
  y dejarlo en `C:\ffmpeg\bin`. **Whisper no**: ese lo instala el panel solo (ver arriba).
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
- **El panel acoplado no gana ni pierde el foco.** En Mac cada panel CEP es una vista
  propia, así que al volver de la línea de tiempo llega un `focus` y ahí el panel comprueba
  si cambiaste de secuencia. En Windows el panel va **adentro** de la ventana de Premiere:
  moverse entre paneles es la misma ventana nativa y ese evento **nunca llega**. El panel se
  quedaba creyendo que seguías en la secuencia anterior para siempre y no aparecía el aviso
  de "estás en otra secuencia". Ahora la detección no depende de un evento: hay un **sondeo
  cada 2,5 s** (`js/seq-watch.js`) que le pregunta a Premiere cuál es la secuencia activa —
  se saltea el turno si la consulta anterior no volvió (mientras Premiere exporta el audio
  para transcribir, ExtendScript queda bloqueado) y no pregunta nada con el panel oculto.
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

En una instalación **empaquetada** (ZXP, sin `.git`) no hay `git fetch`, así que la versión
publicada se lee de la **API de contenidos** de GitHub
(`/repos/{owner}/{repo}/contents/version.json?ref=main`), y el update se aplica bajando el zip
de `codeload`. **No** se usa `raw.githubusercontent.com` como fuente principal: se sirve por un
CDN que cachea por ruta durante minutos e **ignora los cache-busters de query**, así que puede
devolver una versión vieja y hacer creer que no hay nada nuevo. Queda solo de respaldo, y una
respuesta suya nunca alcanza para afirmar que estás al día.

Por eso el botón tiene **tres** estados, no dos: hay versión nueva (resaltado), estás al día
*verificado*, y **no se pudo averiguar** (borde punteado, `v… ?` y el motivo en el tooltip y en
el ⬇ Log). El tercero incluye quedarse sin cupo de la API — 60 consultas por hora por IP sin
autenticar, contra las ~2 que gasta el panel. Nunca se muestra como "estás al día".

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

También el **rescate de la composición**, que es donde se juega una generación ya
pagada: que con el resultado en blanco vuelva exactamente lo mismo que habría venido por
el camino normal, que el **conteo de tokens** que el CLI sí mandó **no se pierda** (a
diferencia del stream cortado, donde sí se pierde y el aviso lo dice), que el aviso llegue
al log como **advertencia** sin frenar nada, que Cursor tenga la misma red, y que cuando
no hay nada que rescatar el error se entienda.

Y el **login de Claude**: que sin CLI se falle al instante en vez de esperar el minuto,
que el timeout cuente qué encontró, que una versión vieja mande a actualizar, que un link
ajeno dentro de un error no se confunda con la autorización y que una ruta con espacios no
rompa nada.

Y los **mensajes de error del proveedor**, que es lo único que le queda al editor cuando
algo se cae en su máquina: que un motivo que vino por `stdout` con `stderr` vacío llegue al
cartel, que la falta de sesión se reconozca como tal y traiga el comando a correr, y que el
JSON del CLI se muestre **legible** y no como un bloque crudo.

Y el **vigilante de la secuencia activa** (el caso Windows): que el cambio se detecte
**sin** que llegue nunca un `focus`, que dos sondeos no se encimen si el primero no volvió,
que con el panel oculto no se le pregunte nada a Premiere, que el aviso se limpie solo al
volver a la secuencia del panel y que una consulta perdida no deje el vigilante muerto.

También el **instalador de Whisper**, con un servidor local que hace de GitHub (no se
baja un giga en un test): que se detecte bien cuándo falta, que lo instalado por el panel
gane sobre el PATH, que un archivo incompleto o con la firma cambiada se **rechace** sin
dejar restos, que reintentar después de un corte **retome** donde iba, y que en una
plataforma donde no se puede instalar quede el camino a mano.

Y la **transcripción cuando la GPU no puede**, simulando la máquina entera (whisper,
ffmpeg, ffprobe y `nvidia-smi` son todos de mentira, porque todo lo externo pasa por un
solo lugar): que con el traceback real de la RTX 50xx la corrida se **rehaga en CPU** y el
editor igual termine con su transcript, que se pruebe **primero** la placa y no al revés,
que sin placa no se reintente nada, que si en CPU también falla se **corte ahí** con el
motivo, y que a la placa se le pregunte **una vez por sesión** y no en cada clase de la
cola. Los flags de cada variante se fijan aparte, porque no se deducen leyendo el código:
se aprenden cuando fallan.

Y el **chequeo de versión** del botón ⟳, también contra un GitHub local de mentira: que una
versión nueva se detecte, que la fuente cacheada y atrasada **no** haga perder la
actualización, que quedarse sin cupo de la API se reporte como "no pude averiguar" y **no**
como "estás al día", que si la API falla el respaldo sirva igual, y que nunca se proponga
"actualizar" a una versión más vieja que la instalada.

Aparte, `node test/manual/live-providers.js` habla con los CLI de verdad (gasta
tokens y tarda): es lo que hay que correr cuando un CLI se actualiza, para ver si
sigue hablando el mismo idioma.

## Diagnóstico

- Botón **⬇ Log** en el header: baja `Hyperpremiere_log_<fecha>.md` a Descargas con todo
  (carga del motor, cola, errores) — útil para depurar cualquier falla.
- Botón **Diagnóstico** en ⚙, al lado de "Iniciar sesión": la ficha del CLI de Claude en
  esta máquina (ruta, versión, sistema y dónde se buscó), sin tener que provocar un error
  antes. Ver **Cuando el login de Claude falla**.

## Notas

- **Windows**: código multiplataforma (spawns con shell, rutas OS-aware), pero **no probado
  en Windows real** todavía.
- Diseño y plan: `docs/superpowers/specs/` y `docs/superpowers/plans/`. Onboarding para otro
  agente: `docs/HANDOFF.md`.
