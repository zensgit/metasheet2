import { describe, expect, it } from 'vitest'

// Service-level test (NOT mocked — imports the real module) for the values-free-by-construction parser
// and the client/server vocabulary tripwire. The SnapshotDiffView spec mocks this module, so it cannot
// exercise the parser; this file does.
import {
  parseStockPreparationSnapshotDiffRowsResult,
  SNAPSHOT_DIFF_ROWS_MALFORMED,
  STOCK_PREP_DIFF_TYPES,
  STOCK_PREP_REVIEW_STATUSES,
  STOCK_PREP_CHANGE_TYPES,
} from '../src/services/integration/stockPreparation/bomSnapshotDiff'
// The AUTHORITATIVE backend vocabularies (frozen). Imported live so a backend vocab change reddens this
// tripwire instead of silently making the client drop every row of the new kind.
import backendDiff from '../../../plugins/plugin-integration-core/lib/stock-preparation-snapshot-diff.cjs'

// Real backend handle/fingerprint shapes (see stock-preparation-snapshot-diff.cjs / -mapper.cjs).
const GOOD_DIFF_ID = 'stockprep_diff_0123456789abcdef'
const GOOD_LINE_ID = 'stockprep_snapshot_line_0123456789abcdef'
const GOOD_FP = 'sha16:0123456789abcdef'
const GOOD_BATCH = 'stockprep_snapshot_0123456789abcdef'

function validRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    diffId: GOOD_DIFF_ID,
    diffType: 'changed',
    reviewStatus: 'held',
    changeTypes: ['quantity_changed', 'unit_changed'],
    reason: 'matched_path_changed',
    rowCount: 1,
    previousSnapshotLineId: GOOD_LINE_ID,
    currentSnapshotLineId: GOOD_LINE_ID,
    keyFingerprint: GOOD_FP,
    previousPathKeyFingerprint: GOOD_FP,
    currentPathKeyFingerprint: null,
    ...overrides,
  }
}

function parseRows(rows: unknown[]): ReturnType<typeof parseStockPreparationSnapshotDiffRowsResult> {
  return parseStockPreparationSnapshotDiffRowsResult({
    snapshotBatchId: GOOD_BATCH,
    baseSnapshotBatchId: null,
    rowCount: rows.length,
    heldRowCount: 0,
    rows,
  })
}

const SECRET = 'DWG-88472-A' // a planted business value; must never survive parsing into a field

describe('bomSnapshotDiff values-free-by-construction parser', () => {
  it('keeps a well-formed row (real backend shapes)', () => {
    const out = parseRows([validRow()])
    expect(out.rows.length).toBe(1)
    expect(out.rows[0].diffId).toBe(GOOD_DIFF_ID)
    expect(out.rows[0].keyFingerprint).toBe(GOOD_FP)
  })

  // Each whitelisted field is a distinct drop path — a business value planted in ANY of them must drop
  // the whole row, so it can never reach the DOM.
  const dropCases: Array<[string, Record<string, unknown>]> = [
    ['diffId carries a business value', { diffId: SECRET }],
    ['diffType is off-vocabulary', { diffType: SECRET }],
    ['reviewStatus is off-vocabulary', { reviewStatus: 'accepted' }],
    ['a changeType is off-vocabulary', { changeTypes: ['quantity_changed', SECRET] }],
    ['keyFingerprint is not a sha16 handle', { keyFingerprint: SECRET }],
    ['rowCount is negative', { rowCount: -3 }],
    ['rowCount is not an integer', { rowCount: 2.5 }],
  ]
  for (const [name, override] of dropCases) {
    it(`drops the row when ${name}`, () => {
      const out = parseRows([validRow(override)])
      expect(out.rows.length).toBe(0)
      expect(JSON.stringify(out)).not.toContain(SECRET)
    })
  }

  it('drops only the invalid row and keeps the valid one alongside it', () => {
    const out = parseRows([validRow(), validRow({ diffId: 'stockprep_diff_ffffffffffffffff', keyFingerprint: SECRET })])
    expect(out.rows.length).toBe(1)
    expect(out.rows[0].diffId).toBe(GOOD_DIFF_ID)
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })

  it('THROWS a fixed coarse token on a malformed envelope (not a silent "no diff rows")', () => {
    // null / non-object / rows-not-an-array are malformed — the caller must show "unavailable", not empty.
    expect(() => parseStockPreparationSnapshotDiffRowsResult(null)).toThrow(SNAPSHOT_DIFF_ROWS_MALFORMED)
    expect(() => parseStockPreparationSnapshotDiffRowsResult({ rows: 'nope' })).toThrow(SNAPSHOT_DIFF_ROWS_MALFORMED)
    // A valid EMPTY array is a real no-diffs result — allowed, zero rows.
    expect(parseStockPreparationSnapshotDiffRowsResult({ rows: [] }).rows).toEqual([])
    // Junk row entries inside a valid array are individually dropped (not a malformed envelope).
    expect(parseStockPreparationSnapshotDiffRowsResult({ rows: [42, null, 'x'] }).rows).toEqual([])
  })

  it('recomputes rowCount/heldRowCount from RETAINED rows (never a phantom count over a shorter table)', () => {
    // Server claims 9/9 but only one row survives validation → counts reflect the retained row.
    const out = parseStockPreparationSnapshotDiffRowsResult({
      rowCount: 9, heldRowCount: 9,
      rows: [validRow({ reviewStatus: 'held' }), validRow({ diffId: SECRET })],
    })
    expect(out.rows.length).toBe(1)
    expect(out.rowCount).toBe(1)
    expect(out.heldRowCount).toBe(1)
  })
})

describe('client/server vocabulary tripwire (drift guard)', () => {
  const sorted = (xs: readonly string[]) => [...xs].sort()

  it('client STOCK_PREP_DIFF_TYPES equals the backend DIFF_TYPES', () => {
    expect(sorted(STOCK_PREP_DIFF_TYPES)).toEqual(sorted(Object.values(backendDiff.DIFF_TYPES)))
  })
  it('client STOCK_PREP_REVIEW_STATUSES equals the backend REVIEW_STATUSES', () => {
    expect(sorted(STOCK_PREP_REVIEW_STATUSES)).toEqual(sorted(Object.values(backendDiff.REVIEW_STATUSES)))
  })
  it('client STOCK_PREP_CHANGE_TYPES equals the backend CHANGE_TYPES', () => {
    expect(sorted(STOCK_PREP_CHANGE_TYPES)).toEqual(sorted(Object.values(backendDiff.CHANGE_TYPES)))
  })
})
