import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

const h_ = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  browserZone: vi.fn(),
  endpointsReply: vi.fn(),
  preferencesReply: vi.fn(),
  establishReply: vi.fn(),
  revokeReply: vi.fn(),
  patchReply: vi.fn(),
  testReply: vi.fn(),
}))

vi.mock('../src/utils/api', () => ({ apiFetch: h_.apiFetch }))

vi.mock('../src/notifications/notificationApi', async () => {
  const actual = await vi.importActual<typeof import('../src/notifications/notificationApi')>('../src/notifications/notificationApi')
  return { ...actual, resolveNotificationBrowserTimeZone: h_.browserZone }
})

vi.mock('../src/composables/useLocale', () => {
  const isZh = ref(true)
  return {
    useLocale: () => ({
      locale: computed(() => (isZh.value ? 'zh-CN' : 'en')),
      isZh,
      setLocale: (next: unknown) => {
        isZh.value = next === 'zh-CN'
      },
    }),
  }
})

import NotificationPreferencesView from '../src/views/NotificationPreferencesView.vue'
import { appRoutes } from '../src/router/appRoutes'
import { useLocale } from '../src/composables/useLocale'

const CONNECTION = '11111111-1111-4111-8111-111111111111'
const OTHER_CONNECTION = '22222222-2222-4222-8222-222222222222'
const ENDPOINT = '33333333-3333-4333-8333-333333333333'
const OTHER_ENDPOINT = '44444444-4444-4444-8444-444444444444'
const BROWSER_ZONE = 'Pacific/Chatham'

function endpoint(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENDPOINT,
    connection: { id: CONNECTION, provider: 'dingtalk', label: '钉钉 · Primary' },
    addressKind: 'dingtalk_userid',
    proofKind: 'directory_link',
    status: 'active',
    revision: 1,
    usable: true,
    unusableReason: null,
    capability: { effective: false, reason: 'switch_off' },
    verified: false,
    lastVerifiedAt: '2026-11-06T08:00:00.000Z',
    ...over,
  }
}

function backupEndpoint(over: Record<string, unknown> = {}): Record<string, unknown> {
  return endpoint({
    id: OTHER_ENDPOINT,
    connection: { id: OTHER_CONNECTION, provider: 'feishu', label: 'Feishu · Backup' },
    addressKind: 'feishu_open_id',
    ...over,
  })
}

function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connection: { id: CONNECTION, provider: 'dingtalk', label: '钉钉 · Primary' },
    proofKind: 'directory_link',
    addressable: true,
    reasonCode: null,
    endpointId: null,
    ...over,
  }
}

function endpointsListing(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    delivery: { enabled: false, testSendAvailable: false, reason: 'delivery_disabled' },
    endpoints: [endpoint()],
    candidates: [],
    ...over,
  }
}

function topic(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: 'task_reminder',
    integrated: false,
    applies: { now: false, reason: 'topic_not_integrated' },
    preference: null,
    effective: { source: 'none', connection: null, usable: false, fallback: null },
    ...over,
  }
}

function preferencesListing(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { topics: [topic()], ...over }
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve
  })
  return { promise, resolve: resolveFn }
}

function updatedTopic(body: string): Record<string, unknown> {
  const patch = JSON.parse(body) as Record<string, unknown>
  return topic({
    preference: {
      enabled: patch.enabled ?? true,
      primaryEndpointId: patch.primaryEndpointId ?? null,
      fallbackEndpointId: patch.fallbackEndpointId ?? null,
      quietHours: patch.quietHours ?? null,
      revision: (patch.expectedRevision as number) + 1,
    },
  })
}

function calls(path: string, method = 'GET'): Array<[string, { method?: string; body?: string } | undefined]> {
  return (h_.apiFetch.mock.calls as Array<[string, { method?: string; body?: string } | undefined]>).filter(
    ([candidatePath, init]) => candidatePath === path && (init?.method ?? 'GET') === method,
  )
}

function writeCalls(): Array<[string, { method?: string; body?: string } | undefined]> {
  return (h_.apiFetch.mock.calls as Array<[string, { method?: string; body?: string } | undefined]>).filter(
    ([, init]) => (init?.method ?? 'GET') !== 'GET',
  )
}

function expectNoAccountFields(body: string): void {
  const forbidden = new Set(['openId', 'unionId', 'userId', 'externalId', 'externalUserId', 'email', 'mobile', 'orgId', 'address', 'recipient'])
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      expect(forbidden.has(key), `request must not carry account field ${key}`).toBe(false)
      visit(child)
    }
  }
  visit(JSON.parse(body))
}

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null
let router: Router | null = null

const OtherPage = defineComponent({ render: () => h('p', { 'data-testid': 'other-page' }, 'other page') })

async function flush(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mountView(): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings', name: 'user-settings', component: OtherPage },
      { path: '/settings/notifications', name: 'notification-preferences', component: NotificationPreferencesView },
    ],
  })
  const Root = defineComponent({ render: () => h(RouterView) })
  await router.push('/settings/notifications')
  await router.isReady()
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(Root)
  app.use(router)
  app.mount(container)
  await flush()
  return container
}

interface PageHandle {
  loadState: string
  loading: boolean
  endpoints: Record<string, unknown> | null
  topics: Array<Record<string, unknown>>
  drafts: Record<string, { enabled: boolean; primaryEndpointId: string; fallbackEndpointId: string; quietEnabled: boolean; quietStart: string; quietEnd: string; timeZone: string }>
  pendingWrite: boolean
  actionMessage: string
  formErrors: Record<string, string>
}

function page(): PageHandle {
  const instance = router!.currentRoute.value.matched[0]?.instances.default
  expect(instance, 'expected the notification page instance').toBeTruthy()
  return instance as unknown as PageHandle
}

function shown(el: HTMLElement, testid: string): HTMLElement | null {
  return el.querySelector(`[data-testid="${testid}"]`)
}

function must(el: HTMLElement, testid: string): HTMLElement {
  const found = shown(el, testid)
  expect(found, `expected [data-testid="${testid}"]`).toBeTruthy()
  return found as HTMLElement
}

function text(el: HTMLElement, testid: string): string {
  return must(el, testid).textContent?.trim() ?? ''
}

async function click(el: HTMLElement, testid: string): Promise<void> {
  ;(must(el, testid) as HTMLButtonElement).click()
  await flush()
}

async function submit(el: HTMLElement): Promise<void> {
  must(el, 'notification-topic-task_reminder').dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

async function select(el: HTMLElement, testid: string, value: string): Promise<void> {
  const field = must(el, testid) as HTMLSelectElement
  field.value = value
  field.dispatchEvent(new Event('change'))
  await flush()
}

async function toggle(el: HTMLElement, testid: string): Promise<void> {
  ;(must(el, testid) as HTMLInputElement).click()
  await flush()
}

beforeEach(() => {
  useLocale().setLocale('zh-CN')
  h_.browserZone.mockReset().mockReturnValue(BROWSER_ZONE)
  h_.endpointsReply.mockReset().mockImplementation(() => response(200, endpointsListing()))
  h_.preferencesReply.mockReset().mockImplementation(() => response(200, preferencesListing()))
  h_.establishReply.mockReset().mockImplementation(() => response(201, { endpoint: endpoint() }))
  h_.revokeReply.mockReset().mockImplementation(() => response(200, { endpoint: { id: ENDPOINT, status: 'revoked', revision: 2 } }))
  h_.patchReply.mockReset().mockImplementation((body: string) => response(200, updatedTopic(body)))
  h_.testReply.mockReset().mockImplementation(() => response(202, null))
  h_.apiFetch.mockReset().mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    if (path === '/api/me/notification-endpoints' && method === 'GET') return h_.endpointsReply()
    if (path === '/api/me/notification-preferences' && method === 'GET') return h_.preferencesReply()
    if (path === '/api/me/notification-endpoints' && method === 'POST') return h_.establishReply(init?.body)
    if (path === '/api/me/notification-preferences' && method === 'PATCH') return h_.patchReply(init?.body)
    if (/^\/api\/me\/notification-endpoints\/[^/]+$/.test(path) && method === 'DELETE') return h_.revokeReply()
    if (/^\/api\/me\/notification-endpoints\/[^/]+\/test-send$/.test(path) && method === 'POST') return h_.testReply()
    return response(500, null)
  })
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
})

describe('notification preference page states', () => {
  it('renders loading and then the main view', async () => {
    const reply = deferred<Response>()
    h_.endpointsReply.mockReturnValue(reply.promise)
    const el = await mountView()
    expect(text(el, 'notification-loading')).toBe('加载中…')
    expect(shown(el, 'notification-channels')).toBeNull()
    reply.resolve(response(200, endpointsListing()))
    await flush()
    expect(shown(el, 'notification-loading')).toBeNull()
    expect(shown(el, 'notification-channels')).toBeTruthy()
    expect(shown(el, 'notification-types')).toBeTruthy()
  })

  it('renders the exact feature-disabled copy on a 404', async () => {
    h_.endpointsReply.mockReturnValue(response(404, { error: { code: 'NOT_FOUND' } }))
    const el = await mountView()
    expect(text(el, 'notification-disabled')).toBe('管理员尚未启用通知偏好')
    expect(shown(el, 'notification-types')).toBeNull()
  })

  it.each([
    ['an HTTP error', () => response(500, null)],
    ['a malformed success', () => response(200, { endpoints: [] })],
    ['a transport failure', () => Promise.reject(new TypeError('offline'))],
  ])('renders the error state for %s', async (_name, reply) => {
    h_.endpointsReply.mockImplementation(reply)
    const el = await mountView()
    expect(text(el, 'notification-error')).toContain('通知设置加载失败，请稍后重试')
    expect(shown(el, 'notification-types')).toBeNull()
  })

  it('renders unavailable candidates and their reasons without suggesting they can be enabled', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({
      endpoints: [endpoint({ usable: false, unusableReason: 'proof_changed' })],
      candidates: [
        candidate({ proofKind: 'external_identity', addressable: false, reasonCode: 'address_kind_not_derivable' }),
        candidate({ addressable: false, reasonCode: 'address_bound_on_other_connection' }),
      ],
    })))
    const el = await mountView()
    expect(shown(el, 'notification-no-channels')).toBeTruthy()
    expect(text(el, 'notification-candidate-reason-0')).toBe('钉钉自助绑定的身份暂不能用于工作通知')
    expect(text(el, 'notification-candidate-reason-1')).toBe('该账号已在另一连接上启用')
    expect(shown(el, 'notification-enable-0')).toBeNull()
    expect(shown(el, 'notification-enable-1')).toBeNull()
    expect(shown(el, 'notification-types')).toBeNull()
    expect((must(el, 'notification-test-0') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders endpoint status, available candidates, and the delivery-disabled reason', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({
      candidates: [candidate(), candidate({ proofKind: 'external_identity', addressable: false, reasonCode: 'address_kind_not_derivable' })],
    })))
    const el = await mountView()
    expect(text(el, 'notification-endpoint-0')).toContain('钉钉 · Primary')
    expect(text(el, 'notification-endpoint-0')).toContain('可用')
    expect(shown(el, 'notification-enable-0')).toBeTruthy()
    expect(text(el, 'notification-test-reason-0')).toBe('通知发送能力尚未启用')
    expect((must(el, 'notification-test-0') as HTMLButtonElement).disabled).toBe(true)
  })

  it('treats an absent test capability field as unavailable with generic copy', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ delivery: { enabled: false } })))
    const el = await mountView()
    expect((must(el, 'notification-test-0') as HTMLButtonElement).disabled).toBe(true)
    expect(text(el, 'notification-test-reason-0')).toBe('当前不能测试发送')
    ;(must(el, 'notification-test-0') as HTMLButtonElement).click()
    await flush()
    expect(shown(el, 'notification-test-dialog')).toBeNull()
  })

  it('uses only usable own endpoints in channel selects and filters fallback providers', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ endpoints: [endpoint(), backupEndpoint()] })))
    const el = await mountView()
    const primary = must(el, 'notification-primary-task_reminder') as HTMLSelectElement
    const fallback = must(el, 'notification-fallback-task_reminder') as HTMLSelectElement
    expect(Array.from(primary.options).map((option) => [option.value, option.textContent?.trim()])).toEqual([
      [ENDPOINT, '钉钉 · Primary'],
      [OTHER_ENDPOINT, 'Feishu · Backup'],
    ])
    expect(Array.from(fallback.options).map((option) => [option.value, option.textContent?.trim()])).toEqual([
      ['', '无备用渠道'],
      [OTHER_ENDPOINT, 'Feishu · Backup'],
    ])
    await select(el, 'notification-primary-task_reminder', OTHER_ENDPOINT)
    expect(Array.from((must(el, 'notification-fallback-task_reminder') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['', ENDPOINT])
    expect(el.textContent).not.toContain(CONNECTION)
    expect(el.textContent).not.toContain(ENDPOINT)
    expect(el.textContent).not.toContain(OTHER_CONNECTION)
    expect(el.textContent).not.toContain(OTHER_ENDPOINT)
  })

  it('defaults to the browser time zone and shows suppression and effectiveness explanations', async () => {
    const el = await mountView()
    expect((must(el, 'notification-time-zone-task_reminder') as HTMLInputElement).value).toBe(BROWSER_ZONE)
    expect(text(el, 'notification-browser-zone-task_reminder')).toBe('默认使用浏览器时区')
    expect(text(el, 'notification-quiet-warning-task_reminder')).toBe('静默期内到点的提醒会被跳过，不会延后发送')
    expect(text(el, 'notification-effective-task_reminder')).toBe('此偏好目前未生效：该通知类型尚未接入发送流程')
  })

  it('marks a preference effective only when both applicability and usability are true', async () => {
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({
        applies: { now: true, reason: null },
        effective: {
          source: 'user_primary',
          connection: { id: CONNECTION, provider: 'dingtalk', label: '钉钉 · Primary' },
          usable: true,
          fallback: null,
        },
      })],
    })))
    const el = await mountView()
    expect(text(el, 'notification-effective-task_reminder')).toBe('此偏好目前生效')
  })

  it('labels every form control, exposes an aria-live result, and closes a dialog with Escape', async () => {
    const el = await mountView()
    for (const control of Array.from(el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'))) {
      const labelled = control.closest('label') !== null || (control.id && el.querySelector(`label[for="${control.id}"]`) !== null)
      expect(labelled, `unlabelled ${control.getAttribute('data-testid')}`).toBe(true)
    }
    expect(must(el, 'notification-action-result').getAttribute('aria-live')).toBe('polite')
    await click(el, 'notification-revoke-0')
    must(el, 'notification-revoke-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    expect(shown(el, 'notification-revoke-dialog')).toBeNull()
    expect(writeCalls()).toHaveLength(0)
  })
})

describe('notification channel and preference writes', () => {
  it('saves the full preference byte for byte with no account fields', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ endpoints: [endpoint(), backupEndpoint()] })))
    const el = await mountView()
    await toggle(el, 'notification-enabled-task_reminder')
    await select(el, 'notification-fallback-task_reminder', OTHER_ENDPOINT)
    await toggle(el, 'notification-quiet-enabled-task_reminder')
    await submit(el)
    const patchCalls = calls('/api/me/notification-preferences', 'PATCH')
    expect(patchCalls).toHaveLength(1)
    const body = patchCalls[0][1]?.body as string
    expect(body).toBe('{"topic":"task_reminder","expectedRevision":0,"enabled":false,"primaryEndpointId":"33333333-3333-4333-8333-333333333333","fallbackEndpointId":"44444444-4444-4444-8444-444444444444","quietHours":{"start":"22:00","end":"08:00","timeZone":"Pacific/Chatham"}}')
    expectNoAccountFields(body)
    expect(text(el, 'notification-action-result')).toBe('已保存')
  })

  it('uses the stored revision and sends an explicit null quiet window', async () => {
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({ preference: { enabled: true, primaryEndpointId: ENDPOINT, fallbackEndpointId: null, quietHours: null, revision: 5 } })],
    })))
    const el = await mountView()
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":5,"enabled":true,"primaryEndpointId":"33333333-3333-4333-8333-333333333333","fallbackEndpointId":null,"quietHours":null}')
  })

  it('enables a candidate with exactly connectionId and proofKind, then rereads', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ candidates: [candidate()] })))
    const el = await mountView()
    await click(el, 'notification-enable-0')
    const posts = calls('/api/me/notification-endpoints', 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0][1]?.body).toBe('{"connectionId":"11111111-1111-4111-8111-111111111111","proofKind":"directory_link"}')
    expectNoAccountFields(posts[0][1]?.body as string)
    expect(calls('/api/me/notification-endpoints')).toHaveLength(2)
    expect(calls('/api/me/notification-preferences')).toHaveLength(2)
    expect(text(el, 'notification-action-result')).toBe('通知渠道已启用')
  })

  it('re-enables a stale endpoint through POST rather than a new request shape', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({
      endpoints: [endpoint({ status: 'stale', usable: false, unusableReason: 'endpoint_stale' })],
    })))
    const el = await mountView()
    await click(el, 'notification-reenable-0')
    expect(calls('/api/me/notification-endpoints', 'POST')).toHaveLength(1)
    expect(calls('/api/me/notification-endpoints', 'POST')[0][1]?.body).toBe('{"connectionId":"11111111-1111-4111-8111-111111111111","proofKind":"directory_link"}')
  })

  it('requires revocation confirmation with the mandated explanation before DELETE', async () => {
    const el = await mountView()
    await click(el, 'notification-revoke-0')
    expect(text(el, 'notification-revoke-confirmation')).toBe('撤销只移除这个渠道；没有可用渠道时，通知会发往管理员设置的默认连接。要停止某类通知，请在下方关闭该类型。')
    expect(text(el, 'notification-revoke-confirmation')).toContain('要停止某类通知，请在下方关闭该类型')
    expect(writeCalls()).toHaveLength(0)
    await click(el, 'notification-dialog-confirm')
    const deletes = calls(`/api/me/notification-endpoints/${ENDPOINT}`, 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0][1]?.body).toBeUndefined()
    expect(text(el, 'notification-action-result')).toBe('通知渠道已撤销')
    expect(calls('/api/me/notification-endpoints')).toHaveLength(2)
  })

  it('refreshes both resources on demand', async () => {
    const el = await mountView()
    await click(el, 'notification-refresh')
    expect(calls('/api/me/notification-endpoints')).toHaveLength(2)
    expect(calls('/api/me/notification-preferences')).toHaveLength(2)
  })

  it('rereads after a 409 and asks for review', async () => {
    h_.patchReply.mockReturnValue(response(409, { error: { code: 'PREFERENCE_STALE', currentRevision: 8 } }))
    h_.preferencesReply
      .mockReturnValueOnce(response(200, preferencesListing()))
      .mockReturnValueOnce(response(200, preferencesListing({
        topics: [topic({ preference: { enabled: true, primaryEndpointId: OTHER_ENDPOINT, fallbackEndpointId: null, quietHours: null, revision: 8 } })],
      })))
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ endpoints: [endpoint(), backupEndpoint()] })))
    const el = await mountView()
    await submit(el)
    expect(text(el, 'notification-action-result')).toBe('偏好已在别处更新，已重新读取，请核对后再保存')
    expect(calls('/api/me/notification-preferences')).toHaveLength(2)
    expect(calls('/api/me/notification-endpoints')).toHaveLength(2)
    expect((must(el, 'notification-primary-task_reminder') as HTMLSelectElement).value).toBe(OTHER_ENDPOINT)
  })

  it('allows only one write at a time across every action', async () => {
    const reply = deferred<Response>()
    h_.patchReply.mockReturnValue(reply.promise)
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ candidates: [candidate()] })))
    const el = await mountView()
    await submit(el)
    await submit(el)
    ;(must(el, 'notification-enable-0') as HTMLButtonElement).click()
    ;(must(el, 'notification-revoke-0') as HTMLButtonElement).click()
    await flush()
    expect(calls('/api/me/notification-preferences', 'PATCH')).toHaveLength(1)
    expect(calls('/api/me/notification-endpoints', 'POST')).toHaveLength(0)
    expect(writeCalls()).toHaveLength(1)
    expect((must(el, 'notification-save-task_reminder') as HTMLButtonElement).disabled).toBe(true)
    expect((must(el, 'notification-enable-0') as HTMLButtonElement).disabled).toBe(true)
    expect(page().pendingWrite).toBe(true)
    reply.resolve(response(200, updatedTopic(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body as string)))
    await flush()
    expect(page().pendingWrite).toBe(false)
  })
})

describe('notification test sending', () => {
  beforeEach(() => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({
      delivery: { enabled: true, testSendAvailable: true, reason: null },
    })))
  })

  it.each([
    [202, '已被平台接受'],
    [500, '失败'],
    [502, '结果未知，请在对应平台确认'],
  ])('requires confirmation and maps HTTP %s to the allowed result copy', async (status, copy) => {
    h_.testReply.mockReturnValue(response(status, null))
    const el = await mountView()
    expect((must(el, 'notification-test-0') as HTMLButtonElement).disabled).toBe(false)
    await click(el, 'notification-test-0')
    expect(shown(el, 'notification-test-dialog')).toBeTruthy()
    expect(writeCalls()).toHaveLength(0)
    await click(el, 'notification-dialog-confirm')
    expect(calls(`/api/me/notification-endpoints/${ENDPOINT}/test-send`, 'POST')).toHaveLength(1)
    expect(calls(`/api/me/notification-endpoints/${ENDPOINT}/test-send`, 'POST')[0][1]?.body).toBeUndefined()
    expect(text(el, 'notification-action-result')).toBe(copy)
    expect(text(el, 'notification-action-result')).not.toContain(['已', '送', '达'].join(''))
  })

  it('shows the retry delay after rate limiting', async () => {
    h_.testReply.mockReturnValue(response(429, null, { 'retry-after': '17' }))
    const el = await mountView()
    await click(el, 'notification-test-0')
    await click(el, 'notification-dialog-confirm')
    expect(text(el, 'notification-action-result')).toBe('请求过于频繁，请在 17 秒后重试')
  })
})

describe('late notification responses', () => {
  it('discards a read that resolves after leaving the page', async () => {
    const reply = deferred<Response>()
    h_.endpointsReply.mockReturnValue(reply.promise)
    const el = await mountView()
    const exposed = page()
    expect(exposed.loadState).toBe('loading')
    await router!.push('/settings')
    await flush()
    expect(shown(el, 'other-page')).toBeTruthy()
    reply.resolve(response(200, endpointsListing()))
    await flush()
    expect(exposed.loadState).toBe('loading')
    expect(exposed.endpoints).toBeNull()
    expect(exposed.actionMessage).toBe('')
  })

  it('discards a write that resolves after leaving the page', async () => {
    const reply = deferred<Response>()
    h_.patchReply.mockReturnValue(reply.promise)
    const el = await mountView()
    await toggle(el, 'notification-enabled-task_reminder')
    const exposed = page()
    const draftBefore = exposed.drafts.task_reminder.enabled
    await submit(el)
    await router!.push('/settings')
    await flush()
    reply.resolve(response(200, updatedTopic(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body as string)))
    await flush()
    expect(exposed.actionMessage).toBe('')
    expect(exposed.drafts.task_reminder.enabled).toBe(draftBefore)
    expect(exposed.topics[0].preference).toBeNull()
    expect(shown(el, 'other-page')).toBeTruthy()
  })
})

describe('notification preferences route', () => {
  it('registers the authenticated route metadata next to the session settings route', () => {
    const index = appRoutes.findIndex((route) => route.path === '/settings/notifications')
    expect(index).toBeGreaterThan(0)
    const route = appRoutes[index]
    expect(route).toMatchObject({
      path: '/settings/notifications',
      name: 'notification-preferences',
      meta: { title: 'Notification Settings', titleZh: '通知设置', requiresAuth: true },
    })
    expect(appRoutes[index - 1].path).toBe('/settings')
    expect(typeof route.component).toBe('function')
    expect(String(route.component)).toContain('NotificationPreferencesView.vue')
    const realRouter = createRouter({ history: createMemoryHistory(), routes: appRoutes })
    expect(realRouter.resolve('/settings/notifications').name).toBe('notification-preferences')
  })
})
