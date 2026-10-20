import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, h, type App } from 'vue'
import Panel from '../src/components/plm/PlmEmbedDiscussionPanel.vue'
import { discoverManagedDiscussion, managedDiscussion } from '../src/services/plm/plmManagedDiscussion'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), base: '' }))
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args), getApiBase: () => mocks.base }))
let app: App | undefined, host: HTMLElement, posted: ReturnType<typeof vi.spyOn>, minted: string[]
const origin = 'https://native.example.test'
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
beforeEach(() => {
  minted = []; mocks.base = ''; mocks.fetch.mockReset()
  mocks.fetch.mockImplementation(async (_path, options) => {
    const input = JSON.parse(options.body)
    const data = input.operation === 'list' ? { threads: [] } : { id: 'thread', status: input.operation === 'resolve' ? 'resolved' : 'open', comments: [{ id: 'root', body: 'Native author' }] }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) }
  })
  host = document.createElement('div'); document.body.appendChild(host)
  posted = vi.spyOn(window.parent, 'postMessage').mockImplementation((message: any) => {
    const token = 'fresh-' + (minted.length + 1); minted.push(token)
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { source: window.parent, origin, data: { type: 'plm-embed:token-response', nonce: message.nonce, token } })))
  })
})
afterEach(() => { app?.unmount(); app = undefined; host.remove(); posted.mockRestore() })
it('uses cookie identity and fresh Native token only at managed same-origin endpoints', async () => {
  await discoverManagedDiscussion('bootstrap', origin)
  expect(mocks.fetch.mock.calls[0]).toEqual(['/api/plm/managed-login/discussion-context', expect.objectContaining({ credentials: 'include', suppressUnauthorizedRedirect: true, headers: { 'Content-Type': 'application/json', 'X-PLM-Embed-Token': 'bootstrap' }, body: JSON.stringify({ operation: 'context', parentOrigin: origin }) })])
  await managedDiscussion('write', 'source/with space', { operation: 'resolve', threadId: 't', body: {} })
  expect(mocks.fetch.mock.calls[1][0]).toBe('/api/plm/managed-login/sources/source%2Fwith%20space/discussion')
})
it('refuses cross-origin API and empty source without shared or legacy fallback', async () => {
  mocks.base = 'https://credential-sink.example.test'
  expect(await discoverManagedDiscussion('secret', origin)).toMatchObject({ ok: false })
  mocks.base = ''; expect(await managedDiscussion('secret', '', { operation: 'list' })).toMatchObject({ ok: false, status: 422 })
  expect(mocks.fetch).not.toHaveBeenCalled()
})
it('uses the existing real panel for managed list, create and resolve with distinct tokens', async () => {
  mocks.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [{ id: 'thread', status: 'open' }] } }) })
  app = createApp(Panel, { parentOrigin: origin, managedSourceId: 'owned', target: { target_type: 'item', target_id: 'part' } }); app.mount(host); await settle()
  host.querySelector<HTMLButtonElement>('[data-testid="plm-discussion-load-detail-thread"]')!.click(); await settle()
  const input = host.querySelector<HTMLTextAreaElement>('[data-testid="plm-discussion-create-input"]')!
  input.value = 'A scoped draft'; input.dispatchEvent(new Event('input')); await nextTick()
  host.querySelector('[data-testid="plm-discussion-create"]')!.dispatchEvent(new Event('submit')); await settle()
  expect(host.textContent).toContain('Native author')
  const reply = host.querySelector<HTMLInputElement>('[data-testid="plm-discussion-reply-input-thread"]')!
  reply.value = 'scoped reply'; reply.dispatchEvent(new Event('input')); await nextTick()
  reply.closest('form')!.dispatchEvent(new Event('submit')); await settle()
  host.querySelector<HTMLButtonElement>('[data-testid="plm-discussion-resolve-thread"]')!.click(); await settle()
  expect(host.querySelector('[data-testid="plm-discussion-thread-status-thread"]')!.textContent).toBe('resolved')
  host.querySelector<HTMLButtonElement>('[data-testid="plm-discussion-reopen-thread"]')!.click(); await settle()
  expect(mocks.fetch.mock.calls.map(call => JSON.parse(call[1].body).operation)).toEqual(['list', 'thread', 'create', 'comment', 'resolve', 'reopen'])
  expect(mocks.fetch.mock.calls.every(call => call[0] === '/api/plm/managed-login/sources/owned/discussion')).toBe(true)
  expect(new Set(mocks.fetch.mock.calls.map(call => call[1].headers['X-PLM-Embed-Token'])).size).toBe(6)
})
it('does not send an empty managed source to legacy transport', async () => {
  app = createApp(Panel, { parentOrigin: origin, managedSourceId: '', target: { target_type: 'item', target_id: 'part' } }); app.mount(host); await settle()
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('drops a late previous-source response after the managed source changes', async () => {
  let release!: (value: unknown) => void
  mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const props = reactive({ parentOrigin: origin, managedSourceId: 'source-A', target: { target_type: 'item' as const, target_id: 'part' } })
  app = createApp({ render: () => h(Panel, props) }); app.mount(host); await settle()
  props.managedSourceId = 'source-B'; await settle()
  release({ ok: true, status: 200, json: async () => ({ ok: true, data: { threads: [{ id: 'old-A', status: 'open' }] } }) }); await settle()
  expect(host.querySelector('[data-testid="plm-discussion-thread-status-old-A"]')).toBeNull()
  expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual(['/api/plm/managed-login/sources/source-A/discussion', '/api/plm/managed-login/sources/source-B/discussion'])
})
