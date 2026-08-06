/**
 * Attendance Windows-native QA v2 — shared harness runtime helpers.
 *
 * Draft/HOLD. Synthetic data only. No deployment/staging authorization.
 * Pinned product SOURCE_SHA: 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b (unchanged by QA tooling).
 *
 * PACKAGED-RUNTIME RESOLUTION (owner Fix 4): the Windows on-prem package ships the COMPILED
 * runtime `packages/core-backend/dist` (scripts/ops/attendance-onprem-package-build.sh:45 +
 * `pnpm --filter @metasheet/core-backend build`). So on the Windows host the harness imports the
 * built `dist/**.js`. On macOS the proof runs against SOURCE via tsx (allowed by Fix 4). This
 * resolver prefers dist and falls back to the .ts source; under a non-tsx `node` with only source
 * present it throws a clear instruction rather than a cryptic ESM error.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PINNED_SHA = '0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// harness dir is <root>/scripts/ops/windows-qa/harness — repo/package root is 4 levels up.
export const REPO_ROOT = path.resolve(HERE, '../../../..')
export const CORE_BACKEND = path.join(REPO_ROOT, 'packages/core-backend')

// `pg` ships in the core-backend package (and in the Windows on-prem package alongside dist).
// Resolve it from there explicitly so these scripts work regardless of cwd / NODE_PATH.
const requireFromCore = createRequire(path.join(CORE_BACKEND, 'package.json'))
export function loadPg() {
  return requireFromCore('pg')
}

function runningUnderTsx() {
  // tsx registers a loader; its presence is what lets `import('*.ts')` resolve.
  return (
    process.env.QA_FORCE_TSX === '1' ||
    (typeof process.env.NODE_OPTIONS === 'string' && /tsx/.test(process.env.NODE_OPTIONS)) ||
    // tsx sets this in child processes it spawns.
    Boolean(process.env.TSX) ||
    // Heuristic: tsx injects itself into module resolution; check for its loader on argv/execArgv.
    process.execArgv.some((a) => /tsx/.test(a)) ||
    (Array.isArray(process.argv) && process.argv.some((a) => /tsx/.test(a)))
  )
}

/**
 * Resolve a core-backend module subpath (e.g. 'attendance/w4c3a-rollout-control') to a file URL:
 * dist .js first (Windows package), then src .ts (macOS/tsx proof).
 */
export function resolveProductModule(subpath) {
  const distJs = path.join(CORE_BACKEND, 'dist', `${subpath}.js`)
  if (fs.existsSync(distJs)) return pathToFileURL(distJs).href
  const srcTs = path.join(CORE_BACKEND, 'src', `${subpath}.ts`)
  if (fs.existsSync(srcTs)) {
    if (!runningUnderTsx()) {
      throw new Error(
        `Only the TypeScript source of "${subpath}" is present (no dist build). Run this harness ` +
          `under tsx, e.g.:\n  node --import tsx <harness>.mjs\n` +
          `or build the package first (pnpm --filter @metasheet/core-backend build) to ship dist.`,
      )
    }
    return pathToFileURL(srcTs).href
  }
  throw new Error(`Cannot resolve product module "${subpath}" (looked in dist/ and src/).`)
}

export async function importProduct(subpath) {
  return import(resolveProductModule(subpath))
}

/** The operator-set synthetic login password (owner security boundary: env only, never committed). */
export function readSyntheticPassword() {
  const pw = process.env.QA_SYNTH_PASSWORD
  if (typeof pw !== 'string' || pw.trim().length === 0) {
    throw new Error(
      'QA_SYNTH_PASSWORD is not set. Provisioning needs the operator-set synthetic password in the ' +
        'environment (it is NEVER committed). Set it before running, e.g. QA_SYNTH_PASSWORD=... node ...',
    )
  }
  return pw
}

/** Load the runtime identity map written by the provisioner (ids ONLY — no secrets). */
export function loadIdentities(identitiesPath) {
  if (!fs.existsSync(identitiesPath)) {
    throw new Error(
      `Missing identity map ${identitiesPath}. Run provision-synth-directory.mjs first (it creates the ` +
        `synthetic users through the product path and captures the minted ids here).`,
    )
  }
  const parsed = JSON.parse(fs.readFileSync(identitiesPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || !parsed.orgs || !parsed.users) {
    throw new Error(`Identity map ${identitiesPath} is malformed (expected {orgs, users}).`)
  }
  return parsed
}

export const DEFAULT_IDENTITIES_PATH = path.join(HERE, '.runtime', 'qa-identities.json')

export function parseArg(flag, fallback) {
  const idx = process.argv.indexOf(flag)
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1]
  return fallback
}

/**
 * Owner gate 4 — DB reset/write safety: refuse to touch anything but the local isolated DB.
 * Parses the ACTUAL connection config (not an env-string match) and verifies the live database
 * name is exactly metasheet_windows_qa and the host is local.
 */
export function assertLocalIsolatedTarget(connectionString) {
  const cs = connectionString || process.env.DATABASE_URL || ''
  if (!cs) throw new Error('DATABASE_URL is not set; refusing to run against an unknown target.')
  let host = ''
  let dbName = ''
  try {
    const u = new URL(cs)
    host = u.hostname || ''
    dbName = decodeURIComponent((u.pathname || '').replace(/^\//, ''))
  } catch {
    throw new Error(`DATABASE_URL is not a parseable URL: refusing. (${cs.slice(0, 24)}...)`)
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', ''])
  const isLocal = localHosts.has(host) || cs.includes('host=/') || host.startsWith('/')
  if (!isLocal) {
    throw new Error(`Refusing: DATABASE_URL host "${host}" is not local (localhost/127.0.0.1/socket).`)
  }
  if (dbName !== 'metasheet_windows_qa') {
    throw new Error(`Refusing: DATABASE_URL database "${dbName}" is not the isolated metasheet_windows_qa.`)
  }
  return { host, dbName }
}

/** Open a single pg Client on the isolated DB, asserting the live database is metasheet_windows_qa. */
export async function openIsolatedClient() {
  assertLocalIsolatedTarget()
  const pg = loadPg()
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const r = await client.query('SELECT current_database() AS db')
  if (r.rows[0]?.db !== 'metasheet_windows_qa') {
    await client.end()
    throw new Error(`Refusing: connected database is "${r.rows[0]?.db}", not metasheet_windows_qa.`)
  }
  return client
}

/** Open a pg Pool on the isolated DB (for product fns that take a Pool with .connect()). */
export async function openIsolatedPool() {
  assertLocalIsolatedTarget()
  const pg = loadPg()
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const c = await pool.connect()
  try {
    const r = await c.query('SELECT current_database() AS db')
    if (r.rows[0]?.db !== 'metasheet_windows_qa') {
      throw new Error(`Refusing: connected database is "${r.rows[0]?.db}", not metasheet_windows_qa.`)
    }
  } finally {
    c.release()
  }
  return pool
}

/**
 * Shared safety fields the harness can LEGITIMATELY attest (it touched only synthetic ids on the
 * isolated DB and made no external call). `windowsPowerShellVersion` is a host fact the harness
 * cannot know off-Windows — the operator affirms it; `hostPlatform` is auto-detected. On macOS this
 * yields hostPlatform!='windows' + empty PS version, so the (hardened) runner still BLOCKS even a
 * PASS-status case until the Windows operator re-runs it and affirms the host facts. That is the
 * honest split: the harness proves product logic; the final PASS needs the Windows host.
 */
export function baseSafetyFields() {
  return {
    syntheticDataOnly: true,
    sourceSha: PINNED_SHA,
    isolatedDatabase: true,
    databaseName: 'metasheet_windows_qa',
    hostPlatform: os.platform() === 'win32' ? 'windows' : os.platform(),
    windowsPowerShellVersion: '',
    customerOrExternalDestination: false,
    externalNotificationsSent: false,
  }
}

/** Read-modify-write the evidence-dir summary.json, upserting this case (harness-produced verdict). */
export function emitCaseEvidence(evidenceDir, caseObj) {
  if (!caseObj || !caseObj.id) throw new Error('emitCaseEvidence requires a case with an id')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const summaryPath = path.join(evidenceDir, 'summary.json')
  let summary = { campaign: 'attendance-windows-native-qa-v2-20260804', sourceSha: PINNED_SHA, residue: null, cases: [] }
  if (fs.existsSync(summaryPath)) {
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    } catch {
      /* start fresh on a corrupt file */
    }
  }
  if (!Array.isArray(summary.cases)) summary.cases = []
  const merged = { ...baseSafetyFields(), ...caseObj }
  const idx = summary.cases.findIndex((c) => c && c.id === caseObj.id)
  if (idx >= 0) summary.cases[idx] = merged
  else summary.cases.push(merged)
  summary.sourceSha = PINNED_SHA
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  return summaryPath
}

export const DEFAULT_EVIDENCE_DIR = path.join(HERE, '.runtime', 'evidence')
