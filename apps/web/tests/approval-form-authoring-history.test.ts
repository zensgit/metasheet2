import { describe, expect, it } from 'vitest'

import {
  canRedoFormHistory,
  canUndoFormHistory,
  createFormAuthoringHistory,
  pushFormSnapshot,
  redoFormHistory,
  undoFormHistory,
} from '../src/approvals/approvalFormAuthoringHistory'
import {
  createEmptyFieldDraft,
  type FieldAuthoringDraft,
} from '../src/approvals/templateAuthoring'

function field(index: number, overrides: Partial<FieldAuthoringDraft> = {}): FieldAuthoringDraft {
  return {
    ...createEmptyFieldDraft(index),
    localId: `local_${index}`,
    id: `field_${index}`,
    label: `字段 ${index}`,
    ...overrides,
  }
}

function fieldIds(fields: readonly FieldAuthoringDraft[]): string[] {
  return fields.map((f) => f.localId)
}

describe('approvalFormAuthoringHistory', () => {
  it('undo restores prior fields', () => {
    const initial = [field(1)]
    let history = createFormAuthoringHistory(initial, 'local_1')
    history = pushFormSnapshot(history, [field(1), field(2)], 'local_2')
    expect(fieldIds(history.fields)).toEqual(['local_1', 'local_2'])
    expect(canUndoFormHistory(history)).toBe(true)

    const undone = undoFormHistory(history)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(fieldIds(undone.fields)).toEqual(['local_1'])
    expect(undone.focusLocalId).toBe('local_1')
    expect(canRedoFormHistory(undone.history)).toBe(true)
  })

  it('redo after undo restores the newer field list', () => {
    let history = createFormAuthoringHistory([field(1)])
    history = pushFormSnapshot(history, [field(1), field(2)], 'local_2')
    const undone = undoFormHistory(history)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return

    const redone = redoFormHistory(undone.history)
    expect(redone.ok).toBe(true)
    if (!redone.ok) return
    expect(fieldIds(redone.fields)).toEqual(['local_1', 'local_2'])
    expect(redone.focusLocalId).toBe('local_2')
    expect(canUndoFormHistory(redone.history)).toBe(true)
    expect(canRedoFormHistory(redone.history)).toBe(false)
  })

  it('empty undo/redo fail closed with unchanged history', () => {
    const history = createFormAuthoringHistory([field(1)], 'local_1')
    const snap = JSON.parse(JSON.stringify(history))

    const emptyUndo = undoFormHistory(history)
    expect(emptyUndo.ok).toBe(false)
    if (emptyUndo.ok) return
    expect(emptyUndo.reason).toBe('empty-undo')
    expect(emptyUndo.history).toEqual(snap)
    expect(fieldIds(emptyUndo.fields)).toEqual(['local_1'])

    const emptyRedo = redoFormHistory(history)
    expect(emptyRedo.ok).toBe(false)
    if (emptyRedo.ok) return
    expect(emptyRedo.reason).toBe('empty-redo')
    expect(emptyRedo.history).toEqual(snap)
  })

  it('push is a no-op when fields are byte-identical', () => {
    const fields = [field(1, { label: 'A' })]
    let history = createFormAuthoringHistory(fields, 'local_1')
    history = pushFormSnapshot(history, [field(1), field(2)], 'local_2')
    const afterPush = JSON.parse(JSON.stringify(history))

    // Same field list as current tip — redo stack would stay if we had one; stacks unchanged.
    const noop = pushFormSnapshot(history, history.fields, 'local_2')
    expect(noop).toEqual(afterPush)
    expect(noop.undoStack.length).toBe(afterPush.undoStack.length)

    // Explicit deep-equal nextFields also no-ops even if caller rebuilds objects.
    const rebuild = pushFormSnapshot(
      history,
      [field(1), field(2)],
      'local_2',
    )
    expect(rebuild.undoStack.length).toBe(1)
    expect(fieldIds(rebuild.fields)).toEqual(['local_1', 'local_2'])
  })

  it('structural: multiple adds then undo steps back one by one', () => {
    let history = createFormAuthoringHistory([field(1)], 'local_1')
    history = pushFormSnapshot(history, [field(1), field(2)], 'local_2')
    history = pushFormSnapshot(history, [field(1), field(2), field(3)], 'local_3')
    history = pushFormSnapshot(
      history,
      [field(1), field(2), field(3), field(4)],
      'local_4',
    )
    expect(fieldIds(history.fields)).toEqual(['local_1', 'local_2', 'local_3', 'local_4'])
    expect(history.undoStack.length).toBe(3)

    const u1 = undoFormHistory(history)
    expect(u1.ok).toBe(true)
    if (!u1.ok) return
    expect(fieldIds(u1.fields)).toEqual(['local_1', 'local_2', 'local_3'])

    const u2 = undoFormHistory(u1.history)
    expect(u2.ok).toBe(true)
    if (!u2.ok) return
    expect(fieldIds(u2.fields)).toEqual(['local_1', 'local_2'])

    const u3 = undoFormHistory(u2.history)
    expect(u3.ok).toBe(true)
    if (!u3.ok) return
    expect(fieldIds(u3.fields)).toEqual(['local_1'])
    expect(canUndoFormHistory(u3.history)).toBe(false)

    const r1 = redoFormHistory(u3.history)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(fieldIds(r1.fields)).toEqual(['local_1', 'local_2'])
  })

  it('push clears redo after a divergent mutation', () => {
    let history = createFormAuthoringHistory([field(1)])
    history = pushFormSnapshot(history, [field(1), field(2)], 'local_2')
    const undone = undoFormHistory(history)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(canRedoFormHistory(undone.history)).toBe(true)

    history = pushFormSnapshot(undone.history, [field(1), field(9)], 'local_9')
    expect(canRedoFormHistory(history)).toBe(false)
    expect(fieldIds(history.fields)).toEqual(['local_1', 'local_9'])
  })

  it('clones fields so later in-place mutation does not corrupt stacks', () => {
    const a = field(1, { label: 'original' })
    let history = createFormAuthoringHistory([a], 'local_1')
    const next = [field(1, { label: 'original' }), field(2)]
    history = pushFormSnapshot(history, next, 'local_2')

    // Mutate the live tip object the caller still holds.
    next[0]!.label = 'mutated-live'
    history.fields[0]!.label = 'mutated-tip'

    const undone = undoFormHistory(history)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.fields[0]?.label).toBe('original')
  })
})
