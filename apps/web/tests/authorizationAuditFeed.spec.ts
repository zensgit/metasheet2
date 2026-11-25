import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import AuthorizationAuditFeed from '../src/components/AuthorizationAuditFeed.vue'

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch: fetchMock }))
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
const EMPTY_LABEL = '默认账户与权限资源'
const HINT = '安全动作验证和管理员登录许可命令需在资源类型中单独选择。结果为空不代表没有发生。'
const MISSING_ACTOR = '\u2014'

function mountFeed() {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(AuthorizationAuditFeed)
  app.mount(host)
}

async function openFeed() {
  const details = host!.querySelector('details') as HTMLDetailsElement
  details.open = true
  details.dispatchEvent(new Event('toggle'))
  await flush()
}

function resourceSelect() {
  return host!.querySelector('select[aria-label="资源类型"]') as HTMLSelectElement
}

function actionSelect() {
  return host!.querySelector('select[aria-label="动作"]') as HTMLSelectElement
}

function setSelect(select: HTMLSelectElement, value: string) {
  select.value = value
  select.dispatchEvent(new Event('change'))
}

function optionValues(select: HTMLSelectElement) {
  return [...select.options].map((option) => option.value)
}

function optionLabel(select: HTMLSelectElement, value: string) {
  return [...select.options].find((option) => option.value === value)?.textContent?.trim() ?? ''
}

function clickText(text: string) {
  const button = [...host!.querySelectorAll('button')].find((item) => item.textContent?.includes(text))
  if (!button) throw new Error(`missing button ${text}`)
  ;(button as HTMLButtonElement).click()
}

function paramsOf(url: string) {
  return new URL(url, 'http://localhost').searchParams
}

function feedItem(overrides: Record<string, unknown> = {}) {
  return {
    created_at: '2026-03-01T00:00:00.000Z',
    actor_id: 'fixture-actor',
    resource_type: 'permission',
    action: 'grant',
    resource_id: 'fixture-target',
    action_details: { operationKind: 'fixture.grant' },
    source: 'audit_logs',
    source_id: 'fixture-1',
    ...overrides,
  }
}

function feedOk(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: { total: items.length, page: 1, pageSize: 20, items, ...extra } }),
  }
}

function feedFail(status: number, message: string) {
  return {
    ok: false,
    status,
    json: async () => ({
      ok: false,
      error: { message },
      data: { items: [feedItem({ actor_id: 'fixture-should-not-render', source_id: `err-${status}` })] },
    }),
  }
}

function setField(selector: string, value: string) {
  const input = host!.querySelector(selector) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}
let host: HTMLDivElement | undefined
let app: ReturnType<typeof createApp> | undefined
afterEach(() => { app?.unmount(); host?.remove(); fetchMock.mockReset() })

describe('authorization audit panel', () => {
  it('opens the unified feed, renders a text actor, and uses the same filters for CSV', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { total: 1, page: 1, items: [{ created_at: '2026-01-02', actor_id: 'actor-text-id', resource_type: 'legacy-permission', action: 'revoke', resource_id: 'target', action_details: { operationKind: 'legacy.revoke' }, source: 'authorization_operation', source_id: 'actor:uuid' }] } }) })
    host = document.createElement('div'); document.body.appendChild(host); app = createApp(AuthorizationAuditFeed); app.mount(host)
    const details = host.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')); await flush()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/admin/audit-activity?')
    expect(host.textContent).toContain('actor-text-id'); expect(host.textContent).toContain('legacy.revoke')
    const select = host.querySelector('select[aria-label="资源类型"]') as HTMLSelectElement
    select.value = 'legacy-permission'; select.dispatchEvent(new Event('change'))
    const search = host.querySelector('input[type="search"]') as HTMLInputElement
    search.value = 'actor-text-id'; search.dispatchEvent(new Event('input'))
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { items: [], total: 0, page: 1 } }) })
    const queryButton = [...host.querySelectorAll('button')].find(item => item.textContent?.includes('查询权限审计'))!
    queryButton.click(); await flush()
    expect(String(fetchMock.mock.calls[1][0])).toContain('resourceType=legacy-permission')
    expect(String(fetchMock.mock.calls[1][0])).toContain('q=actor-text-id')
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['csv']) })
      const button = [...host.querySelectorAll('button')].find(item => item.textContent?.includes('导出权限审计 CSV'))!
      button.click(); await flush()
      const exportUrl = String(fetchMock.mock.calls[2][0])
      expect(exportUrl).toContain('/api/admin/audit-activity/export.csv?')
      expect(exportUrl).toContain('resourceType=legacy-permission'); expect(exportUrl).toContain('q=actor-text-id')
      expect(click).toHaveBeenCalled()
    } finally { click.mockRestore(); URL.createObjectURL = create; URL.revokeObjectURL = revoke }
  })

  it('lists only the two new resources and keeps the original action set on the default resource', async () => {
    mountFeed()
    const resource = resourceSelect()
    expect(optionValues(resource)).toEqual([
      '',
      'permission',
      'legacy-permission',
      'permission-template',
      'user-role',
      'user-namespace-admission',
      'user',
      'user-security-action',
      'admin_login_grant_command',
    ])
    expect(optionLabel(resource, '')).toBe(EMPTY_LABEL)
    expect(optionLabel(resource, 'user-security-action')).toBe('安全动作验证')
    expect(optionLabel(resource, 'admin_login_grant_command')).toBe('管理员登录许可命令')
    expect(host!.textContent).toContain(HINT)
    expect(optionValues(actionSelect())).toEqual(['', 'grant', 'revoke', 'update'])
    setSelect(resource, 'permission')
    await flush()
    expect(optionValues(actionSelect())).toEqual(['', 'grant', 'revoke', 'update'])
    setSelect(resource, 'user-security-action')
    await flush()
    expect(optionValues(actionSelect())).toEqual(['', 'security_action_verify'])
    setSelect(resource, 'admin_login_grant_command')
    await flush()
    expect(optionValues(actionSelect())).toEqual(['', 'admin_login_grant_enable'])
  })

  it('clears an incompatible action when the resource changes and does not query until the button', async () => {
    fetchMock.mockResolvedValue(feedOk([]))
    mountFeed()
    await openFeed()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const resource = resourceSelect()
    const action = actionSelect()
    setSelect(resource, 'user-security-action')
    await flush()
    setSelect(action, 'security_action_verify')
    await flush()
    setSelect(resource, 'legacy-permission')
    await flush()
    expect(actionSelect().value).toBe('')
    expect(optionValues(actionSelect())).not.toContain('security_action_verify')

    setSelect(resource, 'user-security-action')
    await flush()
    setSelect(actionSelect(), 'security_action_verify')
    await flush()
    setSelect(resource, '')
    await flush()
    expect(actionSelect().value).toBe('')
    expect(optionValues(actionSelect())).toEqual(['', 'grant', 'revoke', 'update'])

    setSelect(resource, 'admin_login_grant_command')
    await flush()
    setSelect(actionSelect(), 'admin_login_grant_enable')
    await flush()
    setSelect(resource, 'user-security-action')
    await flush()
    expect(actionSelect().value).toBe('')
    expect(optionValues(actionSelect())).toEqual(['', 'security_action_verify'])
    expect(optionValues(actionSelect())).not.toContain('admin_login_grant_enable')

    setSelect(resource, 'user-role')
    await flush()
    setSelect(actionSelect(), 'grant')
    await flush()
    setSelect(resource, 'permission')
    await flush()
    expect(actionSelect().value).toBe('grant')

    setSelect(resource, 'user-security-action')
    await flush()
    expect(actionSelect().value).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the same fixture filters for the list and the CSV, including an empty action', async () => {
    fetchMock.mockResolvedValueOnce(feedOk([
      feedItem({
        actor_id: 'fixture-audit-logs-actor',
        resource_type: 'user-security-action',
        action: 'security_action_verify',
        resource_id: 'user:fixture-security-target',
        action_details: { operationKind: 'fixture.security' },
        source: 'audit_logs',
        source_id: 'fixture-audit-1',
      }),
      feedItem({
        actor_id: 'fixture-operation-actor',
        resource_type: 'admin_login_grant_command',
        action: 'admin_login_grant_enable',
        resource_id: 'user:fixture-grant-target',
        action_details: { operationKind: 'fixture.grant' },
        source: 'authorization_operation',
        source_id: 'fixture-op-1',
      }),
    ], { total: 2 }))
    mountFeed()
    await openFeed()
    expect(host!.textContent).toContain('fixture-audit-logs-actor')
    expect(host!.textContent).toContain('fixture-operation-actor')
    expect(host!.textContent).toContain('fixture.security')
    expect(host!.textContent).toContain('fixture.grant')
    expect(host!.textContent).not.toContain('生产记录')

    const resource = resourceSelect()
    setSelect(resource, 'user-security-action')
    await flush()
    setSelect(actionSelect(), 'security_action_verify')
    setField('input[type="search"]', 'fixture&actor')
    setField('input[aria-label="开始日期"]', '2026-02-01')
    setField('input[aria-label="结束日期"]', '2026-02-28')
    fetchMock.mockResolvedValueOnce(feedOk([feedItem({
      actor_id: 'fixture-matched-actor',
      resource_type: 'user-security-action',
      action: 'security_action_verify',
      source: 'audit_logs',
      source_id: 'fixture-match-1',
    })]))
    clickText('查询权限审计')
    await flush()
    const listUrl = String(fetchMock.mock.calls[1][0])
    expect(listUrl.startsWith('/api/admin/audit-activity?')).toBe(true)
    expect(listUrl).not.toContain('/api/audit-logs')
    const list = paramsOf(listUrl)
    expect(list.get('resourceType')).toBe('user-security-action')
    expect(list.get('action')).toBe('security_action_verify')
    expect(list.get('q')).toBe('fixture&actor')
    expect(list.get('from')).toBe('2026-02-01')
    expect(list.get('to')).toBe('2026-02-28')
    expect(list.get('page')).toBe('1')
    expect(list.get('pageSize')).toBe('20')
    expect(host!.textContent).toContain('fixture-matched-actor')

    const create = URL.createObjectURL
    const revoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:test')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['fixture-csv']) })
      clickText('导出权限审计 CSV')
      await flush()
      const csvUrl = String(fetchMock.mock.calls[2][0])
      expect(csvUrl.startsWith('/api/admin/audit-activity/export.csv?')).toBe(true)
      const csv = paramsOf(csvUrl)
      for (const key of ['resourceType', 'action', 'q', 'from', 'to']) {
        expect(csv.get(key)).toBe(list.get(key))
      }
      expect(csv.get('limit')).toBe('5000')
      expect(csv.get('page')).toBeNull()
      expect(csv.get('pageSize')).toBeNull()
    } finally {
      click.mockRestore()
      URL.createObjectURL = create
      URL.revokeObjectURL = revoke
    }

    setSelect(actionSelect(), '')
    fetchMock.mockResolvedValueOnce(feedOk([]))
    clickText('查询权限审计')
    await flush()
    const emptyAction = paramsOf(String(fetchMock.mock.calls[3][0]))
    expect(emptyAction.get('resourceType')).toBe('user-security-action')
    expect(emptyAction.has('action')).toBe(false)

    setSelect(resource, 'user')
    await flush()
    setSelect(actionSelect(), 'update')
    fetchMock.mockResolvedValueOnce(feedOk([]))
    clickText('查询权限审计')
    await flush()
    const original = paramsOf(String(fetchMock.mock.calls[4][0]))
    expect(original.get('resourceType')).toBe('user')
    expect(original.get('action')).toBe('update')
    expect(original.get('action')).not.toBe('security_action_verify')
  })

  it('shows an em dash when the fixture has no actor and does not borrow a target id', async () => {
    fetchMock.mockResolvedValueOnce(feedOk([
      feedItem({ actor_id: 'fixture-present-actor', source_id: 'fixture-present' }),
      feedItem({
        actor_id: null,
        resource_id: 'user:fixture-target-99',
        action_details: { userId: 'meta-user-77' },
        meta: { userId: 'meta-user-77' },
        source: 'authorization_operation',
        source_id: 'fixture-missing-actor',
      }),
    ]))
    mountFeed()
    await openFeed()
    const rows = host!.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0].children[1]?.textContent?.trim()).toBe('fixture-present-actor')
    const missing = rows[1].children[1]?.textContent?.trim()
    expect(missing).toBe(MISSING_ACTOR)
    expect(missing).not.toContain('fixture-target-99')
    expect(missing).not.toContain('meta-user-77')
    expect(missing).not.toContain('user:')
  })

  it('shows an alert without the empty state or rows when the fixture read returns 403', async () => {
    fetchMock.mockResolvedValueOnce(feedFail(403, 'fixture read forbidden'))
    mountFeed()
    await openFeed()
    const alert = host!.querySelector('[role="alert"]')
    expect(alert).toBeTruthy()
    expect(alert?.textContent?.trim()).toBe('fixture read forbidden')
    expect(host!.querySelectorAll('tbody tr')).toHaveLength(0)
    expect(host!.textContent).not.toContain('暂无权限审计记录')
    expect(host!.textContent).not.toContain('fixture-should-not-render')
  })

  it('shows an alert without the empty state or rows when the fixture read returns 503', async () => {
    fetchMock.mockResolvedValueOnce(feedFail(503, 'fixture read unavailable'))
    mountFeed()
    await openFeed()
    const alert = host!.querySelector('[role="alert"]')
    expect(alert).toBeTruthy()
    expect(alert?.textContent?.trim()).toBe('fixture read unavailable')
    expect(host!.querySelectorAll('tbody tr')).toHaveLength(0)
    expect(host!.textContent).not.toContain('暂无权限审计记录')
    expect(host!.textContent).not.toContain('fixture-should-not-render')
  })

  it('shows the empty state only when a fixture read succeeds with zero rows', async () => {
    fetchMock.mockResolvedValueOnce(feedOk([], { total: 0 }))
    mountFeed()
    await openFeed()
    expect(host!.querySelector('[role="alert"]')).toBeNull()
    expect(host!.querySelectorAll('tbody tr')).toHaveLength(0)
    expect(host!.textContent).toContain('暂无权限审计记录')
  })

  it('drops the previous fixture rows when the next page fails', async () => {
    fetchMock.mockResolvedValueOnce(feedOk([
      feedItem({ actor_id: 'fixture-page-one-actor', source_id: 'fixture-page-1' }),
    ], { total: 21, page: 1 }))
    mountFeed()
    await openFeed()
    expect(host!.textContent).toContain('fixture-page-one-actor')
    fetchMock.mockResolvedValueOnce(feedFail(503, 'fixture page unavailable'))
    clickText('下一页')
    await flush()
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain('fixture page unavailable')
    expect(host!.querySelectorAll('tbody tr')).toHaveLength(0)
    expect(host!.textContent).not.toContain('fixture-page-one-actor')
    expect(host!.textContent).not.toContain('暂无权限审计记录')
  })
})
