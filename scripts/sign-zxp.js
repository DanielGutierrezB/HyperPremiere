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
const input = path.join(ROOT, "cep");
const dist = path.join(ROOT, "dist");
const cert = path.join(dist, "hyperpremiere-cert.p12");
const output = path.join(dist, "HyperPremiere.zxp");
const PASSWORD = "hyperpremiere";

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

  console.log("[hyperpremiere] ✓ ZXP listo:", output);
})().catch((e) => {
  console.error("[hyperpremiere] ERROR:", (e && e.message) || e);
  process.exit(1);
});
