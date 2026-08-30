#!/usr/bin/env node
/**
 * stock-prep-acceptance-bootstrap.mjs
 *
 * ONE COMMAND from a freshly deployed instance to a proven-green stock-preparation
 * install, printing PASS/FAIL per acceptance criterion.
 *
 * WHY THIS EXISTS. The whole chain below was driven BY HAND against a live deployment
 * for the first time, and the day was mostly archaeology: two operators independently
 * invented different sandbox table names, the configured pack pointed at a table that
 * did not exist, the apply body was rejected for carrying the dry-run token at the top
 * level, reconcile refused a source that a successful connection test had left
 * `inactive`, and a Postgres source created with quoted CamelCase identifiers read back
 * as "relation does not exist". Every one of those is encoded here as an ordered,
 * individually-reportable, IDEMPOTENT step with a fix hint, so the next customer is one
 * command instead of a day.
 *
 * It is also the intended backend of the one-click install page described in
 * docs/development/platform-overall-design/multitable-application-model-20260830.md
 * (§2: install = preflight + bootstrap + acceptance; the button just chains the three).
 * That document is a DRAFT and this script does not depend on it — the step list here is
 * the contract, and the doc describes the button that will eventually call it.
 *
 * ---------------------------------------------------------------------------
 * THE STEPS (each one verified live; each one re-runnable)
 * ---------------------------------------------------------------------------
 *   1 preflight             GET  /integration/stock-preparation/preflight  (#5345)
 *                           Every blocker is printed with its own paste-able `fix.run`,
 *                           and the route's SERVER-side `posture` block is what this
 *                           report carries. On a deployment that predates the route the
 *                           step degrades to SKIP, never a FAIL, and falls back to the
 *                           only posture a client can see — its own environment.
 *   2 managed-tables        POST /integration/stock-preparation/confirmation-decisions/ensure {}
 *                           POST /integration/stock-preparation/sandbox-target/ensure { objectId }
 *                           The objectId comes from the CONFIGURED PACK's declared
 *                           `targetObjectId` and is never invented, never taken from
 *                           env, and never taken from argv. It is validated by the
 *                           server's own `assertSandboxObjectId`, imported rather than
 *                           re-implemented, so the `plm_stock_preparation_sandbox`
 *                           namespace rule cannot drift from the route that enforces it.
 *   3 customer-pack         POST /integration/stock-preparation/customer-packs/:packId/dry-run
 *                           POST /integration/stock-preparation/customer-packs/:packId/install
 *                           then INSTALL AGAIN and assert the re-run is a no-op: zero
 *                           created, zero newly stamped, every field `alreadyStamped`.
 *   4 source-wiring         POST /data-sources (read-only; skipped when the deployment
 *                           already registered it)
 *                           GET  /integration/external-systems/:id — PROBE FIRST. An existing
 *                                system is the deployment's: its kind and its
 *                                config.dataSourceId are ASSERTED, never rewritten (an upsert
 *                                carrying `config` replaces the public half), and only its
 *                                status is moved. Absent, it is created pointing at the data
 *                                source, kind data-source:sql-readonly, status ACTIVE.
 *                           POST /integration/external-systems/:id/test
 *                           GET  /integration/external-systems/:id  -> status must be active.
 *                           RECONCILE REQUIRES ACTIVE; DRY-RUN DOES NOT. A system created
 *                           with the default status stays `inactive` even after a
 *                           successful test (`resolveTestedStatus` deliberately refuses to
 *                           silently enable an intentionally-inactive system), so this step
 *                           sets it explicitly.
 *   5 acceptance-dry-run    POST /integration/table-actions/:actionId/dry-run
 *                           Expects `canApply: true` and a `dryRunToken`.
 *   6 acceptance-apply      POST /integration/table-actions/:actionId/apply
 *                           Body shape is the whole lesson: the apply route's allowlist is
 *                           EXACTLY { parameters, confirm } and the token belongs at
 *                           `confirm.dryRunToken` — a top-level `dryRunToken` is a 400.
 *                           CRITERION 1 is then proven against the TARGET SHEET, not
 *                           against the apply counters: rows exist, every mapped `ext_`
 *                           target is non-empty on at least one row, and every
 *                           `human_preserved` cell is EMPTY on every row.
 *   7 acceptance-idempotent A second dry-run must be all-skip. CRITERION 2.
 *   8 confirmation-queue    reconcile -> values-free queue -> confirm keep_multiple_rows
 *                           -> reconcile again. Optional (MS_SKIP_QUEUE_SMOKE=1), on by
 *                           default. See the E1 note on runConfirmationQueueStep().
 *
 * ---------------------------------------------------------------------------
 * INPUT: ENV ONLY, NEVER ARGV
 * ---------------------------------------------------------------------------
 * argv leaks into process listings and shell history; a bearer token and a database
 * password must not. The ONLY accepted flags are `--dry` (print the plan, call nothing)
 * and `--help`.
 *
 *   MS_API              required  API root INCLUDING /api, e.g. http://127.0.0.1/api
 *   MS_TOKEN            required  admin bearer
 *   MS_PROJECT_NO       required  the `parameters.projectNo` every action call carries
 *   MS_PACK_ID          required  the server-held customer pack id to install
 *   MS_DATA_SOURCE_ID   required  the read-only data source id the external system points at
 *   MS_EXTERNAL_SYSTEM_ID required the external system the TABLE ACTION is configured to read
 *                                 through. Deliberately NOT derived: that binding lives in
 *                                 INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON and the
 *                                 API never exposes it, so a default would be a guess that
 *                                 wires a stray system while the action reads another.
 *   MS_TENANT_ID        optional  sent as x-tenant-id and as ?tenantId where accepted
 *   MS_WORKSPACE_ID     optional  sent as ?workspaceId where accepted
 *   MS_ACTION_ID        optional  default: the plugin's own PLM_STOCK_PREPARATION_ACTION_ID
 *   MS_SKIP_QUEUE_SMOKE optional  '1' turns step 8 off (default: on)
 *   MS_TIMEOUT_MS       optional  per-request timeout, default 20000
 *
 *   Data-source connection settings (ALL optional as a group). Supply them to have this
 *   script register the read-only source; omit them and the script only VERIFIES that
 *   MS_DATA_SOURCE_ID already exists — because the synthetic source is not this script's
 *   job, the deployment supplies its own (see
 *   scripts/ops/fixtures/stock-prep-synthetic-plm/schema.sql for the PLM-shaped tables
 *   and the two gotchas that shape entails).
 *
 *   MS_DS_TYPE (default postgres) · MS_DS_HOST · MS_DS_PORT · MS_DS_DATABASE ·
 *   MS_DS_USER · MS_DS_PASSWORD · MS_DS_SCHEMA · MS_DS_NAME
 *
 * ---------------------------------------------------------------------------
 * VALUES-FREE, AND SELF-CHECKED
 * ---------------------------------------------------------------------------
 * Nothing this script prints is a credential, a hostname or a business value. The output
 * face is: counts, integers, HTTP statuses, closed server tokens, schema ids and FIELD
 * NAMES. Criterion 1 must LOOK at target cells to decide "non-empty" / "empty", and it
 * reduces each one to a boolean the moment it is read; the raw cell never reaches the
 * report object. assertValuesFree() then re-walks the fully-assembled report the way
 * source-discovery-probe.mjs does — it is a self-check on our own output, not a proof
 * the reductions above are bug-free — and REFUSES to print if a scanned value survived.
 * The per-step lines go through the same check before they are emitted, so a failure
 * cannot leak through the streaming half of the output either.
 *
 * ---------------------------------------------------------------------------
 * FENCES: OBSERVED, NEVER TOUCHED
 * ---------------------------------------------------------------------------
 * This script never sets, and never advises setting, INTEGRATION_CORE_B2A_REGISTRY_PATH,
 * INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS, or any production-Apply policy. Posture
 * is REPORTED and the run continues either way — states only, never a path or a value.
 * The preflight's own `posture` block is the source when the route answers (server-side,
 * and it deliberately attaches no `fix` to a fence); the local-environment fallback is
 * labelled `scope: local_process_env` precisely because it is the weaker reading.
 *
 * Exit codes:
 *   0  every step OK or SKIP
 *   1  a step FAILed, or the values-free self-check refused to print
 *   2  required input missing / invalid
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import {
  getObjectFieldId,
  getObjectSheetId,
} from './stock-preparation-derive-target-binding.mjs'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins', 'plugin-integration-core', 'lib')

const nodeRequire = createRequire(import.meta.url)

// IMPORTED, NEVER RESTATED. The human band and the sandbox-namespace rule are the two
// vocabularies this script asserts against; re-typing either here would let it drift
// from the routes that enforce them.
const { HUMAN_PRESERVED_FIELD_IDS } = nodeRequire(path.join(PLUGIN_LIB, 'stock-preparation-templates.cjs'))
const { assertSandboxObjectId } = nodeRequire(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = nodeRequire(path.join(PLUGIN_LIB, 'stock-preparation-table-actions.cjs'))

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL = 'stock-prep-acceptance-bootstrap'
const DEFAULT_TIMEOUT_MS = 20000
const RECORD_PAGE_LIMIT = 500
const RECORD_MAX_PAGES = 20

// The env values a leak would matter for. MS_PACK_ID / MS_DATA_SOURCE_ID /
// MS_EXTERNAL_SYSTEM_ID / MS_ACTION_ID / MS_TENANT_ID are deliberately ABSENT: they are
// ids, and ids are part of this script's declared output face. MS_DS_PORT is absent too
// — a bare port number is neither a credential nor a hostname, and scanning for it would
// collide with the HTTP statuses and counts the report is required to carry.
const SCANNED_ENV_NAMES = Object.freeze([
  'MS_TOKEN',
  'MS_PROJECT_NO',
  'MS_DS_HOST',
  'MS_DS_DATABASE',
  'MS_DS_USER',
  'MS_DS_PASSWORD',
])

const FENCE_ENV_NAMES = Object.freeze([
  'INTEGRATION_CORE_B2A_REGISTRY_PATH',
  'INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS',
])

const STATUS_OK = 'OK'
const STATUS_SKIP = 'SKIP'
const STATUS_FAIL = 'FAIL'

// The exact, closed key set the confirmation-decision queue projection is allowed to
// carry. Step 8 asserts the live response against it: an extra key is how a values-free
// queue stops being one.
const QUEUE_ROW_KEYS = Object.freeze([
  'confirmedAtPresent',
  'confirmedByPresent',
  'conflictType',
  'decisionId',
  'inputFingerprint',
  'notesPresent',
  'resolutionAction',
  'resolvedAuxValuePresent',
  'resolvedValuePresent',
  'sourceRevisionPresent',
  'status',
])

const DUPLICATE_EXPANDED_KEY = 'duplicate_expanded_key'
const KEEP_MULTIPLE_ROWS = 'keep_multiple_rows'

// The ordered plan. `routes` is what --dry prints: templates only, no env values.
const STEP_PLAN = Object.freeze([
  {
    id: 'preflight',
    routes: ['GET /integration/stock-preparation/preflight'],
    note: 'blockers print their paste-able fix.run; posture is reported, never remediated; absent route -> SKIP, never FAIL',
  },
  {
    id: 'managed-tables',
    routes: [
      'POST /integration/stock-preparation/confirmation-decisions/ensure',
      'GET  /integration/stock-preparation/customer-packs',
      'POST /integration/stock-preparation/sandbox-target/ensure',
    ],
    note: 'objectId comes from the pack\'s declared targetObjectId, never invented',
  },
  {
    id: 'customer-pack',
    routes: [
      'POST /integration/stock-preparation/customer-packs/:packId/dry-run',
      'POST /integration/stock-preparation/customer-packs/:packId/install (x2)',
    ],
    note: 'the second install must be a no-op: every field alreadyStamped',
  },
  {
    id: 'source-wiring',
    routes: [
      'GET  /data-sources/:id (POST /data-sources when connection env is supplied)',
      'GET  /integration/external-systems/:id (probe; assert binding, never rewrite it)',
      'POST /integration/external-systems (create when absent; status-only when present)',
      'POST /integration/external-systems/:id/test',
      'GET  /integration/external-systems/:id',
    ],
    note: 'status must end ACTIVE — reconcile requires it, dry-run does not',
  },
  {
    id: 'acceptance-dry-run',
    routes: ['POST /integration/table-actions/:actionId/dry-run'],
    note: 'expects canApply:true and a dryRunToken',
  },
  {
    id: 'acceptance-apply',
    routes: [
      'POST /integration/table-actions/:actionId/apply',
      'GET  /multitable/records?sheetId=...',
    ],
    note: 'CRITERION 1 — token at confirm.dryRunToken; ext_ non-empty, human band EMPTY',
  },
  {
    id: 'acceptance-idempotent',
    routes: ['POST /integration/table-actions/:actionId/dry-run'],
    note: 'CRITERION 2 — the second dry-run is all-skip',
  },
  {
    id: 'confirmation-queue',
    routes: [
      'POST /integration/table-actions/:actionId/confirmation-decisions/reconcile',
      'GET  /integration/stock-preparation/confirmation-decisions',
      'POST /integration/stock-preparation/confirmation-decisions/confirm',
    ],
    note: 'optional (MS_SKIP_QUEUE_SMOKE=1); E1 re-holds are EXPECTED, not failures',
  },
])

const STEP_COUNT = STEP_PLAN.length

// ---------------------------------------------------------------------------
// Sanitizers. Anything response-sourced passes one of these before it can reach the
// report; a foreign shape becomes '<unregistered>' rather than being echoed. This is the
// same posture as the sibling stock-preparation postdeploy smoke: a server that stuffed a
// drawing number into `mode` still cannot get it into this script's output.
// ---------------------------------------------------------------------------

const UNREGISTERED = '<unregistered>'

const TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/
const FIELD_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/
const NUMERIC_PATTERN = /^-?\d+(?:\.\d+)?$/

function safeToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : UNREGISTERED
}

function safeCode(value) {
  return typeof value === 'string' && CODE_PATTERN.test(value) ? value : UNREGISTERED
}

function safeFieldId(value) {
  return typeof value === 'string' && FIELD_ID_PATTERN.test(value) ? value : UNREGISTERED
}

function safeHandle(value) {
  return typeof value === 'string' && HANDLE_PATTERN.test(value) ? value : UNREGISTERED
}

function safeCount(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function safeStatus(value) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n < 1000 ? n : 0
}

// A preflight blocker's `fix.run` — the literal paste-able line the route composed. It is
// values-free by that route's own design (it quotes only deployment-authored ids, env KEY
// names and namespace prefixes), and printing it verbatim is the whole point of the
// route. This bounds its length and strips control characters, and assertValuesFree()
// re-scans it like every other leaf, so a preflight that ever echoed a hostname or a
// credential into a fix line fails this run closed instead of printing it.
function safeFixText(value) {
  if (typeof value !== 'string') return UNREGISTERED
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!cleaned) return UNREGISTERED
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}...` : cleaned
}

// ---------------------------------------------------------------------------
// Values-free self-check (mirrors source-discovery-probe.mjs assertValuesFree)
// ---------------------------------------------------------------------------

function collectStringLeaves(value, out) {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStringLeaves(v, out)
  }
}

/**
 * THE COLLISION FLOOR, and the one honest weakness of a substring self-check.
 *
 * This scan looks for a value ANYWHERE inside the report's string leaves. Below four
 * characters that is dominated by collisions with the report's own required content: a
 * database user named `ro` appears inside the word "from"; the cell value `200` appears
 * inside `http=200`; `2.5` appears inside a revision. Scanning them would fail EVERY
 * clean run closed, which is not a stronger guarantee, it is a broken tool.
 *
 * So: a value is scanned when it is at least four characters AND carries either a
 * non-numeric character or four or more digits. Nothing that is actually a secret — a
 * bearer token, a password, a hostname, a drawing number — is under that floor. A
 * three-character database username is, and this is the compensating control: cell
 * values and connection settings never reach the report BY CONSTRUCTION (they are
 * reduced to booleans and counts where they are read), and this check is the second
 * line, not the first.
 */
function isScannableValue(value) {
  const s = String(value)
  if (s.length < 4) return false
  if (!NUMERIC_PATTERN.test(s)) return true
  return s.replace(/[^0-9]/g, '').length >= 4
}

function assertValuesFree(payload, { env = {}, leakGuardValues = new Set() } = {}) {
  const leaves = []
  collectStringLeaves(payload, leaves)
  const violations = []

  for (const name of SCANNED_ENV_NAMES) {
    const value = env[name]
    if (typeof value !== 'string' || !isScannableValue(value)) continue
    if (leaves.some((leaf) => leaf.includes(value))) {
      violations.push(`env:${name}`)
    }
  }

  for (const value of leakGuardValues) {
    const s = String(value)
    if (!isScannableValue(s)) continue
    if (leaves.some((leaf) => leaf.includes(s))) {
      // One is enough to fail closed. Never enumerate business data into an error.
      violations.push('target-cell-value')
      break
    }
  }

  if (violations.length > 0) {
    throw new Error(`VALUES_FREE_SELF_CHECK_FAILED: output would have leaked: ${violations.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Config (env only)
// ---------------------------------------------------------------------------

export class BootstrapInputError extends Error {
  constructor(message, field) {
    super(message)
    this.name = 'BootstrapInputError'
    this.field = field
  }
}

function requiredEnv(env, name) {
  const value = env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BootstrapInputError(`env ${name} is required`, name)
  }
  return value.trim()
}

function optionalEnv(env, name) {
  const value = env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function readEnvConfig(env = {}) {
  const api = requiredEnv(env, 'MS_API').replace(/\/+$/, '')
  const dataSourceId = requiredEnv(env, 'MS_DATA_SOURCE_ID')
  const host = optionalEnv(env, 'MS_DS_HOST')
  return {
    api,
    token: requiredEnv(env, 'MS_TOKEN'),
    projectNo: requiredEnv(env, 'MS_PROJECT_NO'),
    packId: requiredEnv(env, 'MS_PACK_ID'),
    dataSourceId,
    tenantId: optionalEnv(env, 'MS_TENANT_ID'),
    workspaceId: optionalEnv(env, 'MS_WORKSPACE_ID'),
    actionId: optionalEnv(env, 'MS_ACTION_ID') || PLM_STOCK_PREPARATION_ACTION_ID,
    // REQUIRED, and deliberately not derived. See runSourceWiringStep (b): the action's
    // source binding is server-held config that publicActionMetadata never exposes, so a
    // derived id would be a guess — and a guess here wires a stray system while the action
    // keeps reading a different one.
    externalSystemId: requiredEnv(env, 'MS_EXTERNAL_SYSTEM_ID'),
    queueSmoke: optionalEnv(env, 'MS_SKIP_QUEUE_SMOKE') !== '1',
    timeoutMs: Number(optionalEnv(env, 'MS_TIMEOUT_MS')) > 0 ? Number(env.MS_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    // Present as a group or absent as a group. Absent means "the deployment registered
    // its own source"; this script then only verifies the id resolves.
    connection: host
      ? {
          type: optionalEnv(env, 'MS_DS_TYPE') || 'postgres',
          name: optionalEnv(env, 'MS_DS_NAME') || dataSourceId,
          host,
          port: Number(optionalEnv(env, 'MS_DS_PORT')) || undefined,
          database: optionalEnv(env, 'MS_DS_DATABASE'),
          schema: optionalEnv(env, 'MS_DS_SCHEMA'),
          user: optionalEnv(env, 'MS_DS_USER'),
          password: optionalEnv(env, 'MS_DS_PASSWORD'),
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function buildQuery(config, extra = {}) {
  const params = new URLSearchParams()
  if (config.tenantId) params.set('tenantId', config.tenantId)
  if (config.workspaceId) params.set('workspaceId', config.workspaceId)
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Every plugin and core route in this chain answers with the same envelope:
 *   { ok: true, data: <payload> } | { ok: false, error: { code, message, details } }
 * Only `data` and `error.code` are ever read. `error.message` is deliberately never
 * touched — it can echo request input, which is the one thing this output must not carry.
 */
export async function apiRequest(config, method, pathname, { body, accept = [200], fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const headers = { Authorization: `Bearer ${config.token}` }
    if (config.tenantId) headers['x-tenant-id'] = config.tenantId
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const init = { method, headers, signal: controller.signal }
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await doFetch(`${config.api}${pathname}`, init)
    const text = typeof response.text === 'function' ? await response.text() : ''
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    const envelope = parsed && typeof parsed === 'object' ? parsed : {}
    return {
      status: response.status,
      httpOk: accept.includes(response.status),
      envelopeOk: envelope.ok === true,
      data: envelope.data ?? null,
      errorCode: envelope.error && typeof envelope.error === 'object' ? safeCode(envelope.error.code) : UNREGISTERED,
    }
  } catch (err) {
    // A timeout / socket error is a synthetic status 0. Every assertion downstream is a
    // POSITIVE check on a real field, so this fails the step the same way a bad response
    // would — no separate early-exit branch is needed.
    return { status: 0, httpOk: false, envelopeOk: false, data: null, errorCode: UNREGISTERED, transport: String(err && err.name) }
  } finally {
    clearTimeout(timer)
  }
}

function httpReason(res) {
  return res.status === 0 ? 'transport=failed' : `http=${safeStatus(res.status)} code=${res.errorCode}`
}

// ---------------------------------------------------------------------------
// The four load-bearing rules, each a pure function with its own witnessed-RED test.
// ---------------------------------------------------------------------------

/**
 * RULE: the sandbox objectId comes from the PACK, and from nowhere else.
 *
 * Two operators independently picked different names on the first live install, and the
 * configured pack pointed at a table that did not exist. There is exactly one authority
 * for that id — the pack's declared `targetObjectId` — and this function is the only
 * place this script obtains it. There is deliberately no env var and no flag that can
 * supply one.
 *
 * @param packs  the `data.packs` array from GET /customer-packs (server-held catalog)
 */
export function resolvePackTarget(packs, packId) {
  const list = Array.isArray(packs) ? packs : []
  const pack = list.find((entry) => entry && entry.packId === packId)
  if (!pack) {
    throw new BootstrapInputError(
      `pack ${safeHandle(packId)} is not in the server-held catalog`,
      'PACK_NOT_IN_CATALOG',
    )
  }
  const targetObjectId = pack.targetObjectId
  if (typeof targetObjectId !== 'string' || targetObjectId.trim() === '') {
    throw new BootstrapInputError(
      `pack ${safeHandle(packId)} declares no targetObjectId`,
      'PACK_TARGET_OBJECT_ID_ABSENT',
    )
  }
  // The server's own validator, imported rather than re-implemented. It refuses the
  // production canonical id and anything outside the plm_stock_preparation_sandbox
  // namespace, with the same reason tokens the route would return.
  assertSandboxObjectId(targetObjectId, 'pack.targetObjectId')
  const extensionFields = Array.isArray(pack.extensionFields) ? pack.extensionFields : []
  return {
    packId: pack.packId,
    packVersion: safeCount(pack.packVersion),
    targetObjectId,
    extensionFieldIds: extensionFields.map((f) => safeFieldId(f && f.id)),
    humanExtensionFieldIds: extensionFields
      .filter((f) => f && f.ownership === 'human_preserved')
      .map((f) => safeFieldId(f.id)),
    systemExtensionFieldIds: extensionFields
      .filter((f) => f && f.ownership === 'plm_system')
      .map((f) => safeFieldId(f.id)),
  }
}

/**
 * RULE: the apply body allowlist is EXACTLY { parameters, confirm }, and the dry-run
 * token lives at `confirm.dryRunToken`.
 *
 * A top-level `dryRunToken` is rejected by normalizeTableActionBody with
 * TABLE_ACTION_REQUEST_INVALID before the token is ever looked at — which reads, from the
 * outside, like a bad token rather than a bad body. Building the body here (and nowhere
 * else) is what keeps that lesson encoded.
 */
export function buildApplyBody({ projectNo, dryRunToken }) {
  if (typeof dryRunToken !== 'string' || dryRunToken === '') {
    throw new BootstrapInputError('dryRunToken is required to build an apply body', 'APPLY_TOKEN_ABSENT')
  }
  return { parameters: { projectNo }, confirm: { dryRunToken } }
}

/**
 * CRITERION 1, human half: the machine must never fill the human band.
 *
 * Every `human_preserved` cell must be EMPTY on every written row. Cells are reduced to
 * booleans here and the raw values are handed to the leak guard, never to the report.
 *
 * @param rows        [{ data: { <fieldId|physicalId>: value } }]
 * @param humanFieldIds  logical ids of the human band (canonical 8 + the pack's own)
 * @param physicalIdFor  logicalId -> physical field id
 * @param leakGuardValues  Set the observed cell values are recorded in
 */
export function assertHumanBandEmpty({ rows, humanFieldIds, physicalIdFor, leakGuardValues = new Set() }) {
  const offending = []
  let inspected = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    const data = row && typeof row.data === 'object' && row.data ? row.data : {}
    for (const fieldId of humanFieldIds) {
      const value = readCell(data, fieldId, physicalIdFor)
      inspected += 1
      if (isNonEmptyCell(value)) {
        leakGuardValues.add(String(value))
        if (!offending.includes(fieldId)) offending.push(fieldId)
      }
    }
  }
  return {
    ok: offending.length === 0,
    inspectedCellCount: inspected,
    offendingFieldIds: offending.sort(),
  }
}

/**
 * CRITERION 1, machine half: every MAPPED `ext_` target must be non-empty on at least
 * one written row.
 *
 * A mapping entry whose `sourceColumn` is absent from the source PART row does not fail
 * the run: the cell is simply not produced and the column stays empty, indistinguishable
 * from "the source had no value". That silent mode cost a live afternoon; this is the
 * assertion that names it. It is deliberately "at least one row", not "every row" —
 * per-cell coercion refusals legitimately drop individual cells.
 */
export function assertMappedExtCellsPresent({ rows, mappedFieldIds, physicalIdFor, leakGuardValues = new Set() }) {
  const list = Array.isArray(rows) ? rows : []
  const emptyFieldIds = []
  const nonEmptyFieldIds = []
  for (const fieldId of mappedFieldIds) {
    let found = false
    for (const row of list) {
      const data = row && typeof row.data === 'object' && row.data ? row.data : {}
      const value = readCell(data, fieldId, physicalIdFor)
      if (isNonEmptyCell(value)) {
        leakGuardValues.add(String(value))
        found = true
        break
      }
    }
    if (found) nonEmptyFieldIds.push(fieldId)
    else emptyFieldIds.push(fieldId)
  }
  return {
    ok: emptyFieldIds.length === 0,
    nonEmptyFieldIds: nonEmptyFieldIds.sort(),
    emptyFieldIds: emptyFieldIds.sort(),
  }
}

/**
 * CRITERION 2: a second dry-run over an unchanged source must be ALL SKIP.
 *
 * `skip > 0` is required as well as the four zeroes: a plan of nothing at all would
 * satisfy "no adds, no updates" while proving nothing about idempotence.
 */
export function isIdempotentSecondDryRun(counts) {
  const c = counts && typeof counts === 'object' ? counts : {}
  const add = safeCount(c.add)
  const update = safeCount(c.update)
  const skip = safeCount(c.skip)
  const inactive = safeCount(c.inactive)
  const manualConfirm = safeCount(c.manual_confirm)
  return {
    ok: add === 0 && update === 0 && inactive === 0 && manualConfirm === 0 && skip > 0,
    add,
    update,
    skip,
    inactive,
    manualConfirm,
  }
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

/**
 * Records come back keyed by PHYSICAL field id (`fld_<sha1-24>`), which is a pure
 * function of (projectId, objectId, fieldId) — see stock-preparation-derive-target-binding.mjs,
 * whose colocated test pins that algorithm against the TypeScript source. The logical id
 * is accepted as a fallback so a deployment whose records API translates ids on the way
 * out is read correctly rather than reported as an empty band.
 */
export function readCell(data, logicalFieldId, physicalIdFor) {
  const physical = typeof physicalIdFor === 'function' ? physicalIdFor(logicalFieldId) : null
  if (physical && Object.prototype.hasOwnProperty.call(data, physical)) return data[physical]
  if (Object.prototype.hasOwnProperty.call(data, logicalFieldId)) return data[logicalFieldId]
  return undefined
}

export function isNonEmptyCell(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

function ok(reason, detail) {
  return { status: STATUS_OK, reason, ...(detail ? { detail } : {}) }
}
function skip(reason, detail) {
  return { status: STATUS_SKIP, reason, ...(detail ? { detail } : {}) }
}
function fail(reason, fix, detail) {
  return { status: STATUS_FAIL, reason, fix, ...(detail ? { detail } : {}) }
}

// --- 1 -----------------------------------------------------------------------

/**
 * The preflight (#5345) is the authority on "is this deployment ready", and its `posture`
 * block is the authority on the fences — SERVER-side, which is the reading that actually
 * matters. When it answers, its posture is what this report carries. When it does not
 * (an older deployment), the step degrades to SKIP and falls back to the only posture a
 * client can observe: this process's own environment, labelled as such so nobody mistakes
 * the two.
 *
 * Every blocker carries a `fix` OBJECT — `{ kind: 'http'|'env', ..., run }` — where `run`
 * is the literal paste-able line. That line is printed verbatim, because handing the
 * operator the exact command is the entire point of the route. The preflight deliberately
 * attaches NO fix to a posture entry, and this step adds none either.
 */
export async function runPreflightStep(ctx) {
  const { config, fetchImpl, report } = ctx

  const res = await apiRequest(config, 'GET', `/integration/stock-preparation/preflight${buildQuery(config)}`, {
    accept: [200],
    fetchImpl,
  })
  if (res.status === 404 || res.status === 501) {
    // Fallback posture, and ONLY here: reported, never acted on. This script does not set
    // these, does not advise setting them, and does not change behaviour on them.
    report.posture = {
      scope: 'local_process_env',
      b2aRegistryPathSet: typeof ctx.env.INTEGRATION_CORE_B2A_REGISTRY_PATH === 'string'
        && ctx.env.INTEGRATION_CORE_B2A_REGISTRY_PATH.trim() !== '',
      outboundHttpWriteTargetsSet: typeof ctx.env.INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS === 'string'
        && ctx.env.INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS.trim() !== '',
      fenceEnvNames: [...FENCE_ENV_NAMES],
    }
    return skip('route_absent — this deployment predates the preflight route (#5345); local fence posture reported instead')
  }
  if (!res.httpOk || !res.envelopeOk) {
    return fail(
      `preflight ${httpReason(res)}`,
      'the preflight route answered but not with ok:true — it is stock-prep:read gated; check the bearer',
    )
  }
  const data = res.data && typeof res.data === 'object' ? res.data : {}
  const blockers = Array.isArray(data.blockers) ? data.blockers : []
  const projected = blockers.map((b) => ({
    code: safeCode(b && b.code),
    fix: safeFixText(b && b.fix && b.fix.run),
    fixKind: safeToken(b && b.fix && b.fix.kind),
  }))
  const posture = data.posture && typeof data.posture === 'object' ? data.posture : {}
  report.posture = {
    scope: 'server_preflight',
    // States only. The preflight's own `note` prose is not reproduced: this report's face
    // is tokens, and the operator who wants the prose reads the route.
    productionApply: safeToken(posture.productionApply && posture.productionApply.state),
    k3ExternalWrite: safeToken(posture.k3ExternalWrite && posture.k3ExternalWrite.state),
    b2aTrialRegistry: safeToken(posture.b2aTrialRegistry && posture.b2aTrialRegistry.state),
    outboundHttpWrite: safeToken(posture.outboundHttpWrite && posture.outboundHttpWrite.state),
    fenceEnvNames: [...FENCE_ENV_NAMES],
  }
  report.preflight = { ready: data.ready === true, blockerCount: projected.length, blockers: projected }
  if (projected.length > 0 || data.ready !== true) {
    return fail(
      `preflight reported ${projected.length} blocker(s)`,
      projected.map((b) => `${b.code} -> run: ${b.fix}`).join(' | ') || 'preflight is not ready but named no blocker',
    )
  }
  return ok(
    `preflight ready (blockers=0) posture: productionApply=${report.posture.productionApply} b2a=${report.posture.b2aTrialRegistry} outboundWrite=${report.posture.outboundHttpWrite}`,
  )
}

// --- 2 -----------------------------------------------------------------------

export async function runManagedTablesStep(ctx) {
  const { config, fetchImpl, report } = ctx

  // (a) confirmation-decision ledger. Body is STRICTLY empty: the staging project is
  //     auth-derived and a request projectId would be a steering vector on a write route.
  const ledger = await apiRequest(
    config,
    'POST',
    `/integration/stock-preparation/confirmation-decisions/ensure${buildQuery(config)}`,
    { body: {}, accept: [200, 201], fetchImpl },
  )
  if (!ledger.httpOk || !ledger.envelopeOk) {
    return fail(
      `confirmation-decisions/ensure ${httpReason(ledger)}`,
      'this route is platform-admin and provisions a managed table; check the bearer is an admin and the plugin is active',
    )
  }
  const ledgerMode = safeToken(ledger.data && ledger.data.mode)

  // (b) THE PACK DECLARES THE OBJECT ID. Never env, never argv, never a guess.
  const catalog = await apiRequest(config, 'GET', `/integration/stock-preparation/customer-packs${buildQuery(config)}`, {
    accept: [200],
    fetchImpl,
  })
  if (!catalog.httpOk || !catalog.envelopeOk) {
    return fail(
      `customer-packs list ${httpReason(catalog)}`,
      'the pack catalog is server-held; configure stockPreparationCustomerPacks (INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH) and restart',
    )
  }
  let target
  try {
    target = resolvePackTarget(catalog.data && catalog.data.packs, config.packId)
  } catch (err) {
    // `err.field` is this module's own closed reason on a BootstrapInputError, and
    // `err.code` is the provisioning module's own closed reason when its validator
    // refused the id. Anything else is reduced to one registered token; a raw message is
    // never echoed, because a message can carry request input.
    const reason = safeCode(err && err.field) !== UNREGISTERED
      ? safeCode(err.field)
      : (safeCode(err && err.code) !== UNREGISTERED ? safeCode(err.code) : 'PACK_TARGET_INVALID')
    return fail(
      `pack target unresolved (${reason})`,
      'the sandbox objectId is the pack\'s declared targetObjectId and must sit in the plm_stock_preparation_sandbox namespace — fix the pack, do not invent a name',
    )
  }
  ctx.target = target
  report.pack = {
    packId: safeHandle(target.packId),
    packVersion: target.packVersion,
    targetObjectId: safeHandle(target.targetObjectId),
    extensionFieldCount: target.extensionFieldIds.length,
    systemExtensionFieldIds: [...target.systemExtensionFieldIds].sort(),
    humanExtensionFieldIds: [...target.humanExtensionFieldIds].sort(),
  }

  // (c) the sandbox target itself.
  const sandboxBody = { objectId: target.targetObjectId }
  if (config.workspaceId) sandboxBody.workspaceId = config.workspaceId
  const sandbox = await apiRequest(
    config,
    'POST',
    `/integration/stock-preparation/sandbox-target/ensure${buildQuery(config)}`,
    { body: sandboxBody, accept: [200, 201], fetchImpl },
  )
  if (!sandbox.httpOk || !sandbox.envelopeOk || (sandbox.data && sandbox.data.ready !== true)) {
    return fail(
      `sandbox-target/ensure ${httpReason(sandbox)}`,
      'the objectId must satisfy the plm_stock_preparation_sandbox namespace and the caller must be platform admin',
    )
  }
  const sandboxMode = safeToken(sandbox.data && sandbox.data.mode)
  report.managedTables = { ledgerMode, sandboxMode, targetReady: true }
  return ok(`ledger=${ledgerMode} sandbox=${sandboxMode} objectId=${safeHandle(target.targetObjectId)}`)
}

// --- 3 -----------------------------------------------------------------------

export async function runCustomerPackStep(ctx) {
  const { config, fetchImpl, report } = ctx
  const packPath = `/integration/stock-preparation/customer-packs/${encodeURIComponent(config.packId)}`

  const dryRun = await apiRequest(config, 'POST', `${packPath}/dry-run${buildQuery(config)}`, {
    body: {},
    accept: [200],
    fetchImpl,
  })
  if (!dryRun.httpOk || !dryRun.envelopeOk) {
    return fail(`pack dry-run ${httpReason(dryRun)}`, 'the pack must exist in the server-held catalog and the target sheet must be provisioned (step 2)')
  }
  const plan = dryRun.data && typeof dryRun.data === 'object' ? dryRun.data : {}
  if (plan.canInstall !== true) {
    const conflicting = Array.isArray(plan.conflictingFieldIds) ? plan.conflictingFieldIds.map(safeFieldId) : []
    return fail(
      `pack dry-run canInstall=false conflicting=${conflicting.length}`,
      `these field ids already carry a different ownership stamp and the installer refuses to overwrite one: ${conflicting.join(', ') || '(none reported)'}`,
    )
  }
  const projectId = safeHandle(plan.projectId)
  if (projectId === UNREGISTERED) {
    return fail('pack dry-run returned no usable projectId', 'the install route derives the staging projectId from the authenticated tenant — check the bearer carries a tenant')
  }
  ctx.projectId = plan.projectId

  const install = await apiRequest(config, 'POST', `${packPath}/install${buildQuery(config)}`, {
    body: { mode: 'install' },
    accept: [200, 201],
    fetchImpl,
  })
  if (!install.httpOk || !install.envelopeOk) {
    return fail(`pack install ${httpReason(install)}`, 'installs require the pack-install ledger (migration 076) — a deployment without it answers CUSTOMER_PACK_LEDGER_UNAVAILABLE')
  }
  const installed = install.data && typeof install.data === 'object' ? install.data : {}
  const installedFields = Array.isArray(installed.installedFields) ? installed.installedFields : []
  ctx.installedFields = installedFields

  // RE-RUN AND ASSERT THE NO-OP. This is the idempotence proof the task names: not
  // "it did not crash", but "every field came back alreadyStamped".
  const replay = await apiRequest(config, 'POST', `${packPath}/install${buildQuery(config)}`, {
    body: { mode: 'install' },
    accept: [200],
    fetchImpl,
  })
  if (!replay.httpOk || !replay.envelopeOk) {
    return fail(`pack install replay ${httpReason(replay)}`, 'a second install must be a 200 no-op; a 201 means it created fields again')
  }
  const replayed = replay.data && typeof replay.data === 'object' ? replay.data : {}
  const created = Array.isArray(replayed.createdFields) ? replayed.createdFields.length : -1
  const stamped = Array.isArray(replayed.stampedExistingFields) ? replayed.stampedExistingFields.length : -1
  const alreadyStamped = Array.isArray(replayed.alreadyStampedFields) ? replayed.alreadyStampedFields.length : -1
  const expected = installedFields.length
  const idempotent = created === 0 && stamped === 0 && alreadyStamped === expected && expected > 0

  report.customerPack = {
    willCreateCount: Array.isArray(plan.willCreateFieldIds) ? plan.willCreateFieldIds.length : 0,
    willStampCount: Array.isArray(plan.willStampFieldIds) ? plan.willStampFieldIds.length : 0,
    installedFieldCount: expected,
    replayCreated: created,
    replayStamped: stamped,
    replayAlreadyStamped: alreadyStamped,
    idempotent,
  }
  if (!idempotent) {
    return fail(
      `pack install is not idempotent (created=${created} stamped=${stamped} alreadyStamped=${alreadyStamped} of ${expected})`,
      'a re-install must report every field alreadyStamped; a non-zero created/stamped count means the ownership stamp is not being read back',
    )
  }
  return ok(`installed=${expected} replay all alreadyStamped`)
}

// --- 4 -----------------------------------------------------------------------

export async function runSourceWiringStep(ctx) {
  const { config, fetchImpl, report } = ctx

  // (a) the read-only data source. The synthetic source is NOT this script's job — when
  //     no connection env is supplied we only verify the id the deployment registered.
  let dataSourceMode = 'verified_existing'
  if (config.connection) {
    const c = config.connection
    const connection = { host: c.host }
    if (c.port) connection.port = c.port
    if (c.database) connection.database = c.database
    if (c.schema) connection.schema = c.schema
    const body = {
      id: config.dataSourceId,
      name: c.name,
      type: c.type,
      connection,
      // Read-only is the default and is restated here so nothing downstream can read it
      // as an oversight. This script never registers a write target.
      options: { readOnly: true },
    }
    if (c.user || c.password) {
      body.credentials = {}
      if (c.user) body.credentials.username = c.user
      if (c.password) body.credentials.password = c.password
    }
    const created = await apiRequest(config, 'POST', '/data-sources', { body, accept: [201, 409], fetchImpl })
    if (!created.httpOk) {
      return fail(`data-source create ${httpReason(created)}`, 'check MS_DS_* and that the bearer holds data_sources:write')
    }
    dataSourceMode = created.status === 409 ? 'already_registered' : 'registered'
  }
  const dsGet = await apiRequest(config, 'GET', `/data-sources/${encodeURIComponent(config.dataSourceId)}`, {
    accept: [200],
    fetchImpl,
  })
  if (!dsGet.httpOk || !dsGet.envelopeOk) {
    return fail(
      `data-source ${httpReason(dsGet)}`,
      'register the read-only data source first, or supply MS_DS_HOST/MS_DS_DATABASE/MS_DS_USER/MS_DS_PASSWORD so this script registers it',
    )
  }

  // (b) the external system the ACTION reads through. Its id is NOT derivable: the action's
  //     source binding lives in server-held config and `publicActionMetadata` deliberately
  //     never exposes it, which is why MS_EXTERNAL_SYSTEM_ID is required rather than
  //     invented. A guessed id would create a stray system, leave the action reading a
  //     different one, and surface only at step 8 as a confusing 409 — precisely the class
  //     of late, misdirected failure this script exists to remove.
  //
  //     PROBE FIRST, THEN THE NARROWEST WRITE. When the system already exists it is the
  //     deployment's, and an upsert carrying a `config` key REPLACES its public half — so
  //     an existing system's binding is ASSERTED, never rewritten, and only `status` is
  //     moved. `role` is omitted too: it cannot be changed after creation, and omitting it
  //     preserves whatever the deployment chose.
  const systemPath = `/integration/external-systems/${encodeURIComponent(config.externalSystemId)}`
  const existing = await apiRequest(config, 'GET', `${systemPath}${buildQuery(config)}`, {
    accept: [200, 404],
    fetchImpl,
  })
  if (!existing.httpOk) {
    return fail(`external-system read ${httpReason(existing)}`, 'the bearer needs integration read access and a tenant context')
  }
  const stored = existing.status === 200 && existing.envelopeOk && existing.data && typeof existing.data === 'object'
    ? existing.data
    : null

  let systemMode
  if (stored) {
    const kind = safeHandle(stored.kind)
    if (kind !== 'data-source:sql-readonly') {
      return fail(
        `external-system kind=${kind} (expected data-source:sql-readonly)`,
        'kind cannot be changed after creation — point MS_EXTERNAL_SYSTEM_ID at the sql-readonly source system the table action is configured to read through',
      )
    }
    const bound = stored.config && typeof stored.config === 'object' ? stored.config.dataSourceId : undefined
    if (bound !== config.dataSourceId) {
      return fail(
        'external-system config.dataSourceId does not match MS_DATA_SOURCE_ID',
        'this script will not silently repoint a configured system — either fix its config.dataSourceId, or set MS_DATA_SOURCE_ID to the data source it already names',
      )
    }
    systemMode = safeToken(stored.status) === 'active' ? 'already_active' : 'activated'
    if (safeToken(stored.status) !== 'active') {
      // ACTIVE, EXPLICITLY. A system created with the default status stays `inactive` even
      // after a successful test: resolveTestedStatus refuses to silently enable an
      // intentionally-inactive system. Reconcile loads its adapter with requireActive:true
      // and answers 409 TABLE_ACTION_SOURCE_NOT_ACTIVE; dry-run and apply do not, so the
      // chain appears to work right up to the confirmation queue. That asymmetry cost a
      // live afternoon.
      const activate = await apiRequest(config, 'POST', `/integration/external-systems${buildQuery(config)}`, {
        // No `config`, no `role`, no `capabilities`: each is preserved when the update
        // omits it, so this moves status and nothing else.
        body: { id: config.externalSystemId, name: stored.name, kind: stored.kind, status: 'active' },
        accept: [200, 201],
        fetchImpl,
      })
      if (!activate.httpOk || !activate.envelopeOk) {
        return fail(`external-system activate ${httpReason(activate)}`, 'the upsert needs a tenant on the request or the bearer')
      }
    }
  } else {
    systemMode = 'created'
    const upsertBody = {
      id: config.externalSystemId,
      name: config.externalSystemId,
      kind: 'data-source:sql-readonly',
      role: 'source',
      // The integration row carries the REFERENCE only — never the credentials.
      config: { dataSourceId: config.dataSourceId },
      status: 'active',
    }
    if (config.connection && config.connection.schema) upsertBody.config.schema = config.connection.schema
    if (config.tenantId) upsertBody.tenantId = config.tenantId
    if (config.workspaceId) upsertBody.workspaceId = config.workspaceId
    const created = await apiRequest(config, 'POST', `/integration/external-systems${buildQuery(config)}`, {
      body: upsertBody,
      accept: [200, 201],
      fetchImpl,
    })
    if (!created.httpOk || !created.envelopeOk) {
      return fail(`external-system create ${httpReason(created)}`, 'the upsert needs a tenant on the request or the bearer; kind must be data-source:sql-readonly')
    }
  }

  // (c) prove the wire.
  const test = await apiRequest(
    config,
    'POST',
    `/integration/external-systems/${encodeURIComponent(config.externalSystemId)}/test${buildQuery(config)}`,
    { body: {}, accept: [200], fetchImpl },
  )
  const testOk = test.httpOk && test.envelopeOk && test.data && test.data.ok === true
  if (!testOk) {
    return fail(
      `external-system test failed (${test.data && safeToken(test.data.code) !== UNREGISTERED ? safeToken(test.data.code) : httpReason(test)})`,
      'the data source must be reachable from the SERVER, not from wherever this script runs',
    )
  }

  // (d) and prove it stayed active — the test route can demote to `error`.
  const readback = await apiRequest(
    config,
    'GET',
    `/integration/external-systems/${encodeURIComponent(config.externalSystemId)}${buildQuery(config)}`,
    { accept: [200], fetchImpl },
  )
  const status = safeToken(readback.data && readback.data.status)
  if (!readback.httpOk || !readback.envelopeOk || status !== 'active') {
    return fail(
      `external-system status=${status} (expected active)`,
      'reconcile requires status active (requireActive:true); dry-run does not — re-upsert with status:"active"',
    )
  }
  report.sourceWiring = {
    dataSourceMode,
    systemMode,
    externalSystemId: safeHandle(config.externalSystemId),
    kind: 'data-source:sql-readonly',
    status,
    testOk: true,
  }
  return ok(`dataSource=${dataSourceMode} system=${safeHandle(config.externalSystemId)}(${systemMode}) status=${status}`)
}

// --- 5 -----------------------------------------------------------------------

async function postDryRun(ctx) {
  const { config, fetchImpl } = ctx
  return apiRequest(
    config,
    'POST',
    `/integration/table-actions/${encodeURIComponent(config.actionId)}/dry-run${buildQuery(config)}`,
    { body: { parameters: { projectNo: config.projectNo } }, accept: [200], fetchImpl },
  )
}

export async function runAcceptanceDryRunStep(ctx) {
  const { report } = ctx
  const res = await postDryRun(ctx)
  if (!res.httpOk || !res.envelopeOk) {
    return fail(`dry-run ${httpReason(res)}`, 'the action must resolve a ready target and an existing source system; check steps 2 and 4')
  }
  const data = res.data && typeof res.data === 'object' ? res.data : {}
  const status = safeToken(data.status)
  if (data.canApply !== true || typeof data.dryRunToken !== 'string' || data.dryRunToken === '') {
    return fail(
      `dry-run canApply=${data.canApply === true} status=${status} token=${typeof data.dryRunToken === 'string' && data.dryRunToken !== ''}`,
      'status manual_confirm_required means the plan is held — work the confirmation queue (step 8) first; no token is minted unless canApply is true',
    )
  }
  ctx.dryRunToken = data.dryRunToken
  const evidence = data.evidence && typeof data.evidence === 'object' ? data.evidence : {}
  const mapping = evidence.extFieldMapping && typeof evidence.extFieldMapping === 'object' ? evidence.extFieldMapping : null
  ctx.mappedFieldIds = mapping && Array.isArray(mapping.targetFieldIds)
    ? mapping.targetFieldIds.map(safeFieldId).filter((id) => id !== UNREGISTERED)
    : []
  const counts = data.counts && typeof data.counts === 'object' ? data.counts : {}
  report.acceptanceDryRun = {
    status,
    canApply: true,
    tokenMinted: true,
    counts: {
      add: safeCount(counts.add),
      update: safeCount(counts.update),
      skip: safeCount(counts.skip),
      inactive: safeCount(counts.inactive),
      manualConfirm: safeCount(counts.manual_confirm),
    },
    mappedExtFieldIds: [...ctx.mappedFieldIds].sort(),
    extFieldMappingConfigured: mapping !== null,
  }
  return ok(`status=${status} token=minted mappedExt=${ctx.mappedFieldIds.length}`)
}

// --- 6 -----------------------------------------------------------------------

async function readTargetRows(ctx, sheetId) {
  const { config, fetchImpl } = ctx
  const rows = []
  let cursor = null
  for (let page = 0; page < RECORD_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ sheetId, limit: String(RECORD_PAGE_LIMIT) })
    if (cursor) query.set('cursor', cursor)
    const res = await apiRequest(config, 'GET', `/multitable/records?${query.toString()}`, { accept: [200], fetchImpl })
    if (!res.httpOk || !res.envelopeOk) return { ok: false, rows, res }
    const data = res.data && typeof res.data === 'object' ? res.data : {}
    const page_ = Array.isArray(data.records) ? data.records : []
    rows.push(...page_)
    if (data.hasMore !== true || typeof data.nextCursor !== 'string' || data.nextCursor === '') break
    cursor = data.nextCursor
  }
  return { ok: true, rows, res: null }
}

export async function runAcceptanceApplyStep(ctx) {
  const { config, fetchImpl, report } = ctx
  let body
  try {
    body = buildApplyBody({ projectNo: config.projectNo, dryRunToken: ctx.dryRunToken })
  } catch {
    return fail('no dry-run token available', 'step 5 must mint a token before apply can run')
  }
  const res = await apiRequest(
    config,
    'POST',
    `/integration/table-actions/${encodeURIComponent(config.actionId)}/apply${buildQuery(config)}`,
    { body, accept: [200], fetchImpl },
  )
  if (!res.httpOk || !res.envelopeOk) {
    return fail(
      `apply ${httpReason(res)}`,
      'the apply body accepts ONLY parameters and confirm, with the token at confirm.dryRunToken; a sandbox refusal means STOCK_PREP_SANDBOX_MODE / STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS do not cover this objectId',
    )
  }
  const data = res.data && typeof res.data === 'object' ? res.data : {}
  const applyResult = data.apply && typeof data.apply === 'object' ? data.apply : {}
  if (applyResult.ok !== true) {
    const codes = Array.isArray(applyResult.errorCodes) ? applyResult.errorCodes.map(safeCode) : []
    return fail(
      `apply returned ok=false status=${safeToken(applyResult.status)} codes=${codes.join(',') || '(none)'}`,
      'the writer refused the plan; the codes above are the closed vocabulary to look up',
    )
  }

  // CRITERION 1 is proven against the TARGET SHEET STATE, not against the apply
  // counters. On a second run of this script the source is unchanged, apply legitimately
  // writes zero rows, and the criterion must still hold on the rows run 1 wrote.
  const projectId = ctx.projectId
  const objectId = ctx.target.targetObjectId
  const sheetId = getObjectSheetId(projectId, objectId)
  const physicalIdFor = (fieldId) => getObjectFieldId(projectId, objectId, fieldId)

  const read = await readTargetRows(ctx, sheetId)
  if (!read.ok) {
    return fail(`target read ${httpReason(read.res)}`, 'the bearer must be able to read the sandbox sheet (GET /multitable/records)')
  }
  const rows = read.rows

  const humanFieldIds = [...new Set([...HUMAN_PRESERVED_FIELD_IDS, ...ctx.target.humanExtensionFieldIds])].sort()
  const humanCheck = assertHumanBandEmpty({
    rows,
    humanFieldIds,
    physicalIdFor,
    leakGuardValues: ctx.leakGuardValues,
  })
  const extCheck = assertMappedExtCellsPresent({
    rows,
    mappedFieldIds: ctx.mappedFieldIds,
    physicalIdFor,
    leakGuardValues: ctx.leakGuardValues,
  })

  const rowsWritten = safeCount(applyResult.written)
  const criterion1 =
    rows.length > 0 && humanCheck.ok && extCheck.ok && ctx.mappedFieldIds.length > 0
  report.criterion1 = {
    verdict: criterion1 ? 'PASS' : 'FAIL',
    applyWritten: rowsWritten,
    applyStatus: safeToken(applyResult.status),
    targetRowCount: rows.length,
    mappedExtFieldIds: [...ctx.mappedFieldIds].sort(),
    mappedExtNonEmptyFieldIds: extCheck.nonEmptyFieldIds,
    mappedExtEmptyFieldIds: extCheck.emptyFieldIds,
    humanBandFieldIds: humanFieldIds,
    humanBandCellsInspected: humanCheck.inspectedCellCount,
    humanBandNonEmptyFieldIds: humanCheck.offendingFieldIds,
  }

  if (rows.length === 0) {
    return fail('criterion 1: the target sheet has no rows', 'apply succeeded but wrote nothing — the source read produced no expandable BOM for this projectNo')
  }
  if (ctx.mappedFieldIds.length === 0) {
    return fail(
      'criterion 1: no ext_ field mapping is configured',
      'set stockPreparationExtFieldMapping (INTEGRATION_CORE_STOCK_PREPARATION_EXT_FIELD_MAPPING_PATH) — without it no ext_ column is ever written and the criterion is vacuous',
    )
  }
  if (!extCheck.ok) {
    return fail(
      `criterion 1: mapped ext_ targets empty on every row: ${extCheck.emptyFieldIds.join(', ')}`,
      'each mapping entry reads a bare column off the PART row; a sourceColumn that does not exist there produces no cell and no error — see scripts/ops/fixtures/stock-prep-synthetic-plm/schema.sql gotcha 2',
    )
  }
  if (!humanCheck.ok) {
    return fail(
      `criterion 1: human_preserved cells are non-empty: ${humanCheck.offendingFieldIds.join(', ')}`,
      'the machine must never fill the human band — a non-empty cell here means the writer\'s human wall was bypassed or the band was mis-derived from the pack stamps',
    )
  }
  return ok(
    `criterion 1 PASS — rows=${rows.length} written=${rowsWritten} extNonEmpty=${extCheck.nonEmptyFieldIds.length}/${ctx.mappedFieldIds.length} humanCellsNonEmpty=0`,
  )
}

// --- 7 -----------------------------------------------------------------------

export async function runAcceptanceIdempotentStep(ctx) {
  const { report } = ctx
  const res = await postDryRun(ctx)
  if (!res.httpOk || !res.envelopeOk) {
    return fail(`second dry-run ${httpReason(res)}`, 'the same call that succeeded in step 5 must succeed again')
  }
  const data = res.data && typeof res.data === 'object' ? res.data : {}
  const verdict = isIdempotentSecondDryRun(data.counts)
  report.criterion2 = {
    verdict: verdict.ok ? 'PASS' : 'FAIL',
    status: safeToken(data.status),
    counts: {
      add: verdict.add,
      update: verdict.update,
      skip: verdict.skip,
      inactive: verdict.inactive,
      manualConfirm: verdict.manualConfirm,
    },
  }
  if (!verdict.ok) {
    return fail(
      `criterion 2: second dry-run is not all-skip (add=${verdict.add} update=${verdict.update} skip=${verdict.skip} inactive=${verdict.inactive} manualConfirm=${verdict.manualConfirm})`,
      'a re-run over an unchanged source must decide skip for every row; a non-zero add/update means the key identity is unstable between runs',
    )
  }
  return ok(`criterion 2 PASS — skip=${verdict.skip}, add/update/inactive/manualConfirm all 0`)
}

// --- 8 -----------------------------------------------------------------------

/**
 * Reconcile -> values-free queue -> confirm keep_multiple_rows -> reconcile again.
 *
 * THE E1 ASYMMETRY IS EXPECTED, NOT A BUG. `keep_multiple_rows` is the only resolving
 * duplicate policy, but a group whose canonical row ALREADY EXISTS is re-held on every
 * replan under the `clean_to_collision_requires_review` reason — the collision branch
 * fires precisely when the canonical row exists and does not reclassify the conflict. So
 * a group with no canonical row releases, and one whose canonical row exists stays held,
 * from the same confirmation. That is documented in
 * docs/development/takeover-beiliao-20260821/o1-conflict-matrix-20260829.md (the
 * `duplicate_expanded_key` row, E1 correction) and this step asserts it as EXPECTED: a
 * non-zero pending count after confirming is reported as `e1ReheldCount` and never fails
 * the run.
 *
 * HONEST LIMIT: from outside the server there is no oracle for "did this particular
 * group have a canonical row", so the step asserts the DIRECTION (confirming can only
 * reduce or hold the pending count, never grow it) and reports the delta, rather than
 * claiming to have identified which group did which.
 */
export async function runConfirmationQueueStep(ctx) {
  const { config, fetchImpl, report } = ctx
  if (!config.queueSmoke) {
    return skip('MS_SKIP_QUEUE_SMOKE=1')
  }
  const reconcilePath = `/integration/table-actions/${encodeURIComponent(config.actionId)}/confirmation-decisions/reconcile`
  const queuePath = `/integration/stock-preparation/confirmation-decisions`

  const reconcile = await apiRequest(config, 'POST', `${reconcilePath}${buildQuery(config)}`, {
    body: { parameters: { projectNo: config.projectNo } },
    accept: [200, 201],
    fetchImpl,
  })
  if (!reconcile.httpOk || !reconcile.envelopeOk) {
    return fail(
      `reconcile ${httpReason(reconcile)}`,
      'reconcile loads the source adapter with requireActive:true — a source that dry-run happily read is refused here unless its external system status is active (step 4)',
    )
  }

  const listQuery = buildQuery(config, { projectNo: config.projectNo })
  const before = await apiRequest(config, 'GET', `${queuePath}${listQuery}`, { accept: [200], fetchImpl })
  if (!before.httpOk || !before.envelopeOk) {
    return fail(`queue list ${httpReason(before)}`, 'the queue read is stock-prep:read and requires projectNo')
  }
  const beforeData = before.data && typeof before.data === 'object' ? before.data : {}
  const beforeRows = Array.isArray(beforeData.rows) ? beforeData.rows : []

  // The queue is the values-free surface: presence booleans only, never contents. An
  // EXTRA key is exactly how that stops being true, so the projection is asserted
  // key-for-key against the closed set.
  const foreignKeys = new Set()
  for (const row of beforeRows) {
    for (const key of Object.keys(row && typeof row === 'object' ? row : {})) {
      if (!QUEUE_ROW_KEYS.includes(key)) foreignKeys.add(safeFieldId(key))
    }
  }
  if (foreignKeys.size > 0) {
    return fail(
      `queue projection carries ${foreignKeys.size} unregistered key(s): ${[...foreignKeys].sort().join(', ')}`,
      'the confirmation-decision queue must expose presence booleans only; contents cross exactly one surface (/confirmation-decisions/value-entry) and the queue is not it',
    )
  }

  const pendingBefore = safeCount(beforeData.byStatus && beforeData.byStatus.pending)
  const confirmable = beforeRows.filter(
    (r) => r && r.status === 'pending' && r.conflictType === DUPLICATE_EXPANDED_KEY
      && typeof r.decisionId === 'string' && typeof r.inputFingerprint === 'string',
  )

  if (confirmable.length === 0) {
    report.confirmationQueue = {
      reconciled: true,
      queueValuesFree: true,
      rowCount: beforeRows.length,
      pendingBefore,
      confirmedCount: 0,
      pendingAfter: pendingBefore,
      e1ReheldCount: pendingBefore,
    }
    return skip(`no pending ${DUPLICATE_EXPANDED_KEY} decisions to confirm (queue rows=${beforeRows.length})`)
  }

  let confirmed = 0
  for (const row of confirmable) {
    const res = await apiRequest(config, 'POST', `${queuePath}/confirm${buildQuery(config)}`, {
      body: {
        decisionId: row.decisionId,
        inputFingerprint: row.inputFingerprint,
        resolutionAction: KEEP_MULTIPLE_ROWS,
      },
      accept: [200],
      fetchImpl,
    })
    if (!res.httpOk || !res.envelopeOk) {
      return fail(
        `confirm ${KEEP_MULTIPLE_ROWS} ${httpReason(res)} (confirmed ${confirmed}/${confirmable.length})`,
        'confirm is stock-prep:operate and requires the CURRENT inputFingerprint — a stale one is a 409 revision mismatch',
      )
    }
    confirmed += 1
  }

  const reconcileAgain = await apiRequest(config, 'POST', `${reconcilePath}${buildQuery(config)}`, {
    body: { parameters: { projectNo: config.projectNo } },
    accept: [200, 201],
    fetchImpl,
  })
  if (!reconcileAgain.httpOk || !reconcileAgain.envelopeOk) {
    return fail(`reconcile replay ${httpReason(reconcileAgain)}`, 'the same reconcile that succeeded above must succeed again')
  }
  const after = await apiRequest(config, 'GET', `${queuePath}${listQuery}`, { accept: [200], fetchImpl })
  if (!after.httpOk || !after.envelopeOk) {
    return fail(`queue list replay ${httpReason(after)}`, 'the queue read must succeed again after confirming')
  }
  const afterData = after.data && typeof after.data === 'object' ? after.data : {}
  const pendingAfter = safeCount(afterData.byStatus && afterData.byStatus.pending)
  const released = Math.max(0, pendingBefore - pendingAfter)

  report.confirmationQueue = {
    reconciled: true,
    queueValuesFree: true,
    rowCount: beforeRows.length,
    pendingBefore,
    confirmedCount: confirmed,
    pendingAfter,
    releasedCount: released,
    // EXPECTED, not a defect. See the E1 note above.
    e1ReheldCount: pendingAfter,
    e1Reference: 'docs/development/takeover-beiliao-20260821/o1-conflict-matrix-20260829.md',
  }
  if (pendingAfter > pendingBefore) {
    return fail(
      `confirming grew the pending queue (${pendingBefore} -> ${pendingAfter})`,
      `${KEEP_MULTIPLE_ROWS} may release a group or leave it held (E1), but it must never open more work than it started with`,
    )
  }
  return ok(
    `reconcile+confirm OK — confirmed=${confirmed} pending ${pendingBefore}->${pendingAfter} released=${released} e1Reheld=${pendingAfter} (expected)`,
  )
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const STEP_RUNNERS = Object.freeze({
  'preflight': runPreflightStep,
  'managed-tables': runManagedTablesStep,
  'customer-pack': runCustomerPackStep,
  'source-wiring': runSourceWiringStep,
  'acceptance-dry-run': runAcceptanceDryRunStep,
  'acceptance-apply': runAcceptanceApplyStep,
  'acceptance-idempotent': runAcceptanceIdempotentStep,
  'confirmation-queue': runConfirmationQueueStep,
})

export const LIMITS_NOTE = [
  'Posture is the preflight route\'s server-side block when it answers; on a deployment without that route',
  'step 1 SKIPs and the posture falls back to THIS PROCESS\'s own environment, which is a weaker reading and',
  'is labelled scope: local_process_env. Step 8 asserts the DIRECTION of the confirmation-queue delta and',
  'reports E1 re-holds; it has no oracle for which individual group had a canonical row. Criterion 1 proves',
  'the target sheet state, so on a re-run it passes on rows an earlier run wrote. Every step is a client of',
  'the HTTP surface only: a green run is evidence about the routes, not about the source database behind them.',
  'This script never applies to the production canonical target.',
].join(' ')

export async function runBootstrap({ env = {}, fetchImpl, now = () => new Date().toISOString() } = {}) {
  const config = readEnvConfig(env)
  const report = {
    tool: TOOL,
    generatedAt: now(),
    mode: 'run',
    stepCount: STEP_COUNT,
    steps: [],
    limits: { note: LIMITS_NOTE },
  }
  const ctx = {
    env,
    config,
    fetchImpl,
    report,
    leakGuardValues: new Set(),
    mappedFieldIds: [],
  }

  const lines = []
  let failedStep = null

  for (let i = 0; i < STEP_PLAN.length; i += 1) {
    const plan = STEP_PLAN[i]
    const runner = STEP_RUNNERS[plan.id]
    let outcome
    try {
      outcome = await runner(ctx)
    } catch (err) {
      outcome = fail(
        `unexpected error in step ${plan.id} (${safeToken(err && err.name && err.name.toLowerCase())})`,
        'this is a defect in the bootstrap script or an unreachable API root — re-run with --dry to confirm the plan',
      )
    }
    const entry = {
      index: i + 1,
      id: plan.id,
      status: outcome.status,
      reason: outcome.reason,
      ...(outcome.fix ? { fix: outcome.fix } : {}),
    }
    // Self-check the STREAMING half too: a step line is printed before the final report
    // exists, so the final assertValuesFree() alone would be too late for it.
    assertValuesFree(entry, { env, leakGuardValues: ctx.leakGuardValues })
    report.steps.push(entry)
    lines.push(`[${entry.index}/${STEP_COUNT}] ${entry.id} ... ${entry.status} — ${entry.reason}`)
    if (entry.status === STATUS_FAIL) {
      failedStep = entry
      break
    }
  }

  report.summary = {
    pass: failedStep === null,
    completedSteps: report.steps.length,
    okCount: report.steps.filter((s) => s.status === STATUS_OK).length,
    skipCount: report.steps.filter((s) => s.status === STATUS_SKIP).length,
    failCount: report.steps.filter((s) => s.status === STATUS_FAIL).length,
    failedStepIndex: failedStep ? failedStep.index : 0,
    failedStepId: failedStep ? failedStep.id : 'none',
    failedStepFix: failedStep ? failedStep.fix || '(no fix hint)' : 'none',
  }

  assertValuesFree(report, { env, leakGuardValues: ctx.leakGuardValues })

  return { report, lines, exitCode: failedStep ? 1 : 0 }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { dry: false, help: false }
  for (const a of argv) {
    switch (a) {
      case '--dry':
        opts.dry = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        // Every input is env. An unknown flag is a typo, and a VALUE on argv would be a
        // credential in a process listing — both are refused rather than ignored.
        throw new BootstrapInputError(`unknown argument: ${a}`, 'ARGV')
    }
  }
  return opts
}

export function renderPlan() {
  const lines = [`${TOOL} — plan (${STEP_COUNT} steps, --dry: nothing is called)`, '']
  for (let i = 0; i < STEP_PLAN.length; i += 1) {
    const step = STEP_PLAN[i]
    lines.push(`[${i + 1}/${STEP_COUNT}] ${step.id}`)
    for (const route of step.routes) lines.push(`        ${route}`)
    lines.push(`        note: ${step.note}`)
  }
  lines.push('')
  lines.push('Input is env only (MS_API, MS_TOKEN, MS_PROJECT_NO, MS_PACK_ID, MS_DATA_SOURCE_ID,')
  lines.push('MS_EXTERNAL_SYSTEM_ID, MS_DS_*). The sandbox objectId is NOT among them: it comes from the pack.')
  lines.push('This script never sets or advises setting the B2a registry, the outbound HTTP write targets,')
  lines.push('or any production-Apply policy.')
  return lines.join('\n')
}

function printHelp(write) {
  write(
    [
      `${TOOL} — one command from a fresh deploy to a proven-green stock-preparation install`,
      '',
      'Usage:',
      '  MS_API=http://127.0.0.1/api MS_TOKEN=... MS_PROJECT_NO=... MS_PACK_ID=... \\',
      '  MS_DATA_SOURCE_ID=... MS_EXTERNAL_SYSTEM_ID=... \\',
      '  [MS_TENANT_ID=... MS_DS_HOST=... MS_DS_DATABASE=... MS_DS_USER=... MS_DS_PASSWORD=...] \\',
      `    node scripts/ops/${path.basename(__filename)} [--dry]`,
      '',
      'Flags: --dry (print the plan, call nothing) · --help',
      'Everything else is env — argv leaks into process listings.',
      '',
    ].join('\n'),
  )
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  { fetchImpl, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {},
) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    stderr(`[${TOOL}] ERROR: ${err.message}\n`)
    return 2
  }
  if (opts.help) {
    printHelp(stdout)
    return 0
  }
  if (opts.dry) {
    stdout(`${renderPlan()}\n`)
    return 0
  }

  let result
  try {
    result = await runBootstrap({ env, fetchImpl })
  } catch (err) {
    if (err instanceof BootstrapInputError) {
      stderr(`[${TOOL}] ERROR: ${err.message}\n`)
      return 2
    }
    if (err && /^VALUES_FREE_SELF_CHECK_FAILED:/.test(err.message)) {
      stderr(`[${TOOL}] ERROR: ${err.message}\n`)
      return 1
    }
    stderr(`[${TOOL}] ERROR: ${err && err.message ? err.message : String(err)}\n`)
    return 1
  }

  for (const line of result.lines) stdout(`${line}\n`)
  const s = result.report.summary
  if (s.pass) {
    stdout(`\nPASS — ${s.okCount} OK, ${s.skipCount} SKIP, 0 FAIL of ${STEP_COUNT} steps\n`)
  } else {
    stdout(
      `\nFAIL — step [${s.failedStepIndex}/${STEP_COUNT}] ${s.failedStepId}\n  fix: ${s.failedStepFix}\n`,
    )
  }
  stdout(`STOCK_PREP_BOOTSTRAP_REPORT=${JSON.stringify(result.report)}\n`)
  return result.exitCode
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  })
}

export {
  TOOL,
  STEP_PLAN,
  STEP_COUNT,
  STATUS_OK,
  STATUS_SKIP,
  STATUS_FAIL,
  SCANNED_ENV_NAMES,
  FENCE_ENV_NAMES,
  QUEUE_ROW_KEYS,
  HUMAN_PRESERVED_FIELD_IDS,
  assertValuesFree,
  isScannableValue,
  safeToken,
  safeCode,
  safeFieldId,
  safeHandle,
  safeFixText,
  REPO_ROOT,
}
