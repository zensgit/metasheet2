/**
 * C1/S2 first slice — the synthetic integration preview panel (MetaAutomationIntegrationPreview.vue) and its
 * client calls. Evidence D §5 / §7 C01 (web half), S02 (browser storage) and Y01 (no send/approve affordance):
 *   - hidden unless the server's catalog answers (switch OFF / not authorized => nothing rendered);
 *   - the request body is exactly { planId, fixtureId, mappingPresetId } on its own endpoint (never /test);
 *   - the result lives in panel memory only: no localStorage / sessionStorage / IndexedDB write, cleared on
 *     cancel, on clear, when the drawer closes and on unmount;
 *   - cancel aborts the in-flight request; no send / approve / submit button exists;
 *   - a payload that claims any authority (canSend, canApply, tokenIssued, externalWriteAttempted) is not shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaAutomationIntegrationPreview from '../src/multitable/components/MetaAutomationIntegrationPreview.vue'
import { MultitableApiClient } from '../src/multitable/api/client'

const SENTINEL = 'SYN-DRW-001'
const CATALOG = {
  planId: 'plm-material-to-yida-preview.v1',
  operation: { id: 'plm.material.list.synthetic.v1', version: 1 },
  consumer: 'yida.preview.synthetic.v1',
  fixtureIds: ['synthetic-materials.two-page.v1', 'synthetic-materials.single-page.v1'],
  mappingPresetIds: ['yida-material-v3.original.v1', 'yida-material-v3.allocated.v1'],
  budget: { maxPages: 5, maxRows: 100, maxBytes: 262144, maxInFlight: 1, deadlineMs: 10000 },
}
const RESULT = {
  ok: true,
  synthetic: true,
  summary: {
    outcome: 'OK', fixtureId: 'synthetic-materials.two-page.v1', mappingPresetId: 'yida-material-v3.original.v1',
    counts: { pages: 2, rows: 3, bytes: 900 }, durationMs: 12, steps: [],
  },
  preview: {
    intent: 'create', rowCount: 1, planDigest: 'a'.repeat(64), keyDefinitionDigest: 'b'.repeat(64), locatorDigest: 'c'.repeat(64),
    rows: [{ index: 0, status: 'planned_create', businessKeyDigest: 'd'.repeat(64), payloadDigest: 'e'.repeat(64), fields: { drawingNo: SENTINEL, totalQty: 4 } }],
  },
  canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false,
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

describe('MetaAutomationIntegrationPreview', () => {
  let app: App | null = null
  let container: HTMLElement
  const storageWrites: string[] = []

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    storageWrites.length = 0
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => { storageWrites.push(key) })
    if (typeof indexedDB !== 'undefined') vi.spyOn(indexedDB, 'open').mockImplementation(() => { storageWrites.push('indexedDB'); throw new Error('no') })
  })

  afterEach(() => {
    app?.unmount()
    app = null
    container.remove()
    vi.restoreAllMocks()
  })

  function mount(fetchFn: (url: string, init?: RequestInit) => Promise<Response>, visible = true) {
    const client = new MultitableApiClient({ fetchFn: fetchFn as never })
    const state = reactive({ visible })
    app = createApp({
      render: () => h(MetaAutomationIntegrationPreview, {
        visible: state.visible,
        sheetId: 'sheet_1',
        rules: [{ id: 'rule_1', name: 'Synthetic rule' }],
        client,
      }),
    })
    app.mount(container)
    return state
  }

  it('renders nothing while the switch is off (catalog refused)', async () => {
    const fetchFn = vi.fn(async () => json(404, { ok: false, error: { code: 'INTEGRATION_PREVIEW_DISABLED', message: 'x' } }))
    mount(fetchFn)
    await flush()
    expect(container.querySelector('[data-integration-preview]')).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(fetchFn.mock.calls[0][0])).toContain('/automations/integration-preview/catalog')
  })

  it('does not even ask while the drawer is closed', async () => {
    const fetchFn = vi.fn(async () => json(200, { ok: true, catalog: CATALOG }))
    mount(fetchFn, false)
    await flush()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(container.querySelector('[data-integration-preview]')).toBeNull()
  })

  it('runs on its own endpoint with exactly the three fixed ids and keeps the result in memory only', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/integration-preview/catalog')) return json(200, { ok: true, enabled: true, catalog: CATALOG })
      return json(200, RESULT)
    })
    const state = mount(fetchFn)
    await flush()
    expect(container.querySelector('[data-integration-preview-badge]')?.textContent).toBeTruthy()
    // No send / approve / submit affordance anywhere in the panel.
    const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent ?? '')
    expect(buttons.join(' ')).not.toMatch(/发送|批准|提交|send|approve|submit/i)
    ;(container.querySelector('[data-integration-preview-run]') as HTMLButtonElement).click()
    await flush()
    const post = calls.find((call) => call.init?.method === 'POST')!
    expect(post.url).toBe('/api/multitable/sheets/sheet_1/automations/rule_1/integration-preview')
    expect(post.url).not.toMatch(/\/test$/)
    expect(JSON.parse(String(post.init?.body))).toEqual({
      planId: 'plm-material-to-yida-preview.v1', fixtureId: 'synthetic-materials.two-page.v1', mappingPresetId: 'yida-material-v3.original.v1',
    })
    expect(container.querySelector('[data-integration-preview-rows]')?.textContent).toContain(SENTINEL)
    expect(container.querySelector('[data-integration-preview-no-send]')).not.toBeNull()
    expect(storageWrites).toEqual([])
    // Closing the drawer clears the panel memory.
    state.visible = false
    await flush()
    expect(container.textContent ?? '').not.toContain(SENTINEL)
  })

  it('cancel aborts the in-flight request and shows no result', async () => {
    let captured: AbortSignal | undefined
    const fetchFn = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/integration-preview/catalog')) return Promise.resolve(json(200, { ok: true, catalog: CATALOG }))
      captured = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    mount(fetchFn)
    await flush()
    ;(container.querySelector('[data-integration-preview-run]') as HTMLButtonElement).click()
    await flush()
    expect(container.querySelector('[data-integration-preview-status="running"]')).not.toBeNull()
    ;(container.querySelector('[data-integration-preview-cancel]') as HTMLButtonElement).click()
    await flush()
    expect(captured?.aborted).toBe(true)
    expect(container.querySelector('[data-integration-preview-result]')).toBeNull()
    expect(container.querySelector('[data-integration-preview-status="running"]')).toBeNull()
  })

  it('a fixed refusal code is shown as text; no value from the server message is rendered', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/integration-preview/catalog')) return json(200, { ok: true, catalog: CATALOG })
      return json(403, { ok: false, error: { code: 'INTEGRATION_PREVIEW_DENIED', message: `server says ${SENTINEL}` } })
    })
    mount(fetchFn)
    await flush()
    ;(container.querySelector('[data-integration-preview-run]') as HTMLButtonElement).click()
    await flush()
    const status = container.querySelector('[data-integration-preview-status="error"]')
    expect(status?.getAttribute('data-code')).toBe('INTEGRATION_PREVIEW_DENIED')
    expect(container.textContent ?? '').not.toContain(SENTINEL)
  })

  it('a payload that claims any send/apply authority is refused, not displayed', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/integration-preview/catalog')) return json(200, { ok: true, catalog: CATALOG })
      return json(200, { ...RESULT, canSend: true })
    })
    mount(fetchFn)
    await flush()
    ;(container.querySelector('[data-integration-preview-run]') as HTMLButtonElement).click()
    await flush()
    expect(container.querySelector('[data-integration-preview-result]')).toBeNull()
    expect(container.textContent ?? '').not.toContain(SENTINEL)
  })

  it('unmount drops the result and aborts nothing left behind', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/integration-preview/catalog')) return json(200, { ok: true, catalog: CATALOG })
      return json(200, RESULT)
    })
    mount(fetchFn)
    await flush()
    ;(container.querySelector('[data-integration-preview-run]') as HTMLButtonElement).click()
    await flush()
    expect(container.textContent ?? '').toContain(SENTINEL)
    app?.unmount()
    app = null
    expect(container.textContent ?? '').not.toContain(SENTINEL)
    expect(storageWrites).toEqual([])
  })
})
