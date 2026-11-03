/**
 * #4196 Class-B outbound two-phase — executor wiring (unit) for send_webhook.
 *
 * Proves the two-phase intent/outcome path drives send_webhook when AUTOMATION_CLASSB_OUTBOUND_ENABLED is
 * ON AND an execution identity is present, and that with the flag OFF the send path is BYTE-IDENTICAL to
 * pre-slice (legacy in-call retry loop, no intent row ever written).
 *
 * deps.queryFn routes `meta_automation_outbound_intent` SQL through an in-memory table (shared across two
 * execute() calls so a "retry" — same lineage root — consults the SAME row); deps.fetchFn is the send spy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'

const FLAG = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'
const ROOT = 'exec_root_classb'
const WEBHOOK = { type: 'send_webhook', config: { url: 'https://example.test/hook', body: { x: 1 } } }
const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: {} }

interface IntentRow {
  status: string
  attempts: number
  last_error: string | null
  attempt_token: string | null
  /** lease expiry on the harness clock (ms) */
  lease_expires_at: number | null
}

interface Harness {
  deps: AutomationDeps
  fetch: ReturnType<typeof vi.fn>
  intent: Map<string, IntentRow>
  intentInserts: number
  /** the harness DB clock — advance it to expire a lease */
  clock: { now: number }
}

/** A response-shaped stub for the send spy. */
const resp = (status: number) => ({ ok: status >= 200 && status < 300, status }) as unknown as Response

/**
 * In-memory intent table honoring EVERY guard the module's SQL carries: the `AND status = '…'` guard, the
 * attempt-token fence (`attempt_token = $n` / `IS NOT DISTINCT FROM $n`) and the lease-expired predicate,
 * so weakening a guard in the module changes behavior through this mock.
 */
function makeHarness(fetchImpl: (call: number) => unknown): Harness {
  const intent = new Map<string, IntentRow>()
  const clock = { now: 1_000_000 }
  let calls = 0
  const fetchSpy = vi.fn(async () => {
    const out = fetchImpl(calls++)
    if (out instanceof Error) throw out
    return await (out as Promise<Response> | Response)
  })
  const state = { intentInserts: 0 }
  const keyOf = (p: unknown[]) => `${String(p[0])}|${String(p[1])}|${String(p[2])}`
  const queryFn = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = String(sql)
    if (/meta_automation_outbound_intent/i.test(s)) {
      const key = keyOf(params)
      if (/^\s*INSERT INTO/i.test(s)) {
        if (intent.has(key)) return { rows: [], rowCount: 0 }
        intent.set(key, {
          status: 'pending', attempts: 0, last_error: null,
          attempt_token: (params[4] as string | undefined) ?? null,
          lease_expires_at: typeof params[5] === 'number' ? clock.now + params[5] : null,
        })
        state.intentInserts++
        return { rows: [], rowCount: 1 }
      }
      if (/^\s*SELECT status/i.test(s)) {
        const r = intent.get(key)
        if (!r) return { rows: [], rowCount: 0 }
        const leaseLive = r.lease_expires_at !== null && r.lease_expires_at > clock.now
        return { rows: [{ status: r.status, attempt_token: r.attempt_token, lease_live: leaseLive }], rowCount: 1 }
      }
      // UPDATE — honor the guards parsed from the SQL text.
      const r = intent.get(key)
      if (!r) return { rows: [], rowCount: 0 }
      const guard = /AND status = '([a-z_]+)'/i.exec(s)?.[1] ?? null
      if (guard && r.status !== guard) return { rows: [], rowCount: 0 }
      const nullSafe = /attempt_token IS NOT DISTINCT FROM \$(\d+)/i.exec(s)?.[1]
      const strict = /AND attempt_token = \$(\d+)/i.exec(s)?.[1]
      if (nullSafe && (r.attempt_token ?? null) !== ((params[Number(nullSafe) - 1] as string | null | undefined) ?? null)) return { rows: [], rowCount: 0 }
      if (strict && r.attempt_token !== params[Number(strict) - 1]) return { rows: [], rowCount: 0 }
      if (/lease_expires_at IS NULL OR lease_expires_at <= now\(\)/i.test(s) && r.lease_expires_at !== null && r.lease_expires_at > clock.now) {
        return { rows: [], rowCount: 0 }
      }
      const literal = /SET status = '([a-z_]+)'/i.exec(s)?.[1]
      r.status = literal ?? (s.includes('status = $4') ? String(params[3]) : r.status)
      if (/attempts = attempts \+ 1/i.test(s)) r.attempts += 1
      if (s.includes('last_error = $5')) r.last_error = (params[4] ?? null) as string | null
      else if (/last_error = '([a-z_]+)'/i.test(s)) r.last_error = /last_error = '([a-z_]+)'/i.exec(s)?.[1] ?? r.last_error
      const setToken = /SET [^]*?attempt_token = \$(\d+)/i.exec(s)?.[1]
      const setLease = /lease_expires_at = now\(\) \+ \(\$(\d+)::int/i.exec(s)?.[1]
      if (setToken) r.attempt_token = (params[Number(setToken) - 1] as string | undefined) ?? null
      if (setLease) r.lease_expires_at = clock.now + Number(params[Number(setLease) - 1])
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }) as unknown as AutomationDeps['queryFn']
  return {
    deps: { eventBus: new EventBus(), queryFn, fetchFn: fetchSpy as unknown as typeof fetch },
    fetch: fetchSpy,
    intent,
    clock,
    get intentInserts() { return state.intentInserts },
  } as Harness
}

/** A fetch result the test releases later (the remote is "slow"); ignores the abort signal on purpose. */
function deferredResponse(): { promise: Promise<Response>; release: (status: number) => void } {
  let release!: (status: number) => void
  const promise = new Promise<Response>((resolve) => { release = (status) => resolve(resp(status)) })
  return { promise, release }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function untilFetchCalled(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < 200 && h.fetch.mock.calls.length < n; i++) await tick()
  expect(h.fetch.mock.calls.length).toBeGreaterThanOrEqual(n)
}

function ruleWith(action: { type: string; config: Record<string, unknown> }): AutomationRule {
  return {
    id: 'rule_cb', name: 'Class-B rule', sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [action as never], enabled: true, createdBy: 'user_1', createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}
const only = (m: Map<string, IntentRow>) => [...m.values()][0]
const SECOND_WEBHOOK = { type: 'send_webhook', config: { url: 'https://example.test/hook-2', body: { y: 2 } } }
function ruleWithTwo(): AutomationRule {
  return { ...ruleWith(WEBHOOK), actions: [WEBHOOK, SECOND_WEBHOOK] as never } as AutomationRule
}

beforeEach(() => { delete process.env[FLAG] })
afterEach(() => { delete process.env[FLAG]; vi.restoreAllMocks() })

describe('flag OFF — byte-identical legacy send_webhook (no intent row)', () => {
  it('2xx success: one fetch, success step, NO intent SQL written', async () => {
    const h = makeHarness(() => resp(200))
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('success')
    expect(exec.steps[0]?.alreadyApplied).toBeUndefined()
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.intentInserts).toBe(0) // the two-phase table was never touched
    expect(h.intent.size).toBe(0)
  })

  it('non-2xx keeps the legacy in-call retry loop (fetched retries+1 times, then a failed step)', async () => {
    const h = makeHarness(() => resp(500))
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('failed')
    expect(h.fetch.mock.calls.length).toBeGreaterThan(1) // the legacy loop retried — proves OFF path unchanged
    expect(h.intent.size).toBe(0)
  })
})

describe('flag ON — two-phase intent/outcome', () => {
  beforeEach(() => { process.env[FLAG] = 'true' })

  it('proceed → sent: single fetch, success step, intent row = sent', async () => {
    const h = makeHarness(() => resp(200))
    const exec = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    expect(exec.steps[0]?.status).toBe('success')
    expect(h.fetch).toHaveBeenCalledTimes(1) // exactly one attempt — NO legacy retry loop
    expect(only(h.intent).status).toBe('sent')
  })

  it('real-fire test run writes its outbound intent in kind=test_run', async () => {
    const h = makeHarness(() => resp(200))
    await new AutomationExecutor(h.deps).execute(
      ruleWith(WEBHOOK),
      TRIGGER,
      undefined,
      'trroot_server_derived',
      'live',
      'test_run',
    )
    expect([...h.intent.keys()]).toEqual([
      expect.stringMatching(/^test_run\|trroot_server_derived\|/),
    ])
  })

  it('retry after sent → skip_sent: alreadyApplied, NO second fetch', async () => {
    const h = makeHarness(() => resp(200))
    await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT) // first: sent
    const second = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT) // retry
    expect(second.steps[0]?.status).toBe('success')
    expect(second.steps[0]?.alreadyApplied).toBe(true)
    expect(h.fetch).toHaveBeenCalledTimes(1) // NOT re-sent
    expect(only(h.intent).status).toBe('sent')
  })

  it('4xx (§8 Q-B) → outcome_unknown: failed-shaped step naming outcome_unknown; retry → skip_unknown is ALSO a failed step (never alreadyApplied) and the dependent step stays skipped; no resend', async () => {
    const h = makeHarness(() => resp(404))
    const first = await new AutomationExecutor(h.deps).execute(ruleWithTwo(), TRIGGER, undefined, ROOT)
    expect(first.steps[0]?.status).toBe('failed')
    expect(first.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(first.steps[1]?.status).toBe('skipped') // the dependent step did not run
    expect(only(h.intent).status).toBe('outcome_unknown')
    const retry = await new AutomationExecutor(h.deps).execute(ruleWithTwo(), TRIGGER, undefined, ROOT)
    // skip_unknown must NOT look like a success: the ambiguity is unresolved until reconciliation, so the
    // step fails naming outcome_unknown and the executor keeps the dependent step from running.
    expect(retry.steps[0]?.status).toBe('failed')
    expect(retry.steps[0]?.alreadyApplied).toBeUndefined()
    expect(retry.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(retry.steps[0]?.output).toMatchObject({ outcome: 'outcome_unknown', reason: 'prior_outcome_unknown' })
    expect(retry.steps[1]?.status).toBe('skipped')
    expect(retry.status).toBe('failed')
    expect(h.fetch).toHaveBeenCalledTimes(1) // TERMINAL: never a second send, and hook-2 never fetched
  })

  it('in-flight replay: a second execute of the same lineage while the first awaits the remote → failed step naming in flight, NO fetch; the first then confirms sent with its own token', async () => {
    const slow = deferredResponse()
    const h = makeHarness((call) => (call === 0 ? slow.promise : resp(200)))
    const first = new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    await untilFetchCalled(h, 1) // A has claimed (pending, live lease) and is waiting on the remote
    const replay = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    expect(replay.steps[0]?.status).toBe('failed')
    expect(replay.steps[0]?.alreadyApplied).toBeUndefined()
    expect(replay.steps[0]?.error).toMatch(/in flight/)
    expect(replay.steps[0]?.output).toMatchObject({ outcome: 'pending', reason: 'inflight_lease' })
    expect(h.fetch).toHaveBeenCalledTimes(1) // B sent nothing
    expect(only(h.intent).status).toBe('pending') // and did NOT declare A dead
    slow.release(200)
    const a = await first
    expect(a.steps[0]?.status).toBe('success')
    expect(a.steps[0]?.output).toMatchObject({ outcome: 'sent', httpStatus: 200 })
    expect(only(h.intent)).toMatchObject({ status: 'sent', last_error: 'sent_2xx' })
    expect(only(h.intent).attempt_token).toBeTruthy()
  })

  it('terminal write unconfirmed: the remote answers 2xx only after the lease expired and a replay flipped the row → the step must NOT report success', async () => {
    const slow = deferredResponse()
    const h = makeHarness((call) => (call === 0 ? slow.promise : resp(200)))
    const first = new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    await untilFetchCalled(h, 1)
    h.clock.now += 3_600_000 // A ran past its lease (timeout + grace)
    const replay = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    expect(replay.steps[0]?.status).toBe('failed')
    expect(replay.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(only(h.intent)).toMatchObject({ status: 'outcome_unknown', last_error: 'lease_expired' })
    expect(h.fetch).toHaveBeenCalledTimes(1) // the replay never resent
    slow.release(200) // the slow remote finally answers A with 2xx
    const a = await first
    // A's token-fenced terminal write hit 0 rows: the ledger does not say sent, so neither may the step.
    expect(a.steps[0]?.status).toBe('failed')
    expect(a.steps[0]?.alreadyApplied).toBeUndefined()
    expect(a.steps[0]?.error).toMatch(/terminal write not confirmed/)
    expect(a.steps[0]?.output).toMatchObject({ outcome: 'outcome_unknown', reason: 'terminal_write_unconfirmed', httpStatus: 200 })
    expect(only(h.intent).status).toBe('outcome_unknown') // never clobbered back to sent
  })

  it('DNS failure (ENOTFOUND) → failed step; retry → retry_failed re-attempts (fetch called again)', async () => {
    // First attempt DNS-fails (definite pre-dispatch non-delivery), the retry succeeds.
    const h = makeHarness((call) => (call === 0 ? Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }) }) : resp(200)))
    const first = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    expect(first.steps[0]?.status).toBe('failed')
    expect(first.steps[0]?.error).toMatch(/definite non-delivery/)
    expect(only(h.intent).status).toBe('failed')
    const retry = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    expect(retry.steps[0]?.status).toBe('success')
    expect(h.fetch).toHaveBeenCalledTimes(2) // re-attempted — a definite failure is retryable
    expect(only(h.intent).status).toBe('sent')
  })

  it('no identity (runSingleAction ad-hoc dispatch) → no intent even with the flag ON', async () => {
    const h = makeHarness(() => resp(200))
    const result = await new AutomationExecutor(h.deps).runSingleAction(WEBHOOK as never, {
      executionId: 'x', ruleId: 'r', sheetId: 'sheet_1', recordId: 'rec_1', recordData: {}, ruleCreatedBy: 'user_1', actorId: 'user_1', triggerEvent: null,
    })
    expect(result.status).toBe('success')
    expect(h.intent.size).toBe(0) // ad-hoc dispatch has no lineage → no intent
  })
})
