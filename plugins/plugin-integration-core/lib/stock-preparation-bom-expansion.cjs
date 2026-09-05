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

function makeSummary({ projectNoPresent, matchField, status, rowsExpanded, rootMatches, maxDepth, maxRows, maxPages, maxReadCount, maxElapsedMs, readStats, errors, rowErrors, subtree }) {
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
    errorTypes: Array.from(new Set([...(errors || []), ...(rowErrors || [])].map((entry) => entry.type || entry.code).filter(Boolean))).sort(),
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
    componentName: readField(partRow, 'IdentityName'),
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
  if (!isBlank(spec)) row.spec = spec
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

function failureResult({ projectNoPresent, matchField, status = 'failed', rows, errors, rowErrors, readStats, rootMatches, maxDepth, maxRows, maxPages, maxReadCount, maxElapsedMs, subtree }) {
  return {
    valid: false,
    status,
    rows,
    errors,
    rowErrors,
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
  }
  const readStats = []
  const errors = []
  const rowErrors = []
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
  const addRowError = (error) => {
    rowErrors.push(error)
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
      readStats,
      rootMatches: 0,
      maxDepth: options.maxDepth,
      maxRows: options.maxRows,
      maxPages: options.maxPages,
      maxReadCount: options.maxReadCount,
      maxElapsedMs: options.maxElapsedMs,
      subtree: subtreeCounters,
    })
  }

  if (pathMatches.length === 0) {
    return {
      valid: true,
      status: 'not_found',
      rows: [],
      errors: [],
      rowErrors: [],
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
      }),
    }
  }

  async function readPart(componentSourceId, depth) {
    const matches = await read(plan.part.object, { [plan.part.idField]: componentSourceId })
    const candidates = matchesByField(matches, plan.part.idField, componentSourceId)
    if (candidates.length > 1) {
      addRowError({ type: 'ambiguous_component', field: plan.part.idField, depth })
      return undefined
    }
    const row = candidates[0]
    if (!row) {
      addRowError({ type: 'missing_component', field: plan.part.idField, depth })
      return undefined
    }
    return row
  }

  async function expandChildren(parentRow, pathTokens) {
    if (errors.length > 0) return
    const parentSourceId = parentRow.componentSourceId
    const nextDepth = parentRow.depth + 1
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
        const partRow = await readPart(childSourceId, nextDepth)
        if (!partRow) continue
        const childTokens = pathTokens.concat(childSourceId)
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
          const partRow = await readPart(componentSourceId, 0)
          if (!partRow) continue
          const pathTokens = [componentSourceId]
          const rowResult = rowFromPart(plan, {
            projectNo,
            parentSourceId: null,
            pathTokens,
            depth: 0,
            partRow,
            rawQuantity: qty.value,
            totalQuantity: qty.value,
            active: true,
            sortLine: plan.orderDetail.sortField ? readField(detail, plan.orderDetail.sortField) : undefined,
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
          await expandChildren(rowResult.row, pathTokens)
        }
      }
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
          const partRow = await readPart(rootSourceId, 0)
          if (!partRow) continue
          const pathTokens = [rootSourceId]
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

  const status = errors.length > 0 || rowErrors.length > 0 ? 'failed' : 'expanded'
  return {
    valid: status === 'expanded',
    status,
    rows,
    errors,
    rowErrors,
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
    }),
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
  return evidence
}

module.exports = {
  DEFAULT_PAGE_LIMIT,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ROWS,
  LARGE_BOM_BOUNDED_ERROR_TYPES,
  INCOMPLETE_READ_ERROR_TYPES,
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
  StockPreparationBomExpansionError,
  normalizeStockPreparationBomReadPlan,
  expandPlmProjectBom,
  isLargeBomBoundedExpansion,
  summarizeBomExpansionForEvidence,
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
  },
}
