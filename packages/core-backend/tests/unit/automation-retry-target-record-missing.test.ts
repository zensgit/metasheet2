/**
 * 客户反馈 2026-09-24 #3, final review F2 — whole-execution retry of an execution that was skipped because its
 * trigger record is gone.
 *
 * After the executor fix a `record.deleted → delete_record` rule logs ONE execution whose only step is
 * `skipped` with the values-free `output.reason = 'target_record_missing'`. `retryExecution` used to accept
 * every `skipped` execution, and the admin runs page offered 重新执行 on it; the retry replays the same stored
 * trigger event against the same record id, so it can only skip again (or, if the record was restored from the
 * recycle bin in between, act on a record the operator brought back).
 *
 * Decision: REFUSE with a stable code (409 TARGET_RECORD_MISSING_NOT_RETRYABLE), the way the other refusals that
 * are decidable from the stored row alone are answered (NOT_RETRYABLE / TEST_RUN_NOT_RETRYABLE /
 * MISSING_TRIGGER_EVENT): nothing runs, nothing is recorded, the rule is not read, the retry-ledger sweep is not
 * kicked, and the one-shot first-retry marker is not spent. Not a silent no-op success — that would put a new
 * execution row in the lineage that did nothing.
 *
 * Pinned:
 *   R1 the customer shape (one delete_record step, skipped, target_record_missing) → refused, zero side effects.
 *   R2 several steps, every one skipped with that reason → refused.
 *   R3 control: skipped, but one step skipped for ANOTHER reason → retry proceeds (that step can change).
 *   R4 control: a FAILED execution that merely contains such a step → retry proceeds (NOT_RETRYABLE never
 *      applied to failed, and its failed step can succeed on a retry).
 *   R5 control: skipped with ZERO steps (conditions not met) → retry proceeds as before.
 *   R6 the predicate itself, over malformed step outputs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EventBus } from '../../src/integration/events/event-bus'
import type { AutomationExecution, AutomationStepResult } from '../../src/multitable/automation-executor'
import { isTargetRecordMissingSkippedExecution } from '../../src/multitable/automation-retry-eligibility'
import { AutomationService } from '../../src/multitable/automation-service'

const MISSING: AutomationStepResult = {
  actionType: 'delete_record',
  status: 'skipped',
  output: { recordId: 'rec_gone', sheetId: 'sheet_1', reason: 'target_record_missing' },
}

function storedExecution(over: Partial<AutomationExecution> = {}): AutomationExecution {
  return {
    id: 'axe_orig',
    ruleId: 'atr_1',
    triggeredBy: 'event',
    triggeredAt: new Date().toISOString(),
    status: 'skipped',
    steps: [MISSING],
    triggerEvent: { sheetId: 'sheet_1', recordId: 'rec_gone', actorId: 'u1' },
    ...over,
  }
}

function currentRule() {
  return {
    id: 'atr_1', sheet_id: 'sheet_1', name: 'R', trigger_type: 'record.deleted',
    trigger_config: {}, action_type: 'send_webhook', action_config: { url: 'https://x' },
    enabled: true, actions: null, conditions: null,
  } as never
}

describe('final review F2 — retryExecution refuses an execution skipped because its trigger record is gone', () => {
  let service: AutomationService
  let queryFn: ReturnType<typeof vi.fn>
  let sweep: ReturnType<typeof vi.fn>

  beforeEach(() => {
    queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    service = new AutomationService(new EventBus(), {} as never, queryFn)
    sweep = vi.fn()
    ;(service as unknown as { kickAutomationRetryLedgerSweepIfDue: (nowMs: number) => void }).kickAutomationRetryLedgerSweepIfDue = sweep
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Arrange the collaborators an ELIGIBLE retry reaches, so a control proves the new gate let it through. */
  function armEligibleRetry() {
    // The lineage approval check reads the Kysely `db` directly; answer it here instead of mocking the module.
    const bridges = (service as unknown as { approvalBridgeService: { hasCreatedApprovalForAnyExecution: (ids: string[]) => Promise<boolean> } }).approvalBridgeService
    vi.spyOn(bridges, 'hasCreatedApprovalForAnyExecution').mockResolvedValue(false)
    const getRule = vi.spyOn(service, 'getRule').mockResolvedValue(currentRule())
    const retried = storedExecution({ id: 'axe_next', status: 'success', steps: [] })
    const execSpy = vi.spyOn(service, 'executeRule').mockResolvedValue(retried)
    queryFn.mockResolvedValue({ rows: [{ first_retry_attempt: true }], rowCount: 1 })
    return { getRule, execSpy, retried }
  }

  it('R1 the customer shape → 409 TARGET_RECORD_MISSING_NOT_RETRYABLE; no rule read, no sweep, no marker, no run', async () => {
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution())
    const getRule = vi.spyOn(service, 'getRule')
    const execSpy = vi.spyOn(service, 'executeRule')

    await expect(service.retryExecution('axe_orig', 'admin1')).resolves.toEqual({
      status: 409,
      code: 'TARGET_RECORD_MISSING_NOT_RETRYABLE',
      message: 'Every step of this execution was skipped because its trigger record no longer exists; a retry cannot change that',
    })
    expect(getRule).not.toHaveBeenCalled()
    expect(execSpy).not.toHaveBeenCalled()
    expect(sweep).not.toHaveBeenCalled()
    expect(queryFn).not.toHaveBeenCalled() // the first-retry CAS is a queryFn call — it was never issued
  })

  it('R2 several steps, every one skipped with target_record_missing → refused', async () => {
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution({
      steps: [MISSING, { ...MISSING, output: { recordId: 'rec_gone', sheetId: 'sheet_1', reason: 'target_record_missing' } }],
    }))
    await expect(service.retryExecution('axe_orig', 'admin1')).resolves.toMatchObject({
      status: 409,
      code: 'TARGET_RECORD_MISSING_NOT_RETRYABLE',
    })
  })

  it('R3 control: skipped, but one step skipped for another reason → the retry proceeds', async () => {
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution({
      steps: [MISSING, { actionType: 'write_approval_form_values', status: 'skipped', output: { reason: 'APPROVAL_FWB_WRITEBACK_ENABLED is OFF' } }],
    }))
    const { execSpy, retried } = armEligibleRetry()
    await expect(service.retryExecution('axe_orig', 'admin1')).resolves.toEqual({ execution: retried })
    expect(execSpy).toHaveBeenCalledTimes(1)
  })

  it('R4 control: a FAILED execution containing such a step → the retry proceeds', async () => {
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution({
      status: 'failed',
      steps: [MISSING, { actionType: 'send_webhook', status: 'failed', error: 'HTTP 502' }],
    }))
    const { execSpy, retried } = armEligibleRetry()
    await expect(service.retryExecution('axe_orig', 'admin1')).resolves.toEqual({ execution: retried })
    expect(execSpy).toHaveBeenCalledTimes(1)
  })

  it('R5 control: skipped with ZERO steps (conditions not met) → the retry proceeds as before', async () => {
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution({ steps: [] }))
    const { execSpy, retried } = armEligibleRetry()
    await expect(service.retryExecution('axe_orig', 'admin1')).resolves.toEqual({ execution: retried })
    expect(execSpy).toHaveBeenCalledTimes(1)
  })
})

describe('isTargetRecordMissingSkippedExecution — the predicate', () => {
  it('R6 needs status skipped, at least one step, and EVERY step skipped with the plain-object reason', () => {
    expect(isTargetRecordMissingSkippedExecution({ status: 'skipped', steps: [MISSING] })).toBe(true)
    expect(isTargetRecordMissingSkippedExecution({ status: 'failed', steps: [MISSING] })).toBe(false)
    expect(isTargetRecordMissingSkippedExecution({ status: 'skipped', steps: [] })).toBe(false)
    expect(isTargetRecordMissingSkippedExecution({ status: 'skipped', steps: null })).toBe(false)
    // The update_record no-op carries the same reason but reports success — never a skipped execution's step.
    expect(isTargetRecordMissingSkippedExecution({
      status: 'skipped',
      steps: [{ status: 'success', output: { noop: true, reason: 'target_record_missing' } }],
    })).toBe(false)
    for (const output of [null, 'target_record_missing', ['target_record_missing'], { reason: 'other' }, {}]) {
      expect(isTargetRecordMissingSkippedExecution({ status: 'skipped', steps: [{ status: 'skipped', output }] }), JSON.stringify(output)).toBe(false)
    }
  })
})
