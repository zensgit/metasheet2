import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import AuthorizationAuditFeed from '../src/components/AuthorizationAuditFeed.vue'

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch: fetchMock }))
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
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
})
