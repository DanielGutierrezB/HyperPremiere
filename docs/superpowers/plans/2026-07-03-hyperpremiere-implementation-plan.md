# HyperPremiere — Plan de Implementación

**Fecha:** 2026-07-03
**Basado en:** `docs/superpowers/specs/2026-07-03-hyperpremiere-design.md` (aprobado)
**Construcción:** Fable 5 (`claude-fable-5`) vía Claude CLI, orquestado por MiniM3.
**Decisiones cerradas (defaults del spec aprobados):** versionado `-v2` + `meta.json` · inserción en pista de video superior libre · esquema de transcript se ajusta al primer JSON real · v1 en CEP/ZXP.

---

## Estructura del repositorio

```
HyperPremiere/
├── cep/                        # Panel CEP (se symlinkea a la carpeta de extensiones)
│   ├── CSXS/manifest.xml       # manifest CEP 12, Premiere 2026
│   ├── index.html              # UI del panel
│   ├── css/style.css
│   ├── js/
│   │   ├── main.js             # lógica de UI + estado por marcador
│   │   ├── CSInterface.js      # librería Adobe (vendored)
│   │   └── bridge-client.js    # llamadas HTTP al puente local
│   ├── jsx/host.jsx            # ExtendScript: marcadores, playhead, import/insert
│   └── .debug                  # puertos de debug CEP
├── bridge/                     # Servicio puente local (Node)
│   ├── package.json
│   ├── server.js               # HTTP localhost, endpoints
│   ├── providers/              # adaptadores de modelo
│   │   ├── index.js            # interfaz generateComposition(context)->html
│   │   ├── claude-cli.js       # via `claude -p --model ...`
│   │   ├── claude-api.js       # via API key
│   │   ├── openai-compat.js    # base_url + key
│   │   └── ollama.js           # local
│   ├── prompt/
│   │   ├── system.md           # reglas de estilo HyperFrames (de GUIDE.md)
│   │   └── build-context.js    # ensambla el request (1 por marcador)
│   ├── render/
│   │   └── hyperframes.js      # wrapper del CLI hyperframes -> ProRes 4444 alpha
│   └── store/
│       └── project-fs.js       # carpeta al lado del .prproj, nomenclatura, meta.json
├── scripts/
│   ├── install-dev.sh          # symlink a CEP/extensions + PlayerDebugMode
│   ├── sign-zxp.sh             # empaqueta y firma con zxp-sign-cmd
│   └── start-bridge.sh
├── docs/superpowers/{specs,plans}/
└── README.md
```

---

## Fases

### Fase 0 — Andamiaje y "hola mundo" en Premiere
- Estructura de carpetas, `manifest.xml` (id `com.codigo.hyperpremiere`, host PPRO, CEP 12), `.debug`.
- Panel mínimo que carga en Premiere y ejecuta un `host.jsx` de prueba (nombre de la secuencia activa).
- `scripts/install-dev.sh` (symlink + PlayerDebugMode ya en 1).
- **Verificación:** el panel aparece en Premiere 2026 y muestra el nombre de la secuencia real.

### Fase 1 — Lectura de secuencia y marcadores (ExtendScript)
- `host.jsx`: listar marcadores de la secuencia activa (nombre, start, duration, comentario).
- Navegación: función que mueve el playhead a un marcador.
- Resolver ruta del `.prproj` (para la carpeta de salida).
- **Verificación:** el panel lista los marcadores reales; clic en uno mueve el playhead.

### Fase 2 — UI de contexto (una tarjeta por marcador)
- Render de tarjetas desde los marcadores; campo de instrucción; adjuntar stills (drag/seleccionar).
- Campo global "objetivo de la clase" + carga del transcript JSON.
- Persistencia local del estado (por secuencia).
- **Verificación:** se captura y persiste todo el contexto; clic en tarjeta salta el playhead.

### Fase 3 — Puente local + generación (1 request por marcador)
- Servidor Node local; endpoint `/generate`.
- `build-context.js`: objetivo + transcript completo + segmento por timecodes + instrucción + stills.
- Proveedor `claude-cli` primero (Fable/Claude); interfaz para los demás.
- `system.md` con reglas de estilo de HyperFrames (de `GUIDE.md`).
- **Verificación:** un POST con contexto real devuelve HTML de composición HyperFrames válido.

### Fase 4 — Render alpha + colocación en timeline
- `render/hyperframes.js`: HTML → ProRes 4444 alpha `.mov` (`--format prores4444`).
- Guardado en `<carpeta-.prproj>/HyperPremiere/<secuencia>/<slug>.mov` + `.html` + stills + `.meta.json`.
- `host.jsx`: importar el `.mov` y colocarlo en la pista de video superior libre sobre el marcador.
- **Verificación:** de marcador → aparece el `.mov` alpha colocado y timado en la secuencia.

### Fase 5 — Ciclo de feedback
- Endpoint `/feedback`: ajuste incremental (reenvía diff) o regeneración total.
- Versionado `-v2/-v3` + historial en `meta.json`; reemplazo del clip en timeline.
- **Verificación:** pedir un ajuste produce nueva versión y actualiza el clip.

### Fase 6 — Configuración de modelo (panel)
- UI de Configuración: Claude CLI / API key / API compatible / Ollama local.
- Guardado seguro del token (fuera del repo).
- **Verificación:** cambiar de proveedor y generar con cada uno disponible.

### Fase 7 — Empaquetado ZXP e instalación
- `sign-zxp.sh` con `zxp-sign-cmd` (cert self-signed).
- README de instalación; verificación de install limpio.
- **Verificación:** instalar el ZXP en Premiere 2026 y correr el flujo completo end-to-end.

---

## Estrategia de construcción con Fable 5
- MiniM3 orquesta; cada componente se genera con `claude -p --model claude-fable-5` en el repo.
- Commits por fase; push al repo privado.
- Verificación humana (Daniel) al final de las fases que tocan Premiere (0,1,4,7) porque requieren la app abierta.

## Dependencias externas / de Daniel
- Un **transcript JSON real** de Premiere (para fijar el parser en Fase 2/3).
- Premiere 2026 abierto con una secuencia + marcadores para las verificaciones.
- Cuenta Claude (ya configurada, Fable 5 confirmado por CLI).
