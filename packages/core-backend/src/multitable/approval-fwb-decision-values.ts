/**
 * FWB-3 — approver-decided values: freeze inside the dispatchAction lock transaction, write back by
 * (node_key, entry_epoch) identity (#4203 §2.3 FWB-3 key + §6 epoch semantics).
 *
 *   - `freezeDecisionValues` captures the approver's decision-field values AT DECISION TIME into an
 *     immutable snapshot keyed (node_key, entry_epoch). It is called INSIDE the dispatchAction lock
 *     transaction — the same lock that serializes the node's decision — so the frozen snapshot can never
 *     race the decision it snapshots. Unknown fields (not declared for the node) are REJECTED fail-closed
 *     (an approver cannot smuggle arbitrary fields into the writeback), and a re-entered node (new
 *     entry_epoch) freezes a NEW snapshot — an old epoch's values are NEVER reused (§6).
 *   - `executeWriteDecisionValues` writes a frozen snapshot to the bound record with the FWB-3 idempotency
 *     key (instance, rule, action, node_key, entry_epoch) — the ledger's real node-scope columns — reusing
 *     the FWB-2 bound-record recheck + same-transaction UPDATE + outbox composition.
 *
 * Injected seams as in FWB-1/2; no production caller until the FWB activation slice.
 */
import type { Queryable } from './automation-durable-dispatcher'
import type { TransactionalQueryable } from './pg-transaction-guard'
import { claimActionApplied } from './automation-action-idempotency'
import { mapApprovalFormValues, type FwbFieldMapping } from './approval-form-value-mapping'
import { recheckFwbPermissionGates, type FwbGateChecks, type FwbGateId, type FwbGateSubject } from './approval-fwb-permission-gates'
import { recheckBoundRecordAtExecute, type FwbUpdateSeam, type RecordLinkChecks, type RecordLinkRejectCode } from './approval-fwb-record-link'

export interface FrozenDecisionSnapshot {
  nodeKey: string
  entryEpoch: number
  /** decision-field values captured at decision time (closed set of declared fields only). */
  values: Readonly<Record<string, unknown>>
  frozenAt: string
}

export type FreezeResult =
  | { ok: true; snapshot: FrozenDecisionSnapshot }
  | { ok: false; code: 'node_key_blank' | 'entry_epoch_invalid' | 'undeclared_field' | 'no_declared_fields' }

/**
 * Freeze the decision values. `declaredFieldIds` is the node's CLOSED field set; any submitted field
 * outside it rejects the whole freeze (fail-closed). Call inside the dispatchAction lock transaction.
 */
export function freezeDecisionValues(
  nodeKey: string,
  entryEpoch: number,
  declaredFieldIds: readonly string[],
  decisionData: Readonly<Record<string, unknown>>,
  now: () => Date = () => new Date(),
): FreezeResult {
  if (typeof nodeKey !== 'string' || !/[!-~]/.test(nodeKey)) return { ok: false, code: 'node_key_blank' }
  if (!Number.isSafeInteger(entryEpoch) || entryEpoch < 1) return { ok: false, code: 'entry_epoch_invalid' } // real node scope starts at 1
  if (!declaredFieldIds || declaredFieldIds.length === 0) return { ok: false, code: 'no_declared_fields' }
  const declared = new Set(declaredFieldIds)
  for (const k of Object.keys(decisionData)) {
    if (!declared.has(k)) return { ok: false, code: 'undeclared_field' }
  }
  const values = Object.freeze({ ...decisionData })
  return { ok: true, snapshot: Object.freeze({ nodeKey, entryEpoch, values, frozenAt: now().toISOString() }) }
}

export interface FwbDecisionWriteInput {
  claimId: string
  instanceId: string
  ruleId: string
  actionKey: string
  gateSubject: FwbGateSubject
  boundRecordId: string
  snapshot: FrozenDecisionSnapshot
  mappings: readonly FwbFieldMapping[]
  eventId: string
  automationDepth?: number
}

export type FwbDecisionWriteResult =
  | { status: 'applied' }
  | { status: 'already_applied' }
  | { status: 'rejected'; reason: 'permission_gates' | 'mapping' | RecordLinkRejectCode; failedGates?: FwbGateId[] }

/** FWB-3 executor: gates → bound-record recheck → map the FROZEN snapshot → node-scoped claim → UPDATE + outbox. */
export async function executeWriteDecisionValues(
  trx: TransactionalQueryable, // brand=compile-time doc; real enforcement = claimActionApplied's xid probe (#4336/#4340 hardening)
  input: FwbDecisionWriteInput,
  gates: FwbGateChecks,
  linkChecks: RecordLinkChecks,
  seam: FwbUpdateSeam,
): Promise<FwbDecisionWriteResult> {
  const gate = (await recheckFwbPermissionGates(gates, input.gateSubject)) as { ok: boolean; failed?: FwbGateId[] }
  if (!gate.ok) return { status: 'rejected', reason: 'permission_gates', failedGates: gate.failed ?? [] }

  const bound = await recheckBoundRecordAtExecute(trx, linkChecks, input.gateSubject.configurerUserId, input.gateSubject.targetSheetId, input.boundRecordId)
  if (!bound.ok) return { status: 'rejected', reason: (bound as { code: RecordLinkRejectCode }).code }

  const mapped = mapApprovalFormValues(input.mappings, input.snapshot.values)
  if (!mapped.ok) return { status: 'rejected', reason: 'mapping' }

  // node-scoped FWB-3 idempotency key: (instance, rule, action, node_key, entry_epoch) — a re-entered node
  // (new epoch) claims independently; the same epoch never double-writes.
  const claim = await claimActionApplied(trx, {
    id: input.claimId,
    instanceId: input.instanceId,
    ruleId: input.ruleId,
    actionKey: input.actionKey,
    nodeKey: input.snapshot.nodeKey,
    entryEpoch: input.snapshot.entryEpoch,
  })
  if (claim === 'duplicate') return { status: 'already_applied' }

  await seam.updateRecordWithRevision(trx, input.gateSubject.targetSheetId, input.boundRecordId, mapped.values)
  await seam.enqueueOutbox(trx, {
    eventType: 'multitable.record.updated',
    eventId: input.eventId,
    payload: { recordId: input.boundRecordId, sheetId: input.gateSubject.targetSheetId, nodeKey: input.snapshot.nodeKey, entryEpoch: input.snapshot.entryEpoch },
    automationDepth: input.automationDepth ?? 0,
  })
  return { status: 'applied' }
}
