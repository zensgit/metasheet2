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

interface Harness {
  deps: AutomationDeps
  fetch: ReturnType<typeof vi.fn>
  intent: Map<string, { status: string; attempts: number; last_error: string | null }>
  intentInserts: number
}

/** A response-shaped stub for the send spy. */
const resp = (status: number) => ({ ok: status >= 200 && status < 300, status }) as unknown as Response

function makeHarness(fetchImpl: (call: number) => unknown): Harness {
  const intent = new Map<string, { status: string; attempts: number; last_error: string | null }>()
  let calls = 0
  const fetchSpy = vi.fn(async () => {
    const out = fetchImpl(calls++)
    if (out instanceof Error) throw out
    return out as Response
  })
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
    return { rows: [], rowCount: 1 }
  }) as unknown as AutomationDeps['queryFn']
  return {
    deps: { eventBus: new EventBus(), queryFn, fetchFn: fetchSpy as unknown as typeof fetch },
    fetch: fetchSpy,
    intent,
    get intentInserts() { return state.intentInserts },
  } as Harness
}

function ruleWith(action: { type: string; config: Record<string, unknown> }): AutomationRule {
  return {
    id: 'rule_cb', name: 'Class-B rule', sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [action as never], enabled: true, createdBy: 'user_1', createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}
const only = (m: Map<string, { status: string; attempts: number; last_error: string | null }>) => [...m.values()][0]

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

  it('retry after sent → skip_sent: alreadyApplied, NO second fetch', async () => {
    const h = makeHarness(() => resp(200))
    await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT) // first: sent
    const second = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT) // retry
    expect(second.steps[0]?.status).toBe('success')
    expect(second.steps[0]?.alreadyApplied).toBe(true)
    expect(h.fetch).toHaveBeenCalledTimes(1) // NOT re-sent
    expect(only(h.intent).status).toBe('sent')
  })

  it('4xx (§8 Q-B) → outcome_unknown: failed-shaped step naming outcome_unknown; retry → skip_unknown, no resend', async () => {
    const h = makeHarness(() => resp(404))
    const first = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    expect(first.steps[0]?.status).toBe('failed')
    expect(first.steps[0]?.error).toMatch(/outcome_unknown/)
    expect(only(h.intent).status).toBe('outcome_unknown')
    const retry = await new AutomationExecutor(h.deps).execute(ruleWith(WEBHOOK), TRIGGER, undefined, ROOT)
    expect(retry.steps[0]?.alreadyApplied).toBe(true) // skip_unknown → alreadyApplied
    expect(h.fetch).toHaveBeenCalledTimes(1) // TERMINAL: never a second send
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
