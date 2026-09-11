'use strict'

// #2253 C2: projectNo -> PLM BOM dry-run expansion helper.
// Runtime-safe but write-free: reads only through a data-source:sql-readonly-style
// source adapter using object + equality filters, expands the BOM app-side, and
// returns normalized logical stock-preparation rows. No route, UI, MetaSheet
// write, external DB write, raw SQL, stored procedure, or K3 path.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')
const {
  applyExtFieldMapping,
  isNormalizedExtFieldMapping,
} = require('./stock-preparation-ext-field-mapping.cjs')

const DEFAULT_PAGE_LIMIT = 1000
const DEFAULT_MAX_PAGES = 100
const DEFAULT_MAX_DEPTH = 20
const DEFAULT_MAX_ROWS = 10000
const LARGE_BOM_BOUNDED_ERROR_TYPES = Object.freeze([
  'max_rows_exceeded',
  'read_page_limit_exceeded',
  'read_count_exceeded',
  'read_time_limit_exceeded',
])
// A BROKEN CURSOR (HG v1.2 §9.1(3), "cursor 断裂"), which is NOT a scale bound.
//
// `readAll`'s page loop stops when the adapter reports `done` or offers no `nextCursor`. A page that
// says `done: false` and then supplies NOWHERE TO CONTINUE FROM is neither: the source stated the
// batch was unfinished and then declined to say how to finish it. Before this constant the loop
// simply broke out of the loop and returned what it had — a SILENTLY TRUNCATED batch that reached
// the planner as a complete one, with `canApply: true`.
//
// It is deliberately NOT in `LARGE_BOM_BOUNDED_ERROR_TYPES`: those four mean "this BOM is too big
// for the interactive path, take the background job", and routing a broken cursor there would tell
// an operator to retry a read that will truncate again. It is a failed read, and it says so.
const READ_CURSOR_BROKEN_ERROR_TYPE = 'read_cursor_broken'
const INCOMPLETE_READ_ERROR_TYPES = Object.freeze([
  ...LARGE_BOM_BOUNDED_ERROR_TYPES,
  READ_CURSOR_BROKEN_ERROR_TYPE,
])

// ---------------------------------------------------------------------------
// PROJECT-SUBTREE ROOT DISCOVERY — the OPTIONAL second root segment.
//
// The shipped plan reaches a project's top-level components through the ORDER MODULE
// (pathExAttr -> pathInfo -> orderHead -> orderDetail). A deployment whose projects carry their
// assemblies on the FOLDER TREE instead — BOM heads hanging off a project's directory nodes — has no
// order line to enter through, and the expansion returns zero rows and calls it a success.
//
// `readPlan.projectSubtree` is that second entry, and it is OPTIONAL AND ABSENT BY DEFAULT: the
// shipped `PLM_STOCK_PREPARATION_BOM_READ_PLAN` does not carry the block, so "off" is STRUCTURAL —
// the normalizer emits no key, the expander's second segment is one `if` that never runs, and the
// summary grows no counter. Nothing about the order path changes, in either state.
//
// THE THREE THINGS THAT MAKE IT SAFE (each has a test that fails if it is removed):
//
//   1. THE THREE READS THAT DECIDE WHICH PROJECT'S DATA THIS IS are re-filtered CLIENT-SIDE with
//      `matchesByField`: the pathExAttr ENTRY read (whose rows seed both root segments), the
//      pathInfo CHILD-NODE read, and the bomHead FIND-ROOTS read. `readAll` RECORDS `filtersApplied`
//      and never ENFORCES it, and `bridge:legacy-sql-readonly` may legally answer
//      `filtersApplied: false` (i.e. the whole table). Without the second filter one BFS step would
//      take every folder node in the catalog for a child of this project — and then read other
//      projects' BOM heads under this project's authorization. `visited` and `maxSubtreeDepth` do
//      not help there: the breach happens on the first read, at depth 1, on nodes seen once each.
//
//      NOT re-filtered, and stated plainly rather than glossed: the two reads `expandChildren`
//      issues per row (bomHead by part+version, bomDetail by bom id). Those are the ORDER path's
//      own reads — both root segments call the same function — so their exposure to a lying source
//      is pre-existing and shared, not something root discovery introduces. Closing it is a change
//      to the order path with its own regressions, deferred to W4; the test file's "WHAT IS NOT
//      PINNED" note says the same thing at the same altitude.
//   2. DE-DUPLICATION COVERS EVERY EXPANDED COMPONENT, not just roots. `makeIdempotencyKey` eats
//      {projectNo, componentSourceId, parentSourceId, path}; a part that is already an order root's
//      CHILD and is then re-rooted by the subtree produces a DIFFERENT key, so the conflict planner
//      cannot group them and the whole sub-assembly lands twice with two different totals. So the
//      registry holds every componentSourceId this run has expanded, roots and children alike, and a
//      subtree root that is already in it is skipped and counted. Two BOM heads on one `part_id` (a
//      measured customer shape) collapse to ONE root for the same reason.
//   3. THE READ BUDGET REALLY EXISTS. `maxReadCount`/`maxElapsedMs` are OPTIONAL on the expansion
//      and unset on the measured deployment, and `maxPages` counts pages WITHIN one `readAll`, not
//      reads overall — so "the subtree reuses the existing budget" would have been a budget of
//      nothing. Enabling the block therefore REQUIRES the plan to carry `maxReadCount`, and the
//      three structural bounds below are hard CEILINGS the normalizer refuses to exceed rather than
//      advisory defaults.
//
// The three overrun/loop conditions are GLOBAL errors, never rowErrors: the conflict planner's
// `missingFromPlmPolicy` is pinned to `mark_inactive`, so a HALF-DISCOVERED root set that "succeeds"
// would mark the missing half of last pull's rows invalid. A global error means status `failed` and
// `canApply: false`, which is the only safe posture for a truncated traversal.
// ---------------------------------------------------------------------------
const SUBTREE_CYCLE_DETECTED_ERROR_TYPE = 'subtree_cycle_detected'
const SUBTREE_NODE_LIMIT_EXCEEDED_ERROR_TYPE = 'subtree_node_limit_exceeded'
const SUBTREE_ROOT_LIMIT_EXCEEDED_ERROR_TYPE = 'subtree_root_limit_exceeded'
// Deliberately NOT part of `LARGE_BOM_BOUNDED_ERROR_TYPES`, for the same reason
// `READ_CURSOR_BROKEN_ERROR_TYPE` is not: those four mean "this BOM is too big for the interactive
// path, take the background job". A folder traversal that hit its own structural ceiling will hit
// the identical ceiling on the retry, so routing it there tells an operator to re-run a read that
// cannot end differently.
const PROJECT_SUBTREE_ERROR_TYPES = Object.freeze([
  SUBTREE_CYCLE_DETECTED_ERROR_TYPE,
  SUBTREE_NODE_LIMIT_EXCEEDED_ERROR_TYPE,
  SUBTREE_ROOT_LIMIT_EXCEEDED_ERROR_TYPE,
])

// Structural bounds on the folder traversal. `DEFAULT_*` is what an enabling plan gets when it says
// nothing; `MAX_*` is a CEILING the normalizer refuses to exceed, so a deployment cannot configure
// `maxSubtreeNodes: 100000` and call it a bound. `maxSubtreeDepth` counts FOLDER levels and has
// nothing to do with `maxDepth`, which counts BOM levels.
const DEFAULT_MAX_SUBTREE_DEPTH = 1
const MAX_SUBTREE_DEPTH_CEILING = 4
const DEFAULT_MAX_SUBTREE_NODES = 200
const MAX_SUBTREE_NODES_CEILING = 2000
const DEFAULT_MAX_SUBTREE_ROOTS = 200
const MAX_SUBTREE_ROOTS_CEILING = 500
const PROJECT_SUBTREE_LIMITS = Object.freeze({
  DEFAULT_MAX_SUBTREE_DEPTH,
  MAX_SUBTREE_DEPTH_CEILING,
  DEFAULT_MAX_SUBTREE_NODES,
  MAX_SUBTREE_NODES_CEILING,
  DEFAULT_MAX_SUBTREE_ROOTS,
  MAX_SUBTREE_ROOTS_CEILING,
})
// The quantity a subtree root carries. A folder-discovered root has NO order line, so there is no
// measured quantity to read — and `parseQuantity`'s hold-not-zero rule refuses an absent one rather
// than letting it become a real 0 that multiplies down. 1 is the declared neutral multiplier, and
// the summary counts how many roots took it (`rootQuantitySource.subtreeDefault`) against how many
// came from an order line, so "these rows carry a defaulted quantity" is visible in evidence instead
// of being indistinguishable from a measured 1.
const SUBTREE_ROOT_DEFAULT_QUANTITY = 1
const STOCK_PREPARATION_BOM_SOURCE_KINDS = Object.freeze([
  'data-source:sql-readonly',
  'bridge:legacy-sql-readonly',
])

// W3a — THE ONE VALUE-BEARING SIDE CHANNEL THIS MODULE PRODUCES, and the cap on it.
//
// A `missing_component` rowError says "a part the BOM points at is not in the part library". That
// blocks the WHOLE project (one such rowError makes the plan invalid, and apply refuses without an
// explicit manual-confirm hold), so an operator cannot act on it without knowing WHICH part numbers
// to create. The part number is a real customer value, and the rowError payload is emphatically NOT
// where it may travel: `expansion.rowErrors` is hashed whole into the dry-run revision
// (stock-preparation-table-actions.cjs buildRevision) and feeds the anonymous-hold identity and the
// confirmation ledger. Adding a key there would move every stored revision, supersede every pending
// hold on a project that has a missing component, and put a part number in the ledger.
//
// So the detail travels BESIDE the rowErrors, in its own top-level array, and `rowErrors` keeps the
// exact `{type, field, depth}` shape it has always had. `expansion.missingComponents` is projected
// by NOTHING that hashes, stores or evidences — it is read only by `summarizeMissingComponents`
// below, for the dry-run response's opt-in `missingComponents` key (gated operate ∧ proven tenant).
//
// THE CAP IS ON DISTINCT PART NUMBERS, NOT ON PROBES, and that distinction is the whole guard.
//
// A 10k-row BOM against an empty part library must not accumulate 10k detail objects on a read whose
// contract is that it is bounded — hence a cap. But an earlier cut capped the number of PROBES, and
// that was a correctness bug, not merely a smaller list: a BOM with 199 positions wanting part A and
// then 300 positions wanting part B produced `[A:199, B:1]`, and one more A position made B vanish
// from the list entirely. The operator would then create every part the list named, re-run, and find
// the project still held — by a part the list had silently dropped. Worse, the ordering ("create the
// most-blocking part first") inverted in exactly the case it exists for.
//
// So the collector is KEYED BY PART NUMBER: at most 200 distinct part numbers carry detail, and a
// part number already retained keeps accumulating its occurrence and parent counts however many
// times it is probed. `missingComponentDistinctCount` counts EVERY distinct part number — including
// the ones past the cap that carry no detail — so the summary's `distinctCount` is a true total and
// `truncated` can say honestly that the list is not the whole set.
const MISSING_COMPONENT_DETAIL_LIMIT = 200

// D-C — THE CAP ON `rowErrors`, and why the overflow is a HASHED FACT rather than a silent drop.
//
// `rowErrors` had no bound at all. One bad project — an empty part library, a BOM whose quantity
// column is prose, a mapping whose coercion refuses every cell — produces one entry per BOM
// POSITION, so a 40k-position project produced 40k entries. That array is not a local: it is
// returned in the dry-run response, hashed WHOLE into the dry-run revision
// (stock-preparation-table-actions.cjs `buildRevision`), and handed to the conflict planner, which
// emits one `manualConfirm` decision — with its own anonymous-hold identity — per entry. So the
// unbounded array became an unbounded response, an unbounded plan and an unbounded ledger.
//
// THE CAP IS ON RETAINED ENTRIES, NOT ON THE COUNTS. Past the limit `addRowError` stops appending
// but keeps counting, so `rowErrorsTotal` and the per-type totals in `rowErrorTypeCounts` are TRUE
// TOTALS and `summary.errorTypes` still names a type whose every occurrence was dropped. An
// operator reading a truncated expansion learns the real size of the problem; what they lose is the
// per-position enumeration of a project that was never actionable position-by-position anyway.
//
// BYTE-IDENTITY BELOW THE CAP IS THE OTHER HALF OF THE CONTRACT. The three summary keys and the
// revision's projection of them are mounted CONDITIONALLY, exactly like `subtree`: a project with
// 4999 rowErrors gets the same array, the same summary key set, the same evidence and the same
// revision hash it got before this change. Only a project that actually overflowed moves — and it
// must move, because otherwise two different overflowing projects sharing their first 5000 entries
// would hash the same and one's dry-run token would apply the other's plan.
//
// The ceiling exists so `rowErrorLimit` in a deploy config cannot un-bound the array by writing a
// big number: configuration may lower the cap or raise it within reach of the ceiling, never past.
const ROW_ERROR_LIMIT = 5000
const ROW_ERROR_LIMIT_CEILING = 20000

const FORBIDDEN_PLAN_KEYS = Object.freeze([
  'sql',
  'rawSql',
  'query',
  'where',
  'join',
  'joins',
  'cte',
  'recursiveCte',
  'storedProcedure',
  'vendorApi',
  'rows',
  'records',
  'data',
  'values',
  'payload',
])

class StockPreparationBomExpansionError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationBomExpansionError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : value
}

function toKey(value) {
  if (isBlank(value)) return null
  return String(trimString(value))
}

function isSecretShaped(value) {
  return typeof value === 'string' && scrubSecretStringValue(value) !== value
}

function assertNoForbiddenPlanKeys(value, path = 'readPlan') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenPlanKeys(item, `${path}[${index}]`))
    return
  }
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PLAN_KEYS.includes(key)) {
      throw new StockPreparationBomExpansionError(`${path} must not carry ${key}`, { field: `${path}.${key}` })
    }
    assertNoForbiddenPlanKeys(value[key], `${path}.${key}`)
  }
}

function requiredObject(input, field) {
  if (!isPlainObject(input)) {
    throw new StockPreparationBomExpansionError(`${field} must be an object`, { field })
  }
  return input
}

function optionalObject(input, field) {
  if (input === undefined || input === null) return {}
  return requiredObject(input, field)
}

function requiredString(input, field, { fieldName = false, identifier = true } = {}) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new StockPreparationBomExpansionError(`${field} is required`, { field })
  }
  const value = input.trim()
  if (isSecretShaped(value)) {
    throw new StockPreparationBomExpansionError(`${field} must not be secret-shaped`, { field })
  }
  if (identifier) {
    const pattern = fieldName ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z_][A-Za-z0-9_.]*$/
    if (!pattern.test(value)) {
      throw new StockPreparationBomExpansionError(`${field} must be a safe identifier`, { field, value })
    }
  }
  return value
}

function optionalString(input, field, opts = {}) {
  if (input === undefined || input === null || input === '') return undefined
  return requiredString(input, field, opts)
}

function positiveInteger(input, field, defaultValue) {
  if (input === undefined || input === null || input === '') return defaultValue
  const value = Number(input)
  if (!Number.isInteger(value) || value <= 0) {
    throw new StockPreparationBomExpansionError(`${field} must be a positive integer`, { field, value: input })
  }
  return value
}

function optionalPositiveInteger(input, field) {
  if (input === undefined || input === null || input === '') return undefined
  return positiveInteger(input, field, undefined)
}

// A positive integer with a CEILING the configuration cannot argue with. `positiveInteger` alone
// accepts any integer, which is how "recommended maximum 4" ends up as a comment while a plan
// carries 100000. Over the ceiling is a refusal at normalization time, before a single read.
//
// It is also stricter about the TYPE than `positiveInteger`, which coerces with `Number()` and so
// accepts `true` (-> 1) and `[3]` (-> 3). These three values are read budgets: the difference
// between "the operator wrote 3" and "the operator wrote something that happens to coerce to 3" is
// exactly the difference this module refuses to paper over elsewhere. The plan arrives as JSON, so
// a real number is always expressible and nothing legitimate is lost.
function ceilingBoundedPositiveInteger(input, field, defaultValue, ceiling) {
  if (input !== undefined && input !== null && input !== '' && !Number.isInteger(input)) {
    throw new StockPreparationBomExpansionError(`${field} must be a positive integer`, { field, value: input })
  }
  const value = positiveInteger(input, field, defaultValue)
  if (value > ceiling) {
    throw new StockPreparationBomExpansionError(`${field} must not exceed ${ceiling}`, {
      field,
      value,
      ceiling,
    })
  }
  return value
}

// Same no-coercion rule as `ceilingBoundedPositiveInteger`, for a value that has no ceiling but is
// just as load-bearing: `readPlan.maxReadCount` is the budget `projectSubtree` is REFUSED without.
// A key the normalizer insists on should not then accept `true` (-> 1) or `['200']` (-> 200) as if
// someone had chosen it. Absent stays absent — this is only about what a PRESENT value may be.
function strictOptionalPositiveInteger(input, field) {
  if (input === undefined || input === null || input === '') return undefined
  if (!Number.isInteger(input)) {
    throw new StockPreparationBomExpansionError(`${field} must be a positive integer`, { field, value: input })
  }
  return positiveInteger(input, field, undefined)
}

function optionalBoolean(input, field, defaultValue) {
  if (input === undefined || input === null || input === '') return defaultValue
  if (typeof input !== 'boolean') {
    throw new StockPreparationBomExpansionError(`${field} must be a boolean`, { field, value: input })
  }
  return input
}

function nonNegativeInteger(input, field, defaultValue) {
  if (input === undefined || input === null || input === '') return defaultValue
  const value = Number(input)
  if (!Number.isInteger(value) || value < 0) {
    throw new StockPreparationBomExpansionError(`${field} must be a non-negative integer`, { field, value: input })
  }
  return value
}

function normalizeObjectFields(input, field, requiredFields, optionalFields = []) {
  const value = requiredObject(input, field)
  const out = {}
  for (const key of requiredFields) {
    out[key] = requiredString(value[key], `${field}.${key}`, { fieldName: key !== 'object' })
  }
  for (const key of optionalFields) {
    const normalized = optionalString(value[key], `${field}.${key}`, { fieldName: key !== 'object' })
    if (normalized !== undefined) out[key] = normalized
  }
  return out
}

const PLM_STOCK_PREPARATION_BOM_READ_PLAN = Object.freeze({
  id: 'plm.stock-preparation.bom-read.dn-pdm.v1',
  sourceKind: 'data-source:sql-readonly',
  matchField: 'FileCode',
  pathExAttr: {
    object: 'DN_PDM_PathExAttrInfo',
    matchField: 'FileCode',
    pathIdField: 'Parent_OBJ_ID',
  },
  pathInfo: {
    object: 'DN_PDM_PathInfo',
    idField: 'OBJ_ID',
  },
  orderHead: {
    object: 'DN_PDM_OrderHeadInfo',
    idField: 'OBJ_ID',
    pathIdField: 'path_id',
  },
  orderDetail: {
    object: 'DN_PDM_OrderDetailInfo',
    orderIdField: 'order_id',
    componentIdField: 'part_id',
    quantityField: 'quantity',
    sortField: 'sort_id',
  },
  part: {
    object: 'DN_PDM_PartLibraryInfo',
    idField: 'OBJ_ID',
    codeField: 'IdentityNo',
    nameField: 'IdentityName',
    materialField: 'Material',
    versionField: 'SysVer',
    // specField / createTimeField are DECLARED-BUT-UNDEFAULTED on purpose.
    //
    // 规格 and the material creation time are NOT part of this family's core part roles
    // (source-vendor-presets/dn-pdm-family.preset.json coreTables.part.roles declares exactly
    // rowId/id/code/name/material/version). Where they live is a PER-DEPLOYMENT reading: on the
    // measured customer catalog they surface as native view columns (`Specification`, `Createtime`
    // on DN_PartLibrary_View — docs/development/takeover-beiliao-20260821/onsite-connection-test-
    // runbook-20260901.md §0/§4), while on a stock DN_PDM catalog 规格 is a dictionary-assigned
    // `partExAttr` slot (preset semanticExpectations `part-spec`). Pinning either here would encode
    // ONE customer's dictionary row — the same refusal the preset applies to bomDetail quantity.
    //
    // So the plan DECLARES the two roles and defaults them to ABSENT. Undeclared => the expansion
    // row simply carries no `spec` / `createTime` key (graceful absence), never a guessed column.
  },
  bomHead: {
    object: 'DN_PDM_BomHeadInfo',
    parentPartField: 'part_id',
    bomIdField: 'bom_id',
    versionField: 'SysVer',
    activeField: 'bom_able',
  },
  bomDetail: {
    object: 'DN_PDM_BomDetailsInfo',
    bomParentField: 'bom_pid',
    componentIdField: 'part_id',
    quantityField: 'Bom_ExAttr1',
    sortField: 'sort_id',
  },
})

function normalizeStockPreparationBomReadPlan(input = PLM_STOCK_PREPARATION_BOM_READ_PLAN) {
  const source = input || PLM_STOCK_PREPARATION_BOM_READ_PLAN
  assertNoForbiddenPlanKeys(source)
  const plan = requiredObject(source, 'readPlan')
  const sourceKind = requiredString(plan.sourceKind || 'data-source:sql-readonly', 'readPlan.sourceKind', { identifier: false })
  if (!STOCK_PREPARATION_BOM_SOURCE_KINDS.includes(sourceKind)) {
    throw new StockPreparationBomExpansionError('readPlan.sourceKind must be data-source:sql-readonly or bridge:legacy-sql-readonly', {
      field: 'readPlan.sourceKind',
      value: sourceKind,
    })
  }
  const out = {
    id: optionalString(plan.id, 'readPlan.id', { identifier: false }) || PLM_STOCK_PREPARATION_BOM_READ_PLAN.id,
    sourceKind,
    matchField: requiredString(plan.matchField || 'FileCode', 'readPlan.matchField', { fieldName: true }),
    pathExAttr: normalizeObjectFields(plan.pathExAttr, 'readPlan.pathExAttr', ['object', 'matchField', 'pathIdField']),
    pathInfo: normalizeObjectFields(plan.pathInfo, 'readPlan.pathInfo', ['object', 'idField']),
    orderHead: normalizeObjectFields(plan.orderHead, 'readPlan.orderHead', ['object', 'idField', 'pathIdField']),
    orderDetail: normalizeObjectFields(plan.orderDetail, 'readPlan.orderDetail', ['object', 'orderIdField', 'componentIdField', 'quantityField'], ['sortField']),
    part: normalizeObjectFields(plan.part, 'readPlan.part', ['object', 'idField'], ['codeField', 'nameField', 'materialField', 'versionField', 'specField', 'createTimeField']),
    bomHead: normalizeObjectFields(plan.bomHead, 'readPlan.bomHead', ['object', 'parentPartField', 'bomIdField'], ['versionField', 'activeField']),
    bomDetail: normalizeObjectFields(plan.bomDetail, 'readPlan.bomDetail', ['object', 'bomParentField', 'componentIdField', 'quantityField'], ['sortField']),
  }
  // The DECLARED 备料 batch rule. The expansion itself never reads this — batch identity is minted
  // upstream of it (stock-preparation-batch-identity.cjs) — but the read plan is the deployment's
  // one configuration surface, so the declaration must SURVIVE normalization instead of being
  // silently dropped here. Absent stays absent; a present value is carried through verbatim and
  // validated by the minting module, which refuses an unknown mode rather than defaulting on a typo.
  if (isPlainObject(plan.batchIdentity)) {
    const mode = optionalString(plan.batchIdentity.mode, 'readPlan.batchIdentity.mode', { identifier: false })
    if (mode !== undefined) out.batchIdentity = { mode }
  }
  // The plan-level READ BUDGET. Optional, and ABSENT STAYS ABSENT — an existing plan normalizes to
  // the same object it always did. It exists because `maxReadCount` was reachable only as a
  // per-invocation input that the measured deployment never set, which made "the subtree reuses the
  // existing budget" a statement about a budget of nothing (see the projectSubtree banner).
  const planMaxReadCount = strictOptionalPositiveInteger(plan.maxReadCount, 'readPlan.maxReadCount')
  if (planMaxReadCount !== undefined) out.maxReadCount = planMaxReadCount

  // THE OPTIONAL PROJECT-SUBTREE BLOCK. Absent (the shipped default) => NO KEY AT ALL, so every
  // consumer of a normalized plan sees byte-for-byte what it saw before this feature existed.
  // `assertNoForbiddenPlanKeys` above already walked the raw block, so sql/where/join inside it are
  // refused exactly as they are anywhere else in the plan.
  if (plan.projectSubtree !== undefined && plan.projectSubtree !== null) {
    const block = requiredObject(plan.projectSubtree, 'readPlan.projectSubtree')
    out.projectSubtree = {
      // The folder tree's self-reference: PathInfo rows point at their parent node. Read with
      // `{ [parentIdField]: nodeId }` and then RE-FILTERED client-side, because a source may answer
      // a filtered read with the whole table.
      pathInfo: normalizeObjectFields(block.pathInfo, 'readPlan.projectSubtree.pathInfo', ['parentIdField']),
      // The BOM head's folder-node column: which directory node a head hangs off. Same re-filter.
      bomHead: normalizeObjectFields(block.bomHead, 'readPlan.projectSubtree.bomHead', ['pathIdField']),
      maxSubtreeDepth: ceilingBoundedPositiveInteger(
        block.maxSubtreeDepth, 'readPlan.projectSubtree.maxSubtreeDepth',
        DEFAULT_MAX_SUBTREE_DEPTH, MAX_SUBTREE_DEPTH_CEILING,
      ),
      maxSubtreeNodes: ceilingBoundedPositiveInteger(
        block.maxSubtreeNodes, 'readPlan.projectSubtree.maxSubtreeNodes',
        DEFAULT_MAX_SUBTREE_NODES, MAX_SUBTREE_NODES_CEILING,
      ),
      maxSubtreeRoots: ceilingBoundedPositiveInteger(
        block.maxSubtreeRoots, 'readPlan.projectSubtree.maxSubtreeRoots',
        DEFAULT_MAX_SUBTREE_ROOTS, MAX_SUBTREE_ROOTS_CEILING,
      ),
      // The project node itself is queried for heads too. One extra read, and on the measured
      // catalog the difference between "the project's own heads" and "no roots at all".
      includeSelf: optionalBoolean(block.includeSelf, 'readPlan.projectSubtree.includeSelf', true),
    }
    // MANDATORY READ BUDGET (see (3) in the projectSubtree banner). Refused HERE rather than
    // defaulted, because a default read ceiling picked by this module would be a number nobody
    // measured, and the deployments that need the subtree are exactly the ones whose read
    // amplification has to be a deliberate, reviewed figure.
    if (out.maxReadCount === undefined) {
      throw new StockPreparationBomExpansionError(
        'readPlan.maxReadCount is required when readPlan.projectSubtree is enabled',
        { field: 'readPlan.maxReadCount', reason: 'PROJECT_SUBTREE_REQUIRES_READ_BUDGET' },
      )
    }
  }
  if (out.matchField !== out.pathExAttr.matchField) {
    throw new StockPreparationBomExpansionError('readPlan.matchField must match readPlan.pathExAttr.matchField', {
      field: 'readPlan.matchField',
    })
  }
  return out
}

function requireSourceAdapter(adapter) {
  if (!adapter || typeof adapter.read !== 'function') {
    throw new StockPreparationBomExpansionError('C2 BOM expansion requires a source adapter with read()', {
      field: 'sourceAdapter',
    })
  }
  return adapter
}

function normalizeFilters(filters) {
  const out = {}
  for (const [key, value] of Object.entries(filters || {})) {
    const normalizedKey = requiredString(key, `filters.${key}`, { fieldName: true })
    if (value === undefined || value === null || value === '') continue
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new StockPreparationBomExpansionError('filters support equality primitives only', {
        field: `filters.${normalizedKey}`,
      })
    }
    out[normalizedKey] = value
  }
  if (Object.keys(out).length === 0) {
    throw new StockPreparationBomExpansionError('read filters must not be empty', { field: 'filters' })
  }
  return out
}

function isLargeBomBoundedErrorType(type) {
  return LARGE_BOM_BOUNDED_ERROR_TYPES.includes(type)
}

// Recognizes every INCOMPLETE-READ type, not only the four scale bounds, so a broken cursor keeps
// its structural code instead of collapsing into `read_failed` with a driver message. What counts as
// "large BOM, use the background job" is still decided by `isLargeBomBoundedExpansion`, which asks
// the narrower `isLargeBomBoundedErrorType` — so this widening does not reroute a single expansion.
function isReadLimitError(error) {
  return Boolean(
    error &&
    error.name === 'StockPreparationBomExpansionError' &&
    error.details &&
    INCOMPLETE_READ_ERROR_TYPES.includes(error.details.code),
  )
}

function readLimitErrorDetails(error, fallbackObject) {
  if (!isReadLimitError(error)) return null
  const details = error.details || {}
  const { code, ...rest } = details
  return {
    type: code,
    ...(fallbackObject && !rest.object ? { object: fallbackObject } : {}),
    ...rest,
  }
}

function assertReadBudget(options, readStats, object) {
  if (options.maxReadCount !== undefined && readStats.length >= options.maxReadCount) {
    throw new StockPreparationBomExpansionError('PLM read exceeded maxReadCount', {
      code: 'read_count_exceeded',
      object,
      maxReadCount: options.maxReadCount,
    })
  }
  if (options.maxElapsedMs !== undefined && options.now() - options.startedAtMs > options.maxElapsedMs) {
    throw new StockPreparationBomExpansionError('PLM read exceeded maxElapsedMs', {
      code: 'read_time_limit_exceeded',
      object,
      maxElapsedMs: options.maxElapsedMs,
    })
  }
}

async function readAll(adapter, object, filters, options, readStats) {
  const normalizedFilters = normalizeFilters(filters)
  const rows = []
  let cursor
  for (let page = 0; ; page += 1) {
    if (page >= options.maxPages) {
      throw new StockPreparationBomExpansionError('PLM read exceeded maxPages', {
        code: 'read_page_limit_exceeded',
        object,
        maxPages: options.maxPages,
      })
    }
    assertReadBudget(options, readStats, object)
    const input = { object, filters: normalizedFilters, limit: options.pageLimit }
    if (cursor) input.cursor = cursor
    const stat = {
      object,
      filterFields: Object.keys(normalizedFilters).sort(),
      cursor: cursor || null,
      status: 'attempted',
      filtersSent: true,
    }
    readStats.push(stat)
    let result
    try {
      result = await adapter.read(input)
      stat.status = 'ok'
    } catch (error) {
      stat.status = 'failed'
      stat.errorCode = safeErrorCode(error)
      throw error
    }
    if (isPlainObject(result) && isPlainObject(result.metadata)) {
      stat.source = typeof result.metadata.source === 'string' ? result.metadata.source : undefined
      stat.filtersApplied = result.metadata.filtersApplied
      if (Array.isArray(result.metadata.filterFields)) stat.filterFields = result.metadata.filterFields.slice().sort()
    }
    const records = isPlainObject(result) && Array.isArray(result.records) ? result.records : []
    stat.count = records.length
    for (const record of records) {
      if (isPlainObject(record)) rows.push(record)
    }
    // COMPLETE-BATCH CHECK, opt-in. `done === false` with no `nextCursor` is the source saying the
    // batch is unfinished and refusing to say where to resume — §9.1's 断游标. Gated on
    // `requireCompleteBatch` so an unarmed deployment keeps the exact loop it had: the common fixture
    // shape `{ records: [...] }` leaves `done` UNDEFINED and must keep terminating normally, which is
    // why the test is `=== false` and not falsy.
    if (options.requireCompleteBatch === true
      && isPlainObject(result) && result.done === false && !result.nextCursor) {
      throw new StockPreparationBomExpansionError('PLM read stopped on a broken cursor', {
        code: READ_CURSOR_BROKEN_ERROR_TYPE,
        object,
        page,
      })
    }
    if (!isPlainObject(result) || result.done === true || !result.nextCursor) break
    cursor = result.nextCursor
  }
  return rows
}

function readField(row, field) {
  if (!isPlainObject(row) || field === undefined) return undefined
  if (Object.prototype.hasOwnProperty.call(row, field)) return row[field]
  if (typeof field !== 'string' || field.trim() === '') return undefined
  const normalized = field.toLowerCase()
  const matchingKeys = Object.keys(row).filter((key) => key.toLowerCase() === normalized)
  if (matchingKeys.length !== 1) return undefined
  return row[matchingKeys[0]]
}

function matchesByField(rows, field, value) {
  const key = toKey(value)
  if (key === null) return []
  return rows.filter((row) => toKey(readField(row, field)) === key)
}

function parseQuantity(value, context) {
  // Hold-not-zero: a SQL NULL or blank/whitespace-only string is an ABSENT
  // quantity, not a measured one — Number(null) === 0 and Number('') === 0
  // are both finite, so without this guard an absent source quantity would
  // silently become a real 0 and multiply down as 0 through every descendant
  // (see totalQuantity below). Force it through the same invalid_quantity
  // path a garbled ('not-a-number') value already takes instead. A STATED
  // numeric 0 (isBlank(0) is false) is a real measured zero and stays valid.
  const numeric = isBlank(value) ? NaN : Number(value)
  if (!Number.isFinite(numeric)) {
    return {
      ok: false,
      error: {
        type: 'invalid_quantity',
        field: context.field,
        depth: context.depth,
        relation: context.relation,
      },
    }
  }
  return { ok: true, value: numeric }
}

function isActiveBomHead(row, activeField) {
  if (!activeField) return true
  const value = readField(row, activeField)
  if (value === undefined || value === null || value === '') return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['0', 'false', 'n', 'no', 'disabled', 'inactive'].includes(normalized)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// F1c — 老系统(StockInfoController.java)的三条 BOM 语义,照抄到这条管线上。
//
// 老系统是客户今天在用的备料系统,owner 裁决「阅读 StockInfoController.java,采用该逻辑」。
// 三条语义各自的老系统出处(行号为客户交付的只读源码副本):
//
//   1. 根选择 `doGetAllBomInfo` 1046-1095 —— 订单 BOM 行里若有 `J…-00` 总图,就只拿
//      sysVer 最高的那一张总图 + 所有 `J…-A`/`J…-B` 钣金件当根;一张总图都没有时全部订单行
//      当根,但把「按图号 dash 分段判定为别人子级」的行剔除(`checkHierarchyRelationship`
//      413-450)。
//   2. 同父去重 `iterHandle` 669-700 —— 同一父件之下,key =
//      父组件图号 + 当前组件图号 + 名称及规格 + 材质,首条胜出。老系统的注释写明了为什么要带
//      名称和材质:标准件图号一样,只按图号去重会把不同的标准件合并掉。
//   3. 名称/规格切分 `fillBasicStockInfo` 762-770 —— identityName 按**第一个空格**切两段,
//      前段是名称、后段是规格;切不开则名称=全串、规格空。
//
// 全部是 PURE 函数,没有 IO,便于单独测。规则常量默认按老系统,但由 `rootSelection` 配置块可
// 覆盖(见 normalizeRootSelection):图号前后缀是一家工厂的编码约定,写死在代码里就成了一家客户
// 的字典。
// ---------------------------------------------------------------------------
const DEFAULT_ROOT_SELECTION = Object.freeze({
  enabled: true,
  mainDrawingPrefix: 'J',
  mainDrawingSuffix: '-00',
  sheetMetalSuffixes: Object.freeze(['-A', '-B']),
  dropDashDescendants: true,
})

function optionalStringList(input, field) {
  if (input === undefined || input === null) return undefined
  if (!Array.isArray(input)) {
    throw new StockPreparationBomExpansionError(`${field} must be an array of strings`, { field })
  }
  return input.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new StockPreparationBomExpansionError(`${field}[${index}] must be a non-empty string`, { field: `${field}[${index}]` })
    }
    return entry.trim()
  })
}

// A PREFIX may legitimately be '' ("no prefix rule on this deployment"); a SUFFIX may not, because
// an empty suffix makes `endsWith` true for every code and silently turns every order line into a
// 总图. Absent (`undefined`) keeps the老系统 default; an explicit '' for the suffix is a refusal.
function optionalRuleToken(input, field, { allowEmpty = false } = {}) {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'string') {
    throw new StockPreparationBomExpansionError(`${field} must be a string`, { field })
  }
  const trimmed = input.trim()
  if (trimmed === '' && !allowEmpty) {
    throw new StockPreparationBomExpansionError(`${field} must not be empty`, { field })
  }
  return trimmed
}

function normalizeRootSelection(input) {
  if (input === undefined || input === null) return DEFAULT_ROOT_SELECTION
  if (!isPlainObject(input)) {
    throw new StockPreparationBomExpansionError('rootSelection must be an object', { field: 'rootSelection' })
  }
  const prefix = optionalRuleToken(input.mainDrawingPrefix, 'rootSelection.mainDrawingPrefix', { allowEmpty: true })
  const suffix = optionalRuleToken(input.mainDrawingSuffix, 'rootSelection.mainDrawingSuffix')
  const sheetMetal = optionalStringList(input.sheetMetalSuffixes, 'rootSelection.sheetMetalSuffixes')
  return Object.freeze({
    enabled: optionalBoolean(input.enabled, 'rootSelection.enabled', DEFAULT_ROOT_SELECTION.enabled),
    mainDrawingPrefix: prefix === undefined ? DEFAULT_ROOT_SELECTION.mainDrawingPrefix : prefix,
    mainDrawingSuffix: suffix === undefined ? DEFAULT_ROOT_SELECTION.mainDrawingSuffix : suffix,
    sheetMetalSuffixes: Object.freeze(sheetMetal === undefined ? [...DEFAULT_ROOT_SELECTION.sheetMetalSuffixes] : sheetMetal),
    dropDashDescendants: optionalBoolean(input.dropDashDescendants, 'rootSelection.dropDashDescendants', DEFAULT_ROOT_SELECTION.dropDashDescendants),
  })
}

function hasMainDrawingShape(code, rules) {
  const text = toKey(code)
  if (text === null) return false
  return text.startsWith(rules.mainDrawingPrefix) && text.endsWith(rules.mainDrawingSuffix)
}

function hasSheetMetalShape(code, rules) {
  const text = toKey(code)
  if (text === null) return false
  if (!text.startsWith(rules.mainDrawingPrefix)) return false
  return rules.sheetMetalSuffixes.some((suffix) => text.endsWith(suffix))
}

// 老系统 `Comparator.comparingInt(BomInfo::getSysVer)` 比的是 int。这条管线上的版本是读计划声明
// 的一列,到手是字符串('V1'/'2'/...),所以:两边都能取出数字就按数字比(老系统口径),否则退回
// 码点序 —— 绝不用 localeCompare(宿主 locale 会让同一批数据在 CI 和客户服务器上排出两种结果)。
function versionRank(value) {
  const text = toKey(value)
  if (text === null) return null
  const digits = text.replace(/[^0-9]/g, '')
  if (digits === '') return null
  const numeric = Number(digits)
  return Number.isFinite(numeric) ? numeric : null
}

function compareSourceVersion(left, right) {
  const leftRank = versionRank(left)
  const rightRank = versionRank(right)
  if (leftRank !== null && rightRank !== null) {
    if (leftRank === rightRank) return 0
    return leftRank < rightRank ? -1 : 1
  }
  const leftText = toKey(left) || ''
  const rightText = toKey(right) || ''
  if (leftText === rightText) return 0
  return leftText < rightText ? -1 : 1
}

// 老系统 `checkHierarchyRelationship` 413-450 的逐行等价物:
//   1  -> code1 是 code2 的父级;2 -> code2 是 code1 的父级;0 -> 无直接层级关系;-1 -> 图号不可判定。
// 老系统先用 `Utils.regx` 判图号格式合法(那条正则在客户的 Utils 里,没有随源码交付),这里退到
// 「非空才判定」:判不了就答 -1,而 -1 从不导致剔除 —— 判不出层级时保留行,而不是猜一个关系把行删掉。
function dashHierarchyRelationship(code1, code2) {
  const left = toKey(code1)
  const right = toKey(code2)
  if (left === null || right === null) return -1
  const leftParts = left.split('-')
  const rightParts = right.split('-')
  if (leftParts[0] !== rightParts[0]) return 0
  if (leftParts.length === rightParts.length) return 0
  const leftIsShorter = leftParts.length < rightParts.length
  const parent = leftIsShorter ? leftParts : rightParts
  const child = leftIsShorter ? rightParts : leftParts
  for (let index = 0; index < parent.length; index += 1) {
    if (parent[index] !== child[index]) return 0
  }
  return leftIsShorter ? 1 : 2
}

/**
 * 老系统 `doGetAllBomInfo` 1046-1095 的根选择,作用在**订单行候选**上。
 *
 * 入参是 `{ componentSourceId, componentCode, sourceVersion }` 形状的候选数组(候选顺序=读到的
 * 顺序),回 `{ selected, droppedCount }`。selected 保持候选的相对顺序:展示顺序由树序比较器决定
 * (orderRowsAsBomTree),这里只决定「谁是根」。
 *
 * 只会 **缩小** 根集合,永远不会造出一个新根 —— 被剔除的行不是被丢掉,它还会作为它父件的子级
 * 展开出来(那正是老系统剔除它的理由:它已经是别人的子级)。
 */
function selectOrderRootCandidates(candidates, rules) {
  if (!rules || rules.enabled !== true) return { selected: candidates.slice(), droppedCount: 0 }
  const mains = candidates.filter((candidate) => hasMainDrawingShape(candidate.componentCode, rules))
  if (mains.length === 0) {
    // 无总图:全部订单行当根,但互为 dash 层级关系的,把作为子级的那条剔除。
    if (rules.dropDashDescendants !== true) return { selected: candidates.slice(), droppedCount: 0 }
    const dropped = new Set()
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = 0; j < candidates.length; j += 1) {
        if (i === j) continue
        // 老系统按 pliObjId 跳过同一行(`Objects.equals(bomInfo.getPliObjId(), info.getPliObjId())`);
        // 这里的等价物是部件源 id。同一个部件出现两次的订单行不会互删。
        if (candidates[i].componentSourceId === candidates[j].componentSourceId) continue
        if (dashHierarchyRelationship(candidates[i].componentCode, candidates[j].componentCode) === 1) {
          dropped.add(j)
        }
      }
    }
    const selected = candidates.filter((_, index) => !dropped.has(index))
    return { selected, droppedCount: candidates.length - selected.length }
  }
  // 有总图:钣金件全要 + 总图只要版本最高的那一张(老系统 `Stream.max`,并列时取先到的那条)。
  let best = mains[0]
  for (const candidate of mains.slice(1)) {
    if (compareSourceVersion(candidate.sourceVersion, best.sourceVersion) > 0) best = candidate
  }
  const keep = new Set([best])
  for (const candidate of candidates) {
    if (hasSheetMetalShape(candidate.componentCode, rules)) keep.add(candidate)
  }
  const selected = candidates.filter((candidate) => keep.has(candidate))
  return { selected, droppedCount: candidates.length - selected.length }
}

/**
 * 老系统 `fillBasicStockInfo` 762-770:名称及规格按**第一个**空格切两段。
 * 切不开(无空格 / 非字符串)=> 名称是全串、规格 undefined。多个空格只切首个,后半段原样保留
 * (老系统 `split(" ", 2)` 就是这样,第二段带着它自己的前导空格)。
 */
function splitNameAndSpec(value) {
  if (typeof value !== 'string') return { componentName: value, spec: undefined }
  const index = value.indexOf(' ')
  if (index < 0) return { componentName: value, spec: undefined }
  return { componentName: value.slice(0, index), spec: value.slice(index + 1) }
}

/**
 * 老系统 `iterHandle` 686-693 的同父去重键:父组件图号 + 当前组件图号 + 名称及规格 + 材质,
 * **外加一项老系统没有的:本层用量**。
 *
 * 用 JSON 数组而不是老系统的字符串拼接:拼接会让 ('AB','C') 和 ('A','BC') 撞成同一个键。
 * 这个键 **只在展开层用**,不进幂等键 —— 幂等键 {projectNo, componentSourceId, parentSourceId,
 * pathTokens} 一个字符都没动(dry-run revision / hold / 确认账本全挂在它上面)。
 *
 * 为什么多一项用量(这是对老系统的一处**有意偏离**,写进 PR 正文):
 * 老系统那四样一致就合并,首条胜出 —— 同一父件下两条明细指着同一个零件、用量却一个 1 一个 2 时,
 * 它静悄悄取了第一条的用量。这条管线上,那种形状今天会走到 `duplicate_expanded_key` 的
 * manual_confirm(冲突规划器的 fail-closed 挂起,人来裁),而「按老系统合并」会把这个挂起
 * **消掉** —— 那是把一道已有的守卫放松。所以:四样一致 **且用量也一致** 才合并(真正的重复,
 * 例如两条 active bomHead 指着同一条明细);用量不一致的仍然两行入库,仍然被挂起给人看。
 */
function siblingDedupeKey({ parentComponentCode, componentCode, nameAndSpec, material, rawQuantity }) {
  return JSON.stringify([
    toKey(parentComponentCode),
    toKey(componentCode),
    toKey(nameAndSpec),
    toKey(material),
    rawQuantity === undefined ? null : String(rawQuantity),
  ])
}

function makePath(pathTokens) {
  return JSON.stringify(pathTokens)
}

function makeIdempotencyKey(projectNo, componentSourceId, parentSourceId, pathTokens) {
  return JSON.stringify({
    projectNo,
    componentSourceId,
    parentSourceId: parentSourceId || null,
    path: pathTokens,
  })
}

function makeActions(rowsExpanded) {
  return {
    add: 0,
    update: 0,
    skip: 0,
    inactive: 0,
    manualConfirm: 0,
    candidateRows: rowsExpanded,
    plannerPending: true,
  }
}

function safeErrorCode(error) {
  if (!error) return undefined
  if (typeof error.code === 'string' && error.code.trim()) return error.code.trim()
  if (typeof error.name === 'string' && error.name.trim()) return error.name.trim()
  return undefined
}

function readDiagnostic(entry = {}) {
  const diagnostic = {
    object: entry.object,
    filterFields: Array.isArray(entry.filterFields) ? entry.filterFields.slice().sort() : [],
    cursor: entry.cursor || null,
    status: entry.status || 'attempted',
  }
  if (entry.filtersSent !== undefined) diagnostic.filtersSent = entry.filtersSent === true
  if (entry.source) diagnostic.source = entry.source
  if (entry.filtersApplied !== undefined) diagnostic.filtersApplied = entry.filtersApplied === true
  if (Number.isInteger(entry.count)) diagnostic.count = entry.count
  if (entry.errorCode) diagnostic.errorCode = entry.errorCode
  return diagnostic
}

function scaleErrorTypes(errors = []) {
  return Array.from(new Set(errors.map((entry) => entry.type).filter(isLargeBomBoundedErrorType))).sort()
}

function isLargeBomBoundedExpansion(result = {}) {
  const errors = Array.isArray(result.errors) ? result.errors : []
  const rowErrors = Array.isArray(result.rowErrors) ? result.rowErrors : []
  return errors.length > 0 && rowErrors.length === 0 && errors.every((entry) => isLargeBomBoundedErrorType(entry.type))
}

function boundedPreviewSummary(summary = {}, errorTypes = []) {
  if (errorTypes.length === 0) return undefined
  const out = {
    complete: false,
    authoritative: false,
    rowsExpanded: Number(summary.rowsExpanded || 0),
    readCount: Number(summary.readCount || 0),
    errorTypes: errorTypes.slice(),
  }
  if (summary.maxRows !== undefined) out.maxRows = summary.maxRows
  if (summary.maxPages !== undefined) out.maxPages = summary.maxPages
  if (summary.maxReadCount !== undefined) out.maxReadCount = summary.maxReadCount
  if (summary.maxElapsedMs !== undefined) out.maxElapsedMs = summary.maxElapsedMs
  return out
}

/**
 * A COUNTS-ONLY projection of the subtree segment. Every member is an integer; not one business
 * value crosses into it, and the keys exist only when the block is enabled — the same
 * conditional-key discipline `createRow` applies to `spec`/`sortLine`, so a plan without the block
 * produces a summary whose key set is byte-identical to the pre-feature one.
 *
 * `rootQuantitySource` is the honest half: it says how many depth-0 rows carried a MEASURED order
 * quantity and how many carried the defaulted `SUBTREE_ROOT_DEFAULT_QUANTITY`. The row itself cannot
 * say which it is, so the evidence does.
 */
function subtreeSummaryOf(counters) {
  if (!isPlainObject(counters)) return undefined
  return {
    nodesVisited: Number(counters.nodesVisited || 0),
    // Redundant arrivals at a folder node already queued by another branch — a DAG-shaped
    // directory, a duplicate parent row, or a project naming both an ancestor and its descendant.
    // Ordinary, counted, never an error (see the LOOP/RE-VISIT note on `discoverSubtreeRoots`).
    nodesSkippedAlreadyVisited: Number(counters.nodesSkippedAlreadyVisited || 0),
    rootsDiscovered: Number(counters.rootsDiscovered || 0),
    rootsExpanded: Number(counters.rootsExpanded || 0),
    rootsSkippedAlreadyExpanded: Number(counters.rootsSkippedAlreadyExpanded || 0),
    rootsWithoutChildren: Number(counters.rootsWithoutChildren || 0),
    rootQuantitySource: {
      orderDetail: Number((counters.rootQuantitySource || {}).orderDetail || 0),
      subtreeDefault: Number((counters.rootQuantitySource || {}).subtreeDefault || 0),
    },
  }
}

/**
 * The D-C overflow stanza, or `undefined` when nothing overflowed.
 *
 * `undefined` is the whole point: an expansion under the cap mounts NO key, which is what keeps its
 * summary — and therefore its evidence and its revision hash — byte-identical to the pre-cap one.
 *
 * VALUES-FREE by construction. The keys of `rowErrorTypeCounts` are rowError `type` tokens, the
 * same closed vocabulary `summary.errorTypes` has always published; the values are integers.
 */
function rowErrorTruncationOf({ total, retained, typeTotals }) {
  if (!(Number.isFinite(total) && Number.isFinite(retained) && total > retained)) return undefined
  const rowErrorTypeCounts = {}
  for (const type of Array.from(typeTotals.keys()).sort()) rowErrorTypeCounts[type] = typeTotals.get(type)
  return {
    rowErrorsTotal: total,
    rowErrorsRetained: retained,
    rowErrorsTruncated: true,
    rowErrorTypeCounts,
  }
}

// EVERY type the expansion produced — retained and dropped alike — for an expansion that overflowed.
// A SUPERSET of the dropped types, deliberately: `errorTypes` unions this in, so a superset of the
// truth is exactly as correct as the truth and costs one Map instead of a second one tracking which
// types happened to lose their last array slot. Empty (and therefore invisible to the `Set` below)
// when nothing overflowed, so `errorTypes` is unchanged for every expansion under the cap.
function truncatedRowErrorTypes(rowErrorTruncation) {
  if (!isPlainObject(rowErrorTruncation)) return []
  return Object.keys(rowErrorTruncation.rowErrorTypeCounts || {})
}

function makeSummary({ projectNoPresent, matchField, status, rowsExpanded, rootMatches, maxDepth, maxRows, maxPages, maxReadCount, maxElapsedMs, readStats, errors, rowErrors, subtree, rowErrorTruncation, duplicateSiblingsCollapsed, rootsFilteredOut }) {
  const summary = {
    projectNoPresent,
    matchField,
    status,
    rowsExpanded,
    rootMatches,
    maxDepth,
    maxRows,
    maxPages,
    maxReadCount,
    maxElapsedMs,
    readObjects: Array.from(new Set(readStats.map((entry) => entry.object))).sort(),
    readCount: readStats.length,
    readDiagnostics: readStats.map(readDiagnostic),
    // `.concat` of the TRUNCATED expansion's types keeps this honest: a type whose every occurrence
    // was refused an array slot still has to be named here, or the summary would say the project has
    // no such defect. Empty concat under the cap => the identical set => the identical hash.
    errorTypes: Array.from(new Set([...(errors || []), ...(rowErrors || [])].map((entry) => entry.type || entry.code).concat(truncatedRowErrorTypes(rowErrorTruncation)).filter(Boolean))).sort(),
    actions: makeActions(status === 'expanded' ? rowsExpanded : 0),
  }
  if (status === 'not_found') {
    summary.actions = {
      add: 0,
      update: 0,
      skip: 0,
      inactive: 0,
      manualConfirm: 0,
    }
  }
  // CONDITIONAL KEY — present only when the deployment enabled the block. Appended last so the
  // preceding key order is untouched.
  const subtreeCounts = subtreeSummaryOf(subtree)
  if (subtreeCounts) summary.subtree = subtreeCounts
  // CONDITIONAL KEYS — see ROW_ERROR_LIMIT's header. Mounted only by an expansion that actually
  // overflowed, and appended after `subtree` so neither conditional block can move the other.
  if (isPlainObject(rowErrorTruncation)) Object.assign(summary, rowErrorTruncation)
  // F1c — 老系统语义的两个计数,VALUES-FREE(两个整数,没有图号、没有名称)。
  //
  // CONDITIONAL by the same discipline as every block above it, and appended LAST so neither
  // existing conditional block can be moved by them: an expansion that collapsed nothing and
  // filtered no root produces a summary byte-identical to the pre-F1c one, which is what keeps
  // the dry-run revision of an untouched project stable.
  //
  // WHY THEY MUST BE VISIBLE AT ALL: both are行数变化的原因。去重掉的兄弟行和被剔除的根都会
  // 让「重拉后行数变少」,没有这两个数,操作员分不清「PLM 少了件」和「我们按老系统合并了」。
  if (Number.isFinite(duplicateSiblingsCollapsed) && duplicateSiblingsCollapsed > 0) {
    summary.duplicateSiblingsCollapsed = duplicateSiblingsCollapsed
  }
  if (Number.isFinite(rootsFilteredOut) && rootsFilteredOut > 0) {
    summary.rootsFilteredOut = rootsFilteredOut
  }
  return summary
}

// THE ROW-PRODUCTION BOUNDARY.
//
// `createRow` emits the fixed canonical shape and, when — and only when — an
// `extFieldMapping` is configured, the tenant `ext_` values that mapping
// produced. `extValues` is merged AFTER the canonical keys and is guaranteed by
// the mapping normalizer to contain nothing but `ext_`-prefixed ids that the
// customer pack declared `plm_system`, so it can neither shadow a canonical
// column nor smuggle a human-owned one past the refresh wall.
//
// Omit the mapping and this function is byte-identical to the pre-change one:
// no key is added, not even an empty one.
function createRow({ projectNo, parentSourceId, pathTokens, depth, partRow, rawQuantity, totalQuantity, active, sortLine, extValues }) {
  const componentSourceId = toKey(readField(partRow, 'OBJ_ID'))
  const path = makePath(pathTokens)
  const row = {
    projectNo,
    idempotencyKey: makeIdempotencyKey(projectNo, componentSourceId, parentSourceId, pathTokens),
    componentSourceId,
    parentSourceId: parentSourceId || null,
    path,
    depth,
    componentCode: readField(partRow, 'IdentityNo'),
    // F1c — 名称 is the FIRST SEGMENT of 名称及规格, never the whole cell any more. See
    // splitNameAndSpec (老系统 fillBasicStockInfo 762-770). The UNSPLIT string stays reachable
    // as `nameAndSpec` below, because 名称及规格 is a column of the customer's own workbook.
    componentName: splitNameAndSpec(readField(partRow, 'IdentityName')).componentName,
    material: readField(partRow, 'Material'),
    sourceVersion: readField(partRow, 'SysVer'),
    rawQuantity,
    totalQuantity,
    active,
  }
  // DECLARED-OR-ABSENT (see PLM_STOCK_PREPARATION_BOM_READ_PLAN.part): 规格 and the material
  // creation time are emitted ONLY when the deployment's read plan declared the slot AND the
  // source row actually carried a value. Same conditional-key discipline as `sortLine`, so a plan
  // that declares neither produces a byte-identical row to the pre-change one — no empty key.
  const spec = readField(partRow, 'Spec')
  // F1c — 名称及规格, the customer's own column (老系统 StockInfo.nameAndStandard). Carried
  // VERBATIM and only when the source row had one, so a part library with no name still produces
  // no key. The planner maps it onto the customer pack's `ext_nameAndSpec` where that pack
  // declares the column; on a pack-less deployment it simply travels no further.
  const nameAndSpec = readField(partRow, 'IdentityName')
  if (!isBlank(nameAndSpec)) row.nameAndSpec = nameAndSpec
  if (!isBlank(spec)) {
    // A DECLARED 规格 column always wins: it is the deployment's own column, measured, while the
    // split below is derived from the name cell.
    row.spec = spec
  } else {
    // 老系统口径: 规格 is the tail of 名称及规格 after the first space. This is NOT a guessed
    // COLUMN (the "declared or absent" rule for `readPlan.part.specField` is untouched) — it is a
    // derivation from the DECLARED name column, and a name with no space still yields no key.
    const derivedSpec = splitNameAndSpec(nameAndSpec).spec
    if (!isBlank(derivedSpec)) row.spec = derivedSpec
  }
  const createTime = readField(partRow, 'Createtime')
  if (!isBlank(createTime)) row.createTime = createTime
  if (!isBlank(sortLine)) row.sortLine = sortLine
  if (isPlainObject(extValues)) {
    for (const [fieldId, value] of Object.entries(extValues)) {
      row[fieldId] = value
    }
  }
  return row
}

function rowFromPart(plan, { projectNo, parentSourceId, pathTokens, depth, partRow, rawQuantity, totalQuantity, active, sortLine, extFieldMapping }) {
  const componentSourceId = toKey(readField(partRow, plan.part.idField))
  if (componentSourceId === null) {
    return {
      error: { type: 'missing_component_source_id', depth, field: plan.part.idField },
    }
  }
  const normalizedPart = {
    OBJ_ID: componentSourceId,
    IdentityNo: plan.part.codeField ? readField(partRow, plan.part.codeField) : undefined,
    IdentityName: plan.part.nameField ? readField(partRow, plan.part.nameField) : undefined,
    Material: plan.part.materialField ? readField(partRow, plan.part.materialField) : undefined,
    SysVer: plan.part.versionField ? readField(partRow, plan.part.versionField) : undefined,
    Spec: plan.part.specField ? readField(partRow, plan.part.specField) : undefined,
    Createtime: plan.part.createTimeField ? readField(partRow, plan.part.createTimeField) : undefined,
  }
  // The mapping reads the RAW source row, not `normalizedPart`: the canonical
  // declared keys are the only ones the read plan knows about, and the whole
  // point of a tenant mapping is to reach the columns it does not.
  //
  // `readField` is handed over rather than reimplemented, so a mapped source
  // column resolves through EXACTLY the same lookup (own key first, then a
  // single case-insensitive match, ambiguity refused) as a canonical one.
  const mapped = extFieldMapping
    ? applyExtFieldMapping(extFieldMapping, partRow, { readField })
    : null
  return {
    row: createRow({
      projectNo,
      parentSourceId,
      pathTokens,
      depth,
      partRow: normalizedPart,
      rawQuantity,
      totalQuantity,
      active,
      sortLine,
      extValues: mapped ? mapped.values : undefined,
    }),
    componentSourceId,
    sourceVersion: normalizedPart.SysVer,
    // A refused cell is reported, never guessed at. It does NOT drop the row:
    // one unparseable legacy cell must not cost a BOM component its PLM data.
    extErrors: mapped && mapped.errors.length ? mapped.errors.map((entry) => ({ ...entry, depth })) : undefined,
  }
}

function failureResult({ projectNoPresent, matchField, status = 'failed', rows, errors, rowErrors, missingComponents = [], missingComponentDistinctCount = 0, readStats, rootMatches, maxDepth, maxRows, maxPages, maxReadCount, maxElapsedMs, subtree, rowErrorTruncation }) {
  return {
    valid: false,
    status,
    rows,
    errors,
    rowErrors,
    // Present on EVERY return path (see the constant's header), so a consumer never has to ask
    // whether this particular expansion has the keys. Deliberately NOT passed to makeSummary:
    // `summary` is the values-free projection and stays that way.
    missingComponents,
    missingComponentDistinctCount,
    summary: makeSummary({
      projectNoPresent,
      matchField,
      status,
      rowsExpanded: rows.length,
      rootMatches,
      maxDepth,
      maxRows,
      maxPages,
      maxReadCount,
      maxElapsedMs,
      readStats,
      errors,
      rowErrors,
      subtree,
      rowErrorTruncation,
    }),
  }
}

// Fail-closed on the mapping itself: an `extFieldMapping` that has not been
// through `normalizeExtFieldMapping` has not been checked against a customer
// pack, so its targets could be human-owned, canonical, or simply not installed.
// This module refuses to be the place where that check is skipped. Absent is
// fine (every existing caller); present-but-unvalidated is not.
function requireNormalizedExtFieldMapping(extFieldMapping) {
  if (extFieldMapping === undefined || extFieldMapping === null) return null
  if (!isNormalizedExtFieldMapping(extFieldMapping)) {
    throw new StockPreparationBomExpansionError(
      'extFieldMapping must be produced by normalizeExtFieldMapping (stock-preparation-ext-field-mapping.cjs)',
      { field: 'extFieldMapping', reason: 'EXT_FIELD_MAPPING_NOT_NORMALIZED' },
    )
  }
  return extFieldMapping
}

async function expandPlmProjectBom(input = {}) {
  const sourceAdapter = requireSourceAdapter(input.sourceAdapter)
  const projectNo = typeof input.projectNo === 'string' ? input.projectNo.trim() : ''
  if (!projectNo) {
    throw new StockPreparationBomExpansionError('projectNo is required', { field: 'projectNo' })
  }
  const extFieldMapping = requireNormalizedExtFieldMapping(input.extFieldMapping)
  const plan = normalizeStockPreparationBomReadPlan(input.readPlan || PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  // F1c — 老系统根选择的规则常量。默认就是老系统那套(J…-00 总图 / J…-A、J…-B 钣金 / dash 层级
  // 剔除),但图号编码是一家工厂的约定,所以整块可由调用方(动作配置)覆盖,包括整条规则关掉
  // (`enabled: false` => 订单行全部当根,即 F1c 之前的行为)。
  const rootSelection = normalizeRootSelection(input.rootSelection)
  const options = {
    pageLimit: positiveInteger(input.pageLimit, 'pageLimit', DEFAULT_PAGE_LIMIT),
    maxPages: positiveInteger(input.maxPages, 'maxPages', DEFAULT_MAX_PAGES),
    maxDepth: nonNegativeInteger(input.maxDepth, 'maxDepth', DEFAULT_MAX_DEPTH),
    maxRows: positiveInteger(input.maxRows, 'maxRows', DEFAULT_MAX_ROWS),
    // The per-invocation budget still wins where it is given; the PLAN's budget is the floor under
    // it. Both absent stays both absent, so nothing about an existing caller changes — but a plan
    // that enabled `projectSubtree` cannot be budget-less, because the normalizer refused it.
    maxReadCount: optionalPositiveInteger(input.maxReadCount, 'maxReadCount') !== undefined
      ? optionalPositiveInteger(input.maxReadCount, 'maxReadCount')
      : plan.maxReadCount,
    maxElapsedMs: optionalPositiveInteger(input.maxElapsedMs, 'maxElapsedMs'),
    startedAtMs: Number.isFinite(input.startedAtMs) ? Number(input.startedAtMs) : Date.now(),
    now: typeof input.now === 'function' ? input.now : Date.now,
    // Opt-in, and only the B2a seam opts in. Default `false` keeps every existing caller — every
    // fixture, every demo, every dormant deployment — on the loop it already had.
    requireCompleteBatch: input.requireCompleteBatch === true,
    // D-C. Configuration may move this within reach of the ceiling and no further — see
    // ROW_ERROR_LIMIT's header. The enforcement lives HERE, in the only place that reads the cap, so
    // a caller that forgot to validate cannot un-bound the array by threading a big number through.
    //
    // `ceilingBoundedPositiveInteger`, not a silent `Math.min`: over the ceiling is a REFUSAL, and
    // the type is not coerced. A clamp would have let `rowErrorLimit: 100000` read as "hard cap
    // 20000" with no feedback anywhere, which is the exact "recommended maximum 4 as a comment while
    // the plan carries 100000" failure that helper exists to prevent; and `positiveInteger` alone
    // would have accepted `true` (-> 1), silently cutting the retained sample — and the operator's
    // defect list — to a single entry over a config typo.
    rowErrorLimit: ceilingBoundedPositiveInteger(
      input.rowErrorLimit,
      'rowErrorLimit',
      ROW_ERROR_LIMIT,
      ROW_ERROR_LIMIT_CEILING,
    ),
  }
  const readStats = []
  const errors = []
  const rowErrors = []
  // D-C counters. `rowErrorsTotal` counts EVERY call to `addRowError`, including the ones the cap
  // refused an array slot; `rowErrorTypeTotals` does the same per type. Both are read only through
  // `rowErrorTruncationOf`, which returns `undefined` — and therefore mounts nothing — when the
  // expansion stayed under the cap.
  let rowErrorsTotal = 0
  const rowErrorTypeTotals = new Map()
  // F1c counters — values-free, reported through `makeSummary`'s two conditional keys.
  let duplicateSiblingsCollapsed = 0
  let rootsFilteredOut = 0
  const rows = []
  // Zeroed the moment the block is enabled — so "enabled" and "the summary carries subtree counts"
  // are the same fact on every exit path, including `not_found` and an entry-read failure. Stays
  // `undefined` when the block is absent, which is what keeps the disabled summary byte-identical.
  const subtreeCounters = plan.projectSubtree
    ? {
      nodesVisited: 0,
      nodesSkippedAlreadyVisited: 0,
      rootsDiscovered: 0,
      rootsExpanded: 0,
      rootsSkippedAlreadyExpanded: 0,
      rootsWithoutChildren: 0,
      rootQuantitySource: { orderDetail: 0, subtreeDefault: 0 },
    }
    : undefined
  // The side channel, keyed by part number — see MISSING_COMPONENT_DETAIL_LIMIT's header. Three
  // structures, because three different questions have to stay answerable:
  //   * `missingComponents`        the DETAIL that leaves this module, at most one entry per distinct
  //                               part number and at most MISSING_COMPONENT_DETAIL_LIMIT of them;
  //   * `missingComponentParents`  the distinct parents per retained part (a Set, so `parentCount`
  //                               counts places-it-is-wanted rather than probes);
  //   * `missingComponentIds`      EVERY distinct part number probed, capped by nothing, so the
  //                               reported `distinctCount` is the truth and not the page size.
  const missingComponents = []
  const missingComponentIndex = new Map()
  const missingComponentParents = new Map()
  const missingComponentIds = new Set()

  const read = (object, filters) => readAll(sourceAdapter, object, filters, options, readStats)
  const addGlobalError = (type, details = {}) => {
    errors.push({ type, ...details })
  }
  const addReadError = (err, object) => {
    const bounded = readLimitErrorDetails(err, object)
    if (bounded) {
      addGlobalError(bounded.type, bounded)
      return
    }
    // The read-only ORIGINAL CAUSE CLASS, kept alongside the message. `message` is dynamic and is
    // never allowed into evidence; `causeClass` is `error.code || error.name` — a symbolic token —
    // and it is the only thing a downstream seam can classify a driver failure by. Without it an
    // mssql request timeout is indistinguishable from any other failed read, and the B2a seam has to
    // call it "incomplete" when it is specifically "timed out".
    addGlobalError('read_failed', { object, causeClass: safeErrorCode(err), message: err && err.message })
  }
  // COUNT FIRST, APPEND SECOND (D-C). Every caller keeps being counted; only the array is bounded.
  // The type key mirrors `makeSummary`'s `entry.type || entry.code` exactly, so the per-type totals
  // and `errorTypes` can never disagree about what a rowError's type is.
  const addRowError = (error) => {
    rowErrorsTotal += 1
    const type = isPlainObject(error) ? (error.type || error.code) : undefined
    if (type) rowErrorTypeTotals.set(type, (rowErrorTypeTotals.get(type) || 0) + 1)
    // Deterministic truncation: the array keeps the FIRST `rowErrorLimit` entries in production
    // order, so the same input produces the same retained prefix and the same revision every time.
    if (rowErrors.length >= options.rowErrorLimit) return
    rowErrors.push(error)
  }
  const rowErrorTruncation = () => rowErrorTruncationOf({
    total: rowErrorsTotal,
    retained: rowErrors.length,
    typeTotals: rowErrorTypeTotals,
  })
  // Deliberately separate from `addRowError`: the two payloads have different audiences and
  // different rules, and merging them is exactly the mistake this design exists to prevent.
  //
  // AGGREGATES AT THE POINT OF COLLECTION. Creating a part in PLM is a per-part job, so the unit of
  // this list is the part number, not the BOM position. A part number already retained keeps
  // counting no matter how many positions want it — the cap can cost the list a WHOLE PART, never a
  // wrong count for a part that is on it.
  const addMissingComponent = ({ componentSourceId, parentSourceId, bomId, path, depth }) => {
    missingComponentIds.add(componentSourceId)
    let entry = missingComponentIndex.get(componentSourceId)
    if (!entry) {
      // Only a NEW part number can be refused by the cap, and `missingComponentIds` has already
      // recorded it so `distinctCount` still counts it.
      if (missingComponents.length >= MISSING_COMPONENT_DETAIL_LIMIT) return
      // parent / bom / path / depth are the FIRST place this part was wanted, and stay so.
      entry = { componentSourceId, parentSourceId, bomId, path, depth, occurrenceCount: 0, parentCount: 0 }
      missingComponents.push(entry)
      missingComponentIndex.set(componentSourceId, entry)
      missingComponentParents.set(componentSourceId, new Set())
    }
    entry.occurrenceCount += 1
    const parents = missingComponentParents.get(componentSourceId)
    // `null` for the BOM root ("wanted directly by the order"), which is a distinct place a part is
    // wanted and is counted as one. It can never collide with a String() parent id.
    parents.add(parentSourceId === null || parentSourceId === undefined ? null : String(parentSourceId))
    entry.parentCount = parents.size
  }
  const pushRow = (row) => {
    if (rows.length + 1 > options.maxRows) {
      addGlobalError('max_rows_exceeded', { maxRows: options.maxRows })
      return false
    }
    rows.push(row)
    return true
  }

  let pathMatches = []
  try {
    // THE ENTRY READ, RE-FILTERED CLIENT-SIDE — the one read in this module that was not.
    //
    // Every other filtered read whose result decides WHICH PROJECT'S DATA we are looking at already
    // goes through `matchesByField`, because `readAll` RECORDS `filtersApplied` and never ENFORCES
    // it, and `bridge:legacy-sql-readonly` may legally answer with the whole table. This read was
    // the exception, and it is the most load-bearing one of all: its rows ARE the project — they
    // seed the order loop's folder-node lookups AND the subtree segment's BFS.
    //
    // Unfiltered, a single say-anything source turns every other project's directory node into a
    // depth-0 node of THIS project, and the resulting rows land as this project's stock-preparation
    // lines with `status: expanded`, `valid: true`, `errors: []` — a clean bill of health on
    // cross-project data, with `dataScopeRef` still naming the one project the request asked for.
    //
    // Filtering HERE rather than in the subtree segment is deliberate: one clean `pathMatches`
    // serves both root segments, and the order path — which had the identical exposure before this
    // change — is closed by the same line. Against a source that applies its filters, this is a
    // no-op; the behaviour only differs against a source that lied.
    const pathExAttrRows = await read(plan.pathExAttr.object, { [plan.pathExAttr.matchField]: projectNo })
    pathMatches = matchesByField(pathExAttrRows, plan.pathExAttr.matchField, projectNo)
  } catch (err) {
    addReadError(err, plan.pathExAttr.object)
    return failureResult({
      projectNoPresent: true,
      matchField: plan.matchField,
      rows,
      errors,
      rowErrors,
      missingComponents,
      missingComponentDistinctCount: missingComponentIds.size,
      readStats,
      rootMatches: 0,
      maxDepth: options.maxDepth,
      maxRows: options.maxRows,
      maxPages: options.maxPages,
      maxReadCount: options.maxReadCount,
      maxElapsedMs: options.maxElapsedMs,
      subtree: subtreeCounters,
      rowErrorTruncation: rowErrorTruncation(),
    })
  }

  if (pathMatches.length === 0) {
    return {
      valid: true,
      status: 'not_found',
      rows: [],
      errors: [],
      rowErrors: [],
      missingComponents: [],
      missingComponentDistinctCount: 0,
      summary: makeSummary({
        projectNoPresent: true,
        matchField: plan.matchField,
        status: 'not_found',
        rowsExpanded: 0,
        rootMatches: 0,
        maxDepth: options.maxDepth,
        maxRows: options.maxRows,
        maxPages: options.maxPages,
        maxReadCount: options.maxReadCount,
        maxElapsedMs: options.maxElapsedMs,
        readStats,
        errors: [],
        rowErrors: [],
        subtree: subtreeCounters,
        // NO `rowErrorTruncation` here, and that is not an omission: this is the ONE `makeSummary`
        // call site reached before `addRowError` can have run even once (the project-number lookup
        // came back empty, so nothing was expanded), which is why `rowErrors` is a hardcoded `[]`
        // two lines up. Threading the counters would mount nothing. The other two call sites are
        // both downstream of expansion and MUST thread it — do not copy this exception into one.
      }),
    }
  }

  // `locus` is the W3a context for the missing-component side channel ONLY: the parent, the BOM head
  // and the path this probe happened under. It never reaches `addRowError` — the rowError payload is
  // frozen at `{type, field, depth}` and a test pins its `Object.keys()`.
  //
  // `ambiguous_component` gets NO such channel, deliberately. Two candidate rows for one part id is a
  // SOURCE DATA defect nobody on the floor can fix by creating a part, so naming the part would put a
  // customer value on the wire for no operator action — and every value-bearing key is a leak surface
  // that has to earn its keep.
  async function readPart(componentSourceId, depth, locus = {}) {
    const matches = await read(plan.part.object, { [plan.part.idField]: componentSourceId })
    const candidates = matchesByField(matches, plan.part.idField, componentSourceId)
    if (candidates.length > 1) {
      addRowError({ type: 'ambiguous_component', field: plan.part.idField, depth })
      return undefined
    }
    const row = candidates[0]
    if (!row) {
      addRowError({ type: 'missing_component', field: plan.part.idField, depth })
      addMissingComponent({
        componentSourceId,
        parentSourceId: locus.parentSourceId === undefined ? null : locus.parentSourceId,
        bomId: locus.bomId === undefined ? null : locus.bomId,
        path: locus.path === undefined ? null : locus.path,
        depth,
      })
      return undefined
    }
    return row
  }

  async function expandChildren(parentRow, pathTokens) {
    if (errors.length > 0) return
    const parentSourceId = parentRow.componentSourceId
    const nextDepth = parentRow.depth + 1
    // F1c 同父去重 (老系统 iterHandle 686-693). ONE set PER PARENT, declared here rather than per
    // BOM head on purpose: 老系统 dedupes the parent's WHOLE child list, which it gets by
    // `parentId` — i.e. across every BOM head that named this parent. That is also exactly the
    // shape of 差异A (两条 active bomHead 让同一个子件以相同 pathTokens 重复入行,banner :72-78
    // 自承): the second head's identical child now collapses into the first head's row instead of
    // producing a second row the conflict planner cannot even see as related.
    //
    // 去重掉的子件连同它的子树一起不展开 —— 老系统也是这样(重复节点整个不进 `iterHandle`),
    // 而且它的子树会在胜出的那条兄弟下面原样展开一遍。
    const siblingKeys = new Set()
    const headFilters = { [plan.bomHead.parentPartField]: parentSourceId }
    if (plan.bomHead.versionField && !isBlank(parentRow.sourceVersion)) {
      headFilters[plan.bomHead.versionField] = parentRow.sourceVersion
    }
    let heads
    try {
      heads = (await read(plan.bomHead.object, headFilters)).filter((head) => isActiveBomHead(head, plan.bomHead.activeField))
    } catch (err) {
      addReadError(err, plan.bomHead.object)
      return
    }
    if (nextDepth > options.maxDepth && heads.length > 0) {
      addGlobalError('max_depth_exceeded', { maxDepth: options.maxDepth, parentDepth: parentRow.depth })
      return
    }
    for (const head of heads) {
      if (errors.length > 0) return
      const bomId = readField(head, plan.bomHead.bomIdField)
      if (isBlank(bomId)) {
        addRowError({ type: 'missing_bom_id', field: plan.bomHead.bomIdField, depth: parentRow.depth })
        continue
      }
      let details
      try {
        details = await read(plan.bomDetail.object, { [plan.bomDetail.bomParentField]: bomId })
      } catch (err) {
        addReadError(err, plan.bomDetail.object)
        return
      }
      if (details.length === 0) {
        addRowError({
          type: 'missing_child_bom',
          field: plan.bomDetail.bomParentField,
          depth: nextDepth,
        })
        continue
      }
      for (const detail of details) {
        if (errors.length > 0) return
        const childSourceId = toKey(readField(detail, plan.bomDetail.componentIdField))
        if (childSourceId === null) {
          addRowError({ type: 'missing_component_source_id', field: plan.bomDetail.componentIdField, depth: nextDepth })
          continue
        }
        if (pathTokens.includes(childSourceId)) {
          addGlobalError('cycle_detected', { depth: nextDepth })
          return
        }
        const qty = parseQuantity(readField(detail, plan.bomDetail.quantityField), {
          field: plan.bomDetail.quantityField,
          depth: nextDepth,
          relation: 'child',
        })
        if (!qty.ok) {
          addRowError(qty.error)
          continue
        }
        const childTokens = pathTokens.concat(childSourceId)
        const partRow = await readPart(childSourceId, nextDepth, {
          parentSourceId,
          bomId,
          path: makePath(childTokens),
        })
        if (!partRow) continue
        // 键取的是老系统那四样,读的是 PART 行(图号/名称及规格/材质)+ 父件图号 —— 和老系统
        // `info.getParentComponentCode()+info.getComponentCode()+info.getNameAndStandard()+
        // info.getMaterialId()` 同一组值。名称及规格用的是 **未切分** 的原串,所以两个同图号、
        // 不同名称的标准件不会被合并(老系统那行注释说的就是这件事)。
        const dedupeKey = siblingDedupeKey({
          parentComponentCode: parentRow.componentCode,
          componentCode: plan.part.codeField ? readField(partRow, plan.part.codeField) : undefined,
          nameAndSpec: plan.part.nameField ? readField(partRow, plan.part.nameField) : undefined,
          material: plan.part.materialField ? readField(partRow, plan.part.materialField) : undefined,
          // 本层用量,已经过 parseQuantity(hold-not-zero),所以这里比的是解析后的数,而不是
          // 驱动给的 '1' / 1 两种形状。
          rawQuantity: qty.value,
        })
        if (siblingKeys.has(dedupeKey)) {
          duplicateSiblingsCollapsed += 1
          continue
        }
        siblingKeys.add(dedupeKey)
        const rowResult = rowFromPart(plan, {
          projectNo,
          parentSourceId,
          pathTokens: childTokens,
          depth: nextDepth,
          partRow,
          rawQuantity: qty.value,
          totalQuantity: parentRow.totalQuantity * qty.value,
          active: true,
          sortLine: plan.bomDetail.sortField ? readField(detail, plan.bomDetail.sortField) : undefined,
          extFieldMapping,
        })
        if (rowResult.error) {
          addRowError(rowResult.error)
          continue
        }
        if (rowResult.extErrors) rowResult.extErrors.forEach(addRowError)
        if (!pushRow(rowResult.row)) return
        await expandChildren(rowResult.row, childTokens)
      }
    }
  }

  /**
   * BREADTH-FIRST over the project's FOLDER subtree, returning the `part_id`s of the BOM heads that
   * hang off it — in discovery order, de-duplicated.
   *
   * Returns `null` when the traversal refused (cycle / node ceiling / root ceiling). A refusal is a
   * GLOBAL error by then, so the caller must not treat `null` as "no roots".
   *
   * Two properties do the safety work, and both are testable by making the source misbehave:
   *
   *   RE-FILTERING. Both reads THIS function issues — child nodes by parent, heads by folder node —
   *   go through `matchesByField` before anything is believed, and the SEEDS are covered by the
   *   same discipline one level up (`pathMatches` is re-filtered at the entry read). A source
   *   answering `filtersApplied: false` hands back the WHOLE table; without those filters the first
   *   hop would adopt every folder node in the catalog as this project's child and then read other
   *   projects' BOM heads under this project's authorization, with `dataScopeRef` still naming the
   *   one project the request asked for. The reads `expandChildren` makes for each discovered root
   *   are NOT re-filtered — see the banner: they are the order path's reads, shared verbatim.
   *
   *   TERMINATION, and the difference between a LOOP and a RE-VISIT. These are two different facts
   *   and they get two different answers:
   *
   *     A LOOP is a node that is its own ancestor — the parent chain that led here comes back to
   *     this node. That is a mis-shaped directory whose traversal cannot terminate on its own, and
   *     it is refused: `subtree_cycle_detected`, global, fail-closed. Each queue item therefore
   *     carries its ANCESTOR CHAIN (bounded by `maxSubtreeDepth` <= 4, so it is a 4-element array,
   *     not a data structure worth optimizing).
   *
   *     A RE-VISIT is a node reached a second time by a DIFFERENT branch: a DAG-shaped directory
   *     where two folders share a child, or — the case that matters most — a project whose
   *     pathExAttr rows name BOTH an ancestor and one of its descendants, which is an ordinary
   *     directory shape and not a fault at all. It is SKIPPED (its heads were already collected the
   *     first time) and COUNTED as `nodesSkippedAlreadyVisited`. Refusing it would kill the entire
   *     pull — the ALREADY-COMPLETED order path included — over a perfectly well-formed directory.
   */
  async function discoverSubtreeRoots(seedPathIds, subtree, counters) {
    // Membership is decided AT ENQUEUE, not at dequeue. Deciding it at dequeue is functionally
    // identical but lets one node enter the queue once per PARENT EDGE pointing at it, so a
    // pathInfo table with many rows naming the same child (duplicates, a wide DAG) inflates the
    // queue to `pageLimit * maxPages` entries per visited node while doing exactly the same work.
    // The structural ceilings bound the WORK, not that array. Enqueueing each node at most once
    // bounds both. BFS is FIFO, so the first enqueue of a node is always its minimum depth and
    // dropping the later ones cannot cost a child.
    const queued = new Set(seedPathIds)
    const roots = []
    const rootsSeen = new Set()
    const queue = seedPathIds.map((nodeId) => ({ nodeId, depth: 0, ancestors: [] }))

    while (queue.length > 0) {
      if (errors.length > 0) return null
      const { nodeId, depth, ancestors } = queue.shift()
      if (counters.nodesVisited >= subtree.maxSubtreeNodes) {
        addGlobalError(SUBTREE_NODE_LIMIT_EXCEEDED_ERROR_TYPE, {
          object: plan.pathInfo.object,
          maxSubtreeNodes: subtree.maxSubtreeNodes,
        })
        return null
      }
      counters.nodesVisited += 1

      // The heads hanging off THIS node. `includeSelf` decides whether the project node itself is
      // asked; every deeper node always is.
      if (depth > 0 || subtree.includeSelf) {
        const headRows = await read(plan.bomHead.object, { [subtree.bomHead.pathIdField]: nodeId })
        const heads = matchesByField(headRows, subtree.bomHead.pathIdField, nodeId)
          .filter((head) => isActiveBomHead(head, plan.bomHead.activeField))
        for (const head of heads) {
          const rootSourceId = toKey(readField(head, plan.bomHead.parentPartField))
          if (rootSourceId === null) continue
          // ONE ROOT PER PART, not one per head. A part with two heads (a measured customer shape)
          // would otherwise become two roots whose idempotencyKeys are byte-identical, which the
          // conflict planner groups and HOLDS — turning the whole plan into manual_confirm.
          if (rootsSeen.has(rootSourceId)) continue
          rootsSeen.add(rootSourceId)
          if (roots.length >= subtree.maxSubtreeRoots) {
            addGlobalError(SUBTREE_ROOT_LIMIT_EXCEEDED_ERROR_TYPE, {
              object: plan.bomHead.object,
              maxSubtreeRoots: subtree.maxSubtreeRoots,
            })
            return null
          }
          roots.push(rootSourceId)
        }
      }

      if (depth >= subtree.maxSubtreeDepth) continue
      const childRows = await read(plan.pathInfo.object, { [subtree.pathInfo.parentIdField]: nodeId })
      const children = matchesByField(childRows, subtree.pathInfo.parentIdField, nodeId)
      const childAncestors = ancestors.concat(nodeId)
      for (const child of children) {
        const childId = toKey(readField(child, plan.pathInfo.idField))
        if (childId === null) continue
        // ORDER MATTERS: the ancestor test comes FIRST. A node on this branch's own chain is a
        // LOOP — descending would walk that chain forever — and it is refused whether or not some
        // other branch has already queued it. `childAncestors` includes `nodeId`, so a
        // self-referencing node (the simplest and commonest form) is caught by the same test.
        if (childAncestors.includes(childId)) {
          addGlobalError(SUBTREE_CYCLE_DETECTED_ERROR_TYPE, {
            object: plan.pathInfo.object,
            depth: depth + 1,
          })
          return null
        }
        // Not a loop, but already spoken for: a DAG merge, a duplicate parent row, or a seed that
        // is this node's ancestor. Counted and dropped — never re-queued, so redundant parent edges
        // cost a counter increment rather than a queue slot.
        if (queued.has(childId)) {
          counters.nodesSkippedAlreadyVisited += 1
          continue
        }
        queued.add(childId)
        queue.push({ nodeId: childId, depth: depth + 1, ancestors: childAncestors })
      }
    }
    return roots
  }

  // ---- FIRST ROOT SEGMENT: the order module, in TWO PHASES since F1c -------------------------
  //
  // 老系统 `doGetAllBomInfo` 1046-1095 决定哪些订单行当根,决定的依据是**整个项目的订单 BOM 行
  // 集合**(`selectBomFromBomOrderByProductCode` 一次取全量,再挑总图/钣金)。一条行是不是根,
  // 取决于同一批里有没有别的行 —— 所以在这条管线上,「读一行展开一行」的老形状表达不了这条规则。
  //
  // 于是订单段拆成两段:先把候选根**读齐**(路径 -> 订单头 -> 订单明细 -> 部件行),再按老系统规则
  // 选根,最后才展开。读的对象、过滤器、每行的错误分类一个没变,变的只有顺序:所有根的 part 读
  // 现在都发生在第一次 bomHead 读之前。预算(maxReadCount/maxElapsedMs)仍由同一个 `read` 记账,
  // 超了仍是全局错误 -> status failed -> canApply false。
  const rootCandidates = []
  try {
    for (const pathRow of pathMatches) {
      if (errors.length > 0) break
      const pathId = readField(pathRow, plan.pathExAttr.pathIdField)
      if (isBlank(pathId)) {
        addRowError({ type: 'missing_path_id', field: plan.pathExAttr.pathIdField, depth: 0 })
        continue
      }
      const pathInfoMatches = await read(plan.pathInfo.object, { [plan.pathInfo.idField]: pathId })
      const pathInfoCandidates = matchesByField(pathInfoMatches, plan.pathInfo.idField, pathId)
      if (pathInfoCandidates.length > 1) {
        addRowError({ type: 'ambiguous_path', field: plan.pathInfo.idField, depth: 0 })
        continue
      }
      if (!pathInfoCandidates[0]) {
        addRowError({ type: 'missing_path', field: plan.pathInfo.idField, depth: 0 })
        continue
      }
      const orderHeads = await read(plan.orderHead.object, { [plan.orderHead.pathIdField]: pathId })
      for (const orderHead of orderHeads) {
        if (errors.length > 0) break
        const orderId = readField(orderHead, plan.orderHead.idField)
        if (isBlank(orderId)) {
          addRowError({ type: 'missing_order_id', field: plan.orderHead.idField, depth: 0 })
          continue
        }
        const details = await read(plan.orderDetail.object, { [plan.orderDetail.orderIdField]: orderId })
        for (const detail of details) {
          if (errors.length > 0) break
          const componentSourceId = toKey(readField(detail, plan.orderDetail.componentIdField))
          if (componentSourceId === null) {
            addRowError({ type: 'missing_component_source_id', field: plan.orderDetail.componentIdField, depth: 0 })
            continue
          }
          const qty = parseQuantity(readField(detail, plan.orderDetail.quantityField), {
            field: plan.orderDetail.quantityField,
            depth: 0,
            relation: 'root',
          })
          if (!qty.ok) {
            addRowError(qty.error)
            continue
          }
          const pathTokens = [componentSourceId]
          // The BOM root: the order detail names the part directly, so there is no parent and no BOM
          // head above it. Both are null rather than absent — the shape is uniform for the UI.
          const partRow = await readPart(componentSourceId, 0, {
            parentSourceId: null,
            bomId: null,
            path: makePath(pathTokens),
          })
          if (!partRow) continue
          // PHASE 1 ends here: a candidate, not yet a row. 图号/版本 are read through the read
          // plan's declared part slots — the same two values 老系统 selects roots by.
          rootCandidates.push({
            componentSourceId,
            componentCode: plan.part.codeField ? readField(partRow, plan.part.codeField) : undefined,
            sourceVersion: plan.part.versionField ? readField(partRow, plan.part.versionField) : undefined,
            partRow,
            rawQuantity: qty.value,
            sortLine: plan.orderDetail.sortField ? readField(detail, plan.orderDetail.sortField) : undefined,
            pathTokens,
          })
        }
      }
    }
  } catch (err) {
    const bounded = readLimitErrorDetails(err)
    if (bounded) addGlobalError(bounded.type, bounded)
    else addGlobalError('read_failed', { causeClass: safeErrorCode(err), message: err && err.message })
  }

  // PHASE 2 — 老系统根选择。PURE: no read, no row, just which candidates survive.
  const rootSelectionResult = selectOrderRootCandidates(rootCandidates, rootSelection)
  rootsFilteredOut = rootSelectionResult.droppedCount

  // PHASE 3 — expansion, in candidate (read) order. Byte-identical to the pre-F1c loop body.
  try {
    for (const candidate of rootSelectionResult.selected) {
      if (errors.length > 0) break
      const rowResult = rowFromPart(plan, {
        projectNo,
        parentSourceId: null,
        pathTokens: candidate.pathTokens,
        depth: 0,
        partRow: candidate.partRow,
        rawQuantity: candidate.rawQuantity,
        totalQuantity: candidate.rawQuantity,
        active: true,
        sortLine: candidate.sortLine,
        extFieldMapping,
      })
      if (rowResult.error) {
        addRowError(rowResult.error)
        continue
      }
      if (rowResult.extErrors) rowResult.extErrors.forEach(addRowError)
      if (!pushRow(rowResult.row)) break
      // The ONLY line the order loop gained, and it is a no-op unless the optional block is
      // configured. Counted HERE, where an order root is actually produced, rather than
      // re-derived later from `rows`: the subtree segment does not run on every exit path (an
      // early failure, a `not_found`), and a count derived there would report 0 order-sourced
      // roots for a run that produced several — the one number `rootQuantitySource` exists to
      // get right.
      if (subtreeCounters) subtreeCounters.rootQuantitySource.orderDetail += 1
      await expandChildren(rowResult.row, candidate.pathTokens)
    }
  } catch (err) {
    const bounded = readLimitErrorDetails(err)
    if (bounded) addGlobalError(bounded.type, bounded)
    else addGlobalError('read_failed', { causeClass: safeErrorCode(err), message: err && err.message })
  }

  // ---- SECOND ROOT SEGMENT: the project's folder subtree (optional, off by default) ------------
  //
  // Everything above this line is the order path, unchanged to the character. Everything below runs
  // only when `plan.projectSubtree` exists, and only when the order path finished clean: after a
  // `max_rows_exceeded` or a `cycle_detected` the run is already failed, and continuing to read
  // would burn budget and re-push the same global error once per remaining root.
  //
  // Its own try/catch, INSIDE the function, for the reason the order loop has one: a read that
  // blows `maxReadCount`/`maxElapsedMs` throws, and an uncaught throw here would reject the whole
  // expansion into a 500 instead of the global error -> `status: failed` -> `canApply: false` this
  // design depends on.
  if (plan.projectSubtree && errors.length === 0) {
    const subtree = plan.projectSubtree
    // EVERY component this run has already expanded — roots AND children. See (2) in the banner:
    // de-duplicating only against order ROOTS leaves the common case (a part that is an order root's
    // child and a subtree root) producing two rows the planner cannot even see as related.
    const expandedComponentIds = new Set()
    for (const row of rows) {
      if (row.componentSourceId !== null && row.componentSourceId !== undefined) {
        expandedComponentIds.add(row.componentSourceId)
      }
    }
    try {
      // The project's folder nodes, taken from the pathExAttr rows the entry read ALREADY returned.
      // No extra read, and the order loop above is not touched to produce them.
      const seedPathIds = []
      for (const pathRow of pathMatches) {
        const pathId = toKey(readField(pathRow, plan.pathExAttr.pathIdField))
        if (pathId !== null && !seedPathIds.includes(pathId)) seedPathIds.push(pathId)
      }

      const discovered = await discoverSubtreeRoots(seedPathIds, subtree, subtreeCounters)
      if (discovered) {
        subtreeCounters.rootsDiscovered = discovered.length
        for (const rootSourceId of discovered) {
          if (errors.length > 0) break
          if (expandedComponentIds.has(rootSourceId)) {
            subtreeCounters.rootsSkippedAlreadyExpanded += 1
            continue
          }
          const pathTokens = [rootSourceId]
          // W3a: the SUBTREE root, and it is a root in exactly the sense the order path's root is —
          // no parent above it, no BOM head that named it (the folder walk found it, not a BOM). Same
          // locus shape as the order root, so a missing subtree root reads identically in the
          // operator's list to a missing order root. Without this argument the sidecar would carry
          // the part number with a silently `null` parent/bom/path anyway, but by accident rather
          // than by statement — and `path` would be missing, which the UI's column expects.
          const partRow = await readPart(rootSourceId, 0, {
            parentSourceId: null,
            bomId: null,
            path: makePath(pathTokens),
          })
          if (!partRow) continue
          const rowResult = rowFromPart(plan, {
            projectNo,
            parentSourceId: null,
            pathTokens,
            depth: 0,
            partRow,
            rawQuantity: SUBTREE_ROOT_DEFAULT_QUANTITY,
            totalQuantity: SUBTREE_ROOT_DEFAULT_QUANTITY,
            active: true,
            extFieldMapping,
          })
          if (rowResult.error) {
            addRowError(rowResult.error)
            continue
          }
          if (rowResult.extErrors) rowResult.extErrors.forEach(addRowError)
          if (!pushRow(rowResult.row)) break
          expandedComponentIds.add(rowResult.componentSourceId)
          subtreeCounters.rootsExpanded += 1
          subtreeCounters.rootQuantitySource.subtreeDefault += 1
          const rowsBefore = rows.length
          await expandChildren(rowResult.row, pathTokens)
          // A root whose head SysVer does not match its part's SysVer gets NO children, because
          // `expandChildren` re-reads bomHead filtered by the part's version. Counted rather than
          // silent, so "we pulled six bare roots" is a number in evidence and not a surprise.
          if (rows.length === rowsBefore) subtreeCounters.rootsWithoutChildren += 1
          for (let index = rowsBefore; index < rows.length; index += 1) {
            expandedComponentIds.add(rows[index].componentSourceId)
          }
        }
      }
    } catch (err) {
      const bounded = readLimitErrorDetails(err)
      if (bounded) addGlobalError(bounded.type, bounded)
      else addGlobalError('read_failed', { causeClass: safeErrorCode(err), message: err && err.message })
    }
  }

  // `rowErrorsTotal`, not `rowErrors.length`: a project whose rowErrors were ALL past the cap is
  // still a failed project. (Unreachable today — the cap is 5000 and the array fills before it
  // overflows — but the status must follow the truth, not the retained sample.)
  const status = errors.length > 0 || rowErrorsTotal > 0 ? 'failed' : 'expanded'
  return {
    valid: status === 'expanded',
    status,
    rows,
    errors,
    rowErrors,
    // Same on the bounded (large-BOM) path, which reaches this return with its scale error in
    // `errors`: the keys are always present, empty/zero when nothing was missing.
    missingComponents,
    missingComponentDistinctCount: missingComponentIds.size,
    summary: makeSummary({
      projectNoPresent: true,
      matchField: plan.matchField,
      status,
      rowsExpanded: rows.length,
      rootMatches: pathMatches.length,
      maxDepth: options.maxDepth,
      maxRows: options.maxRows,
      maxPages: options.maxPages,
      maxReadCount: options.maxReadCount,
      maxElapsedMs: options.maxElapsedMs,
      readStats,
      errors,
      rowErrors,
      subtree: subtreeCounters,
      rowErrorTruncation: rowErrorTruncation(),
      duplicateSiblingsCollapsed,
      rootsFilteredOut,
    }),
  }
}

/**
 * W3a — THE OPERATOR-FACING MISSING-COMPONENT LIST. Values-BEARING, and the only function in this
 * module that is.
 *
 * Deliberately NOT built on `summarizeBomExpansionForEvidence`, and deliberately not called by it:
 * that one is the values-free projection every evidence stanza, audit row and ledger entry rides on,
 * and the single most valuable property it has is that no part number can reach it. Sharing code
 * between the two is how that property gets lost in a later refactor, so they share none.
 *
 * ONE ROW PER PART NUMBER, not per probe — and the deduplication has ALREADY HAPPENED, in the
 * expander's keyed collector. Creating a part in PLM is a per-part job, so a list that repeated a
 * part once per BOM position would be a worklist with the same work written out fifty times. The
 * parent / BOM / path / depth reported are the FIRST place the part was wanted; `parentCount` says
 * how many distinct parents wanted it, which is the "this one is holding up several assemblies"
 * signal. This function ranks, bounds and reports; it does not re-derive counts the collector is the
 * only thing in a position to get right (it sees the probes the cap dropped detail for).
 *
 * ORDER: `occurrenceCount` descending (do the most-blocking part first), ties broken by
 * `componentSourceId` ascending — total, so the same expansion always summarizes identically.
 *
 * TOTALS ARE TRUE TOTALS.
 *   `distinctCount` — every distinct missing part number, from the expander's uncapped id set, so a
 *                     BOM whose missing parts overran the detail cap still reports how many there
 *                     really are rather than the page size.
 *   `probeCount`    — every missing-component probe (one per probe). Counted off the rowErrors, but
 *                     `rowErrors` is a bounded sample once D-C truncated, so the expander's true
 *                     per-type total is preferred whenever it says the array is short — and
 *                     `distinctCount` is a hard floor, because a part cannot be missing without
 *                     having been probed.
 *   `truncated`     — true whenever the items are not the whole set: distinct parts beyond the
 *                     collector's cap, or `limit` cutting the list here. A truncated list is a
 *                     "fix these first, export for the rest" signal, never a total.
 */
function summarizeMissingComponents(expansion = {}, { limit = MISSING_COMPONENT_DETAIL_LIMIT } = {}) {
  const entries = Array.isArray(expansion.missingComponents) ? expansion.missingComponents : []
  const rowErrors = Array.isArray(expansion.rowErrors) ? expansion.rowErrors : []
  const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MISSING_COMPONENT_DETAIL_LIMIT

  const positiveInt = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback)

  const byComponent = new Map()
  let retainedProbes = 0
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue
    const componentSourceId = toKey(entry.componentSourceId)
    if (componentSourceId === null) continue
    // Defensive against a second entry for the same part (the collector never emits one, but this
    // function is also handed hand-built objects): fold rather than shadow.
    const existing = byComponent.get(componentSourceId)
    const occurrenceCount = positiveInt(entry.occurrenceCount, 1)
    retainedProbes += occurrenceCount
    if (existing) {
      existing.occurrenceCount += occurrenceCount
      existing.parentCount = Math.max(existing.parentCount, positiveInt(entry.parentCount, 1))
      continue
    }
    byComponent.set(componentSourceId, {
      componentSourceId,
      parentSourceId: entry.parentSourceId === undefined ? null : entry.parentSourceId,
      bomId: entry.bomId === undefined ? null : entry.bomId,
      path: entry.path === undefined ? null : entry.path,
      depth: Number.isFinite(entry.depth) ? Number(entry.depth) : null,
      occurrenceCount,
      parentCount: positiveInt(entry.parentCount, 1),
    })
  }

  const ranked = [...byComponent.values()].sort((a, b) => {
    if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount
    return a.componentSourceId < b.componentSourceId ? -1 : a.componentSourceId > b.componentSourceId ? 1 : 0
  })

  let probeCount = 0
  for (const rowError of rowErrors) {
    if (isPlainObject(rowError) && rowError.type === 'missing_component') probeCount += 1
  }
  // A caller may hand this function a bare `{ missingComponents }` with no rowErrors and no id count
  // at all (the frontend clamp tests do). Never report fewer than what the details themselves show.
  if (retainedProbes > probeCount) probeCount = retainedProbes
  // D-C. `rowErrors` became a BOUNDED SAMPLE, so counting the array stopped being the same claim as
  // counting the probes — and the undercount is not merely low, it is SELF-CONTRADICTORY: the
  // `distinctCount` below comes off the uncapped id set, so a truncated expansion rendered
  // "5100 parts missing across 5000 references", which is arithmetically impossible (a probe per
  // part, at least). The expander publishes the true per-type total the moment it truncates, and it
  // is the authority here — exactly the discipline `hasHardApplyBlockingRowErrors` follows.
  const summary = isPlainObject(expansion.summary) ? expansion.summary : {}
  if (summary.rowErrorsTruncated === true && isPlainObject(summary.rowErrorTypeCounts)) {
    const trueProbes = Number(summary.rowErrorTypeCounts.missing_component || 0)
    if (Number.isFinite(trueProbes) && trueProbes > probeCount) probeCount = trueProbes
  }
  const distinctCount = Math.max(
    Number.isFinite(expansion.missingComponentDistinctCount) ? Math.floor(expansion.missingComponentDistinctCount) : 0,
    ranked.length,
  )
  // Structural floor, and the last line of defence for the invariant above: every distinct missing
  // part was probed at least once, so `probeCount >= distinctCount` can never be false for real
  // data. Holding it here means no future truncation anywhere upstream can make this pair
  // self-contradictory again, whatever it does to the array.
  if (distinctCount > probeCount) probeCount = distinctCount
  const items = ranked.slice(0, boundedLimit)

  return {
    distinctCount,
    probeCount,
    truncated: distinctCount > items.length,
    items,
  }
}

function summarizeBomExpansionForEvidence(result = {}) {
  const summary = isPlainObject(result.summary) ? result.summary : {}
  const evidence = {
    valid: result.valid === true,
    status: typeof result.status === 'string' ? result.status : summary.status,
    projectNoPresent: summary.projectNoPresent === true,
    matchField: summary.matchField,
    rowsExpanded: Number(summary.rowsExpanded || 0),
    rootMatches: Number(summary.rootMatches || 0),
    maxDepth: summary.maxDepth,
    maxRows: summary.maxRows,
    maxPages: summary.maxPages,
    maxReadCount: summary.maxReadCount,
    maxElapsedMs: summary.maxElapsedMs,
    readObjects: Array.isArray(summary.readObjects) ? summary.readObjects.slice() : [],
    readCount: Number(summary.readCount || 0),
    readDiagnostics: Array.isArray(summary.readDiagnostics) ? summary.readDiagnostics.map(readDiagnostic) : [],
    errorTypes: Array.isArray(summary.errorTypes) ? summary.errorTypes.slice() : [],
    largeBom: isLargeBomBoundedExpansion(result),
    boundedPreview: isLargeBomBoundedExpansion(result) ? boundedPreviewSummary(summary, scaleErrorTypes(result.errors)) : undefined,
    actions: isPlainObject(summary.actions) ? { ...summary.actions } : undefined,
  }
  // Same conditional key as the summary's: absent block => absent key => an evidence object whose
  // key set is byte-identical to the pre-feature one.
  const subtree = subtreeSummaryOf(summary.subtree)
  if (subtree) evidence.subtree = subtree
  // D-C. Same conditional discipline, and values-free by the same argument the summary makes: four
  // integers, a boolean, and type tokens `errorTypes` already publishes. An expansion under the cap
  // mounts nothing, so its evidence stanza is byte-identical to the pre-cap one.
  if (summary.rowErrorsTruncated === true) {
    evidence.rowErrorsTotal = Number(summary.rowErrorsTotal || 0)
    evidence.rowErrorsRetained = Number(summary.rowErrorsRetained || 0)
    evidence.rowErrorsTruncated = true
    evidence.rowErrorTypeCounts = isPlainObject(summary.rowErrorTypeCounts)
      ? { ...summary.rowErrorTypeCounts }
      : {}
  }
  return evidence
}

module.exports = {
  DEFAULT_PAGE_LIMIT,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ROWS,
  LARGE_BOM_BOUNDED_ERROR_TYPES,
  INCOMPLETE_READ_ERROR_TYPES,
  MISSING_COMPONENT_DETAIL_LIMIT,
  ROW_ERROR_LIMIT,
  ROW_ERROR_LIMIT_CEILING,
  READ_CURSOR_BROKEN_ERROR_TYPE,
  SUBTREE_CYCLE_DETECTED_ERROR_TYPE,
  SUBTREE_NODE_LIMIT_EXCEEDED_ERROR_TYPE,
  SUBTREE_ROOT_LIMIT_EXCEEDED_ERROR_TYPE,
  PROJECT_SUBTREE_ERROR_TYPES,
  PROJECT_SUBTREE_LIMITS,
  SUBTREE_ROOT_DEFAULT_QUANTITY,
  FORBIDDEN_PLAN_KEYS,
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  STOCK_PREPARATION_BOM_SOURCE_KINDS,
  DEFAULT_ROOT_SELECTION,
  StockPreparationBomExpansionError,
  normalizeStockPreparationBomReadPlan,
  expandPlmProjectBom,
  isLargeBomBoundedExpansion,
  summarizeBomExpansionForEvidence,
  // Values-BEARING — see its header. Exported separately from the evidence summary so a reader of
  // this list can see at a glance which of the two carries customer values.
  summarizeMissingComponents,
  __internals: {
    isBlank,
    isActiveBomHead,
    matchesByField,
    makeIdempotencyKey,
    makePath,
    parseQuantity,
    readAll,
    readField,
    toKey,
    nonNegativeInteger,
    // The row-production boundary, exposed so a test can pin what a row CARRIES
    // without standing up an adapter and a whole expansion.
    createRow,
    rowFromPart,
    requireNormalizedExtFieldMapping,
    // F1c — 老系统语义的纯函数,单独暴露给测试:根选择、dash 层级判定、版本比较、名称规格切分、
    // 同父去重键。它们不做 IO,所以「老系统这条规则在这里是什么行为」可以不起适配器就钉住。
    normalizeRootSelection,
    selectOrderRootCandidates,
    dashHierarchyRelationship,
    compareSourceVersion,
    splitNameAndSpec,
    siblingDedupeKey,
  },
}
