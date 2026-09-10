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

async function runPhase5Validation(metricsText, parserOnly = false) {
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
      parserOnly ? 'pnpm' : 'bash',
      parserOnly
        ? ['--filter', '@metasheet/core-backend', 'exec', 'tsx', path.join(repoRoot, 'scripts/phase5-metrics-percentiles.ts'), metricsUrl, outputPath]
        : ['scripts/phase5-full-validate.sh', metricsUrl, outputPath],
      {
        cwd: repoRoot,
        env: { ...process.env, METRICS_AUTH_HEADER: '', EXTRA_CURL_HEADER: '', THRESHOLDS_FILE: path.join(repoRoot, 'scripts/phase5-thresholds.json') },
        maxBuffer: 1024 * 1024 * 10,
        timeout: 60_000,
      },
    );
    const output = await readFile(outputPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT' && result.code !== 0) return null;
      throw error;
    });
    const json = output === null ? null : JSON.parse(output);
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
metasheet_plugin_reload_duration_seconds_bucket{plugin_name="example-plugin",le="+Inf"} 10
metasheet_plugin_reload_duration_seconds_sum{plugin_name="example-plugin"} 5
metasheet_plugin_reload_duration_seconds_count{plugin_name="example-plugin"} 10

metasheet_snapshot_operation_duration_seconds_bucket{operation="restore",le="1"} 10
metasheet_snapshot_operation_duration_seconds_bucket{operation="restore",le="+Inf"} 10
metasheet_snapshot_operation_duration_seconds_sum{operation="restore"} 5
metasheet_snapshot_operation_duration_seconds_count{operation="restore"} 10

metasheet_snapshot_operation_duration_seconds_bucket{operation="create",le="1"} 10
metasheet_snapshot_operation_duration_seconds_bucket{operation="create",le="+Inf"} 10
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
  assert.deepEqual(Object.keys(result.json.percentiles).sort(), [
    'metasheet_plugin_reload_duration_seconds{plugin_name="example-plugin"}',
    'metasheet_snapshot_operation_duration_seconds{operation="create"}',
    'metasheet_snapshot_operation_duration_seconds{operation="restore"}',
  ]);
  assert.deepEqual(Object.values(result.json.percentiles).map(value => value.count), [10, 10, 10]);
});

const sampleMetric = 'metasheet_snapshot_operation_duration_seconds';

function histogramFixture({ labels = '', countLabels = labels, count = '10', sum = '5', order = 'bucket-first' } = {}) {
  const bucketLabels = labels ? `${labels},` : '';
  const totalsLabels = countLabels ? `{${countLabels}}` : '';
  const buckets = `${sampleMetric}_bucket{${bucketLabels}le="1"} 10\n${sampleMetric}_bucket{${bucketLabels}le="+Inf"} 10\n`;
  const totals = `${sampleMetric}_sum${totalsLabels} ${sum}\n${sampleMetric}_count${totalsLabels} ${count}\n`;
  return order === 'totals-first' ? totals + buckets : buckets + totals;
}

for (const [name, fixture] of [
  ['bare sum/count without labels', histogramFixture()],
  ['empty label braces', histogramFixture().replace(/_(sum|count) /g, '_$1{} ')],
  ['reordered labels', histogramFixture({ labels: 'operation="create",kind="fixed"', countLabels: 'kind="fixed",operation="create"' })],
  ['signed scientific notation', histogramFixture({ count: '+1.0e+1', sum: '+5e0' }).replace(/ 10\n/g, ' +1E1\n')],
  ['negative exponent and decimal shorthand', histogramFixture({ count: '100e-1', sum: '.5e1' })],
  ['totals preceding buckets', histogramFixture({ order: 'totals-first' })],
  ['empty label value', histogramFixture({ labels: 'operation="create",kind=""' })],
]) {
  test(`parses ${name} without losing observations`, async () => {
    const result = await runPhase5Validation(fixture, true);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.raw_data.histograms.length, 1);
    assert.deepEqual(Object.values(result.json.metrics), [{ p50: 0.5, p95: 0.95, p99: 0.99, count: 10, sum: 5, mean: 0.5 }]);
  });
}

for (const [name, fixture] of [
  ['partial number', histogramFixture({ count: '10HOSTILE' })],
  ['missing exponent', histogramFixture({ count: '1e' })],
  ['negative count', histogramFixture({ count: '-10' })],
  ['fractional count', histogramFixture({ count: '1.5' })],
  ['unsafe count', histogramFixture({ count: '9007199254740992' })],
  ['non-finite count', histogramFixture({ count: 'NaN' })],
  ['overflow', histogramFixture({ count: '1e999' })],
  ['duplicate labels', histogramFixture({ labels: 'operation="create",operation="HOSTILE"' })],
  ['invalid label escape', histogramFixture({ labels: 'operation="HOSTILE\\q"' })],
  ['unparsed labels', histogramFixture({ labels: 'operation="create",HOSTILE' })],
  ['missing count', histogramFixture().replace(/^.*_count.*\n/m, '')],
  ['missing sum', histogramFixture().replace(/^.*_sum.*\n/m, '')],
  ['missing bucket bound', histogramFixture().replace('le="1"', 'kind="HOSTILE"')],
  ['non-finite sum', histogramFixture({ sum: 'Infinity' })],
  ['inconsistent infinity count', histogramFixture({ count: '11' })],
  ['only infinite bounds', histogramFixture().replace(/^.*le="1".*\n/m, '')],
  ['missing infinity bucket', histogramFixture().replace(/^.*le="\+Inf".*\n/m, '')],
]) {
  test(`rejects ${name} instead of certifying zero samples`, async () => {
    const result = await runPhase5Validation(fixture, true);
    assert.notEqual(result.code, 0);
    assert.equal(result.json, null);
    assert.match(result.stderr, /(?:INVALID|INCOMPLETE|DUPLICATE)_HISTOGRAM/);
    assert.doesNotMatch(result.stderr, /HOSTILE/);
  });
}

test('retains real zero-count samples without claiming latency success', async () => {
  const result = await runPhase5Validation(`${passingCounters}\n${passingLatencySamples.replace(/ 10\n/g, ' 0\n').replace(/ 5\n/g, ' 0\n')}`);
  assert.equal(result.code, 1);
  assert.equal(result.json.summary.na, 6);
  assert.equal(result.json.summary.overall_status, 'fail');
});

test('does not turn a percentile in the infinity bucket into JSON null', async () => {
  const result = await runPhase5Validation(histogramFixture().replace('le="1"} 10', 'le="1"} 5'), true);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.values(result.json.metrics), [{ p50: 1, p95: 1, p99: 1, count: 10, sum: 5, mean: 0.5 }]);
});

test('does not treat unrelated summary or gauge totals as histogram samples', async () => {
  const result = await runPhase5Validation(`${histogramFixture()}\nunrelated_sum NaN\nunrelated_count +Inf\n`, true);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.raw_data.histograms.length, 1);
  assert.equal(Object.values(result.json.metrics)[0].count, 10);
});

test('retains escaped and empty label identities', async () => {
  const result = await runPhase5Validation(histogramFixture({ labels: 'operation="create",empty="",note="a\\"b\\\\c\\nd"' }), true);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json.raw_data.histograms[0].labels, { empty: '', note: 'a"b\\c\nd', operation: 'create' });
});

test('keeps distinct label sets distinct in output metric keys', async () => {
  const embedded = 'x",b="y';
  const result = await runPhase5Validation(
    histogramFixture({ labels: `a=${JSON.stringify(embedded)}` })
      + histogramFixture({ labels: 'a="x",b="y"' }), true,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.raw_data.histograms.length, 2);
  assert.deepEqual(Object.keys(result.json.metrics).sort(), [
    `${sampleMetric}{a=${JSON.stringify(embedded)}}`,
    `${sampleMetric}{a="x",b="y"}`,
  ].sort());
});
