import { createApp, defineComponent, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../src/utils/api'
import { readAttendanceLegacyPermissionPayload } from '../src/views/attendance/readAttendanceLegacyPermissionPayload'
import { useAttendanceAdminProvisioning } from '../src/views/attendance/useAttendanceAdminProvisioning'

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

const userId = '11111111-1111-4111-8111-111111111111'
const apiFetchMock = vi.mocked(apiFetch)

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

describe('readAttendanceLegacyPermissionPayload', () => {
  it('keeps an effective-only payload and rejects an empty, foreign, or non-array body', () => {
    expect(readAttendanceLegacyPermissionPayload({
      userId,
      permissions: ['attendance:read'],
      isAdmin: false,
    }, userId)).toEqual({ permissions: ['attendance:read'], isAdmin: false })
    expect(readAttendanceLegacyPermissionPayload({
      userId,
      permissions: [],
      isAdmin: true,
    }, userId)).toEqual({ permissions: [], isAdmin: true })
    expect(readAttendanceLegacyPermissionPayload({}, userId)).toBeNull()
    expect(readAttendanceLegacyPermissionPayload({
      userId: 'someone-else',
      permissions: ['attendance:admin'],
      isAdmin: true,
    }, userId)).toBeNull()
    expect(readAttendanceLegacyPermissionPayload({
      userId,
      permissions: 'attendance:read',
      isAdmin: false,
    }, userId)).toBeNull()
    expect(readAttendanceLegacyPermissionPayload({
      userId,
      permissions: [],
      isAdmin: false,
      degraded: true,
    }, userId)).toBeNull()
  })
})

describe('attendance legacy fallback load', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
    apiFetchMock.mockReset()
  })

  async function flushUi(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve()
      await nextTick()
    }
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 40; index += 1) {
      await flushUi()
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('Condition not reached in time')
  }

  function mountLoadButton(): { root: HTMLDivElement; setUserId: (value: string) => void } {
    let setUserId = (_value: string) => {}
    const Harness = defineComponent({
      setup() {
        const provisioning = useAttendanceAdminProvisioning({
          adminForbidden: ref(false),
          orgId: ref(''),
          globalScope: ref(true),
          tr: (_en, zh) => zh,
        })
        setUserId = (value: string) => {
          provisioning.provisionForm.userId = value
        }
        return {
          load: provisioning.loadProvisioningUser,
          status: provisioning.provisionStatusMessage,
          kind: provisioning.provisionStatusKind,
          permissions: provisioning.provisionPermissions,
          loaded: provisioning.provisionHasLoaded,
        }
      },
      template: `
        <button type="button" data-testid="load" @click="load()">加载</button>
        <p data-testid="status">{{ status }}</p>
        <p data-testid="kind">{{ kind }}</p>
        <p data-testid="loaded">{{ loaded ? 'loaded' : 'unread' }}</p>
        <span v-for="perm in permissions" :key="perm" data-testid="perm">{{ perm }}</span>
      `,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(Harness)
    app.mount(container)
    return { root: container, setUserId }
  }

  it('loads a legacy effective-only payload and clears it when the fallback read fails', async () => {
    const steps: Array<{ status?: number; body?: unknown; invalidJson?: boolean; reject?: boolean; hold?: Promise<void> }> = []
    apiFetchMock.mockImplementation(async (path: string) => {
      const url = String(path)
      if (url.includes('/access?')) return jsonResponse(404, { message: 'Not Found' })
      if (url.startsWith('/api/permissions/user/')) {
        const step = steps.shift()
        if (!step) throw new Error(`missing permission step for ${url}`)
        if (step.hold) await step.hold
        if (step.reject) throw new Error('network down')
        if (step.invalidJson) {
          return { ok: true, status: 200, json: async () => { throw new Error('bad json') } }
        }
        return jsonResponse(step.status || 200, step.body)
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const { root, setUserId } = mountLoadButton()
    setUserId(userId)
    const load = () => (root.querySelector('[data-testid="load"]') as HTMLButtonElement).click()
    const status = () => root.querySelector('[data-testid="status"]')?.textContent || ''
    const perms = () => Array.from(root.querySelectorAll('[data-testid="perm"]')).map((node) => node.textContent || '')

    steps.push({ body: { userId, permissions: ['attendance:read'], isAdmin: false } })
    load()
    await waitFor(() => perms().includes('attendance:read') && status().includes('已加载 1 项权限'))
    expect(root.querySelector('[data-testid="loaded"]')?.textContent).toBe('loaded')

    steps.push({ body: { userId, permissions: [], isAdmin: false } })
    load()
    await waitFor(() => status().includes('已加载 0 项权限'))
    expect(perms()).toEqual([])
    expect(root.querySelector('[data-testid="loaded"]')?.textContent).toBe('loaded')

    steps.push({ body: {} })
    load()
    await waitFor(() => (root.querySelector('[data-testid="kind"]')?.textContent || '').includes('error'))
    expect(status()).not.toMatch(/^已加载 \d+ 项权限$/)
    expect(perms()).toEqual([])
    expect(root.querySelector('[data-testid="loaded"]')?.textContent).toBe('unread')

    steps.push({ body: { userId, permissions: ['attendance:read'], isAdmin: false } })
    load()
    await waitFor(() => perms().includes('attendance:read'))

    steps.push({ body: { userId: 'someone-else', permissions: ['attendance:admin'], isAdmin: true } })
    load()
    await waitFor(() => (root.querySelector('[data-testid="kind"]')?.textContent || '').includes('error'))
    expect(perms()).not.toContain('attendance:admin')
    expect(perms()).not.toContain('attendance:read')
    expect(status()).not.toMatch(/^已加载 \d+ 项权限$/)
    expect(root.querySelector('[data-testid="loaded"]')?.textContent).toBe('unread')

    steps.push({ body: { userId, permissions: ['attendance:read'], isAdmin: false } })
    load()
    await waitFor(() => perms().includes('attendance:read'))

    let release: (() => void) | undefined
    const hold = new Promise<void>((resolve) => { release = resolve })
    steps.push({ status: 500, body: { error: '加载权限失败' }, hold })
    load()
    await flushUi()
    expect(perms()).toContain('attendance:read')
    release?.()
    await waitFor(() => (root.querySelector('[data-testid="kind"]')?.textContent || '').includes('error'))
    expect(perms()).toEqual([])
    expect(status()).not.toMatch(/^已加载 \d+ 项权限$/)
    expect(root.querySelector('[data-testid="loaded"]')?.textContent).toBe('unread')

    steps.push({ body: { userId, permissions: ['attendance:read'], isAdmin: false } })
    load()
    await waitFor(() => perms().includes('attendance:read'))
    steps.push({ invalidJson: true })
    load()
    await waitFor(() => (root.querySelector('[data-testid="loaded"]')?.textContent || '') === 'unread')
    expect(perms()).toEqual([])
    expect(status()).not.toMatch(/^已加载 \d+ 项权限$/)

    steps.push({ body: { userId, permissions: ['attendance:read'], isAdmin: false } })
    load()
    await waitFor(() => perms().includes('attendance:read'))
    steps.push({ reject: true })
    load()
    await waitFor(() => (root.querySelector('[data-testid="loaded"]')?.textContent || '') === 'unread')
    expect(perms()).toEqual([])
    expect(status()).toContain('network down')
    expect(status()).not.toMatch(/^已加载 \d+ 项权限$/)
  })
})
