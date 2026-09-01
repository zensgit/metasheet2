/**
 * THE LIVE PATH IS GOVERNED — `runShortcutCore` (the shipped multitable-AI
 * shortcut / inline bulk-fill / async bulk-job worker choke) must consult the
 * data-class routing policy BEFORE calling the provider.
 *
 * This is the adversarial-review P0 regression suite. Before the wiring, this
 * path called `aiClient.complete()` with prompts assembled from CUSTOMER RECORD
 * CONTENT and no routing gate at all — so a deployment with a correct routing
 * policy still shipped BOM/record data to api.anthropic.com / api.openai.com.
 *
 * Witnessed RED: delete the `authorizeAiRoute` gate from ai-bulk-shared.ts and
 * the business-data cases below go green-to-red (the provider gets called).
 *
 * HARD RULE: no real provider HTTP — fetch is injected at client construction.
 * `runShortcutCore` reads `process.env` (via preflight + the routing choke), so
 * these tests set and restore it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AiProviderClient } from '../../src/services/ai-provider-client'
import { AI_SHORTCUT_DATA_CLASS, runShortcutCore, type ShortcutRequestContext } from '../../src/services/ai-bulk-shared'
import { AI_ROUTING_POLICY_PATH_ENV } from '../../src/services/ai-routing-policy'

const scratch = mkdtempSync(join(tmpdir(), 'ai-live-gate-'))
let counter = 0
function policyFile(json: unknown): string {
  const path = join(scratch, `policy-${counter++}.json`)
  writeFileSync(path, JSON.stringify(json), 'utf8')
  return path
}

const ENV_KEYS = [
  'MULTITABLE_AI_ENABLED',
  'MULTITABLE_AI_PROVIDER',
  'MULTITABLE_AI_API_KEY',
  'MULTITABLE_AI_MODEL',
  'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS',
  'MULTITABLE_AI_BASE_URL',
  AI_ROUTING_POLICY_PATH_ENV,
]
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.MULTITABLE_AI_ENABLED = '1'
  process.env.MULTITABLE_AI_PROVIDER = 'openai'
  process.env.MULTITABLE_AI_API_KEY = 'sk-live-gate-test'
  process.env.MULTITABLE_AI_MODEL = 'gpt-4o-mini'
  process.env.MULTITABLE_AI_CONFIRM_LIVE_REQUESTS = '1'
  delete process.env.MULTITABLE_AI_BASE_URL
  delete process.env[AI_ROUTING_POLICY_PATH_ENV]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function fakePool() {
  const seen: Array<{ sql: string; params?: unknown[] }> = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    seen.push({ sql, params })
    return { rows: [] as unknown[], rowCount: 0 }
  })
  const pool = {
    query,
    transaction: async <T>(handler: (c: { query: typeof query }) => Promise<T>): Promise<T> => handler({ query }),
    seen,
  }
  return pool as unknown as ShortcutRequestContext['pool'] & { seen: typeof seen }
}

function ctxFor(pool: ReturnType<typeof fakePool>): ShortcutRequestContext {
  return { pool, sheetId: 'sheet1', recordId: 'rec1', fieldId: 'f1', action: 'run', userId: 'user1' }
}

function openaiOk(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** The prompt this path really carries: customer record content. */
const BOM_PROMPT = 'Fill this field. Record data: BOM item ACME-4471, qty 120, supplier Contoso.'

function ledgerBlockedRows(pool: ReturnType<typeof fakePool>) {
  return pool.seen.filter(
    (c) => c.sql.includes('INSERT INTO multitable_ai_usage_ledger') && (c.params ?? []).includes('blocked'),
  )
}

describe('the shipped shortcut/bulk path is data-class governed (P0 regression)', () => {
  it('pins the path to the BUSINESS class — not a caller-supplied one', () => {
    expect(AI_SHORTCUT_DATA_CLASS).toBe('business')
  })

  it('RED: default-unset policy + cloud provider → business prompt REFUSED, provider NEVER called', async () => {
    const fetchSpy = vi.fn(async () => openaiOk('LEAKED'))
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const pool = fakePool()

    const outcome = await runShortcutCore(client, ctxFor(pool), BOM_PROMPT)

    expect(outcome.kind).toBe('blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
    // Uncharged, auditable: a zero-token `blocked` ledger row, and NO reservation.
    expect(ledgerBlockedRows(pool).length).toBe(1)
  })

  it('RED (proven leak): a `local`-DECLARED provider on a PUBLIC host (api.deepseek.com) is cloud → REFUSED, provider NEVER called', async () => {
    process.env[AI_ROUTING_POLICY_PATH_ENV] = policyFile({
      policyId: 'p',
      policyVersion: 1,
      activeProvider: { tier: 'local' },
    })
    process.env.MULTITABLE_AI_BASE_URL = 'https://api.deepseek.com'

    const fetchSpy = vi.fn(async () => openaiOk('LEAKED TO DEEPSEEK'))
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const pool = fakePool()

    const outcome = await runShortcutCore(client, ctxFor(pool), BOM_PROMPT)

    expect(outcome.kind).toBe('blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an explicit CLOUD policy permitting non-sensitive still REFUSES this business path', async () => {
    process.env[AI_ROUTING_POLICY_PATH_ENV] = policyFile({
      policyId: 'p',
      policyVersion: 1,
      activeProvider: { tier: 'cloud' },
      cloudDataClasses: ['non-sensitive'],
    })
    const fetchSpy = vi.fn(async () => openaiOk('LEAKED'))
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const pool = fakePool()

    const outcome = await runShortcutCore(client, ctxFor(pool), BOM_PROMPT)

    expect(outcome.kind).toBe('blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: a genuinely PRIVATE self-hosted provider serves the same business prompt', async () => {
    process.env[AI_ROUTING_POLICY_PATH_ENV] = policyFile({
      policyId: 'p',
      policyVersion: 1,
      activeProvider: { tier: 'local' },
    })
    process.env.MULTITABLE_AI_BASE_URL = 'http://10.1.2.3:8000'

    const fetchSpy = vi.fn(async () => openaiOk('SUGGESTED VALUE'))
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const pool = fakePool()

    const outcome = await runShortcutCore(client, ctxFor(pool), BOM_PROMPT)

    // The feature still works end-to-end on a compliant deployment — the gate is
    // not a blanket kill switch.
    expect(outcome.kind).toBe('charged')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as unknown as [string]
    expect(String(url)).toContain('10.1.2.3')
  })

  it('a broken routing policy file REFUSES the live path (fail-closed), provider NEVER called', async () => {
    process.env[AI_ROUTING_POLICY_PATH_ENV] = join(scratch, 'missing-policy.json')
    const fetchSpy = vi.fn(async () => openaiOk('LEAKED'))
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const pool = fakePool()

    const outcome = await runShortcutCore(client, ctxFor(pool), BOM_PROMPT)

    expect(outcome.kind).toBe('blocked')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the pre-existing gate order is preserved: unsafe-input still wins before routing', async () => {
    const fetchSpy = vi.fn(async () => openaiOk('x'))
    const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
    const pool = fakePool()

    const outcome = await runShortcutCore(client, ctxFor(pool), `secret sk-${'a'.repeat(40)}`)

    expect(outcome.kind).toBe('unsafe_input')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
