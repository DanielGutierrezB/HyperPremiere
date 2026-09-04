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

Los modos `falla-*` de `fake-claude.js` son los que **sí** pasan seguido en la
máquina de otro: cerrar con código 1 dejando `stderr` vacío y el motivo en
`stdout`, que es como se porta el CLI de verdad con `--output-format json`.

El modo `usage-real` de los dos trae el `usage` con la forma y los órdenes de
magnitud de verdad, que es lo único que hace ver el problema: el campo de entrada
en dos dígitos y la entrada completa en los de caché. El de Cursor es literal — el
`usage` que devolvió `cursor-agent` con el prompt más chico posible ("Decí
solamente: hola"), 2 tokens de entrada y 31.823 escritos a caché.

## El micrófono del dictado

| archivo | qué es |
|---|---|
| `avfoundation-list-devices.txt` | el `stderr` tal cual de `ffmpeg -f avfoundation -list_devices true -i ""` en esta máquina (ffmpeg 9.0.1): once cámaras, seis entradas de audio, la línea ajena de EOS Webcam Utility al principio y el error de abrir `""` al final |
| `avfoundation-list-devices-nombres-raros.txt` | la misma salida con **tres dispositivos agregados a mano** en el mismo formato, para los nombres que existen y acá no estaban enchufados: paréntesis, tildes, `ø`, guiones largos y un nombre de dos renglones de largo |
| `system-profiler-audio.json` | `system_profiler SPAudioDataType -json` de esta máquina, de donde sale cuál es la entrada por defecto del sistema (`coreaudio_default_audio_input_device`) |

`fake-cli/fake-ffmpeg.js` es el ffmpeg de mentira: contesta `-version`, imprime
la lista por `stderr` con código 251 (como el real, que sale mal aunque la lista
haya salido bien) y en captura escupe PCM a tiempo real con los niveles que se
midieron: voz (RMS 0,08), sala callada (0,006), ceros exactos, ni una muestra, o
el error real de un índice que ya no existe.
