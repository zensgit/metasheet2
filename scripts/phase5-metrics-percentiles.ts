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

/**
 * Fetch metrics from Prometheus endpoint
 */
async function fetchMetrics(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, (res) => {
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
function parsePrometheusMetrics(text: string): Histogram[] {
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

      const le = labels.le ? parseFloat(labels.le) : Infinity;
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
function calculatePercentile(buckets: HistogramBucket[], totalCount: number, percentile: number): number {
  if (totalCount === 0) return 0;

  const targetCount = totalCount * percentile;

  // Find the bucket containing the percentile
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].count >= targetCount) {
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
  return histograms.filter(h => targetMetrics.includes(h.metric));
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

    // Target metrics from thresholds.json
    const targetMetrics = [
      'metasheet_plugin_reload_duration_seconds',
      'metasheet_snapshot_restore_duration_seconds',
      'metasheet_snapshot_create_duration_seconds'
    ];

    const relevantHistograms = filterHistograms(allHistograms, targetMetrics);
    console.error(`[INFO] Filtered to ${relevantHistograms.length} relevant histograms`);

    const metrics: Record<string, PercentileResult> = {};

    for (const histogram of relevantHistograms) {
      const key = histogram.metric;
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
  filterHistograms,
  type Histogram,
  type PercentileResult,
  type MetricsOutput
};
