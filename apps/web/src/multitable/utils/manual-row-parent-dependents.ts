// 人工补充行的父组件 — the §12.7 ① warning (ADR adr-stock-prep-manual-rows-20261030, slice P2). A manual row's 图号 can
// be changed (grid cell, drawer) and the row can be deleted; other manual rows that name it as their 父组件 keep the old
// text (rule P6: the parent is a display attribute of each child, never a reference). Before either, the web asks the
// host how many there are (GET /records/:recordId/manual-parent-dependents — a number only) and, when there are any,
// asks the person 「有 N 行人工补充行以它为父组件，修改/删除后它们不会跟着变」. Nothing is rewritten.
//
// A HINT, NOT A GATE: a count that cannot be read (an older host, a refusal, the network) does not stop the change or
// the deletion — the write routes keep their own checks. Only an explicit 「取消」 aborts.

import { manualRowParentDependentsConfirmText } from './manual-row-labels'

export type ManualRowParentDependentsCheck = {
  /** The manual rows about to change 图号 or be deleted. */
  recordIds: readonly string[]
  count: (recordId: string) => Promise<{ count?: unknown } | null | undefined>
  confirm: (message: string) => boolean
  isZh: boolean
}

/** true = go ahead (no dependents, the count could not be read, or the person confirmed); false = the person cancelled. */
export async function confirmManualRowParentDependents(check: ManualRowParentDependentsCheck): Promise<boolean> {
  if (check.recordIds.length === 0) return true
  const answers = await Promise.allSettled(check.recordIds.map((recordId) => check.count(recordId)))
  let total = 0
  for (const answer of answers) {
    if (answer.status !== 'fulfilled') continue
    const count = answer.value?.count
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) total += Math.trunc(count)
  }
  if (total === 0) return true
  return check.confirm(manualRowParentDependentsConfirmText(total, check.isZh))
}
