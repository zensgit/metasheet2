#!/usr/bin/env node
/**
 * Phase 5 Metrics Percentiles Parser
 *
 * Reads Prometheus /metrics/prom endpoint, parses histogram buckets,
 * and calculates P50/P95/P99 percentiles from cumulative distributions.
 *
 * Usage:
 *   npx tsx scripts/phase5-metrics-percentiles.ts <metrics-url> [output-json-path]
 *
 * Example:
 *   npx tsx scripts/phase5-metrics-percentiles.ts http://localhost:8900/metrics/prom
 *   npx tsx scripts/phase5-metrics-percentiles.ts http://localhost:8900/metrics/prom /tmp/percentiles.json
 */

import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';

interface HistogramBucket {
  le: number; // less than or equal to
  count: number; // cumulative count
}

interface Histogram {
  metric: string;
  labels: Record<string, string>;
  buckets: HistogramBucket[];
  sum: number;
  count: number;
}

interface PercentileResult {
  p50: number;
  p95: number;
  p99: number;
  count: number;
  sum: number;
  mean: number;
}

interface MetricsOutput {
  timestamp: string;
  metrics: Record<string, PercentileResult>;
  raw_data: {
    histograms: Histogram[];
  };
}

function parseMetricsAuthHeader(): Record<string, string> | undefined {
  const rawHeader = (process.env.METRICS_AUTH_HEADER || process.env.EXTRA_CURL_HEADER || '').trim();
  if (!rawHeader) return undefined;

  const separatorIndex = rawHeader.indexOf(':');
  const name = rawHeader.slice(0, separatorIndex).trim();
  const value = rawHeader.slice(separatorIndex + 1).trim();

  if (separatorIndex <= 0 || !name || !value) {
    throw new Error('METRICS_AUTH_HEADER must use "Name: value" format');
  }

  return { [name]: value };
}

/**
 * Fetch metrics from Prometheus endpoint
 */
async function fetchMetrics(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const requestOptions = {
      headers: parseMetricsAuthHeader() || {},
    };

    const req = client.get(url, requestOptions, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });

    // Add timeout protection (15 seconds)
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`Request timeout after 15s: ${url}`));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Parse Prometheus text format and extract histograms
 */
function parseHistogramNumber(value: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new Error('INVALID_HISTOGRAM_NUMBER');
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('INVALID_HISTOGRAM_NUMBER');
  return number;
}

function parseHistogramLabels(value: string): Record<string, string> {
  const labels = new Map<string, string>();
  const pattern = /\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\\n]|\\[\\n"])*)"\s*(?:,|$)/y;
  let offset = 0;
  while (offset < value.trimEnd().length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(value);
    if (!match || labels.has(match[1])) throw new Error('INVALID_HISTOGRAM_LABELS');
    labels.set(match[1], match[2].replace(/\\([\\n"])/g, (_, escaped) => escaped === 'n' ? '\n' : escaped));
    offset = pattern.lastIndex;
  }
  return Object.fromEntries([...labels].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function parsePrometheusMetrics(text: string): Histogram[] {
  const lines = text.split('\n');
  const histograms = new Map<string, Histogram>();
  const sums = new Set<string>();
  const counts = new Set<string>();
  const bucketFamilies = new Set(lines.flatMap(line => {
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)_bucket(?:\{|\s)/);
    return match ? [match[1]] : [];
  }));
  // Sum/count samples can precede buckets and may omit an empty label set.
  for (const line of lines) {
    const family = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)_(?:bucket|sum|count)(?:\{|\s)/);
    if (!family || !bucketFamilies.has(family[1])) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)_(bucket|sum|count)(?:\{(.*)\})?[ \t]+(\S+)(?:[ \t]+[+-]?\d+)?[ \t]*$/);
    if (!match) throw new Error('INVALID_HISTOGRAM_SAMPLE');
    const [, metric, kind, rawLabels = '', rawValue] = match;
    const labels = parseHistogramLabels(rawLabels);
    const value = parseHistogramNumber(rawValue);
    let le = 0;
    if (kind === 'bucket') {
      if (!Object.hasOwn(labels, 'le')) throw new Error('INVALID_HISTOGRAM_BOUND');
      le = labels.le === '+Inf' ? Infinity : parseHistogramNumber(labels.le);
      delete labels.le;
    }
    if (kind !== 'sum' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('INVALID_HISTOGRAM_COUNT');
    const key = `${metric}:${JSON.stringify(labels)}`;
    const histogram = histograms.get(key) ?? { metric, labels, buckets: [], sum: 0, count: 0 };
    histograms.set(key, histogram);
    if (kind === 'bucket') {
      if (histogram.buckets.some(bucket => bucket.le === le)) throw new Error('DUPLICATE_HISTOGRAM_SAMPLE');
      histogram.buckets.push({ le, count: value });
    } else {
      const seen = kind === 'sum' ? sums : counts;
      if (seen.has(key)) throw new Error('DUPLICATE_HISTOGRAM_SAMPLE');
      seen.add(key);
      histogram[kind === 'sum' ? 'sum' : 'count'] = value;
    }
  }
  const result: Histogram[] = [];
  for (const [key, histogram] of histograms) {
    if (!histogram.buckets.length) continue;
    if (!sums.has(key) || !counts.has(key)) throw new Error('INCOMPLETE_HISTOGRAM');
    if (!histogram.buckets.some(bucket => bucket.le === Infinity)) throw new Error('INCOMPLETE_HISTOGRAM');
    if (!histogram.buckets.some(bucket => Number.isFinite(bucket.le))) throw new Error('INVALID_HISTOGRAM_BOUND');
    histogram.buckets.sort((a, b) => a.le - b.le);
    for (let i = 0; i < histogram.buckets.length; i++) {
      const bucket = histogram.buckets[i];
      if (bucket.count > histogram.count || (i > 0 && bucket.count < histogram.buckets[i - 1].count)
        || (bucket.le === Infinity && bucket.count !== histogram.count)) throw new Error('INVALID_HISTOGRAM_COUNT');
    }
    result.push(histogram);
  }
  return result;
}

/**
 * Calculate percentile from histogram buckets
 */
function calculatePercentile(buckets: HistogramBucket[], totalCount: number, percentile: number): number {
  if (totalCount === 0) return 0;

  const targetCount = totalCount * percentile;

  // Find the bucket containing the percentile
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].count >= targetCount) {
      if (buckets[i].le === Infinity) return i > 0 ? buckets[i - 1].le : 0;
      // Linear interpolation within bucket
      if (i === 0) {
        // First bucket: assume uniform distribution from 0 to le
        const ratio = targetCount / buckets[i].count;
        return buckets[i].le * ratio;
      } else {
        // Interpolate between previous bucket and current bucket
        const prevCount = buckets[i - 1].count;
        const currCount = buckets[i].count;
        const prevLe = buckets[i - 1].le;
        const currLe = buckets[i].le;

        if (currCount === prevCount) {
          // No samples in this bucket
          return prevLe;
        }

        const ratio = (targetCount - prevCount) / (currCount - prevCount);
        return prevLe + (currLe - prevLe) * ratio;
      }
    }
  }

  // If we reach here, percentile is in the +Inf bucket
  // Return the last finite bucket value
  const lastFiniteBucket = buckets.filter(b => isFinite(b.le)).pop();
  return lastFiniteBucket ? lastFiniteBucket.le : 0;
}

/**
 * Calculate P50/P95/P99 from histogram
 */
function calculatePercentiles(histogram: Histogram): PercentileResult {
  const count = histogram.count;
  const sum = histogram.sum;
  const mean = count > 0 ? sum / count : 0;

  const p50 = calculatePercentile(histogram.buckets, count, 0.50);
  const p95 = calculatePercentile(histogram.buckets, count, 0.95);
  const p99 = calculatePercentile(histogram.buckets, count, 0.99);

  return { p50, p95, p99, count, sum, mean };
}

/**
 * Filter histograms by metric names
 */
function filterHistograms(histograms: Histogram[], targetMetrics: string[]): Histogram[] {
  // Some exporters or wrappers may tweak metric naming; be tolerant by prefix match.
  const targets = new Set(targetMetrics);
  return histograms.filter(h => targets.has(h.metric) || targetMetrics.some(t => h.metric.startsWith(t)));
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: npx tsx phase5-metrics-percentiles.ts <metrics-url> [output-json-path]');
    console.error('Example: npx tsx phase5-metrics-percentiles.ts http://localhost:8900/metrics/prom');
    process.exit(1);
  }

  const metricsUrl = args[0];
  const outputPath = args[1];

  try {
    console.error(`[INFO] Fetching metrics from ${metricsUrl}...`);
    const metricsText = await fetchMetrics(metricsUrl);

    console.error(`[INFO] Parsing Prometheus metrics...`);
    const allHistograms = parsePrometheusMetrics(metricsText);
    console.error(`[INFO] Found ${allHistograms.length} histogram metrics`);

    // Load target metrics dynamically from thresholds.json
    const thresholdsPath = process.env.THRESHOLDS_FILE || process.env.THRESHOLDS_PATH ||
      path.join(process.cwd(), 'scripts', 'phase5-thresholds.json');

    console.error(`[INFO] Loading thresholds from ${thresholdsPath}...`);
    const thresholdsContent = fs.readFileSync(thresholdsPath, 'utf-8');
    const thresholdsData = JSON.parse(thresholdsContent);

    // Extract unique prometheus_metric values from latency thresholds
    const targetMetrics = Array.from(new Set<string>(
      thresholdsData.thresholds
        .filter((t: any) => t.kind === 'latency')
        .map((t: any) => t.prometheus_metric)
    ));

    console.error(`[INFO] Dynamically loaded ${targetMetrics.length} target metrics: ${targetMetrics.join(', ')}`);

    const relevantHistograms = filterHistograms(allHistograms, targetMetrics);
    console.error(`[INFO] Filtered to ${relevantHistograms.length} relevant histograms`);

    const metrics: Record<string, PercentileResult> = {};

    for (const histogram of relevantHistograms) {
      // Create key with labels for labeled metrics (e.g., metric{operation="restore"})
      const labelStr = Object.keys(histogram.labels).length > 0
        ? `{${Object.entries(histogram.labels).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`
        : '';
      const key = `${histogram.metric}${labelStr}`;
      const result = calculatePercentiles(histogram);

      console.error(`[INFO] ${key}:`);
      console.error(`       P50=${result.p50.toFixed(3)}s, P95=${result.p95.toFixed(3)}s, P99=${result.p99.toFixed(3)}s`);
      console.error(`       count=${result.count}, mean=${result.mean.toFixed(3)}s`);

      metrics[key] = result;
    }

    const output: MetricsOutput = {
      timestamp: new Date().toISOString(),
      metrics,
      raw_data: {
        histograms: relevantHistograms
      }
    };

    const jsonOutput = JSON.stringify(output, null, 2);

    if (outputPath) {
      fs.writeFileSync(outputPath, jsonOutput);
      console.error(`[SUCCESS] Percentiles written to ${outputPath}`);
    } else {
      // Output to stdout for piping
      console.log(jsonOutput);
    }

    process.exit(0);
  } catch (error) {
    console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run main function (this is a CLI script)
main();

export {
  fetchMetrics,
  parsePrometheusMetrics,
  calculatePercentile,
  calculatePercentiles,
  parseMetricsAuthHeader,
  filterHistograms,
  type Histogram,
  type PercentileResult,
  type MetricsOutput
};
