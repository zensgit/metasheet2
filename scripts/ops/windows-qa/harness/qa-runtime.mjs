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
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  MACHINE_EVIDENCE_PRODUCER,
  MACHINE_EVIDENCE_SCHEMA,
  validateMachineEvidence,
} from './machine-evidence-contract.mjs'

export const PINNED_SHA = '0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b'

const SHA40 = /^[0-9a-f]{40}$/

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

/**
 * Owner Fix 5 (version-binding). The harnesses ship IN the on-prem ZIP (see
 * attendance-onprem-package-build.sh), so a packaged copy carries a `SOURCE_SHA` file at the package
 * root next to this tree. If that file is present, the harness's PINNED_SHA MUST equal it — otherwise
 * the shipped harnesses drifted from the packaged product and any evidence they write would attest the
 * wrong SHA. In a source checkout there is no SOURCE_SHA file, so this is a no-op (the runner still
 * binds the package SHA independently). `root` is injectable for tests.
 */
export function assertHarnessBoundToPackageSha(root = REPO_ROOT) {
  const sourceShaFile = path.join(root, 'SOURCE_SHA')
  if (!fs.existsSync(sourceShaFile)) return { checked: false }
  const packageSha = fs.readFileSync(sourceShaFile, 'utf8').trim().toLowerCase()
  if (packageSha !== PINNED_SHA) {
    throw new Error(
      `Harness/package SHA drift: this harness is pinned to ${PINNED_SHA} but the package SOURCE_SHA is ` +
        `${packageSha}. Re-ship the QA harnesses bound to the packaged product SHA before running.`,
    )
  }
  return { checked: true, packageSha }
}

export async function importProduct(subpath) {
  // Fail closed on a harness/package SHA drift before touching any product code.
  assertHarnessBoundToPackageSha()
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
  let hostParams = []
  try {
    const u = new URL(cs)
    host = u.hostname || ''
    dbName = decodeURIComponent((u.pathname || '').replace(/^\//, ''))
    // libpq honours a `host=` connection param (a hostname OR a unix-socket directory). It is a
    // real host channel, so it must be validated too — collect every occurrence.
    hostParams = u.searchParams.getAll('host')
  } catch {
    throw new Error(`DATABASE_URL is not a parseable URL: refusing. (${cs.slice(0, 24)}...)`)
  }
  // Owner P1 (remote-DROP host-guard bypass): decide "local" from the PARSED host(s) ONLY — never a
  // substring of the whole connection string. The old check was `cs.includes('host=/')`, which was
  // defeated by putting `host=/tmp` anywhere in a REMOTE url — a query param, the password, or the
  // dbname (e.g. postgres://user@evil.example/db?application_name=host=/tmp): the substring matched,
  // the url was accepted as "local", and reset-isolated-db then connected to evil.example and ran
  // DROP DATABASE. Instead, gather EVERY candidate host — the URL authority host AND each `host`
  // query param — and require ALL of them to be local. An empty URL host with no host param is the
  // loopback/unix-socket default and cannot denote a remote server.
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  const hostIsLocal = (h) => localHosts.has(h) || h.startsWith('/') // a unix-socket path is local
  const candidateHosts = []
  if (host !== '') candidateHosts.push(host)
  for (const hp of hostParams) candidateHosts.push(hp)
  const isLocal = candidateHosts.length === 0 || candidateHosts.every(hostIsLocal)
  if (!isLocal) {
    const bad = candidateHosts.filter((h) => !hostIsLocal(h)).join(', ')
    throw new Error(
      `Refusing: DATABASE_URL host(s) "${bad}" not local (only localhost/127.0.0.1/::1/unix-socket path).`,
    )
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

/**
 * Owner P2 — resolve the QA tooling SHA the harness stamps into machine evidence. Order:
 *   1. env `QA_TOOLING_SHA` (explicit; the macOS source spine sets this),
 *   2. the package-root `QA_TOOLING_SHA` file (the Windows on-prem package ships it),
 *   3. the pinned product SHA as a LAST-RESORT default (the package build defaults QA_TOOLING_SHA to
 *      SOURCE_SHA). The `source` is returned + recorded in the envelope so nothing silently claims a
 *      tooling binding it merely defaulted into (the product-SHA default is transparent, not hidden).
 * Returns `{ sha, source }`.
 */
export function resolveQaToolingSha(root = REPO_ROOT) {
  const env = typeof process.env.QA_TOOLING_SHA === 'string' ? process.env.QA_TOOLING_SHA.trim().toLowerCase() : ''
  if (SHA40.test(env)) return { sha: env, source: 'env' }
  const file = path.join(root, 'QA_TOOLING_SHA')
  if (fs.existsSync(file)) {
    const v = fs.readFileSync(file, 'utf8').trim().toLowerCase()
    if (SHA40.test(v)) return { sha: v, source: 'package-file' }
  }
  return { sha: PINNED_SHA, source: 'product-sha-default' }
}

const RUN_ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z._-]{7,63}$/
const RUN_ID_FILE = path.join(HERE, '.runtime', 'run-id')

/**
 * Owner runId binding — resolve the ONE campaign runId every evidence record (machine + operator) and
 * artifact manifest entry in a run must carry, so the runner can reject a same-product-SHA record
 * spliced in from a DIFFERENT run. Order: env `QA_RUN_ID` (operator/CI sets it), then the persisted
 * `.runtime/run-id` (so the harnesses in one campaign agree without an env), else a freshly minted
 * `run-<uuid>` written to that file. The file lives under the gitignored `.runtime` tree.
 */
export function resolveRunId() {
  const env = typeof process.env.QA_RUN_ID === 'string' ? process.env.QA_RUN_ID.trim() : ''
  if (RUN_ID_RE.test(env)) return env
  try {
    if (fs.existsSync(RUN_ID_FILE)) {
      const v = fs.readFileSync(RUN_ID_FILE, 'utf8').trim()
      if (RUN_ID_RE.test(v)) return v
    }
  } catch {
    /* fall through to mint */
  }
  const minted = `run-${crypto.randomUUID()}`
  try {
    fs.mkdirSync(path.dirname(RUN_ID_FILE), { recursive: true })
    fs.writeFileSync(RUN_ID_FILE, `${minted}\n`)
  } catch {
    /* best-effort persistence; the value is still returned */
  }
  return minted
}

/**
 * Owner P1 — build the STRUCTURED machine-evidence envelope a harness emits for a PASS-eligible case.
 * It carries machine facts (asserted row counts, entity UUIDs), the harness's OWN determination, the
 * producing harness module, and the QA tooling SHA the harness ran as. The runner requires this shape
 * for a PASS (see machine-evidence-contract.validateMachineEvidence) and binds `qaToolingSha` to the
 * package QA_TOOLING_SHA. A JSON file is copyable, so this is NOT forgery-proof — it raises the bar
 * from "any long string an operator can hand-type" to "a structured record a harness produces".
 */
export function buildMachineEvidence({ caseId, harnessModule, determination, facts }) {
  const tooling = resolveQaToolingSha()
  const envelope = {
    schema: MACHINE_EVIDENCE_SCHEMA,
    producedBy: MACHINE_EVIDENCE_PRODUCER,
    caseId: caseId ? String(caseId) : undefined,
    runId: resolveRunId(),
    harnessModule: String(harnessModule || ''),
    determination: String(determination || ''),
    qaToolingSha: tooling.sha,
    qaToolingShaSource: tooling.source,
    facts: facts && typeof facts === 'object' ? facts : {},
    producedAt: new Date().toISOString(),
  }
  // Owner P1 — self-validate the envelope shape (case→harness whitelist + exact facts schema) at EMIT
  // time so any drift between what the harness asserts and the contract fails LOUDLY here, rather than
  // silently getting REJECTED by the runner on the Windows host. The tooling binding is not enforced
  // here (that is the runner's package<->evidence check); pass caseId so the right schema is selected.
  if (caseId) {
    const check = validateMachineEvidence(envelope, { caseId })
    if (!check.ok) {
      throw new Error(`buildMachineEvidence produced an envelope the contract rejects for ${caseId}: ${check.error}`)
    }
  }
  return envelope
}

/** Read-modify-write the evidence-dir summary.json, upserting this case (harness-produced verdict). */
export function emitCaseEvidence(evidenceDir, caseObj) {
  if (!caseObj || !caseObj.id) throw new Error('emitCaseEvidence requires a case with an id')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const summaryPath = path.join(evidenceDir, 'summary.json')
  const runId = resolveRunId()
  let summary = {
    campaign: 'attendance-windows-native-qa-v2-20260804',
    sourceSha: PINNED_SHA,
    runId,
    residue: null,
    cases: [],
  }
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
  // Owner runId binding — the summary carries the ONE campaign runId every evidence record + artifact
  // in this run must match. Stamp it (the machineEvidence the 09/10 harnesses emit uses the same runId).
  summary.runId = runId
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  return summaryPath
}

export const DEFAULT_EVIDENCE_DIR = path.join(HERE, '.runtime', 'evidence')
