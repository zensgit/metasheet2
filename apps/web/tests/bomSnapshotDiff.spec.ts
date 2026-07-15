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

  // Fail-closed at the ENVELOPE: a business value planted in ANY whitelisted field of ANY row THROWS the
  // whole response into the unavailable state — never a silent per-row drop (which would hide an
  // all-invalid response as "no diff rows" and a mixed one as a silently-incomplete table).
  const throwCases: Array<[string, Record<string, unknown>]> = [
    ['diffId carries a business value', { diffId: SECRET }],
    ['diffType is off-vocabulary', { diffType: SECRET }],
    ['reviewStatus is off-vocabulary', { reviewStatus: 'accepted' }],
    ['a changeType is off-vocabulary', { changeTypes: ['quantity_changed', SECRET] }],
    ['keyFingerprint is not a sha16 handle', { keyFingerprint: SECRET }],
    ['rowCount is negative', { rowCount: -3 }],
    ['rowCount is not an integer', { rowCount: 2.5 }],
  ]
  for (const [name, override] of throwCases) {
    it(`THROWS the whole envelope when ${name}`, () => {
      expect(() => parseRows([validRow(override)])).toThrow(SNAPSHOT_DIFF_ROWS_MALFORMED)
    })
  }

  it('a MIXED response (one valid + one invalid row) throws — never a silently-incomplete table', () => {
    expect(() => parseRows([validRow(), validRow({ diffId: 'stockprep_diff_ffffffffffffffff', keyFingerprint: SECRET })]))
      .toThrow(SNAPSHOT_DIFF_ROWS_MALFORMED)
  })

  it('THROWS on a malformed envelope OR any invalid row; only a valid empty [] is the empty state', () => {
    // null / non-object / rows-not-an-array → unavailable, not empty.
    expect(() => parseStockPreparationSnapshotDiffRowsResult(null)).toThrow(SNAPSHOT_DIFF_ROWS_MALFORMED)
    expect(() => parseStockPreparationSnapshotDiffRowsResult({ rows: 'nope' })).toThrow(SNAPSHOT_DIFF_ROWS_MALFORMED)
    // Junk row entries are invalid rows → the whole envelope is unavailable (NOT silently dropped to []).
    expect(() => parseStockPreparationSnapshotDiffRowsResult({ rows: [42, null, 'x'] })).toThrow(SNAPSHOT_DIFF_ROWS_MALFORMED)
    // A genuinely valid EMPTY array is the ONLY thing that yields the empty state.
    expect(parseStockPreparationSnapshotDiffRowsResult({ rows: [] }).rows).toEqual([])
  })

  it('when EVERY row is valid, rowCount/heldRowCount are computed from them', () => {
    const out = parseStockPreparationSnapshotDiffRowsResult({
      rowCount: 9, heldRowCount: 9, // server envelope counts are ignored — recomputed from the parsed rows
      rows: [validRow({ reviewStatus: 'held' }), validRow({ diffId: 'stockprep_diff_ffffffffffffffff', reviewStatus: 'ready' })],
    })
    expect(out.rows.length).toBe(2)
    expect(out.rowCount).toBe(2)
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
