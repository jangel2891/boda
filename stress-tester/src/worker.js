'use strict';

/**
 * Worker de carga. Corre en un hilo (worker_thread) independiente.
 *
 * Levanta N "usuarios virtuales" (VUs), cada uno en un bucle cerrado:
 *   request -> await response -> registrar métricas -> repetir
 * hasta que el proceso principal indica detenerse o se agota la duración.
 *
 * Reporta al hilo principal, cada `reportInterval` ms, un delta con:
 *  - histograma de latencias del intervalo
 *  - conteos por código de estado / error
 *  - bytes recibidos y número de peticiones
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { parentPort, workerData } = require('worker_threads');
const { Histogram } = require('./histogram');

const cfg = workerData.config;
const vus = workerData.vus; // usuarios virtuales asignados a este worker
// Presupuesto de peticiones para ESTE worker (0 = ilimitado). El proceso
// principal reparte cfg.maxRequests entre los workers.
const maxRequests = workerData.maxRequests || 0;
let globalRequestsIssued = 0;

// Objetivos (uno o varios); los VUs los recorren en round-robin.
const targets = cfg.urls.map((u) => {
  const parsed = new URL(u);
  const isHttps = parsed.protocol === 'https:';
  const agent = new (isHttps ? https : http).Agent({
    keepAlive: cfg.keepAlive,
    maxSockets: Infinity,
    // Verificación TLS: por defecto activa; se puede desactivar para hosts internos.
  });
  return {
    lib: isHttps ? https : http,
    options: {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: cfg.method,
      headers: cfg.headers,
      agent,
      rejectUnauthorized: !cfg.insecure,
    },
  };
});

// Acumuladores del intervalo (se reinician tras cada reporte).
let hist = new Histogram();
let reqs = 0;
let errors = 0;
let bytes = 0;
let non2xx = 0;
const statusCounts = Object.create(null);

// Contadores totales para el corte final.
let running = true;
let startedAt = 0;

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

// Pacing opcional: si hay un límite global de RPS, cada VU espaciará sus
// peticiones. intervalPerVU = 1000 / (rate / totalConnections).
const perVuIntervalMs =
  cfg.rate > 0 ? (1000 * cfg.totalConnections) / cfg.rate : 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function doRequest(target) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = target.lib.request(target.options, (res) => {
      let len = 0;
      res.on('data', (chunk) => {
        len += chunk.length;
      });
      res.on('end', () => {
        finish(() => {
          const ms = Number(process.hrtime.bigint() - start) / 1e6;
          hist.record(ms);
          reqs++;
          bytes += len;
          bump(statusCounts, String(res.statusCode));
          if (res.statusCode >= 400) non2xx++;
          resolve();
        });
      });
      res.on('error', () => {
        finish(() => {
          errors++;
          bump(statusCounts, 'read_error');
          resolve();
        });
      });
      // Consumir el stream para liberar el socket aunque no haya listeners extra.
      res.resume();
    });

    req.on('error', (err) => {
      finish(() => {
        errors++;
        bump(statusCounts, err.code || 'error');
        resolve();
      });
    });

    if (cfg.timeout > 0) {
      req.setTimeout(cfg.timeout, () => {
        req.destroy(new Error('timeout'));
        finish(() => {
          errors++;
          bump(statusCounts, 'timeout');
          resolve();
        });
      });
    }

    if (cfg.body) req.write(cfg.body);
    req.end();
  });
}

async function runVU(index) {
  // Reparte el punto de partida entre objetivos para no golpear siempre el mismo.
  let t = index % targets.length;
  while (running) {
    if (cfg.duration > 0 && Date.now() - startedAt >= cfg.duration * 1000) break;
    if (maxRequests > 0 && globalRequestsIssued >= maxRequests) break;
    globalRequestsIssued++;

    const target = targets[t];
    t = (t + 1) % targets.length;

    const cycleStart = Date.now();
    await doRequest(target);

    if (perVuIntervalMs > 0) {
      const elapsed = Date.now() - cycleStart;
      const wait = perVuIntervalMs - elapsed;
      if (wait > 0) await sleep(wait);
    }
  }
}

function report() {
  const snap = hist.snapshot();
  parentPort.postMessage({
    type: 'stats',
    hist: snap,
    reqs,
    errors,
    bytes,
    non2xx,
    statusCounts: { ...statusCounts },
  });
  // Reiniciar acumuladores del intervalo.
  hist = new Histogram();
  reqs = 0;
  errors = 0;
  bytes = 0;
  non2xx = 0;
  for (const k of Object.keys(statusCounts)) delete statusCounts[k];
}

async function start() {
  startedAt = Date.now();
  const timer = setInterval(report, cfg.reportInterval);

  // Ramp-up: escalona el arranque de los VUs a lo largo de rampUp segundos.
  const rampMs = cfg.rampUp * 1000;
  const stagger = vus > 0 && rampMs > 0 ? rampMs / vus : 0;

  const tasks = [];
  for (let i = 0; i < vus; i++) {
    if (stagger > 0) await sleep(stagger);
    if (!running) break;
    tasks.push(runVU(i));
  }
  await Promise.all(tasks);

  clearInterval(timer);
  report(); // último delta
  parentPort.postMessage({ type: 'done' });
}

// (globalRequestsIssued se declara arriba, junto a la config)

parentPort.on('message', (msg) => {
  if (msg === 'stop') running = false;
});

start().catch((err) => {
  parentPort.postMessage({ type: 'fatal', error: String(err && err.stack || err) });
});
