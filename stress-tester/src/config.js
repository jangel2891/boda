'use strict';

const fs = require('fs');
const os = require('os');
const { URL } = require('url');

const DEFAULTS = {
  urls: [],
  method: 'GET',
  headers: {},
  body: '',
  connections: 50, // usuarios virtuales totales
  workers: Math.max(1, Math.min(os.cpus().length, 8)),
  duration: 30, // segundos (0 = ilimitado, usar maxRequests o Ctrl+C)
  maxRequests: 0, // límite total de peticiones (0 = sin límite)
  rate: 0, // límite global de RPS (0 = a máxima velocidad)
  rampUp: 0, // segundos para escalar los VUs
  timeout: 10000, // ms por petición (0 = sin timeout)
  keepAlive: true,
  insecure: false, // true => no verificar TLS (hosts internos/self-signed)
  reportInterval: 250, // ms
  dashboard: false,
  port: 8787,
  json: '', // ruta para volcar el reporte final en JSON
};

const HELP = `
estres — herramienta de pruebas de estrés HTTP(S) para tu infraestructura

USO:
  estres [opciones] <url> [url2 url3 ...]

OPCIONES:
  -c, --connections <n>   Usuarios virtuales concurrentes (def: 50)
  -w, --workers <n>       Hilos worker / núcleos a usar (def: núcleos, máx 8)
  -d, --duration <seg>    Duración en segundos (def: 30; 0 = ilimitado)
  -n, --requests <n>      Nº total de peticiones (0 = sin límite)
  -r, --rate <rps>        Límite global de peticiones/segundo (0 = máx)
      --ramp <seg>        Ramp-up: escalar los VUs durante N segundos
  -m, --method <verbo>    Método HTTP (def: GET)
  -H, --header "K: V"     Cabecera (repetible)
  -b, --body <texto>      Cuerpo de la petición
      --body-file <ruta>  Cuerpo leído de un archivo
  -t, --timeout <ms>      Timeout por petición (def: 10000; 0 = sin límite)
      --no-keepalive      Desactiva keep-alive (nueva conexión por petición)
  -k, --insecure          No verificar certificados TLS (hosts internos)
      --dashboard         Levanta dashboard web en vivo
  -p, --port <n>          Puerto del dashboard (def: 8787)
      --json <ruta>       Guarda el reporte final en JSON
      --config <ruta>     Carga opciones desde un archivo JSON
  -h, --help              Esta ayuda

EJEMPLOS:
  estres -c 100 -d 60 https://api.midominio.com/health
  estres -c 200 -w 4 -r 500 --dashboard https://api.interna/v1/users
  estres -m POST -H "Content-Type: application/json" -b '{"a":1}' http://svc:8080/ingest
  estres --config prueba.json
`;

function parseArgs(argv) {
  const cfg = { ...DEFAULTS, headers: {}, urls: [] };
  const urls = [];
  let i = 0;

  const next = () => argv[++i];

  // Primera pasada: --config se aplica primero como base.
  const cfgIdx = argv.indexOf('--config');
  if (cfgIdx !== -1 && argv[cfgIdx + 1]) {
    const fileCfg = JSON.parse(fs.readFileSync(argv[cfgIdx + 1], 'utf8'));
    Object.assign(cfg, fileCfg);
    if (fileCfg.urls) urls.push(...fileCfg.urls);
  }

  for (i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': return { help: true };
      case '-c': case '--connections': cfg.connections = parseInt(next(), 10); break;
      case '-w': case '--workers': cfg.workers = parseInt(next(), 10); break;
      case '-d': case '--duration': cfg.duration = parseFloat(next()); break;
      case '-n': case '--requests': cfg.maxRequests = parseInt(next(), 10); break;
      case '-r': case '--rate': cfg.rate = parseFloat(next()); break;
      case '--ramp': cfg.rampUp = parseFloat(next()); break;
      case '-m': case '--method': cfg.method = next().toUpperCase(); break;
      case '-H': case '--header': {
        const raw = next();
        const idx = raw.indexOf(':');
        if (idx > 0) cfg.headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
        break;
      }
      case '-b': case '--body': cfg.body = next(); break;
      case '--body-file': cfg.body = fs.readFileSync(next(), 'utf8'); break;
      case '-t': case '--timeout': cfg.timeout = parseInt(next(), 10); break;
      case '--no-keepalive': cfg.keepAlive = false; break;
      case '-k': case '--insecure': cfg.insecure = true; break;
      case '--dashboard': cfg.dashboard = true; break;
      case '-p': case '--port': cfg.port = parseInt(next(), 10); break;
      case '--json': cfg.json = next(); break;
      case '--config': i++; break; // ya procesado arriba
      default:
        if (a.startsWith('-')) throw new Error(`Opción desconocida: ${a}`);
        urls.push(a);
    }
  }

  if (urls.length) cfg.urls = urls;

  // Content-Length automático si hay cuerpo y no se especificó.
  if (cfg.body && !hasHeader(cfg.headers, 'content-length')) {
    cfg.headers['Content-Length'] = Buffer.byteLength(cfg.body);
  }
  if (!hasHeader(cfg.headers, 'user-agent')) {
    cfg.headers['User-Agent'] = 'estres/1.0 (+stress-tester)';
  }

  cfg.totalConnections = cfg.connections;
  validate(cfg);
  return { cfg };
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
}

function validate(cfg) {
  if (!cfg.urls || cfg.urls.length === 0) {
    throw new Error('Debes indicar al menos una URL objetivo.');
  }
  for (const u of cfg.urls) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error();
      }
    } catch {
      throw new Error(`URL inválida: ${u}`);
    }
  }
  if (cfg.connections < 1) throw new Error('connections debe ser >= 1');
  if (cfg.workers < 1) throw new Error('workers debe ser >= 1');
  if (cfg.workers > cfg.connections) cfg.workers = cfg.connections;
  if (cfg.duration === 0 && cfg.maxRequests === 0) {
    // Sin límite: válido, pero se detiene con Ctrl+C.
  }
}

module.exports = { parseArgs, DEFAULTS, HELP };
