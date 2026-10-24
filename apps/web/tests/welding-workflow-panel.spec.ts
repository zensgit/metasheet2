import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, computed, reactive, type App } from 'vue'
import WeldingWorkflowPanel from '../src/views/welding/WeldingWorkflowPanel.vue'
import type { useWeldingWorkflowSession } from '../src/views/welding/useWeldingWorkflowSession'
let app: App<Element> | null = null, root: HTMLDivElement
function fixture(actions: string[]) {
  const state = reactive({ planId: 'plan', versionId: 'v1', owner: { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }, current: { state: 'Draft', is_current: true, approval: null, allowed_actions: actions, issues: [], final_generation: null as any, publication: null as any, final_profile: null as any }, history: { total: 51, offset: 0, items: [] }, pending: null as unknown, working: false, message: '', validation: null, downloading: false, polling: false })
  const workflow = { state, canAction: (action: string) => actions.includes(action), canResolve: computed(() => true), canReplay: computed(() => false), command: vi.fn(), refreshFinal: vi.fn(), downloadPublication: vi.fn(), canDownloadPublication: computed(() => true), refresh: vi.fn(), validate: vi.fn(), resolve: vi.fn(), replay: vi.fn() } as unknown as ReturnType<typeof useWeldingWorkflowSession>
  root = document.createElement('div'); document.body.append(root); app = createApp(WeldingWorkflowPanel, { workflow, generation: { status: 'Ready' } }); app.mount(root)
  return { state, workflow }
}
const button = (label: string) => [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!
afterEach(() => { app?.unmount(); root?.remove() })
describe('workflow form identity boundaries', () => {
  const values = ['106', 'Later review opinion', 'Later withdrawal reason']
  const fields = () => [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')]
  async function fill() {
    fields().forEach((field, i) => { field.value = values[i]; field.dispatchEvent(new Event('input')) })
    await nextTick()
  }
  it('preserves later inputs when a refreshed authority has the same identity values', async () => {
    const f = fixture(['submit', 'approve', 'withdraw'])
    await fill()
    f.state.owner = { ...f.state.owner }
    f.state.pending = { action: 'submit' }
    await nextTick()
    expect(fields().map(field => field.value)).toEqual(values)
    f.state.pending = null
    f.state.owner = { ...f.state.owner }
    await nextTick()
    expect(fields().map(field => field.value)).toEqual(values)
    expect(f.workflow.command).not.toHaveBeenCalled()
  })
  it.each(['plan', 'version', 'tenant', 'org', 'auth-user', 'rbac-user', 'logout'])('clears inputs when %s changes', async change => {
    const f = fixture(['submit', 'approve', 'withdraw'])
    await fill()
    if (change === 'plan') f.state.planId = 'other-plan'
    if (change === 'version') f.state.versionId = 'other-version'
    if (change === 'tenant') f.state.owner.tenant_id = 'other-tenant'
    if (change === 'org') f.state.owner.org_id = 'other-org'
    if (change === 'auth-user') f.state.owner.auth_user_id++
    if (change === 'rbac-user') f.state.owner.rbac_user_id++
    if (change === 'logout') Object.assign(f.state, { owner: null })
    await nextTick()
    expect(fields().map(field => field.value)).toEqual(['', '', ''])
    expect(f.workflow.command).not.toHaveBeenCalled()
  })
})
describe('plain workflow panel controls', () => {
  it('F18b separates original reuse resolution, target opening and exact-source cleanup', async () => {
    const f = fixture([])
    Object.assign(f.workflow, { resolveReuse: vi.fn(), replayReuse: vi.fn(), openReuseTarget: vi.fn(), cleanupReuse: vi.fn(), canOpenReuse: computed(() => true), canCleanupReuse: computed(() => true) })
    Object.assign(f.state, { pending: { action: 'reuse' }, reuseAck: { target_plan_id: 'target', target_version_id: 'tv1' }, reuseCleanup: { original: { plan_id: 'plan', item_version_id: 'v1' }, opened: { plan_id: 'target', item_version_id: 'tv1' } } }); await nextTick()
    button('核对原复用请求结果').click(); expect(f.workflow.resolveReuse).toHaveBeenCalledOnce()
    expect(button('明确重发同一原复用请求').disabled).toBe(true)
    button('打开独立目标计划').click(); expect(f.workflow.openReuseTarget).toHaveBeenCalledOnce()
    button('明确清理来源复用请求').click(); expect(f.workflow.cleanupReuse).toHaveBeenCalledOnce(); expect(f.workflow.resolve).not.toHaveBeenCalled()
  })
  it('F18b offers only supplied approved membership and explicit local target controls before one create click', async () => {
    const f = fixture([])
    const reuse = reactive({ name: '', number: '', reason: '', selectedWeldIds: [], products: [{ item_id: 'other', version_id: 'p2', number: 'P2', name: 'Other' }], drawings: [], boms: [], product: null, drawing: null, bom: null })
    Object.assign(f.workflow, { reuse, reuseWeldIds: computed(() => ['included-w1']), canCreateReuse: computed(() => true), selectReuseProduct: vi.fn(), selectReuseBom: vi.fn(), createReuse: vi.fn() })
    f.state.current.state = 'Released'; await nextTick()
    const checks = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]; expect(checks.map(input => input.value)).toEqual(['included-w1'])
    checks[0].click(); await nextTick(); expect(reuse.selectedWeldIds).toEqual(['included-w1'])
    button('P2 · Other · p2').click(); expect(f.workflow.selectReuseProduct).toHaveBeenCalledWith(reuse.products[0]); expect(f.workflow.createReuse).not.toHaveBeenCalled()
    expect(root.textContent).toContain('重新绑定图纸、编制和评审'); button('明确创建独立复用草稿').click(); expect(f.workflow.createReuse).toHaveBeenCalledOnce()
  })
  it('C3 displays explicit revision open and cleanup controls separately', async () => {
    const f = fixture(['revise']); f.state.current.state = 'Released'
    Object.assign(f.workflow, { openRevisionTarget: vi.fn(), cleanupRevision: vi.fn(), formal: reactive({ planId: '', working: false, directory: null }), canOpenRevision: computed(() => true), canCleanupRevision: computed(() => true) })
    Object.assign(f.state, { revisionAck: { target_version_label: 'B', target_version_id: 'v2' }, revisionCleanup: null }); await nextTick()
    expect(button('创建修订')).toBeDefined(); button('打开目标版本').click(); expect(f.workflow.openRevisionTarget).toHaveBeenCalledOnce()
    Object.assign(f.state, { revisionCleanup: { original: { plan_id: 'plan', item_version_id: 'v1' }, opened: { item_version_id: 'v2' } } }); await nextTick()
    button('明确清理原修订请求').click(); expect(f.workflow.cleanupRevision).toHaveBeenCalledOnce()
  })
  it('keeps C2/C3 actions readonly and enables pagination from the real total', async () => {
    const f = fixture(['final-render', 'final-retry', 'release', 'revise'])
    expect(button('提交评审')).toBeUndefined(); expect(button('发布')).toBeUndefined(); expect(button('重新编制')).toBeUndefined()
    button('下一页评审历史').click(); await nextTick(); expect(f.workflow.refresh).toHaveBeenCalledWith(50)
  })
  it('requires a positive safe integer reviewer and passes only the explicit ID/selected generation', async () => {
    const f = fixture(['submit']), input = root.querySelector('input')!
    for (const invalid of ['0', '-1', '1.5', '9007199254740992', 'someone']) { input.value = invalid; input.dispatchEvent(new Event('input')); await nextTick(); expect(button('提交评审').disabled).toBe(true) }
    input.value = '20'; input.dispatchEvent(new Event('input')); await nextTick(); button('提交评审').click()
    expect(f.workflow.command).toHaveBeenCalledWith('submit', { reviewer: 20, generation: { status: 'Ready' } })
  })
  it('has separate read-only resolution and disabled explicit replay with no write permission', async () => {
    const f = fixture([]); f.state.pending = { action: 'review' }; await nextTick()
    expect(button('核对原评审请求结果').disabled).toBe(false); expect(button('明确重发同一原评审请求').disabled).toBe(true)
    button('核对原评审请求结果').click(); expect(f.workflow.resolve).toHaveBeenCalledTimes(1)
  })
})


describe('C2 finite panel controls', () => {
  it('exposes only explicit approved actions and never pre-publication download or C3 buttons', async () => {
    const f = fixture(['final-render', 'release', 'revise']); f.state.current.state = 'Approved'; f.state.current.final_generation = { status: 'Ready', generation_id: 'fixed', files: { pdf: { byte_size: 1 }, docx: { byte_size: 1 } } }; await nextTick()
    button('生成批准文件').click(); button('发布').click()
    expect(f.workflow.command).toHaveBeenCalledWith('final-render', {}); expect(f.workflow.command).toHaveBeenCalledWith('release', {})
    expect([...root.querySelectorAll('button')].some(value => /下载批准|修订|复用|比较/.test(value.textContent ?? ''))).toBe(false)
  })
  it('offers both formal downloads without a publish action and does not dispatch release', async () => {
    const f = fixture([]); f.state.current.state = 'Superseded'; f.state.current.is_current = false; f.state.current.publication = { publication_id: 'publication', state: 'Superseded', version_label: 'A', published_at: '2026-10-09T00:00:00Z', publisher: { display_name: 'Publisher' }, files: { pdf: { byte_size: 1 }, docx: { byte_size: 1 } } }; await nextTick()
    button('下载正式 PDF').click(); button('下载正式 DOCX').click()
    expect(f.workflow.downloadPublication).toHaveBeenCalledWith('pdf'); expect(f.workflow.downloadPublication).toHaveBeenCalledWith('docx'); expect(f.workflow.command).not.toHaveBeenCalled()
    expect(button('发布')).toBeUndefined()
  })
})

it('F18b P2 loads optional BOM only on an explicit enabled click after fixed product confirmation', async () => {
  const f = fixture([]), product = { item_id: 'other', version_id: 'p2', name: 'Other', number: 'P2', version_label: 'A' }
  const reuse = reactive({ name: '', number: '', reason: '', selectedWeldIds: [] as string[], products: [product], drawings: [], boms: [], product: null as { item_id: string; version_id: string } | null, drawing: null, bom: null, bomWorking: false, bomMessage: '' })
  const loadReuseBoms = vi.fn(async () => { reuse.bomMessage = '可选 BOM 暂不可用；可明确不采用 BOM' })
  Object.assign(f.workflow, { reuse, reuseWeldIds: computed(() => ['w1']), canCreateReuse: computed(() => true), loadReuseBoms,
    selectReuseProduct: vi.fn(async () => { reuse.product = { item_id: product.item_id, version_id: product.version_id } }),
    selectReuseBom: vi.fn(), createReuse: vi.fn() })
  f.state.current.state = 'Released'; await nextTick()
  const loadButton = () => [...root.querySelectorAll('button')].find(b => /读取.*BOM/.test(b.textContent ?? ''))!
  expect(button('P2 · Other · A')).toBeDefined()
  expect(loadButton()).toBeDefined(); expect(loadButton().disabled).toBe(true); expect(loadReuseBoms).not.toHaveBeenCalled()
  button('P2 · Other · A').click(); await nextTick()
  expect(reuse.product).toEqual({ item_id: 'other', version_id: 'p2' }); expect(loadButton().disabled).toBe(false)
  expect(loadReuseBoms).not.toHaveBeenCalled()
  f.state.working = true; await nextTick(); expect(loadButton().disabled).toBe(true)
  f.state.working = false; reuse.bomWorking = true; await nextTick(); expect(loadButton().disabled).toBe(true)
  reuse.bomWorking = false; f.state.pending = { action: 'reuse' }; await nextTick(); expect(loadButton().disabled).toBe(true)
  f.state.pending = null; await nextTick(); loadButton().click(); await nextTick()
  expect(loadReuseBoms).toHaveBeenCalledTimes(1); expect(root.textContent).toContain(reuse.bomMessage)
  expect(button('不采用 BOM').disabled).toBe(false); button('不采用 BOM').click()
  expect(f.workflow.selectReuseBom).toHaveBeenCalledWith(null); expect(f.workflow.createReuse).not.toHaveBeenCalled()
})
