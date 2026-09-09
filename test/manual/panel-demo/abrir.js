#!/usr/bin/env node
/**
 * abrir.js — arma el panel de demostración y lo sirve para mirarlo.
 *
 *   node test/manual/panel-demo/abrir.js             # sirve en :4599 y lo abre
 *   node test/manual/panel-demo/abrir.js --no-open   # solo imprime las URLs
 *   node test/manual/panel-demo/abrir.js --puerto 5000
 *
 * Qué hace: toma cep/index.html TAL CUAL —no lo copia ni lo edita en el repo—,
 * le pone un <base> apuntando a cep/ (así el CSS y todos los js/ salen de los
 * archivos de verdad) y le inyecta dos <script> ANTES de CSInterface.js:
 * datos.js (los datos falsos) y doble.js (el doble de Premiere y del motor).
 *
 * Por eso no hace falta tocar cep/index.html ni dejarle nada inerte adentro:
 * la línea extra se agrega al vuelo, sobre una copia que vive fuera del panel.
 *
 * Se ofrecen dos maneras de abrirlo, porque no todos los navegadores dejan
 * cargar scripts de otra carpeta desde file:// (el de Cursor directamente no
 * abre file://):
 *   · http://localhost:4599/  ← esta es la que anda en todos lados
 *   · el archivo suelto en el temporal del sistema (file://), por si preferís
 */
"use strict";

const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");

const raiz = path.resolve(__dirname, "..", "..", "..");
const cepDir = path.join(raiz, "cep");
const indexReal = path.join(cepDir, "index.html");

const args = process.argv.slice(2);
const puerto = (function () {
  const i = args.indexOf("--puerto");
  return i !== -1 ? parseInt(args[i + 1], 10) || 4599 : 4599;
})();

function fileUrl(p) { return "file://" + encodeURI(p).replace(/#/g, "%23"); }

/** cep/index.html + <base> + los dos scripts de la maqueta. */
function armar(basePath, datosSrc, dobleSrc) {
  let html = fs.readFileSync(indexReal, "utf8");
  if (html.indexOf("<head>") === -1) {
    throw new Error("cep/index.html cambió de forma: no encuentro <head>.");
  }
  html = html.replace("<head>", '<head>\n  <base href="' + basePath + '">');

  const marca = '<script src="js/CSInterface.js"></script>';
  if (html.indexOf(marca) === -1) {
    throw new Error("cep/index.html cambió de forma: no encuentro el <script> de CSInterface.");
  }
  return html.replace(marca,
    "<!-- MAQUETA (test/manual/panel-demo): no existe en el panel real ni en el ZXP -->\n" +
    '  <script src="' + datosSrc + '"></script>\n' +
    '  <script src="' + dobleSrc + '"></script>\n' +
    "  " + marca);
}

// ── Copia suelta en el temporal (file://) ─────────────────────────────
const salidaDir = path.join(os.tmpdir(), "hyperpremiere-demo");
const salida = path.join(salidaDir, "panel.html");
fs.mkdirSync(salidaDir, { recursive: true });
fs.writeFileSync(salida, armar(
  fileUrl(cepDir) + "/",
  fileUrl(path.join(__dirname, "datos.js")),
  fileUrl(path.join(__dirname, "doble.js"))
), "utf8");

// ── Servidor (http://) ────────────────────────────────────────────────
const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".woff2": "font/woff2", ".jsx": "text/plain; charset=utf-8"
};

function servirArchivo(res, abs) {
  fs.readFile(abs, function (err, buf) {
    if (err) { res.writeHead(404); res.end("no está: " + abs); return; }
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(abs).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(function (req, res) {
  const ruta = decodeURIComponent((req.url || "/").split("?")[0]);
  if (ruta === "/" || ruta === "/panel.html") {
    // Se rearma en cada recarga: tocás cep/ o datos.js, apretás F5 y está.
    let html;
    try { html = armar("/cep/", "/demo/datos.js", "/demo/doble.js"); }
    catch (e) { res.writeHead(500); res.end(String(e.message)); return; }
    res.writeHead(200, { "Content-Type": TIPOS[".html"], "Cache-Control": "no-store" });
    res.end(html);
    return;
  }
  if (ruta.indexOf("/demo/") === 0) {
    return servirArchivo(res, path.join(__dirname, ruta.slice("/demo/".length)));
  }
  if (ruta.indexOf("/cep/") === 0) {
    const abs = path.normalize(path.join(cepDir, ruta.slice("/cep/".length)));
    if (abs.indexOf(cepDir) !== 0) { res.writeHead(403); res.end("nope"); return; }
    return servirArchivo(res, abs);
  }
  res.writeHead(404); res.end("nada acá");
});

server.listen(puerto, "127.0.0.1", function () {
  const url = "http://localhost:" + puerto + "/";
  console.log("Panel de demostración (maqueta con datos falsos)\n");
  console.log("  " + url + "                     ← recomendada");
  console.log("  " + fileUrl(salida) + "   (archivo suelto)\n");
  console.log("Escenarios — se agregan a la URL, sin tocar código:");
  console.log("  " + url + "?e=vacio            proyecto recién abierto, sin nada");
  console.log("  " + url + "?e=motor            el motor Node no cargó");
  console.log("  " + url + "?e=preparar         el motor está pero sin dependencias");
  console.log("  " + url + "?e=whisper          falta el Whisper local");
  console.log("  " + url + "?e=otra-secuencia   Premiere está parado en otra secuencia");
  console.log("  " + url + "?e=conflicto        el prompt general de esta máquina no coincide con el del proyecto");
  console.log("  " + url + "?e=sin-secuencia    Premiere sin secuencia al frente: el bloque de la clase no se ofrece");
  console.log("  " + url + "?e=sin-medir        todavía no se generó con ningún proveedor (⚙ lo dice)");
  console.log("  " + url + "?e=api-key          el CLI de Claude entra con API key, así que ⚙ sí promete el 1M");
  console.log("  " + url + "?e=cursor           Cursor elegido y con sesión");
  console.log("  " + url + "?e=cursor-sin-sesion  Cursor elegido, CLI instalado y sin login (el caso del editor)");
  console.log("  " + url + "?e=cursor-sin-cli   Cursor elegido y sin el binario (spawn cursor-agent ENOENT)");
  console.log("  " + url + "?e=cursor-sin-cupo  Cursor con credencial pero la cuenta sin cupo (⚙ en ámbar)");
  console.log("  (se combinan con coma: ?e=whisper,otra-secuencia)\n");
  console.log("Los datos falsos se editan en test/manual/panel-demo/datos.js — recargás y listo.");
  console.log("Ctrl+C para cortar.\n");

  if (args.indexOf("--no-open") === -1) {
    const abridor = process.platform === "darwin" ? "open" : (process.platform === "win32" ? "start" : "xdg-open");
    execFile(abridor, [url], function (err) {
      if (err) console.log("(no pude abrirlo solo: copiá la URL de arriba)");
    });
  }
});
