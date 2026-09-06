/**
 * GOVERNED AI SERVICE BOUNDARY — end-to-end contract + witnessed RED.
 *
 * HARD RULE (inherited from the provider client): NO real provider HTTP — every
 * test injects a fetch-spied AiProviderClient through the SAME construction seam
 * production uses.
 *
 * Witnessed RED:
 *  - business data NEVER reaches a cloud provider END-TO-END (fetch NOT called; refused);
 *  - default-unset (no routing policy) = local-only → a business request on a cloud
 *    provider is refused, data never sent;
 *  - every served suggestion is provenance-marked (aiGenerated + advisory);
 *  - fail-open: no provider ready / broken policy / a throwing client → a clean
 *    "unavailable" result, never a throw;
 *  - the consumer contract (suggest() shape, citations, metering) is pinned.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { AiProviderClient } from '../../src/services/ai-provider-client'
import { AI_BASE_URL_ENV } from '../../src/services/ai-provider-readiness'
import { AI_ROUTING_POLICY_PATH_ENV } from '../../src/services/ai-routing-policy'
import {
  GovernedAiService,
  assembleGroundedPrompt,
  buildCitations,
  createInMemoryAiMeter,
  type AiAdvisoryRequest,
} from '../../src/services/governed-ai-service'

const KEY_SENTINEL = `sk-${'boundaryleak'.repeat(2)}`

const scratch = mkdtempSync(join(tmpdir(), 'ai-boundary-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function policyFile(json: unknown): string {
  const path = join(scratch, `policy-${counter++}.json`)
  writeFileSync(path, typeof json === 'string' ? json : JSON.stringify(json), 'utf8')
  return path
}

/** A ready deployment env (double-confirm armed), openai provider by default. */
function readyEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    MULTITABLE_AI_ENABLED: '1',
    MULTITABLE_AI_PROVIDER: 'openai',
    MULTITABLE_AI_API_KEY: KEY_SENTINEL,
    MULTITABLE_AI_MODEL: 'gpt-4o-mini',
    MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: '1',
    ...overrides,
  }
}

function openaiOk(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function serviceWith(fetchSpy: ReturnType<typeof vi.fn>, meter?: ReturnType<typeof createInMemoryAiMeter>) {
  const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
  return new GovernedAiService({ client, ...(meter ? { meter } : {}) })
}

const businessReq: AiAdvisoryRequest = { feature: 'schema-mapping-copilot', dataClass: 'business', prompt: 'map columns' }

// ─────────────────────────────────────────────────────────────────────────────
describe('business data NEVER reaches a cloud provider (end-to-end RED)', () => {
  it('default-unset policy + cloud provider + business request → REFUSED, fetch NOT called', async () => {
    const fetchSpy = vi.fn(async () => openaiOk('should never be produced'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(businessReq, readyEnv()) // no routing policy → most-restrictive
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('business_data_cloud_forbidden')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POISON: an explicit CLOUD policy + business request still REFUSES, fetch NOT called', async () => {
    const path = policyFile({
      policyId: 'p',
      policyVersion: 1,
      activeProvider: { tier: 'cloud' },
      cloudDataClasses: ['non-sensitive'],
    })
    const fetchSpy = vi.fn(async () => openaiOk('nope'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(businessReq, readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path }))
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('business_data_cloud_forbidden')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a provider DECLARED local but pointed at the public cloud host is downgraded → business REFUSED, fetch NOT called', async () => {
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => openaiOk('nope'))
    const svc = serviceWith(fetchSpy)
    // declares local, but base URL is the public OpenAI host → fail-closed downgrade to cloud
    const res = await svc.suggest(
      businessReq,
      readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://api.openai.com' }),
    )
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('business_data_cloud_forbidden')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('business request DOES route to a genuinely LOCAL (self-hosted) provider', async () => {
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => openaiOk('LOCAL SUGGESTION'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(
      businessReq,
      readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'http://10.1.2.3:8000' }),
    )
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.suggestion).toBe('LOCAL SUGGESTION')
      expect(res.provenance.providerTier).toBe('local')
    }
    // the call went to the self-hosted host, not a cloud endpoint
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as unknown as [string]
    expect(String(url)).toContain('10.1.2.3')
  })

  it('RED (proven leak): a `local`-declared provider on api.deepseek.com REFUSES business data, and does NOT POST it', async () => {
    // Adversarial review executed exactly this and got available=true,
    // providerTier='local', with the BOM grounding POSTed to api.deepseek.com —
    // because the old guard was a two-entry denylist. The positive local check
    // closes it: a public host is cloud whatever the policy declares.
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => openaiOk('LEAKED'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(
      {
        feature: 'copilot',
        dataClass: 'business',
        prompt: 'map columns',
        grounding: [{ id: 'bom:1', label: 'BOM', content: 'ACME-4471 qty 120 supplier Contoso' }],
      },
      readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://api.deepseek.com' }),
    )
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('business_data_cloud_forbidden')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('RED (local lane, end-to-end): provider=local-openai-compat + local URL + keyless + operator model serves BUSINESS — no policy file, no alias, no dummy key', async () => {
    // Before the local lane existed the ONLY way to run this deployment was to
    // lie (alias the local server as gpt-4o-mini + a dummy key). This is the
    // honest configuration, end to end through the boundary.
    const fetchSpy = vi.fn(async () => openaiOk('LOCAL QWEN SUGGESTION'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(businessReq, {
      MULTITABLE_AI_ENABLED: '1',
      MULTITABLE_AI_PROVIDER: 'local-openai-compat',
      MULTITABLE_AI_BASE_URL: 'http://127.0.0.1:11434',
      MULTITABLE_AI_MODEL: 'qwen2.5:14b-instruct',
      MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: '1',
      // no MULTITABLE_AI_API_KEY, no MULTITABLE_AI_ROUTING_POLICY
    })
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.suggestion).toBe('LOCAL QWEN SUGGESTION')
      expect(res.provenance.providerTier).toBe('local')
      expect(res.provenance.provider).toBe('local-openai-compat')
      expect(res.provenance.model).toBe('qwen2.5:14b-instruct')
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as unknown as [string]
    expect(String(url)).toBe('http://127.0.0.1:11434/v1/chat/completions')
  })

  it('RED (local lane): local-openai-compat pointed at a PUBLIC host never serves business — blocked at readiness, fetch NOT called', async () => {
    const fetchSpy = vi.fn(async () => openaiOk('LEAKED'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(businessReq, {
      MULTITABLE_AI_ENABLED: '1',
      MULTITABLE_AI_PROVIDER: 'local-openai-compat',
      MULTITABLE_AI_BASE_URL: 'https://api.example.com',
      MULTITABLE_AI_MODEL: 'qwen2.5:14b-instruct',
      MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: '1',
    })
    expect(res.available).toBe(false)
    // Readiness refuses the unprovable host first (provider_not_ready); even if
    // it were bypassed, the routing tier downgrade would refuse business next —
    // two independent layers, both keyed on the SAME isProvablyLocalHost proof.
    if (!res.available) expect(res.reason).toBe('provider_not_ready')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('non-sensitive routing', () => {
  it('non-sensitive + cloud provider + policy permits → SERVED via cloud', async () => {
    const path = policyFile({
      policyId: 'p',
      policyVersion: 1,
      activeProvider: { tier: 'cloud' },
      cloudDataClasses: ['non-sensitive'],
    })
    const fetchSpy = vi.fn(async () => openaiOk('CLOUD HELP'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(
      { feature: 'help', dataClass: 'non-sensitive', prompt: 'what is a view?' },
      readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path }),
    )
    expect(res.available).toBe(true)
    if (res.available) expect(res.provenance.providerTier).toBe('cloud')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('non-sensitive + cloud provider WITHOUT a permit → refused, fetch NOT called', async () => {
    const fetchSpy = vi.fn(async () => openaiOk('nope'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest({ feature: 'help', dataClass: 'non-sensitive', prompt: 'hi' }, readyEnv())
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('class_not_cloud_authorized')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('advisory-only + provenance is ALWAYS marked', () => {
  it('a served suggestion carries aiGenerated + advisory provenance', async () => {
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => openaiOk('advice'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(businessReq, readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://m.internal' }))
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.provenance.aiGenerated).toBe(true)
      expect(res.provenance.advisory).toBe(true)
    }
  })

  it('the boundary exposes ONLY suggest() — no commit / write path', () => {
    const svc = new GovernedAiService()
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).filter((m) => m !== 'constructor')
    // The only public async surface is suggest(); everything else is private (#-free, but not a mutation seam).
    expect(methods).toContain('suggest')
    expect(methods).not.toContain('commit')
    expect(methods).not.toContain('write')
    expect(methods).not.toContain('apply')
  })
})

describe('fail-open — the boundary is NEVER a hard dependency', () => {
  it('no provider ready (AI disabled) → unavailable, never throws, fetch NOT called', async () => {
    const fetchSpy = vi.fn(async () => openaiOk('x'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(businessReq, { MULTITABLE_AI_ENABLED: '0' })
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('provider_not_ready')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a broken routing policy file → unavailable (fail-closed route, fail-open platform), fetch NOT called', async () => {
    const missing = join(scratch, 'nope.json')
    expect(existsSync(missing)).toBe(false)
    const fetchSpy = vi.fn(async () => openaiOk('x'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(businessReq, readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: missing }))
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('routing_policy_invalid')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('RED: a client that THROWS is caught → internal_error, never propagates', async () => {
    const throwingClient = {
      complete: vi.fn(async () => {
        throw new Error('boom from provider layer')
      }),
    } as unknown as AiProviderClient
    // route business to local so we actually reach the client
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const svc = new GovernedAiService({ client: throwingClient })
    const res = await svc.suggest(businessReq, readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://m.internal' }))
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('internal_error')
  })

  it('RED (P2): suggest(null) / suggest(undefined) / a malformed request RETURN, never reject', async () => {
    const fetchSpy = vi.fn(async () => openaiOk('x'))
    const svc = serviceWith(fetchSpy)
    // The normalize used to run OUTSIDE the try, so these rejected instead of
    // returning — breaking the never-throws invariant the boundary sells.
    for (const bad of [null, undefined, 'a string', 42, {}, { feature: 'f' }]) {
      const res = await svc.suggest(bad as never, readyEnv())
      expect(res.available, JSON.stringify(bad)).toBe(false)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a provider_error result → unavailable(provider_error), still no throw', async () => {
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(businessReq, readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://m.internal' }))
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('provider_error')
  })
})

describe('unsafe-input scan — secret-shaped grounding is not sent', () => {
  it('a secret-shaped grounding value blocks the send (fetch NOT called)', async () => {
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => openaiOk('x'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(
      {
        feature: 'copilot',
        dataClass: 'business',
        prompt: 'map',
        grounding: [{ id: 's1', content: `token sk-${'a'.repeat(40)}` }],
      },
      readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://m.internal' }),
    )
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('unsafe_input')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('grounding / citations', () => {
  it('assembleGroundedPrompt folds sources with [[id]] markers; empty grounding is a pass-through', () => {
    expect(assembleGroundedPrompt('do X')).toBe('do X')
    const out = assembleGroundedPrompt('do X', [{ id: 'col:7', label: 'Bom_ExAttr1', content: 'ACME-123' }])
    expect(out).toContain('[[col:7]]')
    expect(out).toContain('Bom_ExAttr1')
    expect(out).toContain('ACME-123')
  })

  it('buildCitations echoes the supplied set and flags referenced sources', () => {
    const grounding = [
      { id: 'a', label: 'A', content: 'x' },
      { id: 'b', label: 'B', content: 'y' },
    ]
    const cites = buildCitations(grounding, 'per [[a]] the answer is 5')
    expect(cites).toHaveLength(2)
    expect(cites.find((c) => c.id === 'a')?.referenced).toBe(true)
    expect(cites.find((c) => c.id === 'b')?.referenced).toBe(false)
  })

  it('the served envelope carries citations back', async () => {
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => openaiOk('based on [[col:7]] use field X'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(
      { feature: 'copilot', dataClass: 'business', prompt: 'map', grounding: [{ id: 'col:7', label: 'Bom_ExAttr1', content: 'A' }] },
      readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://m.internal' }),
    )
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.citations).toHaveLength(1)
      expect(res.citations[0].id).toBe('col:7')
      expect(res.citations[0].referenced).toBe(true)
    }
  })
})

describe('metering hook', () => {
  it('admit=false → metered_out, and every outcome is recorded', async () => {
    const meter = createInMemoryAiMeter({ maxCalls: 1 })
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => openaiOk('advice'))
    const svc = serviceWith(fetchSpy, meter)
    const env = readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://m.internal' })

    const first = await svc.suggest(businessReq, env)
    expect(first.available).toBe(true)

    const second = await svc.suggest(businessReq, env) // budget exhausted
    expect(second.available).toBe(false)
    if (!second.available) expect(second.reason).toBe('metered_out')

    const snap = meter.snapshot()
    expect(snap.served).toBe(1)
    expect(snap.unavailable).toBe(1)
    expect(snap.declined).toBe(1)
    // the metered-out call never reached the provider
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('no key / prompt leak in the result envelope', () => {
  it('a served envelope never carries the API key sentinel', async () => {
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => openaiOk('clean advice'))
    const svc = serviceWith(fetchSpy)
    const res = await svc.suggest(businessReq, readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://m.internal' }))
    expect(JSON.stringify(res)).not.toContain(KEY_SENTINEL)
  })
})
