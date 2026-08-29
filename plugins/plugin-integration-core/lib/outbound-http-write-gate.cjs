'use strict'

// W-1(c) DEFAULT-DENY AUTHORIZATION GATE for GENERIC OUTBOUND HTTP WRITE.
//
// OWNER RULING (2026-08-29). Generic outbound HTTP write is a capability that must be EXPLICITLY
// AUTHORIZED per deployment. `INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS` UNSET => DENY. No
// production configuration uses a generic `http` write target today, so the blast radius of
// default-deny is zero, and read/list/schema/health legs are deliberately untouched.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS NOT G-4. READ THIS BEFORE CHANGING ANYTHING HERE.
// ─────────────────────────────────────────────────────────────────────────────
//
// `k3-external-write-permanent-fence.cjs` is a PERMANENT BAN (E4 / G-4, HG v1.2 §10.1): K3
// Save/Submit/Audit is unreachable, NO runtime switch is reserved, and re-enabling it requires a
// superseding ADR plus its own Gate. That module is deliberately PARAMETERLESS AND ENV-FREE,
// because any env read would be the re-enable surface §10.1 forbids.
//
// This module is the OPPOSITE KIND OF OBJECT and says so out loud: it is an AUTHORIZATION GATE, so
// it IS env-configurable BY DESIGN. Its posture is "closed until a deployment opens it for named
// targets", not "closed forever". Reading an env var here is the mechanism, not a leak in it.
//
// The two must not be confused in either direction:
//   * Nothing in this file can ever unlock K3. `erp:k3-wise-webapi` does not use this adapter, and
//     the K3 fence refuses at four layers regardless of what any allowlist says. An operator who
//     writes a K3-shaped entry into this allowlist has authorized NOTHING about K3.
//   * Nothing in the K3 fence covers a generic `http` target. That is exactly the hole this file
//     closes: the fence keys on `kind === 'erp:k3-wise-webapi'`, and a generic `http` system whose
//     `baseUrl` happens to point at a K3 endpoint was, before this file, an unfenced outbound POST.
//     The owner rejected URL-sniffing for K3 (brittle, and a matcher that can be defeated by a
//     proxy hop or an IP literal is worse than none); the ruling is to gate the CAPABILITY.
//
// ─────────────────────────────────────────────────────────────────────────────
// ARMING SEMANTICS — DENY IS THE DEFAULT, WHICH IS THE DELIBERATE INVERSION OF B2a
// ─────────────────────────────────────────────────────────────────────────────
//
//   ENV UNSET  ->  every outbound-write operation on this adapter is REFUSED with the fixed code
//                  `OUTBOUND_HTTP_WRITE_DISABLED`. Reads, lists, schema fetches and health probes
//                  are byte-identical to a deployment that never heard of this module.
//
//   ENV SET    ->  the named server-side JSON file enumerates the targets that MAY be written, by
//                  DECLARED IDENTITY (system id / name / kind + object), never by URL. A target the
//                  file does not name is refused with the DISTINCT code
//                  `OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED`, so an operator can tell "the gate is
//                  shut" from "the gate is open and your target is not on the list".
//
// `b2a-trial-registry.cjs` is dormant when unset, and its header explains at length why: arming a
// READ gate by default would force every synthetic fixture, demo and unit test to carry a
// registration, which is how a gate gets switched off wholesale. That reasoning DOES NOT TRANSFER
// here, and the difference is the whole ruling:
//
//   * READ-dormant is recoverable. WRITE-dormant is not — an unauthorized outbound POST has already
//     happened by the time anyone notices.
//   * The corpus cost is empirically nil. ONE suite in this package exercises a generic http write
//     (`__tests__/http-adapter.test.cjs`), and it now points the env var at a synthetic allowlist
//     fixture — six lines — rather than being deleted or watered down (#5247 precedent).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE ENV IS READ HERE AND NOT THREADED IN — THE ONE DELIBERATE DEVIATION FROM B2a
// ─────────────────────────────────────────────────────────────────────────────
//
// The other three deploy-file consumers in this plugin (customer packs, ext-field mapping, the B2a
// registry) are loaded by the HOST — `readDeployJsonObjectFile` in
// packages/core-backend/src/plugin-runtime-config.ts — and handed to the plugin as a server-config
// key. This module deliberately does NOT do that, and the reason is a security property, not
// convenience:
//
//   `createHttpAdapter({ system, fetchImpl, logger })` takes no config context. Threading an
//   allowlist in as a constructor dep or a factory default would make the allowlist an ARGUMENT —
//   and an argument is an unlock surface. ANY in-process caller (a script, a future scheduler, a
//   route that builds its own adapter, a test) could then hand itself an allowlist and write
//   anywhere. §"No request parameter, header, or policy may unlock it" would be false on day one.
//
// So the gate reads `process.env` ITSELF, from a leaf module with ZERO intra-package requires (only
// `node:fs`), and every public function here is PARAMETERLESS with respect to configuration: the
// caller supplies the SUBJECT of the decision (which system, which object, which operation) and
// never the POLICY. There is no options object that can widen the answer.
//
// What IS borrowed verbatim from the host reader is its FILE-LOADING POSTURE, because that part is
// exactly right and already reviewed:
//   * unset / blank  -> not configured (here: DENY; there: dormant)
//   * unreadable     -> THROW, naming the ENV KEY, NEVER echoing the path (a path is deployment
//                       topology and belongs in no error body)
//   * not JSON       -> THROW, same shape
//   * not an object  -> THROW, same shape
// A typo in the path must never be indistinguishable from a valid configuration.
//
// NO CACHING, ON PURPOSE. The file is re-read on every write authorization. A cache would mean an
// operator who REVOKES an entry keeps writing until the process restarts, which is the wrong
// failure direction for a revocation.
//
// The cost, stated exactly rather than waved at: outbound writes are BATCHED — one authorization per
// PAGE of records, never per row — and each batch authorizes TWICE (once at the adapter's named
// `upsert` entry point, once at its transport, which are deliberately independent). So a run costs
// two small reads per page, and the DEFAULT path costs nothing at all: an unset env var
// short-circuits before any file I/O happens.
//
// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY MATCHING, NOT URL MATCHING
// ─────────────────────────────────────────────────────────────────────────────
//
// An entry names the target's DECLARED IDENTITY: `systemId` (required), plus optional `systemName`
// and `kind` which must AGREE when present, plus an object scope. It may not name a URL, a host, a
// path or a header — `FORBIDDEN_TARGET_KEYS` refuses those AT LOAD, and the refusal names the rule
// rather than saying "unsupported key", so a deployer does not go hunting for the supported
// spelling of a control that deliberately does not exist.
//
// That is the ruling restated in code. URL matching was rejected because a URL is not an identity:
// it changes under a proxy, a CNAME, an IP literal, a port move or a path rewrite, and a matcher
// that a reverse proxy can defeat gives false assurance. A system id is a config-authored binding
// that a human wrote and a human reviews.
//
// NO WILDCARDS. `'*'` is refused at load in every position. Object scope must be either an explicit
// non-empty `objects` list or an EXPLICIT `allObjects: true` — omitting both is a load error, so an
// entry never authorizes every object by accident. That is b2a's "a data scope with no enumeration
// is not a scope", with the one concession that a deliberate, visible, reviewable "all objects of
// this system" remains expressible.
//
// ─────────────────────────────────────────────────────────────────────────────
// VALUES-FREE — AND EXACTLY WHERE THIS DIVERGES FROM §15.1, WITH THE REASON
// ─────────────────────────────────────────────────────────────────────────────
//
// A refusal carries: a FIXED code, a coarse reason token, `systemId`, `object`, `operation`, the
// allowlist id/version when one loaded, matched entry ids, and BOOLEANS/COUNTS.
//
// It NEVER carries: a baseUrl, host, port, path, query, fragment, header, credential, bearer token,
// api key, username, password, request body, record value, or any raw error message from the file
// system or JSON parser.
//
// The divergence, stated plainly rather than buried: b2a §15.1 keeps the SOURCE BINDING REF out of
// its refusals. This module puts `systemId` IN. The reason is that the two refusals have different
// jobs. A b2a refusal tells an operator that a read was not authorized; naming the binding adds
// nothing they cannot look up. An outbound-write refusal must tell them WHICH configured target to
// add to the allowlist file — without it the only remedy is to guess, and an operator who cannot
// fix a gate correctly ends up widening it. `systemId` and `object` are deployment/config-authored
// identifiers of the same class as b2a's own `registrationId`, not customer data.

const fs = require('node:fs')

// The single env var. Named for the CAPABILITY (generic outbound http write), not for a consumer:
// a second consumer of this gate arrives as a new entry in the same file, not a new env var.
const OUTBOUND_HTTP_WRITE_TARGETS_ENV = 'INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS'

// ─── FIXED ERROR CODES ───────────────────────────────────────────────────────
// Frozen vocabulary. Fixed strings, never derived, never formatted from input, identical at every
// layer so a caller cannot probe WHICH layer caught them and work inward.

// The env var is unset/blank: the capability is off for this deployment.
const OUTBOUND_HTTP_WRITE_DISABLED = 'OUTBOUND_HTTP_WRITE_DISABLED'
// The capability is on, but this target/object/operation is not on the list. DISTINCT from the
// above on purpose — collapsing them would leave an operator unable to tell a shut gate from a
// missing entry, and the two have different remedies.
const OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED = 'OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED'
// The deployment configured something the gate cannot honour. A broken DEPLOYMENT, not a refused
// caller, so it carries its own code and a 500 — and it still DENIES, never falls through to allow.
const OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID = 'OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID'

const OUTBOUND_HTTP_WRITE_ERROR_CODES = Object.freeze([
  OUTBOUND_HTTP_WRITE_DISABLED,
  OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
  OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID,
])

// 403, not 422: a refused caller cannot fix this by editing their request. 500 for the load fault,
// because there is nothing about the request to refuse.
const OUTBOUND_HTTP_WRITE_REFUSAL_STATUS = 403
const OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID_STATUS = 500

// Fixed, values-free operator-facing text, one per code.
const OUTBOUND_HTTP_WRITE_REFUSAL_MESSAGES = Object.freeze({
  [OUTBOUND_HTTP_WRITE_DISABLED]:
    'generic outbound HTTP write is disabled; it must be authorized by the server-side outbound HTTP write target file',
  [OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED]:
    'this target is not authorized for generic outbound HTTP write',
  [OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID]:
    'the server-side outbound HTTP write target file is not usable; generic outbound HTTP write stays refused',
})

// ─── THE CLOSED OPERATION VOCABULARY ─────────────────────────────────────────
//
// An `operation` is the identity of an outbound-WRITE entry point. Always a frozen constant spelled
// here and referenced by the call site, never anything derived from a request. Two consequences:
//   1. An allowlist entry can narrow itself to one entry point.
//   2. AN UNKNOWN OPERATION DEFAULT-REFUSES. A new write path that has not been inventoried presents
//      an operation outside this list and is refused, rather than inheriting an existing entry.
//      Adding a write path therefore requires a visible edit to this list.
const OUTBOUND_HTTP_WRITE_OPERATION_UPSERT = 'upsert'
// The transport-level catch. `requestJson` treats a body-bearing OR non-safe-method request as a
// write whatever named operation produced it, so a leg that never went through `upsert` — today
// that is `testConnection`, whose `input.method`/`input.path` come straight off an authenticated
// HTTP request body (http-routes.cjs `externalSystemsTest`) — still has to be authorized.
const OUTBOUND_HTTP_WRITE_OPERATION_REQUEST = 'request'

const OUTBOUND_HTTP_WRITE_OPERATIONS = Object.freeze([
  OUTBOUND_HTTP_WRITE_OPERATION_UPSERT,
  OUTBOUND_HTTP_WRITE_OPERATION_REQUEST,
])

// Methods that cannot mutate the remote. Everything else — POST/PUT/PATCH/DELETE and anything a
// config invents — is a write for gating purposes. A request carrying a BODY is a write regardless
// of method: today only `upsert` sends one, and that is a property worth pinning rather than
// re-deriving.
const SAFE_HTTP_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS'])

// The connector kinds that route to the generic HTTP adapter (index.cjs
// `.registerAdapter('http', createHttpAdapterFactory(), …)`). Used ONLY by the pipeline-runner
// layer, which must decide before an adapter exists.
//
// HONEST BOUND: this roster is a LITERAL, so a future kind wired to `createHttpAdapterFactory()`
// without being added here outruns the RUNNER layer. It cannot outrun the ADAPTER layer, which is
// inside `createHttpAdapter` and therefore covers every kind that adapter ever serves. That is the
// intended split — the deep layer is the one that must hold alone.
const GENERIC_HTTP_WRITE_KINDS = Object.freeze(['http'])

function isGenericHttpWriteKind(kind) {
  return typeof kind === 'string' && GENERIC_HTTP_WRITE_KINDS.includes(kind)
}

function isWriteMethod(method) {
  const normalized = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET'
  return !SAFE_HTTP_METHODS.includes(normalized)
}

// ─── ALLOWLIST FILE SHAPE ────────────────────────────────────────────────────

const ALLOWLIST_KEYS = Object.freeze(['allowlistId', 'allowlistVersion', 'targets'])
const TARGET_KEYS = Object.freeze([
  'entryId',
  'systemId',
  'systemName',
  'kind',
  'objects',
  'allObjects',
  'operations',
])

// Key names that would turn this into URL matching, or smuggle a credential into a reviewed file.
// Refused at load BY NAME so the error states the rule instead of inviting a hunt for the supported
// spelling. The closed key set above already refuses anything unlisted; this roster only changes
// the MESSAGE, and that difference is the point.
const FORBIDDEN_TARGET_KEYS = Object.freeze([
  'url', 'uri', 'baseUrl', 'endpoint', 'origin', 'host', 'hostname', 'server', 'address', 'ip',
  'port', 'path', 'paths', 'pathPrefix', 'headers', 'header', 'query',
  'user', 'username', 'password', 'secret', 'token', 'credential', 'credentials',
  'apiKey', 'bearerToken', 'connectionString', 'dsn',
])

// Refused in EVERY string position. A gate whose allowlist accepts `'*'` is not an allowlist.
const WILDCARD_TOKENS = Object.freeze(['*', '**', 'all', 'any'])

class OutboundHttpWriteGateError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'OutboundHttpWriteGateError'
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

// Load-time fault. Values-free: `field` is a JSON POINTER INTO THE FILE (a shape, authored by this
// module's own key vocabulary), never a value read out of it and never the file's path.
function failAllowlist(message, details) {
  throw new OutboundHttpWriteGateError(
    OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID_STATUS,
    OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID,
    message,
    details || {},
  )
}

function assertNoWildcard(value, field) {
  if (WILDCARD_TOKENS.includes(value.toLowerCase()) || value.includes('*')) {
    failAllowlist(
      `${field} must name one target exactly; this gate has no wildcard`,
      { field, reason: 'wildcard_forbidden' },
    )
  }
  return value
}

function requiredString(value, field) {
  const parsed = optionalString(value)
  if (!parsed) failAllowlist(`${field} is required`, { field })
  return assertNoWildcard(parsed, field)
}

function optionalMatchString(value, field) {
  if (value === undefined || value === null) return null
  return requiredString(value, field)
}

function assertClosedKeySet(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    if (FORBIDDEN_TARGET_KEYS.includes(key)) {
      failAllowlist(
        `${label}.${key}: an outbound HTTP write target is authorized by its declared identity and never by URL, host, path or credential`,
        { field: `${label}.${key}`, reason: 'identity_matching_only' },
      )
    }
    failAllowlist(`${label}.${key} is not a supported key`, { field: `${label}.${key}` })
  }
}

function requiredStringList(list, field) {
  if (!Array.isArray(list) || list.length === 0) {
    failAllowlist(`${field} must be a non-empty array`, { field })
  }
  const out = []
  for (let index = 0; index < list.length; index += 1) {
    out.push(requiredString(list[index], `${field}[${index}]`))
  }
  if (new Set(out).size !== out.length) {
    failAllowlist(`${field} must not repeat an entry`, { field })
  }
  return Object.freeze(out)
}

/**
 * Normalize ONE allowlist entry. Every fault is fatal at load, and a load fault DENIES.
 *
 * OBJECT SCOPE IS NOT DECORATION. Exactly one of `objects` (an explicit enumeration) or
 * `allObjects: true` (an explicit, reviewable "every object of this system") must be present.
 * Omitting both is a load error rather than an implicit wildcard, and supplying both is a load
 * error rather than a silent precedence rule nobody can remember.
 */
function normalizeTarget(raw, index) {
  const label = `targets[${index}]`
  if (!isPlainObject(raw)) failAllowlist(`${label} must be an object`, { field: label })
  assertClosedKeySet(raw, TARGET_KEYS, label)

  const entryId = requiredString(raw.entryId, `${label}.entryId`)
  const systemId = requiredString(raw.systemId, `${label}.systemId`)
  // Optional CORROBORATING identities. When present they must AGREE with the loaded system, so an
  // entry can be written to survive an id reuse; when absent the id alone decides. They can only
  // ever NARROW a match — there is no spelling of them that widens one.
  const systemName = optionalMatchString(raw.systemName, `${label}.systemName`)
  const kind = optionalMatchString(raw.kind, `${label}.kind`)

  const hasObjects = raw.objects !== undefined && raw.objects !== null
  const allObjects = raw.allObjects === undefined ? false : raw.allObjects
  if (allObjects !== false && allObjects !== true) {
    failAllowlist(`${label}.allObjects must be a boolean`, { field: `${label}.allObjects` })
  }
  if (hasObjects && allObjects === true) {
    failAllowlist(
      `${label} must declare either an objects enumeration or allObjects, never both`,
      { field: `${label}.objects`, reason: 'ambiguous_object_scope' },
    )
  }
  if (!hasObjects && allObjects !== true) {
    failAllowlist(
      `${label} must declare an objects enumeration, or set allObjects true to authorize every object of this system`,
      { field: `${label}.objects`, reason: 'object_scope_required' },
    )
  }
  const objects = hasObjects ? requiredStringList(raw.objects, `${label}.objects`) : null

  // Defaults to the one operation that existed when this file was written. Spelled out rather than
  // left implicit so a reviewer reading an entry sees the entry point it opens.
  const operations = raw.operations === undefined || raw.operations === null
    ? Object.freeze([OUTBOUND_HTTP_WRITE_OPERATION_UPSERT])
    : requiredStringList(raw.operations, `${label}.operations`)
  for (const operation of operations) {
    if (!OUTBOUND_HTTP_WRITE_OPERATIONS.includes(operation)) {
      failAllowlist(
        `${label}.operations contains an operation that is not a registered outbound HTTP write entry point`,
        { field: `${label}.operations`, reason: 'unknown_operation' },
      )
    }
  }

  return Object.freeze({
    entryId,
    systemId,
    systemName,
    kind,
    objects,
    allObjects: allObjects === true,
    operations,
  })
}

/**
 * Read the allowlist off the environment. THREE states only.
 *
 *   * env unset / blank        -> `null`. DENIED, and no file I/O happens at all.
 *   * env set, file usable     -> a frozen, validated allowlist.
 *   * env set, anything else   -> THROWS `OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID`. Never `null`:
 *                                 a typo in the path must be distinguishable from "unset", and a
 *                                 broken file must not degrade into either state silently.
 *
 * Parameterless with respect to POLICY. `env` exists only so the suites can drive the loader
 * without mutating the process, and it is never threaded from a request, a route, a config object
 * or an adapter constructor — every production call site invokes this with no arguments.
 */
function loadOutboundHttpWriteAllowlist(env = process.env) {
  const raw = env ? env[OUTBOUND_HTTP_WRITE_TARGETS_ENV] : undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const filePath = raw.trim()

  let contents
  try {
    contents = fs.readFileSync(filePath, 'utf8')
  } catch {
    // Values-free: the path is deployment topology, so it is named by ENV KEY and never echoed.
    // The underlying fs error message is dropped entirely — it embeds the path.
    failAllowlist(`${OUTBOUND_HTTP_WRITE_TARGETS_ENV} points at a file that could not be read`, {
      envKey: OUTBOUND_HTTP_WRITE_TARGETS_ENV,
      reason: 'unreadable',
    })
  }

  let parsed
  try {
    parsed = JSON.parse(contents)
  } catch {
    failAllowlist(`${OUTBOUND_HTTP_WRITE_TARGETS_ENV} must point at a file containing valid JSON`, {
      envKey: OUTBOUND_HTTP_WRITE_TARGETS_ENV,
      reason: 'malformed_json',
    })
  }
  if (!isPlainObject(parsed)) {
    failAllowlist(
      `${OUTBOUND_HTTP_WRITE_TARGETS_ENV} must point at a JSON object with allowlistId, allowlistVersion and targets`,
      { envKey: OUTBOUND_HTTP_WRITE_TARGETS_ENV, reason: 'not_an_object' },
    )
  }

  assertClosedKeySet(parsed, ALLOWLIST_KEYS, 'outboundHttpWriteTargets')
  const allowlistId = requiredString(parsed.allowlistId, 'allowlistId')
  if (!Number.isInteger(parsed.allowlistVersion) || parsed.allowlistVersion <= 0) {
    failAllowlist('allowlistVersion must be a positive integer', { field: 'allowlistVersion' })
  }
  if (!Array.isArray(parsed.targets)) {
    failAllowlist('targets must be an array', { field: 'targets' })
  }

  const targets = parsed.targets.map((entry, index) => normalizeTarget(entry, index))

  // Duplicate entry ids would make a refusal/authorization stanza ambiguous about WHICH entry
  // decided, which is the one thing the stanza exists to say.
  const seen = new Set()
  for (const target of targets) {
    if (seen.has(target.entryId)) {
      failAllowlist('targets contains a duplicate entryId', {
        field: 'targets',
        entryId: target.entryId,
        reason: 'duplicate_entry_id',
      })
    }
    seen.add(target.entryId)
  }

  // An ARMED allowlist with an EMPTY `targets` array is legal and authorizes nothing. That is the
  // correct state for a deployment that has turned the capability on and has not yet approved a
  // target; rejecting it would push operators toward leaving the env unset, which is not safer, it
  // is merely less visible.
  return Object.freeze({
    allowlistId,
    allowlistVersion: parsed.allowlistVersion,
    targets: Object.freeze(targets),
    targetCount: targets.length,
  })
}

function matchesTarget(target, subject) {
  if (target.systemId !== subject.systemId) return false
  if (target.systemName !== null && target.systemName !== subject.systemName) return false
  if (target.kind !== null && target.kind !== subject.kind) return false
  if (!target.operations.includes(subject.operation)) return false
  if (target.allObjects) return true
  // Fail-closed on an unresolved object: an entry that enumerates objects cannot authorize a write
  // whose object nobody could name.
  if (subject.object === null) return false
  return target.objects !== null && target.objects.includes(subject.object)
}

/**
 * DECIDE, WITHOUT THROWING.
 *
 * Returns a frozen, values-free decision. Used by the pipeline dry-run preview, which must be able
 * to say `canApply: false` with the code that WOULD fire — a preview that showed a clean plan for a
 * write the gate will refuse would be a lie, and E4-05's lesson cuts both ways: a preview must
 * neither die on a gated target nor pretend the apply is available.
 *
 * A load fault is reported here rather than thrown, so a malformed deployment file degrades a
 * PREVIEW into an honest refusal instead of taking the read leg down with it. `assert…` below still
 * throws on the same fault, because a real write must stop hard.
 */
function evaluateOutboundHttpWrite(input = {}, env = process.env) {
  const subject = Object.freeze({
    systemId: optionalString(input.systemId),
    systemName: optionalString(input.systemName),
    kind: optionalString(input.kind),
    object: optionalString(input.object),
    operation: optionalString(input.operation),
  })
  const base = {
    systemId: subject.systemId,
    object: subject.object,
    operation: subject.operation,
  }

  // UNKNOWN ENTRY POINTS DEFAULT-REFUSE. Unreachable from a request — operations are module
  // constants at every call site — so this fires when a NEW write path is added without being
  // inventoried, which is exactly when it should.
  if (!subject.operation || !OUTBOUND_HTTP_WRITE_OPERATIONS.includes(subject.operation)) {
    return Object.freeze({
      ...base,
      authorized: false,
      canApply: false,
      code: OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
      status: OUTBOUND_HTTP_WRITE_REFUSAL_STATUS,
      reason: 'unknown_write_operation',
      message: OUTBOUND_HTTP_WRITE_REFUSAL_MESSAGES[OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED],
    })
  }

  let allowlist
  try {
    allowlist = loadOutboundHttpWriteAllowlist(env)
  } catch (error) {
    const details = error instanceof OutboundHttpWriteGateError ? error.details : {}
    return Object.freeze({
      ...base,
      authorized: false,
      canApply: false,
      code: OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID,
      status: OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID_STATUS,
      reason: optionalString(details.reason) || 'allowlist_invalid',
      message: OUTBOUND_HTTP_WRITE_REFUSAL_MESSAGES[OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID],
    })
  }

  // THE DEFAULT. Unset env => refused, with the fixed code, before any file is opened.
  if (allowlist === null) {
    return Object.freeze({
      ...base,
      authorized: false,
      canApply: false,
      code: OUTBOUND_HTTP_WRITE_DISABLED,
      status: OUTBOUND_HTTP_WRITE_REFUSAL_STATUS,
      reason: 'capability_not_authorized',
      message: OUTBOUND_HTTP_WRITE_REFUSAL_MESSAGES[OUTBOUND_HTTP_WRITE_DISABLED],
    })
  }

  const scoped = {
    ...base,
    allowlistId: allowlist.allowlistId,
    allowlistVersion: allowlist.allowlistVersion,
  }

  // Fail-closed on an under-specified subject: without a resolved system id nothing can match.
  if (!subject.systemId) {
    return Object.freeze({
      ...scoped,
      authorized: false,
      canApply: false,
      code: OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
      status: OUTBOUND_HTTP_WRITE_REFUSAL_STATUS,
      reason: 'missing_system_identity',
      message: OUTBOUND_HTTP_WRITE_REFUSAL_MESSAGES[OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED],
    })
  }

  const matched = allowlist.targets.filter((target) => matchesTarget(target, subject))
  if (matched.length === 0) {
    return Object.freeze({
      ...scoped,
      authorized: false,
      canApply: false,
      code: OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
      status: OUTBOUND_HTTP_WRITE_REFUSAL_STATUS,
      reason: 'target_not_listed',
      // A count, never the names: how many entries exist is a shape fact; which targets a
      // deployment authorizes is not this caller's business.
      allowlistTargetCount: allowlist.targetCount,
      message: OUTBOUND_HTTP_WRITE_REFUSAL_MESSAGES[OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED],
    })
  }

  // Deterministic pick: lowest entry id, so a stanza names a stable entry rather than one that
  // depends on the order a deployer happened to write the file in.
  const entryIds = matched.map((target) => target.entryId).sort()
  return Object.freeze({
    ...scoped,
    authorized: true,
    canApply: true,
    code: null,
    status: 200,
    reason: 'authorized',
    entryId: entryIds[0],
    matchedEntryCount: matched.length,
  })
}

/**
 * REFUSE OR RETURN. The form every enforcement point uses.
 *
 * `buildError` receives (status, code, message, details) so each layer throws ITS OWN error type
 * (AdapterValidationError / PipelineRunnerError / HttpRouteError) and rides that layer's established
 * mapping — while the code, message and status stay identical across layers. This module never
 * learns those error shapes; that is what keeps it a leaf.
 */
function assertOutboundHttpWriteAuthorized(buildError, input = {}, env = process.env) {
  const decision = evaluateOutboundHttpWrite(input, env)
  if (decision.authorized) return decision
  const { authorized, canApply, status, code, message, ...details } = decision
  throw buildError(status, code, message, { code, ...details })
}

module.exports = {
  GENERIC_HTTP_WRITE_KINDS,
  OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID,
  OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID_STATUS,
  OUTBOUND_HTTP_WRITE_DISABLED,
  OUTBOUND_HTTP_WRITE_ERROR_CODES,
  OUTBOUND_HTTP_WRITE_OPERATIONS,
  OUTBOUND_HTTP_WRITE_OPERATION_REQUEST,
  OUTBOUND_HTTP_WRITE_OPERATION_UPSERT,
  OUTBOUND_HTTP_WRITE_REFUSAL_MESSAGES,
  OUTBOUND_HTTP_WRITE_REFUSAL_STATUS,
  OUTBOUND_HTTP_WRITE_TARGETS_ENV,
  OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
  OutboundHttpWriteGateError,
  SAFE_HTTP_METHODS,
  assertOutboundHttpWriteAuthorized,
  evaluateOutboundHttpWrite,
  isGenericHttpWriteKind,
  isWriteMethod,
  loadOutboundHttpWriteAllowlist,
}
