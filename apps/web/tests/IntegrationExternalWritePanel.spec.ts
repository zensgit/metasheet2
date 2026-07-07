import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import IntegrationExternalWritePanel from '../src/components/integration/IntegrationExternalWritePanel.vue'
import type { IntegrationExternalWriteDryRunResult } from '../src/services/integration/workbench'

// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — run-push decomposition): structural smoke test for the extracted external-write C6
// panel. `data-testid="external-write-panel"` is a mount anchor other specs query against, so its
// unconditional presence is pinned explicitly here.

describe('IntegrationExternalWritePanel (unit)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mountPanel(props: Record<string, unknown>): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationExternalWritePanel as unknown as Component, props)
      },
    })
    app = createApp(Host)
    app.mount(container)
    await nextTick()
  }

  const noopFn = (..._args: unknown[]): unknown => undefined

  function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      externalWriteCanDryRun: false,
      runningExternalWrite: '',
      externalWriteCanApply: false,
      externalWriteDryRunResult: null,
      externalWriteReviewSummary: '',
      externalWriteDryRunMetrics: [],
      externalWriteDryRunToken: '',
      externalWriteEvidenceText: '',
      externalWriteApplyResult: null,
      externalWriteApplyMetrics: [],
      externalWriteApplyRunId: '',
      dryRunExternalWrite: vi.fn(noopFn),
      applyExternalWrite: vi.fn(noopFn),
      externalWriteAcceptReview: false,
      'onUpdate:externalWriteAcceptReview': vi.fn(noopFn),
      ...overrides,
    }
  }

  it('always renders the external-write-panel mount anchor with boundary + permission-note copy', async () => {
    await mountPanel(baseProps())
    expect(container?.querySelector('[data-testid="external-write-panel"]')).toBeTruthy()
    expect(container?.querySelector('[data-testid="external-write-boundary"]')?.textContent).toContain('dry-run token 只保存在内存中')
    expect(container?.querySelector('[data-testid="external-write-permission-note"]')?.textContent).toContain('dry-run=read · apply=write/admin')
    // no dry-run result yet → review block absent
    expect(container?.querySelector('[data-testid="external-write-review"]')).toBeNull()
  })

  it('forwards the dry-run click and honours the can-dry-run disable gate', async () => {
    const dryRunExternalWrite = vi.fn(noopFn)
    await mountPanel(baseProps({ dryRunExternalWrite, externalWriteCanDryRun: true }))
    const button = container?.querySelector<HTMLButtonElement>('[data-testid="external-write-dry-run"]')
    expect(button?.disabled).toBe(false)
    button?.click()
    await nextTick()
    expect(dryRunExternalWrite).toHaveBeenCalledTimes(1)
    // apply stays disabled without a token/review
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="external-write-apply"]')?.disabled).toBe(true)
  })

  it('shows the review block for a dry-run result and forwards the accept-review checkbox through update:externalWriteAcceptReview', async () => {
    const onUpdateAcceptReview = vi.fn(noopFn)
    const dryRunResult = { status: 'ok', counts: { add: 1 } } as unknown as IntegrationExternalWriteDryRunResult
    await mountPanel(baseProps({
      externalWriteDryRunResult: dryRunResult,
      externalWriteReviewSummary: 'dry-run ok · add 1',
      'onUpdate:externalWriteAcceptReview': onUpdateAcceptReview,
    }))
    expect(container?.querySelector('[data-testid="external-write-review"]')?.textContent).toContain('dry-run ok · add 1')
    const checkbox = container?.querySelector<HTMLInputElement>('[data-testid="external-write-accept-review"]')
    expect(checkbox).toBeTruthy()
    if (checkbox) {
      checkbox.checked = true
      checkbox.dispatchEvent(new Event('change'))
    }
    await nextTick()
    expect(onUpdateAcceptReview).toHaveBeenCalledWith(true)
  })
})
