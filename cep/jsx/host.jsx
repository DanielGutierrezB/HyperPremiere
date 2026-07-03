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

// Importa un .mov y lo coloca en la pista de video superior, en atSeconds.
// Devuelve "ok" o "error: ...".
function hp_placeClip(movPath, atSeconds) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "error: no hay secuencia activa";

        var f = new File(movPath);
        if (!f.exists) return "error: no existe el archivo: " + movPath;

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

        // Pista de video superior (la de mayor índice).
        var vTracks = seq.videoTracks;
        if (!vTracks || vTracks.numTracks === 0) return "error: la secuencia no tiene pistas de video";
        var track = vTracks[vTracks.numTracks - 1];

        // Colocar en atSeconds. overwriteClip acepta el tiempo en segundos.
        // TODO: verificar en tu Premiere si requiere Time/ticks en vez de number.
        track.overwriteClip(item, atSeconds);
        return "ok";
    } catch (e) {
        return "error: " + e.toString();
    }
}
