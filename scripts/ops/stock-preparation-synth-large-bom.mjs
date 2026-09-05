#!/usr/bin/env node
// ============================================================================
// Synthetic PLM BOM data generator for the "大 BOM 分批" (large-BOM bounded
// expansion) path of stock-preparation (备料).
//
// WHY THIS EXISTS
//   `expandPlmProjectBom` bounds an expansion at `maxRows` (default 10000,
//   plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:18,
//   :747-750) and reports it as `largeBom: true` / a bounded preview
//   (`isLargeBomBoundedExpansion`, same file :514-518). That path exists in
//   code and in the UI, but as of 2026-09-03 nobody has ever fed it a project
//   that actually expands past 10000 rows — the shipped synthetic fixture at
//   `plugins/plugin-integration-core/fixtures/stock-preparation-synthetic-sql-source/`
//   is deliberately "tens of rows" (see that fixture's README, "what it
//   deliberately does not cover"). This script produces the oversized sibling
//   dataset needed to actually exercise the bounded path against the 222
//   synthetic PLM Postgres instance.
//
// SHAPE (matches the read plan's 7-object graph, same column names / marker
// values as the shipped fixture — see 01-schema.sql and 02-seed-pull-1.sql
// in the directory above):
//   DN_PDM_PathExAttrInfo   1 row   — FileCode = projectNo, Parent_OBJ_ID = path id
//   DN_PDM_PathInfo         1 row   — OBJ_ID = path id
//   DN_PDM_OrderHeadInfo    1 row   — OBJ_ID = order id, path_id = path id
//   DN_PDM_OrderDetailInfo  1 row   — order_id/part_id -> root part, quantity 1
//   DN_PDM_PartLibraryInfo  N rows  — root + 3 fan-out layers, every part exactly once
//   DN_PDM_BomHeadInfo      M rows  — one per non-leaf part (root + layer 1 + layer 2),
//                                     SysVer 'V1' on every part AND every head (so the
//                                     child read's part_id+SysVer filter always matches
//                                     — see 01-schema.sql's note on DN_PDM_BomHeadInfo),
//                                     bom_able '1' (active) throughout — this dataset is
//                                     deliberately clean, no missing/retired/ambiguous rows.
//   DN_PDM_BomDetailsInfo   K rows  — one per parent -> child edge; Bom_ExAttr1 (the
//                                     quantity column, per the plan default) cycles
//                                     1, 2, 3, 1, 2, 3, ... across a parent's children so
//                                     the rolled-up totalQuantity is checkable by hand.
//
// FAN-OUT / ROW-COUNT FORMULA
//   Given --fanout f0,f1,f2 (children-per-parent at layer 1/2/3):
//     layer1 parts = f0
//     layer2 parts = f0 * f1
//     layer3 parts = f0 * f1 * f2
//     DN_PDM_BomDetailsInfo rows = layer1 + layer2 + layer3   (one edge per non-root part)
//     DN_PDM_PartLibraryInfo rows = 1 (root) + layer1 + layer2 + layer3
//   The default 25,25,20 gives layer rows 25 + 625 + 12500 = 13150 (> maxRows
//   10000), and 13151 parts counting the root. A real dry-run's
//   `evidence.expansion.rowsExpanded` counts the root row too (the root order
//   line is pushed like any other row —
//   lib/stock-preparation-bom-expansion.cjs:946-966), so it should land at
//   13151 before the bound kicks in and truncates it.
//
// IDEMPOTENCY
//   Every identifier this generator creates (path id, order id, part OBJ_IDs,
//   BOM ids) is prefixed `SYNL-` — deliberately NOT `SYN-` so it can never
//   collide with the shipped fixture's `SYN-PROJ-0001` dataset if both are
//   loaded into the same schema. Each table's DELETE filters on a `SYNL-%`
//   LIKE match on one of its own columns (not on the project number, which is
//   caller-supplied via --project and may not carry the prefix), so re-running
//   this script — even with a different --fanout or --project — always
//   removes every row a prior run of THIS generator left behind before
//   inserting the new set. The DELETE statements are grouped and marked with
//   CLEANUP-START / CLEANUP-END comments so they can also be run alone, without
//   the INSERTs that follow, to just remove the synthetic large-BOM rows.
//
// USAGE
//   node scripts/ops/stock-preparation-synth-large-bom.mjs --out <file.sql> \
//     [--fanout 25,25,20] [--project SYN-PROJ-LARGE-0001]
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const PREFIX = 'SYNL-'
export const DEFAULT_FANOUT = Object.freeze([25, 25, 20])
export const DEFAULT_PROJECT_NO = 'SYN-PROJ-LARGE-0001'
export const DEFAULT_MAX_ROWS = 10000

const MATERIALS = Object.freeze(['SYNL-MAT-STEEL', 'SYNL-MAT-ALU', 'SYNL-MAT-POLY'])

const TABLES = Object.freeze({
  pathExAttr: 'DN_PDM_PathExAttrInfo',
  pathInfo: 'DN_PDM_PathInfo',
  orderHead: 'DN_PDM_OrderHeadInfo',
  orderDetail: 'DN_PDM_OrderDetailInfo',
  part: 'DN_PDM_PartLibraryInfo',
  bomHead: 'DN_PDM_BomHeadInfo',
  bomDetail: 'DN_PDM_BomDetailsInfo',
})

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * Parse a "25,25,20" style fanout string into an array of 3 positive integers.
 */
export function parseFanout(input) {
  if (Array.isArray(input)) {
    if (input.length !== 3 || !input.every(isPositiveInteger)) {
      throw new Error(`FANOUT_INVALID: expected 3 positive integers, got ${JSON.stringify(input)}`)
    }
    return input.slice()
  }
  const raw = typeof input === 'string' ? input : ''
  const parts = raw.split(',').map((token) => token.trim())
  if (parts.length !== 3 || parts.some((token) => !/^[0-9]+$/.test(token))) {
    throw new Error(`FANOUT_INVALID: expected "N,N,N" (3 positive integers), got ${JSON.stringify(input)}`)
  }
  const numbers = parts.map((token) => Number.parseInt(token, 10))
  if (!numbers.every(isPositiveInteger)) {
    throw new Error(`FANOUT_INVALID: expected 3 positive integers, got ${JSON.stringify(input)}`)
  }
  return numbers
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Pure builder: given a fanout triple and a project number, build the full
 * in-memory dataset (every row this generator will emit) plus a summary of
 * expected counts. No I/O — safe to call from tests.
 */
export function buildLargeBomDataset({ fanout = DEFAULT_FANOUT, project = DEFAULT_PROJECT_NO } = {}) {
  const [f0, f1, f2] = parseFanout(fanout)
  const projectNo = typeof project === 'string' && project.trim() ? project.trim() : DEFAULT_PROJECT_NO

  const pathId = `${PREFIX}PATH-1`
  const orderId = `${PREFIX}ORDER-1`
  const rootPartId = `${PREFIX}PART-L0-1`

  const parts = []
  const bomHeads = []
  const bomDetails = []
  let materialCursor = 0

  function addPart(objId) {
    parts.push({
      objId,
      identityNo: `${objId}-NO`,
      identityName: `Synthetic Large Part ${objId}`,
      material: MATERIALS[materialCursor % MATERIALS.length],
      sysVer: 'V1',
    })
    materialCursor += 1
  }

  function addBomHead(partId) {
    const bomId = `${partId}-BOM`
    bomHeads.push({ partId, bomId, sysVer: 'V1', bomAble: '1' })
    return bomId
  }

  function addBomDetail(bomPid, childPartId, indexInParent) {
    const qty = (indexInParent % 3) + 1
    bomDetails.push({ bomPid, partId: childPartId, qty, sortId: (indexInParent + 1) * 10 })
    return qty
  }

  addPart(rootPartId)
  const rootBomId = addBomHead(rootPartId)

  const rootQuantity = 1 // DN_PDM_OrderDetailInfo.quantity for the root line
  let totalQuantitySum = rootQuantity // the root row's own totalQuantity

  for (let i = 0; i < f0; i += 1) {
    const l1Id = `${PREFIX}PART-L1-${i + 1}`
    addPart(l1Id)
    const l1Qty = addBomDetail(rootBomId, l1Id, i)
    const l1Total = rootQuantity * l1Qty
    totalQuantitySum += l1Total
    const l1BomId = addBomHead(l1Id)

    for (let j = 0; j < f1; j += 1) {
      const l2Id = `${PREFIX}PART-L2-${i + 1}-${j + 1}`
      addPart(l2Id)
      const l2Qty = addBomDetail(l1BomId, l2Id, j)
      const l2Total = l1Total * l2Qty
      totalQuantitySum += l2Total
      const l2BomId = addBomHead(l2Id)

      for (let k = 0; k < f2; k += 1) {
        const l3Id = `${PREFIX}PART-L3-${i + 1}-${j + 1}-${k + 1}`
        addPart(l3Id)
        const l3Qty = addBomDetail(l2BomId, l3Id, k)
        const l3Total = l2Total * l3Qty
        totalQuantitySum += l3Total
      }
    }
  }

  const layer1Count = f0
  const layer2Count = f0 * f1
  const layer3Count = f0 * f1 * f2
  const childRowsFormulaSum = layer1Count + layer2Count + layer3Count // matches bomDetails.length
  const expectedExpansionRowsWithRoot = 1 + childRowsFormulaSum // matches parts.length; dry-run rowsExpanded shape

  const summary = {
    fanout: [f0, f1, f2],
    projectNo,
    tableRowCounts: {
      [TABLES.pathExAttr]: 1,
      [TABLES.pathInfo]: 1,
      [TABLES.orderHead]: 1,
      [TABLES.orderDetail]: 1,
      [TABLES.part]: parts.length,
      [TABLES.bomHead]: bomHeads.length,
      [TABLES.bomDetail]: bomDetails.length,
    },
    layerCounts: { layer1: layer1Count, layer2: layer2Count, layer3: layer3Count },
    // The literal "f0 + f0*f1 + f0*f1*f2" reading (child rows only, no root).
    childRowsFormulaSum,
    // rowsExpanded a real dry-run would report: child rows plus the root's own row.
    expectedExpansionRowsWithRoot,
    exceedsDefaultMaxRows: expectedExpansionRowsWithRoot > DEFAULT_MAX_ROWS,
    expectedTotalQuantitySum: totalQuantitySum,
  }

  return {
    pathId,
    orderId,
    rootPartId,
    projectNo,
    parts,
    bomHeads,
    bomDetails,
    orderDetail: { orderId, partId: rootPartId, quantity: rootQuantity, sortId: 10 },
    summary,
  }
}

/**
 * Render `rows` as one or more complete `INSERT INTO table (columnsSql) VALUES (...), (...);`
 * statements, batching at `batchSize` rows per statement so no single statement holds
 * an unbounded number of value tuples.
 */
function renderInsertStatements(table, columnsSql, rows, mapRow, batchSize = 500) {
  const statements = []
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize)
    const values = batch.map(mapRow).join(',\n  ')
    statements.push(`INSERT INTO ${table} (${columnsSql}) VALUES\n  ${values};`)
  }
  return statements
}

/**
 * Render the full idempotent SQL text for a dataset built by
 * `buildLargeBomDataset`. DELETEs (prefix-scoped, CLEANUP-marked) come first,
 * INSERTs follow in the same parent-before-child order the shipped fixture
 * uses (02-seed-pull-1.sql).
 */
export function renderSql(dataset) {
  const { pathId, orderId, rootPartId, projectNo, parts, bomHeads, bomDetails, orderDetail, summary } = dataset
  const out = []

  out.push('-- ============================================================================')
  out.push('-- SYNTHETIC LARGE-BOM dataset for the stock-preparation "大 BOM 分批" bounded')
  out.push('-- expansion path. Generated by scripts/ops/stock-preparation-synth-large-bom.mjs')
  out.push('-- -- DO NOT hand-edit; regenerate instead. Idempotent: safe to re-run.')
  out.push(`-- projectNo (DN_PDM_PathExAttrInfo.FileCode): ${projectNo}`)
  out.push(`-- fanout: ${summary.fanout.join(',')}  (layer1=${summary.layerCounts.layer1} layer2=${summary.layerCounts.layer2} layer3=${summary.layerCounts.layer3})`)
  out.push(`-- expected DN_PDM_PartLibraryInfo rows (root + all descendants): ${summary.expectedExpansionRowsWithRoot}`)
  out.push(`-- expected DN_PDM_BomDetailsInfo rows (layer1+layer2+layer3): ${summary.childRowsFormulaSum}`)
  out.push(`-- expected total rolled-up quantity across every expanded row: ${summary.expectedTotalQuantitySum}`)
  out.push(`-- exceeds default maxRows (${DEFAULT_MAX_ROWS}): ${summary.exceedsDefaultMaxRows}`)
  out.push('-- All identifiers created by this generator are prefixed "SYNL-" (never "SYN-",')
  out.push('-- so this can never collide with plugins/plugin-integration-core/fixtures/')
  out.push('-- stock-preparation-synthetic-sql-source/*.sql, which uses "SYN-").')
  out.push('-- ============================================================================')
  out.push('')
  out.push('-- ==== CLEANUP-START (safe to run alone to remove this generator\'s rows only) ====')
  out.push(`DELETE FROM ${TABLES.bomDetail} WHERE bom_pid LIKE '${PREFIX}%';`)
  out.push(`DELETE FROM ${TABLES.bomHead} WHERE part_id LIKE '${PREFIX}%';`)
  out.push(`DELETE FROM ${TABLES.part} WHERE OBJ_ID LIKE '${PREFIX}%';`)
  out.push(`DELETE FROM ${TABLES.orderDetail} WHERE order_id LIKE '${PREFIX}%';`)
  out.push(`DELETE FROM ${TABLES.orderHead} WHERE OBJ_ID LIKE '${PREFIX}%';`)
  out.push(`DELETE FROM ${TABLES.pathInfo} WHERE OBJ_ID LIKE '${PREFIX}%';`)
  out.push(`DELETE FROM ${TABLES.pathExAttr} WHERE Parent_OBJ_ID LIKE '${PREFIX}%';`)
  out.push('-- ==== CLEANUP-END ====')
  out.push('')

  out.push(`INSERT INTO ${TABLES.pathExAttr} (FileCode, Parent_OBJ_ID) VALUES`)
  out.push(`  (${sqlString(projectNo)}, ${sqlString(pathId)});`)
  out.push('')

  out.push(`INSERT INTO ${TABLES.pathInfo} (OBJ_ID) VALUES`)
  out.push(`  (${sqlString(pathId)});`)
  out.push('')

  out.push(`INSERT INTO ${TABLES.orderHead} (OBJ_ID, path_id) VALUES`)
  out.push(`  (${sqlString(orderId)}, ${sqlString(pathId)});`)
  out.push('')

  out.push(`INSERT INTO ${TABLES.orderDetail} (order_id, part_id, quantity, sort_id) VALUES`)
  out.push(`  (${sqlString(orderDetail.orderId)}, ${sqlString(orderDetail.partId)}, ${orderDetail.quantity}, ${orderDetail.sortId});`)
  out.push('')

  const partStatements = renderInsertStatements(
    TABLES.part,
    'OBJ_ID, IdentityNo, IdentityName, Material, SysVer',
    parts,
    (p) => `(${sqlString(p.objId)}, ${sqlString(p.identityNo)}, ${sqlString(p.identityName)}, ${sqlString(p.material)}, ${sqlString(p.sysVer)})`,
  )
  out.push(partStatements.join('\n\n'))
  out.push('')

  const headStatements = renderInsertStatements(
    TABLES.bomHead,
    'part_id, bom_id, SysVer, bom_able',
    bomHeads,
    (h) => `(${sqlString(h.partId)}, ${sqlString(h.bomId)}, ${sqlString(h.sysVer)}, ${sqlString(h.bomAble)})`,
  )
  out.push(headStatements.join('\n\n'))
  out.push('')

  const detailStatements = renderInsertStatements(
    TABLES.bomDetail,
    'bom_pid, part_id, Bom_ExAttr1, sort_id',
    bomDetails,
    (d) => `(${sqlString(d.bomPid)}, ${sqlString(d.partId)}, ${d.qty}, ${d.sortId})`,
  )
  out.push(detailStatements.join('\n\n'))
  out.push('')

  return `${out.join('\n')}\n`
}

export function formatSummary(summary) {
  const lines = []
  lines.push(`projectNo: ${summary.projectNo}`)
  lines.push(`fanout: ${summary.fanout.join(',')}`)
  lines.push('table row counts:')
  for (const [table, count] of Object.entries(summary.tableRowCounts)) {
    lines.push(`  ${table}: ${count}`)
  }
  lines.push(`layer counts: layer1=${summary.layerCounts.layer1} layer2=${summary.layerCounts.layer2} layer3=${summary.layerCounts.layer3}`)
  lines.push(`expected expansion rows, child-only formula (layer1+layer2+layer3): ${summary.childRowsFormulaSum}`)
  lines.push(`expected expansion rows, with root (matches dry-run rowsExpanded): ${summary.expectedExpansionRowsWithRoot}`)
  lines.push(`exceeds default maxRows (${DEFAULT_MAX_ROWS}): ${summary.exceedsDefaultMaxRows}`)
  lines.push(`expected total rolled-up quantity sum across every expanded row: ${summary.expectedTotalQuantitySum}`)
  return lines.join('\n')
}

export function parseArgs(argv) {
  const result = { out: '', fanout: DEFAULT_FANOUT.slice(), project: DEFAULT_PROJECT_NO }
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--out' && value) { result.out = value; i += 1; continue }
    if (flag === '--fanout' && value) { result.fanout = parseFanout(value); i += 1; continue }
    if (flag === '--project' && value) { result.project = value; i += 1; continue }
    throw new Error(`USAGE: node scripts/ops/stock-preparation-synth-large-bom.mjs --out <file.sql> [--fanout 25,25,20] [--project ${DEFAULT_PROJECT_NO}] (unrecognized: ${flag})`)
  }
  if (!result.out) {
    throw new Error('USAGE: --out <file.sql> is required')
  }
  return result
}

function main(argv) {
  const args = parseArgs(argv)
  const dataset = buildLargeBomDataset({ fanout: args.fanout, project: args.project })
  const sql = renderSql(dataset)
  const outPath = path.resolve(args.out)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, sql)
  process.stdout.write(`wrote ${outPath}\n\n`)
  process.stdout.write(`${formatSummary(dataset.summary)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'GENERATE_FAILED'}\n`)
    process.exitCode = 2
  }
}
