/**
 * Attendance Windows-native QA v2 — shared harness runtime helpers.
 *
 * Draft/HOLD. Synthetic data only. No deployment/staging authorization.
 * Pinned product SOURCE_SHA: 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b (unchanged by QA tooling).
 *
 * PACKAGED-RUNTIME RESOLUTION (owner Fix 4 + scope ruling B): the Windows on-prem package ships
 * the COMPILED runtime `packages/core-backend/dist` (scripts/ops/attendance-onprem-package-build.sh
 * + `pnpm --filter @metasheet/core-backend build`). core-backend's tsconfig has `rootDir: "."` and
 * `outDir: "dist"`, so tsc emits `dist/src/<subpath>.js` — NOT `dist/<subpath>.js`. The runtime
 * MODE therefore determines the ONE path (no cross-mode fallback, no symlinks):
 *   - tsx-src   (macOS proof, `node --import tsx` / the tsx CLI): `src/<subpath>.ts`
 *   - node-dist (Windows host / plain node):                      `dist/src/<subpath>.js`
 * If the mode's path is missing the resolver FAILS with a mode-specific instruction — it never
 * silently falls through to the other mode's path, and it REJECTS any resolution that traverses a
 * symlink (the historical `ln -sfn` dist workaround is both unnecessary and forbidden).
 *
 * SINGLE-INSTANCE LOADING (scope ruling B): importProduct loads product modules through ONE
 * pipeline — a CJS `require` rooted at the core-backend package — in BOTH modes. Product modules
 * compile to CommonJS and guard their witness objects with module-PRIVATE WeakSets
 * (w4c0-identity.ts). On Node 20, tsx's ESM loader materialises an ESM-`import()`ed CJS-package
 * `.ts` as an inline `data:text/javascript` CommonJS translation, which does NOT share the plain
 * require cache — so the harness's dynamically imported `w4c0-identity` was a SECOND instance:
 * witnesses minted by it were rejected by the product-internal instance with
 * W4C0_OPERATION_WITNESS_REQUIRED. Requiring through the one CJS cache (path-keyed, symlink-
 * resolving) collapses harness and product-internal edges onto the same module instances.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
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

export function runningUnderTsx() {
  // tsx registers its loaders via `--import tsx` / NODE_OPTIONS / its own CLI (which re-execs node
  // with the loader on execArgv). These are the REAL registration channels; scanning process.argv
  // (script arguments) was a false-positive hazard (any argument containing "tsx" flipped the mode)
  // and is deliberately NOT consulted. QA_FORCE_TSX=1 remains an explicit test override.
  return (
    process.env.QA_FORCE_TSX === '1' ||
    (typeof process.env.NODE_OPTIONS === 'string' && /tsx/.test(process.env.NODE_OPTIONS)) ||
    // tsx sets this in child processes it spawns.
    Boolean(process.env.TSX) ||
    process.execArgv.some((a) => /tsx/.test(a))
  )
}

/** The ONE runtime mode: 'tsx-src' (macOS tsx proof) or 'node-dist' (Windows / plain node). */
export function productModuleMode() {
  return runningUnderTsx() ? 'tsx-src' : 'node-dist'
}

/**
 * Reject a resolution that traverses a symlink: every path component from `root` (inclusive) down
 * to the resolved file (inclusive) must be a real directory/file, not a symlink. This makes the
 * historical `ln -sfn` out-of-repo dist workaround impossible — a symlinked dist/, dist/src/, a
 * symlinked module file, or a wholesale-symlinked core-backend all REFUSE. Components ABOVE `root`
 * are deliberately not checked (macOS /tmp is itself a symlink; a worktree may live under one).
 */
function assertNoSymlinkedResolution(root, absPath) {
  const rel = path.relative(root, absPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing: resolved product path ${absPath} escapes the package root ${root}.`)
  }
  const steps = [root]
  let cur = root
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part)
    steps.push(cur)
  }
  for (const step of steps) {
    const st = fs.lstatSync(step)
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing: product-module resolution traverses a SYMLINK at ${step}. The harness forbids ` +
          `symlinked product paths (the old \`ln -sfn\` dist workaround is obsolete — the resolver ` +
          `now uses the real tsc layout dist/src/<subpath>.js). Remove the symlink.`,
      )
    }
  }
}

/**
 * Resolve a core-backend module subpath (e.g. 'attendance/w4c3a-rollout-control') to the ONE
 * absolute file path for the current runtime mode (owner scope ruling B):
 *   tsx-src   -> <core-backend>/src/<subpath>.ts
 *   node-dist -> <core-backend>/dist/src/<subpath>.js   (the real tsc rootDir:"." layout)
 * Missing path => mode-specific error; NEVER falls through to the other mode's path. Any symlink
 * on the resolution path => refuse. `opts` ({ mode, coreBackendRoot }) is injectable for tests.
 */
export function resolveProductModule(subpath, opts = {}) {
  const mode = opts.mode ?? productModuleMode()
  const root = opts.coreBackendRoot ?? CORE_BACKEND
  if (mode !== 'tsx-src' && mode !== 'node-dist') {
    throw new Error(`Unknown product-module mode "${mode}" (expected tsx-src or node-dist).`)
  }
  const rel = mode === 'tsx-src'
    ? path.join('src', `${subpath}.ts`)
    : path.join('dist', 'src', `${subpath}.js`)
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) {
    if (mode === 'tsx-src') {
      throw new Error(
        `tsx-src mode: product source ${abs} is missing. This mode runs the harness under tsx ` +
          `against the TypeScript source (node --import tsx <harness>.mjs) — it does NOT fall back ` +
          `to dist. If you meant to run the packaged runtime, run under plain node instead.`,
      )
    }
    throw new Error(
      `node-dist mode: compiled module ${abs} is missing. This mode runs against the built ` +
        `package (tsc emits dist/src/<subpath>.js) — it does NOT fall back to the .ts source. ` +
        `Build it first (pnpm --filter @metasheet/core-backend build), or run the macOS source ` +
        `proof under tsx (node --import tsx <harness>.mjs).`,
    )
  }
  assertNoSymlinkedResolution(root, abs)
  return abs
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
  // ONE loading pipeline in BOTH modes: CJS require rooted at the core-backend package. Product
  // modules are CommonJS (compiled and source alike); requiring them keeps every edge — harness
  // AND product-internal — in the single path-keyed require cache, so module-private witness
  // WeakSets (w4c0-identity.ts) exist exactly once. Dynamically `import()`ing the same file gave
  // tsx's ESM pipeline on Node 20 a SECOND instance (inline data:-URL CommonJS translation) and
  // produced W4C0_OPERATION_WITNESS_REQUIRED at the product's witness checks.
  return requireFromCore(resolveProductModule(subpath))
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
