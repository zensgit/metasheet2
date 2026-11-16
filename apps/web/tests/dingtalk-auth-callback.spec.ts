import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import DingTalkAuthCallbackView from '../src/views/DingTalkAuthCallbackView.vue'
import { DINGTALK_CALLBACK_FAILURE_CODES } from '../src/utils/dingtalkLoginErrors'

const apiFetchMock = vi.fn()
const setTokenMock = vi.fn()
const primeSessionMock = vi.fn()
const getTokenMock = vi.fn()
const bootstrapSessionMock = vi.fn()
const loadProductFeaturesMock = vi.fn()
const resolveHomePathMock = vi.fn(() => '/attendance')
const replaceMock = vi.fn(() => Promise.resolve())

const routeState = {
  query: {
    code: 'auth-code',
    state: 'state-1',
  },
}

const localeMocks = vi.hoisted(() => ({ isZh: true }))
vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ locale: ref(localeMocks.isZh ? 'zh-CN' : 'en'), isZh: ref(localeMocks.isZh), setLocale: vi.fn() }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: getTokenMock,
    bootstrapSession: bootstrapSessionMock,
    setToken: setTokenMock,
    primeSession: primeSessionMock,
  }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures: loadProductFeaturesMock,
    resolveHomePath: resolveHomePathMock,
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({
    replace: replaceMock,
  }),
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('DingTalkAuthCallbackView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    getTokenMock.mockReset()
    bootstrapSessionMock.mockReset()
    setTokenMock.mockReset()
    primeSessionMock.mockReset()
    loadProductFeaturesMock.mockReset()
    resolveHomePathMock.mockReset()
    resolveHomePathMock.mockReturnValue('/attendance')
    replaceMock.mockReset()
    replaceMock.mockResolvedValue(undefined)
    getTokenMock.mockReturnValue(null)
    bootstrapSessionMock.mockResolvedValue({ ok: false, status: 401, payload: null })
    routeState.query.code = 'auth-code'
    routeState.query.state = 'state-1'
    localeMocks.isZh = true

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('stores the returned token and redirects to the backend-provided path', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          mode: 'login',
          token: 'jwt-dingtalk-token',
          redirectPath: '/workflows',
          user: {
            id: 'user-1',
            email: 'manager@example.com',
            role: 'admin',
            permissions: ['attendance:admin'],
          },
          features: {
            attendance: true,
            workflow: true,
            attendanceAdmin: true,
            attendanceImport: true,
            plm: false,
            mode: 'platform',
          },
        },
      }),
    })
    loadProductFeaturesMock.mockResolvedValue(undefined)

    app = createApp(DingTalkAuthCallbackView)
    app.mount(container!)
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/auth/dingtalk/callback',
      expect.objectContaining({
        method: 'POST',
        suppressUnauthorizedRedirect: true,
      }),
    )
    expect(setTokenMock).toHaveBeenCalledWith('jwt-dingtalk-token')
    expect(primeSessionMock).toHaveBeenCalled()
    expect(replaceMock).toHaveBeenCalledWith('/workflows')
  })

  it('shows an inline error when the callback is missing the code query param', async () => {
    routeState.query.code = ''
    routeState.query.state = ''

    app = createApp(DingTalkAuthCallbackView)
    app.mount(container!)
    await flushUi(4)

    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(container?.textContent).toContain('缺少授权码参数')
  })

  it('still POSTs the callback when an existing session is present (mode=bind keeps token)', async () => {
    getTokenMock.mockReturnValue('existing-token')
    bootstrapSessionMock.mockResolvedValue({
      ok: true,
      status: 200,
      payload: {
        data: {
          user: {
            id: 'user-1',
          },
        },
      },
    })
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          mode: 'bind',
          bound: true,
          redirectPath: '/settings?dingtalk=bound',
          identity: {
            userId: 'user-1',
            identity: { exists: true },
          },
        },
      }),
    })

    app = createApp(DingTalkAuthCallbackView)
    app.mount(container!)
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/auth/dingtalk/callback',
      expect.objectContaining({
        method: 'POST',
        suppressUnauthorizedRedirect: true,
      }),
    )
    expect(setTokenMock).not.toHaveBeenCalled()
    expect(primeSessionMock).not.toHaveBeenCalled()
    expect(replaceMock).toHaveBeenCalledWith('/settings?dingtalk=bound')
  })

  it('surfaces a DingTalk bind error when the backend returns a conflict', async () => {
    getTokenMock.mockReturnValue('existing-token')
    // The backend's real bind-conflict answer: status 409, the message and the stable code, no `data`.
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: 'DingTalk identity is already bound to another local user',
        code: 'identity_already_bound',
      }),
    })

    app = createApp(DingTalkAuthCallbackView)
    app.mount(container!)
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/auth/dingtalk/callback',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(setTokenMock).not.toHaveBeenCalled()
    expect(errorText()).toBe('该钉钉身份已关联其他本地账号。请联系管理员核验；不要重复绑定或新建账号。')
    expect(container?.textContent ?? '').not.toContain('already bound')
  })

  describe('failure guidance', () => {
    const FALLBACK_ZH = '钉钉登录或绑定未完成。请返回重新发起；如仍失败，请联系管理员。'
    const FALLBACK_EN = 'DingTalk sign-in or binding did not complete. Go back and start again; if it still fails, ask an administrator.'
    const PRIVATE_EMAIL = 'marker-private@example.test'
    const PRIVATE_MARKER = 'MARKER_raw_callback_text'

    function failWith(body: unknown, status = 403) {
      apiFetchMock.mockResolvedValue({ ok: false, status, json: async () => body })
    }

    async function mountCallback() {
      app = createApp(DingTalkAuthCallbackView)
      app.mount(container!)
      await flushUi(6)
    }

    function expectNoSessionAndNoNavigation() {
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(setTokenMock).not.toHaveBeenCalled()
      expect(primeSessionMock).not.toHaveBeenCalled()
      expect(loadProductFeaturesMock).not.toHaveBeenCalled()
      expect(replaceMock).not.toHaveBeenCalled()
    }

    function expectNoRawText() {
      const text = container?.textContent ?? ''
      expect(text).not.toContain(PRIVATE_EMAIL)
      expect(text).not.toContain(PRIVATE_MARKER)
    }

    /**
     * Pins the code table's keys to a literal list of the top-level codes the backend callback can
     * answer. packages/core-backend/tests/unit/auth-login-routes.test.ts pins the backend's set
     * (CALLBACK_TOP_LEVEL_CODES) and also imports apps/web/src/utils/dingtalkLoginErrors.ts to check
     * that DINGTALK_CALLBACK_FAILURE_CODES equals that list.
     */
    it('has guidance for exactly the callback\'s top-level codes', () => {
      expect([...DINGTALK_CALLBACK_FAILURE_CODES]).toEqual([
        'ACCOUNT_ACTIVATION_INVALID',
        'ACCOUNT_PENDING_ACTIVATION',
        'activate_admin_required',
        'activate_commit_incomplete',
        'activate_failed',
        'activate_source_ineligible',
        'activate_state_invalid',
        'activate_target_not_found',
        'authentication_changed',
        'auto_provision_alias_conflict',
        'auto_provision_corp_required',
        'auto_provision_email_conflict',
        'bind_user_mismatch',
        'directory_managed_conflict',
        'directory_managed_identity',
        'grant_disabled',
        'grant_required',
        'grant_state_unavailable',
        'identity_already_bound',
        'identity_ambiguous',
        'identity_mismatch',
        'local_user_disabled',
        'repair_identity_mismatch',
        'unlinked_enabled_local_user',
        'unlinked_local_user',
      ])
    })

    it.each([
      ['unlinked_enabled_local_user', 403, true, '该钉钉账号尚未关联可登录的本地账号。请联系管理员核验身份并完成关联。'],
      ['unlinked_local_user', 403, true, '该钉钉账号尚未关联本地账号。请联系管理员核验身份并完成关联。'],
      ['local_user_disabled', 403, true, '关联的本地账号当前不能登录（可能已停用或已删除）。请联系管理员核查账号状态。'],
      ['grant_required', 403, true, '该账号尚未获准使用钉钉登录。请联系管理员开通钉钉登录授权。'],
      ['grant_disabled', 403, true, '该账号的钉钉登录授权已关闭。请联系管理员核查。'],
      ['identity_ambiguous', 409, true, '该钉钉身份对应多个本地账号，无法确定要登录哪一个。请联系管理员核验。'],
      ['grant_state_unavailable', 503, true, '暂时无法核验钉钉登录授权。请稍后重新发起登录；不要为此更改账号或绑定。'],
      ['unlinked_enabled_local_user', 403, false, 'This DingTalk account is not linked to a local account that can sign in. Ask an administrator to verify the identity and complete the link.'],
      ['unlinked_local_user', 403, false, 'This DingTalk account is not linked to a local account. Ask an administrator to verify the identity and complete the link.'],
      ['local_user_disabled', 403, false, 'The linked local account cannot sign in right now (it may be disabled or deleted). Ask an administrator to check the account status.'],
      ['grant_required', 403, false, 'This account has not been granted DingTalk sign-in. Ask an administrator to grant it.'],
      ['grant_disabled', 403, false, 'DingTalk sign-in has been turned off for this account. Ask an administrator to check it.'],
      ['identity_ambiguous', 409, false, 'This DingTalk identity matches more than one local account, so the account to sign in cannot be determined. Ask an administrator to verify it.'],
      ['grant_state_unavailable', 503, false, 'DingTalk sign-in authorization cannot be verified right now. Start a new sign-in later; do not change accounts or bindings because of this.'],
    ])('shows the fixed guidance for %s (HTTP %i, zh=%s) and never the raw text', async (code, status, isZh, expected) => {
      localeMocks.isZh = isZh
      failWith({ success: false, code, error: `DingTalk account ${PRIVATE_EMAIL} ${PRIVATE_MARKER}` }, status)
      await mountCallback()
      expect(errorText()).toBe(expected)
      expectNoRawText()
      expectNoSessionAndNoNavigation()
    })

    it.each([true, false])('every listed code has its own guidance, distinct from the fallback (zh=%s)', async (isZh) => {
      localeMocks.isZh = isZh
      for (const code of DINGTALK_CALLBACK_FAILURE_CODES) {
        failWith({ success: false, code, error: PRIVATE_MARKER }, 409)
        if (app) app.unmount()
        await mountCallback()
        const text = errorText()
        expect(text, code).not.toBe(isZh ? FALLBACK_ZH : FALLBACK_EN)
        expect(text.length, code).toBeGreaterThan(0)
        expect(container?.textContent ?? '').not.toContain(PRIVATE_MARKER)
      }
    })

    it.each([
      ['an unknown code', { success: false, code: 'policy_denied_unlisted', error: PRIVATE_MARKER }],
      ['a code with different case', { success: false, code: 'GRANT_REQUIRED', error: PRIVATE_MARKER }],
      ['a missing code (older backend)', { success: false, error: `DingTalk account ${PRIVATE_EMAIL} is not linked to a local user` }],
      ['a numeric code', { success: false, code: 403, error: PRIVATE_MARKER }],
      ['an array code', { success: false, code: ['grant_required'], error: PRIVATE_MARKER }],
      ['an object code', { success: false, code: { code: 'grant_required' }, error: PRIVATE_MARKER }],
      ['a null code', { success: false, code: null, error: PRIVATE_MARKER }],
      ['the prototype key toString', { success: false, code: 'toString', error: PRIVATE_MARKER }],
      ['the prototype key constructor', { success: false, code: 'constructor', error: PRIVATE_MARKER }],
      ['the prototype key hasOwnProperty', { success: false, code: 'hasOwnProperty', error: PRIVATE_MARKER }],
      ['the prototype key __proto__', { success: false, code: '__proto__', error: PRIVATE_MARKER }],
      ['an error object with a message', { success: false, error: { message: `${PRIVATE_MARKER} ${PRIVATE_EMAIL}` } }],
      ['a body that is not an object', `${PRIVATE_MARKER} ${PRIVATE_EMAIL}`],
      ['an array body', [{ code: 'grant_required' }]],
      ['an empty body', null],
    ])('shows the fixed fallback for %s', async (_label, body) => {
      failWith(body, 400)
      await mountCallback()
      expect(errorText()).toBe(FALLBACK_ZH)
      expectNoRawText()
      expectNoSessionAndNoNavigation()
    })

    it('shows the English fallback for an unknown code', async () => {
      localeMocks.isZh = false
      failWith({ success: false, code: 'unknown-private-code', error: PRIVATE_MARKER })
      await mountCallback()
      expect(errorText()).toBe(FALLBACK_EN)
      expectNoRawText()
    })

    it('a state failure (400, no code) shows the fallback, not the state error text', async () => {
      failWith({ success: false, error: 'Invalid or unknown state parameter' }, 400)
      await mountCallback()
      expect(errorText()).toBe(FALLBACK_ZH)
      expect(container?.textContent ?? '').not.toContain('state parameter')
      expectNoSessionAndNoNavigation()
    })

    it('the nested recovery-conflict answer shows the temporary guidance, not its message', async () => {
      failWith({
        ok: false,
        error: { code: 'RECOVERY_AUTHORITY_BUSY', message: 'Recovery is stabilizing permissions; retry this change.', details: { retryable: true } },
      }, 409)
      await mountCallback()
      expect(errorText()).toBe('暂时无法完成核验。请稍后重新发起；不要为此更改账号或绑定。')
      expect(container?.textContent ?? '').not.toContain('Recovery is stabilizing')
      expectNoSessionAndNoNavigation()
    })

    it('an unreadable JSON body shows the fallback', async () => {
      apiFetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError(`Unexpected token ${PRIVATE_MARKER}`) } })
      await mountCallback()
      expect(errorText()).toBe(FALLBACK_ZH)
      expectNoRawText()
      expectNoSessionAndNoNavigation()
    })

    it('a 200 answer with an unreadable body is not a sign-in', async () => {
      apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } })
      await mountCallback()
      expect(errorText()).toBe(FALLBACK_ZH)
      expectNoSessionAndNoNavigation()
    })

    it('a network failure shows the fallback, not the exception text, and does not retry', async () => {
      apiFetchMock.mockRejectedValue(new TypeError(`Failed to fetch ${PRIVATE_MARKER} ${PRIVATE_EMAIL}`))
      await mountCallback()
      expect(errorText()).toBe(FALLBACK_ZH)
      expectNoRawText()
      expectNoSessionAndNoNavigation()
    })

    it('an exception after a successful sign-in response shows the fixed fallback, not the exception text', async () => {
      apiFetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { mode: 'login', token: 'jwt-dingtalk-token', redirectPath: '/workflows', user: { id: 'user-1' } } }),
      })
      loadProductFeaturesMock.mockResolvedValue(undefined)
      replaceMock.mockRejectedValue(new Error(`${PRIVATE_MARKER} navigation aborted for ${PRIVATE_EMAIL}`))
      await mountCallback()
      expect(errorText()).toBe(FALLBACK_ZH)
      expectNoRawText()
    })

    it('a failed bind keeps the existing session untouched', async () => {
      getTokenMock.mockReturnValue('existing-token')
      failWith({ success: false, error: 'DingTalk bind session does not match the current user', code: 'bind_user_mismatch' })
      await mountCallback()
      expect(errorText()).toBe('发起绑定的账号与当前登录的账号不一致。请用发起绑定的账号登录后重新绑定。')
      expectNoSessionAndNoNavigation()
    })
  })
})

function errorText(): string {
  return document.querySelector('.dingtalk-callback__error-text')?.textContent ?? ''
}
