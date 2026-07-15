/**
 * Action-idempotency ledger L2 — stable action_key derivation + Class-A same-transaction claim + Class-B
 * outbound semantics (#4203 §2.3 / #4196 C4). FWB write-path prerequisite; no production callers yet.
 *
 *   - `deriveActionKey({structuralPath, actionType, canonicalConfig})` — the #4196-C4 corrected TRIPLE
 *     identity. Deterministic: the config is canonicalized (deep key-sort) then sha256-hashed, so the key is
 *     stable across fence tokens, attempts, retries and process restarts — the Class-B outbound-idempotency
 *     seed. NEVER derived from fence/attempt/timestamps.
 *   - `claimActionApplied(trx, claim)` — Class-A same-DB claim: INSERT ... ON CONFLICT DO NOTHING on the
 *     composite business key, in the SAME transaction as the record write + revision + outbox row (§3 D9).
 *     Returns 'claimed' (proceed to write) or 'duplicate' (a prior apply won — skip, net-once). A zombie's
 *     duplicate write therefore collides and aborts with its transaction — natural fencing for same-DB
 *     effects, no oracle needed.
 *   - Class-B (outbound) effects CANNOT be fenced by this table: both a zombie and its reclaimer may reach
 *     the send. `deriveOutboundIdempotencyKey` binds the endpoint key to the STABLE event+action identity
 *     (never fence/attempt), so a double send carries the SAME key and the endpoint collapses it;
 *     `classifyOutboundOutcome` encodes the ratified rule: an endpoint without idempotency support and an
 *     ambiguous transport result → `outcome_unknown`, recorded, NEVER auto-resent (#4203 §340-346).
 */
import { createHash } from 'node:crypto'

import type { Queryable } from './automation-durable-dispatcher'

const NON_BLANK = /[!-~]/

/** Deep-sort object keys so hashing is insensitive to property order (arrays keep order — it is meaning). */
export function canonicalizeConfig(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return JSON.stringify(walk(value ?? null))
}

export interface ActionIdentity {
  /** structured step path of the action inside its rule (#4196 C4). */
  structuralPath: string
  actionType: string
  canonicalConfig: unknown
}

/** The stable triple-identity action key: `<structuralPath>#<actionType>#sha256(canonicalConfig)[:16]`. */
export function deriveActionKey(id: ActionIdentity): string {
  if (!NON_BLANK.test(id.structuralPath ?? '') || !NON_BLANK.test(id.actionType ?? '')) {
    throw new RangeError('deriveActionKey: structuralPath and actionType must be non-blank')
  }
  const cfgHash = createHash('sha256').update(canonicalizeConfig(id.canonicalConfig)).digest('hex').slice(0, 16)
  return `${id.structuralPath}#${id.actionType}#${cfgHash}`
}

export interface ActionClaim {
  id: string
  instanceId: string
  ruleId: string
  actionKey: string
  /** FWB-3 only; FWB-1/2 use the sentinels. */
  nodeKey?: string
  entryEpoch?: number
  applicationMode?: 'apply' | 'test_run'
  /** identifiers only (record id / revision id) — never business values. */
  resultRef?: string | null
}

/**
 * Class-A same-transaction business claim. Call on the SAME trx as the record write; 'duplicate' means a
 * prior apply already holds the key (net-once satisfied) — the caller skips its write and completes.
 */
export async function claimActionApplied(trx: Queryable, c: ActionClaim): Promise<'claimed' | 'duplicate'> {
  for (const [name, v] of [['instanceId', c.instanceId], ['ruleId', c.ruleId], ['actionKey', c.actionKey]] as const) {
    if (typeof v !== 'string' || !NON_BLANK.test(v)) throw new RangeError(`claimActionApplied: ${name} must be non-blank`)
  }
  const mode = c.applicationMode ?? 'apply'
  const res = await trx.query(
    `INSERT INTO meta_automation_action_applied (id, instance_id, rule_id, action_key, node_key, entry_epoch, application_mode, result_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (instance_id, rule_id, action_key, node_key, entry_epoch, application_mode) DO NOTHING`,
    [c.id, c.instanceId, c.ruleId, c.actionKey, c.nodeKey ?? '', c.entryEpoch ?? 0, mode, c.resultRef ?? null],
  )
  return Number(res.rowCount ?? 0) === 1 ? 'claimed' : 'duplicate'
}

/** Endpoint idempotency key = stable event+action identity. NEVER fence/attempt-derived (#4203 §340). */
export function deriveOutboundIdempotencyKey(eventId: string, actionKey: string): string {
  if (!NON_BLANK.test(eventId) || !NON_BLANK.test(actionKey)) {
    throw new RangeError('deriveOutboundIdempotencyKey: eventId and actionKey must be non-blank')
  }
  return `${eventId}::${actionKey}`
}

/**
 * Class-B outcome classification (#4203 §344): a definite transport success/failure maps through; an
 * AMBIGUOUS result (timeout/unknown) on an endpoint WITHOUT idempotency support is `outcome_unknown` —
 * recorded, never auto-resent (a resend on ambiguity is a duplicate external effect). With endpoint
 * idempotency support, a retry is safe (same key collapses), so ambiguity maps to retryable.
 */
export function classifyOutboundOutcome(
  transport: 'delivered' | 'rejected' | 'ambiguous',
  endpointSupportsIdempotency: boolean,
): 'success' | 'permanent_failure' | 'retryable_failure' | 'outcome_unknown' {
  if (transport === 'delivered') return 'success'
  if (transport === 'rejected') return 'permanent_failure'
  return endpointSupportsIdempotency ? 'retryable_failure' : 'outcome_unknown'
}
