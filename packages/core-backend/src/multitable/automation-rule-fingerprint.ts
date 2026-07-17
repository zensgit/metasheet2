/**
 * #4196 §2.1 / §4 — the RULE action-set fingerprint over the FULL action identity.
 *
 * The suspend/resume + bridge guards use `computeActionFingerprint` (automation-suspension-service.ts), which
 * per §2.1 hashes ONLY the sequence of action TYPES — it cannot see a config-only edit (same types, changed
 * config), which is exactly the "rule changed" a retry must refuse (§4). This module derives a fingerprint
 * over the SAME injective identity the applied-ledger locks for `action_key` — `deriveActionKey({
 * structuralPath, actionType, canonicalConfig })` — so a config edit, a type swap in place, an action
 * reorder, or a branch-key change all change the fingerprint.
 *
 * `enumerateRuleActions` assigns every action (top-level AND nested inside a `parallel_branch` /
 * `condition_branch`) the EXACT step-key the executor stamps, via the shared `automation-step-key` builder —
 * `${i}` / `${i}.parallel.${branchKey}.${j}` / `${i}.branch.${branchKey}.${j}`. The retry guard AND the
 * future Class-A claim consume THIS walk, so the identities they compare are the executor's own identities,
 * never a divergent index-based path (#4420 review P1). Config is passed RAW to `deriveActionKey` (which
 * canonicalizes internally) so the enumerator's key is byte-identical to a direct `deriveActionKey` call
 * on the same action — i.e. the fingerprint really shares the applied-ledger identity (#4420 review P2).
 */
import { createHash } from 'node:crypto'

import { deriveActionKey } from './automation-action-idempotency'
import { branchChildStepKey, topLevelStepKey, type BranchKind } from './automation-step-key'

interface RuleAction {
  type: string
  config?: unknown
}

interface Branch {
  key?: unknown
  actions?: ReadonlyArray<RuleAction>
}

export interface RuleActionFingerprint {
  /** total actions counted, including nested — a count mismatch alone is a change */
  count: number
  /** sha256 over the sorted set of per-action §2.1 identities */
  hash: string
}

const MAX_NESTING_DEPTH = 8 // guard a pathological/cyclic config; real rules nest a couple deep at most

/** The `.parallel.` vs `.branch.` segment is chosen by the PARENT action's type (matches the executor). */
function branchKindForParent(parentType: string): BranchKind | null {
  if (parentType === 'parallel_branch') return 'parallel'
  if (parentType === 'condition_branch') return 'branch'
  return null
}

/**
 * Yield every action in the rule with its canonical executor step-key. Deterministic order: top-level index,
 * then branch order, then nested action index. A branch's identity is its stable `key` (NOT its array index),
 * so reordering branches does not move a child's identity.
 */
export function* enumerateRuleActions(
  actions: ReadonlyArray<RuleAction> | undefined,
): Generator<{ action: RuleAction; structuralPath: string }> {
  if (!Array.isArray(actions)) return
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]
    if (!action || typeof action.type !== 'string') continue
    yield { action, structuralPath: topLevelStepKey(i) }
    const kind = branchKindForParent(action.type)
    if (!kind) continue
    const config = action.config
    const branches = config && typeof config === 'object' ? (config as { branches?: unknown }).branches : undefined
    if (!Array.isArray(branches)) continue
    for (const branch of branches as Branch[]) {
      const branchKey = typeof branch?.key === 'string' ? branch.key : ''
      yield* enumerateBranchActions(branch?.actions, i, kind, branchKey, 1)
    }
  }
}

function* enumerateBranchActions(
  actions: ReadonlyArray<RuleAction> | undefined,
  parentStepIndex: number,
  kind: BranchKind,
  branchKey: string,
  depth: number,
): Generator<{ action: RuleAction; structuralPath: string }> {
  if (!Array.isArray(actions) || depth > MAX_NESTING_DEPTH) return
  for (let j = 0; j < actions.length; j++) {
    const action = actions[j]
    if (!action || typeof action.type !== 'string') continue
    yield { action, structuralPath: branchChildStepKey(parentStepIndex, kind, branchKey, j) }
  }
}

/**
 * Fingerprint the rule's action set over the §2.1 identity. Two rules with the same fingerprint have the same
 * actions at the same structural step-keys with the same types AND the same config; ANY difference
 * (config-only, type swap, reorder, add/remove, branch-key change) changes it.
 */
export function deriveRuleActionSetFingerprint(actions: ReadonlyArray<RuleAction> | undefined): RuleActionFingerprint {
  const keys: string[] = []
  for (const { action, structuralPath } of enumerateRuleActions(actions)) {
    // RAW config — deriveActionKey canonicalizes internally; passing pre-canonicalized text would double-apply
    // it and diverge from the applied-ledger key (#4420 review P2).
    keys.push(deriveActionKey({ structuralPath, actionType: action.type, canonicalConfig: action.config ?? {} }))
  }
  keys.sort()
  const hash = createHash('sha256').update(JSON.stringify(keys)).digest('hex')
  return { count: keys.length, hash }
}
