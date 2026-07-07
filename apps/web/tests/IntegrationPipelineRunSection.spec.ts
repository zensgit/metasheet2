import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationPipelineRunSection from '../src/components/integration/IntegrationPipelineRunSection.vue'
import type { ReadinessItem, SourceFieldOption } from '../src/components/integration/integrationWorkbenchSectionTypes'

// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — run-push decomposition): structural smoke test for the extracted pipeline
// config + run-trigger sub-panel — a light isolation check, not a re-test of behavior already
// covered via the parent's unchanged 50 tests (same rationale as the IU-2b/IU-2c section specs).

describe('IntegrationPipelineRunSection (unit)', () => {
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
        return () => h(IntegrationPipelineRunSection as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.mount(container)
    await nextTick()
  }

  const noopFn = (..._args: unknown[]): unknown => undefined

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      generatedPipelineName: 'auto-pipeline-name',
      showWatermarkConfig: false,
      hasSourceFieldOptions: false,
      sourceFieldOptionsForValue: (_value: string): SourceFieldOption[] => [],
      sourceFieldOptionText: (option: SourceFieldOption): string => option.label,
      watermarkConfigError: '',
      stagingDescriptors: [],
      savePipelineBlockedSummary: '还缺 2 项',
      dryRunBlockedSummary: '还缺 1 项',
      dryRunReadinessItems: [
        { id: 'source-system', label: '选择可读取的数据源', ready: false, detail: '还没有选择数据源' },
      ] as ReadinessItem[],
      runningPipeline: '',
      canRunPipeline: false,
      dryRunEmptyPreviewNotice: '',
      useGeneratedPipelineName: vi.fn(noopFn),
      executePipeline: vi.fn(noopFn),
      pipelineName: '',
      pipelineMode: 'manual',
      watermarkType: 'updated_at',
      watermarkField: '',
      watermarkTiebreaker: '',
      idempotencyFieldsText: 'code',
      stagingSheetId: '',
      savedPipelineId: '',
      pipelineRunMode: 'manual',
      pipelineSampleLimit: '20',
      allowSaveOnlyRun: false,
      'onUpdate:pipelineName': vi.fn(noopFn),
      'onUpdate:allowSaveOnlyRun': vi.fn(noopFn),
      ...overrides,
    }
  }

  it('renders the pipeline config grid, readiness block, and run buttons; watermark config only in incremental mode', async () => {
    await mountSection(baseProps())
    expect(container?.querySelector('[data-testid="pipeline-name"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="pipeline-mode"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="pipeline-readiness"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="run-push-explainer"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="run-dry-run"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="run-save-only"]')).toBeTruthy()
    // watermark config is v-if'd on showWatermarkConfig (pipelineMode === 'incremental' upstream)
    expect(container?.querySelector('[data-testid="watermark-config"]')).toBeNull()

    await mountSection(baseProps({ showWatermarkConfig: true }))
    expect(container?.querySelector('[data-testid="watermark-config"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="watermark-type"]')).toBeTruthy()
  })

  it('forwards run-dry-run click to executePipeline(true) when runnable, and keeps save-only gated on allowSaveOnlyRun', async () => {
    const executePipeline = vi.fn(noopFn)
    await mountSection(baseProps({ executePipeline, canRunPipeline: true, allowSaveOnlyRun: false }))
    const dryRun = container?.querySelector<HTMLButtonElement>('[data-testid="run-dry-run"]')
    expect(dryRun?.disabled).toBe(false)
    dryRun?.click()
    await nextTick()
    expect(executePipeline).toHaveBeenCalledWith(true)
    // save-only stays disabled until the user ticks allow-save-only-run, even when runnable
    const saveOnly = container?.querySelector<HTMLButtonElement>('[data-testid="run-save-only"]')
    expect(saveOnly?.disabled).toBe(true)
  })

  it('forwards pipeline-name input through update:pipelineName (defineModel wiring)', async () => {
    const onUpdatePipelineName = vi.fn(noopFn)
    await mountSection(baseProps({ 'onUpdate:pipelineName': onUpdatePipelineName }))
    const input = container?.querySelector<HTMLInputElement>('[data-testid="pipeline-name"]')
    expect(input).toBeTruthy()
    if (input) {
      input.value = '物料清洗流程'
      input.dispatchEvent(new Event('input'))
    }
    await nextTick()
    expect(onUpdatePipelineName).toHaveBeenCalledWith('物料清洗流程')
  })
})
