# HyperPremiere — Diseño (Spec)

**Fecha:** 2026-07-03
**Autor:** Daniel Gutiérrez + MiniM3
**Estado:** Aprobado el diseño de alto nivel; pendiente revisión del spec antes de implementar.
**Modelo de construcción:** Fable 5 (`claude-fable-5`) vía Claude CLI.

---

## 1. Objetivo

Plugin instalable (ZXP/CEP) para **Adobe Premiere Pro 2026** que, al estilo de HyperFrames,
genera **gráficos animados por IA** timados al audio de una clase y los coloca sobre marcadores
de la secuencia. La meta central: **maximizar el contexto capturado desde la interfaz** para que
cada generación salga lo mejor posible con **un solo request por marcador** (mínimo gasto de tokens).

Reutiliza el motor y los hallazgos del proceso previo en
`/Users/danielgutierrez/Movies/Render/claude-templates 2` (HyperFrames HTML+GSAP → ProRes 4444 alpha).

## 2. Alcance (qué SÍ y qué NO)

**SÍ (v1):**
- Panel CEP dentro de Premiere que lee la secuencia activa y sus marcadores.
- Captura de contexto por marcador: instrucción de texto + stills (imágenes).
- Objetivo de clase + transcript completo (JSON de Premiere) como contexto global.
- Generación de animación HTML (HyperFrames) → render **ProRes 4444 con alpha** → colocación
  automática sobre el marcador.
- Ciclo de feedback: ajuste puntual o regeneración total por marcador.
- Configuración de proveedor/modelo (Claude vía CLI/API key, API compatible, o local/Ollama).
- Salida en carpeta al lado del proyecto, con nomenclatura consistente panel↔archivo.

**NO (v1, YAGNI):**
- No genera MOGRT/Essential Graphics nativos.
- No edita el footage (captions, zoom, música) — eso sigue en el skill `video-edit` aparte.
- No sincroniza a la nube ni multiusuario. Todo local.
- No crea/edita marcadores desde el panel (se crean nativos en Premiere).

## 3. Arquitectura (3 componentes)

```
┌─────────────────────────── Premiere Pro 2026 ───────────────────────────┐
│  Panel CEP  (com.codigo.hyperpremiere)                                   │
│   - UI (HTML/CSS/JS)  ── una tarjeta por marcador                        │
│   - CSInterface  ─────────────────────────┐                              │
│                                            ▼                              │
│  ExtendScript (host.jsx)                                                 │
│   - lee secuencia activa + marcadores (tiempo, duración, nombre)         │
│   - mueve playhead a un marcador                                         │
│   - importa .mov y lo inserta sobre el marcador (pista de gráficos)      │
│   - resuelve ruta del .prproj (para la carpeta de salida)                │
└──────────────────────────────┬───────────────────────────────────────────┘
                                │ HTTP localhost (JSON)
                                ▼
        Servicio puente local (Node)  ── `hyperpremiere-bridge`
         - POST /generate  { objetivo, transcript, marcador, instrucción, stills[] }
         - arma el prompt (un request), llama al modelo elegido
         - el modelo escribe la composición HyperFrames (HTML+GSAP)
         - render con hyperframes CLI → ProRes 4444 alpha (.mov)
         - devuelve ruta del .mov + metadata
         - POST /feedback  { markerId, ajuste | regenerar }
         - GET  /models, POST /config  (proveedor, token, modelo)
```

**Por qué el puente local:** el render de HyperFrames necesita Node + Chromium (Puppeteer/Playwright),
que no corren dentro del sandbox CEP. El puente aísla secretos (token del modelo) fuera del panel y
reaprovecha el pipeline de render existente sin cambios.

## 4. Flujo de trabajo (usuario)

1. **Activar clase:** con la secuencia abierta, el editor pulsa "Activar clase" en el panel.
2. **Contexto global:** carga el **transcript JSON** de Premiere (con timecodes) y escribe el
   **objetivo de la clase** (una vez por secuencia). Se persiste (ver §7).
3. **Marcadores:** el editor coloca **marcadores nativos con duración** manualmente. El rango del
   marcador = duración objetivo del recurso. El panel los lee y muestra **una tarjeta por marcador**.
4. **Por marcador:** escribe la **instrucción** ("aprovechá este gráfico pero regenerá el orden
   visual, que los elementos aparezcan al ritmo de lo que dice…") y adjunta **stills**.
   Clic en la tarjeta → el playhead salta a ese marcador en la secuencia.
5. **Generar:** el puente arma **un solo request** (objetivo + transcript completo + segmento del
   marcador por timecode + instrucción + stills) → el modelo escribe el HTML → render alpha →
   ExtendScript importa y coloca el `.mov` sobre el marcador.
6. **Feedback:** por cada resultado, el editor pide **ajuste puntual** (nuevo request incremental)
   o **regeneración total**. Itera hasta el resultado final.

## 5. Estrategia de contexto y tokens

- **Un request por marcador**, sin ida y vuelta conversacional.
- El **transcript completo** se envía como contexto (para entender la clase entera), pero el
  **segmento del marcador** se marca explícitamente por timecodes (inicio/fin del marcador).
- El **objetivo de la clase** encabeza siempre el prompt: toda decisión visual prioriza ese objetivo.
- Los **stills** se adjuntan como imágenes (visión) solo del marcador en cuestión.
- Prompt del sistema fijo (reglas de estilo de HyperFrames de `GUIDE.md`: motion editorial,
  nada "vibecoded", alpha, timings al audio) → se cachea; el contenido variable es lo mínimo.
- En feedback incremental se reenvía solo el diff (instrucción de ajuste + HTML previo), no todo.

## 6. Salida y nomenclatura

```
<carpeta-del-.prproj>/
└── HyperPremiere/
    └── <nombre-secuencia>/
        ├── <slug-marcador>.mov            # ProRes 4444 alpha, resultado final
        ├── <slug-marcador>.html           # composición fuente (regenerable/editable)
        ├── <slug-marcador>.stills/        # stills adjuntados
        └── <slug-marcador>.meta.json      # instrucción, timecodes, versión, historial feedback
```

- `<slug-marcador>` se deriva del nombre/orden del marcador y es **idéntico** en el panel y en el
  archivo (ej. `01-intro-grafico`, `02-comparativa`).
- Versionado de feedback: `-v2`, `-v3` o carpeta de historial (a decidir en el plan; default: sufijo
  de versión + `meta.json` guarda el historial).

## 7. Persistencia

- Estado por secuencia (objetivo, transcript, instrucciones, stills, rutas generadas) en un
  `hyperpremiere.state.json` dentro de `HyperPremiere/<secuencia>/`, para reabrir sin recargar todo.
- Config global del plugin (proveedor/modelo/token) en el almacenamiento del panel (fuera del repo).

## 8. Configuración de modelo (proveedor-agnóstico)

Panel de Configuración con opciones:
- **Claude vía CLI** — usa el token del CLI (login/oauth) del sistema. Recomendado.
- **Claude vía API key** — pegar `sk-ant-…`.
- **API compatible (OpenAI-style)** — base_url + key + nombre de modelo.
- **Local (Ollama)** — modelo local (ej. `qwen3-coder:30b`).

El puente normaliza todos a una interfaz interna `generateComposition(context) → html`.

## 9. Componentes a construir (para el plan de implementación)

1. **Panel CEP** — `manifest.xml` (CEP 12, Premiere 2026), UI, CSInterface, estado por marcador.
2. **host.jsx (ExtendScript)** — lectura de marcadores, navegación de playhead, import + inserción
   del .mov, resolución de ruta del proyecto.
3. **hyperpremiere-bridge (Node)** — servidor HTTP local, adaptadores de modelo, generación de
   prompt, integración con hyperframes CLI, render alpha, endpoints de feedback/config.
4. **Prompt/plantillas HyperFrames** — sistema de reglas de estilo + andamiaje de composición.
5. **Empaquetado ZXP** — firma con `zxp-sign-cmd`, instalación por symlink (patrón `com.codigo.*`)
   con PlayerDebugMode (ya activo).

## 10. Riesgos y decisiones abiertas

- **CEP deprecación:** Premiere 2026 aún soporta CEP; UXP sería el futuro. v1 va CEP (ZXP) por
  compatibilidad con tu tooling actual. Migración a UXP queda como posible v2.
- **Formato del transcript JSON de Premiere:** confirmar el esquema exacto al implementar (se
  parsea al primer archivo real que cargues).
- **Colocación exacta en pista:** definir en qué pista de video/gráficos se inserta (default: pista
  superior libre) y manejo de colisiones.
- **Versionado de feedback:** sufijo de versión vs. sobrescritura (default propuesto: versión + meta).

## 11. Criterios de éxito (v1)

- Instalable como ZXP en tu Premiere 2026 y visible como panel.
- Lee marcadores reales de una secuencia y muestra una tarjeta por cada uno; clic → salta el playhead.
- Con objetivo + transcript + instrucción + still, genera un `.mov` alpha timado y lo coloca sobre
  el marcador, con la carpeta/nomenclatura correcta.
- Ciclo de feedback funcional (ajuste y regeneración).
- Config de modelo funcional con al menos Claude (CLI) y un fallback local.
