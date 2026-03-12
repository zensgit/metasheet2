import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts', 'ops', 'attendance-fast-parallel-regression.sh');

function runFastRegression(extraEnv = {}) {
  const outputRoot = mkdtempSync(path.join(os.tmpdir(), 'attendance-fast-regression-'));
  const result = spawnSync('bash', [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      OUTPUT_ROOT: outputRoot,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  return {
    ...result,
    outputRoot,
  };
}

test('attendance-fast-parallel-regression rejects invalid profile', () => {
  const result = runFastRegression({ PROFILE: 'invalid' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PROFILE must be one of: full, ops, contracts/);
});

test('attendance-fast-parallel-regression rejects invalid max parallel', () => {
  const result = runFastRegression({ MAX_PARALLEL: 'bad' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /MAX_PARALLEL must be an integer >= 0/);
});

test('attendance-fast-parallel-regression ops profile defaults to ops checks only', () => {
  const result = runFastRegression({ PROFILE: 'ops', MAX_PARALLEL: '2' });
  assert.equal(result.status, 0);
  const summary = JSON.parse(
    readFileSync(path.join(result.outputRoot, 'summary.json'), 'utf8'),
  );
  assert.equal(summary.profile, 'ops');
  assert.equal(summary.maxParallel, 2);
  assert.equal(summary.runContractCases, false);
  assert.equal(summary.totals.total, 4);
  const checks = summary.checks.map((item) => item.check);
  assert.ok(checks.every((name) => name.startsWith('ops-')));
});

test('attendance-fast-parallel-regression contracts profile defaults to contract checks only', () => {
  const result = runFastRegression({
    PROFILE: 'contracts',
    MAX_PARALLEL: '1',
    CONTRACT_STRICT_CMD: 'echo strict-ok',
    CONTRACT_DASHBOARD_CMD: 'echo dashboard-ok',
  });
  assert.equal(result.status, 0);
  const summary = JSON.parse(
    readFileSync(path.join(result.outputRoot, 'summary.json'), 'utf8'),
  );
  assert.equal(summary.profile, 'contracts');
  assert.equal(summary.maxParallel, 1);
  assert.equal(summary.runContractCases, true);
  assert.equal(summary.totals.total, 2);
  const checks = summary.checks.map((item) => item.check);
  assert.deepEqual(checks.sort(), ['contract-dashboard', 'contract-strict']);
});
