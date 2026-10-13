import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import Section from '../src/views/ElearningAppInstallationSection.vue'
import { getAuthPrincipalKey, notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { useLocale } from '../src/composables/useLocale'
import { elearningSessionOrgPage } from '../src/composables/useElearningSessionOrg'

const mocks = vi.hoisted(() => ({ get: vi.fn(), install: vi.fn(), update: vi.fn(), changed: vi.fn() }))
vi.mock('../src/services/elearningApp', () => ({
  getElearningAppInstallation: mocks.get,
  installElearningApp: mocks.install,
  updateElearningAppInstallation: mocks.update,
}))

// Session-org fake: the real composable is covered by useSessionOrg.spec.ts; here only the
// e-learning page's use of it (visibility, switch, reload-after-switch) is under test.
const sessionOrgFake = vi.hoisted(() => ({
  orgs: [] as string[],
  currentOrgId: null as string | null,
  load: vi.fn(),
  switch: vi.fn(),
}))

vi.mock('../src/composables/useSessionOrg', async () => {
  const { computed, ref } = await import('vue')
  return {
    useSessionOrg: () => {
      const orgs = ref<string[]>([...sessionOrgFake.orgs])
      const currentOrgId = ref<string | null>(sessionOrgFake.currentOrgId)
      return {
        loading: ref(false),
        switching: ref(false),
        errorMessage: ref(''),
        orgs,
        currentOrgId,
        selectedOrgId: computed(() => currentOrgId.value ?? ''),
        hasMultipleOrgs: computed(() => orgs.value.length > 1),
        loadSessionOrgs: sessionOrgFake.load,
        switchSessionOrg: sessionOrgFake.switch,
      }
    },
  }
})
let app: App
let root: HTMLDivElement
async function flush() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick() } }
function button(text: string) { return Array.from(root.querySelectorAll('button')).find((node) => node.textContent?.trim() === text)! }
async function mount() {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(Section, { onChanged: mocks.changed })
  app.mount(root)
  await flush()
}
beforeEach(() => { localStorage.clear(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
afterEach(() => { app?.unmount(); root?.remove(); localStorage.clear() })

function token(org: string): string {
  return `header.${btoa(JSON.stringify({ sub: 'same-user', tenantId: org }))}.signature`
}

describe('installation section', () => {
  it.each(['not-installed', 'inactive', 'active'])('keeps %s state readonly for learners', async (status) => {
    mocks.get.mockResolvedValue({ status, notificationsEnabled: false, canManage: false })
    await mount()
    expect(root.textContent).toContain(status)
    expect(root.textContent).toContain('Notifications: disabled')
    expect(root.querySelectorAll('button, input')).toHaveLength(0)
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it.each(['Install', 'Enable', 'Save notifications'])('reloads instead of replaying stale %s intent across same-sub token switches', async (action) => {
    localStorage.setItem('auth_token', token('org-a'))
    const principal = getAuthPrincipalKey()
    mocks.get.mockResolvedValueOnce({ status: action === 'Install' ? 'not-installed' : 'inactive', notificationsEnabled: false, canManage: true })
    await mount()
    if (action === 'Save notifications') { root.querySelector('input')!.click(); await flush() }
    localStorage.setItem('auth_token', token('org-b'))
    expect(getAuthPrincipalKey()).toBe(principal)
    mocks.get.mockResolvedValueOnce({ status: 'inactive', notificationsEnabled: false, canManage: false })
    // The storage event may not yet have arrived: the write itself must recheck.
    button(action).click(); await flush()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(root.querySelectorAll('button, input')).toHaveLength(0)
  })

  it('clears cached controls on a cross-tab storage event', async () => {
    localStorage.setItem('auth_token', token('org-a'))
    mocks.get.mockResolvedValueOnce({ status: 'active', notificationsEnabled: true, canManage: true })
    await mount()
    mocks.get.mockResolvedValueOnce({ status: 'inactive', notificationsEnabled: false, canManage: false })
    localStorage.setItem('auth_token', token('org-b'))
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }))
    await flush()
    expect(root.querySelectorAll('button, input')).toHaveLength(0)
    expect(root.textContent).toContain('Notifications: disabled')
    expect(mocks.get).toHaveBeenCalledTimes(2)
  })

  it.each(['load', 'write', 'error'])('discards stale async %s results and reloads after same-sub token changes', async (operation) => {
    localStorage.setItem('auth_token', token('org-a'))
    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    const deferred = new Promise((done, fail) => { resolve = done; reject = fail })
    mocks.get.mockResolvedValueOnce({ status: 'inactive', notificationsEnabled: false, canManage: true })
    if (operation === 'load') mocks.get.mockReset().mockReturnValueOnce(deferred)
    await mount()
    if (operation !== 'load') {
      mocks.update.mockReturnValueOnce(deferred)
      button('Enable').click(); await flush()
    }
    localStorage.setItem('auth_token', token('org-b'))
    mocks.get.mockResolvedValueOnce({ status: 'inactive', notificationsEnabled: false, canManage: false })
    if (operation === 'error') reject(new Error('sensitive'))
    else resolve({ status: 'active', notificationsEnabled: true, canManage: true })
    await flush()
    expect(mocks.changed).not.toHaveBeenCalled()
    expect(root.querySelectorAll('button, input')).toHaveLength(0)
    expect(root.textContent).toContain('inactive')
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(mocks.get).toHaveBeenCalledTimes(2)
  })
  it('loads without writes, installs inactive, enables with notifications off, opts in and disables', async () => {
    mocks.get.mockResolvedValue({ status: 'not-installed', notificationsEnabled: false, canManage: true })
    mocks.install.mockResolvedValue({ status: 'inactive', notificationsEnabled: false, canManage: true })
    await mount()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    button('Install').click(); await flush()
    expect(root.textContent).toContain('inactive')
    expect(root.querySelector('input')?.checked).toBe(false)
    mocks.update.mockResolvedValueOnce({ status: 'active', notificationsEnabled: false, canManage: true })
    button('Enable').click(); await flush()
    expect(mocks.update).toHaveBeenLastCalledWith(true, false)
    root.querySelector('input')!.click(); await flush()
    expect(mocks.update).toHaveBeenCalledTimes(1)
    mocks.update.mockResolvedValueOnce({ status: 'active', notificationsEnabled: true, canManage: true })
    button('Save notifications').click(); await flush()
    expect(mocks.update).toHaveBeenLastCalledWith(true, true)
    mocks.update.mockResolvedValueOnce({ status: 'inactive', notificationsEnabled: true, canManage: true })
    button('Disable').click(); await flush()
    expect(mocks.update).toHaveBeenLastCalledWith(false, true)
    expect(mocks.changed).toHaveBeenCalledTimes(4)
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })
  it('fails closed on write errors and supports explicit retry', async () => {
    mocks.get.mockResolvedValue({ status: 'inactive', notificationsEnabled: false, canManage: true })
    await mount()
    mocks.update.mockRejectedValue(new Error('sensitive endpoint'))
    button('Enable').click(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('elearning_installation_request_failed')
    expect(root.textContent).not.toContain('sensitive')
    expect(root.querySelector('input')).toBeNull()
    button('Retry').click(); await flush()
    expect(button('Enable')).toBeTruthy()
  })
  it('locks pending actions and ignores stale results after a session change', async () => {
    let resolve!: (value: unknown) => void
    mocks.get.mockResolvedValue({ status: 'not-installed', notificationsEnabled: false, canManage: true })
    mocks.install.mockReturnValue(new Promise((done) => { resolve = done }))
    await mount()
    button('Install').click(); await flush()
    expect(button('Install').disabled).toBe(true)
    button('Install').click()
    expect(mocks.install).toHaveBeenCalledTimes(1)
    notifyAuthPrincipalChange()
    resolve({ status: 'active', notificationsEnabled: true, canManage: true }); await flush()
    expect(root.querySelector('input')).toBeNull()
    expect(mocks.changed).not.toHaveBeenCalled()
  })
})

describe('installation section organization context', () => {
  const realReload = elearningSessionOrgPage.reload
  const reload = vi.fn()

  beforeEach(() => {
    elearningSessionOrgPage.reload = reload
    reload.mockReset()
    sessionOrgFake.load.mockReset()
    sessionOrgFake.switch.mockReset()
  })
  afterEach(() => {
    elearningSessionOrgPage.reload = realReload
    sessionOrgFake.orgs = []
    sessionOrgFake.currentOrgId = null
    useLocale().setLocale('en')
  })

  function orgContextFailure(status = 403) {
    return Object.assign(new Error('request_failed'), { status, code: 'ORG_CONTEXT_REQUIRED' })
  }

  it('explains the org-context 403 in Chinese instead of the English token', async () => {
    useLocale().setLocale('zh-CN')
    mocks.get.mockRejectedValue(orgContextFailure())
    await mount()
    const alert = root.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toBe('当前账号没有唯一的有效组织：没有组织请联系管理员加入组织；属于多个组织请先在上方选择组织。')
    expect(alert).not.toContain('elearning_installation_request_failed')
    expect(alert).not.toContain('ORG_CONTEXT_REQUIRED')
  })

  it('keeps the closed token for the org code on another status and for codeless failures', async () => {
    useLocale().setLocale('zh-CN')
    mocks.get.mockRejectedValueOnce(orgContextFailure(400))
    await mount()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('elearning_installation_request_failed')
    mocks.get.mockRejectedValueOnce(Object.assign(new Error('request_failed'), { status: 403, code: 'request_failed' }))
    button('Retry').click(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('elearning_installation_request_failed')
  })

  it('offers the session-org selector to a multi-organization member only, reloading after a switch', async () => {
    sessionOrgFake.orgs = ['org-a']
    sessionOrgFake.currentOrgId = 'org-a'
    mocks.get.mockResolvedValue({ status: 'active', notificationsEnabled: false, canManage: false })
    await mount()
    expect(sessionOrgFake.load).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-testid="session-org-switcher"]')).toBeNull()
    app.unmount(); root.remove()

    sessionOrgFake.orgs = ['org-a', 'org-b']
    mocks.get.mockRejectedValue(orgContextFailure())
    await mount()
    const select = root.querySelector('[data-testid="session-org-switcher"] select') as HTMLSelectElement
    expect(select).not.toBeNull()
    sessionOrgFake.switch.mockResolvedValueOnce(true)
    select.value = 'org-b'
    select.dispatchEvent(new Event('change'))
    await flush()
    expect(sessionOrgFake.switch).toHaveBeenCalledWith('org-b')
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
