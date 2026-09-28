/**
 * @fileoverview Latency Profiling Hooks and Telemetry for Privacy Lens Agent.
 * Measures high-resolution performance timings (performance.now()) across all
 * phases of perception, redaction, and transport.
 * 
 * Enforces and verifies the strict <150ms per frame latency budget target.
 */

export const LATENCY_BUDGET_MS = 150;

export const PROFILING_PHASES = [
  'capture_ms',
  'dom_extract_ms',
  'dom_detect_ms',
  'face_detect_ms',
  'ocr_detect_ms',
  'region_merge_ms',
  'image_redact_ms',
  'dom_redact_ms',
  'transport_ms',
  'total_client_ms'
];

/**
 * Computes statistical summaries (mean, min, max, p50, p95) for an array of numbers.
 * @param {number[]} values
 * @returns {{ count: number, mean: number, min: number, max: number, p50: number, p95: number }}
 */
export function computeStats(values) {
  const filtered = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (filtered.length === 0) {
    return { count: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0 };
  }

  filtered.sort((a, b) => a - b);
  const count = filtered.length;
  const sum = filtered.reduce((acc, v) => acc + v, 0);
  const mean = Number((sum / count).toFixed(3));
  const min = Number(filtered[0].toFixed(3));
  const max = Number(filtered[count - 1].toFixed(3));
  const p50 = Number(filtered[Math.floor(count * 0.5)].toFixed(3));
  const p95 = Number(filtered[Math.min(count - 1, Math.floor(count * 0.95))].toFixed(3));

  return { count, mean, min, max, p50, p95 };
}

/**
 * LatencyProfiler manages profiling records, aggregations, and budget assertions.
 */
export class LatencyProfiler {
  /**
   * @param {object} [options={}]
   * @param {number} [options.budgetMs=150]
   * @param {number} [options.maxRecords=500]
   * @param {boolean} [options.enabled=true]
   */
  constructor(options = {}) {
    this.budgetMs = options.budgetMs ?? LATENCY_BUDGET_MS;
    this.maxRecords = options.maxRecords ?? 500;
    this.enabled = options.enabled !== false;
    this.records = [];
  }

  /**
   * Starts a high-resolution timer.
   * @returns {number} Start timestamp from performance.now()
   */
  startTimer() {
    return performance.now();
  }

  /**
   * Calculates elapsed milliseconds from a given start timestamp.
   * @param {number} startTime
   * @returns {number}
   */
  elapsed(startTime) {
    const diff = performance.now() - startTime;
    return Number(diff.toFixed(3));
  }

  /**
   * Records a timing snapshot entry.
   * @param {object} timings
   * @returns {object} Stored record
   */
  record(timings = {}) {
    if (!this.enabled) return timings;

    const entry = {
      timestamp: Date.now(),
      capture_ms: Number((timings.capture_ms ?? 0).toFixed(3)),
      dom_extract_ms: Number((timings.dom_extract_ms ?? 0).toFixed(3)),
      dom_detect_ms: Number((timings.dom_detect_ms ?? 0).toFixed(3)),
      face_detect_ms: Number((timings.face_detect_ms ?? 0).toFixed(3)),
      ocr_detect_ms: Number((timings.ocr_detect_ms ?? 0).toFixed(3)),
      region_merge_ms: Number((timings.region_merge_ms ?? 0).toFixed(3)),
      image_redact_ms: Number((timings.image_redact_ms ?? 0).toFixed(3)),
      dom_redact_ms: Number((timings.dom_redact_ms ?? 0).toFixed(3)),
      transport_ms: Number((timings.transport_ms ?? 0).toFixed(3)),
      total_client_ms: Number((timings.total_client_ms ?? 0).toFixed(3)),
      ...timings
    };

    this.records.push(entry);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
    return entry;
  }

  /**
   * Returns all stored profiling records.
   * @returns {Array<object>}
   */
  getRecords() {
    return [...this.records];
  }

  /**
   * Clears all stored records.
   */
  clear() {
    this.records = [];
  }

  /**
   * Generates aggregated summary statistics across all recorded runs.
   * @returns {object} Summary report
   */
  getSummary() {
    if (this.records.length === 0) {
      return {
        count: 0,
        budgetMs: this.budgetMs,
        phases: {},
        total_client_ms: null,
        budgetCompliant: true
      };
    }

    const phasesStats = {};
    for (const phase of PROFILING_PHASES) {
      const vals = this.records.map((r) => r[phase]).filter((v) => typeof v === 'number');
      phasesStats[phase] = computeStats(vals);
    }

    const totalStats = phasesStats.total_client_ms;
    const isCompliant = Boolean(
      totalStats &&
      totalStats.p95 <= this.budgetMs &&
      totalStats.mean <= this.budgetMs
    );

    return {
      count: this.records.length,
      budgetMs: this.budgetMs,
      phases: phasesStats,
      total_client_ms: totalStats,
      budgetCompliant: isCompliant
    };
  }

  /**
   * Returns a formatted text table of metrics.
   * @returns {string}
   */
  formatSummary() {
    const summary = this.getSummary();
    if (summary.count === 0) {
      return '[LatencyProfiler] No profiling records available.';
    }

    const colPhase = 'Phase'.padEnd(18);
    const colMean = 'Mean (ms)'.padStart(10);
    const colMin = 'Min (ms)'.padStart(10);
    const colMax = 'Max (ms)'.padStart(10);
    const colP50 = 'P50 (ms)'.padStart(10);
    const colP95 = 'P95 (ms)'.padStart(10);

    const header = `${colPhase} | ${colMean} | ${colMin} | ${colMax} | ${colP50} | ${colP95}`;
    const separator = '-'.repeat(header.length);

    const lines = [
      `=== Privacy Lens Latency Telemetry (${summary.count} frames profiled, Budget: <${summary.budgetMs}ms) ===`,
      header,
      separator
    ];

    for (const phase of PROFILING_PHASES) {
      const s = summary.phases[phase];
      if (!s) continue;
      const p = phase.padEnd(18);
      const mean = s.mean.toFixed(2).padStart(10);
      const min = s.min.toFixed(2).padStart(10);
      const max = s.max.toFixed(2).padStart(10);
      const p50 = s.p50.toFixed(2).padStart(10);
      const p95 = s.p95.toFixed(2).padStart(10);
      lines.push(`${p} | ${mean} | ${min} | ${max} | ${p50} | ${p95}`);
    }

    lines.push(separator);
    const status = summary.budgetCompliant
      ? `PASS (P95: ${summary.total_client_ms?.p95}ms < ${summary.budgetMs}ms)`
      : `FAIL (P95: ${summary.total_client_ms?.p95}ms >= ${summary.budgetMs}ms)`;
    lines.push(`Budget Verification: ${status}`);

    return lines.join('\n');
  }

  /**
   * Logs formatted summary table to console.
   * @returns {object} Summary report
   */
  logSummary() {
    const summary = this.getSummary();
    console.log(this.formatSummary());
    return summary;
  }
}

// Global default profiler instance
export const defaultProfiler = new LatencyProfiler();

if (typeof globalThis !== 'undefined') {
  globalThis.__privacyLensProfiler = defaultProfiler;
}
