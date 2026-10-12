/* eslint-disable vue/one-component-per-file -- Parent wiring requires small, explicit child/card/router stubs in this test only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import View from '../src/views/IntegrationWorkbenchView.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

// Parent-wiring proof only. The separate run-panel suite mounts the real child,
// service and apiFetch; here only the child receiving the hint is replaced.
vi.mock('../src/components/integration/IntegrationReadSourceConfigPanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({
    props: { hasIntegrationAdmin: Boolean },
    setup(props) {
      return () => h('div', { 'data-testid': 'read-source-admin-hint', 'data-allowed': String(props.hasIntegrationAdmin) })
    },
  }) }
})
vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true, data: [] }), {
    headers: { 'Content-Type': 'application/json' },
  })),
  apiGet: vi.fn(async () => ({ ok: true, data: { items: [] } })),
}))

let app: App | undefined
let container: HTMLDivElement | undefined

async function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(View)
  app.use(createPinia())
  app.component('ElCard', defineComponent({ setup(_props, { slots }) {
    return () => h('section', [slots.header?.(), slots.default?.()])
  } }))
  app.component('RouterLink', defineComponent({ setup(_props, { slots }) { return () => h('a', slots.default?.()) } }))
  app.mount(container)
  await nextTick()
  return () => container?.querySelector('[data-testid="read-source-admin-hint"]')?.getAttribute('data-allowed') === 'true'
}

beforeEach(() => { localStorage.clear() })
afterEach(() => {
  app?.unmount()
  app = undefined
  container?.remove()
  container = undefined
  localStorage.clear()
})

describe('approved K3 B4 workbench admin hint', () => {
  it.each([
    ['no permission', [], [], false],
    ['read', ['integration:read'], [], false],
    ['write', ['integration:write'], [], false],
    ['broad user administration', ['users:write'], [], false],
    ['wildcard', ['*:*', 'admin:all'], [], false],
    ['literal integration admin', ['integration:admin'], [], true],
    ['literal role admin', [], ['admin'], true],
  ])('uses the server-shaped gate: %s', async (_name, permissions, roles, expected) => {
    localStorage.setItem('user_permissions', JSON.stringify(permissions))
    localStorage.setItem('user_roles', JSON.stringify(roles))
    const panel = await render()
    expect(panel()).toBe(expected)
  })

  it('withdraws the hint when a refreshed permission snapshot removes admin', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['integration:admin']))
    const panel = await render()
    expect(panel()).toBe(true)
    localStorage.setItem('user_permissions', JSON.stringify(['integration:read']))
    window.dispatchEvent(new StorageEvent('storage', { key: 'user_permissions' }))
    await nextTick()
    expect(panel()).toBe(false)
  })

  it('recomputes after an authentication session switch without relying on a scope re-render', async () => {
    const token = (role: string) => `synthetic.${btoa(JSON.stringify({ sub: role, roles: [role] }))}.synthetic`
    localStorage.setItem('auth_token', token('admin'))
    const panel = await render()
    expect(panel()).toBe(true)
    notifyAuthPrincipalChange()
    localStorage.setItem('auth_token', token('reader'))
    await Promise.resolve()
    await nextTick()
    expect(panel()).toBe(false)
  })
})
