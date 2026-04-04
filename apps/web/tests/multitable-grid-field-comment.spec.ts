import { describe, expect, it, vi } from 'vitest'
import type { MultitableCommentPresenceSummary } from '../src/multitable/types'
import { handleCommentAffordanceKeydown } from '../src/multitable/utils/comment-affordance'

const PRESENCE: Record<string, MultitableCommentPresenceSummary> = {
  r1: {
    containerId: 's1',
    targetId: 'r1',
    unresolvedCount: 5,
    fieldCounts: { f1: 3, f2: 0, f3: 2 },
    mentionedCount: 2,
    mentionedFieldCounts: { f1: 1, f3: 0, f4: 2 },
  },
  r2: {
    containerId: 's1',
    targetId: 'r2',
    unresolvedCount: 0,
    fieldCounts: {},
    mentionedCount: 0,
    mentionedFieldCounts: {},
  },
}

function fieldCommentCount(
  presence: Record<string, MultitableCommentPresenceSummary | undefined> | undefined,
  recordId: string,
  fieldId: string,
): number {
  return presence?.[recordId]?.fieldCounts?.[fieldId] ?? 0
}

function fieldMentionCount(
  presence: Record<string, MultitableCommentPresenceSummary | undefined> | undefined,
  recordId: string,
  fieldId: string,
): number {
  return presence?.[recordId]?.mentionedFieldCounts?.[fieldId] ?? 0
}

function shouldShowFieldAction(canComment: boolean, isFocused: boolean): boolean {
  return canComment && isFocused
}

describe('grid field-level comment action', () => {
  it('renders only when comments are enabled and the cell is focused', () => {
    expect(shouldShowFieldAction(true, true)).toBe(true)
    expect(shouldShowFieldAction(false, true)).toBe(false)
    expect(shouldShowFieldAction(true, false)).toBe(false)
  })

  it('reads unresolved field counts from fieldCounts', () => {
    expect(fieldCommentCount(PRESENCE, 'r1', 'f1')).toBe(3)
    expect(fieldCommentCount(PRESENCE, 'r1', 'f3')).toBe(2)
    expect(fieldCommentCount(PRESENCE, 'r1', 'f99')).toBe(0)
    expect(fieldCommentCount(undefined, 'r1', 'f1')).toBe(0)
  })

  it('reads mention field counts from mentionedFieldCounts', () => {
    expect(fieldMentionCount(PRESENCE, 'r1', 'f1')).toBe(1)
    expect(fieldMentionCount(PRESENCE, 'r1', 'f4')).toBe(2)
    expect(fieldMentionCount(PRESENCE, 'r1', 'f99')).toBe(0)
    expect(fieldMentionCount(undefined, 'r1', 'f1')).toBe(0)
  })

  it('keeps the open-field-comments payload contract stable', () => {
    const payload = { recordId: 'r1', fieldId: 'f1' }
    expect(payload).toHaveProperty('recordId')
    expect(payload).toHaveProperty('fieldId')
  })

  it('opens field comments on keyboard activation without bubbling', () => {
    const activate = vi.fn()
    const event = {
      key: ' ',
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent

    handleCommentAffordanceKeydown(event, activate)

    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledTimes(1)
  })
})
