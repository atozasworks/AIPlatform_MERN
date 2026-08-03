import os from 'node:os';
import { getRedis, key } from '../../config/redis.js';

/**
 * Inference and system metrics.
 *
 * Counters live in Redis so the API process can report on work the worker
 * process performed. Latency distributions are kept as a capped reservoir of
 * recent samples rather than full histograms — enough for p50/p95 on an
 * operator dashboard without a metrics backend.
 */

const SAMPLE_LIMIT = 500;

const counterKey = (name) => key('metric', 'count', name);
const sampleKey = (name) => key('metric', 'sample', name);

export const METRIC = {
  GENERATIONS_STARTED: 'generations_started',
  GENERATIONS_COMPLETED: 'generations_completed',
  GENERATIONS_FAILED: 'generations_failed',
  GENERATIONS_CANCELLED: 'generations_cancelled',
  GENERATIONS_TIMED_OUT: 'generations_timed_out',
  REQUESTS_RATE_LIMITED: 'requests_rate_limited',
  REQUESTS_QUEUE_FULL: 'requests_queue_full',
  RETRIEVALS: 'retrievals',
};

export async function increment(name, by = 1) {
  await getRedis().incrby(counterKey(name), by).catch(() => {});
}

/** Records a latency/throughput sample into a capped reservoir. */
export async function observe(name, value) {
  if (!Number.isFinite(value)) return;
  await getRedis()
    .multi()
    .rpush(sampleKey(name), String(value))
    .ltrim(sampleKey(name), -SAMPLE_LIMIT, -1)
    .exec()
    .catch(() => {});
}

export const SAMPLE = {
  QUEUE_WAIT_MS: 'queue_wait_ms',
  TIME_TO_FIRST_TOKEN_MS: 'ttft_ms',
  TOKENS_PER_SECOND: 'tokens_per_second',
  TOTAL_COMPLETION_MS: 'total_completion_ms',
  RETRIEVAL_MS: 'retrieval_ms',
};

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[index] * 100) / 100;
}

async function summarize(name) {
  const raw = await getRedis().lrange(sampleKey(name), 0, -1).catch(() => []);
  const values = raw.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return { count: 0, p50: null, p95: null, max: null };
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.round(values[values.length - 1] * 100) / 100,
  };
}

/** Counters plus latency summaries for the admin dashboard. */
export async function getMetricsSnapshot() {
  const redis = getRedis();

  const counterNames = Object.values(METRIC);
  const counterValues = await redis
    .mget(counterNames.map(counterKey))
    .catch(() => counterNames.map(() => null));

  const counters = Object.fromEntries(
    counterNames.map((name, i) => [name, Number(counterValues[i] || 0)]),
  );

  const sampleNames = Object.values(SAMPLE);
  const summaries = await Promise.all(sampleNames.map(summarize));

  return {
    counters,
    latency: Object.fromEntries(sampleNames.map((name, i) => [name, summaries[i]])),
  };
}

/**
 * Host resource usage. Load average is unavailable on Windows (os.loadavg()
 * returns zeros there), so the development box reports null instead of a lie.
 */
export function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg();
  const cpuCount = os.cpus().length || 1;
  const isWindows = process.platform === 'win32';

  const mem = process.memoryUsage();

  return {
    platform: process.platform,
    cpuCount,
    loadAverage: isWindows ? null : { '1m': load[0], '5m': load[1], '15m': load[2] },
    // Load per core is the number that actually indicates saturation.
    loadPerCore: isWindows ? null : Math.round((load[0] / cpuCount) * 100) / 100,
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
    },
    process: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      uptimeSeconds: Math.round(process.uptime()),
    },
  };
}

export default { increment, observe, getMetricsSnapshot, getSystemMetrics, METRIC, SAMPLE };
