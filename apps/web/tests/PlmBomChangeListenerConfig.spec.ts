import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import PlmBomChangeListenerConfig from '../src/components/plm/PlmBomChangeListenerConfig.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { getBomChangeListener, startBomChangeListener } from '../src/services/plm/plmBomCollaboration'
const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/api', () => ({ apiFetch }))
const reply = (data: unknown) => new Response(JSON.stringify({ ok: true, data }))
const deny = (code: string) => new Response(JSON.stringify({ ok: false, error: { code, message: 'private' } }), { status: 409 })
const active = { status: 'active', generation: 'generation', cursor: 12, bindingVersion: 3 }
let app: App | undefined, host: HTMLDivElement
const id = ref('binding'), version = ref(3), close = vi.fn(), reloadBinding = vi.fn()
async function flush() { for (let i = 0; i < 35; i++) { await Promise.resolve(); await nextTick() } }
async function mount(response: unknown = { status: 'not_started' }) {
  apiFetch.mockResolvedValueOnce(reply(response))
  app = createApp(defineComponent({ setup: () => () => h(PlmBomChangeListenerConfig, { bindingId: id.value, bindingVersion: version.value, onClose: close, onReloadBinding: reloadBinding }) }))
  app.mount(host); await flush()
}
async function consent() {
  const checkbox = host.querySelector<HTMLInputElement>('[data-testid=listener-consent]')!
  checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true })); await flush()
}
async function submit() { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush() }
beforeEach(() => { apiFetch.mockReset(); close.mockReset(); reloadBinding.mockReset(); id.value = 'binding'; version.value = 3; localStorage.setItem('auth_token', 'owner'); host = document.createElement('div'); document.body.append(host) })
afterEach(() => { app?.unmount(); app = undefined; host.remove(); localStorage.clear() })
describe('explicit source listener authorization', () => {
  it('only reads on mount and requires consent before sending the current binding version', async () => {
    await mount(); await submit()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('不补发历史')
    await consent(); apiFetch.mockResolvedValueOnce(reply(active)); await submit()
    expect(apiFetch.mock.calls[1][0]).toBe('/api/plm-bom-reviews/binding/change-listener')
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ expectedVersion: 3 })
    expect(host.textContent).toContain('监听已开启')
    expect(host.querySelector<HTMLInputElement>('[data-testid=listener-consent]')!.checked).toBe(false)
    await submit(); expect(apiFetch).toHaveBeenCalledTimes(2)
  })
  it('shows stopped status without automatically resuming or exposing raw stop reasons', async () => {
    await mount({ ...active, status: 'stopped', stop_reason: 'private-reason' })
    expect(host.textContent).toContain('监听已停止'); expect(host.textContent).not.toContain('private-reason')
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
  it.each(['LISTENER_CHANGED', 'VERSION_CONFLICT', 'FORBIDDEN', 'RULE_DISABLED'])('requires reload after %s without retrying', async code => {
    await mount(active); await consent(); apiFetch.mockResolvedValueOnce(deny(code)); await submit(); await submit()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-testid=listener-status]')).toBeNull()
    expect(host.textContent).not.toContain('private')
    expect(host.querySelector('fieldset')!.disabled).toBe(true)
  })
  it('requests fresh parent binding on CAS conflict and requires new consent before posting version 4', async () => {
    await mount(active); await consent()
    reloadBinding.mockImplementation(() => { version.value = 4 })
    apiFetch.mockResolvedValueOnce(deny('VERSION_CONFLICT')).mockResolvedValueOnce(reply({ status: 'not_started' }))
    await submit()
    expect(reloadBinding).toHaveBeenCalledOnce()
    await submit(); expect(apiFetch).toHaveBeenCalledTimes(3)
    await consent(); apiFetch.mockResolvedValueOnce(reply({ ...active, bindingVersion: 4 })); await submit()
    expect(JSON.parse(apiFetch.mock.calls[3][1].body)).toEqual({ expectedVersion: 4 })
    expect(host.textContent).toContain('监听已开启')
  })
  it('discards a late start result on account switch', async () => {
    await mount(); await consent()
    let resolve!: (value: Response) => void
    apiFetch.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r }))
    await submit(); localStorage.removeItem('auth_token'); notifyAuthPrincipalChange(); await flush()
    resolve(reply(active)); await flush()
    expect(close).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain('监听已开启')
    expect(host.querySelector('fieldset')!.disabled).toBe(true)
  })
  it('invalidates consent and reloads when binding version changes', async () => {
    await mount(active); await consent(); apiFetch.mockResolvedValueOnce(reply({ status: 'not_started' }))
    version.value = 4; await flush(); await submit()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(apiFetch.mock.calls[1][1].method).toBe('GET')
    expect(host.querySelector<HTMLInputElement>('[data-testid=listener-consent]')!.checked).toBe(false)
  })
  it.each([{ ...active, cursor: -1 }, { ...active, cursor: '12' }, { ...active, generation: '' }, { ...active, status: 'unknown' }])('rejects malformed listener status', async value => {
    apiFetch.mockResolvedValueOnce(reply(value))
    await expect(getBomChangeListener('binding')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('rejects mismatched start binding versions and projects no credentials', async () => {
    apiFetch.mockResolvedValueOnce(reply({ ...active, bindingVersion: 4 }))
    await expect(startBomChangeListener('binding', 3)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    apiFetch.mockResolvedValueOnce(reply({ ...active, credential: 'secret' }))
    expect(await getBomChangeListener('id/one')).toEqual({ status: 'active', generation: 'generation', cursor: 12 })
    expect(apiFetch.mock.calls[1][0]).toContain('id%2Fone/change-listener')
  })
})
