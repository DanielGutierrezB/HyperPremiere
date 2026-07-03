# HyperPremiere

Plugin CEP para **Adobe Premiere Pro 2026** que genera gráficos animados por IA
(motor **HyperFrames** → `.mov` **ProRes 4444 con alpha**), timados al audio de una
clase, y los **coloca automáticamente sobre marcadores** de la secuencia.

100% Apple Silicon (arm64). Modelo configurable (Claude CLI/API, API compatible, u Ollama local).

Diseño y plan: `docs/superpowers/specs/` y `docs/superpowers/plans/`.

## Arquitectura

- **Panel CEP** (`cep/`) — la interfaz dentro de Premiere (`com.codigo.hyperpremiere`).
- **ExtendScript** (`cep/jsx/host.jsx`) — lee marcadores, mueve el playhead, importa y coloca el `.mov`.
- **Puente Node** (`bridge/`) — recibe el contexto, llama al modelo, renderiza el HTML de HyperFrames a ProRes 4444 alpha, y guarda en `<carpeta-del-.prproj>/HyperPremiere/<secuencia>/`.

## Requisitos

- macOS Apple Silicon (M-series), Premiere Pro 2026.
- Node 18+ arm64 y ffmpeg arm64 (ya presentes en el equipo de Daniel).
- Para render: la primera vez el puente instala `hyperframes` (baja Chromium arm64).

## Instalación (desarrollo)

```bash
# 1. Instala el panel en Premiere (symlink + PlayerDebugMode)
bash scripts/install-dev.sh

# 2. Levanta el puente local (instala deps la primera vez)
bash scripts/start-bridge.sh
```

Reiniciá Premiere y abrí el panel: **Ventana → Extensiones → HyperPremiere**.

## Uso

1. Abrí tu secuencia y poné **marcadores nativos con duración** donde quieras un recurso.
2. En el panel: **Cargar marcadores** (una tarjeta por marcador; clic en la cabecera salta el playhead).
3. **Cargar transcript (JSON)** de Premiere → la IA **deriva el objetivo de la clase** solo (editable).
4. En cada tarjeta escribí la **instrucción** y adjuntá **stills**.
5. **Generar** → se crea el `.mov` alpha y se coloca sobre el marcador.
6. **Regenerar** / **Ajustar** para iterar hasta el resultado final.
7. **Configuración del modelo** (abajo del panel): proveedor / modelo / token / base URL.

## Empaquetar el ZXP (distribución)

```bash
node scripts/sign-zxp.js          # genera dist/HyperPremiere.zxp (self-signed)
# opcional con timestamp: HP_TSA=http://timestamp.digicert.com node scripts/sign-zxp.js
```

Construido con **Fable 5**. El modelo runtime del plugin lo elige el usuario en Configuración.
