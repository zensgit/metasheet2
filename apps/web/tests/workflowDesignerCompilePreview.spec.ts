import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ buildAuthHeaders: () => ({}) }),
}))

import {
  compileWorkflowPreview,
  normalizeCompilePreview,
  type WorkflowCompilePreview,
} from '../src/views/workflowDesignerPersistence'
import WorkflowCompilePreviewPanel from '../src/components/workflow/WorkflowCompilePreviewPanel.vue'

function flushUi(cycles = 4): Promise<void> {
  return Promise.all(
    Array.from({ length: cycles }).map(() => Promise.resolve().then(() => nextTick())),
  ).then(() => undefined)
}

function supportedEnvelope() {
  return {
    success: true,
    data: {
      source: { workflowId: 'wf_1', mode: 'visual', sourceVersion: 3 },
      supported: true,
      automationPreview: {
        actions: [{ type: 'update_record' }, { type: 'send_notification' }],
        requiresExecutionMode: 'workflow_job_v1',
      },
      approvalPreview: { formSchema: {}, approvalGraph: {}, runtimeGraphPreview: null },
      mappingReport: [
        {
          bpmnElementId: 'Task_1',
          bpmnElementType: 'bpmn:ServiceTask',
          target: 'automation',
          targetKind: 'update_record',
        },
        {
          bpmnElementId: 'Gateway_1',
          bpmnElementType: 'bpmn:ExclusiveGateway',
          target: 'automation',
          targetKind: 'condition_branch',
        },
      ],
      gapReport: [],
      warnings: ['start event treated as structural'],
    },
  }
}

function unsupportedEnvelope() {
  return {
    success: true,
    data: {
      source: { workflowId: 'wf_2', mode: 'bpmn_xml', sourceVersion: 1 },
      supported: false,
      mappingReport: [],
      gapReport: [
        {
          bpmnElementId: 'Task_wait',
          bpmnElementType: 'bpmn:ReceiveTask',
          reason: 'branch-local wait is not supported yet',
          requiredRung: 'A6-3-3',
        },
      ],
      warnings: [],
    },
  }
}

describe('normalizeCompilePreview', () => {
  it('maps a fully-supported envelope into the read-only view model', () => {
    const result = normalizeCompilePreview(supportedEnvelope())

    expect(result.supported).toBe(true)
    expect(result.source).toEqual({ workflowId: 'wf_1', mode: 'visual', sourceVersion: 3 })
    expect(result.automationPreview).toEqual({ actionCount: 2, requiresExecutionMode: 'workflow_job_v1' })
    expect(result.approvalPreview).toEqual({
      hasFormSchema: true,
      hasApprovalGraph: true,
      hasRuntimeGraphPreview: false,
    })
    expect(result.mappingReport).toHaveLength(2)
    expect(result.mappingReport[1].targetKind).toBe('condition_branch')
    expect(result.gapReport).toHaveLength(0)
    expect(result.warnings).toEqual(['start event treated as structural'])
  })

  it('keeps unsupported gaps with their required rung and nulls absent previews', () => {
    const result = normalizeCompilePreview(unsupportedEnvelope())

    expect(result.supported).toBe(false)
    expect(result.source.mode).toBe('bpmn_xml')
    expect(result.automationPreview).toBeNull()
    expect(result.approvalPreview).toBeNull()
    expect(result.gapReport).toEqual([
      {
        bpmnElementId: 'Task_wait',
        bpmnElementType: 'bpmn:ReceiveTask',
        reason: 'branch-local wait is not supported yet',
        requiredRung: 'A6-3-3',
      },
    ])
  })

  it('is defensive: non-true supported and malformed arrays never fake success', () => {
    const result = normalizeCompilePreview({
      success: true,
      data: { supported: 'yes', mappingReport: 'nope', gapReport: null, warnings: 42 },
    })

    expect(result.supported).toBe(false)
    expect(result.mappingReport).toEqual([])
    expect(result.gapReport).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.source.mode).toBe('visual')
  })
})

describe('compileWorkflowPreview', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
    fetchMock.mockReset()
  })

  it('POSTs the read-only compile-preview route and returns the normalized result', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(supportedEnvelope()) })

    const result = await compileWorkflowPreview('wf_1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workflow-designer/workflows/wf_1/compile-preview',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.supported).toBe(true)
    expect(result.mappingReport).toHaveLength(2)
  })

  it('throws the backend error message when the route fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ success: false, error: 'Workflow not found' }),
    })

    await expect(compileWorkflowPreview('missing')).rejects.toThrow('Workflow not found')
  })
})

describe('WorkflowCompilePreviewPanel', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  function mountPanel(props: {
    result: WorkflowCompilePreview | null
    loading?: boolean
    error?: string
  }): HTMLElement {
    app = createApp(WorkflowCompilePreviewPanel, {
      loading: false,
      error: '',
      ...props,
    })
    app.mount(container!)
    return container!
  }

  it('renders mapping rows, supported status and previews — with no action buttons', async () => {
    const root = mountPanel({ result: normalizeCompilePreview(supportedEnvelope()) })
    await flushUi()

    expect(root.querySelector('[data-testid="compile-preview-supported"]')?.textContent).toContain('可完整映射')
    expect(root.querySelectorAll('[data-testid="compile-preview-mapping"] tbody tr')).toHaveLength(2)
    expect(root.querySelector('[data-testid="compile-preview-automation"]')?.textContent).toContain('2 个动作')
    expect(root.querySelector('[data-testid="compile-preview-approval"]')?.textContent).toBeTruthy()
    expect(root.querySelector('[data-testid="compile-preview-no-gaps"]')).toBeTruthy()

    // Read-only: the panel introduces no actionable affordance at all — no
    // deploy/start/test/publish/save button, link, or role=button control.
    expect(root.querySelectorAll('button')).toHaveLength(0)
    expect(root.querySelectorAll('a')).toHaveLength(0)
    expect(root.querySelectorAll('[role="button"]')).toHaveLength(0)
    expect(root.querySelectorAll('input, select, textarea')).toHaveLength(0)
  })

  it('surfaces unsupported nodes as visible gaps with the required rung', async () => {
    const root = mountPanel({ result: normalizeCompilePreview(unsupportedEnvelope()) })
    await flushUi()

    expect(root.querySelector('[data-testid="compile-preview-supported"]')?.textContent).toContain('存在不支持的节点')
    const gaps = root.querySelector('[data-testid="compile-preview-gaps"]')
    expect(gaps).toBeTruthy()
    expect(gaps?.textContent).toContain('Task_wait')
    expect(gaps?.textContent).toContain('A6-3-3')
    expect(gaps?.textContent).toContain('branch-local wait is not supported yet')
  })

  it('shows loading, error (draft untouched) and empty states', async () => {
    const loadingRoot = mountPanel({ result: null, loading: true })
    await flushUi()
    expect(loadingRoot.querySelector('[data-testid="compile-preview-loading"]')).toBeTruthy()
    app!.unmount()

    const errorRoot = mountPanel({ result: null, error: '编译预览失败' })
    await flushUi()
    const errorEl = errorRoot.querySelector('[data-testid="compile-preview-error"]')
    expect(errorEl).toBeTruthy()
    expect(errorEl?.textContent).toContain('草稿未被修改')
    app!.unmount()

    const emptyRoot = mountPanel({ result: null })
    await flushUi()
    expect(emptyRoot.querySelector('[data-testid="compile-preview-empty"]')).toBeTruthy()
  })
})
