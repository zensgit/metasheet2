'use strict'

/**
 * 项目目录子树找根桥接 — the OPTIONAL `readPlan.projectSubtree` block.
 *
 * WHAT THE FEATURE IS
 *   The shipped read plan reaches a project's top-level components through the ORDER MODULE
 *   (pathExAttr -> pathInfo -> orderHead -> orderDetail). A deployment whose projects carry their
 *   assemblies on the FOLDER TREE instead — BOM heads hanging off the project's directory nodes —
 *   has no order line to enter through, so the expansion returns zero rows and reports success.
 *   `projectSubtree` adds a SECOND root segment, after the order loop, that walks the folder subtree
 *   and roots the BOM heads it finds.
 *
 * WHAT THIS SUITE IS FOR
 *   The feature was designed, then adversarially reviewed twice, and both reviews REFUTED it. Their
 *   findings became mandatory pre-conditions, and every one of them is a test here that fails if the
 *   guard is removed:
 *
 *   G-01  DEFAULT OFF IS STRUCTURAL   the shipped plan carries no block, and normalization emits no
 *                                     key. Not "we did not configure it" — "there is nothing to
 *                                     configure it from".
 *   G-02  OFF == BYTE-IDENTICAL       with the block absent, a source that CONTAINS folder-tree data
 *                                     yields the same reads (object + filter fields + order), the
 *                                     same rows, and the same summary key set as one that does not.
 *   G-03  ONLY THE SUBTREE CAN ROOT   zero order lines, roots anyway, at depth 0, quantity defaulted
 *                                     to 1, and the defaulting is COUNTED in evidence.
 *   G-04  必修① CLIENT-SIDE RE-FILTER a source that ignores filters and answers with the WHOLE TABLE
 *                                     (`filtersApplied: false`, which `bridge:legacy-sql-readonly`
 *                                     may legally do) must not make the traversal adopt another
 *                                     project's folder nodes or read another project's BOM heads.
 *   G-05  必修② DE-DUP COVERS CHILDREN a part that is already an order root's CHILD and is then found
 *                                     as a subtree root appears ONCE. Two BOM heads on one part_id
 *                                     are ONE root. Both of these, unfixed, are apply-able double
 *                                     writes or a whole-plan hold.
 *   G-06  必修③ THE BUDGET EXISTS      the ceilings are refused at normalization, an enabling plan
 *                                     without `maxReadCount` is refused, and an overrun is a GLOBAL
 *                                     error that is NOT routed to the large-BOM background path.
 *   G-07  CYCLES                       a self-referencing folder node is refused, boundedly.
 *   G-08  ERRORS STOP THE SEGMENT      the order loop failing means the subtree never runs.
 *   G-09  READS THROW INTO A CATCH     a budget overrun inside the subtree becomes a global error,
 *                                     not a rejected promise (which would be a 500, not a refusal).
 *   P-01  PREFLIGHT                    `project-subtree` is declarable, has its own counter-evidence
 *                                     and its own blocker, leaves the two carrier judgements
 *                                     untouched, and does not break the values-free self-check.
 *
 * Hermetic: no database, no network. The source is an in-memory catalog behind the same
 * `read({ object, filters, limit })` seam the real adapters expose.
 */

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  LARGE_BOM_BOUNDED_ERROR_TYPES,
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  PROJECT_SUBTREE_ERROR_TYPES,
  PROJECT_SUBTREE_LIMITS,
  SUBTREE_CYCLE_DETECTED_ERROR_TYPE,
  SUBTREE_NODE_LIMIT_EXCEEDED_ERROR_TYPE,
  SUBTREE_ROOT_LIMIT_EXCEEDED_ERROR_TYPE,
  SUBTREE_ROOT_DEFAULT_QUANTITY,
  expandPlmProjectBom,
  isLargeBomBoundedExpansion,
  normalizeStockPreparationBomReadPlan,
  summarizeBomExpansionForEvidence,
} = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const {
  duplicateExpandedKeyDiagnosticsForRows,
  planStockPreparationConflicts,
} = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  BRIDGE_MIN_LINES,
  DECLARABLE_BRIDGES,
  EXCLUSIVE_CARRIER_BRIDGES,
  SOURCE_PREFLIGHT_BLOCKER_CODES,
  SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER,
  SOURCE_PREFLIGHT_BRIDGES,
  assertSourcePreflightValuesFree,
  runStockPreparationSourcePreflight,
} = require(path.join(LIB, 'stock-preparation-source-preflight.cjs'))

const PROJECT_NO = 'SUB-PROJ-1'
const B = SOURCE_PREFLIGHT_BLOCKER_CODES

// ---------------------------------------------------------------------------
// The plan under test. Shaped exactly as a deployment would configure it, on top of the shipped
// plan — so a drift in the shipped plan shows up here rather than being masked by a private copy.
// ---------------------------------------------------------------------------

function subtreePlan(overrides = {}) {
  return {
    ...PLM_STOCK_PREPARATION_BOM_READ_PLAN,
    maxReadCount: 200,
    ...overrides,
    projectSubtree: {
      pathInfo: { parentIdField: 'Parent_OBJ_ID' },
      bomHead: { pathIdField: 'path_id' },
      ...(overrides.projectSubtree || {}),
    },
  }
}

// ---------------------------------------------------------------------------
// THE IN-MEMORY SOURCE
//
// `filtersApplied: false` is not a fault injection dreamed up for this suite: it is a documented,
// legal answer from the bridge adapter, and the ONLY thing that stands between it and a cross-project
// read is the client-side re-filter this suite pins.
// ---------------------------------------------------------------------------

function createAdapter(catalog, { honourFilters = true, unfilteredObjects = [] } = {}) {
  const calls = []
  // Per-object lying is the sharper instrument: a source that ignores filters on ONE table (the
  // project-entry table, say) is both realistic and the only way to isolate which read a guard
  // actually protects.
  const lying = new Set(unfilteredObjects.map((name) => String(name).toLowerCase()))
  return {
    calls,
    /** `object:field+field` per read, in order — the shape G-02 compares. */
    signature() {
      return calls.map((call) => `${call.object}:${Object.keys(call.filters).sort().join('+')}`)
    },
    async read(input = {}) {
      calls.push({ object: input.object, filters: { ...input.filters } })
      const key = Object.keys(catalog).find(
        (name) => name.toLowerCase() === String(input.object).toLowerCase(),
      )
      const rows = key ? catalog[key] : []
      const applied = honourFilters && !lying.has(String(input.object).toLowerCase())
      const matches = applied
        ? rows.filter((row) => Object.entries(input.filters || {}).every(
          ([field, expected]) => String(row[field] === undefined || row[field] === null ? '' : row[field]) === String(expected),
        ))
        : rows
      return {
        records: matches.slice(0, input.limit || 1000).map((row) => ({ ...row })),
        done: true,
        metadata: {
          source: 'bridge:legacy-sql-readonly',
          filtersApplied: applied,
          filterFields: Object.keys(input.filters || {}).sort(),
        },
      }
    },
  }
}

function part(objId, code) {
  return { OBJ_ID: objId, IdentityNo: code, IdentityName: `name-${objId}`, Material: 'MAT', SysVer: 'V1' }
}

/**
 * The base catalog.
 *
 *   NODE-ROOT                     the project's folder node (from pathExAttr)
 *   └── NODE-CHILD                depth 1
 *   FOREIGN-NODE                  belongs to ANOTHER project — the cross-project probe of G-04
 *
 * Order module: one head, one line -> ORDER-ROOT (qty 2), whose BOM contains SHARED-PART.
 * Folder tree: SUBTREE-ROOT hangs off NODE-CHILD. FOREIGN-ROOT hangs off FOREIGN-NODE.
 */
function baseCatalog(overrides = {}) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: PROJECT_NO, Parent_OBJ_ID: 'NODE-ROOT' }],
    DN_PDM_PathInfo: [
      { OBJ_ID: 'NODE-ROOT', Parent_OBJ_ID: null },
      { OBJ_ID: 'NODE-CHILD', Parent_OBJ_ID: 'NODE-ROOT' },
      { OBJ_ID: 'FOREIGN-NODE', Parent_OBJ_ID: 'OTHER-PROJECT-NODE' },
    ],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'NODE-ROOT' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'ORDER-ROOT', quantity: 2, sort_id: 10 }],
    DN_PDM_PartLibraryInfo: [
      part('ORDER-ROOT', 'C-ORDER-ROOT'),
      part('SHARED-PART', 'C-SHARED'),
      part('SUBTREE-ROOT', 'C-SUBTREE-ROOT'),
      part('SUBTREE-LEAF', 'C-SUBTREE-LEAF'),
      part('FOREIGN-ROOT', 'C-FOREIGN-ROOT'),
    ],
    DN_PDM_BomHeadInfo: [
      { part_id: 'ORDER-ROOT', bom_id: 'BOM-ORDER', SysVer: 'V1', bom_able: '1', path_id: null },
      { part_id: 'SUBTREE-ROOT', bom_id: 'BOM-SUBTREE', SysVer: 'V1', bom_able: '1', path_id: 'NODE-CHILD' },
      { part_id: 'FOREIGN-ROOT', bom_id: 'BOM-FOREIGN', SysVer: 'V1', bom_able: '1', path_id: 'FOREIGN-NODE' },
    ],
    DN_PDM_BomDetailsInfo: [
      { bom_pid: 'BOM-ORDER', part_id: 'SHARED-PART', Bom_ExAttr1: 3, sort_id: 10 },
      { bom_pid: 'BOM-SUBTREE', part_id: 'SUBTREE-LEAF', Bom_ExAttr1: 4, sort_id: 10 },
      { bom_pid: 'BOM-FOREIGN', part_id: 'SHARED-PART', Bom_ExAttr1: 9, sort_id: 10 },
    ],
    ...overrides,
  }
}

/** The same catalog with every trace of the folder tree removed — G-02's control. */
function catalogWithoutSubtreeData() {
  const catalog = baseCatalog()
  catalog.DN_PDM_PathInfo = [{ OBJ_ID: 'NODE-ROOT', Parent_OBJ_ID: null }]
  catalog.DN_PDM_BomHeadInfo = catalog.DN_PDM_BomHeadInfo
    .filter((head) => head.path_id === null)
    .map((head) => {
      const copy = { ...head }
      delete copy.path_id
      return copy
    })
  catalog.DN_PDM_BomDetailsInfo = catalog.DN_PDM_BomDetailsInfo.filter((line) => line.bom_pid === 'BOM-ORDER')
  return catalog
}

async function expand(catalog, { readPlan, honourFilters = true, unfilteredObjects, ...rest } = {}) {
  const adapter = createAdapter(catalog, { honourFilters, unfilteredObjects })
  const result = await expandPlmProjectBom({
    sourceAdapter: adapter,
    projectNo: PROJECT_NO,
    ...(readPlan ? { readPlan } : {}),
    ...rest,
  })
  return { result, adapter }
}

function componentIds(result) {
  return result.rows.map((row) => row.componentSourceId)
}

function errorTypes(result) {
  return result.errors.map((entry) => entry.type)
}

// ---------------------------------------------------------------------------
// G-01 / G-02 — off is structural, and off costs nothing
// ---------------------------------------------------------------------------

async function offIsStructural() {
  const shipped = normalizeStockPreparationBomReadPlan(PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  assert.equal(
    shipped.projectSubtree,
    undefined,
    'the SHIPPED plan must not carry projectSubtree — absence is what makes "off" a guarantee',
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(shipped, 'projectSubtree'),
    false,
    'and the key must be ABSENT, not present-and-undefined: consumers enumerate keys',
  )
  // The normalizer of an ARBITRARY plan without the block is equally silent, so "off" does not
  // depend on going through the shipped constant.
  const custom = normalizeStockPreparationBomReadPlan({ ...PLM_STOCK_PREPARATION_BOM_READ_PLAN, maxReadCount: 50 })
  assert.equal(custom.projectSubtree, undefined)
  assert.equal(custom.maxReadCount, 50, 'a plan-level read budget stands on its own, block or no block')
}

async function offIsByteIdentical() {
  // The SAME default plan over two catalogs: one carrying folder nodes, folder-node columns and a
  // whole second BOM tree; one carrying none of it. Off, the two runs must be indistinguishable.
  const withData = await expand(baseCatalog())
  const withoutData = await expand(catalogWithoutSubtreeData())

  assert.deepEqual(
    withData.adapter.signature(),
    withoutData.adapter.signature(),
    'the read sequence (object + filter fields + order) must be identical while the block is off',
  )
  assert.deepEqual(
    withData.result.rows,
    withoutData.result.rows,
    'the rows must be identical, field for field, while the block is off',
  )
  assert.deepEqual(
    Object.keys(withData.result.summary),
    Object.keys(withoutData.result.summary),
    'the summary key set must be identical while the block is off',
  )
  assert.equal(withData.result.summary.subtree, undefined, 'no counter key appears while the block is off')
  assert.equal(
    summarizeBomExpansionForEvidence(withData.result).subtree,
    undefined,
    'and none appears in the evidence projection either',
  )

  // The rows really are the order path's, so the comparison above is not vacuous.
  assert.deepEqual(componentIds(withData.result), ['ORDER-ROOT', 'SHARED-PART'])
  assert.equal(withData.result.status, 'expanded')

  // Turning it ON over the SAME catalog changes the answer — otherwise the equality above would
  // prove only that the fixture is inert.
  const on = await expand(baseCatalog(), { readPlan: subtreePlan() })
  assert.notDeepEqual(componentIds(on.result), componentIds(withData.result))
  assert.ok(Object.keys(on.result.summary).includes('subtree'))
}

// ---------------------------------------------------------------------------
// G-03 — only the subtree can produce a root
// ---------------------------------------------------------------------------

async function onlyTheSubtreeCanRoot() {
  // No order head, no order line: the order path can produce nothing at all.
  const catalog = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })
  const { result } = await expand(catalog, { readPlan: subtreePlan() })

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.rowErrors, [])
  assert.equal(result.status, 'expanded')
  assert.deepEqual(componentIds(result), ['SUBTREE-ROOT', 'SUBTREE-LEAF'])

  const root = result.rows[0]
  assert.equal(root.depth, 0)
  assert.equal(root.parentSourceId, null)
  assert.equal(root.rawQuantity, SUBTREE_ROOT_DEFAULT_QUANTITY)
  assert.equal(root.totalQuantity, SUBTREE_ROOT_DEFAULT_QUANTITY)
  assert.equal(result.rows[1].totalQuantity, 4, 'the defaulted 1 is a NEUTRAL multiplier, not a scaling one')

  assert.deepEqual(result.summary.subtree, {
    nodesVisited: 2,
    nodesSkippedAlreadyVisited: 0,
    rootsDiscovered: 1,
    rootsExpanded: 1,
    rootsSkippedAlreadyExpanded: 0,
    rootsWithoutChildren: 0,
    // THE HONEST HALF: the row's `1` is byte-identical to a measured `1`, so the only place the
    // provenance survives is this count. A consumer treating those rows as procurement quantities
    // has to read it.
    rootQuantitySource: { orderDetail: 0, subtreeDefault: 1 },
  })
  assert.deepEqual(
    summarizeBomExpansionForEvidence(result).subtree,
    result.summary.subtree,
    'evidence carries the same counts, not a re-derived set',
  )

  // `includeSelf: false` skips the project node's own heads and costs one read less.
  const noSelf = await expand(catalog, {
    readPlan: subtreePlan({ projectSubtree: { includeSelf: false } }),
  })
  assert.equal(noSelf.result.summary.subtree.rootsDiscovered, 1, 'the depth-1 root is still found')
  assert.ok(
    noSelf.result.summary.readCount < result.summary.readCount,
    'and the project node`s own bomHead read is genuinely skipped',
  )

  // A root whose current head is on a DIFFERENT SysVer than its part gets no children — and that is
  // counted rather than passing for a leaf.
  const bare = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })
  bare.DN_PDM_BomHeadInfo = bare.DN_PDM_BomHeadInfo.map((head) => (
    head.bom_id === 'BOM-SUBTREE' ? { ...head, SysVer: 'V9' } : head
  ))
  const bareRun = await expand(bare, { readPlan: subtreePlan() })
  assert.deepEqual(componentIds(bareRun.result), ['SUBTREE-ROOT'])
  assert.equal(bareRun.result.summary.subtree.rootsWithoutChildren, 1)
}

// ---------------------------------------------------------------------------
// G-04 (必修①) — a source that ignores filters must not widen the traversal
// ---------------------------------------------------------------------------

async function ignoredFiltersCannotWidenTheTraversal() {
  // The order module is emptied so the ONLY thing under test is the subtree segment.
  const catalog = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })

  // Control: with filters honoured, this catalog yields exactly the project's own root.
  const honoured = await expand(catalog, { readPlan: subtreePlan() })
  assert.deepEqual(componentIds(honoured.result), ['SUBTREE-ROOT', 'SUBTREE-LEAF'])

  // The breach attempt: EVERY read comes back as the whole table, `filtersApplied: false` — a legal
  // answer from `bridge:legacy-sql-readonly`. Without the client-side re-filter, the first hop takes
  // FOREIGN-NODE for a child of this project and its BOM head for this project's root.
  const ignored = await expand(catalog, { readPlan: subtreePlan(), honourFilters: false })

  // WHAT IS PINNED HERE, precisely: the ROOT SET, against a source that lies on EVERY table. The
  // two reads this feature introduces — folder children and heads-by-folder-node — are both
  // re-filtered, so an unfiltered source cannot add a single ROOT beyond the ones the filtered
  // source produced.
  //
  // NOTE ON COVERAGE: this fixture's project-entry table holds ONE row, so it cannot by itself
  // demonstrate anything about the SEED. `foreignProjectRowsCannotSeedTheTraversal` below is the
  // test that does, with a two-row entry table — without it, this assertion would pass on a build
  // whose seeds were never filtered at all.
  //
  // WHAT IS NOT PINNED, and deliberately: what `expandChildren` does under an unfiltered source. It
  // re-reads bomHead/bomDetail WITHOUT a client-side re-filter, and it has always done so — the
  // ORDER path runs through the identical code and has the identical exposure today. That is a
  // pre-existing, shared property of child expansion, not something root discovery introduces, and
  // fixing it belongs in its own change with its own regressions rather than being smuggled in here.
  const rootsOf = (result) => result.rows.filter((row) => row.depth === 0).map((row) => row.componentSourceId)
  assert.deepEqual(
    rootsOf(ignored.result),
    rootsOf(honoured.result),
    'an unfiltered source must not add ONE root the filtered source did not produce',
  )
  assert.deepEqual(rootsOf(ignored.result), ['SUBTREE-ROOT'])
  assert.equal(
    ignored.result.summary.subtree.rootsDiscovered,
    1,
    'root discovery must absorb only heads whose path_id really matches a node of THIS project',
  )
  assert.equal(
    ignored.result.rows.some((row) => row.depth === 0 && row.componentSourceId === 'FOREIGN-ROOT'),
    false,
    'another project`s BOM head must never become this project`s root',
  )

  // Not just "the rows came out right" — the traversal must never have GONE there. A read for
  // FOREIGN-NODE's heads is itself the breach, whatever it returns.
  const filterValues = ignored.adapter.calls
    .filter((call) => call.object === PLM_STOCK_PREPARATION_BOM_READ_PLAN.bomHead.object)
    .map((call) => call.filters.path_id)
  assert.deepEqual(
    filterValues.filter((value) => value !== undefined).sort(),
    ['NODE-CHILD', 'NODE-ROOT'],
    'the only folder nodes whose BOM heads are read are the project`s own',
  )
  assert.equal(
    ignored.adapter.calls.some((call) => call.filters.Parent_OBJ_ID === 'FOREIGN-NODE'),
    false,
    'and the traversal never descends into a node that is not a descendant of the project node',
  )

  // The diagnostics say the source ignored the filters, so the re-filter is visible rather than
  // silently compensating.
  assert.ok(
    ignored.result.summary.readDiagnostics.some((entry) => entry.filtersApplied === false),
    'the run must still REPORT that the source did not apply the filters',
  )
}

/**
 * G-10 — THE SEED IS THE SAME HOLE ONE LEVEL UP.
 *
 * The project-entry read (`pathExAttr` filtered by the project number) was the ONE filtered read in
 * this module whose result was believed without `matchesByField`. Its rows ARE the project: they
 * feed the order loop's folder-node lookups and they seed the subtree BFS. A source that ignores
 * filters on THAT ONE TABLE — and honours them everywhere else, which is why a
 * lie-about-everything fixture never surfaced it — hands back every project's entry row, and both
 * root segments then walk another project's directory under this project's authorization.
 *
 * The failure it produced was the worst-shaped kind available: `status: 'expanded'`,
 * `valid: true`, `errors: []`. A clean bill of health on cross-project data.
 */
async function foreignProjectRowsCannotSeedTheTraversal() {
  const catalog = baseCatalog()
  // A SECOND project's entry row, pointing at a folder node that is no descendant of ours.
  catalog.DN_PDM_PathExAttrInfo = [
    { FileCode: PROJECT_NO, Parent_OBJ_ID: 'NODE-ROOT' },
    { FileCode: 'OTHER-PROJ-9', Parent_OBJ_ID: 'FOREIGN-NODE' },
  ]
  // …and an order module hanging off that foreign node, so a breach would show up as ROWS and not
  // merely as reads. FOREIGN-ROOT already carries a BOM head on FOREIGN-NODE (see baseCatalog).
  catalog.DN_PDM_OrderHeadInfo = [
    ...catalog.DN_PDM_OrderHeadInfo,
    { OBJ_ID: 'ORDER-FOREIGN', path_id: 'FOREIGN-NODE' },
  ]
  catalog.DN_PDM_OrderDetailInfo = [
    ...catalog.DN_PDM_OrderDetailInfo,
    { order_id: 'ORDER-FOREIGN', part_id: 'FOREIGN-ROOT', quantity: 7, sort_id: 10 },
  ]

  // The lie is scoped to the entry table alone.
  const lying = { unfilteredObjects: [PLM_STOCK_PREPARATION_BOM_READ_PLAN.pathExAttr.object] }
  const honest = await expand(catalog, { readPlan: subtreePlan() })
  const lied = await expand(catalog, { readPlan: subtreePlan(), ...lying })

  assert.deepEqual(lied.result.errors, [])
  assert.deepEqual(lied.result.rowErrors, [])
  assert.deepEqual(
    componentIds(lied.result),
    componentIds(honest.result),
    'a lying project-entry read must not add one row',
  )
  assert.equal(
    lied.result.rows.some((row) => row.componentSourceId === 'FOREIGN-ROOT'),
    false,
    'another project`s root must never land as this project`s row',
  )
  assert.equal(lied.result.summary.rootMatches, 1, 'rootMatches counts the project`s OWN entry rows')
  assert.equal(lied.result.summary.subtree.rootsDiscovered, 1)

  // Neither segment may even LOOK at the foreign node. A read issued is the breach, whatever it
  // returns — the ORDER path is checked here too, because the filter that closes this sits on the
  // shared entry read and closes the identical hole on the order side.
  const foreignReads = lied.adapter.calls.filter((call) => (
    call.filters.path_id === 'FOREIGN-NODE'
    || call.filters.Parent_OBJ_ID === 'FOREIGN-NODE'
    || call.filters.OBJ_ID === 'FOREIGN-NODE'
  ))
  assert.deepEqual(foreignReads, [], 'no read may name a folder node belonging to another project')
  assert.equal(
    lied.adapter.calls.some((call) => call.filters.order_id === 'ORDER-FOREIGN'),
    false,
    'and the ORDER path must not reach another project`s order head either',
  )

  // THE ORDER PATH ALONE, block absent — the pre-existing hole this filter also closes. Without the
  // fix this run pulls FOREIGN-ROOT in and reports `expanded` / `valid: true` / no errors.
  const orderOnly = await expand(catalog, { ...lying })
  assert.equal(orderOnly.result.status, 'expanded')
  assert.deepEqual(orderOnly.result.errors, [])
  assert.deepEqual(
    componentIds(orderOnly.result),
    ['ORDER-ROOT', 'SHARED-PART'],
    'the default (subtree-off) plan must not absorb another project`s order lines either',
  )
  assert.equal(orderOnly.result.summary.rootMatches, 1)

  // The diagnostics still SAY the source ignored the filters — the guard compensates, it does not
  // conceal.
  assert.ok(lied.result.summary.readDiagnostics.some((entry) => entry.filtersApplied === false))
}

// ---------------------------------------------------------------------------
// G-05 (必修②) — de-duplication covers every expanded component, and heads collapse per part
// ---------------------------------------------------------------------------

async function deduplicationCoversChildrenNotJustRoots() {
  // SHARED-PART is a CHILD of the order root, and also has a BOM head on the project's folder tree.
  // Its two idempotency keys would be {P,SHARED,"ORDER-ROOT",[…]} and {P,SHARED,null,["SHARED"]} —
  // DIFFERENT, so the conflict planner cannot even see them as related and the whole sub-tree would
  // land twice with two different totals, apply-ably.
  const catalog = baseCatalog()
  catalog.DN_PDM_BomHeadInfo = [
    // The order root's own head also sits on the folder tree — so it is discovered as a subtree root
    // as well as being an order root.
    ...catalog.DN_PDM_BomHeadInfo.map((head) => (
      head.bom_id === 'BOM-ORDER' ? { ...head, path_id: 'NODE-CHILD' } : head
    )),
    // SHARED-PART's own (superseded) head on the folder tree. `SysVer: 'V0'` so the CHILD read
    // (part_id + SysVer) does not return it — this head exists only to make SHARED-PART discoverable
    // as a ROOT, which is precisely the collision the registry has to absorb.
    { part_id: 'SHARED-PART', bom_id: 'BOM-SHARED-V0', SysVer: 'V0', bom_able: '1', path_id: 'NODE-CHILD' },
  ]

  const { result } = await expand(catalog, { readPlan: subtreePlan() })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.rowErrors, [])

  const occurrences = componentIds(result).filter((id) => id === 'SHARED-PART')
  assert.equal(occurrences.length, 1, 'a part already expanded as a CHILD must not be re-rooted')
  assert.deepEqual(componentIds(result), ['ORDER-ROOT', 'SHARED-PART', 'SUBTREE-ROOT', 'SUBTREE-LEAF'])

  // ORDER-ROOT is skipped as an order ROOT; SHARED-PART is skipped as an already-expanded CHILD.
  // A registry that only held roots would have caught the first and missed the second.
  assert.equal(result.summary.subtree.rootsDiscovered, 3)
  assert.equal(result.summary.subtree.rootsSkippedAlreadyExpanded, 2)
  assert.equal(result.summary.subtree.rootsExpanded, 1)
  assert.deepEqual(result.summary.subtree.rootQuantitySource, { orderDetail: 1, subtreeDefault: 1 })

  // Pinned on the CONTRACT, not on reasoning about keys.
  assert.equal(duplicateExpandedKeyDiagnosticsForRows(result.rows), undefined)
  const plan = planStockPreparationConflicts({
    template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    expandedRows: result.rows,
    existingRows: [],
    runId: 'subtree-run-1',
    plannedAt: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(plan.valid, true)
  assert.equal(plan.counts.manual_confirm, 0)
}

async function twoHeadsOnOnePartAreOneRoot() {
  // The measured customer shape: one part carrying two BOM heads. Two roots would carry
  // BYTE-IDENTICAL idempotency keys -> the planner groups them -> `duplicate_expanded_key` ->
  // defaultPolicy 'hold' -> the whole plan becomes manual_confirm and NOTHING can be applied.
  const catalog = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })
  catalog.DN_PDM_BomHeadInfo = [
    ...catalog.DN_PDM_BomHeadInfo,
    // Same part, same folder node, DIFFERENT bom_id and a superseded version — so root discovery
    // (which filters on path_id only) really does see two heads, while the child read (which filters
    // on part_id AND SysVer) still sees one.
    { part_id: 'SUBTREE-ROOT', bom_id: 'BOM-SUBTREE-V0', SysVer: 'V0', bom_able: '1', path_id: 'NODE-CHILD' },
  ]

  const { result } = await expand(catalog, { readPlan: subtreePlan() })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.rowErrors, [])
  assert.equal(result.summary.subtree.rootsDiscovered, 1, 'two heads, one part_id, ONE root')
  assert.deepEqual(componentIds(result), ['SUBTREE-ROOT', 'SUBTREE-LEAF'])
  assert.equal(duplicateExpandedKeyDiagnosticsForRows(result.rows), undefined)

  // An INACTIVE head on the folder tree contributes no root at all.
  const retired = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })
  retired.DN_PDM_BomHeadInfo = retired.DN_PDM_BomHeadInfo.map((head) => (
    head.bom_id === 'BOM-SUBTREE' ? { ...head, bom_able: '0' } : head
  ))
  const retiredRun = await expand(retired, { readPlan: subtreePlan() })
  assert.equal(retiredRun.result.summary.subtree.rootsDiscovered, 0)
  assert.deepEqual(retiredRun.result.rows, [])
}

// ---------------------------------------------------------------------------
// G-06 (必修③) — the budget and the ceilings are real
// ---------------------------------------------------------------------------

async function theBudgetAndCeilingsAreEnforcedAtNormalization() {
  // No read budget on the plan -> the block is refused OUTRIGHT. `maxReadCount` is optional on the
  // expansion and unset on the measured deployment, and `maxPages` counts pages within ONE readAll,
  // so without this the subtree would have run with no read ceiling whatsoever.
  assert.throws(
    () => normalizeStockPreparationBomReadPlan({
      ...PLM_STOCK_PREPARATION_BOM_READ_PLAN,
      projectSubtree: { pathInfo: { parentIdField: 'Parent_OBJ_ID' }, bomHead: { pathIdField: 'path_id' } },
    }),
    (error) => error.details && error.details.reason === 'PROJECT_SUBTREE_REQUIRES_READ_BUDGET',
    'enabling the block without a plan-level maxReadCount must be refused',
  )

  // The ceilings are CODE, not advice. Each is refused one past its limit and accepted at it.
  const ceilings = [
    ['maxSubtreeDepth', PROJECT_SUBTREE_LIMITS.MAX_SUBTREE_DEPTH_CEILING],
    ['maxSubtreeNodes', PROJECT_SUBTREE_LIMITS.MAX_SUBTREE_NODES_CEILING],
    ['maxSubtreeRoots', PROJECT_SUBTREE_LIMITS.MAX_SUBTREE_ROOTS_CEILING],
  ]
  for (const [field, ceiling] of ceilings) {
    assert.throws(
      () => normalizeStockPreparationBomReadPlan(subtreePlan({ projectSubtree: { [field]: ceiling + 1 } })),
      (error) => error.details && error.details.field === `readPlan.projectSubtree.${field}`,
      `${field} above its ceiling must be refused at normalization`,
    )
    assert.equal(
      normalizeStockPreparationBomReadPlan(subtreePlan({ projectSubtree: { [field]: ceiling } }))
        .projectSubtree[field],
      ceiling,
      `${field} AT its ceiling must be accepted — the refusal is a ceiling, not an off-by-one`,
    )
    // NO COERCION. These three are read budgets, and `Number(true) === 1` / `Number([3]) === 3`
    // would let a malformed config pass as a deliberate one. The plan arrives as JSON, so a real
    // number is always expressible and nothing legitimate is refused here.
    for (const bogus of [true, [3], '3', { valueOf: () => 3 }, 3.5]) {
      assert.throws(
        () => normalizeStockPreparationBomReadPlan(subtreePlan({ projectSubtree: { [field]: bogus } })),
        (error) => error.details && error.details.field === `readPlan.projectSubtree.${field}`,
        `${field} = ${JSON.stringify(bogus)} must be refused, not coerced`,
      )
    }
  }

  // Required members are required; the forbidden-key sweep reaches inside the new block.
  assert.throws(
    () => normalizeStockPreparationBomReadPlan(subtreePlan({ projectSubtree: { pathInfo: {} } })),
    /projectSubtree\.pathInfo\.parentIdField/,
  )
  assert.throws(
    () => normalizeStockPreparationBomReadPlan(subtreePlan({
      projectSubtree: { pathInfo: { parentIdField: 'Parent_OBJ_ID', where: 'x = 1' } },
    })),
    /must not carry where/,
  )
  // Defaults, pinned — a silent change to any of them changes how much of a customer's PLM one
  // click reads.
  const defaults = normalizeStockPreparationBomReadPlan(subtreePlan()).projectSubtree
  assert.equal(defaults.maxSubtreeDepth, PROJECT_SUBTREE_LIMITS.DEFAULT_MAX_SUBTREE_DEPTH)
  assert.equal(defaults.maxSubtreeNodes, PROJECT_SUBTREE_LIMITS.DEFAULT_MAX_SUBTREE_NODES)
  assert.equal(defaults.maxSubtreeRoots, PROJECT_SUBTREE_LIMITS.DEFAULT_MAX_SUBTREE_ROOTS)
  assert.equal(defaults.includeSelf, true)
}

async function overrunsAreGlobalFailuresNotBackgroundJobs() {
  const catalog = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })

  // NODE LIMIT: one node allowed, two to visit.
  const nodes = await expand(catalog, { readPlan: subtreePlan({ projectSubtree: { maxSubtreeNodes: 1 } }) })
  assert.deepEqual(errorTypes(nodes.result), [SUBTREE_NODE_LIMIT_EXCEEDED_ERROR_TYPE])

  // ROOT LIMIT: two distinct root parts on the project's folder tree, one allowed.
  const twoRoots = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })
  twoRoots.DN_PDM_BomHeadInfo = twoRoots.DN_PDM_BomHeadInfo.map((head) => (
    head.bom_id === 'BOM-ORDER' ? { ...head, path_id: 'NODE-CHILD' } : head
  ))
  const roots = await expand(twoRoots, { readPlan: subtreePlan({ projectSubtree: { maxSubtreeRoots: 1 } }) })
  assert.deepEqual(errorTypes(roots.result), [SUBTREE_ROOT_LIMIT_EXCEEDED_ERROR_TYPE])

  for (const run of [nodes.result, roots.result]) {
    // GLOBAL, not rowError. The conflict planner's missingFromPlm policy is pinned to
    // `mark_inactive`, so a HALF-DISCOVERED root set that "succeeded" would mark the missing half of
    // last pull's rows invalid. Failing closed is the only safe posture.
    assert.deepEqual(run.rowErrors, [], 'a truncated traversal is never reported per-row')
    assert.equal(run.status, 'failed')
    assert.equal(run.valid, false)
    // NOT the large-BOM background route: that path tells an operator to retry the read, and this
    // read will hit the identical structural ceiling every time.
    assert.equal(isLargeBomBoundedExpansion(run), false)
    assert.equal(summarizeBomExpansionForEvidence(run).largeBom, false)
    for (const type of errorTypes(run)) {
      assert.equal(LARGE_BOM_BOUNDED_ERROR_TYPES.includes(type), false)
      assert.ok(PROJECT_SUBTREE_ERROR_TYPES.includes(type))
    }
  }
}

async function aBudgetOverrunInsideTheSubtreeIsCaught() {
  // The order loop is wrapped in try/catch; a subtree read that blows the budget must be too. If it
  // were not, `expandPlmProjectBom` would REJECT and the route would answer 500 — not the
  // `status: failed` / `canApply: false` this design rests on.
  const catalog = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })
  const { result } = await expand(catalog, { readPlan: subtreePlan({ maxReadCount: 3 }) })

  assert.deepEqual(errorTypes(result), ['read_count_exceeded'])
  assert.equal(result.status, 'failed')
  assert.equal(result.valid, false)
  assert.ok(result.summary.subtree, 'the counters are still reported for an enabled, failed run')
  assert.equal(result.summary.maxReadCount, 3, 'the PLAN`s budget is the one that applied')
}

// ---------------------------------------------------------------------------
// G-07 / G-08 — cycles, and errors stopping the segment
// ---------------------------------------------------------------------------

/**
 * G-11 — A RE-VISIT IS NOT A LOOP.
 *
 * Refusing every second arrival at a node treats three different situations as one, and two of them
 * are ordinary:
 *
 *   (a) a project whose entry table names BOTH a folder node and one of its descendants — a normal
 *       directory shape. Under a seen-set seeded with every seed, the descendant seed is "already
 *       seen" the moment its ancestor's child read returns it, and the whole pull dies:
 *       `subtree_cycle_detected` is a GLOBAL error, so the ALREADY-COMPLETED order path goes down
 *       with it.
 *   (b) a DAG-shaped directory where two folders share a child.
 *   (c) an actual loop: a node that is its own ancestor.
 *
 * Only (c) cannot terminate, and only (c) is refused. (a) and (b) are skipped and counted.
 */
async function ancestorSeedsAndDagMergesAreSkippedNotRefused() {
  // (a) TWO SEEDS, one the other's descendant.
  const ancestorSeeds = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })
  ancestorSeeds.DN_PDM_PathExAttrInfo = [
    { FileCode: PROJECT_NO, Parent_OBJ_ID: 'NODE-ROOT' },
    { FileCode: PROJECT_NO, Parent_OBJ_ID: 'NODE-CHILD' },
  ]
  const seeds = await expand(ancestorSeeds, { readPlan: subtreePlan() })

  assert.deepEqual(seeds.result.errors, [], 'an ancestor/descendant seed pair is a directory, not a fault')
  assert.deepEqual(seeds.result.rowErrors, [])
  assert.equal(seeds.result.status, 'expanded')
  assert.deepEqual(componentIds(seeds.result), ['SUBTREE-ROOT', 'SUBTREE-LEAF'], 'and the roots still come out')
  assert.equal(seeds.result.summary.subtree.nodesVisited, 2)
  assert.equal(seeds.result.summary.subtree.nodesSkippedAlreadyVisited, 1)
  assert.equal(seeds.result.summary.subtree.rootsDiscovered, 1, 'the shared node`s heads are collected ONCE')

  // (b) DAG MERGE: two folders, one shared child.
  const dag = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })
  dag.DN_PDM_PathInfo = [
    { OBJ_ID: 'NODE-ROOT', Parent_OBJ_ID: null },
    { OBJ_ID: 'NODE-A', Parent_OBJ_ID: 'NODE-ROOT' },
    { OBJ_ID: 'NODE-B', Parent_OBJ_ID: 'NODE-ROOT' },
    // Reached from BOTH NODE-A and NODE-B.
    { OBJ_ID: 'NODE-CHILD', Parent_OBJ_ID: 'NODE-A' },
    { OBJ_ID: 'NODE-CHILD', Parent_OBJ_ID: 'NODE-B' },
  ]
  const merged = await expand(dag, {
    readPlan: subtreePlan({ projectSubtree: { maxSubtreeDepth: 2 } }),
  })

  assert.deepEqual(merged.result.errors, [], 'a DAG-shaped directory is traversed, not refused')
  assert.deepEqual(componentIds(merged.result), ['SUBTREE-ROOT', 'SUBTREE-LEAF'])
  assert.equal(merged.result.summary.subtree.nodesSkippedAlreadyVisited, 1)
  assert.equal(merged.result.summary.subtree.rootsDiscovered, 1)
}

async function aFolderCycleIsRefusedBoundedly() {
  const catalog = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })
  // The project node names ITSELF as its parent.
  catalog.DN_PDM_PathInfo = [
    { OBJ_ID: 'NODE-ROOT', Parent_OBJ_ID: 'NODE-ROOT' },
    { OBJ_ID: 'NODE-CHILD', Parent_OBJ_ID: 'NODE-ROOT' },
  ]

  const { result } = await expand(catalog, { readPlan: subtreePlan() })
  assert.deepEqual(errorTypes(result), [SUBTREE_CYCLE_DETECTED_ERROR_TYPE])
  assert.equal(result.status, 'failed')
  assert.equal(isLargeBomBoundedExpansion(result), false)
  assert.ok(result.summary.readCount < 10, 'the traversal stops rather than looping: reads stay bounded')

  // A LONGER loop — A -> B -> A — is caught by the same ancestor test, which is the point of
  // carrying the chain rather than a single parent.
  const twoStep = baseCatalog({ DN_PDM_OrderHeadInfo: [], DN_PDM_OrderDetailInfo: [] })
  twoStep.DN_PDM_PathInfo = [
    { OBJ_ID: 'NODE-ROOT', Parent_OBJ_ID: 'NODE-CHILD' },
    { OBJ_ID: 'NODE-CHILD', Parent_OBJ_ID: 'NODE-ROOT' },
  ]
  const looped = await expand(twoStep, {
    readPlan: subtreePlan({ projectSubtree: { maxSubtreeDepth: 2 } }),
  })
  assert.deepEqual(errorTypes(looped.result), [SUBTREE_CYCLE_DETECTED_ERROR_TYPE])
  assert.equal(looped.result.valid, false)
  assert.ok(looped.result.summary.readCount < 12)
}

async function anAlreadyFailedRunNeverStartsTheSegment() {
  // The order loop fails on max_rows_exceeded. The subtree segment must not run: it would burn read
  // budget and re-push the same global error once per remaining root.
  const { result, adapter } = await expand(baseCatalog(), { readPlan: subtreePlan(), maxRows: 1 })

  assert.ok(errorTypes(result).includes('max_rows_exceeded'))
  assert.equal(
    errorTypes(result).filter((type) => type === 'max_rows_exceeded').length,
    1,
    'the global error is pushed once, not once per remaining root',
  )
  assert.deepEqual(result.summary.subtree, {
    nodesVisited: 0,
    nodesSkippedAlreadyVisited: 0,
    rootsDiscovered: 0,
    rootsExpanded: 0,
    rootsSkippedAlreadyExpanded: 0,
    rootsWithoutChildren: 0,
    // The order path DID produce a root before it hit the row ceiling, and the count says so.
    // Deriving this from `rows` inside the subtree segment would report 0 here, because the segment
    // never runs on this path — the one number this counter exists to get right.
    rootQuantitySource: { orderDetail: 1, subtreeDefault: 0 },
  })
  // The two reads only the subtree segment ever issues. (`path_id` alone would not do: the ORDER
  // path filters orderHead by a column of the same name.)
  const subtreeReads = adapter.calls.filter((call) => (
    (call.object === PLM_STOCK_PREPARATION_BOM_READ_PLAN.bomHead.object && call.filters.path_id !== undefined)
    || (call.object === PLM_STOCK_PREPARATION_BOM_READ_PLAN.pathInfo.object && call.filters.Parent_OBJ_ID !== undefined)
  ))
  assert.deepEqual(
    subtreeReads,
    [],
    'not one folder-tree read is issued after the order path has already failed',
  )
}

// ---------------------------------------------------------------------------
// P-01 — the preflight axis
// ---------------------------------------------------------------------------

const PREFLIGHT_TENANT_SYSTEM = 'plm_sql_source'

function preflightPart(index) {
  return {
    OBJ_ID: `PART-${index}`,
    IdentityNo: `DWG-${1000 + index}`,
    IdentityName: `part-${index}`,
    Material: 'Q235',
    SysVer: 'V1',
  }
}

/**
 * A healthy ORDER-MODULE catalog whose BOM heads ALSO carry a populated folder-node column — i.e. a
 * source where the carrier question and the root-discovery question have different answers, which is
 * exactly the shape that makes the two axes worth separating.
 */
function preflightCatalog({ pathIdOnHeads = true, populatedHeads = 3 } = {}) {
  return {
    DN_PDM_PathExAttrInfo: [
      { FileCode: 'PRJ-2600', Parent_OBJ_ID: 'PATH-1', NodeType: 2 },
      { FileCode: 'PRJ-2601', Parent_OBJ_ID: 'PATH-2', NodeType: 1 },
    ],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1', Parent_OBJ_ID: null }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: Array.from({ length: 12 }, (_, index) => ({
      order_id: 'ORDER-1', part_id: `PART-${(index % 4) + 1}`, sort_id: index, quantity: String(index + 1),
    })),
    DN_PDM_PartLibraryInfo: Array.from({ length: 4 }, (_, index) => preflightPart(index + 1)),
    DN_PDM_BomHeadInfo: Array.from({ length: 4 }, (_, index) => {
      const head = { part_id: `PART-${index + 1}`, bom_id: `BOM-${index + 1}`, SysVer: 'V1', bom_able: 1 }
      if (pathIdOnHeads) head.path_id = index < populatedHeads ? 'PATH-1' : ''
      return head
    }),
    DN_PDM_BomDetailsInfo: Array.from({ length: 6 }, (_, index) => ({
      bom_pid: `BOM-${(index % 3) + 1}`,
      part_id: `PART-${(index % 4) + 1}`,
      sort_id: index,
      Bom_ExAttr1: String((index % 5) + 1),
      Bom_ExAttr2: 'PCS',
    })),
  }
}

async function preflight(catalog, options = {}) {
  const calls = []
  const readObject = async (request) => {
    calls.push(request)
    const key = Object.keys(catalog).find(
      (name) => name.toLowerCase() === String(request.object).toLowerCase(),
    )
    if (!key) {
      const error = new Error(`Invalid object name '${request.object}'.`)
      error.code = 'EREQUEST'
      throw error
    }
    return { records: catalog[key].slice(0, request.limit) }
  }
  const report = await runStockPreparationSourcePreflight({
    readObject,
    externalSystemId: PREFLIGHT_TENANT_SYSTEM,
    ...options,
  })
  return { report, calls }
}

async function theSubtreeAxisIsDeclarableAndMeasured() {
  // The vocabulary really grew, and the exclusive axis really did not.
  assert.deepEqual([...DECLARABLE_BRIDGES], ['order-module', 'design-bom', 'project-subtree'])
  assert.deepEqual([...EXCLUSIVE_CARRIER_BRIDGES], ['order-module', 'design-bom'])
  assert.ok(SOURCE_PREFLIGHT_BRIDGES.includes('project-subtree'))
  assert.deepEqual(
    [...SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER].sort(),
    Object.values(SOURCE_PREFLIGHT_BLOCKER_CODES).sort(),
    'the new blocker has a declared position and the order names nothing that does not exist',
  )

  // (a) DECLARED AND CORROBORATED: the heads carry a populated folder-node column, so the
  //     declaration is accepted — and `detectedBridge` is STILL the measured carrier, because the
  //     two axes answer different questions.
  const { report } = await preflight(preflightCatalog(), { declaredBridge: 'project-subtree' })
  const topology = report.checks.topology

  assert.equal(topology.declaredBridge, 'project-subtree')
  assert.equal(topology.detectedBridge, 'order-module', 'the CARRIER axis is untouched by a subtree declaration')
  assert.equal(topology.bridgeSource, 'measured')
  assert.equal(topology.matchesConfigured, true)
  assert.equal(topology.declarationContradictsMeasurement, false)
  assert.equal(
    report.blockers.some((entry) => entry.code === B.DECLARED_BRIDGE_CONTRADICTS_MEASUREMENT),
    false,
    'a subtree declaration can never contradict the CARRIER measurement — different axis',
  )
  assert.equal(report.blockers.some((entry) => entry.code === B.DECLARED_SUBTREE_CONTRADICTS_MEASUREMENT), false)
  assert.equal(report.verdict, 'go')

  assert.deepEqual(topology.subtree, {
    configured: false,
    declared: true,
    bomHeadObject: PLM_STOCK_PREPARATION_BOM_READ_PLAN.bomHead.object,
    column: 'path_id',
    columnPresent: true,
    rowsSampled: 4,
    populatedRows: 3,
    rowCap: report.rowCap,
    minLines: BRIDGE_MIN_LINES,
    measured: true,
    declarationContradictsMeasurement: false,
  })

  // The axis is measured on EVERY run, so an operator can see the option exists without declaring
  // anything first.
  const { report: undeclared } = await preflight(preflightCatalog())
  assert.equal(undeclared.checks.topology.subtree.declared, false)
  assert.equal(undeclared.checks.topology.subtree.measured, true)
  assert.equal(undeclared.verdict, 'go')

  // `configured` follows the PLAN, independently of any declaration.
  const { report: configured } = await preflight(preflightCatalog(), { readPlan: subtreePlan() })
  assert.equal(configured.checks.topology.subtree.configured, true)
}

async function aSubtreeDeclarationTheDataDeniesIsBlocked() {
  // (b) The BOM heads have NO folder-node column at all: the declaration is refused.
  const { report: noColumn } = await preflight(
    preflightCatalog({ pathIdOnHeads: false }),
    { declaredBridge: 'project-subtree' },
  )
  const blocker = noColumn.blockers.find((entry) => entry.code === B.DECLARED_SUBTREE_CONTRADICTS_MEASUREMENT)
  assert.ok(blocker, `expected ${B.DECLARED_SUBTREE_CONTRADICTS_MEASUREMENT}, got ${JSON.stringify(noColumn.blockers.map((e) => e.code))}`)
  assert.equal(blocker.detail.declaredBridge, 'project-subtree')
  assert.equal(blocker.detail.columnPresent, false)
  assert.equal(blocker.detail.column, 'path_id', 'the refusal names WHAT was missing')
  assert.equal(noColumn.checks.topology.subtree.measured, false)
  assert.equal(noColumn.verdict, 'no-go')

  // The column PRESENT but populated below the floor is the same refusal: a schema leftover is not
  // a topology.
  const { report: empty } = await preflight(
    preflightCatalog({ populatedHeads: BRIDGE_MIN_LINES - 1 }),
    { declaredBridge: 'project-subtree' },
  )
  assert.ok(empty.blockers.some((entry) => entry.code === B.DECLARED_SUBTREE_CONTRADICTS_MEASUREMENT))
  assert.equal(empty.checks.topology.subtree.columnPresent, true)
  assert.equal(empty.checks.topology.subtree.populatedRows, BRIDGE_MIN_LINES - 1)

  // Not declaring it means no blocker, whatever the data says — the axis reports, it does not demand.
  const { report: silent } = await preflight(preflightCatalog({ pathIdOnHeads: false }))
  assert.equal(silent.blockers.some((entry) => entry.code === B.DECLARED_SUBTREE_CONTRADICTS_MEASUREMENT), false)
  assert.equal(silent.verdict, 'go')
}

async function theEnabledReportStillPassesTheValuesFreeSelfCheck() {
  // The self-check runs unconditionally at the end of EVERY preflight and refuses any string leaf in
  // no declared class. A `topology.subtree` whose leaves were strings called `configured` /
  // `declared` / `measured` would therefore 500 the route for every tenant, subtree or not. This
  // pins that the new block's leaves are booleans, integers, or already-classified identifiers.
  for (const options of [
    {},
    { declaredBridge: 'project-subtree' },
    { readPlan: subtreePlan() },
    { readPlan: subtreePlan(), declaredBridge: 'project-subtree' },
  ]) {
    const { report } = await preflight(preflightCatalog(), options)
    assert.ok(report.checks.topology.subtree, 'the block is present on every run')
    // Independently re-run with an EMPTY exemption set: nothing in the subtree block may need the
    // observed-value or identifier exemptions to survive classification.
    assertSourcePreflightValuesFree(
      { checks: { topology: { subtree: report.checks.topology.subtree } } },
      { observedValues: new Set(), identifiers: new Set(['path_id', PLM_STOCK_PREPARATION_BOM_READ_PLAN.bomHead.object]) },
    )
  }

  // And a run whose heads lack the column — the branch that reports a name nothing observed.
  const { report: missing } = await preflight(preflightCatalog({ pathIdOnHeads: false }), { declaredBridge: 'project-subtree' })
  assert.equal(missing.checks.topology.subtree.columnPresent, false)
}

async function theCarrierAxisJudgementsAreUnchanged() {
  // REGRESSION, stated positively: a declaration on the CARRIER axis still contradicts a decisive
  // carrier measurement, still resolves nothing it could not resolve before, and the two standoff
  // blockers still advertise only the two carriers — adding a third declarable value must not put a
  // provably-useless option on the repair list an operator reads.
  const designShaped = preflightCatalog()
  designShaped.DN_PDM_OrderDetailInfo = []
  designShaped.DN_PDM_BomHeadInfo = []
  designShaped.DN_PDM_BomDetailsInfo = []
  designShaped.DN_PDM_DesignBom = Array.from({ length: 250 }, (_, index) => ({
    OBJ_ID: `DB-${index + 1}`,
    part_id: `PART-${(index % 4) + 1}`,
    sort_id: index,
    bom_exattr1: index % 12 === 0 ? '' : String((index % 7) + 1),
    bom_exattr2: '套',
  }))

  const { report: contradicted } = await preflight(designShaped, { declaredBridge: 'order-module' })
  const carrier = contradicted.blockers.find((entry) => entry.code === B.DECLARED_BRIDGE_CONTRADICTS_MEASUREMENT)
  assert.ok(carrier, 'the carrier-axis contradiction still fires, byte-identically')
  assert.equal(carrier.detail.declaredBridge, 'order-module')
  assert.equal(carrier.detail.measuredBridge, 'design-bom')
  assert.equal(contradicted.checks.topology.detectedBridge, 'design-bom')

  // Declaring the ROOT-DISCOVERY axis against the same source contradicts NOTHING on the carrier
  // axis — and does not silence the carrier findings either.
  const { report: subtreeDeclared } = await preflight(designShaped, { declaredBridge: 'project-subtree' })
  assert.equal(
    subtreeDeclared.blockers.some((entry) => entry.code === B.DECLARED_BRIDGE_CONTRADICTS_MEASUREMENT),
    false,
  )
  assert.equal(subtreeDeclared.checks.topology.detectedBridge, 'design-bom')
  assert.equal(subtreeDeclared.checks.topology.bridgeSource, 'measured')
  assert.ok(subtreeDeclared.blockers.some((entry) => entry.code === B.TOPOLOGY_MISMATCH))

  // The cap standoff: its way out is still, and only, the two carriers.
  const saturated = preflightCatalog()
  saturated.DN_PDM_OrderDetailInfo = Array.from({ length: 260 }, (_, index) => ({
    order_id: 'ORDER-1', part_id: `PART-${(index % 4) + 1}`, sort_id: index, quantity: '1',
  }))
  saturated.DN_PDM_BomHeadInfo = []
  saturated.DN_PDM_BomDetailsInfo = []
  saturated.DN_PDM_DesignBom = Array.from({ length: 260 }, (_, index) => ({
    OBJ_ID: `DB-${index + 1}`, part_id: `PART-${(index % 4) + 1}`, sort_id: index, bom_exattr1: '1',
  }))
  const { report: standoff } = await preflight(saturated)
  const capBlocker = standoff.blockers.find((entry) => entry.code === B.BRIDGE_UNDECIDABLE_AT_CAP)
  assert.ok(capBlocker)
  assert.deepEqual(
    capBlocker.detail.declarableBridges,
    ['order-module', 'design-bom'],
    'the cap standoff must not advertise project-subtree: it provably cannot clear this blocker',
  )

  // And declaring project-subtree really does NOT clear it — the claim above is checked, not assumed.
  const { report: stillStuck } = await preflight(saturated, { declaredBridge: 'project-subtree' })
  assert.ok(stillStuck.blockers.some((entry) => entry.code === B.BRIDGE_UNDECIDABLE_AT_CAP))
  assert.equal(stillStuck.checks.topology.detectedBridge, 'ambiguous')
  assert.equal(stillStuck.checks.topology.bridgeSource, 'measured')

  // Declaring a CARRIER still resolves it, exactly as before.
  const { report: resolved } = await preflight(saturated, { declaredBridge: 'order-module' })
  assert.equal(resolved.checks.topology.detectedBridge, 'order-module')
  assert.equal(resolved.checks.topology.bridgeSource, 'declared')
}

// ---------------------------------------------------------------------------

async function main() {
  await offIsStructural()
  console.log('  ✓ G-01 the shipped plan carries no block, and normalization emits no key')
  await offIsByteIdentical()
  console.log('  ✓ G-02 off: same reads, same rows, same summary keys, even over folder-tree data')
  await onlyTheSubtreeCanRoot()
  console.log('  ✓ G-03 zero order lines still root, at depth 0, with the defaulting COUNTED')
  await ignoredFiltersCannotWidenTheTraversal()
  console.log('  ✓ G-04 必修①: a source that ignores filters cannot pull another project`s BOM in')
  await foreignProjectRowsCannotSeedTheTraversal()
  console.log('  ✓ G-10 a lying project-ENTRY read cannot seed either root segment with a foreign project')
  await deduplicationCoversChildrenNotJustRoots()
  await twoHeadsOnOnePartAreOneRoot()
  console.log('  ✓ G-05 必修②: de-dup covers children, and two heads on one part are one root')
  await theBudgetAndCeilingsAreEnforcedAtNormalization()
  await overrunsAreGlobalFailuresNotBackgroundJobs()
  console.log('  ✓ G-06 必修③: budget mandatory, ceilings hard, overruns fail closed and stay out of large-BOM')
  await aBudgetOverrunInsideTheSubtreeIsCaught()
  console.log('  ✓ G-09 a budget overrun inside the segment is a refusal, not a rejected promise')
  await aFolderCycleIsRefusedBoundedly()
  await ancestorSeedsAndDagMergesAreSkippedNotRefused()
  console.log('  ✓ G-07/G-11 a real loop is refused; an ancestor seed or a DAG merge is skipped and counted')
  await anAlreadyFailedRunNeverStartsTheSegment()
  console.log('  ✓ G-08 an already-failed order path never starts the subtree segment')

  await theSubtreeAxisIsDeclarableAndMeasured()
  await aSubtreeDeclarationTheDataDeniesIsBlocked()
  await theEnabledReportStillPassesTheValuesFreeSelfCheck()
  await theCarrierAxisJudgementsAreUnchanged()
  console.log('  ✓ P-01 preflight: a second axis with its own evidence, its own blocker, and no carrier drift')

  console.log('stock-preparation-project-subtree-bridge: OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
