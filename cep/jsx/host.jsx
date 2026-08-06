function hp_getActiveSequenceName() {
    try {
        return app.project.activeSequence
            ? app.project.activeSequence.name
            : "(sin secuencia activa)";
    } catch (e) {
        return "Error: " + e.toString();
    }
}

function hp_escapeJsonString(value) {
    var text = String(value === undefined || value === null ? "" : value);
    var result = "";
    for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        var code = text.charCodeAt(i);
        if (ch === "\\") {
            result += "\\\\";
        } else if (ch === '"') {
            result += '\\"';
        } else if (ch === "\n") {
            result += "\\n";
        } else if (ch === "\r") {
            result += "\\r";
        } else if (ch === "\t") {
            result += "\\t";
        } else if (code < 32) {
            result += "\\u" + ("000" + code.toString(16)).slice(-4);
        } else {
            result += ch;
        }
    }
    return result;
}

function hp_getMarkers() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return '{"error":"No hay secuencia activa."}';
        }

        var markers = seq.markers;
        var items = [];
        var marker = markers.getFirstMarker();
        while (marker) {
            // guid: identidad estable del marcador (Premiere 11.1+). Sobrevive
            // moverlo, renombrarlo y reabrir el proyecto; un marcador nuevo trae
            // uno nuevo. Es lo que le permite al panel numerar por marcador y no
            // por posición. Si la versión no lo expone, va vacío y el panel cae
            // a la numeración por posición.
            var guid = "";
            try { guid = marker.guid; } catch (eg) { guid = ""; }
            items.push({
                guid: guid,
                name: marker.name,
                comment: marker.comments,
                start: marker.start.seconds,
                end: marker.end.seconds
            });
            marker = markers.getNextMarker(marker);
        }

        items.sort(function (a, b) {
            return a.start - b.start;
        });

        var parts = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            parts.push(
                '{"index":' + i +
                ',"guid":"' + hp_escapeJsonString(it.guid) +
                '","name":"' + hp_escapeJsonString(it.name) +
                '","comment":"' + hp_escapeJsonString(it.comment) +
                '","start":' + it.start +
                ',"duration":' + (it.end - it.start) +
                ',"end":' + it.end + "}"
            );
        }
        return "[" + parts.join(",") + "]";
    } catch (e) {
        return '{"error":"' + hp_escapeJsonString(e.toString()) + '"}';
    }
}

function hp_seekToTime(seconds) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return "error: no hay secuencia activa";
        }
        var TICKS_PER_SECOND = 254016000000;
        var ticks = Math.round(Number(seconds) * TICKS_PER_SECOND);
        seq.setPlayerPosition(String(ticks));
        return "ok";
    } catch (e) {
        return "error: " + e.toString();
    }
}

// Abre/activa una secuencia por nombre y mueve el playhead a `seconds`.
// Sirve para revisar un marcador recién terminado desde la Cola aunque el
// editor esté en otra secuencia. Devuelve "ok" o "error: ...".
function hp_openSequenceAndSeek(seqName, seconds) {
    try {
        var seq = hp_findSequenceByName(seqName);
        if (!seq) return "error: no se encontró la secuencia '" + seqName + "'";
        var active = app.project.activeSequence;
        if (!active || active.name !== seqName) {
            // openSequence(sequenceID) la abre en el timeline y la hace activa.
            try { app.project.openSequence(seq.sequenceID); } catch (e1) {}
        }
        var tgt = (app.project.activeSequence && app.project.activeSequence.name === seqName)
            ? app.project.activeSequence : seq;
        var TICKS_PER_SECOND = 254016000000;
        var ticks = Math.round(Number(seconds) * TICKS_PER_SECOND);
        tgt.setPlayerPosition(String(ticks));
        return "ok";
    } catch (e) {
        return "error: " + e.toString();
    }
}

function hp_getProjectPath() {
    try {
        return app.project && app.project.path ? app.project.path : "";
    } catch (e) {
        return "";
    }
}

// Duración REAL de la secuencia activa en segundos (fin del último clip entre
// TODAS las pistas de video y audio). Sirve como referencia para validar las
// unidades de tiempo de un transcript importado. Devuelve "ok|<segundos>" o
// "error: ...".
function hp_getSequenceDuration() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "error: no hay secuencia activa";
        function maxEnd(tracks, current) {
            try {
                for (var t = 0; t < tracks.numTracks; t++) {
                    var track = tracks[t];
                    if (!track.clips) continue;
                    for (var i = 0; i < track.clips.numItems; i++) {
                        var e = track.clips[i].end.seconds;
                        if (e > current) current = e;
                    }
                }
            } catch (e2) {}
            return current;
        }
        var dur = 0;
        dur = maxEnd(seq.videoTracks, dur);
        dur = maxEnd(seq.audioTracks, dur);
        if (dur <= 0) return "error: la secuencia no tiene clips";
        return "ok|" + dur;
    } catch (e) {
        return "error: " + e.toString();
    }
}

// Info del clip PRINCIPAL de la secuencia: el clip MÁS LARGO de TODA la
// secuencia, mirando pistas de VIDEO y de AUDIO por igual — en muchos flujos
// la narración de la clase es un WAV en una pista de audio que atraviesa todo
// el timeline, mientras el video de cámara está cortado en pedazos (antes se
// miraba solo la primera pista de video y se elegía un pedazo equivocado).
// Devuelve JSON:
//   { ok: true, offset, mediaPath, clipName }  |  { ok: false, error }
// donde offset = inPoint - start (desfase transcript ↔ timeline: si el editor
// recortó el inicio del medio o corrió el clip, tiempoMedio = tiempoSecuencia
// + offset) y mediaPath es la ruta del archivo original (para transcribirlo).
function hp_getPrimaryClipInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"ok":false,"error":"no hay secuencia activa"}';
        function longestOf(tracks, state) {
            try {
                for (var t = 0; t < tracks.numTracks; t++) {
                    var track = tracks[t];
                    if (!track.clips) continue;
                    for (var i = 0; i < track.clips.numItems; i++) {
                        var c = track.clips[i];
                        var len = c.end.seconds - c.start.seconds;
                        if (len > state.len) { state.len = len; state.clip = c; }
                    }
                }
            } catch (e) {}
        }
        var state = { clip: null, len: -1 };
        longestOf(seq.videoTracks, state);
        longestOf(seq.audioTracks, state);
        if (!state.clip) return '{"ok":false,"error":"la secuencia no tiene clips"}';
        var clip = state.clip;
        var offset = clip.inPoint.seconds - clip.start.seconds;
        var mediaPath = "";
        try { if (clip.projectItem) mediaPath = String(clip.projectItem.getMediaPath() || ""); } catch (e2) {}
        return '{"ok":true,"offset":' + offset +
            ',"mediaPath":"' + hp_escapeJsonString(mediaPath) +
            '","clipName":"' + hp_escapeJsonString(clip.name) + '"}';
    } catch (e) {
        return '{"ok":false,"error":"' + hp_escapeJsonString(e.toString()) + '"}';
    }
}

// Exporta el frame actual del monitor de programa (playhead) a un PNG.
// Adobe cambió esta API entre versiones; probamos varias vías en orden y
// reportamos con detalle si ninguna funciona. Devuelve "ok|<ruta>" o "error: ...".
function hp_captureProgramFrame(outPath) {
    // Método probado (igual que Editor Pro): QE + CTI.timecode + exportFramePNG(time, base).
    // QE agrega ".png" solo, y la exportación tarda: hay que esperar antes de leer.
    try {
        app.enableQE();
        var qeSeq = (typeof qe !== "undefined" && qe.project) ? qe.project.getActiveSequence() : null;
        if (!qeSeq) return "error: no hay secuencia activa (QE)";
        if (typeof qeSeq.exportFramePNG !== "function") return "error: exportFramePNG no disponible en QE";

        var time = qeSeq.CTI.timecode; // timecode del playhead (string), no ticks

        // Normalizar el destino a la carpeta temporal REAL del SO. main.js pasa una
        // ruta estilo "/tmp/..." que en Windows no existe → QE no escribía nada y
        // fallaba con "el frame no se generó". Folder.temp resuelve en Mac y Windows.
        var fileName = String(outPath).replace(/^.*[\/\\]/, "").replace(/\.png$/i, "");
        if (!fileName) fileName = "hp-still-" + (new Date().getTime());
        var base = new File(Folder.temp.fsName + "/" + fileName).fsName;

        qeSeq.exportFramePNG(time, base);
        $.sleep(1200); // QE escribe el archivo de forma diferida

        var candidates = [base + ".png", base, base + ".png.png"];
        for (var i = 0; i < candidates.length; i++) {
            var f = new File(candidates[i]);
            if (f.exists && f.length > 100) return "ok|" + candidates[i];
        }
        return "error: el frame no se generó (tc=" + time + ")";
    } catch (e) {
        return "error: " + e.toString();
    }
}

// ¿Está libre la pista en el rango [start, start+dur)? (sin clips que solapen)
function hp_trackIsFree(track, start, end) {
    try {
        for (var i = 0; i < track.clips.numItems; i++) {
            var c = track.clips[i];
            var cs = c.start.seconds;
            var ce = c.end.seconds;
            if (cs < end && ce > start) return false; // solapa
        }
        return true;
    } catch (e) {
        return false; // ante la duda, no usar esta pista
    }
}

// ── Exportar el AUDIO de la secuencia (para transcribir) ─────────────
// Antes se transcribía el "clip más largo" de la secuencia, y eso elegía mal:
// en un timeline con overlays del propio plugin, el clip más largo podía ser un
// "Marcador N vX.mov" (ProRes con alpha, MUDO). Exportar el audio de la
// secuencia arregla eso de raíz y además deja los tiempos YA alineados al
// timeline (tiempo del audio = tiempo de la secuencia → desfase 0).

// Presets de audio que trae Premiere, en orden de preferencia. El primero es
// exactamente lo que Whisper quiere (mono 16 bits 16 kHz) → cero reconversión.
var HP_AUDIO_PRESETS = [
    "WAV_Mono_16bit_16kHz.epr",
    "Wave48mono16.epr",
    "Wave48mono24.epr",
    "AudioOnly.epr"
];

// Carpetas candidatas donde viven los EncoderPresets, según plataforma e
// instalación. Se prueban en orden y se usa la primera que exista.
function hp_encoderPresetDirs() {
    var dirs = [];
    function push(p) { if (p) dirs.push(p); }
    // app.path apunta a la instalación de Premiere (varía por plataforma/versión).
    var base = "";
    try { base = String(app.path || ""); } catch (e) {}
    if (base) {
        push(base + "/Settings/EncoderPresets");                        // Windows
        push(base + "/Contents/Settings/EncoderPresets");               // macOS (.app)
        push(base + "/../Settings/EncoderPresets");
    }
    // Barrido de las rutas de instalación típicas (cubre cambios de año/versión).
    var roots = ["/Applications", "C:/Program Files/Adobe", "C:/Program Files (x86)/Adobe"];
    for (var r = 0; r < roots.length; r++) {
        try {
            var folder = new Folder(roots[r]);
            if (!folder.exists) continue;
            var kids = folder.getFiles("Adobe Premiere Pro*");
            for (var k = 0; k < kids.length; k++) {
                var p = kids[k].fsName;
                push(p + "/Settings/EncoderPresets");                                    // Windows
                push(p + "/Contents/Settings/EncoderPresets");                           // .app directo
                // En macOS la carpeta contiene el .app: "…/Adobe Premiere Pro 2026.app".
                try {
                    var inner = new Folder(p).getFiles("*.app");
                    for (var a = 0; a < inner.length; a++) {
                        push(inner[a].fsName + "/Contents/Settings/EncoderPresets");
                    }
                } catch (e3) {}
            }
        } catch (e2) {}
    }
    return dirs;
}

// Ruta absoluta al .epr de audio a usar, o "" si no se encontró ninguno.
function hp_findAudioPreset() {
    var dirs = hp_encoderPresetDirs();
    for (var p = 0; p < HP_AUDIO_PRESETS.length; p++) {
        for (var d = 0; d < dirs.length; d++) {
            try {
                var f = new File(dirs[d] + "/" + HP_AUDIO_PRESETS[p]);
                if (f.exists) return f.fsName;
            } catch (e) {}
        }
    }
    return "";
}

// Renderiza el audio de la secuencia activa COMPLETA a `outPath` (.wav).
// Devuelve "ok|<ruta>|<preset>" o "error: ...".
function hp_exportSequenceAudio(outPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "error: no hay secuencia activa";
        if (!outPath) return "error: falta la ruta de salida";

        var preset = hp_findAudioPreset();
        if (!preset) {
            return "error: no encontré ningún preset de audio (.epr) de Premiere. Buscado: " +
                HP_AUDIO_PRESETS.join(", ") + " en " + hp_encoderPresetDirs().slice(0, 4).join(" | ");
        }

        // workAreaType 0 = TODA la secuencia (no in/out ni área de trabajo).
        var ok = false;
        try { ok = seq.exportAsMediaDirect(outPath, preset, 0); } catch (e1) {
            return "error: exportAsMediaDirect falló: " + e1.toString() + " (preset: " + preset + ")";
        }

        // Premiere a veces ajusta el nombre/extensión: aceptamos la variante que exista.
        // Se devuelve el NOMBRE de la secuencia exportada (siempre la activa) para
        // que el panel confirme que es la que cree: si el editor cambió de timeline,
        // guardar este audio como transcript de otra clase sería un desastre.
        var candidates = [outPath, outPath + ".wav", outPath.replace(/\.wav$/i, "") + ".wav"];
        for (var i = 0; i < candidates.length; i++) {
            try {
                var f = new File(candidates[i]);
                if (f.exists && f.length > 0) return "ok|" + f.fsName + "|" + preset + "|" + seq.name;
            } catch (e2) {}
        }
        return "error: la exportación " + (ok ? "dijo OK" : "devolvió false") +
            " pero no encontré el archivo en " + outPath + " (preset: " + preset + ")";
    } catch (e) {
        return "error: " + e.toString();
    }
}

// Busca un bin hijo por nombre dentro de `parent`; si no existe, lo crea.
// Devuelve el projectItem del bin, o null si no se pudo.
function hp_ensureBin(parent, name) {
    if (!parent || !name) return null;
    try {
        var kids = parent.children;
        for (var i = 0; i < kids.numItems; i++) {
            var ch = kids[i];
            // type 2 = BIN. Coincidencia exacta de nombre.
            if (ch && ch.name === name && ch.type === 2) return ch;
        }
    } catch (e) {}
    try { return parent.createBin(name); } catch (e2) { return null; }
}

// Busca una secuencia del proyecto por nombre. Devuelve el objeto o null.
function hp_findSequenceByName(name) {
    try {
        var seqs = app.project.sequences;
        for (var i = 0; i < seqs.numSequences; i++) {
            if (seqs[i] && seqs[i].name === name) return seqs[i];
        }
    } catch (e) {}
    return null;
}

// Coloca el .mov en una secuencia ESPECÍFICA (por nombre), aunque no sea la
// activa — necesario para la cola: un trabajo de la secuencia A puede terminar
// mientras el editor está en la secuencia B. Devuelve "ok" o "error: ...".
// Índices de etiqueta de color de Premiere (orden del menú Etiqueta):
// 11 = Magenta, 14 = Marrón (café). Ver hp_recolorClipAt / colorLabel.
function hp_placeClipInSequence(movPath, seqName, atSeconds, durationSec, colorLabel) {
    try {
        var active = app.project.activeSequence;
        var isActive = active && active.name === seqName;
        var seq = isActive ? active : hp_findSequenceByName(seqName);
        if (!seq) return "error: no se encontró la secuencia \"" + seqName + "\" (¿la cerraste?)";

        var f = new File(movPath);
        if (!f.exists) return "error: no existe el archivo: " + movPath;

        var start = Number(atSeconds) || 0;
        var end = start + (Number(durationSec) || 5);

        var hpBin = hp_ensureBin(app.project.rootItem, "HyperPremiere");
        var seqBin = hpBin ? hp_ensureBin(hpBin, String(seqName || "secuencia")) : null;
        var targetBin = seqBin || hpBin || app.project.rootItem;
        app.project.importFiles([movPath], true, targetBin, false);

        // Localizar el ítem importado por su RUTA DE MEDIA, que es su identidad
        // real. Antes se buscaba por nombre y, si no aparecía, se agarraba el
        // último hijo del bin: eso podía colocar el video de OTRO marcador en
        // este (Premiere no siempre materializa el import de inmediato, y con dos
        // renders terminando juntos el "último" es una lotería). El nombre queda
        // como respaldo por si getMediaPath no está disponible.
        var root = targetBin;
        var count = root.children.numItems;
        var wantPath = String(f.fsName);
        var baseName = f.name.replace(/\.[^\.]+$/, "");
        var item = null;
        var byName = null;
        for (var i = count - 1; i >= 0; i--) {
            var ch = root.children[i];
            if (!ch) continue;
            var mp = "";
            try { if (ch.getMediaPath) mp = String(ch.getMediaPath() || ""); } catch (eMp) {}
            if (mp && mp === wantPath) { item = ch; break; }
            if (!byName && ch.name && ch.name.indexOf(baseName) === 0) byName = ch;
        }
        if (!item) item = byName;
        if (!item) return "error: Premiere importó el video pero no lo encuentro en el bin (" + f.name + "); reintentá el render.";

        var vTracks = seq.videoTracks;
        if (!vTracks || vTracks.numTracks === 0) return "error: la secuencia no tiene pistas de video";
        var target = vTracks[vTracks.numTracks - 1];

        if (!hp_trackIsFree(target, start, end) && isActive) {
            // Solo podemos agregar pista vía QE en la secuencia ACTIVA.
            try {
                app.enableQE();
                var qeSeq = qe.project.getActiveSequence();
                qeSeq.addTracks(1, vTracks.numTracks);
                vTracks = seq.videoTracks;
                target = vTracks[vTracks.numTracks - 1];
            } catch (qerr) {
                target = vTracks[vTracks.numTracks - 1];
            }
        }

        target.overwriteClip(item, start);
        // Color de etiqueta (café=borrador / magenta=HQ) sobre el projectItem.
        try {
            var cl = Number(colorLabel);
            if (!isNaN(cl) && cl >= 0 && item.setColorLabel) item.setColorLabel(cl);
        } catch (eColor) {}
        return "ok";
    } catch (e) {
        return "error: " + e.toString();
    }
}

// Saca de Premiere las versiones viejas ANTES de borrar sus archivos: (1) quita
// sus clips de todas las secuencias, (2) elimina sus ítems del proyecto (bin) con
// el truco mover-a-bin-temporal + deleteBin. `namesJoined` = nombres de archivo
// separados por "\n" (los nombres nunca contienen saltos de línea — ExtendScript
// no trae JSON, así evitamos parsear con eval). Devuelve "ok|<n>|<m>" o "error: ...".
function hp_purgeClipsByName(namesJoined) {
    try {
        var arr = String(namesJoined || "").split("\n");
        var names = {};
        for (var a = 0; a < arr.length; a++) {
            var nm = arr[a];
            if (!nm) continue;
            names[nm] = true;
            names[nm.replace(/\.[^.]+$/, "")] = true; // sin extensión
        }
        function matches(name) {
            if (!name) return false;
            return names[name] === true || names[String(name).replace(/\.[^.]+$/, "")] === true;
        }

        // 1) Quitar clips de TODAS las secuencias (de arriba hacia abajo).
        var removedClips = 0;
        try {
            var seqs = app.project.sequences;
            for (var s = 0; s < seqs.numSequences; s++) {
                var seq = seqs[s];
                var vt = seq.videoTracks;
                for (var t = 0; t < vt.numTracks; t++) {
                    var track = vt[t];
                    for (var c = track.clips.numItems - 1; c >= 0; c--) {
                        var clip = track.clips[c];
                        var pn = clip && clip.projectItem ? clip.projectItem.name : (clip ? clip.name : "");
                        if (matches(pn)) {
                            try { clip.remove(false, false); removedClips++; } catch (er) {}
                        }
                    }
                }
            }
        } catch (eseq) {}

        // 2) Eliminar los ítems del proyecto: moverlos a un bin temporal y borrarlo.
        var root = app.project.rootItem;
        var trash = null;
        try { trash = root.createBin("__hp_trash__"); } catch (eb) {}
        var removedItems = 0;
        function walk(item) {
            if (!item || !item.children) return;
            for (var i = item.children.numItems - 1; i >= 0; i--) {
                var ch = item.children[i];
                if (!ch) continue;
                if (trash && ch === trash) continue;
                if (ch.type === 2) { walk(ch); continue; } // bin → recursar
                if (matches(ch.name)) {
                    try { if (trash) { ch.moveBin(trash); removedItems++; } } catch (em) {}
                }
            }
        }
        walk(root);
        if (trash) { try { trash.deleteBin(); } catch (ed) {} }
        return "ok|" + removedClips + "|" + removedItems;
    } catch (e) {
        return "error: " + e.toString();
    }
}

// Recolorea el clip de HyperPremiere que está en `atSeconds` (busca en las pistas
// de video, de arriba hacia abajo, el clip cuyo inicio coincide). Sirve para
// marcar como HQ (magenta) tras reemplazar el archivo, sin colocar un clip nuevo.
// Devuelve "ok" o "error: ...".
function hp_recolorClipAt(seqName, atSeconds, colorLabel) {
    try {
        var seq = (app.project.activeSequence && app.project.activeSequence.name === seqName)
            ? app.project.activeSequence : hp_findSequenceByName(seqName);
        if (!seq) return "error: no se encontró la secuencia \"" + seqName + "\"";
        var cl = Number(colorLabel);
        if (isNaN(cl) || cl < 0) return "error: color inválido";
        var start = Number(atSeconds) || 0;
        var tol = 0.25; // tolerancia en segundos para ubicar el clip
        var vTracks = seq.videoTracks;
        for (var t = vTracks.numTracks - 1; t >= 0; t--) {
            var track = vTracks[t];
            for (var i = 0; i < track.clips.numItems; i++) {
                var c = track.clips[i];
                if (Math.abs(c.start.seconds - start) <= tol && c.projectItem && c.projectItem.setColorLabel) {
                    c.projectItem.setColorLabel(cl);
                    return "ok";
                }
            }
        }
        return "error: no se encontró un clip en " + start + "s";
    } catch (e) {
        return "error: " + e.toString();
    }
}

