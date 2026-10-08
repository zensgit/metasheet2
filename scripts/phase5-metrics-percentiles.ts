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
import { createHash } from 'node:crypto';

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
  p50: number | null;
  p95: number | null;
  p99: number | null;
  count: number;
  sum: number;
  mean: number;
}

interface MetricsOutput {
  timestamp: string;
  metrics: Record<string, PercentileResult>;
  sampling: {
    source: 'SECOND_PERCENTILE_SCRAPE';
    input_sha256: string;
    parsed_histograms: number;
    relevant_histograms: number;
    thresholds: Array<{
      metric: string;
      raw_bucket_lines: number;
      parsed_family_histograms: number;
      selected_count: number | null;
      reason: 'family_absent' | 'family_unparsed' | 'selector_missing' |
        'count_unparsed' | 'count_invalid' | 'zero_samples' | 'positive_samples' | 'percentile_unestimable';
    }>;
  };
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
function parsePrometheusMetrics(text: string, countWitnesses?: Map<Histogram, boolean>): Histogram[] {
  const lines = text.split('\n');
  const histograms: Map<string, Histogram> = new Map();

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line.trim() === '') {
      continue;
    }

    // Parse histogram bucket lines (e.g., metric_name_bucket{le="0.5"} 10)
    const bucketMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*_bucket)\{(.+)\}\s+(\d+(?:\.\d+)?)/);
    if (bucketMatch) {
      const metricName = bucketMatch[1].replace('_bucket', '');
      const labelsStr = bucketMatch[2];
      const count = parseFloat(bucketMatch[3]);

      // Parse labels
      const labels: Record<string, string> = {};
      const labelMatches = labelsStr.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="([^"]+)"/g);
      for (const match of labelMatches) {
        labels[match[1]] = match[2];
      }

      const le = labels.le === '+Inf' ? Infinity : labels.le ? parseFloat(labels.le) : Infinity;
      delete labels.le; // Remove 'le' from labels as it's stored separately

      const key = `${metricName}:${JSON.stringify(labels)}`;

      if (!histograms.has(key)) {
        histograms.set(key, {
          metric: metricName,
          labels,
          buckets: [],
          sum: 0,
          count: 0
        });
      }

      histograms.get(key)!.buckets.push({ le, count });
    }

    // Parse sum lines (e.g., metric_name_sum{} 123.45)
    const sumMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*_sum)\{(.+)?\}\s+(\d+(?:\.\d+)?)/);
    if (sumMatch) {
      const metricName = sumMatch[1].replace('_sum', '');
      const labelsStr = sumMatch[2] || '';
      const sum = parseFloat(sumMatch[3]);

      const labels: Record<string, string> = {};
      if (labelsStr) {
        const labelMatches = labelsStr.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="([^"]+)"/g);
        for (const match of labelMatches) {
          labels[match[1]] = match[2];
        }
      }

      const key = `${metricName}:${JSON.stringify(labels)}`;

      if (histograms.has(key)) {
        histograms.get(key)!.sum = sum;
      }
    }

    // Parse count lines (e.g., metric_name_count{} 100)
    const countMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*_count)\{(.+)?\}\s+(\d+(?:\.\d+)?)/);
    if (countMatch) {
      const metricName = countMatch[1].replace('_count', '');
      const labelsStr = countMatch[2] || '';
      const count = parseFloat(countMatch[3]);

      const labels: Record<string, string> = {};
      if (labelsStr) {
        const labelMatches = labelsStr.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="([^"]+)"/g);
        for (const match of labelMatches) {
          labels[match[1]] = match[2];
        }
      }

      const key = `${metricName}:${JSON.stringify(labels)}`;

      if (histograms.has(key)) {
        histograms.get(key)!.count = count;
        const token = line.slice(countMatch[0].length - countMatch[3].length).trim().split(/\s+/)[0];
        const completeCount = Number(token);
        countWitnesses?.set(histograms.get(key)!,
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token) &&
          Number.isFinite(completeCount) && completeCount >= 0 && completeCount === count,
        );
      }
    }
  }

  // Sort buckets by 'le' value
  for (const histogram of histograms.values()) {
    histogram.buckets.sort((a, b) => a.le - b.le);
  }

  return Array.from(histograms.values());
}

/**
 * Calculate percentile from histogram buckets
 */
function calculatePercentile(buckets: HistogramBucket[], totalCount: number, percentile: number): number | null {
  if (totalCount === 0) return 0;
  if (!Number.isFinite(totalCount)) return null;

  const targetCount = totalCount * percentile;

  // Find the bucket containing the percentile
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].count >= targetCount) {
      // An unbounded or invalid range cannot yield a finite percentile.
      if (!Number.isFinite(buckets[i].le)) return null;

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
        if (!Number.isFinite(prevLe)) return null;

        if (currCount === prevCount) {
          // No samples in this bucket
          return prevLe;
        }

        const ratio = (targetCount - prevCount) / (currCount - prevCount);
        return prevLe + (currLe - prevLe) * ratio;
      }
    }
  }

  // The buckets do not cover the requested rank.
  return null;
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
    const countWitnesses = new Map<Histogram, boolean>();
    const allHistograms = parsePrometheusMetrics(metricsText, countWitnesses);
    console.error(`[INFO] Found ${allHistograms.length} histogram metrics`);

    // Load target metrics dynamically from thresholds.json
    const thresholdsPath = process.env.THRESHOLDS_FILE || process.env.THRESHOLDS_PATH ||
      path.join(process.cwd(), 'scripts', 'phase5-thresholds.json');

    console.error(`[INFO] Loading thresholds from ${thresholdsPath}...`);
    const thresholdsContent = fs.readFileSync(thresholdsPath, 'utf-8');
    const thresholdsData: { thresholds: Array<{
      metric: string;
      kind: string;
      prometheus_metric: string;
      label_selector?: Record<string, string>;
    }> } = JSON.parse(thresholdsContent);

    // Extract unique prometheus_metric values from latency thresholds
    const latencyThresholds = thresholdsData.thresholds.filter(t => t.kind === 'latency');
    const targetMetrics = Array.from(new Set<string>(
      latencyThresholds.map(t => t.prometheus_metric)
    ));

    console.error(`[INFO] Dynamically loaded ${targetMetrics.length} target metrics: ${targetMetrics.join(', ')}`);

    const relevantHistograms = filterHistograms(allHistograms, targetMetrics);
    console.error(`[INFO] Filtered to ${relevantHistograms.length} relevant histograms`);

    const metrics: Record<string, PercentileResult> = {};
    const histogramsByKey = new Map<string, Histogram>();

    for (const histogram of relevantHistograms) {
      // Create key with labels for labeled metrics (e.g., metric{operation="restore"})
      const labelStr = Object.keys(histogram.labels).length > 0
        ? `{${Object.entries(histogram.labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
        : '';
      const key = `${histogram.metric}${labelStr}`;
      const result = calculatePercentiles(histogram);

      console.error(`[INFO] ${key}:`);
      console.error(`       P50=${result.p50?.toFixed(3) ?? 'null'}s, P95=${result.p95?.toFixed(3) ?? 'null'}s, P99=${result.p99?.toFixed(3) ?? 'null'}s`);
      console.error(`       count=${result.count}, mean=${result.mean.toFixed(3)}s`);

      metrics[key] = result;
      histogramsByKey.set(key, histogram);
    }

    const rawLines = metricsText.split('\n');
    const sampling: MetricsOutput['sampling'] = {
      source: 'SECOND_PERCENTILE_SCRAPE',
      input_sha256: createHash('sha256').update(metricsText).digest('hex'),
      parsed_histograms: allHistograms.length,
      relevant_histograms: relevantHistograms.length,
      thresholds: latencyThresholds.map(threshold => {
        const family = threshold.prometheus_metric;
        const rawBucketLines = rawLines.filter(line =>
          line.startsWith(`${family}_bucket{`) || line.startsWith(`${family}_bucket `),
        ).length;
        const parsedFamilyHistograms = allHistograms.filter(h => h.metric === family).length;
        // Keep the validator's exact key, including label order and every label.
        const selector = threshold.label_selector;
        const key = selector
          ? `${family}{${Object.entries(selector).map(([k, v]) => `${k}="${v}"`).join(',')}}`
          : family;
        const selected = histogramsByKey.get(key);
        const percentile = threshold.metric.match(/p[0-9]+/g)?.pop() as 'p50' | 'p95' | 'p99';
        const reason = rawBucketLines === 0 ? 'family_absent'
          : parsedFamilyHistograms === 0 ? 'family_unparsed'
          : !selected ? 'selector_missing'
          : !countWitnesses.has(selected) ? 'count_unparsed'
          : !countWitnesses.get(selected) ? 'count_invalid'
          : selected.count === 0 ? 'zero_samples'
          : !Number.isFinite(metrics[key][percentile]) ? 'percentile_unestimable'
          : 'positive_samples';
        return {
          metric: threshold.metric,
          raw_bucket_lines: rawBucketLines,
          parsed_family_histograms: parsedFamilyHistograms,
          selected_count: selected && countWitnesses.get(selected)
            ? selected.count : null,
          reason,
        };
      }),
    };

    const output: MetricsOutput = {
      timestamp: new Date().toISOString(),
      metrics,
      sampling,
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
