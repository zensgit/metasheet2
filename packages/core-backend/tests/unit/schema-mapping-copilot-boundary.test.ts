/**
 * 列映射副驾 × GOVERNED AI BOUNDARY — end-to-end contract + witnessed RED.
 *
 * This wires the REAL `GovernedAiService` (fetch-injected — NO real provider HTTP) to the REAL copilot
 * core (`plugins/plugin-integration-core/lib/schema-mapping-copilot.cjs`, required as CJS). It proves
 * the copilot consumes the boundary as specified, through the same construction seam production uses.
 *
 * Witnessed RED:
 *  - PRIVACY PIN: the copilot tags its request `dataClass: 'business'`, so on a cloud deployment that
 *    even PERMITS non-sensitive, the customer schema is REFUSED and NEVER reaches the provider fetch.
 *    Weaken the tag to 'non-sensitive' (or omit it) and the boundary would route the business columns
 *    to the cloud provider — the `fetch NOT called` assertion goes red. This is the leak-witnessing pin.
 *  - FAIL-OPEN: no provider ready → the copilot degrades to manual mapping (aiAvailable:false), never
 *    throws, and still surfaces the deterministic hints.
 *  - THE AI OUTPUT IS NEVER A PRESET: a proposal call's `authoritativePreset` is always null.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { AiProviderClient } from '../../src/services/ai-provider-client'
import { AI_BASE_URL_ENV } from '../../src/services/ai-provider-readiness'
import { AI_ROUTING_POLICY_PATH_ENV } from '../../src/services/ai-routing-policy'
import { GovernedAiService } from '../../src/services/governed-ai-service'

interface CopilotColumnSignal {
  name: string
  dictLabel: string | null
  labelHint: string | null
}
interface CopilotSignals {
  columnSignals: CopilotColumnSignal[]
  groundingSources: unknown[]
  scrubbedCount: number
}
interface CopilotProposalRow {
  id: string
  aiSemantic: string | null
  deterministic: { labelHint: string | null; family: string | null }
  agreesWithDiscovery: boolean | null
}
interface CopilotResult {
  aiAvailable: boolean
  reason: string | null
  manualFallback: boolean
  provenance: { aiGenerated?: boolean; advisory?: boolean; providerTier?: string } | null
  proposals: CopilotProposalRow[]
  authoritativePreset: unknown | null
}
interface CopilotModule {
  gatherSchemaSignals(input: unknown): CopilotSignals
  proposeColumnMappings(args: unknown): Promise<CopilotResult>
}

const require_ = createRequire(__filename)
const copilot = require_('../../../../plugins/plugin-integration-core/lib/schema-mapping-copilot.cjs') as CopilotModule

const KEY_SENTINEL = `sk-${'copilotleak'.repeat(2)}`
const scratch = mkdtempSync(join(tmpdir(), 'copilot-boundary-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function policyFile(json: unknown): string {
  const path = join(scratch, `policy-${counter++}.json`)
  writeFileSync(path, JSON.stringify(json), 'utf8')
  return path
}

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

function serviceWith(fetchSpy: ReturnType<typeof vi.fn>) {
  const client = new AiProviderClient({ fetchFn: fetchSpy as unknown as typeof fetch })
  return new GovernedAiService({ client })
}

// A distinctive customer column name — if the boundary ever leaks it to fetch, we catch it.
const CUSTOMER_COLUMN = 'Bom_ExAttr7'
const CUSTOMER_LABEL = '数量'

function businessSignals() {
  return copilot.gatherSchemaSignals({
    tableNames: ['DN_PDM_BomDetailsInfo'],
    columns: [{ id: '7', name: CUSTOMER_COLUMN, sample: ['12', '3', '40'] }],
    dictionaryRows: [{ columnName: CUSTOMER_COLUMN, label: CUSTOMER_LABEL, type: 'numeric', enabled: true }],
    presetCatalog: [],
  })
}

describe('列映射副驾 signal gathering reuses the deterministic discovery', () => {
  it('derives the quantity label hint from the dictionary via LABEL_HINT_VOCABULARY', () => {
    const signals = businessSignals()
    const s = signals.columnSignals[0]
    expect(s.name).toBe(CUSTOMER_COLUMN)
    expect(s.dictLabel).toBe(CUSTOMER_LABEL)
    expect(s.labelHint).toBe('quantity')
  })

  it('scrubs a secret-shaped column value — it never enters a grounding source', () => {
    const signals = copilot.gatherSchemaSignals({
      tableNames: [],
      columns: [
        { id: '1', name: 'GoodCol' },
        { id: '2', name: 'password=hunter2-secret' },
      ],
      dictionaryRows: [],
      presetCatalog: [],
    })
    expect(signals.scrubbedCount).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(signals.groundingSources)).not.toContain('hunter2-secret')
  })
})

describe('PRIVACY PIN — business schema NEVER reaches a cloud provider (end-to-end RED)', () => {
  it('cloud provider permitting non-sensitive + business request → REFUSED, customer columns NOT sent, degrades to manual', async () => {
    const path = policyFile({
      policyId: 'p',
      policyVersion: 1,
      activeProvider: { tier: 'cloud' },
      cloudDataClasses: ['non-sensitive'], // even with a cloud permit, business is refused
    })
    const fetchSpy = vi.fn(async () => openaiOk('[]'))
    const svc = serviceWith(fetchSpy)
    const result = await copilot.proposeColumnMappings({
      governedAi: svc,
      signals: businessSignals(),
      env: readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path }),
    })
    // The boundary refused; the copilot fail-opens to manual mapping.
    expect(result.aiAvailable).toBe(false)
    expect(result.reason).toBe('business_data_cloud_forbidden')
    expect(result.manualFallback).toBe(true)
    // THE LEAK WITNESS: the provider was never called — the customer columns did not leave the box.
    expect(fetchSpy).not.toHaveBeenCalled()
    // Even refused, the AI output is never a preset.
    expect(result.authoritativePreset).toBeNull()
  })

  it('a corporate-looking host that is NOT provably local (.corp) is treated as cloud → business REFUSED, fetch NOT called', async () => {
    // Hardened check (isProvablyLocalHost): only the localHosts allowlist, localhost / a private
    // suffix (.local/.internal/.lan/.home.arpa/.localhost), or a non-routable IP is local. A
    // `local`-DECLARED provider pointed at anything else is downgraded to cloud, so business is
    // refused. This is the case the old two-host denylist would have let through.
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => openaiOk('[]'))
    const svc = serviceWith(fetchSpy)
    const result = await copilot.proposeColumnMappings({
      governedAi: svc,
      signals: businessSignals(),
      env: readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://qwen.internal.corp:8000' }),
    })
    expect(result.aiAvailable).toBe(false)
    expect(result.reason).toBe('business_data_cloud_forbidden')
    expect(result.manualFallback).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('default-unset policy (most-restrictive) + cloud provider → business request refused, fetch NOT called', async () => {
    const fetchSpy = vi.fn(async () => openaiOk('[]'))
    const svc = serviceWith(fetchSpy)
    const result = await copilot.proposeColumnMappings({ governedAi: svc, signals: businessSignals(), env: readyEnv() })
    expect(result.aiAvailable).toBe(false)
    expect(result.reason).toBe('business_data_cloud_forbidden')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('business schema DOES route to a genuinely LOCAL provider, and the AI PROPOSES', () => {
  it('served: proposals parsed, provenance marked AI+advisory, authoritativePreset still null', async () => {
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const aiJson = JSON.stringify([
      { id: '7', meaning: '数量 (quantity)', semantic: 'bom-line-quantity', reasoning: 'per [[col:7]] dict labels it 数量, numeric dense', confidence: 'high' },
    ])
    const fetchSpy = vi.fn(async () => openaiOk(aiJson))
    const svc = serviceWith(fetchSpy)
    const result = await copilot.proposeColumnMappings({
      governedAi: svc,
      signals: businessSignals(),
      // `.internal` is a definitionally-private suffix under isProvablyLocalHost — genuinely on-prem.
      env: readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://qwen.intranet.internal:8000' }),
    })
    expect(result.aiAvailable).toBe(true)
    expect(result.provenance?.aiGenerated).toBe(true)
    expect(result.provenance?.advisory).toBe(true)
    expect(result.provenance?.providerTier).toBe('local')
    // The proposal is cross-checked against the deterministic discovery.
    const p = result.proposals.find((x) => x.id === '7')
    expect(p?.aiSemantic).toBe('bom-line-quantity')
    expect(p?.deterministic.labelHint).toBe('quantity')
    expect(p?.agreesWithDiscovery).toBe(true)
    // The AI output is advisory only — never an authoritative preset.
    expect(result.authoritativePreset).toBeNull()
    // The call went to the self-hosted host, carrying the business columns there (and nowhere else).
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as unknown as [string]
    expect(String(url)).toContain('qwen.intranet.internal')
  })

  it('an operator-allowlisted on-prem host (policy localHosts) also serves business', async () => {
    const path = policyFile({
      policyId: 'p',
      policyVersion: 1,
      activeProvider: { tier: 'local' },
      localHosts: ['gpu-box-7'],
    })
    const fetchSpy = vi.fn(async () => openaiOk('[]'))
    const svc = serviceWith(fetchSpy)
    const result = await copilot.proposeColumnMappings({
      governedAi: svc,
      signals: businessSignals(),
      env: readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'http://gpu-box-7:8000' }),
    })
    expect(result.aiAvailable).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('FAIL-OPEN — the copilot is never a hard dependency', () => {
  it('no provider ready → manual mapping, no throw, deterministic hints still surfaced', async () => {
    const fetchSpy = vi.fn(async () => openaiOk('[]'))
    const svc = serviceWith(fetchSpy)
    const result = await copilot.proposeColumnMappings({
      governedAi: svc,
      signals: businessSignals(),
      env: { MULTITABLE_AI_ENABLED: '0' },
    })
    expect(result.aiAvailable).toBe(false)
    expect(result.reason).toBe('provider_not_ready')
    expect(result.manualFallback).toBe(true)
    // The deterministic hint a human maps by hand is still there.
    expect(result.proposals[0]?.deterministic.labelHint).toBe('quantity')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('boundary not wired at all (absent) → manual mapping, boundary_absent', async () => {
    const result = await copilot.proposeColumnMappings({ governedAi: null, signals: businessSignals(), env: readyEnv() })
    expect(result.aiAvailable).toBe(false)
    expect(result.reason).toBe('boundary_absent')
    expect(result.authoritativePreset).toBeNull()
  })

  it('a served envelope never carries the API key sentinel', async () => {
    const path = policyFile({ policyId: 'p', policyVersion: 1, activeProvider: { tier: 'local' } })
    const fetchSpy = vi.fn(async () => openaiOk('[]'))
    const svc = serviceWith(fetchSpy)
    const result = await copilot.proposeColumnMappings({
      governedAi: svc,
      signals: businessSignals(),
      env: readyEnv({ [AI_ROUTING_POLICY_PATH_ENV]: path, [AI_BASE_URL_ENV]: 'https://m.internal' }),
    })
    expect(JSON.stringify(result)).not.toContain(KEY_SENTINEL)
  })
})
