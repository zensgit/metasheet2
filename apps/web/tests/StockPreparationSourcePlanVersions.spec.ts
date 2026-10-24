import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref, type App } from 'vue'

const h = vi.hoisted(() => ({ apiFetch: vi.fn(), permissions: ['integration:admin'] as string[], locale: 'zh-CN' }))
vi.mock('../src/utils/api', () => ({ apiFetch: h.apiFetch }))
vi.mock('../src/composables/useLocale', () => ({ useLocale: () => ({ locale: ref(h.locale) }) }))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getAccessSnapshot: () => ({ roles: [], isAdmin: false, permissions: h.permissions }) }),
}))

import SourceBindingPanel from '../src/components/integration/stockPreparation/StockPreparationSourceBindingPanel.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { compileSourcePlanDraft, createSyntheticSourcePlanDraft, parseSourcePlanDraftJson } from '../src/services/integration/stockPreparation/sourcePlanDraft'
import {
  SOURCE_PLAN_VERSIONS_ROUTE,
  activateSourcePlanVersion,
  approveSourcePlanVersion,
  deactivateSourcePlanVersion,
  listSourcePlanVersions,
  saveSourcePlanVersion,
} from '../src/services/integration/stockPreparation/sourcePlanVersions'

const SYSTEM = 'sys_synthetic_owned'
const ACTION = 'plm.stock-preparation.pull-bom.v1'
const HASH = 'a'.repeat(64)
const READ_PLAN = compileSourcePlanDraft(createSyntheticSourcePlanDraft()).envelope!.readPlan
const SCOPE = { tenantId: 'synthetic_tenant', workspaceId: 'synthetic_workspace' }
function confirmedReceipt() {
  return {
    validationId: 'validation_1', status: 'confirmed' as const,
    counts: { sampleCount: 1, readCount: 1, objectCount: 1 },
    expiresAt: '2099-01-01T00:00:00.000Z', confirmedAt: '2098-12-01T00:00:00.000Z',
  }
}
function version(status: 'draft' | 'approved' = 'draft', id = 'version_1') {
  const validation = confirmedReceipt()
  return {
    id, tenantId: SCOPE.tenantId, workspaceId: null, actionId: ACTION, schemaVersion: 1,
    systemId: SYSTEM, version: 1, status, contentKey: HASH,
    validationId: validation.validationId, validation,
    config: { schemaVersion: 1, systemId: SYSTEM, actionId: ACTION, readPlan: READ_PLAN },
  }
}
function activation(status: 'active' | 'disabled' = 'active', generation = 1) {
  return { versionId: 'version_1', systemId: SYSTEM, actionId: ACTION, workspaceId: null, status, generation, contentKey: HASH }
}
function envelope(data: unknown) { return new Response(JSON.stringify({ ok: true, data })) }
function refusal(status = 403) {
  return new Response(JSON.stringify({ ok: false, error: { code: 'PRIVATE_UNTRUSTED_TOKEN', message: 'PRIVATE_SCHEMA_CREDENTIAL', details: { secret: 'PRIVATE_SCHEMA_CREDENTIAL' } } }), { status })
}
function deferred() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}
async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null
let container: HTMLDivElement
let versions: ReturnType<typeof version>[]
let pointer: ReturnType<typeof activation> | null
let delay: { path: string; method: string; response: ReturnType<typeof deferred> } | null
let deny = false

function routes() {
  h.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/source-binding')) return envelope({
      actionId: ACTION, effectiveExternalSystemId: 'sys_bound_workspace', effectiveSourceKind: 'data-source:sql-readonly',
      origin: 'deploy_default', persistedBinding: null, effectiveSourceProblem: null,
      takesEffectWithoutRestart: true, eligibleSources: [],
    })
    const parsed = new URL(url, 'https://synthetic.invalid')
    const path = parsed.pathname.slice(SOURCE_PLAN_VERSIONS_ROUTE.length)
    const method = init?.method || 'GET'
    if (delay && delay.path === path && delay.method === method) return delay.response.promise
    if (deny) return refusal()
    if (method === 'GET') return envelope({ versions, activation: pointer })
    if (!path) { const row = version(); versions = [row]; return envelope(row) }
    if (path === '/version_1/approve') { versions = [version('approved')]; return envelope(versions[0]) }
    if (path === '/version_1/activate') { pointer = activation('active', (pointer?.generation ?? 0) + 1); return envelope(pointer) }
    if (path === '/deactivate') { pointer = activation('disabled', (pointer?.generation ?? 0) + 1); return envelope(pointer) }
    throw new Error('unexpected synthetic route')
  })
}
function element(id: string): HTMLElement { return container.querySelector(`[data-testid="stock-prep-${id}"]`)! }
async function click(id: string) { element(id).click(); await flush() }
async function input(id: string, value: string) {
  const node = element(id) as HTMLInputElement
  node.value = value
  node.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}
function onlineCalls() { return h.apiFetch.mock.calls.filter(([url]) => String(url).startsWith(SOURCE_PLAN_VERSIONS_ROUTE)) }
function mutations() { return onlineCalls().filter(([, init]) => init?.method === 'POST') }
async function mount(scope = SCOPE) {
  app = createApp(SourceBindingPanel, { scope })
  app.mount(container)
  await flush()
}
async function manage() {
  await click('plan-management-toggle')
  await input('plan-system', SYSTEM)
  await click('plan-refresh')
}

beforeEach(() => {
  localStorage.clear()
  h.permissions = ['integration:admin']
  h.locale = 'zh-CN'
  h.apiFetch.mockReset()
  versions = []
  pointer = null
  delay = null
  deny = false
  app = null
  container = document.createElement('div')
  document.body.appendChild(container)
  routes()
})
afterEach(() => { app?.unmount(); container.remove(); localStorage.clear(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('tenant-level PLM version client', () => {
  it('sends only the explicit management contract and exact version/generation; strips global subject hints', async () => {
    await listSourcePlanVersions(SYSTEM)
    await saveSourcePlanVersion(SYSTEM, READ_PLAN)
    await approveSourcePlanVersion(SYSTEM, 'version_1')
    await activateSourcePlanVersion(SYSTEM, 'version_1', 0)
    await deactivateSourcePlanVersion(SYSTEM, 1)
    const calls = onlineCalls()
    expect(new URL(calls[0][0], 'https://synthetic.invalid').searchParams.toString()).toBe(`managementScope=tenant&systemId=${SYSTEM}`)
    expect(calls.slice(1).map(([, init]) => JSON.parse(init.body))).toEqual([
      { managementScope: 'tenant', config: { schemaVersion: 1, actionId: ACTION, systemId: SYSTEM, readPlan: READ_PLAN } },
      { managementScope: 'tenant', systemId: SYSTEM },
      { managementScope: 'tenant', systemId: SYSTEM, expectedGeneration: 0 },
      { managementScope: 'tenant', systemId: SYSTEM, expectedGeneration: 1 },
    ])
    for (const [, init] of calls) {
      expect(init.omitHeaders).toEqual(['x-tenant-id', 'x-workspace-id'])
      expect(init.suppressUnauthorizedRedirect).toBe(true)
    }
  })

  it.each([
    { workspaceId: 'other_workspace' }, { systemId: 'other_system' }, { actionId: 'other_action' },
    { contentKey: 'private_unvalidated_data' }, { status: 'active' },
  ])('rejects an invalid saved-version projection %j', async (patch) => {
    h.apiFetch.mockResolvedValue(envelope({ versions: [{ ...version(), ...patch }], activation: null }))
    await expect(listSourcePlanVersions(SYSTEM)).rejects.toMatchObject({ status: 0 })
  })

  it('does not leak refusal data and rejects a forged activation generation', async () => {
    deny = true
    await expect(listSourcePlanVersions(SYSTEM)).rejects.toMatchObject({ status: 403, message: 'PLM read plan request failed (403)' })
    deny = false
    h.apiFetch.mockResolvedValue(envelope(activation('active', 5)))
    await expect(activateSourcePlanVersion(SYSTEM, 'version_1', 0)).rejects.toMatchObject({ status: 0 })
  })

  it.each(['active', 'disabled'] as const)('rejects a %s pointer whose exact version ID names different content', async (status) => {
    h.apiFetch.mockResolvedValue(envelope({ versions: [version('approved')], activation: {
      ...activation(status), contentKey: 'b'.repeat(64),
    } }))
    await expect(listSourcePlanVersions(SYSTEM)).rejects.toMatchObject({ status: 0 })
  })

  it('rejects an exact version ID reused by a pointer for a different source', async () => {
    h.apiFetch.mockResolvedValue(envelope({ versions: [version('approved')], activation: {
      ...activation(), systemId: 'sys_other_owned',
    } }))
    await expect(listSourcePlanVersions(SYSTEM)).rejects.toMatchObject({ status: 0 })
  })

  it.each([
    activation(),
    { ...activation(), versionId: 'version_older', contentKey: 'b'.repeat(64) },
    { ...activation(), versionId: 'version_other', systemId: 'sys_other_owned', contentKey: 'c'.repeat(64) },
  ])('preserves a matching or independently owned/unlisted pointer %j', async (current) => {
    h.apiFetch.mockResolvedValue(envelope({ versions: [version('approved')], activation: current }))
    await expect(listSourcePlanVersions(SYSTEM)).resolves.toMatchObject({ activation: {
      versionId: current.versionId, systemId: current.systemId, contentKey: current.contentKey,
    } })
  })
})

describe('online management in the existing source-binding editor', () => {
  it.each(['zh-CN', 'en-US'])('copies only the selected saved read plan after explicit local confirmation in %s', async locale => {
    h.locale = locale
    const savedReadPlan = { ...READ_PLAN, maxReadCount: 7, pathExAttr: { ...READ_PLAN.pathExAttr, object: 'SYN_SAVED_PATH' } }
    versions = [version('approved'), { ...version('draft', 'version_2'), config: { ...version().config, readPlan: savedReadPlan } }]
    pointer = activation()
    await mount()
    await click('source-plan-draft-synthetic')
    await input('source-plan-draft-input-pathExAttr-object', 'SYN_LOCAL_KEEP')
    await click('source-plan-draft-preview')
    await manage()
    expect((element('plan-copy-draft') as HTMLButtonElement).disabled).toBe(true)
    await click('plan-version-version_2')
    await click('source-plan-draft-preview')
    const count = h.apiFetch.mock.calls.length
    const serverBefore = JSON.stringify({ versions, pointer })
    await click('plan-copy-draft')
    expect((element('source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('SYN_LOCAL_KEEP')
    expect(element('plan-copy-confirm')).not.toBeNull()
    expect(element('plan-copy-confirm').textContent).toContain(locale === 'zh-CN' ? '替换当前本地草稿' : 'Replace the current local draft')
    expect(element('source-plan-draft-json')).toBeNull()
    expect((element('source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('SYN_LOCAL_KEEP')
    await click('plan-copy-confirm-cancel')
    expect(element('plan-copy-confirm')).toBeNull()
    expect((element('source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('SYN_LOCAL_KEEP')
    await click('plan-copy-draft')
    await click('plan-copy-confirm-submit')
    expect(element('plan-copy-confirm')).toBeNull()
    expect((element('source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('SYN_SAVED_PATH')
    expect((element('source-plan-draft-max-read-count') as HTMLInputElement).value).toBe('7')
    expect(element('source-plan-draft-json')).toBeNull()
    await click('source-plan-draft-preview')
    const exported = JSON.parse(element('source-plan-draft-json').textContent!)
    expect(exported).toEqual({ schemaVersion: 1, kind: 'stock-preparation-plm-role-draft', status: 'confirm-required', validation: 'structure-only', readPlan: savedReadPlan })
    expect(parseSourcePlanDraftJson(JSON.stringify(exported)).ok).toBe(true)
    for (const forbidden of [SYSTEM, SCOPE.tenantId, SCOPE.workspaceId, 'version_2', HASH, 'validation_1', 'validationId', 'contentKey', 'approved', 'activation', 'owner']) expect(JSON.stringify(exported)).not.toContain(forbidden)
    expect(JSON.stringify({ versions, pointer })).toBe(serverBefore)
    expect(h.apiFetch.mock.calls).toHaveLength(count)
    expect(mutations()).toHaveLength(0)
  })

  it.each(['selection', 'source', 'session', 'scope', 'local-edit', 'refresh'])('invalidates local copy confirmation on %s', async change => {
    versions = [version(), version('approved', 'version_2')]
    const scope = reactive({ ...SCOPE })
    await mount(scope)
    await click('source-plan-draft-synthetic')
    await input('source-plan-draft-input-pathExAttr-object', 'SYN_LOCAL_KEEP')
    await manage()
    await click('plan-version-version_1')
    await click('plan-copy-draft')
    const stale = element('plan-copy-confirm-submit')
    if (change === 'selection') await click('plan-version-version_2')
    else if (change === 'source') await input('plan-system', 'sys_other_owned')
    else if (change === 'session') { notifyAuthPrincipalChange(); await flush() }
    else if (change === 'scope') { scope.workspaceId = 'synthetic_other_workspace'; await flush() }
    else if (change === 'local-edit') await input('source-plan-draft-input-pathExAttr-object', 'SYN_NEW_LOCAL')
    else await click('plan-refresh')
    stale.click()
    await flush()
    expect(element('plan-copy-confirm')).toBeNull()
    expect(element('source-plan-draft-json')).toBeNull()
    const value = (element('source-plan-draft-input-pathExAttr-object') as HTMLInputElement | null)?.value
    expect(value).not.toBe(READ_PLAN.pathExAttr.object)
    expect(mutations()).toHaveLength(0)
  })

  it('cannot copy while a request is pending and does not use approval confirmation for local copy', async () => {
    versions = [version()]
    await mount()
    await manage()
    await click('plan-version-version_1')
    await click('plan-approve')
    expect(element('plan-confirm')).not.toBeNull()
    await click('plan-copy-draft')
    expect(element('plan-confirm')).toBeNull()
    await click('plan-copy-confirm-cancel')
    const response = deferred()
    delay = { path: '', method: 'GET', response }
    await click('plan-refresh')
    expect(element('plan-copy-draft')).toBeNull()
    response.resolve(envelope({ versions, activation: pointer }))
    await flush()
    expect(mutations()).toHaveLength(0)
  })

  it('downloads a local review file and imports it into another instance without inheriting its source', async () => {
    const savedReadPlan = { ...READ_PLAN, maxReadCount: 9, part: { ...READ_PLAN.part, object: 'SYN_SAVED_PART' } }
    versions = [{ ...version('approved'), config: { ...version().config, readPlan: savedReadPlan } }]
    await mount()
    await manage()
    await click('plan-version-version_1')
    await click('plan-copy-draft')
    await click('plan-copy-confirm-submit')
    await click('source-plan-draft-preview')
    let downloadBlob: Blob | null = null
    class ReviewURL extends URL {
      static createObjectURL = vi.fn((blob: Blob) => { downloadBlob = blob; return 'blob:synthetic-review' })
      static revokeObjectURL = vi.fn()
    }
    vi.stubGlobal('URL', ReviewURL)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const count = h.apiFetch.mock.calls.length
    await click('source-plan-draft-download')
    expect(downloadBlob).toBeInstanceOf(Blob)
    const exported = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('synthetic review read failed'))
      reader.readAsText(downloadBlob!)
    })
    expect(parseSourcePlanDraftJson(exported).ok).toBe(true)
    expect(h.apiFetch.mock.calls).toHaveLength(count)
    app!.unmount(); app = null
    await mount({ tenantId: 'synthetic_second_tenant', workspaceId: 'synthetic_second_workspace' })
    await click('plan-management-toggle')
    await input('plan-system', 'sys_second_owned')
    const secondCount = h.apiFetch.mock.calls.length
    const importer = element('source-plan-draft-import') as HTMLInputElement
    Object.defineProperty(importer, 'files', { configurable: true, value: [new File([exported], 'synthetic.review.json', { type: 'application/json' })] })
    importer.dispatchEvent(new Event('change'))
    await flush()
    expect((element('source-plan-draft-input-part-object') as HTMLInputElement).value).toBe('SYN_SAVED_PART')
    expect((element('plan-system') as HTMLInputElement).value).toBe('sys_second_owned')
    expect(element('plan-versions')).toBeNull()
    expect(element('plan-confirm')).toBeNull()
    await click('source-plan-draft-preview')
    expect(JSON.parse(element('source-plan-draft-json').textContent!).readPlan).toEqual(savedReadPlan)
    expect(h.apiFetch.mock.calls).toHaveLength(secondCount)
    expect(mutations()).toHaveLength(0)
  })

  it('starts local, then saves, selects, approves, activates and disables exact versions without changing execution scope', async () => {
    localStorage.setItem('workspaceId', SCOPE.workspaceId)
    await mount()
    expect(element('plan-management')).toBeNull()
    await click('source-plan-draft-synthetic')
    await click('source-plan-draft-preview')
    expect(onlineCalls()).toHaveLength(0)
    expect(element('source-plan-draft-download')).not.toBeNull()
    await manage()
    expect(element('plan-management-scope').textContent).toContain('workspace=null')
    expect(element('plan-execution-scope').textContent).toContain(SCOPE.workspaceId)
    expect(element('plan-execution-scope').textContent).toContain('未查询')
    await click('plan-save')
    expect(mutations()).toHaveLength(1)
    expect(element('plan-version-version_1')).not.toBeNull()
    expect(element('plan-selected-details')).toBeNull()
    await click('plan-version-version_1')
    await click('plan-approve')
    expect(mutations()).toHaveLength(1)
    expect(element('plan-confirm').textContent).toContain('version_1')
    expect(element('plan-confirm-generation')).toBeNull()
    expect(element('plan-confirm').textContent).not.toContain('代次')
    await click('plan-confirm-submit')
    expect(element('plan-activation').textContent).toContain('尚无激活记录')
    await click('plan-activate')
    expect(element('plan-confirm-generation').textContent).toContain('预期激活指针代次（并发校验）： 0')
    await click('plan-confirm-submit')
    expect(element('plan-activation').textContent).toContain('已激活')
    await click('plan-deactivate')
    expect(element('plan-confirm-generation').textContent).toContain('预期激活指针代次（并发校验）： 1')
    await click('plan-confirm-submit')
    expect(element('plan-activation').textContent).toContain('已停用')
    expect(mutations().map(([url]) => String(url).slice(SOURCE_PLAN_VERSIONS_ROUTE.length))).toEqual(['', '/version_1/approve', '/version_1/activate', '/deactivate'])
    expect(onlineCalls().filter(([, init]) => !init.method)).toHaveLength(5)
    expect(localStorage.getItem('workspaceId')).toBe(SCOPE.workspaceId)
    expect(String(h.apiFetch.mock.calls[0][0])).toContain(`workspaceId=${SCOPE.workspaceId}`)
    expect(element('source-current-id').textContent).toContain('sys_bound_workspace')
  })

  it('requires the server-owned list, hides management for non-admins, and keeps refusal values out of the DOM', async () => {
    await mount()
    deny = true
    await manage()
    expect(element('plan-error').textContent).toContain('HTTP 403')
    expect(element('plan-error').textContent).toContain('连接所有权')
    expect(container.textContent).not.toContain('PRIVATE_')
    expect((element('plan-save') as HTMLButtonElement).disabled).toBe(true)
    expect(mutations()).toHaveLength(0)
    h.permissions = ['stock-prep:admin']
    notifyAuthPrincipalChange()
    await flush()
    expect(element('plan-management-toggle')).toBeNull()
    const calls = h.apiFetch.mock.calls.length
    h.permissions = ['integration:admin']
    notifyAuthPrincipalChange()
    await flush()
    expect(element('plan-management')).toBeNull()
    expect(h.apiFetch.mock.calls).toHaveLength(calls)
  })

  it('keeps a changed local draft separate from the immutable saved version being approved', async () => {
    versions = [version()]
    await mount()
    await click('source-plan-draft-synthetic')
    await manage()
    await click('plan-version-version_1')
    await input('source-plan-draft-input-pathExAttr-object', 'SYN_NEW_LOCAL')
    await click('plan-approve')
    await click('plan-confirm-submit')
    expect(mutations()).toHaveLength(1)
    expect(JSON.parse(mutations()[0][1].body)).toEqual({ managementScope: 'tenant', systemId: SYSTEM })
    expect(element('plan-selected-details').textContent).not.toContain('SYN_NEW_LOCAL')
    expect((element('source-plan-draft-input-pathExAttr-object') as HTMLInputElement).value).toBe('SYN_NEW_LOCAL')
  })

  it('displays another owned source pointer and cannot disable it through the selected target', async () => {
    pointer = { ...activation(), versionId: 'version_other', systemId: 'sys_other_owned' }
    versions = [version('approved')]
    await mount()
    await manage()
    expect(element('plan-activation').textContent).toContain('当前指向另一系统')
    expect((element('plan-deactivate') as HTMLButtonElement).disabled).toBe(true)
    await click('plan-version-version_1')
    await click('plan-activate')
    await click('plan-confirm-submit')
    expect(JSON.parse(mutations()[0][1].body).expectedGeneration).toBe(1)
  })

  it('does not render a version body or activation after an inconsistent list response', async () => {
    versions = [{ ...version('approved'), contentKey: 'b'.repeat(64), config: {
      ...version().config, readPlan: { ...READ_PLAN, pathExAttr: { ...READ_PLAN.pathExAttr, object: 'SYN_BODY_B' } },
    } }]
    pointer = activation()
    await mount()
    await manage()
    expect(element('plan-error')).not.toBeNull()
    expect(element('plan-versions')).toBeNull()
    expect(element('plan-activation')).toBeNull()
    expect(container.textContent).not.toContain('SYN_BODY_B')
    expect(mutations()).toHaveLength(0)
  })

  it.each(['save', 'approve', 'activate', 'deactivate'] as const)('locks version selection while %s is pending, then publishes the actual readback', async (action) => {
    versions = [version(action === 'approve' ? 'draft' : 'approved'), version('approved', 'version_2')]
    pointer = action === 'deactivate' ? activation() : null
    await mount()
    await click('source-plan-draft-synthetic')
    await manage()
    await click('plan-version-version_1')
    const response = deferred()
    delay = { path: action === 'save' ? '' : action === 'deactivate' ? '/deactivate' : `/version_1/${action}`, method: 'POST', response }
    if (action === 'save') await click('plan-save')
    else { await click(`plan-${action}`); await click('plan-confirm-submit') }
    expect(mutations()).toHaveLength(1)
    const calls = onlineCalls().length
    expect((element('plan-version-version_2') as HTMLInputElement).disabled).toBe(true)
    await click('plan-version-version_2')
    expect((element('plan-version-version_1') as HTMLInputElement).checked).toBe(true)
    expect((element('plan-version-version_2') as HTMLInputElement).checked).toBe(false)
    versions = [version('approved'), version('approved', 'version_2')]
    if (action === 'activate') pointer = activation()
    if (action === 'deactivate') pointer = activation('disabled', 2)
    response.resolve(envelope(action === 'save' || action === 'approve' ? versions[0] : pointer))
    await flush()
    expect(onlineCalls()).toHaveLength(calls + 1)
    expect((element('plan-version-version_2') as HTMLInputElement).disabled).toBe(false)
    expect((element('plan-version-version_1') as HTMLInputElement).checked).toBe(true)
    expect(element('plan-error')).toBeNull()
    expect(element('plan-versions').textContent).toContain('已审批')
    if (action === 'activate') expect(element('plan-activation').textContent).toContain('已激活')
    if (action === 'deactivate') expect(element('plan-activation').textContent).toContain('已停用')
  })

  it.each(['success', 'failure'] as const)('ignores a late list %s after a target switch and retains real busy state', async (outcome) => {
    await mount()
    const response = deferred()
    delay = { path: '', method: 'GET', response }
    await manage()
    await input('plan-system', 'sys_next')
    expect((element('plan-refresh') as HTMLButtonElement).disabled).toBe(true)
    response.resolve(outcome === 'success' ? envelope({ versions: [version()], activation: activation() }) : refusal())
    await flush()
    expect(element('plan-versions')).toBeNull()
    expect(element('plan-error')).toBeNull()
    expect((element('plan-refresh') as HTMLButtonElement).disabled).toBe(false)
  })

  it.each((['save', 'approve', 'activate', 'deactivate'] as const).flatMap(action =>
    (['success', 'failure'] as const).map(outcome => ({ action, outcome }))))('never publishes a late $action $outcome into the next scope/session', async ({ action, outcome }) => {
    const scope = reactive({ ...SCOPE })
    versions = [version(action === 'approve' ? 'draft' : 'approved')]
    pointer = action === 'deactivate' ? activation() : null
    await mount(scope)
    await click('source-plan-draft-synthetic')
    await manage()
    await click('plan-version-version_1')
    const response = deferred()
    delay = { path: action === 'save' ? '' : action === 'deactivate' ? '/deactivate' : `/version_1/${action}`, method: 'POST', response }
    if (action === 'save') await click('plan-save')
    else { await click(`plan-${action}`); await click('plan-confirm-submit') }
    expect(mutations()).toHaveLength(1)
    const count = onlineCalls().length
    scope.workspaceId = 'synthetic_next_workspace'
    notifyAuthPrincipalChange()
    await flush()
    response.resolve(outcome === 'failure' ? refusal() : envelope(action === 'save' || action === 'approve' ? version('approved') : activation(action === 'deactivate' ? 'disabled' : 'active', action === 'deactivate' ? 2 : 1)))
    await flush()
    expect(onlineCalls()).toHaveLength(count)
    expect(element('plan-management')).toBeNull()
    expect(element('plan-confirm')).toBeNull()
  })

  it('checks the live permission/session and mounted state even when handlers are called directly', async () => {
    versions = [version()]
    await mount()
    await click('source-plan-draft-synthetic')
    await manage()
    await click('plan-version-version_1')
    await click('plan-approve')
    const internal = app!._instance as unknown as { setupState: {
      loadPlanVersions: () => Promise<void>
      savePlanDraft: () => Promise<void>
      askPlanAction: (action: 'approve') => void
      confirmPlanAction: () => Promise<void>
    } }
    const invoke = async () => {
      await internal.setupState.confirmPlanAction()
      await internal.setupState.savePlanDraft()
      await internal.setupState.loadPlanVersions()
      internal.setupState.askPlanAction('approve')
      await internal.setupState.confirmPlanAction()
    }
    const count = onlineCalls().length
    h.permissions = []
    localStorage.setItem('user_permissions', '[]')
    await invoke()
    expect(onlineCalls()).toHaveLength(count)
    app!.unmount()
    app = null
    h.permissions = ['integration:admin']
    await invoke()
    expect(onlineCalls()).toHaveLength(count)
  })

  it('invalidates a pending exact-version confirmation on selection changes and ignores readback after unmount', async () => {
    versions = [version(), version('approved', 'version_2')]
    await mount()
    await manage()
    await click('plan-version-version_1')
    await click('plan-approve')
    const oldButton = element('plan-confirm-submit')
    await click('plan-version-version_2')
    oldButton.click()
    await flush()
    expect(mutations()).toHaveLength(0)
    const response = deferred()
    delay = { path: '', method: 'GET', response }
    await click('plan-refresh')
    app!.unmount()
    app = null
    const count = onlineCalls().length
    response.resolve(envelope({ versions: [version()], activation: null }))
    await flush()
    expect(onlineCalls()).toHaveLength(count)
    expect(container.textContent).toBe('')
  })
})
