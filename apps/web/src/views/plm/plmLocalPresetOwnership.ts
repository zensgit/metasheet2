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
