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
  configurerCanWriteRecord(
    trx: Queryable,
    configurerUserId: string,
    sheetId: string,
    recordId: string,
  ): Promise<boolean>
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

/**
 * Ordered helper steps for the full record-link submit authz pipeline.
 * Missing / base-mismatch / unreadable / row-denied MUST share this order so public
 * bodies AND query/helper transcripts cannot form an existence oracle.
 *
 * Create-txn final recheck (when multi-target create path is used):
 *   Globally phased locks for ALL candidates first (see
 *   lockRecordLinkMultiTargetCreatePathOnQuery):
 *     1) all target meta_bases (sorted)
 *     2) all target meta_sheets (sorted)
 *     3) actor-wide authority rows once (user_roles → … → groups)
 *     4) spreadsheet_permissions for all target sheets (sorted)
 *     5) row-auth advisory + meta_records FOR UPDATE per target (canonical order)
 *   Then re-read membership / base / sheet / row auth for every candidate under those locks
 *   (this probe's per-link steps; lock hooks no-op when pre-locked by the multi-target helper).
 * Concurrent DELETE/INSERT on locked sources either blocks or is observed as empty.
 * Final write gate is txn-local DB/admin only. Never authorize from a pre-lock snapshot alone.
 *
 * Multi-link: sorting alone does NOT fix unequal overlapping sets ([A,B] vs [B] same actor
 * deadlocks when authority is interleaved per candidate). Global phases close that cycle.
 * Candidate sort still keeps re-read / row-auth order deterministic.
 */
export const RECORD_LINK_SUBMIT_AUTH_STEPS = [
  'lock_authority',
  'lock_row_auth',
  'sheet_membership',
  'record_exists',
  'base_readable',
  'sheet_capabilities',
  'row_deny_strict',
] as const

/**
 * Canonical multi-link lock order for final create recheck.
 * Sort key: baseId → sheetId → recordId → fieldId → stable original index.
 * Shape-invalid candidates use their placeholder ids and still sort deterministically
 * (they take no real locks when shapeOk is false, but keep pipeline order uniform).
 */
export function sortRecordLinkSubmitCandidates<
  T extends { baseId: string; sheetId: string; recordId: string; fieldId: string },
>(links: readonly T[]): T[] {
  return links
    .map((link, index) => ({ link, index }))
    .sort((a, b) => {
      if (a.link.baseId !== b.link.baseId) {
        return a.link.baseId < b.link.baseId ? -1 : 1
      }
      if (a.link.sheetId !== b.link.sheetId) {
        return a.link.sheetId < b.link.sheetId ? -1 : 1
      }
      if (a.link.recordId !== b.link.recordId) {
        return a.link.recordId < b.link.recordId ? -1 : 1
      }
      if (a.link.fieldId !== b.link.fieldId) {
        return a.link.fieldId < b.link.fieldId ? -1 : 1
      }
      return a.index - b.index
    })
    .map(({ link }) => link)
}

export type RecordLinkSubmitAuthStep = (typeof RECORD_LINK_SUBMIT_AUTH_STEPS)[number]

export type RecordLinkSubmitAuthDeps = {
  sheetBelongsToBase: (sheetId: string, baseId: string) => Promise<boolean>
  /**
   * Optional: lock every authority source consumed by the subsequent auth re-read
   * (create final path). Signature includes baseId so meta_bases can be locked.
   */
  lockAuthorityRows?: (userId: string, sheetId: string, baseId: string) => Promise<void>
  /**
   * Optional: canonical sheet+record row-auth advisory lock (create final path).
   * Shared with record_permissions PUT/DELETE writers.
   */
  lockRowAuth?: (sheetId: string, recordId: string) => Promise<void>
  baseReadable: (userId: string, baseId: string) => Promise<boolean>
  resolveSheetCapabilities: (
    sheetId: string,
    userId: string,
  ) => Promise<{ isAdminRole: boolean; capabilities: { canRead: boolean } }>
  isRecordReadDeniedStrict: (
    sheetId: string,
    recordId: string,
    userId: string,
  ) => Promise<boolean>
  /**
   * Existence (and optional FOR UPDATE lock) on the pinned sheet.
   * Final create-path recheck locks the row on the transaction client after authority locks.
   */
  recordExistsOnSheet: (sheetId: string, recordId: string) => Promise<boolean>
}

/**
 * Constant-shape submit authz for one linked record.
 *
 * Always executes every step in `RECORD_LINK_SUBMIT_AUTH_STEPS` order (no early
 * return that skips later helpers). Result is the AND of all gates; any throw
 * fails closed. When `transcript` is provided, each step name is appended in
 * order for parity tests across missing / mismatch / unreadable / denied.
 */
export async function probeRecordLinkSubmitAuthConstantShape(
  deps: RecordLinkSubmitAuthDeps,
  input: {
    userId: string
    baseId: string
    sheetId: string
    recordId: string
  },
  transcript?: string[],
): Promise<boolean> {
  const push = (step: RecordLinkSubmitAuthStep) => {
    transcript?.push(step)
  }
  try {
    // Locks first so membership / base / sheet / row re-reads observe a consistent locked set.
    // Membership MUST NOT be trusted from a pre-lock read (meta_sheets.base_id can mutate).
    push('lock_authority')
    if (deps.lockAuthorityRows) {
      await deps.lockAuthorityRows(input.userId, input.sheetId, input.baseId)
    }

    // Serialize concurrent record_permissions deny INSERT/DELETE (phantom-safe advisory).
    push('lock_row_auth')
    if (deps.lockRowAuth) {
      await deps.lockRowAuth(input.sheetId, input.recordId)
    }

    // Membership under lock (meta_sheets already FOR SHARE when lockAuthorityRows ran).
    push('sheet_membership')
    const membershipOk = await deps.sheetBelongsToBase(input.sheetId, input.baseId)

    // Lock / existence (create final recheck uses FOR UPDATE here).
    push('record_exists')
    const exists = await deps.recordExistsOnSheet(input.sheetId, input.recordId)

    push('base_readable')
    const baseOk = await deps.baseReadable(input.userId, input.baseId)

    push('sheet_capabilities')
    const { capabilities, isAdminRole } = await deps.resolveSheetCapabilities(
      input.sheetId,
      input.userId,
    )
    const sheetOk = isAdminRole || capabilities.canRead === true

    push('row_deny_strict')
    let denied = false
    if (!isAdminRole) {
      denied = await deps.isRecordReadDeniedStrict(
        input.sheetId,
        input.recordId,
        input.userId,
      )
    }

    return Boolean(membershipOk && exists && baseOk && sheetOk && !denied)
  } catch {
    // Ensure a partial transcript still ends at a fixed length when a later step throws:
    // callers that compare ordered steps across outcomes should push remaining steps only
    // on the happy path of the try; on throw we leave the transcript as-is (fail-closed).
    return false
  }
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
  if (!(await safe(checks.configurerCanWriteRecord(trx, configurerUserId, sheetId, recordId), false))) {
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
