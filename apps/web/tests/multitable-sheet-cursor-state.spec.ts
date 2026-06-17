import { describe, it, expect } from 'vitest'
import {
  applyCursorEvent,
  pruneCursors,
  cursorsByCell,
  cursorCellKey,
  type RemoteCellCursor,
} from '../src/multitable/utils/sheet-cursor-state'

const empty = () => new Map<string, RemoteCellCursor>()

describe('sheet-cursor-state — live cell-cursor reducers', () => {
  it('applyCursorEvent tracks a remote collaborator\'s active cell', () => {
    const next = applyCursorEvent(empty(), { userId: 'user_b', recordId: 'rec_1', fieldId: 'fld_x' }, 'user_a')
    expect(next.get('user_b')).toEqual({ recordId: 'rec_1', fieldId: 'fld_x' })
  })

  it('applyCursorEvent EXCLUDES self (never renders your own cursor as remote)', () => {
    const next = applyCursorEvent(empty(), { userId: 'user_a', recordId: 'rec_1', fieldId: 'fld_x' }, 'user_a')
    expect(next.has('user_a')).toBe(false)
    expect(next.size).toBe(0)
  })

  it('applyCursorEvent replaces a user\'s cursor on move + returns a NEW map (reactivity)', () => {
    const first = applyCursorEvent(empty(), { userId: 'user_b', recordId: 'rec_1', fieldId: 'fld_x' }, 'user_a')
    const moved = applyCursorEvent(first, { userId: 'user_b', recordId: 'rec_2', fieldId: 'fld_y' }, 'user_a')
    expect(moved).not.toBe(first)
    expect(moved.get('user_b')).toEqual({ recordId: 'rec_2', fieldId: 'fld_y' })
    expect(moved.size).toBe(1)
  })

  it('applyCursorEvent removes a cursor on a cleared (blur) event — recordId/fieldId missing', () => {
    const present = applyCursorEvent(empty(), { userId: 'user_b', recordId: 'rec_1', fieldId: 'fld_x' }, 'user_a')
    const cleared = applyCursorEvent(present, { userId: 'user_b', recordId: null, fieldId: null }, 'user_a')
    expect(cleared.has('user_b')).toBe(false)
  })

  it('applyCursorEvent ignores an event with no userId', () => {
    const next = applyCursorEvent(empty(), { recordId: 'rec_1', fieldId: 'fld_x' }, 'user_a')
    expect(next.size).toBe(0)
  })

  it('pruneCursors drops cursors for users no longer present', () => {
    let cursors = applyCursorEvent(empty(), { userId: 'user_b', recordId: 'r1', fieldId: 'f1' }, 'me')
    cursors = applyCursorEvent(cursors, { userId: 'user_c', recordId: 'r2', fieldId: 'f2' }, 'me')
    const pruned = pruneCursors(cursors, ['user_b']) // user_c left
    expect(pruned.has('user_b')).toBe(true)
    expect(pruned.has('user_c')).toBe(false)
  })

  it('pruneCursors returns the SAME ref when nothing changed (avoids needless re-render)', () => {
    const cursors = applyCursorEvent(empty(), { userId: 'user_b', recordId: 'r1', fieldId: 'f1' }, 'me')
    expect(pruneCursors(cursors, ['user_b', 'user_c'])).toBe(cursors)
  })

  it('cursorsByCell indexes by cell key and supports multiple collaborators on one cell', () => {
    let cursors = applyCursorEvent(empty(), { userId: 'user_b', recordId: 'r1', fieldId: 'f1' }, 'me')
    cursors = applyCursorEvent(cursors, { userId: 'user_c', recordId: 'r1', fieldId: 'f1' }, 'me')
    const byCell = cursorsByCell(cursors)
    expect(byCell.get(cursorCellKey('r1', 'f1'))?.sort()).toEqual(['user_b', 'user_c'])
  })
})
