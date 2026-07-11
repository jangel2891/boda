# estres — pruebas de estrés HTTP(S) para tu infraestructura

Herramienta de carga (load/stress testing) para tus propios servicios HTTP/HTTPS.
Genera peticiones concurrentes desde varios núcleos, mide latencia (percentiles),
throughput y errores, y ofrece un **dashboard web en vivo**.

- **Sin dependencias externas** — solo Node.js nativo (`http`, `worker_threads`). No hace falta `npm install`.
- **Multinúcleo** — usa `worker_threads` para repartir la carga y exprimir la CPU.
- **CLI + dashboard** — panel en terminal en vivo y una UI web con gráficas (SSE).
- **Percentiles precisos** — histograma log-lineal (~2% de error) con memoria acotada.
- **Reporte JSON** — para guardar resultados o integrarlos en CI/CD.

> ⚠️ **Uso responsable:** esta herramienta es para probar **infraestructura propia o
> con autorización explícita**. Generar carga contra sistemas de terceros sin permiso
> puede ser ilegal y equivale a un ataque de denegación de servicio.

## Requisitos

- Node.js >= 18 (probado en Node 22).

## Uso rápido

```bash
cd stress-tester

# Ayuda
node bin/estres.js --help

# Prueba básica: 100 conexiones durante 60s
node bin/estres.js -c 100 -d 60 https://api.midominio.com/health

# Con dashboard web en vivo (abre http://localhost:8787)
node bin/estres.js -c 200 -w 4 -d 120 --dashboard https://api.interna/v1/users

# Límite de 500 req/s, con ramp-up de 10s
node bin/estres.js -c 300 -r 500 --ramp 10 -d 60 https://svc.interno/

# POST con cuerpo JSON
node bin/estres.js -m POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer XXX" \
  -b '{"evento":"ping"}' \
  http://svc:8080/ingest

# Host interno con certificado self-signed
node bin/estres.js -k -c 50 -d 30 https://10.0.0.5/health

# Guardar reporte para CI
node bin/estres.js -c 100 -n 50000 --json reporte.json https://api/
```

También puedes instalarlo como comando global:

```bash
cd stress-tester && npm link   # habilita el comando `estres`
estres -c 100 -d 30 https://api/
```

## Probar en local antes de apuntar a tu infra

Incluye un servidor objetivo de ejemplo con endpoints de distintas características:

```bash
# Terminal 1
node examples/target-server.js 3000
#   /       respuesta rápida
#   /slow   latencia 50-250ms
#   /flaky  ~10% de errores 500
#   /echo   (POST) devuelve el cuerpo

# Terminal 2
node bin/estres.js -c 50 -d 20 --dashboard http://localhost:3000/slow
```

## Opciones

| Opción | Descripción | Def. |
|---|---|---|
| `-c, --connections <n>` | Usuarios virtuales concurrentes | 50 |
| `-w, --workers <n>` | Hilos worker (núcleos) | núcleos (máx 8) |
| `-d, --duration <seg>` | Duración; `0` = ilimitado (Ctrl+C) | 30 |
| `-n, --requests <n>` | Nº total de peticiones (`0` = sin límite) | 0 |
| `-r, --rate <rps>` | Límite global de peticiones/segundo | 0 (máx) |
| `--ramp <seg>` | Ramp-up: escalar los VUs durante N segundos | 0 |
| `-m, --method <verbo>` | Método HTTP | GET |
| `-H, --header "K: V"` | Cabecera (repetible) | — |
| `-b, --body <texto>` | Cuerpo de la petición | — |
| `--body-file <ruta>` | Cuerpo leído de archivo | — |
| `-t, --timeout <ms>` | Timeout por petición (`0` = sin límite) | 10000 |
| `--no-keepalive` | Nueva conexión por petición | keep-alive |
| `-k, --insecure` | No verificar certificados TLS | verifica |
| `--dashboard` | Levanta el dashboard web | off |
| `-p, --port <n>` | Puerto del dashboard | 8787 |
| `--json <ruta>` | Guarda el reporte final en JSON | — |
| `--config <ruta>` | Carga opciones desde un JSON | — |

### Archivo de configuración

Puedes definir todo en un JSON y reutilizarlo:

```json
{
  "urls": ["https://api.interna/v1/users", "https://api.interna/v1/orders"],
  "method": "GET",
  "connections": 200,
  "workers": 4,
  "duration": 120,
  "rate": 0,
  "headers": { "Authorization": "Bearer XXX" },
  "dashboard": true,
  "port": 8787
}
```

```bash
node bin/estres.js --config prueba.json
```

Cuando se indican **varias URLs**, los usuarios virtuales las recorren en
round-robin (útil para repartir carga entre varios endpoints).

## Métricas

- **RPS** (peticiones por segundo), instantáneo y promedio.
- **Latencia**: min, media, p50, p90, p95, p99, p99.9, máx.
- **Errores de red** (conexión rechazada, timeouts, DNS…) desglosados por tipo.
- **Códigos de estado** HTTP (200, 404, 500…).
- **Bytes transferidos** y throughput de red.

El reporte JSON (`--json`) contiene todo lo anterior en formato estructurado.

## Cómo funciona

```
bin/estres.js        → CLI: parseo y arranque
src/config.js        → opciones (CLI + archivo)
src/runner.js        → orquesta workers, agrega métricas, panel en terminal
src/worker.js        → genera la carga (VUs) en cada hilo/núcleo
src/histogram.js     → histograma log-lineal para percentiles
src/server.js        → dashboard HTTP + stream SSE
public/index.html    → UI del dashboard (canvas nativo, sin CDN)
examples/            → servidor objetivo de práctica
test/                → test de humo (unit + end-to-end)
```

El proceso principal reparte las conexiones entre `workers` hilos. Cada worker
corre sus usuarios virtuales en un bucle cerrado (request → respuesta → repetir)
y reporta deltas al principal cada 250ms, que los agrega y los publica en el
panel de terminal y en el dashboard.

## Tests

```bash
node test/smoke.test.js
```

Arranca un servidor real, lanza una prueba corta y verifica que el conteo de
peticiones del cliente coincide con el del servidor (±2%) y que los percentiles
del histograma son correctos.

## Consejos para pruebas de estrés reales

- Empieza suave (`-c 10`) y sube gradualmente; usa `--ramp` para no saturar de golpe.
- Corre `estres` desde una máquina distinta a la que pruebas (si no, compites por CPU/red).
- Vigila el lado del servidor (CPU, memoria, conexiones, colas) en paralelo.
- Si ves muchos `EADDRNOTAVAIL`/`ECONNRESET`, es señal de agotamiento de puertos o
  límites del SO; ajusta `ulimit -n` y considera `--no-keepalive` con cuidado.
- Para máxima carga, sube `-w` hasta el nº de núcleos de la máquina generadora.
