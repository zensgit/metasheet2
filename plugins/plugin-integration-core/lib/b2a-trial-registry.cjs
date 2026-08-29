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
// HOW STRONG THE CLAIM IS — MIGRATION 078 CHANGED THIS ANSWER. The plugin's key-value storage
// contract is `get`/`set`/(optional `delete`) with no compare-and-set and no transaction, and its
// `set` is an unconditional upsert. `claimReadOperation` used to do get -> set -> READ BACK AND
// VERIFY over exactly that: exact on a single process, and on a store shared by several processes it
// NARROWED the race without closing it — two writers interleaving between the read-back and the set
// could both believe they won. The old header said so rather than claiming atomicity, and then said
// closing it needed a storage-contract change. That last part was wrong: it needed a TABLE.
//
// It now has one. `integration_b2a_operation_claim` (migration 078) has the claim key as its PRIMARY
// KEY, and claiming is a plain INSERT, so of two concurrent claimers exactly one lands — the
// identical shape PR-A already uses for the confirmation-decision reconcile lease (migration 077).
// The loser reads the winning row back and either CONTINUES on it (same Run) or is refused. The
// AUTHORITY for who holds an operation is that row. The `plugin_kv` record survives only as a
// values-free PROJECTION carrying the `pageReads` re-entry counter for evidence.
//
// FAIL-CLOSED, WITH NO FALLBACK. An ARMED deployment that cannot reach the claim (no `db`) refuses
// every gated read with `operation_claim_unavailable`. It does NOT fall back to the kv-only path:
// "the database was unavailable" is not a reason to widen a one-time authorization. A DORMANT
// deployment is untouched — it never reaches this code at all.
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
// §9.1(3) and E3-02/E3-05 name this code; §13's suggested roster does not list it, because §13 lists
// the REGISTRY codes and this one belongs to the full-batch property. It is in the frozen vocabulary
// because the acceptance matrix asserts on it by name.
const C6_FULL_BATCH_INCOMPLETE = 'C6_FULL_BATCH_INCOMPLETE'
// Load-time faults are a broken DEPLOYMENT, not a refused caller, so they carry their own code and a
// 500. They are never emitted in response to a request: the registry is built at activation.
const B2A_REGISTRY_INVALID = 'B2A_REGISTRY_INVALID'
// W-5, floor 1: an ARMED B2a read over a sqlserver data source configured with
// connection.requestTimeoutMs=0 ("no timeout" — legitimate for the general adapter, MSSQLAdapter.ts's
// `?? 30000` deliberately does not override an explicit 0) is refused BEFORE any source connection.
// Distinct from `B2A_SOURCE_TIMEOUT` (§13/R-05, 504): that code maps a read that DID connect and then
// timed out; this one refuses a read that would never time out at all. See
// `refuseB2aArmedSqlServerRequestTimeoutDisabled` below — the seam that resolves an armed read's
// source config throws this directly, never through the R-05 cause-class mapper (there is no driver
// failure to classify here; the connection is never opened).
const B2A_SOURCE_TIMEOUT_DISABLED_REJECTED = 'B2A_SOURCE_TIMEOUT_DISABLED_REJECTED'

const B2A_ERROR_CODES = Object.freeze([
  B2A_REGISTRATION_REQUIRED,
  B2A_AUTHORIZATION_INVALID,
  B2A_SCOPE_MISMATCH,
  B2A_SOURCE_TIMEOUT,
  B2A_PAGE_LIMIT_EXCEEDED,
  B2A_SCHEMA_DRIFT,
  C6_SAFE_LIFECYCLE_REQUIRED,
  C6_FULL_BATCH_INCOMPLETE,
  B2A_SOURCE_TIMEOUT_DISABLED_REJECTED,
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

// ─── THE ALREADY-ASSERTED RUN MARKER (W-2) ───────────────────────────────────
//
// The choke point stands at TWO layers on the pipeline path now: the HTTP route (where PR-C put it)
// and the pipeline RUNNER (sunk there so in-process callers — the cross-plugin communication API's
// `runPipeline` / `replayDeadLetter` — are covered as well). Both must ASSERT. Exactly one may
// CONSUME the registration's single operation.
//
// The mechanism is the one the stock-preparation route/wrapper pair already uses, and nothing new:
// THE TWO GUARDS SHARE A RUN. Whichever layer asserts FIRST generates the run id and claims; the
// layer beneath is handed that same id, and `claimReadOperation` recognises it as the run that
// already holds the claim, so it CONTINUES (`operationClaimed: false`, `operationContinued: true`,
// `pageReads` incremented) rather than taking a second one. A caller that presents NO marker gets a
// freshly generated run id and claims in its own right — which is the correct behaviour for an
// in-process caller that no route ever fenced.
//
// WHY A SYMBOL AND NOT A STRING KEY. The run id is the thing that decides whether a claim is
// continued or refused, so a caller able to set it could ride somebody else's authorization. A
// symbol cannot be expressed in JSON, so it cannot arrive over a cross-plugin call, an HTTP body or
// a query string; only a module that imports this constant can set one, and every such module is
// inside this plugin and generates the id server-side. `index.cjs` strips it off cross-plugin input
// anyway — belt and braces, because "not expressible in JSON" is a property of today's transport
// rather than a fence.
const B2A_AUTHORIZED_RUN_ID = Symbol('b2aAuthorizedRunId')

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
// Migration 078. The AUTHORITY for "who holds this registration's one source-read operation".
const B2A_OPERATION_CLAIM_TABLE = 'integration_b2a_operation_claim'

// The OPERATION identity, hashed: tenant + system type + binding + data scope + object scope +
// purpose + operationRef (`matchingKeyOf`). Hashed because every one of those components is or can
// be a customer identifier, and this value lands in a durable row, a key listing and a log.
function operationDigest(registration) {
  return crypto.createHash('sha256').update(matchingKeyOf(registration)).digest('hex').slice(0, 32)
}

// Store keys must never carry a customer identifier in the clear: they can end up in a durable row,
// a key listing or a log. The scope half is hashed; the registration id (a deployment-authored slug)
// stays readable so an operator can correlate a claim with the file they wrote.
//
// This is ALSO the primary key of `integration_b2a_operation_claim` — the kv projection and the SQL
// row are deliberately keyed identically, so an operator reading either one is looking at the same
// operation.
function claimKey(registration) {
  return `${CLAIM_KEY_PREFIX}${registration.registrationId}:${registration.registrationVersion}:${operationDigest(registration)}`
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

function requireOperationClaim(operationClaim) {
  // FAIL-CLOSED, and this one has no fallback BY DESIGN. The kv store above cannot enforce
  // one-shot-ness across processes (its `set` is an unconditional upsert), so an armed deployment
  // that cannot reach the DB-enforced claim refuses rather than quietly degrading to the
  // read-then-write shape this migration exists to replace. "The database was unavailable" is not a
  // reason to widen an authorization.
  if (!operationClaim || typeof operationClaim.claim !== 'function') {
    refuse(
      B2A_AUTHORIZATION_INVALID,
      'operation_claim_unavailable',
      'a B2a-gated read requires the database-enforced one-shot operation claim',
      {},
    )
  }
  return operationClaim
}

/**
 * THE DB-ENFORCED ONE-SHOT CLAIM (migration 078).
 *
 * Shaped on `createConfirmationDecisionReconcileLease` (PR-A) deliberately: this plugin already
 * solved the identical "an in-process read-then-write is not a concurrency guarantee" problem there,
 * and solving it a second way would leave two protocols to reason about.
 *
 * ACQUISITION IS A PLAIN INSERT. `claim_key` is the table's PRIMARY KEY, so of two concurrent
 * claimers for the same operation exactly one row lands and the other's INSERT dies at the unique
 * index — inside the database, not inside a process. The loser then READS the winning row back and
 * asks one question: is the run that holds it MY run?
 *
 *   SAME RUN  -> `held: true, claimed: false`. Bounded paging inside one operation, and the
 *                large-BOM expansion job that legitimately re-enters the guard under its own job id.
 *   OTHER RUN -> `held: false`. The caller refuses with the fixed `operation_already_consumed` code.
 *
 * WHY THERE IS NO TTL AND NO STEAL — the one place this deliberately diverges from 077. A lease is a
 * temporary right that must be recoverable when its holder dies. An operation claim is PERMANENT:
 * the registration's single authorization is spent, and a second source-read Run needs a second
 * registration and a second one-time human authorization. A claim that expired would be a renewable
 * one-shot, which is not a thing.
 *
 * FAIL-CLOSED ON ANY INSERT FAILURE. A failed INSERT is not assumed to be a unique violation: the
 * row is read back and the decision is made from what is actually there. If nothing is there — the
 * INSERT failed for some other reason entirely — the answer is `held: false`, i.e. refuse. Never
 * fail-open.
 *
 * @param {object} options.db scoped SQL helper (`insertOne`/`selectOne`), from `createDb` in index.cjs
 */
function createB2aOperationClaim({ db } = {}) {
  if (!db || typeof db.insertOne !== 'function' || typeof db.selectOne !== 'function') {
    throw new Error('createB2aOperationClaim: scoped db helper (insertOne/selectOne) is required')
  }
  return {
    table: B2A_OPERATION_CLAIM_TABLE,
    async claim({ claimKey: key, registrationId, registrationVersion, operationDigest: digest, runId, claimedAtMs }) {
      const row = {
        claim_key: key,
        registration_id: registrationId,
        registration_version: registrationVersion,
        operation_digest: digest,
        run_id: runId,
        claimed_at: new Date(claimedAtMs).toISOString(),
      }
      try {
        await db.insertOne(B2A_OPERATION_CLAIM_TABLE, row)
        return { held: true, claimed: true, holderRunId: runId }
      } catch {
        // Unique violation (someone already claimed this operation) — resolve against the row that
        // is actually there. Any other insert failure lands here too and resolves to refused.
      }
      const current = await db.selectOne(B2A_OPERATION_CLAIM_TABLE, { claim_key: key })
      if (!current) return { held: false, claimed: false, holderRunId: null }
      const holderRunId = typeof current.run_id === 'string' ? current.run_id : null
      return { held: holderRunId === runId, claimed: false, holderRunId }
    },
  }
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
 * HOW ATOMIC THIS IS, precisely — and this is the sentence migration 078 changed. The decision is
 * now a single INSERT into `integration_b2a_operation_claim`, whose PRIMARY KEY is the claim key. Of
 * two concurrent claimers exactly one row lands; the other's INSERT dies at the unique index, INSIDE
 * THE DATABASE, and it then reads the winning row back to learn whose it is. What used to be here —
 * get -> set -> read back over a kv `set` that is an unconditional upsert — was exact on one process
 * and merely NARROWED the race on a store shared by several, and said so. It is gone.
 *
 * WHAT THE kv RECORD IS NOW. A values-free PROJECTION, not the authority. It carries `pageReads`,
 * the re-entry counter evidence stanzas report, and nothing decides anything from it any more. If it
 * were wiped, a same-run re-entry would simply restart the counter at 1 — an evidence detail — while
 * the operation's ownership, which is the property that matters, still comes from the SQL row.
 */
async function claimReadOperation(store, operationClaim, registration, runId, now) {
  const key = claimKey(registration)
  const decision = await operationClaim.claim({
    claimKey: key,
    registrationId: registration.registrationId,
    registrationVersion: registration.registrationVersion,
    operationDigest: operationDigest(registration),
    runId,
    claimedAtMs: now,
  })
  if (!decision.held) {
    if (decision.holderRunId === null) {
      // The claim could not be established AND no row is there to explain why: the database did not
      // accept the INSERT for some reason other than a conflict. Fail closed — an unestablished
      // claim authorizes nothing.
      refuse(
        B2A_AUTHORIZATION_INVALID,
        'operation_claim_lost',
        'the durable claim on this B2a registration could not be established',
        { registrationId: registration.registrationId },
      )
    }
    refuse(
      B2A_AUTHORIZATION_INVALID,
      'operation_already_consumed',
      'this B2a registration has already been consumed by another source-read run',
      { registrationId: registration.registrationId, sourceReadOperationLimit: 1 },
    )
  }
  const existing = await store.get(key)
  if (decision.claimed) {
    await store.set(key, { runId, claimedAtMs: now, pageReads: 1 })
    return { claimed: true, continued: false, pageReads: 1 }
  }
  const previous = isPlainObject(existing) ? existing : {}
  const pageReads = Number.isInteger(previous.pageReads) ? previous.pageReads + 1 : 1
  await store.set(key, { ...previous, runId, claimedAtMs: previous.claimedAtMs || now, pageReads })
  return { claimed: false, continued: true, pageReads }
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
 * @param {object}      o.store            durable kv projection store (`context.storage`)
 * @param {object}      o.operationClaim   DB-enforced one-shot claim (`createB2aOperationClaim`);
 *                                         REQUIRED when armed — absent means refuse, never degrade
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
  // Migration 078. NOT optional when armed, and there is no non-CAS fallback behind it.
  const operationClaim = requireOperationClaim(options.operationClaim)

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
      const claim = await claimReadOperation(store, operationClaim, registration, runId, now)
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

// ─── R-05: THE READ-HARDENING CODES, SURFACED AT THE SEAM ────────────────────
//
// `B2A_SOURCE_TIMEOUT` and `B2A_PAGE_LIMIT_EXCEEDED` were frozen vocabulary with NO PRODUCER: pinned
// by test, exported, never thrown. This is the producer, and it is a MAPPER, not new adapter
// behaviour. The hardening itself already exists at two layers and neither is touched here:
//
//   * the HOST sets the driver's `requestTimeout` (packages/core-backend/src/data-adapters/
//     MSSQLAdapter.ts, `connection.requestTimeoutMs`, default 30s);
//   * the stock-preparation expander enforces its own row/page/read-count/elapsed budgets
//     (stock-preparation-bom-expansion.cjs — `maxRows`, `maxPages`, `maxReadCount`, `maxElapsedMs`).
//
// What was missing is that an ARMED B2a read surfaced those failures as whatever the driver happened
// to throw. An mssql request timeout arrives as a raw driver error (`name: 'RequestError'`,
// `code: 'ETIMEOUT'`) that nothing in this repo recognizes, and `inferHttpStatus` turns it into a
// 500 with a dynamic message — which is both values-BEARING and unusable as evidence.
//
// SO: WHAT IS MAPPED, AND WHAT IS NOT.
//
//   MAPPED. A failure whose CAUSE CLASS — `error.details.code`, else `error.code`, else `error.name`
//   — is on one of the closed rosters below. The roster is the whole contract: a cause class that is
//   not on it is NOT mapped and propagates exactly as it did before, because inventing a fixed code
//   for an unrecognized failure would claim a classification the code cannot make.
//
//   NOT MAPPED, and stated rather than papered over: the host's own row ceiling
//   (`resolveEffectiveLimit` in BaseAdapter.ts, limit > 10000) throws a BARE `Error` with no `code`
//   and `name === 'Error'`. It is structurally indistinguishable from any other bare error, and the
//   only thing that identifies it is its MESSAGE. Matching on a message would be both brittle and a
//   values-discipline violation dressed as a control, so that one ceiling stays unmapped. It is also
//   unreachable from this path in practice — the expander's `pageLimit` defaults to 1000 and its own
//   `maxRows` budget fires first — but "unreachable in practice" is not the same as "mapped", and
//   this comment is the difference.
//
// THE ORIGINAL CAUSE CLASS IS NOT SWALLOWED. The mapped error carries `causeClass` (a token from the
// closed roster — never a message, never a value) and `cause` (the original error object, for a log
// sink that has one). A read-only failure therefore surfaces as a read-only fixed code and keeps its
// provenance; it is never re-labelled as an authorization refusal or a write fence.

// An elapsed/wall-clock failure. `read_time_limit_exceeded` is the expander's own `maxElapsedMs`
// budget; the rest are what the transport layers below it actually produce.
const B2A_TIMEOUT_CAUSE_CLASSES = Object.freeze([
  'read_time_limit_exceeded',   // stock-preparation-bom-expansion.cjs, maxElapsedMs
  'ETIMEOUT',                   // mssql/tedious request timeout (the host's `requestTimeout`)
  'ETIMEDOUT',                  // node socket timeout
  'ESOCKETTIMEDOUT',
  'TimeoutError',
  'AbortError',                 // an AbortController fired by a timeout race
  'TIMEOUT',                    // http-adapter.cjs / k3-wise-webapi-adapter.cjs
  'BRIDGE_AGENT_TIMEOUT',       // bridge-agent-readonly-adapter.cjs
])

// A bound on HOW MUCH was read, not on how long it took. All four of the expander's bounded types
// live here: from the caller's side "the row cap fired" and "the page cap fired" are the same fact —
// the read was bounded before it finished — and §15.2 R-05 asks for one fixed limit code, not four.
const B2A_PAGE_LIMIT_CAUSE_CLASSES = Object.freeze([
  'read_page_limit_exceeded',
  'max_rows_exceeded',
  'read_count_exceeded',
  'SOURCE_RUN_RESULT_TOO_LARGE',
])

// The batch stopped short for a reason that is neither a clock nor a declared bound — the source
// said "not done" and then offered nowhere to continue from. §9.1(3) calls this 断游标.
const B2A_INCOMPLETE_BATCH_CAUSE_CLASSES = Object.freeze([
  'read_cursor_broken',
])

/**
 * The structural class of a read failure. `details.code` first, because the expander's own bounded
 * errors carry their type there; then `code`, which is where drivers put theirs; then `name`, which
 * is the last thing that is still a CLASS rather than a value.
 *
 * A message is never consulted. That is the point.
 */
function b2aSourceReadCauseClass(error) {
  if (!error || typeof error !== 'object') return null
  const detailCode = isPlainObject(error.details) ? optionalString(error.details.code) : null
  return detailCode || optionalString(error.code) || optionalString(error.name)
}

/**
 * Cause class -> fixed code + coarse reason, or `null` when the class is not on any roster.
 */
function classifyB2aSourceReadCause(causeClass) {
  if (!causeClass) return null
  if (B2A_TIMEOUT_CAUSE_CLASSES.includes(causeClass)) {
    return { code: B2A_SOURCE_TIMEOUT, status: 504, reason: 'source_read_timeout' }
  }
  if (B2A_PAGE_LIMIT_CAUSE_CLASSES.includes(causeClass)) {
    return { code: B2A_PAGE_LIMIT_EXCEEDED, status: 409, reason: 'source_read_bound_exceeded' }
  }
  if (B2A_INCOMPLETE_BATCH_CAUSE_CLASSES.includes(causeClass)) {
    return { code: C6_FULL_BATCH_INCOMPLETE, status: 409, reason: 'source_read_cursor_broken' }
  }
  return null
}

function b2aSourceReadEvidence(authorization) {
  if (!isPlainObject(authorization)) return {}
  return {
    registryId: authorization.registryId,
    registryVersion: authorization.registryVersion,
    registrationId: authorization.registrationId,
    purpose: authorization.purpose,
  }
}

/**
 * Map ONE read failure to a fixed B2a code, or return `null` to leave it alone.
 *
 * Returning `null` rather than a catch-all code is deliberate: an unrecognized failure is a failure
 * this module cannot classify, and a fixed code that means "something went wrong" is not evidence.
 */
function mapB2aSourceReadError(error, authorization) {
  const causeClass = b2aSourceReadCauseClass(error)
  const classified = classifyB2aSourceReadCause(causeClass)
  if (!classified) return null
  const mapped = new B2aReadAuthorizationError(classified.status, classified.code,
    'the B2a-authorized source read did not complete within its hardened bounds', {
      reason: classified.reason,
      ...b2aSourceReadEvidence(authorization),
      // The read-only original cause CLASS, kept. A token from a closed roster, never a message.
      causeClass,
    })
  mapped.cause = error
  return mapped
}

/**
 * THE WRAPPER. Run a source read under an armed B2a authorization and surface its hardened failures
 * as fixed codes.
 *
 * DORMANT (`authorization == null`) calls `read()` and returns it, with no try/catch and no mapping
 * — the dormant path stays byte-identical, error objects included.
 */
async function runB2aGuardedSourceRead(authorization, read) {
  if (authorization === null || authorization === undefined) return read()
  try {
    return await read()
  } catch (error) {
    const mapped = mapB2aSourceReadError(error, authorization)
    if (mapped) throw mapped
    throw error
  }
}

/**
 * THE RESULT-SIDE HALF, and the reason R-05 needed two surfaces rather than one.
 *
 * The stock-preparation expander does not THROW its bounded failures at the caller. It CATCHES them
 * and records them as global error entries (`expansion.errors[].type`), so `expandPlmProjectBom`
 * returns a truncated result and the wrapper above never sees an exception. The bound is real; it
 * simply arrives as data instead of as a throw.
 *
 * So the same rosters are applied to the returned error TYPES. Order matters: a timeout and a bound
 * are distinguishable, and evidence should say which fired, so timeout wins over bound wins over
 * "incomplete for some other reason".
 *
 * E3-02 IS THE REST OF THIS FUNCTION. §9.1(3) requires that a source read which did not complete —
 * maxRows/maxPages, a broken cursor, a generation change — produce a fixed code and NO executable
 * plan. Any global error at all means the batch is not the full batch, so ANY unclassified global
 * error still refuses, with `C6_FULL_BATCH_INCOMPLETE`. Called BEFORE the plan and the revision are
 * built, which is what "不得生成可执行计划" means when it is code.
 *
 * A `read_failed` entry carries the ORIGINAL CAUSE CLASS the expander preserved (`causeClass` —
 * `error.code || error.name`), which is how a driver timeout swallowed into a global error still
 * surfaces as `B2A_SOURCE_TIMEOUT` instead of collapsing into a generic incompleteness. Both an
 * entry's `type` and its `causeClass` are offered to the rosters; only a class that MATCHES a roster
 * is ever echoed, so an unrecognized driver code never reaches evidence.
 *
 * @param {object|null} authorization the guard's stanza; `null` => dormant => no-op
 * @param {object[]}    errors        `expansion.errors`, in the order the expander recorded them
 */
function assertB2aFullBatchComplete(authorization, errors) {
  if (authorization === null || authorization === undefined) return
  const entries = (Array.isArray(errors) ? errors : []).filter(isPlainObject)
  if (entries.length === 0) return
  const classes = []
  for (const entry of entries) {
    const type = optionalString(entry.type)
    if (type) classes.push(type)
    const causeClass = optionalString(entry.causeClass)
    if (causeClass) classes.push(causeClass)
  }

  const timeout = classes.find((value) => B2A_TIMEOUT_CAUSE_CLASSES.includes(value))
  const bounded = classes.find((value) => B2A_PAGE_LIMIT_CAUSE_CLASSES.includes(value))
  const causeClass = timeout || bounded || classes.find((value) =>
    B2A_INCOMPLETE_BATCH_CAUSE_CLASSES.includes(value)) || null
  const classified = causeClass ? classifyB2aSourceReadCause(causeClass) : null

  const code = classified ? classified.code : C6_FULL_BATCH_INCOMPLETE
  const status = classified ? classified.status : 409
  const reason = classified ? classified.reason : 'source_read_incomplete'
  throw new B2aReadAuthorizationError(status, code,
    'the B2a source read did not return a complete batch, so no plan may be produced', {
      reason,
      ...b2aSourceReadEvidence(authorization),
      // A COUNT of failing error kinds, and the classified cause when there is one. The unclassified
      // types are not echoed: `read_failed` carries a driver message and this stanza carries none.
      ...(causeClass ? { causeClass } : {}),
      errorEntryCount: entries.length,
      fullBatch: false,
    })
}

// ─── W-5: TWO FAIL-CLOSED FLOORS FOR ARMED B2a READS OVER SQL SERVER ─────────
//
// Two gaps the general adapter deliberately leaves open for everyone (both are legitimate, opt-in
// mssql conventions when there is no armed B2a trial in play): MSSQLAdapter.ts allows
// connection.requestTimeoutMs=0 ("no timeout") through unchanged, and #5243's strict-offset-ordering
// belt defaults OFF. Neither floor below touches that default behaviour — both are read ONLY when
// the caller (the `data-source:sql-readonly` bridge, `lib/adapters/data-source-sql-readonly-source-
// adapter.cjs`) is under an armed, authorized B2a read, and both are enforced BEFORE this module ever
// sees a driver error: floor 1 is a pre-connect refusal the core-backend read-only facade throws
// (`select(..., strict=true)`, packages/core-backend/src/data-adapters/data-source-plugin-facade.ts);
// floor 2 is the SAME per-call override forcing MSSQLAdapter's own #5243 check on, so its refusal —
// unchanged message, no `.code` — propagates exactly as it already does for a connection that opted
// into `strictOffsetOrdering:true` itself. Floor 2 therefore needs nothing here: there is no new code
// to mint, no cause class to add to a roster, and no mapper to route it through — "do not invent a
// parallel code" is enforced by there being nothing to invent.
//
// Floor 1 DOES get a fixed code, because unlike floor 2 it is not reusing an existing thrown error —
// the core-backend facade's `DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE` is deliberately B2a-agnostic
// (that module knows nothing of B2a), so THIS seam is where it becomes `B2A_SOURCE_TIMEOUT_DISABLED_
// REJECTED`. Cross-tested against the facade's literal string (see b2a-trial-registry.test.cjs) so the
// two cannot drift silently apart — the same accepted-duplication pattern `parseStrictIsoTimestamp`
// above uses against stock-preparation-production-policy.cjs.
const DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CAUSE_CODE = 'DATA_SOURCE_REQUEST_TIMEOUT_DISABLED'

/**
 * True when `error` is exactly the core-backend read-only facade's floor-1 refusal (thrown by
 * `select(..., strict=true)` before any source connection). Anything else — including every OTHER
 * error `api.select` can throw — is not this module's concern and must propagate unchanged.
 */
function isDataSourceRequestTimeoutDisabledError(error) {
  return Boolean(error) && typeof error === 'object' && error.code === DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CAUSE_CODE
}

/**
 * Floor 1's actual refusal. DORMANT (`authorization == null`) is not a state this function can even
 * reach in practice — the caller only invokes `select(..., strict=true)` when armed — but the guard is
 * repeated here anyway rather than trusted to the caller, matching every other assert* in this module.
 */
function refuseB2aArmedSqlServerRequestTimeoutDisabled(authorization) {
  if (authorization === null || authorization === undefined) return
  refuse(B2A_SOURCE_TIMEOUT_DISABLED_REJECTED, 'sqlserver_request_timeout_disabled',
    'an armed B2a read over SQL Server refuses a data source configured with ' +
    'connection.requestTimeoutMs=0 (no timeout) before any source connection is opened; set ' +
    'connection.requestTimeoutMs to a positive bound for this data source', b2aSourceReadEvidence(authorization))
}

// ─── R-06: THE SCHEMA CONTRACT, AND DRIFT ────────────────────────────────────
//
// §13 PR-C: "首次读取固定 schema contract/digest，字段缺失、类型或映射漂移在生成业务制品前返回固定错误码".
//
// WHAT IS PINNED. The structure of the source objects the READ PLAN will touch — column name, column
// type, column nullability — read through the adapter's own `getSchema` facade. NEVER a row: the
// contract is metadata about the source, and sampling data to describe a schema would put customer
// values into a durable record that exists precisely so no values have to be kept.
//
// WHAT IS STORED IS VALUES-FREE, and more strictly than it strictly had to be. This module's
// evidence discipline (see the header) already refuses to emit a SOURCE OBJECT NAME, so a contract
// that stored column names in the clear would be the one place in this file where an identifier
// leaked into durable state. It stores DIGESTS instead:
//
//     fieldKey  = sha256(object \0 columnName)[0..32)     -> identity of a column, not its name
//     fieldType = sha256(type \0 nullable)[0..32)         -> its declared shape
//
// which is enough to tell the three drift kinds apart by COUNT — a key that vanished is a missing
// field, a key whose type digest moved is a type change, a key that appeared is a widened source —
// without any of them being reconstructible into a name. §15.1 asks for "布尔项、整数计数"; this is that.
//
// MAPPING DRIFT is the third kind §13 names and it is not a source property at all: it is which
// `ext_` mapping was in force. The mapping's IDENTITY (`mappingId` + `mappingVersion`) is folded in,
// so swapping the mapping under a pinned registration is drift even when the source never moved.
//
// ANY DIFFERENCE REFUSES, including a purely ADDITIVE one. §13 names three kinds and an added column
// is not literally one of them, but the contract is a DIGEST and the acceptance condition is
// "identical schema passes". A source that grew a column is a source that changed under a
// one-time authorization; refusing is the fail-closed reading and re-pinning is a deliberate act.
//
// COST, stated: an ARMED read now makes one `getSchema` call per plan object before the read (to pin
// or compare) and one after it (E3-05's mid-read check). A DORMANT read makes none — the whole path
// is skipped when the authorization is `null`.

const SCHEMA_CONTRACT_KEY_PREFIX = 'integration:b2a:schema-contract:'
const B2A_SCHEMA_CONTRACT_VERSION = 1

function schemaContractKey(registrationId) {
  return `${SCHEMA_CONTRACT_KEY_PREFIX}${registrationId}`
}

function shortDigest(...parts) {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)
}

/**
 * Nullability across two adapters that spell it differently, and one of them inverted.
 *
 *   data-source:sql-readonly   -> `{ name, type, nullable }`
 *   bridge:legacy-sql-readonly -> `{ name, label, type, required }`   (required = NOT nullable)
 *
 * A contract that read `nullable` alone would record `undefined` for every bridge column and then
 * pass a source whose nullability changed — a control that looks total and matches on a constant.
 * Unknown stays `unknown` rather than defaulting to a value, so a facade that reports neither cannot
 * be mistaken for one that reports "nullable".
 */
function fieldNullability(field) {
  if (typeof field.nullable === 'boolean') return field.nullable ? 'nullable' : 'not_null'
  if (typeof field.required === 'boolean') return field.required ? 'not_null' : 'nullable'
  return 'unknown'
}

/**
 * Read the CURRENT structural schema of the plan's objects and reduce it to a values-free contract.
 *
 * Runs through `runB2aGuardedSourceRead`, so a `getSchema` that times out surfaces as
 * `B2A_SOURCE_TIMEOUT` rather than as an unclassified 500 — the schema probe is a source read and is
 * hardened as one.
 */
async function computeB2aSchemaContract({ authorization, sourceAdapter, sourceObjects, extFieldMapping }) {
  if (!sourceAdapter || typeof sourceAdapter.getSchema !== 'function') {
    // FAIL-CLOSED. An armed read whose adapter cannot describe its own source cannot honour a schema
    // contract, and "no contract" must not read as "no drift".
    throw new B2aReadAuthorizationError(409, B2A_SCHEMA_DRIFT,
      'a B2a-gated read requires a source adapter that can report its schema', {
        reason: 'schema_facade_unavailable',
        ...b2aSourceReadEvidence(authorization),
      })
  }
  const objects = [...new Set((Array.isArray(sourceObjects) ? sourceObjects : [])
    .map(optionalString).filter(Boolean))].sort()
  if (objects.length === 0) {
    throw new B2aReadAuthorizationError(409, B2A_SCHEMA_DRIFT,
      'a B2a-gated read must name the source objects its schema contract covers', {
        reason: 'schema_scope_empty',
        ...b2aSourceReadEvidence(authorization),
      })
  }

  const fields = {}
  for (const object of objects) {
    const described = await runB2aGuardedSourceRead(authorization, () => sourceAdapter.getSchema({ object }))
    const describedFields = isPlainObject(described) && Array.isArray(described.fields) ? described.fields : null
    if (!describedFields) {
      throw new B2aReadAuthorizationError(409, B2A_SCHEMA_DRIFT,
        'the source adapter did not describe one of the objects this B2a read plan touches', {
          reason: 'schema_unreadable',
          ...b2aSourceReadEvidence(authorization),
        })
    }
    for (const field of describedFields) {
      if (!isPlainObject(field)) continue
      const name = optionalString(field.name)
      if (!name) continue
      const type = optionalString(field.type) || 'unknown'
      fields[shortDigest(object, name)] = shortDigest(type, fieldNullability(field))
    }
  }

  // The mapping's IDENTITY, not its content: a slug and an integer, hashed anyway so the contract is
  // one uniform shape. `none` is a distinct value from any configured mapping, so CONFIGURING a
  // mapping under a pinned registration is itself drift.
  const mappingDigest = isPlainObject(extFieldMapping)
    ? shortDigest('mapping', String(extFieldMapping.mappingId), String(extFieldMapping.mappingVersion))
    : shortDigest('mapping', 'none')

  const fieldKeys = Object.keys(fields).sort()
  const schemaDigest = crypto.createHash('sha256')
    .update(JSON.stringify([B2A_SCHEMA_CONTRACT_VERSION, mappingDigest, fieldKeys.map((key) => [key, fields[key]])]))
    .digest('hex')

  return Object.freeze({
    schemaContractVersion: B2A_SCHEMA_CONTRACT_VERSION,
    objectCount: objects.length,
    fieldCount: fieldKeys.length,
    mappingDigest,
    schemaDigest,
    fields: Object.freeze({ ...fields }),
  })
}

/**
 * Compare a freshly computed contract against the pinned one and report the drift by COUNT.
 */
function diffB2aSchemaContract(pinned, current) {
  const pinnedFields = isPlainObject(pinned) && isPlainObject(pinned.fields) ? pinned.fields : {}
  const currentFields = isPlainObject(current.fields) ? current.fields : {}
  let missingFieldCount = 0
  let changedFieldCount = 0
  let addedFieldCount = 0
  for (const key of Object.keys(pinnedFields)) {
    if (!Object.prototype.hasOwnProperty.call(currentFields, key)) missingFieldCount += 1
    else if (currentFields[key] !== pinnedFields[key]) changedFieldCount += 1
  }
  for (const key of Object.keys(currentFields)) {
    if (!Object.prototype.hasOwnProperty.call(pinnedFields, key)) addedFieldCount += 1
  }
  const mappingChanged = pinned.mappingDigest !== current.mappingDigest
  return {
    missingFieldCount,
    changedFieldCount,
    addedFieldCount,
    mappingChanged,
    drifted: pinned.schemaDigest !== current.schemaDigest,
  }
}

/**
 * R-06. PIN on the first armed read for a registration; COMPARE on every one after it.
 *
 * Called AFTER `assertB2aReadAuthorization` (so only an authorized read ever probes the source) and
 * BEFORE any business artifact — no plan, no rows, no revision, no evidence stanza is built between
 * the guard and this check.
 *
 * PERSISTENCE. The plugin's durable KV (`context.storage` — Postgres `plugin_kv`, namespaced per
 * plugin, survives restart), under its own key prefix, which is the SAME store and the same shape
 * the operation claim and the registration-version floor already use a few functions above. The
 * registry file itself is a read-only deploy artifact and is never written. Keyed by
 * `registrationId` alone — a deployment-authored slug, and deliberately NOT by registrationVersion:
 * bumping the version must not silently drop a pinned contract and re-pin whatever the source
 * happens to look like that morning. Re-pinning is `store.delete` on this key, an explicit act.
 *
 * @returns {Promise<object|null>} `null` when dormant; otherwise a frozen values-free stanza.
 */
async function assertB2aSchemaContract({ store, authorization, sourceAdapter, sourceObjects, extFieldMapping, now } = {}) {
  if (authorization === null || authorization === undefined) return null
  const claimStore = requireClaimStore(store)
  const current = await computeB2aSchemaContract({ authorization, sourceAdapter, sourceObjects, extFieldMapping })
  const key = schemaContractKey(authorization.registrationId)
  const stored = await claimStore.get(key)

  if (!isPlainObject(stored) || typeof stored.schemaDigest !== 'string') {
    await claimStore.set(key, {
      schemaContractVersion: current.schemaContractVersion,
      registrationVersion: authorization.registrationVersion,
      purpose: authorization.purpose,
      objectCount: current.objectCount,
      fieldCount: current.fieldCount,
      mappingDigest: current.mappingDigest,
      schemaDigest: current.schemaDigest,
      fields: { ...current.fields },
      pinnedAtMs: Number.isFinite(now) ? now : null,
    })
    return frozenSchemaContractStanza(true, current)
  }

  // A contract pinned by an older version of THIS code cannot be compared field-for-field, and
  // treating an incomparable record as "no drift" is the failure this whole check exists to prevent.
  if (stored.schemaContractVersion !== current.schemaContractVersion) {
    throw new B2aReadAuthorizationError(409, B2A_SCHEMA_DRIFT,
      'the pinned B2a schema contract was written in a format this runtime cannot compare', {
        reason: 'schema_contract_version_mismatch',
        ...b2aSourceReadEvidence(authorization),
      })
  }

  const diff = diffB2aSchemaContract(stored, current)
  if (diff.drifted) {
    throw new B2aReadAuthorizationError(409, B2A_SCHEMA_DRIFT,
      'the source schema no longer matches the contract pinned for this B2a registration', {
        reason: 'schema_contract_drift',
        ...b2aSourceReadEvidence(authorization),
        missingFieldCount: diff.missingFieldCount,
        changedFieldCount: diff.changedFieldCount,
        addedFieldCount: diff.addedFieldCount,
        mappingChanged: diff.mappingChanged,
      })
  }

  return frozenSchemaContractStanza(false, current)
}

/**
 * The stanza a caller carries forward: the pinned/compared result, plus the field digest map the
 * mid-read check needs to diff against. `b2aSchemaContractEvidence` is what goes into evidence —
 * every key here is a digest, a count or a boolean, but a whole field map is noise in a stanza whose
 * job is to be readable.
 */
function frozenSchemaContractStanza(pinned, current) {
  return Object.freeze({
    schemaContractPinned: pinned,
    schemaContractVersion: current.schemaContractVersion,
    objectCount: current.objectCount,
    fieldCount: current.fieldCount,
    mappingDigest: current.mappingDigest,
    schemaDigest: current.schemaDigest,
    schemaDrift: false,
    fields: current.fields,
  })
}

function b2aSchemaContractEvidence(contract) {
  if (!isPlainObject(contract)) return null
  return {
    schemaContractPinned: contract.schemaContractPinned === true,
    schemaContractVersion: contract.schemaContractVersion,
    objectCount: contract.objectCount,
    fieldCount: contract.fieldCount,
    schemaDigest: contract.schemaDigest,
    schemaDrift: contract.schemaDrift === true,
  }
}

/**
 * E3-05, the half this cut can actually enforce: the source must not have CHANGED SHAPE between the
 * moment the batch started and the moment it finished.
 *
 * Re-reads the same schema after the read and compares it to the digest the pre-read check agreed
 * on. A DDL change mid-batch — a column dropped, retyped, added — refuses with
 * `C6_FULL_BATCH_INCOMPLETE` and no plan is built.
 *
 * WHAT THIS DOES NOT COVER, said plainly rather than implied: a ROW-LEVEL generation change. Nothing
 * in these sources carries a generation marker, a snapshot token or a change counter, so "the data
 * moved under us mid-read" is not observable from here at all. Detecting it needs source-side
 * snapshot isolation or a generation column — Mirror-spike machinery — and a version built now would
 * be replaced by it. That half is DEFERRED, and the deferral is the honest answer rather than a
 * check that fires on nothing.
 */
async function assertB2aSourceUnchangedAfterRead({ authorization, contract, sourceAdapter, sourceObjects, extFieldMapping } = {}) {
  if (authorization === null || authorization === undefined) return null
  if (!isPlainObject(contract)) return null
  const after = await computeB2aSchemaContract({ authorization, sourceAdapter, sourceObjects, extFieldMapping })
  if (after.schemaDigest === contract.schemaDigest) {
    return Object.freeze({ sourceUnchangedAcrossRead: true })
  }
  const diff = diffB2aSchemaContract(contract, after)
  throw new B2aReadAuthorizationError(409, C6_FULL_BATCH_INCOMPLETE,
    'the source schema changed while this B2a batch was being read', {
      reason: 'source_changed_mid_read',
      ...b2aSourceReadEvidence(authorization),
      missingFieldCount: diff.missingFieldCount,
      changedFieldCount: diff.changedFieldCount,
      addedFieldCount: diff.addedFieldCount,
      fullBatch: false,
    })
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
  B2A_AUTHORIZED_RUN_ID,
  readPlanSourceObjects,
  B2A_ERROR_CODES,
  B2A_REGISTRATION_REQUIRED,
  B2A_AUTHORIZATION_INVALID,
  B2A_SCOPE_MISMATCH,
  B2A_SOURCE_TIMEOUT,
  B2A_PAGE_LIMIT_EXCEEDED,
  B2A_SCHEMA_DRIFT,
  C6_SAFE_LIFECYCLE_REQUIRED,
  C6_FULL_BATCH_INCOMPLETE,
  B2A_REGISTRY_INVALID,
  B2A_SOURCE_TIMEOUT_DISABLED_REJECTED,
  DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CAUSE_CODE,
  isDataSourceRequestTimeoutDisabledError,
  refuseB2aArmedSqlServerRequestTimeoutDisabled,
  B2A_TIMEOUT_CAUSE_CLASSES,
  B2A_PAGE_LIMIT_CAUSE_CLASSES,
  B2A_INCOMPLETE_BATCH_CAUSE_CLASSES,
  B2A_SCHEMA_CONTRACT_VERSION,
  SCHEMA_CONTRACT_KEY_PREFIX,
  b2aSourceReadCauseClass,
  classifyB2aSourceReadCause,
  mapB2aSourceReadError,
  runB2aGuardedSourceRead,
  assertB2aFullBatchComplete,
  assertB2aSchemaContract,
  assertB2aSourceUnchangedAfterRead,
  b2aSchemaContractEvidence,
  B2A_EXPIRY_HANDLINGS,
  B2A_CONSUMPTION_STATES,
  B2A_STATUSES,
  MAX_B2A_REGISTRATION_WINDOW_MS,
  B2aReadAuthorizationError,
  assertB2aReadAuthorization,
  createB2aRegistry,
  createB2aOperationClaim,
  B2A_OPERATION_CLAIM_TABLE,
  resolveB2aRegistryConfig,
}
