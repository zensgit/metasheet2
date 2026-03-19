import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import AcceptInviteView from '../src/views/AcceptInviteView.vue'

const replaceMock = vi.fn(async () => undefined)
const setTokenMock = vi.fn()
const primeSessionMock = vi.fn()
const loadProductFeaturesMock = vi.fn(async () => ({ attendance: true, workflow: true, attendanceAdmin: true, attendanceImport: true, mode: 'platform' }))

const mockRoute = { query: { token: 'invite-token' } }

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useRoute: () => mockRoute,
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    setToken: setTokenMock,
    primeSession: primeSessionMock,
  }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures: loadProductFeaturesMock,
  }),
}))

function createMockResponse(payload: unknown, status = 200, ok = status < 300) {
  return {
    ok,
    status,
    json: vi.fn(async () => payload),
  } as Response
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 0)
  })
}

function mountAcceptInvite() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(AcceptInviteView)
  app.mount(container)

  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

const onboardingPayload = {
  presetId: null,
  productMode: 'attendance' as const,
  homePath: '/attendance',
  loginPath: '/attendance/login',
  loginUrl: 'http://localhost:8899/login',
  acceptInvitePath: '/accept-invite',
  acceptInviteUrl: 'http://localhost:8899/accept-invite',
  welcomeTitle: '欢迎你',
  checklist: ['设置密码', '激活账号'],
  inviteMessage: '欢迎加入',
}

describe('AcceptInviteView', () => {
  beforeEach(() => {
    replaceMock.mockReset()
    setTokenMock.mockReset()
    primeSessionMock.mockReset()
    loadProductFeaturesMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('shows error message from payload.error object when preview is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => createMockResponse({
      error: { message: 'Invalid invite token' },
    }, 410, false)))

    const { container, unmount } = mountAcceptInvite()
    await flushPromises()
    await nextTick()

    const errorMessage = container.querySelector('.invite-error')
    expect(errorMessage).not.toBeNull()
    expect(errorMessage?.textContent).toContain('Invalid invite token')
    unmount()
  })

  it('shows detailed error message from submit failure payload', async () => {
    let callIndex = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (callIndex === 0) {
        callIndex += 1
        return createMockResponse({
          success: true,
          data: {
            user: {
              id: 'invite-user',
              email: 'invitee@example.com',
              name: 'Invitee',
              isActive: false,
            },
            onboarding: onboardingPayload,
          },
        })
      }

      return createMockResponse({
        error: {
          message: '密码复杂度不足',
        },
        details: ['至少包含一个数字'],
      }, 400, false)
    }))

    const { container, unmount } = mountAcceptInvite()
    await flushPromises()
    await nextTick()

    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement | null
    const confirmPasswordInput = container.querySelectorAll('input[type="password"]')[1] as HTMLInputElement
    const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement | null
    expect(passwordInput).not.toBeNull()
    expect(confirmPasswordInput).not.toBeNull()

    passwordInput.value = '123'
    confirmPasswordInput.value = '123'
    passwordInput.dispatchEvent(new Event('input'))
    confirmPasswordInput.dispatchEvent(new Event('input'))

    submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    await nextTick()

    const errorMessage = container.querySelector('.invite-error')
    expect(errorMessage).not.toBeNull()
    expect(errorMessage?.textContent).toContain('密码复杂度不足：至少包含一个数字')
    expect(setTokenMock).not.toHaveBeenCalled()
    expect(primeSessionMock).not.toHaveBeenCalled()
    unmount()
  })
})
