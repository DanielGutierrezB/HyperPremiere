#!/usr/bin/env node
/**
 * Empaqueta y firma el panel CEP (cep/) en un .zxp instalable.
 * Usa la librería zxp-sign-cmd (envuelve el ZXPSignCmd de Adobe).
 * La primera vez crea un certificado self-signed en dist/.
 *
 * Uso: node scripts/sign-zxp.js
 */
const path = require("path");
const fs = require("fs");

let zxp;
try {
  zxp = require("zxp-sign-cmd");
} catch (e) {
  // Fallback a la instalación global del usuario.
  zxp = require(path.join(process.env.HOME, ".npm-packages/lib/node_modules/zxp-sign-cmd"));
}

const ROOT = path.resolve(__dirname, "..");
const cepDir = path.join(ROOT, "cep");
const bridgeDir = path.join(ROOT, "bridge");
const dist = path.join(ROOT, "dist");
const stage = path.join(dist, "stage");
const cert = path.join(dist, "hyperpremiere-cert.p12");
const output = path.join(dist, "HyperPremiere.zxp");
const PASSWORD = "hyperpremiere";

// Arma el contenido AUTOCONTENIDO a firmar: el panel (cep/) + el motor
// (bridge/) SIN node_modules (410 MB, binarios por plataforma → se instalan en
// la 1ª corrida) + version.json (el motor lo lee desde <ext>/version.json).
function buildStage() {
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const skip = (p) => {
    const n = p.replace(/\\/g, "/");
    return /\/node_modules(\/|$)/.test(n) || /\/\.git(\/|$)/.test(n) || /\/\.DS_Store$/.test(n);
  };
  fs.cpSync(cepDir, stage, { recursive: true, filter: (src) => !skip(src) });
  fs.cpSync(bridgeDir, path.join(stage, "bridge"), { recursive: true, filter: (src) => !skip(src) });
  const vj = path.join(ROOT, "version.json");
  if (fs.existsSync(vj)) fs.copyFileSync(vj, path.join(stage, "version.json"));
  return stage;
}

(async () => {
  fs.mkdirSync(dist, { recursive: true });

  if (!fs.existsSync(cert)) {
    console.log("[hyperpremiere] creando certificado self-signed…");
    await zxp.selfSignedCert({
      country: "CO",
      province: "Bogota",
      org: "Codigo",
      name: "HyperPremiere",
      password: PASSWORD,
      output: cert,
      validityDays: 3650
    });
  }

  if (fs.existsSync(output)) fs.unlinkSync(output);

  console.log("[hyperpremiere] armando contenido (cep + bridge sin node_modules)…");
  const input = buildStage();

  console.log("[hyperpremiere] firmando ZXP…");
  var signOpts = {
    input: input,
    output: output,
    cert: cert,
    password: PASSWORD
  };
  // Timestamp opcional: solo si se pasa HP_TSA (requiere red al servidor TSA).
  // Sin timestamp la firma es válida igual para instalación local/dev.
  if (process.env.HP_TSA) signOpts.timestamp = process.env.HP_TSA;
  await zxp.sign(signOpts);
  fs.rmSync(stage, { recursive: true, force: true });

  console.log("[hyperpremiere] ✓ ZXP listo (autocontenido: cep + bridge):", output);
})().catch((e) => {
  console.error("[hyperpremiere] ERROR:", (e && e.message) || e);
  process.exit(1);
});
