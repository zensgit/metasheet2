import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts', 'ops', 'attendance-run-perf-highscale.sh');

function writeDispatcher({ root, runId = '123456', rows = 100000, mode = 'commit', uploadCsv = true, commitAsync = true, payloadSource = 'auto' }) {
  const dispatcherPath = path.join(root, 'fake-dispatcher.sh');
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
