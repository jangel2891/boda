'use strict';

/**
 * Histograma log-lineal para latencias (en milisegundos).
 *
 * Usa buckets con crecimiento geométrico (base 1.02 => ~2% de error relativo),
 * lo que permite cubrir desde ~0.05ms hasta ~120s con memoria acotada
 * (unos ~800 buckets) manteniendo percentiles muy precisos.
 *
 * Es "mergeable": los workers acumulan su propio histograma y el proceso
 * principal los suma sin perder precisión.
 */

const BASE = 1.02;
const LOG_BASE = Math.log(BASE);
const MIN_VALUE = 0.05; // ms; valores menores caen en el bucket 0
const MIN_EXP = Math.floor(Math.log(MIN_VALUE) / LOG_BASE);
// Cota superior generosa (~180s) para no desbordar el arreglo.
const MAX_VALUE = 180000;
const NUM_BUCKETS = Math.ceil(Math.log(MAX_VALUE) / LOG_BASE) - MIN_EXP + 1;

function bucketIndex(ms) {
  if (ms <= MIN_VALUE) return 0;
  const idx = Math.floor(Math.log(ms) / LOG_BASE) - MIN_EXP;
  if (idx < 0) return 0;
  if (idx >= NUM_BUCKETS) return NUM_BUCKETS - 1;
  return idx;
}

// Valor representativo (punto medio geométrico) de un bucket.
function bucketValue(idx) {
  return Math.pow(BASE, idx + MIN_EXP + 0.5);
}

class Histogram {
  constructor(counts) {
    this.counts = counts || new Float64Array(NUM_BUCKETS);
    this.total = 0;
    this.sum = 0; // suma de latencias, para la media
    this.min = Infinity;
    this.max = 0;
    if (counts) {
      for (let i = 0; i < counts.length; i++) {
        const c = counts[i];
        if (c > 0) {
          this.total += c;
          this.sum += c * bucketValue(i);
        }
      }
    }
  }

  record(ms) {
    this.counts[bucketIndex(ms)]++;
    this.total++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }

  /** Suma otro histograma dentro de este (in-place). */
  add(other) {
    const a = this.counts;
    const b = other.counts;
    for (let i = 0; i < a.length; i++) a[i] += b[i];
    this.total += other.total;
    this.sum += other.sum;
    if (other.min < this.min) this.min = other.min;
    if (other.max > this.max) this.max = other.max;
  }

  percentile(p) {
    if (this.total === 0) return 0;
    const target = (p / 100) * this.total;
    let cumulative = 0;
    for (let i = 0; i < this.counts.length; i++) {
      cumulative += this.counts[i];
      if (cumulative >= target) return bucketValue(i);
    }
    return bucketValue(this.counts.length - 1);
  }

  get mean() {
    return this.total === 0 ? 0 : this.sum / this.total;
  }

  reset() {
    this.counts.fill(0);
    this.total = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = 0;
  }

  /** Copia serializable/transferible para postMessage. */
  snapshot() {
    return {
      counts: this.counts,
      total: this.total,
      sum: this.sum,
      min: this.min === Infinity ? 0 : this.min,
      max: this.max,
    };
  }
}

/** Reconstruye un histograma a partir de un snapshot recibido por mensaje. */
function fromSnapshot(snap) {
  const h = new Histogram(Float64Array.from(snap.counts));
  h.total = snap.total;
  h.sum = snap.sum;
  h.min = snap.min || Infinity;
  h.max = snap.max || 0;
  return h;
}

module.exports = { Histogram, fromSnapshot, NUM_BUCKETS };
