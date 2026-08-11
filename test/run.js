'use strict';

// Corre todos los tests del motor:  node test/run.js
// Devuelve 1 si algo falla, así sirve igual desde una terminal que desde un hook.

const fs = require('fs');
const path = require('path');
const { runAll, group } = require('./harness');

fs.readdirSync(__dirname)
  .filter((f) => /\.test\.js$/.test(f))
  .sort()
  .forEach((f) => {
    group(f);
    require(path.join(__dirname, f));
  });

runAll();
