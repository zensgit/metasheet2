import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const backend = join(root, 'packages/core-backend')
const requireBackend = createRequire(join(backend, 'package.json'))
const trustedNames = new Set([
  'matches actual guards for a trusted JWT and refuses target-token inference',
  'treats dev trusted admin as token guard context, not database delegation authority',
])

/** Never allow a remote database, a different database name, or URL parameters that can redirect PG. */
export function validateConnection(raw, acknowledgement) {
  if (acknowledgement !== 'permission_check_test' || typeof raw !== 'string') throw new Error('DATABASE_NOT_AUTHORIZED')
  let url
  try { url = new URL(raw) } catch { throw new Error('DATABASE_URL_INVALID') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/permission_check_test' || url.search || url.hash
    || !url.username || !url.port || !/^\d+$/.test(url.port)
    || Number(url.port) < 1 || Number(url.port) > 65535) throw new Error('DATABASE_NOT_AUTHORIZED')
  return url
}

/** Vitest 1 reports skipped assertions as passed in aggregate totals: inspect each assertion. */
export function validateReport(report, mode) {
  if (!['off', 'on'].includes(mode) || !report || report.success !== true
    || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0
    || !Array.isArray(report.testResults) || report.testResults.length !== 1) throw new Error('REPORT_INVALID')
  const file = report.testResults[0]
  if (file.status !== 'passed' || typeof file.name !== 'string'
    || !file.name.replaceAll('\\', '/').endsWith('/tests/integration/business-check-realdb.test.ts')
    || !Array.isArray(file.assertionResults) || file.assertionResults.length < 3) throw new Error('REPORT_INVALID')
  const seen = new Set()
  let ran = 0
  let skipped = 0
  for (const test of file.assertionResults) {
    if (typeof test.title !== 'string' || seen.has(test.title)) throw new Error('REPORT_INVALID')
    seen.add(test.title)
    const expectedRun = mode === 'on' ? trustedNames.has(test.title) : !trustedNames.has(test.title)
    if (expectedRun) {
      if (test.status !== 'passed') throw new Error('TEST_NOT_EXECUTED')
      ran++
    } else {
      if (test.status !== 'skipped') throw new Error('UNEXPECTED_TEST_STATUS')
      skipped++
    }
  }
  if ([...trustedNames].some(name => !seen.has(name)) || (mode === 'on' ? ran !== 2 : ran < 19)
    || (mode === 'off' && skipped !== 2)) throw new Error('TEST_COVERAGE_INCOMPLETE')
  return { ran, skipped }
}

/** Only OS process-launch variables are inherited; application secrets and PG overrides are not. */
export function buildTestEnvironment(parent, url, schema, mode, tempDir) {
  const env = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
    if (typeof parent[key] === 'string') env[key] = parent[key]
  }
  Object.assign(env, {
    DATABASE_URL: url.toString(), PGOPTIONS: `-c search_path=${schema}`,
    PERMISSION_CHECK_TEST_SCHEMA: schema, EXPECT_DB: '1', NODE_ENV: 'test',
    JWT_SECRET: 'permission-check-synthetic-test-secret-only', PRODUCT_MODE: 'plm-workbench',
    RBAC_BYPASS: 'false', RBAC_TOKEN_TRUST: mode === 'on' ? 'true' : 'false',
    DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED: 'false', VITEST_MAX_THREADS: '3',
    TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir,
  })
  return env
}

async function main() {
  const url = validateConnection(process.env.DATABASE_URL, process.env.PERMISSION_CHECK_DISPOSABLE_DB)
  // The explicit config prevents PGHOST/PGSERVICE/PGOPTIONS from changing the safety probe destination.
  const { Client } = requireBackend('pg')
  const client = new Client({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: 'permission_check_test', ssl: false, connectionTimeoutMillis: 3000, options: '-c search_path=pg_catalog' })
  try {
    await client.connect()
    const result = await client.query('SELECT current_database() AS db')
    if (result.rows[0]?.db !== 'permission_check_test') throw new Error('DATABASE_NOT_AUTHORIZED')
  } finally { await client.end().catch(() => {}) }

  const runId = randomBytes(8).toString('hex')
  const reportDir = join(root, 'tmp', 'permission-check', `ci-${runId}`)
  mkdirSync(reportDir, { recursive: true })
  const executable = requireBackend.resolve('vitest/vitest.mjs')
  for (const mode of ['off', 'on']) {
    const schema = `permission_check_ci_${runId}_${mode}`
    const reportPath = join(reportDir, `${mode}.json`)
    const env = buildTestEnvironment(process.env, url, schema, mode, reportDir)
    const args = [executable, 'run', '--config', 'vitest.business-check-realdb.config.ts',
      '--reporter=json', `--outputFile=${reportPath}`]
    if (mode === 'on') args.push('-t', 'trusted')
    const child = spawnSync(process.execPath, args, { cwd: backend, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 })
    if (child.error || child.status !== 0) throw new Error(`VITEST_${mode.toUpperCase()}_FAILED`)
    let report
    try { report = JSON.parse(readFileSync(reportPath, 'utf8')) } catch { throw new Error('REPORT_UNREADABLE') }
    const counts = validateReport(report, mode)
    console.log(`BUSINESS_CHECK_REALDB ${mode}: ${counts.ran} passed, ${counts.skipped} intentionally skipped`)
  }
}


if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    // Never print URLs, connection errors, test output, SQL, or data.
    const key = typeof error?.message === 'string' && /^[A-Z_]+$/.test(error.message) ? error.message : 'RUN_FAILED'
    console.error(`BUSINESS_CHECK_REALDB: ${key}`)
    process.exitCode = 1
  })
}
