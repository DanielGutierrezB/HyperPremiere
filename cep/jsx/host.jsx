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
