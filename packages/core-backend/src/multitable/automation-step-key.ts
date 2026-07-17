/**
 * #4196 — the SINGLE source of truth for an action's structural step-key (its `structuralPath` identity).
 *
 * The executor already stamps every action with a `stepKey` for its C1 job / step provenance:
 *   - a top-level action at index i:                    `${i}`                         (e.g. "0")
 *   - a `parallel_branch` child (branch KEY k, index j): `${i}.parallel.${k}.${j}`
 *   - a `condition_branch` child (branch KEY k, index j): `${i}.branch.${k}.${j}`
 *
 * The retry rule-change fingerprint (§4) AND the future Class-A applied-ledger claim (§2) BOTH key on this
 * exact identity — so it MUST NOT be re-invented per-consumer (a fingerprint that used branch ARRAY INDEX
 * instead of branch KEY would diverge from the executor's identity, and a branch reorder would then falsely
 * read as "rule changed" while a same-index-different-key swap would falsely read as "same" — #4420 review
 * P1). This module is that one builder; the executor and the fingerprint both call it.
 *
 * The branch KEY (not the array position) is deliberate: a branch is identified by its stable `key`, so
 * reordering branches does NOT change a child's identity, and two branches sharing a child index are still
 * distinct.
 */
export type BranchKind = 'parallel' | 'branch'

/** A top-level action's step-key: just its index. */
export function topLevelStepKey(stepIndex: number): string {
  return String(stepIndex)
}

/** A branch child's step-key: `${parentStepIndex}.${kind}.${branchKey}.${actionIndex}` (kind = parallel | branch). */
export function branchChildStepKey(parentStepIndex: number, kind: BranchKind, branchKey: string, actionIndex: number): string {
  return `${parentStepIndex}.${kind}.${branchKey}.${actionIndex}`
}
