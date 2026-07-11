'use strict'

// External-API WRITE self-service — W2-a: dry-run PREVIEW runtime, STATIC-PREVIEW level ONLY
// (design-lock `docs/development/integration-write-self-service-w2-dryrun-design-lock-20260708.md`, #3878).
//
// Scope fence (binding, §4 of the lock):
//   - ZERO network. This module never calls fetch/http(s).request, never constructs a transport/adapter,
//     never dispatches a request of any kind -- not a write, not even the OPTIONAL read-only lookup the
//     lock admits at §1.1 ("lookup-classified preview"). That level, W2-b token issuance, the W2 route/UI,
//     and the W3 sandbox redeemer are each a SEPARATE, later, explicit owner opt-in -- NOT this slice.
//   - No write-method dispatch, ever, to sandbox or production. No adapter.upsert/save/write call.
//   - Production `systemId` is NEVER read for resolution purposes beyond the one guard comparison that
//     REJECTS it (see assertSandboxBinding) -- it is never contacted, never decrypted, never dispatched to.
//   - No token issuance (W2-b), no route (later rung), no redeemer (W3), no lifecycle execution
//     (no Save/Submit/Audit), no delete, no raw SQL / free-form body, no credential ever visible.
//   - Values-free evidence only: counts, booleans, and exact-registered coarse codes -- never row values,
//     composed body content, field values, credentials, hostnames, endpoint text, or response bodies.
//
// Consumes an ALREADY-APPROVED, S1-normalized write-target config RECORD (status/version/config), the
// SAME two-tier discipline read-source-read-runtime.cjs uses for an approved read-source config, plus the
// draft/approved/retired lifecycle from write-target-config-store.cjs (the read line has no such lifecycle
// to mirror -- this check is net-new here). Composes the would-be write body IN MEMORY ONLY, from the
// config's fieldMap, purely to validate row shape/keying -- the composed body is discarded immediately and
// NEVER returned, logged, or included in evidence.
//
// `canApply` / `status: 'ready'` are INTENTIONALLY unreachable from this slice: certifying "ready to apply"
// requires the lookup-classified level (to rule out ambiguous/held rows), which this slice does not
// implement. Static-preview dry-runs therefore always report `status: 'not_applyable'`, `canApply: false`,
// `tokenIssued: false` -- a deliberate safety choice (a future rung must not mint a write-intent token off a
// run that never checked for row ambiguity), not an oversight.

const { validateWriteTargetConfig } = require('./write-target-config.cjs')

const WRITE_TARGET_DRY_RUN_DEFAULT_MAX_ROWS = 100
const WRITE_TARGET_DRY_RUN_MAX_ROWS = 10000

const WRITE_TARGET_DRY_RUN_TOP_KEYS = Object.freeze(['configRecord', 'payload', 'sandboxSystem', 'maxRows'])
const WRITE_TARGET_DRY_RUN_PAYLOAD_KEYS = Object.freeze(['rows'])
const WRITE_TARGET_DRY_RUN_CONFIG_RECORD_KEYS = Object.freeze(['id', 'status', 'version', 'config'])
const WRITE_TARGET_DRY_RUN_APPROVED_STATUS = 'approved'

const WRITE_TARGET_DRY_RUN_ERROR_CODE = 'WRITE_TARGET_DRY_RUN_CONTRACT_INVALID'
const WRITE_TARGET_DRY_RUN_DEFAULT_ERROR = 'WRITE_TARGET_DRY_RUN_FAILED'

// Exact-registered family (safeErrorCode discipline identical to read-source-probe-contract.cjs):
// prefix matching is NOT allowed; an unregistered/producer-supplied code clamps to the generic fallback.
// Registered here ONLY the codes THIS static-preview slice can actually produce. The lookup-classified
// level and token issuance (separate, later opt-ins) will extend this family additively when they land --
// `WRITE_TARGET_DRY_RUN_LOOKUP_AMBIGUOUS` / `..._AUTH_FAILED` / `..._NETWORK_FAILED` / `..._TIMEOUT` /
// `..._TOKEN_STORE_UNAVAILABLE` are named in the design lock's full W2 taxonomy but are NOT registered by
// this module: nothing here can throw them, and registering an unreachable code would be untested dead
// enumeration.
const WRITE_TARGET_DRY_RUN_ERROR_CODES = Object.freeze([
  WRITE_TARGET_DRY_RUN_ERROR_CODE,
  'WRITE_TARGET_DRY_RUN_CONFIG_NOT_FOUND',
  'WRITE_TARGET_DRY_RUN_CONFIG_NOT_APPROVED',
  'WRITE_TARGET_DRY_RUN_CONFIG_INVALID',
  'WRITE_TARGET_DRY_RUN_CONFIG_NOT_NORMALIZED',
  'WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING',
  'WRITE_TARGET_DRY_RUN_KEY_MISSING',
  'WRITE_TARGET_DRY_RUN_PAYLOAD_INVALID',
  'WRITE_TARGET_DRY_RUN_CAP_REACHED',
  'WRITE_TARGET_DRY_RUN_WRITE_BLOCKED',
  WRITE_TARGET_DRY_RUN_DEFAULT_ERROR,
])
const WRITE_TARGET_DRY_RUN_ERROR_CODE_SET = new Set(WRITE_TARGET_DRY_RUN_ERROR_CODES)

const WRITE_TARGET_DRY_RUN_ERROR_TYPES = Object.freeze(['WriteTargetDryRunError', 'Error'])
const WRITE_TARGET_DRY_RUN_ERROR_TYPE_SET = new Set(WRITE_TARGET_DRY_RUN_ERROR_TYPES)

// Count allowlist actually populated by this slice. `wouldAdd` / `wouldUpdate` / `held` are reserved by the
// design lock for the lookup-classified level (they require a read-only existence check this slice never
// performs) and are therefore never emitted here -- omitted, not zero-faked.
const WRITE_TARGET_DRY_RUN_EVIDENCE_COUNT_KEYS = Object.freeze(['planned', 'invalid', 'rowCount'])
const WRITE_TARGET_DRY_RUN_RESERVED_LOOKUP_COUNT_KEYS = Object.freeze(['wouldAdd', 'wouldUpdate', 'held'])
// `timeoutReached` is reserved for the (future, network-bearing) lookup-classified level; this slice never
// sets it because nothing here can time out. Listed for allowlist parity with the design-lock evidence
// shape, not emitted.
const WRITE_TARGET_DRY_RUN_EVIDENCE_BOOLEAN_KEYS = Object.freeze([
  'lookupExecuted', 'capReached', 'timeoutReached', 'sandboxBindingResolved', 'tokenIssued', 'externalWriteAttempted',
])

class WriteTargetDryRunError extends Error {
  constructor(code, reason) {
    super(reason)
    this.name = 'WriteTargetDryRunError'
    this.code = WRITE_TARGET_DRY_RUN_ERROR_CODE_SET.has(code) ? code : WRITE_TARGET_DRY_RUN_DEFAULT_ERROR
    this.reason = typeof reason === 'string' ? reason : 'failed'
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stableStringify(value) {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function onlyAllowedKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

// --- Zero-write structural guard -------------------------------------------------------------------
//
// This is the ONE real observation point the whole "no outbound write" claim routes through. The
// static-preview compose path below never calls `guard.blockDispatch`, by construction (there is no
// write-dispatch call site at all in this module -- see the class docstring). The guard exists so the
// claim is MUTATION-PROVABLE rather than merely true-by-absence:
//   - `guard.writeAttempts` is a real counter, not a decoration; `blockDispatch` is the only way to move
//     it, and doing so always throws the registered WRITE_BLOCKED code (never a silent no-op).
//   - `dryRunWriteTarget` re-checks `guard.writeAttempts` BEFORE building evidence and refuses the entire
//     run if it is non-zero -- so even a guard that had already observed an attempt (e.g. injected
//     pre-poisoned by a test simulating a future code path that wrongly called it) fails the run closed
//     rather than silently reporting success.
//   - `externalWriteAttempted` in evidence is DERIVED from `guard.writeAttempts > 0`, never hardcoded.
function createWriteDispatchGuard() {
  let attempts = 0
  return Object.freeze({
    get writeAttempts() {
      return attempts
    },
    // Any real write-dispatch call site (none exist in this slice) would have to route through here.
    // Recording an attempt and throwing are inseparable -- there is no way to "attempt" a write via this
    // guard without it being observed and blocked.
    blockDispatch(methodName) {
      attempts += 1
      throw new WriteTargetDryRunError(
        'WRITE_TARGET_DRY_RUN_WRITE_BLOCKED',
        `write_dispatch_blocked:${typeof methodName === 'string' && methodName ? methodName : 'unknown'}`,
      )
    },
  })
}

function safeErrorCode(value) {
  if (typeof value !== 'string') return null
  const code = value.trim()
  return WRITE_TARGET_DRY_RUN_ERROR_CODE_SET.has(code) ? code : null
}

function safeErrorType(value) {
  if (typeof value !== 'string') return null
  const type = value.trim()
  return WRITE_TARGET_DRY_RUN_ERROR_TYPE_SET.has(type) ? type : null
}

// Converts a thrown WriteTargetDryRunError (or any error) into values-free failure evidence. Callers
// (future route slices) that want an evidence-shaped response instead of a thrown error use this; the
// core functions below throw, mirroring read-source-probe-contract.cjs's prepare-stage discipline.
function writeTargetDryRunErrorEvidence(error) {
  const code = error instanceof WriteTargetDryRunError ? error.code : null
  const type = error instanceof WriteTargetDryRunError
    ? 'WriteTargetDryRunError'
    : (typeof error?.name === 'string' ? error.name : 'Error')
  return Object.freeze({
    ok: false,
    lookupExecuted: false,
    tokenIssued: false,
    canApply: false,
    errorCode: safeErrorCode(code) || WRITE_TARGET_DRY_RUN_DEFAULT_ERROR,
    errorType: safeErrorType(type) || 'Error',
  })
}

// --- Contract-shape assertions ----------------------------------------------------------------------

function assertContractShape(input) {
  if (!isPlainObject(input)) {
    throw new WriteTargetDryRunError(WRITE_TARGET_DRY_RUN_ERROR_CODE, 'not_object')
  }
  if (!onlyAllowedKeys(input, WRITE_TARGET_DRY_RUN_TOP_KEYS)) {
    throw new WriteTargetDryRunError(WRITE_TARGET_DRY_RUN_ERROR_CODE, 'unexpected_field')
  }
  if (!isPlainObject(input.payload)) {
    throw new WriteTargetDryRunError(WRITE_TARGET_DRY_RUN_ERROR_CODE, 'payload_required')
  }
  // sandboxSystem's presence/shape is deliberately NOT checked here: a missing, malformed, or
  // non-matching sandboxSystem is a sandbox-binding problem, not a generic contract problem, and gets
  // the more specific WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING code from assertSandboxBinding below
  // (which safely handles a non-object input) -- one code covers every "not a valid sandbox handle" case.
}

// Fail-closed on draft / retired / missing / invalid / non-normalized config (§4.4 of the lock's
// verification plan). This lifecycle check is NET-NEW relative to read-source-read-runtime.cjs (the read
// line has no draft/approved/retired lifecycle to mirror); it is borrowed from
// write-target-config-store.cjs's status vocabulary. The byte-identical normalized-config assertion below
// mirrors read-source-probe-contract.cjs's `assertS1NormalizedConfig` idiom exactly, so this dry-run never
// becomes a second validator by accident.
function assertApprovedNormalizedConfig(configRecord) {
  if (!isPlainObject(configRecord)) {
    throw new WriteTargetDryRunError('WRITE_TARGET_DRY_RUN_CONFIG_NOT_FOUND', 'config_record_missing')
  }
  if (!onlyAllowedKeys(configRecord, WRITE_TARGET_DRY_RUN_CONFIG_RECORD_KEYS)) {
    throw new WriteTargetDryRunError(WRITE_TARGET_DRY_RUN_ERROR_CODE, 'config_record_unexpected_field')
  }
  if (configRecord.status !== WRITE_TARGET_DRY_RUN_APPROVED_STATUS) {
    throw new WriteTargetDryRunError(
      'WRITE_TARGET_DRY_RUN_CONFIG_NOT_APPROVED',
      `config_status_${typeof configRecord.status === 'string' && configRecord.status ? configRecord.status : 'missing'}`,
    )
  }
  const result = validateWriteTargetConfig(configRecord.config)
  if (!result.valid) {
    throw new WriteTargetDryRunError('WRITE_TARGET_DRY_RUN_CONFIG_INVALID', 'config_invalid')
  }
  // Caller obligation (mirrors S2-a): pass the STORED/APPROVED config, which must already be byte-identical
  // to validateWriteTargetConfig(raw).normalized. A merely-valid-but-differently-shaped config would make
  // this dry-run a second validator by accident.
  if (stableStringify(configRecord.config) !== stableStringify(result.normalized)) {
    throw new WriteTargetDryRunError('WRITE_TARGET_DRY_RUN_CONFIG_NOT_NORMALIZED', 'config_not_normalized')
  }
  return result.normalized
}

// Sandbox-only resolution (§4.4 / §1.1 of the lock): the dry-run compares the supplied system's id
// against the config's `sandboxSystemId` ONLY -- the production `systemId` is never read for any purpose
// other than this rejecting comparison being possible to fail; it is never contacted, credential-resolved,
// or dispatched to. A production systemId (or any non-matching system) fails closed here, always, on every
// path -- there is no fallback and no partial success.
function assertSandboxBinding(config, sandboxSystem) {
  const sandboxId = isPlainObject(sandboxSystem) && typeof sandboxSystem.id === 'string' ? sandboxSystem.id.trim() : ''
  if (!sandboxId || sandboxId !== config.sandboxSystemId) {
    throw new WriteTargetDryRunError('WRITE_TARGET_DRY_RUN_SANDBOX_BINDING_MISSING', 'sandbox_binding_mismatch')
  }
}

function clampMaxRows(value) {
  if (value === undefined || value === null) return WRITE_TARGET_DRY_RUN_DEFAULT_MAX_ROWS
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new WriteTargetDryRunError(WRITE_TARGET_DRY_RUN_ERROR_CODE, 'max_rows_invalid')
  }
  return Math.min(numeric, WRITE_TARGET_DRY_RUN_MAX_ROWS)
}

// Bounded, C6-style row caps: `WRITE_TARGET_DRY_RUN_CAP_REACHED` thrown outright only when the payload
// exceeds the hard ceiling (abusive/oversized request, rejected wholesale); a payload within the ceiling
// but above the effective max is bounded and surfaces as the `capReached` evidence BOOLEAN, never as a
// value-carrying error (§5.7 of the lock's verification plan).
function assertPayloadShape(payload, maxRowsInput) {
  if (!onlyAllowedKeys(payload, WRITE_TARGET_DRY_RUN_PAYLOAD_KEYS)) {
    throw new WriteTargetDryRunError(WRITE_TARGET_DRY_RUN_ERROR_CODE, 'payload_unexpected_field')
  }
  if (!Array.isArray(payload.rows) || payload.rows.length === 0 || !payload.rows.every(isPlainObject)) {
    throw new WriteTargetDryRunError('WRITE_TARGET_DRY_RUN_PAYLOAD_INVALID', 'payload_rows_invalid')
  }
  if (payload.rows.length > WRITE_TARGET_DRY_RUN_MAX_ROWS) {
    throw new WriteTargetDryRunError('WRITE_TARGET_DRY_RUN_CAP_REACHED', 'payload_exceeds_hard_cap')
  }
  const effectiveMax = clampMaxRows(maxRowsInput)
  const capReached = payload.rows.length > effectiveMax
  const rows = Object.freeze(payload.rows.slice(0, effectiveMax))
  return { rows, capReached, rowCount: rows.length }
}

// --- In-memory row classification / body composition ------------------------------------------------

// Own-property dotted walk (mirrors read-source-read-runtime.cjs's walkOwnPath exactly): prototype keys
// never resolve, so a hostile row cannot smuggle a value in via inherited/prototype properties.
function walkOwnPath(root, path) {
  let current = root
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { resolved: false, value: null }
    }
    current = current[segment]
  }
  return { resolved: true, value: current }
}

function isEmptyKeyValue(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

// Composes the would-be write body IN MEMORY from the config's fieldMap, for shape/keying validation
// ONLY. The composed body is intentionally discarded by the caller immediately after this returns `ok` --
// it is NEVER returned, logged, or folded into evidence (values-free contract, design-lock §2.2).
function classifyRow(row, config) {
  const keyResolved = walkOwnPath(row, config.keyField)
  if (!keyResolved.resolved || isEmptyKeyValue(keyResolved.value)) {
    return { ok: false }
  }
  const body = {}
  for (const entry of config.fieldMap) {
    const resolved = walkOwnPath(row, entry.source)
    body[entry.target] = resolved.resolved ? resolved.value : null
  }
  return { ok: true, body }
}

function safeCount(value) {
  return (typeof value === 'number' && Number.isInteger(value) && value >= 0) ? value : null
}

function buildSuccessEvidence({ configId, configVersion, counts, capReached, externalWriteAttempted }) {
  const evidence = {
    ok: true,
    configId: typeof configId === 'string' ? configId : null,
    configVersion: Number.isInteger(configVersion) ? configVersion : null,
    // Static-preview level NEVER certifies apply-readiness -- see module header. `canApply` requires the
    // lookup-classified level (ambiguity/held-row detection), which this slice does not implement.
    status: 'not_applyable',
    canApply: false,
  }
  for (const key of WRITE_TARGET_DRY_RUN_EVIDENCE_COUNT_KEYS) {
    const count = safeCount(counts[key])
    if (count !== null) evidence[key] = count
  }
  evidence.lookupExecuted = false
  evidence.capReached = capReached === true
  evidence.sandboxBindingResolved = true
  evidence.tokenIssued = false
  evidence.externalWriteAttempted = externalWriteAttempted === true
  return Object.freeze(evidence)
}

// --- Entry point --------------------------------------------------------------------------------------

// `deps.createAdapter` is accepted ONLY for DI/interface parity with read-source-read-runtime.cjs's
// `createAdapter` seam and for the zero-write proof tests (a hostile factory injected there must be
// provably NEVER invoked -- see __tests__). It is intentionally never referenced below: this slice never
// constructs an adapter of any kind. `deps.writeDispatchGuard` allows tests to inject a
// pre-existing/pre-poisoned guard to prove the fail-closed re-check and the derived marker are real
// (see __tests__ "poisoned guard" cases); production callers should omit it (a fresh guard is created).
function dryRunWriteTarget(input, deps = {}) {
  const guard = deps.writeDispatchGuard || createWriteDispatchGuard()
  // Structural fail-closed re-check, first thing, before any other validation: if the guard already
  // observed a write-shaped dispatch attempt (never true on the happy path -- nothing below ever calls
  // guard.blockDispatch), refuse the entire run. Mutation-tested: removing this check does not hide the
  // truth because `externalWriteAttempted` below is independently derived from the same counter.
  if (guard.writeAttempts > 0) {
    throw new WriteTargetDryRunError('WRITE_TARGET_DRY_RUN_WRITE_BLOCKED', 'write_dispatch_already_attempted')
  }

  assertContractShape(input)
  const normalizedConfig = assertApprovedNormalizedConfig(input.configRecord)
  assertSandboxBinding(normalizedConfig, input.sandboxSystem)
  const { rows, capReached, rowCount } = assertPayloadShape(input.payload, input.maxRows)

  let planned = 0
  let invalid = 0
  for (const row of rows) {
    const classified = classifyRow(row, normalizedConfig)
    if (classified.ok) planned += 1
    else invalid += 1
  }
  // Total-failure guard: every row failed to resolve a key -- nothing usable to preview. Partial failure
  // (some rows keyed, some not) is NOT a hard failure; it surfaces as the `invalid` count in evidence so
  // the caller sees a partial, still-useful preview.
  if (rows.length > 0 && planned === 0) {
    throw new WriteTargetDryRunError('WRITE_TARGET_DRY_RUN_KEY_MISSING', 'no_row_resolved_key')
  }

  return Object.freeze({
    evidence: buildSuccessEvidence({
      configId: input.configRecord.id,
      configVersion: input.configRecord.version,
      counts: { planned, invalid, rowCount },
      capReached,
      externalWriteAttempted: guard.writeAttempts > 0,
    }),
  })
}

module.exports = {
  WRITE_TARGET_DRY_RUN_DEFAULT_MAX_ROWS,
  WRITE_TARGET_DRY_RUN_MAX_ROWS,
  WRITE_TARGET_DRY_RUN_TOP_KEYS,
  WRITE_TARGET_DRY_RUN_PAYLOAD_KEYS,
  WRITE_TARGET_DRY_RUN_CONFIG_RECORD_KEYS,
  WRITE_TARGET_DRY_RUN_ERROR_CODES,
  WRITE_TARGET_DRY_RUN_ERROR_TYPES,
  WRITE_TARGET_DRY_RUN_EVIDENCE_COUNT_KEYS,
  WRITE_TARGET_DRY_RUN_RESERVED_LOOKUP_COUNT_KEYS,
  WRITE_TARGET_DRY_RUN_EVIDENCE_BOOLEAN_KEYS,
  WriteTargetDryRunError,
  createWriteDispatchGuard,
  dryRunWriteTarget,
  writeTargetDryRunErrorEvidence,
  __internals: {
    assertApprovedNormalizedConfig,
    assertContractShape,
    assertPayloadShape,
    assertSandboxBinding,
    buildSuccessEvidence,
    classifyRow,
    clampMaxRows,
    safeErrorCode,
    safeErrorType,
    stableStringify,
    walkOwnPath,
  },
}
