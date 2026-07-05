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
            items.push({
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
                ',"name":"' + hp_escapeJsonString(it.name) +
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
        var base = String(outPath).replace(/\.png$/i, "");

        qeSeq.exportFramePNG(time, base);
        $.sleep(1200); // QE escribe el archivo de forma diferida

        var candidates = [base + ".png", base, base + ".png.png", outPath, outPath + ".png"];
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
function hp_placeClipInSequence(movPath, seqName, atSeconds, durationSec) {
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

        var root = targetBin;
        var count = root.children.numItems;
        var baseName = f.name.replace(/\.[^\.]+$/, "");
        var item = null;
        for (var i = count - 1; i >= 0; i--) {
            var ch = root.children[i];
            if (ch && ch.name && ch.name.indexOf(baseName) === 0) { item = ch; break; }
        }
        if (!item && count > 0) item = root.children[count - 1];
        if (!item) return "error: no se pudo localizar el clip importado";

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
        return "ok";
    } catch (e) {
        return "error: " + e.toString();
    }
}

// Importa un .mov y lo coloca SIEMPRE en la pista superior si está libre;
// si no, crea una pista de video nueva encima y lo pone ahí (nunca pisa nada).
// El clip se importa a un bin "HyperPremiere" > "<secuencia>" para no dejarlo
// suelto en la raíz del proyecto. Devuelve "ok" o "error: ...".
function hp_placeClip(movPath, atSeconds, durationSec) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "error: no hay secuencia activa";

        var f = new File(movPath);
        if (!f.exists) return "error: no existe el archivo: " + movPath;

        var start = Number(atSeconds) || 0;
        var end = start + (Number(durationSec) || 5);

        // Bin organizado: HyperPremiere > <nombre de la secuencia>.
        // Si por algún motivo no se puede crear, cae a la raíz del proyecto.
        var hpBin = hp_ensureBin(app.project.rootItem, "HyperPremiere");
        var seqBin = hpBin ? hp_ensureBin(hpBin, String(seq.name || "secuencia")) : null;
        var targetBin = seqBin || hpBin || app.project.rootItem;

        // Importar al bin destino (suppressUI = true, no como stills).
        app.project.importFiles([movPath], true, targetBin, false);

        // Localizar el projectItem recién importado por nombre; fallback al último.
        var root = targetBin;
        var count = root.children.numItems;
        var baseName = f.name.replace(/\.[^\.]+$/, "");
        var item = null;
        for (var i = count - 1; i >= 0; i--) {
            var ch = root.children[i];
            if (ch && ch.name && ch.name.indexOf(baseName) === 0) { item = ch; break; }
        }
        if (!item && count > 0) item = root.children[count - 1];
        if (!item) return "error: no se pudo localizar el clip importado";

        var vTracks = seq.videoTracks;
        if (!vTracks || vTracks.numTracks === 0) return "error: la secuencia no tiene pistas de video";

        // 1) Si la pista superior está libre en el rango, usarla.
        var topIndex = vTracks.numTracks - 1;
        var target = vTracks[topIndex];

        if (!hp_trackIsFree(target, start, end)) {
            // 2) Crear una pista de video nueva encima (QE) y usarla.
            try {
                app.enableQE();
                var qeSeq = qe.project.getActiveSequence();
                qeSeq.addTracks(1, vTracks.numTracks); // 1 pista de video tras la última
                vTracks = seq.videoTracks; // re-leer tras agregar
                target = vTracks[vTracks.numTracks - 1];
            } catch (qerr) {
                // Si QE falla, seguimos con la pista superior existente.
                target = vTracks[vTracks.numTracks - 1];
            }
        }

        target.overwriteClip(item, start);
        return "ok";
    } catch (e) {
        return "error: " + e.toString();
    }
}
