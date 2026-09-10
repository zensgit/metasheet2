import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 列映射副驾 (schema-mapping copilot) PANEL. Mocks ONLY apiFetch and drives the REAL service module
// (schemaMappingCopilot.ts) through the panel, pinning BOTH directions of the wire contract:
//   - the AI output is LABELLED "AI 建议·待确认" and is NEVER applied — a propose call posts `signals`
//     and no preset, and produces no authoritative artifact in the DOM;
//   - CONFIRM is a separate, explicit call that posts the human-confirmed semantics with AI-vs-human
//     provenance and NEVER a confirmedBy (server-stamped);
//   - FAIL-OPEN: an aiAvailable:false response degrades to the manual chip + deterministic hints (not
//     an error), and a transport failure renders the clamped code, never the raw message.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ locale: ref(h.locale), isZh: ref(h.locale === 'zh-CN'), setLocale: vi.fn() }),
}))

vi.mock('../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/api')>('../src/utils/api')
  return { ...actual, apiFetch: h.apiFetch }
})

import SchemaMappingCopilotPanel from '../src/components/integration/stockPreparation/SchemaMappingCopilotPanel.vue'

const PLANTED_RAW_ERROR = 'connectionString=host=erp;pwd=secret-42007'

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status })
}
function fail(status: number, code: string, field?: string): Response {
  return new Response(
    JSON.stringify({ ok: false, error: { code, message: PLANTED_RAW_ERROR, details: field ? { field } : {} } }),
    { status },
  )
}

function signals() {
  return {
    tableNames: ['DN_PDM_BomDetailsInfo', 'DN_PM_BomExAttrInfo', 'DN_PDM_PartLibraryInfo'],
    columns: [{ id: '7', name: 'Bom_ExAttr7' }],
    dictionaryRows: [{ columnName: 'Bom_ExAttr7', label: '数量', type: 'numeric', enabled: true }],
  }
}

function proposeAvailableData() {
  return {
    aiAvailable: true,
    reason: null,
    message: null,
    manualFallback: false,
    familyDetection: { presetId: 'dn-pdm-family', reason: 'MATCHED' },
    presetId: 'dn-pdm-family',
    baseSemanticExpectations: [
      { semantic: 'bom-line-quantity', locus: 'dictionary-assigned-column', columnFamily: 'bomDetailExAttr', dictionary: 'bom-detail-exattr-labels', dictionaryTypeHint: 'numeric', labelHint: 'quantity' },
    ],
    proposals: [
      {
        id: '7',
        column: 'Bom_ExAttr7',
        aiMeaning: '数量 (quantity)',
        aiSemantic: 'bom-line-quantity',
        aiReasoning: 'per [[col:7]] the dictionary labels it 数量 and values are numeric-dense',
        aiConfidence: 'high',
        deterministic: { family: 'bomDetailExAttr', dictLabel: '数量', labelHint: 'quantity', isGenericSlot: true },
        groundedByDiscovery: true,
        agreesWithDiscovery: true,
      },
    ],
    aiSuggestionText: '[{"id":"7","meaning":"数量"}]',
    aiParseError: false,
    citations: [{ id: 'col:7', label: 'Bom_ExAttr7', referenced: true }],
    provenance: { aiGenerated: true, advisory: true, providerTier: 'local' },
    scrubbedCount: 0,
    authoritativePreset: null,
  }
}

function proposeUnavailableData() {
  return {
    aiAvailable: false,
    reason: 'business_data_cloud_forbidden',
    message: 'Business-class data is not routed to a cloud AI provider.',
    manualFallback: true,
    familyDetection: { presetId: 'dn-pdm-family', reason: 'MATCHED' },
    presetId: 'dn-pdm-family',
    baseSemanticExpectations: [],
    proposals: [
      {
        id: '7',
        column: 'Bom_ExAttr7',
        aiMeaning: null,
        aiSemantic: null,
        aiReasoning: null,
        aiConfidence: null,
        deterministic: { family: 'bomDetailExAttr', dictLabel: '数量', labelHint: 'quantity', isGenericSlot: true },
        groundedByDiscovery: true,
        agreesWithDiscovery: null,
      },
    ],
    citations: [],
    provenance: null,
    scrubbedCount: 0,
    authoritativePreset: null,
  }
}

function confirmData() {
  return {
    preset: { presetSchema: 'metasheet.source-vendor-preset', presetVersion: 1, presetId: 'dn-pdm-family', semanticExpectations: [{ semantic: 'bom-line-quantity' }] },
    provenance: { confirmedBy: 'user_admin', confirmedAt: '2026-09-01T00:00:00.000Z', fields: [{ semantic: 'bom-line-quantity', source: 'ai-suggested' }], aiSuggested: 1, humanSet: 0 },
    aiFieldCount: 1,
    humanFieldCount: 0,
  }
}

let app: VueApp | null = null
let container: HTMLDivElement | null = null
const calls: Array<{ url: string; body: unknown }> = []

beforeEach(() => {
  calls.length = 0
  h.locale = 'zh-CN'
  h.apiFetch.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
})
afterEach(() => {
  if (app) app.unmount()
  app = null
  if (container) container.remove()
  container = null
})

function mountPanel(props: Record<string, unknown>): HTMLDivElement {
  app = createApp(SchemaMappingCopilotPanel as Component, props)
  app.mount(container!)
  return container as HTMLDivElement
}

function routeMock(map: { propose?: () => Response; confirm?: () => Response }): void {
  h.apiFetch.mockImplementation(async (url: string, options: RequestInit = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(String(options.body)) : undefined })
    if (url.includes('/schema-mapping-copilot/confirm')) return (map.confirm || (() => ok(confirmData())))()
    if (url.includes('/schema-mapping-copilot/propose')) return (map.propose || (() => ok(proposeAvailableData())))()
    return new Response('{}', { status: 404 })
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

async function clickPropose(root: HTMLDivElement): Promise<void> {
  ;(root.querySelector('[data-testid="copilot-propose"]') as HTMLButtonElement).click()
  await flush()
}

describe('列映射副驾 panel', () => {
  it('propose posts `signals` (no preset) and labels the AI output AI 建议·待确认', async () => {
    routeMock({})
    const root = mountPanel({ scope: { tenantId: 'tenant_1' }, signals: signals() })
    await clickPropose(root)

    const proposeCall = calls.find((c) => c.url.includes('/propose'))
    expect(proposeCall).toBeTruthy()
    // The request carries the discovered signals and NEVER a preset (no auto-apply from the client).
    expect((proposeCall!.body as Record<string, unknown>).signals).toBeTruthy()
    expect((proposeCall!.body as Record<string, unknown>).preset).toBeUndefined()

    // AI output is clearly labelled advisory + shows reasoning and the deterministic cross-check.
    expect(root.querySelector('[data-testid="copilot-ai-chip"]')?.textContent).toContain('AI 建议·待确认')
    const row = root.querySelector('[data-testid="copilot-proposal-row"]')
    expect(row?.textContent).toContain('数量 (quantity)')
    expect(row?.textContent).toContain('the dictionary labels it')
    expect(row?.textContent).toContain('数量') // deterministic dict label
    // No authoritative preset is rendered before confirm.
    expect(root.querySelector('[data-testid="copilot-done"]')).toBeNull()
  })

  it('FAIL-OPEN: an unavailable boundary renders the manual chip + deterministic hint, not an error', async () => {
    routeMock({ propose: () => ok(proposeUnavailableData()) })
    const root = mountPanel({ scope: { tenantId: 'tenant_1' }, signals: signals() })
    await clickPropose(root)

    expect(root.querySelector('[data-testid="copilot-error"]')).toBeNull()
    const manual = root.querySelector('[data-testid="copilot-manual-chip"]')
    expect(manual?.textContent).toContain('AI 建议不可用')
    expect(manual?.textContent).toContain('business_data_cloud_forbidden')
    // The deterministic hint a human maps by hand is still shown.
    expect(root.querySelector('[data-testid="copilot-proposal-row"]')?.textContent).toContain('quantity')
  })

  it('CONFIRM posts the human-confirmed semantics with provenance and NO confirmedBy, then renders provenance', async () => {
    routeMock({})
    const root = mountPanel({ scope: { tenantId: 'tenant_1' }, signals: signals() })
    await clickPropose(root)

    // Confirm is a SEPARATE explicit action.
    ;(root.querySelector('[data-testid="copilot-confirm"]') as HTMLButtonElement).click()
    await flush()

    const confirmCall = calls.find((c) => c.url.includes('/confirm'))
    expect(confirmCall).toBeTruthy()
    const body = confirmCall!.body as Record<string, unknown>
    expect(body.presetId).toBe('dn-pdm-family')
    const confirmed = body.confirmedSemantics as Array<Record<string, unknown>>
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0].semantic).toBe('bom-line-quantity')
    expect(confirmed[0].source).toBe('ai-suggested')
    // confirmedBy is SERVER-STAMPED — the client never sends it.
    expect(body.confirmedBy).toBeUndefined()

    // The authoritative-artifact provenance is rendered.
    const done = root.querySelector('[data-testid="copilot-done"]')
    expect(done?.textContent).toContain('user_admin')
    expect(done?.textContent).toContain('dn-pdm-family')
  })

  it('a transport failure renders the clamped code, never the raw error body', async () => {
    routeMock({ propose: () => fail(400, 'SCHEMA_MAPPING_COPILOT_SIGNALS_INVALID', 'columns') })
    const root = mountPanel({ scope: { tenantId: 'tenant_1' }, signals: signals() })
    await clickPropose(root)

    const err = root.querySelector('[data-testid="copilot-error"]')
    expect(err?.textContent).toContain('SCHEMA_MAPPING_COPILOT_SIGNALS_INVALID')
    expect(root.textContent || '').not.toContain('secret-42007')
  })

  it('with no signals the panel shows the run-a-discovery-first guidance and cannot propose', async () => {
    routeMock({})
    const root = mountPanel({ scope: { tenantId: 'tenant_1' }, signals: null })
    expect(root.textContent).toContain('尚无来源结构信号')
    expect((root.querySelector('[data-testid="copilot-propose"]') as HTMLButtonElement).disabled).toBe(true)
  })
})
