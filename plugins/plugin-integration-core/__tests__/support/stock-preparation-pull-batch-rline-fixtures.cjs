'use strict'

// 批次标识 BI-4 (R line only) — SYNTHETIC fixtures for the pull-batch pure suite's PB-C1 / PB-C2 cases.
//
// On main these cases build their expansions with support/stock-preparation-continuation-fixtures.cjs, which drags in
// the demand-evidence golden harness (#6502 recorder), the refresh lanes and the project write lock — none of which is
// on this line. This file offers the SAME five helpers (part / project / expand / plan / applyToSheet) over this line's
// own modules: every expansion is a REAL `expandPlmProjectBom` walk over an in-memory source (no demand-evidence
// recorder: this line's expander has none), and every plan is this line's REAL `planStockPreparationConflicts`. A
// "first pull" is written to the sheet the way the planner would write it (the ADD records; UPDATE / INACTIVE patched).
// The R line's reader attaches no record reference, so none is attached here.
//
// VALUES-FREE: invented project / part ids and drawing numbers only.

const path = require('node:path')

const LIB = path.join(__dirname, '..', '..', 'lib')
const { expandPlmProjectBom } = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const { planStockPreparationConflicts } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))

const PROJECT_NO = 'PRJ-SCC-1'
const RUN_ID = 'run_scc_fixture'
const PLANNED_AT = '2026-10-23T03:00:00.000Z'

const clone = (value) => JSON.parse(JSON.stringify(value))

function createSourceAdapter(data) {
  return {
    async read(input = {}) {
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) =>
        Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit || 1000
      const records = matches.slice(offset, offset + limit).map(clone)
      return {
        records,
        done: offset + records.length >= matches.length,
        nextCursor: offset + records.length < matches.length ? String(offset + records.length) : null,
      }
    },
  }
}

function part(id, code, name, extra = {}) {
  return { OBJ_ID: id, IdentityNo: code, IdentityName: name, Material: 'M-STEEL', SysVer: 'V1', ...extra }
}

/** One project's source. `orders`: [{ part, qty }] in line order. `boms`: { parentId: [{ part, usage }] }. */
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

async function expand(data, { projectNo = PROJECT_NO, allowStatuses = ['expanded'] } = {}) {
  const result = await expandPlmProjectBom({ sourceAdapter: createSourceAdapter(data), projectNo })
  if (!allowStatuses.includes(result.status)) throw new Error(`fixture expansion did not complete: ${result.status}`)
  return result
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

/** What the sheet holds after a plan was applied: every existing row (UPDATE / INACTIVE patched) plus every ADD record. */
function applyToSheet(planned, existingRows = []) {
  const byKey = new Map(existingRows.map((row) => [row.idempotencyKey, row]))
  for (const decision of planned.decisions) {
    if (decision.decision === 'add') {
      byKey.set(decision.idempotencyKey, { ...decision.record })
    } else if (decision.decision === 'update' || decision.decision === 'inactive') {
      const current = byKey.get(decision.idempotencyKey)
      byKey.set(decision.idempotencyKey, { ...current, ...decision.patch })
    }
  }
  return Array.from(byKey.values())
}

module.exports = {
  PROJECT_NO,
  RUN_ID,
  PLANNED_AT,
  part,
  project,
  expand,
  plan,
  applyToSheet,
}
