import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function execFileResult(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/metrics/prom`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function runPhase5Validation(metricsText) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phase5-required-samples-'));
  const outputPath = path.join(dir, 'phase5.json');
  const server = createServer((req, res) => {
    if (req.url !== '/metrics/prom') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(metricsText);
  });

  try {
    const metricsUrl = await listen(server);
    const result = await execFileResult(
      'bash',
      ['scripts/phase5-full-validate.sh', metricsUrl, outputPath],
      {
        cwd: repoRoot,
        env: { ...process.env, METRICS_AUTH_HEADER: '', EXTRA_CURL_HEADER: '', npm_config_offline: 'true' },
        maxBuffer: 1024 * 1024 * 10,
        timeout: 60_000,
      },
    );
    const json = JSON.parse(await readFile(outputPath, 'utf8'));
    return { ...result, json };
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
}

const passingCounters = `
rbac_perm_cache_hits_total 10
rbac_perm_cache_miss_total 1
http_requests_total{method="GET",status="200"} 100
process_resident_memory_bytes 104857600
`;

const passingLatencySamples = `
metasheet_plugin_reload_duration_seconds_bucket{plugin_name="example-plugin",le="1"} 10
metasheet_plugin_reload_duration_seconds_sum{plugin_name="example-plugin"} 5
metasheet_plugin_reload_duration_seconds_count{plugin_name="example-plugin"} 10

metasheet_snapshot_operation_duration_seconds_bucket{operation="restore",le="1"} 10
metasheet_snapshot_operation_duration_seconds_sum{operation="restore"} 5
metasheet_snapshot_operation_duration_seconds_count{operation="restore"} 10

metasheet_snapshot_operation_duration_seconds_bucket{operation="create",le="1"} 10
metasheet_snapshot_operation_duration_seconds_sum{operation="create"} 5
metasheet_snapshot_operation_duration_seconds_count{operation="create"} 10
`;

test('marks overall status fail when required latency samples are missing', async () => {
  const result = await runPhase5Validation(passingCounters);

  assert.equal(result.code, 1);
  assert.equal(result.json.summary.overall_status, 'fail');
  assert.equal(result.json.summary.failed, 0);
  assert.equal(result.json.summary.na, 6);
  assert.equal(result.json.summary.passed, 5);
  assert.equal(result.json.assertions.filter((assertion) => assertion.status === 'na').length, 6);
});

test('keeps overall status pass when required latency samples satisfy thresholds', async () => {
  const result = await runPhase5Validation(`${passingCounters}\n${passingLatencySamples}`);

  assert.equal(result.code, 0);
  assert.equal(result.json.summary.overall_status, 'pass');
  assert.equal(result.json.summary.failed, 0);
  assert.equal(result.json.summary.na, 0);
  assert.equal(result.json.summary.passed, 11);
});

function pluginHistogram(buckets, count = 10) {
  return `${passingCounters}\n${passingLatencySamples.replace(
    /metasheet_plugin_reload_duration_seconds_(bucket|sum|count)[^\n]*\n/g,
    '',
  )}\n${buckets.map(([le, samples]) =>
    `metasheet_plugin_reload_duration_seconds_bucket{plugin_name="example-plugin",le="${le}"} ${samples}`,
  ).join('\n')}
metasheet_plugin_reload_duration_seconds_sum{plugin_name="example-plugin"} 100
metasheet_plugin_reload_duration_seconds_count{plugin_name="example-plugin"} ${count}
`;
}

function assertPluginReport(result, { code, status, actual, count, passed, failed, na }) {
  assert.equal(result.code, code, JSON.stringify({ exit: result.code, summary: result.json.summary, percentiles: result.json.percentiles, assertions: result.json.assertions }));
  assert.deepEqual(result.json.summary, {
    total_checks: 11,
    passed,
    failed,
    na,
    overall_status: status === 'pass' ? 'pass' : 'fail',
  });
  assert.equal(result.json.assertions.length, 11);
  assert.equal(result.json.percentiles['metasheet_plugin_reload_duration_seconds{plugin_name="example-plugin"}'].count, count);
  for (const [percentile, threshold] of [['p95', 2], ['p99', 5]]) {
    const value = typeof actual === 'object' && actual !== null ? actual[percentile] : actual;
    assert.deepEqual(result.json.assertions.find((entry) => entry.metric === `plugin_reload_latency_${percentile}`), {
      metric: `plugin_reload_latency_${percentile}`,
      actual: value,
      threshold,
      unit: 'seconds',
      type: 'upper_bound',
      comparison: status === 'na' ? 'N/A' : '≤',
      status,
    });
    assert.equal(result.json.percentiles['metasheet_plugin_reload_duration_seconds{plugin_name="example-plugin"}'][percentile], value);
  }
  assert.doesNotMatch(result.stderr, /syntax error|illegal character/);
}

test('fails positive-count percentiles in the +Inf bucket instead of treating null as zero', async () => {
  const result = await runPhase5Validation(pluginHistogram([['10', 0], ['+Inf', 10]]));
  assertPluginReport(result, { code: 1, status: 'fail', actual: null, count: 10, passed: 9, failed: 2, na: 0 });
});

test('fails positive-count percentiles when the only bucket is +Inf', async () => {
  const result = await runPhase5Validation(pluginHistogram([['+Inf', 10]]));
  assertPluginReport(result, { code: 1, status: 'fail', actual: null, count: 10, passed: 9, failed: 2, na: 0 });
});

test('fails positive-count percentiles when buckets do not cover the requested rank', async () => {
  const result = await runPhase5Validation(pluginHistogram([['1', 1]]));
  assertPluginReport(result, { code: 1, status: 'fail', actual: null, count: 10, passed: 9, failed: 2, na: 0 });
});

test('keeps finite interpolation with a +Inf terminal bucket passing', async () => {
  const result = await runPhase5Validation(pluginHistogram([['0.5', 5], ['1', 10], ['+Inf', 10]]));
  assertPluginReport(result, { code: 0, status: 'pass', actual: { p95: 0.95, p99: 0.99 }, count: 10, passed: 11, failed: 0, na: 0 });
});

test('keeps zero-count required histograms NA and overall fail', async () => {
  const result = await runPhase5Validation(pluginHistogram([['1', 0], ['+Inf', 0]], 0));
  assertPluginReport(result, { code: 1, status: 'na', actual: 0, count: 0, passed: 9, failed: 0, na: 2 });
});
