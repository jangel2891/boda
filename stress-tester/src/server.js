'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * Servidor mínimo del dashboard.
 *  - GET /            -> sirve public/index.html
 *  - GET /events      -> stream SSE con snapshots de métricas en vivo
 *  - GET /snapshot    -> último snapshot en JSON (para polling/curl)
 *
 * Sin dependencias externas: solo http nativo + Server-Sent Events.
 */
function startServer(runner, port) {
  const clients = new Set();
  let last = null;

  const indexPath = path.join(__dirname, '..', 'public', 'index.html');

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      fs.readFile(indexPath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end('No se pudo cargar el dashboard');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    if (req.url === '/snapshot') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(last || {}));
      return;
    }

    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      if (last) res.write(`data: ${JSON.stringify(last)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  server.listen(port, () => {
    process.stderr.write(`Dashboard en vivo: http://localhost:${port}\n`);
  });
  server.on('error', (err) => {
    process.stderr.write(`\n[dashboard] no se pudo iniciar en el puerto ${port}: ${err.message}\n`);
  });

  return {
    broadcast(snapshot) {
      last = snapshot;
      const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
      for (const res of clients) {
        try { res.write(payload); } catch { clients.delete(res); }
      }
    },
    close() {
      for (const res of clients) { try { res.end(); } catch {} }
      server.close();
    },
  };
}

module.exports = { startServer };
