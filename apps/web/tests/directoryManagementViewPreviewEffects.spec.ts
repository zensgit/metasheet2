import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DirectoryManagementView from '../src/views/DirectoryManagementView.vue'

const api = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch: api }))
const integration = {
  id: 'preview-a', name: 'Synthetic directory', corpId: 'synthetic-corp',
  status: 'active', syncEnabled: false, scheduleCron: null, lastSyncAt: null, lastSuccessAt: null, lastError: null,
  defaultDeprovisionPolicy: 'manual_review',
  config: { appKey: '', appSecretConfigured: true, rootDepartmentId: '1', baseUrl: null, pageSize: 50,
    admissionMode: 'manual_only', admissionDepartmentIds: [], excludeDepartmentIds: [],
    memberGroupSyncMode: 'disabled', memberGroupDepartmentIds: [], memberGroupDefaultRoleIds: [], memberGroupDefaultNamespaces: [] },
  stats: { departmentCount: 0, accountCount: 0, pendingLinkCount: 0, linkedCount: 0, lastRunStatus: null },
}
const effects = {
  wouldAdmitUsers: 9, wouldBindAccounts: 2, wouldUnbindAccounts: 1, wouldCreateMemberGroups: 3, wouldSyncMemberGroups: 4,
  wouldAddMemberGroupMemberships: 5, wouldRemoveMemberGroupMemberships: 6, wouldAssignRoles: 7, wouldAdmitNamespaces: 8,
}
let app: App<Element> | null = null
let host: HTMLDivElement | null = null
afterEach(() => { app?.unmount(); host?.remove(); app = null; host = null; api.mockReset(); window.history.replaceState({}, '', '/') })
async function flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
type PreviewResponse = { ok: boolean; status: number; json: () => Promise<unknown> }
function payload(extra: Record<string, unknown>, id = 'preview-a') {
  return { ok: true, data: { preview: {
    integrationId: id, integrationName: integration.name, departmentsSeen: 1, accountsSeen: 4,
    wouldCreateAccounts: 3, wouldDeactivateAccounts: 0, wouldDeactivateLinkedAccounts: 0,
    autoAdmissionMode: 'manual_only', autoAdmissionCandidateCount: 0, autoAdmissionSkippedMissingEmailCount: 0,
    autoAdmissionExcludedCount: 0, sampledNewAccounts: [], sampledDeactivations: [], ...extra,
  } } }
}
function response(extra: Record<string, unknown>, id = 'preview-a'): PreviewResponse {
  return { ok: true, status: 200, json: async () => payload(extra, id) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function previewButton() {
  const button = Array.from(host!.querySelectorAll('button')).find(b => b.textContent?.trim().startsWith('预览'))
  expect(button).toBeDefined()
  return button!
}
async function select(id: 'preview-a' | 'preview-b') {
  const name = id === 'preview-a' ? integration.name : 'Synthetic B'
  const button = Array.from(host!.querySelectorAll<HTMLButtonElement>('.directory-admin__item'))
    .find(b => b.querySelector('strong')?.textContent === name)
  expect(button).toBeDefined(); button!.click(); await flush()
  expect(host!.querySelector('.directory-admin__item--active strong')?.textContent).toBe(name)
}
async function mountPreview(extra: Record<string, unknown>, setup: {
  two?: boolean; handle?: (path: string) => PreviewResponse | Promise<PreviewResponse> | undefined
} = {}) {
  api.mockImplementation(async (path: string) => {
    const controlled = setup.handle?.(path)
    if (controlled !== undefined) return controlled
    if (path.endsWith('/sync/preview')) return response(extra, path.split('/')[5])
    return { ok: true, status: 200, json: async () => path === '/api/admin/directory/integrations'
      ? { ok: true, data: { items: setup.two ? [integration, { ...integration, id: 'preview-b', name: 'Synthetic B' }] : [integration] } }
      : { ok: true, data: { items: [], total: 0 } } }
  })
  host = document.createElement('div'); document.body.appendChild(host)
  app = createApp(DirectoryManagementView); app.component('RouterLink', { template: '<a><slot /></a>' }); app.mount(host)
  await flush(); previewButton().click(); await flush()
}

describe('directory preview effect counters in the real view', () => {
  it('retains the original account preview and read-only request control', async () => {
    await mountPreview(effects)
    expect(host!.textContent).toContain('将新增账号 3')
    expect(api).toHaveBeenCalledWith('/api/admin/directory/integrations/preview-a/sync/preview', expect.objectContaining({ method: 'POST' }))
    expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('renders all nine prospective binding and governance differences', async () => {
    await mountPreview(effects)
    const panel = host!.querySelector('[data-testid="directory-preview-effects"]')
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain('关联数量不等同于最终有效权限')
    expect(panel!.textContent).toContain('将准入本地用户 9')
    expect(panel!.textContent).toContain('将绑定账号 2')
    expect(panel!.textContent).toContain('将解除绑定 1')
    expect(panel!.textContent).toContain('将新增成员组 3')
    expect(panel!.textContent).toContain('将同步成员组 4')
    expect(panel!.textContent).toContain('将加入成员组 5')
    expect(panel!.textContent).toContain('将移出成员组 6')
    expect(panel!.textContent).toContain('将新增角色分配 7')
    expect(panel!.textContent).toContain('将新增命名空间准入 8')
  })
  it('renders actual zero differences explicitly', async () => {
    await mountPreview(Object.fromEntries(Object.keys(effects).map(k => [k, 0])))
    const panel = host!.querySelector('[data-testid="directory-preview-effects"]')
    expect(panel).not.toBeNull()
    expect(panel!.querySelectorAll('[data-preview-effect]')).toHaveLength(9)
    expect(Array.from(panel!.querySelectorAll('[data-preview-effect]')).every(e => e.textContent?.trim().endsWith('0'))).toBe(true)
  })
  it('does not invent zero or stringify private malformed counters from a legacy response', async () => {
    await mountPreview({ wouldBindAccounts: '<private>', wouldUnbindAccounts: -1, wouldAssignRoles: 2 ** 54 })
    const panel = host!.querySelector('[data-testid="directory-preview-effects"]')
    expect(panel).not.toBeNull()
    expect(panel!.querySelectorAll('[data-preview-effect]')).toHaveLength(9)
    expect(panel!.textContent).not.toContain('private')
    expect(panel!.textContent).not.toContain('undefined')
    expect(Array.from(panel!.querySelectorAll('[data-preview-effect]')).every(e => e.textContent?.includes('未提供'))).toBe(true)
  })
})

describe('directory preview scope lifetime', () => {
  it('clears the previous result when the current preview refresh fails', async () => {
    await mountPreview(effects)
    expect(host!.querySelector('[data-testid="directory-preview-effects"]')).not.toBeNull()
    api.mockRejectedValueOnce(new Error('SYNTHETIC_CURRENT_PREVIEW_FAILURE'))
    previewButton().click(); await flush()
    expect(host!.textContent).toContain('SYNTHETIC_CURRENT_PREVIEW_FAILURE')
    expect(host!.querySelector('[data-testid="directory-preview-effects"]')).toBeNull()
  })
  it('rejects old headers after switching to B without decoding the old preview', async () => {
    const a = deferred<PreviewResponse>(), json = vi.fn(async () => payload({ ...effects, wouldAdmitUsers: 99 }))
    await mountPreview(effects, { two: true, handle: p => p.includes('/preview-a/sync/preview') ? a.promise : undefined })
    await select('preview-b'); a.resolve({ ok: true, status: 200, json }); await flush()
    expect(json).not.toHaveBeenCalled()
    expect(host!.querySelector('[data-testid="directory-preview-effects"]')).toBeNull()
  })
  it('rejects an old JSON continuation after switching to B', async () => {
    const json = deferred<unknown>()
    await mountPreview(effects, { two: true, handle: p => p.includes('/preview-a/sync/preview')
      ? { ok: true, status: 200, json: () => json.promise } : undefined })
    await select('preview-b'); json.resolve(payload({ ...effects, wouldAdmitUsers: 99 })); await flush()
    expect(host!.querySelector('[data-testid="directory-preview-effects"]')).toBeNull()
    expect(host!.textContent).not.toContain('将准入本地用户 99')
  })
  it('does not publish an old failure in the newly selected integration', async () => {
    const a = deferred<PreviewResponse>()
    await mountPreview(effects, { two: true, handle: p => p.includes('/preview-a/sync/preview') ? a.promise : undefined })
    await select('preview-b'); a.reject(new Error('SYNTHETIC_OLD_PREVIEW_FAILURE')); await flush()
    expect(host!.textContent).not.toContain('SYNTHETIC_OLD_PREVIEW_FAILURE')
  })
  it('allows the current B preview and keeps its loading state when old A finally completes', async () => {
    const a = deferred<PreviewResponse>(), b = deferred<PreviewResponse>()
    await mountPreview(effects, { two: true, handle: p => p.includes('/sync/preview')
      ? p.includes('/preview-a/') ? a.promise : b.promise : undefined })
    try {
      await select('preview-b'); expect(previewButton().disabled).toBe(false)
      previewButton().click(); await flush(); expect(previewButton().disabled).toBe(true)
      a.resolve(response({ ...effects, wouldAdmitUsers: 99 })); await flush()
      expect(previewButton().disabled).toBe(true)
      b.resolve(response({ ...effects, wouldAdmitUsers: 2 }, 'preview-b')); await flush()
      expect(host!.querySelector('[data-testid="directory-preview-effects"]')?.textContent).toContain('将准入本地用户 2')
    } finally {
      a.resolve(response(effects)); b.resolve(response(effects, 'preview-b')); await flush()
    }
  })
  it('does not reauthorize an A response after an A-B-A selection round trip', async () => {
    const a = deferred<PreviewResponse>(), json = vi.fn(async () => payload(effects))
    await mountPreview(effects, { two: true, handle: p => p.includes('/preview-a/sync/preview') ? a.promise : undefined })
    await select('preview-b'); await select('preview-a')
    a.resolve({ ok: true, status: 200, json }); await flush()
    expect(json).not.toHaveBeenCalled()
    expect(host!.querySelector('[data-testid="directory-preview-effects"]')).toBeNull()
  })
  it('makes preview headers inert after unmount', async () => {
    const a = deferred<PreviewResponse>(), json = vi.fn(async () => payload(effects))
    await mountPreview(effects, { handle: p => p.includes('/sync/preview') ? a.promise : undefined })
    app!.unmount(); app = null; a.resolve({ ok: true, status: 200, json }); await flush()
    expect(json).not.toHaveBeenCalled()
  })
})
