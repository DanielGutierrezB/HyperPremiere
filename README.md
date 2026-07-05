# HyperPremiere

Panel **CEP para Adobe Premiere Pro 2026** que genera gráficos animados por IA
(motor **HyperFrames** → HTML + GSAP) **sobre los marcadores** de tu secuencia y los
**coloca automáticamente en el timeline**, en la secuencia correcta.

Salida por defecto en **ProRes 4444 con alpha** (`.mov`, overlay transparente), o
en **MP4 H.264 1080p opaco** por marcador cuando activás "Con fondo".

Modelo configurable: **Claude (CLI de suscripción o API key)**, cualquier **API
compatible con OpenAI**, o **Ollama local**. Multiplataforma: **macOS (Apple Silicon)
y Windows**.

Versión actual: ver `version.json`. ZXP firmado: `dist/HyperPremiere.zxp`.

## Qué hace

1. Ponés **marcadores nativos con duración** en tu secuencia donde querés un recurso.
2. El panel lee los marcadores (una **tarjeta** por marcador) y el **transcript** de la clase.
3. Por marcador escribís una **instrucción** y podés arrastrar **stills / imágenes / PDFs / referencias** (drag & drop), o capturar el frame del programa.
4. La IA diseña una animación **HyperFrames**, se **renderiza** y se **coloca sobre el marcador**, importada a un bin **`HyperPremiere > <secuencia>`** dentro del proyecto.
5. Iterás con **Generar / Refinar / Regenerar**, o editás el **HTML a mano** (con resaltado de sintaxis) y lo renderizás sin gastar IA.

## Funcionalidades

- **Cola global serial** con 2 carriles (modelo ↔ render): en la nube genera el HTML
  del siguiente marcador mientras renderiza el actual; en local (Ollama) es serial
  para no reventar la RAM.
- **Pestañas Marcadores | Cola**: la Cola es una vista completa para lotes largos
  (reordenar por secuencia y por marcador, iniciar/pausar, quitar).
- **Enviar a la cola** (staging sin arrancar) + **Agregar listos a la cola** +
  **Generar listos**.
- **Reactivar sin tokens**: si una generación falla por límite/cuota (429, usage
  limit, etc.), el job queda **esperando tokens** ⏳ con botón **↻ Reactivar**
  (individual o "Reactivar todos") para reencolar cuando se reinicie tu uso.
- **Render HQ por secuencia**: re-renderiza en alta calidad la última versión de
  cada marcador (reusa el HTML, sin volver a llamar a la IA).
- **Modo borrador** global (render rápido de menor calidad para previsualizar).
- **Fondo opcional** por marcador (mp4 HD temático vs alpha por defecto).
- **Contador de tokens** por sesión + **estimado previo** por marcador + **timer** por generación.
- **Nombres con el modelo usado**: `Marcador 1 v2 [claude-sonnet-5].mov`.
- **Config del modelo inteligente**: por proveedor (cambiar de proveedor no borra
  credenciales del anterior), autopoblado de modelos de Ollama, campos condicionales.
- **Actualización desde GitHub**: el botón ⟳ compara tu versión con `origin/main`,
  **avisa con un resalte cuando hay versión nueva** y la aplica.
- **Persistencia por secuencia**: objetivo, instrucciones y recursos se guardan por
  proyecto+secuencia.

## Arquitectura

- **Panel CEP** (`cep/`) — la interfaz dentro de Premiere (`com.codigo.hyperpremiere`),
  con Node embebido (`--enable-nodejs`).
- **ExtendScript** (`cep/jsx/host.jsx`) — lee marcadores, mueve el playhead, importa
  y coloca el clip en la secuencia por nombre (`hp_placeClipInSequence`).
- **Motor Node in-process** (`bridge/`) — corre **dentro del panel** vía `require`
  (no hay proceso externo ni servidor): arma un request por marcador, llama al
  proveedor, renderiza el HTML de HyperFrames y guarda en
  `<carpeta-del-.prproj>/HyperPremiere/<secuencia>/`.
  - `bridge/engine.js` — orquestación (prepare/render en 2 etapas, config, update, versiones).
  - `bridge/providers/` — `claude-cli`, `claude-api`, `openai-compat`, `ollama`.
  - `bridge/render/hyperframes.js` — render a `.mov` (ProRes 4444 alpha) o `.mp4` (H.264).

## Requisitos

- **Premiere Pro 2026** con panel CEP (Node habilitado en el manifest).
- **Node 18+** y **ffmpeg** en el PATH.
- Para render, la primera vez se instala **`hyperframes`** (baja un Chromium).
- Proveedor de IA: sesión de Claude / API key / endpoint OpenAI-compatible, o
  **Ollama** local con un modelo con **visión** (ej. `qwen3-vl:30b`).

## Instalación

**Opción A — ZXP firmado (recomendada):** instalá `dist/HyperPremiere.zxp` con tu
gestor de ZXP (ej. ZXP/UXP Installer o Anastasiy's Extension Manager). Reiniciá
Premiere y abrí **Ventana → Extensiones → HyperPremiere**.

**Opción B — desarrollo (symlink):**

```bash
bash scripts/install-dev.sh   # symlink + PlayerDebugMode
```

Reiniciá Premiere y abrí el panel. Como el panel es un symlink al repo, editar
`cep/` y recargar el panel ya trae los cambios.

## Empaquetar el ZXP

```bash
node scripts/sign-zxp.js          # genera dist/HyperPremiere.zxp (self-signed)
# opcional con timestamp: HP_TSA=http://timestamp.digicert.com node scripts/sign-zxp.js
```

## Notas

- Windows: código multiplataforma (spawns con shell, rutas OS-aware). Testeado a
  fondo en macOS; en Windows puede requerir ajustes si la ruta del repo tiene espacios.
- Diseño y plan: `docs/superpowers/specs/` y `docs/superpowers/plans/`.
