'use strict'

// B2a TRIAL REGISTRATION — the enforceable form of the "限时架构例外登记" the v9.1 freeze asked for.
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
//   ENV UNSET  ->  the host omits the config key  ->  `createB2aTrialRegistry` returns `null`
//              ->  DORMANT. Not one call is gated. Behaviour is byte-identical to a deployment that
//                  never heard of this module — same plan, same revision, same evidence keys, same
//                  written payload. Synthetic fixtures, local demos and the whole existing test
//                  corpus are untouched. This is the #5108 dormancy pattern, unchanged.
//
//   ENV SET    ->  the registry is built ONCE at route registration  ->  ARMED. From that moment
//                  EVERY gated stock-preparation source-reading call must match a live entry on
//                  (tenantId, externalSystemId, projectNo-within-scope, purpose, not-expired,
//                  already-effective) or be REFUSED — before the source adapter is invoked.
//
// THE THING THAT IS DELIBERATELY *NOT* CODE HERE. Dormancy means an operator who simply never sets
// the env var reads a real customer's PLM with nothing standing in the way. That is prohibited
// PROCEDURALLY, by the W0 operator checklist, not by this file. Making the code refuse instead
// would mean every synthetic dry-run in CI, every demo and every unit test had to carry a
// registration file — which is how a gate gets switched off wholesale and stays off. A gate that is
// armed by an explicit deployment act, and total once armed, is worth more than one that everybody
// routes around. This limitation is stated in the evidence stanza too (`armed: true` appears only
// when it is), so a reviewer can tell the two states apart from the output alone rather than
// having to guess from the absence of a key.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE ENTRY IS SCOPED, AND WHY tenant+project ALONE WAS RULED INSUFFICIENT
// ─────────────────────────────────────────────────────────────────────────────
//
// R-09's lesson is binding here. The existing production-apply instrument
// (stock-preparation-production-policy.cjs) is PROCESS-GLOBAL: one policy per server, carrying no
// tenant field and no project field at all. That was the wrong shape — it can only ever say "this
// server may apply", never "this customer, on this system, for these projects". A B2a registration
// that repeated it would be a rename, not a mechanism.
//
// So the KEY is `tenantId + sourceBinding.externalSystemId + projectScope [+ purpose]`. Tenant plus
// project was explicitly ruled insufficient in review: ONE customer can connect several PLM/ERP
// systems (a PLM and a K3, or two PLM instances mid-migration), and an exception granted for one of
// them must not silently authorize reads against the other. The external-system id is the only
// thing in this codebase that distinguishes them — it is what `action.source.externalSystemId`
// already names and what `loadTableActionSourceAdapter` already resolves against.
//
// ─────────────────────────────────────────────────────────────────────────────
// SHAPE: A FILE, NOT AN ENV-JSON BLOB
// ─────────────────────────────────────────────────────────────────────────────
//
// The host reads `INTEGRATION_CORE_B2A_REGISTRY_PATH` through the generalized
// `readDeployJsonObjectFile` in packages/core-backend/src/plugin-runtime-config.ts — the same reader
// the customer-pack catalog and the ext-field mapping use, for the same reasons: unset omits the
// key; unreadable/malformed THROWS naming the ENV KEY and never echoing the path (a path is
// deployment topology). A registration carries owner names, expiry dates and a customer's project
// numbers; it is a reviewable artifact that belongs in a file on the deployment's own machine, not
// inline in a process environment where it cannot be diffed or signed off.
//
// This module is the plugin-side half, built ONCE at registration
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
//   * every listed field REQUIRED. An entry missing `owner`, `b2bCondition` or `expiryHandling` is
//     refused AT LOAD TIME: an exception nobody owns, with no migration condition and no stated
//     consequence for overrunning, is precisely the "首客户交付路径 -> 事实上的第二套集成框架" drift
//     the registration exists to prevent.
//
// ONE DELIBERATE DEVIATION FROM THAT MODULE, and it is a deviation: expiry against the WALL CLOCK is
// checked at CHECK time, not at load. An already-expired entry LOADS (it is well-formed) and then
// refuses every single call. Throwing at load would make plugin activation depend on the time of
// day — a restart at one minute past an expiry would take down pipelines, connectors, sealed-export
// and every other capability in this plugin, which is a far worse failure than refusing the one
// gated action. It is also the production-policy module's own structure: it keeps
// `assertProductionPolicyNotExpired` separate precisely so the caller supplies `now` and the module
// holds no clock. `MAX_B2A_REGISTRATION_WINDOW_MS` is what stays load-time, because a window length
// needs no clock to check.
//
// ─────────────────────────────────────────────────────────────────────────────
// VALUES-FREE
// ─────────────────────────────────────────────────────────────────────────────
//
// Refusals and passes carry: the registry id/version, the entry id, coarse reason tokens, and
// BOOLEANS for each scope dimension. They never carry a projectNo, a tenant id, the contents of a
// project scope, an owner name or a date. `entryId` is a deployment-authored slug and
// `externalSystemId` already appears in this plugin's existing TABLE_ACTION_SOURCE_INVALID detail,
// so neither is newly disclosed — and even those are omitted from the no-entry refusal, which
// cannot name an entry it did not find.

// The single server-config key the host writes. Named for the mechanism, not for stock preparation:
// the registry keys on (tenant, system, scope, purpose), and the stock-prep line is its FIRST
// consumer rather than its definition. A second consumer arrives as a new `purpose`, not as a new
// config key.
const B2A_TRIAL_REGISTRY_CONFIG_KEY = 'b2aTrialRegistry'

// Closed purpose vocabulary. A `purpose` is the identity of a CALL SITE and is always a frozen
// constant spelled in this file — never anything derived from a request. That is what makes
// `forbidReuse` mean something: see the note on it below.
const B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION = 'stock-preparation.table-action'
const B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST = 'stock-preparation.mvp-persist'
const B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM = 'stock-preparation.large-bom-expansion'

const B2A_PURPOSES = Object.freeze([
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
  B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
])

// Bounded exception window. 180 days is long enough for a real narrow-path activation (the freeze
// estimates B2a at ≈3–5 pw of engineering plus gate calendar) and short enough that an exception
// cannot quietly outlive the P2.5 migration it is supposed to be replaced by. Reviewed bound;
// tighten it and the only thing that breaks is an over-long registration, at load, loudly.
const MAX_B2A_REGISTRATION_WINDOW_MS = 180 * 24 * 60 * 60 * 1000

// Closed vocabulary for `expiryHandling`. The freeze asks the registration to state "逾期未迁移的处理
// 方式"; the only handling this cut can MECHANICALLY perform is refusal, so that is the only value
// accepted. Writing prose here would be a field that reads like a control and is not one.
const B2A_EXPIRY_HANDLINGS = Object.freeze(['refuse'])

const REGISTRY_KEYS = Object.freeze(['registryId', 'registryVersion', 'entries'])
const ENTRY_KEYS = Object.freeze([
  'entryId',
  'tenantId',
  'sourceBinding',
  'projectScope',
  'purpose',
  'owner',
  'effectiveAt',
  'expiresAt',
  'forbidReuse',
  'b2bCondition',
  'expiryHandling',
])
const SOURCE_BINDING_KEYS = Object.freeze(['externalSystemId', 'systemKind'])
const PROJECT_SCOPE_KEYS = Object.freeze(['projectNos'])

class B2aTrialRegistryError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'B2aTrialRegistryError'
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
  throw new B2aTrialRegistryError(500, 'B2A_TRIAL_REGISTRY_INVALID', message, details || {})
}

// Check-time refusal. 403, values-free: a coarse reason plus booleans.
function refuse(reason, message, details) {
  throw new B2aTrialRegistryError(
    403,
    'B2A_TRIAL_REGISTRATION_REQUIRED',
    message,
    { reason, ...(details || {}) },
  )
}

// Strict ISO-8601 with explicit time and zone. Lifted from
// stock-preparation-production-policy.cjs deliberately rather than imported: that module is the
// production-APPLY contract and importing it here would couple a read-side gate to a write-side
// policy that a future change might legitimately move. The two are checked against each other by
// test (b2a-trial-registry.test.cjs asserts identical accept/reject behaviour on a shared vector
// table), so the duplication cannot drift silently.
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
      failConfig(`${label}.${key} is not a supported key`, { field: `${label}.${key}` })
    }
  }
}

function requiredString(value, field) {
  const parsed = optionalString(value)
  if (!parsed) failConfig(`${field} is required`, { field })
  return parsed
}

function normalizeSourceBinding(raw, label) {
  if (!isPlainObject(raw)) failConfig(`${label} must be an object`, { field: label })
  assertClosedKeySet(raw, SOURCE_BINDING_KEYS, label)
  // The external-system id IS the discriminator that tenant+project could not provide. Required, and
  // deliberately not defaultable: an entry that does not name a system authorizes every system the
  // tenant has connected, which is the failure this key exists to prevent.
  const externalSystemId = requiredString(raw.externalSystemId, `${label}.externalSystemId`)
  const systemKind = raw.systemKind === undefined ? null : requiredString(raw.systemKind, `${label}.systemKind`)
  return Object.freeze({ externalSystemId, systemKind })
}

function normalizeProjectScope(raw, label) {
  if (!isPlainObject(raw)) failConfig(`${label} must be an object`, { field: label })
  assertClosedKeySet(raw, PROJECT_SCOPE_KEYS, label)
  const list = raw.projectNos
  if (!Array.isArray(list) || list.length === 0) {
    // No wildcard, on purpose. "允许读写的数据范围" with no enumeration is not a scope.
    failConfig(`${label}.projectNos must be a non-empty array of project numbers`, { field: `${label}.projectNos` })
  }
  const projectNos = []
  for (let index = 0; index < list.length; index += 1) {
    const projectNo = optionalString(list[index])
    if (!projectNo) failConfig(`${label}.projectNos[${index}] must be a non-empty string`, { field: `${label}.projectNos` })
    projectNos.push(projectNo)
  }
  if (new Set(projectNos).size !== projectNos.length) {
    failConfig(`${label}.projectNos must not repeat a project number`, { field: `${label}.projectNos` })
  }
  return Object.freeze({ projectNos: Object.freeze(projectNos) })
}

/**
 * Normalize ONE registration entry. Every fault is fatal at load.
 *
 * `forbidReuse` — WHAT IT ACTUALLY ENFORCES, stated exactly, because a field that sounds like a
 * control and is not one is worse than no field:
 *
 *   `forbidReuse: true` REQUIRES the entry to name a `purpose`, and then the entry matches ONLY
 *   calls arriving with that exact purpose. A `purpose` is the identity of a CALL SITE — a frozen
 *   constant in this module's `B2A_PURPOSES`, never request-derived — so a SECOND consumer (another
 *   read path, another application reaching for the same narrow binding) presents a different
 *   purpose and is refused with `purpose_not_permitted`, even though the tenant, the system and the
 *   project all match. That is the mechanically enforceable core of "禁止被其他应用复用".
 *
 *   `forbidReuse: false` lets an entry omit `purpose`, and it then matches any gated purpose. It is
 *   the explicit, reviewable way to write "this registration is shared across the stock-prep call
 *   sites", and it has to be written down rather than defaulted into.
 *
 * WHAT IT DOES NOT ENFORCE, and cannot in this cut:
 *   * It does not stop a human ADDING a second entry to the registry file for the same binding under
 *     a different purpose. That is a review control (the file is a reviewed artifact), not a code
 *     control, and this module does not pretend otherwise.
 *   * It does not discriminate by actionId. The stock-prep action registry accepts exactly one
 *     actionId (PLM_STOCK_PREPARATION_ACTION_ID), so "a second actionId" is not a state this
 *     codebase can currently reach; encoding a check for it would be an untestable assertion.
 *     Purpose is the discriminator that exists and is exercisable today.
 */
function normalizeEntry(raw, index) {
  const label = `${B2A_TRIAL_REGISTRY_CONFIG_KEY}.entries[${index}]`
  if (!isPlainObject(raw)) failConfig(`${label} must be an object`, { field: label })
  assertClosedKeySet(raw, ENTRY_KEYS, label)

  const entryId = requiredString(raw.entryId, `${label}.entryId`)
  const tenantId = requiredString(raw.tenantId, `${label}.tenantId`)
  const sourceBinding = normalizeSourceBinding(raw.sourceBinding, `${label}.sourceBinding`)
  const projectScope = normalizeProjectScope(raw.projectScope, `${label}.projectScope`)
  const owner = requiredString(raw.owner, `${label}.owner`)
  const b2bCondition = requiredString(raw.b2bCondition, `${label}.b2bCondition`)

  const expiryHandling = requiredString(raw.expiryHandling, `${label}.expiryHandling`)
  if (!B2A_EXPIRY_HANDLINGS.includes(expiryHandling)) {
    failConfig(`${label}.expiryHandling must be one of ${B2A_EXPIRY_HANDLINGS.join(' | ')}`, {
      field: `${label}.expiryHandling`,
    })
  }

  if (typeof raw.forbidReuse !== 'boolean') {
    failConfig(`${label}.forbidReuse must be a boolean`, { field: `${label}.forbidReuse` })
  }
  const forbidReuse = raw.forbidReuse
  const purpose = raw.purpose === undefined ? null : requiredString(raw.purpose, `${label}.purpose`)
  if (purpose !== null && !B2A_PURPOSES.includes(purpose)) {
    failConfig(`${label}.purpose is not a recognized B2a purpose`, { field: `${label}.purpose` })
  }
  if (forbidReuse && purpose === null) {
    failConfig(`${label}.purpose is required when forbidReuse is true`, { field: `${label}.purpose` })
  }

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
    entryId,
    tenantId,
    sourceBinding,
    projectScope,
    purpose,
    owner,
    effectiveAt,
    effectiveAtMs,
    expiresAt,
    expiresAtMs,
    forbidReuse,
    b2bCondition,
    expiryHandling,
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
function resolveB2aTrialRegistryConfig(config) {
  if (!config || !Object.prototype.hasOwnProperty.call(config, B2A_TRIAL_REGISTRY_CONFIG_KEY)) {
    return undefined
  }
  const raw = config[B2A_TRIAL_REGISTRY_CONFIG_KEY]
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) {
    failConfig(
      `${B2A_TRIAL_REGISTRY_CONFIG_KEY} must be an object; unset INTEGRATION_CORE_B2A_REGISTRY_PATH to leave the B2a gate dormant`,
      { field: B2A_TRIAL_REGISTRY_CONFIG_KEY },
    )
  }
  return raw
}

/**
 * Build the ONE registry this server enforces, or `null` when the env var is unset (DORMANT).
 *
 * An ARMED registry with an EMPTY `entries` array is legal and refuses everything. That is not a
 * degenerate case to reject — it is the correct state for a deployment that has armed the gate and
 * has not yet had an exception approved, and rejecting it would push operators toward leaving the
 * env var unset instead, which is strictly worse.
 *
 * @param {object} options.config server config (`context.config`)
 * @returns {object|null} a frozen registry, or `null` when dormant.
 */
function createB2aTrialRegistry({ config } = {}) {
  const raw = resolveB2aTrialRegistryConfig(config)
  if (raw === undefined) return null

  assertClosedKeySet(raw, REGISTRY_KEYS, B2A_TRIAL_REGISTRY_CONFIG_KEY)
  const registryId = requiredString(raw.registryId, `${B2A_TRIAL_REGISTRY_CONFIG_KEY}.registryId`)
  if (!Number.isInteger(raw.registryVersion) || raw.registryVersion <= 0) {
    failConfig(`${B2A_TRIAL_REGISTRY_CONFIG_KEY}.registryVersion must be a positive integer`, {
      field: `${B2A_TRIAL_REGISTRY_CONFIG_KEY}.registryVersion`,
    })
  }
  if (!Array.isArray(raw.entries)) {
    failConfig(`${B2A_TRIAL_REGISTRY_CONFIG_KEY}.entries must be an array`, {
      field: `${B2A_TRIAL_REGISTRY_CONFIG_KEY}.entries`,
    })
  }

  const entries = raw.entries.map((entry, index) => normalizeEntry(entry, index))
  const seenIds = new Set()
  for (const entry of entries) {
    if (seenIds.has(entry.entryId)) {
      // Duplicate ids would make an evidence stanza ambiguous about WHICH registration authorized a
      // read, which is the one thing the stanza exists to say.
      failConfig(`${B2A_TRIAL_REGISTRY_CONFIG_KEY}.entries contains a duplicate entryId`, {
        field: `${B2A_TRIAL_REGISTRY_CONFIG_KEY}.entries`,
        entryId: entry.entryId,
      })
    }
    seenIds.add(entry.entryId)
  }

  return Object.freeze({
    registryId,
    registryVersion: raw.registryVersion,
    entries: Object.freeze(entries),
    entryCount: entries.length,
  })
}

function isRegistry(value) {
  return Boolean(
    isPlainObject(value)
    && typeof value.registryId === 'string'
    && Array.isArray(value.entries),
  )
}

/**
 * THE GATE. Call this BEFORE the source adapter is invoked.
 *
 * @param {object|null} options.registry         server-resolved; `null` => dormant => returns `null`
 * @param {string}      options.tenantId         server-resolved from the request principal
 * @param {string}      options.externalSystemId server-resolved from the action's source binding
 * @param {string}      [options.systemKind]     server-resolved; checked only when the entry pins one
 * @param {string}      options.projectNo        the normalized action parameter
 * @param {string}      options.purpose          a frozen `B2A_PURPOSES` constant, never request-derived
 * @param {number}      options.now              caller-supplied clock (this module holds none)
 * @returns {object|null} `null` when dormant; otherwise a frozen, values-free evidence stanza.
 * @throws  {B2aTrialRegistryError} 403 when armed and no live entry authorizes the call.
 */
function assertB2aTrialAuthorized(options = {}) {
  const { registry } = options
  // DORMANT. Returning `null` — rather than a stanza saying "not armed" — is what keeps the dormant
  // path byte-identical: every caller attaches evidence only when this is non-null, so a dormant
  // deployment produces exactly the object graph it produced before this module existed.
  if (registry === null || registry === undefined) return null
  if (!isRegistry(registry)) {
    // Not a caller's fault and not refusable as one: a caller reached the gate with something that
    // is not a built registry. 500 and fail-closed — never fall through to "allow".
    failConfig('b2a registry must be built by createB2aTrialRegistry before the check', { field: 'registry' })
  }

  const purpose = optionalString(options.purpose)
  if (!purpose || !B2A_PURPOSES.includes(purpose)) {
    // A call site that has not declared a purpose cannot be authorized. This is unreachable from a
    // request (purposes are module constants at every call site) and exists so that ADDING a call
    // site without declaring one fails loudly instead of inheriting somebody else's registration.
    refuse('unknown_purpose', 'the calling path does not declare a registered B2a purpose', {
      registryId: registry.registryId,
      registryVersion: registry.registryVersion,
    })
  }

  const tenantId = optionalString(options.tenantId)
  const externalSystemId = optionalString(options.externalSystemId)
  const projectNo = optionalString(options.projectNo)
  const systemKind = optionalString(options.systemKind)
  if (!tenantId || !externalSystemId || !projectNo) {
    // Fail-closed on an under-specified call. Booleans only — the missing dimension is named, its
    // value never is.
    refuse('missing_scope', 'a B2a-gated read must resolve tenant, source system and project', {
      registryId: registry.registryId,
      registryVersion: registry.registryVersion,
      purpose,
      tenantResolved: Boolean(tenantId),
      sourceSystemResolved: Boolean(externalSystemId),
      projectResolved: Boolean(projectNo),
    })
  }

  const now = options.now
  if (!Number.isFinite(now)) {
    refuse('missing_now', 'a current timestamp is required for the B2a expiry check', {
      registryId: registry.registryId,
      registryVersion: registry.registryVersion,
      purpose,
    })
  }

  // Candidates on the BINDING half of the key — tenant plus the external system that tenant+project
  // alone could not tell apart.
  const bindingMatches = registry.entries.filter((entry) =>
    entry.tenantId === tenantId
    && entry.sourceBinding.externalSystemId === externalSystemId
    && (entry.sourceBinding.systemKind === null || entry.sourceBinding.systemKind === systemKind))

  if (bindingMatches.length === 0) {
    // Nothing to name: no entry was found, so no entryId is disclosed.
    refuse('no_entry', 'no B2a registration covers this tenant and source system', {
      registryId: registry.registryId,
      registryVersion: registry.registryVersion,
      purpose,
      sourceSystemId: externalSystemId,
    })
  }

  // PURPOSE. A `forbidReuse` entry matches only its own purpose; a shared entry (purpose omitted,
  // forbidReuse false) matches any gated purpose.
  const purposeMatches = bindingMatches.filter((entry) => entry.purpose === null || entry.purpose === purpose)
  if (purposeMatches.length === 0) {
    refuse('purpose_not_permitted', 'the B2a registration for this binding forbids reuse by this consumer', {
      registryId: registry.registryId,
      registryVersion: registry.registryVersion,
      purpose,
      sourceSystemId: externalSystemId,
      candidateEntryIds: bindingMatches.map((entry) => entry.entryId),
      forbidReuse: bindingMatches.every((entry) => entry.forbidReuse === true),
    })
  }

  const scopeMatches = purposeMatches.filter((entry) => entry.projectScope.projectNos.includes(projectNo))
  if (scopeMatches.length === 0) {
    refuse('project_out_of_scope', 'the project is outside the registered B2a data scope', {
      registryId: registry.registryId,
      registryVersion: registry.registryVersion,
      purpose,
      sourceSystemId: externalSystemId,
      candidateEntryIds: purposeMatches.map((entry) => entry.entryId),
      projectInScope: false,
    })
  }

  const live = scopeMatches.filter((entry) => now >= entry.effectiveAtMs && now < entry.expiresAtMs)
  if (live.length === 0) {
    // Distinguish "not yet" from "no longer" — both refuse, and an operator needs to know which.
    const notYet = scopeMatches.every((entry) => now < entry.effectiveAtMs)
    refuse(notYet ? 'not_yet_effective' : 'expired', notYet
      ? 'the B2a registration covering this read is not yet effective'
      : 'the B2a registration covering this read has expired', {
      registryId: registry.registryId,
      registryVersion: registry.registryVersion,
      purpose,
      sourceSystemId: externalSystemId,
      entryIds: scopeMatches.map((entry) => entry.entryId),
      effective: !notYet,
      notExpired: notYet,
      // `expiryHandling` is the registration's own declared consequence, echoed so the refusal says
      // which rule it is applying. It is a closed token, not prose.
      expiryHandling: scopeMatches[0].expiryHandling,
    })
  }

  // Deterministic pick when several live entries authorize the same call: the one expiring SOONEST,
  // so evidence names the narrowest authorization in force rather than an arbitrary one.
  const entry = live.slice().sort((a, b) => (a.expiresAtMs - b.expiresAtMs) || (a.entryId < b.entryId ? -1 : 1))[0]

  // Values-free pass stanza. Booleans and ids only — no projectNo, no tenantId, no scope contents,
  // no owner, no dates. `armed: true` is stated explicitly so a reader can tell an armed pass from a
  // dormant deployment by the presence of this object rather than by inference.
  return Object.freeze({
    armed: true,
    registryId: registry.registryId,
    registryVersion: registry.registryVersion,
    entryId: entry.entryId,
    purpose,
    sourceSystemId: externalSystemId,
    sourceBindingMatched: true,
    projectInScope: true,
    effective: true,
    notExpired: true,
    forbidReuse: entry.forbidReuse,
    expiryHandling: entry.expiryHandling,
  })
}

module.exports = {
  B2A_TRIAL_REGISTRY_CONFIG_KEY,
  B2A_PURPOSES,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
  B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
  B2A_EXPIRY_HANDLINGS,
  MAX_B2A_REGISTRATION_WINDOW_MS,
  B2aTrialRegistryError,
  assertB2aTrialAuthorized,
  createB2aTrialRegistry,
  resolveB2aTrialRegistryConfig,
}
