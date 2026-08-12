# Fixtures: salida real de los CLI

Los `.jsonl` de esta carpeta **no están escritos a mano**: son la salida tal
cual de los CLI corriendo con los mismos flags que usa el motor. El formato lo
deciden ellos y cambia sin avisar, así que la prueba tiene que ser contra lo que
escupen de verdad — si mañana un CLI cambia un nombre de evento, el test falla
acá antes que en la máquina del editor.

Capturadas con `claude` **2.1.201** y `cursor-agent` **2026.08.04** (macOS).

| archivo | qué corrida es |
|---|---|
| `claude-thinking.jsonl` | razonamiento con contador de tokens + respuesta por deltas (`--include-partial-messages`) |
| `claude-tool.jsonl` | el agente usa una herramienta (Read) antes de contestar |
| `cursor-tools-partial.jsonl` | tres herramientas (glob, read, shell) + respuesta a pedazos (`--stream-partial-output`) |
| `cursor-plain.jsonl` | sin parciales: la respuesta llega entera en un solo evento |

Para renovarlas:

```bash
claude -p "<algo que lo haga pensar>" --output-format stream-json --verbose \
  --include-partial-messages > claude-thinking.jsonl

cursor-agent -p "<algo que lo haga leer un archivo>" --output-format stream-json \
  --stream-partial-output --mode ask --trust --model <modelo> --workspace <carpeta> \
  > cursor-tools-partial.jsonl
```

`fake-cli/fake-claude.js` y `fake-cli/fake-cursor.js` son otra cosa: CLI de
mentira para probar sin red ni tokens los caminos que casi nunca pasan (un CLI
viejo que rechaza los flags, un stream que se corta antes del final, un cierre
con el resultado en blanco, el prompt entrando por stdin como en Windows). La
salida que devuelven sale igual de los `.jsonl` de arriba, retocada para cada
caso: lo que se prueba sigue siendo formato real.
