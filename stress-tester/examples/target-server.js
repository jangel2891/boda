#!/usr/bin/env node
'use strict';

/**
 * Servidor objetivo de ejemplo, para practicar contra algo local antes de
 * apuntar a tu infraestructura real.
 *
 *   node examples/target-server.js [puerto]
 *
 * Endpoints:
 *   GET  /            -> 200, respuesta rápida
 *   GET  /slow        -> 200 con latencia artificial (~50-250ms)
 *   GET  /flaky       -> ~10% de 500, resto 200
 *   POST /echo        -> 200 devolviendo el cuerpo
 */

const http = require('http');
const port = parseInt(process.argv[2], 10) || 3000;

function jitter(min, max) { return min + Math.floor(Math.random() * (max - min)); }

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('lento pero seguro\n');
    }, jitter(50, 250));
    return;
  }

  if (url === '/flaky') {
    if (Math.random() < 0.1) {
      res.writeHead(500); res.end('boom\n'); return;
    }
    res.writeHead(200); res.end('ok\n'); return;
  }

  if (url === '/echo' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(body);
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok\n');
});

server.listen(port, () => {
  console.log(`Servidor objetivo de ejemplo en http://localhost:${port}`);
  console.log('Endpoints: /  /slow  /flaky  POST /echo');
});
