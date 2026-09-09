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
objetivo, los dos prompts generales, transcript, marcadores con sus instrucciones e
imágenes, la cola entera con el estado de cada job, el contador de la sesión,
las correcciones y la configuración del modelo. No tiene lógica: son datos.
Querés ver un nombre más largo, cero marcadores o un error más feo, lo cambiás
ahí y recargás.

Las imágenes de referencia se dibujan al vuelo (un PNG de color con el nombre
escrito encima), así que en `datos.js` una imagen es una etiqueta y dos colores;
no hay binarios que versionar.

Las **referencias de los dos niveles generales** —`referenciasCurso`,
`referenciasSecuencia` y `referenciasLocales`— son un caso aparte, porque desde
la 1.5.2 no viven en el `localStorage` sino en dos carpetas `_referencias` del
proyecto. `doble.js` las maqueta en memoria, una carpeta por nivel y separadas de
verdad: quitar una del curso no puede tocar las de la clase. La única concesión
es la miniatura, que apunta al PNG dibujado al vuelo en vez de a un `file://` que
acá no existe; el panel no se entera porque `stillThumbSrc` deja pasar los data
URL tal cual. `referenciasLocales`, en cambio, se siembra con la API pública de
`HPStore`, igual que las guardaba la versión anterior: lo que migra en los dos
escenarios de abajo es exactamente lo que se encontraría en la máquina de un
editor que actualiza.

Un campo que vale la pena conocer: el `contexto` de cada recurso de
`correcciones`. Es lo que la ficha `.meta.json` guardó de los tres niveles cuando
ese recurso se generó, y decide cuál de los dos casos muestra la fila. Con un
objeto (aunque sea `{ curso: null, secuencia: null, objetivo: null }`, que es el
atajo para "lo mismo que dicen los archivos hoy") la fila dice **lo que se mandó**;
con `contexto: null` dice **reconstruido**, que es el recurso generado antes de que
la ficha lo anotara. `contextoDeVersion` es de qué versión salió ese registro, y es
lo que hace que la fila pueda decir "al generar la v4" y no "al generar" a secas.

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
| `?e=conflicto` | el prompt general de esta máquina no coincide con el del proyecto (la migración del `localStorage`, que sigue existiendo aunque el botón de destino se haya ido en la 1.5.0) |
| `?e=refs-migran` | el final feliz de la migración de las **referencias**: la carpeta de la secuencia está vacía y las que había en esta máquina suben solas |
| `?e=refs-conflicto` | el otro final: el proyecto ya tiene referencias (las puso el compañero) y las de esta máquina son otras — no se pisa nada y el panel pregunta de quién son |
| `?e=sin-secuencia` | Premiere sin ninguna secuencia al frente: **Estilo del curso** se dibuja solo, sin mandar a un bloque que no está, y **Estilo de esta secuencia** no se ofrece entero (ni el campo ni las referencias: no hay carpeta donde guardarlos) |
| `?e=mic-perdido` | el micrófono elegido ya no está enchufado: el desplegable del encabezado se pone en ámbar, la fila de ⚙ avisa y el 🎙 dice cuál usa en su lugar |
| `?e=mic-mudo` | "Probar micrófono" termina en silencio digital (el dispositivo abre pero entrega ceros) |
| `?e=sin-dictado` | no se puede dictar (Windows, sin ffmpeg, sin Whisper) **pero sí refinar**: el encabezado no dibuja el desplegable de micrófono, el 🎙 se ve apagado con su motivo y el ✨ de refinar lo escrito a mano queda **prendido** |
| `?e=sin-refinador` | el otro eje: se puede dictar, pero no hay ningún refinador en la máquina — el dictado deja el texto crudo y el ✨ está apagado diciendo qué falta |
| `?e=refinado-falla` | el ✨ se rechaza (el control de tamaño lo agarró): se lee el motivo y el campo **no se toca** |
| `?e=dictando` | hay un dictado andando: cambiar de micrófono se guarda, pero la fila aclara que vale desde el próximo |
| `?e=sin-medir` | todavía no se generó con ningún proveedor: ⚙ lo dice en vez de mostrar el promedio de otro |
| `?e=api-key` | el CLI de Claude entra con una API key, así que ⚙ **sí** promete el 1M (por suscripción muestra el piso) |
| `?e=cursor` | Cursor elegido y con sesión: ⚙ en verde, con qué cuenta entra, y la fila de API key disponible |
| `?e=cursor-sin-sesion` | el caso del editor: el CLI está instalado y falta el login — ⚙ nombra a **Cursor** (no a Claude) y da el comando con la ruta completa |
| `?e=cursor-sin-cli` | el binario no está (`spawn cursor-agent ENOENT`): otro cartel, con el comando de instalación, y el Diagnóstico arma la ficha igual diciendo dónde buscó |
| `?e=cursor-sin-cupo` | hay credencial y la cuenta no tiene cupo: ⚙ en **ámbar**, ni verde (mentiría) ni rojo (no falta configurar nada) |

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

Lo mismo pero para el panel entero: recorre **23 vistas** —las tres pestañas, ⚙,
la ayuda, el feedback y el editor de HTML de la cola, el medidor del micrófono y
los escenarios— por los seis anchos, y para cada botón visible compara su
ancho real contra el que **necesita su contenido**. Son ~12000 mediciones y tarda
unos catorce minutos.

La vista `prompts-generales` abre **los dos** bloques de estilo a la vez —el del
curso arriba y el de la secuencia adentro del área de marcadores— cerrando las
tarjetas de marcador, porque el acordeón de `main.js` los pliega a los dos al
abrir una. Es la foto que dice si el panel desborda con todo desplegado, y desde
la 1.5.2 los dos bloques traen además su caja de referencias con material
adentro.

La vista `refs-conflicto` es el cartel de la migración de las referencias, y va
aparte del de `conflicto` —que es el del texto— porque sus tres botones (*Son de
esta clase* · *Son del curso* · *Descartarlas*) viven en un renglón propio adentro
del bloque de la secuencia. Es el candidato obvio a desbordar a 320 px, y no
desborda: los tres entran y el renglón envuelve.

En esos dos escenarios se ve además el **freno de la cola**: apretá *Generar* en
cualquier marcador con `?e=refs-conflicto` y el panel no manda nada — el área de
salida se pone en rojo diciendo cuántas referencias quedaron en esta máquina, de
qué clase son y cómo se sueltan, y ofrece ▶ *Iniciar cola* otra vez para generar
igual sin ellas. Es el chequeo previo de `main.js` (`refsListasPara`) corriendo
de verdad sobre los dobles: nada de eso está maquetado. Con `?e=refs-migran` no
aparece ningún cartel, que es el otro lado de la misma decisión: si alcanza con
esperar a que la migración termine, se espera y se genera con el material.

La vista `corrections-contexto` despliega *Lo que recibió este marcador* en cada
fila **y teclea de verdad** en el campo del curso, porque el botón *Guardar para
todo el curso* no existe hasta que hay algo que guardar: en `corrections` no se
mide nunca. Es el único botón nuevo de esa fila y el más largo, así que es la vista
que dice si entra a 320 px (entra: pide 154 px y vive en un renglón propio).

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
