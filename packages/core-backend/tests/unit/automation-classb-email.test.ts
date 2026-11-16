/**
 * #4196 Class-B outbound two-phase — executor wiring (unit) for send_email (follow-up to send_webhook).
 *
 * Proves the two-phase intent/outcome path drives send_email when AUTOMATION_CLASSB_OUTBOUND_ENABLED is ON
 * AND an execution identity is present, and that with the flag OFF the send path is BYTE-IDENTICAL to
 * pre-slice (single NotificationService.send, no intent row ever written).
 *
 * The crash-flip + single-writer guards are proven action-agnostically in the substrate goldens
 * (automation-outbound-intent.test.ts); here we add the per-action CLASSIFICATION contract
 * (`mapSendEmailDeliveryOutcome`, one mapping for the legacy step, the two-phase step and the ledger):
 *   - a positive `sent` result is the ONLY success;
 *   - a channel that EXPLICITLY reports no attempt (`simulated` mock, `cancelled` no-recipient / disabled)
 *     records the ledger's retryable `failed` with a closed-set reason token and a `skipped` step — nothing
 *     left the client, so a re-attempt cannot duplicate an email;
 *   - a `failed` result, a throw, or a deferred / unrecognised literal is un-provable as pre-dispatch
 *     non-delivery ⇒ outcome_unknown (fail-closed), never auto-resent. A transport failure is therefore
 *     NEVER the retryable `failed`; only an explicit non-attempt is.
 *
 * deps.queryFn routes `meta_automation_outbound_intent` SQL through an in-memory table (shared across two
 * execute() calls so a "retry" — same lineage root — consults the SAME row); deps.notificationService.send
 * is the send spy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'

const FLAG = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'
const ROOT = 'exec_root_classb_email'
const EMAIL = {
  type: 'send_email',
  config: { recipients: ['ops@example.test'], subjectTemplate: 'Subject', bodyTemplate: 'Body' },
}
const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: { title: 'X' } }

type IntentRow = { status: string; attempts: number; last_error: string | null }
type SendResult = { id: string; status: string; failedReason?: string; metadata?: Record<string, unknown> }

interface Harness {
  deps: AutomationDeps
  send: ReturnType<typeof vi.fn>
  intent: Map<string, IntentRow>
  intentInserts: number
}

function makeHarness(sendImpl: (call: number) => SendResult): Harness {
  const intent = new Map<string, IntentRow>()
  let calls = 0
  const sendSpy = vi.fn(async () => sendImpl(calls++))
  const state = { intentInserts: 0 }
  const keyOf = (p: unknown[]) => `${String(p[0])}|${String(p[1])}|${String(p[2])}`
  const queryFn = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = String(sql)
    if (/meta_automation_outbound_intent/i.test(s)) {
      const key = keyOf(params)
      if (/^\s*INSERT INTO/i.test(s)) {
        if (intent.has(key)) return { rows: [], rowCount: 0 }
        intent.set(key, { status: 'pending', attempts: 0, last_error: null })
        state.intentInserts++
        return { rows: [], rowCount: 1 }
      }
      if (/^\s*SELECT status/i.test(s)) {
        const r = intent.get(key)
        return { rows: r ? [{ status: r.status }] : [], rowCount: r ? 1 : 0 }
      }
      // UPDATE — honor the `AND status = '…'` guard parsed from the SQL text.
      const r = intent.get(key)
      if (!r) return { rows: [], rowCount: 0 }
      const guard = /AND status = '([a-z_]+)'/i.exec(s)?.[1] ?? null
      if (guard && r.status !== guard) return { rows: [], rowCount: 0 }
      const literal = /SET status = '([a-z_]+)'/i.exec(s)?.[1]
      r.status = literal ?? (s.includes('status = $4') ? String(params[3]) : r.status)
      if (/attempts = attempts \+ 1/i.test(s)) r.attempts += 1
      if (s.includes('last_error = $5')) r.last_error = (params[4] ?? null) as string | null
      return { rows: [], rowCount: 1 }
    }
    // The email path never mutates records; any other SQL is inert.
    return { rows: [], rowCount: 1 }
  }) as unknown as AutomationDeps['queryFn']
  return {
    deps: { eventBus: new EventBus(), queryFn, notificationService: { send: sendSpy as never } },
    send: sendSpy,
    intent,
    get intentInserts() { return state.intentInserts },
  } as Harness
}

function ruleWith(action: { type: string; config: Record<string, unknown> }): AutomationRule {
  return {
    id: 'rule_cb_email', name: 'Class-B email rule', sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [action as never], enabled: true, createdBy: 'user_1', createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}
const only = (m: Map<string, IntentRow>) => [...m.values()][0]
const sent = (): SendResult => ({ id: 'notif_1', status: 'sent' })
const failed = (): SendResult => ({ id: 'notif_1', status: 'failed', failedReason: 'SMTP blocked: redacted' })
const simulated = (): SendResult => ({ id: 'notif_1', status: 'simulated', metadata: { channel: 'email', transport: 'mock', reason: 'transport_simulated', recipientCount: 1 } })
const noRecipients = (): SendResult => ({ id: 'notif_1', status: 'cancelled', metadata: { channel: 'email', reason: 'no_channel_recipients', recipientCount: 0 } })
const disabled = (): SendResult => ({ id: 'notif_1', status: 'cancelled', metadata: { channel: 'email', transport: 'disabled', reason: 'transport_disabled', recipientCount: 1 } })
const pending = (): SendResult => ({ id: 'notif_1', status: 'pending' })

beforeEach(() => { delete process.env[FLAG] })
afterEach(() => { delete process.env[FLAG]; vi.restoreAllMocks() })

describe('flag OFF — byte-identical legacy send_email (no intent row)', () => {
  it('sent: one send, success step, NO intent SQL written', async () => {
    const h = makeHarness(sent)
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('success')
    expect(exec.steps[0]?.alreadyApplied).toBeUndefined()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.intentInserts).toBe(0) // the two-phase table was never touched
    expect(h.intent.size).toBe(0)
  })

  it('transport failure keeps the legacy failed step + result output (unchanged), no intent row', async () => {
    const h = makeHarness(failed)
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toBe('SMTP blocked: redacted')
    expect(exec.steps[0]?.error).not.toMatch(/outcome_unknown/) // legacy wording, not the two-phase wording
    expect(h.intent.size).toBe(0)
  })

  it('simulated result: a skipped step (never success) naming the simulated reason; execution skipped', async () => {
    const h = makeHarness(simulated)
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(exec.status).toBe('skipped')
    expect(exec.steps[0]?.status).toBe('skipped')
    expect(exec.steps[0]?.output).toEqual({
      outcome: 'not_sent',
      reason: 'email_transport_simulated',
      notificationId: 'notif_1',
      notificationStatus: 'simulated',
      recipientCount: 1,
    })
    expect(h.intent.size).toBe(0)
  })

  it('cancelled (no recipient / disabled) results: skipped steps with their own reason tokens', async () => {
    const none = await new AutomationExecutor(makeHarness(noRecipients).deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(none.steps[0]?.status).toBe('skipped')
    expect(none.steps[0]?.output).toMatchObject({ outcome: 'not_sent', reason: 'email_no_recipients', notificationStatus: 'cancelled' })
    const off = await new AutomationExecutor(makeHarness(disabled).deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(off.steps[0]?.status).toBe('skipped')
    expect(off.steps[0]?.output).toMatchObject({ outcome: 'not_sent', reason: 'email_transport_disabled', notificationStatus: 'cancelled' })
  })

  it('deferred (pending) result fails closed: a failed step naming outcome_unknown, never success', async () => {
    const exec = await new AutomationExecutor(makeHarness(pending).deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(exec.steps[0]?.output).toMatchObject({ outcome: 'outcome_unknown', reason: 'email_result_unrecognized' })
  })
})

describe('flag ON — two-phase intent/outcome', () => {
  beforeEach(() => { process.env[FLAG] = 'true' })

  it('proceed → sent: single send, success step, intent row = sent', async () => {
    const h = makeHarness(sent)
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('success')
    expect(exec.steps[0]?.output).toMatchObject({ outcome: 'sent' })
    expect(h.send).toHaveBeenCalledTimes(1) // exactly one attempt
    expect(only(h.intent).status).toBe('sent')
  })

  it('retry after sent → skip_sent: alreadyApplied, NO second send', async () => {
    const h = makeHarness(sent)
    await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT) // first: sent
    const second = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT) // retry
    expect(second.steps[0]?.status).toBe('success')
    expect(second.steps[0]?.alreadyApplied).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1) // NOT re-sent
    expect(only(h.intent).status).toBe('sent')
  })

  // MUTATION-PROOF for the outcome MAPPING (`mapSendEmailDeliveryOutcome`): mutating the transport-failure
  // branch to 'failed' makes the intent terminal `failed` (retryable) instead of outcome_unknown, so BOTH the
  // intent-status assertion below AND the retry-skip assertion (a `failed` intent would retry_failed →
  // re-send) fail. Contrast with the simulated case below, where `failed` IS the correct terminal.
  it('transport failure → outcome_unknown (NEVER failed); retry → skip_unknown, no resend', async () => {
    const h = makeHarness(failed)
    const first = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(first.steps[0]?.status).toBe('failed')
    expect(first.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(only(h.intent).status).toBe('outcome_unknown') // fail-closed: never the retryable `failed`
    expect(only(h.intent).last_error).toBe('email_send_failed')

    const retry = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    // skip_unknown → a FAILED step naming outcome_unknown (never an alreadyApplied success): the ambiguity is
    // unresolved until reconciliation, so dependent steps must not run as if the email were known sent.
    expect(retry.steps[0]?.status).toBe('failed')
    expect(retry.steps[0]?.alreadyApplied).toBeUndefined()
    expect(retry.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(h.send).toHaveBeenCalledTimes(1) // TERMINAL: never a second send
  })

  // CONTRAST (the only path that lands the retryable `failed`): the channel EXPLICITLY reported no attempt.
  // MUTATION-PROOF for the positive match: mutating the mapping back to "non-failed ⇒ sent" writes the ledger
  // `sent`, the step `success`, and the replay `alreadyApplied` — all three assertions below fail.
  it('simulated result → ledger failed (retryable) + skipped step; replay re-attempts (attempts 1), still never sent', async () => {
    const h = makeHarness(simulated)
    const first = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(first.status).toBe('skipped')
    expect(first.steps[0]?.status).toBe('skipped')
    expect(first.steps[0]?.alreadyApplied).toBeUndefined()
    expect(first.steps[0]?.output).toEqual({
      outcome: 'not_sent',
      reason: 'email_transport_simulated',
      notificationId: 'notif_1',
      notificationStatus: 'simulated',
      recipientCount: 1,
    })
    expect(only(h.intent).status).toBe('failed')
    expect(only(h.intent).last_error).toBe('email_transport_simulated')
    expect(only(h.intent).attempts).toBe(0)

    const retry = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(retry.steps[0]?.status).toBe('skipped')
    expect(retry.steps[0]?.alreadyApplied).toBeUndefined()
    expect(h.send).toHaveBeenCalledTimes(2) // re-armed: nothing left the client the first time
    expect(only(h.intent).status).toBe('failed')
    expect(only(h.intent).attempts).toBe(1)
  })

  it('cancelled result (no email recipient) → ledger failed + email_no_recipients; disabled → email_transport_disabled', async () => {
    const none = makeHarness(noRecipients)
    const first = await new AutomationExecutor(none.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(first.steps[0]?.status).toBe('skipped')
    expect(first.steps[0]?.output).toMatchObject({ outcome: 'not_sent', reason: 'email_no_recipients' })
    expect(only(none.intent)).toMatchObject({ status: 'failed', last_error: 'email_no_recipients' })

    const off = makeHarness(disabled)
    await new AutomationExecutor(off.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(only(off.intent)).toMatchObject({ status: 'failed', last_error: 'email_transport_disabled' })
  })

  it('deferred (pending) result → outcome_unknown (fail-closed), failed step, intent terminal', async () => {
    const h = makeHarness(pending)
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(only(h.intent).status).toBe('outcome_unknown')
    expect(only(h.intent).last_error).toBe('email_result_unrecognized')
    const retry = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(retry.steps[0]?.status).toBe('failed')
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('send() throws → outcome_unknown (fail-closed), intent = outcome_unknown', async () => {
    const h = makeHarness(() => { throw new Error('unexpected throw') })
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(EMAIL), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('failed')
    expect(exec.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(only(h.intent).status).toBe('outcome_unknown')
    expect(only(h.intent).last_error).toBe('email_send_threw')
  })

  it('no identity (runSingleAction ad-hoc dispatch) → no intent even with the flag ON', async () => {
    const h = makeHarness(sent)
    const result = await new AutomationExecutor(h.deps).runSingleAction(EMAIL as never, {
      executionId: 'x', ruleId: 'r', sheetId: 'sheet_1', recordId: 'rec_1', recordData: {}, ruleCreatedBy: 'user_1', actorId: 'user_1', triggerEvent: null,
    })
    expect(result.status).toBe('success')
    expect(h.intent.size).toBe(0) // ad-hoc dispatch has no lineage → no intent
  })
})
