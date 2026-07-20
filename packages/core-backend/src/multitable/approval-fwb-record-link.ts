/**
 * record-link + FWB-2 — bound-record rechecks and the UPDATE-instead-of-CREATE executor.
 *
 * A record-link form field binds an approval to an EXISTING record. Two check moments (lock ruling):
 *   - SUBMIT time: the FILLER must be able to READ the record they are linking (no blind-linking probes —
 *     rejecting unreadable ids also prevents an existence oracle: same code for missing and unreadable).
 *   - EXECUTE time: re-verify the record still EXISTS, is NOT LOCKED, and the rule's CONFIGURER can WRITE
 *     it (the £11 Q6 authority carries; a record locked/deleted/permission-revoked since submission must
 *     fail CLOSED as a permanent rejection, never a partial write).
 *
 * `executeUpdateBoundRecord` composes exactly like FWB-1's executor (gates → mapping → claim → seam) but
 * UPDATES the bound record + bumps its revision instead of creating one; same-transaction with the ledger
 * claim and the outbox row. Checks and writes are injected seams; no production caller yet.
 */
import type { Queryable } from './automation-durable-dispatcher'
import type { TransactionalQueryable } from './pg-transaction-guard'
import { claimActionApplied } from './automation-action-idempotency'
import { mapApprovalFormValues, type FwbFieldMapping } from './approval-form-value-mapping'
import { recheckFwbPermissionGates, type FwbGateChecks, type FwbGateId, type FwbGateSubject } from './approval-fwb-permission-gates'

export interface RecordLinkChecks {
  /** submit-time: can the FILLER read the record? MUST return false for a nonexistent record too. */
  fillerCanReadRecord(fillerUserId: string, sheetId: string, recordId: string): Promise<boolean>
  /** execute-time trio: */
  recordExists(trx: Queryable, sheetId: string, recordId: string): Promise<boolean>
  recordIsLocked(trx: Queryable, sheetId: string, recordId: string): Promise<boolean>
  configurerCanWriteRecord(configurerUserId: string, sheetId: string, recordId: string): Promise<boolean>
}

export type RecordLinkRejectCode = 'link_not_readable' | 'record_missing' | 'record_locked' | 'record_not_writable'

/** Submit-time validation: one uniform rejection for missing AND unreadable (no existence oracle). */
export async function validateRecordLinkAtSubmit(
  checks: Pick<RecordLinkChecks, 'fillerCanReadRecord'>,
  fillerUserId: string,
  sheetId: string,
  recordId: string,
): Promise<{ ok: true } | { ok: false; code: 'link_not_readable' }> {
  let readable = false
  try {
    readable = await checks.fillerCanReadRecord(fillerUserId, sheetId, recordId)
  } catch {
    readable = false // fail-closed
  }
  return readable ? { ok: true } : { ok: false, code: 'link_not_readable' }
}

/** Execute-time recheck: exists → not locked → configurer-writable, each fail-closed on error. */
export async function recheckBoundRecordAtExecute(
  trx: Queryable,
  checks: RecordLinkChecks,
  configurerUserId: string,
  sheetId: string,
  recordId: string,
): Promise<{ ok: true } | { ok: false; code: RecordLinkRejectCode }> {
  const safe = async (p: Promise<boolean>, fallback: boolean): Promise<boolean> => {
    try {
      return await p
    } catch {
      return fallback
    }
  }
  if (!(await safe(checks.recordExists(trx, sheetId, recordId), false))) return { ok: false, code: 'record_missing' }
  if (await safe(checks.recordIsLocked(trx, sheetId, recordId), true)) return { ok: false, code: 'record_locked' } // error ⇒ treat as locked
  if (!(await safe(checks.configurerCanWriteRecord(configurerUserId, sheetId, recordId), false))) {
    return { ok: false, code: 'record_not_writable' }
  }
  return { ok: true }
}

export interface FwbUpdateSeam {
  /** UPDATE the bound record's mapped fields + bump its revision on the SAME trx. */
  updateRecordWithRevision(trx: Queryable, sheetId: string, recordId: string, values: Record<string, string | number>): Promise<void>
  enqueueOutbox(trx: Queryable, event: { eventType: string; eventId: string; payload: unknown; automationDepth: number }): Promise<void>
}

export interface FwbUpdateActionInput {
  claimId: string
  instanceId: string
  ruleId: string
  actionKey: string
  gateSubject: FwbGateSubject
  boundRecordId: string
  mappings: readonly FwbFieldMapping[]
  formValues: Readonly<Record<string, unknown>>
  eventId: string
  automationDepth?: number
}

export type FwbUpdateActionResult =
  | { status: 'applied' }
  | { status: 'already_applied' }
  | { status: 'rejected'; reason: 'permission_gates' | 'mapping' | RecordLinkRejectCode; failedGates?: FwbGateId[] }

/** FWB-2 executor: gates → bound-record recheck → mapping → same-txn claim + UPDATE + revision + outbox. */
export async function executeUpdateBoundRecord(
  trx: TransactionalQueryable, // brand=compile-time doc; real enforcement = claimActionApplied's xid probe (#4336/#4340 hardening)
  input: FwbUpdateActionInput,
  gates: FwbGateChecks,
  linkChecks: RecordLinkChecks,
  seam: FwbUpdateSeam,
): Promise<FwbUpdateActionResult> {
  const gate = (await recheckFwbPermissionGates(gates, input.gateSubject)) as { ok: boolean; failed?: FwbGateId[] }
  if (!gate.ok) return { status: 'rejected', reason: 'permission_gates', failedGates: gate.failed ?? [] }

  const bound = await recheckBoundRecordAtExecute(trx, linkChecks, input.gateSubject.configurerUserId, input.gateSubject.targetSheetId, input.boundRecordId)
  if (!bound.ok) return { status: 'rejected', reason: (bound as { code: RecordLinkRejectCode }).code }

  const mapped = mapApprovalFormValues(input.mappings, input.formValues)
  if (!mapped.ok) return { status: 'rejected', reason: 'mapping' }

  const claim = await claimActionApplied(trx, {
    id: input.claimId,
    instanceId: input.instanceId,
    ruleId: input.ruleId,
    actionKey: input.actionKey,
  })
  if (claim === 'duplicate') return { status: 'already_applied' }

  await seam.updateRecordWithRevision(trx, input.gateSubject.targetSheetId, input.boundRecordId, mapped.values)
  await seam.enqueueOutbox(trx, {
    eventType: 'multitable.record.updated',
    eventId: input.eventId,
    payload: { recordId: input.boundRecordId, sheetId: input.gateSubject.targetSheetId },
    automationDepth: input.automationDepth ?? 0,
  })
  return { status: 'applied' }
}
