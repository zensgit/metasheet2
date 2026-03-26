type RunPlmLocalPresetOwnershipActionOptions<Result> = {
  clearLocalOwner: () => void
  shouldClear?: (result: Result) => boolean
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
