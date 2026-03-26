type RunPlmLocalPresetOwnershipActionOptions<Result> = {
  clearLocalOwner: () => void
  shouldClear?: (result: Result) => boolean
}

export type PlmLocalPresetTeamPresetActionKind =
  | 'apply'
  | 'save'
  | 'duplicate'
  | 'rename'
  | 'transfer'
  | 'set-default'
  | 'clear-default'
  | 'restore'
  | 'promote'
  | 'promote-default'
  | 'archive'
  | 'batch-archive'
  | 'batch-delete'

export function shouldClearLocalPresetOwnerAfterTeamPresetAction(
  action: PlmLocalPresetTeamPresetActionKind,
  result: unknown,
) {
  if (action === 'archive' || action === 'batch-archive' || action === 'batch-delete') {
    return false
  }
  return Boolean(result)
}

export function shouldClearLocalPresetOwnerAfterTeamPresetBatchRestore(
  result: { processedIds?: string[] } | null | undefined,
  activeTeamPresetId: string | null | undefined,
  requestedTeamPresetId: string | null | undefined,
  hadLocalOwnerBeforeAction = false,
) {
  if (hadLocalOwnerBeforeAction) return false

  const activeId = activeTeamPresetId?.trim() || ''
  if (!activeId) return false

  const processedIds = new Set(
    (result?.processedIds || [])
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  if (!processedIds.has(activeId)) return false

  const requestedId = requestedTeamPresetId?.trim() || ''
  if (requestedId && !processedIds.has(requestedId)) {
    return false
  }

  return true
}

export async function runPlmLocalPresetOwnershipAction<Result>(
  action: () => Promise<Result>,
  options: RunPlmLocalPresetOwnershipActionOptions<Result>,
) {
  const result = await action()
  if ((options.shouldClear ?? (() => true))(result)) {
    options.clearLocalOwner()
  }
  return result
}
