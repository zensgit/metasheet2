import type { ApprovalAddSignAggregation } from '../types/approval-product'
import { isApprovalAddSignAggregation } from '../types/approval-product'

/**
 * Lock-5 L5-B / OD-L5-4(b) — the appended (后加签) round's aggregation carrier.
 * Source: `docs/development/approval-lock5-node-operation-policy-20260817.md` §0.1 (the `add_sign`
 * row), OD-L5-4(b), OD-L5-5(a), gates B-3/B-5; execution ledger row "OD-L5-4(b) — four enumerated
 * completions", owner disposition (1) 2026-10-01.
 *
 * ### What is persisted, and why HERE
 *
 * An after-sign consumes the actor's seat as an approval and activates the addees as a FRESH
 * `nodeEntryEpoch` round at the SAME node. That round is governed by the action-time
 * `addSignAggregation` (`all` | `any`), NOT by the node's authored `approvalMode` — a single addee
 * could never satisfy an authored `threshold` of two, and an authored `sequential` queue has no
 * shape for the addees at all. So the aggregation must outlive the add-sign request, and the
 * approve path must find it WITHOUT an extra read.
 *
 * It lives in `approval_instances.metadata.addSignAppendedRound`, keyed by `{ nodeKey, entryEpoch }`:
 *   - the instance row is already loaded (FOR UPDATE) by every dispatch, so reading it costs no
 *     query — the same reason `parallelBranchStates` lives there;
 *   - keying on the EPOCH (not on seat rows) makes the carrier immune to every same-round seat
 *     mutation that rewrites assignment metadata (transfer, timeout transfer, bulk reassign,
 *     departure transfer, in-round parallel add-sign) — none of those can drop the aggregation;
 *   - a stale entry is harmless by construction: a later activation of the node (return, jump)
 *     mints a different epoch and the entry no longer matches, so the node's authored mode applies
 *     again. Nothing needs to clear it.
 *
 * The `add_sign` audit row carries the same triple (`addSignMode:'after'`, `appendedNodeEntryEpoch`,
 * `addSignAggregation`) so the state is reconstructible from audit rows alone.
 */
export const ADD_SIGN_APPENDED_ROUND_METADATA_KEY = 'addSignAppendedRound'

export interface AddSignAppendedRound {
  nodeKey: string
  entryEpoch: number
  aggregation: ApprovalAddSignAggregation
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Serialisable shape written by the after-sign transaction (jsonb `||` merge, never a full rewrite). */
export function buildAddSignAppendedRoundMetadata(round: AddSignAppendedRound): Record<string, unknown> {
  return { nodeKey: round.nodeKey, entryEpoch: round.entryEpoch, aggregation: round.aggregation }
}

/**
 * The appended round governing `nodeKey` at `currentEpoch`, or `null` when the current round is an
 * ordinary activation. Strict on every field: a malformed entry (hand-edited, or a future shape)
 * resolves to `null` — the node's authored mode — rather than to a guessed aggregation.
 */
export function readAddSignAppendedRound(
  instanceMetadata: unknown,
  nodeKey: string | null | undefined,
  currentEpoch: number | null | undefined,
): AddSignAppendedRound | null {
  if (!nodeKey || currentEpoch === null || currentEpoch === undefined || !Number.isInteger(currentEpoch)) return null
  if (!isRecord(instanceMetadata)) return null
  const raw = instanceMetadata[ADD_SIGN_APPENDED_ROUND_METADATA_KEY]
  if (!isRecord(raw)) return null
  const rawEpoch = raw.entryEpoch
  const entryEpoch = typeof rawEpoch === 'number' && Number.isInteger(rawEpoch)
    ? rawEpoch
    : typeof rawEpoch === 'string' && /^\d+$/.test(rawEpoch)
      ? Number.parseInt(rawEpoch, 10)
      : null
  if (entryEpoch === null || entryEpoch !== currentEpoch) return null
  if (raw.nodeKey !== nodeKey) return null
  if (!isApprovalAddSignAggregation(raw.aggregation)) return null
  return { nodeKey, entryEpoch, aggregation: raw.aggregation }
}
