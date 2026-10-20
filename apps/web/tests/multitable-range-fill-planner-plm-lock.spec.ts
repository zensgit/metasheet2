/**
 * 备料 option B (awaiting the owner's A/B/C ruling): the range planner SKIPS human-write-locked columns.
 *
 * A PLM-system column on a one-sheet-per-project 备料 sheet carries `property.humanWriteLock = 'plm_system'`.
 * The server refuses any person write to it (FIELD_READONLY_PLM_SYSTEM). The planner must therefore never
 * emit a change for such a column — and, unlike every other read-only cell (which still refuses the whole
 * range with READ_ONLY), it leaves the locked column alone and plans the rest, counting what it skipped.
 *
 * Collected by the required web gate through the existing `multitable-range-fill-planner` token (a vitest
 * path-substring filter, apps/web/scripts/run-required-web-tests.sh).
 */
import { describe, expect, it } from 'vitest'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import {
  RangeOperationError, planRangeFill, planRangeFillWithSkips, planRangePaste, planRangePasteWithSkips,
  type CellRange,
} from '../src/multitable/utils/grid-range-fill'
import { isFieldBulkEditable, isFieldHumanWriteLocked } from '../src/multitable/utils/field-permissions'

const writable = () => true
const LOCK = { humanWriteLock: 'plm_system' }
// Column 0 = a locked PLM-system string column (图号-like), 1 = a human string column (备注-like),
// 2 = a locked PLM-system number column (总用量-like), 3 = a human number column (提前周期-like).
function fields(): MetaField[] {
  return [
    { id: 'plmCode', name: 'PLM code', type: 'string', property: { ...LOCK } },
    { id: 'notes', name: 'Notes', type: 'string' },
    { id: 'plmQty', name: 'PLM qty', type: 'number', property: { ...LOCK } },
    { id: 'lead', name: 'Lead', type: 'number' },
  ]
}
function rows(): MetaRecord[] {
  return [0, 1, 2].map((i) => ({
    id: `r${i}`, version: 10 + i,
    data: { plmCode: `CODE-${i}`, notes: `note-${i}`, plmQty: i + 1, lead: (i + 1) * 2 },
  }))
}
const range = (top: number, left: number, bottom: number, right: number): CellRange => ({ top, left, bottom, right })
function expectCode(run: () => unknown, code: string) {
  try { run() } catch (error) {
    expect(error).toBeInstanceOf(RangeOperationError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error('EXPECTED_RANGE_REJECTION')
}

describe('isFieldHumanWriteLocked — closed vocabulary', () => {
  it('only the exact plm_system marker locks a column', () => {
    expect(isFieldHumanWriteLocked({ property: { humanWriteLock: 'plm_system' } })).toBe(true)
    for (const value of [true, 'PLM_SYSTEM', 'plm', '', null, 1, { kind: 'plm_system' }]) {
      expect(isFieldHumanWriteLocked({ property: { humanWriteLock: value } }), String(value)).toBe(false)
    }
    expect(isFieldHumanWriteLocked({ property: {} })).toBe(false)
    expect(isFieldHumanWriteLocked({})).toBe(false)
    expect(isFieldHumanWriteLocked(null)).toBe(false)
  })

  it('a locked column is not bulk-editable; the same column unlocked is', () => {
    const [locked, human] = fields()
    expect(isFieldBulkEditable({ field: locked, canEdit: true })).toBe(false)
    expect(isFieldBulkEditable({ field: { ...locked, property: {} }, canEdit: true })).toBe(true)
    expect(isFieldBulkEditable({ field: human, canEdit: true })).toBe(true)
  })
})

describe('paste: locked columns are skipped, the rest is planned', () => {
  it('a 2x2 clipboard over [locked, human] writes only the human column and counts the skipped cells', () => {
    const plan = planRangePasteWithSkips({
      rows: rows(), fields: fields(), target: range(0, 0, 1, 1),
      matrix: [['HACK-0', 'n0'], ['HACK-1', 'n1']], canWrite: writable,
    })
    expect(plan.changes).toEqual([
      { recordId: 'r0', fieldId: 'notes', value: 'n0', expectedVersion: 10 },
      { recordId: 'r1', fieldId: 'notes', value: 'n1', expectedVersion: 11 },
    ])
    expect(plan.skippedLockedCells).toBe(2)
    expect(plan.changes.some((change) => change.fieldId === 'plmCode')).toBe(false)
  })

  it('text that would be INVALID for the locked column is never parsed for it (no INVALID_VALUE)', () => {
    // 'not-a-number' would fail the number column's parse — it is skipped first, so the paste stands.
    const plan = planRangePasteWithSkips({
      rows: rows(), fields: fields(), target: range(0, 2, 0, 3),
      matrix: [['not-a-number', '7']], canWrite: writable,
    })
    expect(plan.changes).toEqual([{ recordId: 'r0', fieldId: 'lead', value: 7, expectedVersion: 10 }])
    expect(plan.skippedLockedCells).toBe(1)
  })

  it('a paste onto a locked column only plans nothing and reports what it skipped', () => {
    const plan = planRangePasteWithSkips({
      rows: rows(), fields: fields(), target: range(0, 0, 2, 0), matrix: [['X']], canWrite: writable,
    })
    expect(plan).toEqual({ changes: [], skippedLockedCells: 3 })
  })

  it('the legacy entry point returns the same changes (no locked column ever in it)', () => {
    const args = { rows: rows(), fields: fields(), target: range(0, 0, 1, 1), matrix: [['A', 'b'], ['C', 'd']], canWrite: writable }
    expect(planRangePaste(args)).toEqual(planRangePasteWithSkips(args).changes)
  })

  it('every OTHER read-only cell keeps the all-or-nothing READ_ONLY refusal', () => {
    const withLegacyReadonly = fields().map((field) => field.id === 'notes' ? { ...field, property: { readOnly: true } } : field)
    expectCode(() => planRangePasteWithSkips({
      rows: rows(), fields: withLegacyReadonly, target: range(0, 0, 0, 1), matrix: [['A', 'b']], canWrite: writable,
    }), 'READ_ONLY')
    // A per-field permission deny (canWrite false) on the human column is still READ_ONLY too.
    expectCode(() => planRangePasteWithSkips({
      rows: rows(), fields: fields(), target: range(0, 0, 0, 1), matrix: [['A', 'b']],
      canWrite: (_recordId, field) => field.id !== 'notes',
    }), 'READ_ONLY')
  })

  it('the skip does not depend on canWrite: a stale permission map that still says writable cannot reopen it', () => {
    const plan = planRangePasteWithSkips({
      rows: rows(), fields: fields(), target: range(0, 0, 0, 0), matrix: [['X']], canWrite: () => true,
    })
    expect(plan.changes).toEqual([])
  })
})

describe('fill: locked destination columns are skipped', () => {
  it('copy-fill down over [locked, human] fills only the human column', () => {
    const plan = planRangeFillWithSkips({
      rows: rows(), fields: fields(), source: range(0, 0, 0, 1), target: range(0, 0, 2, 1), mode: 'copy', canWrite: writable,
    })
    expect(plan.changes).toEqual([
      { recordId: 'r1', fieldId: 'notes', value: 'note-0', expectedVersion: 11 },
      { recordId: 'r2', fieldId: 'notes', value: 'note-0', expectedVersion: 12 },
    ])
    expect(plan.skippedLockedCells).toBe(2)
  })

  it('series-fill down over [locked number, human number] builds no series for the locked column', () => {
    const plan = planRangeFillWithSkips({
      rows: rows(), fields: fields(), source: range(0, 2, 1, 3), target: range(0, 2, 2, 3), mode: 'series', canWrite: writable,
    })
    expect(plan.changes).toEqual([{ recordId: 'r2', fieldId: 'lead', value: 6, expectedVersion: 12 }])
    expect(plan.skippedLockedCells).toBe(1)
  })

  it('series-fill down over a locked STRING column is not an INVALID_SERIES (it is skipped, not evaluated)', () => {
    const plan = planRangeFillWithSkips({
      rows: rows(), fields: fields(), source: range(0, 0, 1, 0), target: range(0, 0, 2, 0), mode: 'series', canWrite: writable,
    })
    expect(plan).toEqual({ changes: [], skippedLockedCells: 1 })
  })

  it('a horizontal fill FROM a locked column into a human column of the same type is a normal copy (reading is allowed)', () => {
    const plan = planRangeFillWithSkips({
      rows: rows(), fields: fields(), source: range(0, 0, 0, 0), target: range(0, 0, 0, 1), mode: 'copy', canWrite: writable,
    })
    expect(plan).toEqual({ changes: [{ recordId: 'r0', fieldId: 'notes', value: 'CODE-0', expectedVersion: 10 }], skippedLockedCells: 0 })
  })

  it('the legacy entry point returns the same changes', () => {
    const args = { rows: rows(), fields: fields(), source: range(0, 0, 0, 1), target: range(0, 0, 2, 1), mode: 'copy' as const, canWrite: writable }
    expect(planRangeFill(args)).toEqual(planRangeFillWithSkips(args).changes)
  })
})
