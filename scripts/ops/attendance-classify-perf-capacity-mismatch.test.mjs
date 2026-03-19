import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts', 'ops', 'attendance-classify-perf-capacity-mismatch.mjs');

function runClassifier({
  logText,
  rows = '100000',
  csvRowsLimitHint = '100000',
  remoteCsvRowsLimit = '100000',
  uploadCsv = 'true',
  payloadSource = 'auto',
}) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'attendance-capacity-classify-'));
  const perfLog = path.join(tempRoot, 'perf.log');
  const outputFile = path.join(tempRoot, 'perf-capacity-mismatch.json');
  writeFileSync(perfLog, logText, 'utf8');

  const result = spawnSync('node', [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PERF_LOG: perfLog,
      OUTPUT_FILE: outputFile,
      ROWS: rows,
      CSV_ROWS_LIMIT_HINT: csvRowsLimitHint,
      REMOTE_CSV_ROWS_LIMIT: remoteCsvRowsLimit,
      UPLOAD_CSV: uploadCsv,
      PAYLOAD_SOURCE: payloadSource,
    },
    encoding: 'utf8',
  });

  return { ...result, outputFile };
}

test('classifier prefers failure-line row cap when remote env is stale', () => {
  const result = runClassifier({
    logText: [
      '[attendance-import-perf] payload_source=csv reason=auto_csv upload_csv_requested=true upload_csv_effective=true csv_rows_limit_hint=100000',
      '[attendance-import-perf] Failed: async commit job failed: CSV exceeds max rows (20000)',
      '',
    ].join('\n'),
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(existsSync(result.outputFile), true);

  const payload = JSON.parse(readFileSync(result.outputFile, 'utf8'));
  assert.equal(payload.classification, 'capacity_mismatch');
  assert.equal(payload.remoteCsvRowsLimit, 20000);
  assert.equal(payload.remoteCsvRowsLimitSource, 'failure_line');
  assert.equal(payload.requestedRows, 100000);
});

test('classifier skips when CSV upload lane would not be used', () => {
  const result = runClassifier({
    logText: '[attendance-import-perf] Failed: async commit job failed: CSV exceeds max rows (20000)\n',
    rows: '100001',
    csvRowsLimitHint: '100000',
    payloadSource: 'auto',
  });

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(result.outputFile), false);
});
