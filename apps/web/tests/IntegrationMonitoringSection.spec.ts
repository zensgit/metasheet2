import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationMonitoringSection from '../src/components/integration/IntegrationMonitoringSection.vue'
import type { IntegrationDeadLetter, IntegrationPipelineRun } from '../src/services/integration/workbench'

// IU-2b (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage B): structural smoke test for the extracted monitoring section — the bulk of its
// behavior is already covered by tests/IntegrationWorkbenchView.spec.ts's unchanged 50 tests
// (mounted through the parent, exercising the same DOM this component now renders). This spec
// only proves the component renders correctly in isolation with a minimal prop contract.
//
// ElCard stub: mirrors the same pattern already used in IntegrationWorkbenchView.spec.ts /
// IntegrationWorkbenchRail.spec.ts — real Element Plus is not globally installed in this test's
// createApp() instance.
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

const bi = (zh: string, _en: string): string => zh

describe('IntegrationMonitoringSection (unit)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountSection(props: Record<string, unknown>): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationMonitoringSection as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.component('ElCard', ElCard)
    app.mount(container)
    await nextTick()
  }

  const noopFn = (..._args: unknown[]): unknown => undefined

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      observationSummary: '0 runs / 0 open dead letters',
      observingPipeline: false,
      pipelineRuns: [] as IntegrationPipelineRun[],
      deadLetters: [] as IntegrationDeadLetter[],
      bi,
      runRowSummaries: () => [],
      isRunExpanded: () => false,
      deadLetterErrorLabel: () => '',
      deadLetterErrorHint: () => null,
      isDeadLetterReplayable: () => false,
      confirmReplayDeadLetterId: '',
      replayingDeadLetterId: '',
      canViewRowProvenance: () => false,
      isRowProvenanceExpanded: () => false,
      isRowProvenanceLoading: () => false,
      rowProvenanceError: () => '',
      rowProvenanceTimeline: () => [],
      rowProvenanceAttrsSummary: () => '',
      refreshPipelineObservation: vi.fn(noopFn),
      toggleRunSummaries: vi.fn(noopFn),
      requestReplay: vi.fn(noopFn),
      cancelReplay: vi.fn(noopFn),
      replayDeadLetter: vi.fn(noopFn),
      toggleDeadLetterProvenance: vi.fn(noopFn),
      ...overrides,
    }
  }

  it('renders the section id and both empty states when there is no data', async () => {
    await mountSection(baseProps())
    expect(container?.querySelector('#int-sec-monitoring')).toBeTruthy()
    expect(container?.querySelector('[data-testid="pipeline-runs-empty"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="dead-letters-empty"]')).toBeTruthy()
  })

  it('renders a pipeline run row and forwards the refresh click to the prop function', async () => {
    const refreshPipelineObservation = vi.fn(noopFn)
    const run: IntegrationPipelineRun = {
      id: 'run-1',
      status: 'success',
      mode: 'manual',
      rowsRead: 3,
      rowsCleaned: 3,
      rowsWritten: 3,
      rowsFailed: 0,
    } as IntegrationPipelineRun
    await mountSection(baseProps({ pipelineRuns: [run], refreshPipelineObservation }))
    expect(container?.querySelector('[data-testid="pipeline-run-run-1"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="run-status-run-1"]')?.textContent).toContain('success')
    const refreshButton = container?.querySelector<HTMLButtonElement>('[data-testid="refresh-observation"]')
    refreshButton?.click()
    await nextTick()
    expect(refreshPipelineObservation).toHaveBeenCalledWith(false)
  })
})
