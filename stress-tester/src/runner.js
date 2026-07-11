'use strict';

const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { Histogram, fromSnapshot } = require('./histogram');
const { startServer } = require('./server');

const WORKER_PATH = path.join(__dirname, 'worker.js');

function fmtNum(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtMs(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
  if (ms >= 10) return ms.toFixed(0) + 'ms';
  return ms.toFixed(2) + 'ms';
}
function fmtBytes(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i === 0 ? 0 : 2) + u[i];
}

class Runner {
  constructor(cfg) {
    this.cfg = cfg;
    this.workers = [];
    this.workersDone = 0;

    // Estado acumulado (total de toda la prueba).
    this.cumHist = new Histogram();
    this.totalReqs = 0;
    this.totalErrors = 0;
    this.totalNon2xx = 0;
    this.totalBytes = 0;
    this.statusCounts = Object.create(null);

    // Estado del intervalo actual (para RPS/latencia "en vivo").
    this.intervalHist = new Histogram();
    this.intervalReqs = 0;

    // Serie temporal para el dashboard.
    this.series = []; // { t, rps, p50, p95, p99, errors }

    this.startedAt = 0;
    this.lastTickAt = 0;
    this.server = null;
    this.onComplete = null;
    this.finished = false;
  }

  async run() {
    const { cfg } = this;
    this.startedAt = Date.now();
    this.lastTickAt = this.startedAt;

    if (cfg.dashboard) {
      this.server = startServer(this, cfg.port);
    }

    // Reparte VUs y presupuesto de peticiones entre los workers.
    const base = Math.floor(cfg.connections / cfg.workers);
    let rem = cfg.connections % cfg.workers;
    const reqBase = cfg.maxRequests > 0 ? Math.floor(cfg.maxRequests / cfg.workers) : 0;
    let reqRem = cfg.maxRequests > 0 ? cfg.maxRequests % cfg.workers : 0;

    for (let i = 0; i < cfg.workers; i++) {
      const vus = base + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
      const maxRequests = cfg.maxRequests > 0 ? reqBase + (reqRem > 0 ? 1 : 0) : 0;
      if (reqRem > 0) reqRem--;
      if (vus === 0) continue;

      const worker = new Worker(WORKER_PATH, {
        workerData: { config: cfg, vus, maxRequests },
      });
      worker.on('message', (msg) => this.onWorkerMessage(msg));
      worker.on('error', (err) => {
        process.stderr.write(`\n[worker error] ${err.stack || err}\n`);
      });
      this.workers.push(worker);
    }

    this.printHeader();
    this.ticker = setInterval(() => this.tick(), Math.max(cfg.reportInterval, 250));

    // Corte por duración (además del que aplica cada worker por su cuenta).
    if (cfg.duration > 0) {
      this.durationTimer = setTimeout(() => this.stop(), cfg.duration * 1000 + 500);
    }

    // Ctrl+C => cierre ordenado.
    process.on('SIGINT', () => {
      process.stderr.write('\n\nInterrumpido. Finalizando...\n');
      this.stop();
    });

    return new Promise((resolve) => { this.onComplete = resolve; });
  }

  onWorkerMessage(msg) {
    if (msg.type === 'stats') {
      const h = fromSnapshot(msg.hist);
      this.cumHist.add(h);
      this.intervalHist.add(h);
      this.totalReqs += msg.reqs;
      this.intervalReqs += msg.reqs;
      this.totalErrors += msg.errors;
      this.totalNon2xx += msg.non2xx;
      this.totalBytes += msg.bytes;
      for (const [k, v] of Object.entries(msg.statusCounts)) {
        this.statusCounts[k] = (this.statusCounts[k] || 0) + v;
      }
    } else if (msg.type === 'done') {
      this.workersDone++;
      if (this.workersDone >= this.workers.length) this.stop();
    } else if (msg.type === 'fatal') {
      process.stderr.write(`\n[worker fatal] ${msg.error}\n`);
    }
  }

  tick() {
    const now = Date.now();
    const dt = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    const rps = dt > 0 ? this.intervalReqs / dt : 0;

    const point = {
      t: Math.round((now - this.startedAt) / 1000),
      rps: Math.round(rps),
      p50: this.intervalHist.percentile(50),
      p95: this.intervalHist.percentile(95),
      p99: this.intervalHist.percentile(99),
      reqs: this.totalReqs,
      errors: this.totalErrors,
    };
    this.series.push(point);
    if (this.series.length > 3600) this.series.shift();

    this.renderTerminal(rps);
    if (this.server) this.server.broadcast(this.liveSnapshot(rps));

    // Reiniciar acumuladores del intervalo.
    this.intervalHist.reset();
    this.intervalReqs = 0;
  }

  liveSnapshot(rps) {
    return {
      elapsed: (Date.now() - this.startedAt) / 1000,
      rps: Math.round(rps),
      totalReqs: this.totalReqs,
      totalErrors: this.totalErrors,
      totalNon2xx: this.totalNon2xx,
      totalBytes: this.totalBytes,
      latency: {
        p50: this.cumHist.percentile(50),
        p90: this.cumHist.percentile(90),
        p95: this.cumHist.percentile(95),
        p99: this.cumHist.percentile(99),
        max: this.cumHist.max,
        mean: this.cumHist.mean,
      },
      statusCounts: { ...this.statusCounts },
      series: this.series.slice(-300),
      config: {
        urls: this.cfg.urls,
        connections: this.cfg.connections,
        workers: this.cfg.workers,
        method: this.cfg.method,
      },
      finished: this.finished,
    };
  }

  printHeader() {
    const c = this.cfg;
    process.stderr.write(
      `\nestres → ${c.method} ${c.urls.join(', ')}\n` +
      `  ${c.connections} conexiones · ${c.workers} workers · ` +
      (c.duration > 0 ? `${c.duration}s` : 'ilimitado') +
      (c.rate > 0 ? ` · límite ${c.rate} rps` : '') +
      (c.dashboard ? ` · dashboard http://localhost:${c.port}` : '') +
      `\n\n`
    );
  }

  renderTerminal(rps) {
    const el = ((Date.now() - this.startedAt) / 1000).toFixed(0);
    const line =
      `[${el}s] ` +
      `rps: ${String(fmtNum(Math.round(rps))).padStart(7)} · ` +
      `reqs: ${String(fmtNum(this.totalReqs)).padStart(9)} · ` +
      `p50 ${fmtMs(this.cumHist.percentile(50)).padStart(7)} · ` +
      `p95 ${fmtMs(this.cumHist.percentile(95)).padStart(7)} · ` +
      `p99 ${fmtMs(this.cumHist.percentile(99)).padStart(7)} · ` +
      `err: ${fmtNum(this.totalErrors)}`;
    // Sobrescribe la línea (carriage return) para un panel "en vivo".
    process.stderr.write('\r' + line.padEnd(100));
  }

  async stop() {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.ticker);
    clearTimeout(this.durationTimer);

    for (const w of this.workers) {
      try { w.postMessage('stop'); } catch {}
    }
    // Da un margen breve para el último reporte y termina los workers.
    await new Promise((r) => setTimeout(r, 400));
    for (const w of this.workers) {
      try { await w.terminate(); } catch {}
    }

    const report = this.finalReport();
    this.printFinalReport(report);

    if (this.cfg.json) {
      fs.writeFileSync(this.cfg.json, JSON.stringify(report, null, 2));
      process.stderr.write(`\nReporte JSON guardado en ${this.cfg.json}\n`);
    }

    if (this.server) {
      this.server.broadcast({ ...this.liveSnapshot(0), finished: true });
      process.stderr.write(
        `\nDashboard sigue disponible en http://localhost:${this.cfg.port} (Ctrl+C para salir)\n`
      );
      // No cerramos el server para poder ver el resultado final; el proceso
      // seguirá vivo hasta Ctrl+C.
    }

    if (this.onComplete) this.onComplete(report);
  }

  finalReport() {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    return {
      target: { urls: this.cfg.urls, method: this.cfg.method },
      config: {
        connections: this.cfg.connections,
        workers: this.cfg.workers,
        durationRequested: this.cfg.duration,
        rate: this.cfg.rate,
      },
      elapsedSeconds: Number(elapsed.toFixed(2)),
      requests: this.totalReqs,
      errors: this.totalErrors,
      non2xx: this.totalNon2xx,
      throughputRps: Number((this.totalReqs / elapsed).toFixed(2)),
      bytes: this.totalBytes,
      bytesPerSecond: Number((this.totalBytes / elapsed).toFixed(2)),
      latencyMs: {
        min: this.cumHist.min === Infinity ? 0 : Number(this.cumHist.min.toFixed(3)),
        mean: Number(this.cumHist.mean.toFixed(3)),
        p50: Number(this.cumHist.percentile(50).toFixed(3)),
        p90: Number(this.cumHist.percentile(90).toFixed(3)),
        p95: Number(this.cumHist.percentile(95).toFixed(3)),
        p99: Number(this.cumHist.percentile(99).toFixed(3)),
        p999: Number(this.cumHist.percentile(99.9).toFixed(3)),
        max: Number(this.cumHist.max.toFixed(3)),
      },
      statusCounts: { ...this.statusCounts },
    };
  }

  printFinalReport(r) {
    const L = r.latencyMs;
    const out = [];
    out.push('\n\n' + '─'.repeat(60));
    out.push('  RESULTADO DE LA PRUEBA DE ESTRÉS');
    out.push('─'.repeat(60));
    out.push(`  Objetivo        ${r.target.method} ${r.target.urls.join(', ')}`);
    out.push(`  Duración        ${r.elapsedSeconds}s`);
    out.push(`  Peticiones      ${fmtNum(r.requests)}`);
    out.push(`  Throughput      ${fmtNum(Math.round(r.throughputRps))} req/s`);
    out.push(`  Transferido     ${fmtBytes(r.bytes)} (${fmtBytes(r.bytesPerSecond)}/s)`);
    out.push(`  Errores de red  ${fmtNum(r.errors)}`);
    out.push(`  Respuestas 4xx/5xx  ${fmtNum(r.non2xx)}`);
    out.push('');
    out.push('  Latencia');
    out.push(`    min   ${fmtMs(L.min)}`);
    out.push(`    media ${fmtMs(L.mean)}`);
    out.push(`    p50   ${fmtMs(L.p50)}`);
    out.push(`    p90   ${fmtMs(L.p90)}`);
    out.push(`    p95   ${fmtMs(L.p95)}`);
    out.push(`    p99   ${fmtMs(L.p99)}`);
    out.push(`    p99.9 ${fmtMs(L.p999)}`);
    out.push(`    max   ${fmtMs(L.max)}`);
    out.push('');
    out.push('  Códigos de estado / errores');
    const entries = Object.entries(r.statusCounts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) out.push('    (ninguno)');
    for (const [code, count] of entries) {
      out.push(`    ${String(code).padEnd(16)} ${fmtNum(count)}`);
    }
    out.push('─'.repeat(60));
    process.stderr.write(out.join('\n') + '\n');
  }
}

module.exports = { Runner };
