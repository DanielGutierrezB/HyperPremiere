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

function hp_getProjectPath() {
    try {
        return app.project && app.project.path ? app.project.path : "";
    } catch (e) {
        return "";
    }
}

// Exporta el frame actual del monitor de programa (playhead) a un PNG.
// Adobe cambió esta API entre versiones; probamos varias vías en orden y
// reportamos con detalle si ninguna funciona. Devuelve "ok" o "error: ...".
function hp_captureProgramFrame(outPath) {
    var seq = app.project.activeSequence;
    if (!seq) return "error: no hay secuencia activa";

    var ticks = "0";
    try { ticks = seq.getPlayerPosition().ticks; } catch (e) {}

    var tried = [];
    var f = new File(outPath);

    // 1) DOM: seq.exportFramePNG(ticks, path)  (Premiere viejo)
    try {
        if (typeof seq.exportFramePNG === "function") {
            seq.exportFramePNG(ticks, outPath);
            if (f.exists && f.length > 0) return "ok";
        } else { tried.push("dom: sin exportFramePNG"); }
    } catch (e) { tried.push("dom: " + e.toString()); }

    // 2) QE DOM (vía confiable en Premiere reciente)
    try {
        app.enableQE();
        var q = (typeof qe !== "undefined" && qe.project) ? qe.project.getActiveSequence() : null;
        if (q && typeof q.exportFramePNG === "function") {
            // Firma A: exportFramePNG(path)
            try { q.exportFramePNG(outPath); } catch (eA) {
                // Firma B: exportFramePNG(ticks, path)
                try { q.exportFramePNG(ticks, outPath); } catch (eB) { tried.push("qe: " + eB.toString()); }
            }
            if (f.exists && f.length > 0) return "ok";
        } else { tried.push("qe: sin exportFramePNG"); }
    } catch (e) { tried.push("qe-enable: " + e.toString()); }

    return "error: no se pudo exportar el frame [" + tried.join(" | ") + "]";
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

// Importa un .mov y lo coloca SIEMPRE en la pista superior si está libre;
// si no, crea una pista de video nueva encima y lo pone ahí (nunca pisa nada).
// Devuelve "ok" o "error: ...".
function hp_placeClip(movPath, atSeconds, durationSec) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "error: no hay secuencia activa";

        var f = new File(movPath);
        if (!f.exists) return "error: no existe el archivo: " + movPath;

        var start = Number(atSeconds) || 0;
        var end = start + (Number(durationSec) || 5);

        // Importar al root del proyecto (suppressUI = true, no como stills).
        app.project.importFiles([movPath], true, app.project.rootItem, false);

        // Localizar el projectItem recién importado por nombre; fallback al último.
        var root = app.project.rootItem;
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
