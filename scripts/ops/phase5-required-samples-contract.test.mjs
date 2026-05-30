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
        env: { ...process.env, METRICS_AUTH_HEADER: '', EXTRA_CURL_HEADER: '' },
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
