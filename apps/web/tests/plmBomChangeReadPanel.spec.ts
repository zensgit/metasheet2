import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, h, type App } from 'vue'
const mocks = vi.hoisted(() => ({ changeReadTargets: vi.fn(), changeReadManagement: vi.fn(), changeReadState: vi.fn(), bindChangeRead: vi.fn(), startChangeRead: vi.fn(), unbindChangeRead: vi.fn(), identity: 'first', listeners: new Set<() => void>() }))
vi.mock('../src/services/plm/plmBomChangeRead', () => mocks)
vi.mock('../src/composables/authPrincipal', () => ({ readAuthSessionSignature: () => mocks.identity, onAuthSessionSwitch: (fn: () => void) => { mocks.listeners.add(fn); return () => mocks.listeners.delete(fn) } }))
import Panel from '../src/components/plm/PlmBomChangeReadPanel.vue'
const target = { id: '11111111-1111-4111-8111-111111111111', name: '已导入协作表', version: 1, baseId: 'base', sheetId: 'sheet' }
const bound = { bound: true, purpose: 'bom_change_read', status: 'stopped', expiresAt: '2026-12-01T00:00:00Z' }
const secret = 'yue_' + 'a'.repeat(32) + '_' + 'b'.repeat(43)
let app: App, host: HTMLDivElement, props: { dataSourceId: string; partId: string }
const get = (name: string) => host.querySelector(`[data-testid="plm-change-read-${name}"]`) as HTMLElement
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); await nextTick() }
beforeEach(() => {
  vi.clearAllMocks(); mocks.identity = 'first'; mocks.listeners.clear()
  mocks.changeReadTargets.mockResolvedValue([target]); mocks.changeReadState.mockResolvedValue({ bound: false, purpose: 'bom_change_read' }); mocks.bindChangeRead.mockResolvedValue(bound); mocks.changeReadManagement.mockResolvedValue('https://native.example/personal-approval-grants#bom-change-read?request=fixture'); mocks.startChangeRead.mockResolvedValue(undefined); mocks.unbindChangeRead.mockResolvedValue({ pending: 1, rejected: 0 })
  props = reactive({ dataSourceId: 'source', partId: 'P' }); host = document.createElement('div'); document.body.append(host); app = createApp({ render: () => h(Panel, props) }); app.mount(host)
})
afterEach(() => { app.unmount(); host.remove(); vi.restoreAllMocks() })
async function select() { get('targets').click(); await flush(); const select = get('target') as HTMLSelectElement; select.value = target.id; select.dispatchEvent(new Event('change', { bubbles: true })); await flush() }
async function submit() { const input = get('grant') as HTMLInputElement; input.value = secret; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick(); host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await nextTick() }
it('requires target choice and explicit start after binding, preserving snapshot and retry messages', async () => {
  expect(mocks.changeReadTargets).not.toHaveBeenCalled(); await select()
  get('consent').click(); await flush(); expect(get('native').getAttribute('rel')).toBe('noopener noreferrer')
  await submit(); await flush(); expect((get('grant') as HTMLInputElement).value).toBe(''); expect(mocks.bindChangeRead).toHaveBeenCalledWith(target, secret); expect(mocks.startChangeRead).not.toHaveBeenCalled()
  mocks.startChangeRead.mockImplementationOnce(async () => { mocks.changeReadState.mockResolvedValue({ ...bound, status: 'active' }) })
  get('start').click(); await flush(); expect(mocks.startChangeRead).toHaveBeenCalledWith(target); expect(get('state').textContent).toContain('监听中')
  mocks.unbindChangeRead.mockImplementationOnce(async () => { mocks.changeReadState.mockResolvedValue({ ...bound, bound: false }); return { pending: 1, rejected: 0 } })
  get('unbind').click(); await flush(); expect(get('message').textContent).toContain('本地读取已停止'); expect(host.textContent).toContain('已导入的快照按目标权限保留')
})
it('clears a submitted secret immediately and ignores completion after an identity switch', async () => {
  await select(); let resolve!: (v: unknown) => void; mocks.bindChangeRead.mockReturnValueOnce(new Promise(r => { resolve = r }))
  await submit(); expect((get('grant') as HTMLInputElement).value).toBe('')
  mocks.identity = 'second'; for (const callback of mocks.listeners) callback(); await nextTick(); resolve(bound); await flush()
  expect(get('target')).toBeNull(); expect(get('message').textContent).toBe(''); expect(host.textContent).not.toContain(secret)
})
it('drops a late Native consent link when source or root changes', async () => {
  await select(); let resolve!: (v: unknown) => void; mocks.changeReadManagement.mockReturnValueOnce(new Promise(r => { resolve = r }))
  get('consent').click(); await nextTick(); props.dataSourceId = 'foreign'; props.partId = 'Q'; await nextTick()
  resolve('https://old.example/personal-approval-grants#bom-change-read?request=old'); await flush()
  expect(get('native')).toBeNull(); expect(get('target')).toBeNull()
})
it('does not adopt a late status after selection changes while it is pending', async () => {
  const other = { ...target, id: '22222222-2222-4222-8222-222222222222', name: '另一协作表' }; mocks.changeReadTargets.mockResolvedValueOnce([target, other])
  get('targets').click(); await flush(); let resolve!: (v: unknown) => void; mocks.changeReadState.mockReturnValueOnce(new Promise(r => { resolve = r }))
  const select = get('target') as HTMLSelectElement; select.value = target.id; select.dispatchEvent(new Event('change', { bubbles: true })); await nextTick(); select.value = other.id; select.dispatchEvent(new Event('change', { bubbles: true })); await nextTick(); resolve(bound); await flush()
  expect(get('state')).toBeNull(); expect(mocks.startChangeRead).not.toHaveBeenCalled()
})
