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

// ¿Son la misma secuencia? Se compara por sequenceID, que es su identidad real:
// dos secuencias del mismo proyecto pueden llamarse igual.
function hp_sameSequence(a, b) {
    if (!a || !b) return false;
    var ida = "", idb = "";
    try { ida = String(a.sequenceID || ""); } catch (e1) {}
    try { idb = String(b.sequenceID || ""); } catch (e2) {}
    if (ida && idb) return ida === idb;
    return String(a.name) === String(b.name);
}

// Pasa `seq` al frente del timeline y NADA MÁS: no mueve el playhead ni toca la
// selección. Es para lo que Premiere solo permite en la secuencia ACTIVA
// (agregar pistas con QE, exportar el audio); el que la llama es responsable de
// devolver al editor a la secuencia que estaba mirando. Devuelve "ok" o "error: ...".
function hp_makeSequenceActive(seq) {
    try {
        if (!seq) return "error: no hay secuencia que abrir";
        if (hp_sameSequence(app.project.activeSequence, seq)) return "ok";
        // openSequence(sequenceID) la abre en el timeline y la hace activa.
        app.project.openSequence(seq.sequenceID);
        // Cambiar de timeline puede tardar un instante. Se le da un momento
        // antes de rendirse, porque rendirse acá significa no colocar el clip.
        for (var i = 0; i < 3 && !hp_sameSequence(app.project.activeSequence, seq); i++) {
            try { $.sleep(150); } catch (eSleep) {}
        }
        if (!hp_sameSequence(app.project.activeSequence, seq)) {
            return "error: Premiere no pasó a \"" + seq.name + "\"";
        }
        return "ok";
    } catch (e) {
        return "error: " + e.toString();
    }
}

// Igual pero por nombre. Devuelve "ok" o "error: ...".
function hp_activateSequence(seqName) {
    var active = app.project.activeSequence;
    // Si la que está al frente ya se llama así, es ésa: buscar por nombre podría
    // devolver una tocaya y hacerle cambiar de timeline al editor al vacío.
    if (active && active.name === seqName) return "ok";
    var seq = hp_findSequenceByName(seqName);
    if (!seq) return "error: no se encontró la secuencia \"" + seqName + "\"";
    return hp_makeSequenceActive(seq);
}

// Abre/activa una secuencia por nombre y mueve el playhead a `seconds`.
// Sirve para revisar un marcador recién terminado desde la Cola aunque el
// editor esté en otra secuencia. Devuelve "ok" o "error: ...".
// Mueve el playhead A PROPÓSITO: para solo activar (sin tocarle nada al editor)
// está hp_activateSequence.
function hp_openSequenceAndSeek(seqName, seconds) {
    try {
        var act = hp_activateSequence(seqName);
        if (act !== "ok") return act;
        var tgt = app.project.activeSequence;
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

// La pista de video de MÁS ARRIBA, que es donde va siempre la animación, o null
// si la secuencia no tiene pistas de video. Devolver null es seguro: para
// hp_trackIsFree "ante la duda" significa ocupada, así que nada se coloca.
function hp_topVideoTrack(seq) {
    try {
        var vt = seq.videoTracks;
        if (!vt || vt.numTracks === 0) return null;
        return vt[vt.numTracks - 1];
    } catch (e) {
        return null;
    }
}

// Segundos → "m:ss", que es como el editor lee su timeline. Solo para mensajes.
function hp_fmtTime(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" + r : String(r));
}

// ¿Este ítem del proyecto apunta a ESTE archivo? La ruta de medio es la
// identidad real de un clip: el nombre se repite entre versiones y entre
// marcadores, y con dos renders terminando juntos buscar por nombre colocaba (o
// recoloreaba) el video de OTRO marcador.
function hp_mediaPathIs(item, wantPath) {
    if (!item || !wantPath) return false;
    try {
        if (!item.getMediaPath) return false;
        var mp = String(item.getMediaPath() || "");
        if (!mp) return false;
        if (mp === wantPath) return true;
        // Windows no distingue mayúsculas en las rutas; Premiere puede devolver
        // la unidad en otra caja que la que nos dio el motor.
        return mp.toLowerCase() === String(wantPath).toLowerCase();
    } catch (e) {
        return false;
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

// ¿Alguna pista de AUDIO de la secuencia está libre en [start, end)? Solo se
// pregunta cuando el clip TRAE sonido: si hay lugar, el audio entra sin agregar
// pistas; si no, habría que pisarle el audio al editor y preferimos una nueva.
function hp_hasFreeAudioTrack(seq, start, end) {
    try {
        var aTracks = seq.audioTracks;
        if (!aTracks || aTracks.numTracks === 0) return false;
        for (var i = 0; i < aTracks.numTracks; i++) {
            if (hp_trackIsFree(aTracks[i], start, end)) return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

// ── Conseguir lugar sin pisarle nada al editor ───────────────────────
//
// LA REGLA DE ORO: overwriteClip pisa lo que encuentre, así que se llama
// ÚNICAMENTE sobre un tramo de pista que se acaba de verificar libre. Si no hay
// lugar y no se puede crear la pista, la colocación FALLA con un mensaje que
// dice qué hacer. Un marcador sin colocar se resuelve apretando un botón; un
// clip borrado del timeline del editor, no.

// Agrega pistas a `seq` con QE. Premiere solo deja agregarlas en la secuencia
// ACTIVA, así que si el editor está en otra: se pasa a la de destino un
// instante, se agrega, y se lo devuelve a la suya. No se le mueve el playhead ni
// la selección (ver hp_makeSequenceActive) y solo pasa cuando de verdad hace
// falta una pista nueva, que es una vez por secuencia y no en cada marcador.
//
// Se evaluó agregarlas SIN activar: QE expone getSequenceAt(i) para llegar a
// cualquier secuencia del proyecto. Se descartó a propósito — es API interna
// cuyas propias definiciones dicen que addTracks agrega "a la secuencia
// actual". Si eso es literal, le estaríamos insertando una pista vacía EN MEDIO
// de las del editor (justo lo que arreglamos en la 1.4.30) y no hay forma de
// comprobar cuál de las dos cosas hace sin Premiere delante. El DOM público no
// ofrece nada: videoTracks/audioTracks son de solo lectura, no hay addTrack en
// ninguna versión (tampoco en la 2026), y la API nueva (UXP) no se alcanza
// desde un panel CEP/ExtendScript.
//
// Devuelve "ok" (QE aceptó el pedido) o el motivo. Ojo: "ok" NO garantiza que la
// pista exista — quien llama tiene que verificarlo.
function hp_addTracks(seq, numVideo, videoIndex, numAudio, audioIndex) {
    var volverA = null;
    try {
        var antes = app.project.activeSequence;
        if (antes && !hp_sameSequence(antes, seq)) volverA = antes;
    } catch (e0) {}
    try {
        var act = hp_makeSequenceActive(seq);
        if (act !== "ok") return "no pude abrirla para agregarle la pista (" + act + ")";
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return "QE no me dio la secuencia activa";
        // Firma de QE: addTracks(numVideo, videoIndex, numAudio,
        // audioChannelType, audioIndex). Los CINCO argumentos van SIEMPRE: si se
        // omiten los de audio, QE usa su default numAudio = 1 y agrega una pista
        // de audio vacía por su cuenta, que era lo que le corría las pistas al
        // editor con cada animación muda (1.4.30).
        qeSeq.addTracks(numVideo, videoIndex, numAudio, 1, audioIndex);
        return "ok";
    } catch (e) {
        return "QE falló al agregar la pista: " + e.toString();
    } finally {
        // Volver SIEMPRE, haya salido bien o mal: el editor tiene que quedar en
        // la secuencia que estaba mirando.
        if (volverA) { try { hp_makeSequenceActive(volverA); } catch (e2) {} }
    }
}

// Deja lugar para el clip en `seq`: la pista de video de ARRIBA libre en
// [start, end) —donde va siempre la animación— y, si el clip trae sonido, alguna
// pista de audio libre. Agrega pistas si hace falta y COMPRUEBA que el lugar
// exista de verdad antes de decir que sí. Devuelve "ok" o el motivo (texto para
// el editor, sin el prefijo "error:").
function hp_makeRoom(seq, start, end, wantAudio) {
    var cuando = " entre " + hp_fmtTime(start) + " y " + hp_fmtTime(end);
    var faltaVideo = !hp_trackIsFree(hp_topVideoTrack(seq), start, end);
    // Audio: solo si el clip TRAE sonido y no queda ninguna pista de audio libre
    // donde meterlo. Nuestras animaciones con alpha son mudas, así que en la
    // práctica esto siempre da 0 y la secuencia conserva sus pistas de audio.
    var faltaAudio = wantAudio && !hp_hasFreeAudioTrack(seq, start, end);
    if (!faltaVideo && !faltaAudio) return "ok";

    var aIndex = 0;
    try { aIndex = seq.audioTracks.numTracks; } catch (eA) {}
    // La de video va ARRIBA de todo (videoIndex = las que ya hay), que es donde
    // va a caer el clip. La de audio va al FINAL para que A1, A2… sigan siendo
    // las mismas: insertarla arriba le renumeraría el trabajo al editor.
    var pedido = hp_addTracks(seq, faltaVideo ? 1 : 0, seq.videoTracks.numTracks, faltaAudio ? 1 : 0, aIndex);
    var detalle = (pedido === "ok")
        ? ": Premiere aceptó el pedido pero la pista no apareció"
        : ": " + pedido;

    if (!hp_trackIsFree(hp_topVideoTrack(seq), start, end)) {
        return "la pista de video de arriba tiene material" + cuando +
            " y no pude agregar una pista nueva encima" + detalle;
    }
    if (faltaAudio && !hp_hasFreeAudioTrack(seq, start, end)) {
        return "el video trae sonido, todas las pistas de audio tienen material" + cuando +
            " y no pude agregar una pista nueva" + detalle;
    }
    return "ok";
}

// El mensaje de "no coloqué nada". Dice qué pasó, que no se tocó nada, y cómo
// resolverlo a mano sin volver a renderizar (el video ya está en el proyecto).
function hp_noPlaceMsg(seqName, motivo) {
    return "error: NO coloqué la animación para no pisar tu material: en \"" + seqName + "\" " + motivo +
        ". No se tocó ningún clip tuyo. El video ya está importado en el bin HyperPremiere › " + seqName +
        ": hacé lugar en ese tramo (o agregá una pista de video vacía arriba) y arrastralo, o volvé a colocarlo desde la Cola.";
}

// Coloca el .mov en una secuencia ESPECÍFICA (por nombre), aunque no sea la
// activa — es el caso NORMAL, no la excepción: mientras se renderiza, el editor
// se va a trabajar a otra secuencia. Devuelve "ok" o "error: ...".
// Índices de etiqueta de color de Premiere (orden del menú Etiqueta):
// 11 = Magenta, 14 = Marrón (café). Ver hp_recolorClipAt / colorLabel.
// `hasAudio` (1/0): si el ARCHIVO trae pista de audio. Lo resuelve el motor con
// ffprobe antes de llamar (ver mediaHasAudio en bridge/engine.js): acá adentro
// no hay con qué mirar el contenido de un .mov. Solo decide si RESERVAMOS una
// pista de audio; nunca descarta el sonido del clip.
function hp_placeClipInSequence(movPath, seqName, atSeconds, durationSec, colorLabel, hasAudio) {
    try {
        var active = app.project.activeSequence;
        // Si la que está al frente ya se llama así, es ésa (puede haber tocayas).
        var seq = (active && active.name === seqName) ? active : hp_findSequenceByName(seqName);
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
            if (hp_mediaPathIs(ch, wantPath)) { item = ch; break; }
            if (!byName && ch.name && ch.name.indexOf(baseName) === 0) byName = ch;
        }
        if (!item) item = byName;
        if (!item) return "error: Premiere importó el video pero no lo encuentro en el bin (" + f.name + "); reintentá el render.";

        if (!seq.videoTracks || seq.videoTracks.numTracks === 0) return "error: la secuencia no tiene pistas de video";

        // Conseguir el lugar ANTES de colocar: la pista de video de arriba libre
        // en este tramo (agregando una encima si está ocupada, incluso si el
        // editor está mirando otra secuencia). Si no se pudo, no se coloca nada.
        // `hasAudio` (1/0) lo resuelve el motor con ffprobe antes de llamar (ver
        // mediaHasAudio en bridge/engine.js): acá adentro no hay con qué mirar el
        // contenido de un .mov.
        var room = hp_makeRoom(seq, start, end, (String(hasAudio) === "1" || hasAudio === true));
        if (room !== "ok") return hp_noPlaceMsg(seqName, room);

        var target = hp_topVideoTrack(seq);

        // ── RED DE SEGURIDAD: la última comprobación antes de escribir ────
        // overwriteClip PISA lo que encuentre, así que se llama únicamente sobre
        // un tramo que ACÁ MISMO se verificó libre. Sí, hp_makeRoom ya dijo "ok":
        // esto está igual a propósito, para que si esa lógica se equivoca (hoy o
        // el día que alguien la cambie) el editor pierda una colocación y no su
        // trabajo. Fue exactamente este agujero el que le borraba clips cuando la
        // secuencia de destino no era la activa.
        if (!hp_trackIsFree(target, start, end)) {
            return hp_noPlaceMsg(seqName, "la pista de video de arriba tiene material entre " +
                hp_fmtTime(start) + " y " + hp_fmtTime(end) + " (no debería haber llegado hasta acá)");
        }

        // overwriteClip se lleva el clip ENTERO: si el .mov trae audio, Premiere
        // lo baja solo a las pistas de audio (por eso "video + audio" sigue
        // funcionando sin código aparte); si es mudo, no toca el audio de nadie.
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
// el truco mover-a-bin-temporal + deleteBin. `pathsJoined` = rutas de archivo
// separadas por "\n" (las rutas nunca contienen saltos de línea — ExtendScript no
// trae JSON, así evitamos parsear con eval). Devuelve "ok|<n>|<m>" o "error: ...".
//
// Identifica por RUTA DE MEDIA, la misma regla de identidad que para colocar y
// recolorear (ver hp_mediaPathIs). Por nombre no alcanza: cada clase tiene su
// "Marcador 1 v1 [modelo].mov", así que limpiar las previas de una se llevaba de
// OTRA clase un clip que el editor ya había aprobado — y ese archivo no se
// borraba, así que el clip desaparecía del timeline sin ninguna señal.
function hp_purgeClipsByPath(pathsJoined) {
    try {
        var arr = String(pathsJoined || "").split("\n");
        var paths = [];   // rutas como las ve el SO
        var names = {};   // respaldo SOLO para ítems sin ruta legible
        for (var a = 0; a < arr.length; a++) {
            var p = arr[a];
            if (!p) continue;
            var f = null;
            try { f = new File(p); } catch (eF) {}
            paths.push(f ? String(f.fsName) : String(p));
            if (f && f.name) names[String(f.name)] = true;
        }
        // ¿Este ítem del proyecto es uno de los que vamos a borrar?
        function matches(item, fallbackName) {
            for (var i = 0; i < paths.length; i++) {
                if (hp_mediaPathIs(item, paths[i])) return true;
            }
            // Media offline: no hay ruta con la que comparar y lo único que queda
            // es el nombre. Es el caso raro, y era la regla anterior.
            var mp = "";
            try { mp = (item && item.getMediaPath) ? String(item.getMediaPath() || "") : ""; } catch (e) {}
            if (mp) return false;
            var nm = String((item && item.name) || fallbackName || "");
            return nm !== "" && names[nm] === true;
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
                        if (!clip) continue;
                        if (matches(clip.projectItem, clip.name)) {
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
                if (matches(ch, ch.name)) {
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

// Recolorea NUESTRO clip que está en `atSeconds` (busca en las pistas de video,
// de arriba hacia abajo, el clip que arranca ahí Y apunta a `mediaPath`). Sirve
// para marcar como HQ (magenta) tras reemplazar el archivo, sin colocar un clip
// nuevo. Devuelve "ok" o "error: ...".
//
// `mediaPath` es obligatorio y es la misma regla de identidad que al colocar: sin
// ella alcanzaba con que un clip del EDITOR arrancara en ese mismo segundo (en
// una pista más alta que la nuestra, por ejemplo) para llevarse la etiqueta de
// color. No es destructivo, pero es su proyecto y no lo tocamos. Si no aparece,
// esto falla y el panel dice "recoloreá a mano": una etiqueta es cosmética.
function hp_recolorClipAt(seqName, atSeconds, colorLabel, mediaPath) {
    try {
        var seq = (app.project.activeSequence && app.project.activeSequence.name === seqName)
            ? app.project.activeSequence : hp_findSequenceByName(seqName);
        if (!seq) return "error: no se encontró la secuencia \"" + seqName + "\"";
        var cl = Number(colorLabel);
        if (isNaN(cl) || cl < 0) return "error: color inválido";
        var want = String(mediaPath || "");
        if (!want) return "error: me falta la ruta del video: sin ella no sé cuál clip es el mío";
        try { want = String(new File(want).fsName); } catch (eF) {}
        var start = Number(atSeconds) || 0;
        var tol = 0.25; // tolerancia en segundos para ubicar el clip
        var vTracks = seq.videoTracks;
        for (var t = vTracks.numTracks - 1; t >= 0; t--) {
            var track = vTracks[t];
            for (var i = 0; i < track.clips.numItems; i++) {
                var c = track.clips[i];
                if (Math.abs(c.start.seconds - start) > tol) continue;
                if (!c.projectItem || !c.projectItem.setColorLabel) continue;
                if (!hp_mediaPathIs(c.projectItem, want)) continue;
                c.projectItem.setColorLabel(cl);
                return "ok";
            }
        }
        return "error: no encontré nuestro clip (" + want.replace(/^.*[\/\\]/, "") + ") en " + start + "s";
    } catch (e) {
        return "error: " + e.toString();
    }
}

