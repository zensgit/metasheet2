/**
 * FWB-1 slice ③ — `write_approval_form_values` executor: gates → mapping → SAME-TRANSACTION
 * claim + record + revision + outbox (#4203 §3 D9/D10).
 *
 * Composition (all inside the CALLER-provided transaction client):
 *   1. §11 Q6 four-gate execute-time recheck — any gate down → 'rejected' (PERMANENT; the action must
 *      never run on revoked authority);
 *   2. fail-closed all-or-nothing value mapping — any mapping error → 'rejected' (PERMANENT; config bug);
 *   3. Class-A business claim (`claimActionApplied`) — 'duplicate' → 'already_applied' (net-once: a prior
 *      apply won; skip the write, report success upstream);
 *   4. the record write (injected seam — the real record-service call at final wiring; MUST create the
 *      record AND its revision on the SAME trx) + `produceAutomationEvent` on the SAME trx (durable
 *      downstream fan-out commits or rolls back WITH the claim and the record).
 *
 * Any throw from the seam propagates and aborts the caller's transaction — claim, record, revision and
 * outbox rows all vanish together (proven in the real-DB spec). NO production caller yet; the dispatchAction
 * wiring lands with the FWB activation slice behind its own gate.
 */
import type { Queryable } from './automation-durable-dispatcher'
import { claimActionApplied } from './automation-action-idempotency'
import { mapApprovalFormValues, type FwbFieldMapping } from './approval-form-value-mapping'
import { recheckFwbPermissionGates, type FwbGateChecks, type FwbGateId, type FwbGateSubject } from './approval-fwb-permission-gates'

export interface FwbWriteActionInput {
  /** idempotency identity (ledger): */
  claimId: string
  instanceId: string
  ruleId: string
  actionKey: string
  applicationMode?: 'apply' | 'test_run'
  /** permission subject (§11 Q6): */
  gateSubject: FwbGateSubject
  /** mapping config + submitted form values: */
  mappings: readonly FwbFieldMapping[]
  formValues: Readonly<Record<string, unknown>>
  /** durable event identity for the outbox row (stable original event id): */
  eventId: string
  automationDepth?: number
}

export interface FwbRecordWriteSeam {
  /** Create the record + its revision on the SAME trx; returns the new record id (identifier only). */
  createRecordWithRevision(trx: Queryable, targetSheetId: string, values: Record<string, string | number>): Promise<string>
  /** Durable outbox enqueue on the SAME trx (final wiring passes produceAutomationEvent; flag-gated there). */
  enqueueOutbox(trx: Queryable, event: { eventType: string; eventId: string; payload: unknown; automationDepth: number }): Promise<void>
}

export type FwbWriteActionResult =
  | { status: 'applied'; recordId: string }
  | { status: 'already_applied' }
  | { status: 'rejected'; reason: 'permission_gates' | 'mapping'; failedGates?: FwbGateId[] }

/** Execute the write action INSIDE the caller's transaction. See module doc for the four-step contract. */
export async function executeWriteApprovalFormValues(
  trx: Queryable,
  input: FwbWriteActionInput,
  gates: FwbGateChecks,
  seam: FwbRecordWriteSeam,
): Promise<FwbWriteActionResult> {
  const gate = (await recheckFwbPermissionGates(gates, input.gateSubject)) as { ok: boolean; failed?: FwbGateId[] }
  if (!gate.ok) return { status: 'rejected', reason: 'permission_gates', failedGates: gate.failed ?? [] }

  const mapped = mapApprovalFormValues(input.mappings, input.formValues)
  if (!mapped.ok) return { status: 'rejected', reason: 'mapping' }

  const claim = await claimActionApplied(trx, {
    id: input.claimId,
    instanceId: input.instanceId,
    ruleId: input.ruleId,
    actionKey: input.actionKey,
    applicationMode: input.applicationMode ?? 'apply',
  })
  if (claim === 'duplicate') return { status: 'already_applied' }

  const recordId = await seam.createRecordWithRevision(trx, input.gateSubject.targetSheetId, mapped.values)
  // durable downstream fan-out, SAME trx (the injected enqueue is flag-gated at final wiring).
  await seam.enqueueOutbox(trx, {
    eventType: 'multitable.record.created',
    eventId: input.eventId,
    payload: { recordId, sheetId: input.gateSubject.targetSheetId },
    automationDepth: input.automationDepth ?? 0,
  })
  return { status: 'applied', recordId }
}
