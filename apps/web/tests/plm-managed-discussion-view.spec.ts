import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import View from '../src/views/PlmManagedDiscussionView.vue'
const mocks = vi.hoisted(() => ({ discover: vi.fn(), signature: 'identity-A', listener: undefined as (() => void) | undefined, unsubscribe: vi.fn() }))
vi.mock('../src/services/plm/plmManagedDiscussion', () => ({ discoverManagedDiscussion: (...args: unknown[]) => mocks.discover(...args) }))
vi.mock('../src/composables/authPrincipal', () => ({ readAuthSessionSignature: () => mocks.signature, onAuthSessionSwitch: (listener: () => void) => { mocks.listener = listener; return mocks.unsubscribe } }))
vi.mock('../src/components/plm/PlmEmbedDiscussionPanel.vue', () => ({ default: defineComponent({ props: ['parentOrigin', 'managedSourceId', 'target'], setup: props => () => h('div', { 'data-testid': 'bound-panel' }, JSON.stringify(props)) }) }))
vi.mock('../src/components/plm/PlmEmbedVisualPreviewPanel.vue', () => ({ default: defineComponent({ props: ['parentOrigin', 'partId', 'managedSourceId'], setup: props => () => h('div', { 'data-testid': 'visual-panel' }, JSON.stringify(props)) }) }))
let app: App | undefined, host: HTMLElement, frame: HTMLIFrameElement, parent: Window, descriptor: PropertyDescriptor
const origin = 'https://native.example.test', context = { sourceId: 'owned-source', partId: 'native-part', parentOrigin: origin }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
function initial(source: MessageEventSource | null = parent) { window.dispatchEvent(new MessageEvent('message', { origin, source, data: { type: 'plm-embed:token', token: 'initial-fresh' } })) }
beforeEach(() => {
  mocks.signature = 'identity-A'; mocks.discover.mockReset(); mocks.unsubscribe.mockReset(); mocks.discover.mockResolvedValue({ ok: true, data: context })
  frame = document.createElement('iframe'); document.body.appendChild(frame); parent = frame.contentWindow!
  descriptor = Object.getOwnPropertyDescriptor(window, 'parent')!; Object.defineProperty(window, 'parent', { configurable: true, value: parent })
  host = document.createElement('div'); document.body.appendChild(host); app = createApp(View); app.mount(host)
})
afterEach(() => { app?.unmount(); app = undefined; host.remove(); Object.defineProperty(window, 'parent', descriptor); frame.remove(); vi.restoreAllMocks() })
it('ignores non-parent messages and binds only the context accepted by the server', async () => {
  initial(window); await settle(); expect(mocks.discover).not.toHaveBeenCalled()
  initial(); await settle(); expect(mocks.discover).toHaveBeenCalledWith('initial-fresh', origin)
  expect(host.querySelector('[data-testid="bound-panel"]')!.textContent).toContain('owned-source')
})
it('refuses returned parent mismatch', async () => {
  mocks.discover.mockResolvedValue({ ok: true, data: { ...context, parentOrigin: 'https://forged.example.test' } })
  initial(); await settle(); expect(host.querySelector('[data-testid="bound-panel"]')).toBeNull()
})
it('opens explicit authentication independently with no opener trust', () => {
  const link = host.querySelector<HTMLAnchorElement>('[data-testid="managed-discussion-signin"]')!
  expect(link.getAttribute('href')).toMatch(/^\/plm\/managed-entry/); expect(link.target).toBe('_blank'); expect(link.rel).toContain('noopener')
})
it('clears rendered data on identity switch', async () => {
  initial(); await settle(); expect(host.querySelector('[data-testid="bound-panel"]')).not.toBeNull()
  mocks.signature = 'identity-B'; mocks.listener!(); await nextTick(); expect(host.querySelector('[data-testid="bound-panel"]')).toBeNull()
})
it('drops delayed context after identity switch', async () => {
  let release!: (value: unknown) => void; mocks.discover.mockReturnValue(new Promise(resolve => { release = resolve }))
  initial(); await settle(); mocks.signature = 'identity-B'; mocks.listener!(); release({ ok: true, data: context }); await settle()
  expect(host.querySelector('[data-testid="bound-panel"]')).toBeNull()
})
it('uses a freshly minted token from the real parent protocol when retrying after login', async () => {
  mocks.discover.mockResolvedValueOnce({ ok: false, status: 401 }); initial(); await settle()
  initial(); await settle(); expect(mocks.discover).toHaveBeenCalledOnce()
  const post = vi.spyOn(parent, 'postMessage').mockImplementation((message: any, targetOrigin: any) => {
    expect(targetOrigin).toBe(origin); expect(message.purpose).toBe('discussion-read')
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { source: parent, origin, data: { type: 'plm-embed:token-response', nonce: message.nonce, token: 'new-after-login' } })))
  })
  host.querySelector<HTMLButtonElement>('[data-testid="managed-discussion-retry"]')!.click(); await settle()
  expect(post).toHaveBeenCalledOnce(); expect(mocks.discover.mock.calls.map(call => call[0])).toEqual(['initial-fresh', 'new-after-login'])
  expect(host.querySelector('[data-testid="bound-panel"]')).not.toBeNull()
})

it('drops a late bootstrap response after frame unmount and unsubscribes identity events', async () => {
  let release!: (value: unknown) => void
  mocks.discover.mockReturnValue(new Promise(resolve => { release = resolve }))
  initial(); await settle(); app!.unmount(); app = undefined
  release({ ok: true, data: context }); await settle()
  expect(host.textContent).toBe(''); expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})

it('mounts the existing visual panel only for the exact server capability and clears it on identity switch', async () => {
  mocks.discover.mockResolvedValue({ ok: true, data: { ...context, visualPreviewEnabled: true } })
  initial(); await settle()
  expect(host.querySelector('[data-testid="visual-panel"]')!.textContent).toContain('owned-source')
  expect(host.querySelector('[data-testid="visual-panel"]')!.textContent).toContain('native-part')
  mocks.signature = 'identity-B'; mocks.listener!(); await nextTick()
  expect(host.querySelector('[data-testid="visual-panel"]')).toBeNull()
})
it.each([false, 'true', 1, null])('refuses malformed visual capability %s', async visualPreviewEnabled => {
  mocks.discover.mockResolvedValue({ ok: true, data: { ...context, visualPreviewEnabled } })
  initial(); await settle(); expect(host.querySelector('[data-testid="bound-panel"]')).toBeNull()
  expect(host.querySelector('[data-testid="visual-panel"]')).toBeNull()
})
it('does not infer a visual capability from extra context fields', async () => {
  mocks.discover.mockResolvedValue({ ok: true, data: { ...context, visualPreviewEnabled: true, untrusted: true } })
  initial(); await settle(); expect(host.querySelector('[data-testid="visual-panel"]')).toBeNull()
})
