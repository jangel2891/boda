'use strict';

/**
 * Test de humo: arranca un servidor objetivo real, lanza una prueba corta
 * con la CLI y verifica que el reporte JSON tenga números coherentes.
 * No usa dependencias externas.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { Histogram } = require('../src/histogram');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// --- 1) Pruebas unitarias del histograma ---
console.log('Histograma:');
check('percentiles de un dataset conocido', () => {
  const h = new Histogram();
  for (let i = 1; i <= 1000; i++) h.record(i); // 1..1000 ms
  const p50 = h.percentile(50);
  const p99 = h.percentile(99);
  assert(Math.abs(p50 - 500) / 500 < 0.05, `p50 ~500, obtuve ${p50}`);
  assert(Math.abs(p99 - 990) / 990 < 0.05, `p99 ~990, obtuve ${p99}`);
  assert.strictEqual(h.total, 1000);
});
check('merge de histogramas', () => {
  const a = new Histogram(); const b = new Histogram();
  for (let i = 0; i < 100; i++) { a.record(10); b.record(20); }
  a.add(b);
  assert.strictEqual(a.total, 200);
  assert(a.max >= 20);
});

// --- 2) Test end-to-end contra un servidor real ---
function runE2E() {
  return new Promise((resolve) => {
    let served = 0;
    const target = http.createServer((req, res) => {
      served++;
      res.writeHead(200); res.end('ok');
    });
    target.listen(0, () => {
      const port = target.address().port;
      const url = `http://127.0.0.1:${port}/`;
      const jsonPath = path.join(os.tmpdir(), `estres-smoke-${port}.json`);
      const bin = path.join(__dirname, '..', 'bin', 'estres.js');

      const child = spawn('node', [
        bin, '-c', '10', '-w', '2', '-d', '2', '--json', jsonPath, url,
      ], { stdio: ['ignore', 'ignore', 'inherit'] });

      child.on('exit', (code) => {
        console.log('\nEnd-to-end:');
        check('la CLI termina con código 0', () => assert.strictEqual(code, 0));
        check('genera reporte JSON', () => assert(fs.existsSync(jsonPath)));
        const r = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        check('hizo peticiones', () => assert(r.requests > 0, `requests=${r.requests}`));
        check('sin errores de red', () => assert.strictEqual(r.errors, 0));
        check('todo fueron 200', () => assert.strictEqual(r.statusCounts['200'], r.requests));
        check('conteo del servidor coincide (±2%)', () => {
          const diff = Math.abs(served - r.requests) / r.requests;
          assert(diff < 0.02, `servidor=${served} cliente=${r.requests}`);
        });
        check('throughput reportado > 0', () => assert(r.throughputRps > 0));
        try { fs.unlinkSync(jsonPath); } catch {}
        target.close(() => resolve());
      });
    });
  });
}

runE2E().then(() => {
  console.log(`\n${failures === 0 ? 'OK' : 'FALLAS: ' + failures}`);
  process.exit(failures === 0 ? 0 : 1);
});
