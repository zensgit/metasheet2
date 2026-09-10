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
  IDENTITY_PROBE_MAX,
  SOURCE_PREFLIGHT_BLOCKER_CODES,
  SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER,
  SOURCE_PREFLIGHT_WARNING_CODES,
  SOURCE_PREFLIGHT_READ_ERROR_CODES,
  SOURCE_PREFLIGHT_BRIDGES,
  SOURCE_PREFLIGHT_BINDING_SHAPES,
  PULL_DELEGATION_REASONS,
  DESIGN_BOM_BRIDGE_OBJECTS,
  LIVENESS_SAMPLE_MAX,
  PROJECT_NODE_TYPE,
  SourcePreflightError,
  runStockPreparationSourcePreflight,
  assertSourcePreflightValuesFree,
  describeValuesFreeRefusal,
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

// The shipped catalog, read the way the module reads it — so the roster assertion below is written
// against what actually ships rather than against a copy that could drift from it.
const SHIPPED_PRESETS = require(path.join(LIB, 'source-vendor-presets', 'preset-schema.cjs'))
  .loadVendorPresetsFromDir(path.join(LIB, 'source-vendor-presets'))
  .map((entry) => entry.preset)
const SHIPPED_SIGNATURE_TABLES = SHIPPED_PRESETS
  .flatMap((preset) => preset.matches.signatureTables)

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
    // The classic head/detail pair is EMPTY here — that is what makes this deployment genuinely
    // DesignBom-backed rather than merely DesignBom-heavy. With a matched dn-pdm preset, a populated
    // classic pair always pulls the AUTHORITY signal to `bom-details`, so a source where BOTH stores
    // carry lines can never resolve to design-bom — it conflicts, and a human decides. That is the
    // whole point of the revised rule, and `realCustomerShapedSource()` is that case.
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
    [DESIGN_BOM_OBJECT]: designBomRows(designBomLines),
  })
}

/**
 * GROUND TRUTH — the real customer PLM, measured read-only. Proportions preserved, values synthetic.
 *
 *   DN_PDM_OrderHeadInfo      1 row   /  DN_PDM_OrderDetailInfo  7 rows   (order module effectively dead)
 *   DN_PDM_BomHeadInfo      143 rows  /  DN_PDM_BomDetailsInfo 1319 rows, Bom_ExAttr1 columnar 100% numeric
 *   DN_PDM_DesignBom       2570 rows, NO ExAttr columns at all — slots are JSON KEYS inside `data`
 *
 * VOLUME says DesignBom (2570 > 1319). SHAPE and the preset's own AUTHORITY say BomDetails. The
 * customer's legacy 备料 system reads BomHeadInfo/BomDetailsInfo and references DesignBom nowhere, so
 * volume's answer is the WRONG carrier — and a confident wrong carrier is worse than a refusal.
 */
function realCustomerShapedSource() {
  const catalog = baseCatalog({
    DN_PDM_OrderHeadInfo: [{ ID: 1, OBJ_ID: 'ORDER-1', path_id: 'PATH-9' }],
    DN_PDM_OrderDetailInfo: Array.from({ length: 7 }, (_, index) => ({
      ID: index + 1,
      order_id: 'ORDER-1',
      part_id: `PART-${(index % 4) + 1}`,
      sort_id: index,
      quantity: String(index + 1),
    })),
    DN_PDM_BomHeadInfo: bomHeadRows(143),
    DN_PDM_BomDetailsInfo: bomDetailRows(1319),
  })
  // The real DesignBom columns, verbatim in shape: no ExAttr column anywhere, the dictionary values
  // living as JSON keys inside one nvarchar blob. 2458/2570 rows populated upstream; the same ~96%
  // ratio here, and `bom_exattr16` is present-but-EMPTY exactly as measured.
  catalog[DESIGN_BOM_OBJECT] = Array.from({ length: 2570 }, (_, index) => ({
    ID: index + 1,
    product_part_id: `PART-${(index % 4) + 1}`,
    obj_id: `DB-${index + 1}`,
    sort_id: index,
    SysVer: 'V1',
    pid: `DBP-${index + 1}`,
    data: index % 25 === 0
      ? ''
      : JSON.stringify({ pid: `DBP-${index + 1}`, material: 'S31603', specification: '', bom_exattr16: '' }),
    part_id: `PART-${(index % 4) + 1}`,
    path_id: 'PATH-1',
    creator: 'svc',
    createtime: '2026-01-01',
  }))
  return catalog
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
    declaredBridge: options.declaredBridge,
    ...(Object.prototype.hasOwnProperty.call(options, 'pullDelegation')
      ? { pullDelegation: options.pullDelegation }
      : {}),
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
  // Classic pair emptied so the STORE question resolves to design-bom and does not pre-empt the
  // bridge question — this test is about two ENTRIES of comparable volume, not two stores.
  catalog.DN_PDM_BomHeadInfo = []
  catalog.DN_PDM_BomDetailsInfo = []
  catalog[DESIGN_BOM_OBJECT] = designBomRows(14) // comparable to the 12 order lines, BOTH exact
  const { report } = await preflight(catalog)
  const topology = checkOf(report, 'topology')
  assert.equal(topology.detectedBridge, 'ambiguous')
  assert.equal(topology.reason, 'both-candidates-carry-comparable-line-volume')
  // A GENUINE tie: both counts are exact, so the comparison really was made and really came out close.
  assert.equal(topology.undecidableAtCap, false)
  blockerNamed(report, B.BRIDGE_AMBIGUOUS)
  assert.equal(report.blockers.some((entry) => entry.code === B.BRIDGE_UNDECIDABLE_AT_CAP), false)
  assert.equal(report.verdict, 'no-go')
}

// ---------------------------------------------------------------------------
// S-17 — GROUND TRUTH: volume alone picks the WRONG carrier, so it must not decide
// ---------------------------------------------------------------------------

async function volumeAloneMustNotPickTheCarrier() {
  const { report } = await preflight(realCustomerShapedSource())
  const store = checkOf(report, 'bomStore')

  // THE DEFECT, as a verdict: a volume-ranked rule reads 2570 > 1319 and says design-bom.
  assert.notEqual(store.store, 'design-bom',
    'volume must never hand over the carrier on its own — on this real catalog it is the wrong one')
  assert.equal(store.store, 'conflicted')
  // Both stores fill the sample cap, so the probe cannot see that DesignBom holds 2570 rows against
  // BomDetails' 1319 — and cannot rule it out either. Letting the cap manufacture agreement would be
  // "always prefer the preset's pair" wearing a measurement's clothes.
  assert.equal(store.reason, 'volume-undecidable-at-cap')
  assert.equal(store.volumeUndecidableAtCap, true)
  assert.equal(store.rowCap, SOURCE_PREFLIGHT_ROW_CAP)

  // The signals, and WHICH ONE FAVOURS WHICH — the sentence a refusal has to be able to say.
  const favours = Object.fromEntries(store.signals.map((entry) => [entry.signal, entry.favours]))
  assert.equal(favours.volume, null, 'volume cannot rank two stores that both fill the cap')
  assert.equal(favours.shape, 'bom-details', 'shape points at the columnar, densely-numeric one')
  assert.equal(favours.authority, 'bom-details', 'and so does the preset`s own declared BOM-line role')
  assert.equal(store.authorityBasis, 'preset-bom-line-quantity-role')

  // Both carriers named, with the evidence behind each.
  const byStore = Object.fromEntries(store.candidates.map((entry) => [entry.store, entry]))
  assert.equal(byStore['bom-details'].object, PLM_STOCK_PREPARATION_BOM_READ_PLAN.bomDetail.object)
  assert.equal(byStore['bom-details'].shape, 'columnar-numeric')
  assert.deepEqual(byStore['bom-details'].numericSlotColumns, ['Bom_ExAttr1'])
  assert.equal(byStore['design-bom'].object, DESIGN_BOM_OBJECT)
  assert.equal(byStore['design-bom'].shape, 'json-embedded')
  assert.deepEqual(byStore['design-bom'].familySlotColumns, [], 'the real DesignBom has NO ExAttr columns')
  assert.ok(byStore['design-bom'].lines > byStore['bom-details'].lines || !byStore['bom-details'].exact,
    'and it is the bigger table, which is exactly why volume misleads')

  // The blocker, carrying the whole disagreement.
  const blocker = blockerNamed(report, B.BOM_STORE_SIGNALS_CONFLICT)
  assert.equal(blocker.detail.reason, 'volume-undecidable-at-cap')
  assert.deepEqual(
    blocker.detail.candidates.map((entry) => entry.store).sort(),
    ['bom-details', 'design-bom'],
  )
  assert.deepEqual(blocker.detail.signals, store.signals)
  assert.equal(report.verdict, 'no-go')

  // And it is ranked above every bridge question — the more basic fact comes first.
  assert.equal(report.blockers[0].code, B.BOM_STORE_SIGNALS_CONFLICT)

  // THE VERDICT THE OLD RULE WOULD HAVE GIVEN. DesignBom holds 2570 rows against 7 order lines, so a
  // volume-ranked bridge decision hands over `design-bom` — the wrong carrier. It is not eligible as
  // an entry at all while the store question is unresolved.
  assert.notEqual(checkOf(report, 'topology').detectedBridge, 'design-bom',
    'an unresolved store must not let the biggest table become the entry')
  assert.equal(checkOf(report, 'topology').detectedBridge, 'order-module')

  // THE SAME DISAGREEMENT WHERE THE SAMPLE CAN SEE IT. Same proportions, both stores under the cap:
  // volume now really does point at the bigger DesignBom while shape and authority point at
  // BomDetails. Still a refusal, and now the volume signal names its store explicitly.
  const visible = realCustomerShapedSource()
  visible.DN_PDM_BomDetailsInfo = bomDetailRows(40)
  visible[DESIGN_BOM_OBJECT] = visible[DESIGN_BOM_OBJECT].slice(0, 150)
  const { report: seen } = await preflight(visible)
  const seenStore = checkOf(seen, 'bomStore')
  assert.equal(seenStore.store, 'conflicted')
  assert.equal(seenStore.reason, 'strong-signals-and-volume-disagree')
  const seenFavours = Object.fromEntries(seenStore.signals.map((entry) => [entry.signal, entry.favours]))
  assert.deepEqual(seenFavours, { authority: 'bom-details', shape: 'bom-details', volume: 'design-bom' })
  assert.notEqual(seenStore.store, 'design-bom', 'the bigger table does not win on being bigger')
  blockerNamed(seen, B.BOM_STORE_SIGNALS_CONFLICT)
}

async function jsonEmbeddedSlotsAreReportedNotSilentlyMissed() {
  // Force the design-BOM store to be the carrier so the JSON path is the one measured: strip the
  // classic pair, leaving DesignBom as the only store that carries lines.
  const catalog = realCustomerShapedSource()
  catalog.DN_PDM_BomHeadInfo = []
  catalog.DN_PDM_BomDetailsInfo = []
  const { report } = await preflight(catalog)

  assert.equal(checkOf(report, 'bomStore').store, 'design-bom', 'only one store carries lines now')
  const quantity = checkOf(report, 'quantityField')
  assert.equal(quantity.carrierObject, DESIGN_BOM_OBJECT)
  assert.equal(quantity.carrierShape, 'json-embedded')
  assert.equal(quantity.slotsUndetectable, true)

  // The slots ARE there — named, from the vendor's own pattern — they are simply not addressable by a
  // columnar read plan. Saying nothing here would render as "no quantity", which is wrong.
  assert.equal(quantity.jsonSlotColumn, 'data')
  assert.deepEqual(quantity.jsonFamilySlotKeys, ['bom_exattr16'])
  assert.ok(quantity.jsonOtherKeyCount >= 3, 'other JSON keys are COUNTED, never named')

  const warning = report.warnings.find((entry) => entry.code === W.QUANTITY_FIELD_UNDETECTABLE_ON_CARRIER)
  assert.ok(warning, `expected ${W.QUANTITY_FIELD_UNDETECTABLE_ON_CARRIER}, got ${JSON.stringify(codesOf(report.warnings))}`)
  assert.equal(warning.detail.jsonSlotColumn, 'data')
  // No confident claim about the configured field is made from a carrier we cannot read.
  assert.equal(report.warnings.some((entry) => entry.code === W.QUANTITY_FIELD_MISMATCH), false)
  assert.equal(report.warnings.some((entry) => entry.code === W.QUANTITY_FIELD_UNRESOLVED), false)

  // VALUES-FREE: the JSON blob's own values never travel, only the vendor slot key names.
  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes('S31603'), false, 'a material value inside the blob must not travel')
  assert.equal(serialized.includes('specification'), false, 'a non-family JSON key is counted, not named')
}

async function noConfidentQuantityClaimWhileTheStoreIsUnresolved() {
  // The plan is configured for a slot the carrier does NOT use, so the mismatch warning would fire on
  // any resolved store. It must stay silent while the store question is open: "your quantity column is
  // wrong" names a specific table, and we do not yet know which table should be read.
  const readPlan = {
    ...PLM_STOCK_PREPARATION_BOM_READ_PLAN,
    bomDetail: { ...PLM_STOCK_PREPARATION_BOM_READ_PLAN.bomDetail, quantityField: 'Bom_ExAttr7' },
  }
  const { report } = await preflight(realCustomerShapedSource(), { readPlan })
  const quantity = checkOf(report, 'quantityField')
  assert.equal(quantity.carrierUndecided, true)
  assert.equal(quantity.carrierStore, 'conflicted')
  assert.equal(quantity.resolvedSlot, 'Bom_ExAttr1', 'the reading itself still happens and is reported')
  assert.equal(quantity.matchesConfigured, false, 'and it does differ from the configured field')
  assert.equal(report.warnings.some((entry) => entry.code === W.QUANTITY_FIELD_MISMATCH), false,
    'but no mismatch is CLAIMED while the store is unresolved')

  // Once the store resolves, the same disagreement is reported normally.
  const settled = realCustomerShapedSource()
  settled[DESIGN_BOM_OBJECT] = settled[DESIGN_BOM_OBJECT].slice(0, 50)
  const { report: decided } = await preflight(settled, { readPlan })
  assert.equal(checkOf(decided, 'bomStore').store, 'bom-details')
  assert.ok(decided.warnings.some((entry) => entry.code === W.QUANTITY_FIELD_MISMATCH))
}

async function strongSignalsDisagreeingIsAlsoARefusal() {
  // authority says bom-details (the preset's declared BOM-line role, and the pair carries lines);
  // shape says design-bom (only DesignBom is columnar-numeric here). Two STRONG signals pointing
  // different ways is a refusal in its own right — volume never gets to break that tie.
  const catalog = realCustomerShapedSource()
  // BomDetails present and populated, but its slot is text — so it is columnar-PLAIN, not numeric.
  catalog.DN_PDM_BomDetailsInfo = bomDetailRows(30).map((row) => ({ ...row, Bom_ExAttr1: 'N/A' }))
  // DesignBom given real columnar numeric slots, and kept small so volume favours bom-details.
  catalog[DESIGN_BOM_OBJECT] = designBomRows(10)

  const { report } = await preflight(catalog)
  const store = checkOf(report, 'bomStore')
  assert.equal(store.store, 'conflicted')
  assert.equal(store.reason, 'strong-signals-disagree')
  const favours = Object.fromEntries(store.signals.map((entry) => [entry.signal, entry.favours]))
  assert.equal(favours.authority, 'bom-details')
  assert.equal(favours.shape, 'design-bom')
  assert.equal(favours.volume, 'bom-details', 'volume agrees with authority and STILL does not settle it')
  blockerNamed(report, B.BOM_STORE_SIGNALS_CONFLICT)
}

async function agreeingSignalsStillDecide() {
  // The guard against over-correcting into "always refuse". Same real shape, but DesignBom is small
  // enough that volume agrees with shape and authority instead of fighting them — all three point at
  // bom-details, and the store IS decided.
  const catalog = realCustomerShapedSource()
  catalog[DESIGN_BOM_OBJECT] = catalog[DESIGN_BOM_OBJECT].slice(0, 50)
  const { report } = await preflight(catalog)
  const store = checkOf(report, 'bomStore')

  assert.equal(store.store, 'bom-details')
  assert.equal(store.reason, 'strong-signals-agree')
  const favours = Object.fromEntries(store.signals.map((entry) => [entry.signal, entry.favours]))
  assert.deepEqual(favours, { authority: 'bom-details', shape: 'bom-details', volume: 'bom-details' })
  assert.equal(report.blockers.some((entry) => entry.code === B.BOM_STORE_SIGNALS_CONFLICT), false)
  // A decided store yields a real quantity answer again.
  assert.equal(checkOf(report, 'quantityField').carrierUndecided, false)
  assert.equal(checkOf(report, 'quantityField').resolvedSlot, 'Bom_ExAttr1')
}

async function theOriginalIncidentStillLands() {
  // INCIDENT A, unchanged: an order-module read plan against a source whose BOM really is in
  // DesignBom (the classic pair empty, so nothing contests the store).
  const { report } = await preflight(customerShapedSource())
  const store = checkOf(report, 'bomStore')
  assert.equal(store.store, 'design-bom')
  assert.equal(store.reason, 'only-one-store-carries-lines')
  assert.equal(checkOf(report, 'topology').detectedBridge, 'design-bom')
  blockerNamed(report, B.TOPOLOGY_MISMATCH)
  // The empty classic pair is the EXPECTED shape here, not missing data.
  assert.equal(report.blockers.some((entry) => entry.code === B.NO_BOM_ROWS), false)
}

// ---------------------------------------------------------------------------
// S-14 — cap saturation is its own answer, and it has a way out
// ---------------------------------------------------------------------------

/** Both carriers full past the sample cap — the shape every real, busy deployment has. */
function bothBridgesSaturatedSource() {
  const catalog = orderModuleSource()
  // Classic pair emptied for the same reason as above: this fixture is about two ENTRIES saturating
  // the sample cap, and a populated classic pair would settle the STORE question first.
  catalog.DN_PDM_BomHeadInfo = []
  catalog.DN_PDM_BomDetailsInfo = []
  catalog.DN_PDM_OrderDetailInfo = Array.from({ length: SOURCE_PREFLIGHT_ROW_CAP + 900 }, (_, index) => ({
    ID: index + 1,
    order_id: `ORDER-${(index % 2) + 1}`,
    part_id: `PART-${(index % 4) + 1}`,
    sort_id: index,
    quantity: String(index + 1),
  }))
  catalog[DESIGN_BOM_OBJECT] = designBomRows(SOURCE_PREFLIGHT_ROW_CAP + 2400)
  return catalog
}

async function capSaturationIsDistinguishableFromATie() {
  const { report } = await preflight(bothBridgesSaturatedSource())
  const topology = checkOf(report, 'topology')

  // The verdict is still a refusal — we do not guess — but it is a DIFFERENT refusal, and it says why.
  assert.equal(topology.detectedBridge, 'ambiguous')
  assert.equal(topology.undecidableAtCap, true)
  assert.equal(topology.reason, 'both-candidates-saturate-the-sample-cap')
  assert.notEqual(topology.reason, 'both-candidates-carry-comparable-line-volume',
    'a standoff at the cap must never be reported as a measured tie')

  const blocker = blockerNamed(report, B.BRIDGE_UNDECIDABLE_AT_CAP)
  assert.equal(report.blockers.some((entry) => entry.code === B.BRIDGE_AMBIGUOUS), false,
    'the two ambiguity codes are mutually exclusive: an operator must be able to tell them apart')

  // ACTIONABLE: the refusal carries the cap that produced it and the way out.
  assert.equal(blocker.detail.rowCap, SOURCE_PREFLIGHT_ROW_CAP)
  assert.deepEqual(blocker.detail.declarableBridges, ['order-module', 'design-bom'])
  assert.equal(blocker.detail.orderLineObject, PLM_STOCK_PREPARATION_BOM_READ_PLAN.orderDetail.object)
  assert.equal(blocker.detail.designBomLineObject, DESIGN_BOM_OBJECT)
  assert.equal(report.verdict, 'no-go')
}

async function aDeclarationResolvesWhatTheSampleCannotRank() {
  const { report } = await preflight(bothBridgesSaturatedSource(), { declaredBridge: 'design-bom' })
  const topology = checkOf(report, 'topology')

  assert.equal(topology.detectedBridge, 'design-bom')
  // PROVENANCE: the report never lets a human's answer be read back as a measurement.
  assert.equal(topology.bridgeSource, 'declared')
  assert.equal(topology.declaredBridge, 'design-bom')
  assert.equal(topology.measuredBridge, 'ambiguous')
  assert.ok(report.warnings.some((entry) => entry.code === W.BRIDGE_DECLARED_NOT_MEASURED))
  assert.equal(report.blockers.some((entry) => entry.code === B.BRIDGE_UNDECIDABLE_AT_CAP), false)

  // And the alignment check then runs against the declared bridge — the whole point of resolving it.
  assert.equal(topology.matchesConfigured, false)
  blockerNamed(report, B.TOPOLOGY_MISMATCH)

  // Declaring the CONFIGURED bridge clears every bridge blocker: a runnable deployment.
  const { report: aligned } = await preflight(bothBridgesSaturatedSource(), { declaredBridge: 'order-module' })
  assert.equal(aligned.checks.topology.detectedBridge, 'order-module')
  assert.equal(aligned.checks.topology.matchesConfigured, true)
  assert.deepEqual(codesOf(aligned.blockers), [])
  assert.equal(aligned.verdict, 'go')
  assert.ok(aligned.warnings.some((entry) => entry.code === W.BRIDGE_DECLARED_NOT_MEASURED),
    'even a go verdict says the bridge was declared, not measured')
}

async function aDeclarationCannotOverruleAMeasurement() {
  // The live customer's shape measures DECISIVELY as design-bom. An operator declaring order-module
  // must be refused, not obeyed — otherwise the one measurement this module exists to make becomes a
  // formality anyone can wave away.
  const { report } = await preflight(customerShapedSource(), { declaredBridge: 'order-module' })
  const blocker = blockerNamed(report, B.DECLARED_BRIDGE_CONTRADICTS_MEASUREMENT)
  assert.equal(blocker.detail.declaredBridge, 'order-module')
  assert.equal(blocker.detail.measuredBridge, 'design-bom')
  assert.equal(checkOf(report, 'topology').detectedBridge, 'design-bom',
    'the MEASUREMENT stands; the declaration is reported as contradicted, never applied')
  assert.equal(checkOf(report, 'topology').bridgeSource, 'measured')
  assert.equal(report.verdict, 'no-go')

  // Nor can a declaration conjure a bridge into an empty catalog — that is how a zero-row run gets
  // blessed, which is the failure this whole module was written for.
  const { report: empty } = await preflight(emptySource(), { declaredBridge: 'design-bom' })
  assert.equal(empty.checks.topology.detectedBridge, 'none')
  blockerNamed(empty, B.NO_BOM_BRIDGE)
  assert.equal(empty.verdict, 'no-go')

  // Nor break a genuine, exactly-counted tie: that tie is a real measurement.
  const tie = orderModuleSource()
  tie.DN_PDM_BomHeadInfo = []
  tie.DN_PDM_BomDetailsInfo = []
  tie[DESIGN_BOM_OBJECT] = designBomRows(14)
  const { report: tied } = await preflight(tie, { declaredBridge: 'design-bom' })
  assert.equal(tied.checks.topology.detectedBridge, 'ambiguous')
  assert.equal(tied.checks.topology.bridgeSource, 'measured')
}

// ---------------------------------------------------------------------------
// S-15 — a role addressing several objects collapses to the STRONGEST, not the first
// ---------------------------------------------------------------------------

async function roleCollapseTakesTheStrongestCarrier() {
  // Both design-BOM spellings exist: a five-row legacy leftover FIRST in roster order, and the real
  // one second. First-wins would read design-bom volume as five and tilt the verdict.
  const catalog = customerShapedSource({ designBomLines: 250 })
  catalog[DESIGN_BOM_BRIDGE_OBJECTS[0]] = designBomRows(5)
  catalog[DESIGN_BOM_BRIDGE_OBJECTS[1]] = designBomRows(250)

  const { report } = await preflight(catalog)
  const candidate = checkOf(report, 'topology').candidates.find((entry) => entry.bridge === 'design-bom')

  assert.equal(candidate.lineObject, DESIGN_BOM_BRIDGE_OBJECTS[1], 'the STRONGEST carrier wins, not the first')
  assert.ok(candidate.lineRows >= SOURCE_PREFLIGHT_ROW_CAP)
  // Both are still reported, so the collapse is auditable rather than invisible.
  assert.deepEqual(
    candidate.contributingObjects.map((entry) => entry.object).sort(),
    [...DESIGN_BOM_BRIDGE_OBJECTS].sort(),
  )
  assert.equal(candidate.contributingObjects.find((e) => e.object === DESIGN_BOM_BRIDGE_OBJECTS[0]).rowsObserved, 5)

  // And the verdict follows the real carrier.
  assert.equal(checkOf(report, 'topology').detectedBridge, 'design-bom')
  blockerNamed(report, B.TOPOLOGY_MISMATCH)

  // The SAMPLED ROWS follow the winner too — the slot measurement must describe the table the verdict
  // rests on, not a different one that happened to answer first.
  assert.equal(checkOf(report, 'quantityField').carrierObject, DESIGN_BOM_BRIDGE_OBJECTS[1])
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

// ---------------------------------------------------------------------------
// S-16 — the quantity reading refuses to pick a winner out of a field
// ---------------------------------------------------------------------------

/** A BOM line whose slots carry quantity AND weight — both numeric, both plausible. */
function twoNumericSlotsSource() {
  const catalog = customerShapedSource()
  catalog[DESIGN_BOM_OBJECT] = catalog[DESIGN_BOM_OBJECT].map((row, index) => ({
    ...row,
    bom_exattr4: String((index % 13) + 0.5), // a weight column: just as numeric as the quantity
  }))
  return catalog
}

async function twoPlausibleQuantitySlotsAreNotGuessedBetween() {
  // With the dictionary UNREADABLE there is nothing to break the tie, so the reading must refuse.
  const { report } = await preflight(twoNumericSlotsSource(), { missingObjects: ['DN_PM_BomExAttrInfo'] })
  const quantity = checkOf(report, 'quantityField')

  assert.deepEqual(quantity.qualifyingSlots.slice().sort(), ['bom_exattr1', 'bom_exattr4'])
  assert.equal(quantity.measuredAmbiguous, true)
  assert.equal(quantity.measuredSlot, null, 'the sort order is not evidence; nothing is picked')
  assert.equal(quantity.resolvedSlot, null)

  const warning = report.warnings.find((entry) => entry.code === W.QUANTITY_FIELD_AMBIGUOUS)
  assert.ok(warning, `expected ${W.QUANTITY_FIELD_AMBIGUOUS}, got ${JSON.stringify(codesOf(report.warnings))}`)
  assert.deepEqual(warning.detail.candidates.slice().sort(), ['bom_exattr1', 'bom_exattr4'])
  assert.equal(warning.detail.configuredAmongCandidates, true)

  // THE POINT: no confident mismatch is claimed. Before this rule, the sort winner could have named a
  // wrong column and sent an implementer to change a correct configuration.
  assert.equal(report.warnings.some((entry) => entry.code === W.QUANTITY_FIELD_MISMATCH), false)
  assert.equal(report.warnings.some((entry) => entry.code === W.QUANTITY_FIELD_UNRESOLVED), false)
}

async function theCustomersOwnDictionaryBreaksTheTie() {
  // Same two-numeric-slot catalog, dictionary READABLE. A dictionary is the customer's declaration
  // about their own schema — evidence, unlike a sort order — so it resolves the field.
  const { report } = await preflight(twoNumericSlotsSource())
  const quantity = checkOf(report, 'quantityField')

  assert.deepEqual(quantity.qualifyingSlots.slice().sort(), ['bom_exattr1', 'bom_exattr4'])
  assert.equal(quantity.measuredAmbiguous, false, 'the dictionary named one of the candidates')
  assert.equal(quantity.dictionarySlot, 'Bom_ExAttr1')
  assert.equal(quantity.measuredSlot, 'bom_exattr1')
  assert.equal(quantity.resolvedSlot, 'Bom_ExAttr1')
  assert.equal(report.warnings.some((entry) => entry.code === W.QUANTITY_FIELD_AMBIGUOUS), false)
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

  // The signature is measured in FULL. A catalog carrying every signature table reports none missing —
  // which is only true because the roster asks about the tables the plan does not name. Reporting a
  // dictionary table as "missing" because nobody asked would read like drift and be an artifact.
  assert.deepEqual(a.checks.presetMatch.missingSignatureTables, [])
  assert.equal(a.checks.presetMatch.matchedSignatureTables, SHIPPED_SIGNATURE_TABLES.length)

  // And a genuinely absent signature table is reported as absent — the same field, telling the truth
  // in the other direction.
  const { report: drifted } = await preflight(customerShapedSource(), {
    missingObjects: ['DN_PM_OrderExAttrInfo'],
  })
  assert.deepEqual(drifted.checks.presetMatch.missingSignatureTables, ['DN_PM_OrderExAttrInfo'])
  assert.equal(drifted.checks.presetMatch.presetId, 'dn-pdm-family',
    'one absent dictionary table is drift, not a different vendor — the floor still clears')
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
  // The roster is finite and DERIVED: the plan's own objects, the declared bridge candidates, and the
  // shipped catalog's signature tables (so "missing from the signature" means measured-absent rather
  // than never-asked). Nothing else may be read.
  const probed = new Set(calls.map((call) => call.object))
  const expected = new Set([
    ...Object.values(PLM_STOCK_PREPARATION_BOM_READ_PLAN)
      .filter((entry) => entry && typeof entry === 'object' && entry.object)
      .map((entry) => entry.object),
    ...DESIGN_BOM_BRIDGE_OBJECTS,
    ...SHIPPED_SIGNATURE_TABLES,
  ])
  for (const object of probed) {
    assert.ok(expected.has(object), `probed an object outside the roster: ${object}`)
  }
  assert.equal(report.probes.length, calls.length)
  // Bounded: the identity top-up cannot grow the roster without limit as the catalog grows.
  const identityProbes = report.probes.filter((entry) => entry.role === 'signature')
  assert.ok(identityProbes.length <= IDENTITY_PROBE_MAX)
  assert.ok(identityProbes.length > 0, 'the catalog names signature tables the plan does not')
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

// A REALISTIC `data-source:sql-readonly` ROW: a canonical Connection reference plus the server-held
// owner stamp the registry writes at bind time. The stub used to carry neither, which made every
// route case look like a binding whose pull can only ever be run by the person who bound it — the
// exact condition `PULL_PRINCIPAL_DELEGATION_UNAVAILABLE` now names (see R-07).
function boundSystem(id, overrides = {}) {
  return {
    id,
    kind: 'data-source:sql-readonly',
    connectionId: `conn_${id}`,
    // `lookupProjection` is the PRIVATE subtree for this kind: present on the adapter-ready row,
    // deleted from the public projection. It is what makes the two accessors distinguishable.
    config: { schema: 'dbo', dataSourceOwnerId: 'u_binding_owner', lookupProjection: { table: 'dbo.parts' } },
    ...overrides,
  }
}

function mountRoute({ catalog, action = tableActionConfig(), systems, adapterOverride, logger } = {}) {
  const routes = new Map()
  const reader = catalog ? createReader(catalog) : null
  const loaded = []
  const storedSystem = (input) => {
    const system = (systems || { [SYSTEM_ID]: boundSystem(SYSTEM_ID) })[input.id]
    if (!system) {
      const error = new Error('external system not found')
      error.name = 'ExternalSystemNotFoundError'
      throw error
    }
    return system
  }
  // G4/M2 (#5553 §3). These used to be ONE function under two names, which is the shape the design
  // rules out: with an alias, a call site that degraded from the decrypting accessor back to the
  // public projection returns the identical object and every assertion here still passes. They are
  // now distinct — `getExternalSystem` deletes the private config subtree that `publicRow()` deletes
  // for this kind (external-systems.cjs PRIVATE_CONFIG_KEYS_BY_KIND: `lookupProjection`) — and
  // `loaded` counts the DECRYPTING loads only.
  const registry = {
    ...inertService(['upsertExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
    async getExternalSystem(input) {
      const system = storedSystem(input)
      const { lookupProjection, ...publicConfig } = system.config || {}
      return { ...system, config: publicConfig }
    },
    async getExternalSystemForAdapter(input) {
      loaded.push(input)
      return storedSystem(input)
    },
  }
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
    // A caller may inject a recording logger (see `createRecordingLogger` below, R-08) to observe
    // what `routeLogger` is wired with, or explicitly pass `logger: null` to mean NO logger at all
    // (`routeLogger` resolves to `null`, http-routes.cjs:~3582) — distinguished from "not passed",
    // which stays a no-op so every other case is unaffected.
    logger: logger === undefined ? { info() {}, warn() {}, error() {} } : logger,
  })
  return { routes, reader, loaded }
}

/** Captures every `warn(message, payload)` call, for R-08 (values-free refusal logging). */
function createRecordingLogger() {
  const warnCalls = []
  return {
    warnCalls,
    info() {},
    warn(message, payload) { warnCalls.push([message, payload]) },
    error() {},
  }
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
      [SYSTEM_ID]: boundSystem(SYSTEM_ID),
      other_system: boundSystem('other_system'),
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

  // `declaredBridge` IS accepted — and only as one of two words. It is a declaration, not a text
  // channel, and a mistyped one is refused AT THE EDGE rather than quietly ignored (which would hand
  // back a measured report to someone who believes they declared something).
  for (const value of ['designbom', 'DESIGN-BOM', 'ambiguous', 'none', 'unknown', '', 'order module']) {
    const res = await callRoute(routes, { user: INTEGRATION_READER, query: { declaredBridge: value } })
    assert.equal(res.statusCode, 400, `declaredBridge=${JSON.stringify(value)} must be refused`)
    assert.equal(res.body.error.code, 'STOCK_PREPARATION_SOURCE_PREFLIGHT_REQUEST_INVALID')
  }
  for (const value of ['order-module', 'design-bom']) {
    const res = await callRoute(routes, { user: INTEGRATION_READER, query: { declaredBridge: value } })
    assert.equal(res.statusCode, 200, `declaredBridge=${value} is one of the two candidates`)
    assert.equal(res.body.data.checks.topology.declaredBridge, value)
  }
}

async function aDeclarationTravelsThroughTheRoute() {
  const { routes } = mountRoute({ catalog: bothBridgesSaturatedSource() })

  // Without it: the distinguishable, actionable standoff.
  const undeclared = await callRoute(routes, { user: INTEGRATION_READER })
  assert.equal(undeclared.statusCode, 200)
  assert.equal(undeclared.body.data.checks.topology.undecidableAtCap, true)
  assert.ok(undeclared.body.data.blockers.some((entry) => entry.code === B.BRIDGE_UNDECIDABLE_AT_CAP))

  // With it: resolved, and labelled as declared all the way out to the wire.
  const declared = await callRoute(routes, {
    user: INTEGRATION_READER,
    query: { declaredBridge: 'order-module' },
  })
  assert.equal(declared.statusCode, 200)
  assert.equal(declared.body.data.checks.topology.detectedBridge, 'order-module')
  assert.equal(declared.body.data.checks.topology.bridgeSource, 'declared')
  assert.equal(declared.body.data.verdict, 'go')
  assert.ok(declared.body.data.warnings.some((entry) => entry.code === W.BRIDGE_DECLARED_NOT_MEASURED))
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
// S-18 — THE BINDING HALF: can this source's pull delegate its read identity at all
// ---------------------------------------------------------------------------
//
// The source-shape checks measure the CUSTOMER's catalog. This one reports a fact about OUR side:
// `data-source:*` bindings are authorized by the host facade on strict owner equality, so unless the
// binding carries a server-held owner stamp, only the person who bound the connection can ever pull
// through it — whatever the catalog looks like. A perfect source that nobody but the binder can read
// is a no-go for a delivery that promises 一线自助拉取, and before this the report said `go`.
async function theBindingHalfIsReportedAndBlocks() {
  // 1. NOT EVALUATED is the default, and it is silent. A caller that never heard of this input gets
  //    the report it always got.
  {
    const { report } = await preflight(orderModuleSource())
    assert.deepEqual(
      checkOf(report, 'pullDelegation'),
      { evaluated: false, available: null, bindingShape: null, reason: null },
      'S-18: with no stanza the check is not evaluated',
    )
    assert.equal(report.verdict, 'go', 'S-18: and an unevaluated check blocks nothing')
  }

  // 2. AVAILABLE -> reported, no blocker. The shape travels so an implementer can see WHICH binding
  //    shape answered without ever being told the connection id.
  {
    const { report } = await preflight(orderModuleSource(), {
      pullDelegation: { available: true, bindingShape: 'canonical', reason: null },
    })
    assert.deepEqual(checkOf(report, 'pullDelegation'), {
      evaluated: true, available: true, bindingShape: 'canonical', reason: null,
    })
    assert.deepEqual(codesOf(report.blockers), [], 'S-18: an available delegation blocks nothing')
    assert.equal(report.verdict, 'go')
  }

  // 3. UNAVAILABLE -> a BLOCKER on an otherwise flawless source, carrying the shape and the reason.
  {
    const { report } = await preflight(orderModuleSource(), {
      pullDelegation: { available: false, bindingShape: 'canonical', reason: 'binding_owner_unstamped' },
    })
    assert.equal(report.verdict, 'no-go', 'S-18: a source only its binder can read is not go')
    const blocker = report.blockers.find((entry) => entry.code === B.PULL_PRINCIPAL_DELEGATION_UNAVAILABLE)
    assert.ok(blocker, 'S-18: and the blocker is raised')
    assert.deepEqual(blocker.detail, { bindingShape: 'canonical', reason: 'binding_owner_unstamped' })
    // Everything else about this source still measured clean — the blocker is ADDITIVE, it does not
    // suppress or cascade into the shape findings.
    assert.equal(checkOf(report, 'reachability').reachable, true)
    assert.equal(checkOf(report, 'topology').matchesConfigured, true)
  }

  // 4. IT IS JUDGED EVEN WHEN THE SOURCE CANNOT BE REACHED — two independent facts, two blockers,
  //    ordered with unreachable first.
  {
    const { report } = await preflight(orderModuleSource(), {
      failEveryRead: 'connection refused',
      pullDelegation: { available: false, bindingShape: 'legacy', reason: 'binding_owner_unstamped' },
    })
    assert.deepEqual(
      codesOf(report.blockers),
      [B.SOURCE_UNREACHABLE, B.PULL_PRINCIPAL_DELEGATION_UNAVAILABLE],
      'S-18: unreachable leads; the binding finding is still reported, not swallowed',
    )
  }

  // 5. A GARBLED STANZA IS NOT A MEASUREMENT. Anything that is not a literal boolean `available`, and
  //    any word outside the closed vocabularies, degrades to not-evaluated / null rather than
  //    reaching the report — which is what keeps this input from becoming a free-text channel.
  {
    const { report } = await preflight(orderModuleSource(), {
      pullDelegation: { available: 'false', bindingShape: 'canonical' },
    })
    assert.equal(checkOf(report, 'pullDelegation').evaluated, false, 'S-18: a non-boolean is no answer')
  }
  {
    const { report } = await preflight(orderModuleSource(), {
      pullDelegation: { available: false, bindingShape: 'DSN=srv;pwd=hunter2', reason: 'because reasons' },
    })
    const check = checkOf(report, 'pullDelegation')
    assert.equal(check.bindingShape, null, 'S-18: an off-vocabulary shape is dropped, not echoed')
    assert.equal(check.reason, null, 'S-18: and so is an off-vocabulary reason')
    assert.equal(
      JSON.stringify(report).includes('hunter2'),
      false,
      'S-18: nothing from a garbled stanza reaches the report',
    )
  }

  // 6. THE VOCABULARIES ARE CLOSED AND THE CODE IS ORDERED — the same discipline every other code in
  //    this module is held to.
  assert.ok(
    SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER.includes(B.PULL_PRINCIPAL_DELEGATION_UNAVAILABLE),
    'S-18: an unordered blocker sorts to the end by accident rather than by decision',
  )
  assert.deepEqual([...SOURCE_PREFLIGHT_BINDING_SHAPES], ['canonical', 'legacy', 'unbound'])
  assert.deepEqual([...PULL_DELEGATION_REASONS], ['binding_owner_unstamped'])
}

// ---------------------------------------------------------------------------
// R-07 — the route computes the binding half from the SAME row it built the adapter from
// ---------------------------------------------------------------------------
async function theRouteReportsWhetherThePullCanDelegate() {
  // A canonical binding with NO server-held owner stamp — the shape every 222 row had, and the one
  // that made every operator pull 400 with nothing anywhere explaining it.
  {
    const { routes } = mountRoute({
      catalog: orderModuleSource(),
      systems: {
        [SYSTEM_ID]: boundSystem(SYSTEM_ID, { config: { schema: 'dbo' } }),
      },
    })
    const res = await callRoute(routes, { user: INTEGRATION_READER })
    assert.equal(res.statusCode, 200)
    const blocker = res.body.data.blockers.find((entry) => entry.code === B.PULL_PRINCIPAL_DELEGATION_UNAVAILABLE)
    assert.ok(blocker, 'R-07: an unstamped canonical binding is reported at the route')
    assert.deepEqual(blocker.detail, { bindingShape: 'canonical', reason: 'binding_owner_unstamped' })
    assert.deepEqual(res.body.data.checks.pullDelegation, {
      evaluated: true, available: false, bindingShape: 'canonical', reason: 'binding_owner_unstamped',
    })
  }

  // The same source with the stamp present: clean.
  {
    const { routes } = mountRoute({ catalog: orderModuleSource() })
    const res = await callRoute(routes, { user: INTEGRATION_READER })
    assert.equal(res.body.data.verdict, 'go')
    assert.equal(res.body.data.checks.pullDelegation.available, true)
  }

  // A LEGACY-pointer binding is the same question with a different shape word.
  {
    const { routes } = mountRoute({
      catalog: orderModuleSource(),
      systems: {
        [SYSTEM_ID]: boundSystem(SYSTEM_ID, { connectionId: null, config: { dataSourceId: 'ds_1' } }),
      },
    })
    const res = await callRoute(routes, { user: INTEGRATION_READER })
    assert.equal(res.body.data.checks.pullDelegation.bindingShape, 'legacy')
    assert.equal(res.body.data.checks.pullDelegation.available, false)
  }

  // AND THE ROUTE NEVER LEAKS THE ANSWER'S INPUTS: neither the connection id nor the owner id is a
  // field of the report, in any binding shape.
  {
    const { routes } = mountRoute({ catalog: orderModuleSource() })
    const res = await callRoute(routes, { user: INTEGRATION_READER })
    const serialized = JSON.stringify(res.body)
    assert.equal(serialized.includes('u_binding_owner'), false, 'R-07: the owner id never travels')
    assert.equal(serialized.includes(`conn_${SYSTEM_ID}`), false, 'R-07: nor the connection id')
  }
}

// ---------------------------------------------------------------------------
// R-08 — 222 2026-09-08: the values-free self-check's refusal reached a real customer as
// `SOURCE_PREFLIGHT_FAILED` / `{"reason":"SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED"}` and
// NOTHING else anywhere — the self-check's own `path`/`kind`/`length`/`masked` never left
// `error.details` for pm2. `describeValuesFreeRefusal` (exported alongside `refuse`, above) picks
// exactly those four keys and NOTHING else off the caught error; the route logs them plus
// `externalSystemId` on one `warn`, and the wire response stays byte-identical.
// ---------------------------------------------------------------------------

// The value the fixture below gets the self-check to refuse. Length 11 (>= 6, per the PR spec),
// so a masked stub (`B****9`) is trivially distinguishable from the real thing in every assertion.
const SELF_CHECK_TRIPPING_VALUE = 'Bom_ExAttr9'

/**
 * A catalog that trips the values-free self-check ITSELF — distinct from `poisonedSource()` above,
 * whose planted values are redacted well before the self-check ever runs (see `poisonedValuesNeverTravel`).
 *
 * The mechanism: the customer's OWN quantity dictionary (`DN_PM_BomExAttrInfo`, read by
 * `decodeQuantitySlotFromDictionary`) names a family slot — `Bom_ExAttr9`, within the `bomDetailExAttr`
 * family's declared index range 1..30 (`dn-pdm-family.preset.json`) — that is enabled (`isable: 1`,
 * `nonzero-means-enabled`) and labelled with the quantity hint ('数量'). The decoder reads that
 * assignment straight off the dictionary ROW, exactly as it must (that reading IS the feature: see
 * `theCustomersOwnDictionaryBreaksTheTie`). But THIS slot is not a column any probed table actually
 * has — `orderModuleSource()`'s `DN_PDM_BomDetailsInfo` only carries `Bom_ExAttr1`/`Bom_ExAttr2` — so
 * it never enters `identifiers` (built only from columns THIS RUN observed), while it DID enter
 * `observedValues` (every string cell of every sampled row, dictionary included). The report then
 * carries it at `checks.quantityField.dictionarySlot`, and `assertSourcePreflightValuesFree` refuses
 * that leaf as class `dictionarySlot` reproducing an observed value nobody can vouch for as a real
 * identifier of this source. Everything else is `orderModuleSource()`, unmodified — a fixture already
 * proven (S-01) to pass the self-check on its own, so this is the ONE deliberate difference.
 */
function selfCheckTrippingSource() {
  const catalog = orderModuleSource()
  catalog.DN_PM_BomExAttrInfo = [{
    describes_table: 'DN_PDM_BomDetailsInfo',
    ID: 9,
    attr_name: SELF_CHECK_TRIPPING_VALUE,
    display_name: '数量',
    attr_type: 'float',
    isable: 1,
    sort_id: 1,
  }]
  return catalog
}

/**
 * Every string leaf of `object` neither equals nor contains `value`.
 *
 * PARTIAL-BY-DESIGN, and this assertion does NOT say otherwise: `masked` carries the refused value's
 * FIRST and LAST character plus, beside it, an exact `length`. That is whole-value containment this
 * checks, not information-theoretic secrecy — `B****9` passes here and still narrows the candidates.
 * The narrowing is bounded on purpose elsewhere, not here: `describeValuesFreeRefusal` republishes
 * the mask only from length 5 up (below that '**', see `MASKED_FIRST_LAST_MIN_LENGTH`) and publishes
 * no mask at all for `kind: 'secret'`. Both floors are asserted directly, further down.
 */
function assertNoStringLeafCarries(object, value, label) {
  for (const [key, leaf] of Object.entries(object)) {
    if (typeof leaf !== 'string') continue
    assert.notEqual(leaf, value, `${label}.${key} must not equal the refused value`)
    assert.equal(leaf.includes(value), false, `${label}.${key} must not contain the refused value`)
  }
}

async function theSelfCheckRefusalDescriptorIsExactlyTheFourKeys() {
  let caught = null
  try {
    await preflight(selfCheckTrippingSource())
    assert.fail('expected the values-free self-check to refuse this catalog')
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SourcePreflightError)
  assert.equal(caught.message, 'SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED')
  assert.equal(caught.details.kind, 'observed-row-value')

  // (a) the picker returns EXACTLY the four keys, values matching `error.details` verbatim.
  const described = describeValuesFreeRefusal(caught)
  assert.ok(described)
  assert.deepEqual(Object.keys(described).sort(), ['kind', 'length', 'masked', 'path'])
  assert.deepEqual(described, {
    path: caught.details.path,
    kind: caught.details.kind,
    length: caught.details.length,
    masked: caught.details.masked,
  })
  assert.equal(described.length, SELF_CHECK_TRIPPING_VALUE.length)
  assert.match(described.masked, /^.\*{4}.$/)

  // (d) VALUES-FREE: nothing the picker hands back equals or contains the value the self-check
  // actually refused.
  assertNoStringLeafCarries(described, SELF_CHECK_TRIPPING_VALUE, 'described')

  // (c) REVERSE — the picker answers `null` for every `SourcePreflightError` that is not this exact
  // refusal, and for anything that is not a `SourcePreflightError` at all. This module has exactly
  // one other throw site (the missing-capability guard); exercised for real, not hand-built.
  let capabilityError = null
  try {
    await runStockPreparationSourcePreflight({})
    assert.fail('expected a capability refusal')
  } catch (error) {
    capabilityError = error
  }
  assert.ok(capabilityError instanceof SourcePreflightError)
  assert.notEqual(capabilityError.message, 'SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED')
  assert.equal(describeValuesFreeRefusal(capabilityError), null, 'a different SourcePreflightError must not match')

  // A hand-built SourcePreflightError with the RIGHT-shaped `details` but a DIFFERENT message: matched
  // by message, never merely by whether `details` happens to look right.
  assert.equal(
    describeValuesFreeRefusal(new SourcePreflightError('some other refusal', {
      path: 'x', kind: 'observed-row-value', length: 3, masked: 'a**b',
    })),
    null,
    'matched by message, not by details shape',
  )
  assert.equal(describeValuesFreeRefusal(new Error('boom')), null, 'not a SourcePreflightError at all')
  assert.equal(describeValuesFreeRefusal(null), null)
  assert.equal(describeValuesFreeRefusal(undefined), null)

  // KEYS AND SHAPES, both required, and refused WHOLE rather than partially. A right-message error
  // whose details are missing a key, or carry a non-scalar under one, must not produce a half
  // descriptor that the route would then log as if it were a refusal report.
  assert.equal(
    describeValuesFreeRefusal(new SourcePreflightError('SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED', {})),
    null,
    'no detail keys at all is not a describable refusal',
  )
  assert.equal(
    describeValuesFreeRefusal(new SourcePreflightError('SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED', {
      path: 'probes[0].object', kind: 'observed-row-value', length: 7, // no `masked`
    })),
    null,
    'a missing key refuses the whole descriptor',
  )
  for (const wrongShape of [
    { path: { toString: () => 'x' }, kind: 'observed-row-value', length: 7, masked: 'a****b' },
    { path: 'p', kind: ['observed-row-value'], length: 7, masked: 'a****b' },
    { path: 'p', kind: 'observed-row-value', length: '7', masked: 'a****b' },
    { path: 'p', kind: 'observed-row-value', length: 7.5, masked: 'a****b' },
    // The one that matters: a future `refuse()` putting the ROW under a declared key.
    { path: 'p', kind: 'observed-row-value', length: 7, masked: { row: { PartNo: 'B-100019' } } },
  ]) {
    assert.equal(
      describeValuesFreeRefusal(new SourcePreflightError('SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED', wrongShape)),
      null,
      'a declared key carrying an undeclared shape refuses the whole descriptor',
    )
  }

  // THE MASK FLOOR. `maskForRefusal` publishes first + last character from length 3 up; at 3 and 4
  // that pair beside an exact length is effectively the value, and THIS projection is the first
  // thing that carries it out of the process. So the picker republishes the mask only from 5 up.
  // Driven through the REAL self-check, not hand-built errors: `probes[].object` is an identifier
  // leaf, and an observed value nobody vouched for as an identifier of this run is refused there.
  const maskedAtLength = (value) => {
    try {
      assertSourcePreflightValuesFree({ probes: [{ object: value }] }, { observedValues: new Set([value]) })
      assert.fail(`expected the self-check to refuse ${value.length} characters`)
    } catch (error) {
      assert.ok(error instanceof SourcePreflightError)
      assert.equal(error.details.length, value.length)
      return { onTheError: error.details.masked, published: describeValuesFreeRefusal(error) }
    }
  }
  for (const short of ['ABC', 'ABCD']) {
    const { onTheError, published } = maskedAtLength(short)
    assert.match(onTheError, /^.\*{4}.$/, 'the self-check itself still masks first/last — unchanged')
    assert.equal(published.masked, '**', 'but below the floor the published mask carries no characters')
    assert.equal(published.length, short.length, 'the length still travels: it names no character')
    assertNoStringLeafCarries(published, short, `published(${short.length})`)
    assert.equal(published.masked.includes(short[0]), false)
    assert.equal(published.masked.includes(short[short.length - 1]), false)
  }
  const atFloor = maskedAtLength('ABCDE')
  assert.equal(atFloor.published.masked, atFloor.onTheError, 'at and above the floor the mask travels as minted')
  assert.match(atFloor.published.masked, /^.\*{4}.$/)

  // THE SECRET FLOOR. `refuse(..., 'secret', ...)` describes a SUPPLIED CREDENTIAL, so for that class
  // neither the mask nor the exact length is publishable at any length. Unreachable from the route
  // today (the runner passes observed values and identifiers, never secrets) — pinned so it stays
  // harmless if secrets are ever wired in.
  try {
    assertSourcePreflightValuesFree(
      { checks: { projectData: { livenessSamples: [PLANTED_PASSWORD] } } },
      { secrets: [PLANTED_PASSWORD] },
    )
    assert.fail('expected a secret refusal')
  } catch (error) {
    assert.equal(error.details.kind, 'secret')
    assert.equal(error.details.length, PLANTED_PASSWORD.length, 'the error itself still carries it')
    const publishedSecret = describeValuesFreeRefusal(error)
    assert.deepEqual(Object.keys(publishedSecret).sort(), ['kind', 'path'], 'no mask and no length leave for a secret')
    assert.equal(publishedSecret.kind, 'secret')
    assert.equal(publishedSecret.path, error.details.path)
    assertNoStringLeafCarries(publishedSecret, PLANTED_PASSWORD, 'publishedSecret')
    assert.equal(JSON.stringify(publishedSecret).includes(String(PLANTED_PASSWORD.length)), false)
  }
}

// The wire answer this route gives a self-check refusal, captured from `origin/main` BEFORE this PR
// (same fixture, same route, run in a `git archive` sandbox of the pre-change tree) and pinned here
// so "byte-identical" is a re-runnable assertion rather than something a reader has to confirm by
// eyeballing a diff. If a change ever makes this line fail, the response body moved — which is
// exactly what this PR promises it does not do.
const WIRE_RESPONSE_BEFORE_THIS_PR = JSON.stringify({
  status: 500,
  body: {
    ok: false,
    error: {
      code: 'SOURCE_PREFLIGHT_FAILED',
      message: 'source preflight could not complete',
      details: { reason: 'SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED' },
    },
  },
})

async function theRouteLogsTheRefusalAndTheResponseStaysByteIdentical() {
  const recording = createRecordingLogger()
  const { routes: loggedRoutes } = mountRoute({ catalog: selfCheckTrippingSource(), logger: recording })
  const loggedRes = await callRoute(loggedRoutes, { user: INTEGRATION_READER })

  // (b) THE WIRE RESPONSE — unchanged from before this PR: 500, the same code/message, and `details`
  // carrying `reason` alone (never the four keys — those are the LOG line's, not the response's).
  assert.equal(loggedRes.statusCode, 500)
  assert.equal(loggedRes.body.ok, false)
  assert.equal(loggedRes.body.error.code, 'SOURCE_PREFLIGHT_FAILED')
  assert.equal(loggedRes.body.error.message, 'source preflight could not complete')
  // Not `assert.deepEqual` against a literal object: `sendError`'s `sanitizeIntegrationPayload` hands
  // back a null-prototype object, and `node:assert/strict`'s `deepEqual` is `deepStrictEqual` (which
  // compares prototypes too) — so this checks the one key and its value directly instead.
  assert.deepEqual(Object.keys(loggedRes.body.error.details), ['reason'])
  assert.equal(loggedRes.body.error.details.reason, 'SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED')
  // …and the whole thing, serialised, against what `origin/main` answered before this PR.
  assert.equal(
    JSON.stringify({ status: loggedRes.statusCode, body: loggedRes.body }),
    WIRE_RESPONSE_BEFORE_THIS_PR,
    'the wire answer must be byte-identical to the pre-change one',
  )

  // (a) the warn fired EXACTLY once, with the fixed prefix and ONLY `externalSystemId` plus the four
  // values-free keys — never a spread of `error.details`.
  assert.equal(recording.warnCalls.length, 1, 'the self-check refusal logs exactly one warn')
  const [message, payload] = recording.warnCalls[0]
  assert.equal(typeof message, 'string')
  assert.match(message, /values-free self-check refused/)
  assert.deepEqual(Object.keys(payload).sort(), ['externalSystemId', 'kind', 'length', 'masked', 'path'])
  assert.equal(payload.externalSystemId, SYSTEM_ID)
  assert.equal(payload.kind, 'observed-row-value')
  assert.equal(payload.length, SELF_CHECK_TRIPPING_VALUE.length)
  assert.match(payload.masked, /^.\*{4}.$/)

  // (d) VALUES-FREE at the log line itself: nothing in the payload equals or contains the refused
  // value, and its JSON form doesn't either.
  assertNoStringLeafCarries(payload, SELF_CHECK_TRIPPING_VALUE, 'payload')
  assert.equal(JSON.stringify(payload).includes(SELF_CHECK_TRIPPING_VALUE), false)

  // (b) continued — BYTE-IDENTICAL regardless of whether a logger is wired at all, or wired without
  // a `.warn`: the log line is a pure side effect of the catch block, so the wire answer a deployment
  // with no logger gets today must be the one this PR still gives it.
  const { routes: noLoggerRoutes } = mountRoute({ catalog: selfCheckTrippingSource(), logger: null })
  const noLoggerRes = await callRoute(noLoggerRoutes, { user: INTEGRATION_READER })
  assert.deepEqual(noLoggerRes.body, loggedRes.body)
  assert.equal(noLoggerRes.statusCode, loggedRes.statusCode)

  const { routes: warnlessRoutes } = mountRoute({
    catalog: selfCheckTrippingSource(),
    logger: { info() {}, error() {} }, // no `.warn` at all — must not throw and must not change the body
  })
  const warnlessRes = await callRoute(warnlessRoutes, { user: INTEGRATION_READER })
  assert.deepEqual(warnlessRes.body, loggedRes.body)

  // (c) REVERSE at the route: a HEALTHY catalog logs nothing here. Deliberately not "another kind of
  // SourcePreflightError at the route" — the module's only other throw site is the missing-`readObject`
  // guard, and the route always supplies `readObject` itself, so that error is unreachable from here.
  // The picker's `null` for it is asserted in the pure-function test above, where it is reachable.
  const cleanRecording = createRecordingLogger()
  const { routes: cleanRoutes } = mountRoute({ catalog: orderModuleSource(), logger: cleanRecording })
  const cleanRes = await callRoute(cleanRoutes, { user: INTEGRATION_READER })
  assert.equal(cleanRes.statusCode, 200)
  assert.equal(cleanRecording.warnCalls.length, 0, 'a clean run logs nothing on this path')
}

// ---------------------------------------------------------------------------
// S-19 / R-09 — 222 2026-09-08, the SECOND refusal on this route. With the customer's order data
// finally loaded, `GET /api/integration/stock-preparation/source-preflight` answered 500
// `SOURCE_PREFLIGHT_FAILED` again, and #5569's new warn named the leaf for the first time:
//
//     kind=observed-row-value, length=4, masked=**, path=probes[10].columns[27]
//
// A COLUMN NAME — an identifier leaf, built from `Object.keys(row)`, refused for CONTAINING a
// four-character value sampled from some row of the same run. The identifier exemption tested
// `entry.value` (the ROW VALUE) rather than `leaf.value` (the LEAF), while every comment around it
// described the leaf. In a real PLM that misreading is not an edge case: a dictionary's labels
// eventually spell `Code` / `Name` / `Type` / `Unit`, every one of them four characters, and column
// names spell them too — so the whole source 500'd, and which run it broke on moved with the
// customer's data.
//
// The guards below fix the mechanism in place, in both directions.
// ---------------------------------------------------------------------------

// Four characters — long enough for the `length >= 4` containment test — and deliberately NOT a
// column or table name of any fixture here, so it can never earn the exemption on its own.
const IDENTIFIER_SUBSTRING_ROW_VALUE = 'Code'
// A column the shipped read plan names AND every probe of `DN_PDM_PathExAttrInfo` observes. It
// contains the row value above, which is the entire bug.
const OBSERVED_COLUMN_CARRYING_IT = 'FileCode'

/**
 * `orderModuleSource()` with ONE cell changed: a part row whose `Material` holds exactly `Code`.
 * That single string enters `observedValues` (every string cell of every sampled row does), and from
 * that moment the report's own `probes[].columns[]` — which carry `FileCode` — reproduce it by
 * containment. Nothing else about the catalog moves, so S-01's verdict is the control.
 */
function columnNameContainsARowValueSource() {
  const catalog = orderModuleSource()
  catalog.DN_PDM_PartLibraryInfo = catalog.DN_PDM_PartLibraryInfo.map((row, index) => (
    index === 0 ? { ...row, Material: IDENTIFIER_SUBSTRING_ROW_VALUE } : row
  ))
  return catalog
}

async function aColumnNameContainingARowValueIsNotARefusal() {
  // END TO END — the 222 shape through the real runner. Before the fix this threw
  // SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED and the route answered 500 for the whole source.
  //
  // The reader is wrapped rather than used through `preflight()` for ONE reason: this test is only a
  // reproduction while the planted cell is actually READ. If a later fixture edit stopped the roster
  // from sampling `DN_PDM_PartLibraryInfo`, or renamed `Material`, the value would never reach
  // `observedValues`, the containment would never be tested, and the assertions below would all still
  // pass — a green that reproduces nothing. So the run records what came back, and the test asserts
  // on it.
  const reader = createReader(columnNameContainsARowValueSource())
  const partRowsRead = []
  const report = await runStockPreparationSourcePreflight({
    readObject: async (request) => {
      const result = await reader.readObject(request)
      if (String(request && request.object).toLowerCase() === 'dn_pdm_partlibraryinfo') {
        partRowsRead.push(...result.records)
      }
      return result
    },
    externalSystemId: SYSTEM_ID,
  })

  // ARM — the planted cell really was read this run, so it really is in `observedValues`: the runner
  // adds every non-blank string cell of every sampled row (`observedValues.add(value)`), with no
  // filter of any kind in between.
  assert.ok(
    partRowsRead.some((row) => row.Material === IDENTIFIER_SUBSTRING_ROW_VALUE),
    'the planted row value was actually sampled — without this the test reproduces nothing',
  )
  // TARGET — and the report really does reproduce it, by containment, at identifier leaves: in TWO
  // identifier classes, `probes[].columns[]` and `matchField`.
  const carrier = report.probes.find((probe) => (probe.columns || []).includes(OBSERVED_COLUMN_CARRYING_IT))
  assert.ok(carrier, 'the report names the observed column that contains the row value')
  assert.equal(report.checks.projectData.matchField, OBSERVED_COLUMN_CARRYING_IT)
  assert.ok(
    OBSERVED_COLUMN_CARRYING_IT.includes(IDENTIFIER_SUBSTRING_ROW_VALUE),
    'containment is what the self-check tests, and it holds here',
  )
  // …and it is the identifier exemption alone that saves it: run the SAME report through the
  // self-check with the identifiers withheld and the refusal comes back, in the 222 shape.
  try {
    assertSourcePreflightValuesFree(report, {
      observedValues: new Set([IDENTIFIER_SUBSTRING_ROW_VALUE]),
    })
    assert.fail('expected the report to be refused once the identifier ground is withheld')
  } catch (error) {
    assert.ok(error instanceof SourcePreflightError)
    assert.equal(error.message, 'SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED')
    assert.equal(error.details.kind, 'observed-row-value')
    assert.equal(error.details.length, IDENTIFIER_SUBSTRING_ROW_VALUE.length)
  }

  // And the run is otherwise S-01: the fix buys back the report, it does not blunt it.
  assert.equal(report.verdict, 'go')
  assert.equal(report.checks.topology.detectedBridge, 'order-module')
  assert.deepEqual(codesOf(report.blockers), [])
}

async function theIdentifierExemptionIsByLeafValueAndStaysNarrow() {
  // The 222 report shape, hand-built so the mechanism is pinned without a whole catalog behind it.
  // `identifiers` holds what that run genuinely observed; `Code` is NOT one of them.
  const armed = {
    observedValues: new Set([IDENTIFIER_SUBSTRING_ROW_VALUE, 'PRJ-2600']),
    identifiers: new Set(['DN_PDM_PathExAttrInfo', 'ID', OBSERVED_COLUMN_CARRYING_IT, 'NodeType']),
  }
  const twoTwoTwoShape = {
    verdict: 'go',
    checks: { projectData: { matchField: OBSERVED_COLUMN_CARRYING_IT, livenessSamples: ['PRJ-2600'] } },
    probes: [{
      role: 'pathExAttr',
      object: 'DN_PDM_PathExAttrInfo',
      columns: ['ID', OBSERVED_COLUMN_CARRYING_IT, 'NodeType'],
    }],
  }
  assert.equal(
    assertSourcePreflightValuesFree(twoTwoTwoShape, armed),
    twoTwoTwoShape,
    'an identifier leaf whose OWN value is an identifier this run observed is exempt',
  )

  // REVERSE 1 — the exemption is by VALUE, never by field. An identifier-class leaf whose value is
  // NOT one of this run's identifiers is still refused for containing the row value, at the exact
  // path/kind/length shape 222 logged. Without this, the fix would read "all identifier fields are
  // exempt", which is a values channel.
  const refusalFor = (report) => {
    try {
      assertSourcePreflightValuesFree(report, armed)
      assert.fail('expected the values-free self-check to refuse this report')
    } catch (error) {
      assert.ok(error instanceof SourcePreflightError)
      assert.equal(error.message, 'SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED')
      return error.details
    }
  }
  const shadowed = refusalFor({ probes: [{ columns: [`${OBSERVED_COLUMN_CARRYING_IT}Shadow`] }] })
  assert.equal(shadowed.kind, 'observed-row-value')
  assert.equal(shadowed.path, 'probes[0].columns[0]')
  assert.equal(shadowed.length, IDENTIFIER_SUBSTRING_ROW_VALUE.length)

  // REVERSE 2 — an identifier leaf whose value EQUALS the row value and is vouched for by nobody is
  // still refused. This is R-08's live `dictionarySlot` case, restated at the unit level.
  const equalled = refusalFor({ checks: { quantityField: { dictionarySlot: IDENTIFIER_SUBSTRING_ROW_VALUE } } })
  assert.equal(equalled.kind, 'observed-row-value')
  assert.equal(equalled.path, 'checks.quantityField.dictionarySlot')

  // REVERSE 3 — nothing outside the identifier class gained anything, and these three say so at an
  // EARLIER gate than the line this PR touched: (1) CLASSIFICATION refuses them for being
  // unclassified or for violating a closed vocabulary, so they never reach (2) CONTAINMENT at all —
  // which the asserted `kind` states outright rather than papering over. That is structural, not a
  // hole in the test: a non-identifier leaf CANNOT produce an `observed-row-value` refusal, because
  // liveness / closed-vocabulary / server-authored leaves `continue` before the containment loop and
  // every remaining non-identifier leaf has already been refused as unclassified. What these three
  // pin is that the classification gate in front of the exemption did not move; the narrowness of the
  // exemption itself is pinned by REVERSE 1 and REVERSE 2 above.
  assert.equal(refusalFor({ somethingNew: IDENTIFIER_SUBSTRING_ROW_VALUE }).kind, 'unclassified-string-leaf')
  assert.equal(
    refusalFor({ checks: { bomData: { livenessSamples: [IDENTIFIER_SUBSTRING_ROW_VALUE] } } }).kind,
    'unclassified-string-leaf',
    'the liveness exemption is an exact path, not a field name that can be spelled elsewhere',
  )
  assert.equal(refusalFor({ verdict: IDENTIFIER_SUBSTRING_ROW_VALUE }).kind, 'closed-vocabulary-violated')
  // …while the ONE allowlisted liveness path still is exempt, so the boundary is a boundary.
  assertSourcePreflightValuesFree(
    { checks: { projectData: { livenessSamples: [IDENTIFIER_SUBSTRING_ROW_VALUE] } } },
    armed,
  )

  // REVERSE 4 — the exemption is still BELOW secrets, on the ONE leaf where the two actually cross:
  // `FileCode` is an observed identifier (so ground (a) exempts it from the row value `Code` it
  // contains) AND is a supplied secret. The row value is armed here deliberately — with an empty
  // `observedValues` this would only prove that secrets run before the identifier logic, not that a
  // leaf the new ground genuinely exempts is still refused for the secret.
  const secreted = (() => {
    try {
      assertSourcePreflightValuesFree(
        { probes: [{ columns: [OBSERVED_COLUMN_CARRYING_IT] }] },
        {
          observedValues: new Set([IDENTIFIER_SUBSTRING_ROW_VALUE]),
          identifiers: new Set([OBSERVED_COLUMN_CARRYING_IT]),
          secrets: [OBSERVED_COLUMN_CARRYING_IT],
        },
      )
      assert.fail('expected a secret refusal')
    } catch (error) {
      return error.details
    }
  })()
  assert.equal(secreted.kind, 'secret', 'secrets are exempt nowhere, the new ground included')

  // THE SECOND GROUND, unchanged by this PR and pinned so a later narrowing is a deliberate red: an
  // identifier leaf that merely CONTAINS a row value which is itself a known identifier stays exempt,
  // even though the leaf's own value is not one. This is the dictionary "row that names a column"
  // case, and it is the wider of the two grounds.
  assertSourcePreflightValuesFree(
    { probes: [{ columns: [`X_${OBSERVED_COLUMN_CARRYING_IT}_Y`] }] },
    {
      observedValues: new Set([OBSERVED_COLUMN_CARRYING_IT]),
      identifiers: new Set([OBSERVED_COLUMN_CARRYING_IT]),
    },
  )
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
  await volumeAloneMustNotPickTheCarrier()
  await jsonEmbeddedSlotsAreReportedNotSilentlyMissed()
  await noConfidentQuantityClaimWhileTheStoreIsUnresolved()
  await strongSignalsDisagreeingIsAlsoARefusal()
  await agreeingSignalsStillDecide()
  await theOriginalIncidentStillLands()
  console.log('  ✓ S-17 GROUND TRUTH: volume is evidence, not verdict — conflicting signals refuse and say why')
  await capSaturationIsDistinguishableFromATie()
  await aDeclarationResolvesWhatTheSampleCannotRank()
  await aDeclarationCannotOverruleAMeasurement()
  console.log('  ✓ S-14 a standoff at the sample cap is its own answer, with a way out that cannot overrule data')
  await roleCollapseTakesTheStrongestCarrier()
  console.log('  ✓ S-15 a role addressing two objects collapses to the strongest, and says which answered')
  await quantitySlotIsMeasuredTwoWays()
  await aPlanOnTheWrongSlotWarns()
  await anUnreadableDictionaryFallsBackToTheData()
  console.log('  ✓ S-08 the quantity slot is read from the customer`s dictionary AND from the data')
  await twoPlausibleQuantitySlotsAreNotGuessedBetween()
  await theCustomersOwnDictionaryBreaksTheTie()
  console.log('  ✓ S-16 two plausible quantity slots are reported as a field, never guessed between')
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
  await aDeclarationTravelsThroughTheRoute()
  console.log('  ✓ R-06 a declared bridge crosses the route and stays labelled as declared')
  await theHttpBoundaryIsValuesFreeToo()
  console.log('  ✓ R-05 the HTTP boundary is values-free too')

  await theBindingHalfIsReportedAndBlocks()
  console.log('  ✓ S-18 a source only its binder can pull through is a no-go, and says which shape')
  await theRouteReportsWhetherThePullCanDelegate()
  console.log('  ✓ R-07 the route reports the binding half without leaking owner or connection id')

  await theSelfCheckRefusalDescriptorIsExactlyTheFourKeys()
  await theRouteLogsTheRefusalAndTheResponseStaysByteIdentical()
  console.log('  ✓ R-08 the self-check refusal logs path/kind/length/masked (and only those), values-free, response unchanged')

  await aColumnNameContainingARowValueIsNotARefusal()
  await theIdentifierExemptionIsByLeafValueAndStaysNarrow()
  console.log('  ✓ S-19 a column name is exempt because IT is an observed identifier — not because its field is one')

  console.log('stock-preparation-source-preflight: OK')
}

main()
