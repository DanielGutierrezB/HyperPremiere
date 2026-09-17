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
   Los **comentarios que volvés a importar de Frame.io** se **ignoran**: son notas para
   vos, no trabajo para la herramienta. Se reconocen por el sello que Frame.io le pega al
   final del comentario —`Frame.io Comment ID: <uuid>`— y el panel te dice **cuáles**
   salteó, con nombre y minuto. Importante que no entren, porque si se colaran
   **correrían la numeración** y "Marcador 3" pasaría a ser otro marcador distinto del
   que tiene los archivos ya generados. (Ver **Los comentarios de Frame.io no dicen
   Frame.io**.)
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
   Arriba de todo, en
   **Estilo del curso**, el **Prompt general** lleva estilo/marca/tipografía/colores que
   aplican a TODO el curso; abajo del rótulo **Marcadores**, en **Estilo de esta
   secuencia**, el **Prompt de secuencia** lleva lo que sea propio de esa clase (no lo
   repetís en cada marcador). El rótulo separa lo que es del curso —y se mantiene al
   cambiar de clase— de lo que es de la secuencia en la que estás. Los dos viajan juntos al modelo y, donde se contradigan,
   manda el de la secuencia. Los dos bloques aceptan además **referencias** —capturas,
   logos, manuales de marca, PDFs—, y como los dos textos, se guardan en archivos del
   proyecto: las del curso las ve cualquiera que abra el `.prproj`.
3. Por marcador escribís una **instrucción**, podés **capturar el frame del programa** y
   arrastrar **imágenes / PDFs / referencias** sobre el campo: quedan adjuntas y
   **mencionadas** donde tenías el cursor (ver **Mencionar una referencia sin contar**).
4. La IA diseña una animación **HyperFrames**, se **renderiza** y se **coloca sobre el
   marcador**, importada a un bin **`HyperPremiere > <secuencia>`** dentro del proyecto.
   Todo pasa por una **cola** que procesa de a uno.
5. Iterás con **Generar / Refinar / Regenerar**, o editás el **HTML a mano** (con
   resaltado de sintaxis) y lo renderizás sin gastar IA.

**La carpeta `HyperPremiere/` aparece cuando la usás, no cuando abrís el panel.** Todo lo
que la herramienta guarda vive en `<carpeta-del-.prproj>/HyperPremiere/` —la cola y el
estilo del curso arriba, y una carpeta por secuencia con sus renders, su transcript y sus
referencias—, y esa carpeta se crea con la **primera escritura de verdad**: generar,
transcribir, capturar un cuadro, agregar una referencia, escribir un prompt o encolar un
trabajo. Abrir un proyecto y mirar no deja nada: ni la carpeta del proyecto ni la de la
secuencia. Importa porque **viaja con el `.prproj`** —al disco compartido y a las otras
máquinas—, así que una carpeta vacía en un proyecto donde nunca se usó la herramienta es
basura que se propaga y encima miente sobre que ahí hay algo.

## Imágenes: referencia vs. usar

Cada imagen adjunta se etiqueta:

- **referencia** (default) — el modelo la **mira** para leer composición, paleta y zonas
  libres, pero **NO la incrusta** en el gráfico.
- **✓ usar** — se **incrusta tal cual** (`<img src="assets/…">`): un logo, ícono o foto,
  respetando su proporción (el motor le pasa al modelo las dimensiones reales en px).

Las imágenes van **numeradas** en el orden en que le llegan al modelo, y así se las
nombra en la instrucción: *"imagen 1 arriba, imagen 2 es solo referencia"*. Las capturas
del programa **se acumulan** (cada una suma) y se guardan en la carpeta de la secuencia
(`_capturas/`).

**Pero ese número ya no hay que contarlo**: se toca la referencia en la tira de arriba del
campo y en el texto queda un chip que dice `@Imagen_2` y que guarda
`@[curso/logo-platzi.svg]`, que al mandar se traduce al número que le toca (ver **Mencionar
una referencia sin contar**).

Se adjuntan en **tres lugares** y el orden en que llegan al modelo es del más específico al
más general: las del **marcador**, las del **curso** y las de **esta secuencia**. Las dos
últimas se guardan en archivos del proyecto y viajan con el `.prproj` (ver *Las referencias
viajan con el proyecto*); las del marcador siguen siendo de esta máquina, porque son de un
marcador de una clase y no le sirven a nadie más.

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

## Mencionar una referencia sin contar

Escribir "imagen 2" obligaba a **contar en la cabeza**, y a contar sobre tres listas que se
concatenan y que se mueven solas: agregás una captura al marcador y todas las del curso se
corren un lugar; borrás una y se corren para el otro lado; una que el disco no tiene no
viaja, así que no ocupa número. La instrucción que escribiste ayer queda apuntando a otra
imagen y **nada falla**: el gráfico sale distinto.

Ahora la referencia se **menciona por su nombre** y el número lo pone la herramienta al
mandar. Escribís `@` y la elegís de la lista (o tocás la miniatura, o la soltás sobre el
campo, o apretás *Capturar del programa*) y en el texto queda escrito, donde tenías el cursor:

```
Copiá la disposición de @[marcador/boceto-3-bloques.png], la tipografía de
@[curso/manual-de-marca-nova.png] y el encuadre de @[clase/captura-00-03-41.png].
```

que en el campo **se ve** así, como chips (y abajo está el por qué):

```
Copiá la disposición de @Imagen_1, la tipografía de @Imagen_2 y el encuadre de @Imagen_5.
```

y al modelo le llega esto:

```
Copiá la disposición de imagen 1, la tipografía de imagen 2 y el encuadre de imagen 5.
```

**El contrato con el modelo no cambió** y eso es a propósito: sigue recibiendo N imágenes
numeradas de 1 a N y sigue entendiendo "imagen 1" como siempre. Lo que cambió es del lado
del editor. Por eso la traducción se hace en el último momento, contra las imágenes que **de
verdad viajan**, y no al escribir la mención: escrita, la mención no tiene número.

**Por qué se guarda así.** La instrucción es un texto y viaja por seis lugares —el
`localStorage` del panel, el payload del job, el `queue.json` del proyecto, el `.meta.json`
de cada versión, la pestaña Corrections y el prompt—, así que la mención es texto y nada
más: cualquier otra forma habría que enseñársela a los seis. Lleva el **nombre** y no el
número, que es lo único que sobrevive a que la lista se mueva; lleva el **ámbito**
(`marcador` / `curso` / `clase`), porque un `captura.png` del marcador y otro del curso son
dos archivos distintos; va **delimitada** con `@[…]` porque los nombres de archivo tienen
espacios (*"Captura de pantalla 2026-09-15 a la(s) 11.04.32.png"* es lo que escribe macOS);
y **se lee**: si algún día aparece sin traducir —una fila de Corrections, un panel más viejo
que el archivo— lo que se ve es el nombre de un archivo y no un identificador opaco.

### En el campo se ve `@Imagen_1` y se guarda el nombre

El editor lo pidió mirando su instrucción: *"me gustaría que en vez de decir '@' y la ruta,
fuera '@Imagen_1, @Imagen_2', '@Documento_3', algo más simple"*. Tenía razón: un
`@[curso/manual-de-marca-nova.png]` en medio de una frase es largo y ensucia la lectura de
lo que uno está escribiendo.

Y el costo estaba escrito desde el principio, tres párrafos más arriba: la mención lleva el
**nombre** y no el número porque es lo único que sobrevive a que la lista se mueva. Así que
se le planteó la disyuntiva y eligió sabiéndola: **el chip MUESTRA `@Imagen_1` y GUARDA
`@[curso/manual-de-marca-nova.png]`**. El número es capa de presentación y nada más. La
consecuencia buena es que **nada de lo que se guarda cambió**: el texto en disco, el payload
del job, el `queue.json`, los `.meta.json`, el `localStorage` y el prompt dicen exactamente
lo que decían, y el contrato con el motor quedó donde estaba (se rehace entero con
`node test/manual/menciones-al-modelo.js`).

Lo que eso pide a cambio es que **el número que se muestra sea el del motor**, porque un chip
que dice «Imagen_2» sobre lo que va a llegar como «imagen 3» es *peor* que el token largo: el
token largo no miente. La cuenta es una sola —la posición entre las imágenes que de verdad
viajan, en orden marcador → curso → clase— y la hacen las mismas líneas que usa el ✨ para
canonizar. Los **documentos** el motor no los numera (los nombra: *el documento
«manual.pdf»*), así que el `_3` de `@Documento_3` es un identificador del panel nomás y no
viaja a ninguna parte.

**Y las tres cosas que un chip corto tiene que devolver:**

- **Hover.** La miniatura de la imagen, o el icono del tipo de documento, pegada al chip y
  **arriba** —abajo taparía el renglón que se está escribiendo—, con el nombre del archivo al
  pie. Es lo que el chip corto se llevó puesto: `@Imagen_2` no dice *qué* imagen es. La fuente
  del `<img>` sale del inventario ya convertida, por la misma función que las miniaturas de la
  tira: las del marcador son data URLs y las de los dos niveles generales son rutas en disco,
  que en Windows hay que **convertir** a `file:///C:/…` y no concatenar.
- **Borrado entero.** Con el chip seleccionado o el cursor pegado a él, una sola tecla se lo
  lleva completo, de los dos lados. Lo que no se puede dejar pasar es medio token suelto:
  medio token viaja al modelo como texto y el gráfico sale sin la referencia.
- **Doble clic para cambiar el número.** El chip se abre como un **campo de texto de verdad**
  —un `<input>` adentro del chip— con el número ya seleccionado, así escribir lo reemplaza de
  una. Cursor, selección con el mouse, flechas y Backspace son los del navegador, no una
  emulación. El editor escribe `2` y el chip **repunta a la referencia que HOY es la 2** y
  guarda su nombre; Enter o Tab confirman, Escape cancela.
  Y un número que no existe —un `7` con seis referencias— **no se deshace**: queda escrito, el
  chip pasa a rojo y el renglón de abajo dice qué pasó y cuántas hay (ver abajo).

Las que **no apuntan a nada** se ven ahí mismo, y la regla de qué muestra un chip roto es de
tres casos porque son tres cosas distintas de arreglar. El chip muestra **lo que hay que
corregir**: el *nombre del archivo* cuando la referencia ya no está adjunta o cuando el disco
no la tiene —es lo que hay que volver a adjuntar, y un «@Imagen_?» no diría nada—, y el
*número* cuando lo que está mal es el número que el editor escribió. Ámbar si el archivo no
está en el disco o si el nombre es ambiguo, rojo para los dos casos que no apuntan a nada: los
mismos colores que ya significan eso en todo el panel. Medido sobre el DOM y a los cuatro
anchos: el chip que apunta bien **9.24:1**, el colgado **6.91:1**, el del número inválido
**6.91:1** (el mismo rojo), el que el disco no tiene **8.21:1**, el nombre en el preview
**7.69:1**. Cero textos por debajo de AA, que es lo que consiguió la etapa 1 y no se podía
perder.

#### Un número que no apunta a nada queda escrito, en rojo

La primera versión deshacía lo escrito: si el editor ponía `7` y había seis referencias, el
chip volvía solo a su número anterior y se decía en un renglón. El argumento era no inventar
nada, y el editor lo corrigió con razón: *"si lo modifico a algo que no está, pues debería
dejar de aparecer azul ya que no está referenciando nada. O que aparezca rojo avisando que no
referencia a nada"*. **Deshacerle lo que escribió es peor que mostrárselo mal**: el chip
volviendo solo al 3 se siente como que el panel le pelea el teclado, y lo deja creyendo que
quedó el 3 cuando quería el 7.

Así que el estado inválido pasó a ser **representable**, y para eso hay que poder guardarlo. Lo
que se guarda es el número, escrito como el nombre de una referencia que no existe:
`@[Imagen_7]`. Y eso no contradice por qué se guarda el nombre y no el número: **el nombre
existe para que una mención válida sobreviva a que la lista se reordene**; una que no apunta a
nada no tiene nombre que guardar, y ahí el número es el único registro fiel de lo que el editor
pidió — y lo único que puede corregir.

El motor ya trata bien ese token sin saber nada de esto: no encuentra ninguna referencia que se
llame «Imagen_7», así que lo resuelve como una mención colgada y **el modelo lee que falta, no
otra imagen en su lugar** (está fijado desde antes en `menciones.test.js`). Y se sigue
leyendo, que es el otro requisito de siempre: un `@[Imagen_7]` sin traducir dice exactamente lo
que se quiso pedir.

Tres cosas que lo hacen usable, y las tres hicieron falta:

- **Se arregla con el mismo gesto.** Doble clic en el chip rojo, que reabre con el número que
  se había escrito (no vacío), un número que sí existe, y vuelve a azul guardando el nombre.
  Ida y vuelta, sin quedar pegado en rojo.
- **El renglón de abajo y el tooltip lo dicen en palabras.** El tooltip es más importante que
  nunca: en un chip rojo que dice `@Imagen_7` el color es lo único que avisa, así que dice las
  tres cosas —cuántas hay, que el modelo va a leer que falta, y que se corrige con doble clic—.
  Y el aviso **no lo confunde con una referencia borrada**: las dos están en rojo, pero una se
  arregla volviendo a adjuntar el archivo y la otra escribiendo otro número, así que un aviso
  que dijera *"volvé a adjuntar «Imagen_7»"* mandaría a buscar un archivo que no existe.
- **El Escape recuperó su sentido.** Antes cancelar y confirmar terminaban en lo mismo, porque
  el número inválido se deshacía igual. Ahora son dos cosas distintas de verdad: Escape deja el
  chip apuntando a lo que apuntaba, Enter guarda lo que el editor escribió.

Y el aviso de una sola vez se fue con la regla vieja. Era un mensaje transitorio para un estado
permanente —lo decía una vez y se perdía al cambiar de pestaña—; ahora el chip rojo y su
renglón siguen ahí porque lo que los produce es el token guardado.

Y la mención **sigue leyéndose**, que era el argumento para guardar el nombre y no un
identificador opaco: el tooltip del chip dice el token entero y con qué número le va a llegar
al modelo. Lo que se movió es dónde se lee, no si se puede.

#### Cómo, y por qué el cambio no se propaga

El campo dejó de ser un `<textarea>`. Hubo un **espejo** —un `<div>` detrás con la misma
tipografía pintando el mismo texto con las menciones en `<span>`, y el textarea encima con el
texto transparente— y andaba, con 28 de 28 mediciones alineadas, porque el espejo decía
*exactamente* los mismos caracteres que el campo. Un chip no puede: dice `@Imagen_1` donde el
texto guardado tiene 38 caracteres, así que no hay nada que alinear. El campo es ahora un
`contenteditable` con los chips de verdad adentro (`contenteditable="false"` en cada uno, que
es lo que los hace atómicos para el navegador).

Pero al campo le hablan seis cosas que existían antes de esto —el dictado, que lo reescribe
entero cada segundo y medio y le maneja el alto; el ✨; la inserción de menciones; el control
de alto; el guardado de cada pestaña; y el aviso— y las seis hablan en `value`,
`selectionStart`, `selectionEnd`, `setSelectionRange()` y el evento `input`. Así que el campo
nuevo **imita la interfaz de un textarea, en coordenadas del texto canónico**: el getter de
`value` serializa el DOM (los nodos de texto tal cual, cada chip como su `@[…]`), el setter
parsea texto canónico y redibuja con chips, y los offsets se traducen en los dos sentidos
tratando cada chip como **una** unidad que aporta `token.length` caracteres y no admite el
cursor adentro. `HPMenciones.insertar` no se tocó ni una línea, y eso es la prueba de que la
fachada está completa.

Dos reglas sostienen eso. La primera: la aritmética de offsets vive en **una** función que
recorre los hijos y arma el mapa; las cuatro operaciones salen de ahí. Repartirla es cómo se
llega a que el cursor caiga un carácter corrido sólo cuando hay dos chips seguidos. La
segunda: un `contenteditable` con el foco adentro **no se redibuja en cada tecleo** —se come
el undo nativo—, así que los chips se crean al cargar el texto, al insertar una mención, al
refinar y cuando cambia la lista de referencias, y nunca tecleando; tecleando sólo se editan
nodos de texto.

Y **copiar** un pedazo de instrucción se lleva el texto canónico, no lo que se ve. Sin eso,
copiar una frase con un chip adentro ponía `@Imagen_3` en el portapapeles: pegado en el
marcador de al lado le llega al modelo como texto suelto, y ahí el número vuelve a ser el
dato. Pegando el token se recupera el chip, y copiar la instrucción entera afuera del panel
da el texto que el motor entiende.

### Escribir `@` abre la lista de referencias

El editor lo pidió así: *"al escribir a mano '@' debería salir un menú de selección de las
referencias. Así puedo solo seleccionar lo que deseo rápidamente"*. Es el complemento de la
tira: para mencionar tocando una miniatura hay que sacar la mano del teclado en medio de una
frase. Ahora se escribe `@`, se filtra tecleando y se sigue escribiendo sin soltar el teclado.

Se abre cuando el `@` está **al principio del campo o después de un espacio**. Pegado a una
palabra no se abre, y eso es la mitad del diseño: `escribile a dani@nova.com` y
`como dice @marcelo` son un mail y un handle, y abrir un menú ahí convierte cada dirección de
correo en un tropiezo donde encima un Enter elegiría una referencia que nadie pidió. Tampoco
se abre **adentro de una mención ya escrita**: ofrecer reemplazar lo que se acaba de elegir no
es ayuda.

Filtra por **nombre de archivo, sin mayúsculas y sin acentos** —hay archivos que se llaman
*"Guía de estilo"* y *"Captura de pantalla"*, y tener que acertarle al acento para encontrar
uno es peor que abrir la tira con el mouse—. Y muestra **lo mismo que va a decir el chip**: la
miniatura (o el icono del tipo de documento), el número y el nombre, agrupados por ámbito con
los rótulos que la tira ya usa (*de este marcador*, *del curso*, *de esta clase*) y en el
orden en que le llegan al modelo. La etiqueta de cada fila sale de la **misma función** que la
del chip, así que lo que se lee en la lista es, carácter por carácter, lo que va a quedar en el
campo — con dos cuentas, la lista diría «Imagen_5» y el chip que aparece en su lugar otra cosa.

Teclado primero: flechas para moverse, **Enter o Tab** para elegir, **Esc** para cerrar sin
elegir, y el mouse hace lo mismo moviendo la *misma* marca de selección (con dos, dos filas
dirían a la vez que son la que entra con Enter). Al elegir queda el chip y el `@` con lo
tecleado desaparece; los espacios de alrededor los cuida `HPMenciones.insertar`, el mismo
camino que tocar una miniatura, así que no hay una segunda regla de espaciado que pueda decir
otra cosa.

Las que el disco **no tiene** aparecen igual, dichas como tales, y elegirlas deja la mención
con el aviso de siempre. Esconderlas es peor: el editor sabe que agregó ese archivo, no lo
vería en la lista y se iría a buscar el motivo al lugar equivocado. Y **sin ninguna referencia
adjunta** no hay un menú vacío: hay una línea con los dos caminos para conseguirlas (arrastrar
un archivo sobre el campo, o los bloques de estilo del curso), que es la duda real de alguien
que recién abrió el panel.

Está medido, no supuesto: `node test/manual/panel-demo/medir-chips.js` comprueba, en los tres
campos con menciones y a 320 / 400 / 600 / 900 px, que el número del chip coincida con el de
la tira, que `value` siga siendo el texto canónico con Chromium editando, que el preview
aparezca arriba del chip, que Backspace se lleve el token entero **y se pueda deshacer**, que
tecleando el chip siga siendo el mismo nodo, que el doble clic repunte (y que un número que no
existe no toque el texto), y que el menú del `@` se abra tecleando, filtre, no quede cortado y
**su Enter no deje un salto de línea**. 120 de 120 en verde.

Fue lo que encontró los dos únicos defectos reales que tuvo esto, y ninguno de los dos lo
podía ver un test del repo. El primero: el número se editaba volviendo el chip
`contenteditable`, y con el foco puesto ahí Chromium le entregaba el Backspace y el Enter **al
campo de afuera**, así que "borrar el número" borraba el chip entero y "confirmar" metía un
salto de línea en la instrucción. El segundo: el menú elegía de qué lado abrirse pero no se
**acotaba** al hueco, así que a 320×700 con el campo a media altura "hay lugar abajo" era
verdad (132 px) y el menú de 232 igual salía 18 px por debajo del borde. Ahora se acota al
hueco del lado que elige y scrollea adentro: en el caso apretado se ven tres filas en vez de
seis, que es lo correcto — tres que se leen valen más que seis de las que dos se cortan.

### El undo, hasta dónde llega

El undo de un `contenteditable` lo lleva el navegador, con sus propios snapshots, y **no se le
puede empujar nada a mano**: todo lo que el panel cambia por su cuenta, Cmd+Z lo saltea. En un
campo donde se escriben instrucciones largas eso no es un detalle, así que:

- **Borrar un chip SE DESHACE.** En vez de sacar el nodo, se selecciona el chip entero y se le
  pide al navegador que borre la selección, así el paso entra en su pila. Y acá sí se puede
  confiar en él porque la ambigüedad se la sacamos: lo que no se podía dejar pasar era *"el
  cursor está pegado a un elemento atómico, adiviná qué quiso borrar"* —de ahí salía el medio
  token de basura—, y con la selección puesta exactamente sobre el chip no queda nada que
  adivinar. Medido en los tres campos y a los cuatro anchos.
- **Cambiarle el número a un chip no se deshace, y queda así a propósito.** Ahí no hay nada
  que borrar ni insertar: cambia el *token* de un nodo que se queda donde está, y la pila
  nativa sólo entiende de texto insertado y borrado. Se podría hacer pasar por un borrado más
  una inserción, pero lo insertado sería TEXTO (el comando de edición no inserta elementos),
  así que el chip se volvería el token crudo hasta el próximo redibujado: se cambiaría un paso
  que el undo saltea por un parpadeo visible en cada cambio de número. Y no hace tanta falta,
  que es la otra mitad de la decisión: repuntar un chip es **reversible con el mismo gesto** —
  doble clic otra vez y el número anterior, que es el que el chip mostraba un segundo antes—.
  Y desde que un número inválido queda escrito en rojo en vez de deshacerse, ese camino de
  vuelta es además **visible**: el chip dice qué hay que corregir. Está escrito en el módulo
  para que no se intente de nuevo a ciegas.

**Lo que ya estaba escrito sigue andando.** Una instrucción que dice *"como en la imagen 2"*
en texto plano viaja exactamente así: la herramienta **no** busca "imagen N" para
reescribirlo al mandar. Lo único que traduce son las menciones.

**Pero el ✨ Refinar sí las arregla, si se lo pedís.** Apretar *Refinar* con un
*"como en la imagen 2"* escrito a mano lo convierte en la mención del archivo que de verdad
es la 2 —y de ahí en adelante ese texto ya no depende de contar—. La diferencia con el
párrafo de arriba es quién lo pidió: al mandar, reescribir el texto del editor a espaldas
suyas sería peligroso; acá apretó un botón que dice que se lo arregle, el cambio queda a la
vista en el campo y el **↩** lo devuelve carácter por carácter.

Y lo hace el **panel**, no el modelo. El orden del pedido —marcador → curso → clase,
salteando lo que no viaja— lo conoce el panel exactamente; pedírselo al refinador sería que
adivine un mapeo que ya sabemos, y si adivina mal cambia la imagen sin que nada falle. El
modelo sigue haciendo lo suyo (ordenar y aclarar el pedido) y la canonización la hace quien
la sabe. Tres cosas que no hace: si un *"imagen 5"* no tiene a qué apuntar porque solo
viajan tres, **no inventa** nada —queda como estaba y se dice—; no toca una enumeración
(*"las imágenes 1 y 2"*), porque reemplazar solo el primer número dejaría el resto suelto; y
no reescribe por dentro una mención que ya está, aunque el archivo se llame *"imagen 2.png"*.

Y los tres casos en que una mención no puede apuntar a un número se **dicen**, en el panel
mientras escribís y en el ⬇ Log antes de gastar la llamada. Ninguno frena la generación —no
se puede no generar por un error de tipeo— y ninguno se calla:

- **la referencia ya no está en la lista** (la mencionaste y después la borraste): el modelo
  lee *«paleta.png» (referencia que ya no está adjunta a este pedido)*, y no el número de la
  imagen que quedó en ese lugar. En el panel, en rojo.
- **el archivo no está en el disco** (el disco externo desmontado): esa imagen no viaja, así
  que no ocupa número; se dice, y el aviso de siempre sobre las referencias que no se
  pudieron leer sigue saliendo por su cuenta. En el panel, en ámbar.
- **el nombre está en dos niveles y la mención no dice cuál** (solo pasa escribiéndola a
  mano: el panel siempre escribe el ámbito): va la primera en llegarle al modelo, y se dice
  cuál se eligió.

Un **documento** mencionado no recibe número, porque los documentos no se numeran: se
traduce a *el documento «manual-de-marca.pdf»*, que es exactamente como lo nombra el prompt.
Con eso siguen valiendo las reglas de siempre: un `.md` se pega en el pedido y llega por
cualquier proveedor; un PDF solo llega por los dos CLI de agente, y con los otros tres se
avisa antes de gastar la llamada.

Un detalle que no es cosmético: si mencionás una imagen marcada **✓ usar**, la traducción
dice además cuál es su archivo — *imagen 3 (el archivo assets/asset-01)*. El bloque de
assets del prompt lista los archivos embebibles pero no dice cuál es cuál, así que con dos
logos "usá la imagen 3" dejaba al modelo eligiendo entre dos.

Y el **✨ Refinar** no puede perder una mención: si el refinador devuelve un texto al que le
falta alguna, se rechaza y queda el original, con el motivo escrito. Un modelo chico
reordena y reescribe —es para lo que está— y un token con corchetes es justo lo que le da
ganas de "arreglar"; una mención a medias llega al modelo como texto suelto y el gráfico
sale sin la marca.

La evidencia de punta a punta —proyecto real, panel real, motor real, y un solo doble: el
proveedor, que anota lo que recibió— se rehace con
`node test/manual/menciones-al-modelo.js`, que imprime **el prompt real** de cada caso.

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

## Fondo o alpha

Un marcador se genera **sin fondo** (`.mov` con **alpha**, transparente, para que quede
como overlay sobre tu imagen) o **con fondo** (`.mp4` opaco HD, fondo minimalista temático
con buen contraste). Es la única decisión de salida que hay que tomar, y se toma por
marcador con el toggle **Con fondo** de la tarjeta.

**Todo se renderiza siempre en alta**: el alpha en **ProRes 4444** y el mp4 con fondo en
H.264 con calidad de lectura (`--crf 18`), que es lo que hace falta cuando el gráfico se
va a ver proyectado en una clase. No hay dial de calidad, ni casilla que apagar, ni nada
que rehacer después de aprobar una animación.

Hubo un **modo borrador** —render más liviano para previsualizar, con su **Render HQ**
para rehacer en alta lo que hubiera gustado— y se sacó en la v1.4.49. Nunca sirvió mucho:
solo tocaba al mp4 con fondo (los clips con alpha ya salían al máximo, así que para ellos
borrador y alta eran el mismo archivo), y a cambio metía dos calidades posibles y dos
etiquetas de color en el timeline para poder distinguirlas. Los clips que se hicieron en
borrador **quedaron como están**, en café: si querés alguno en alta, regeneralo.

## Optimización de tokens

- **Refinar / Feedback** usa prompt *lean*: **no reenvía el transcript completo** de la
  clase (el modelo se apoya en el HTML previo + el fragmento del marcador). **Generar** y
  **Regenerar desde cero** sí mandan el contexto completo, porque no hay diseño previo.
  El **fragmento del marcador viaja siempre**, en toda llamada y ronda de feedback: es lo
  único que dice qué se está diciendo mientras el recurso está en pantalla y en qué
  segundo de la animación pasa cada cosa (con los tiempos **relativos** al arranque del
  clip). Si esa secuencia no está cargada en el panel —un job que quedó de otra sesión, o
  una corrección de un corte que nunca abriste acá—, el transcript se **recupera de su
  carpeta** antes de llamar al modelo.
- **Las imágenes NO son un lugar donde ahorrar**: se reenvían siempre (ver arriba). En la
  ronda de feedback de la Cola cada miniatura tiene su **reenviar** por si querés dejar alguna
  afuera a propósito; las marcadas **✓ usar** se **incrustan igual**, viajen o no.
- La **continuidad** con otros marcadores solo se inyecta si la instrucción lo pide
  (retomar/continuar/mismo estilo, o nombrar un marcador), no siempre. Nombrando el
  marcador gastás **más por recurso pero en el correcto**: va uno entero (~3k tok) en vez
  de dos ajenos recortados a la mitad.

## Cómo se lee el panel (v1.6.0)

El panel hace tres trabajos y hay que poder distinguirlos de un vistazo: **decidir** (los
tres alcances de prompt), **escanear** (la cola) y **confirmar** (estados, costos,
estimados). Hasta la v1.5.3 los tres se leían al mismo volumen. Medido sobre la maqueta a
400×700: **nueve** tamaños de letra a la vez, cinco pesos, **quince** colores de texto, y
los dos tamaños que cargaban el 60 % del texto se diferenciaban en **un píxel** (11 y 12).
Eso no es jerarquía, es ruido parejo. Y peor: el nivel que WCAG no aprobaba —2.84:1— era el
que cargaba la **estructura**, o sea cada rótulo de campo y cada título de sección.

Ahora son **tres niveles de voz** construidos con **peso y color**, con el tamaño casi
quieto (13 / 12 / 11 px). El tamaño no puede ser el canal y no es una elección: en 400 px de
ancho el techo tipográfico son ~15 px y el piso legible 11, así que el rango da tres pasos
de un píxel, y un paso de un píxel no se lee. Es el mismo modelo del escritorio de Apple,
donde Body y Headline miden **los dos** 13 pt y solo cambian de peso.

Lo que se movió, medido con las herramientas de `test/manual/panel-demo` (`auditar.js` mide
contraste real sobre el DOM, altos de fila y presupuesto vertical; `medir-botones.js`,
desborde y solapes caja por caja):

| | antes | ahora |
| --- | --- | --- |
| textos que no llegan a AA (por vista) | 52 a 71 | **0** |
| el peor contraste del panel | 1.75:1 | **4.83:1** |
| tamaños de letra a la vez | 9 | **4** |
| rótulos en MAYÚSCULAS | 10 | **0** |
| cromo fijo a 400 px de ancho | 232.5 px (33.2 %) | **150.9 px (21.6 %)** |
| cromo fijo a 320 px | 277.3 px (39.6 %) | **182.9 px (26.1 %)** |
| fila de marcador plegada | 55.5 px | **32.8 px** |
| marcadores que entran sin scrollear | 3 | **7** |
| controles por debajo de 24×24 px (SC 2.5.8) | 40 de 154 | **7 de 225** |
| el peor contraste de las vistas de marcadores | 1.75:1 | **5.53:1** |

Los siete que quedan son las casillas nativas de 16×16 (*Con fondo* y las etiquetas de las
miniaturas): reemplazarlas pide un control propio en el HTML y quedó pendiente. Los blancos
de clic pasaron de 153 a 225 —los controles de la ficha nueva y las referencias heredadas—
y ninguno de los nuevos entró por debajo del mínimo.

### Y el interior de la ficha

Lo de arriba ordenó la *voz* del panel; adentro de la ficha de un marcador la
**distribución** seguía siendo la vieja, y el editor lo dijo sin vueltas: *"dejamos mucho
espacio vacío"*, *"deberíamos tener un área de controles y otra de input"*. Tenía razón, y el
número lo explica: arriba del campo había **90 px de cromo** —una zona de arrastre de 52 px
que repetía una instrucción que se aprende la primera vez, un botón *Capturar del programa*
de ancho completo, y la separación entre los dos— para un campo de escritura de 72.

Ahora la ficha es, de arriba a abajo: **la tira de referencias** · **el campo**, de 110 px ·
**el aviso de menciones** · **la barra de controles** (dictar, refinar, capturar, adjuntar,
*Con fondo*, todo en un renglón y con iconos de trazo) · un desplegable **Avanzado** con el
transcript del tramo y el editor de HTML · y el **pie**, con *Generar* en el vértice de abajo
a la derecha, *Enviar a la cola* a su izquierda y *Regenerar desde cero* en la otra punta.
Los 90 px del cromo se los quedó el campo. Con la tira vacía no ocupa nada: lo que dice que
se puede arrastrar un archivo es el `placeholder` del campo, que se está viendo justo
entonces.

Y **el encabezado de la ficha lleva los cuatro datos** que se quieren ver sin desplegarla:
el nombre y lo que **tardó** la última versión a la izquierda; el tramo, lo que va a
**costar** mandarla y el estado a la derecha. Los dos datos de confirmación vivían en una
fila del cuerpo, o sea que se veían solo con la ficha abierta y a cambio de una fila de
alto. Ahora se leen con la ficha **plegada**, que es cuando de verdad sirven: mirás la lista
y ves cuál costó cuánto. A 320 px no entra todo, así que el orden de prioridad está escrito:
el nombre y el estado no se caen nunca, el tramo cede después, y los dos datos de
confirmación son los primeros en recortarse — se quedan con su número (`v3: 4m 12s`,
`≈ 41k`) y sueltan el desglose por etapa, que aparece a partir de 640 px y sigue entero en
el tooltip. Medido: la fila plegada sigue midiendo **32.8 px** y siguen entrando **siete**
marcadores en el primer viewport.

Y **"Regenerar desde cero" pregunta siempre**, igual que el de la caja de feedback de la
Cola. Acá hacía más falta que allá: está en la misma fila que *Generar*. Están en las dos
puntas, pero un clic de más sigue tirando una animación que estaba bien y arrancando una
generación completa. La pregunta dice las tres cosas: que se descarta el diseño anterior, lo
que cuesta, y —si hay algo escrito en el campo— que ese texto se usa como la instrucción del
marcador pero **no** como un ajuste sobre la versión anterior.

Y es **un solo cuerpo de ficha** (`cep/js/prompt-card.js`) para los tres lugares donde se le
pide algo al modelo: la instrucción del marcador, *Estilo del curso* y *Estilo de esta
secuencia*. Los tres tienen su tira de referencias arriba del campo y su barra de controles
abajo; los dos de estilo no tienen pie, porque no generan nada. Antes eran tres layouts para
el mismo problema.

Se archivan (en `test/manual/panel-demo/capturas-1.6.0/`) las capturas de la ficha cerrada,
abierta, con los chips de mención, con una mención que apunta a un archivo que no está, con un
documento mencionado, con el **menú del `@`** abierto y filtrado, con el **doble clic abierto**
como campo de texto y con un **número que no apunta a nada** en rojo, los dos bloques de
estilo, y el micrófono en sus tres estados, a 400 y a 320 px. Se rehacen con `node test/manual/panel-demo/capturar-ficha.js`, que **falla** si la
página tira un error de JS en vez de sacar la foto de un panel roto.

### Y las tres pestañas son la misma lista

**Marcadores**, **Cola** y **Corrections** son la misma cosa tres veces: una lista de
marcadores con su estado y sus acciones. Hasta la v1.6.0 estaban dibujadas con tres
gramáticas distintas, y la peor parte no era que fueran distintas: era que **la misma barra
de la izquierda quería decir dos cosas** según la pestaña. En Marcadores, una guarda de 2 px
decía «esta ficha está abierta». En la Cola, una de 3 px decía **el estado del trabajo**, y
esa columna alineada es lo mejor que tiene esa pestaña: es lo que permite barrerla con la
vista, que es su función. En Corrections no había guarda salvo la ámbar de «no sé dónde iba
este recurso», que es —otra vez— un estado.

**La guarda dice el ESTADO, en las tres.** Un canal, un significado. Dos de las tres
pestañas ya la usaban así, la que no la usaba para eso tenía dos canales para lo mismo (la
guarda y el chevron), y el estado es lo único que una fila plegada no puede mostrar de otra
manera. Lo que se pierde: la ficha de marcador abierta ya no se marca con la guarda. Se
marca con lo que ya venía marcándola —el chevron girado y el cuerpo desplegado, que es la
evidencia más directa que hay— más el **recuadro encendido** a `--border-field`, que es el
mismo 3.37:1 con el que la guarda cumplía el 3:1 que WCAG 1.4.11 pide para «whether a
component is selected or focused». O sea que el requisito se paga con el mismo valor, sobre
los otros tres lados, y el que cambia de trabajo es sólo el borde izquierdo.

**Y el estado no es sólo color en ninguna de las tres.** Al lado de la guarda va la
PALABRA: `en cola`, `por rendir`, `diseñando`, `rindiendo`, `listo`, `sin colocar`, `falló`,
`sin cupo`. Ocho situaciones, ocho palabras, **cinco** colores —lo que cambia de color es
qué *pide* el estado, no en qué etapa del pipeline está: modelar y renderizar son dos etapas
y un solo «está pasando ahora»—. Las escribe un solo lugar para las dos pestañas que
muestran el mismo trabajo, y hacía falta: el `⏳` quería decir «está corriendo» en la ficha
del marcador y «se quedó sin tokens» en la Cola.

De paso se arregló algo que el CSS daba por imposible y tenía escrito como tal: un trabajo
**terminado sin colocar** llevaba la misma guarda verde y el mismo «listo» que uno que
entró al timeline, porque las dos filas tenían la misma clase. Ahora se distinguen —la
distinción la hace la misma función que decide si ofrecer **Colocar**— y esa fila queda en
ámbar diciendo `sin colocar`, que es lo que es: falta hacer algo.

**El cuerpo es uno.** La caja de feedback de la Cola y la fila de Corrections tenían las dos
un campo de prompt con su micrófono, su refinado y sus imágenes: o sea el mismo problema que
la etapa anterior ya había resuelto para la ficha del marcador, resuelto otras dos veces.
Ahora las cuatro fichas son `HPPromptCard` con otras acciones, y con eso las dos pestañas
**ganan tres cosas que ya existían y que nadie les había cableado**: los chips que muestran
las menciones, el aviso de la mención colgada y la canonización del ✨. No es un agregado
cosmético: el motor traduce las menciones del campo de ajuste igual que las de la
instrucción de un marcador, así que un `@[curso/logo-platzi.svg]` escrito en la caja de
feedback **ya viajaba traducido** y el panel no lo pintaba ni avisaba si quedaba colgado.

Con el cuerpo compartido se fue **la última zona de arrastre** del panel (52 px punteados
para repetir una instrucción que se aprende la primera vez) y el último botón **📸 Capturar
del programa** de ancho completo (30 px de fila propia): los dos eran del cuerpo viejo y
seguían vivos en esas dos pestañas. Ahora el archivo se suelta sobre el campo y queda
**mencionado** donde estaba el cursor, y capturar y adjuntar son dos iconos de la barra de
controles. Los 82 px se los quedó el campo, que pasó de 34 px en la Cola y dos renglones en
Corrections a **tres renglones enteros** en las dos.

Lo que sigue siendo de cada pestaña, porque son interacciones distintas:

- **La Cola** lleva sus acciones en el ENCABEZADO y no en el pie, que es lo contrario de la
  ficha de un marcador. Es a propósito: *Reintentar* el que falló, *Colocar* el que no entró
  y reordenar los que esperan se aprietan mirando la lista, con la fila plegada. Y el
  mensaje de estado, la línea de «qué está haciendo ahora» y la barra de progreso viven
  **adentro del encabezado**, no del cuerpo plegable: un desplegable esconde todo lo que va
  después de su resumen, y el `✓ Listo y colocado (v3) · 4m 12s (IA 3m 05s · render 1m 07s)`
  de un trabajo terminado tiene que leerse sin abrir nada.
- **Un mensaje que no dice más que la pastilla no se dibuja.** «En cola…» al lado de una
  pastilla que dice `en cola` son 19 px por fila para repetir la palabra que está tres
  centímetros a la izquierda; en una cola de diez trabajos en espera, un tercio de la
  pantalla. Los que sí dicen algo («Reencolado, esperando turno…») se siguen viendo.
- **Corrections se pliega.** Era la fila más cargada del panel y estaba toda desplegada:
  mediana medida **487.7 px**, o sea que con seis recursos generados —una clase normal— hay
  casi 3.000 px de scroll para encontrar el que hay que corregir, y para encontrarlo alcanzan
  el nombre y el segundo en que entra. Ahora el encabezado dice nombre · tramo · versiones ·
  estado, y abrir una cierra las demás (el mismo acordeón de la lista de marcadores). Abierta
  muestra exactamente lo que mostraba.
- **Y su pastilla dice otra cosa**, porque acá no hay trabajo en curso: dice si de esa versión
  se **puede saber** con qué se generó (`listo`) o si lo que se ofrece es una reconstrucción
  de los archivos de hoy (`reconstruido`), que antes sólo se veía abriendo el desplegable del
  contexto de a una fila.

**Los emojis que quedaban** eran los de estas dos pestañas, y el problema era el de siempre
con otra cara: **tres botones con el mismo `↻`** para tres cosas que no se parecen. Son tres
significados y ahora son tres dibujos:

| | qué es | el dibujo |
| --- | --- | --- |
| **Aplicar el ajuste** | rediseñar SOBRE lo que hay, con lo que escribiste | dos rieles con su perilla |
| **Regenerar desde cero** | tirar el diseño y volver a diseñar | el lazo que vuelve al principio |
| **Reintentar** | el trabajo FALLÓ: lo mismo otra vez, desde donde se cayó | dos flechas encadenadas |
| **Reactivar** | no falló, se quedó sin cupo: vuelve a la cola como estaba | la flecha que entra a la lista |

Y lo mismo el `✎`, que estaba en dos botones que hacen cosas distintas —*Feedback* y *Editar
HTML*—: un globo de diálogo y un `< >`. El `📌` de *Colocar* es una flecha que baja a una
pista; el `🧹` de limpiar versiones viejas es un cesto, porque eso **borra archivos del
disco**, y el `⏹` de *vaciar cola* es la lista con una ✕, porque eso **no borra nada**: saca
todo de la lista. Dos dibujos se repiten a propósito, y por el mismo motivo por el que
*generar* y *encolar* se repiten entre la ficha y la barra de arriba: son la misma acción con
otro alcance (limpiar un recurso o todos; iniciar la cola o reanudarla).

El `📤` de cada miniatura también pasó a ser un icono, y **hace exactamente lo mismo**:
decide si esa imagen viaja en este pedido. Lo que cambió es que ahora hereda el color del
estado, que es justo lo que un emoji no puede hacer.

**Lo que costó, medido.** Con los mismos diez trabajos en la cola y los mismos seis
recursos en Corrections, a 400 px de ancho:

| | antes | ahora |
| --- | --- | --- |
| la lista de la Cola, entera | 951 px | **1.145 px** |
| ídem a 320 px | 1.048 px | **1.259 px** |
| la fila de un trabajo en espera | 2 renglones | **1 renglón (34 px)** |
| la lista de Corrections, entera | no entraba en una ventana de 1.500 px | **885 px** |
| ídem a 320 px | no entraba | **929 px** |
| fila de marcador plegada | 32.8 px | **32.8 px** (no se movió) |
| textos por debajo de AA en las tres pestañas | 0 | **0** |
| el peor contraste de las tres | 5.53:1 | **5.53:1** |
| controles por debajo de 24×24 px en la Cola | 0 de 40 | **0 de 41** |
| ídem en Corrections | 0 de 105 | **0 de 105** |
| botones con el texto pintado afuera de su caja (23 vistas × 4 anchos) | 0 | **0 de 13.511** |
| solapes | 0 | **0** |

**La Cola creció un 20 %**, y hay que decirlo con nombre: son ~19 px por fila y salen del
recuadro (1 px arriba y abajo más los 4 del `gap` de la lista) y del renglón que a veces se
lleva la pastilla del estado. Lo que se compró con eso: la misma gramática que las otras dos
pestañas, el estado en palabras, lo que costó cada trabajo, y que la fila que se repite diez
veces en una cola larga —la que está en espera— pase a UN renglón, que antes eran dos.
A 320 px cede el número del costo, que es lo que el orden de prioridad del encabezado dice
que cede primero; sin eso la lista medía 1.345 px en vez de 1.259.

**Corrections se redujo a menos de un tercio** y es donde el cambio se siente: encontrar el
recurso que hay que corregir era scrollear 3.000 px de formularios abiertos.

Las capturas del antes y el después de las dos pestañas, a 400 y a 320 px y con la cola
mostrando los siete estados a la vez, se rehacen con
`node test/manual/panel-demo/capturar-listas.js --prefijo antes|despues`. El alto de una
lista se mide sobre las capturas con `medir-capturas.js`, y eso es a propósito: las tres
etapas de la 1.6.0 se hicieron sobre el árbol sin commitear, así que el «antes» de cada una
no se puede volver a correr — lo único que queda de él son las fotos, y una foto sí se puede
medir (se busca la última fila de píxeles que no es el fondo del panel).

**La Cola, antes y ahora, a 400 px** (los diez trabajos, en los siete estados):

![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/antes-cola-400.png)
![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/despues-cola-400.png)

**Y a 320 px**, que es donde el panel acoplado aprieta de verdad:

![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/antes-cola-320.png)
![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/despues-cola-320.png)

**La ronda de feedback de un trabajo terminado**, que es la que pasó a ser el cuerpo de
ficha compartido (antes / ahora, a 400 px):

![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/antes-cola-feedback-400.png)
![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/despues-cola-feedback-400.png)

**Corrections, antes y ahora, a 400 px.** Es el cambio más grande de la etapa: seis filas
abiertas contra seis filas que se pueden barrer.

![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/antes-corrections-400.png)
![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/despues-corrections-400.png)

**Y a 320 px:**

![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/antes-corrections-320.png)
![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/despues-corrections-320.png)

**Una fila de corrección abierta**, con su contexto y su editor de HTML desplegados (antes /
ahora, a 400 px): lo que muestra es lo mismo, y ahora hay que abrirla.

![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/antes-corrections-abierta-400.png)
![](/Users/danielgutierrez/Desktop/Codigo/HyperPremiere/test/manual/panel-demo/capturas-1.6.0/despues-corrections-abierta-400.png)

**El inventario de referencias ya no se esconde detrás de un scroll.** La caja de los dos
bloques de estilo estaba acotada a 108 px con barra propia, y era lo peor del sistema: escondía
contenido con la barra como única señal. Existía por un número medido —el inventario del curso
empujaba el campo de la clase 234 px hacia abajo— pero 90 de esos 108 px eran el botón y la zona
de arrastre, que ya no están. Sin techo y envolviendo, cuatro referencias miden 68 px a 400 px de
ancho: **40 menos** que el techo que las escondía, y sin esconder ninguna.

Dos cosas más que salieron de mirar los números:

- **El número que mostraba una referencia del curso era el equivocado.** Cada caja numeraba
  dentro de su propio nivel, y el modelo numera el pedido entero (marcador → curso → clase):
  con dos capturas en el marcador, la "imagen 1" del curso era la **imagen 3** para el modelo.
  O sea que el número que el panel ofrecía para copiar era, casi siempre, otro. En los bloques
  de estilo el número se fue (ahí no se puede saber: depende de qué marcador esté generando) y
  en la ficha del marcador se muestran **todas** las que viajan, en su orden, con su número de
  verdad.
- **Los `position: sticky` de los tres encabezados se fueron.** El número que los motivaba lo
  arregló otra cosa: con un marcador abierto, el acordeón pliega los tres bloques y los tres
  encabezados quedan a la vista sin scrollear. Un `sticky` que no despega nunca es una capa de
  apilamiento y una superficie opaca que hay que mantener sincronizada, a cambio de nada.

Dos bugs de raíz se fueron en el camino, los dos por la misma causa —una regla y su
contra-regla en el mismo archivo—: la tarjeta de marcador tenía **doble padding** (una regla
vieja la redefinía sin resetear el `padding: 9px 12px` de la original, así que el nombre
quedaba a 17 px del borde) y **doble separación** entre tarjetas (`gap: 6px` de la lista más
`margin-bottom: 6px` de la tarjeta = 12). Juntas explicaban casi todo el 55.5 → 32.8.

La propuesta de la que salió todo esto, con su tesis, sus fuentes y sus capturas del antes y
el después, quedó en `test/manual/panel-demo/temas/estudiado/` para poder comparar.

## Qué dice el contador de la sesión, y dónde vive

**Está en ⚙, al final de la lista, y en el encabezado queda solo el monto.** Hasta la
v1.5.3 era una franja fija a lo ancho del panel: 40.5 px de alto permanentes —el 6 % de un
panel de 700— para un renglón que se mira una vez por sesión. Ahora el detalle entero
(entrada, caché, salida, costo, generaciones, el desglose y el botón de **reiniciar**) vive
adentro de ⚙, y arriba queda el **$15.37** pelado, como pastilla al lado del nombre de la
secuencia, para no perder el aviso de que estás gastando. El monto **solo se dibuja si hay
costo informado**: con Cursor, que va por suscripción y no informa ninguno, el encabezado
queda igual que si esta línea no existiera. Y el desglose, que antes era un tooltip, en ⚙
se lee escrito: si abriste el diálogo y bajaste hasta ahí, es porque lo querés leer.

La barra **Sesión** mostraba una fracción de lo que pasaba. Con 164 generaciones encima
marcaba *75.256 tokens de entrada · 2.341.682 de salida*: 459 de entrada por generación,
cuando cada una manda el objetivo de la clase, el fragmento del transcript, la instrucción
y las imágenes. La salida estaba bien; la entrada no estaba mal calculada, estaba **mal
leída**.

Los CLI de agente parten la entrada en tres, y `inputTokens` —el que se estaba mostrando—
es solo el pedazo que **no** estaba cacheado. El resto viaja por los campos de caché. Se
ve mejor que en ninguna explicación en la llamada más chica que se puede hacer, un prompt
de veinte caracteres a `cursor-agent`:

```json
{ "inputTokens": 2, "outputTokens": 4, "cacheReadTokens": 0, "cacheWriteTokens": 31823 }
```

Esos 31.823 son el contexto del propio agente. En una generación de verdad los tres
conviven —4 sueltos, 84.015 leídos de caché, 49.316 escritos— y el contador mostraba **4**.

Ahora la línea dice la entrada **completa**, y aparte cuánto de eso fue caché, que es lo
que explica por qué la entrada real es diez veces el prompt que armamos: es contexto que el
agente vuelve a leer en cada llamada, no algo que podamos recortar. El desglose de ⚙ desarma los
tres números, da el promedio por generación y aclara el **costo**, que también engañaba:
Cursor va por suscripción y no informa costo, y la API de Anthropic no lo devuelve, así que
un "$15.37" pelado se leía como el costo de la sesión entera cuando en realidad cubría doce
de ciento sesenta y cuatro generaciones. Se dice: `$15.37 en 12 de 164`.

Una advertencia para el día de la actualización: **el acumulado que ya tenías no se puede
reparar hacia atrás** (los tokens de caché de esas generaciones no los guardaba nadie), así
que queda marcado como mezclado —lo dice el ⬇ Log al abrir y el desglose de ⚙— hasta que
toques **reiniciar**, que está al lado del renglón, en ⚙.

Un detalle de dónde quedó: el bloque va al **final** de la lista de ⚙ y no en el medio. Es
una lectura entre ajustes, y ⚙ ya tiene 214 elementos en el primer viewport; meterle 200 px
de números entre el selector de modelo y el nivel de pensamiento sería empujar hacia abajo
justo los dos controles que sí se cambian. De ahí en adelante, todo se cuenta igual.

El mismo gasto se lleva además **por proveedor**, y de ahí sale el "una generación con X
gastó ≈ N" que dice ⚙ debajo del selector de modelo. Va aparte del total porque el promedio
solo quiere decir algo adentro de una puerta: medido acá, la misma clase da **≈ 92k de
entrada por generación con Claude** y **≈ 128k con Cursor**, y la diferencia no es del
prompt —es idéntico— sino del contexto que el agente de Cursor arrastra en cada llamada.
Mostrar el promedio de uno como si describiera al otro es el mismo tipo de error que
mostraba `inputTokens` a secas. Va por proveedor y no por modelo porque lo que domina es de
quién es la puerta, y porque en Cursor el ID del modelo cambia con el nivel de pensamiento:
por modelo, la muestra se partiría en pedazos de una o dos generaciones.

Estos bolsillos **nacen vacíos**: el acumulado que ya tenías no se reparte entre proveedores
—no se sabe de cuál salió cada generación, y encima tiene la entrada contada a medias—, así
que hasta que generes de nuevo ⚙ dice *"todavía no generaste con esto, así que no sé cuánto
gasta acá"*. Es la respuesta honesta; un promedio prestado del otro proveedor no lo es.

De paso se arregló el **estimado de la cola**, que se calibraba con esto. Dividía el costo
acumulado por esos tokens de entrada de mentira, así que le salía una tarifa de cientos de
dólares por millón. Ahora promedia **por generación** y solo sobre las que informaron
costo, que son las únicas donde están las dos mitades de la cuenta. Y la línea de tokens de
la cola dice lo que de verdad estima —**el prompt que mandamos nosotros**—, porque el
contexto del agente no lo podemos prever.

**Los dos estimados de antes de gastar cuentan el pedido entero.** El `≈ N tokens de
entrada` de la tarjeta del marcador y el del pie de la Cola se arman con **el mismo cuerpo
que se le manda al modelo**: los dos prompts generales —el del curso y el de la clase—, el
objetivo, el encargo, el guion del tramo, el ajuste de una corrección y **todas** las
imágenes que viajan, las del marcador y las del prompt general. Antes cada uno se lo
armaba por su cuenta y se quedaban atrás: con un prompt de curso de 7 kB y dos imágenes de
marca, la tarjeta decía ≈4.875 y se mandaban ≈9.207 —**47% corto**, y siempre para el mismo
lado—, y en la Cola una corrección recién encolada se estimaba sin ningún nivel de contexto
hasta que el job arrancaba. Sigue siendo un estimado (el prompt del sistema y la respuesta
no se pueden saber de antemano), pero ya no es el de otro pedido. Y **refinar se estima
como refinar**: ese prompt es más chico y el número lo dice.

**Y cuentan lo que va a viajar, no lo que se adjuntó.** El estimado no multiplica listas
por un fijo: le pregunta a las mismas funciones que arman la llamada. Una imagen que el
manifiesto nombra y el disco no tiene **no se cobra** —es el disco externo desmontado, y el
renglón de al lado ya está avisando que ese archivo no está—; un documento de texto se
cuenta por **lo que se pega en el prompt** (hasta 20.000 caracteres, ≈5.000 tokens) y no por
un fijo; y un PDF se cuenta **según el proveedor elegido**: con `claude-cli` o `cursor-cli`
viaja y cuesta, con `ollama` no viaja y no cuesta. Los tres eran el mismo bug con tres
caras: un número fijo donde había que mirar el contenido. Medido: con un `.md` de marca de
26.600 caracteres el semáforo decía 5.131 y se mandaban 8.679 —**41% corto**—; ahora da el
mismo número que se paga. Con una referencia borrada del disco cobraba 3 imágenes y viajaban
2: **2.064 tokens de más**.

## La línea de estado aparece cuando pide acción

Arriba de todo había una franja fija de **47 px** que decía cosas —"7 marcadores cargados",
"Cola vaciada", "Log descargado en: …"— y arrancaba con un *"Pulsá Cargar marcadores para
leer la secuencia activa"* que repetía el botón que está tres centímetros más arriba. De los
**23 avisos** que la escriben, **20 son informativos** y **tres** paran de verdad y piden
que decidas algo: *no generé nada todavía porque hay referencias en esta máquina*,
*cancelaste la transcripción, así que no generé nada* y *la secuencia activa no tiene
marcadores*.

Desde la v1.6.0 la franja **no ocupa lugar cuando no hay nada que atender**, y hay tres
clases de mensaje:

- **informativo** — se muestra un rato y se esconde solo. El rato se calcula por largo del
  texto (4 s más 60 ms por carácter, con techo de 15), que es holgado contra las ~17
  letras por segundo de la lectura corrida. No desaparece del todo a propósito: la mitad de
  estos mensajes son el acuse de un clic, y un clic sin respuesta visible se lee como un
  panel colgado. Uno además trae un dato que hay que leer una vez (la ruta donde bajó el
  log).
- **paré y hay que decidir** — se queda, en ámbar. Son esos tres, y los tres terminan en una
  pregunta: esconderla a los ocho segundos sería esconder la pregunta.
- **falló** — se queda, en rojo.

Y **todo** lo que pasa por ahí queda en el **⬇ Log**, también lo que se esconde solo: la
franja es el aviso, el log es el registro. Así que esconder lo informativo no pierde nada.

Dos cosas más, que son las que hacían falta para que esto no empeorara otra cosa:

- **La franja se mudó abajo, afuera de las tres pestañas.** Arriba, aparecer empujaba 30 px
  hacia abajo *todo* el contenido —los tres bloques de contexto, el rótulo y la lista—.
  Abajo, lo único que cambia de tamaño es la vista, que cede esos píxeles del área que
  scrollea. Medido elemento por elemento a 320, 400 y 600 px con un mensaje de dos
  renglones: de las **935 cajas** del panel se mueve **una**, que es la franja apareciendo.
  Cero salto.
- **Y ahora sirve para las tres pestañas.** Vivía adentro de la vista de *Marcadores*, así
  que los mensajes que escribe la **Cola** ("Escribí qué ajustar…", "Cola vaciada") se
  pintaban en una vista **escondida**: no los veía nadie. Eso era un bug y se fue con la
  mudanza.

Sigue siendo la región `aria-live` del panel, y el texto se escribe **después** de
mostrarla: una región escondida no anuncia lo que le cambia adentro.

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
  no era el cuello, cada worker extra era otro Chrome que arrancar. Con cuántos workers
  conviene en **tu** máquina ya no se supone: se aprende de tus propios renders (ver
  **Con cuántos workers conviene renderizar**). Mientras aprende, los carriles se quedan
  quietos — si cambiaran de render en render, cada medición se habría tomado con otra
  cantidad de Chrome al lado y no habría con qué comparar.
- **Lo que toca Premiere va de a uno.** Importar el video, colocarlo y agregar pistas
  comparten el bin de la secuencia y las pistas, así que esas escrituras se serializan
  aunque los renders vayan en paralelo (cuesta ~1s por clip y la ganancia queda intacta).
  Sin eso, dos colocaciones simultáneas podían dejar el video de un marcador en otro,
  sin ningún error: Premiere no siempre materializa el import de inmediato. Por lo mismo
  el clip importado se busca por su **ruta de media** y no por nombre ni por posición.
- **Colocar NUNCA sobrescribe tu material.** La animación va siempre a la pista de video
  de más arriba, y el clip solo se escribe sobre un tramo de pista que el panel **acaba
  de verificar libre**. Si esa pista tiene algo ahí, se agrega una nueva encima —y si por
  lo que sea no se pudiera agregar, **el panel no coloca nada**: te lo dice en la fila del
  marcador y en el ⬇ Log, con el tramo exacto y qué hacer. Un marcador sin colocar se
  arregla en dos clics (el video ya quedó importado en el bin **HyperPremiere › tu
  secuencia**: lo arrastrás y listo); un clip borrado del timeline, no.
  Esto **funciona igual si estás parado en otra secuencia**, que es lo normal mientras se
  renderiza. Las pistas solo se pueden agregar en la secuencia que está al frente, así que
  el panel pasa un instante a la de destino, agrega la pista y **te devuelve a la tuya**,
  sin tocarte el cursor de reproducción ni la selección. Y solo lo hace cuando de verdad
  falta la pista: en cuanto existe, los marcadores que siguen caen ahí sin que la vista
  se mueva. (Hasta la v1.4.30 este era el bug grave del panel: con la secuencia de destino
  inactiva, la pista no se agregaba y el clip se colocaba **encima**, borrando el que estaba.)
- **Colocar tampoco te reacomoda la secuencia.** Pista de **audio** se agrega únicamente si
  el archivo que está colocando trae sonido, y va al final para que A1, A2… sigan
  siendo las mismas. Antes aparecía un "Audio N" vacío en cada colocación: el comando de
  Premiere que agrega pistas suma **una de audio por defecto** si no le decís que no.
  Si el archivo tiene audio (una animación con música o voz), Premiere baja el clip
  entero, video y audio, y si no hay ninguna pista de audio libre donde caiga tampoco se
  coloca: pisarte el sonido es tan grave como pisarte el video. Quién trae audio y quién
  no lo mira el motor con `ffprobe` antes de llamar: adentro de Premiere no hay con qué
  abrir el archivo.
- **El panel solo toca clips que son suyos, y no te pinta el timeline.** El clip importado
  se identifica por su **ruta de media** y no por nombre ni por posición, así que ninguna
  operación nuestra puede agarrar un clip tuyo por error. Y salvo las correcciones —que
  entran en **amarillo** a propósito, para que se vean entre los que ya estaban— los clips
  llegan **sin etiqueta de color**: los colores de tu secuencia significan lo que vos
  quieras.
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
  job queda **esperando tokens** —la fila lo dice con la palabra `sin cupo`— con
  **Reactivar** (individual o todos).
- **Ver**: clic en el nombre del clip terminado → abre esa secuencia y **para el cursor
  donde está el recurso**, y nada más. Es para mirarlo: el panel se queda en la Cola. (A
  la pestaña Marcadores se llega con **Editar HTML**, que es el que la necesita.)
- **Feedback** abre la ronda ahí mismo —es el cuerpo de ficha compartido, el mismo de un
  marcador— con las **dos salidas** de siempre: **Aplicar el ajuste** trabaja sobre la
  última versión con lo que escribiste, y **Regenerar desde cero** la descarta y vuelve a
  diseñar con la instrucción y el material de hoy. Las dos van en el **pie de la ficha**
  (v1.6.0): el ajuste a la derecha y destacado, porque es la de todos los días, y desde
  cero a la otra punta, chico y gris, porque descarta
  trabajo hecho. No dice "Refinar" a propósito: el **✨ Refinar** del dictado queda a
  seis píxeles y hace otra cosa —reescribe el texto del pedido, no la animación—, y
  además "aplicar el ajuste" se lee como lo contrario de "desde cero", que es lo que son.
  El ajuste **con el cuadro vacío avisa** en vez de rediseñar por su cuenta,
  y desde cero **pregunta siempre** —están pegados y las dos palabras se parecen, así que
  errarle es esperable y un clic de más tiraría una animación que estaba bien—, aclarando
  además que el feedback escrito ahí no se usa.
- **Ver solo esta secuencia**: filtro en la cabecera, cuando la cola tiene marcadores de
  más de una. Solo cambia lo que se dibuja —los contadores de arriba siguen siendo de toda
  la cola y todo se procesa igual— y se recuerda entre sesiones.
- **Estimado** al pie: tiempo, tamaño del prompt y **costo** aproximados de lo pendiente
  (el tiempo y el costo se auto-calibran con el uso real; ver **Qué dice el contador de la
  sesión**).
- **Persistencia por proyecto**: la cola se guarda en
  `<carpeta-del-.prproj>/HyperPremiere/queue.json` y se recarga al reabrir. El transcript
  va aparte, por secuencia, en `HyperPremiere/<secuencia>/transcript.json`.

## Corrections: corregir lo que ya mandaste

La pestaña **Corrections** es para el momento en que la clase ya salió: la mandaste a
revisar, volvés con comentarios y **volver a abrir los marcadores no es opción** (los
borraste, los moviste, o la secuencia está llena de los de Frame.io).

Todo lo que necesita lo lee **del disco**, no de los marcadores:

- **Cargar secuencia** arma una fila por recurso ya generado con **en qué segundo entraba
  y cuánto duraba**, la última versión y con qué modelo se hizo. Ese tramo sale de la
  ficha `.meta.json` que se escribe con cada generación. La fila viene **plegada** y su
  encabezado es el de una ficha de marcador: nombre · tramo · versiones · estado (ver *Y
  las tres pestañas son la misma lista*). Abrir una cierra las demás.
- **Regenerar**: cada fila es una **ronda de feedback completa**, igual que en la Cola —es
  literalmente el mismo cuerpo de ficha, con su resaltado de menciones y su barra de
  controles—.
  Escribís qué está mal, **mandás imágenes nuevas** (arrastrando o con 📸 del programa),
  decidís con **reenviar** **cuáles viajan** y marcás las que se **incrustan** (✓ usar), y elegís
  **sobre qué versión** se rediseña (no siempre la última). Vuelve a su segundo original,
  con la misma duración.
  Las imágenes son las **del marcador en la secuencia donde nació**, incluso si estás
  parado en otro corte: es lo que hizo bueno al original y tiene que seguir viajando.
  Lo mismo con el resto del contexto: viaja **el encargo original** del recurso (lo que
  pediste cuando lo generaste, que la fila te muestra debajo del nombre) **además** de tu
  corrección, el **objetivo de la clase**, los **dos prompts generales** —el del curso y el
  de la clase, los mismos tres niveles de siempre— y el **tramo del guion** del corte donde
  nació (si no está en el panel, se recupera de su carpeta). Es la
  diferencia entre pedir "subí el título" sobre un gráfico que el modelo entiende y
  pedírselo a ciegas. Y **no se transcribe nada** para corregir: el corte viejo puede ya
  no existir en el proyecto, así que se usa lo que haya y la cola nunca se frena por eso.
- **▸ Lo que recibió este marcador**: el contexto con el que se generó, plegado en un solo
  renglón. Abierto son cuatro campos —**Prompt general · todo el curso**, **Prompt de
  secuencia · solo "<clase>"**, **Objetivo de la clase** y **Encargo de este marcador**— con
  el texto que viajó, editables. Está plegado porque la fila ya tiene bastante y esto es
  algo que se mira cuando hace falta, no siempre; lo que se necesita saber sin abrirlo está
  en el renglón del resumen. Ver el detalle abajo, en *Lo que recibió, y qué se puede saber
  de una versión vieja*. Y **cuál de los dos casos es** se lee ahora sin abrir nada: la
  pastilla del encabezado dice `listo` cuando la ficha guardó el contexto y `reconstruido`
  cuando lo que se ofrece son los archivos de hoy. Antes había que desplegar las seis filas
  de a una para saberlo.
- **Enviar a la cola** (al lado de Regenerar): la misma corrección, pero **en espera**.
  Sirve para revisar la clase entera —ir fila por fila escribiendo qué está mal— y largar
  todo junto con **Iniciar cola**, en vez de que la primera arranque mientras todavía estás
  revisando el resto. Es el mismo par que en las tarjetas de Marcadores: *Enviar a la cola*
  encola, *Regenerar* encola y arranca.
- **Ver y editar el HTML**: el de la versión que tengas elegida, **traído del disco** (la
  pestaña ya encontró los archivos, no te los pide). Sirve para ver qué tiene el recurso
  antes de escribir la corrección, para retocarlo a mano y renderizarlo **sin gastar IA**,
  o para pegar encima una versión que traigas de afuera. Sale en el **mismo formato** que
  el original (opaco si llevaba fondo) y **no borra el encargo**: la corrección siguiente
  sigue sabiendo qué era ese gráfico.
- **Clic en el nombre** del marcador: te lleva a ese punto del timeline de la secuencia
  que tenés abierta, para ver qué hay ahí antes de escribir la corrección.
- El clip corregido llega en **amarillo** y en una **pista nueva**, para verlo de un golpe
  entre los que ya estaban. Es la **única** etiqueta de color que el panel pone: lo que se
  genera normalmente entra sin pintar.

### Lo que recibió, y qué se puede saber de una versión vieja

Corregir es rediseñar, y para rediseñar hay que saber con qué se diseñó. Así que
**la ficha `.meta.json` guarda ahora los tres niveles y el objetivo** de cada versión —el
prompt del curso, el de la clase, el objetivo de la clase y el encargo del marcador—, y
`▸ Lo que recibió este marcador` los muestra tal como viajaron. Se guardan al preparar la
generación y se vuelven a escribir al terminar el render; el **render manual** (editar el
HTML a mano y renderizarlo) **no los guarda**, y no es un olvido: ahí no hubo modelo al que
mandarle nada, y una ficha que dijera lo contrario mentiría.

**Y por eso hay dos casos, que se dicen distinto.** El renglón del resumen es el único lugar
donde se dice cuál de los dos estás mirando:

| Lo que dice | Qué significa |
| --- | --- |
| `· lo que se mandó al generar la v4` (verde) | es un dato: salió de la ficha de esa versión, palabra por palabra |
| `· no quedó guardado: reconstruido` (ámbar) | de esa versión **no se puede saber** qué se mandó: se generó antes de que la ficha lo anotara. Lo de abajo son los archivos del proyecto **como están hoy**, que pueden haber cambiado desde entonces |
| `· ajustado para esta corrección` (ámbar) | lo tocaste vos, acá, y así va a viajar |

Cuando lo que se muestra **no coincide** con lo que el archivo del proyecto dice hoy, el pie
del campo dice **por qué**, y son dos motivos opuestos: o el archivo cambió desde entonces
(*"El archivo del proyecto dice otra cosa hoy: esto es lo que se mandó entonces"*), o ese
texto **nunca salió del archivo** porque se ajustó a mano para aquella corrección (*"Esto no
salió del archivo: se ajustó a mano para aquella corrección"*). El dato que los distingue lo
guarda la ficha, nivel por nivel, y por eso se puede decir cuál de los dos es: mientras se
decía siempre el primero, el panel le echaba la culpa a un archivo que nadie había tocado.

De una versión vieja, entonces, se puede saber **qué se le pidió** (el encargo ya se
guardaba) y **nada más**: si el prompt del curso decía otra cosa hace un mes, no hay dónde
mirarlo. La reconstrucción se ofrece igual porque es útil para escribir la corrección, pero
con el cartel puesto y en ámbar. La versión de al lado del mismo recurso puede estar en el
otro caso, y se ve: el rótulo nombra la versión (`al generar la v4`), no el recurso. El
renglón de estado de la pestaña lo cuenta de entrada: *"6 recurso(s) generados en … · 2 sin
el contexto guardado (se reconstruye)"*.

Lo que pesa, medido antes de decidir y no estimado: una ficha terminada pasa de **832 B** a
**1,4 kB** con un prompt de curso normal, y a **6,8 kB** con uno largo de 5,5 kB de texto. Un
proyecto de 20 recursos con 4 versiones cada uno son 80 fichas: **~530 kB** en el peor caso,
al lado de los `.mov` de decenas de MB que están en la misma carpeta. El texto se guarda
entero y sin recortar, porque una ficha con el prompt cortado a la mitad no sirve para lo
único que se le pide.

### Editar los prompts desde una corrección

Los cuatro campos se editan, y **lo que escribís ahí vale para esa corrección y nada más**:
el archivo del proyecto no se toca. Cada campo lo dice debajo en cuanto lo tocás —*"Ajustado
para esta corrección. El archivo del curso NO se toca"*—. El ajuste viaja con **ese** pedido
de regeneración, encima de lo que los archivos digan al momento de generar: la cola sigue
releyendo el estilo del proyecto (así que arreglar el prompt y reintentar sale con el
arreglado), y el ajuste se aplica después, solo sobre los niveles que tocaste. `⟲ Regenerar
desde cero` lo descarta, que es lo que quiere decir "desde cero".

No es una decisión de comodidad. El prompt del curso lo comparten **todas** las clases y
viaja en el `.prproj` a las máquinas de los demás editores; que se reescriba desde una fila
de correcciones —donde uno está pensando en un clip puntual— es la manera de cambiarle el
estilo a un curso entero sin darse cuenta. Ya pagamos un bug de esa familia (vaciar el campo
de una clase reescribía la base de todos, más arriba) y no se reintroduce por otra puerta.

Si el cambio tiene que quedar, hay una acción **aparte**, que aparece recién cuando hay algo
que guardar y en el mismo ámbar que Regenerar: **Guardar para todo el curso** debajo del
campo del curso, **Guardar para esta secuencia** debajo del de la clase. Pregunta antes, y
la pregunta dice a quién le llega: *"Pasa a ser el Prompt general del curso: lo van a usar
TODAS las clases de este proyecto y le va a llegar a cualquiera que abra el .prproj (el
archivo viaja al lado del proyecto). Se reemplaza lo que diga hoy."* Y abajo, la salida:
*"Si solo querés que valga para esta corrección, cancelá: el ajuste ya viaja con este pedido
sin guardar nada."* Cuando lo que tenés en pantalla salió de una ficha vieja y el archivo
dice **otra cosa hoy**, el aviso lo agrega: guardarlo pisa el texto actual, con los cambios
que le haya hecho otro editor. El texto que se guarda es el que el campo dice **cuando
aceptás**, no el que decía cuando apretaste el botón: la confirmación son cinco renglones y
en el medio se sigue pudiendo escribir.

Guardado, el archivo del proyecto cambió, así que **todo lo que lo estaba mostrando se pone
al día solo**: el bloque de estilo del encabezado, el resto de las clases del proyecto y las
**otras filas de la lista** que estaban reconstruyendo con ese archivo (las que muestran lo
que su propia versión recibió no se tocan —eso es historia, no una copia del archivo—, pero
su comparación con el archivo de hoy sí cambia de respuesta). Nada de recargar el panel.

El **Objetivo de la clase** y el **Encargo de este marcador** no tienen botón de guardar, y
por motivos opuestos. El objetivo se escribe en la pestaña Marcadores y ahí queda; ajustarlo
acá no lo cambia. El encargo es de **este recurso y de ningún otro**, así que no hay a quién
avisarle: la versión nueva nace con lo que dejaste escrito, como pasaba siempre. Y
**dejarlo vacío también es un ajuste**, igual que en los otros tres niveles: si el encargo
original ya no describe lo que querés —el gráfico cambió de idea y lo que sobra es la
descripción vieja—, borrás el campo y la versión nueva sale **sin encargo**, guiada por tu
corrección y el resto del contexto. Un campo vacío que **no tocaste** es otra cosa y sigue
funcionando como antes: ahí no dijiste nada, así que viaja el encargo original del recurso.

Si un recurso es **anterior** a que existiera la ficha, el tramo se busca en la cola
guardada (`queue.json`) y, si no, en el `data-duration` del HTML —que da la duración pero
no la posición—. Cuando no hay de dónde sacarlo, la fila **te lo pregunta una vez** y lo
deja anotado en la ficha. Nunca se coloca a ciegas: sin el tramo no se ofrece corregir.

**Si volviste a cortar la clase.** Es lo normal: la clase vuelve como "…_02" y esa
secuencia no tiene nada generado, porque todo se hizo en la anterior. La pestaña **no se
queda en la carpeta de la secuencia abierta**: te ofrece las del proyecto que sí tienen
recursos y, si hay una que es la misma clase con otro sufijo, la trae sola y te lo dice.
Entonces trabaja con **dos secuencias a la vez**, y conviene tenerlo claro:

- El recurso se **genera en la carpeta donde nació**, así su historia de versiones sigue
  siendo una sola (v5 después de la v4) y las **imágenes de referencia** de ese marcador
  —que están guardadas contra esa secuencia— se siguen mandando al modelo.
- El clip se **coloca en la secuencia que tenés abierta**, en el segundo del corte viejo y
  en una **pista nueva arriba de todo**: si los tiempos se movieron, lo arrastrás. Se
  probó pidiéndote el segundo escrito y era peor: un cálculo de más para vos, con el
  riesgo de correr también el tramo del guion que lee el modelo.

## Acciones por recurso

- **Generar** (1ª vez): crea el recurso desde cero, con todo el contexto.
- **Generar (refinar) / Feedback**: ajusta sobre la versión previa con tu nueva instrucción
  (prompt lean, ver Tokens).
- **Regenerar desde cero**: descarta lo anterior y crea uno nuevo con la instrucción +
  recursos actuales.
- **Editar HTML manualmente**: abrís una versión, la retocás a mano y la renderizás sin IA.
- **Limpiar previas** (en cada recurso terminado de la Cola): cuando ya estás feliz con
  una animación, borra sus **versiones anteriores** — del disco **y de las secuencias donde
  estén**— y deja la aprobada. Va de a un recurso porque los demás pueden estar a medio
  revisar. No aparece en una v1, que no tiene nada atrás.
- **Limpiar versiones viejas** (arriba, en la Cola): lo mismo para **todas** las
  secuencias de la cola de una vez, al cerrar la tanda.

  Las dos piden confirmación mostrando archivo por archivo qué se borra y qué se conserva.
  Los **HTMLs no se tocan**: son kilobytes y son con lo que Corrections puede volver sobre
  una versión vieja. El orden importa y es siempre el mismo: primero se sacan los clips de
  la secuencia y del proyecto, después se borran los archivos —al revés, Premiere te recibe
  con el cartel de "Link Media"—. Y los clips se identifican por **ruta**, no por nombre:
  toda clase tiene su `Marcador 1 v1 [modelo].mov`.

## Arquitectura

- **Panel CEP** (`cep/`) — la interfaz dentro de Premiere (`com.codigo.hyperpremiere`), con
  Node embebido (`--enable-nodejs --mixed-context`), en módulos vanilla (sin bundler,
  cargados en orden por `index.html`): `js/util.js` (helpers puros), `js/log.js` (log de
  diagnóstico), `js/engine-client.js` (`HPEngine`, carga/llamadas al motor Node),
  `js/host-client.js` (`HPHost`, frontera única con ExtendScript), `js/seq-watch.js`
  (`HPSeqWatch`, se entera de que cambiaste de secuencia en Premiere), `js/tabs.js`
  (`HPTabs`, conmuta las tres vistas), `js/store.js`
  (`HPStore`, persiste por proyecto+secuencia), `js/transcript.js`, `js/widgets.js`
  (select propio, editor de código, tooltips — CEF no dibuja los `title` nativos),
  `js/iconos.js` (`HPIconos`, los iconos de trazo escritos una sola vez: heredan el color
  del texto, que es lo que un emoji no puede),
  `js/menciones.js` (`HPMenciones`, la mitad del panel de las menciones de referencias:
  escribirlas donde está el cursor, avisar antes de generar, decir con qué número se muestra
  cada una y decidir cuándo se abre el menú del `@` y qué ofrece — la gramática está también
  en `bridge/prompt/menciones.js`, que es quien las resuelve, y un test corre las dos sobre el
  mismo corpus),
  `js/campo.js` (`HPCampo`, **el campo donde se escribe un pedido**: un `contenteditable`
  que pinta las menciones como chips —`@Imagen_1` a la vista, `@[curso/manual.png]`
  guardado—, con el menú que se abre al escribir `@`, y que imita la interfaz de un
  `<textarea>` en coordenadas del texto canónico, para que el dictado, el ✨ y el control de
  alto no se enteren de nada),
  `js/prompt-card.js` (`HPPromptCard`, **el cuerpo de ficha que comparten los tres lugares
  donde se le pide algo al modelo**: tira de referencias arriba, campo, barra de controles
  abajo),
  `js/stills.js` (control de imágenes/recursos **por marcador**, que siguen en esta
  máquina), `js/refs.js` (`HPRefs`, las referencias de los dos niveles generales, que
  viven en archivos del proyecto, con la caché partida por alcance y la migración de lo
  que quedó en el `localStorage`) y `js/refs-view.js` (su caja: miniaturas, chips,
  arrastrar y soltar, las referencias heredadas de la ficha de un marcador, y el cartel de
  la migración), `js/queue.js` (cola
  `HPQueue`, máquina de estados), `js/queue-view.js` (pestaña Cola + limpieza),
  `js/corrections.js` (pestaña Corrections, que lee lo generado del disco),
  `js/config-ui.js` (proveedor/modelo/credenciales) y `js/main.js` (tarjetas de
  marcadores + wiring). `css/style.css`.
- **ExtendScript** (`cep/jsx/host.jsx`) — lee marcadores, mueve el playhead, importa y
  coloca el clip (buscándolo por su ruta de media) sin agregar pistas de más y
  **sin escribir nunca sobre un tramo ocupado**, exporta el frame del programa, purga
  clips al limpiar.
- **Motor Node in-process** (`bridge/`) — corre **dentro del panel** vía `require` (sin
  proceso externo ni servidor):
  - `bridge/engine.js` — orquestación en 2 etapas (`prepareGenerate`/`prepareFeedback` =
    modelo, `renderPrepared` = render), config, self-update, versiones, cola, capturas.
    También `listCorrections`, que reconstruye lo ya generado de una secuencia leyendo la
    carpeta: la ficha de cada versión guarda **dónde iba** en el timeline, y se escribe
    **antes** de llamar al modelo — si el render se cae, el dato no se pierde, y es lo
    único que no se puede volver a deducir cuando el marcador ya no existe.
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
    que cayó al modo software. Tres piezas viven sueltas y no adentro del render, porque
    son decisiones con consecuencias y así se prueban sin levantar Chromium: `argsDeRender`
    (qué comando se arma), `esErrorDeComposicion` (si reintentar puede servir) y
    `correrEscalera` (hasta dónde bajar antes de rendirse).
  - `bridge/store/render-profile.js` — lo que esta máquina fue mostrando sobre con cuántos
    workers rinde mejor, aprendido de sus propios renders. La comparación es lo delicado
    (solo entre marcadores de tamaño parecido, por el mejor tiempo de cada uno, y con una
    ventaja mínima), así que vive en una función pura y aparte.
  - `bridge/prompt/` — system prompt con el sistema de diseño ("menos es más",
    acompañar sin ilustrar literal, coreografía del motion) y el protocolo
    **PLAN → CÓDIGO → AUDITORÍA**: el modelo diseña regiones que no se pisan,
    codea, y se auto-audita con checklist; si declara `AUDIT: FALLA`, el motor
    pide UNA corrección dirigida (solo gasta llamada extra cuando hay falla).
    + build-context (prompt por marcador, lean en refinamiento, imágenes numeradas)
    + `menciones.js`, que traduce `@[curso/logo.svg]` al número que le toca en ESE pedido.
    Vive acá y no en el panel porque el número de una imagen es su posición entre las que
    **de verdad llegan**, y el único que sabe si un archivo se pudo leer del disco es el que
    está armando la llamada.
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
  - `bridge/store/project-fs.js` — salidas en `<carpeta-del-.prproj>/HyperPremiere/<secuencia>/`.
    Tiene **dos** helpers y la diferencia es el contrato de arriba: `outputDirPath` arma la
    ruta y `ensureOutputDir` la **crea**. Todo lo que solo lee —¿hay transcript?, ¿qué
    versiones hay?, ¿hay videos viejos que limpiar?— pide el primero y tolera que la carpeta
    no exista; el segundo es de las escrituras. Pedir el que crea desde una lectura es cómo
    volvería el bug de la carpeta que aparece sola;

    `bridge/store/versions.js` — dueño único del esquema de nombres versionados
    (`<slug> vN [modelo].ext`): parse, formato, próxima versión y listados.
  - `bridge/store/references.js` — las **referencias** de los dos niveles generales como
    archivos del proyecto: `_referencias/` al lado del `.prproj` para las del curso y una
    adentro de cada secuencia para las suyas, con un `referencias.json` que lleva lo que un
    archivo suelto no dice (orden, tipo y la marca ✓ usar). La carpeta manda sobre el
    manifiesto en lo que puede: lo que falta se reporta y lo que apareció a mano se adopta.
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
    El tercero de la familia es `bridge/claude-session.js`, que contesta la otra pregunta
    —**¿puede autenticarse acá y ahora?**— preguntándosela al CLI (`claude auth status`) con
    el mismo entorno con el que se genera. Es dueño de ese entorno para los dos, que es lo
    que evita que el cartel opine sobre una corrida que no es la que hace (ver **Cuando el
    panel dice que falta iniciar sesión y no falta**).

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
  de tiempo y tokens. Aplica a los dos proveedores Claude (CLI y API) y **también a
  Cursor** (ver **Elegir cuánto piensa el modelo, con los dos proveedores**).
- **Cursor (⚙):** genera con tu **suscripción de Cursor** en vez de la de Claude — útil
  cuando el cupo de Claude se agota. Requiere el CLI en cada máquina:
  `curl https://cursor.com/install -fsS | bash` y después `cursor-agent login`
  (o la variable `CURSOR_API_KEY`). La lista de modelos se pide a tu cuenta
  (`cursor-agent --list-models`) y se **cura**: quedan fuera las variantes `-fast`
  (pagan prioridad con más consumo), las `-none` (sin razonamiento) y la gama chica.
  Acá el nivel de pensamiento **va dentro del ID del modelo** (`…-thinking-high`,
  `-xhigh`), pero eso es asunto nuestro: el panel lo muestra en el **mismo desplegable
  de "Nivel de pensamiento"** que Claude y vuelve a armar el ID al guardar (ver
  **Elegir cuánto piensa el modelo, con los dos proveedores**). Las variantes de
  **1M de contexto** son las que Cursor nombra así, y el selector lo dice.
  A tener en cuenta: cada generación arrastra el contexto del propio agente —medido
  con un prompt de veinte caracteres, **31.823 tokens** de piso, y por eso el
  contador de la sesión marca una entrada mucho mayor que nuestro prompt— y tarda
  ~1,5–3 min, más que Claude directo. Lo que puede ver es un
  **directorio temporal nuestro** —ahí dejamos las imágenes de referencia y una **copia**
  de los documentos (un PDF de marca), nunca se le pasa la carpeta de tu proyecto— y va
  **sin permisos abiertos**, así que
  cualquier herramienta que necesite aprobación queda denegada. Lo que **no** hace
  es correr en los modos de solo lectura del CLI (`ask`, `plan`): son para
  preguntar y para planear, y componer una animación es producir el entregable
  (ver **Cuando el modelo contesta en vez de componer**).
- **Login de Claude (⚙):** abre la página de autorización en el navegador; autorizás,
  copiás el **código** que te muestra la página y lo pegás en el panel. Requiere el CLI
  `claude` instalado. Alternativa universal: pegá directamente el token (`sk-ant-oat…`)
  en "…o pegá el token directamente" (corré `claude setup-token` en tu terminal y copialo).
  **Cuando no anda, ahora dice por qué** (ver **Cuando el login de Claude falla**).
  Y si ya te logueaste por la terminal con `claude auth login`, **no hace falta hacer nada
  acá**: el panel lo detecta solo y te dice con qué credencial entrás (ver **Cuando el
  panel dice que falta iniciar sesión y no falta**).
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

## Cuando el render no puede salir bien

Un caso real (Marcador 13): el modelo devolvió una composición **sin el andamiaje** que el
motor de captura necesita —no declaraba duración, no registraba la timeline—. Se mandó
igual a renderizar y el CLI cortó con *"Composition has zero duration… this is permanent"*.
La escalera de intentos, que existe para los **crashes**, reaccionó como si fuera un
problema de máquina: bajó la GPU a software, bajó los workers, reintentó. Tres veces el
mismo error. Un minuto tirado y, al final, un mensaje que le hablaba al editor de
`browser-gpu=software`, o sea de una placa de video que no tenía nada que ver.

Tres cambios, en el orden en que actúan:

1. **El reparador adopta cualquier raíz.** Antes exigía `<div id="stage">` literal. Ahora
   busca en orden: `id="stage"`, cualquier elemento con `data-composition-id`, o —si del
   `<body>` cuelga uno solo— ése. Con la raíz encontrada completa en código los atributos
   que falten, sin gastar otra llamada al modelo. También distingue una animación de
   **puro CSS** (que no necesita registrar nada) de una **timeline de GSAP sin registrar**
   (que sí, y para eso se vuelve al modelo): antes las trataba igual y pedía correcciones
   que no hacían falta.
2. **Lo que no se puede renderizar, no se renderiza.** Si después de todo eso el andamiaje
   sigue incompleto, la generación **corta ahí** con el motivo escrito y qué hacer. El
   HTML se guarda igual —ya se pagó— así se puede mirar o corregir a mano y usar
   **Renderizar HTML**. Los dos finales que evita son igual de malos: el error de duración
   después de tres intentos, o un `.mov` de la duración pedida con la animación
   **congelada**, que no falla y se descubre mirando.
3. **La escalera distingue un crash de un problema de contenido.** Bajar GPU y workers
   arregla un Chromium que se muere o una máquina sin memoria; no le agrega una duración a
   una composición que no la declara. Ante un error de contenido corta en el primer
   intento y lo dice con todas las letras: *el problema no está en el hardware*.

## Los comentarios de Frame.io no dicen Frame.io

El filtro que se hizo para ignorarlos miraba el **nombre** del marcador y pedía
`Frame.io:`. Parecía razonable y no atrapó ni uno: el editor seguía viendo una tarjeta por
comentario de la revisión. Hubo que abrir el `.prproj` de un editor para entender por qué.
Los dos comentarios que había ahí estaban guardados así:

```
nombre  = "Cande"
comment = "Texto listado:\n- Abrir navegador\n- Descargar archivos…\n
           \nFrame.io Comment ID: bba94422-efc7-4389-afbd-23a4cb72f65a"
```

El **nombre es quién comentó**. De Frame.io no dice nada, y nunca iba a decirlo. La marca
está al final del **comentario**, y es un sello que no aparece por casualidad: se reconoce
eso, escrito como venga (con o sin punto, con espacios de más, en el comentario o en el
nombre por si algún día lo mueven).

Lo que **no** se hace es descartar por la palabra "Frame.io" suelta en un comentario. El
comentario del marcador es justo donde el editor escribe la instrucción, así que un
marcador que diga *"esto lo pidieron por Frame.io: subir el contraste"* es trabajo de
verdad. Y como el filtro ahora mira ahí, el log dice **cuáles** ignoró con nombre y minuto
(*"Cande 2:26 · Candela 3:24"*): si alguna vez se lleva puesto un marcador de animación,
eso se ve en vez de adivinarse.

## Cuando el render salió bien pero el clip no entró

Otro caso real (Marcador 3, 18/08). Tres minutos y tres cuartos de modelo, render impecable
en 10,9s… y el clip afuera:

> *el render salió bien pero el clip no entró: no se encontró la secuencia
> "23_…_106595" (¿la cerraste?)*

No la había cerrado. La secuencia estaba en el proyecto —se verificó leyendo el `.prproj`:
ahí está, la última de sesenta y pico— y los marcadores se habían cargado de ella cinco
minutos antes. El que se equivocaba era el panel: la búsqueda por nombre tenía el
`try/catch` **alrededor del bucle**, así que la primera secuencia que no se dejara leer la
cortaba, y todas las que venían después dejaban de existir. En silencio, y con un mensaje
que mandaba a buscar la culpa del otro lado.

Qué cambió:

1. **La búsqueda aguanta.** El `try` va por ítem: una secuencia que se queja se cuenta y se
   sigue con la que sigue. Si el nombre exacto no aparece, se acepta una **casi igual**
   (espacios de más, otra caja) *solo si es única*: con dos candidatas no se adivina, porque
   colocar en la clase equivocada sí le mueve el material al editor.
2. **El "no la encontré" dice qué miró.** En qué proyecto buscó, cuántas secuencias pudo
   leer, cuántas no se dejaron, y —lo más útil— si la secuencia está en **otro proyecto
   abierto** (Premiere permite varios y `app.project` es el del frente; pasarse de proyecto
   mientras la cola trabaja es lo más normal del mundo). Si no está en ninguno, ofrece el
   nombre **más parecido**, que en una clase re-cortada suele ser el sospechoso: `…_106595`
   contra `…_106595_01`.
3. **Colocar.** El render ya se pagó; que no entre tiene que costar un botón. En la fila
   del recurso terminado aparece primero, con el `.mov` que ya está en el disco y el color
   que le correspondía (una corrección sigue entrando en amarillo). Antes la única salida
   era **Feedback** —otra generación entera para repetir un archivo que ya existía— o
   arrastrarlo a mano desde la carpeta. La marca **se guarda en `queue.json`**, porque la
   causa típica se arregla reabriendo Premiere y para entonces el panel ya se reinició; y
   si el job es viejo y no la trae —el del caso, por ejemplo— se lo reconoce por su
   mensaje y el video se busca en la carpeta de la secuencia.

## Cuando el modelo contesta en vez de componer

Otro caso real (Marcador 1, tres rondas seguidas). El panel corría el CLI de Cursor en
`--mode ask` porque parecía la opción prudente —es de solo lectura—, y en medio de una
clase el modelo se plantó:

> *I'm in Ask mode, which is for answering questions and providing guidance — I can't
> generate a final production deliverable… please switch to Agent mode.*

Eso no es un error del CLI: es una respuesta, en prosa, con código de salida 0. Y disparó
tres problemas en cadena. El primero fue el diagnóstico: el motor la leyó como una
composición mal armada y dijo *"no encuentro el contenedor `<div id="stage">`"* — cierto y
completamente engañoso, porque no había composición ninguna. El segundo, que gastó la
llamada extra de estructura mandándole su propia negativa como "tu versión a corregir", y
el modelo se volvió a negar. El tercero fue el que hizo daño de verdad: la prosa quedó
guardada como el HTML de la versión nueva, así que la ronda siguiente la leyó como **"la
versión previa"** y le pidió mejorar un texto de disculpa. Lo detectó el propio modelo:
*"the 'versión previa' block does not actually contain the prior HTML (it contains an
earlier refusal message instead)"*.

Qué cambió:

1. **El modo.** Los dos que ofrece el CLI son de solo lectura y los dos son para otra
   cosa: `ask` es Q&A y `plan` es analizar y proponer. Componer **es** el entregable, así
   que va sin `--mode`. El aislamiento no dependía del modo y no cambia: el workspace
   sigue siendo un temporal nuestro y sigue sin `--force`. Medido contra el CLI de verdad
   (`test/manual/cursor-contrato.js`, que sabe forzar `--modo ask`), el modo nuevo dio
   **4 de 4 composiciones impecables**, sin negativas y ~14% más rápido (219s contra 253s
   de promedio). Pero hay que decir lo otro: **`ask` también dio 4 de 4**. La negativa no
   se reproduce a pedido — el modelo se planta cuando se planta, y por eso el arreglo que
   de verdad protege al editor no es este punto sino los dos que siguen.
2. **"Esto no es HTML" es un problema aparte.** No es lo mismo que un andamiaje
   incompleto: no hay nada que reparar. Se corta en la primera llamada, sin gastar la de
   estructura, y el mensaje trae **las palabras del modelo**, que suelen decir exactamente
   qué lo frenó.
3. **Una negativa no puede contaminar la cadena de versiones.** No se guarda como versión,
   y si en el disco quedó una de antes, la referencia para corregir la **saltea** y vuelve
   sobre el último diseño real. Lo mismo vale para **Renderizar HTML**: si lo que hay en el
   editor es texto pegado de un chat, se dice en el momento en vez de esperar un render que
   saldría en negro.

## Con cuántos workers conviene renderizar

Salía de una cuenta sobre la RAM y los cores. Da un número plausible, y nadie había
comprobado que fuera el bueno.

El primer intento de comprobarlo fue **medir con una composición de prueba** antes del
primer render de cada máquina. Se descartó por lo que mostró la propia medición: en el M3
Max dio **58,1s el reparto en paralelo contra 65,2s el de un worker**, al revés de lo que
había dado un banco de pruebas anterior **en la misma máquina**. La diferencia entre las
dos fue el estado del equipo — la segunda con Premiere abierto y la carga en 7, que es
exactamente cómo trabaja un editor. Una medición de una sola vez, tomada en un mal
momento, queda grabada para siempre; y encima cuesta minutos de espera antes del primer
render.

Lo que quedó: **aprender de los renders que ya se hacen**. Cada render exitoso deja
anotado cuántos fotogramas fueron y cuánto tardó, en
`~/.hyperpremiere/render-profile.json`. Mientras junta datos alterna los dos repartos, y
elige uno solo cuando la evidencia alcanza:

- **Solo compara marcadores de tamaño parecido.** Un render corto está dominado por el
  arranque de Chrome y el encode (~40s fijos contra ~0,1s por fotograma en el M3 Max):
  comparar uno de 4s contra uno de 30s no dice cuál reparto es mejor, dice cuál marcador
  era más largo.
- **Se queda con el mejor tiempo de cada uno,** no con el promedio. Premiere exportando o
  un backup corriendo solo pueden hacer las cosas más lentas, nunca más rápidas.
- **Necesita 3 corridas de cada reparto y una ventaja de 10%,** ganando en todos los
  tamaños comparables. Por debajo de eso no toca nada: el reparto de siempre se queda.

En el M3 Max los dos repartos terminaron a 52,5s y 54,2s sobre el mismo marcador — un 3%,
o sea empate. Ahí la regla correcta es justamente **no cambiar nada**.

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

## Cuando el panel dice que falta iniciar sesión y no falta

Un editor en mac, con el panel v1.4.46 y Claude por suscripción, mandó la captura del
cartel: *iniciá sesión en Claude*. Su log de diagnóstico, del mismo rato, dice otra cosa —
tres generaciones seguidas con `claude-sonnet-5`, las tres terminadas y colocadas:

```
[14:45:29] Job DONE [Marcador 1] v1 · ✓ Listo y colocado · 1m 50s
[14:51:38] Job DONE [Marcador 1] v2 · ✓ Listo y colocado · 2m 05s
[14:54:34] Job DONE [Marcador 1] v3 · ✓ Listo y colocado · 1m 45s
```

O sea que la sesión estaba y el que mentía era el cartel. Es el peor tipo de bug de los que
hay acá: no rompe nada, no aparece en ningún error, y manda a **arreglar algo que
funciona** — a distancia, que es como se trabaja con el panel de otro.

El indicador miraba **una sola cosa**: si en la config del panel había un token guardado
(el que deja el botón "Iniciar sesión" o el que se pega a mano). Pero el proveedor
`claude-cli` **no necesita ese token**: solo lo pone en el entorno si existe, y cuando no
está, el CLI resuelve con **su propia sesión** —la de `claude auth login` en la terminal—.
El editor se había logueado así, que es el camino normal y el que recomienda Anthropic, y
el panel no miraba nunca ahí. Con lo cual el cartel no describía la máquina: describía
nuestra cajita.

Ahora se le pregunta **al CLI**, con el **mismo entorno** con el que va a generar:

```
$ claude auth status
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty" }
```

Es de lectura, contesta en **~250 ms**, no gasta un token y no toca la red (medido contra
el CLI 2.1.201). Y es sensible al entorno: con `CLAUDE_CODE_OAUTH_TOKEN` puesto contesta
`authMethod: "oauth_token"`. Por eso la respuesta es la de la corrida **de verdad** y no
una conjetura sobre ella: el entorno lo arma una sola función que comparten la detección y
la generación (`bridge/claude-session.js`), así que no pueden opinar distinto. Los cuatro
caminos que el CLI sabe distinguir —`claude.ai`, `oauth_token`, `api_key`, `none`— ahora se
ven en el panel, que además dice **con cuál** entrás.

La otra mitad del arreglo es que la respuesta tiene **tres** valores y no dos:

- **Hay sesión** → verde, con la credencial nombrada.
- **No hay** → ahí sí el cartel, con el próximo paso escrito: `claude auth login` en una
  terminal, o pegar el token como siempre.
- **No se pudo averiguar** (un CLI viejo que no conoce `auth status`, un binario que no
  contesta) → **no se avisa nada**, y el renglón lo dice con todas las letras: *no quiere
  decir que falte; si venís generando bien, está todo en orden*. Es el mismo criterio del
  botón ⟳, que tampoco tiene dos estados sino tres. Tratar "no sé" como "no tenés" es
  exactamente el bug que esto vino a sacar, y era la forma más fácil de traerlo de vuelta.

Falta el CLI entero, que es otro problema con otro arreglo, también se dice aparte: mandar
a iniciar sesión a alguien que no tiene el binario es hacerle perder el rato.

Lo que este chequeo **no** hace es validar la credencial: con un token vencido igual
contesta que sí. Es a propósito. Dice "hay con qué autenticarse", que es exactamente la
condición desde la que arranca la generación; si esa credencial ya no sirve, lo va a decir
la generación con su motivo (ver **Cuando la generación se cae**), y para eso está. Un
indicador que además valide cuesta una llamada al modelo cada vez que se abre ⚙.

Una advertencia sobre cómo medir esto, porque es fácil sacar la conclusión equivocada:
correr `claude -p "hola" --output-format json` desde un proceso hijo **sin terminal** puede
devolver `"Not logged in · Please run /login"` con **código de salida 0**, y eso se parece
mucho a "el hijo no llega al llavero". Puede no serlo: en la máquina donde se investigó
esto, `claude auth status` contestaba `"authMethod": "none"` — simplemente no había ninguna
sesión, ni interactiva ni de ninguna clase. Conviene preguntar antes de deducir.

## Cuando el proveedor es Cursor y algo no anda

Cursor tardó en tener lo que Claude ya tenía, y se notó. Un editor mandó dos capturas del
mismo camino, con días de diferencia:

1. `✕ No pude hablar con Cursor… Detalle: spawn cursor-agent ENOENT` — el binario no estaba.
2. Después de instalarlo, el mismo cartel con `Detalle: Error: Authentication required. Run
   'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.` —
   el binario estaba y faltaba la sesión.

Los dos se arreglan en un minuto, pero lo que el panel le mostraba era el error crudo del
proceso: ninguna diferencia entre "no está instalado" y "está pero sin sesión", y ningún
camino desde el panel. Ahora ⚙ **pregunta antes**, igual que con Claude, y el semáforo
distingue los cuatro casos: sesión activa (con qué cuenta entra), falta el CLI (con el
comando de instalación), falta la sesión (con `cursor-agent login`), y **no se pudo
averiguar** — que se dibuja como lo que es, una duda nuestra, y no como un problema del
editor. Ese último estado existe porque tratar "no sé" como "no tenés" ya se pagó una vez con
Claude (ver **Cuando el panel dice que falta iniciar sesión y no falta**), y no había ningún
motivo para pagarlo de nuevo.

**El botón de Diagnóstico** al lado dice si el CLI está, en qué ruta, qué versión y con qué
credencial entra, en un texto que entra en una captura. Es lo que conviene pedirle a alguien
cuando no tenemos su máquina adelante, y funciona igual cuando el CLI **no** está: ahí
informa dónde se buscó, que es lo que distingue "no está instalado" de "está en un lugar
donde no miré".

**"No me lo encuentra la Terminal" no quiere decir que falte.** En la máquina de este editor,
`cursor-agent` y `claude` devuelven los dos `command not found` en su `zsh`, y sin embargo
están: viven en `~/.local/bin`, que el panel agrega a su PATH y su shell no. Si un comando
que sugiere el panel no arranca en tu Terminal, probá con la ruta completa
(`~/.local/bin/cursor-agent login`) antes de reinstalar nada.

**La API key de Cursor se puede pegar en ⚙.** El motor siempre supo usarla, pero la fila
estaba escondida para este proveedor, así que no había forma de llegar a ella desde el panel.
Se pasa como `CURSOR_API_KEY` y nada más: `CURSOR_AUTH_TOKEN`, la otra variable que nombra el
mensaje de error del CLI, quedó descartada a propósito porque al usarla el CLI intenta
**escribir en el llavero del sistema** y puede pisar la sesión que ya tenías. Si el CLI ya
tiene sesión no hace falta pegar nada; la key es para las máquinas donde el login interactivo
no es una opción.

## Cuando el indicador está en verde y la generación dice que no hay crédito

Otra captura del mismo editor, y las dos cosas eran ciertas: arriba el semáforo de ⚙ en
verde, abajo en la cola `Credit balance is too low`. El chequeo de sesión pregunta si hay
**con qué autenticarse**, y una cuenta sin saldo tiene credencial: contestaba que sí y tenía
razón. Pero lo único que se mira antes de apretar "Generar" es el semáforo.

Ahora, cuando una generación o un refinado rebota por cupo o límite de uso, el panel se
acuerda y el indicador de **ese** proveedor pasa a **ámbar**: *"hay credencial, pero la
cuenta no tiene cupo"*. Ámbar y no rojo, porque no te falta configurar nada —está todo
puesto— y no se arregla desde acá adentro. Es por proveedor: que Claude se quede sin cupo no
dice nada de Cursor, y cambiarte al otro no te arrastra el cartel.

Se olvida sola en cuanto puede haber cambiado algo: al guardar la configuración de ese
proveedor (pegar una API key nueva es "probá de nuevo") y al reiniciar el panel. No se
persiste a propósito: cargar crédito se hace afuera y de eso no nos vamos a enterar nunca, así
que un aviso guardado en disco sería un cartel pegado hasta la próxima versión.

## Cuando el modelo diseña sin mirar la imagen de referencia

El mismo editor del cartel mandó otra cosa: *"tampoco está tomando la imagen de referencia
que le compartí"*. En su log, las tres generaciones de esa clase traían la misma línea:

```
[WARN] OJO: el CLI necesitó permiso para usar Write (1 vez/veces) y no lo tuvo,
       así que el modelo diseñó sin eso.
```

Ese aviso apuntaba al lugar equivocado y sonaba peor de lo que era. Lo denegado fue
**Write**: el modelo, que trabaja todo el día en repositorios, intentó **guardar la
composición en un archivo** — una composición que ya nos había devuelto entera en su
respuesta. Denegarlo no le quitó nada al diseño. Pero el aviso metía todas las
herramientas en la misma bolsa y le decía al editor que su animación se había hecho a
ciegas, tapando lo único que sí importa: **leer**, que es lo que cambia lo que el modelo
vio.

Tres arreglos, en orden de qué tan seguido pega cada uno:

**1. El CLI arranca con las herramientas justas.** `--tools Read`: leer, y nada más. Sin la
herramienta no hay intento de guardar, no hay denegación y el turno se va entero en
diseñar. Va acompañado de `--allowedTools Read`, que es la otra mitad del permiso:
`--add-dir` dice *dónde* puede leer, esto dice que **no hace falta consultarlo** (en
headless no hay a quién preguntarle, así que una lectura "a confirmar" es una lectura
perdida). Y el manual del sistema ahora lo dice también en palabras: *la composición se
entrega en tu respuesta, no en un archivo*.

**2. Se comprueba que la haya abierto.** Que el permiso esté no garantiza que mire: el
modelo puede saltearse la lectura y diseñar igual, y ahí sale algo presentable que no tiene
nada que ver con el cuadro que el editor eligió. Era el modo de falla más **mudo** del
proyecto: nadie se enteraba hasta ver el video. Con el estado en vivo prendido, el stream
dice qué archivos abrió, así que se puede contar — y si falta alguna, se avisa con el
nombre:

```
OJO: el modelo abrió solo 1 de las 2 imágenes de referencia (le faltó: imagen-2.png).
Qué hacer: volvé a generar. Si se repite, cambiá el proveedor a la API de Claude en
Configuración: ahí las imágenes viajan dentro del mensaje y no dependen de que el
modelo abra un archivo.
```

La comparación es por **nombre de archivo** y no por ruta completa, porque el modelo la
escribe como quiere (relativa, con `./`, con la barra de la otra plataforma) y lo que se
pregunta es si miró **esa** imagen. Sin estado en vivo no hay con qué comprobarlo, y ahí
no se avisa nada: inventar una sospecha es peor que no tener el dato. Y el prompt le avisa
de antemano que esto se mira, que es la mitad más barata del arreglo.

**3. El aviso de permisos dice cuál es cuál.** Si lo que se denegó fue leer, se dice fuerte
y con la consecuencia (*el modelo diseñó sin ver eso*). Si fue cualquier otra cosa, se dice
como nota y con la verdad: *eso es a propósito, no afecta al diseño*.

Lo que este arreglo **no** hace es mandar las imágenes adentro del mensaje, como sí se hace
con la API. El CLI en headless no las adjunta: van a un directorio temporal y se nombran
por ruta absoluta en el prompt (`--input-format stream-json` abre una puerta a mandarlas
en base64, pero no se pudo comprobar contra un CLI con sesión, y cambiar el transporte de
las imágenes a ciegas es exactamente el tipo de cambio que rompe las dos plataformas a la
vez). Mientras siga siendo por archivo, el control de arriba es lo que convierte una falla
muda en una línea de log.

## Elegir cuánto piensa el modelo, con los dos proveedores

Del mismo editor: *"su modelo no le deja seleccionar bien la exigencia de pensamiento del
Sonnet"*. Y era cierto, aunque el control existiera: en **Cursor** el nivel de razonamiento
no es un flag, viene **dentro del ID del modelo** (`claude-sonnet-5-thinking-high`,
`-xhigh`). El panel mostraba esos IDs tal cual y **escondía** la fila de "Nivel de
pensamiento" porque "en Cursor no aplica". Aplicaba: estaba disfrazada de modelo, y para
subirle la exigencia había que saber leer el ID.

Ahora las variantes se **agrupan por familia** y el editor ve los **mismos dos
desplegables** con los dos proveedores:

| Antes (una lista de IDs) | Ahora |
| --- | --- |
| `claude-sonnet-5-thinking-high` | **Modelo:** Claude Sonnet 5 · 1M |
| `claude-sonnet-5-thinking-xhigh` | **Pensamiento:** Alto / Muy alto |

Al guardar se vuelve a armar el ID (familia + nivel), así que el motor y la config no
cambiaron: lo que viaja sigue siendo el ID que entiende `cursor-agent`. El nombre de la
familia sale del que pone **Cursor**, no de uno nuestro, y de ahí viene el **1M**: es la
razón por la que alguien elige esas variantes, y ahora se ve en el selector en vez de
haber que deducirla del sufijo. Tres detalles que valen la pena:

- **Solo se ofrecen los niveles que tu cuenta tiene.** Cursor no tiene `máximo`; ofrecerlo
  para después resolverlo calladamente a otra cosa sería mentir. Si cambiás de familia y el
  nivel que tenías no existe ahí, se baja al vecino más cercano y el desplegable **muestra
  el que quedó**.
- **Manda el ID guardado.** Al abrir el panel, el nivel que aparece es el que dice el ID
  con el que se venía generando, no el `effort` que quedó de cuando usabas Claude.
- **La variante que no razona queda afuera.** En una familia con niveles, el ID pelado
  (`claude-sonnet-5`, sin thinking) ya no es alcanzable — misma política que las `-none`,
  que el motor filtra desde antes: para diseñar una animación es la herramienta equivocada.

Y como el nivel pesa tanto como el modelo en el resultado, ahora va **al log de
diagnóstico** junto a él (`modelo=… · pensamiento=high`). Es el dato que faltaba para
comparar el log de otra máquina contra el propio: dos corridas con el mismo modelo y
distinto nivel no son la misma corrida. El modelo, además, se refresca al cambiarlo: antes
el log repetía el que había al **abrir** el panel.

Del mismo editor vino el resto del pedido: *"ahí no me dice claramente cuántos tokens
consume, tipo 300k o 1M"*. Ahora el desplegable lleva la **ventana de contexto** pegada al
nombre (`Claude Sonnet 5 · 1M`) y debajo del selector hay un renglón que contesta la
pregunta con la que se abre ⚙ —cuánto de esa ventana se está usando de verdad—, con el
promedio medido en esta máquina: *"Ventana de contexto: 1M. Una generación con Cursor gastó
≈ 128k de entrada (promedio de 12), o sea ~13% de 1M."*

**De dónde sale ese número, porque no sale del proveedor.** Ni la lista de Cursor
(`cursor-agent --list-models` devuelve `<id> - <nombre>` y nada más) ni la que lee el motor
de Anthropic traen la ventana, así que hay una **tabla nuestra por familia** en
`cep/js/util.js` (`VENTANA_CLAUDE`), sacada de la documentación de Anthropic —*Context
window sizes by model*— el **2026-09-03**: 1M para Fable 5.1, Mythos 5.1, Fable 5, Mythos 5,
Opus 5, Opus 4.8/4.7/4.6, Sonnet 5 y Sonnet 4.6; 200k para el resto. Una tabla a mano **se
desactualiza**: los modelos nuevos entran solos al panel (la lista se pide a tu cuenta) pero
acá hay que agregarlos, y hasta que alguien lo haga **se ven sin ventana**. Ese es el modo
de fallar correcto: un modelo sin número se nota, un número inventado no. Hay una excepción
donde el dato sí viene de la fuente: la lista de Anthropic trae `max_input_tokens` y el
motor ahora lo pasa; cuando llega, le gana a la tabla.

Sobre el **1M**, para que no queden expectativas cruzadas: **la ventana depende de por dónde
entres, no solo del modelo**. Por **Cursor** el dato es del propio proveedor —esas variantes
se llaman así en su lista— y el panel lo promete. Por la **API de Claude**, la documentación
dice 1M y ya no hace falta ningún beta. Por el **CLI de Claude depende de la credencial**:
con una API key va por la API y vale lo mismo, y ahí el selector dice `1M`. Con la sesión de
`claude.ai` o un token de suscripción, **nadie nos dice qué ventana efectiva te toca** — el
CLI contesta con qué te autenticás (`claude auth status`), no cuánto te entra. Ahí el panel
muestra el piso, `200k+`, marcado como piso, y **no promete los 1M**: mentir en el dato con
el que el editor decide cuánto material le mete a una generación es peor que quedarse corto.
Lo mismo mientras no se sepa (el CLI todavía no contestó, o es una versión que no conoce el
comando): no saber se parece más a no prometer que a prometer.

Una corrección de lo que decía antes esta sección: el motivo que dábamos —que el 1M era un
beta *API key users only*— ya no es el correcto. Ese cartel existe (`claude --help` lo dice
sobre `--betas`) pero es sobre los headers beta en general, y para esta generación de
modelos el 1M **ya no es un beta**. Lo que de verdad no se puede saber es la otra cosa: qué
ventana da Claude Code con una suscripción. La conclusión no cambia; el motivo sí.

## El estilo del curso, el de la clase, y el del marcador

Dos editores, el mismo `.prproj`, animaciones distintas. Diagnosticando por qué al
compañero le salían peores apareció esta línea, igual en las tres generaciones de su log:

```
prompt general no
```

El **Prompt general** —marca, paleta, tipografía, tono, todo lo que define el estilo de un
curso— vivía en el `localStorage` del panel, con una clave por proyecto y secuencia. Es
decir: en la máquina donde se escribió, y en ninguna otra. El editor que lo llenó generaba
con el estilo puesto; el que abría el mismo proyecto generaba **con el campo vacío**, sin
manera de darse cuenta. Ese `no` del log era el único rastro, y había que ir a buscarlo.

**El estilo ahora es un archivo al lado del `.prproj`.** En la carpeta `HyperPremiere` que
ya se crea junto al proyecto —la misma donde viven los renders y las transcripciones— hay
un `prompt-general.md` que es texto plano y se puede abrir con cualquier editor, corregir a
mano y mandar por chat. Va **arriba** de las carpetas por secuencia, no adentro, porque es
del curso entero y no de una clase: esa distinción no existía en el proyecto y hubo que
crearla (`projectRootPath`, que ya estaba escondido dentro de `outputDirPath`). Y como está
junto al `.prproj`, viaja con él por el mismo camino que ya usan los editores para pasarse
el proyecto, sin que nadie tenga que acordarse de nada.

### Tres niveles que se acumulan

Un curso tiene una marca, una clase puede tener lo suyo, y un marcador pide una animación
concreta. Son tres cosas distintas y hoy se escriben en tres lugares distintos:

- **Prompt general**, el del curso entero. Vive fuera de las secuencias, en
  `HyperPremiere/prompt-general.md`, y **se mantiene al cambiar de secuencia**: es la marca,
  y la marca no cambia porque hoy estés editando otra clase.
- **Prompt de secuencia**, el de esta clase. Vive en la carpeta de la secuencia, en
  `HyperPremiere/<slug-secuencia>/prompt-secuencia.md`.
- **La instrucción del marcador**, la de este recurso y ningún otro, que se escribe en la
  tarjeta y no se guarda en ningún archivo.

**Los tres viajan al modelo, juntos, en ese orden.** El del curso primero, como base; el de
la secuencia encima; la instrucción del marcador al final. Hasta la 1.4.51 el de la clase
**reemplazaba** al del curso: si una secuencia tenía el suyo, el del curso no se mandaba. La
razón que dábamos para reemplazar era buena y sigue siendo cierta —el editor escribe *"esta
clase va en blanco y negro"* esperando que mande, y pegado al *"paleta azul institucional"*
del curso deja al modelo eligiendo cuál gana— pero la conclusión estaba mal. Lo que faltaba
no era **sacar** el del curso: era **decir quién gana**. Reemplazando, escribir dos palabras
sobre el color de una clase tiraba a la basura la tipografía, el tono y todo el resto del
estilo del curso, que nadie quiso tirar.

Así que ahora se acumulan y la precedencia se le dice al modelo con todas las letras, en el
prompt, en vez de dejársela a su criterio. Esto es literalmente lo que le llega:

```
# El estilo del curso (base)
Marca ACADEMIA NOVA. Tipografía: Söhne para títulos, Inter para cuerpo.
Paleta: fondo carbón #12161d, acento cian #38e1c4...

# El estilo de esta secuencia
Lo propio de ESTA clase, sobre la base del curso. PRECEDENCIA: donde diga algo
distinto al estilo del curso, MANDA ESTO.
Este módulo va en BLANCO Y NEGRO: se compara material de archivo...

# Qué animación hacer acá
Es el nivel MÁS específico: donde contradiga a los estilos de arriba, manda esto.
Comparación lado a lado: archivo a la izquierda, hoy a la derecha...
```

La regla general está también en el system prompt, dicha una vez para los tres niveles: el
más específico manda, y **no es una invitación a promediar**. Si el curso pide azul y la
clase pide blanco y negro, la clase gana en el color y el curso sigue mandando en todo lo
demás. Eso es lo que un editor puede predecir leyendo lo que escribió, que era el punto de
reemplazar, sin el precio de perder el resto del estilo.

El log dice qué niveles viajaron:

```
prompt general del curso
prompt general de esta secuencia
prompt general del curso + de esta secuencia (si se contradicen, manda la secuencia)
```

El caso sin estilo sigue diciendo `prompt general no`, palabra por palabra. Es el texto por
el que se buscó en el log del editor, y cambiarlo dejaría los logs de las versiones
anteriores sin con qué compararse. Lo que cambió es que ahora ese `no` **quiere decir algo
distinto**: antes podía significar *nadie definió el estilo* o *lo definieron en la otra
máquina y a vos no te llegó*, que es justo la ambigüedad que hizo falta desenredar a mano.
Ahora el estilo está en el proyecto, así que `no` es una sola cosa: no hay estilo escrito en
ningún lado.

### Queda anotado qué se mandó

El log dice **cuáles** viajaron; la **ficha** dice **qué decían**. Cada versión guarda en su
`.meta.json` los tres niveles con los que se generó, más el objetivo de la clase, y
Corrections los muestra al abrir el recurso —ver *Lo que recibió, y qué se puede saber de una
versión vieja*—. Sin eso, "lo que recibió este marcador" solo se podía adivinar mirando los
archivos de hoy, que son justamente los que el editor está por cambiar. Con esto, un gráfico
que salió raro se puede rediseñar sabiendo con qué salió raro.

Es de acá en adelante, y se dice: de una versión **anterior** a este cambio no hay ficha con
los prompts, así que lo que se muestra es una reconstrucción de los archivos actuales, con el
cartel puesto. Lo único que de esas versiones sí se sabe es el **encargo del marcador**, que
ya se guardaba desde antes.

### Dos campos, dos archivos, y ninguna duda de dónde estás escribiendo

En el panel los dos niveles se editan en **dos bloques separados**, cada uno en el lugar
que le corresponde por alcance. Son **tres tarjetas hermanas**, al ras y en orden de
alcance: **Estilo del curso** (adentro, **Prompt general · TODO el curso**), **Contexto de
la clase** y **Estilo de esta secuencia** (adentro, **Prompt de secuencia · solo "<nombre
de la clase>"**). Y **después** de las tres viene el rótulo *Marcadores* con la lista. Cada
bloque tiene además **su caja de referencias**, con el alcance del bloque. El rótulo nombra
la secuencia porque
nombrar el alcance en abstracto —"esta secuencia"— obliga a mirar otra parte del panel para
saber cuál es. Sin secuencia abierta el bloque de abajo **no se ofrece**, entero: no hay
carpeta donde guardar ni el texto ni las referencias.

Las tres se ven **iguales**: el mismo recuadro, el mismo desplegable y el mismo aire que una
tarjeta de marcador, sin sangrías distintas. Hubo una escalera —cada alcance un poco más
adentro que el anterior, con su guardita de color y su título un punto más chico— y se fue
en la v1.6.0. Dos motivos. Uno: el tercer nivel no es una caja con rótulo, es el `<textarea>`
de la tarjeta, así que la sangría se le dibujaba **al campo** y de ahí salieron un borde de
arriba de otro color que los otros tres y el texto arrancando tres píxeles más abajo que el
cursor. Otro: en 400 px de ancho la sangría se paga en ancho de escritura, y un canal que
funciona en dos de tres casos hay que aprenderlo. **El alcance lo dice el título**, que es
lo que se lee igual sin aprender nada.

Y hasta la v1.5.3 *Estilo de esta secuencia* vivía **abajo** del rótulo *Marcadores*, o sea
adentro del área de una lista a la que no pertenece: es el encabezado de esas tarjetas, no
una de ellas. Es el mismo error que se había corregido para el prompt del curso y que se
arrastró al separarlos.

Vivieron juntos, en una sola caja llamada *Prompts generales*, y estaban abajo del rótulo
*Marcadores* los dos. Juntos tenían algo bueno que se perdió: la relación entre los niveles
—que los dos viajan y que el de la clase manda donde se contradigan— se leía de un vistazo,
un campo abajo del otro y un renglón entre medio. Lo malo era peor: el prompt del **curso
entero** quedaba adentro del área de los marcadores de **esta** clase, que es exactamente lo
que no es. Y leyéndolo de arriba a abajo, el panel ahora va del alcance más ancho al más
angosto: el curso, esta clase, los marcadores de esta clase.

Lo que sostiene la relación ahora que las cajas están lejos son **los dos renglones**, y
está repartido a propósito para no escribir el mismo párrafo dos veces. El de arriba dice
qué alcance tiene lo suyo y **dónde está el otro**: *"El mismo en todas las clases del
curso. Viaja con el .prproj. Lo de esta clase va abajo, en 'Estilo de esta secuencia'"*. El
de abajo dice **quién manda**, que es lo único que cambia lo que uno escribe: *"Al modelo
van los DOS: el del curso (arriba) como base y éste encima, que MANDA donde se
contradigan"*. La precedencia se dice una sola vez, en el bloque que gana. Los dos rótulos
salen de un solo lugar en el código (`HPGeneral.TITULOS`) y hay un test que los compara con
el HTML: un renglón que mande a una sección que se llama distinto es peor que no decir nada.

Cada bloque tiene además **su propio badge**, que es todo lo que se ve plegado, y dice de su
nivel y no del otro: *"✓ del curso"* arriba, *"✓ MANDA sobre el del curso · 3 adj."* abajo.

Las **referencias** (capturas, logos, manuales de marca, PDFs) son **dos cajas, una por
bloque**, y cada una tiene el alcance de su bloque: *"Referencias del curso"* arriba y
*"Referencias de esta secuencia"* abajo. Fueron una sola bolsa por secuencia hasta la
1.5.1, y eso dejaba la caja de arriba —la que promete *"viaja con el .prproj"*— sin
referencias, o sea prometiendo estilo del curso y sin manera de darle el manual de marca.
Partirlas era un cambio de datos y de migración, no de layout, y por eso tardó: está contado
en *Las referencias viajan con el proyecto*.

El **cartel de conflicto del texto** —el de la migración del `localStorage`, más abajo— vive
en el bloque del curso. Puede hablar de cualquiera de los dos niveles, y por eso su lugar lo
decide otra cosa: es el único bloque que se dibuja **siempre** (sin secuencia abierta el
otro no existe, y ahí el cartel quedaría inalcanzable), y de sus tres respuestas la cara
reemplaza justo ese archivo, el que comparten los dos editores. Cuando hay algo sin decidir,
el bloque de abajo lo dice y señala dónde: *"Ese texto puede ser el de esta clase: se decide
arriba, en 'Estilo del curso'"*. Su comportamiento y sus tres respuestas no cambiaron.

El de las **referencias** es otro cartel y vive en el bloque de la secuencia, que es donde
estaba lo que migra. Son dos migraciones distintas y contestarlas por separado es lo
correcto: decidir de quién es un texto no dice nada de un PDF.

Cada campo escribe en su propio archivo y en ninguno más. Eso, que suena obvio, es la
regresión que más caro salió: con un solo campo que editaba uno u otro archivo según un
estado interno, vaciar el prompt de una clase borraba su archivo y el tecleo siguiente se
guardaba en el del curso —el que le llega a todos los editores— sin que nada fallara. El
estado explícito que lo arreglaba (`writeScope`, más un botón para elegir destino) **ya no
existe**: con los dos campos a la vista no hay ningún destino que elegir, cada uno tiene el
suyo escrito en el HTML. La disciplina sí sigue, y hay tests que la fijan en la forma nueva:
vaciar un campo no toca el archivo del otro, ni al guardar ni en lo que queda en pantalla.

Vaciar **cualquiera de los dos** borra su archivo, que es la manera de no dejar uno vacío
que después parece una decisión: mientras no esté el de la secuencia, esa clase usa el del
curso y nada más. Los dos niveles se comportan igual a propósito. Vaciar el del curso dejaba
un `prompt-general.md` de **cero bytes** en la raíz del proyecto: no rompía nada —se lee
como "no hay estilo del curso", que es lo que el editor quiso decir— pero es un archivo que
**viaja al lado del `.prproj`** y le aparece a todos los demás editores sin querer decir
nada. Si el archivo no está, tampoco está la duda.

### Los proyectos que ya existen

El de la raíz no cambió: se sigue llamando `prompt-general.md` y sigue queriendo decir lo
mismo. El de la clase sí cambió de nombre —`prompt-general.md` adentro de una carpeta de
secuencia pasó a `prompt-secuencia.md`— porque el nombre viejo ya no lo describe, y los dos
llamándose igual es una trampa cuando hay que hablar de ellos.

Los archivos que ya están en los proyectos siguen andando **sin que nadie renombre nada**.
Adentro de una carpeta de secuencia, `prompt-general.md` siempre quiso decir "el de esta
clase", así que se lee tal cual cuando no hay uno con el nombre nuevo; lo único que cambia
es que ahora **se suma** al del curso en vez de reemplazarlo. La primera vez que ese campo
se guarda, el texto va al nombre nuevo y el del nombre viejo se borra: queda uno solo, y
nunca dos diciendo cosas distintas. El editor no se entera de nada de esto.

**Lo que ya estaba escrito en el `localStorage` tampoco se pierde.** Al abrir el panel por
primera vez con esta versión, lo que había se sube al proyecto si el proyecto todavía no
tiene nada, y recién ahí se limpia lo local. Si el proyecto ya tiene un texto **idéntico**,
se limpia sin decir nada: no hay nada que preguntar. Y si tiene uno **distinto**, no se pisa
ninguno de los dos: el panel muestra los dos textos y pregunta cuál vale, con tres
respuestas —*es el de esta clase* (lo guarda como Prompt de secuencia, que se suma al del
curso y manda donde se contradigan), *que sea el general del curso* (reemplaza el del
proyecto, y le llega a todos) o descartarlo. Pisar en silencio hubiera sido perder trabajo
escrito de un editor sin avisarle, que es exactamente la clase de cosa por la que este bug
existió. Mientras no se conteste, el texto local queda guardado: cerrar el panel no es una
respuesta. Y si el motor no puede leer el proyecto —disco de red caído, permisos—, el texto
local se sigue mostrando y usando: la alternativa era volver a generar sin estilo por un
error de lectura, que es el bug original otra vez.

Todo lo que arma un pedido al modelo lee ahora de los mismos dos archivos: la generación
normal por marcador, los reintentos y el feedback de la cola —que releen al momento de
generar, así que arreglar el estilo y reintentar sale con el arreglado, no con el que tenía
pegado el job—, la pestaña de correcciones y la estimación de costo, que cuenta los tokens
del prompt que se va a mandar de verdad. La única cosa que se les pone **encima** de lo leído
es el ajuste local de una fila de Corrections, y solo en los niveles que se tocaron y solo
para ese pedido: no escribe ninguno de los dos archivos.

**Releer quiere decir releer el disco, no la memoria del panel.** La cola va a los archivos
**antes de cada job**, aunque ya los haya leído en esta sesión. La caché del panel sirve
para lo que se dibuja —las tarjetas, las filas de Corrections, los badges—, que no puede
esperar a un archivo, pero no ve el caso que este nivel vino a servir: el `.md` cambiando
**por afuera del panel**, cuando otro editor sincroniza el `.prproj` o vos lo abrís en un
editor de texto. Ahí no hay ningún guardado del panel que refresque nada, y un lote de
veinte marcadores corre más de una hora: el archivo puede cambiar en el medio, y el marcador
número doce tiene que salir con lo que el archivo diga **en su momento**. Lo que cuesta es
una lectura de dos archivos de pocos kB por job, en proceso, medido en 1,3 ms cada veinte,
contra los minutos de modelo y render que ese job va a gastar igual —y contra una generación
entera tirada por salir con el estilo viejo—. Los diseños que arrancan juntos leen **una
sola vez** si son de la misma clase, y un parpadeo de lectura en el medio del lote no borra
lo que ya se había leído bien: se sigue con eso y el ⬇ Log lo dice.

Lo que **quedó afuera** de este cambio fueron las imágenes de referencia, que tenían el mismo
problema. Ya no: está contado en la sección que sigue.

## Las referencias viajan con el proyecto

El texto del estilo del curso viajaba desde la 1.5.0; sus **referencias** —capturas, logos,
manuales de marca, PDFs— no. Se guardaban como data URL en el `localStorage` de la máquina
que las arrastró, con una sola bolsa por secuencia y ninguna del curso. O sea: el bloque que
promete *"viaja con el .prproj"* no tenía dónde poner el manual de marca, y lo que sí se
podía adjuntar —del lado de la clase— se quedaba en una computadora. El compañero abría el
mismo proyecto, generaba, y el gráfico salía sin la marca. Nada fallaba.

El peso lo hacía urgente aparte de incorrecto. Un cuadro de programa de 1920×1080 en PNG
pesa **3,5 MB medidos**; en base64 son 4,7 MB, y el panel reescribía la entrada **entera** en
cada tecleo del campo de texto (+1,6 ms por `setItem`). El `localStorage` de CEP tiene un
techo y al pasarse **falla en silencio**: dos capturas y un PDF ya lo rozaban.

### Dónde quedan ahora

Dos carpetas, con la misma geometría que los dos `.md` y por el mismo motivo:

```
<carpeta del .prproj>/HyperPremiere/_referencias/                ← las del CURSO
<carpeta del .prproj>/HyperPremiere/<secuencia>/_referencias/    ← las de ESA clase
```

Las del curso son **del proyecto**, no de una secuencia: se leen igual con cualquier clase
abierta, y sin ninguna abierta también. Las de la clase viven en su carpeta y se van con
ella. Cada bloque escribe en la suya y en ninguna otra: quitar una del curso no toca las de
la clase, y hay tests que lo fijan en los dos sentidos.

Al lado de los archivos hay un **`referencias.json`**, y no es redundante: de cada referencia
hay que saber tres cosas que un archivo suelto no dice —en qué **orden** va (el prompt las
numera *imagen 1, imagen 2…* y el editor las nombra así en su instrucción), si es imagen o
documento, y si está marcada **✓ usar**, o sea si se incrusta o solo se mira—. La carpeta
manda sobre el manifiesto en lo único que puede: un archivo que el manifiesto nombra y no
está se dibuja como **faltante**, con su motivo (el disco externo desmontado es el caso), en
vez de desaparecer de una lista más corta y sin explicación; y un archivo que alguien soltó
en la carpeta desde el Finder se **adopta** al final, como referencia. La carpeta viaja con
el proyecto: que se vea lo que hay adentro es parte del trato.

### Lo que ya estaba en el `localStorage`

Se migra al abrir el panel, con las mismas tres salidas que el texto y por el mismo criterio.
La migración es **explícita** (`HPRefs.migrate`) y la llama **solo la vista**, una vez por
contexto: la cola llama a `load`, que lee y nada más. Si migrar viviera adentro de la
lectura, encolar una corrección de un corte que nunca se abrió en esta máquina subiría al
proyecto —para los dos editores— material que estaba en una sola, desde un camino que nadie
mira.

- **La carpeta de la secuencia está vacía** → sube ahí, y recién entonces se limpia lo local.
  A la de la **secuencia** y no a la del curso porque es lo que ese material decía ser: el
  bloque se llamaba *"Referencias de esta secuencia"* y la clave del `localStorage` lleva el
  nombre de la clase. Promoverlo al curso sería decidir por el editor que el manual de una
  clase es el de todas, y eso le llega a todos.
- **Ya está lo mismo en el proyecto** (mismo nombre y mismo tamaño) → la copia local sobra y
  se borra sin molestar a nadie. Se compara por nombre y bytes, que es lo que distingue un
  archivo de otro sin leerlo entero: decodificar 1,5 MB en el hilo del panel para contestar
  *¿es la misma?* sería pagar justo lo que este cambio vino a dejar de pagar.
- **Hay las dos cosas y no son lo mismo** → no se toca ninguna. Lo local se aparta y el panel
  pregunta, con tres respuestas: *son de esta clase*, *son del curso* o *descartarlas*. Las
  dos primeras **suman**, no reemplazan: del otro lado hay material que puso otro editor, y
  borrarlo para poner el propio es la pérdida que este cartel existe para evitar. Si sobra
  una, se saca con su ✕ viendo cuál se saca.

Lo local se aparta **antes** de vaciarse, y solo se vacía si el apartado quedó escrito: al
revés, un `localStorage` lleno perdería las dos copias de una. Y si la escritura en el
proyecto falla —disco de red caído, permisos—, **no se borra nada de esta máquina**: hay un
test que lo comprueba rompiendo el guardado a propósito.

### Y mientras eso no termina, no se genera

Entre que el panel abre y que la migración contesta hay una ventana en la que las
referencias todavía no viajan; y si quedó **en conflicto**, esperando que el editor
conteste, no viajan hasta que conteste. Generar ahí sale **sin la marca**, se ve
presentable y no falla nada: es el modo de falla mudo que en este proyecto ya se pagó
tres veces. Y el motor no puede avisar, porque no sabe que hay material en el limbo: el
único que lo sabe es el panel.

Así que el panel **frena la cola antes de gastar un token**, con las mismas tres
respuestas que usa para el transcript:

- **La migración está en vuelo** → se espera y listo. Es el caso del día que se
  actualiza: dura lo que tarda el disco, se resuelve sola, no aparece ningún cartel y el
  material viaja.
- **Quedó material esperando una decisión** (el conflicto), **o de una clase que esta
  máquina nunca abrió** → la cola se pausa y se dice qué falta: cuántas referencias, de
  qué clase, y qué hacer para soltarlas.
- **Volvés a apretar ▶ Iniciar cola** → se genera igual, y queda escrito en el ⬇ Log qué
  salió sin qué. La decisión es del editor —puede tener el material en la otra máquina y
  querer el gráfico igual—; lo que no puede pasar es que salga callado.

El chequeo corre para **todos** los jobs de IA, correcciones incluidas, y mira la clase de
la que sale el material: al corregir algo generado en otro corte, la de **origen**. Con el
`localStorage` vacío —o sea todos los días menos uno— contesta que sí en la primera línea:
nadie espera nada ni ve ningún cartel.

Queda un caso que solo se puede **contar**, no detallar: quien guardó referencias contra
seis clases y abre una deja las otras cinco esperando. Al abrir el panel se dice cuántas
son y que se suben solas al abrir esa clase, pero no de cuál es cada una: el namespace del
`localStorage` es un hash de proyecto + secuencia y no se invierte. Nombrarlas exigiría
guardar un índice de contextos que existe únicamente para este aviso.

### Cómo llegan al modelo, proveedor por proveedor

Las imágenes **viajan como rutas hasta el último momento**. El contrato de los proveedores
sigue siendo data URL, así que el que lo necesita convierte al momento de llamar; el que lee
archivos usa la ruta y se ahorra el viaje. Esa decisión se toma por proveedor y no por el
panel, que es lo que estaba mal antes: `claude-cli` no puede recibir imágenes inline y
escribía a archivos temporales lo que el panel había convertido desde archivos reales.

Con los **documentos** hay una diferencia que sí importa:

- **Los de texto** (`.md`, `.txt`, `.csv`, `.json`) se **pegan en el prompt**, en su propia
  sección. Es lo mismo que escribir su contenido en el campo, y así llega igual por una API
  que por un CLI. Llegan a los cinco proveedores.
- **Los binarios —un PDF—** solo pueden llegar por un agente que abra archivos, y son dos:
  **`claude-cli`**, al que se le declara la carpeta con `--add-dir`, y **`cursor-cli`**, que
  trabaja encerrado en un workspace temporal y necesita una **copia adentro**. Nombrar la
  ruta no alcanza para ninguno de los dos, y escribirla desde el motor sin saber cuál
  atiende era exactamente lo que hacía que con Cursor el PDF quedara nombrado en el prompt y
  fuera de su alcance.
- Con **`claude-api`, `openai-compat` y `ollama` el PDF no llega**, y ahora **se dice antes
  de gastar la llamada**. Antes pasaba en silencio: el panel aceptaba el archivo, el prompt
  escribía su ruta y el modelo, que no tiene disco, componía sin él. Prometer en la interfaz
  que se puede pasar documentación y no mandarla es la clase de mentira que ya salió cara
  acá; si no llega, se dice.

Los documentos que **ya son archivos del proyecto** se usan **donde están** y no se copian a
la carpeta de cada versión. No es cosmético: los dos niveles generales entran en **todos** los
marcadores de la clase, y copiar un PDF de 8 MB al lado de cada versión de cada uno son
cientos de MB de la misma cosa —veinte marcadores por tres versiones ya son 480 MB—.

### Cuánto pesa

Medido, no estimado, sobre un caso realista: un curso con 3 referencias del curso (logo,
guía de estilo en PDF y una captura de programa) y 3 por clase en 3 clases.

| | |
| --- | --- |
| carpeta del curso | 3,6 MB |
| las tres clases | 31,7 MB |
| **total** | **35,3 MB** |
| lo mismo en base64, que es lo que iba al `localStorage` | 47,1 MB |

Lo que pesa son las **capturas de programa**: 3,5 MB cada una, porque un cuadro de video en
PNG no se comprime. El PDF y el logo juntos no llegan a 100 kB. Al lado de los `.mov` de
decenas de MB que están en esa misma carpeta, no hay nada que discutir, y **no se dedupe por
hash**: sumar un índice de hashes para ahorrar unos MB en la carpeta donde se guardan los
renders es complejidad que se paga siempre para un ahorro que casi nunca aparece. Si algún
día el mismo logo aparece en veinte clases, se revisa entonces.

## Dictar la instrucción en vez de escribirla

**Abajo** de cada campo donde se escribe un pedido —la instrucción de cada marcador, los dos
prompts de estilo, el objetivo de la clase, el feedback de la Cola y el de Corrections— hay
una barra de controles, y el primero es el **micrófono**. Un clic arranca, otro para; no hay
que mantenerlo apretado. Mientras se habla, el texto va apareciendo de a frases con un par de
segundos de retraso, y al parar un modelo chico lo convierte en una instrucción de diseño
legible: reordena y estructura, conserva todo lo que se pidió y **no inventa** nada que no se
haya dicho. Queda en español, con los términos técnicos en inglés como se dijeron —nadie
quiere leer *fotograma clave*. Y al lado aparece un **↩ dictado crudo** que devuelve lo que
se dijo textual, por si el refinado no gustó.

**El micrófono está en verde cuando se puede dictar y en rojo mientras escucha**, que es lo
que pidió el editor. Y el verde quiere decir exactamente una cosa: *se puede dictar y no
estoy escuchando*. En una máquina donde el dictado no está disponible —Windows, sin ffmpeg,
sin el Whisper de Apple Silicon— el botón queda **gris** y no verde: sería el mismo color
prometiendo lo contrario de lo que pasa. Mientras prepara o mientras refina queda apagado, y
antes de saber qué tiene la máquina queda neutro. El color tampoco es el único canal, que es
lo que pide WCAG: el **dibujo cambia** —un micrófono cuando está listo, un cuadrado de parar
mientras escucha— y el tooltip lo dice con palabras. Quien no distingue el rojo del verde ve
un cuadrado.

Y son **dibujos y no emojis**. El 🎙, el ✨, el 📸 y compañía estaban tipeados en el JS, así que
los dibujaba la fuente de emoji del sistema: el panel se veía distinto en cada máquina, cada
uno traía su propio alto de caja —la fila quedaba desalineada por dentro— y, sobre todo, un
emoji **no hereda el color del texto**, o sea que un micrófono en rojo era imposible. Ahora
son SVG de líneas, con un dibujo por concepto. Eso arregló además algo que se venía
arrastrando: los dos botones de "rehacer" de la caja de feedback (↻ y ⟲) eran **el mismo
dibujo** —una flecha en círculo— para las dos acciones más opuestas que hay ahí, una que sigue
el diseño anterior y otra que lo tira. Ahora *Aplicar el ajuste* son dos rieles con su perilla
(calibrar algo que ya existe) y *Regenerar desde cero* es el lazo que vuelve al principio.

Lo que ya estaba escrito en el campo no se pisa nunca: el dictado se agrega abajo mientras
se habla, y al parar las dos partes se refinan **juntas, como una sola idea**, no una atrás
de la otra. El texto en vivo, en cambio, se reescribe entero en cada refresco. No es un
detalle cosmético, es consecuencia de cómo está armado: el motor no trocea el audio en
pedazos de dos o tres segundos, retranscribe **todo el buffer** cada segundo y medio. Suena
caro y es al revés —con el modelo cargado en memoria, treinta segundos de habla se
transcriben en medio segundo— y a cambio la frase se corrige sola a medida que crece el
contexto, en vez de quedar cosida de pedazos que no se conocen entre sí.

**El campo se abre y crece con lo que se va diciendo**, para poder ir leyéndolo. Al arrancar
se despliega si estaba plegado y se sube a la vista, después se agranda con el texto y, en el
tope, se queda ahí mostrando siempre **el final** —lo último que se dijo—, que hay que
volver a poner a la vista en cada refresco justamente porque el texto se reescribe entero. El
tope es una fracción del alto del panel y no un número de píxeles, porque el panel se
redimensiona (abre en 400×600, va de 320×400 a 2200×2200): son 180 px de campo en un panel
en su alto mínimo y 270 en el de arranque. Lo que manda es que el **🎙 quede alcanzable para
parar**; un campo que lo empuja fuera de la vista deja al editor dictando sin poder frenar, y
eso es peor que no tener la función. Al terminar, el campo vuelve al alto de lo que quedó
escrito.

**El micrófono lo abre ffmpeg, no el navegador del panel.** `getUserMedia` dentro de un
panel CEP no tiene un solo reporte público de funcionar, y apoyar la función entera en eso
era una apuesta; ffmpeg ya es requisito del proyecto y capturar con él está medido. Saca
PCM crudo por `stdout` y el motor lo acumula en memoria —escribir un `.wav` e ir leyéndolo
no sirve, porque ffmpeg lo vacía en bloques de ocho segundos—. Por eso el dictado es **solo
para Mac por ahora**: la captura usa avfoundation, y el equivalente de Windows no está
probado. En Windows el botón se ve, deshabilitado, y dice exactamente eso; la instrucción
se escribe a mano como siempre. Lo mismo si falta ffmpeg o el Whisper local: el botón lo
dice y apunta al arreglo, y **el campo sigue funcionando igual**. El dictado es un
agregado, nunca un requisito: si el módulo no carga, ningún campo de prompt deja de
dibujarse.

**Whisper para dictar es otro, y es `small`.** El de las clases (`large-v3`) es la peor
elección para esto: 0,84 s de inferencia contra 0,29 s, por una precisión que en una frase
dictada no aparece. Y no se bajó más porque `base`, que es más rápido, rompe justo lo que el
editor no puede dejar pasar —medido con la misma frase, `base` devolvió *"que entre con un
FAKE… los QUE Y FRAMES"* donde `small` escribió *fade* y *keyframes*—. La primera vez que se
dicta en una máquina hay que bajar el modelo (~480 MB) y el botón lo dice en vez de quedarse
colgado. El proceso de Whisper se levanta al primer dictado y se queda vivo, porque cada
invocación suelta del CLI paga un piso de 1,2 s que es entre ocho y quince veces lo que
cuesta transcribir; tras cinco minutos sin usarse se baja solo, que son ~500 MB de modelo
que no vale la pena tener residentes al lado de Premiere. Como usa su propio modelo, un
dictado nunca frena una transcripción de secuencia que esté corriendo.

**El silencio hace inventar a Whisper**, y no es teoría: un segundo de sala callada volvió
como *"¡Suscríbete!"*, y en otra corrida como *"! las las las las"*. Son las frases más
repetidas en los subtítulos con los que se entrenó. Lo único que lo evita es no llamar al
modelo, así que hay una compuerta de volumen medida con este micrófono: la sala callada
está entre −44 y −37 dBFS y el habla llegando en −21, y el umbral va en −34, del lado
estricto a propósito. Si queda alto, alguien que habla bajito lee *"entró audio pero está
en silencio"* y sabe qué tocar; si quedara bajo, leería *"¡Suscríbete!"* metido en la
instrucción de su marcador y pensaría que la función está rota. Para una sala ruidosa o un
micrófono flojo, `HYPERPREMIERE_DICTADO_RMS` lo ajusta. Lo que igual se cuele tiene una red
abajo: si la transcripción entera es una de esas frases, se descarta.

**Refina el proveedor que elegiste en ⚙.** Durante un tiempo no fue así, y el editor lo
notó: *"si tengo configurado el CLI de Cursor, aún siento que el botón de refinar manda el
prompt por Claude, no por el que tengo seleccionado"*. Tenía razón. El refinado recorría una
lista fija —API de Anthropic, CLI de Claude, Ollama— y nunca miraba qué proveedor estaba
elegido. El razonamiento era de costo, y no era descabellado: refinar dos frases es una
llamada de segundos que pasa cada vez que alguien suelta el botón del micrófono, así que
convenía la vía más barata que hubiera en la máquina. Pero en la suya la cuenta de Claude no
tenía cupo, así que el botón **no funcionaba teniendo la máquina con qué refinar**. Elegir un
proveedor y que el panel hable con otro es confuso; que además rompa la función es
directamente un bug.

Ahora la regla es una sola: **si el proveedor elegido puede refinar, refina él**. Vale para
todos —elegiste Claude, refina Claude; elegiste Ollama, refina Ollama; elegiste Cursor,
refina Cursor—. La cadena vieja quedó como **respaldo**, y solo entra cuando el elegido no
puede (sin sesión, sin cupo, sin credencial). Ahí su orden sigue siendo por costo y latencia:
la **API de Anthropic** primero si hay key configurada (HTTP directo, sin arranque de ningún
CLI), después el **CLI de Claude con Haiku**, después **Ollama local**. Si no hay ninguno el
dictado no se rompe: queda el texto crudo en el campo y se dice por qué no se pudo refinar,
empezando por el proveedor que elegiste, que es el único que te conviene arreglar. Y cuando
refina el respaldo **se dice** —"Claude Haiku (API de Anthropic) (respaldo)"—, porque el
texto que apareció en el campo lo escribió otro modelo y eso hay que saberlo.

**Qué modelo se le pide a cada uno.** Refinar no es diseñar, así que a nadie se le pide el
modelo con el que generás animaciones: a Claude se le pide **Haiku**, a Ollama el modelo
chico que ya tengas instalado, y a Cursor **Claude Sonnet 5**. Ese último se eligió midiendo
y salió al revés de lo esperable: refinando el mismo dictado, Composer 2.5 —el modelo propio
de Cursor, el que uno tomaría por "chico y rápido"— tardó 6,8-8,9 s y mandó **8.647 tokens
frescos**, mientras que Sonnet tardó 5,7-7,1 s y mandó **2**. Cursor le cachea el contexto
del agente a los modelos de Anthropic y a los suyos no. Con la API compatible se usa el
modelo que hayas configurado: atrás puede haber OpenAI, Gemini u OpenRouter, y el ID de un
hermano más barato no existe en la mitad de ellos.

**Refinar por Cursor cuesta más, y por eso no es el respaldo de nadie.** Medido en esta
máquina: ~6 segundos y ~9.500 tokens escritos a caché por llamada, contra los ~2 segundos de
Haiku por la API, porque el CLI arrastra su propio contexto de agente por corto que sea el
pedido. Como respaldo sería elegir lo más caro habiendo alternativa; como proveedor elegido
es lo que pediste, y el panel te avisa lo que estás pagando (la demora, y que ese gasto va a
tu cupo de Cursor). Lo que
vuelve del refinador pasa por un control de tamaño antes de tocar el campo —con un modelo
chico corriendo local, `llama3` se comió dónde iba el título y agregó un *"sin pérdida"* que
nadie dijo— y si no lo pasa se conserva el crudo con el motivo escrito. El log dice qué
modelo refinó y cuánto tardó, que es lo primero que hace falta cuando alguien dice *"el
dictado me sale raro"*. Y el gasto va a un bolsillo **aparte** en el contador de la sesión,
para que no se confunda con lo que cuestan las animaciones.

**Y el mismo refinado, para lo que se escribió a mano.** Al lado del micrófono hay un
**✨ Refinar** —con la palabra desde 381 px de ancho de panel, o sea también en el que abre
Premiere; por debajo queda el dibujo solo, que es donde el panel ya se queda sin lugar para
las palabras—:
toma lo que hay tecleado en ese campo y lo pasa por el refinador de arriba —la misma cadena, el
mismo control de tamaño, el mismo bolsillo del contador—, dejando el resultado en el campo
y un **↩ texto original** al lado, que devuelve lo que había *carácter por carácter*, con
sus espacios y sus renglones en blanco. Se puede apretar una vez: después queda apagado
hasta que el texto cambie, porque refinar lo refinado gasta tokens para empeorarlo; si se
vuelve al original, o si se sigue escribiendo, se prende de nuevo. Con el campo vacío está
apagado, mientras se dicta también —al parar, el dictado se refina solo— y se refina de a
uno en todo el panel, como hay un solo micrófono. La diferencia con el dictado es qué pasa
cuando falla: acá el campo **no se toca**. Un dictado se puede pisar con el crudo, porque
el crudo es lo que acababa de entrar; un párrafo que alguien escribió con las manos no se
pisa con nada, así que si el refinador se cae o el control de tamaño lo rechaza, queda el
texto tal cual y el motivo escrito abajo.

**Refinar no necesita micrófono, ni ffmpeg, ni Whisper, ni ser una Mac**: es una llamada de
texto a texto. Por eso "se puede dictar" y "se puede refinar" son dos respuestas separadas
y no una, y **el ✨ funciona en Windows**, donde el micrófono no. Ese es el punto de todo
esto: el editor que escribe todo a mano *porque* no puede dictar es justamente el que más lo
necesita, y colgar el botón nuevo de la respuesta del micrófono se lo escondía a él. Cada
botón apagado dice en su tooltip qué le falta a esa máquina —el micrófono el avfoundation o el
Whisper, el ✨ la API key, la sesión del CLI o el Ollama que no está corriendo— y ninguno
de los dos se esconde: que una función exista y no esté disponible es información, que no
esté es un misterio. Una aspereza medida acá, con el CLI de Claude como refinador: de siete
refinados de una instrucción de marcador, cinco tardaron entre 7,9 y 16 segundos (mediana
~8) y **dos se colgaron hasta el tope de 45 s**. El texto queda intacto y se dice el
motivo, pero ocho segundos ya se sienten y cuarenta y cinco son un callejón. Con una API
key de Anthropic no se paga el arranque del CLI, que es de donde sale casi todo ese número.

Dos asperezas honestas. El texto en vivo **va quedando atrás** del que habla: medio segundo
al principio, unos dos y medio a los veinte segundos. Se aisló capturando sin transcribir y
el retraso es idéntico, así que es de ffmpeg/avfoundation, no del modelo; probar a 48 kHz
nativo sin resamplear no cambió nada. Para el texto final no importa, porque al parar se
procesa el buffer completo, pero la sensación de "en vivo" se degrada en dictados largos. Y
un dictado se corta solo a los cinco minutos, con aviso: para una instrucción de marcador
es muchísimo, y el costo de cada refresco crece con el largo del buffer.

### Qué micrófono, y cómo saber que anda

Con una interfaz de audio, unos auriculares Bluetooth y una webcam enchufados, "el
micrófono" no dice nada. En la máquina donde se armó esto, ffmpeg lista **seis** entradas
de audio y una sola es un micrófono de verdad que suena: el `[0]` es el iPhone por
Continuidad, el `[1]` la webcam, tres son dispositivos virtuales de Steam y Zoom, y el `[2]`
es el de la MacBook. Por eso el desplegable de micrófono está **en el encabezado del panel**,
al lado del ⬇ Log: cambiar de micrófono es algo que pasa entre marcador y marcador —te
sacás los auriculares, enchufás la interfaz— y hacerlo abriendo la configuración era
esconderlo detrás de dos clics. En ⚙ sigue estando la fila **Micrófono** completa, que es
donde se diagnostica: el mismo desplegable con el nombre entero, un ↻ para volver a
preguntar cuando enchufás algo sin cerrar el panel, la línea que dice cuál se está usando y
por qué, y **Probar micrófono** con su medidor. Es **un solo control con dos vistas**, no dos
desplegables: elegís arriba y ⚙ ya muestra el nuevo sin recargar nada, y abrir el panel corre
ffmpeg una vez y no una por vista. Y el botón 🎙 de cada campo dice en su tooltip cuál va a
abrir; mientras dicta, la línea de estado también lo nombra.

**Arriba hay 34 px, así que arriba se dice distinto.** En un panel angosto el desplegable
queda en el ícono 🎙 solo y el nombre del dispositivo se lee en el tooltip: media palabra
—"MacBoo…"— no es información. Con algo más de ancho aparece el nombre sin el "Microphone"
que repiten los seis dispositivos de esta máquina ("MacBook Pro", "OBSBOT Meet 2"), y si es
larguísimo —los virtuales de Steam lo son— se acorta por el medio, que conserva el sufijo que
diferencia uno del otro. El **menú desplegado no se cuelga del botón sino del encabezado**:
toma el ancho del panel, y ahí los nombres completos entran enteros incluso en 320 px. Si el
elegido no está enchufado, el desplegable de arriba se pone en ámbar y lo dice en el tooltip.

**Donde no se puede dictar, no hay desplegable arriba.** En Windows, sin ffmpeg o sin el
Whisper de Apple Silicon, el encabezado no dibuja un control de una función que no corre —un
desplegable vacío es peor que ninguno—, y el porqué lo siguen diciendo ⚙ y el 🎙 de cada
campo. Si el motor no contesta si se puede dictar, se muestra igual: no saber no es "no hay".
Cambiar de micrófono **con un dictado andando** no lo rompe ni lo cambia: el motor resolvió
nombre → índice al abrir el dispositivo y su ffmpeg ya está corriendo con ése. Vale desde el
próximo dictado, y eso se dice en la fila en vez de dejar creer que el cambio fue en vivo.

**Se guarda el nombre, no el índice.** Los índices de avfoundation son la posición en la
lista de ese momento: enchufar unos auriculares corre a todos los demás un lugar, y sin el
iPhone cerca el micrófono de la MacBook pasa de `[2]` a `[1]`. Un índice guardado abriría
mañana otro dispositivo sin avisar. El nombre es lo único estable, así que la elección se
guarda por nombre —en la config de la máquina, junto al proveedor, porque un micrófono es de
la computadora y no del proyecto— y se resuelve al índice de hoy en el momento de capturar,
con la lista fresca. Si el elegido no está, se cae al del sistema **diciéndolo**: en amarillo
en ⚙, en el tooltip del 🎙, en la línea mientras escucha y en el log, nunca en silencio, y
el elegido sigue apareciendo en el desplegable como "no conectado ahora" para que no se
pierda cuando lo vuelvas a enchufar. Sin elección se usa `:default`, que avfoundation acepta
para audio —está verificado con ffmpeg acá, no supuesto— y abre el que macOS tiene como
entrada en Ajustes del Sistema → Sonido → Entrada; es mejor que "el primero de la lista",
que en esta máquina sería el iPhone. Para poder **decir** cuál es ese default sin abrir el
micrófono (abrirlo dispararía el permiso de macOS por el solo hecho de abrir ⚙) se le
pregunta a `system_profiler`, que tarda 0,14 s y usa los mismos nombres que avfoundation. La
fila lo dice tal cual: *"todavía no elegiste micrófono: uso el que macOS tiene por defecto,
«MacBook Pro Microphone»"*.

**La prueba abre el micrófono con el mismo comando que el dictado**, hasta el último
argumento: si el medidor anduviera y el dictado no, la prueba habría mentido, y para eso no
sirve. Durante siete segundos muestra una barra con el nivel en dBFS, un tic con el pico
sostenido y una marca fija donde está la compuerta de silencio del dictado (−34 dBFS): la
barra se pone verde cuando tu voz la cruza, que es lo único que hay que mirar. Al final, un
veredicto en palabras. Si entra audio y pasa la compuerta, podés dictar. Si entra señal pero
floja, dice el promedio y el pico en números y qué tocar (el volumen de entrada, acercarse,
otro micrófono), y distingue el caso de haber hablado poco: el dictado mira el **promedio de
todo lo grabado**, así que si el pico pasa pero el promedio no, lo que hace falta es hablar
seguido, no cambiar de micrófono. Si el dispositivo abrió pero no entregó **ni una muestra**
—medido acá con el iPhone por Continuidad y el teléfono lejos— o entregó muestras **todas en
cero exacto** —lo que dan los dispositivos virtuales y un micrófono con el permiso negado— lo
dice por su nombre, y en los dos casos nombra el camino que el editor no puede adivinar: la
captura la hace ffmpeg, hijo del panel, hijo de Premiere, así que el permiso de micrófono lo
pide y lo tiene **Adobe Premiere Pro** como app anfitriona; el diálogo del sistema dice
"Adobe Premiere Pro 2026", y si alguna vez se le dijo que no, macOS no vuelve a preguntar:
Ajustes del Sistema → Privacidad y seguridad → Micrófono, prender Adobe Premiere Pro y
reiniciar Premiere. Si ffmpeg directamente no pudo abrir el dispositivo, el veredicto trae su
error textual, y sabe leerlo: un índice que ya no existe se diagnostica como "refrescá la
lista", no como un problema de permisos, aunque ffmpeg lo reporte con el mismo
`Input/output error` genérico.

**Todo queda en el log**, pensado para diagnosticar desde otra máquina, con el archivo que
baja ⬇ Log y nada más: la lista de dispositivos con nombre e índice cada vez que se enumera y
cuál es el default del sistema; cuál está elegido, si lo eligió el editor o es el del
sistema, y si el elegido no apareció y se cayó a otro; al arrancar cada dictado y cada prueba,
el dispositivo, el índice resuelto y el comando exacto de ffmpeg que se lanzó; durante la
prueba, un resumen de niveles (mínimo, máximo, promedio, cuántas lecturas, cuántas muestras
en cero) y no las setenta lecturas una por una; el veredicto; y, si algo falló, el `stderr`
de ffmpeg tal cual. Una línea que sí aparece siempre en esta máquina y no es un error:
`CMIOMS: EOSWebcamUtilityMain`, que la deja un plugin de CoreMediaIO en cada arranque de
ffmpeg. Se filtra para decidir si ffmpeg se quejó —sin eso, "no entró audio y stderr dice
algo" se dispararía en falso con el micrófono andando— y se conserva en el log, por si algún
día sí importa.

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

Lo primero que cubren es **la regla de oro**: que el panel no te borre material. Con la
secuencia de destino **inactiva** y la pista de arriba **ocupada** —el caso exacto del bug—
se fija que `overwriteClip` **no se llame nunca** sobre un tramo con clips: que la pista
nueva se le pida a la secuencia de destino y no a la que estás mirando; que si no se puede
agregar (QE que acepta y no hace nada, QE que explota, Premiere que no deja abrir la
secuencia) la colocación **falle sin tocar nada** y con un mensaje que diga qué hacer; que
la vista vuelva **siempre** a tu secuencia, también cuando algo falla; que no se te mueva
el cursor de reproducción; y que si arriba hay lugar **no se cambie de secuencia en
absoluto** (si no, con varios renders terminando seguidos la vista estaría saltando todo el
tiempo). El Premiere de mentira respeta la limitación que originó el bug: QE solo alcanza
la secuencia que está al frente, así que un intento de agregar pistas sin activarla no hace
nada, igual que en el Premiere de verdad. Y hay un test para la **red de seguridad sola**,
con una pista nueva que viene ocupada (imposible en la vida real): la última comprobación
antes de escribir tiene que frenar el clip igual.

De la misma familia, **buscar la secuencia por nombre y poder colocar después**: que una
secuencia ilegible en el medio de la lista no borre del mapa a las que siguen (con los
nombres reales del proyecto donde pasó, y la del caso al final, que es lo que la hacía tan
fácil de perder), que la del frente que no se deja leer no salga como "EvalScript error",
que el "no la encontré" cuente cuántas miró y en qué proyecto, que se avise cuando está en
**otro proyecto abierto**, que se ofrezca el nombre parecido sin inventar sospechosos, que
un espacio de más no sea otra secuencia pero **dos** candidatas no se adivinen, y del lado
del panel: que el recurso quede marcado con el `.mov` y el motivo textual de Premiere, que
colocarlo después **no gaste ni una llamada** de IA ni de render, que conserve su color, que
un segundo fallo no borre el motivo, que la marca sobreviva a cerrar el panel, y que un job
guardado por una versión **anterior** —sin la marca y sin la ruta— se reconozca igual y
encuentre su video en el disco (o lo diga, si ya no está).

Cubren también el **estado en vivo**: el traductor de la salida de los CLI —con
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

Y el **contador de la sesión**, eslabón por eslabón, porque el número se puede perder en
cualquiera y sin que nada falle: que el mapeo de cada CLI no deje la caché afuera (con el
`usage` real de los dos, incluido el `cacheWriteTokens` de Cursor, que un rename pondría en
cero calladito), que las hasta tres llamadas de un mismo recurso sumen su entrada completa,
que un proveedor que no manda el total no lo deje en cero, que el panel acumule la caché y
lleve el costo con **cuántas** generaciones lo informaron, que un acumulado guardado por
una versión anterior siga sumando desde donde iba, y que la línea que se lee diga la
entrada completa, cuánto fue caché y sobre cuántas generaciones se juntó ese costo.

Y el **login de Claude**: que sin CLI se falle al instante en vez de esperar el minuto,
que el timeout cuente qué encontró, que una versión vieja mande a actualizar, que un link
ajeno dentro de un error no se confunda con la autorización y que una ruta con espacios no
rompa nada.

Y, del otro lado, el **cartel de sesión**, que es el que mentía. Con un `claude` de mentira
que copia la salida real de `auth status` —y que, como el de verdad, contesta según el
**entorno**—: que el editor logueado por su terminal **no** reciba el cartel aunque el
panel no tenga ningún token guardado (el caso del log, y el que hay que no volver a
romper), que el token del panel llegue al proceso hijo y por eso cuente, que sin token
nuestro la variable de entorno **no se toque** —pisarla en vacío le sacaría al CLI su
propia sesión—, que faltar el CLI se diga aparte de faltar la sesión, y que un CLI viejo,
uno que contesta cualquier cosa o uno colgado terminen en **"no se sabe"** y no en un
aviso. Del lado del panel se prueba la regla sola, apretando sobre el ⚙ dibujado: que solo
se avise cuando se **sabe** que falta, ni mientras se averigua ni cuando no se pudo.

La **imagen de referencia** tiene su propia suite, y la mitad interesante es la que prueba
que el aviso **no** aparezca cuando no corresponde: que el modelo que abrió las dos
imágenes no reciba ninguna advertencia, que sin imágenes no se avise de nada y que sin
estado en vivo —donde no hay con qué comprobar— el panel se calle. Del lado que sí avisa:
que abrir una de dos se diga con el nombre de la que faltó, que la ruta se compare por
nombre de archivo (el modelo escribe `./imagen-1.png` cuando nosotros pasamos una absoluta),
que lo que leyó se saque de los mensajes **completos** y no de los eventos parciales —que
llegan sin la ruta—, y que denegar `Write` no vuelva a decirle al editor que su animación
se hizo a ciegas. Aparte, que el CLI arranque con `Read` y nada más, y que un CLI viejo que
no conozca el flag **genere igual**: soltar el acotado no puede llevarse puesto el estado
en vivo ni el system prompt.

Y el **selector de pensamiento** de Cursor, que se prueba de los dos lados: el motor
separando familia y nivel de la lista real del CLI (con las `-fast`, las `-none` y la gama
chica quedando afuera, como siempre), y el panel armando el ID de vuelta. Lo que fija cada
decisión: que no se ofrezca un nivel que la cuenta no tiene, que cambiar de familia nunca
produzca un ID inexistente, que el nivel del ID le gane al `effort` guardado, que una
familia sin niveles lo diga en vez de inventar uno, y que **Claude no se haya movido** —sus
cinco niveles siguen enteros y su ID sigue viajando pelado—.

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

Y el **render que no puede salir bien**, que es donde se tiraba un minuto para llegar a un
mensaje equivocado: que una composición sin andamiaje **no llegue** al render, que el
motivo no nombre la GPU (porque no es la GPU), que el HTML se conserve igual, que el error
permanente **corte** la escalera en el primer intento y que un crash, en cambio, **sí**
baje al escalón siguiente.

Y la **negativa del modelo**, con la respuesta real guardada como fixture: que se reconozca
como "esto no es HTML" y no como un contenedor que falta, que no se gaste la llamada de
estructura, que **no viaje** como HTML para que no quede guardada de versión, que una
composición mínima de una sola etiqueta **no** se confunda con prosa (y que la prosa que
nombra un tag al pasar sí), que una negativa que llega en la segunda o tercera llamada no se
lleve puesto el diseño ya pago, que la referencia para corregir saltee las versiones
envenenadas que hayan quedado en disco, y que el CLI de Cursor no se invoque en un modo de
solo lectura pero siga aislado en su temporal.

Y el **reparto de workers aprendido**: que no se comparen
marcadores de tamaños distintos, que una diferencia chica no cambie nada, que un pico de
carga no hunda a un reparto que en su mejor momento fue más rápido, y que lo aprendido en
otra máquina no se use acá.

Y los **marcadores de Frame.io**, donde el riesgo no es la tarjeta de más sino la
**numeración**: que un comentario intercalado no le corra el número a un marcador que ya
tiene archivos generados (con la contraprueba de cómo se veía el bug), que se reconozca el
nombre venga como venga, que no se lleve puesto un marcador del editor que se parezca
("Frames por segundo", "Frame final"), y que en un Premiere sin `guid` la numeración de
respaldo siga saliendo bien. Los dos comentarios **reales** del proyecto de un editor están
ahí como fixture, con su texto tal cual: son los que demuestran que el nombre no alcanzaba
—se llaman "Cande" y "Candela"— y son los que hoy se reconocen por el sello del comentario.
Con ellos se prueba también el otro lado: que un marcador de animación que **menciona**
Frame.io en su instrucción sobreviva, y que el log liste los ignorados sin desbordarse
cuando la revisión trae doce.

Y la pestaña **Corrections**, que trabaja sin los marcadores: que agrupe por marcador y
tome la última versión, que el **tramo** se recupere por las tres fuentes en orden y que
cuando no hay ninguna **se diga** en vez de inventarlo, que no se tome el tramo de un
trabajo de **otra secuencia** con el mismo nombre de marcador, que abrir la pestaña **no
cree carpetas**, que la corrección lleve el HTML de la versión **elegida** (no la
anterior), que vuelva al segundo original y **en amarillo**, que una generación normal
entre **sin etiqueta de color** (si todo saliera pintado, el amarillo no distinguiría
nada), que un job viejo con el campo `draft` colgado en su payload se coloque igual —ese
campo ya no lo lee nadie—, y que la marca de corrección **sobreviva** a reiniciar el
panel. Las
**tres pestañas** se prueban aparte: exactamente una vista visible, siempre.

De *Lo que recibió este marcador*, las dos mitades que se pueden romper sin que nada falle.
La **honestidad**: que la ficha guarde los tres niveles al preparar y al terminar el render y
que el render **manual** no los guarde; que una versión sin ellos vuelva del motor en `null`
—y no rellenada con los archivos de hoy, que es la mentira barata— y se muestre en pantalla
como reconstrucción, dicho con esas palabras. Y que el ajuste local **no sea decorativo**:
que se muestre y **viaje** al modelo, solo en los niveles tocados, dejando los demás como los
lea el disco; que no escriba ninguno de los dos archivos del proyecto; que `desde cero` lo
descarte; que sin ajuste la relectura siga intacta (arreglar el prompt del proyecto y
reintentar sale con el arreglado); y del lado del guardado explícito, que **pregunte** antes,
que escriba el archivo que dice y ninguno más, y que guardar el del curso deje al día a las
demás clases del proyecto sin pisarles el suyo.

Y las **referencias que viajan con el proyecto**, que es un cambio de almacenamiento y por
eso se prueba de las dos puntas. Del lado del disco: que las del curso queden al lado del
`.prproj` y las de la clase en su carpeta, que **otra máquina** que abre el mismo proyecto
las lea, que el manifiesto conserve el orden y la marca ✓ usar, que un nombre repetido se
desempate en vez de comerse al anterior, que un archivo que ya no está se reporte
**faltante** y uno que apareció a mano se **adopte**, y que vaciar o borrar en un nivel no
toque el otro —en los dos sentidos—. De la migración: que lo local suba a la carpeta de la
**secuencia** y no a la del curso, que lo idéntico se limpie sin preguntar, que lo distinto
**no pise nada** y quede apartado, que el apartado **sobreviva** a cerrar el panel, que las
tres respuestas **sumen** en vez de reemplazar, y que si la escritura en el proyecto falla
**no se borre nada** de esta máquina. Y del camino al modelo: que un pedido de verdad salga
con las del curso **y** las de la clase, en ese orden; que una corrección de otro corte vea
las de **su** secuencia de origen; que la cola no migre nada; que el estimado de tokens
cuente las mismas que se van a mandar; que un `.md` se pegue en el prompt, que un PDF llegue
a `claude-cli` por su carpeta declarada y a `cursor-cli` por una copia en su workspace, y
que con un proveedor que no abre archivos se **avise** en vez de mandar sin él. Y del
**chequeo previo**: que con material sin migrar la cola frene sin gastar un token y lo
explique, que insistiendo se genere igual dejándolo escrito en el log, que una migración en
vuelo se **espere** y el material viaje sin ningún cartel, que una corrección de otro corte
se frene por el material de **su** clase, y que a quien no tiene nada guardado no le
aparezca nada ni tenga que esperar.

Y el caso de la clase **re-cortada**, que es el que apareció en producción: que estando
parado en "…_105875_02" se encuentren los recursos de "…_105875" y se **avise** que la
elección la hicimos nosotros; que "Clase 10" **no** pase por otro corte de "Clase 1"; que
el recurso se escriba en la carpeta de **origen** mientras el clip va a la secuencia
**abierta**, con las imágenes de referencia saliendo de la de origen; que cambiar el
segundo **no** mueva el tramo del transcript que lee el modelo; y que los dos nombres —45
caracteres iguales salvo el sufijo— se muestren recortados a **lo que los diferencia**, que
es lo único que evita corregir el corte equivocado.

Y **mirar y rehacer desde la Cola**, apretando los botones de verdad sobre la cola
dibujada: que el clic en el nombre lleve al timeline y **no** arrastre el panel a otra
pestaña (y que a Marcadores se siga llegando por "Editar HTML"), que refinar con el cuadro
vacío **avise** en vez de rediseñar por su cuenta —que era lo que pasaba antes y se
descubría viendo el resultado—, que desde cero **pregunte siempre** (y que la pregunta
aclare que el feedback escrito no se usa) y no arrastre **nada** de la ronda anterior (ni HTML previo, ni el ajuste, ni la selección de
imágenes), que el "Colocar" del intento viejo deje de ofrecerse al reencolar, y del
filtro: que solo aparezca cuando hay más de una secuencia, que oculte sin tocar la cola
—los contadores siguen siendo del total—, que diga cuántos quedaron afuera y que se
recuerde entre sesiones.

Y el **cartel de "Preparar motor"**, el primero de los dos tests de ancho del repo y por eso
vale aclarar qué fija y qué no. El botón quedaba **aplastado a 22 px** al lado del texto largo
del cartel —culpa del `button { flex: 1; min-width: 0 }` global, que está para la barra de
acciones, donde tres botones se reparten la fila— y su etiqueta se iba **18 px afuera del
panel**, con scroll horizontal en todo el panel y a **cualquier** ancho (medido a 360, 400,
440, 470, 520 y 600). El DOM de mentira no calcula cajas, así que estos tests **no miden**:
fijan la regla de CSS donde vivía el bug —que la fila envuelva y que el texto reclame su
ancho mínimo, que es lo que decide cuándo el botón baja de línea— y que el HTML siga siendo
texto + botón sin envoltorios en el medio. Medir se mide con la **maqueta**
(`test/manual/panel-demo`, que usa el HTML y el CSS de verdad), a esos seis anchos, antes y
después. El blindaje propio de este cartel ya no está: se fue con la causa (ver más abajo).

Y el **encabezado**, que es el otro, y donde la misma regla global picó de nuevo. En un panel
angosto "HyperPremiere" se dibujaba **encima** de la insignia verde de estado y el `?` encima
del `⟳ v1.4.4…`, que además quedaba cortado. Son dos causas: `.brand` tenía permiso para
quedar más chica que su contenido y su nombre no recortaba, así que lo que no entraba se
pintaba **afuera** de la caja; y la etiqueta de versión quedaba en **19 px a 470** por el
mismo `button { flex: 1 }` global —en el encabezado ya había tres blindajes uno por uno
contra esa regla y el de `.btn-update` era el que faltaba—. El grupo de herramientas dejó
de envolver **por dentro**, que era lo que ponía el `?` sobre el `⟳`, y se va entero a la fila
de abajo cuando no cabe. La invariante que sostiene todo: cada hoja del encabezado o tiene su
ancho natural o puede ceder **y recorta**, y con el encabezado envolviendo así no hay
solapamiento posible a ningún ancho ni con ningún texto. Los tests fijan esas reglas leyendo
el CSS real; medido en la maqueta a 320, 360, 400, 470, 600 y 900: desborde 0 px en todos
(antes 4 px a 470), cero pares de elementos superpuestos (antes hasta dos por ancho) y la
etiqueta de versión entera en sus 70 px siempre. `node test/manual/panel-demo/medir-encabezado.js`
lo vuelve a medir: compara los `getBoundingClientRect` de todo el encabezado y avisa qué par
se toca, que es la forma directa de ver lo que muestran las capturas.

**v1.4.50 — la causa, no los síntomas.** Los dos párrafos de arriba son el mismo bug contado
dos veces, y hubo cuatro. El `button { flex: 1; min-width: 0 }` global le daba a **todos** los
botones del panel base 0 y permiso para encogerse, cuando eso solo lo quería la barra de
acciones; como los botones son `nowrap`, el que caía en cualquier otra fila flex quedaba
angosto y pintaba la etiqueta **afuera** de su caja. Ahora el default es al revés —`flex: 0 1
auto` y sin `min-width: 0`, así el piso de cada botón es su propia etiqueta— y el reparto se
pide donde se lo quiere, en `.actions button`. Con eso se sacaron **veinticuatro** blindajes
sueltos (el del cartel, el de Corrections, el del encabezado, el `min-width: 120px` a mano de
la barra de acciones y veinte más); el único que quedó es `.icon-btn`, que no era de esta
familia: tiene ancho fijo y una sola letra, así que sí se puede aplastar. Medido con
`node test/manual/panel-demo/medir-botones.js` —15 vistas por seis anchos, 7578 mediciones de
botón—: **572 botones con contenido fuera de su caja pasaron a 30**, cero empeoraron, y sacar
los veinticuatro parches no cambió **ni una** medición de ancho. Los 30 que quedan son el
desplegable de micrófono en modo ícono, idéntico antes y después.

Aparte, dos scripts a mano para cuando se toca el render:
`node test/manual/render-real.js` renderiza de verdad (dos `.mov`, ~2 min) y muestra qué
fue aprendiendo; `node test/manual/mutaciones-render.js` mete a propósito cada regresión
que estos tests dicen cubrir y avisa si alguna pasa igual — un test que no falla cuando
rompés el código no está probando nada. Acepta un filtro por nombre
(`node test/manual/mutaciones-render.js sesión`) para cuando se tocó una sola parte, y hace
falta: son **318** y la corrida entera son casi tres horas.

Y al lado, `node test/manual/mutaciones-verificar.js`, que no corre ninguna: para cada
mutación comprueba que el texto ORIGINAL siga en su archivo. Contesta dos preguntas en un
segundo. La primera es «¿quedó una mutación puesta?» —el corredor restaura en un `finally`,
y un `finally` no corre si al proceso lo matan; cortar una corrida de tres horas es algo que
se hace—. La segunda es «¿cuáles hay que actualizar?»: una mutación cuyo texto original ya no
existe no prueba nada y no se queja, sólo dice *el código cambió* en el medio de trescientas
líneas de salida.

Y `node test/manual/live-providers.js` habla con los CLI de verdad (gasta tokens y tarda):
es lo que hay que correr cuando un CLI se actualiza, para ver si sigue hablando el mismo
idioma.

Y tres que contestan la pregunta que se hace mirando un recurso que salió mal, armando un
pedido de punta a punta con un proyecto de verdad y un solo doble —el proveedor, que anota
lo que le mandaron en vez de contestar—: `node test/manual/prompt-tres-niveles.js` vuelca el
**texto** exacto que recibe el modelo con los tres niveles puestos;
`node test/manual/referencias-al-modelo.js` hace lo mismo con las **referencias**, corriendo
el mismo proyecto con un proveedor que abre archivos y con uno que no, para poder ver de qué
manera llega —o no llega— cada documento; y `node test/manual/menciones-al-modelo.js`
imprime el prompt real de cinco pedidos con **menciones** (tres niveles en una frase, la
misma instrucción después de reordenar la lista, una mención colgada, una referencia que el
disco no tiene, y una instrucción vieja con "imagen 2" en texto plano). Los tres aceptan
`--out archivo.md`.

Y las **menciones** tienen su propia mitad en la suite, porque tocan el camino más caro que
hay acá. Del lado del motor: que una mención se traduzca al número del pedido y no al de la
pantalla; que **sobreviva a reordenar** —agregar una imagen antes corre los números y la
mención sigue apuntando a la misma imagen—; que dos referencias con el mismo nombre en dos
niveles no se confundan; que una que el disco no tiene **no reciba número** (no viaja, así
que no ocupa lugar) y que eso no tape el aviso de siempre; que una colgada se diga y **no se
le preste el número de otra**; que un documento no se numere; que una instrucción vieja con
"imagen 2" en texto plano vuelva **byte por byte** como entró; y que un `@[` sin cerrar no se
coma media instrucción. Del lado del panel: que la mención entre donde estaba el cursor
—aunque el campo ya haya perdido el foco, que es lo que pasa al tocar la miniatura—, que los
espacios de alrededor queden bien, y que el aviso distinga rojo (colgada) de ámbar (el disco).
Y una que las abraza a todas: el **corpus compartido**, con el que se corren las dos
gramáticas —la del panel y la del motor, que están escritas dos veces porque el panel no tiene
`require`— sobre los mismos catorce textos raros para que no puedan decir cosas distintas.

Del **campo con chips**, dos familias. Que **nada de lo que se guarda cambió**: `value`
devuelve el mismo string que devolvía el textarea, sobre el corpus entero más los casos con
`<`, `>`, `&`, saltos, espacios dobles, chips pegados y espacios adentro del token; que el
token se guarde tal cual vino y no reconstruido (`partir` recorta espacios, así que un token
reconstruido mediría menos y correría todos los offsets); y que un `@[]` sin nombre quede como
texto, igual que en el motor. Y que **el número del chip sea el del motor**: las dos cuentas
—`etiqueta()` del panel y `indice()` del motor— se corren sobre el mismo pedido, y el círculo
se cierra traduciendo de vuelta.

En el medio, la **fachada**: la traducción de offsets en los dos sentidos y sobre todos los
offsets del texto; el chip como unidad atómica (un offset en medio de un token se acerca al
borde, no parte la mención); el borrado que se lleva el token entero de los dos lados, también
con dos chips seguidos; Enter como `"\n"` de verdad; pegar como texto plano y **copiar** como
texto canónico; que el token sobreviva a un **clon** (lo que deja el undo nativo, y sin eso un
chip clonado devolvía su etiqueta); el dictado escribiendo en un campo con chips sin perder
ninguno; el ✨ canonizando y lo canonizado entrando como chip; y que tecleando los chips **no**
se redibujen (por identidad del nodo: si se recreó, se perdió el undo).

Del **doble clic**: que abra un `<input>` de verdad con el número adentro y seleccionado; que
su Enter no llegue al campo (que es lo que dejaría un salto de línea); que lo que no es un
dígito se filtre y tres sea el tope; que el chip en edición no se lo lleve la limpieza del
campo (tiene un input adentro, así que su texto está vacío y parece un chip roto); que el
Backspace del input no se lleve el chip de al lado; que un número inválido **quede escrito en
rojo** con el número que se escribió y no se deshaga; que el estado sobreviva a recargar el
campo porque está en el texto; que el renglón diga cuántas hay y **no** lo confunda con una
referencia borrada; que se arregle con el mismo gesto; que Escape y Enter terminen en cosas
distintas; y que un archivo llamado `Imagen_7.png` **no** se confunda con un número suelto.

Y del **menú del `@`**, otras dos familias. Lo que se decide sin DOM: que se abra al principio
del campo y después de un espacio y **no** pegado a una palabra (un mail, un handle) ni adentro
de una mención ya escrita; que el filtro no distinga mayúsculas **ni acentos**; que la lista
salga en el orden del pedido, con la etiqueta que va a decir el chip, con los rótulos de ámbito
que ya usa la tira (se corren los dos archivos juntos) y con las que el disco no tiene
incluidas y marcadas. Y lo que necesita el campo montado: que las flechas muevan y den la
vuelta, que el `keyup` de la flecha no devuelva la selección al principio, que Enter y Tab
elijan **sin dejar un salto de línea**, que Esc cierre sin tocar el texto, que el `@` con lo
tecleado desaparezca, que el mouse mueva la misma marca que el teclado, que sin referencias no
haya un menú vacío sino la línea que dice cómo se consiguen, y que el menú y la edición del
número de un chip no puedan estar abiertos a la vez.

Lo que sólo pasa en un navegador se mide con `medir-chips.js` y no se puede fijar acá: que
Chromium se lleve el chip entero, que el borrado **se deshaga**, que el preview caiga arriba,
que el menú no quede cortado en ningún ancho y que su Enter no meta un salto.

Y de **canonizar al refinar**: que "imagen 2" pase a ser la mención de la que de verdad es la
2 contando solo las imágenes que viajan; que un "imagen 9" que no apunta a nada no se
convierta en nada; que una enumeración no se toque; que no se reescriba por dentro una mención
que ya está, ni con un archivo llamado "imagen 2.png"; que el **↩** devuelva lo que el editor
había escrito, sin canonizar; que sin el gancho —la caja de feedback de la Cola y las filas de
Corrections, que cuelgan el micrófono sin pasar por la ficha— refinar haga exactamente lo que
hacía; y que una canonización que revienta no se lleve puesto un refinado ya pagado.

Y el **interior de la ficha**, por estructura y no por medición (el DOM de mentira no tiene
motor de layout): que las referencias vayan arriba del campo; que los tres lugares donde se le
pide algo al modelo usen el **mismo** cuerpo y que los dos de estilo no tengan pie de
acciones; que la zona de arrastre no vuelva; que el techo de 108 px con scroll no vuelva; que
la tira vacía no ocupe nada; que el renglón de estado de la tira viva **afuera** de la tira
—si no, un error de captura quedaría invisible justo cuando aparece, con el marcador todavía
sin imágenes—; que lo destructivo quede en la punta opuesta a *Generar* y que **pregunte**
antes de tirar el trabajo hecho; que el transcript que llega después entre adentro de
*Avanzado*; y que sin dictado la barra de controles **se arme igual** —si no, en Windows la
ficha se quedaría sin capturar del programa y sin adjuntar, que no tienen nada que ver con el
micrófono—.

Del **encabezado**: que el nombre y los tiempos vayan a la izquierda y el tramo, el estimado
y el estado a la derecha; que el grupo de la derecha envuelva **entero** y no de a una pieza;
que el nombre ceda ancho hasta 80 px y ahí recorte; que el desglose de los dos datos arranque
escondido y aparezca a partir de 640 px (es lo que hace que la fila plegada siga midiendo 32.8
px); y que el estimado se pida con la ficha **plegada**, porque ahí es donde ahora se muestra.

Los **iconos** aparte: que todos estén dibujados en la misma caja, que ninguno lleve color
propio (heredan el del texto, que es lo que un emoji no puede), que un concepto no comparta
dibujo con otro, y que las **cuatro** formas de rehacer —aplicar el ajuste, desde cero,
reintentar, reactivar— sean cuatro dibujos distintos. Y que no queden glifos tipeados donde
hay un control: la lista incluye ahora los de la Cola y los de Corrections.

Y **las tres pestañas como una sola lista**, que es lo que la v1.6.0 cerró: que las tres
dibujen la misma tarjeta, el mismo encabezado y la misma separación; que la guarda izquierda
la pinten **solo** las cinco clases de estado (si otra regla la toca, la barra vuelve a
querer decir dos cosas); que la tarjeta abierta se marque con el recuadro y no con la
guarda; que el estado tenga **palabra** además de color, que las ocho situaciones tengan
ocho palabras distintas y cinco colores, y que las escriba un solo lugar para las dos
pestañas que muestran el mismo trabajo; que un trabajo terminado **sin colocar** no se pinte
de «todo bien»; que el título de la Cola vuelva a ser el nombre y nada más; que la columna
del chevron se reserve **también** en las filas que no se abren (o el nombre de ésas
arrancaría 13 px a la izquierda y la columna dejaría de estar alineada); que el mensaje de
un trabajo se lea con la fila **plegada**; que un mensaje que no dice más que la pastilla no
se dibuje; que las cuatro fichas monten el cuerpo compartido **una sola vez cada una**; que
el inventario de referencias lo contesta un solo lugar para las tres; que los cinco campos de
prompt se dibujen con los mismos valores —y que ninguna fila de lista le ponga tamaño a su
campo por la etiqueta, que es lo que le ganaba por especificidad y, cuando había espejo,
desalineaba el resaltado—; y que Corrections abra de a una.

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
