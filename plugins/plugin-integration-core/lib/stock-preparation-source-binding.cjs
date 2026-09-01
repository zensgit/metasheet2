'use strict'

// 工作台里选源 — the ELIGIBILITY CONTRACT for the stock-preparation table action's data SOURCE.
//
// THE PROBLEM THIS LINE EXISTS TO CLOSE. Until now the pull action's source was pinned in
// `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON` -> `source.externalSystemId`, read once at
// plugin activation into a Map (`createStockPreparationTableActionRegistry`). Pointing a deployment
// at a customer's own PLM therefore meant editing an env file on the server and restarting the
// backend. That is the single biggest onboarding cost we have, and it is not a cost the customer's
// admin can pay at all — it needs an implementer with a shell.
//
// WHAT THIS MODULE IS. The PURE half: it decides whether a given external system may be BOUND as
// that action's source, and it projects an eligible candidate into the plain-language row the
// workbench renders. It touches no database, opens no connection, reads no env, and constructs no
// adapter. The durable half is stock-preparation-source-binding-store.cjs; the request-time
// resolution is the registry's `resolveSourceBinding` seam.
//
// FAIL-CLOSED, and note WHICH direction. Eligibility is an ALLOWLIST over
// `STOCK_PREPARATION_BOM_SOURCE_KINDS` — the exact two kinds the BOM expander can read
// (`data-source:sql-readonly`, `bridge:legacy-sql-readonly`). A kind this module has never heard of
// is refused, so a connector added tomorrow is not silently bindable; it becomes a reviewable edit
// to that frozen list. Nothing here can WIDEN what the action already accepted: `normalizeSource`
// already rejected every other kind at config-parse time, and the runtime's
// `loadTableActionSourceAdapter` still re-checks `system.kind === action.source.kind` on every read.
// This is a third, earlier gate over the same set, not a new authority.
//
// THE K3 BOUNDARY (G-4 / E4 §10.1), stated precisely because it is easy to get wrong in BOTH
// directions. The permanent fence in k3-external-write-permanent-fence.cjs bans K3 WISE
// Save/Submit/Audit EXTERNAL WRITE, keyed on the write target kind `erp:k3-wise-webapi`. A source
// binding is a READ binding: it can never reach a write path, because the only thing the bound id
// is used for is `loadTableActionSourceAdapter` -> a read adapter -> `expandPlmProjectBom`.
//
// So this module aligns with the fence by CONSTRUCTION — the allowlist admits neither
// `erp:k3-wise-webapi` nor any other write-capable kind — and it deliberately does NOT import the
// fence or reuse its token. §15.2 E4-06 is explicit that a read-path refusal must surface its OWN
// pre-enumerated read-only code and must never be swallowed into `K3_WISE_EXTERNAL_WRITE_DISABLED`;
// borrowing that token here would make a mistyped source id look like an attempted external write
// in the logs, and would make the fence's own tests unable to tell a real write attempt from this.
// The refusal below is therefore `SOURCE_BINDING_KIND_INELIGIBLE`, and the K3 write kind reaches it
// by the same door every other ineligible kind does.
//
// VALUES-FREE. Everything that leaves this module is a handle or an enum: an external-system id, a
// connector kind, a status enum, a role enum, a refusal reason token. The system NAME is passed
// through for display — it is operator-authored labelling that the workbench already renders on the
// 对接总览 card and the external-systems list, at the same or a wider tier than this binding's — and
// nothing else off the row is. No config subtree, no credential, no fingerprint, no host, no
// customer business value.

const { STOCK_PREPARATION_BOM_SOURCE_KINDS } = require('./stock-preparation-bom-expansion.cjs')
const { describeConnectorKind } = require('./integration-hub-overview.cjs')

/** The one action whose source this line binds. Same literal the registry keys on. */
const PLM_STOCK_PREPARATION_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'

/**
 * The kinds a stock-preparation source may be bound to — the BOM expander's own read kinds, reused
 * rather than restated so the two can never disagree about what "a source" is.
 */
const ELIGIBLE_SOURCE_KINDS = Object.freeze([...STOCK_PREPARATION_BOM_SOURCE_KINDS])

/** Only an ACTIVE system may be bound: binding an inactive one is scheduling a 409 for later. */
const ELIGIBLE_STATUS = 'active'

/**
 * A `target`-role system is a WRITE destination. It is refused separately from the kind check so the
 * reason token says which property failed — an operator who mis-registered a role gets told that,
 * not "wrong kind".
 */
const INELIGIBLE_ROLES = Object.freeze(['target'])

/** Closed refusal vocabulary. Fixed tokens, never formatted from input. */
const SOURCE_BINDING_REFUSAL_REASONS = Object.freeze([
  'not_found',
  'kind_ineligible',
  // The action is wired for ONE of the two BOM read kinds and a candidate of the OTHER one was
  // offered. Distinct from `kind_ineligible` (which means "not a BOM source kind at all") because
  // the two need different words: one says "that connector cannot be a 备料 source", the other says
  // "that connector is fine, but not for THIS action as it is deployed".
  'kind_mismatch',
  'role_ineligible',
  'not_active',
  'data_source_not_accessible',
])

class StockPreparationSourceBindingError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationSourceBindingError'
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

function isEligibleSourceKind(kind) {
  return ELIGIBLE_SOURCE_KINDS.includes(optionalString(kind))
}

/**
 * Why this system may NOT be bound, or `null` if it may.
 *
 * PURE. `system` is the PUBLIC external-system projection (`rowToPublicExternalSystem`) — the shape
 * `listExternalSystems` / `getExternalSystem` return, whose private per-kind config subtrees are
 * already deleted. `dataSourceAccessible` is the caller's already-resolved answer to "may THIS
 * principal use the core data source behind it" (#5401 owner-only, via the host's narrow
 * `dataSources.describe` seam); `undefined` means the question does not apply to this kind.
 *
 * `requiredKind` IS THE ACTION'S OWN FROZEN `source.kind`, AND IT IS LOAD-BEARING.
 *
 * The binding moves `externalSystemId` and deliberately nothing else, so `source.kind` stays at its
 * deploy-time value for every request. The read path then re-checks it: `loadTableActionSourceAdapter`
 * refuses unless `system.kind === action.source.kind` (TABLE_ACTION_SOURCE_INVALID). So a candidate of
 * the OTHER BOM read kind is not merely sub-optimal — it is ACCEPTED-YET-UNREADABLE: the Save
 * succeeds, the binding persists, and every subsequent read fails opaquely.
 *
 * That is a fail-CLOSED outcome (a wrong-kind source is never actually read), but it is exactly the
 * onboarding footgun this whole feature exists to remove, so `requiredKind` is checked HERE — at the
 * one place both the picker and the POST consult — rather than being left to surface later as a
 * refusal an admin cannot connect to anything they did.
 *
 * Passing `requiredKind` is therefore how a caller says "for THIS action, as deployed". Omitting it
 * keeps the old, wider question ("is this a bindable 备料 source at all") for callers that genuinely
 * have no action context.
 */
function sourceBindingRefusalReason(system, { dataSourceAccessible, requiredKind } = {}) {
  if (!isPlainObject(system)) return 'not_found'
  if (!isEligibleSourceKind(system.kind)) return 'kind_ineligible'
  const wanted = optionalString(requiredKind)
  if (wanted && optionalString(system.kind) !== wanted) return 'kind_mismatch'
  if (INELIGIBLE_ROLES.includes(optionalString(system.role))) return 'role_ineligible'
  if (optionalString(system.status) !== ELIGIBLE_STATUS) return 'not_active'
  // The #5401 join. A `data-source:*` system carries only a REFERENCE to a core data source, and the
  // right to use that source is the owner's, not the integration admin's — `assertAccess` has no
  // admin bypass on the data plane. `false` here is the host facade's uniform refusal (owner
  // mismatch and deleted row are indistinguishable on purpose, so this leaks no existence either).
  //
  // WHAT THIS CHECK IS AND IS NOT. It asks whether the ADMIN DOING THE BINDING may use the source,
  // which keeps the picker honest for them and refuses a bind they could not themselves exercise. It
  // is NOT a promise about every later reader: other tenant principals invoke the action under their
  // own authority, and enforcing ownership at READ time is the adapter's job (the data-source facade
  // authorizes each read with the requesting principal), not this function's. Removing this check
  // would not open a read path; it would only let an admin bind something opaque to them.
  if (dataSourceAccessible === false) return 'data_source_not_accessible'
  return null
}

function isBindableSource(system, options = {}) {
  return sourceBindingRefusalReason(system, options) === null
}

/**
 * Refuse an unbindable system with a values-free, reason-tagged error.
 *
 * 404 for `not_found` (and ONLY that) so an id in another tenant, a deleted id and a typo are
 * indistinguishable. Everything else is a 422: the system exists and the caller may see it, so
 * naming the property that disqualified it is information they already have.
 */
function assertBindableSource(system, options = {}) {
  const reason = sourceBindingRefusalReason(system, options)
  if (reason === null) return system
  if (reason === 'not_found') {
    throw new StockPreparationSourceBindingError(404, 'SOURCE_BINDING_SOURCE_NOT_FOUND', 'source external system not found', {
      reason,
    })
  }
  throw new StockPreparationSourceBindingError(422, 'SOURCE_BINDING_SOURCE_INELIGIBLE', 'external system is not eligible as a stock-preparation source', {
    reason,
    // The kind is a structural identifier — the same class of fact TABLE_ACTION_SOURCE_INVALID
    // already reports as `actualKind`, and what tells an operator whether they picked a write
    // connector by mistake.
    kind: optionalString(system.kind),
    eligibleKinds: ELIGIBLE_SOURCE_KINDS,
    // On a mismatch, name the kind the ACTION is wired for. Without it the refusal says "wrong
    // kind" and leaves the admin to guess which one is right — and the answer is not something they
    // can see anywhere else on the screen, because it comes off deploy-time config.
    ...(reason === 'kind_mismatch' ? { requiredKind: optionalString(options.requiredKind) } : {}),
  })
}

/**
 * The workbench row for one candidate — plain language FIRST (#5391 register), the identifier
 * beside it. `describeConnectorKind` is the 对接总览's own register, reused rather than re-tabled so
 * "只读数据库桥接" means the same thing on both screens and a new connector cannot acquire two names.
 */
function projectEligibleSource(system, { dataSourceAccessible, requiredKind } = {}) {
  const kind = optionalString(system && system.kind)
  const kindInfo = describeConnectorKind(kind)
  return {
    externalSystemId: optionalString(system && system.id),
    name: optionalString(system && system.name),
    kind,
    kindLabel: kindInfo && kindInfo.label ? kindInfo.label : null,
    status: optionalString(system && system.status),
    role: optionalString(system && system.role),
    eligible: isBindableSource(system, { dataSourceAccessible, requiredKind }),
    ineligibleReason: sourceBindingRefusalReason(system, { dataSourceAccessible, requiredKind }),
  }
}

/**
 * The eligible candidate list, from the systems the caller may already list at their tier.
 *
 * `dataSourceAccessibility` is a Map/object from externalSystemId -> boolean|undefined, resolved by
 * the caller once per request. INELIGIBLE CANDIDATES ARE DROPPED, not rendered greyed-out: R-11 says
 * what is not permitted must not be visible, and a picker offering a row that would 422 on Save is
 * exactly the "visible but not actionable" failure.
 *
 * `requiredKind` narrows the list to the action's OWN kind, and it is the difference between an
 * honest picker and a trap. Without it the list offers both BOM read kinds while only one of them can
 * ever be read (see `sourceBindingRefusalReason`) — so an admin whose deploy default is
 * `data-source:sql-readonly` could pick their `bridge:legacy-sql-readonly` PLM, be told it saved, and
 * then have every refresh fail. THE RULE THIS ENCODES: never offer a choice whose Save leads to a
 * broken read.
 */
function listEligibleSources(systems, { dataSourceAccessibility, requiredKind } = {}) {
  const accessible = (id) => {
    if (!dataSourceAccessibility) return undefined
    if (typeof dataSourceAccessibility.get === 'function') return dataSourceAccessibility.get(id)
    return dataSourceAccessibility[id]
  }
  return (Array.isArray(systems) ? systems : [])
    .filter(isPlainObject)
    .map((system) => projectEligibleSource(system, {
      dataSourceAccessible: accessible(system.id),
      requiredKind,
    }))
    .filter((row) => row.eligible === true && row.externalSystemId !== null)
    .map(({ eligible: _eligible, ineligibleReason: _reason, ...row }) => row)
}

module.exports = {
  ELIGIBLE_SOURCE_KINDS,
  ELIGIBLE_STATUS,
  INELIGIBLE_ROLES,
  PLM_STOCK_PREPARATION_ACTION_ID,
  SOURCE_BINDING_REFUSAL_REASONS,
  StockPreparationSourceBindingError,
  assertBindableSource,
  isBindableSource,
  isEligibleSourceKind,
  listEligibleSources,
  projectEligibleSource,
  sourceBindingRefusalReason,
}
