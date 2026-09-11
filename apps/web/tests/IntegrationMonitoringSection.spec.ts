import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import IntegrationMonitoringSection from '../src/components/integration/IntegrationMonitoringSection.vue'
import {
  buildDeadLetterRequestParams,
  buildRunsRequestParams,
  createMonitoringQueryState,
  type MonitoringQueryState,
} from '../src/services/integration/monitoringQuery'
import type { IntegrationDeadLetter, IntegrationPipelineRun } from '../src/services/integration/workbench'

// IU-2b (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage B): structural smoke test for the extracted monitoring section — the bulk of its
// behavior is already covered by tests/IntegrationWorkbenchView.spec.ts's unchanged 50 tests
// (mounted through the parent, exercising the same DOM this component now renders). This spec
// only proves the component renders correctly in isolation with a minimal prop contract.
//
// G34 (docs/development/integration-monitoring-reach-design-20260910.md) added the reach controls
// (cross-pipeline / status / paging / errorCode groups / 5s polling), so this spec also owns them:
// the component decides WHICH pure transition each control applies and owns the poll timer, while
// the resulting REQUEST URLs are pinned end-to-end in tests/integrationMonitoringReach.spec.ts.
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
const SCOPE = { tenantId: 'default', workspaceId: null }

describe('IntegrationMonitoringSection (unit)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  const liveProps = ref<Record<string, unknown>>({})

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.useRealTimers()
  })

  async function mountSection(props: Record<string, unknown>): Promise<void> {
    liveProps.value = props
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationMonitoringSection as unknown as Component, liveProps.value)
      },
    })
    app = createApp(Host)
    app.component('ElCard', ElCard)
    app.mount(container)
    await nextTick()
  }

  async function updateProps(patch: Record<string, unknown>): Promise<void> {
    liveProps.value = { ...liveProps.value, ...patch }
    await nextTick()
  }

  const noopFn = (..._args: unknown[]): unknown => undefined

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      observationSummary: '0 runs / 0 open dead letters',
      observingPipeline: false,
      monitoringQuery: createMonitoringQueryState(),
      monitoringError: '',
      currentPipelineId: 'pipe_1',
      applyMonitoringQuery: vi.fn(noopFn),
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
      pollPipelineObservation: vi.fn(noopFn),
      toggleRunSummaries: vi.fn(noopFn),
      requestReplay: vi.fn(noopFn),
      cancelReplay: vi.fn(noopFn),
      replayDeadLetter: vi.fn(noopFn),
      toggleDeadLetterProvenance: vi.fn(noopFn),
      ...overrides,
    }
  }

  function run(overrides: Partial<IntegrationPipelineRun> = {}): IntegrationPipelineRun {
    return {
      id: 'run-1',
      status: 'succeeded',
      mode: 'manual',
      pipelineId: 'pipe_1',
      rowsRead: 3,
      rowsCleaned: 3,
      rowsWritten: 3,
      rowsFailed: 0,
      ...overrides,
    } as IntegrationPipelineRun
  }

  function deadLetter(overrides: Partial<IntegrationDeadLetter> = {}): IntegrationDeadLetter {
    return {
      id: 'dl-1',
      runId: 'run-1',
      pipelineId: 'pipe_1',
      errorCode: 'VALIDATION_FAILED',
      errorMessage: 'x',
      status: 'open',
      ...overrides,
    } as IntegrationDeadLetter
  }

  function select(testId: string): HTMLSelectElement {
    return container?.querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement
  }

  function lastAppliedQuery(applyMonitoringQuery: ReturnType<typeof vi.fn>): MonitoringQueryState {
    const calls = applyMonitoringQuery.mock.calls
    return calls[calls.length - 1][0] as MonitoringQueryState
  }

  async function chooseOption(testId: string, value: string): Promise<void> {
    const element = select(testId)
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
  }

  it('renders the section id and both empty states when there is no data', async () => {
    await mountSection(baseProps())
    expect(container?.querySelector('#int-sec-monitoring')).toBeTruthy()
    expect(container?.querySelector('[data-testid="pipeline-runs-empty"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="dead-letters-empty"]')).toBeTruthy()
    // IU-6 guided empty-state copy (what-this-is + first-step) rides through the IU-2b extraction —
    // pin both sub-testids here (the parent view spec doesn't assert them, so without this the
    // extracted component could drop the guidance and stay green — quality-gate finding).
    expect(container?.querySelector('[data-testid="dead-letters-empty-what"]')?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    expect(container?.querySelector('[data-testid="dead-letters-empty-first-step"]')?.textContent?.trim().length ?? 0).toBeGreaterThan(0)
  })

  it('renders a pipeline run row and forwards the refresh click to the prop function', async () => {
    const refreshPipelineObservation = vi.fn(noopFn)
    await mountSection(baseProps({ pipelineRuns: [run({ status: 'success' })], refreshPipelineObservation }))
    expect(container?.querySelector('[data-testid="pipeline-run-run-1"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="run-status-run-1"]')?.textContent).toContain('success')
    const refreshButton = container?.querySelector<HTMLButtonElement>('[data-testid="refresh-observation"]')
    refreshButton?.click()
    await nextTick()
    expect(refreshPipelineObservation).toHaveBeenCalledWith(false)
  })

  it('G34: switching the pipeline scope to 全部管道 produces a query with NO pipelineId', async () => {
    const applyMonitoringQuery = vi.fn(noopFn)
    await mountSection(baseProps({ applyMonitoringQuery }))
    // Default ('current') still resolves to the workbench pipeline.
    expect(buildRunsRequestParams(createMonitoringQueryState(), SCOPE, 'pipe_1').pipelineId).toBe('pipe_1')

    await chooseOption('monitoring-pipeline-scope', 'all')
    const applied = lastAppliedQuery(applyMonitoringQuery)
    expect(applied.pipelineScope).toBe('all')
    // The emitted state is what the loader feeds to the builder: assert the REQUEST, not the flag.
    expect(buildRunsRequestParams(applied, SCOPE, 'pipe_1')).not.toHaveProperty('pipelineId')
    expect(buildDeadLetterRequestParams(applied, SCOPE, 'pipe_1')).not.toHaveProperty('pipelineId')
  })

  it('G34: a typed custom pipeline id reaches the query; the input only exists in custom scope', async () => {
    const applyMonitoringQuery = vi.fn(noopFn)
    await mountSection(baseProps({ applyMonitoringQuery }))
    expect(container?.querySelector('[data-testid="monitoring-pipeline-id"]')).toBeNull()

    await updateProps({ monitoringQuery: createMonitoringQueryState({ pipelineScope: 'custom' }) })
    const input = container?.querySelector('[data-testid="monitoring-pipeline-id"]') as HTMLInputElement
    expect(input).toBeTruthy()
    input.value = 'pipe_other'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(buildRunsRequestParams(lastAppliedQuery(applyMonitoringQuery), SCOPE, 'pipe_1').pipelineId).toBe('pipe_other')
  })

  it('G34: run/dead-letter status filters map to their own backend-valid parameter', async () => {
    const applyMonitoringQuery = vi.fn(noopFn)
    await mountSection(baseProps({ applyMonitoringQuery }))

    await chooseOption('monitoring-run-status', 'failed')
    const afterRunStatus = lastAppliedQuery(applyMonitoringQuery)
    expect(buildRunsRequestParams(afterRunStatus, SCOPE, 'pipe_1').status).toBe('failed')
    // The run status must NOT bleed into the dead-letter request (different closed set).
    expect(buildDeadLetterRequestParams(afterRunStatus, SCOPE, 'pipe_1').status).toBe('open')

    await updateProps({ monitoringQuery: afterRunStatus })
    await chooseOption('monitoring-dead-letter-status', '')
    const afterDeadLetterStatus = lastAppliedQuery(applyMonitoringQuery)
    expect(buildDeadLetterRequestParams(afterDeadLetterStatus, SCOPE, 'pipe_1')).not.toHaveProperty('status')
    expect(buildRunsRequestParams(afterDeadLetterStatus, SCOPE, 'pipe_1').status).toBe('failed')
  })

  it('G34: paging buttons are disabled at the boundaries and advance/rewind by the page size', async () => {
    const applyMonitoringQuery = vi.fn(noopFn)
    const shortPage = [run({ id: 'run-1' })]
    await mountSection(baseProps({ applyMonitoringQuery, pipelineRuns: shortPage }))
    const prev = () => container?.querySelector('[data-testid="monitoring-prev-page"]') as HTMLButtonElement
    const next = () => container?.querySelector('[data-testid="monitoring-next-page"]') as HTMLButtonElement

    // Page 1 + a SHORT page: nothing before, and no evidence of anything after.
    expect(prev().disabled).toBe(true)
    expect(next().disabled).toBe(true)

    // A FULL page is the only "there may be more" signal the backend gives (no total).
    const fullPage = Array.from({ length: 5 }, (_value, index) => run({ id: `run-${index}` }))
    await updateProps({ pipelineRuns: fullPage })
    expect(next().disabled).toBe(false)
    next().click()
    await nextTick()
    expect(lastAppliedQuery(applyMonitoringQuery).offset).toBe(5)

    // The dead-letter list alone being full must also keep 下一页 reachable (one shared cursor).
    await updateProps({
      pipelineRuns: shortPage,
      deadLetters: Array.from({ length: 5 }, (_value, index) => deadLetter({ id: `dl-${index}` })),
    })
    expect(next().disabled).toBe(false)

    await updateProps({ monitoringQuery: createMonitoringQueryState({ offset: 5 }), deadLetters: [] })
    expect(prev().disabled).toBe(false)
    expect(container?.querySelector('[data-testid="monitoring-page-indicator"]')?.textContent).toContain('第 2 页')
    prev().click()
    await nextTick()
    expect(lastAppliedQuery(applyMonitoringQuery).offset).toBe(0)
  })

  it('G34: page size changes the limit and resets the cursor to the first page', async () => {
    const applyMonitoringQuery = vi.fn(noopFn)
    await mountSection(baseProps({
      applyMonitoringQuery,
      monitoringQuery: createMonitoringQueryState({ offset: 20 }),
    }))
    await chooseOption('monitoring-page-size', '50')
    const applied = lastAppliedQuery(applyMonitoringQuery)
    expect(applied.pageSize).toBe(50)
    expect(applied.offset).toBe(0)
    expect(buildRunsRequestParams(applied, SCOPE, 'pipe_1').limit).toBe(50)
  })

  it('G34: the count line stops claiming "open" once another dead-letter status is selected', async () => {
    await mountSection(baseProps({
      observationSummary: '1 runs / 1 open dead letters',
      pipelineRuns: [run()],
      deadLetters: [deadLetter({ status: 'replayed' })],
    }))
    // Default filter ('open'): the parent's wording is reused verbatim.
    expect(container?.querySelector('[data-testid="monitoring-summary"]')?.textContent).toContain('1 runs / 1 open dead letters')

    await updateProps({ monitoringQuery: createMonitoringQueryState({ deadLetterStatus: 'replayed' }) })
    const summary = container?.querySelector('[data-testid="monitoring-summary"]')?.textContent ?? ''
    expect(summary).not.toContain('open dead letters')
    expect(summary).toContain('replayed')
  })

  it('G34: dead letters get an errorCode count header computed over the loaded page', async () => {
    await mountSection(baseProps({
      deadLetters: [
        deadLetter({ id: 'dl-1', errorCode: 'VALIDATION_FAILED' }),
        deadLetter({ id: 'dl-2', errorCode: 'VALIDATION_FAILED' }),
        deadLetter({ id: 'dl-3', errorCode: 'K3_SAVE_FAILED' }),
      ],
    }))
    const groups = container?.querySelector('[data-testid="dead-letter-error-groups"]')
    expect(groups).toBeTruthy()
    expect(container?.querySelector('[data-testid="dead-letter-group-VALIDATION_FAILED"]')?.textContent).toContain('2')
    expect(container?.querySelector('[data-testid="dead-letter-group-K3_SAVE_FAILED"]')?.textContent).toContain('1')
    // The header must say the count is page-scoped — the backend returns no totals.
    expect(container?.querySelector('[data-testid="dead-letter-groups-scope"]')?.textContent).toContain('当前这一页')
  })

  it('G34: run detail expands the fields the LIST ROW already carries (there is no GET /runs/:id)', async () => {
    await mountSection(baseProps({
      pipelineRuns: [run({ id: 'run-9', status: 'partial', rowsFailed: 2, errorSummary: '2 rows failed' })],
      deadLetters: [deadLetter({ id: 'dl-1', runId: 'run-9' }), deadLetter({ id: 'dl-2', runId: 'run-9' })],
    }))
    expect(container?.querySelector('[data-testid="run-detail-run-9"]')).toBeNull()
    ;(container?.querySelector('[data-testid="toggle-run-detail-run-9"]') as HTMLButtonElement).click()
    await nextTick()
    const detail = container?.querySelector('[data-testid="run-detail-run-9"]') as HTMLElement
    expect(detail).toBeTruthy()
    expect(detail.textContent).toContain('2 rows failed')
    expect(container?.querySelector('[data-testid="run-dead-letter-count-run-9"]')?.textContent).toContain('2')
    expect(container?.querySelector('[data-testid="run-detail-source-run-9"]')?.textContent).toContain('GET /runs/:id')
  })

  it('X1: a filter change that did NOT commit snaps the control back and surfaces the error', async () => {
    // The view commits the cursor only together with the rows, so a FAILED read leaves
    // `monitoringQuery` on the old value. The control must not keep claiming the filter the
    // operator picked — that is the "new label, old rows" bug this guards.
    const applyMonitoringQuery = vi.fn(noopFn)
    await mountSection(baseProps({
      applyMonitoringQuery,
      deadLetters: [deadLetter({ id: 'dl-open', status: 'open' })],
    }))
    await chooseOption('monitoring-dead-letter-status', 'discarded')
    expect(applyMonitoringQuery).toHaveBeenCalledTimes(1)
    // Cursor did not move (the mock never changed the prop) → the select is back on open.
    expect(select('monitoring-dead-letter-status').value).toBe('open')
    expect(container?.querySelector('[data-testid="dead-letter-dl-open"]')).not.toBeNull()
    expect(container?.textContent).not.toContain('Dead Letters（discarded）')

    await updateProps({ monitoringError: '监控读取失败，筛选/翻页未生效：boom' })
    const error = container?.querySelector('[data-testid="monitoring-error"]')
    expect(error).not.toBeNull()
    expect(error?.textContent).toContain('未生效')
  })

  it('X1: a page turn that did NOT commit leaves the page indicator on the page that is showing', async () => {
    const applyMonitoringQuery = vi.fn(noopFn)
    await mountSection(baseProps({
      applyMonitoringQuery,
      pipelineRuns: Array.from({ length: 5 }, (_value, index) => run({ id: `run-${index}` })),
    }))
    const next = container?.querySelector('[data-testid="monitoring-next-page"]') as HTMLButtonElement
    next.click()
    await nextTick()
    expect(applyMonitoringQuery).toHaveBeenCalledTimes(1)
    expect(container?.querySelector('[data-testid="monitoring-page-indicator"]')?.textContent).toContain('第 1 页')
    expect(container?.querySelector('[data-testid="monitoring-page-indicator"]')?.textContent).toContain('offset 0')
  })

  it('X2: every dead-letter row names its pipeline, and so does the real-write confirm button', async () => {
    await mountSection(baseProps({
      deadLetters: [deadLetter({ id: 'dl-x', pipelineId: 'pipe_other', status: 'open' })],
      isDeadLetterReplayable: () => true,
      confirmReplayDeadLetterId: 'dl-x',
    }))
    expect(container?.querySelector('[data-testid="dead-letter-meta-dl-x"]')?.textContent).toContain('pipeline pipe_other')
    const confirm = container?.querySelector('[data-testid="confirm-replay-dead-letter-dl-x"]') as HTMLButtonElement
    expect(confirm.getAttribute('title')).toContain('pipe_other')
    expect(confirm.getAttribute('title')).toContain('真实写入')
  })

  // P2 (#5612): the timer calls the BACKGROUND door only. The operator's door
  // (`refreshPipelineObservation`) must stay untouched by the poll, because the loader behind it
  // gives manual reads priority — a poll arriving there would preempt the operator's own read.
  it('G34: polls every 5s while a run is running, and stops as soon as none is', async () => {
    vi.useFakeTimers()
    const refreshPipelineObservation = vi.fn(noopFn)
    const pollPipelineObservation = vi.fn(noopFn)
    await mountSection(baseProps({
      refreshPipelineObservation,
      pollPipelineObservation,
      pipelineRuns: [run({ id: 'run-r', status: 'running' })],
    }))
    expect(container?.querySelector('[data-testid="monitoring-polling"]')).toBeTruthy()

    vi.advanceTimersByTime(5000)
    expect(pollPipelineObservation).toHaveBeenCalledTimes(1)
    // The poll NEVER enters through the operator's door.
    expect(refreshPipelineObservation).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect(pollPipelineObservation).toHaveBeenCalledTimes(2)

    // The run finished: the timer must go away (nothing left that can change).
    await updateProps({ pipelineRuns: [run({ id: 'run-r', status: 'succeeded' })] })
    expect(container?.querySelector('[data-testid="monitoring-polling"]')).toBeNull()
    vi.advanceTimersByTime(20000)
    expect(pollPipelineObservation).toHaveBeenCalledTimes(2)
    expect(refreshPipelineObservation).not.toHaveBeenCalled()
  })

  it('G34: never polls when nothing is running', async () => {
    vi.useFakeTimers()
    const pollPipelineObservation = vi.fn(noopFn)
    await mountSection(baseProps({ pollPipelineObservation, pipelineRuns: [run({ status: 'succeeded' })] }))
    expect(container?.querySelector('[data-testid="monitoring-polling"]')).toBeNull()
    vi.advanceTimersByTime(30000)
    expect(pollPipelineObservation).not.toHaveBeenCalled()
  })

  it('G34: unmount clears the poll timer (an interval outliving the section keeps fetching forever)', async () => {
    vi.useFakeTimers()
    const pollPipelineObservation = vi.fn(noopFn)
    await mountSection(baseProps({
      pollPipelineObservation,
      pipelineRuns: [run({ id: 'run-r', status: 'running' })],
    }))
    vi.advanceTimersByTime(5000)
    expect(pollPipelineObservation).toHaveBeenCalledTimes(1)

    app?.unmount()
    app = null
    vi.advanceTimersByTime(60000)
    expect(pollPipelineObservation).toHaveBeenCalledTimes(1)
  })
})
