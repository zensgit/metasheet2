import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts', 'ops', 'attendance-fast-parallel-summary-report.mjs');

function writeSummary(root, dir, payload) {
  const outDir = path.join(root, dir);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function runReport(env = {}) {
  return spawnSync('node', [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('attendance-fast-parallel-summary-report selects latest row per profile by default', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-fast-report-source-'));
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-fast-report-out-'));
  writeSummary(sourceRoot, '20260310-010101-100', {
    timestamp: '20260310-010101-100',
    outputRoot: path.join(sourceRoot, '20260310-010101-100'),
    profile: 'ops',
    maxParallel: 2,
    runContractCases: false,
    totals: { total: 4, pass: 4, fail: 0, skip: 0 },
  });
  writeSummary(sourceRoot, '20260310-010102-101', {
    timestamp: '20260310-010102-101',
    outputRoot: path.join(sourceRoot, '20260310-010102-101'),
    profile: 'ops',
    maxParallel: 2,
    runContractCases: false,
    totals: { total: 4, pass: 3, fail: 1, skip: 0 },
  });
  writeSummary(sourceRoot, '20260310-010103-102', {
    timestamp: '20260310-010103-102',
    outputRoot: path.join(sourceRoot, '20260310-010103-102'),
    profile: 'contracts',
    maxParallel: 1,
    runContractCases: true,
    totals: { total: 2, pass: 2, fail: 0, skip: 0 },
  });

  const result = runReport({
    OUTPUT_ROOT: sourceRoot,
    REPORT_ROOT: reportRoot,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const markdown = result.stdout;
  assert.match(markdown, /20260310-010102-101/);
  assert.match(markdown, /20260310-010103-102/);
  assert.doesNotMatch(markdown, /20260310-010101-100/);
});

test('attendance-fast-parallel-summary-report can include all rows', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-fast-report-source-'));
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-fast-report-out-'));
  writeSummary(sourceRoot, '20260310-010101-100', {
    timestamp: '20260310-010101-100',
    outputRoot: path.join(sourceRoot, '20260310-010101-100'),
    profile: 'ops',
    maxParallel: 2,
    runContractCases: false,
    totals: { total: 4, pass: 4, fail: 0, skip: 0 },
  });
  writeSummary(sourceRoot, '20260310-010102-101', {
    timestamp: '20260310-010102-101',
    outputRoot: path.join(sourceRoot, '20260310-010102-101'),
    profile: 'ops',
    maxParallel: 2,
    runContractCases: false,
    totals: { total: 4, pass: 3, fail: 1, skip: 0 },
  });

  const result = runReport({
    OUTPUT_ROOT: sourceRoot,
    REPORT_ROOT: reportRoot,
    LATEST_PER_PROFILE: 'false',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const markdown = result.stdout;
  assert.match(markdown, /20260310-010101-100/);
  assert.match(markdown, /20260310-010102-101/);
});

test('attendance-fast-parallel-summary-report fails when source root has no summary files', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-fast-report-source-empty-'));
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-fast-report-out-'));
  const result = runReport({
    OUTPUT_ROOT: sourceRoot,
    REPORT_ROOT: reportRoot,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /no summary\.json found under/);
});
