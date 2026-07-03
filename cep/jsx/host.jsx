function hp_getActiveSequenceName() {
    try {
        return app.project.activeSequence
            ? app.project.activeSequence.name
            : "(sin secuencia activa)";
    } catch (e) {
        return "Error: " + e.toString();
    }
}
