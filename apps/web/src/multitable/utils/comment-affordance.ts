import type { MultitableCommentPresenceSummary } from '../types'

export type CommentAffordanceState = {
  unresolvedCount: number
  mentionCount: number
  isActive: boolean
  isIdle: boolean
  showIcon: boolean
}

export type CommentAffordanceStateName = 'active' | 'idle'

export function resolveCommentAffordance(
  unresolvedCount?: number | null,
  mentionCount?: number | null,
): CommentAffordanceState {
  const nextUnresolvedCount = unresolvedCount ?? 0
  const nextMentionCount = mentionCount ?? 0
  const isActive = nextUnresolvedCount > 0 || nextMentionCount > 0

  return {
    unresolvedCount: nextUnresolvedCount,
    mentionCount: nextMentionCount,
    isActive,
    isIdle: !isActive,
    showIcon: !isActive,
  }
}

export function resolveCommentAffordanceStateName(
  state: Pick<CommentAffordanceState, 'isActive'>,
): CommentAffordanceStateName {
  return state.isActive ? 'active' : 'idle'
}

export function resolveCommentAffordanceStateClass(
  baseClassName: string,
  state: Pick<CommentAffordanceState, 'isActive'>,
): string {
  return `${baseClassName}--${resolveCommentAffordanceStateName(state)}`
}

export function resolveFieldCommentAffordance(
  presence: MultitableCommentPresenceSummary | null | undefined,
  fieldId: string,
): CommentAffordanceState {
  return resolveCommentAffordance(
    presence?.fieldCounts?.[fieldId],
    presence?.mentionedFieldCounts?.[fieldId],
  )
}

export function resolveRecordCommentAffordance(
  presence: MultitableCommentPresenceSummary | null | undefined,
): CommentAffordanceState {
  return resolveCommentAffordance(
    presence?.unresolvedCount,
    presence?.mentionedCount,
  )
}

export function handleCommentAffordanceKeydown(
  event: KeyboardEvent,
  activate: () => void,
): void {
  event.stopPropagation()
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault()
    activate()
  }
}
