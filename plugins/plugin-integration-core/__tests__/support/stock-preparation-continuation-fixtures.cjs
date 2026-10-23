'use strict'

// Batch-refresh step 4, PR-1 — SYNTHETIC fixtures for the continuation suites.
//
// Every expansion here is a REAL `expandPlmProjectBom` walk over an in-memory source with the #6502
// recorder ON, so the demand facts the planner reads (decision / rule / ruleDetail / lineOrder /
// expandedOccurrences) are what the recorder really produces, never hand-written observations. A "first
// pull" is written to the sheet the way the planner would write it (the ADD records), and each row gets
// the record reference the project-scoped reader attaches (EXISTING_ROW_RECORD_REF).
//
// VALUES-FREE: invented project / part ids and drawing numbers only (P-001, S-001, PART-A, ...).

const path = require('node:path')

const LIB = path.join(__dirname, '..', '..', 'lib')
const { expandPlmProjectBom } = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const {
  EXISTING_ROW_RECORD_REF,
  planStockPreparationConflicts,
} = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const { createSourceAdapter } = require('./stock-preparation-demand-evidence-golden-harness.cjs')

const PROJECT_NO = 'PRJ-SCC-1'
const RUN_ID = 'run_scc_fixture'
const PLANNED_AT = '2026-10-23T03:00:00.000Z'

const SOURCE_IDENTITY = Object.freeze({
  externalSystemId: 'plm_scc_fixture',
  sourceScopeDigest: 'a'.repeat(64),
  readPlanDigest: 'b'.repeat(64),
})

function part(id, code, name, extra = {}) {
  return { OBJ_ID: id, IdentityNo: code, IdentityName: name, Material: 'M-STEEL', SysVer: 'V1', ...extra }
}

/**
 * One project's source. `orders`: [{ part, qty }] in line order. `boms`: { parentId: [{ part, usage }] }.
 */
function project({ projectNo = PROJECT_NO, orders, parts, boms = {} }) {
  const heads = []
  const lines = []
  for (const [parentId, children] of Object.entries(boms)) {
    heads.push({ part_id: parentId, bom_id: `BOM-${parentId}`, SysVer: 'V1', bom_able: true })
    children.forEach((child, index) => {
      lines.push({ bom_pid: `BOM-${parentId}`, part_id: child.part, Bom_ExAttr1: String(child.usage), sort_id: String(index + 1) })
    })
  }
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: `${projectNo}-PATH` }],
    DN_PDM_PathInfo: [{ OBJ_ID: `${projectNo}-PATH` }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: `${projectNo}-ORDER-1`, path_id: `${projectNo}-PATH` }],
    DN_PDM_OrderDetailInfo: orders.map((order, index) => ({
      order_id: `${projectNo}-ORDER-1`,
      part_id: order.part,
      quantity: String(order.qty),
      sort_id: String((index + 1) * 10),
    })),
    DN_PDM_PartLibraryInfo: parts,
    DN_PDM_BomHeadInfo: heads,
    DN_PDM_BomDetailsInfo: lines,
  }
}

async function expand(data, { projectNo = PROJECT_NO, rootSelection, demandEvidence = true, allowStatuses = ['expanded'] } = {}) {
  const result = await expandPlmProjectBom({
    sourceAdapter: createSourceAdapter(data),
    projectNo,
    ...(demandEvidence ? { demandEvidence: true } : {}),
    ...(rootSelection ? { rootSelection } : {}),
  })
  if (!allowStatuses.includes(result.status)) throw new Error(`fixture expansion did not complete: ${result.status}`)
  return result
}

function withRecordRef(row, id, version = 1) {
  const out = { ...row }
  out[EXISTING_ROW_RECORD_REF] = Object.freeze({ id, version })
  return out
}

function plan(expansion, existingRows, extra = {}) {
  return planStockPreparationConflicts({
    expandedRows: expansion.rows,
    existingRows,
    rowErrors: expansion.rowErrors,
    runId: RUN_ID,
    plannedAt: PLANNED_AT,
    ...extra,
  })
}

/**
 * What the sheet holds after a plan was applied: every existing row (UPDATE / INACTIVE patched) plus
 * every ADD record, each with a record reference. `human` adds human cells by component id.
 */
function applyToSheet(planned, existingRows = [], { idPrefix = 'rec', human = {} } = {}) {
  const byKey = new Map(existingRows.map((row) => [row.idempotencyKey, row]))
  let counter = existingRows.length
  for (const decision of planned.decisions) {
    if (decision.decision === 'add') {
      counter += 1
      const record = { ...decision.record, ...(human[decision.record.componentSourceId] || {}) }
      byKey.set(decision.idempotencyKey, withRecordRef(record, `${idPrefix}_${counter}`, 1))
    } else if (decision.decision === 'update' || decision.decision === 'inactive') {
      const current = byKey.get(decision.idempotencyKey)
      const ref = current[EXISTING_ROW_RECORD_REF]
      byKey.set(decision.idempotencyKey, withRecordRef({ ...current, ...decision.patch }, ref.id, ref.version + 1))
    }
  }
  return Array.from(byKey.values())
}

/**
 * The continuation a confirm of `hold` (a `continuation_candidate`) would persist: header + members,
 * built ONLY from what the hold carries (its pairs and the three fingerprints).
 */
function continuationFromHold(hold, { id = 'cont_scc_1', status = 'active', statusReason = null, sourceIdentity = SOURCE_IDENTITY } = {}) {
  const pairs = hold.detail.pairs
  const root = pairs.find((pair) => pair.relativePath.length === 0)
  const header = {
    id,
    status,
    statusReason,
    revision: 1,
    comparisonFingerprint: hold.comparisonFingerprint,
    evidenceFingerprint: hold.evidenceFingerprint,
    pairingFingerprint: hold.pairingFingerprint,
    sourceScopeDigest: sourceIdentity.sourceScopeDigest,
    readPlanDigest: sourceIdentity.readPlanDigest,
    oldRootKey: root.oldKey,
    newRootKey: root.newKey,
    memberCount: pairs.length,
  }
  const members = pairs.map((pair, position) => ({
    continuationId: id,
    position,
    relativePathTokens: pair.relativePath.slice(),
    componentSourceId: pair.componentSourceId,
    oldRecordId: pair.oldRecordId,
    oldKey: pair.oldKey,
    newKey: pair.newKey,
  }))
  return { header, members }
}

function continuationInput({ pilot = true, continuations = [], members = [], demandEvidence = null, sourceIdentity = SOURCE_IDENTITY, specSlotDeclared = false, projectNo = PROJECT_NO, ...rest } = {}) {
  return { storeState: 'ok', pilot, projectNo, continuations, members, demandEvidence, sourceIdentity, specSlotDeclared, ...rest }
}

function byType(planned, type) {
  return planned.decisions.filter((decision) => decision.conflictSummary && decision.conflictSummary.type === type)
}

function byDecision(planned, decision) {
  return planned.decisions.filter((entry) => entry.decision === decision)
}

function componentOf(key) {
  return JSON.parse(key).componentSourceId
}

// ── the canonical S/P story (plan §1, §9.1 A01-A03) ────────────────────────────────────────────────
//
// First pull: S-001 ordered on its own (qty 10): S-001 > PART-A (edge 2) > PART-C (edge 4), and
// S-001 > PART-B (edge 3) — four rows. Second pull: P-001 ordered (qty 5) with S-001 inside it (edge 2),
// plus a truly new N-001 (qty 1); S-001's own line is still on the order and root selection drops it as
// a dash descendant of P-001. The new S-001 root total is 5 x 2 = 10 = the old root's order quantity.

const PARTS = Object.freeze([
  part('P-001', 'D100-01', 'Assembly'),
  part('S-001', 'D100-01-03', 'SubAssembly'),
  part('PART-A', 'C200-1', 'Bracket'),
  part('PART-B', 'C200-2', 'Plate'),
  part('PART-C', 'C200-3', 'Pin'),
  part('N-001', 'E300-1', 'Loose'),
])

const S_BOMS = Object.freeze({
  'S-001': [{ part: 'PART-A', usage: 2 }, { part: 'PART-B', usage: 3 }],
  'PART-A': [{ part: 'PART-C', usage: 4 }],
})

function firstPullSource({ sQty = 10 } = {}) {
  return project({ orders: [{ part: 'S-001', qty: sQty }], parts: PARTS.slice(), boms: { ...S_BOMS } })
}

function secondPullSource({ pQty = 5, edge = 2, sLine = true, extraOrders = [], boms = {}, parts } = {}) {
  const orders = [{ part: 'P-001', qty: pQty }]
  if (sLine) orders.push({ part: 'S-001', qty: 10 })
  orders.push({ part: 'N-001', qty: 1 }, ...extraOrders)
  return project({
    orders,
    parts: parts || PARTS.slice(),
    boms: { 'P-001': [{ part: 'S-001', usage: edge }], ...S_BOMS, ...boms },
  })
}

// The sheet after the first pull, with a person's note on the S-001 root.
async function firstPullSheet(options = {}) {
  const expansion = await expand(firstPullSource(options))
  const planned = plan(expansion, [])
  return applyToSheet(planned, [], { idPrefix: 'rec_s', human: { 'S-001': { notes: 'synthetic note' } } })
}

module.exports = {
  PARTS,
  PLANNED_AT,
  PROJECT_NO,
  RUN_ID,
  SOURCE_IDENTITY,
  S_BOMS,
  applyToSheet,
  byDecision,
  byType,
  componentOf,
  continuationFromHold,
  continuationInput,
  expand,
  firstPullSheet,
  firstPullSource,
  part,
  plan,
  project,
  secondPullSource,
  withRecordRef,
}
