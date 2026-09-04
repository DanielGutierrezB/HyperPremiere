# Panel de demostración (maqueta con datos falsos)

Para mirar el diseño del panel en un navegador, sin Premiere y sin motor Node.
Es el **HTML y el CSS de verdad** (`cep/index.html`, `cep/css/style.css`, todo
`cep/js/`): acá adentro no hay ni una línea de interfaz duplicada. Lo único que
se falsea son las dos puertas por donde el panel habla con el mundo.

**No viaja al ZXP.** El firmador (`scripts/sign-zxp.js`) empaqueta por lista
blanca: copia `cep/`, `bridge/` (sin `node_modules`) y `version.json`, y nada
más. Esta carpeta vive en `test/manual/`, así que no puede entrar ni por
accidente. Comprobado:

```
$ node scripts/sign-zxp.js
$ unzip -l dist/HyperPremiere.zxp | grep -iE "panel-demo|doble\.js|datos\.js"
(sin coincidencias)
```

## Cómo se abre

```
node test/manual/panel-demo/abrir.js
```

Levanta `http://localhost:4599/` y lo abre. También deja una copia suelta en el
temporal del sistema por si preferís `file://` (algunos navegadores no dejan
cargar scripts de otra carpeta desde `file://`; el de Cursor directamente no
abre `file://`, así que para eso está el `http://`).

`--no-open` solo imprime las URLs. `--puerto 5000` cambia el puerto.

El servidor **rearma el HTML en cada recarga**: tocás `cep/` o `datos.js`,
apretás F5 y ya está. No hay que reiniciar nada.

## Cómo se editan los datos falsos

Todo en **`datos.js`**, y nada más que ahí: nombres de proyecto y secuencia,
objetivo, prompt general, transcript, marcadores con sus instrucciones e
imágenes, la cola entera con el estado de cada job, el contador de la sesión,
las correcciones y la configuración del modelo. No tiene lógica: son datos.
Querés ver un nombre más largo, cero marcadores o un error más feo, lo cambiás
ahí y recargás.

Las imágenes de referencia se dibujan al vuelo (un PNG de color con el nombre
escrito encima), así que en `datos.js` una imagen es una etiqueta y dos colores;
no hay binarios que versionar.

## Escenarios

Estados que no se pueden ver a la vez. Se eligen por la URL, sin tocar código, y
se combinan con coma (`?e=whisper,otra-secuencia`):

| URL | Qué muestra |
| --- | --- |
| `?e=vacio` | proyecto recién abierto: sin marcadores, sin transcript, cola vacía |
| `?e=motor` | el motor Node no cargó (panel en rojo con las rutas que probó) |
| `?e=preparar` | el motor está pero le faltan las dependencias (cartel "Preparar motor") |
| `?e=whisper` | falta el Whisper local (badge en ámbar + oferta de instalarlo) |
| `?e=otra-secuencia` | a los 4 s Premiere se mueve a otra secuencia y salta el cartel amarillo |
| `?e=conflicto` | el prompt general de esta máquina no coincide con el del proyecto |
| `?e=mic-perdido` | el micrófono elegido ya no está enchufado: el desplegable del encabezado se pone en ámbar, la fila de ⚙ avisa y el 🎙 dice cuál usa en su lugar |
| `?e=mic-mudo` | "Probar micrófono" termina en silencio digital (el dispositivo abre pero entrega ceros) |
| `?e=sin-dictado` | en esta máquina no se puede dictar (Windows, sin ffmpeg, sin Whisper): el encabezado NO dibuja el desplegable de micrófono |
| `?e=dictando` | hay un dictado andando: cambiar de micrófono se guarda, pero la fila aclara que vale desde el próximo |
| `?e=sin-medir` | todavía no se generó con ningún proveedor: ⚙ lo dice en vez de mostrar el promedio de otro |
| `?e=api-key` | el CLI de Claude entra con una API key, así que ⚙ **sí** promete el 1M (por suscripción muestra el piso) |

## Medir el encabezado (no mirarlo a ojo)

```
node test/manual/panel-demo/medir-encabezado.js
```

Abre la maqueta en el Chrome del sistema por CDP, a 320, 360, 400, 470, 600 y 900
px de ancho, y a cada uno imprime el desborde del documento y del encabezado
(`scrollWidth` contra `clientWidth`), la caja de cada elemento del encabezado, si
su texto se sale, y **qué pares se superponen y cuántos píxeles**. Es lo que hace
falta para decir si el encabezado está sano: dos cajas que se tocan 6 px se ven
bien en una captura, y los tests del repo fijan las reglas de CSS pero no miden
cajas (el DOM de mentira no tiene motor de layout).

`--capturas <dir>` deja un PNG del encabezado por ancho, `--anchos 320,400` los
cambia, `--url` apunta a un escenario (`?e=sin-dictado`) y `--abrir-mic` despliega
el menú del micrófono antes de medir.

## Medir los botones de todo el panel

```
node test/manual/panel-demo/medir-botones.js
```

Lo mismo pero para el panel entero: recorre **15 vistas** —las tres pestañas, ⚙,
la ayuda, el feedback y el editor de HTML de la cola, el medidor del micrófono y
los ocho escenarios— por los seis anchos, y para cada botón visible compara su
ancho real contra el que **necesita su contenido**. Son ~7600 mediciones y tarda
unos diez minutos.

El ancho necesario no se estima: se clona el botón como hermano suyo (así los
selectores por descendencia siguen aplicando) con `width: max-content` y se lo
mide. Dos detalles que hacen la diferencia entre un número y un número que
sirve, y que están explicados arriba del archivo:

- **`scrollWidth` no alcanza como criterio.** Los botones son `inline-flex`
  centrados, así que el texto que no entra se sale por los dos lados y
  `scrollWidth` solo cuenta el de la derecha: de 585 botones con contenido
  afuera, delataba 310.
- **Lo que recorta con ellipsis no chorrea.** Un desplegable con el nombre de un
  micrófono pide 322 px y vive en 99, y eso es un nombre recortado, no texto
  encima del vecino. Al clonar se le congela el ancho a todo descendiente que
  recorte, y se compara solo el contenido que no se puede recortar.

`--json <archivo>` guarda todas las medidas (sirve para diffear antes/después),
`--capturas <dir>` deja un PNG por vista y ancho, y `--vistas cola,config` y
`--anchos 320,400` acotan la corrida. Si una vista no llega a abrirse, la corrida
**falla** en vez de medir otra cosa: la maqueta aprieta "Cargar marcadores" sola
unos segundos después de cargar y ese redibujo se comía el clic en la pestaña.

## Cómo está hecho

`cep/js/` habla con afuera por dos puertas y nada más:

- **ExtendScript** → `window.__adobe_cep__.evalScript("hp_…()")` (lo usa
  `cep/js/host-client.js`)
- **el motor Node** → `window.cep_node.require(".../bridge/engine.js")` (lo usa
  `cep/js/engine-client.js`)

`doble.js` pone las dos falsas **antes** de que cargue `CSInterface.js`, y con
eso el panel real se dibuja solo creyendo que hay un proyecto abierto. También
reemplaza `localStorage` por uno en memoria (cada recarga arranca limpia) y
siembra el estado con la **API pública de `HPStore`**, así que lo que queda
guardado es exactamente lo que guardaría el panel trabajando de verdad.

Los tres archivos:

- `datos.js` — los datos falsos. Es el que se edita.
- `doble.js` — el cableado: el doble de Premiere, el doble del motor y la siembra.
- `abrir.js` — arma el HTML (inyecta `<base>` + los dos `<script>` sobre
  `cep/index.html`, sin editarlo) y lo sirve.

Por eso **no hizo falta tocar `cep/index.html`**: la línea extra se agrega al
vuelo sobre una copia que vive fuera del panel.

Dos botones se aprietan solos al abrir (`Cargar marcadores` y, la primera vez que
entrás a Corrections, `Cargar secuencia`): en Premiere los toca el editor, y sin
eso la maqueta abriría vacía.

Los botones que generan y renderizan están simulados: podés apretar
`Generar (refinar)` y ver la barra, la línea de "razonando…", el render y el
resultado. Tarda ~25 s en vez de minutos.

Abajo a la derecha hay un sello amarillo **MAQUETA · datos falsos**, para que
nunca se confunda una captura de esto con una del panel corriendo en Premiere.
