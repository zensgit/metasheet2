#!/usr/bin/env node
// Read-only preflight for the K3 WISE PoC on-prem deployment.
//
// What this DOES:
// - Validate runtime env (DATABASE_URL, JWT_SECRET) without printing secret values.
// - TCP-probe Postgres host:port from DATABASE_URL.
// - Spawn `kysely migrate --list` (read-only) and report code-vs-DB alignment.
// - Verify K3 WISE mock fixtures are present so the offline smoke can run.
// - In --live mode: assert K3 endpoint config is supplied and TCP-reach the K3 host.
//
// What this does NOT do:
// - Run migrations, write to any DB, or call any K3 write endpoint.
// - Print or persist secret values. URL credentials (DATABASE_URL / K3_API_URL
//   userinfo password) are stripped at storage time; query params whose keys
//   match access_token / token / password / secret / sign / signature /
//   api_key / session_id are redacted in BOTH stdout/MD (via redactString)
//   AND preflight.json (via sanitizeUrl applied at storage time).
//
// Exit codes (stable contract):
//   0  PASS         — safe to proceed with on-prem PoC test
//   1  FAIL         — mandatory env defect (fix before continuing)
//   2  GATE_BLOCKED — customer GATE answers / config still required (live only)

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..')

const DEFAULT_OUTPUT_ROOT = 'artifacts/integration-k3wise-onprem-preflight'
const REQUIRED_FIXTURES = [
  'scripts/ops/fixtures/integration-k3wise/gate-sample.json',
  'scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.mjs',
  'scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.mjs',
  'scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs',
]
const MIN_JWT_SECRET_LENGTH = 32
const DEFAULT_TIMEOUT_MS = 5000

const SECRET_QUERY_PARAM_PATTERN = /^(access[-_]?token|token|password|secret|signature|sign|api[-_]?key|sessionid|session[-_]?id|auth)$/i

function redactString(value) {
  return String(value)
    .replace(/([?&]access[-_]?token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&]token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&]password=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&]secret=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&]sign(?:ature)?=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&]api[-_]?key=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&]session[-_]?id=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
    .replace(/(postgres(?:ql)?:\/\/[^:/?@\s]+):[^@\s]+@/gi, '$1:<redacted>@')
}

// Sanitize a URL for storage in artifact files (preflight.json / preflight.md).
// Strips userinfo password and redacts query params whose keys look like
// secrets. Used at storage time so JSON output is safe even though
// JSON.stringify does not pass through redactString. (PR Hardening Checklist:
// "sanitize env values in artifact files".)
function sanitizeUrl(value) {
  if (!value) return ''
  try {
    const u = new URL(value)
    if (u.password) u.password = '<redacted>'
    for (const key of Array.from(u.searchParams.keys())) {
      if (SECRET_QUERY_PARAM_PATTERN.test(key)) {
        u.searchParams.set(key, '<redacted>')
      }
    }
    return u.toString()
  } catch {
    return '<unparseable>'
  }
}

// Backward-compatible alias for the original export name; behaviour is now a
// superset (also redacts secret query params).
const maskedDatabaseUrl = sanitizeUrl

function parseArgs(argv) {
  const opts = {
    mode: 'mock',
    outputDir: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    gateFile: '',
    skipTcp: false,
    skipMigrations: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    switch (a) {
      case '--live':
        opts.mode = 'live'
        break
      case '--mock':
        opts.mode = 'mock'
        break
      case '--gate-file':
        opts.gateFile = argv[++i] || ''
        break
      case '--out-dir':
        opts.outputDir = argv[++i] || ''
        break
      case '--timeout-ms': {
        const next = Number.parseInt(argv[++i], 10)
        if (!Number.isFinite(next) || next < 100 || next > 120_000) {
          throw new Error('--timeout-ms must be an integer between 100 and 120000')
        }
        opts.timeoutMs = next
        break
      }
      case '--skip-tcp':
        opts.skipTcp = true
        break
      case '--skip-migrations':
        opts.skipMigrations = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new Error(`unknown argument: ${a}`)
    }
  }
  return opts
}

function addCheck(summary, id, label, status, details = {}) {
  summary.checks.push({ id, label, status, details })
}

function classifyChecks(checks) {
  if (checks.some((c) => c.status === 'fail')) return { decision: 'FAIL', exitCode: 1 }
  if (checks.some((c) => c.status === 'gate-blocked')) return { decision: 'GATE_BLOCKED', exitCode: 2 }
  return { decision: 'PASS', exitCode: 0 }
}

function checkDatabaseUrl(env, summary) {
  const raw = (env.DATABASE_URL || '').trim()
  if (!raw) {
    addCheck(summary, 'env.database-url', 'DATABASE_URL is set', 'fail', {
      hint: 'set DATABASE_URL=postgres://user:pass@host:5432/db before running backend or migrations',
    })
    return null
  }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    addCheck(summary, 'env.database-url', 'DATABASE_URL is set', 'fail', {
      hint: 'DATABASE_URL is set but is not a valid URL',
      masked: '<unparseable>',
    })
    return null
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    addCheck(summary, 'env.database-url', 'DATABASE_URL is set', 'fail', {
      hint: 'DATABASE_URL must use the postgres:// or postgresql:// scheme',
      masked: maskedDatabaseUrl(raw),
    })
    return null
  }
  const port = parsed.port || '5432'
  addCheck(summary, 'env.database-url', 'DATABASE_URL is set', 'pass', {
    masked: maskedDatabaseUrl(raw),
    host: parsed.hostname,
    port,
    database: parsed.pathname.replace(/^\//, '') || '<unspecified>',
  })
  return { url: parsed, host: parsed.hostname, port: Number.parseInt(port, 10) }
}

function checkJwtSecret(env, summary) {
  const v = env.JWT_SECRET || ''
  if (!v) {
    addCheck(summary, 'env.jwt-secret', `JWT_SECRET is set (>=${MIN_JWT_SECRET_LENGTH} chars)`, 'fail', {
      hint: `set JWT_SECRET to a >=${MIN_JWT_SECRET_LENGTH}-char random string before starting the backend`,
    })
    return
  }
  if (v.length < MIN_JWT_SECRET_LENGTH) {
    addCheck(summary, 'env.jwt-secret', `JWT_SECRET is set (>=${MIN_JWT_SECRET_LENGTH} chars)`, 'fail', {
      hint: `JWT_SECRET length=${v.length} is too short; auth round-trip is unstable. Regenerate >=${MIN_JWT_SECRET_LENGTH} chars.`,
      length: v.length,
    })
    return
  }
  addCheck(summary, 'env.jwt-secret', `JWT_SECRET is set (>=${MIN_JWT_SECRET_LENGTH} chars)`, 'pass', { length: v.length })
}

function tcpProbe({ host, port, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false
    const sock = net.createConnection({ host, port })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve({ ok: false, code: 'ETIMEDOUT' })
    }, timeoutMs)
    sock.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.end() } catch { /* ignore */ }
      resolve({ ok: true })
    })
    sock.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* ignore */ }
      resolve({ ok: false, code: err.code || 'EUNKNOWN' })
    })
  })
}

function tcpHint(code, host, port, service) {
  switch (code) {
    case 'ECONNREFUSED':
      return `nothing listens on ${host}:${port} — confirm ${service} is running and the port matches`
    case 'EHOSTUNREACH':
      return `host ${host} is unreachable — check route, VPN, or security group`
    case 'ENOTFOUND':
      return `DNS lookup failed for ${host} — check /etc/hosts or DNS`
    case 'ETIMEDOUT':
      return `TCP connect timed out — likely a firewall blocking ${host}:${port}`
    default:
      return `TCP connect failed (code=${code}) — re-check ${service} host/port`
  }
}

async function checkPostgresTcp(pg, opts, summary) {
  if (opts.skipTcp) {
    addCheck(summary, 'pg.tcp-reachable', 'Postgres TCP reachable', 'skip', { reason: '--skip-tcp' })
    return
  }
  if (!pg) {
    addCheck(summary, 'pg.tcp-reachable', 'Postgres TCP reachable', 'skip', { reason: 'DATABASE_URL not set' })
    return
  }
  const result = await tcpProbe({ host: pg.host, port: pg.port, timeoutMs: opts.timeoutMs })
  if (result.ok) {
    addCheck(summary, 'pg.tcp-reachable', `Postgres TCP reachable at ${pg.host}:${pg.port}`, 'pass', {
      host: pg.host,
      port: pg.port,
    })
    return
  }
  addCheck(summary, 'pg.tcp-reachable', `Postgres TCP reachable at ${pg.host}:${pg.port}`, 'fail', {
    host: pg.host,
    port: pg.port,
    code: result.code,
    hint: tcpHint(result.code, pg.host, pg.port, 'Postgres'),
  })
}

function spawnReadOnly(cmd, args, opts) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(cmd, args, opts)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => resolve({
      ok: false,
      code: -1,
      spawnErrorCode: err && err.code ? err.code : null,
      stdout,
      stderr: stderr + (err && err.message ? err.message : String(err)),
    }))
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }))
  })
}

async function checkMigrationAlignment(opts, pg, env, summary) {
  if (opts.skipMigrations) {
    addCheck(summary, 'pg.migrations-aligned', 'Code migrations aligned with DB', 'skip', { reason: '--skip-migrations' })
    return
  }
  if (!pg) {
    addCheck(summary, 'pg.migrations-aligned', 'Code migrations aligned with DB', 'skip', {
      reason: 'DATABASE_URL not set; cannot query kysely_migration',
    })
    return
  }
  const tcpFail = summary.checks.find((c) => c.id === 'pg.tcp-reachable' && c.status === 'fail')
  if (tcpFail) {
    addCheck(summary, 'pg.migrations-aligned', 'Code migrations aligned with DB', 'skip', {
      reason: 'Postgres unreachable; skipping migration query',
    })
    return
  }
  const result = await spawnReadOnly(
    'pnpm',
    ['--silent', '--filter', '@metasheet/core-backend', 'exec', 'tsx', 'src/db/migrate.ts', '--list'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (!result.ok) {
    // ENOENT here means pnpm/tsx isn't on PATH — typical of a stripped-down
    // on-prem box that only has the built artifact, not the full monorepo.
    // That is a legitimate state: skip the alignment check with an actionable
    // reason instead of falsely reporting FAIL.
    if (result.spawnErrorCode === 'ENOENT') {
      addCheck(summary, 'pg.migrations-aligned', 'Code migrations aligned with DB', 'skip', {
        reason: 'pnpm/tsx not on PATH; migration alignment requires the full monorepo checkout',
        hint: 'run this preflight from a workstation that has `pnpm install` completed, or pass --skip-migrations',
      })
      return
    }
    addCheck(summary, 'pg.migrations-aligned', 'Code migrations aligned with DB', 'fail', {
      hint: 'kysely migrate --list failed; the script could not determine alignment',
      exitCode: result.code,
      stderr: redactString(String(result.stderr || '').slice(0, 1500)),
    })
    return
  }
  const out = result.stdout
  const appliedMatch = out.match(/Applied:\s+(\d+)/)
  const pendingMatch = out.match(/Pending:\s+(\d+)/)
  if (!appliedMatch || !pendingMatch) {
    addCheck(summary, 'pg.migrations-aligned', 'Code migrations aligned with DB', 'warn', {
      hint: 'migrate --list succeeded but output format was unexpected; review manually',
      stdoutHead: redactString(String(out).slice(0, 500)),
    })
    return
  }
  const applied = Number.parseInt(appliedMatch[1], 10)
  const pending = Number.parseInt(pendingMatch[1], 10)
  const pendingNamesSection = out.split('Pending migrations')[1] || ''
  const pendingMigrations = pendingNamesSection
    .split('\n')
    .map((l) => l.trim().replace(/^-\s+/, ''))
    .filter((l) => l && !l.endsWith(':'))
    .slice(0, 50)
  addCheck(summary, 'pg.migrations-aligned', 'Code migrations aligned with DB', pending === 0 ? 'pass' : 'warn', {
    applied,
    pending,
    pendingMigrations,
    hint: pending === 0
      ? 'all code-level migrations are applied to the target DB'
      : `DB is behind code by ${pending} migration(s); run \`pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts\` (NOT this script) to apply them`,
  })
}

function checkMockFixtures(summary) {
  const missing = REQUIRED_FIXTURES.filter((f) => !existsSync(path.join(REPO_ROOT, f)))
  addCheck(summary, 'fixtures.k3wise-mock', 'K3 WISE mock fixtures present', missing.length === 0 ? 'pass' : 'fail', {
    requiredFiles: REQUIRED_FIXTURES,
    missing,
    hint: missing.length === 0
      ? 'mock smoke (run-mock-poc-demo.mjs) is runnable offline'
      : 'mock smoke cannot run without these fixtures; restore them before any on-prem test',
  })
}

function checkLiveK3Config(env, mode, summary) {
  if (mode !== 'live') {
    addCheck(summary, 'k3.live-config', 'K3 WISE live endpoint config (only checked in --live)', 'skip', {
      mode: 'mock',
      reason: 'mock mode does not require K3 endpoint or credentials',
    })
    return null
  }
  const apiUrl = (env.K3_API_URL || env.K3_BASE_URL || '').trim()
  const acctId = (env.K3_ACCT_ID || '').trim()
  const username = (env.K3_USERNAME || '').trim()
  const passwordPresent = Boolean((env.K3_PASSWORD || '').trim())

  const missing = []
  if (!apiUrl) missing.push('K3_API_URL')
  if (!acctId) missing.push('K3_ACCT_ID')
  if (!username) missing.push('K3_USERNAME')
  if (!passwordPresent) missing.push('K3_PASSWORD')

  let parsedUrl = null
  if (apiUrl) {
    try {
      const u = new URL(apiUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        missing.push('K3_API_URL (must use http or https)')
      } else {
        parsedUrl = u
      }
    } catch {
      missing.push('K3_API_URL (invalid URL)')
    }
  }

  if (missing.length > 0) {
    addCheck(summary, 'k3.live-config', 'K3 WISE live endpoint config', 'gate-blocked', {
      mode: 'live',
      missing,
      hint: 'live preflight cannot proceed until customer GATE supplies these values',
    })
    return null
  }

  addCheck(summary, 'k3.live-config', 'K3 WISE live endpoint config', 'pass', {
    // Some K3 deployments place auth tokens in the API URL query string. Store
    // a sanitized form so the raw token never lands in preflight.json. The
    // unsanitized URL is still used live for the host:port TCP probe via
    // parsedUrl.hostname/port; it is never persisted.
    apiUrl: sanitizeUrl(apiUrl),
    acctId,
    usernamePresent: true,
    passwordPresent: true,
  })
  return parsedUrl
}

async function checkLiveK3Reachable(parsedUrl, mode, opts, summary) {
  if (mode !== 'live') {
    addCheck(summary, 'k3.live-reachable', 'K3 WISE endpoint TCP reachable (only checked in --live)', 'skip', {
      reason: 'mock mode',
    })
    return
  }
  if (!parsedUrl) {
    addCheck(summary, 'k3.live-reachable', 'K3 WISE endpoint TCP reachable', 'skip', {
      reason: 'K3 endpoint config missing or invalid (gated upstream)',
    })
    return
  }
  const host = parsedUrl.hostname
  const port = Number.parseInt(parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80'), 10)
  const result = await tcpProbe({ host, port, timeoutMs: opts.timeoutMs })
  if (result.ok) {
    addCheck(summary, 'k3.live-reachable', `K3 WISE endpoint TCP reachable at ${host}:${port}`, 'pass', { host, port })
    return
  }
  addCheck(summary, 'k3.live-reachable', `K3 WISE endpoint TCP reachable at ${host}:${port}`, 'fail', {
    host,
    port,
    code: result.code,
    hint: tcpHint(result.code, host, port, 'K3 WISE WebAPI'),
  })
}

function checkGateFile(opts, summary) {
  if (!opts.gateFile) {
    if (opts.mode === 'live') {
      addCheck(summary, 'gate.file-present', 'GATE answer file present (--gate-file)', 'gate-blocked', {
        mode: 'live',
        hint: 'live preflight requires --gate-file <path>; produce one via integration-k3wise-live-poc-preflight.mjs --print-sample',
      })
    } else {
      addCheck(summary, 'gate.file-present', 'GATE answer file present', 'skip', { mode: 'mock' })
    }
    return
  }
  const resolved = path.resolve(opts.gateFile)
  if (!existsSync(resolved)) {
    addCheck(summary, 'gate.file-present', 'GATE answer file present', 'fail', {
      path: resolved,
      hint: 'path does not exist',
    })
    return
  }
  addCheck(summary, 'gate.file-present', 'GATE answer file present', 'pass', { path: resolved })
}

function renderMarkdown(summary) {
  const lines = [
    '# K3 PoC On-Prem Preflight',
    '',
    `- Generated: ${summary.generatedAt}`,
    `- Mode: \`${summary.mode}\``,
    `- Decision: **${summary.decision}** (exit ${summary.exitCode})`,
    '',
    '## Decision Code Map',
    '',
    '- `0` PASS — safe to proceed with on-prem PoC test',
    '- `1` FAIL — mandatory env defect (fix before continuing)',
    '- `2` GATE_BLOCKED — customer GATE answers / config still required (live only)',
    '',
    '## Checks',
    '',
    '| ID | Status | Label |',
    '|---|---|---|',
    ...summary.checks.map((c) => `| \`${c.id}\` | ${c.status} | ${escapePipes(c.label)} |`),
    '',
    '## Details',
    '',
  ]
  for (const c of summary.checks) {
    lines.push(`### \`${c.id}\` — ${c.status}`, '', `- ${c.label}`)
    for (const [k, v] of Object.entries(c.details || {})) {
      lines.push(`- ${k}: ${formatValue(v)}`)
    }
    lines.push('')
  }
  lines.push(
    '## Safety Notes',
    '',
    '- Read-only: no DB writes, no migration runs, no K3 write calls.',
    '- Mock mode does not require any K3 endpoint or credentials.',
    '- Live mode performs only a TCP-level reachability probe on the K3 endpoint host:port; it does NOT call the K3 API.',
    '- Secrets are redacted in all output paths — stdout/MD via `redactString` and preflight.json via `sanitizeUrl` at storage time. Covered: DATABASE_URL / K3_API_URL userinfo password; query params keyed `access_token` / `token` / `password` / `secret` / `sign(ature)` / `api_key` / `session_id` / `auth`; `Bearer …` headers; `eyJ…` JWT-shaped tokens; K3_PASSWORD value.',
    '',
  )
  return lines.join('\n') + '\n'
}

function escapePipes(value) {
  return String(value).replaceAll('|', '\\|')
}

function formatValue(v) {
  if (v == null) return '`<null>`'
  if (Array.isArray(v)) return v.length ? v.map((x) => `\`${redactString(String(x))}\``).join(', ') : '`(none)`'
  if (typeof v === 'object') return '`' + redactString(JSON.stringify(v)) + '`'
  return '`' + redactString(String(v)) + '`'
}

function makeRunId(now = new Date()) {
  return `k3wise-onprem-preflight-${now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
}

function renderConsole(summary) {
  const lines = [
    `integration-k3wise-onprem-preflight: ${summary.decision} (exit ${summary.exitCode}, mode=${summary.mode})`,
  ]
  for (const c of summary.checks) {
    const detail = c.details && (c.details.hint || c.details.reason)
    const tail = detail ? ` — ${redactString(detail)}` : ''
    lines.push(`  [${c.status.padEnd(13)}] ${c.id}${tail}`)
  }
  return lines.join('\n') + '\n'
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/ops/integration-k3wise-onprem-preflight.mjs [options]

Read-only preflight for the K3 WISE PoC on-prem deployment. Default mock mode
does NOT require K3 endpoint or credentials. Use --live ONLY after the customer
GATE has supplied real K3 answers.

Options:
  --mock                  (default) skip live K3 endpoint and gate-file checks
  --live                  require K3_API_URL/K3_ACCT_ID/K3_USERNAME/K3_PASSWORD
                          and TCP-reach the K3 endpoint host:port
  --gate-file <path>      Path to GATE answer JSON (required for --live)
  --out-dir <dir>         Override artifact directory
  --timeout-ms <ms>       TCP probe timeout (default ${DEFAULT_TIMEOUT_MS}, range 100..120000)
  --skip-tcp              Skip Postgres TCP probe
  --skip-migrations       Skip kysely migration-alignment query
  --help, -h              Show this help

Exit codes:
  0  PASS
  1  FAIL          mandatory env defect (DATABASE_URL/JWT_SECRET/Postgres/fixtures)
  2  GATE_BLOCKED  customer GATE config still required (live mode)

This script does NOT mutate the database, run migrations, or call K3 WebAPI.
`)
}

async function runPreflight(env, opts) {
  const summary = {
    tool: 'integration-k3wise-onprem-preflight',
    runId: makeRunId(),
    generatedAt: new Date().toISOString(),
    mode: opts.mode,
    checks: [],
    decision: 'FAIL',
    exitCode: 1,
  }

  const pg = checkDatabaseUrl(env, summary)
  checkJwtSecret(env, summary)
  await checkPostgresTcp(pg, opts, summary)
  await checkMigrationAlignment(opts, pg, env, summary)
  checkMockFixtures(summary)
  const k3Url = checkLiveK3Config(env, opts.mode, summary)
  await checkLiveK3Reachable(k3Url, opts.mode, opts, summary)
  checkGateFile(opts, summary)

  const { decision, exitCode } = classifyChecks(summary.checks)
  summary.decision = decision
  summary.exitCode = exitCode
  return summary
}

function writeOutputs(summary, outputDir) {
  mkdirSync(outputDir, { recursive: true })
  const jsonPath = path.join(outputDir, 'preflight.json')
  const mdPath = path.join(outputDir, 'preflight.md')
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + '\n', 'utf8')
  writeFileSync(mdPath, renderMarkdown(summary), 'utf8')
  return { jsonPath, mdPath }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`[integration-k3wise-onprem-preflight] ERROR: ${redactString(err.message)}\n`)
    return 1
  }
  if (opts.help) {
    printHelp()
    return 0
  }

  const summary = await runPreflight(env, opts)
  const outputDir = opts.outputDir
    ? path.resolve(opts.outputDir)
    : path.join(REPO_ROOT, DEFAULT_OUTPUT_ROOT, summary.runId)
  const written = writeOutputs(summary, outputDir)

  process.stdout.write(renderConsole(summary))
  process.stdout.write(`json: ${path.relative(REPO_ROOT, written.jsonPath) || written.jsonPath}\n`)
  process.stdout.write(`md:   ${path.relative(REPO_ROOT, written.mdPath) || written.mdPath}\n`)
  return summary.exitCode
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null
const isEntry = entryPath && entryPath === fileURLToPath(import.meta.url)
if (isEntry) {
  main().then((code) => {
    process.exitCode = code
  }).catch((err) => {
    process.stderr.write(`[integration-k3wise-onprem-preflight] ERROR: ${redactString(err && err.message ? err.message : String(err))}\n`)
    process.exitCode = 1
  })
}

export {
  classifyChecks,
  main,
  maskedDatabaseUrl,
  parseArgs,
  redactString,
  renderConsole,
  renderMarkdown,
  runPreflight,
  sanitizeUrl,
  tcpProbe,
}
