#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Proceso PERSISTENTE de Whisper para el dictado por voz del panel.

Por qué existe un proceso aparte y no se reusa bridge/transcribe.js
-------------------------------------------------------------------
transcribe.js invoca el CLI de Whisper una vez por clase: carga el modelo,
transcribe una hora de audio y cierra. Ahí el arranque no se nota.

El dictado es lo contrario: llamadas de medio segundo, una cada segundo y
medio, durante todo el rato que el editor esté hablando. Medido en esta Mac,
cada invocación del CLI tiene un piso de ~1,2 s que no baja aunque el audio
dure tres segundos — entre 8 y 15 veces lo que cuesta transcribir de verdad.
Con el modelo ya cargado en memoria, `small` transcribe 30 s de habla en
~0,5 s. O sea que el proceso persistente no es una optimización: es la
diferencia entre que el texto aparezca mientras hablás y que no aparezca.

El intérprete arranca en 0,02 s y el `import mlx_whisper` en caliente tarda
0,03 s, así que ese piso de 1,2 s está en el CLI, no en Python. Por eso se
puede sacar sin escribir un motor de inferencia: alcanza con no volver a
arrancar el proceso.

Protocolo (una línea JSON por mensaje, en las dos direcciones)
-------------------------------------------------------------
stdin  <- {"id": 3, "pcm": "/tmp/…/buf.pcm", "rate": 16000}
stdout -> {"id": 3, "texto": "…", "ms": 412}
stdout -> {"listo": true, "modelo": "…", "ms": 1840}     (una vez, al arrancar)
stdout -> {"id": 3, "error": "…"}                        (si algo falló)

stdout es SOLO para esas líneas. Todo lo demás (avisos, descargas del modelo,
las barras de progreso de huggingface) va a stderr, que el motor lee para el
log y para saber si está bajando el modelo. Un `print` de más acá adentro
rompería el parseo del otro lado, y por eso no hay ninguno.

El audio llega como PCM CRUDO int16 mono en un archivo, no como WAV: es el
formato que ya sale de ffmpeg (`-f s16le`) y se lee con una línea de numpy,
sin cabecera que parsear ni una variante de WAV que se nos escape.

Se transcribe SIEMPRE el buffer entero acumulado, no el pedacito nuevo. Suena
caro y no lo es (30 s de audio en `small` son ~0,5 s), y a cambio el texto se
auto-corrige a medida que crece el contexto en vez de quedar cosido de
fragmentos que no se conocen entre sí.
"""

import json
import sys
import time


def responder(obj):
    """Una línea JSON a stdout, con flush. Es la ÚNICA salida por stdout."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def avisar(texto):
    """Diagnóstico a stderr: lo lee el motor para el ⬇ Log, nadie lo parsea."""
    sys.stderr.write(str(texto) + "\n")
    sys.stderr.flush()


def main():
    if len(sys.argv) < 2:
        avisar("uso: dictado-whisper.py <repo-del-modelo> [idioma]")
        return 2
    repo = sys.argv[1]
    idioma = sys.argv[2] if len(sys.argv) > 2 else "es"

    t0 = time.time()
    try:
        import numpy as np
        import mlx_whisper
    except Exception as e:  # noqa: BLE001 — el motor necesita el motivo textual
        responder({"error": "no pude importar mlx_whisper: %s" % e})
        return 1

    def transcribir(audio):
        # condition_on_previous_text=False por lo mismo que en transcribe.js:
        # alimentar a Whisper con su propia salida lo hace entrar en bucle
        # cuando no hay voz clara. Acá pasa seguido, porque cada refresco
        # incluye el silencio del final mientras el editor piensa.
        return mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=repo,
            language=idioma,
            condition_on_previous_text=False,
            fp16=True,
        )

    # Calentar: la PRIMERA transcripción de verdad no puede pagar la carga del
    # modelo (y, la primera vez de todas, su descarga). Se hace con un segundo
    # de silencio y se tira el resultado. El motor no manda nada hasta ver el
    # {"listo":true}, así que este rato queda del lado de "preparando", no del
    # lado de "el dictado no arranca".
    try:
        transcribir(np.zeros(16000, dtype=np.float32))
    except Exception as e:  # noqa: BLE001
        responder({"error": "no pude cargar el modelo %s: %s" % (repo, e)})
        return 1

    responder({"listo": True, "modelo": repo, "ms": int((time.time() - t0) * 1000)})

    for linea in sys.stdin:
        linea = linea.strip()
        if not linea:
            continue
        try:
            msg = json.loads(linea)
        except Exception as e:  # noqa: BLE001
            avisar("línea ilegible: %s" % e)
            continue
        if msg.get("cmd") == "chau":
            break
        pedido = msg.get("id")
        try:
            crudo = np.fromfile(msg["pcm"], dtype=np.int16)
            # int16 → float32 en [-1, 1], que es lo que espera el modelo.
            audio = crudo.astype(np.float32) / 32768.0
            t = time.time()
            r = transcribir(audio)
            responder({
                "id": pedido,
                "texto": (r.get("text") or "").strip(),
                "ms": int((time.time() - t) * 1000),
                "segundos": round(len(audio) / float(msg.get("rate") or 16000), 2),
            })
        except Exception as e:  # noqa: BLE001
            responder({"id": pedido, "error": str(e)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
