'use strict'

// ---------------------------------------------------------------------------
// B-stage takeover CONFIRMATION-DECISION LEDGER — FIRST CUT.
//
// Owner-approved boundary (all four clauses hold here, by construction):
//   1. ONE decision ledger + the canonical sheet as the only projection surface.
//      This module owns exactly one managed supporting table
//      (plm_stock_preparation_confirmation_decision) and NOTHING else.
//   2. The nine frozen MVP satellite tables are NOT used by this line.
//   3. Production Apply stays OFF. This module never applies anything; the
//      planner readback it feeds still flows through the existing apply gates
//      (sandbox-only policy, explicit acknowledgements, token recompute).
//   4. The machine NEVER writes the canonical sheet's human_preserved columns.
//      Stronger, structurally: this module holds NO records-API capability
//      toward the canonical sheet at all — every write goes through a records
//      API scoped to the ledger's own sheet (createTargetScopedRecordsApi pins
//      the sheetId and throws on any attempt to leave it), the canonical
//      object's identifiers appear nowhere in this file, and a structural test
//      asserts both.
//
// FIRST-CUT SCOPE — exactly ONE conflict class:
//     duplicate_expanded_key  x  resolution keep_multiple_rows
//   * reconcile ledgers duplicate_expanded_key manual-confirm holds; every
//     other KEYED manual-confirm class is counted (values-free) and left
//     un-ledgered, so no pending row can accumulate for a class whose
//     resolution semantics do not exist yet.
//
// O1-B EXTENSION — IDENTITY FOR THE ANONYMOUS HOLD FAMILIES (owner ruling
// 2026-08-29, Q4-A). The three planner emitters that produce holds WITHOUT an
// idempotencyKey (the keyless expanded/existing row families and the
// `c2_row_error` UMBRELLA — 10 real BOM-expander types plus the ext-mapping
// coercion codes) now carry a planner-derived, values-free HASH identity when
// their emitter attaches anything stable. Those holds are ledgered as PENDING
// decision rows. Three properties make this identity and not write capability:
//   * NO new resolution action, and no change to the confirm boundary. The
//     PRE-EXISTING conflict-type check in confirmConfirmationDecision already
//     refuses anything outside the first cut, so an anonymous-family row lands
//     as a VISIBLE PENDING queue entry that cannot yet be confirmed at all.
//     "Ledgered pending" is the whole of what this cut grants.
//   * The planner readback CANNOT SEE THEM. deriveDecisionCandidates returns
//     anonymous candidates in a separate array that only reconcile consumes;
//     loadConfirmedDuplicatePolicyReview destructures `candidates` and so is
//     structurally incapable of emitting a policy for one. Not a filter — an
//     absence of capability.
//   * A hold whose emitter attaches NOTHING stable (the unvalidated
//     `c2_row_error` fallback; a keyless row with no lineage discriminator)
//     keeps today's counted-not-ledgered behaviour, now under the explicit
//     ANONYMOUS_HOLD_IDENTITY_UNAVAILABLE deferral marker in run evidence
//     rather than lumped in with the out-of-scope keyed classes.
// Full per-family audit (what each emitter really attaches, repair surface,
// identity granularity, and where NO identity exists):
//   docs/development/takeover-beiliao-20260821/
//     anonymous-hold-identity-spec-20260829.md
//   * confirm accepts ONLY keep_multiple_rows. accept_current / manual_hold
//     exist in the frozen vocabulary but their planner semantics are NOT
//     implemented in this cut, so selecting one is refused loudly at the
//     boundary (CONFIRMATION_DECISION_ACTION_UNIMPLEMENTED) instead of being
//     stored inert — the same refusal discipline the duplicate-policy
//     selection boundary already uses.
//   * the 16 human-column value entry is OUT of scope: resolvedValue /
//     resolvedAuxValue are refused at confirm
//     (CONFIRMATION_DECISION_VALUE_ENTRY_UNIMPLEMENTED); the columns stay in
//     the schema only so the converged template needs no later migration.
//   * no new-held-row entry surface, no FE view, no `cancelled` migration/UI.
//
// Ledger semantics:
//   * keyed by (staging project, target object, stableDecisionKey) with a
//     revision-bound inputFingerprint; decisionId = hash(stableDecisionKey,
//     inputFingerprint) so one decision row is one (row-identity, input) pair.
//   * fingerprint change on reconcile => the old pending/confirmed row is
//     SUPERSEDED and a fresh pending row opens; the planner readback never
//     honours a decision whose fingerprint no longer matches, so a stale
//     confirmation can only ever leave the hold standing.
//   * fingerprint RETURN on reconcile (A→B→A — the source content reverts, and
//     the revision handle is a pure content hash, so this is normal PLM/BOM
//     behaviour) REOPENS the returning fingerprint's superseded row to pending
//     and CLEARS the old human resolutionAction/notes (conservative default: a
//     revived conflict must be re-confirmed by a human, never silently
//     re-armed with the old answer); any OTHER live row of the same stable
//     key is still superseded in the same run.
//   * a PENDING row whose conflict vanished from the current plan entirely is
//     closed by reconcile's orphan sweep (status superseded; the sweep's
//     distinguishing reason travels in the run evidence — a row-level reason
//     column would need its own migration, like the reserved cancelled state).
//     CONFIRMED orphans are historical human decisions and stay untouched;
//     the readback already ignores them via the fingerprint bind.
//   * statuses: pending / confirmed / superseded (frozen public vocabulary).
//     A cancellation state is internally reserved for a later slice but is NOT
//     exposed — no API accepts, emits, or filters on it until its migration,
//     API and UI land together (HG v1.2: an enum token without its full
//     implementation must not be exposed).
//   * this module's OWN human_preserved columns (resolutionAction, notes, and
//     the two refused value columns) are written exclusively by the explicit
//     human confirm endpoint acting for the confirming admin — never by
//     reconcile, readback, or any refresh path.
//
// CONCURRENCY — DB-BACKED SINGLE ACTIVE RECONCILER (HG v1.2 hard requirement:
// an in-process lock is NOT a concurrency guarantee). The multitable records
// API offers no uniqueness constraint, so the guarantee lives in SQL:
// migration 077 creates integration_stock_prep_confirmation_reconcile_lease
// with scope_key as PRIMARY KEY, and reconcile REQUIRES a lease over it
// (createConfirmationDecisionReconcileLease). Acquisition is an INSERT — the
// unique key makes two concurrent acquirers resolve to exactly one holder —
// and takeover of an EXPIRED lease is a single-statement CAS UPDATE guarded by
// the previous lease_id. The loser of either race gets the fixed conflict code
// CONFIRMATION_DECISION_RECONCILE_BUSY and has written nothing; because
// reconcile is idempotent for an unchanged plan (A-01), retrying after the
// holder finishes is a no-op. No lease configured => reconcile refuses
// fail-closed (501), never a silent fallback to process-local locking.
// MID-RUN, the holder re-asserts ownership with a CAS renew (extend expires_at
// WHERE scope_key AND lease_id match) immediately before the FIRST ledger
// write and then every RECONCILE_LEASE_RENEW_EVERY_WRITES writes; a renew that
// matches zero rows means the lease expired and was taken over, and the run
// ABORTS with CONFIRMATION_DECISION_RECONCILE_LEASE_LOST (partial counts in
// the error payload). TRUE write fencing is impossible on the multitable
// records API — no ledger write can be made conditional on the lease row — so
// bounded abort is the ceiling here; idempotent replay (A-01) makes the writes
// that landed before the abort harmless to the takeover reconciler.
// The human CONFIRM path needs no lease: it patches exactly one existing row
// and refuses any row that is not pending; simultaneous confirms of the SAME
// decision can last-write-win on the records service, which still leaves one
// confirmed row with one action (never a duplicate decision).
// ---------------------------------------------------------------------------

const crypto = require('node:crypto')

const {
  STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
  buildSheetStructureFromMvpTableTemplate,
} = require('./stock-preparation-templates.cjs')
const {
  ANONYMOUS_HOLD_IDENTITY_PREFIX,
  DECISIONS,
  DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY,
  __internals: { stableFingerprint: duplicateGroupFingerprint },
} = require('./stock-preparation-conflict-planner.cjs')
const { createTargetScopedRecordsApi } = require('./stock-preparation-table-actions.cjs')
const {
  StockPreparationTargetProvisioningError,
  __internals: {
    assertAdminPermission,
    getProvisioningApi,
    missingLogicalFields,
    templateFieldCounts,
    templateFieldIds,
  },
} = require('./stock-preparation-target-provisioning.cjs')

const TEMPLATE = STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE
const OBJECT_ID = TEMPLATE.objectId
const FIELD_IDS = Object.freeze(TEMPLATE.fields.map((field) => field.id))
// The one conflict class of the first cut. Everything else is out of scope BY
// CONSTRUCTION: candidates of any other class are never derived, so they can
// be neither ledgered, confirmed, nor read back.
const FIRST_CUT_CONFLICT_TYPE = 'duplicate_expanded_key'
// O1-B. The fixed code an ANONYMOUS hold gets when its emitter attached nothing
// stable to key it by (the unvalidated `c2_row_error` fallback, or a keyless row
// carrying no lineage discriminator at all). Such holds stay counted-not-
// ledgered — the pre-O1-B behaviour — but they now travel in run evidence under
// their own family + count instead of being lumped in with genuinely
// out-of-scope keyed classes. Deferral, stated; never a silent drop.
const ANONYMOUS_HOLD_IDENTITY_DEFERRAL_CODE = 'ANONYMOUS_HOLD_IDENTITY_UNAVAILABLE'
// Public status vocabulary. A 'cancelled' state is reserved for a later slice
// (see the header) and deliberately NOT part of this frozen public set.
const STATUSES = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  SUPERSEDED: 'superseded',
})
const RESOLUTION_ACTIONS = Object.freeze({
  KEEP_MULTIPLE_ROWS: DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY,
  ACCEPT_CURRENT: 'accept_current',
  MANUAL_HOLD: 'manual_hold',
})
const RESOLUTION_ACTION_SET = new Set(Object.values(RESOLUTION_ACTIONS))
// Derived, not hand-copied: the ONLY action with planner semantics in this cut
// is the duplicate-resolving policy. The other vocabulary tokens are refused at
// the confirm boundary (see confirmConfirmationDecision).
const IMPLEMENTED_RESOLUTION_ACTIONS = Object.freeze([RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS])
const IMPLEMENTED_RESOLUTION_ACTION_SET = new Set(IMPLEMENTED_RESOLUTION_ACTIONS)
const READ_PAGE_LIMIT = 500
const READ_MAX_PAGES = 50
const MAX_DECISIONS_PER_RECONCILE = 2000
const CONCURRENCY_MODEL = 'db_backed_reconcile_lease'
const RECONCILE_LEASE_TABLE = 'integration_stock_prep_confirmation_reconcile_lease'
const RECONCILE_LEASE_TTL_MS = 60_000
// Mid-run lease keepalive cadence: renew every this many ledger WRITES. Up to
// MAX_DECISIONS_PER_RECONCILE sequential remote writes can far outlive one
// 60s TTL, so the write loop re-asserts ownership at this bounded cadence and
// aborts the moment the CAS reports the lease gone (see the CONCURRENCY note).
const RECONCILE_LEASE_RENEW_EVERY_WRITES = 25

class StockPreparationConfirmationDecisionError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationConfirmationDecisionError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationConfirmationDecisionError(
      422,
      'CONFIRMATION_DECISION_INPUT_INVALID',
      `${field} is required`,
      { field },
    )
  }
  return normalized
}

function normalizeIsoTime(value, field, now = () => new Date()) {
  if (value === undefined || value === null) return now().toISOString()
  const normalized = requiredString(value, field)
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    throw new StockPreparationConfirmationDecisionError(
      422,
      'CONFIRMATION_DECISION_INPUT_INVALID',
      `${field} must be an ISO timestamp`,
      { field },
    )
  }
  return parsed.toISOString()
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

// Hash namespaces are shared verbatim with the agreed cross-checkout reference
// implementation so both produce IDENTICAL decisionIds / fingerprints for the
// same plan — convergence later must not re-key anyone's ledger rows.
function stableHash(namespace, value, length = 32) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`stock-preparation-confirmation-decision:${namespace}:v1\0`)
    .update(typeof value === 'string' ? value : stableStringify(value))
    .digest('hex')
    .slice(0, length)}`
}

function recordData(record) {
  if (!isPlainObject(record)) return {}
  return isPlainObject(record.data) ? record.data : record
}

function readCell(record, key) {
  const value = recordData(record)[key]
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value
  return value
}

function buildTargetDescriptor() {
  const structure = buildSheetStructureFromMvpTableTemplate(TEMPLATE)
  const templateById = new Map(TEMPLATE.fields.map((field) => [field.id, field]))
  return {
    id: structure.objectId,
    name: structure.label,
    description: 'MetaSheet-managed stock-preparation confirmation decision ledger.',
    fields: structure.fields.map((field) => {
      const templateField = templateById.get(field.id)
      const property = field.property ? JSON.parse(JSON.stringify(field.property)) : {}
      property.stockPreparationConfirmationDecision = {
        ownership: templateField.ownership,
        preserveOnRefresh: templateField.preserveOnRefresh === true,
        required: templateField.required === true,
        key: templateField.key === true,
      }
      return { ...field, property }
    }),
  }
}

async function inspectConfirmationDecisionTarget({ context, projectId, permission } = {}) {
  assertAdminPermission(permission)
  const provisioning = getProvisioningApi(context || {})
  const scopedProjectId = requiredString(projectId, 'projectId')
  const sheet = await provisioning.findObjectSheet({ projectId: scopedProjectId, objectId: OBJECT_ID })
  if (!sheet) {
    return {
      ready: false,
      present: false,
      mode: 'confirmation_decision_missing',
      missingFields: FIELD_IDS.slice(),
      evidence: { objectId: OBJECT_ID, fieldCount: FIELD_IDS.length, missingFieldCount: FIELD_IDS.length },
    }
  }
  const resolved = await provisioning.resolveFieldIds({ projectId: scopedProjectId, objectId: OBJECT_ID, fieldIds: FIELD_IDS })
  const missingFields = missingLogicalFields(TEMPLATE, resolved)
  return {
    ready: missingFields.length === 0,
    present: true,
    mode: missingFields.length === 0 ? 'confirmation_decision_existing' : 'confirmation_decision_incomplete',
    missingFields,
    evidence: { objectId: OBJECT_ID, fieldCount: FIELD_IDS.length, missingFieldCount: missingFields.length },
  }
}

async function ensureConfirmationDecisionTarget({ context, projectId, permission, baseId } = {}) {
  assertAdminPermission(permission)
  const provisioning = getProvisioningApi(context || {})
  const scopedProjectId = requiredString(projectId, 'projectId')
  const inspected = await inspectConfirmationDecisionTarget({ context, projectId: scopedProjectId, permission })
  if (inspected.ready) {
    return {
      ready: true,
      created: false,
      mode: 'confirmation_decision_existing',
      evidence: { objectId: OBJECT_ID, created: false, rowsSeeded: 0, fieldCounts: templateFieldCounts(TEMPLATE) },
    }
  }
  if (inspected.present) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'CONFIRMATION_DECISION_TARGET_SCHEMA_INCOMPLETE',
      'existing confirmation decision table is missing template fields',
      { objectId: OBJECT_ID, missingFields: inspected.missingFields, requiredFields: templateFieldIds(TEMPLATE) },
    )
  }
  await provisioning.ensureObject({
    projectId: scopedProjectId,
    baseId: optionalString(baseId),
    descriptor: buildTargetDescriptor(),
  })
  const verified = await inspectConfirmationDecisionTarget({ context, projectId: scopedProjectId, permission })
  if (!verified.ready) {
    throw new StockPreparationTargetProvisioningError(
      422,
      'CONFIRMATION_DECISION_TARGET_SCHEMA_INCOMPLETE',
      'created confirmation decision table is missing template fields',
      { objectId: OBJECT_ID, missingFields: verified.missingFields, requiredFields: templateFieldIds(TEMPLATE) },
    )
  }
  return {
    ready: true,
    created: true,
    mode: 'confirmation_decision_created',
    evidence: { objectId: OBJECT_ID, created: true, rowsSeeded: 0, fieldCounts: templateFieldCounts(TEMPLATE) },
  }
}

function ensureRecordsApi(recordsApi, methods) {
  const missing = methods.filter((method) => !recordsApi || typeof recordsApi[method] !== 'function')
  if (missing.length) {
    throw new StockPreparationConfirmationDecisionError(
      501,
      'CONFIRMATION_DECISION_RECORDS_API_UNAVAILABLE',
      'required multitable records methods are unavailable',
      { requiredMethods: methods.slice() },
    )
  }
  return recordsApi
}

// The ONLY records-API constructor in this module. The target is pinned to the
// ledger's own objectId before the scoped API is built, and the scoped API
// itself refuses any call that names a different sheetId — so canonical-sheet
// write capability structurally does not exist here.
async function resolveScopedLedger(recordsApi, provisioning, targetProjectId, methods) {
  ensureRecordsApi(recordsApi, methods)
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function') {
    throw new StockPreparationConfirmationDecisionError(
      501,
      'CONFIRMATION_DECISION_PROVISIONING_API_UNAVAILABLE',
      'multitable provisioning API is unavailable',
      { requiredMethods: ['findObjectSheet'] },
    )
  }
  const projectId = requiredString(targetProjectId, 'targetProjectId')
  const sheet = await provisioning.findObjectSheet({ projectId, objectId: OBJECT_ID })
  const sheetId = sheet && optionalString(sheet.id || sheet.sheetId)
  if (!sheetId) {
    throw new StockPreparationConfirmationDecisionError(
      409,
      'CONFIRMATION_DECISION_TARGET_NOT_READY',
      'confirmation decision target is not provisioned',
      { objectId: OBJECT_ID },
    )
  }
  return createTargetScopedRecordsApi(recordsApi, { sheetId, objectId: OBJECT_ID }, { provisioning, projectId })
}

async function queryAll(scoped, filters) {
  const rows = []
  for (let page = 0; page < READ_MAX_PAGES; page += 1) {
    const batch = await scoped.queryRecords({ filters, limit: READ_PAGE_LIMIT, offset: page * READ_PAGE_LIMIT })
    if (!Array.isArray(batch)) {
      throw new StockPreparationConfirmationDecisionError(
        500,
        'CONFIRMATION_DECISION_RECORDS_API_INVALID',
        'queryRecords must return an array',
      )
    }
    rows.push(...batch)
    if (batch.length < READ_PAGE_LIMIT) return rows
  }
  throw new StockPreparationConfirmationDecisionError(
    413,
    'CONFIRMATION_DECISION_LIST_LIMIT_EXCEEDED',
    'confirmation decision row limit was exceeded',
    { maxRows: READ_PAGE_LIMIT * READ_MAX_PAGES },
  )
}

// THE NAMESPACE WALL between the two addressing schemes a ledger row can be
// keyed by (O1-B). A real idempotencyKey is a JSON object literal, so it can
// never begin with the reserved prefix; a planner-derived anonymous identity
// always does. Either direction crossed means the plan was not produced by the
// planner — refuse rather than key a row under a scheme it does not belong to,
// because `stableDecisionKey` folds rowIdentity in and a crossed row would
// silently claim (or be claimed by) somebody else's decision history.
function assertIdentityNamespace(value, field, mustBeAnonymous) {
  const isAnonymous = value.startsWith(ANONYMOUS_HOLD_IDENTITY_PREFIX)
  if (isAnonymous === mustBeAnonymous) return value
  throw new StockPreparationConfirmationDecisionError(
    422,
    'CONFIRMATION_DECISION_IDENTITY_NAMESPACE_VIOLATION',
    mustBeAnonymous
      ? 'a derived anonymous-hold identity must use the reserved identity namespace'
      : 'an idempotencyKey must not use the reserved anonymous-hold identity namespace',
    { field },
  )
}

// FIRST CUT + O1-B: candidates come from two DISJOINT sources.
//   * duplicate_expanded_key manual-confirm holds, addressed by idempotencyKey.
//     Unchanged — same recipe, same fingerprint inputs, so no ledger row that
//     exists today is re-keyed by this change.
//   * ANONYMOUS holds (manual_confirm carrying NO idempotencyKey: the keyless
//     expanded/existing row families and the whole `c2_row_error` umbrella)
//     that the planner could give a derived identity to. These are ledgered
//     PENDING ONLY — no resolution action has semantics for them — and they are
//     returned in a SEPARATE array so the planner readback structurally cannot
//     receive them. Identity, not write capability.
// Anonymous holds that share a derived identity are ONE decision row with an
// occurrenceCount folded into the fingerprint: the expander attaches no per-row
// discriminator to a rowError (see the O1-B spec), so the honest granularity is
// the error LOCUS, and a change in how many errors sit on that locus is a
// material change that must supersede rather than ride an old confirmation.
// Everything else is counted (values-free, by its enum-shaped conflict type)
// and skipped, exactly as before.
function countByConflictType(entries) {
  const counts = {}
  for (const entry of entries) counts[entry.conflictType] = (counts[entry.conflictType] || 0) + 1
  return counts
}

function deriveDecisionCandidates({ projectNo, plan, sourceRevision } = {}) {
  const scopedProjectNo = requiredString(projectNo, 'projectNo')
  const revision = requiredString(sourceRevision, 'sourceRevision')
  if (!isPlainObject(plan) || !Array.isArray(plan.decisions)) {
    throw new StockPreparationConfirmationDecisionError(
      422,
      'CONFIRMATION_DECISION_PLAN_INVALID',
      'plan.decisions must be an array',
      { field: 'plan.decisions' },
    )
  }
  const candidates = []
  const outOfScopeByConflictType = {}
  const identityLessByConflictType = {}
  // Insertion-ordered, so the derived candidate list is a deterministic
  // function of plan order — a reconcile-reproducibility requirement.
  const anonymousGroups = new Map()
  for (const decision of plan.decisions) {
    if (!isPlainObject(decision) || decision.decision !== DECISIONS.MANUAL_CONFIRM) continue
    const conflictType = optionalString(decision.conflictSummary && decision.conflictSummary.type) || 'unknown_conflict'
    const idempotencyKey = optionalString(decision.idempotencyKey)
    if (idempotencyKey) assertIdentityNamespace(idempotencyKey, 'plan.decisions[].idempotencyKey', false)
    if (conflictType === FIRST_CUT_CONFLICT_TYPE) {
      // The planner emits exactly one duplicate_expanded_key hold per group and
      // always stamps the duplicated key on it. A hold of this class WITHOUT a
      // key is not a planner artifact — refuse instead of ledgering an anonymous
      // row nothing could ever match again.
      if (!idempotencyKey) {
        throw new StockPreparationConfirmationDecisionError(
          422,
          'CONFIRMATION_DECISION_PLAN_INVALID',
          'duplicate_expanded_key manual-confirm decisions must carry an idempotencyKey',
          { field: 'plan.decisions[].idempotencyKey' },
        )
      }
      const rowIdentity = idempotencyKey
      const stableDecisionKey = stableHash('stable-key', { projectNo: scopedProjectNo, rowIdentity, conflictType })
      const inputFingerprint = stableHash('input', {
        sourceRevision: revision,
        stableDecisionKey,
        conflictSummary: decision.conflictSummary || null,
        changedFields: Array.isArray(decision.changedFields) ? decision.changedFields : [],
      })
      const decisionId = stableHash('revision-key', { stableDecisionKey, inputFingerprint })
      candidates.push({
        decisionId,
        stableDecisionKey,
        projectNo: scopedProjectNo,
        rowIdentity,
        conflictType,
        inputFingerprint,
        sourceRevision: revision,
        duplicateGroupFingerprint: duplicateGroupFingerprint(rowIdentity),
      })
      continue
    }
    // A KEYED hold of any other class stays out of scope, unchanged.
    if (idempotencyKey) {
      outOfScopeByConflictType[conflictType] = (outOfScopeByConflictType[conflictType] || 0) + 1
      continue
    }
    const derivedRowIdentity = optionalString(decision.derivedRowIdentity)
    if (!derivedRowIdentity) {
      identityLessByConflictType[conflictType] = (identityLessByConflictType[conflictType] || 0) + 1
      continue
    }
    assertIdentityNamespace(derivedRowIdentity, 'plan.decisions[].derivedRowIdentity', true)
    const groupKey = `${conflictType}\u0000${derivedRowIdentity}`
    const group = anonymousGroups.get(groupKey)
    if (group) {
      group.occurrenceCount += 1
      continue
    }
    anonymousGroups.set(groupKey, {
      conflictType,
      rowIdentity: derivedRowIdentity,
      // Group members share their conflictSummary BY CONSTRUCTION: every field
      // the summary carries for these classes is part of the identity context.
      // The first occurrence is therefore a faithful, order-stable representative.
      conflictSummary: decision.conflictSummary || null,
      changedFields: Array.isArray(decision.changedFields) ? decision.changedFields : [],
      occurrenceCount: 1,
    })
  }
  const anonymousCandidates = []
  for (const group of anonymousGroups.values()) {
    const stableDecisionKey = stableHash('stable-key', {
      projectNo: scopedProjectNo,
      rowIdentity: group.rowIdentity,
      conflictType: group.conflictType,
    })
    const inputFingerprint = stableHash('input', {
      sourceRevision: revision,
      stableDecisionKey,
      conflictSummary: group.conflictSummary,
      changedFields: group.changedFields,
      occurrenceCount: group.occurrenceCount,
    })
    anonymousCandidates.push({
      decisionId: stableHash('revision-key', { stableDecisionKey, inputFingerprint }),
      stableDecisionKey,
      projectNo: scopedProjectNo,
      rowIdentity: group.rowIdentity,
      conflictType: group.conflictType,
      inputFingerprint,
      sourceRevision: revision,
      occurrenceCount: group.occurrenceCount,
      // NO duplicateGroupFingerprint, deliberately: the ONLY consumer of that
      // field is the duplicate-policy readback, and an anonymous-family row
      // must never be able to emit a policy that downgrades a hold.
    })
  }
  if (candidates.length + anonymousCandidates.length > MAX_DECISIONS_PER_RECONCILE) {
    throw new StockPreparationConfirmationDecisionError(
      413,
      'CONFIRMATION_DECISION_RECONCILE_LIMIT_EXCEEDED',
      'too many manual-confirm decisions to reconcile',
      { maxDecisions: MAX_DECISIONS_PER_RECONCILE },
    )
  }
  return { candidates, anonymousCandidates, outOfScopeByConflictType, identityLessByConflictType }
}

// The DB-BACKED single-active-reconciler lease (see the CONCURRENCY header
// note and migration 077). scope_key is the table's PRIMARY KEY, so:
//   * fresh acquisition = INSERT — two concurrent acquirers resolve to exactly
//     one holder at the unique index, never in JS;
//   * takeover of an EXPIRED lease = one CAS UPDATE guarded by the previous
//     lease_id — of two stealers exactly one updates a row;
//   * renew = one CAS UPDATE extending expires_at, guarded by scope_key AND
//     the caller's own lease_id (existing migration-077 columns, no new SQL).
//     Zero rows updated means the lease expired and someone took it over: the
//     caller has LOST the lease and must abort its writes;
//   * release deletes ONLY the caller's own lease_id, so a stolen-then-released
//     stale holder cannot free somebody else's lease. Release is best-effort:
//     an unreleased lease simply expires by TTL.
function createConfirmationDecisionReconcileLease({ db, ttlMs, now } = {}) {
  if (
    !db
    || typeof db.insertOne !== 'function'
    || typeof db.selectOne !== 'function'
    || typeof db.updateRow !== 'function'
    || typeof db.deleteRows !== 'function'
  ) {
    throw new Error('createConfirmationDecisionReconcileLease: scoped db helper (insertOne/selectOne/updateRow/deleteRows) is required')
  }
  const ttl = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : RECONCILE_LEASE_TTL_MS
  const clock = typeof now === 'function' ? now : () => new Date()

  function leaseRow(scopeKey, leaseId, at) {
    return {
      scope_key: scopeKey,
      lease_id: leaseId,
      acquired_at: at.toISOString(),
      expires_at: new Date(at.getTime() + ttl).toISOString(),
    }
  }

  function expiryMs(value) {
    if (value instanceof Date) return value.getTime()
    const parsed = Date.parse(String(value))
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
  }

  return {
    async acquire(scopeKey) {
      const at = clock()
      const leaseId = crypto.randomUUID()
      try {
        await db.insertOne(RECONCILE_LEASE_TABLE, leaseRow(scopeKey, leaseId, at))
        return { held: true, leaseId }
      } catch {
        // Unique violation (someone holds or held the scope) — fall through to
        // the expired-lease CAS. Any other insert failure lands there too and
        // resolves to busy: fail-closed, never fail-open.
      }
      const current = await db.selectOne(RECONCILE_LEASE_TABLE, { scope_key: scopeKey })
      if (!current) return { held: false }
      if (expiryMs(current.expires_at) > at.getTime()) return { held: false }
      const updated = await db.updateRow(RECONCILE_LEASE_TABLE, leaseRow(scopeKey, leaseId, at), {
        scope_key: scopeKey,
        lease_id: current.lease_id,
      })
      const updatedRows = Array.isArray(updated) ? updated : (updated && Array.isArray(updated.rows) ? updated.rows : [])
      return updatedRows.length === 1 ? { held: true, leaseId } : { held: false }
    },
    async renew({ scopeKey, leaseId, ttlMs: renewTtlMs } = {}) {
      const at = clock()
      const extension = Number.isInteger(renewTtlMs) && renewTtlMs > 0 ? renewTtlMs : ttl
      const updated = await db.updateRow(
        RECONCILE_LEASE_TABLE,
        { expires_at: new Date(at.getTime() + extension).toISOString() },
        { scope_key: scopeKey, lease_id: leaseId },
      )
      const updatedRows = Array.isArray(updated) ? updated : (updated && Array.isArray(updated.rows) ? updated.rows : [])
      return { held: updatedRows.length === 1 }
    },
    async release(scopeKey, leaseId) {
      try {
        await db.deleteRows(RECONCILE_LEASE_TABLE, { scope_key: scopeKey, lease_id: leaseId })
      } catch {
        // Best-effort — the TTL bounds an unreleased lease.
      }
    },
  }
}

function requireReconcileLease(reconcileLease) {
  // renew is REQUIRED, not optional: without mid-run renewal the write loop
  // has no way to notice a lost lease, which is exactly the duplicate-active
  // -row hole this gate exists to close. Fail-closed like the rest.
  if (
    !reconcileLease
    || typeof reconcileLease.acquire !== 'function'
    || typeof reconcileLease.release !== 'function'
    || typeof reconcileLease.renew !== 'function'
  ) {
    throw new StockPreparationConfirmationDecisionError(
      501,
      'CONFIRMATION_DECISION_RECONCILE_LEASE_UNAVAILABLE',
      'reconcile requires the durable single-reconciler lease; an in-process lock is not a concurrency guarantee',
      { requiredMethods: ['acquire', 'release', 'renew'] },
    )
  }
  return reconcileLease
}

async function reconcileConfirmationDecisions({ recordsApi, provisioning, targetProjectId, permission, projectNo, plan, sourceRevision, reconcileLease, now } = {}) {
  assertAdminPermission(permission)
  const lease = requireReconcileLease(reconcileLease)
  const {
    candidates: duplicateCandidates,
    anonymousCandidates,
    outOfScopeByConflictType,
    identityLessByConflictType,
  } = deriveDecisionCandidates({ projectNo, plan, sourceRevision })
  // Reconcile is the ONLY consumer that sees both sets. The ledger lifecycle
  // (create / supersede / reopen / orphan-sweep) is identical for both — an
  // anonymous row is an ordinary pending decision row that simply happens to be
  // addressed by a derived identity instead of an idempotencyKey.
  const candidates = duplicateCandidates.concat(anonymousCandidates)
  const openedAt = normalizeIsoTime(undefined, 'openedAt', typeof now === 'function' ? now : () => new Date())
  const scopeKey = stableHash('reconcile-lock', { targetProjectId: requiredString(targetProjectId, 'targetProjectId'), projectNo: requiredString(projectNo, 'projectNo') })
  const acquired = await lease.acquire(scopeKey)
  if (!acquired || acquired.held !== true) {
    throw new StockPreparationConfirmationDecisionError(
      409,
      'CONFIRMATION_DECISION_RECONCILE_BUSY',
      'another reconciler holds the lease for this project; retry after it finishes (replay is idempotent)',
    )
  }
  try {
    const scoped = await resolveScopedLedger(recordsApi, provisioning, targetProjectId, ['queryRecords', 'createRecord', 'patchRecord'])
    const existing = await queryAll(scoped, { projectNo: requiredString(projectNo, 'projectNo') })
    const byDecisionId = new Map(existing.map((record) => [optionalString(readCell(record, 'decisionId')), record]).filter(([key]) => key))
    const byStableKey = new Map()
    for (const record of existing) {
      const key = optionalString(readCell(record, 'stableDecisionKey'))
      if (!key) continue
      const rows = byStableKey.get(key) || []
      rows.push(record)
      byStableKey.set(key, rows)
    }
    const counts = { created: 0, existing: 0, superseded: 0, reopened: 0, orphanSuperseded: 0, pending: 0, confirmed: 0 }
    // Bounded-abort write fencing (the ceiling available here — see the
    // CONCURRENCY header note): re-assert lease ownership via the CAS renew
    // immediately before the FIRST ledger write and then every
    // RECONCILE_LEASE_RENEW_EVERY_WRITES writes. A renew that reports the
    // lease gone ABORTS the run with a fixed code and the partial counts; at
    // most one cadence window of writes can race a takeover, and idempotent
    // replay (A-01) makes those surviving writes harmless.
    let writesSinceRenew = RECONCILE_LEASE_RENEW_EVERY_WRITES
    const assertLeaseBeforeWrite = async () => {
      if (writesSinceRenew >= RECONCILE_LEASE_RENEW_EVERY_WRITES) {
        const renewed = await lease.renew({ scopeKey, leaseId: acquired.leaseId })
        if (!renewed || renewed.held !== true) {
          throw new StockPreparationConfirmationDecisionError(
            409,
            'CONFIRMATION_DECISION_RECONCILE_LEASE_LOST',
            'the reconcile lease was lost mid-run (expired and taken over); aborting to bound concurrent-writer damage — retry after the takeover reconciler finishes (replay is idempotent)',
            { partial: true, counts: { ...counts } },
          )
        }
        writesSinceRenew = 0
      }
      writesSinceRenew += 1
    }
    const seenThisRun = new Set()
    for (const candidate of candidates) {
      // Replay guard #1: the same decisionId inside ONE reconcile run (the
      // planner cannot produce this for the duplicate class, but a fabricated
      // plan could) collapses to a single row.
      if (seenThisRun.has(candidate.decisionId)) continue
      seenThisRun.add(candidate.decisionId)
      // Replay guard #2: a LIVE (pending/confirmed) decision row that already
      // exists for this exact (stableDecisionKey, inputFingerprint) is left
      // untouched — re-posting the same reconcile is a no-op, never a
      // duplicate. A SUPERSEDED exact hit is NOT a replay: it means the
      // fingerprint RETURNED (A→B→A) and falls through to the reopen below.
      const exact = byDecisionId.get(candidate.decisionId)
      const exactStatus = exact ? optionalString(readCell(exact, 'status')) : null
      if (exact && exactStatus !== STATUSES.SUPERSEDED) {
        counts.existing += 1
        if (exactStatus === STATUSES.CONFIRMED) counts.confirmed += 1
        else if (exactStatus === STATUSES.PENDING) counts.pending += 1
        continue
      }
      // Fingerprint change => SUPERSEDE: any live (pending/confirmed) row for
      // the same stable decision key whose fingerprint differs is closed.
      // Superseding touches plm_system columns only — the human's own
      // resolutionAction/notes stay untouched on the closed row. This runs
      // even on a superseded exact hit, so the stale intermediate
      // fingerprint's live row still closes in the same run as the reopen.
      for (const old of byStableKey.get(candidate.stableDecisionKey) || []) {
        const status = optionalString(readCell(old, 'status'))
        const oldFingerprint = optionalString(readCell(old, 'inputFingerprint'))
        if (![STATUSES.PENDING, STATUSES.CONFIRMED].includes(status) || oldFingerprint === candidate.inputFingerprint) continue
        await assertLeaseBeforeWrite()
        await scoped.patchRecord({
          recordId: old.id,
          changes: { status: STATUSES.SUPERSEDED, supersededAt: openedAt },
        })
        counts.superseded += 1
      }
      if (exact) {
        // Fingerprint RETURN (A→B→A) => REOPEN the superseded row instead of
        // skipping it: without this the key wedges permanently (confirm
        // requires pending; readback requires confirmed + fingerprint match).
        // The OLD human decision is deliberately CLEARED, not carried forward
        // — a revived conflict is a NEW question to the human (fail-safe
        // default, flagged for the owner: O1' matrix Q5 may later rule to
        // carry it forward). confirmedBy/confirmedAt are machine bookkeeping
        // of that cleared confirmation and are cleared with it; openedAt
        // stays — it truthfully records when the decision first opened.
        await assertLeaseBeforeWrite()
        await scoped.patchRecord({
          recordId: exact.id,
          changes: {
            status: STATUSES.PENDING,
            supersededAt: null,
            resolutionAction: null,
            notes: null,
            confirmedBy: null,
            confirmedAt: null,
          },
        })
        counts.reopened += 1
        counts.pending += 1
        continue
      }
      await assertLeaseBeforeWrite()
      await scoped.createRecord({
        data: {
          decisionId: candidate.decisionId,
          stableDecisionKey: candidate.stableDecisionKey,
          projectNo: candidate.projectNo,
          rowIdentity: candidate.rowIdentity,
          conflictType: candidate.conflictType,
          inputFingerprint: candidate.inputFingerprint,
          sourceRevision: candidate.sourceRevision,
          status: STATUSES.PENDING,
          openedAt,
        },
      })
      counts.created += 1
      counts.pending += 1
    }
    // ORPHAN SWEEP: a conflict that vanished from the source leaves its ledger
    // row behind forever if only candidates are iterated. Close every PENDING
    // row (same projectNo scope as this run) whose stableDecisionKey is not in
    // the current candidate set. Reuses the frozen superseded status — the
    // distinguishing reason travels in the run evidence, because a row-level
    // reason column (like the reserved cancelled status) needs its own
    // migration/UI slice. CONFIRMED orphans are historical human decisions and
    // are left untouched (readback already ignores them via the fingerprint
    // bind). The sweep spends the remainder of the per-run decision budget;
    // anything beyond it closes on the next reconcile.
    const candidateKeys = new Set(candidates.map((candidate) => candidate.stableDecisionKey))
    const sweepBudget = MAX_DECISIONS_PER_RECONCILE - candidates.length
    let sweepTruncated = false
    for (const record of existing) {
      if (optionalString(readCell(record, 'status')) !== STATUSES.PENDING) continue
      const key = optionalString(readCell(record, 'stableDecisionKey'))
      if (key && candidateKeys.has(key)) continue
      if (counts.orphanSuperseded >= sweepBudget) {
        sweepTruncated = true
        break
      }
      await assertLeaseBeforeWrite()
      await scoped.patchRecord({
        recordId: record.id,
        changes: { status: STATUSES.SUPERSEDED, supersededAt: openedAt },
      })
      counts.orphanSuperseded += 1
    }
    return {
      ok: true,
      mode: 'confirmation_decisions_reconciled',
      counts,
      evidence: {
        objectId: OBJECT_ID,
        candidateCount: candidates.length,
        outOfScopeManualConfirm: outOfScopeByConflictType,
        // O1-B, values-free: family tokens and counts only. `ledgeredByFamily`
        // counts DECISION ROWS (one per derived identity); `ledgeredHoldCount`
        // counts the planner holds behind them, so a locus that folded 40 row
        // errors into one row still reports both numbers honestly.
        // `deferredByFamily` is the explicit marker replacing the old silent
        // lumping of identity-less anonymous holds into the out-of-scope tally.
        anonymousHoldIdentity: {
          ledgeredByFamily: countByConflictType(anonymousCandidates),
          ledgeredDecisionCount: anonymousCandidates.length,
          ledgeredHoldCount: anonymousCandidates.reduce((total, candidate) => total + candidate.occurrenceCount, 0),
          deferredByFamily: identityLessByConflictType,
          deferralCode: ANONYMOUS_HOLD_IDENTITY_DEFERRAL_CODE,
        },
        concurrencyModel: CONCURRENCY_MODEL,
        orphanSweep: { closed: counts.orphanSuperseded, reason: 'conflict_vanished_from_plan', truncated: sweepTruncated },
        ...counts,
      },
    }
  } finally {
    await lease.release(scopeKey, acquired.leaseId)
  }
}

// THE authoritative exception queue of the takeover line (converged ruling);
// canonical-sheet filter views are auxiliary. VALUES-FREE: the projection names
// ids, hashes, enum statuses and presence booleans only. rowIdentity (which
// embeds source path/component identifiers) and every other value-bearing cell
// deliberately never crosses this surface.
async function listConfirmationDecisions({ recordsApi, provisioning, targetProjectId, permission, projectNo, status } = {}) {
  assertAdminPermission(permission)
  const scoped = await resolveScopedLedger(recordsApi, provisioning, targetProjectId, ['queryRecords'])
  const filters = { projectNo: requiredString(projectNo, 'projectNo') }
  const normalizedStatus = optionalString(status)
  if (normalizedStatus) {
    if (!Object.values(STATUSES).includes(normalizedStatus)) {
      throw new StockPreparationConfirmationDecisionError(
        422,
        'CONFIRMATION_DECISION_STATUS_INVALID',
        'status is outside the frozen vocabulary',
        { field: 'status' },
      )
    }
    filters.status = normalizedStatus
  }
  const rows = await queryAll(scoped, filters)
  const counts = {}
  for (const row of rows) {
    const rowStatus = optionalString(readCell(row, 'status')) || 'unknown'
    counts[rowStatus] = (counts[rowStatus] || 0) + 1
  }
  return {
    ok: true,
    rowCount: rows.length,
    byStatus: counts,
    rows: rows.map((row) => ({
      decisionId: optionalString(readCell(row, 'decisionId')),
      conflictType: optionalString(readCell(row, 'conflictType')),
      status: optionalString(readCell(row, 'status')),
      resolutionAction: optionalString(readCell(row, 'resolutionAction')),
      inputFingerprint: optionalString(readCell(row, 'inputFingerprint')),
      sourceRevisionPresent: Boolean(optionalString(readCell(row, 'sourceRevision'))),
      confirmedByPresent: Boolean(optionalString(readCell(row, 'confirmedBy'))),
      confirmedAtPresent: Boolean(optionalString(readCell(row, 'confirmedAt'))),
    })),
  }
}

async function confirmConfirmationDecision({ recordsApi, provisioning, targetProjectId, permission, decisionId, inputFingerprint, resolutionAction, resolvedValue, resolvedAuxValue, notes, confirmedBy, now } = {}) {
  assertAdminPermission(permission)
  const id = requiredString(decisionId, 'decisionId')
  const fingerprint = requiredString(inputFingerprint, 'inputFingerprint')
  const action = requiredString(resolutionAction, 'resolutionAction')
  const actor = requiredString(confirmedBy, 'confirmedBy')
  if (!RESOLUTION_ACTION_SET.has(action)) {
    throw new StockPreparationConfirmationDecisionError(
      422,
      'CONFIRMATION_DECISION_ACTION_INVALID',
      'resolutionAction is outside the frozen vocabulary',
      { field: 'resolutionAction' },
    )
  }
  // FIRST CUT: only keep_multiple_rows has planner semantics. Refuse the other
  // vocabulary tokens HERE, at selection time, so the refusal lands on the
  // operator instead of storing a confirmation nothing will ever consume.
  if (!IMPLEMENTED_RESOLUTION_ACTION_SET.has(action)) {
    throw new StockPreparationConfirmationDecisionError(
      422,
      'CONFIRMATION_DECISION_ACTION_UNIMPLEMENTED',
      'resolutionAction has no implemented planner semantics in the first cut',
      { field: 'resolutionAction', implementedActions: IMPLEMENTED_RESOLUTION_ACTIONS.slice() },
    )
  }
  // FIRST CUT: value entry belongs to the (out-of-scope) human-column line and
  // keep_multiple_rows needs no value — refuse rather than store-and-ignore.
  for (const [field, value] of [['resolvedValue', resolvedValue], ['resolvedAuxValue', resolvedAuxValue]]) {
    if (optionalString(value)) {
      throw new StockPreparationConfirmationDecisionError(
        422,
        'CONFIRMATION_DECISION_VALUE_ENTRY_UNIMPLEMENTED',
        'resolution value entry is not part of the first cut',
        { field },
      )
    }
  }
  const scoped = await resolveScopedLedger(recordsApi, provisioning, targetProjectId, ['queryRecords', 'patchRecord'])
  const matches = await scoped.queryRecords({ filters: { decisionId: id }, limit: 2, offset: 0 })
  if (!Array.isArray(matches)) {
    throw new StockPreparationConfirmationDecisionError(500, 'CONFIRMATION_DECISION_RECORDS_API_INVALID', 'queryRecords must return an array')
  }
  if (matches.length !== 1) {
    throw new StockPreparationConfirmationDecisionError(
      matches.length === 0 ? 404 : 409,
      matches.length === 0 ? 'CONFIRMATION_DECISION_NOT_FOUND' : 'CONFIRMATION_DECISION_DUPLICATE',
      'decisionId must resolve to exactly one decision row',
    )
  }
  const record = matches[0]
  if (optionalString(readCell(record, 'status')) !== STATUSES.PENDING) {
    throw new StockPreparationConfirmationDecisionError(
      409,
      'CONFIRMATION_DECISION_NOT_PENDING',
      'only a pending decision can be confirmed',
    )
  }
  if (optionalString(readCell(record, 'inputFingerprint')) !== fingerprint) {
    throw new StockPreparationConfirmationDecisionError(
      409,
      'CONFIRMATION_DECISION_REVISION_MISMATCH',
      'decision input fingerprint no longer matches',
    )
  }
  const conflictType = optionalString(readCell(record, 'conflictType'))
  if (conflictType !== FIRST_CUT_CONFLICT_TYPE) {
    throw new StockPreparationConfirmationDecisionError(
      409,
      'CONFIRMATION_DECISION_ACTION_CONFLICT_MISMATCH',
      'resolutionAction is not valid for this conflict type',
    )
  }
  const confirmedAt = normalizeIsoTime(undefined, 'confirmedAt', typeof now === 'function' ? now : () => new Date())
  const changes = {
    status: STATUSES.CONFIRMED,
    resolutionAction: action,
    confirmedBy: actor,
    confirmedAt,
  }
  const normalizedNotes = optionalString(notes)
  if (normalizedNotes) changes.notes = normalizedNotes
  await scoped.patchRecord({ recordId: record.id, changes })
  return {
    ok: true,
    mode: 'confirmation_decision_confirmed',
    decisionId: id,
    status: STATUSES.CONFIRMED,
    resolutionAction: action,
    evidence: {
      objectId: OBJECT_ID,
      confirmed: 1,
      actorPresent: true,
      confirmedAtPresent: true,
      notesPresent: Boolean(normalizedNotes),
    },
  }
}

// Planner readback (read-only). Recomputes the first-cut candidates for the
// CURRENT plan+revision and emits a keep_multiple_rows table-scope policy for
// each duplicate group whose decision row is CONFIRMED with the SAME
// inputFingerprint and resolutionAction keep_multiple_rows. Every other case —
// pending, superseded, cancelled, stale fingerprint, other action — emits
// nothing, so the hold stands. Superseding a stale row is reconcile's job (the
// explicit write path); this function never writes anything.
async function loadConfirmedDuplicatePolicyReview({ recordsApi, provisioning, targetProjectId, permission, projectNo, plan, sourceRevision } = {}) {
  assertAdminPermission(permission)
  const { candidates } = deriveDecisionCandidates({ projectNo, plan, sourceRevision })
  if (!candidates.length) return { scope: 'table_scope', policies: [] }
  const scoped = await resolveScopedLedger(recordsApi, provisioning, targetProjectId, ['queryRecords'])
  const rows = await queryAll(scoped, { projectNo: requiredString(projectNo, 'projectNo'), status: STATUSES.CONFIRMED })
  const byDecisionId = new Map(rows.map((row) => [optionalString(readCell(row, 'decisionId')), row]).filter(([key]) => key))
  const policies = []
  for (const candidate of candidates) {
    const row = byDecisionId.get(candidate.decisionId)
    if (!row) continue
    if (optionalString(readCell(row, 'inputFingerprint')) !== candidate.inputFingerprint) continue
    if (optionalString(readCell(row, 'resolutionAction')) !== RESOLUTION_ACTIONS.KEEP_MULTIPLE_ROWS) continue
    policies.push({
      fingerprint: candidate.duplicateGroupFingerprint,
      policy: DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY,
      approvedAtPresent: true,
      approvedByPresent: true,
    })
  }
  return { scope: 'table_scope', policies }
}

module.exports = {
  OBJECT_ID,
  FIELD_IDS,
  FIRST_CUT_CONFLICT_TYPE,
  ANONYMOUS_HOLD_IDENTITY_DEFERRAL_CODE,
  STATUSES,
  RESOLUTION_ACTIONS,
  IMPLEMENTED_RESOLUTION_ACTIONS,
  CONCURRENCY_MODEL,
  RECONCILE_LEASE_TABLE,
  StockPreparationConfirmationDecisionError,
  createConfirmationDecisionReconcileLease,
  buildTargetDescriptor,
  inspectConfirmationDecisionTarget,
  ensureConfirmationDecisionTarget,
  deriveDecisionCandidates,
  reconcileConfirmationDecisions,
  listConfirmationDecisions,
  confirmConfirmationDecision,
  loadConfirmedDuplicatePolicyReview,
  __internals: {
    stableHash,
    stableStringify,
    recordData,
    readCell,
    queryAll,
    resolveScopedLedger,
    requireReconcileLease,
  },
}
