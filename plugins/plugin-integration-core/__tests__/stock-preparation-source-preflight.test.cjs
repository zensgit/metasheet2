'use strict'

// 源就绪预检 + 拓扑自测 — SOURCE PREFLIGHT: the suite.
//
// THE TWO LIVE FAILURES THIS FEATURE EXISTS FOR, restated as the two fixtures below:
//
//   INCIDENT A  the shipped read plan reaches a project's components through the ORDER MODULE. The
//               first real customer catalog had ONE order-head row in total and carried its BOM in a
//               design-BOM table instead. The expansion returned zero rows and reported success,
//               because a plan that assumes its own bridge cannot tell "no data" from "wrong bridge".
//               -> `customerShapedSource()` is that catalog: order module nearly empty, design BOM
//                  populated, quantity in a generic `bom_exattr` slot.
//
//   INCIDENT B  a test catalog with the right tables and no business rows in them, discovered many
//               steps downstream.
//               -> `emptySource()`.
//
// Guards (each RED-witnessed by mutation; see the PR body's mutation table):
//   S-01  a healthy order-module source detects `order-module`, agrees with the plan, verdict go
//   S-02  INCIDENT A: the customer shape detects `design-bom` and BLOCKS with topology_mismatch,
//         naming both the configured line object and the detected one
//   S-03  INCIDENT B: an empty-but-present catalog blocks on no project numbers / no BOM rows
//   S-04  unreachable: every read fails at the connection -> source_unreachable and nothing else
//   S-05  the entry table missing is a DIFFERENT verdict from unreachable
//   S-06  bounded counts are honest: a table at the cap reports exact:false, below it exact:true
//   S-07  both topologies populated -> bridge_ambiguous (a human decides; we do not guess)
//   S-08  quantity slot: the customer's own dictionary decodes the slot, the data's numeric density
//         corroborates it, and a plan configured for another slot warns
//   S-09  preset match is BY TABLE SIGNATURE: the same tables match whatever the system is called,
//         and a catalog of other tables matches nothing
//   S-10  READ-ONLY + BOUNDED: every read is unfiltered, at the module's cap, and no other adapter
//         method is ever touched
//   S-11  VALUES-FREE: a catalog poisoned with a credential, a connection string and bulk business
//         values yields a report carrying none of them, and liveness evidence stays at 2 short values
//   S-12  the values-free self-check really fires (it is not vacuous), and refuses an UNCLASSIFIED
//         leaf, a closed-vocabulary violation and a planted secret
//   S-13  driver error text NEVER reaches the report — a message carrying a password classifies to a
//         code and the password is gone
//   R-01  the route is registered at the module's own path and gated on the integration READ tier;
//         a stock-prep-namespace principal is refused (source reads are not a queue-operator act)
//   R-02  the source defaults to the CONFIGURED table action, and an explicit id overrides it
//   R-03  no configured action and no id -> 409, not a 500 and not a silent default
//   R-04  the request surface is closed: no object, no limit, no read plan, no unknown key
//   R-05  VALUES-FREE at the HTTP boundary too
//
// Hermetic: no DB, no network, no `mssql`. The source is an in-memory catalog and the route runs over
// a fake host.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  SOURCE_PREFLIGHT_ROUTE_PATH,
  SOURCE_PREFLIGHT_ROW_CAP,
  SOURCE_PREFLIGHT_BLOCKER_CODES,
  SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER,
  SOURCE_PREFLIGHT_WARNING_CODES,
  SOURCE_PREFLIGHT_READ_ERROR_CODES,
  SOURCE_PREFLIGHT_BRIDGES,
  DESIGN_BOM_BRIDGE_OBJECTS,
  LIVENESS_SAMPLE_MAX,
  PROJECT_NODE_TYPE,
  SourcePreflightError,
  runStockPreparationSourcePreflight,
  assertSourcePreflightValuesFree,
} = require(path.join(LIB, 'stock-preparation-source-preflight.cjs'))
const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
} = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  STOCK_PREP_ADMIN,
  STOCK_PREP_READ,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))

const B = SOURCE_PREFLIGHT_BLOCKER_CODES
const W = SOURCE_PREFLIGHT_WARNING_CODES

const TENANT_ID = 'tenant-a'
const SYSTEM_ID = 'plm_sql_source'
const DESIGN_BOM_OBJECT = DESIGN_BOM_BRIDGE_OBJECTS[0]

// ---------------------------------------------------------------------------
// THE SYNTHETIC SOURCE
//
// Shaped like the DN-PDM family the vendor preset describes, in the SPELLING a live SQL Server
// catalog of that family uses. Business values here are obviously synthetic; the poison fixture below
// plants the things that must never travel.
// ---------------------------------------------------------------------------

function partRows(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    ID: index + 1,
    OBJ_ID: `PART-${index + 1}`,
    IdentityNo: `DWG-${1000 + index}`,
    IdentityName: `零件-${index + 1}`,
    Material: 'Q235',
    SysVer: 'V1',
    isable: 0,
  }))
}

/** The project-number entry table. NodeType 2 marks a project node. */
function pathExAttrRows(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    ID: index + 1,
    FileCode: `PRJ-${2600 + index}`,
    Parent_OBJ_ID: `PATH-${index + 1}`,
    NodeType: index === 0 ? PROJECT_NODE_TYPE : 1,
  }))
}

function bomHeadRows(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    ID: index + 1,
    part_id: `PART-${index + 1}`,
    bom_id: `BOM-${index + 1}`,
    SysVer: 'V1',
    bom_able: 1,
  }))
}

function bomDetailRows(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    ID: index + 1,
    bom_pid: `BOM-${(index % 3) + 1}`,
    part_id: `PART-${(index % 4) + 1}`,
    sort_id: index,
    Bom_ExAttr1: String((index % 5) + 1),
    Bom_ExAttr2: 'PCS',
  }))
}

/**
 * The design-BOM table — the bridge nothing in the repo knew about until the first live run. Its
 * quantity is in a generic slot (`bom_exattr1`, lower case as SQL Server's case-insensitive collation
 * and the customer's own DDL had it), not in a column called anything like "quantity".
 */
function designBomRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    ID: index + 1,
    project_id: `PATH-1`,
    part_id: `PART-${(index % 4) + 1}`,
    sort_id: index,
    // The quantity slot is EMPTY on a few lines (a reference line carries none) while the unit slot
    // is populated everywhere. That asymmetry is what makes "rank slots by numeric density" a real
    // measurement: a ranker that counted populated cells instead of NUMERIC ones would pick the unit
    // slot here, so the mutation is visible rather than harmless.
    bom_exattr1: index % 12 === 0 ? '' : String((index % 7) + 1),
    bom_exattr2: '套',
  }))
}

/**
 * The slot dictionary: one row per generic slot, the enabled ones carrying the customer's meanings.
 *
 * The RETIRED quantity slot is deliberately FIRST. A decoder that ignored the enabled flag — the
 * measured `nonzero-means-enabled` polarity the vendor preset carries — would take this row and
 * report the wrong column, so the ordering makes that mutation visible instead of harmless.
 */
function quantityDictionaryRows() {
  // `describes_table` comes FIRST and is populated on every row, so a key-column chooser that ranked
  // by "how many rows have a value here" instead of "how many values NAME a slot of the family" would
  // pick it and decode nothing — another mutation the fixture makes visible.
  return [
    { describes_table: 'DN_PDM_BomDetailsInfo', ID: 3, attr_name: 'Bom_ExAttr3', display_name: '数量(旧)', attr_type: 'float', isable: 0, sort_id: 3 },
    { describes_table: 'DN_PDM_BomDetailsInfo', ID: 1, attr_name: 'Bom_ExAttr1', display_name: '数量', attr_type: 'float', isable: 1, sort_id: 1 },
    { describes_table: 'DN_PDM_BomDetailsInfo', ID: 2, attr_name: 'Bom_ExAttr2', display_name: '单位', attr_type: 'list', isable: 1, sort_id: 2 },
  ]
}

/** Everything the family's signature names, so a preset match is decidable. */
function baseCatalog(overrides = {}) {
  return {
    DN_PDM_PathExAttrInfo: pathExAttrRows(),
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1', Parent_OBJ_ID: null }],
    DN_PDM_OrderHeadInfo: [],
    DN_PDM_OrderDetailInfo: [],
    DN_PDM_PartLibraryInfo: partRows(),
    DN_PDM_BomHeadInfo: bomHeadRows(),
    DN_PDM_BomDetailsInfo: bomDetailRows(),
    DN_PM_BomExAttrInfo: quantityDictionaryRows(),
    DN_PM_BomExAttrInfo_header: [],
    DN_PM_PartExAttrInfo: [],
    DN_PM_OrderExAttrInfo: [],
    ...overrides,
  }
}

/** A deployment whose order module really is the bridge — the shape the shipped plan assumes. */
function orderModuleSource() {
  return baseCatalog({
    DN_PDM_OrderHeadInfo: [
      { ID: 1, OBJ_ID: 'ORDER-1', path_id: 'PATH-1' },
      { ID: 2, OBJ_ID: 'ORDER-2', path_id: 'PATH-2' },
    ],
    DN_PDM_OrderDetailInfo: Array.from({ length: 12 }, (_, index) => ({
      ID: index + 1,
      order_id: `ORDER-${(index % 2) + 1}`,
      part_id: `PART-${(index % 4) + 1}`,
      sort_id: index,
      quantity: String(index + 1),
    })),
  })
}

/**
 * INCIDENT A, as a catalog: ONE order head, no order lines at all, and a populated design BOM whose
 * quantity lives in a generic slot. This is the shape that made a run return zero rows and call it a
 * success.
 */
function customerShapedSource({ designBomLines = 250 } = {}) {
  return baseCatalog({
    DN_PDM_OrderHeadInfo: [{ ID: 1, OBJ_ID: 'ORDER-1', path_id: 'PATH-9' }],
    DN_PDM_OrderDetailInfo: [],
    [DESIGN_BOM_OBJECT]: designBomRows(designBomLines),
  })
}

/** INCIDENT B: every table present, not one business row anywhere. */
function emptySource() {
  return {
    DN_PDM_PathExAttrInfo: [],
    DN_PDM_PathInfo: [],
    DN_PDM_OrderHeadInfo: [],
    DN_PDM_OrderDetailInfo: [],
    DN_PDM_PartLibraryInfo: [],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
    DN_PM_BomExAttrInfo: [],
    DN_PM_BomExAttrInfo_header: [],
    DN_PM_PartExAttrInfo: [],
    DN_PM_OrderExAttrInfo: [],
  }
}

// ---------------------------------------------------------------------------
// THE READER — the one capability the probe is handed, plus a full call log so the read-only and
// bounded claims are decidable rather than asserted.
// ---------------------------------------------------------------------------

class FakeDriverError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

function createReader(catalog, options = {}) {
  const calls = []
  const missing = new Set((options.missingObjects || []).map((name) => name.toLowerCase()))
  async function readObject(request) {
    calls.push(request)
    if (options.failEveryRead) throw options.failEveryRead()
    const object = request && request.object
    const key = Object.keys(catalog).find((name) => name.toLowerCase() === String(object).toLowerCase())
    if (missing.has(String(object).toLowerCase()) || !key) {
      throw new FakeDriverError(`Invalid object name '${object}'.`, 'EREQUEST')
    }
    const limit = request.limit
    return { records: catalog[key].slice(0, limit) }
  }
  return { readObject, calls }
}

function codesOf(entries) {
  return entries.map((entry) => entry.code)
}

function blockerNamed(report, code) {
  const found = report.blockers.find((entry) => entry.code === code)
  assert.ok(found, `expected blocker ${code}, got ${JSON.stringify(codesOf(report.blockers))}`)
  return found
}

function checkOf(report, name) {
  return report.checks[name]
}

async function preflight(catalog, options = {}) {
  const reader = createReader(catalog, options)
  const report = await runStockPreparationSourcePreflight({
    readObject: reader.readObject,
    readPlan: options.readPlan,
    externalSystemId: options.externalSystemId || SYSTEM_ID,
  })
  return { report, calls: reader.calls }
}

/** Every string that appears anywhere in the report, for leak assertions. */
function reportStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) reportStrings(item, out)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) reportStrings(item, out)
  return out
}

// ---------------------------------------------------------------------------
// S-01 .. S-07 — reachability, data, topology
// ---------------------------------------------------------------------------

async function healthyOrderModuleSource() {
  const { report } = await preflight(orderModuleSource())
  const topology = checkOf(report, 'topology')

  assert.equal(topology.detectedBridge, 'order-module')
  assert.equal(topology.configuredBridge, 'order-module')
  assert.equal(topology.matchesConfigured, true)
  assert.equal(checkOf(report, 'reachability').reachable, true)
  assert.equal(checkOf(report, 'projectData').hasProjectNumbers, true)
  assert.equal(checkOf(report, 'bomData').hasBomRows, true)
  assert.deepEqual(codesOf(report.blockers), [])
  assert.equal(report.verdict, 'go')
  assert.equal(report.ok, true)

  // The node-type reading is a MEASUREMENT, not an assumption: the fixture has exactly one project
  // node among three rows, and the report says so.
  const projectData = checkOf(report, 'projectData')
  assert.equal(projectData.nodeTypeColumn, 'NodeType')
  assert.equal(projectData.projectNodeRows, 1)
  assert.equal(projectData.rowsObserved, 3)
}

async function incidentAIsDetectedAndBlocked() {
  const { report } = await preflight(customerShapedSource())
  const topology = checkOf(report, 'topology')

  // The measurement.
  assert.equal(topology.detectedBridge, 'design-bom')
  assert.equal(topology.configuredBridge, 'order-module')
  assert.equal(topology.matchesConfigured, false)
  const orderCandidate = topology.candidates.find((entry) => entry.bridge === 'order-module')
  const designCandidate = topology.candidates.find((entry) => entry.bridge === 'design-bom')
  assert.equal(orderCandidate.headRows, 1, 'the live catalog had exactly one order head')
  assert.equal(orderCandidate.lineRows, 0, 'and no order lines at all')
  assert.ok(designCandidate.lineRows >= SOURCE_PREFLIGHT_ROW_CAP, 'while the design BOM is full')

  // The refusal. This is the sentence the zero-row run never said.
  const blocker = blockerNamed(report, B.TOPOLOGY_MISMATCH)
  assert.equal(blocker.detail.configuredBridge, 'order-module')
  assert.equal(blocker.detail.detectedBridge, 'design-bom')
  assert.equal(blocker.detail.configuredLineObject, PLM_STOCK_PREPARATION_BOM_READ_PLAN.orderDetail.object)
  assert.equal(blocker.detail.detectedLineObject, DESIGN_BOM_OBJECT)
  assert.equal(report.verdict, 'no-go')

  // "No BOM rows" must NOT also fire: the source is full of BOM lines, they are simply somewhere the
  // plan does not look. Reporting both would send an implementer hunting for missing data.
  assert.equal(report.blockers.some((entry) => entry.code === B.NO_BOM_ROWS), false)
}

async function incidentBIsDetected() {
  const { report } = await preflight(emptySource())
  assert.equal(checkOf(report, 'reachability').reachable, true, 'the catalog answered; it is simply empty')
  assert.equal(checkOf(report, 'projectData').hasProjectNumbers, false)
  assert.equal(checkOf(report, 'bomData').hasBomRows, false)
  assert.equal(checkOf(report, 'topology').detectedBridge, 'none')
  const codes = codesOf(report.blockers)
  assert.ok(codes.includes(B.NO_PROJECT_NUMBERS))
  assert.ok(codes.includes(B.NO_BOM_ROWS))
  assert.ok(codes.includes(B.NO_BOM_BRIDGE))
  assert.equal(report.verdict, 'no-go')
  assert.deepEqual(checkOf(report, 'projectData').livenessSamples, [], 'no rows, no liveness evidence')
}

async function unreachableSourceIsItsOwnVerdict() {
  const { report } = await preflight(orderModuleSource(), {
    failEveryRead: () => new FakeDriverError('failed to connect to sql-01.customer.example:1433', 'ESOCKET'),
  })
  const reachability = checkOf(report, 'reachability')
  assert.equal(reachability.reachable, false)
  assert.equal(reachability.objectsAnswered, 0)
  assert.equal(reachability.failureCode, 'unreachable')
  assert.deepEqual(codesOf(report.blockers), [B.SOURCE_UNREACHABLE],
    'an unreachable source produces ONE blocker: every later finding would be meaningless')
  assert.deepEqual(report.warnings, [])
}

async function missingEntryTableIsNotUnreachable() {
  const { report } = await preflight(orderModuleSource(), {
    missingObjects: ['DN_PDM_PathExAttrInfo'],
  })
  assert.equal(checkOf(report, 'reachability').reachable, true)
  const blocker = blockerNamed(report, B.ENTRY_TABLE_MISSING)
  assert.equal(blocker.detail.object, PLM_STOCK_PREPARATION_BOM_READ_PLAN.pathExAttr.object)
  assert.equal(blocker.detail.errorCode, 'object_missing')
  assert.equal(report.blockers.some((entry) => entry.code === B.SOURCE_UNREACHABLE), false)
}

async function countsAreHonestAboutTheCap() {
  const { report } = await preflight(customerShapedSource({ designBomLines: SOURCE_PREFLIGHT_ROW_CAP + 400 }))
  const design = report.probes.find((entry) => entry.role === 'designBom' && entry.present)
  assert.equal(design.rowsObserved, SOURCE_PREFLIGHT_ROW_CAP)
  assert.equal(design.exact, false, 'a page that filled the cap is a FLOOR, never a total')

  const parts = report.probes.find((entry) => entry.role === 'part')
  assert.equal(parts.rowsObserved, 4)
  assert.equal(parts.exact, true, 'a page below the cap saw the whole table')
}

async function twoPopulatedTopologiesRefuseToGuess() {
  const catalog = orderModuleSource()
  catalog[DESIGN_BOM_OBJECT] = designBomRows(14) // comparable to the 12 order lines
  const { report } = await preflight(catalog)
  assert.equal(checkOf(report, 'topology').detectedBridge, 'ambiguous')
  blockerNamed(report, B.BRIDGE_AMBIGUOUS)
  assert.equal(report.verdict, 'no-go')
}

// ---------------------------------------------------------------------------
// S-08 — the quantity slot
// ---------------------------------------------------------------------------

async function quantitySlotIsMeasuredTwoWays() {
  const { report } = await preflight(customerShapedSource())
  const quantity = checkOf(report, 'quantityField')

  assert.equal(quantity.carrierObject, DESIGN_BOM_OBJECT,
    'the slots measured are the DETECTED carrier`s, not the configured one`s')
  assert.equal(quantity.dictionaryObject, 'DN_PM_BomExAttrInfo')
  assert.equal(quantity.dictionaryReadable, true)
  assert.equal(quantity.dictionaryKeyColumn, 'attr_name', 'the key column is measured, not declared')
  assert.equal(quantity.dictionarySlot, 'Bom_ExAttr1')
  assert.equal(quantity.measuredSlot, 'bom_exattr1', 'the data`s own numeric density corroborates it')
  assert.equal(quantity.readingsAgree, true)
  assert.equal(quantity.resolvedSlot, 'Bom_ExAttr1')
  // The shipped plan already names Bom_ExAttr1, so this source needs no quantity change.
  assert.equal(quantity.configuredField, PLM_STOCK_PREPARATION_BOM_READ_PLAN.bomDetail.quantityField)
  assert.equal(quantity.matchesConfigured, true)

  // The disabled slot the dictionary carries must NOT win, even though its label also says 数量.
  assert.notEqual(quantity.dictionarySlot, 'Bom_ExAttr3')

  // The customer's own field LABEL never travels — only the slot identifier does.
  assert.equal(reportStrings(report).includes('数量'), false)
  assert.equal(reportStrings(report).includes('单位'), false)
}

async function aPlanOnTheWrongSlotWarns() {
  const readPlan = {
    ...PLM_STOCK_PREPARATION_BOM_READ_PLAN,
    bomDetail: { ...PLM_STOCK_PREPARATION_BOM_READ_PLAN.bomDetail, quantityField: 'Bom_ExAttr7' },
  }
  const { report } = await preflight(customerShapedSource(), { readPlan })
  const quantity = checkOf(report, 'quantityField')
  assert.equal(quantity.configuredField, 'Bom_ExAttr7')
  assert.equal(quantity.resolvedSlot, 'Bom_ExAttr1')
  assert.equal(quantity.matchesConfigured, false)
  const warning = report.warnings.find((entry) => entry.code === W.QUANTITY_FIELD_MISMATCH)
  assert.ok(warning, `expected ${W.QUANTITY_FIELD_MISMATCH}, got ${JSON.stringify(codesOf(report.warnings))}`)
  assert.equal(warning.detail.detectedField, 'Bom_ExAttr1')
}

async function anUnreadableDictionaryFallsBackToTheData() {
  const { report } = await preflight(customerShapedSource(), { missingObjects: ['DN_PM_BomExAttrInfo'] })
  const quantity = checkOf(report, 'quantityField')
  assert.equal(quantity.dictionaryReadable, false)
  assert.equal(quantity.dictionarySlot, null)
  assert.equal(quantity.measuredSlot, 'bom_exattr1', 'the density reading stands on its own')
  assert.equal(quantity.resolvedSlot, 'bom_exattr1')
  assert.ok(report.warnings.some((entry) => entry.code === W.DICTIONARY_UNREADABLE))
}

// ---------------------------------------------------------------------------
// S-09 — preset identity BY TABLE SIGNATURE
// ---------------------------------------------------------------------------

async function presetIdentityIsBySignatureNotByName() {
  const { report: a } = await preflight(customerShapedSource(), { externalSystemId: 'acme_plm_prod' })
  const { report: b } = await preflight(customerShapedSource(), { externalSystemId: 'totally_different_customer' })
  assert.equal(a.checks.presetMatch.presetId, 'dn-pdm-family')
  assert.equal(a.checks.presetMatch.matchedBy, 'table-signature')
  assert.equal(a.checks.presetMatch.reason, 'MATCHED')
  assert.deepEqual(a.checks.presetMatch, b.checks.presetMatch,
    'the system id is not an input to identity: same tables, same answer')
  assert.ok(a.checks.presetMatch.matchedSignatureTables >= a.checks.presetMatch.requiredSignatureTables)
}

async function anUnknownCatalogMatchesNothing() {
  // Same ROLES, entirely different table names: the read plan is overridden to address them, so the
  // probe reaches real data and still refuses to claim a vendor identity.
  const readPlan = {
    ...PLM_STOCK_PREPARATION_BOM_READ_PLAN,
    pathExAttr: { object: 'ZZ_ProjectIndex', matchField: 'FileCode', pathIdField: 'Parent_OBJ_ID' },
    pathInfo: { object: 'ZZ_Nodes', idField: 'OBJ_ID' },
    orderHead: { object: 'ZZ_OrderHead', idField: 'OBJ_ID', pathIdField: 'path_id' },
    orderDetail: { object: 'ZZ_OrderLine', orderIdField: 'order_id', componentIdField: 'part_id', quantityField: 'quantity', sortField: 'sort_id' },
    part: { object: 'ZZ_Parts', idField: 'OBJ_ID' },
    bomHead: { object: 'ZZ_BomHead', parentPartField: 'part_id', bomIdField: 'bom_id' },
    bomDetail: { object: 'ZZ_BomLine', bomParentField: 'bom_pid', componentIdField: 'part_id', quantityField: 'Bom_ExAttr1' },
  }
  const source = orderModuleSource()
  const catalog = {
    ZZ_ProjectIndex: source.DN_PDM_PathExAttrInfo,
    ZZ_Nodes: source.DN_PDM_PathInfo,
    ZZ_OrderHead: source.DN_PDM_OrderHeadInfo,
    ZZ_OrderLine: source.DN_PDM_OrderDetailInfo,
    ZZ_Parts: source.DN_PDM_PartLibraryInfo,
    ZZ_BomHead: source.DN_PDM_BomHeadInfo,
    ZZ_BomLine: source.DN_PDM_BomDetailsInfo,
  }
  const { report } = await preflight(catalog, { readPlan })
  assert.equal(report.checks.presetMatch.presetId, null)
  assert.equal(report.checks.presetMatch.reason, 'NO_PRESET_MATCHED')
  assert.ok(report.warnings.some((entry) => entry.code === W.NO_PRESET_MATCH))
  // Not knowing the vendor is a WARNING, not a blocker: the source is reachable, populated and
  // topologically consistent with the plan, and that is a runnable deployment.
  assert.equal(report.checks.topology.detectedBridge, 'order-module')
  assert.equal(report.verdict, 'go')
}

// ---------------------------------------------------------------------------
// S-10 — read-only and bounded
// ---------------------------------------------------------------------------

async function everyReadIsUnfilteredAndCapped() {
  const { report, calls } = await preflight(customerShapedSource())
  assert.ok(calls.length > 0)
  for (const call of calls) {
    assert.equal(call.limit, SOURCE_PREFLIGHT_ROW_CAP, 'the page size is a module constant')
    assert.equal(Object.prototype.hasOwnProperty.call(call, 'filters'), false, 'the probe sends no filters')
    assert.equal(Object.prototype.hasOwnProperty.call(call, 'cursor'), false, 'and never pages past the cap')
    assert.deepEqual(Object.keys(call).sort(), ['limit', 'object'])
  }
  // The roster is finite and derived from the plan + the declared bridge candidates. No probe of an
  // object nobody named.
  const probed = new Set(calls.map((call) => call.object))
  const expected = new Set([
    ...Object.values(PLM_STOCK_PREPARATION_BOM_READ_PLAN)
      .filter((entry) => entry && typeof entry === 'object' && entry.object)
      .map((entry) => entry.object),
    ...DESIGN_BOM_BRIDGE_OBJECTS,
    'DN_PM_BomExAttrInfo',
  ])
  for (const object of probed) {
    assert.ok(expected.has(object), `probed an object outside the roster: ${object}`)
  }
  assert.equal(report.probes.length, calls.length)
}

async function theProbeHoldsNothingButRead() {
  // A source adapter with the full contract on it. The probe is handed ONLY `read`, so nothing else
  // can be reached — this asserts the wiring keeps it that way.
  const catalog = customerShapedSource()
  const forbidden = []
  const adapter = {
    async read(request) {
      const key = Object.keys(catalog).find((name) => name.toLowerCase() === String(request.object).toLowerCase())
      if (!key) throw new FakeDriverError(`Invalid object name '${request.object}'.`, 'EREQUEST')
      return { records: catalog[key].slice(0, request.limit) }
    },
  }
  for (const method of ['write', 'upsert', 'deleteRecords', 'testConnection', 'listObjects', 'getSchema']) {
    adapter[method] = async () => {
      forbidden.push(method)
      throw new Error(`source preflight must not call adapter.${method}`)
    }
  }
  await runStockPreparationSourcePreflight({
    readObject: (request) => adapter.read(request),
    externalSystemId: SYSTEM_ID,
  })
  assert.deepEqual(forbidden, [], 'the probe reached no adapter method but read()')
}

async function aMissingCapabilityIsRefusedNotFaked() {
  await assert.rejects(
    () => runStockPreparationSourcePreflight({}),
    (error) => error instanceof SourcePreflightError && error.details.field === 'readObject',
  )
}

// ---------------------------------------------------------------------------
// S-11 .. S-13 — values-free
// ---------------------------------------------------------------------------

const PLANTED_PASSWORD = 'Sup3rSecret!PlmPassw0rd'
const PLANTED_DSN = 'Server=10.4.2.19,1433;Database=PDM;User Id=sa;Password=hunter2;'
const PLANTED_HOST = 'pdm-prod.customer-internal.example'
const PLANTED_DRAWING = 'TG-2026-0001-ROTOR-HOUSING'
const PLANTED_CUSTOMER = '某某重工股份有限公司'

/** A catalog with the things that must never travel planted in ordinary business columns. */
function poisonedSource() {
  const catalog = customerShapedSource()
  catalog.DN_PDM_PartLibraryInfo = catalog.DN_PDM_PartLibraryInfo.map((row, index) => ({
    ...row,
    IdentityNo: index === 0 ? PLANTED_DRAWING : row.IdentityNo,
    IdentityName: index === 0 ? PLANTED_CUSTOMER : row.IdentityName,
    Material: index === 0 ? PLANTED_PASSWORD : row.Material,
    Notes: PLANTED_DSN,
  }))
  catalog.DN_PM_BomExAttrInfo = catalog.DN_PM_BomExAttrInfo.map((row) => ({
    ...row,
    remark: `${PLANTED_HOST} / ${PLANTED_PASSWORD}`,
  }))
  return catalog
}

async function poisonedValuesNeverTravel() {
  const { report } = await preflight(poisonedSource())
  const strings = reportStrings(report)
  const serialized = JSON.stringify(report)
  for (const planted of [PLANTED_PASSWORD, PLANTED_DSN, PLANTED_HOST, PLANTED_DRAWING, PLANTED_CUSTOMER]) {
    assert.equal(serialized.includes(planted), false, `planted value reached the report: ${planted.slice(0, 8)}…`)
  }
  // The detection still worked on the poisoned catalog — the guard is not "return nothing".
  assert.equal(report.checks.topology.detectedBridge, 'design-bom')
  assert.equal(report.checks.quantityField.dictionarySlot, 'Bom_ExAttr1')
  assert.ok(strings.length > 0)
}

async function livenessEvidenceIsBoundedAndScreened() {
  const { report } = await preflight(customerShapedSource())
  const samples = report.checks.projectData.livenessSamples
  assert.ok(samples.length > 0, 'a populated source proves liveness')
  assert.equal(LIVENESS_SAMPLE_MAX, 2, 'the cap is TWO — stated literally so widening it reds here')
  assert.ok(samples.length <= 2, 'two short values are evidence; a page of them is a dump')

  // A project-number column poisoned with connection-shaped values yields NO liveness evidence: the
  // shape screen drops each one rather than quoting it back.
  const catalog = customerShapedSource()
  catalog.DN_PDM_PathExAttrInfo = [
    { ID: 1, FileCode: PLANTED_DSN, Parent_OBJ_ID: 'PATH-1', NodeType: PROJECT_NODE_TYPE },
    { ID: 2, FileCode: PLANTED_HOST, Parent_OBJ_ID: 'PATH-2', NodeType: PROJECT_NODE_TYPE },
    { ID: 3, FileCode: '10.4.2.19', Parent_OBJ_ID: 'PATH-3', NodeType: PROJECT_NODE_TYPE },
  ]
  const { report: screened } = await preflight(catalog)
  assert.deepEqual(screened.checks.projectData.livenessSamples, [])
  // and the COUNT still tells the truth: the rows are there, they just may not be quoted.
  assert.equal(screened.checks.projectData.populatedMatchRows, 3)
  assert.equal(JSON.stringify(screened).includes(PLANTED_DSN), false)
}

async function theSelfCheckIsNotVacuous() {
  // A planted secret is refused wherever it sits — the liveness path included.
  assert.throws(
    () => assertSourcePreflightValuesFree(
      { checks: { projectData: { livenessSamples: [PLANTED_PASSWORD] } } },
      { secrets: [PLANTED_PASSWORD] },
    ),
    (error) => error instanceof SourcePreflightError && error.details.kind === 'secret',
  )
  // The refusal never echoes the value.
  try {
    assertSourcePreflightValuesFree(
      { checks: { projectData: { livenessSamples: ['ok'] } }, probes: [{ object: PLANTED_PASSWORD }] },
      { observedValues: new Set([PLANTED_PASSWORD]) },
    )
    assert.fail('expected a values-free refusal')
  } catch (error) {
    assert.ok(error instanceof SourcePreflightError)
    assert.equal(JSON.stringify(error.details).includes(PLANTED_PASSWORD), false)
    assert.match(error.details.masked, /^.\*{4}.$/)
  }
  // An UNCLASSIFIED string leaf is refused by default — this is what makes a future field safe.
  assert.throws(
    () => assertSourcePreflightValuesFree({ somethingNew: 'a value nobody classified' }, {}),
    (error) => error instanceof SourcePreflightError && error.details.kind === 'unclassified-string-leaf',
  )
  // A closed-vocabulary leaf carrying something outside its vocabulary is refused, so a value that
  // reached a code field cannot ride out on the exemption that field enjoys.
  assert.throws(
    () => assertSourcePreflightValuesFree({ verdict: 'probably fine' }, {}),
    (error) => error instanceof SourcePreflightError && error.details.kind === 'closed-vocabulary-violated',
  )
  // And a genuine report passes it, so the guard is not simply always-red.
  assertSourcePreflightValuesFree({ verdict: 'go', checks: { projectData: { livenessSamples: ['PRJ-1'] } } }, {})
}

async function driverTextNeverReachesTheReport() {
  const { report } = await preflight(orderModuleSource(), {
    failEveryRead: () => new FakeDriverError(
      `Login failed for user 'sa'. password=${PLANTED_PASSWORD} host=${PLANTED_HOST}`,
      'ELOGIN',
    ),
  })
  assert.equal(checkOf(report, 'reachability').failureCode, 'auth_refused')
  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes(PLANTED_PASSWORD), false)
  assert.equal(serialized.includes(PLANTED_HOST), false)
  assert.equal(serialized.includes('Login failed'), false)
  for (const probe of report.probes) {
    assert.ok(probe.errorCode === null || SOURCE_PREFLIGHT_READ_ERROR_CODES.includes(probe.errorCode))
  }
}

async function vocabulariesAreClosedAndOrdered() {
  assert.deepEqual(
    [...SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER].sort(),
    Object.values(SOURCE_PREFLIGHT_BLOCKER_CODES).sort(),
    'every blocker code has a declared position, and the order names no code that does not exist',
  )
  const { report } = await preflight(emptySource())
  const positions = report.blockers.map((entry) => SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER.indexOf(entry.code))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'blockers come out most-blocking first')
  for (const bridge of [report.checks.topology.detectedBridge, report.checks.topology.configuredBridge]) {
    assert.ok(SOURCE_PREFLIGHT_BRIDGES.includes(bridge))
  }
}

// ---------------------------------------------------------------------------
// R-01 .. R-05 — the route
// ---------------------------------------------------------------------------

const ANONYMOUS = undefined
const LOGGED_IN = Object.freeze({ id: 'u_plain', tenantId: TENANT_ID, permissions: [] })
const INTEGRATION_READER = Object.freeze({ id: 'u_read', tenantId: TENANT_ID, permissions: ['integration:read'] })
const INTEGRATION_WRITER = Object.freeze({ id: 'u_write', tenantId: TENANT_ID, permissions: ['integration:write'] })
const PLATFORM_ADMIN = Object.freeze({ id: 'u_admin', tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] })
const STOCK_PREP_OPERATOR = Object.freeze({ id: 'u_sp', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ, STOCK_PREP_ADMIN] })

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

function tableActionConfig(overrides = {}) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: SYSTEM_ID, kind: 'data-source:sql-readonly', ...(overrides.source || {}) },
    target: { sheetId: 'sheet_stock', objectId: 'stockPreparationMain' },
  }
}

function mountRoute({ catalog, action = tableActionConfig(), systems, adapterOverride } = {}) {
  const routes = new Map()
  const reader = catalog ? createReader(catalog) : null
  const loaded = []
  const registry = {
    ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
    async getExternalSystem(input) {
      loaded.push(input)
      const system = (systems || { [SYSTEM_ID]: { id: SYSTEM_ID, kind: 'data-source:sql-readonly' } })[input.id]
      if (!system) {
        const error = new Error('external system not found')
        error.name = 'ExternalSystemNotFoundError'
        throw error
      }
      return system
    },
  }
  registry.getExternalSystemForAdapter = registry.getExternalSystem
  const adapterRegistry = {
    listAdapterKinds() { return ['data-source:sql-readonly'] },
    createAdapter() {
      if (adapterOverride) return adapterOverride
      return { read: (request) => reader.readObject(request) }
    },
  }
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
      },
      multitable: { provisioning: {}, records: {} },
    },
    storage: new Map(),
    config: action === null ? {} : { stockPreparationTableActions: [action] },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services: {
      externalSystemRegistry: registry,
      adapterRegistry,
      pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
      pipelineRunner: inertService(['runPipeline']),
      deadLetterStore: inertService(['listDeadLetters']),
      stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
      templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
      readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
      readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
      bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, reader, loaded }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function callRoute(routes, { user, query = {} } = {}) {
  const handler = routes.get(`GET ${SOURCE_PREFLIGHT_ROUTE_PATH}`)
  assert.ok(handler, `route GET ${SOURCE_PREFLIGHT_ROUTE_PATH} is registered`)
  const res = createResponse()
  await handler({ user, body: {}, query, params: {} }, res)
  assert.notEqual(res.body, undefined)
  return res
}

async function routeIsRegisteredAtTheModulesOwnPath() {
  const declared = httpRoutes.ROUTES.filter(([, routePath]) => routePath === SOURCE_PREFLIGHT_ROUTE_PATH)
  assert.equal(declared.length, 1, 'the route table names the module`s own path exactly once')
  assert.deepEqual(declared[0], ['GET', SOURCE_PREFLIGHT_ROUTE_PATH, 'stockPreparationSourcePreflight'])
}

async function routeIsGatedOnTheIntegrationReadTier() {
  const { routes } = mountRoute({ catalog: orderModuleSource() })

  const anonymous = await callRoute(routes, { user: ANONYMOUS })
  assert.equal(anonymous.statusCode, 401)

  const noPermissions = await callRoute(routes, { user: LOGGED_IN })
  assert.equal(noPermissions.statusCode, 403)

  // R-11: source reads against the customer's system are not a queue-operator act, so the stock-prep
  // namespace does NOT open this route — it never falls through to integration:*.
  const operator = await callRoute(routes, { user: STOCK_PREP_OPERATOR })
  assert.equal(operator.statusCode, 403)

  for (const user of [INTEGRATION_READER, INTEGRATION_WRITER, PLATFORM_ADMIN]) {
    const allowed = await callRoute(routes, { user })
    assert.equal(allowed.statusCode, 200, `${user.id} is inside the read tier`)
    assert.equal(allowed.body.ok, true)
  }
}

async function routeDefaultsToTheConfiguredSourceAndAcceptsAnOverride() {
  const { routes, loaded } = mountRoute({
    catalog: customerShapedSource(),
    systems: {
      [SYSTEM_ID]: { id: SYSTEM_ID, kind: 'data-source:sql-readonly' },
      other_system: { id: 'other_system', kind: 'data-source:sql-readonly' },
    },
  })

  const byDefault = await callRoute(routes, { user: INTEGRATION_READER })
  assert.equal(byDefault.statusCode, 200)
  assert.equal(loaded[0].id, SYSTEM_ID, 'with no id the CONFIGURED action`s source is checked')
  assert.equal(byDefault.body.data.externalSystemId, SYSTEM_ID)
  // The end-to-end deliverable: the route reports INCIDENT A.
  assert.equal(byDefault.body.data.verdict, 'no-go')
  assert.ok(byDefault.body.data.blockers.some((entry) => entry.code === B.TOPOLOGY_MISMATCH))

  const overridden = await callRoute(routes, {
    user: INTEGRATION_READER,
    query: { externalSystemId: 'other_system' },
  })
  assert.equal(overridden.statusCode, 200)
  assert.equal(loaded[loaded.length - 1].id, 'other_system')
  assert.equal(overridden.body.data.externalSystemId, 'other_system')
}

async function noSourceAtAllIsAClearRefusal() {
  const { routes } = mountRoute({ catalog: orderModuleSource(), action: null })
  const res = await callRoute(routes, { user: INTEGRATION_READER })
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'SOURCE_PREFLIGHT_NO_SOURCE')
}

async function anUnreadableKindIsRefused() {
  const { routes } = mountRoute({
    catalog: orderModuleSource(),
    adapterOverride: { testConnection: async () => ({ ok: true }) },
  })
  const res = await callRoute(routes, { user: INTEGRATION_READER })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.error.code, 'SOURCE_PREFLIGHT_KIND_UNSUPPORTED')
}

async function theRequestSurfaceIsClosed() {
  const { routes } = mountRoute({ catalog: orderModuleSource() })
  // Every one of these would be a steering vector: an object to read, a page size, a read plan to
  // make the alignment check agree with itself.
  for (const query of [
    { object: 'DN_PDM_PartLibraryInfo' },
    { limit: '100000' },
    { readPlan: '{}' },
    { filters: 'x' },
    { actionId: PLM_STOCK_PREPARATION_ACTION_ID },
  ]) {
    const res = await callRoute(routes, { user: INTEGRATION_READER, query })
    assert.equal(res.statusCode, 400, `query key ${Object.keys(query)[0]} must be refused`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_SOURCE_PREFLIGHT_REQUEST_INVALID')
  }
}

async function theHttpBoundaryIsValuesFreeToo() {
  const { routes } = mountRoute({ catalog: poisonedSource() })
  const res = await callRoute(routes, { user: PLATFORM_ADMIN })
  assert.equal(res.statusCode, 200)
  const serialized = JSON.stringify(res.body)
  for (const planted of [PLANTED_PASSWORD, PLANTED_DSN, PLANTED_HOST, PLANTED_DRAWING, PLANTED_CUSTOMER]) {
    assert.equal(serialized.includes(planted), false, `planted value crossed the HTTP boundary: ${planted.slice(0, 8)}…`)
  }
}

// ---------------------------------------------------------------------------

async function main() {
  await healthyOrderModuleSource()
  console.log('  ✓ S-01 a healthy order-module source reads as go, and the node-type count is measured')
  await incidentAIsDetectedAndBlocked()
  console.log('  ✓ S-02 INCIDENT A: a DesignBom-shaped source is detected and the plan mismatch BLOCKS')
  await incidentBIsDetected()
  console.log('  ✓ S-03 INCIDENT B: an empty catalog blocks in one click instead of many steps later')
  await unreachableSourceIsItsOwnVerdict()
  console.log('  ✓ S-04 unreachable is one blocker, not a cascade')
  await missingEntryTableIsNotUnreachable()
  console.log('  ✓ S-05 a missing entry table is a different diagnosis from a missing connection')
  await countsAreHonestAboutTheCap()
  console.log('  ✓ S-06 a capped page reports a floor; a short page reports a total')
  await twoPopulatedTopologiesRefuseToGuess()
  console.log('  ✓ S-07 two populated topologies ask a human instead of guessing')
  await quantitySlotIsMeasuredTwoWays()
  await aPlanOnTheWrongSlotWarns()
  await anUnreadableDictionaryFallsBackToTheData()
  console.log('  ✓ S-08 the quantity slot is read from the customer`s dictionary AND from the data')
  await presetIdentityIsBySignatureNotByName()
  await anUnknownCatalogMatchesNothing()
  console.log('  ✓ S-09 vendor identity is by table signature, never by who the customer is')
  await everyReadIsUnfilteredAndCapped()
  await theProbeHoldsNothingButRead()
  await aMissingCapabilityIsRefusedNotFaked()
  console.log('  ✓ S-10 read-only, bounded, and holding one capability')
  await poisonedValuesNeverTravel()
  await livenessEvidenceIsBoundedAndScreened()
  console.log('  ✓ S-11 a poisoned catalog yields a report carrying none of the poison')
  await theSelfCheckIsNotVacuous()
  console.log('  ✓ S-12 the values-free self-check refuses secrets, unclassified leaves and code-field drift')
  await driverTextNeverReachesTheReport()
  await vocabulariesAreClosedAndOrdered()
  console.log('  ✓ S-13 driver text never travels; the vocabularies are closed and ordered')

  await routeIsRegisteredAtTheModulesOwnPath()
  await routeIsGatedOnTheIntegrationReadTier()
  console.log('  ✓ R-01 the route is registered at the module`s path and gated on the integration read tier')
  await routeDefaultsToTheConfiguredSourceAndAcceptsAnOverride()
  console.log('  ✓ R-02 the configured source is the default, and an explicit id overrides it')
  await noSourceAtAllIsAClearRefusal()
  await anUnreadableKindIsRefused()
  console.log('  ✓ R-03 nothing to check, and nothing readable, are both clear refusals')
  await theRequestSurfaceIsClosed()
  console.log('  ✓ R-04 the request cannot name an object, a page size or a read plan')
  await theHttpBoundaryIsValuesFreeToo()
  console.log('  ✓ R-05 the HTTP boundary is values-free too')

  console.log('stock-preparation-source-preflight: OK')
}

main()
