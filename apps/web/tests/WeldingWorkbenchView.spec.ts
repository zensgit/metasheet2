import { createHash, webcrypto } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import WeldingWorkbenchView from '../src/views/welding/WeldingWorkbenchView.vue'
import type { PlanRecoveryRecord } from '../src/services/welding/planRecovery'
import { appRoutes } from '../src/router/appRoutes'

const mocks = vi.hoisted(() => ({
  route: { fullPath: '/plm/welding' }, flags: { plm: true, weldingRead: true, weldingWrite: true },
  apiFetch: vi.fn(), failClaim: false, records: new Map<string, unknown>(), generationRecords: new Map<string, unknown>(), workflowRecords: new Map<string, unknown>(),
  leave: vi.fn(), update: vi.fn(),
}))
vi.mock('vue-router', async () => ({ ...await vi.importActual<typeof import('vue-router')>('vue-router'), useRoute: () => mocks.route, onBeforeRouteLeave: mocks.leave, onBeforeRouteUpdate: mocks.update }))
vi.mock('../src/stores/featureFlags', () => ({ useFeatureFlags: () => ({ hasFeature: (key: keyof typeof mocks.flags) => mocks.flags[key] }) }))
vi.mock('../src/utils/api', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('../src/services/welding/planRecovery', async () => {
  const actual = await vi.importActual<typeof import('../src/services/welding/planRecovery')>('../src/services/welding/planRecovery')
  return { ...actual, openPlanRecoveryStore: async () => ({
    list: async () => [...mocks.records.values()].map(value => actual.clone(value)),
    get: async (_owner: unknown, id: string) => actual.clone(mocks.records.get(id) ?? null),
    claim: async (record: PlanRecoveryRecord) => {
      if (mocks.failClaim) throw new Error('quota')
      const existing = mocks.records.get(record.recovery_id)
      if (existing) return actual.equal(existing, record)
      mocks.records.set(record.recovery_id, actual.clone(record)); return true
    },
    compareReplace: async (expected: PlanRecoveryRecord, next: PlanRecoveryRecord | null) => {
      if (!actual.equal(mocks.records.get(expected.recovery_id), expected)) return false
      if (next) mocks.records.set(expected.recovery_id, actual.clone(next)); else mocks.records.delete(expected.recovery_id)
      return true
    }, close() {},
  }) }
})

vi.mock('../src/services/welding/commandRecovery', async () => {
  const actual = await vi.importActual<typeof import('../src/services/welding/commandRecovery')>('../src/services/welding/commandRecovery')
  const { clone, equal } = await vi.importActual<typeof import('../src/services/welding/planRecovery')>('../src/services/welding/planRecovery')
  return { ...actual, openGenerationRecoveryStore: async () => ({
    getResourceImport: async () => null,
    get: async (owner: unknown) => clone(mocks.generationRecords.get(JSON.stringify(owner)) ?? null),
    claim: async (value: import('../src/services/welding/commandRecovery').GenerationPending) => {
      const key = JSON.stringify(value.owner), old = mocks.generationRecords.get(key)
      if (old) return equal(old, value); mocks.generationRecords.set(key, clone(value)); return true
    },
    clear: async (value: import('../src/services/welding/commandRecovery').GenerationPending) => {
      const key = JSON.stringify(value.owner); if (!equal(mocks.generationRecords.get(key), value)) return false
      mocks.generationRecords.delete(key); return true
    },
    getWorkflow: async (owner: unknown, plan: string, version: string) => clone(mocks.workflowRecords.get(JSON.stringify([owner, plan, version])) ?? null),
    claimWorkflow: async (value: import('../src/services/welding/commandRecovery').WorkflowPending) => {
      const key = JSON.stringify([value.owner, value.plan_id, value.item_version_id]), old = mocks.workflowRecords.get(key)
      if (old) return equal(old, value); mocks.workflowRecords.set(key, clone(value)); return true
    },
    clearWorkflow: async (value: import('../src/services/welding/commandRecovery').WorkflowPending) => {
      const key = JSON.stringify([value.owner, value.plan_id, value.item_version_id]); if (!equal(mocks.workflowRecords.get(key), value)) return false
      mocks.workflowRecords.delete(key); return true
    }, close() {},
  }) }
})

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
const product = { item_id: 'part', version_id: 'p1', name: 'Part', number: 'P1', version_label: 'A' }
const drawing = { item_id: 'drawing', version_id: 'd1', name: 'Drawing', number: 'D1', version_label: 'B', file_id: 'f1', file_role: 'drawing', checksum: 'a'.repeat(64) }
const payload = { schema_version: 1, bom: null, process_refs: [], product: { item_id: 'part', version_id: 'p1' }, drawing: { item_id: 'drawing', version_id: 'd1', file_id: 'f1', file_role: 'drawing', expected_checksum: 'a'.repeat(64) }, welds: [{ weld_id: 'w1', display_no: '1', location: 'original', joint_type: '', method: '', material_a: '', material_b: '', filler: '', thickness_a: null, thickness_b: null, manufacturing_length: null, measured_length: null, welding_requirements: '', inspection_requirements: '', assembly_binding: { id: 'retain' }, passes: [] }], overlay: { schema: 'vemcad-weld-overlay/3', keep: true } }
const plan = { plan_id: 'plan', item_version_id: 'v1', name: 'Plan', number: 'W1', version_label: 'A', state: 'Draft', draft_seq: 1, content_hash: 'a'.repeat(64), payload, sources: { assembly: { retain: true } } }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const renderTemplate = { id: 'welding-a4', version: '3', digest: 'c'.repeat(64), name: 'A4', available: true, unavailable_reason: null, default_options: { organization_name: '', header_text: '', footer_text: '', optional_columns: [], logo: null }, options_schema: {} }
let generationAck: Record<string, unknown> | null = null
let app: App<Element> | null, root: HTMLDivElement
async function waitText(value: string) { await vi.waitFor(() => expect(root.textContent).toContain(value)) }
const button = (label: string) => [...root.querySelectorAll('button')].find(value => value.textContent?.trim() === label)!
function input(label: string) { return [...root.querySelectorAll('label')].find(value => value.childNodes[0]?.textContent?.trim() === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')! }
async function enterValue(label: string, value: string) { const field = input(label); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); await nextTick(); await vi.waitFor(() => expect(button('新增焊缝').disabled).toBe(false)) }
async function mount() {
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(WeldingWorkbenchView)
  app.component('router-link', { props: ['to'], render() { return h('a', { href: this.$props.to }, this.$slots.default?.()) } })
  const vm = app.mount(root); await nextTick(); return vm
}
describe('reachable welding draft page with controlled APIs', () => {
  it('mounts the import area and actual leave/update hooks protect busy and unsubmitted selections', async () => {
    // Node WebCrypto needs a Node-owned buffer when jsdom creates another ArrayBuffer realm.
    vi.stubGlobal('crypto', { randomUUID: () => webcrypto.randomUUID(), subtle: {
      digest: (algorithm: string, bytes: ArrayBuffer) => webcrypto.subtle.digest(algorithm, Buffer.from(new Uint8Array(bytes))),
    } }); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mount(); await waitText('已读取个人范围')
    expect(root.querySelector('[aria-label="整批资料导入"]')).not.toBeNull()
    button('核对整批导入身份与原请求').click()
    const fileInput = root.querySelector<HTMLInputElement>('[aria-label="整批资料导入"] input[type=file]')!
    await vi.waitFor(() => expect(fileInput.disabled).toBe(false))
    let finish!: (bytes: ArrayBuffer) => void
    const file = { name: 'route.csv', size: 3, arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { finish = resolve }) }
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] }); fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(typeof finish).toBe('function'))
    const leave = mocks.leave.mock.calls.at(-1)![0], update = mocks.update.mock.calls.at(-1)![0]
    expect(await leave()).toBe(false); expect(await update()).toBe(false)
    finish(new Uint8Array([0, 255, 128]).buffer)
    await vi.waitFor(() => expect(button('预检当前整份文件').disabled).toBe(false))
    expect(root.querySelector('[aria-label="整批资料导入"]')?.textContent).toContain(createHash('sha256').update(Buffer.from([0, 255, 128])).digest('hex'))
    expect(await leave()).toBe(false); expect(await update()).toBe(false); expect(confirm).toHaveBeenCalledWith(expect.stringContaining('原文件选择'))
    confirm.mockReturnValue(true); expect(await update()).toBe(true); await nextTick()
    expect(root.querySelector('[aria-label="整批资料导入"]')?.textContent).not.toContain('route.csv')
    expect(mocks.apiFetch.mock.calls.filter(([path]) => String(path).includes('/resources/import/'))).toHaveLength(0)
  })
  it('F18b exposes authorized provenance reading independently of editing and write availability', async () => {
    mocks.flags.weldingWrite = false; mocks.route.fullPath = '/plm/welding?plan_id=plan&version_id=v1'
    await mount(); await waitText('复用来源（初始采用）')
    expect(button('读取授权复用来源')).toBeDefined(); expect(root.textContent).toContain('尚未业务签收')
    button('读取授权复用来源').click(); await vi.waitFor(() => expect(mocks.apiFetch.mock.calls.some(([path]) => path === '/api/welding/plans/plan/versions/v1/reuse-provenance')).toBe(true))
    expect(mocks.apiFetch.mock.calls.filter(([path]) => String(path).endsWith('/reuse'))).toHaveLength(0)
  })
  beforeEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, action: () => Promise<unknown>) => action() } })
    Object.assign(mocks.flags, { plm: true, weldingRead: true, weldingWrite: true }); mocks.route.fullPath = '/plm/welding'
    mocks.failClaim = false; mocks.records.clear(); mocks.generationRecords.clear(); mocks.workflowRecords.clear(); generationAck = null; localStorage.setItem('auth_token', 'native-session')
    mocks.apiFetch.mockReset().mockImplementation(async (path: string, options: { method: string; body?: string }) => {
      if (path === '/api/welding/authority') return response({ schema: 'yuantus.welding_generation_authority/1', owner })
      if (path.endsWith('/review-state')) return response({ schema: 'yuantus.welding_review_state/1', plan_id: 'plan', item_version_id: 'v1', state: 'Draft', draft_seq: 1, content_hash: 'a'.repeat(64), is_current: true, approval: null, final_generation: null, publication: null, final_profile: null, allowed_actions: ['submit'], issues: [] })
      if (path.includes('/review-history?')) return response({ schema: 'yuantus.welding_review_history/1', plan_id: 'plan', item_version_id: 'v1', total: 0, limit: 50, offset: 0, items: [] })
      if (path === '/api/welding/render-templates') return response({ schema: 'yuantus.welding_instruction_templates/1', items: [renderTemplate] })
      if (path.includes('/renders?')) return response({ items: [], total: 0, offset: 0, limit: 20 })
      if (path.endsWith('/renders') && options.method === 'POST') {
        const body = JSON.parse(options.body!)
        generationAck = { schema: 'yuantus.welding_generation_ack/1', request_id: body.request_id, generation_id: '00000000-0000-4000-8000-000000000009', render_key: 'd'.repeat(64), plan_id: 'plan', item_version_id: 'v1', draft_seq: body.expected_draft_seq, plan_content_hash: body.expected_content_hash, generation_content_hash: 'e'.repeat(64), purpose: 'review', template: { id: body.template_id, version: body.template_version, digest: body.template_digest } }
        return response(generationAck, 202)
      }
      if (path.startsWith('/api/welding/artifacts/') && options.method === 'GET') { const { request_id: _request, ...fixed } = generationAck!; return response({ ...fixed, schema: 'yuantus.welding_plan_generation/1', status: 'Queued', attempt: 0, created_at: '2026-10-09T00:00:00Z', review: { pending_count: 0, unbound_count: 0 }, files: { pdf: null, docx: null }, error: null }) }
      if (path === '/api/welding/plans/recovery-authority' && options.method === 'GET') return response({ schema: 'yuantus.welding_plan_recovery_authority/1', owner })
      if (path.startsWith('/api/welding/plans?')) return response({ items: [plan], total: 1, limit: 50, offset: 0 })
      if (path.includes('/product-candidates?')) return response({ items: [product] })
      if (path.includes('/drawing-candidates?')) return response({ items: [drawing] })
      if (path.includes('/product-context?')) return response({ schema: 'yuantus.welding_plan_entry/1', product })
      if (path === '/api/welding/plans/plan/versions/v1' && options.method === 'GET') return response(plan)
      if (path === '/api/welding/plans/recovery-authority' && options.method === 'POST') {
        const { record } = JSON.parse(options.body!)
        return response({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: record.draft.version_id ? plan : null, can_write: true, conflict: false })
      }
      if (path === '/api/welding/plans/plan/versions/v1/draft' && options.method === 'PUT') { const body = JSON.parse(options.body!); return response({ ...plan, draft_seq: 2, content_hash: 'b'.repeat(64), save_id: body.save_id, payload: body.payload }) }
      if (path === '/api/welding/plans' && options.method === 'POST') { const body = JSON.parse(options.body!); return response({ ...plan, plan_id: body.plan_id, item_version_id: 'allocated', name: body.name, number: body.number, payload: body.payload }, 201) }
      throw new Error(`Unexpected fixed request ${options.method} ${path}`)
    })
  })
  afterEach(() => { app?.unmount(); app = null; root?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (navigator as any).locks })
  it('C3 root follow-up normal list selection initializes the independent formal directory with no query entry', async () => {
    const ordinary = mocks.apiFetch.getMockImplementation()!
    mocks.apiFetch.mockImplementation(async (path: string, options: { method: string; body?: string }) => {
      if (path.includes('/publications?')) return response({ schema: 'yuantus.welding_publication_directory/1', plan_id: 'plan', total: 0, limit: 20, offset: 0, items: [], current_publication: null })
      if (path.endsWith('/publication')) return response({ error: { code: 'WELDING_PLAN_NOT_FOUND' } }, 404)
      return ordinary(path, options)
    })
    await mount(); await waitText('W1 · Plan')
    const choose = [...root.querySelectorAll('button')].find(value => value.textContent?.includes('W1 · Plan'))!; choose.click()
    await waitText('正式目录'); await waitText('没有可见的当前正式版')
    expect(mocks.apiFetch.mock.calls.some(([path]) => path === '/api/welding/plans/plan/publications?limit=20&offset=0')).toBe(true)
    expect(mocks.route.fullPath).toBe('/plm/welding')
  })
  it.each(['Released', 'Superseded'])('C3 independent official %s reader survives editor503 and review-state503', async state => {
    mocks.flags.weldingWrite = false; mocks.route.fullPath = '/plm/welding?plan_id=plan&version_id=v1'
    const archive = { schema: 'yuantus.welding_plan_publication/1', publication_id: 'publication', plan_id: 'plan', item_version_id: 'v1', state, draft_seq: 1, content_hash: 'a'.repeat(64), version_label: 'A', name: 'Plan', number: 'W1', approval_request_id: 'approval', submission_hash: 'a'.repeat(64), decision_hash: 'b'.repeat(64), review_generation_id: '00000000-0000-4000-8000-000000000009', final_generation_id: '00000000-0000-4000-8000-000000000010', generation_content_hash: 'a'.repeat(64), requester: { auth_user_id: 7, rbac_user_id: 19, display_name: '作者' }, reviewer: { auth_user_id: 8, rbac_user_id: 20, display_name: '评审' }, publisher: { auth_user_id: 7, rbac_user_id: 19, display_name: '作者' }, opinion: '', approved_at: '2026-10-09T00:00:00Z', published_at: '2026-10-09T01:00:00Z', files: { pdf: { format: 'pdf', mime_type: 'application/pdf', byte_size: 1, artifact_sha256: 'a'.repeat(64) }, docx: { format: 'docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: 1, artifact_sha256: 'a'.repeat(64) } } }
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/welding/authority') return response({ schema: 'yuantus.welding_generation_authority/1', owner })
      if (path.endsWith('/publication')) return response(archive)
      if (path.includes('/publications?')) return response({ schema: 'yuantus.welding_publication_directory/1', plan_id: 'plan', total: 1, limit: 20, offset: 0, items: [{ publication_id: 'publication', item_version_id: 'v1', version_label: 'A', state, published_at: archive.published_at, content_hash: archive.content_hash }], current_publication: state === 'Released' ? { publication_id: 'publication', item_version_id: 'v1', version_label: 'A', state, published_at: archive.published_at, content_hash: archive.content_hash } : null })
      return response({ error: { code: 'WELDING_PLUGIN_UNAVAILABLE' } }, 503)
    })
    await mount(); await waitText('正式目录'); await waitText('选定正式版本：A')
    expect(button('下载选定正式 PDF').disabled).toBe(false); expect(button('下载选定正式 DOCX').disabled).toBe(false)
    expect(button('创建修订')).toBeUndefined(); expect(mocks.apiFetch.mock.calls.some(([path]) => String(path).includes('/publications?limit=20&offset=0'))).toBe(true)
  })
  it('reads the fixed cold workflow route when editor initialization is unavailable', async () => {
    mocks.flags.weldingWrite = false; mocks.route.fullPath = '/plm/welding?plan_id=plan&version_id=v1'
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/welding/authority') return response({ schema: 'yuantus.welding_generation_authority/1', owner })
      if (path.endsWith('/review-state')) return response({ schema: 'yuantus.welding_review_state/1', plan_id: 'plan', item_version_id: 'v1', state: 'Draft', draft_seq: 1, content_hash: 'a'.repeat(64), is_current: true, approval: null, final_generation: null, publication: null, final_profile: null, allowed_actions: [], issues: [] })
      if (path.includes('/review-history?')) return response({ schema: 'yuantus.welding_review_history/1', plan_id: 'plan', item_version_id: 'v1', total: 0, limit: 50, offset: 0, items: [] })
      return response({ error: { code: 'WELDING_PLUGIN_UNAVAILABLE' } }, 503)
    })
    await mount(); await waitText('评审状态：Draft')
    expect(mocks.apiFetch.mock.calls.some(([path]) => String(path).endsWith('/review-state'))).toBe(true)
    expect(mocks.apiFetch.mock.calls.some(([path]) => String(path).includes('/review-history?'))).toBe(true)
    expect(button('提交评审')).toBeUndefined()
  })
  it.each(['Released', 'Superseded'])('cold %s page reaches both formal files despite editor503/writeOFF and retains an UNKNOWN original', async state => {
    mocks.flags.weldingWrite = false; mocks.route.fullPath = '/plm/welding?plan_id=plan&version_id=v1'; vi.stubGlobal('crypto', webcrypto)
    const hash = 'a'.repeat(64), data = new TextEncoder().encode('formal-view'), digest = createHash('sha256').update(data).digest('hex'), G = '00000000-0000-4000-8000-000000000010', R = '00000000-0000-4000-8000-000000000009'
    const requester = { auth_user_id: 7, rbac_user_id: 19, display_name: '作者' }, reviewer = { auth_user_id: 8, rbac_user_id: 20, display_name: '评审人' }, date = '2026-10-09T00:00:00Z'
    const files = { pdf: { format: 'pdf', mime_type: 'application/pdf', byte_size: data.length, artifact_sha256: digest }, docx: { format: 'docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: data.length, artifact_sha256: digest } }
    const fixed = { generation_id: G, render_key: hash, plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, plan_content_hash: hash, generation_content_hash: hash, purpose: 'final', approval_request_id: 'approval', submission_hash: hash, decision_hash: hash, template: { id: 'welding-approval-appendix', version: '1', digest: hash } }
    const assets = ['pdf', 'docx', 'layout_png'].map(format => ({ asset_id: format, file_id: format, format, sha256: hash, byte_size: 1, mime_type: format === 'layout_png' ? 'image/png' : files[format as keyof typeof files].mime_type }))
    const approval = { approval_request_id: 'approval', state: 'approved', submission_hash: hash, submission: { schema: 'yuantus.welding_submission/1', tenant_id: 'tenant', org_id: 'org', plan_id: 'plan', item_version_id: 'v1', version_label: 'A', draft_seq: 1, plan_content_hash: hash, requester, reviewer, review_generation_id: R, render_key: hash, input_sha256: hash, render_profile: {}, attempt: 1, attempt_token: 'attempt', assets, renderer_receipt: {}, sources: {}, review: {}, included_weld_ids: [], excluded_weld_ids: [] }, decision: { decision_hash: hash, decision: { schema: 'yuantus.welding_decision/1', approval_request_id: 'approval', submission_hash: hash, request_id: 'approved', decision: 'approve', opinion: '', reviewer, decided_at: date } } }
    const publication = { schema: 'yuantus.welding_plan_publication/1', publication_id: 'publication', plan_id: 'plan', item_version_id: 'v1', state, draft_seq: 1, content_hash: hash, version_label: 'A', name: 'Plan', number: 'W1', approval_request_id: 'approval', submission_hash: hash, decision_hash: hash, review_generation_id: R, final_generation_id: G, generation_content_hash: hash, requester, reviewer, opinion: '', approved_at: date, published_at: date, publisher: reviewer, files }
    const original = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', owner, plan_id: 'plan', item_version_id: 'v1', action: 'final-retry', body: { request_id: 'unknown-original', expected_attempt: 1 }, basis: fixed }, key = JSON.stringify([owner, 'plan', 'v1'])
    mocks.workflowRecords.set(key, structuredClone(original))
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/welding/authority') return response({ schema: 'yuantus.welding_generation_authority/1', owner })
      if (path.endsWith('/review-state')) return response({ schema: 'yuantus.welding_review_state/1', plan_id: 'plan', item_version_id: 'v1', state, draft_seq: 1, content_hash: hash, is_current: state === 'Released', approval, final_generation: { schema: 'yuantus.welding_final_generation/1', ...fixed, status: 'Ready', state, attempt: 1, created_at: date, files, error: null }, publication, final_profile: null, allowed_actions: [], issues: ['editor-inactive'] })
      if (path.includes('/review-history?')) return response({ schema: 'yuantus.welding_review_history/1', plan_id: 'plan', item_version_id: 'v1', total: 0, limit: 50, offset: 0, items: [] })
      if (path.endsWith('/publication')) return response(publication)
      if (path.includes('/publication/files/')) { const descriptor = files[path.endsWith('/pdf') ? 'pdf' : 'docx']; return new Response(data, { headers: { 'Content-Type': descriptor.mime_type, 'Content-Length': String(data.length), 'X-Artifact-SHA256': digest } }) }
      return response({ error: { code: 'WELDING_PLUGIN_UNAVAILABLE' } }, 503)
    })
    const createURL = vi.fn(() => 'blob:formal-view-' + crypto.randomUUID()), revokeURL = vi.fn(); vi.stubGlobal('URL', class extends URL { static get createObjectURL() { return createURL }; static get revokeObjectURL() { return revokeURL } }); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await mount(); await waitText('评审状态：' + state)
    for (const [i, format] of ['PDF', 'DOCX'].entries()) { await vi.waitFor(() => expect(button('下载正式 ' + format).disabled).toBe(false)); button('下载正式 ' + format).click(); await vi.waitFor(() => expect(createURL).toHaveBeenCalledTimes(i + 1)) }
    expect(mocks.workflowRecords.get(key)).toEqual(original); expect(mocks.apiFetch.mock.calls.filter(([path]) => path.includes('/publication/files/'))).toHaveLength(2)
    expect(button('发布')).toBeUndefined(); app?.unmount(); app = null; expect(revokeURL).toHaveBeenCalledTimes(2)
  })
  it('OFF does not issue any welding request and does not render save buttons', async () => {
    mocks.flags.weldingRead = false; await mount()
    expect(root.textContent).toContain('当前焊接读取未开启')
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    expect(root.querySelectorAll('button')).toHaveLength(0)
  })
  it('direct fixed-version entry renders saved hash/edit seq and CAS saves existing opaque fields', async () => {
    mocks.route.fullPath = '/plm/welding?plan_id=plan&version_id=v1'; await mount(); await waitText('已读取服务器草稿'); await waitText('已读取模板与固定评审任务')
    expect(input('名称').readOnly).toBe(true)
    expect(root.textContent).toContain('服务器保存序号 1 · 本地编辑序号 0')
    expect(root.textContent).toContain('a'.repeat(64))
    await enterValue('位置', 'changed'); button('保存草稿').click(); await waitText('已保存服务器草稿')
    const call = mocks.apiFetch.mock.calls.find(([path, opts]) => path.endsWith('/draft') && opts.method === 'PUT')!
    expect(JSON.parse(call[1].body)).toMatchObject({ expected_draft_seq: 1, payload: { overlay: { keep: true }, welds: [{ assembly_binding: { id: 'retain' }, location: 'changed' }] } })
    expect(JSON.parse(call[1].body)).not.toHaveProperty('measure_geometry')
    expect(root.textContent).toContain('b'.repeat(64))
    expect(root.textContent).toContain('HOLD')
  })
  it('offers explicit measurement independently of dirty edits and sends true only from that button', async () => {
    mocks.route.fullPath = '/plm/welding?plan_id=plan&version_id=v1'
    const vm = await mount(); await waitText('已读取服务器草稿'); await waitText('已读取模板与固定评审任务')
    expect(button('保存并核验几何测量').disabled).toBe(true)
    // Controlled CAD-context boundary; real native opening is covered on Mini.
    vm.$.setupState.session.state.overlayContextId = 'test-cad-context'
    await nextTick(); expect(button('保存草稿').disabled).toBe(true)
    expect(button('保存并核验几何测量').disabled).toBe(false)
    button('保存并核验几何测量').click(); await waitText('已保存服务器草稿')
    const writes = mocks.apiFetch.mock.calls.filter(([path, opts]) => path.endsWith('/draft') && opts.method === 'PUT')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0][1].body)).toMatchObject({ measure_geometry: true, overlay_context_id: 'test-cad-context', expected_draft_seq: 1 })
  })
  it('fixed entry reaches review generation and sends the exact saved template basis', async () => {
    mocks.route.fullPath = '/plm/welding?plan_id=plan&version_id=v1'; await mount(); await waitText('已读取模板与固定评审任务')
    expect(button('生成评审文件').disabled).toBe(false); button('生成评审文件').click(); await waitText('原生成请求已确认')
    const writes = mocks.apiFetch.mock.calls.filter(([path, opts]) => path.endsWith('/renders') && opts.method === 'POST')
    expect(writes).toHaveLength(1); expect(JSON.parse(writes[0][1].body)).toMatchObject({ expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), purpose: 'review', template_version: '3', template_digest: 'c'.repeat(64) })
    expect(mocks.generationRecords.size).toBe(0); expect(root.textContent).toContain('排队中')
    expect([...root.querySelectorAll('button')].some(value => /发布|送审|批准文件/.test(value.textContent ?? ''))).toBe(false)
  })
  it('new draft selects real product/drawing candidates and creates one stable original request', async () => {
    await mount(); await waitText('已读取个人范围')
    button('新建草稿').click(); await waitText('新建本地草稿')
    await enterValue('名称', 'New Plan'); await enterValue('编号', 'NEW1')
    await enterValue('产品检索', 'P1'); button('查找产品版本').click(); await waitText('P1 · Part · A')
    button('P1 · Part · A').click(); await waitText('产品：part · p1')
    await enterValue('图纸检索', 'D1'); button('查找固定图纸').click(); await waitText('D1 · B · drawing · f1')
    button('D1 · B · drawing · f1').click(); await nextTick(); await vi.waitFor(() => expect(button('新增焊缝').disabled).toBe(false))
    button('新增焊缝').click(); await nextTick(); await vi.waitFor(() => expect(button('保存草稿').disabled).toBe(false)); button('保存草稿').click(); await waitText('已保存服务器草稿')
    const writes = mocks.apiFetch.mock.calls.filter(([path, opts]) => path === '/api/welding/plans' && opts.method === 'POST')
    expect(writes).toHaveLength(1)
    const body = JSON.parse(writes[0][1].body)
    expect(body.payload.drawing.expected_checksum).toBe(drawing.checksum)
    expect(body.payload.welds[0].weld_id).not.toBe(body.payload.welds[0].display_no)
  })
  it('F18 actual saved-plan entry compares a fixed BOM and applies the exact original POST only after the explicit button', async () => {
    mocks.route.fullPath = '/plm/welding?plan_id=plan&version_id=v1'
    const connection = { a: { role: '人工 A 侧', path: ['rel-a'], item_id: 'same-part', version_id: 'part-v1' }, b: { role: '人工 B 侧', path: ['rel-b'], item_id: 'same-part', version_id: 'part-v1' } }
    let current = { ...plan, payload: { ...structuredClone(payload), assembly_format: 'yuantus.welding_assembly/1', bom: { baseline_id: 'old-bom', expected_fingerprint: 'b'.repeat(64) }, welds: [{ ...structuredClone(payload.welds[0]), assembly: connection }] }, sources: { assembly: { schema: 'yuantus.welding_assembly/1', adopted_welds: ['w1'] } } }
    const projection = { baseline_id: 'new-bom', fingerprint: 'c'.repeat(64), name: '装配', number: 'B2', captured_depth: 2, root: { path: [], item_id: 'part', version_id: 'p1', name: '产品', number: 'P1', version_label: 'A' },
      occurrences: ['rel-a', 'rel-b'].map(rel => ({ path: [rel], item_id: 'same-part', version_id: 'part-v1', name: '同零件', number: 'P2', version_label: 'A', quantity: '1', uom: '', find_number: '' })) }
    let comparedBody: Record<string, unknown> | null = null
    const ordinary = mocks.apiFetch.getMockImplementation()!
    mocks.apiFetch.mockImplementation(async (path: string, options: { method: string; body?: string }) => {
      if (path === '/api/welding/plans/plan/versions/v1' && options.method === 'GET') return response(current)
      if (path === '/api/welding/plans/recovery-authority' && options.method === 'POST') { const { record } = JSON.parse(options.body!); return response({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current, can_write: true, conflict: false }) }
      if (path.includes('/bom-candidates?')) return response({ items: [projection] })
      if (path.endsWith('/assembly-preview')) {
        comparedBody = JSON.parse(options.body!); const body = comparedBody as any, selected = body.payload.welds[0].assembly
        const sides = Object.fromEntries(['a', 'b'].map(name => [name, { selection: selected[name], facts: { path: selected[name].path, item_id: selected[name].item_id, version_id: selected[name].version_id, quantity: '1', uom: '', find_number: '' }, provenance: null, unknown: ['missing_witness'] }]))
        return response({ schema: 'yuantus.welding_assembly_preview/1', plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, content_hash: 'a'.repeat(64), from_fingerprint: 'b'.repeat(64), to_fingerprint: 'c'.repeat(64), affected_welds: [{ weld_id: 'w1', reason_codes: ['missing_witness'], before: null, after: { sides, unknown: ['missing_witness'] }, state: 'unknown' }] })
      }
      if (path.endsWith('/assembly-apply')) {
        const body = JSON.parse(options.body!); expect(body).toEqual(comparedBody)
        expect(mocks.records.size).toBe(1); expect([...mocks.records.values()][0]).toMatchObject({ pending: { method: 'POST', path: '/plan/versions/v1/assembly-apply', body } })
        current = { ...current, draft_seq: 2, content_hash: 'e'.repeat(64), payload: body.payload }; return response({ ...current, save_id: body.save_id })
      }
      return ordinary(path, options)
    })
    await mount(); await waitText('已读取服务器草稿'); await waitText('已读取模板与固定评审任务')
    expect(root.querySelectorAll('.assembly-panel')).toHaveLength(1)
    await vi.waitFor(() => expect(button('读取固定 BOM 装配位置').disabled).toBe(false)); button('读取固定 BOM 装配位置').click(); await waitText('已读取固定 BOM 装配位置')
    const panel = root.querySelector('.assembly-panel')!
    async function choose(label: string, value: string, within: Element = panel) {
      const field = [...within.querySelectorAll('label')].find(el => el.childNodes[0]?.textContent?.trim() === label)!.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')!
      field.value = value; field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await nextTick()
    }
    await choose('固定 BOM', 'new-bom'); await choose('关联焊缝', 'w1'); const sides = panel.querySelectorAll('fieldset')
    for (const [i, path] of ['rel-a', 'rel-b'].entries()) { await choose('装配位置', JSON.stringify([path]), sides[i]); await choose('人工角色名称', i ? '人工 B 侧' : '人工 A 侧', sides[i]) }
    button('比较固定 BOM 变化').click(); await waitText('装配变化比较')
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path.endsWith('/assembly-apply'))).toHaveLength(0); expect(mocks.records.size).toBe(0)
    expect(panel.textContent).toContain('待核对'); button('明确应用装配变化').click()
    await vi.waitFor(() => expect(mocks.apiFetch.mock.calls.filter(([path]) => path.endsWith('/assembly-apply'))).toHaveLength(1))
    await vi.waitFor(() => expect(mocks.records.size).toBe(0)); expect(root.textContent).toContain('e'.repeat(64))
    expect(mocks.apiFetch.mock.calls.filter(([path, options]) => path.endsWith('/draft') && options.method === 'PUT')).toHaveLength(0)
  })
  it('write OFF keeps fixed-version reads available while suppressing new saves', async () => {
    mocks.flags.weldingWrite = false; mocks.route.fullPath = '/plm/welding?plan_id=plan&version_id=v1'
    await mount(); await waitText('服务器保存序号')
    expect(button('保存草稿').disabled).toBe(true)
    expect(button('新建草稿').disabled).toBe(true)
    expect(mocks.apiFetch.mock.calls.some(([, opts]) => opts.method === 'PUT')).toBe(false)
  })
  it('malformed direct entry causes no API request or fallback to a different target', async () => {
    mocks.route.fullPath = '/plm/welding?plan_id=p&plan_id=q&version_id=v'; await mount()
    await vi.waitFor(() => expect(root.textContent).toContain('格式无法确认'))
    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })
  it('page offers no unimplemented CAD or workflow command buttons', async () => {
    await mount(); await waitText('已读取个人范围')
    expect([...root.querySelectorAll('button')].some(value => /发布|送审|生成|CAD/.test(value.textContent ?? ''))).toBe(false)
  })
  it('actual registry exposes a lazy authenticated route within existing PLM feature/focus', async () => {
    const route = appRoutes.find(value => value.path === '/plm/welding')!
    expect(route.meta).toMatchObject({ requiresAuth: true, requiredFeature: 'plm' })
    expect(typeof route.component).toBe('function')
    expect((await (route.component as () => Promise<{ default: unknown }>)()).default).toBe(WeldingWorkbenchView)
  })
  it('explicit local storage retry persists an unsaved edit and never dispatches a plan save', async () => {
    mocks.route.fullPath = '/plm/welding?plan_id=plan&version_id=v1'; await mount(); await waitText('已读取服务器草稿'); await waitText('已读取模板与固定评审任务')
    mocks.failClaim = true; await enterValue('位置', 'recover me'); await waitText('quota')
    expect(button('重试本地恢复存储').disabled).toBe(false); mocks.failClaim = false; button('重试本地恢复存储').click(); await waitText('本地恢复存储已确认')
    expect([...mocks.records.values()][0]).toMatchObject({ draft: { payload: { welds: [{ location: 'recover me' }] } } })
    expect(mocks.apiFetch.mock.calls.some(([, options]) => options.method === 'PUT')).toBe(false)
  })

})
