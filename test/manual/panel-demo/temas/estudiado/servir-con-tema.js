#!/usr/bin/env node
'use strict';

// Un proxy de una línea para poder correr `medir-botones.js` CONTRA EL TEMA.
//
// `medir-botones.js` es el medidor oficial del repo y arma sus URLs como
// `BASE + '?e=escenario'`, así que con `--base 'http://localhost:4599/?tema=…'`
// quedan dos `?` y se pierden las dos cosas: el tema y el escenario. Y el
// medidor no se puede tocar (es del panel publicado, no de esta propuesta).
//
// Entonces: este proceso escucha en otro puerto, le agrega `tema=<nombre>` a la
// query de cada pedido y lo reenvía a la maqueta. Con eso el medidor corre sin
// una sola modificación y las 23 vistas —escenarios incluidos— se miden con el
// tema puesto.
//
//   node test/manual/panel-demo/abrir.js --no-open
//   node test/manual/panel-demo/temas/estudiado/servir-con-tema.js
//   node test/manual/panel-demo/medir-botones.js --base http://localhost:4600/ \
//        --anchos 320,400,600,900

const http = require('http');

function arg(nombre, def) {
  const i = process.argv.indexOf(nombre);
  return i === -1 ? def : process.argv[i + 1];
}

// `estudiado` ya NO existe como tema: la etapa 1 lo plegó adentro de
// `cep/css/style.css`, o sea que es la interfaz publicada y no una propuesta encima.
// Los que quedan son las otras dos exploraciones; el default apunta a una de ellas
// para que esto no sirva un tema fantasma en silencio (`abrir.js` ignora un `?tema=`
// que no existe, así que mediría el panel pelado creyendo que mide algo).
const TEMA = arg('--tema', 'premiere');
const DESTINO = Number(arg('--destino', 4599));
const PUERTO = Number(arg('--puerto', 4600));

const server = http.createServer(function (req, res) {
  // `?tema=estudiado?e=vacio` es lo que llega cuando el medidor concatena su
  // escenario: se normalizan los `?` de más a `&` antes de reenviar.
  let url = req.url || '/';
  const partes = url.split('?');
  const ruta = partes[0];
  const query = partes.slice(1).join('&');
  const params = new URLSearchParams(query);
  params.set('tema', TEMA);
  url = ruta + '?' + params.toString();

  const up = http.request(
    { host: '127.0.0.1', port: DESTINO, path: url, method: req.method, headers: req.headers },
    function (r) {
      res.writeHead(r.statusCode || 200, r.headers);
      r.pipe(res);
    }
  );
  up.on('error', function (e) { res.writeHead(502); res.end(String(e.message)); });
  req.pipe(up);
});

server.listen(PUERTO, '127.0.0.1', function () {
  console.log('Maqueta con el tema «' + TEMA + '» en http://localhost:' + PUERTO + '/');
  console.log('(reenvía a http://localhost:' + DESTINO + '/ agregando tema=' + TEMA + ')');
  console.log('Ctrl+C para cortar.');
});
