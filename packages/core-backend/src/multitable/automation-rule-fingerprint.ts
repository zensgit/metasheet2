/**
 * #4196 §2.1 / §4 — the RULE action-set fingerprint over the FULL action identity.
 *
 * The suspend/resume + bridge guards use `computeActionFingerprint` (automation-suspension-service.ts), which
 * per §2.1 hashes ONLY the sequence of action TYPES — it cannot see a config-only edit (same types, changed
 * config), which is exactly the "rule changed" a retry must refuse (§4). This module derives a fingerprint
 * over the SAME injective identity the applied-ledger locks for `action_key` — `{ structuralPath, action.type,
 * canonicalConfig }` (`deriveActionKey`) — so a config edit, a type swap in place, or an action reorder all
 * change the fingerprint.
 *
 * `enumerateRuleActions` is the SHARED canonical walk: it assigns every action (top-level AND nested inside a
 * `parallel_branch` / `condition_branch`, both of which nest via `config.branches[].actions[]`) a stable
 * structural path. The retry rule-change guard AND the future Class-A claim wiring both consume THIS walk, so
 * the structural paths they compare can never drift apart — the exact path string is an internal detail as
 * long as it is injective and position-sensitive, which this scheme is.
 */
import { createHash } from 'node:crypto'

import { canonicalizeConfig, deriveActionKey } from './automation-action-idempotency'

interface RuleAction {
  type: string
  config?: unknown
}

export interface RuleActionFingerprint {
  /** total actions counted, including nested — a count mismatch alone is a change */
  count: number
  /** sha256 over the sorted set of per-action §2.1 identities */
  hash: string
}

const MAX_NESTING_DEPTH = 8 // guard against a pathological/cyclic config; real rules nest at most a couple deep

/**
 * Yield every action in the rule with its canonical structural path, recursing into `config.branches[].actions[]`
 * (the shared nesting shape of parallel_branch and condition_branch). Deterministic order: top-level index, then
 * branch index, then nested action index.
 */
export function* enumerateRuleActions(
  actions: ReadonlyArray<RuleAction> | undefined,
  prefix = 'actions',
  depth = 0,
): Generator<{ action: RuleAction; structuralPath: string }> {
  if (!Array.isArray(actions) || depth > MAX_NESTING_DEPTH) return
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]
    if (!action || typeof action.type !== 'string') continue
    const structuralPath = `${prefix}[${i}]`
    yield { action, structuralPath }
    const config = action.config
    const branches = config && typeof config === 'object' ? (config as { branches?: unknown }).branches : undefined
    if (Array.isArray(branches)) {
      for (let b = 0; b < branches.length; b++) {
        const branch = branches[b] as { actions?: ReadonlyArray<RuleAction> } | undefined
        yield* enumerateRuleActions(branch?.actions, `${structuralPath}.branches[${b}].actions`, depth + 1)
      }
    }
  }
}

/**
 * Fingerprint the rule's action set over the §2.1 identity. Two rules with the same fingerprint have the same
 * actions at the same structural positions with the same types AND the same canonical config; ANY difference
 * (config-only, type swap, reorder, add/remove, nested-branch edit) changes it.
 */
export function deriveRuleActionSetFingerprint(actions: ReadonlyArray<RuleAction> | undefined): RuleActionFingerprint {
  const keys: string[] = []
  for (const { action, structuralPath } of enumerateRuleActions(actions)) {
    keys.push(
      deriveActionKey({
        structuralPath,
        actionType: action.type,
        canonicalConfig: canonicalizeConfig(action.config ?? {}),
      }),
    )
  }
  keys.sort()
  const hash = createHash('sha256').update(JSON.stringify(keys)).digest('hex')
  return { count: keys.length, hash }
}
