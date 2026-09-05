import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_FANOUT,
  DEFAULT_MAX_ROWS,
  PREFIX,
  buildLargeBomDataset,
  parseFanout,
  renderSql,
} from '../stock-preparation-synth-large-bom.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.join(__dirname, '..', 'stock-preparation-synth-large-bom.mjs')

// The 7 table names the shipped fixture DDL declares
// (plugins/plugin-integration-core/fixtures/stock-preparation-synthetic-sql-source/01-schema.sql) —
// this generator must emit exactly these, unquoted, same casing.
const TABLE_NAMES = [
  'DN_PDM_PathExAttrInfo',
  'DN_PDM_PathInfo',
  'DN_PDM_OrderHeadInfo',
  'DN_PDM_OrderDetailInfo',
  'DN_PDM_PartLibraryInfo',
  'DN_PDM_BomHeadInfo',
  'DN_PDM_BomDetailsInfo',
]

function expectedCounts([f0, f1, f2]) {
  const layer1 = f0
  const layer2 = f0 * f1
  const layer3 = f0 * f1 * f2
  return {
    layer1,
    layer2,
    layer3,
    childRowsFormulaSum: layer1 + layer2 + layer3,
    partsCount: 1 + layer1 + layer2 + layer3,
    bomHeadsCount: 1 + layer1 + layer2, // root + layer1 + layer2 parts are the only non-leaf parts
    bomDetailsCount: layer1 + layer2 + layer3,
  }
}

function assertDatasetShape(dataset, fanout) {
  const expected = expectedCounts(fanout)

  assert.equal(dataset.parts.length, expected.partsCount)
  assert.equal(dataset.bomHeads.length, expected.bomHeadsCount)
  assert.equal(dataset.bomDetails.length, expected.bomDetailsCount)
  assert.equal(dataset.summary.childRowsFormulaSum, expected.childRowsFormulaSum)
  assert.equal(dataset.summary.expectedExpansionRowsWithRoot, expected.partsCount)

  // Every part appears exactly once in the part master (no duplicates, no missing parts).
  const partIds = dataset.parts.map((p) => p.objId)
  assert.equal(new Set(partIds).size, partIds.length, 'part OBJ_IDs must be unique')

  // Every BOM detail line's component id resolves to a part in the master.
  const partIdSet = new Set(partIds)
  for (const detail of dataset.bomDetails) {
    assert.ok(partIdSet.has(detail.partId), `bomDetail references missing part ${detail.partId}`)
  }
  // Every BOM head's owning part id resolves to a part in the master too.
  for (const head of dataset.bomHeads) {
    assert.ok(partIdSet.has(head.partId), `bomHead references missing part ${head.partId}`)
  }

  // Prefix discipline: every identifier this generator creates for itself (path id, order id,
  // part ids, bom ids) carries the "SYNL-" prefix (never bare "SYN-", which belongs to the
  // shipped fixture's own dataset and must never collide with this one).
  assert.ok(dataset.pathId.startsWith(PREFIX))
  assert.ok(dataset.orderId.startsWith(PREFIX))
  assert.ok(dataset.rootPartId.startsWith(PREFIX))
  for (const p of dataset.parts) assert.ok(p.objId.startsWith(PREFIX), `part id ${p.objId} missing ${PREFIX} prefix`)
  for (const h of dataset.bomHeads) {
    assert.ok(h.partId.startsWith(PREFIX), `bomHead.partId ${h.partId} missing ${PREFIX} prefix`)
    assert.ok(h.bomId.startsWith(PREFIX), `bomHead.bomId ${h.bomId} missing ${PREFIX} prefix`)
  }
  for (const d of dataset.bomDetails) {
    assert.ok(d.bomPid.startsWith(PREFIX), `bomDetail.bomPid ${d.bomPid} missing ${PREFIX} prefix`)
    assert.ok(d.partId.startsWith(PREFIX), `bomDetail.partId ${d.partId} missing ${PREFIX} prefix`)
  }

  // Quantities cycle 1,2,3 within a parent's children (so totalQuantity roll-up is hand-checkable).
  for (const d of dataset.bomDetails) {
    assert.ok(d.qty >= 1 && d.qty <= 3, `bomDetail quantity ${d.qty} out of the 1-3 cycle`)
  }

  // Recompute the expected total-quantity sum independently (root quantity 1, multiplied down
  // each parent -> child edge) and check it matches the generator's own reported sum.
  const totalByPart = new Map([[dataset.rootPartId, dataset.orderDetail.quantity]])
  const childrenByBomPid = new Map()
  for (const d of dataset.bomDetails) {
    if (!childrenByBomPid.has(d.bomPid)) childrenByBomPid.set(d.bomPid, [])
    childrenByBomPid.get(d.bomPid).push(d)
  }
  const bomIdByPartId = new Map(dataset.bomHeads.map((h) => [h.partId, h.bomId]))
  let recomputedSum = 0
  const queue = [dataset.rootPartId]
  while (queue.length > 0) {
    const partId = queue.shift()
    const total = totalByPart.get(partId)
    recomputedSum += total
    const bomId = bomIdByPartId.get(partId)
    const children = bomId ? childrenByBomPid.get(bomId) || [] : []
    for (const child of children) {
      totalByPart.set(child.partId, total * child.qty)
      queue.push(child.partId)
    }
  }
  assert.equal(recomputedSum, dataset.summary.expectedTotalQuantitySum)
}

test('parseFanout accepts "N,N,N" strings and 3-element arrays, rejects everything else', () => {
  assert.deepEqual(parseFanout('25,25,20'), [25, 25, 20])
  assert.deepEqual(parseFanout([2, 2, 2]), [2, 2, 2])
  assert.throws(() => parseFanout('2,2'), /FANOUT_INVALID/)
  assert.throws(() => parseFanout('2,2,0'), /FANOUT_INVALID/)
  assert.throws(() => parseFanout('a,b,c'), /FANOUT_INVALID/)
  assert.throws(() => parseFanout([2, 2]), /FANOUT_INVALID/)
})

test('buildLargeBomDataset with a small fanout (2,2,2) matches the layer-product formula', () => {
  const dataset = buildLargeBomDataset({ fanout: [2, 2, 2], project: 'SYNL-TEST-SMALL' })
  assertDatasetShape(dataset, [2, 2, 2])
  assert.equal(dataset.summary.expectedExpansionRowsWithRoot, 15) // 1 + 2 + 4 + 8
  assert.equal(dataset.summary.childRowsFormulaSum, 14) // 2 + 4 + 8
  assert.equal(dataset.summary.exceedsDefaultMaxRows, false)
})

test('buildLargeBomDataset with the default fanout (25,25,20) exceeds maxRows and matches the spec arithmetic', () => {
  const dataset = buildLargeBomDataset({}) // default fanout + default project
  assert.deepEqual(dataset.summary.fanout, DEFAULT_FANOUT.slice())
  assertDatasetShape(dataset, DEFAULT_FANOUT)
  // Spec arithmetic: 25 + 625 + 12500 = 13150 (child rows only, no root).
  assert.equal(dataset.summary.childRowsFormulaSum, 25 + 625 + 12500)
  assert.equal(dataset.summary.childRowsFormulaSum, 13150)
  // rowsExpanded a real dry-run would report also counts the root's own row.
  assert.equal(dataset.summary.expectedExpansionRowsWithRoot, 13151)
  assert.ok(dataset.summary.expectedExpansionRowsWithRoot > DEFAULT_MAX_ROWS)
  assert.equal(dataset.summary.exceedsDefaultMaxRows, true)
})

test('renderSql emits idempotent SQL: every DELETE precedes every INSERT, all 7 tables present', () => {
  const dataset = buildLargeBomDataset({ fanout: [2, 2, 2], project: 'SYNL-TEST-SMALL' })
  const sql = renderSql(dataset)

  for (const table of TABLE_NAMES) {
    assert.match(sql, new RegExp(`DELETE FROM ${table}\\b`), `missing DELETE for ${table}`)
    assert.match(sql, new RegExp(`INSERT INTO ${table}\\b`), `missing INSERT for ${table}`)
  }

  const lastDeleteIndex = Math.max(...TABLE_NAMES.map((t) => sql.lastIndexOf(`DELETE FROM ${t}`)))
  const firstInsertIndex = Math.min(...TABLE_NAMES.map((t) => sql.indexOf(`INSERT INTO ${t}`)))
  assert.ok(lastDeleteIndex < firstInsertIndex, 'every DELETE statement must precede every INSERT statement')

  // Cleanup markers bracket exactly the DELETE block.
  const cleanupStart = sql.indexOf('CLEANUP-START')
  const cleanupEnd = sql.indexOf('CLEANUP-END')
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart)
  assert.ok(cleanupEnd < firstInsertIndex)

  // Every DELETE filters by the SYNL- prefix (idempotency, and never touches SYN- fixture rows).
  const deleteLines = sql.split('\n').filter((line) => line.startsWith('DELETE FROM'))
  assert.equal(deleteLines.length, TABLE_NAMES.length)
  for (const line of deleteLines) {
    assert.match(line, /LIKE 'SYNL-%'/)
  }
})

test('renderSql row counts in the generated SQL text match the dataset (2,2,2)', () => {
  const dataset = buildLargeBomDataset({ fanout: [2, 2, 2], project: 'SYNL-TEST-SMALL' })
  const sql = renderSql(dataset)

  // Count VALUES tuples emitted for the part / bomHead / bomDetail tables by counting the
  // generator's own id prefixes, which is robust to statement batching.
  const partTupleCount = (sql.match(/'SYNL-PART-[^']*-NO'/g) || []).length
  assert.equal(partTupleCount, dataset.parts.length)

  // Scope to the BomHeadInfo insert block only — bom_pid values in DN_PDM_BomDetailsInfo also
  // end in "-BOM" and would otherwise be double-counted.
  const bomHeadBlockMatch = sql.match(/INSERT INTO DN_PDM_BomHeadInfo[\s\S]*?(?=\n\nINSERT INTO DN_PDM_BomDetailsInfo)/)
  assert.ok(bomHeadBlockMatch)
  const bomHeadTupleCount = (bomHeadBlockMatch[0].match(/\('SYNL-/g) || []).length
  assert.equal(bomHeadTupleCount, dataset.bomHeads.length)

  // bom detail rows: one line per (bom_pid, part_id) tuple in the INSERT INTO DN_PDM_BomDetailsInfo block
  const bomDetailBlockMatch = sql.match(/INSERT INTO DN_PDM_BomDetailsInfo[\s\S]*/)
  assert.ok(bomDetailBlockMatch)
  const bomDetailTupleCount = (bomDetailBlockMatch[0].match(/\('SYNL-/g) || []).length
  assert.equal(bomDetailTupleCount, dataset.bomDetails.length)
})

test('CLI writes a file and prints a summary (2,2,2 via subprocess)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-large-bom-'))
  const outFile = path.join(tmpDir, 'synth-large-bom.sql')
  try {
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH, '--out', outFile, '--fanout', '2,2,2', '--project', 'SYNL-TEST-CLI'],
      { encoding: 'utf8' },
    )
    assert.match(stdout, /table row counts:/)
    assert.match(stdout, /expected expansion rows, with root \(matches dry-run rowsExpanded\): 15/)

    assert.ok(fs.existsSync(outFile))
    const sql = fs.readFileSync(outFile, 'utf8')
    assert.match(sql, /DELETE FROM DN_PDM_BomDetailsInfo WHERE bom_pid LIKE 'SYNL-%';/)
    assert.match(sql, /INSERT INTO DN_PDM_PathExAttrInfo \(FileCode, Parent_OBJ_ID\) VALUES/)
    assert.match(sql, /'SYNL-TEST-CLI'/)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('CLI is idempotent when re-run: re-generating still deletes-then-inserts, no accumulation across runs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-large-bom-idem-'))
  const outFile = path.join(tmpDir, 'synth-large-bom.sql')
  try {
    execFileSync(process.execPath, [SCRIPT_PATH, '--out', outFile, '--fanout', '2,2,2'], { encoding: 'utf8' })
    const firstRun = fs.readFileSync(outFile, 'utf8')
    execFileSync(process.execPath, [SCRIPT_PATH, '--out', outFile, '--fanout', '2,2,2'], { encoding: 'utf8' })
    const secondRun = fs.readFileSync(outFile, 'utf8')
    // Regenerating with the same params reproduces byte-identical SQL (deterministic generator) —
    // the actual idempotency-on-the-database guarantee comes from the DELETE...LIKE 'SYNL-%'
    // statements at the top of the file, asserted separately above.
    assert.equal(firstRun, secondRun)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('CLI rejects a missing --out and an invalid --fanout', () => {
  assert.throws(() => {
    execFileSync(process.execPath, [SCRIPT_PATH, '--fanout', '2,2,2'], { encoding: 'utf8', stdio: 'pipe' })
  })
  assert.throws(() => {
    execFileSync(process.execPath, [SCRIPT_PATH, '--out', 'x.sql', '--fanout', '2,2'], { encoding: 'utf8', stdio: 'pipe' })
  })
})
