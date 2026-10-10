import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function execFileResult(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error && (error.killed || error.signal || typeof error.code !== 'number' || error.code === 0)) {
        reject(error);
        return;
      }
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
  const bodies = Array.isArray(metricsText) ? metricsText : [metricsText, metricsText];
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.url !== '/metrics/prom') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(bodies[requests++]);
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
    assert.equal(requests, 2);
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

const latencyIds = [
  'plugin_reload_latency_p95', 'plugin_reload_latency_p99',
  'snapshot_restore_latency_p95', 'snapshot_restore_latency_p99',
  'snapshot_create_latency_p95', 'snapshot_create_latency_p99',
];

function pluginSampling(result, expected) {
  assert.deepEqual(result.json.sampling.thresholds.map(t => t.metric), latencyIds);
  for (const metric of latencyIds.slice(0, 2)) {
    assert.deepEqual(result.json.sampling.thresholds.find(t => t.metric === metric), { metric, ...expected });
  }
}

test('marks overall status fail when required latency samples are missing', async () => {
  const result = await runPhase5Validation(passingCounters);

  assert.equal(result.code, 1);
  assert.equal(result.json.summary.overall_status, 'fail');
  assert.equal(result.json.summary.failed, 0);
  assert.equal(result.json.summary.na, 6);
  assert.equal(result.json.summary.passed, 5);
  assert.equal(result.json.assertions.filter((assertion) => assertion.status === 'na').length, 6);
  assert.deepEqual(result.json.percentiles, {});
  assert.deepEqual(result.json.sampling, {
    source: 'SECOND_PERCENTILE_SCRAPE',
    input_sha256: createHash('sha256').update(passingCounters).digest('hex'),
    parsed_histograms: 0,
    relevant_histograms: 0,
    thresholds: latencyIds.map(metric => ({
      metric, raw_bucket_lines: 0, parsed_family_histograms: 0,
      selected_count: null, reason: 'family_absent',
    })),
  });
});

test('distinguishes registered histograms with no series while required latency remains blocking', async () => {
  const secondBody = `${passingCounters}
# TYPE metasheet_plugin_reload_duration_seconds histogram
# TYPE\tmetasheet_snapshot_operation_duration_seconds\thistogram
`;
  const result = await runPhase5Validation([passingCounters, secondBody]);

  assert.equal(result.code, 1);
  assert.deepEqual(result.json.summary, { total_checks: 11, passed: 5, failed: 0, na: 6, overall_status: 'fail' });
  assert.deepEqual(result.json.percentiles, {});
  assert.deepEqual(result.json.sampling, {
    source: 'SECOND_PERCENTILE_SCRAPE',
    input_sha256: createHash('sha256').update(secondBody).digest('hex'),
    parsed_histograms: 0,
    relevant_histograms: 0,
    thresholds: latencyIds.map(metric => ({
      metric, raw_bucket_lines: 0, parsed_family_histograms: 0,
      selected_count: null, reason: 'family_no_series',
    })),
  });
});

test('keeps overall status pass when required latency samples satisfy thresholds', async () => {
  const secondBody = `${passingCounters}\n${passingLatencySamples}`;
  const result = await runPhase5Validation([passingCounters, secondBody]);

  assert.equal(result.code, 0);
  assert.equal(result.json.summary.overall_status, 'pass');
  assert.equal(result.json.summary.failed, 0);
  assert.equal(result.json.summary.na, 0);
  assert.equal(result.json.summary.passed, 11);
  assert.deepEqual(result.json.sampling, {
    source: 'SECOND_PERCENTILE_SCRAPE',
    input_sha256: createHash('sha256').update(secondBody).digest('hex'),
    parsed_histograms: 3,
    relevant_histograms: 3,
    thresholds: latencyIds.map(metric => ({
      metric, raw_bucket_lines: metric.startsWith('plugin_') ? 1 : 2,
      parsed_family_histograms: metric.startsWith('plugin_') ? 1 : 2,
      selected_count: 10, reason: 'positive_samples',
    })),
  });
});

test('keeps wrong exact selectors NA without exposing sensitive labels in sampling', async () => {
  const sentinel = 'SENSITIVE_LABEL_SENTINEL';
  for (const replacement of [`plugin_name="${sentinel}"`, `plugin_name="example-plugin",private_label="${sentinel}"`]) {
    const body = `${passingCounters}\n${passingLatencySamples.replaceAll('plugin_name="example-plugin"', replacement)}`;
    const result = await runPhase5Validation(body);
    assert.equal(result.code, 1);
    assert.deepEqual(result.json.summary, { total_checks: 11, passed: 9, failed: 0, na: 2, overall_status: 'fail' });
    assert.equal(Object.keys(result.json.percentiles).length, 3);
    pluginSampling(result, { raw_bucket_lines: 1, parsed_family_histograms: 1, selected_count: null, reason: 'selector_missing' });
    assert.doesNotMatch(JSON.stringify(result.json.sampling), new RegExp(sentinel));
    assert.doesNotMatch(JSON.stringify(result.json.sampling), /plugin_name|private_label|metrics\/prom|http:/);
  }
});

test('distinguishes missing, unparsed and invalid complete counts from genuinely zero samples', async () => {
  for (const [value, reason, code] of [
    ['', 'count_unparsed', 1], ['malformed', 'count_unparsed', 1],
    ['9'.repeat(400), 'count_invalid', 1], ['1e309', 'count_invalid', 0],
    ['0junk', 'count_invalid', 1], ['1e2', 'count_invalid', 0],
  ]) {
    const countLine = value ? `metasheet_plugin_reload_duration_seconds_count{plugin_name="example-plugin"} ${value}` : '';
    const body = `${passingCounters}\n${passingLatencySamples.replace(
      'metasheet_plugin_reload_duration_seconds_count{plugin_name="example-plugin"} 10', countLine,
    )}`;
    const result = await runPhase5Validation(body);
    assert.equal(result.code, code);
    assert.equal(result.json.summary.na, code === 1 ? 2 : 0);
    pluginSampling(result, { raw_bucket_lines: 1, parsed_family_histograms: 1, selected_count: null, reason });
  }
});

test('retains nonempty percentiles for genuine zero-count selected histograms', async () => {
  const body = `${passingCounters}\n${passingLatencySamples.replace(
    /^(metasheet_plugin_reload_duration_seconds_(?:bucket|sum|count)[^\n]*) \d+$/gm, '$1 0',
  )}`;
  const result = await runPhase5Validation(body);
  assert.equal(result.code, 1);
  assert.equal(result.json.summary.na, 2);
  assert.equal(Object.keys(result.json.percentiles).length, 3);
  pluginSampling(result, { raw_bucket_lines: 1, parsed_family_histograms: 1, selected_count: 0, reason: 'zero_samples' });
});

test('reports present but unparsed buckets separately from absent families', async () => {
  const body = `${passingCounters}\n${passingLatencySamples.replace(
    'metasheet_plugin_reload_duration_seconds_bucket{plugin_name="example-plugin",le="1"} 10',
    'metasheet_plugin_reload_duration_seconds_bucket{plugin_name="example-plugin",le="1"} malformed',
  )}`;
  const result = await runPhase5Validation(body);
  assert.equal(result.code, 1);
  assert.equal(result.json.summary.na, 2);
  assert.equal(result.json.sampling.parsed_histograms, 2);
  assert.equal(result.json.sampling.relevant_histograms, 2);
  pluginSampling(result, { raw_bucket_lines: 1, parsed_family_histograms: 0, selected_count: null, reason: 'family_unparsed' });
});

test('reports nonfinite sampling while the repaired gate refuses unestimable latency', async () => {
  const body = `${passingCounters}\n${passingLatencySamples.replace('le="1"} 10', 'le="malformed"} 10')}`;
  const result = await runPhase5Validation(body);
  assert.equal(result.code, 1);
  assert.deepEqual(result.json.summary, { total_checks: 11, passed: 9, failed: 2, na: 0, overall_status: 'fail' });
  assert.equal(result.json.percentiles['metasheet_plugin_reload_duration_seconds{plugin_name="example-plugin"}'].p95, null);
  pluginSampling(result, { raw_bucket_lines: 1, parsed_family_histograms: 1, selected_count: 10, reason: 'percentile_unestimable' });
});

test('rejects unknown child termination instead of reporting a normal zero exit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phase5-child-exit-'));
  try {
    await assert.rejects(execFileResult(path.join(dir, 'missing-child'), [], {}), error => error.code === 'ENOENT');
    await assert.rejects(execFileResult(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeout: 100, killSignal: 'SIGTERM',
    }), error => error.killed === true && error.signal === 'SIGTERM' && typeof error.code !== 'number');
    const nonzero = await execFileResult(process.execPath, ['-e', 'process.exit(7)'], {});
    assert.equal(nonzero.code, 7);
    const normal = await execFileResult(process.execPath, ['-e', 'process.exit(0)'], {});
    assert.equal(normal.code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
