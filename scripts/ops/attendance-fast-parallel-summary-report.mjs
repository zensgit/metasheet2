#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const OUTPUT_ROOT = process.env.OUTPUT_ROOT
  ? path.resolve(process.env.OUTPUT_ROOT)
  : path.resolve('output/playwright/attendance-fast-parallel-regression');
const REPORT_ROOT = process.env.REPORT_ROOT
  ? path.resolve(process.env.REPORT_ROOT)
  : path.resolve('output/playwright/attendance-fast-parallel-report');
const LATEST_PER_PROFILE = process.env.LATEST_PER_PROFILE !== 'false';

function parseTimestampKey(key) {
  const matched = String(key || '').match(/^(\d{8})-(\d{6})/);
  if (!matched) {
    return null;
  }
  return `${matched[1]}${matched[2]}`;
}

function statusFromTotals(totals) {
  const fail = Number(totals?.fail || 0);
  if (fail > 0) {
    return 'FAIL';
  }
  return 'PASS';
}

function inferProfileFromChecks(checks) {
  const names = (Array.isArray(checks) ? checks : [])
    .map((item) => String(item?.check || ''))
    .filter(Boolean);
  if (names.length === 0) {
    return 'unknown';
  }
  if (names.every((name) => name.startsWith('ops-'))) {
    return 'ops';
  }
  if (names.every((name) => name.startsWith('contract-'))) {
    return 'contracts';
  }
  return 'full';
}

async function readSummary(summaryPath) {
  const raw = await fs.readFile(summaryPath, 'utf8');
  const data = JSON.parse(raw);
  const outputRoot = String(data.outputRoot || '');
  const outputBase = path.basename(outputRoot);
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const totals = {
    total: Number(data?.totals?.total || checks.length || 0),
    pass: Number(data?.totals?.pass || 0),
    fail: Number(data?.totals?.fail || 0),
    skip: Number(data?.totals?.skip || 0),
  };
  const inferredProfile = inferProfileFromChecks(checks);
  const profile = String(data.profile || inferredProfile);
  const maxParallel = Number(data.maxParallel || totals.total || checks.length || 0);
  const runContractCases = Object.prototype.hasOwnProperty.call(data, 'runContractCases')
    ? Boolean(data.runContractCases)
    : checks.some((item) => String(item?.check || '').startsWith('contract-'));
  return {
    summaryPath,
    outputRoot,
    outputBase,
    timestamp: String(data.timestamp || outputBase),
    timestampKey: parseTimestampKey(data.timestamp || outputBase) || String(data.timestamp || outputBase),
    profile,
    maxParallel,
    runContractCases,
    totals,
  };
}

function toMarkdown(rows) {
  const header = [
    '# Attendance Fast Parallel Regression Report',
    '',
    `- Source root: \`${OUTPUT_ROOT}\``,
    '',
    '| Timestamp | Profile | Max Parallel | Contract Checks | Status | Total | Pass | Fail | Skip | Summary |',
    '|---|---|---:|---|---|---:|---:|---:|---:|---|',
  ];
  const body = rows.map((item) => {
    const status = statusFromTotals(item.totals);
    return `| ${item.timestamp} | ${item.profile} | ${item.maxParallel} | ${item.runContractCases ? 'YES' : 'NO'} | ${status} | ${item.totals.total} | ${item.totals.pass} | ${item.totals.fail} | ${item.totals.skip} | \`${item.summaryPath}\` |`;
  });
  return `${header.concat(body).join('\n')}\n`;
}

async function discoverSummaries(root) {
  let dirEntries;
  try {
    dirEntries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = dirEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const summaries = [];
  for (const dir of dirs) {
    const summaryPath = path.join(root, dir, 'summary.json');
    try {
      await fs.access(summaryPath);
      summaries.push(summaryPath);
    } catch {
      // ignore
    }
  }
  return summaries;
}

function pickLatestPerProfile(items) {
  const latestMap = new Map();
  for (const item of items) {
    const current = latestMap.get(item.profile);
    if (!current || String(item.timestampKey) > String(current.timestampKey)) {
      latestMap.set(item.profile, item);
    }
  }
  return Array.from(latestMap.values()).sort((a, b) => String(b.timestampKey).localeCompare(String(a.timestampKey)));
}

async function main() {
  const summaryPaths = await discoverSummaries(OUTPUT_ROOT);
  if (summaryPaths.length === 0) {
    throw new Error(`no summary.json found under ${OUTPUT_ROOT}`);
  }
  const parsed = await Promise.all(summaryPaths.map(readSummary));
  const sorted = parsed.sort((a, b) => String(b.timestampKey).localeCompare(String(a.timestampKey)));
  const reportRows = LATEST_PER_PROFILE ? pickLatestPerProfile(sorted) : sorted;

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const outDir = path.join(REPORT_ROOT, stamp);
  await fs.mkdir(outDir, { recursive: true });

  const markdown = toMarkdown(reportRows);
  const reportJson = {
    sourceRoot: OUTPUT_ROOT,
    latestPerProfile: LATEST_PER_PROFILE,
    generatedAt: now.toISOString(),
    rows: reportRows,
  };

  const mdPath = path.join(outDir, 'attendance-fast-parallel-report.md');
  const jsonPath = path.join(outDir, 'attendance-fast-parallel-report.json');
  await fs.writeFile(mdPath, markdown, 'utf8');
  await fs.writeFile(jsonPath, JSON.stringify(reportJson, null, 2) + '\n', 'utf8');

  process.stdout.write(markdown);
  process.stdout.write(`\n[attendance-fast-parallel-summary-report] report_md=${mdPath}\n`);
  process.stdout.write(`[attendance-fast-parallel-summary-report] report_json=${jsonPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`[attendance-fast-parallel-summary-report] ERROR: ${error.message}\n`);
  process.exit(1);
});
