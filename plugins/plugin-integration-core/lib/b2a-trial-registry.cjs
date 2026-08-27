'use strict'

// B2a REGISTRATION + THE SINGLE READ-AUTHORIZATION CHOKE POINT (HG v1.2 §6, §13 PR-C).
//
// WHAT WAS THERE BEFORE THIS FILE: nothing. `B2a` had ZERO occurrences in main's tracked code
// (docs/development/platform-overall-design/README.md says so in as many words). The narrow
// stock-preparation path — named PLM/K3 profile + approved config + planner/UoW — was allowed to
// serve exactly one customer, for a bounded time, over a named data scope, without being reused as a
// second general-purpose integration framework. Every one of those words lived in prose. The code
// enforced none of them, and "narrow" held only by everyone remembering to be careful.
//
// ─────────────────────────────────────────────────────────────────────────────
// ARMING SEMANTICS — READ THIS FIRST, IT IS THE WHOLE POSTURE
// ─────────────────────────────────────────────────────────────────────────────
//
//   ENV UNSET  ->  the host omits the config key  ->  `createB2aRegistry` returns `null`
//              ->  DORMANT. Not one call is gated. Behaviour is byte-identical to a deployment that
//                  never heard of this module — same plan, same revision, same evidence keys, same
//                  written payload. Synthetic fixtures, local demos and the whole existing test
//                  corpus are untouched.
//
//   ENV SET    ->  the registry is built ONCE at route registration  ->  ARMED. From that moment
//                  EVERY known source-reading entry point must present a live, in-scope,
//                  unconsumed registration before any external/source DB connect, credential
//                  reload, source query or `sourceAdapter.read` — and every UNKNOWN entry point is
//                  refused by default.
//
// THE THING THAT IS DELIBERATELY *NOT* CODE HERE. Dormancy means an operator who simply never sets
// the env var reads a real customer's PLM with nothing standing in the way. HG v1.2 §6.2 settles
// that split explicitly: the mechanism may be developed and exercised against local synthetic
// fixtures, while creating a REAL customer registration and executing a REAL read both require
// separate owner authorization. Making the code refuse instead would mean every synthetic dry-run in
// CI, every demo and every unit test had to carry a registration file — which is how a gate gets
// switched off wholesale and stays off.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE KEY IS WHAT IT IS (§6.1)
// ─────────────────────────────────────────────────────────────────────────────
//
// R-09's lesson is binding. The existing production-apply instrument
// (stock-preparation-production-policy.cjs) is PROCESS-GLOBAL: one policy per server, carrying no
// tenant field and no project field at all. That was the wrong shape — it can only ever say "this
// server may apply", never "this customer, on this system, for these projects, for this purpose,
// once". A B2a registration that repeated it would be a rename, not a mechanism.
//
// So matching covers, at minimum: tenant + source binding + project/data object + purpose +
// operation. `tenant + project` was explicitly ruled INSUFFICIENT because ONE customer can connect
// several PLM/ERP systems (a PLM and a K3, or two PLM instances mid-migration), and an exception
// granted for one of them must not silently authorize reads against the other.
//
// OBJECT SCOPE IS NOT DECORATION. `objectScope.sourceObjects` enumerates the source objects the read
// plan is allowed to touch, and the guard is handed the objects the plan WILL touch. A read plan
// repointed at one extra table is refused — which is the executable form of "不扩大范围" (R-02) and
// the reason object scope is a separate key component rather than folded into the project scope.
//
// NO CREDENTIALS, EVER. A registration references a managed binding (`sourceBindingRef`, the
// external-system id this plugin already resolves adapters against) and carries opaque
// `authorizationRef` / `operationRef` tokens. It never carries a host, an IP, a username, a
// password, a token or a connection string — §6.1, and the load-time validation below rejects the
// key names that would smuggle them in.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE REGISTRATION = ONE SOURCE-READ OPERATION (§6.1)
// ─────────────────────────────────────────────────────────────────────────────
//
// `sourceReadOperationLimit` is fixed at 1. A single guarded call claims the registration's
// operation before the first read; every page of that same read rides the claim, because paging
// happens INSIDE the one guarded call. A different Run presenting the same registration is refused:
// a new source-read Run needs a new operation and a new one-time authorization.
//
// The consequence is deliberate and worth stating plainly: with a single registration, a dry-run
// spends it. An apply that re-expands the source is a NEW Run and is refused unless a second
// registration authorizes it. That is not an accident of the implementation — §9.1 makes B2a v1
// dry-run-shaped (`B2a-DRY` ApplyCommand count must be 0), so "one authorization, one read" is the
// intended shape, not a limitation of it.
//
// HOW STRONG THE CLAIM IS, HONESTLY. The plugin's storage contract is `get`/`set`/(optional
// `delete`) — there is no compare-and-set primitive and no transaction. `claimReadOperation` below
// does get -> set -> READ BACK AND VERIFY THE STORED RUN IS OURS. On a single process that is exact.
// On a store shared by several processes it NARROWS the race, it does not close it: two writers
// interleaving between the read-back and the set could both believe they won. That is stated here,
// and in the claim function, rather than being described as atomic — a fence that is documented as
// stronger than it is, is worse than one whose edge is known. Closing it needs a storage-level CAS
// (see `updatePointer` in sealed-export/generation-store.cjs for the shape a real one takes), which
// is a storage-contract change, not a change to this file.
//
// ─────────────────────────────────────────────────────────────────────────────
// SHAPE: A FILE, NOT AN ENV-JSON BLOB
// ─────────────────────────────────────────────────────────────────────────────
//
// The host reads `INTEGRATION_CORE_B2A_REGISTRY_PATH` through the generalized
// `readDeployJsonObjectFile` in packages/core-backend/src/plugin-runtime-config.ts — the same reader
// the customer-pack catalog and the ext-field mapping use, for the same reasons: unset omits the
// key; unreadable/malformed THROWS naming the ENV KEY and never echoing the path (a path is
// deployment topology). This module is the plugin-side half, built ONCE at registration
// (stock-preparation-ext-field-mapping-config.cjs's posture, verbatim): closed key set, typed
// errors, a malformed registry fails PLUGIN ACTIVATION rather than a deployer's first dry-run.
//
// BLAST RADIUS, stated plainly: this module is called from `createHandlers`, so a throw here fails
// registration for the ENTIRE plugin. Unlike the ext-field mapping there is deliberately NO `false`
// kill switch: the mapping's escape hatch exists because switching a value-producer off is a normal
// operational act, whereas "switch the B2a gate off" is exactly the act this mechanism exists to
// make impossible from inside the config. Switching it off means unsetting the ENV VAR — a
// deployment change, visible in the deployment, not a value buried in a JSON file.
//
// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION POSTURE (from stock-preparation-production-policy.cjs)
// ─────────────────────────────────────────────────────────────────────────────
//
//   * strict ISO-8601 with time AND zone for `effectiveAt`/`expiresAt` — `Date.parse` alone accepts
//     "2999" and turns a bounded window into a millennium.
//   * a maximum WINDOW cap (`expiresAt - effectiveAt`), so "限时" is real even when both timestamps
//     are individually well-formed.
//   * every listed field REQUIRED. A registration missing `ownerPrincipalRef`,
//     `b2bMigrationCondition` or `expiryHandling` is refused AT LOAD: an exception nobody owns, with
//     no migration condition and no stated consequence for overrunning, is precisely the
//     "首客户交付路径 -> 事实上的第二套集成框架" drift the registration exists to prevent.
//
// ONE DELIBERATE DEVIATION FROM THAT MODULE, and it is a deviation: expiry against the WALL CLOCK is
// checked at CHECK time, not at load. An already-expired registration LOADS (it is well-formed) and
// then refuses every single call. Throwing at load would make plugin activation depend on the time
// of day — a restart one minute past an expiry would take down pipelines, connectors, sealed-export
// and every other capability in this plugin, which is a far worse failure than refusing the one
// gated read. It is also the production-policy module's own structure: it keeps
// `assertProductionPolicyNotExpired` separate precisely so the caller supplies `now` and the module
// holds no clock. `MAX_B2A_REGISTRATION_WINDOW_MS` is what stays load-time, because a window length
// needs no clock to check.
//
// ─────────────────────────────────────────────────────────────────────────────
// VALUES-FREE (§15.1)
// ─────────────────────────────────────────────────────────────────────────────
//
// Refusals and passes carry: a FIXED error code, a coarse reason token, the registry id/version, the
// registration id, and BOOLEANS/COUNTS for each scope dimension. They never carry a data-scope ref, a
// tenant id, a source binding ref, an owner ref, an authorization or operation ref, a source object
// name, a row value, SQL, or a date. Registration ids and registry ids are deployment-authored
// slugs; everything else that could identify a customer stays out.

const crypto = require('node:crypto')

// The single server-config key the host writes. Named for the mechanism, not for stock preparation:
// the registry keys on (tenant, binding, scope, purpose, operation), and the stock-prep line is its
// FIRST consumer rather than its definition. A second consumer arrives as a new `purpose`, not as a
// new config key.
const B2A_REGISTRY_CONFIG_KEY = 'b2aTrialRegistry'

// ─── FIXED ERROR CODES (§13) ─────────────────────────────────────────────────
// Frozen vocabulary. Evidence records the CODE and a coarse reason, never a dynamic message.
const B2A_REGISTRATION_REQUIRED = 'B2A_REGISTRATION_REQUIRED'
const B2A_AUTHORIZATION_INVALID = 'B2A_AUTHORIZATION_INVALID'
const B2A_SCOPE_MISMATCH = 'B2A_SCOPE_MISMATCH'
const B2A_SOURCE_TIMEOUT = 'B2A_SOURCE_TIMEOUT'
const B2A_PAGE_LIMIT_EXCEEDED = 'B2A_PAGE_LIMIT_EXCEEDED'
const B2A_SCHEMA_DRIFT = 'B2A_SCHEMA_DRIFT'
const C6_SAFE_LIFECYCLE_REQUIRED = 'C6_SAFE_LIFECYCLE_REQUIRED'
// Load-time faults are a broken DEPLOYMENT, not a refused caller, so they carry their own code and a
// 500. They are never emitted in response to a request: the registry is built at activation.
const B2A_REGISTRY_INVALID = 'B2A_REGISTRY_INVALID'

const B2A_ERROR_CODES = Object.freeze([
  B2A_REGISTRATION_REQUIRED,
  B2A_AUTHORIZATION_INVALID,
  B2A_SCOPE_MISMATCH,
  B2A_SOURCE_TIMEOUT,
  B2A_PAGE_LIMIT_EXCEEDED,
  B2A_SCHEMA_DRIFT,
  C6_SAFE_LIFECYCLE_REQUIRED,
])

// ─── THE CLOSED ENTRY-POINT VOCABULARY (§13 PR-C: "inventory and guard four entry points") ────
//
// A `purpose` is the identity of a READ ENTRY POINT. It is always a frozen constant spelled here and
// referenced by the call site — never anything derived from a request. Two things follow:
//
//   1. `forbidReuse` means something. A registration bound to one purpose cannot be spent by another
//      consumer reaching for the same binding.
//   2. UNKNOWN ENTRY POINTS DEFAULT-REFUSE. A new read path that has not been inventoried presents a
//      purpose outside this list and is refused (`unknown_entry_point`) rather than inheriting
//      somebody else's registration. Adding a path therefore requires a visible edit to this list.
const B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION = 'stock-preparation.table-action'
const B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST = 'stock-preparation.mvp-persist'
const B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM = 'stock-preparation.large-bom-expansion'
const B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN = 'c6.external-write.dry-run'
const B2A_PURPOSE_PIPELINE_RUNNER_READ = 'pipeline-runner.source-read'
const B2A_PURPOSE_SEALED_SNAPSHOT_SQLSERVER = 'sealed-snapshot.sqlserver-session'

const B2A_PURPOSES = Object.freeze([
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
  B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
  B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN,
  B2A_PURPOSE_PIPELINE_RUNNER_READ,
  B2A_PURPOSE_SEALED_SNAPSHOT_SQLSERVER,
])

// HOW EACH INVENTORIED ENTRY POINT FILLS THE KEY — and where the fill is weaker than the others.
//
// `projectDataScope.dataScopeRefs` is spelled generically, not `projectNos`, because only the
// stock-preparation line HAS a project number. §6.1 asks for a "项目/数据对象" scope, and the honest
// reading is that each path names the strongest data-scope reference IT actually resolves
// server-side. Pretending otherwise — inventing a project id for a path that has none — would make
// the scope check look total while matching on a constant.
//
//   stock-preparation.*            dataScopeRef = the validated `parameters.projectNo`
//                                  sourceObjects = every `object` in the action's read plan
//                                  sourceBindingRef = action.source.externalSystemId
//                                  STRENGTH: full. Every dimension is independently resolved.
//
//   c6.external-write.dry-run      dataScopeRef = `pipeline.projectId`
//   pipeline-runner.source-read    sourceObjects = [`pipeline.sourceObject`]
//                                  sourceBindingRef = `pipeline.sourceSystemId`
//                                  STRENGTH: full, WITH ONE CONSEQUENCE STATED LOUDLY —
//                                  `pipeline.projectId` is NULLABLE (pipelines.cjs stores
//                                  `row.project_id ?? null`). A pipeline with no project id cannot
//                                  be B2a-authorized at all: the guard refuses it with
//                                  `missing_scope`. That is deliberate. A null data scope is not a
//                                  wildcard, and silently treating it as one would let every
//                                  project-less pipeline through the moment the gate is armed.
//
//   sealed-snapshot.sqlserver-     dataScopeRef = the runtime binding's frozen `objectKey`
//   session                        sourceObjects = [the same objectKey]
//                                  sourceBindingRef = SEALED_SNAPSHOT_BINDING_REF (a SENTINEL)
//                                  STRENGTH: WEAKER, and this is the one residual gap in the
//                                  inventory. The sealed-snapshot runtime resolves its own active
//                                  binding INTERNALLY (stock-preparation-runtime-core.cjs), so the
//                                  route that guards it cannot know which external system the run
//                                  will open before the run begins. The guard therefore authorizes
//                                  the SESSION for a tenant + purpose + data scope, and does NOT
//                                  verify the binding instance. Closing that gap means threading the
//                                  registry into the runtime's validated dep list — inside the
//                                  digest-pinned `lib/sealed-export/` tree, whose manifest would
//                                  then have to be re-pinned. That is a change with its own blast
//                                  radius and it is deliberately NOT ridden along here.
const SEALED_SNAPSHOT_BINDING_REF = 'sealed-snapshot:active-binding'

// Bounded exception window. 180 days is long enough for a real narrow-path activation (the v9.1
// freeze estimates B2a at ≈3–5 pw of engineering plus gate calendar) and short enough that an
// exception cannot quietly outlive the P2.5 migration meant to replace it. Reviewed bound; tighten
// it and the only thing that breaks is an over-long registration, at load, loudly.
const MAX_B2A_REGISTRATION_WINDOW_MS = 180 * 24 * 60 * 60 * 1000

// `expiry_handling` must state the disposition of already-frozen artifacts once a registration
// expires (§6.1). Closed vocabulary: writing prose here would be a field that reads like a control
// and is not one.
//   * `deny_replay`  — artifacts are retained but may never be replayed or re-read.
//   * `purge`        — artifacts are to be purged.
// Both refuse NEW reads after expiry; they differ only in what happens to what already exists.
const B2A_EXPIRY_HANDLINGS = Object.freeze(['deny_replay', 'purge'])

const B2A_CONSUMPTION_STATES = Object.freeze(['unconsumed', 'consumed'])
const B2A_STATUSES = Object.freeze(['active', 'revoked'])

const REGISTRY_KEYS = Object.freeze(['registryId', 'registryVersion', 'registrations'])
const REGISTRATION_KEYS = Object.freeze([
  'registrationId',
  'tenantScope',
  'sourceSystemType',
  'sourceBindingRef',
  'projectDataScope',
  'objectScope',
  'purpose',
  'ownerPrincipalRef',
  'authorizationRef',
  'operationRef',
  'effectiveAt',
  'expiresAt',
  'forbidReuse',
  'sourceReadOperationLimit',
  'artifactReplayLimit',
  'consumptionState',
  'consumedAt',
  'b2bMigrationCondition',
  'expiryHandling',
  'status',
  'registrationVersion',
])
const PROJECT_DATA_SCOPE_KEYS = Object.freeze(['dataScopeRefs'])
const OBJECT_SCOPE_KEYS = Object.freeze(['sourceObjects'])

// Key names that would smuggle a credential or a host into a registration. §6.1 forbids them
// outright, and the closed key set above already refuses anything unlisted — this roster exists so
// the REFUSAL NAMES THE RULE ("a registration references a managed binding; it never carries
// connection detail") instead of the generic "unsupported key", which a deployer would read as an
// invitation to find the supported spelling.
const FORBIDDEN_REGISTRATION_KEYS = Object.freeze([
  'host', 'hostname', 'server', 'address', 'ip', 'port',
  'user', 'username', 'password', 'secret', 'token', 'credential', 'credentials',
  'connectionString', 'dsn', 'url', 'uri', 'database', 'schema',
])

/**
 * Every source object a read plan will touch, in sorted order.
 *
 * THIS IS WHAT MAKES `objectScope` AN ENFORCEABLE CONTROL rather than a label. A stock-preparation
 * read plan names its objects declaratively (`pathExAttr.object`, `part.object`, `bomDetail.object`,
 * …), and the expansion queries exactly those. Handing the guard the plan's own object list means a
 * plan repointed at one extra table stops matching a registration that did not enumerate it —
 * R-02's "不扩大范围", enforced rather than asserted.
 *
 * Deliberately structural (walk the plan and collect every `object` string) rather than a hardcoded
 * roster: a hardcoded list would silently keep passing when a future plan grows a new section, which
 * is precisely the case the control exists for. Depth is bounded and cycles are impossible — a read
 * plan is JSON from server config — but the walk is iterative anyway so a malformed one cannot
 * recurse without limit.
 */
function readPlanSourceObjects(readPlan) {
  const objects = new Set()
  const stack = [readPlan]
  let visited = 0
  while (stack.length > 0) {
    // A read plan is a small declarative object; the cap exists so a pathological one degrades to a
    // SMALLER object set (and therefore a refusal), never to an unbounded walk.
    if ((visited += 1) > 1000) break
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item)
      continue
    }
    if (!isPlainObject(node)) continue
    for (const [key, value] of Object.entries(node)) {
      if (key === 'object') {
        const object = optionalString(value)
        if (object) objects.add(object)
        continue
      }
      if (value && typeof value === 'object') stack.push(value)
    }
  }
  return Object.freeze([...objects].sort())
}

class B2aReadAuthorizationError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'B2aReadAuthorizationError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// Load-time fault: the deployment configured something the registry cannot honour. 500, because at
// registration there is no request to refuse — this is a broken deployment, not a rejected caller.
function failConfig(message, details) {
  throw new B2aReadAuthorizationError(500, B2A_REGISTRY_INVALID, message, details || {})
}

// Check-time refusal. 403 with one of the FIXED codes; values-free details.
function refuse(code, reason, message, details) {
  throw new B2aReadAuthorizationError(403, code, message, { reason, ...(details || {}) })
}

// Strict ISO-8601 with explicit time and zone. Lifted from
// stock-preparation-production-policy.cjs deliberately rather than imported: that module is the
// production-APPLY contract, and importing it here would couple a read-side gate to a write-side
// policy that a future change might legitimately move. The two are checked against each other by
// test (b2a-trial-registry.test.cjs runs a shared vector table through both), so the duplication
// cannot drift silently.
function parseStrictIsoTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[9] === undefined ? 0 : Number(match[9])
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10])
  if (month < 1 || month > 12) return null
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day < 1 || day > daysInMonth) return null
  if (hour < 0 || hour > 23) return null
  if (minute < 0 || minute > 59) return null
  if (second < 0 || second > 59) return null
  if (offsetHour < 0 || offsetHour > 23 || offsetMinute < 0 || offsetMinute > 59) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function assertClosedKeySet(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      if (FORBIDDEN_REGISTRATION_KEYS.includes(key)) {
        failConfig(
          `${label}.${key}: a registration references a managed binding and never carries connection detail`,
          { field: `${label}.${key}`, reason: 'connection_detail_forbidden' },
        )
      }
      failConfig(`${label}.${key} is not a supported key`, { field: `${label}.${key}` })
    }
  }
}

function requiredString(value, field) {
  const parsed = optionalString(value)
  if (!parsed) failConfig(`${field} is required`, { field })
  return parsed
}

function requiredStringList(raw, label, keys) {
  if (!isPlainObject(raw)) failConfig(`${label} must be an object`, { field: label })
  assertClosedKeySet(raw, keys, label)
  const listKey = keys[0]
  const list = raw[listKey]
  if (!Array.isArray(list) || list.length === 0) {
    // No wildcard, on purpose. A data scope with no enumeration is not a scope.
    failConfig(`${label}.${listKey} must be a non-empty array`, { field: `${label}.${listKey}` })
  }
  const out = []
  for (let index = 0; index < list.length; index += 1) {
    const value = optionalString(list[index])
    if (!value) failConfig(`${label}.${listKey}[${index}] must be a non-empty string`, { field: `${label}.${listKey}` })
    out.push(value)
  }
  if (new Set(out).size !== out.length) {
    failConfig(`${label}.${listKey} must not repeat an entry`, { field: `${label}.${listKey}` })
  }
  return Object.freeze(out)
}

function requiredEnum(value, allowed, field) {
  const parsed = requiredString(value, field)
  if (!allowed.includes(parsed)) {
    failConfig(`${field} must be one of ${allowed.join(' | ')}`, { field })
  }
  return parsed
}

/**
 * Normalize ONE registration. Every fault is fatal at load.
 *
 * WHAT `forbidReuse` ACTUALLY ENFORCES, stated exactly, because a field that sounds like a control
 * and is not one is worse than no field:
 *
 *   §6.1 fixes it at `true` — a B2a registration may not be written reusable — and it forbids reuse
 *   along three axes, of which this module mechanically enforces all three:
 *     * ACROSS APPLICATIONS / entry points: the registration names a `purpose` from the closed
 *       entry-point vocabulary and matches only that purpose. A different read path presents a
 *       different purpose and is refused with `B2A_SCOPE_MISMATCH`.
 *     * ACROSS OPERATIONS: `sourceReadOperationLimit` is 1 and the operation is CLAIMED before the
 *       first read, so a second Run is refused with `B2A_AUTHORIZATION_INVALID`.
 *     * BEYOND THE AUTHORIZED PURPOSE: a purpose outside the closed vocabulary is refused outright,
 *       so a new entry point cannot quietly inherit an existing registration.
 *
 * WHAT IT DOES NOT ENFORCE, and cannot in this cut:
 *   * It does not stop a human ADDING a second registration to the file for the same binding under
 *     a different purpose or operation. That is a review control — the file is a reviewed artifact —
 *     and this module does not pretend otherwise. What it DOES refuse is two ACTIVE registrations
 *     claiming the same operation (see the uniqueness check in `createB2aRegistry`).
 *   * It does not evaluate `b2bMigrationCondition`. That field is required, recorded and surfaced in
 *     evidence, but it is prose describing a migration acceptance condition; no code in this cut can
 *     decide whether it has been met. What IS enforced is the consequence the freeze cares about:
 *     the narrow path cannot be claimed as a general binding, because every purpose outside the
 *     closed entry-point vocabulary is refused.
 */
function normalizeRegistration(raw, index) {
  const label = `${B2A_REGISTRY_CONFIG_KEY}.registrations[${index}]`
  if (!isPlainObject(raw)) failConfig(`${label} must be an object`, { field: label })
  assertClosedKeySet(raw, REGISTRATION_KEYS, label)

  const registrationId = requiredString(raw.registrationId, `${label}.registrationId`)
  const tenantScope = requiredString(raw.tenantScope, `${label}.tenantScope`)
  // The system TYPE (which product) and the system BINDING (which instance) are separate keys
  // because one customer can run two instances of the same product mid-migration, and an exception
  // for one must not authorize the other.
  const sourceSystemType = requiredString(raw.sourceSystemType, `${label}.sourceSystemType`)
  const sourceBindingRef = requiredString(raw.sourceBindingRef, `${label}.sourceBindingRef`)
  const projectDataScope = Object.freeze({
    dataScopeRefs: requiredStringList(raw.projectDataScope, `${label}.projectDataScope`, PROJECT_DATA_SCOPE_KEYS),
  })
  const objectScope = Object.freeze({
    sourceObjects: requiredStringList(raw.objectScope, `${label}.objectScope`, OBJECT_SCOPE_KEYS),
  })

  const purpose = requiredString(raw.purpose, `${label}.purpose`)
  if (!B2A_PURPOSES.includes(purpose)) {
    failConfig(`${label}.purpose is not a registered B2a read entry point`, { field: `${label}.purpose` })
  }

  const ownerPrincipalRef = requiredString(raw.ownerPrincipalRef, `${label}.ownerPrincipalRef`)
  const authorizationRef = requiredString(raw.authorizationRef, `${label}.authorizationRef`)
  const operationRef = requiredString(raw.operationRef, `${label}.operationRef`)
  const b2bMigrationCondition = requiredString(raw.b2bMigrationCondition, `${label}.b2bMigrationCondition`)
  const expiryHandling = requiredEnum(raw.expiryHandling, B2A_EXPIRY_HANDLINGS, `${label}.expiryHandling`)
  const status = requiredEnum(raw.status, B2A_STATUSES, `${label}.status`)
  const consumptionState = requiredEnum(raw.consumptionState, B2A_CONSUMPTION_STATES, `${label}.consumptionState`)

  // `consumedAt` must AGREE with `consumptionState`. A registration that says "unconsumed" while
  // carrying a consumption timestamp — or the reverse — is an unreadable record, and the one thing
  // a one-time authorization cannot afford is ambiguity about whether it has been spent.
  const consumedAt = raw.consumedAt === undefined || raw.consumedAt === null
    ? null
    : requiredString(raw.consumedAt, `${label}.consumedAt`)
  if (consumptionState === 'consumed' && !consumedAt) {
    failConfig(`${label}.consumedAt is required when consumptionState is consumed`, { field: `${label}.consumedAt` })
  }
  if (consumptionState === 'unconsumed' && consumedAt) {
    failConfig(`${label}.consumedAt must be absent when consumptionState is unconsumed`, { field: `${label}.consumedAt` })
  }
  if (consumedAt && !Number.isFinite(parseStrictIsoTimestamp(consumedAt))) {
    failConfig(`${label}.consumedAt must be a strict ISO-8601 timestamp with time and zone`, { field: `${label}.consumedAt` })
  }

  // §6.1 fixes both of these. They are still spelled out in the file rather than defaulted, so a
  // reviewer reading a registration sees the constraint it is operating under instead of having to
  // know it.
  if (raw.forbidReuse !== true) {
    failConfig(`${label}.forbidReuse must be true — a B2a registration may not be written reusable`, {
      field: `${label}.forbidReuse`,
    })
  }
  if (raw.sourceReadOperationLimit !== 1) {
    failConfig(`${label}.sourceReadOperationLimit must be 1 in B2a`, { field: `${label}.sourceReadOperationLimit` })
  }

  // `artifactReplayLimit` defaults to 0 and, in THIS cut, may only be 0. §6.1 permits a non-zero
  // value only when an O4 authorization text names a replay count — and no artifact in this codebase
  // records an O4 reference, so nothing here could verify such a claim. Accepting a number the code
  // cannot check would be a field that reads like a control and is not one; refusing it is
  // fail-closed and reversible the moment O4 has a representation.
  const artifactReplayLimit = raw.artifactReplayLimit === undefined ? 0 : raw.artifactReplayLimit
  if (!Number.isInteger(artifactReplayLimit) || artifactReplayLimit < 0) {
    failConfig(`${label}.artifactReplayLimit must be a non-negative integer`, { field: `${label}.artifactReplayLimit` })
  }
  if (artifactReplayLimit !== 0) {
    failConfig(
      `${label}.artifactReplayLimit may only be 0 in this cut: a non-zero replay count requires an O4 authorization reference this codebase cannot yet record or verify`,
      { field: `${label}.artifactReplayLimit`, reason: 'artifact_replay_not_authorized' },
    )
  }

  if (!Number.isInteger(raw.registrationVersion) || raw.registrationVersion <= 0) {
    failConfig(`${label}.registrationVersion must be a positive integer`, { field: `${label}.registrationVersion` })
  }
  const registrationVersion = raw.registrationVersion

  const effectiveAt = requiredString(raw.effectiveAt, `${label}.effectiveAt`)
  const effectiveAtMs = parseStrictIsoTimestamp(effectiveAt)
  if (!Number.isFinite(effectiveAtMs)) {
    failConfig(`${label}.effectiveAt must be a strict ISO-8601 timestamp with time and zone`, {
      field: `${label}.effectiveAt`,
    })
  }
  const expiresAt = requiredString(raw.expiresAt, `${label}.expiresAt`)
  const expiresAtMs = parseStrictIsoTimestamp(expiresAt)
  if (!Number.isFinite(expiresAtMs)) {
    failConfig(`${label}.expiresAt must be a strict ISO-8601 timestamp with time and zone`, {
      field: `${label}.expiresAt`,
    })
  }
  if (expiresAtMs <= effectiveAtMs) {
    failConfig(`${label}.expiresAt must be after effectiveAt`, { field: `${label}.expiresAt` })
  }
  // "限时" enforced on the WINDOW LENGTH, which needs no clock and so can be checked at load.
  if (expiresAtMs - effectiveAtMs > MAX_B2A_REGISTRATION_WINDOW_MS) {
    failConfig(`${label} authorization window exceeds the bounded B2a exception window`, {
      field: `${label}.expiresAt`,
    })
  }

  return Object.freeze({
    registrationId,
    tenantScope,
    sourceSystemType,
    sourceBindingRef,
    projectDataScope,
    objectScope,
    purpose,
    ownerPrincipalRef,
    authorizationRef,
    operationRef,
    effectiveAt,
    effectiveAtMs,
    expiresAt,
    expiresAtMs,
    forbidReuse: true,
    sourceReadOperationLimit: 1,
    artifactReplayLimit,
    consumptionState,
    consumedAt,
    b2bMigrationCondition,
    expiryHandling,
    status,
    registrationVersion,
  })
}

/**
 * Read the registry off server config. TWO states only.
 *
 *   * key absent / `undefined` / `null` -> DORMANT. The host omits the key when the env var is
 *     unset, which is the only supported way to be dormant.
 *   * a plain object -> validated, and any fault is fatal at registration.
 *
 * Anything else (a string, an array, a number, `true`, `false`) is FATAL. Note especially that
 * `false` is fatal here where the ext-field mapping treats it as "switched off": that module needs a
 * kill switch an operator can reach without taking the plugin down, whereas the whole point of this
 * one is that it cannot be switched off from inside the configuration file it governs. Turning the
 * B2a gate off is `unset INTEGRATION_CORE_B2A_REGISTRY_PATH` — an act on the deployment, visible in
 * the deployment.
 */
function resolveB2aRegistryConfig(config) {
  if (!config || !Object.prototype.hasOwnProperty.call(config, B2A_REGISTRY_CONFIG_KEY)) {
    return undefined
  }
  const raw = config[B2A_REGISTRY_CONFIG_KEY]
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) {
    failConfig(
      `${B2A_REGISTRY_CONFIG_KEY} must be an object; unset INTEGRATION_CORE_B2A_REGISTRY_PATH to leave the B2a gate dormant`,
      { field: B2A_REGISTRY_CONFIG_KEY },
    )
  }
  return raw
}

// The uniqueness key §6.1 demands: tenant + source binding + project/data object + purpose +
// operation. Two ACTIVE registrations sharing it are a duplicate registration, refused at load —
// which is the mechanical half of R-04's "唯一 active". Scope lists are sorted so the key does not
// depend on the order a deployer happened to write them in.
function matchingKeyOf(registration) {
  return JSON.stringify([
    registration.tenantScope,
    registration.sourceSystemType,
    registration.sourceBindingRef,
    [...registration.projectDataScope.dataScopeRefs].sort(),
    [...registration.objectScope.sourceObjects].sort(),
    registration.purpose,
    registration.operationRef,
  ])
}

/**
 * Build the ONE registry this server enforces, or `null` when the env var is unset (DORMANT).
 *
 * An ARMED registry with an EMPTY `registrations` array is legal and refuses everything. That is not
 * a degenerate case to reject — it is the correct state for a deployment that has armed the gate and
 * has not yet had an exception approved, and rejecting it would push operators toward leaving the
 * env var unset instead, which is strictly worse.
 *
 * @param {object} options.config server config (`context.config`)
 * @returns {object|null} a frozen registry, or `null` when dormant.
 */
function createB2aRegistry({ config } = {}) {
  const raw = resolveB2aRegistryConfig(config)
  if (raw === undefined) return null

  assertClosedKeySet(raw, REGISTRY_KEYS, B2A_REGISTRY_CONFIG_KEY)
  const registryId = requiredString(raw.registryId, `${B2A_REGISTRY_CONFIG_KEY}.registryId`)
  if (!Number.isInteger(raw.registryVersion) || raw.registryVersion <= 0) {
    failConfig(`${B2A_REGISTRY_CONFIG_KEY}.registryVersion must be a positive integer`, {
      field: `${B2A_REGISTRY_CONFIG_KEY}.registryVersion`,
    })
  }
  if (!Array.isArray(raw.registrations)) {
    failConfig(`${B2A_REGISTRY_CONFIG_KEY}.registrations must be an array`, {
      field: `${B2A_REGISTRY_CONFIG_KEY}.registrations`,
    })
  }

  const registrations = raw.registrations.map((entry, index) => normalizeRegistration(entry, index))

  const seenIds = new Set()
  const seenMatchingKeys = new Set()
  const highestVersionById = new Map()
  for (const registration of registrations) {
    // Duplicate ids would make an evidence stanza ambiguous about WHICH registration authorized a
    // read, which is the one thing the stanza exists to say.
    if (seenIds.has(registration.registrationId)) {
      failConfig(`${B2A_REGISTRY_CONFIG_KEY}.registrations contains a duplicate registrationId`, {
        field: `${B2A_REGISTRY_CONFIG_KEY}.registrations`,
        registrationId: registration.registrationId,
        reason: 'duplicate_registration_id',
      })
    }
    seenIds.add(registration.registrationId)

    // R-04, load-time half: two ACTIVE registrations claiming the same operation for the same scope.
    // Revoked ones are exempt — a revoked record is history, and superseding a registration by
    // revoking it and writing a replacement must stay possible.
    if (registration.status === 'active') {
      const key = matchingKeyOf(registration)
      if (seenMatchingKeys.has(key)) {
        failConfig(
          `${B2A_REGISTRY_CONFIG_KEY}.registrations contains two active registrations for the same tenant, binding, scope, purpose and operation`,
          { field: `${B2A_REGISTRY_CONFIG_KEY}.registrations`, reason: 'duplicate_active_registration' },
        )
      }
      seenMatchingKeys.add(key)
    }
    const previous = highestVersionById.get(registration.registrationId)
    if (previous === undefined || registration.registrationVersion > previous) {
      highestVersionById.set(registration.registrationId, registration.registrationVersion)
    }
  }

  return Object.freeze({
    registryId,
    registryVersion: raw.registryVersion,
    registrations: Object.freeze(registrations),
    registrationCount: registrations.length,
  })
}

function isRegistry(value) {
  return Boolean(
    isPlainObject(value)
    && typeof value.registryId === 'string'
    && Array.isArray(value.registrations),
  )
}

// ─── DURABLE CLAIM STATE ─────────────────────────────────────────────────────

const CLAIM_KEY_PREFIX = 'integration:b2a:operation-claim:'
const VERSION_KEY_PREFIX = 'integration:b2a:registration-version:'

// Store keys must never carry a customer identifier in the clear: they can end up in a durable row,
// a key listing or a log. The scope half is hashed; the registration id (a deployment-authored slug)
// stays readable so an operator can correlate a claim with the file they wrote.
function claimKey(registration) {
  const scopeDigest = crypto.createHash('sha256').update(matchingKeyOf(registration)).digest('hex').slice(0, 32)
  return `${CLAIM_KEY_PREFIX}${registration.registrationId}:${registration.registrationVersion}:${scopeDigest}`
}

function versionKey(registration) {
  return `${VERSION_KEY_PREFIX}${registration.registrationId}`
}

function requireClaimStore(store) {
  // FAIL-CLOSED. Without durable state a one-time authorization cannot be one-time, so an armed
  // deployment with no store refuses rather than degrading to an unlimited read.
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    refuse(
      B2A_AUTHORIZATION_INVALID,
      'claim_store_unavailable',
      'a B2a-gated read requires durable operation-claim storage',
      {},
    )
  }
  return store
}

/**
 * R-04's runtime half: a registration may never be presented at a LOWER version than one already
 * seen. Rewinding `registrationVersion` is how a spent or narrowed authorization would be resurrected
 * — the file is edited back to an older, wider revision — and the file alone cannot detect it,
 * because each load sees only what it was given.
 *
 * The highest version ever presented is therefore remembered in durable storage. Equal is fine (the
 * same revision, used again within its operation claim); lower is refused.
 */
async function assertNoRegistrationVersionDowngrade(store, registration) {
  const key = versionKey(registration)
  const seen = await store.get(key)
  const seenVersion = isPlainObject(seen) && Number.isInteger(seen.registrationVersion)
    ? seen.registrationVersion
    : null
  if (seenVersion !== null && registration.registrationVersion < seenVersion) {
    refuse(
      B2A_AUTHORIZATION_INVALID,
      'registration_version_downgrade',
      'the presented B2a registration is older than a version already seen',
      { registrationId: registration.registrationId },
    )
  }
  if (seenVersion === null || registration.registrationVersion > seenVersion) {
    await store.set(key, { registrationVersion: registration.registrationVersion })
  }
}

/**
 * Claim the registration's ONE source-read operation for this Run.
 *
 * SAME RUN -> allowed. Every page of one guarded read rides a single claim, because paging happens
 * inside the one guarded call; and a path that legitimately re-enters the guard for the same Run
 * (the large-BOM expansion job, whose `runId` is its job id) continues on the claim it already
 * holds. `pageReads` counts re-entries so evidence can show the read stayed bounded.
 *
 * DIFFERENT RUN -> refused. `sourceReadOperationLimit` is 1: a new source-read Run needs a new
 * operation and a new one-time authorization.
 *
 * HOW ATOMIC THIS IS, precisely. The plugin storage contract is `get`/`set` with no compare-and-set
 * and no transaction, so this is get -> set -> read back and verify the stored run is ours. On one
 * process that is exact. On a store shared by several processes it narrows the race without closing
 * it: two writers interleaving between the read-back and the set could both conclude they won.
 * Documented rather than described as atomic — a fence claimed to be stronger than it is, is worse
 * than one whose edge is known. Closing it needs a storage-level CAS (see `updatePointer` in
 * sealed-export/generation-store.cjs), which is a storage-contract change, not a change here.
 */
async function claimReadOperation(store, registration, runId, now) {
  const key = claimKey(registration)
  const existing = await store.get(key)
  if (isPlainObject(existing)) {
    if (existing.runId !== runId) {
      refuse(
        B2A_AUTHORIZATION_INVALID,
        'operation_already_consumed',
        'this B2a registration has already been consumed by another source-read run',
        { registrationId: registration.registrationId, sourceReadOperationLimit: 1 },
      )
    }
    const pageReads = Number.isInteger(existing.pageReads) ? existing.pageReads + 1 : 1
    await store.set(key, { ...existing, pageReads })
    return { claimed: false, continued: true, pageReads }
  }
  await store.set(key, { runId, claimedAtMs: now, pageReads: 1 })
  const readBack = await store.get(key)
  if (!isPlainObject(readBack) || readBack.runId !== runId) {
    // Someone else's claim landed between the read and the write.
    refuse(
      B2A_AUTHORIZATION_INVALID,
      'operation_claim_lost',
      'another source-read run claimed this B2a registration concurrently',
      { registrationId: registration.registrationId },
    )
  }
  return { claimed: true, continued: false, pageReads: 1 }
}

// ─── THE CHOKE POINT ─────────────────────────────────────────────────────────

/**
 * THE SINGLE READ-AUTHORIZATION GUARD (§13 PR-C).
 *
 * Call this BEFORE any external/source DB connect, credential reload, source query or
 * `sourceAdapter.read`. Looking up the platform's own registration state (this function's storage
 * reads) is explicitly NOT one of those things — §6.1 says so, and it is why the guard may use
 * durable storage without violating the property it enforces.
 *
 * @param {object|null} o.registry         server-resolved; `null` => dormant => returns `null`
 * @param {object}      o.store            durable claim store (`context.storage`)
 * @param {string}      o.tenantScope      server-resolved from the request principal
 * @param {string}      o.sourceSystemType server-resolved (which product)
 * @param {string}      o.sourceBindingRef server-resolved (which instance)
 * @param {string}      o.dataScopeRef     the validated project/data-scope reference for this path
 * @param {string[]}    o.sourceObjects    the source objects this read WILL touch
 * @param {string}      o.purpose          a frozen `B2A_PURPOSES` constant, never request-derived
 * @param {string}      o.runId            identifies this source-read Run
 * @param {number}      o.now              caller-supplied clock (this module holds none)
 * @returns {Promise<object|null>} `null` when dormant; otherwise a frozen, values-free stanza.
 * @throws  {B2aReadAuthorizationError} 403 with a FIXED code when armed and unauthorized.
 */
async function assertB2aReadAuthorization(options = {}) {
  const { registry } = options
  // DORMANT. Returning `null` — rather than a stanza saying "not armed" — is what keeps the dormant
  // path byte-identical: every caller attaches evidence only when this is non-null, so a dormant
  // deployment produces exactly the object graph it produced before this module existed.
  if (registry === null || registry === undefined) return null
  if (!isRegistry(registry)) {
    // Not a caller's fault and not refusable as one: a caller reached the guard with something that
    // is not a built registry. 500 and fail-closed — never fall through to "allow".
    failConfig('the B2a registry must be built by createB2aRegistry before the guard runs', { field: 'registry' })
  }

  const evidenceBase = { registryId: registry.registryId, registryVersion: registry.registryVersion }

  // UNKNOWN ENTRY POINTS DEFAULT-REFUSE. Unreachable from a request — purposes are module constants
  // at every call site — so this fires when a NEW read path is added without being inventoried, which
  // is exactly when it should.
  const purpose = optionalString(options.purpose)
  if (!purpose || !B2A_PURPOSES.includes(purpose)) {
    refuse(B2A_REGISTRATION_REQUIRED, 'unknown_entry_point',
      'this read path is not a registered B2a entry point', evidenceBase)
  }
  const scoped = { ...evidenceBase, purpose }

  const tenantScope = optionalString(options.tenantScope)
  const sourceSystemType = optionalString(options.sourceSystemType)
  const sourceBindingRef = optionalString(options.sourceBindingRef)
  const dataScopeRef = optionalString(options.dataScopeRef)
  const sourceObjects = Array.isArray(options.sourceObjects)
    ? options.sourceObjects.map(optionalString).filter(Boolean)
    : []
  if (!tenantScope || !sourceSystemType || !sourceBindingRef || !dataScopeRef || sourceObjects.length === 0) {
    // Fail-closed on an under-specified call. Booleans only — the missing dimension is named, its
    // value never is.
    refuse(B2A_SCOPE_MISMATCH, 'missing_scope',
      'a B2a-gated read must resolve tenant, source system, binding, data scope and source objects', {
        ...scoped,
        tenantResolved: Boolean(tenantScope),
        sourceSystemTypeResolved: Boolean(sourceSystemType),
        sourceBindingResolved: Boolean(sourceBindingRef),
        dataScopeResolved: Boolean(dataScopeRef),
        objectCount: sourceObjects.length,
      })
  }

  const now = options.now
  if (!Number.isFinite(now)) {
    refuse(B2A_AUTHORIZATION_INVALID, 'missing_now',
      'a current timestamp is required for the B2a validity check', scoped)
  }
  const runId = optionalString(options.runId)
  if (!runId) {
    // Without a Run identity the one-operation limit cannot be enforced at all.
    refuse(B2A_AUTHORIZATION_INVALID, 'missing_run_id',
      'a B2a-gated read must identify its source-read run', scoped)
  }
  const store = requireClaimStore(options.store)

  // 1. BINDING — tenant + system type + binding instance. The half `tenant + project` could not
  //    express, and the reason review ruled that key insufficient.
  const bindingMatches = registry.registrations.filter((r) =>
    r.tenantScope === tenantScope
    && r.sourceSystemType === sourceSystemType
    && r.sourceBindingRef === sourceBindingRef)
  if (bindingMatches.length === 0) {
    // Nothing to name: no registration was found, so no registration id is disclosed.
    refuse(B2A_REGISTRATION_REQUIRED, 'no_registration',
      'no B2a registration covers this tenant and source binding', scoped)
  }

  // 2. STATUS — a revoked registration authorizes nothing.
  const active = bindingMatches.filter((r) => r.status === 'active')
  if (active.length === 0) {
    refuse(B2A_REGISTRATION_REQUIRED, 'revoked',
      'every B2a registration for this binding has been revoked', {
        ...scoped, registrationIds: bindingMatches.map((r) => r.registrationId),
      })
  }

  // 3. PURPOSE — forbidReuse across applications / entry points.
  const purposeMatches = active.filter((r) => r.purpose === purpose)
  if (purposeMatches.length === 0) {
    refuse(B2A_SCOPE_MISMATCH, 'purpose_not_permitted',
      'the B2a registration for this binding forbids reuse by this consumer', {
        ...scoped, registrationIds: active.map((r) => r.registrationId), forbidReuse: true,
      })
  }

  // 4. PROJECT SCOPE.
  const scopeMatches = purposeMatches.filter((r) => r.projectDataScope.dataScopeRefs.includes(dataScopeRef))
  if (scopeMatches.length === 0) {
    refuse(B2A_SCOPE_MISMATCH, 'data_scope_mismatch',
      'the requested project/data scope is outside the registered B2a scope', {
        ...scoped, registrationIds: purposeMatches.map((r) => r.registrationId), dataScopeInScope: false,
      })
  }

  // 5. OBJECT SCOPE — every object the read will touch must be enumerated. A read plan repointed at
  //    one extra table is refused; the count of unauthorized objects is reported, never their names.
  const objectMatches = scopeMatches.filter((r) =>
    sourceObjects.every((object) => r.objectScope.sourceObjects.includes(object)))
  if (objectMatches.length === 0) {
    const shortfall = Math.min(...scopeMatches.map((r) =>
      sourceObjects.filter((object) => !r.objectScope.sourceObjects.includes(object)).length))
    refuse(B2A_SCOPE_MISMATCH, 'object_out_of_scope',
      'the read reaches source objects outside the registered B2a object scope', {
        ...scoped,
        registrationIds: scopeMatches.map((r) => r.registrationId),
        objectInScope: false,
        unauthorizedObjectCount: shortfall,
      })
  }

  // 6. VALIDITY WINDOW.
  const live = objectMatches.filter((r) => now >= r.effectiveAtMs && now < r.expiresAtMs)
  if (live.length === 0) {
    const notYet = objectMatches.every((r) => now < r.effectiveAtMs)
    refuse(B2A_REGISTRATION_REQUIRED, notYet ? 'not_yet_effective' : 'expired', notYet
      ? 'the B2a registration covering this read is not yet effective'
      : 'the B2a registration covering this read has expired', {
      ...scoped,
      registrationIds: objectMatches.map((r) => r.registrationId),
      effective: !notYet,
      notExpired: notYet,
      // The registration's own declared disposition for artifacts frozen under it, echoed so the
      // refusal states which rule applies to what already exists. A closed token, not prose.
      expiryHandling: objectMatches[0].expiryHandling,
    })
  }

  // 7. CONSUMPTION recorded in the FILE. A registration a deployer has already marked spent
  //    authorizes nothing, whatever the durable claim says.
  const unspent = live.filter((r) => r.consumptionState === 'unconsumed')
  if (unspent.length === 0) {
    refuse(B2A_AUTHORIZATION_INVALID, 'already_consumed',
      'the B2a registration covering this read is recorded as consumed', {
        ...scoped, registrationIds: live.map((r) => r.registrationId),
      })
  }

  // Deterministic pick: the registration expiring SOONEST, so evidence names the narrowest
  // authorization in force rather than an arbitrary one, and stable under input order.
  const candidates = unspent.slice().sort((a, b) =>
    (a.expiresAtMs - b.expiresAtMs) || (a.registrationId < b.registrationId ? -1 : 1))

  // 8. VERSION + 9. OPERATION CLAIM. Try candidates in order so a registration already spent by
  //    another Run does not mask a sibling that is still available — but a VERSION DOWNGRADE is
  //    fatal immediately, because it is a property of the file, not of this Run's luck.
  let lastRefusal = null
  for (const registration of candidates) {
    await assertNoRegistrationVersionDowngrade(store, registration)
    try {
      const claim = await claimReadOperation(store, registration, runId, now)
      return Object.freeze({
        armed: true,
        registryId: registry.registryId,
        registryVersion: registry.registryVersion,
        registrationId: registration.registrationId,
        registrationVersion: registration.registrationVersion,
        purpose,
        sourceBindingMatched: true,
        dataScopeInScope: true,
        objectInScope: true,
        objectCount: sourceObjects.length,
        effective: true,
        notExpired: true,
        forbidReuse: true,
        sourceReadOperationLimit: 1,
        artifactReplayLimit: registration.artifactReplayLimit,
        expiryHandling: registration.expiryHandling,
        operationClaimed: claim.claimed,
        operationContinued: claim.continued,
        pageReads: claim.pageReads,
      })
    } catch (error) {
      if (!(error instanceof B2aReadAuthorizationError)) throw error
      lastRefusal = error
    }
  }
  throw lastRefusal
}

module.exports = {
  B2A_REGISTRY_CONFIG_KEY,
  B2A_PURPOSES,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
  B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
  B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN,
  B2A_PURPOSE_PIPELINE_RUNNER_READ,
  B2A_PURPOSE_SEALED_SNAPSHOT_SQLSERVER,
  SEALED_SNAPSHOT_BINDING_REF,
  readPlanSourceObjects,
  B2A_ERROR_CODES,
  B2A_REGISTRATION_REQUIRED,
  B2A_AUTHORIZATION_INVALID,
  B2A_SCOPE_MISMATCH,
  B2A_SOURCE_TIMEOUT,
  B2A_PAGE_LIMIT_EXCEEDED,
  B2A_SCHEMA_DRIFT,
  C6_SAFE_LIFECYCLE_REQUIRED,
  B2A_REGISTRY_INVALID,
  B2A_EXPIRY_HANDLINGS,
  B2A_CONSUMPTION_STATES,
  B2A_STATUSES,
  MAX_B2A_REGISTRATION_WINDOW_MS,
  B2aReadAuthorizationError,
  assertB2aReadAuthorization,
  createB2aRegistry,
  resolveB2aRegistryConfig,
}
