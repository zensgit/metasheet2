import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
// Static top-level import for the same reason IntegrationWorkbenchView.spec.ts uses one: a dynamic
// import inside a test body pays this 5k-line SFC's first-time transform against that test's own
// 5000ms timeout, which is exactly how the #4614 integration-guard flake reproduced.
import View from '../src/views/IntegrationWorkbenchView.vue'

// G34 运行监控到达率 (docs/development/integration-monitoring-reach-design-20260910.md).
//
// This spec pins the REQUEST the 运行监控 section actually issues — the one thing neither the pure
// monitoringQuery unit tests (state → params) nor the section unit tests (DOM → state) can prove on
// their own — plus the response gate that keeps a slow earlier read from repainting a newer page.
// New FILE on purpose: IntegrationWorkbenchView.spec.ts is edited by several in-flight PRs.
const ElCard = defineComponent({
  name: 'ElCard',
  props: { shadow: { type: String, required: false, default: undefined } },
  setup(_props, { slots }) {
    return () => h('div', { class: 'el-card' }, [
      slots.header ? h('div', { class: 'el-card__header' }, slots.header()) : null,
      h('div', { class: 'el-card__body' }, slots.default?.()),
    ])
  },
})

const apiFetchMock = vi.fn()
const apiGetMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}))

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function pipelineRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run_g34',
    tenantId: 'default',
    workspaceId: null,
    pipelineId: 'pipe_g34',
    mode: 'manual',
    status: 'succeeded',
    rowsRead: 1,
    rowsCleaned: 1,
    rowsWritten: 1,
    rowsFailed: 0,
    ...overrides,
  }
}

describe('G34 运行监控到达率 (view → request)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let runUrls: string[] = []
  let deadLetterUrls: string[] = []

  beforeEach(() => {
    apiFetchMock.mockReset()
    apiGetMock.mockReset()
    apiGetMock.mockImplementation(async () => ({ ok: true, data: { items: [] } }))
    runUrls = []
    deadLetterUrls = []
    if (typeof localStorage?.clear === 'function') localStorage.clear()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  /**
   * @param runsFor answers the runs route; anything falsy falls back to an empty page.
   */
  function installFetchMock(
    runsFor: (url: string) => unknown | Promise<Response> | null = () => null,
    deadLettersFor: (url: string) => unknown | null = () => null,
  ): void {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/integration/runs?')) {
        runUrls.push(url)
        const answer = runsFor(url)
        if (answer instanceof Promise) return answer
        return jsonResponse(answer ?? [])
      }
      if (url.startsWith('/api/integration/dead-letters?')) {
        deadLetterUrls.push(url)
        return jsonResponse(deadLettersFor(url) ?? [])
      }
      // Bootstrap + every other section: an empty answer is enough for this spec.
      return jsonResponse([])
    })
  }

  async function mountView(): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('ElCard', ElCard)
    app.component('router-link', {
      props: ['to'],
      setup(_props, { slots }) {
        return () => h('a', slots.default?.())
      },
    })
    app.mount(container)
    await flushUi()
  }

  async function setPipelineId(pipelineId: string): Promise<void> {
    const input = container?.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement
    input.value = pipelineId
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
  }

  async function clickRefresh(): Promise<void> {
    ;(container?.querySelector('[data-testid="refresh-observation"]') as HTMLButtonElement).click()
    await flushUi()
  }

  async function chooseOption(testId: string, value: string): Promise<void> {
    const element = container?.querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
  }

  it('keeps the pre-G34 first screen URL byte-identical (current pipeline, limit 5, open dead letters)', async () => {
    installFetchMock()
    await mountView()
    await setPipelineId('pipe_g34')
    await clickRefresh()
    expect(runUrls).toEqual(['/api/integration/runs?tenantId=default&pipelineId=pipe_g34&limit=5'])
    expect(deadLetterUrls).toEqual(['/api/integration/dead-letters?tenantId=default&pipelineId=pipe_g34&status=open&limit=5'])
  })

  it('reads ACROSS pipelines with no pipelineId parameter at all when the scope is 全部管道', async () => {
    installFetchMock((url) => (url.includes('pipelineId') ? [] : [pipelineRun({ id: 'run_other', pipelineId: 'pipe_other' })]))
    await mountView()
    await setPipelineId('pipe_g34')
    await chooseOption('monitoring-pipeline-scope', 'all')

    expect(runUrls.at(-1)).toBe('/api/integration/runs?tenantId=default&limit=5')
    expect(deadLetterUrls.at(-1)).toBe('/api/integration/dead-letters?tenantId=default&status=open&limit=5')
    // A run belonging to a DIFFERENT pipeline is now reachable from this section.
    expect(container?.querySelector('[data-testid="pipeline-run-run_other"]')).not.toBeNull()
  })

  it('reads across pipelines with no saved pipeline instead of refusing to query (pre-G34 hard error)', async () => {
    installFetchMock(() => [pipelineRun({ id: 'run_nopipe' })])
    await mountView()
    await clickRefresh()
    expect(runUrls.at(-1)).toBe('/api/integration/runs?tenantId=default&limit=5')
    expect(container?.querySelector('[data-testid="pipeline-run-run_nopipe"]')).not.toBeNull()
  })

  it('sends the run status filter and the dead-letter status filter to their own routes', async () => {
    installFetchMock()
    await mountView()
    await setPipelineId('pipe_g34')
    await chooseOption('monitoring-run-status', 'failed')
    expect(runUrls.at(-1)).toBe('/api/integration/runs?tenantId=default&pipelineId=pipe_g34&status=failed&limit=5')
    // The run status must not leak into the dead-letter route (a different closed status set).
    expect(deadLetterUrls.at(-1)).toBe('/api/integration/dead-letters?tenantId=default&pipelineId=pipe_g34&status=open&limit=5')

    await chooseOption('monitoring-dead-letter-status', 'replayed')
    expect(deadLetterUrls.at(-1)).toBe('/api/integration/dead-letters?tenantId=default&pipelineId=pipe_g34&status=replayed&limit=5')
    expect(runUrls.at(-1)).toBe('/api/integration/runs?tenantId=default&pipelineId=pipe_g34&status=failed&limit=5')
  })

  it('pages with limit/offset and never emits offset=0 on the first page', async () => {
    // A FULL page is the only next-page evidence the backend gives (no total in the response).
    installFetchMock((url) => (url.includes('limit=20')
      ? Array.from({ length: 20 }, (_value, index) => pipelineRun({ id: `run_${index}` }))
      : []))
    await mountView()
    await setPipelineId('pipe_g34')
    await chooseOption('monitoring-page-size', '20')
    expect(runUrls.at(-1)).toBe('/api/integration/runs?tenantId=default&pipelineId=pipe_g34&limit=20')

    const next = container?.querySelector('[data-testid="monitoring-next-page"]') as HTMLButtonElement
    expect(next.disabled).toBe(false)
    next.click()
    await flushUi()
    expect(runUrls.at(-1)).toBe('/api/integration/runs?tenantId=default&pipelineId=pipe_g34&limit=20&offset=20')
    expect(deadLetterUrls.at(-1)).toBe('/api/integration/dead-letters?tenantId=default&pipelineId=pipe_g34&status=open&limit=20&offset=20')

    const prev = container?.querySelector('[data-testid="monitoring-prev-page"]') as HTMLButtonElement
    expect(prev.disabled).toBe(false)
    prev.click()
    await flushUi()
    expect(runUrls.at(-1)).toBe('/api/integration/runs?tenantId=default&pipelineId=pipe_g34&limit=20')
  })

  it('a slow EARLIER read cannot repaint the list after a newer read has landed (response gate)', async () => {
    let releaseFirstRead: (() => void) | null = null
    const firstRead = new Promise<Response>((resolve) => {
      releaseFirstRead = () => resolve(jsonResponse([pipelineRun({ id: 'run_stale' })]))
    })
    installFetchMock((url) => {
      // The unfiltered read (issued first) is held open; the filtered read answers immediately.
      if (url.includes('status=failed')) return [pipelineRun({ id: 'run_fresh', status: 'failed' })]
      return firstRead
    })
    await mountView()
    await setPipelineId('pipe_g34')

    // Read #1 is in flight and unanswered.
    ;(container?.querySelector('[data-testid="refresh-observation"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container?.querySelector('[data-testid="pipeline-run-run_stale"]')).toBeNull()

    // Read #2 (filter change) overtakes it and paints.
    await chooseOption('monitoring-run-status', 'failed')
    expect(container?.querySelector('[data-testid="pipeline-run-run_fresh"]')).not.toBeNull()

    // Now the superseded read finally answers — it must be dropped, not painted.
    releaseFirstRead?.()
    await flushUi()
    expect(container?.querySelector('[data-testid="pipeline-run-run_stale"]')).toBeNull()
    expect(container?.querySelector('[data-testid="pipeline-run-run_fresh"]')).not.toBeNull()
  })
})
