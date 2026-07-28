import type { ApprovalStepDraft } from './templateAuthoring'

/**
 * C1 unified canvas — the ONE place that knows which `ApprovalStepDraft` a linear draft's canvas
 * node stands for.
 *
 * The canvas renders `buildApprovalGraph(draft)` for BOTH shapes: a preserved complex graph is
 * emitted verbatim, and a linear draft is projected into `start → approval_N* → end`. For the
 * complex shape every node already has a persisted carrier (`draft.approvalNodeEdits[nodeKey]`);
 * for the linear shape the carrier is the step itself, and the ONLY link between a canvas node and
 * that step is the key `buildApprovalGraph` assigned to it. So that key convention lives here and
 * `buildApprovalGraph` imports it — one definition, no second regex to drift from it.
 *
 * Deliberately pure and renderer-free: no coordinates, no selection/zoom, no Vue. Layout is
 * `graphLayout.computeLayout`'s job and stays out of the graph the adapter produces.
 */

/** The node key `buildApprovalGraph` gives the linear step at 0-based `index`. */
export function linearStepNodeKey(index: number): string {
  return `approval_${index + 1}`
}

/**
 * The step a linear draft's canvas node edits, or `undefined` when `nodeKey` is not a step node
 * (`start`/`end`, or a key from some other graph). Resolved by re-deriving `linearStepNodeKey` per
 * position rather than parsing the key, so the lookup can never disagree with the builder.
 *
 * Callers must only reach here for a LINEAR draft (no `preservedGraph`): once a draft is promoted,
 * `steps` is emptied and `approvalNodeEdits` is the carrier.
 */
export function linearStepForNodeKey(
  steps: ApprovalStepDraft[],
  nodeKey: string,
): ApprovalStepDraft | undefined {
  const index = steps.findIndex((_step, position) => linearStepNodeKey(position) === nodeKey)
  return index === -1 ? undefined : steps[index]
}
