import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import ElementPlus from 'element-plus'
import ApprovalVersionWorkspace from '../src/approvals/components/ApprovalVersionWorkspace.vue'
import { ApprovalApiError } from '../src/approvals/api'
import type {
  ApprovalGraph,
  ApprovalTemplateDetailDTO,
  ApprovalTemplateVersionDetailDTO,
  ApprovalTemplateVersionSummaryDTO,
  FormSchema,
} from '../src/types/approval'

const listTemplateVersionsSpy = vi.fn()
const getTemplateSpy = vi.fn()
const getTemplateVersionSpy = vi.fn()
const restoreTemplateVersionSpy = vi.fn()

vi.mock('../src/approvals/api', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/api')>('../src/approvals/api')
  return {
    ...actual,
    getTemplate: (templateId: string) => getTemplateSpy(templateId),
    listTemplateVersions: (templateId: string) => listTemplateVersionsSpy(templateId),
    getTemplateVersion: (templateId: string, versionId: string) => getTemplateVersionSpy(templateId, versionId),
    restoreTemplateVersion: (templateId: string, versionId: string, request: unknown) => (
      restoreTemplateVersionSpy(templateId, versionId, request)
    ),
  }
})

const historicalGraph: ApprovalGraph = {
  nodes: [
    { key: 'secret_start_key', type: 'start', config: {} },
    { key: 'secret_approval_key', type: 'approval', name: '主管审批', config: { approvalMode: 'single' } },
    { key: 'secret_end_key', type: 'end', config: {} },
  ],
  edges: [
    { key: 'secret_edge_one', source: 'secret_start_key', target: 'secret_approval_key' },
    { key: 'secret_edge_two', source: 'secret_approval_key', target: 'secret_end_key' },
  ],
}

const currentGraph: ApprovalGraph = {
  nodes: [
    { key: 'secret_start_key', type: 'start', config: {} },
    { key: 'secret_approval_key', type: 'approval', name: '财务审批', config: { approvalMode: 'all' } },
    { key: 'secret_end_key', type: 'end', config: {} },
  ],
  edges: historicalGraph.edges,
}

const historicalSchema: FormSchema = {
  fields: [{ id: 'secret_amount_id', type: 'number', label: '金额', required: true }],
}
const currentSchema: FormSchema = {
  fields: [{ id: 'secret_amount_id', type: 'number', label: '报销金额', required: true }],
}

function templateDetail(latestVersionId = 'latest-version-id'): ApprovalTemplateDetailDTO {
  return {
    id: 'template-1',
    key: 'expense',
    name: '费用审批',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'draft',
    activeVersionId: null,
    latestVersionId,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    formSchema: currentSchema,
    approvalGraph: currentGraph,
  }
}

const summary: ApprovalTemplateVersionSummaryDTO = {
  id: 'secret_version_id',
  templateId: 'template-1',
  version: 1,
  status: 'published',
  publishNote: '初始流程',
  publishedDefinitionId: 'definition-1',
  restoredFromVersionId: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
}

const versionDetail: ApprovalTemplateVersionDetailDTO = {
  ...summary,
  formSchema: historicalSchema,
  approvalGraph: historicalGraph,
  runtimeGraph: null,
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function findButton(testId: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  if (!button) throw new Error(`missing button ${testId}`)
  return button
}

async function mountWorkspace(latestVersionId: string | null = 'latest-version-id') {
  const restored = ref<ApprovalTemplateVersionDetailDTO | null>(null)
  const Root = defineComponent({
    setup() {
      return () => h(ApprovalVersionWorkspace, {
        visible: true,
        templateId: 'template-1',
        latestVersionId,
        currentFormSchema: currentSchema,
        currentGraph,
        currentDirty: true,
        'onUpdate:visible': () => undefined,
        onRestored: (value: ApprovalTemplateVersionDetailDTO) => { restored.value = value },
      })
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(Root)
  app.use(ElementPlus)
  app.mount(host)
  await flush()
  await nextTick()
  return { app, host, restored }
}

describe('ApprovalVersionWorkspace', () => {
  let app: VueApp<Element> | null = null
  let host: HTMLElement | null = null

  beforeEach(() => {
    listTemplateVersionsSpy.mockReset().mockResolvedValue([summary])
    getTemplateVersionSpy.mockReset().mockResolvedValue(versionDetail)
    getTemplateSpy.mockReset().mockResolvedValue(templateDetail())
    restoreTemplateVersionSpy.mockReset().mockResolvedValue({
      ...versionDetail,
      id: 'restored-version-id',
      version: 2,
      status: 'draft',
      restoredFromVersionId: summary.id,
    })
  })

  afterEach(() => {
    app?.unmount()
    host?.remove()
    document.body.querySelectorAll('.el-overlay, .el-message').forEach((node) => node.remove())
    app = null
    host = null
  })

  it('loads a historical version and renders business labels without raw ids', async () => {
    const mounted = await mountWorkspace()
    app = mounted.app
    host = mounted.host

    expect(listTemplateVersionsSpy).toHaveBeenCalledWith('template-1')
    expect(getTemplateVersionSpy).toHaveBeenCalledWith('template-1', summary.id)
    expect(document.body.textContent).toContain('v1 与当前草稿')
    expect(document.body.textContent).toContain('主管审批')
    expect(document.body.textContent).toContain('财务审批')
    expect(document.body.textContent).toContain('报销金额')
    expect(document.body.textContent).not.toMatch(/secret_(version|amount|start|approval|end|edge)_/)
  })

  it('restores only after explicit acknowledgement and sends the latest-version concurrency fence', async () => {
    const mounted = await mountWorkspace('latest-version-id')
    app = mounted.app
    host = mounted.host

    findButton('approval-version-open-restore-preview').click()
    await nextTick()
    const confirm = findButton('approval-version-restore-confirm')
    expect(confirm.disabled).toBe(true)

    const checkbox = document.querySelector<HTMLInputElement>('[data-testid="approval-version-restore-acknowledge"] input')
    expect(checkbox).not.toBeNull()
    checkbox!.click()
    await nextTick()
    expect(confirm.disabled).toBe(false)
    confirm.click()
    await flush()

    expect(restoreTemplateVersionSpy).toHaveBeenCalledWith('template-1', summary.id, {
      expectedLatestVersionId: 'latest-version-id',
    })
    expect(mounted.restored.value?.id).toBe('restored-version-id')
  })

  it('fails closed when the latest version cannot be proven', async () => {
    const mounted = await mountWorkspace(null)
    app = mounted.app
    host = mounted.host

    expect(findButton('approval-version-open-restore-preview').disabled).toBe(true)
    expect(restoreTemplateVersionSpy).not.toHaveBeenCalled()
  })

  it('never echoes a raw restore failure', async () => {
    restoreTemplateVersionSpy.mockRejectedValueOnce(new Error('postgres://admin:secret@db.internal:5432'))
    const mounted = await mountWorkspace()
    app = mounted.app
    host = mounted.host

    findButton('approval-version-open-restore-preview').click()
    await nextTick()
    document.querySelector<HTMLInputElement>('[data-testid="approval-version-restore-acknowledge"] input')!.click()
    await nextTick()
    findButton('approval-version-restore-confirm').click()
    await flush()

    expect(document.body.textContent).toContain('恢复版本失败')
    expect(document.body.textContent).not.toContain('db.internal')
    expect(document.body.textContent).not.toContain('admin:secret')
  })

  it('refreshes the concurrency fence after a stale restore without discarding the current draft', async () => {
    restoreTemplateVersionSpy.mockRejectedValueOnce(new ApprovalApiError(
      'database host=secret.internal',
      409,
      'APPROVAL_TEMPLATE_VERSION_STALE',
    ))
    getTemplateSpy.mockResolvedValueOnce(templateDetail('latest-after-conflict'))
    const mounted = await mountWorkspace('latest-version-id')
    app = mounted.app
    host = mounted.host

    findButton('approval-version-open-restore-preview').click()
    await nextTick()
    document.querySelector<HTMLInputElement>('[data-testid="approval-version-restore-acknowledge"] input')!.click()
    await nextTick()
    findButton('approval-version-restore-confirm').click()
    await flush()
    await nextTick()

    expect(document.body.textContent).toContain('版本已由其他人更新，列表已刷新')
    expect(document.body.textContent).toContain('报销金额')
    expect(document.body.textContent).toContain('财务审批')
    expect(document.body.textContent).not.toContain('secret.internal')
    expect(mounted.restored.value).toBeNull()

    document.querySelector<HTMLInputElement>('[data-testid="approval-version-restore-acknowledge"] input')!.click()
    await nextTick()
    findButton('approval-version-restore-confirm').click()
    await flush()

    expect(restoreTemplateVersionSpy).toHaveBeenLastCalledWith('template-1', summary.id, {
      expectedLatestVersionId: 'latest-after-conflict',
    })
    expect(mounted.restored.value?.id).toBe('restored-version-id')
  })

  it('keeps a slower previous version request from replacing the latest selection', async () => {
    const second = { ...summary, id: 'version-two', version: 2 }
    const third = { ...summary, id: 'version-three', version: 3 }
    const secondRequest = deferred<ApprovalTemplateVersionDetailDTO>()
    const thirdRequest = deferred<ApprovalTemplateVersionDetailDTO>()
    listTemplateVersionsSpy.mockResolvedValueOnce([summary, second, third])
    getTemplateVersionSpy.mockImplementation((_templateId: string, versionId: string) => {
      if (versionId === second.id) return secondRequest.promise
      if (versionId === third.id) return thirdRequest.promise
      return Promise.resolve(versionDetail)
    })
    const mounted = await mountWorkspace()
    app = mounted.app
    host = mounted.host

    findButton('approval-version-timeline-2').click()
    await nextTick()
    findButton('approval-version-timeline-3').click()
    thirdRequest.resolve({ ...versionDetail, ...third })
    await flush()
    expect(document.body.textContent).toContain('v3 与当前草稿')

    secondRequest.resolve({ ...versionDetail, ...second })
    await flush()
    expect(document.body.textContent).toContain('v3 与当前草稿')
    expect(document.body.textContent).not.toContain('v2 与当前草稿')
  })
})
