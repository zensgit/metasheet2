import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DirectoryManagementView from '../src/views/DirectoryManagementView.vue'

const api = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => api(...args) }))
vi.mock('../src/components/directory/DirectoryDeprovisionEvidencePanel.vue', () => ({
  default: { template: '<div />' },
}))

const response = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => ({ ok: status < 400, data }),
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const integration = (id: string) => ({
  id, name: id, corpId: 'synthetic', status: 'active', syncEnabled: false,
  scheduleCron: null, defaultDeprovisionPolicy: 'mark_inactive',
  lastSyncAt: null, lastSuccessAt: null, lastError: null,
  config: {
    appKey: '', appSecretConfigured: false, rootDepartmentId: '1', baseUrl: null,
    pageSize: 50, admissionMode: 'manual_only', admissionDepartmentIds: [],
    excludeDepartmentIds: [], memberGroupSyncMode: 'disabled',
    memberGroupDepartmentIds: [], memberGroupDefaultRoleIds: [], memberGroupDefaultNamespaces: [],
  },
  stats: { departmentCount: 0, accountCount: 0, pendingLinkCount: 0, linkedCount: 0, lastRunStatus: null },
})
const run = (id: string) => ({
  id, status: 'completed', startedAt: '2026-01-01T00:00:00Z', finishedAt: null,
  stats: { accountsSynced: 1 }, errorMessage: id,
})
const alert = (id: string, details: Record<string, unknown> = {}) => ({
  id, integrationId: 'dir-1', runId: null, level: 'warning',
  code: 'root_department_sparse', message: id, details,
  createdAt: '2026-01-01T00:00:00Z', acknowledgedAt: null, acknowledgedBy: null,
})
async function flush() {
  for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() }
}

describe('directory management server observations', () => {
  let app: App<Element> | null
  let root: HTMLDivElement
  let runs: (url: URL) => unknown
  let alerts: (url: URL) => unknown
  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    runs = () => response({ items: [run('run-control')], total: 21 })
    alerts = () => response({ items: [alert('alert-control')], total: 41, counts: { total: 41, pending: 35, acknowledged: 6 } })
    api.mockReset()
    api.mockImplementation((path: string) => {
      const url = new URL(path, 'http://synthetic.invalid')
      if (url.pathname === '/api/admin/directory/integrations') return response({ items: [integration('dir-1'), integration('dir-2')] })
      if (url.pathname.endsWith('/runs')) return runs(url)
      if (url.pathname.endsWith('/alerts')) return alerts(url)
      if (url.pathname.endsWith('/schedule')) return response({ snapshot: null })
      return response({ items: [], total: 0, counts: {} })
    })
    root = document.createElement('div'); document.body.append(root); app = null
  })
  afterEach(() => {
    app?.unmount(); root.remove(); vi.restoreAllMocks()
    window.history.replaceState({}, '', '/')
  })
  async function mount() {
    app = createApp(DirectoryManagementView)
    app.component('RouterLink', { template: '<a><slot /></a>' })
    app.mount(root); await flush()
  }
  async function click(id: string) {
    const button = root.querySelector<HTMLButtonElement>('[data-testid="' + id + '"]')
    expect(button, id).not.toBeNull()
    expect(button!.disabled, id).toBe(false)
    button!.click(); await flush()
  }
  async function selectSecond() {
    const item = Array.from(root.querySelectorAll<HTMLButtonElement>('.directory-admin__item')).find(x => x.textContent?.includes('dir-2'))
    expect(item).toBeDefined(); item!.click(); await flush()
  }

  it('retains the original successful run and alert rendering control', async () => {
    await mount()
    expect(root.textContent).toContain('completed')
    expect(root.textContent).toContain('alert-control')
  })
  it('retains default first-page API requests as a control', async () => {
    await mount()
    expect(api).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/runs?page=1&pageSize=10')
    expect(api).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=20&filter=all')
  })
  it('requests the second run page and replaces first-page rows', async () => {
    runs = url => response({ items: [run(url.searchParams.get('page') === '2' ? 'page-two' : 'page-one')], total: 21 })
    await mount(); await click('directory-runs-next')
    expect(api).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/runs?page=2&pageSize=10')
    expect(root.querySelector('[data-testid="directory-run-page"]')?.textContent).toContain('第 2 / 3 页')
  })
  it('requests the aborted run status instead of silently mapping it to failed', async () => {
    await mount(); await click('directory-runs-filter-aborted')
    expect(api).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/runs?page=1&pageSize=10&status=aborted')
  })
  it('uses server-global alert counts and requests confirmation filters on the server', async () => {
    await mount()
    const pending = root.querySelector('[data-testid="directory-alerts-filter-pending"]')
    expect(pending).not.toBeNull()
    expect(pending!.textContent).toContain('35')
    await click('directory-alerts-filter-pending')
    expect(api).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=20&filter=pending')
  })
  it('requests the second alert page', async () => {
    await mount(); await click('directory-alerts-next')
    expect(api).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/alerts?page=2&pageSize=20&filter=all')
    expect(root.querySelector('[data-testid="directory-alert-page"]')?.textContent).toContain('第 2 / 3 页')
  })
  it('renders bounded operational details without reflecting arbitrary values or HTML', async () => {
    alerts = () => response({ items: [alert('safe-alert', {
      accountsSeen: 17, rootDepartmentChildCount: 3,
      secret: 'must-not-render', harmless: 'private@example.test',
      pendingCount: { nested: 'do-not-stringify' }, errorCode: '<img src=x onerror=alert(1)>',
    })], total: 1, counts: { total: 1, pending: 1, acknowledged: 0 } })
    await mount()
    const details = root.querySelector('[data-testid="directory-alert-details"]')
    expect(details).not.toBeNull()
    expect(details!.textContent).toContain('17')
    expect(details?.textContent).toContain('3')
    expect(root.textContent).not.toContain('must-not-render')
    expect(root.textContent).not.toContain('private@example.test')
    expect(root.textContent).not.toContain('do-not-stringify')
    expect(root.querySelector('img')).toBeNull()
  })
  it.each(['runs', 'alerts'])('rejects late %s headers from the previously selected integration', async kind => {
    const late = deferred<ReturnType<typeof response>>()
    if (kind === 'runs') runs = url => url.pathname.includes('dir-1') ? late.promise : response({ items: [run('B')], total: 1 })
    else alerts = url => url.pathname.includes('dir-1') ? late.promise : response({ items: [alert('B')], total: 1, counts: { total: 1, pending: 1, acknowledged: 0 } })
    await mount(); await selectSecond()
    late.resolve(response({ items: [kind === 'runs' ? run('late-A') : alert('late-A')], total: 99, counts: { total: 99, pending: 99, acknowledged: 0 } }))
    await flush()
    expect(root.textContent).not.toContain('99')
    expect(root.textContent).not.toContain('late-A')
  })
  it('does not land a stale alert JSON continuation after filter changes', async () => {
    const late = deferred<{ ok: boolean; data: unknown }>()
    alerts = url => url.searchParams.get('filter') === 'all'
      ? { ok: true, status: 200, json: () => late.promise }
      : response({ items: [alert('pending-new')], total: 1, counts: { total: 1, pending: 1, acknowledged: 0 } })
    await mount()
    await click('directory-alerts-filter-pending')
    late.resolve({ ok: true, data: { items: [alert('stale-json')], total: 88, counts: { total: 88, pending: 88, acknowledged: 0 } } }); await flush()
    expect(root.textContent).toContain('pending-new')
    expect(root.textContent).not.toContain('stale-json')
  })
  it('does not publish an old failure or clear the current loading state', async () => {
    const old = deferred<ReturnType<typeof response>>(); const current = deferred<ReturnType<typeof response>>()
    alerts = url => url.pathname.includes('dir-1') ? old.promise : current.promise
    await mount(); await selectSecond(); old.reject(new Error('obsolete-private-error')); await flush()
    expect(root.textContent).not.toContain('obsolete-private-error')
    expect(root.textContent).toContain('最近告警加载中')
    current.resolve(response({ items: [alert('current')], total: 1, counts: { total: 1, pending: 1, acknowledged: 0 } })); await flush()
    expect(root.textContent).toContain('current')
  })
  it('does not refresh integration B after an acknowledgement from A completes', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    await mount()
    const original = api.getMockImplementation()!
    api.mockImplementation((path: string, ...args: unknown[]) => path.endsWith('/ack') ? pending.promise : original(path, ...args))
    const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(x => x.textContent?.trim() === '确认告警')
    expect(button).toBeDefined(); button!.click(); await flush()
    expect(api).toHaveBeenCalledWith('/api/admin/directory/alerts/alert-control/ack', { method: 'POST' })
    await selectSecond(); api.mockClear()
    pending.resolve(response({ alert: { acknowledgedAt: '2026-01-01T01:00:00Z' } })); await flush()
    expect(api).not.toHaveBeenCalled()
    expect(root.textContent).not.toContain('目录告警已确认')
  })

  it('acknowledging the last pending page refetches the correct shrunken page', async () => {
    let shrink = false
    alerts = url => response({
      items: url.searchParams.get('page') === '3' && shrink ? [] : [alert('last-pending')],
      total: shrink ? 20 : 41,
      counts: { total: 50, pending: shrink ? 20 : 41, acknowledged: shrink ? 30 : 9 },
    })
    await mount(); await click('directory-alerts-filter-pending')
    await click('directory-alerts-next'); await click('directory-alerts-next')
    const original = api.getMockImplementation()!
    api.mockImplementation((path: string, ...args: unknown[]) => {
      if (path.endsWith('/ack')) { shrink = true; return response({}) }
      return original(path, ...args)
    })
    const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(x => x.textContent?.trim() === '确认告警')
    expect(button).toBeDefined(); button!.click(); await flush()
    expect(api).toHaveBeenCalledWith('/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=20&filter=pending')
    expect(root.querySelector('[data-testid="directory-alert-page"]')?.textContent).toContain('第 1 / 1 页')
    expect(root.querySelector('[data-testid="directory-alerts-filter-pending"]')?.textContent).toContain('20')
  })

  it('a real host background poll cannot replace the selected second page', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    let polling = false
    runs = url => url.searchParams.get('page') === '1' && polling ? pending.promise : response({
      items: [run(url.searchParams.get('page') === '2' ? 'kept-page-two' : 'initial-page')], total: 21,
    })
    await mount()
    const original = api.getMockImplementation()!
    api.mockImplementation((path: string, ...args: unknown[]) => {
      if (path.endsWith('/sync')) { polling = true; return response({ runId: 'polled-run' }, 202) }
      return original(path, ...args)
    })
    const start = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(x => x.textContent?.trim() === '后台同步')
    expect(start).toBeDefined(); expect(start!.disabled).toBe(false)
    start!.click(); await flush(); await click('directory-runs-next')
    pending.resolve(response({ items: [{ ...run('polled-run'), status: 'running', errorMessage: 'wrong-first-page' }], total: 21 })); await flush()
    expect(root.textContent).toContain('kept-page-two')
    expect(root.textContent).not.toContain('wrong-first-page')
    expect(root.querySelector('[data-testid="directory-run-page"]')?.textContent).toContain('第 2 / 3 页')
  })

  it.each(['superseded', 'refused'])('acknowledgement refresh must preserve the latest %s read error', async mode => {
    const late = deferred<ReturnType<typeof response>>()
    await mount()
    const original = api.getMockImplementation()!
    api.mockImplementation((path: string, ...args: unknown[]) => {
      if (path.endsWith('/ack')) return response({})
      if (path.includes('/alerts?')) {
        const filter = new URL(path, 'http://synthetic.invalid').searchParams.get('filter')
        if (mode === 'refused' || filter === 'pending') return response({}, 403)
        return late.promise
      }
      return original(path, ...args)
    })
    const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(x => x.textContent?.trim() === '确认告警')
    expect(button).toBeDefined(); button!.click(); await flush()
    if (mode === 'superseded') {
      await click('directory-alerts-filter-pending')
      late.resolve(response({ items: [], total: 0, counts: { total: 0, pending: 0, acknowledged: 0 } }))
      await flush()
    }
    expect(root.textContent).toContain('加载最近告警失败')
    expect(root.textContent).not.toContain('目录告警已确认')
  })

})


import { effectScope, ref } from 'vue'
import { useDirectorySyncObservability } from '../src/composables/useDirectorySyncObservability'
import { directoryAlertDetailRows } from '../src/views/directoryAlertDetails'

describe('observation request lifetimes and paging protocol', () => {
  let scope: ReturnType<typeof effectScope>
  let selected: ReturnType<typeof ref<string>>
  let errors: ReturnType<typeof vi.fn>
  let observation: ReturnType<typeof useDirectorySyncObservability>
  beforeEach(() => {
    api.mockReset()
    scope = effectScope()
    selected = ref('dir-1')
    errors = vi.fn()
    scope.run(() => { observation = useDirectorySyncObservability(selected, errors) })
  })
  afterEach(() => scope.stop())

  it.each(['runs', 'alerts'])('does not even decode stale %s headers after reset', async kind => {
    const pending = deferred<ReturnType<typeof response>>()
    api.mockReturnValue(pending.promise)
    const task = kind === 'runs' ? observation.loadRuns('dir-1') : observation.loadAlerts('dir-1')
    observation.reset()
    const json = vi.fn(async () => ({ data: { items: [run('stale')], total: 99 } }))
    pending.resolve({ ok: true, status: 200, json })
    await task
    expect(json).not.toHaveBeenCalled()
    expect(observation.runs.value).toEqual([])
    expect(observation.alerts.value).toEqual([])
    expect(observation.loadingRuns.value).toBe(false)
    expect(observation.loadingAlerts.value).toBe(false)
    expect(errors).not.toHaveBeenCalled()
  })

  it.each(['runs', 'alerts'])('unmount makes a pending %s rejection inert', async kind => {
    const pending = deferred<ReturnType<typeof response>>()
    api.mockReturnValue(pending.promise)
    const task = kind === 'runs' ? observation.loadRuns('dir-1') : observation.loadAlerts('dir-1')
    scope.stop()
    pending.reject(new Error('must-not-echo'))
    await task
    expect(errors).not.toHaveBeenCalled()
    expect(observation.runs.value).toEqual([])
    expect(observation.alerts.value).toEqual([])
    expect(observation.runTotal.value).toBe(0)
    expect(observation.alertTotal.value).toBe(0)
  })

  it('increments context across A-B-A instead of authorizing the original acknowledgement continuation', () => {
    const original = observation.contextVersion()
    selected.value = 'dir-2'; selected.value = 'dir-1'
    expect(observation.contextVersion()).toBeGreaterThan(original)
  })

  it('clamps a shrunken run last page and refetches that exact page', async () => {
    api.mockImplementation((path: string) => {
      const page = new URL(path, 'http://synthetic.invalid').searchParams.get('page')
      return response({ items: page === '1' ? [run('initial')] : page === '2' ? [run('last')] : [], total: page === '1' ? 21 : 11 })
    })
    await observation.loadRuns('dir-1')
    await observation.changeRunPage(3)
    expect(api.mock.calls.map(x => x[0])).toEqual([
      '/api/admin/directory/integrations/dir-1/runs?page=1&pageSize=10',
      '/api/admin/directory/integrations/dir-1/runs?page=3&pageSize=10',
      '/api/admin/directory/integrations/dir-1/runs?page=2&pageSize=10',
    ])
    expect(observation.runPage.value).toBe(2)
    expect(observation.runTotal.value).toBe(11)
    expect(observation.runs.value.map(x => x.id)).toEqual(['last'])
    expect(observation.loadingRuns.value).toBe(false)
  })

  it.each([0, 20])('reloads the current pending alert page after count shrinks to %i', async total => {
    let shrink = false
    api.mockImplementation((path: string) => {
      const page = new URL(path, 'http://synthetic.invalid').searchParams.get('page')
      return response({ items: page === '1' && (!shrink || total > 0) ? [alert('last')] : [], total: shrink ? total : 41,
        counts: { total: 50, pending: shrink ? total : 41, acknowledged: shrink ? 50 - total : 9 } })
    })
    await observation.updateAlertFilter('pending')
    await observation.changeAlertPage(3)
    api.mockClear(); shrink = true
    await observation.loadAlerts('dir-1')
    expect(observation.alertPage.value).toBe(1)
    expect(observation.alertTotal.value).toBe(total)
    expect(observation.alertCounts.value).toEqual({ all: 50, pending: total, acknowledged: 50 - total })
    expect(observation.loadingAlerts.value).toBe(false)
    expect(api.mock.calls.map(x => x[0])).toEqual(total === 0 ? [
      '/api/admin/directory/integrations/dir-1/alerts?page=3&pageSize=20&filter=pending',
    ] : [
      '/api/admin/directory/integrations/dir-1/alerts?page=3&pageSize=20&filter=pending',
      '/api/admin/directory/integrations/dir-1/alerts?page=1&pageSize=20&filter=pending',
    ])
  })

  it.each(['runs', 'alerts'])('refuses new %s reads for a different selection', async kind => {
    if (kind === 'runs') await observation.loadRuns('dir-2')
    else await observation.loadAlerts('dir-2')
    expect(api).not.toHaveBeenCalled()
  })

  it.each(['runs', 'alerts'])('resets a failed second %s page to a valid empty first page', async kind => {
    api.mockResolvedValue(response({
      items: [kind === 'runs' ? run('old') : alert('old')],
      total: kind === 'runs' ? 21 : 41, counts: { total: 41, pending: 41, acknowledged: 0 },
    }))
    if (kind === 'runs') await observation.loadRuns('dir-1')
    else await observation.loadAlerts('dir-1')
    api.mockResolvedValue(response({ error: { message: 'do-not-echo' } }, 403))
    if (kind === 'runs') await observation.changeRunPage(2)
    else await observation.changeAlertPage(2)
    expect(kind === 'runs' ? observation.runPage.value : observation.alertPage.value).toBe(1)
    expect(kind === 'runs' ? observation.runTotal.value : observation.alertTotal.value).toBe(0)
    expect(kind === 'runs' ? observation.runs.value : observation.alerts.value).toEqual([])
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('returns true only when latest alert data commits and false for a superseded load', async () => {
    const late = deferred<ReturnType<typeof response>>()
    api.mockReturnValue(late.promise)
    const old = observation.loadAlerts('dir-1')
    api.mockResolvedValue(response({ items: [alert('current')], total: 1, counts: { total: 1, pending: 1, acknowledged: 0 } }))
    expect(await observation.loadAlerts('dir-1')).toBe(true)
    late.resolve(response({ items: [alert('stale')], total: 99, counts: { total: 99, pending: 99, acknowledged: 0 } }))
    expect(await old).toBe(false)
    expect(observation.alerts.value.map(x => x.id)).toEqual(['current'])
    expect(observation.alertTotal.value).toBe(1)
  })

  it('reports only the fixed current-scope error and removes old counts on refusal', async () => {
    api.mockResolvedValue(response({ error: { message: 'private-data' } }, 403))
    await observation.loadAlerts('dir-1')
    expect(errors.mock.calls).toEqual([['加载最近告警失败']])
    expect(observation.alertCounts.value).toEqual({ all: 0, pending: 0, acknowledged: 0 })
    expect(observation.alerts.value).toEqual([])
    expect(observation.loadingAlerts.value).toBe(false)
  })

  it('accepts a fresh first-page poll as a positive control', () => {
    const version = observation.runPollVersion()
    expect(observation.applyFirstPageRunPoll(version, 'dir-1', [run('polled')], 27)).toBe(true)
    expect(observation.runs.value.map(x => x.id)).toEqual(['polled'])
    expect(observation.runTotal.value).toBe(27)
  })

  it('rejects a poll started before a newer filtered read', async () => {
    const version = observation.runPollVersion()
    api.mockResolvedValue(response({ items: [run('filtered')], total: 1 }))
    await observation.updateRunStatus('failed')
    expect(observation.applyFirstPageRunPoll(version, 'dir-1', [run('stale-poll')], 99)).toBe(false)
    expect(observation.runs.value.map(x => x.id)).toEqual(['filtered'])
    expect(observation.runTotal.value).toBe(1)
  })

  it('never puts a first-page poll into the second page', async () => {
    api.mockResolvedValue(response({ items: [run('page-two')], total: 21 }))
    await observation.loadRuns('dir-1'); await observation.changeRunPage(2)
    const version = observation.runPollVersion()
    expect(version).toBeNull()
    expect(observation.applyFirstPageRunPoll(version, 'dir-1', [run('first-page')], 99)).toBe(false)
    expect(observation.runs.value.map(x => x.id)).toEqual(['page-two'])
  })

  it('invalidates a poll across reset and A-B-A', () => {
    const version = observation.runPollVersion()
    selected.value = 'dir-2'; selected.value = 'dir-1'
    expect(observation.applyFirstPageRunPoll(version, 'dir-1', [run('stale')], 9)).toBe(false)
    expect(observation.runs.value).toEqual([])
  })

  it('does not accept a poll whose main list was already loading', async () => {
    const pending = deferred<ReturnType<typeof response>>(); api.mockReturnValue(pending.promise)
    const task = observation.loadRuns('dir-1')
    const version = observation.runPollVersion()
    expect(version).toBeNull()
    pending.resolve(response({ items: [run('new-main')], total: 1 })); await task
    expect(observation.applyFirstPageRunPoll(version, 'dir-1', [run('old-poll')], 99)).toBe(false)
    expect(observation.runs.value.map(x => x.id)).toEqual(['new-main'])
  })
})

describe('bounded operational alert detail values', () => {
  it('preserves zero and false without reflecting arbitrary strings or nested records', () => {
    expect(directoryAlertDetailRows({
      accountsSeen: 0, rootDepartmentDirectUserHasMore: false,
      accountsSynced: '123', pendingCount: { value: 2 }, linkedCount: -1,
      durationMs: Infinity, harmless: 'private-data', secret: 'private-secret',
    })).toEqual([
      { label: '目录账号数', value: '0' }, { label: '直属成员还有更多', value: '否' },
    ])
  })
  it.each([null, undefined, 'private', [], { accountsSeen: NaN }, { accountsSeen: 2 ** 54 }])('does not stringify malformed detail values: %j', value => {
    expect(directoryAlertDetailRows(value)).toEqual([])
  })
})
