import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts', 'ops', 'attendance-run-perf-highscale.sh');

function writeDispatcher({
  root,
  runId = '123456',
  rows = 100000,
  mode = 'commit',
  uploadCsv = true,
  commitAsync = true,
  payloadSource = 'auto',
  capacityMismatch = null,
  perfLog = '',
}) {
  const dispatcherPath = path.join(root, 'fake-dispatcher.sh');
  const capacityMismatchScript = capacityMismatch
    ? `cat > "\${DOWNLOAD_DIR}/\${run_id}/artifact/perf-capacity-mismatch.json" <<'EOF'
${JSON.stringify(capacityMismatch, null, 2)}
EOF
`
    : '';
  const perfLogScript = perfLog
    ? `cat > "\${DOWNLOAD_DIR}/\${run_id}/artifact/perf.log" <<'EOF'
${perfLog}
EOF
`
    : '';
  const script = `#!/usr/bin/env bash
set -euo pipefail
run_id="${runId}"
args_file="\${DOWNLOAD_DIR}/args.txt"
mkdir -p "\${DOWNLOAD_DIR}/\${run_id}/artifact"
printf '%s\\n' "$*" > "\${args_file}"
cat > "\${DOWNLOAD_DIR}/\${run_id}/artifact/perf-summary.json" <<'EOF'
{
  "rows": ${rows},
  "mode": "${mode}",
  "uploadCsv": ${uploadCsv},
  "commitAsync": ${commitAsync},
  "payloadSource": "${payloadSource}",
  "regressions": []
}
EOF
${capacityMismatchScript}
${perfLogScript}
echo "RUN_ID=\${run_id}"
`;
  writeFileSync(dispatcherPath, script, 'utf8');
  spawnSync('chmod', ['+x', dispatcherPath]);
  return dispatcherPath;
}

function runHighscale(extraEnv = {}) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'attendance-highscale-'));
  const outputRoot = path.join(tempRoot, 'out');
  const dispatcherPath = writeDispatcher({ root: tempRoot });

  const result = spawnSync('bash', [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      DOWNLOAD_ROOT: outputRoot,
      DISPATCHER: dispatcherPath,
      ...extraEnv,
    },
    encoding: 'utf8',
  });

  return {
    ...result,
    tempRoot,
    outputRoot,
    dispatcherPath,
  };
}

test('attendance-run-perf-highscale succeeds with valid summary and records drill args', () => {
  const result = runHighscale({
    DRILL: 'true',
    DRILL_FAIL: 'false',
    ROWS: '100000',
    MODE: 'commit',
    COMMIT_ASYNC: 'true',
    UPLOAD_CSV: 'true',
    PAYLOAD_SOURCE: 'auto',
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const summaryJson = path.join(result.outputRoot, 'summary.json');
  const summaryMd = path.join(result.outputRoot, 'summary.md');
  const argsFile = path.join(result.outputRoot, 'ga', 'args.txt');

  assert.equal(existsSync(summaryJson), true);
  assert.equal(existsSync(summaryMd), true);
  assert.equal(existsSync(argsFile), true);

  const summary = JSON.parse(readFileSync(summaryJson, 'utf8'));
  assert.equal(summary.runId, '123456');
  assert.equal(summary.contract.rowsActual, 100000);
  assert.equal(summary.contract.modeActual, 'commit');
  assert.equal(summary.contract.uploadActual, 'true');
  assert.equal(summary.contract.commitAsyncActual, 'true');

  const argsRaw = readFileSync(argsFile, 'utf8');
  assert.match(argsRaw, /drill=true/);
  assert.match(argsRaw, /drill_fail=false/);
});

test('attendance-run-perf-highscale fails when summary rows is below expected', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'attendance-highscale-fail-'));
  const outputRoot = path.join(tempRoot, 'out');
  const dispatcherPath = writeDispatcher({ root: tempRoot, rows: 99999 });

  const result = spawnSync('bash', [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      DOWNLOAD_ROOT: outputRoot,
      DISPATCHER: dispatcherPath,
      ROWS: '100000',
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /summary rows 99999 < expected 100000/);
});

test('attendance-run-perf-highscale classifies known capacity mismatch from artifact', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'attendance-highscale-capacity-'));
  const outputRoot = path.join(tempRoot, 'out');
  const dispatcherPath = writeDispatcher({
    root: tempRoot,
    capacityMismatch: {
      classification: 'capacity_mismatch',
      requestedRows: 100000,
      payloadSourceRequested: 'auto',
      uploadCsvRequested: true,
      csvRowsLimitHint: 100000,
      remoteCsvRowsLimit: 20000,
      failureLine: '[attendance-import-perf] Failed: async commit job failed: CSV exceeds max rows (20000)',
    },
  });

  const result = spawnSync('bash', [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      DOWNLOAD_ROOT: outputRoot,
      DISPATCHER: dispatcherPath,
      ROWS: '100000',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(readFileSync(path.join(outputRoot, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'known_capacity_mismatch');
  assert.equal(summary.classification, 'capacity_mismatch');
  assert.equal(summary.capacityMismatch.remoteCsvRowsLimit, 20000);
  assert.equal(summary.capacityMismatch.requestedRows, 100000);
});

test('attendance-run-perf-highscale infers capacity mismatch from perf.log when artifact is missing', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'attendance-highscale-log-capacity-'));
  const outputRoot = path.join(tempRoot, 'out');
  const dispatcherPath = writeDispatcher({
    root: tempRoot,
    perfLog: [
      '[attendance-import-perf] payload_source=csv reason=auto_csv upload_csv_requested=true upload_csv_effective=true csv_rows_limit_hint=100000',
      '[attendance-import-perf] Failed: async commit job failed: CSV exceeds max rows (20000)',
      '',
    ].join('\n'),
  });

  const result = spawnSync('bash', [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      DOWNLOAD_ROOT: outputRoot,
      DISPATCHER: dispatcherPath,
      ROWS: '100000',
      PAYLOAD_SOURCE: 'auto',
      UPLOAD_CSV: 'true',
      CSV_ROWS_LIMIT_HINT: '100000',
      REMOTE_CSV_ROWS_LIMIT: '100000',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const summary = JSON.parse(readFileSync(path.join(outputRoot, 'summary.json'), 'utf8'));
  assert.equal(summary.classification, 'capacity_mismatch');
  assert.equal(summary.capacityMismatch.remoteCsvRowsLimit, 20000);
  assert.equal(summary.capacityMismatch.requestedRows, 100000);
});
