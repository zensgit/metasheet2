import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
import { resolveRouteGuardDecision, type RouteGuardPolicyContext } from '../src/router/guardPolicy'
import { useLocale } from '../src/composables/useLocale'

const CONNECTION = '11111111-1111-4111-8111-111111111111'
const OTHER_CONNECTION = '22222222-2222-4222-8222-222222222222'
const ENDPOINT = '33333333-3333-4333-8333-333333333333'
const OTHER_ENDPOINT = '44444444-4444-4444-8444-444444444444'
const THIRD_CONNECTION = '55555555-5555-4555-8555-555555555555'
const THIRD_ENDPOINT = '66666666-6666-4666-8666-666666666666'
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
  readGeneration: number
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

async function fill(el: HTMLElement, testid: string, value: string): Promise<void> {
  const field = must(el, testid) as HTMLInputElement
  field.value = value
  field.dispatchEvent(new Event('input'))
  await flush()
}

async function toggle(el: HTMLElement, testid: string): Promise<void> {
  ;(must(el, testid) as HTMLInputElement).click()
  await flush()
}

let randomFill = 0

beforeEach(() => {
  useLocale().setLocale('zh-CN')
  randomFill = 0
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((target) => {
    const bytes = target as Uint8Array
    bytes.fill(randomFill)
    randomFill = (randomFill + 1) % 256
    return target
  })
  h_.browserZone.mockReset().mockReturnValue(BROWSER_ZONE)
  h_.endpointsReply.mockReset().mockImplementation(() => response(200, endpointsListing()))
  h_.preferencesReply.mockReset().mockImplementation(() => response(200, preferencesListing()))
  h_.establishReply.mockReset().mockImplementation(() => response(201, { endpoint: endpoint() }))
  h_.revokeReply.mockReset().mockImplementation(() => response(200, { endpoint: { id: ENDPOINT, status: 'revoked', revision: 2 } }))
  h_.patchReply.mockReset().mockImplementation((body: string) => response(200, updatedTopic(body)))
  h_.testReply.mockReset().mockImplementation(() => response(200, { outcome: 'accepted', code: 'TEST_ACCEPTED', testSendId: 'test-send-1' }))
  h_.apiFetch.mockReset().mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    if (path === '/api/me/notification-endpoints' && method === 'GET') return h_.endpointsReply()
    if (path === '/api/me/notification-preferences' && method === 'GET') return h_.preferencesReply()
    if (path === '/api/me/notification-endpoints' && method === 'POST') return h_.establishReply(init?.body)
    if (path === '/api/me/notification-preferences' && method === 'PATCH') return h_.patchReply(init?.body)
    if (/^\/api\/me\/notification-endpoints\/[^/]+$/.test(path) && method === 'DELETE') return h_.revokeReply()
    if (/^\/api\/me\/notification-endpoints\/[^/]+\/test$/.test(path) && method === 'POST') return h_.testReply()
    return response(500, null)
  })
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
  vi.restoreAllMocks()
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

  it('renders the exact feature-disabled copy with organization guidance on a 404', async () => {
    h_.endpointsReply.mockReturnValue(response(404, { error: { code: 'NOT_FOUND' } }))
    const el = await mountView()
    expect(text(el, 'notification-disabled')).toBe('管理员尚未启用通知偏好')
    expect(text(el, 'notification-disabled-org-hint')).toBe('如果功能已启用，请确认已选择组织。')
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
    expect(shown(el, 'notification-types')).toBeTruthy()
    expect((must(el, 'notification-primary-task_reminder') as HTMLSelectElement).disabled).toBe(false)
    expect(text(el, 'notification-default-connection')).toBe('将使用管理员设置的默认连接')
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
      ['', '将使用管理员设置的默认连接'],
      [ENDPOINT, '钉钉 · Primary'],
      [OTHER_ENDPOINT, 'Feishu · Backup'],
    ])
    expect(Array.from(fallback.options).map((option) => [option.value, option.textContent?.trim()])).toEqual([
      ['', '无备用渠道'],
    ])
    expect(fallback.disabled).toBe(true)
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

  it('marks a preference effective when enabled, applicable, and usable', async () => {
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
    await select(el, 'notification-primary-task_reminder', ENDPOINT)
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

  it('uses the stored revision and omits every unchanged field', async () => {
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({ preference: { enabled: true, primaryEndpointId: ENDPOINT, fallbackEndpointId: null, quietHours: null, revision: 5 } })],
    })))
    const el = await mountView()
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":5}')
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
    ['accepted', '已被平台接受'],
    ['failed', '失败'],
    ['outcome_unknown', '结果未知，请在对应平台确认'],
  ])('requires confirmation and maps the %s outcome to the allowed copy', async (outcome, copy) => {
    h_.testReply.mockReturnValue(response(200, { outcome, code: 'TEST_OUTCOME', testSendId: 'test-send-1' }))
    const el = await mountView()
    expect((must(el, 'notification-test-0') as HTMLButtonElement).disabled).toBe(false)
    await click(el, 'notification-test-0')
    expect(shown(el, 'notification-test-dialog')).toBeTruthy()
    expect(writeCalls()).toHaveLength(0)
    await click(el, 'notification-dialog-confirm')
    const testCalls = calls(`/api/me/notification-endpoints/${ENDPOINT}/test`, 'POST')
    expect(testCalls).toHaveLength(1)
    expect(testCalls[0][1]?.body).toBe('{"confirm":true,"idempotencyKey":"AAAAAAAAAAAAAAAAAAAAAAAA"}')
    const key = JSON.parse(testCalls[0][1]?.body as string).idempotencyKey
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(text(el, 'notification-action-result')).toBe(copy)
    expect(text(el, 'notification-action-result')).not.toContain(['已', '送', '达'].join(''))
    expect(shown(el, 'notification-test-retry')).toBeNull()
  })

  it('reuses one key after a network failure and generates a new key on the next confirmation', async () => {
    h_.testReply
      .mockImplementationOnce(() => Promise.reject(new TypeError('offline')))
      .mockImplementationOnce(() => response(200, { outcome: 'accepted', code: 'RETRY_ACCEPTED', testSendId: 'test-send-2' }))
      .mockImplementationOnce(() => response(200, { outcome: 'accepted', code: 'NEW_ACCEPTED', testSendId: 'test-send-3' }))
    const el = await mountView()
    await click(el, 'notification-test-0')
    await click(el, 'notification-dialog-confirm')
    expect(text(el, 'notification-action-result')).toBe('结果未知，请在对应平台确认')
    expect(shown(el, 'notification-test-retry')).toBeTruthy()
    const testCalls = () => calls(`/api/me/notification-endpoints/${ENDPOINT}/test`, 'POST')
    expect(testCalls()).toHaveLength(1)
    const firstBody = testCalls()[0][1]?.body as string

    await click(el, 'notification-test-retry')
    expect(testCalls()).toHaveLength(2)
    expect(testCalls()[1][1]?.body).toBe(firstBody)
    expect(text(el, 'notification-action-result')).toBe('已被平台接受')
    expect(shown(el, 'notification-test-retry')).toBeNull()

    await click(el, 'notification-test-0')
    await click(el, 'notification-dialog-confirm')
    expect(testCalls()).toHaveLength(3)
    const nextBody = testCalls()[2][1]?.body as string
    expect(nextBody).toBe('{"confirm":true,"idempotencyKey":"BBBBBBBBBBBBBBBBBBBBBBBB"}')
    expect(nextBody).not.toBe(firstBody)
    expect(vi.mocked(globalThis.crypto.getRandomValues).mock.calls).toHaveLength(2)
  })

  it.each([
    [422, 'CONFIRM_REQUIRED', '请先确认测试发送'],
    [409, 'NOTIFICATION_DELIVERY_DISABLED', '通知发送能力尚未启用'],
    [409, 'ENDPOINT_NOT_USABLE', '当前渠道不可用，请重新启用后再试'],
    [409, 'CONNECTION_NOT_READY', '连接尚未就绪，请稍后再试'],
    [409, 'TEST_SEND_IN_PROGRESS', '上一条测试仍在处理中，请稍后再试'],
    [404, 'NOT_FOUND', '通知渠道不存在或已移除'],
  ])('shows the explanation for HTTP %s %s', async (status, code, copy) => {
    h_.testReply.mockReturnValue(response(status, { error: { code } }))
    const el = await mountView()
    await click(el, 'notification-test-0')
    await click(el, 'notification-dialog-confirm')
    expect(text(el, 'notification-action-result')).toBe(copy)
    expect(shown(el, 'notification-test-retry')).toBeNull()
  })

  it('shows Retry-After seconds after TEST_SEND_RATE_LIMITED', async () => {
    h_.testReply.mockReturnValue(response(429, { error: { code: 'TEST_SEND_RATE_LIMITED' } }, { 'retry-after': '17' }))
    const el = await mountView()
    await click(el, 'notification-test-0')
    await click(el, 'notification-dialog-confirm')
    expect(text(el, 'notification-action-result')).toBe('请求过于频繁，请在 17 秒后重试')
  })
})

describe('notification state, errors, and accessibility', () => {
  const storedPreference = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    primaryEndpointId: ENDPOINT,
    fallbackEndpointId: null,
    quietHours: null,
    revision: 4,
    ...over,
  })
  const alternateEndpoint = () => endpoint({
    id: THIRD_ENDPOINT,
    connection: { id: THIRD_CONNECTION, provider: 'dingtalk', label: '钉钉 · Alternate' },
  })

  it('blocks preference writes while a refresh is in flight and releases them afterward', async () => {
    const el = await mountView()
    const oldEndpoints = deferred<Response>()
    const oldPreferences = deferred<Response>()
    h_.endpointsReply.mockReturnValue(oldEndpoints.promise)
    h_.preferencesReply.mockReturnValue(oldPreferences.promise)
    await click(el, 'notification-refresh')
    expect((must(el, 'notification-save-task_reminder') as HTMLButtonElement).disabled).toBe(true)
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')).toHaveLength(0)
    expect(page().pendingWrite).toBe(false)

    oldEndpoints.resolve(response(200, endpointsListing()))
    oldPreferences.resolve(response(200, preferencesListing()))
    await flush()
    expect(page().loading).toBe(false)
    expect((must(el, 'notification-save-task_reminder') as HTMLButtonElement).disabled).toBe(false)
    await toggle(el, 'notification-enabled-task_reminder')
    await submit(el)
    expect(text(el, 'notification-action-result')).toBe('已保存')
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":0,"enabled":false}')
  })

  it.each([
    ['ENDPOINT_NOT_USABLE', 'endpoint_stale', '绑定关系需要重新确认'],
    ['ENDPOINT_NOT_ALLOWED_FOR_TOPIC', null, '该渠道不能用于此通知类型'],
    ['FALLBACK_PROVIDER_NOT_ALLOWED', null, '备用渠道必须与主渠道使用不同提供方'],
  ])('keeps the draft and explains %s instead of reloading', async (code, reason, copy) => {
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({ topics: [topic({ preference: storedPreference() })] })))
    const el = await mountView()
    await toggle(el, 'notification-quiet-enabled-task_reminder')
    await fill(el, 'notification-quiet-start-task_reminder', '23:00')
    h_.patchReply.mockReturnValue(response(409, { error: { code, ...(reason ? { reason } : {}) } }))
    await submit(el)
    expect(text(el, 'notification-action-result')).toBe(copy)
    expect(calls('/api/me/notification-preferences')).toHaveLength(1)
    expect(calls('/api/me/notification-endpoints')).toHaveLength(1)
    expect(page().drafts.task_reminder.quietEnabled).toBe(true)
    expect(page().drafts.task_reminder.quietStart).toBe('23:00')
    expect(text(el, 'notification-action-result')).not.toBe('偏好已在别处更新，已重新读取，请核对后再保存')
  })

  it('omits unchanged stale primary and fallback ids so only the enabled flag changes', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({
      endpoints: [
        endpoint({ status: 'stale', usable: false, unusableReason: 'endpoint_stale' }),
        backupEndpoint({ status: 'stale', usable: false, unusableReason: 'endpoint_stale' }),
        alternateEndpoint(),
      ],
    })))
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({ preference: storedPreference({ fallbackEndpointId: OTHER_ENDPOINT, revision: 9 }) })],
    })))
    h_.patchReply.mockImplementation((body: string) => {
      const patch = JSON.parse(body)
      const suppliedIds = [patch.primaryEndpointId, patch.fallbackEndpointId].filter((id) => typeof id === 'string')
      if (suppliedIds.some((id) => id === ENDPOINT || id === OTHER_ENDPOINT)) {
        return response(409, { error: { code: 'ENDPOINT_NOT_USABLE', reason: 'endpoint_stale' } })
      }
      return response(200, topic({
        preference: storedPreference({ enabled: patch.enabled ?? true, fallbackEndpointId: OTHER_ENDPOINT, revision: 10 }),
      }))
    })
    const el = await mountView()
    const primary = must(el, 'notification-primary-task_reminder') as HTMLSelectElement
    const fallback = must(el, 'notification-fallback-task_reminder') as HTMLSelectElement
    expect(primary.value).toBe(ENDPOINT)
    expect(fallback.value).toBe(OTHER_ENDPOINT)
    expect(Array.from(primary.options).find((option) => option.value === ENDPOINT)?.disabled).toBe(true)
    expect(Array.from(fallback.options).find((option) => option.value === OTHER_ENDPOINT)?.disabled).toBe(true)
    expect(text(el, 'notification-primary-issue-task_reminder')).toBe('绑定关系需要重新确认')
    expect(text(el, 'notification-fallback-issue-task_reminder')).toBe('绑定关系需要重新确认')

    await toggle(el, 'notification-enabled-task_reminder')
    await submit(el)
    expect(text(el, 'notification-action-result')).toBe('已保存')
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":9,"enabled":false}')
    expect(calls('/api/me/notification-preferences')).toHaveLength(1)
  })

  it('does not mark a disabled preference effective', async () => {
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({
        applies: { now: true, reason: null },
        preference: storedPreference({ enabled: false }),
        effective: {
          source: 'user_primary',
          connection: { id: CONNECTION, provider: 'dingtalk', label: '钉钉 · Primary' },
          usable: true,
          fallback: null,
        },
      })],
    })))
    const el = await mountView()
    expect(text(el, 'notification-effective-task_reminder')).toBe('此偏好目前未生效')
    expect(text(el, 'notification-effective-task_reminder')).not.toContain('通知发送能力尚未启用')
  })

  it('uses neutral copy when an applicable preference has an unusable endpoint and no reason code', async () => {
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({
        applies: { now: true, reason: null },
        preference: storedPreference(),
        effective: {
          source: 'user_primary',
          connection: { id: CONNECTION, provider: 'dingtalk', label: '钉钉 · Primary' },
          usable: false,
          fallback: null,
        },
      })],
    })))
    const el = await mountView()
    expect(text(el, 'notification-effective-task_reminder')).toBe('此偏好目前未生效')
    expect(text(el, 'notification-effective-task_reminder')).not.toContain('通知发送能力尚未启用')
  })

  it('uses an ASCII separator for the English effectiveness explanation', async () => {
    useLocale().setLocale('en')
    const el = await mountView()
    expect(text(el, 'notification-effective-task_reminder')).toBe('This preference is currently not effective: This notification type is not connected to the delivery flow yet')
    expect(text(el, 'notification-effective-task_reminder')).not.toContain('：')
  })

  it('shows the specific PROOF_AMBIGUOUS explanation after an enable conflict', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ candidates: [candidate()] })))
    h_.establishReply.mockReturnValue(response(409, { error: { code: 'PROOF_AMBIGUOUS' } }))
    const el = await mountView()
    await click(el, 'notification-enable-0')
    expect(text(el, 'notification-action-result')).toBe('绑定关系不唯一，请联系管理员处理')
    expect(calls('/api/me/notification-endpoints')).toHaveLength(1)
  })

  it.each(['test', 'revoke'] as const)('moves focus to the persistent result after confirming %s', async (action) => {
    const reply = deferred<Response>()
    if (action === 'test') {
      h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ delivery: { enabled: true, testSendAvailable: true, reason: null } })))
      h_.testReply.mockReturnValue(reply.promise)
    } else {
      h_.revokeReply.mockReturnValue(reply.promise)
    }
    const el = await mountView()
    if (action === 'revoke') h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ endpoints: [] })))
    await click(el, action === 'test' ? 'notification-test-0' : 'notification-revoke-0')
    const confirm = must(el, 'notification-dialog-confirm') as HTMLButtonElement
    confirm.focus()
    confirm.click()
    await flush()
    expect(document.activeElement).toBe(must(el, 'notification-action-result'))
    reply.resolve(action === 'test'
      ? response(200, { outcome: 'accepted', code: 'TEST_ACCEPTED', testSendId: 'test-send-1' })
      : response(200, { endpoint: { id: ENDPOINT, status: 'revoked', revision: 2 } }))
    await flush()
    expect(document.activeElement).toBe(must(el, 'notification-action-result'))
  })

  it.each([
    ['fallbackEndpointId', '备用渠道选择无效，请检查主、备渠道'],
    ['quietHours.start', '静默时段开始时间无效'],
  ])('shows the server-provided 422 field %s', async (field, copy) => {
    h_.patchReply.mockReturnValue(response(422, { error: { code: 'INVALID_REQUEST', fields: [field] } }))
    const el = await mountView()
    await submit(el)
    expect(text(el, 'notification-action-result')).toBe(copy)
    expect(calls('/api/me/notification-preferences')).toHaveLength(1)
  })

  it.each([
    ['22:00', '22:00', BROWSER_ZONE],
    ['22:00', '08:00', 'Nowhere/Land'],
  ])('rejects an invalid quiet draft before transport: %s %s %s', async (start, end, timeZone) => {
    const el = await mountView()
    await toggle(el, 'notification-quiet-enabled-task_reminder')
    await fill(el, 'notification-quiet-start-task_reminder', start)
    await fill(el, 'notification-quiet-end-task_reminder', end)
    await fill(el, 'notification-time-zone-task_reminder', timeZone)
    await submit(el)
    expect(text(el, 'notification-form-error-task_reminder')).toBe('请填写有效的起止时间和时区；起止时间不能相同')
    expect(calls('/api/me/notification-preferences', 'PATCH')).toHaveLength(0)
    expect(page().pendingWrite).toBe(false)
    expect((must(el, 'notification-save-task_reminder') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the stored quiet-hours time zone instead of replacing it with the browser zone', async () => {
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({ preference: storedPreference({ quietHours: { start: '22:00', end: '08:00', timeZone: 'Europe/Paris' }, revision: 2 }) })],
    })))
    const el = await mountView()
    expect((must(el, 'notification-time-zone-task_reminder') as HTMLInputElement).value).toBe('Europe/Paris')
    await fill(el, 'notification-quiet-start-task_reminder', '23:00')
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toContain('"quietHours":{"start":"23:00","end":"08:00","timeZone":"Europe/Paris"}')
  })

  it('marks directly disabled quiet-hours controls and pins their disabled styling', async () => {
    const el = await mountView()
    const start = must(el, 'notification-quiet-start-task_reminder') as HTMLInputElement
    const zone = must(el, 'notification-time-zone-task_reminder') as HTMLInputElement
    expect(start.disabled).toBe(true)
    expect(zone.disabled).toBe(true)
    const source = readFileSync(resolve('src/views/NotificationPreferencesView.vue'), 'utf8')
    expect(source).toContain('button:disabled,\ninput:disabled,\nselect:disabled,')
    expect(source).toContain('cursor: not-allowed;\n  opacity: 0.62;')
    await toggle(el, 'notification-quiet-enabled-task_reminder')
    expect(start.disabled).toBe(false)
    expect(zone.disabled).toBe(false)
  })

  it('clears a pending test retry when another write starts', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ delivery: { enabled: true, testSendAvailable: true, reason: null } })))
    h_.testReply.mockRejectedValue(new TypeError('offline'))
    const el = await mountView()
    await click(el, 'notification-test-0')
    await click(el, 'notification-dialog-confirm')
    expect(shown(el, 'notification-test-retry')).toBeTruthy()
    await submit(el)
    expect(text(el, 'notification-action-result')).toBe('已保存')
    expect(shown(el, 'notification-test-retry')).toBeNull()
    expect(calls(`/api/me/notification-endpoints/${ENDPOINT}/test`, 'POST')).toHaveLength(1)
  })

  it('pins the guard runner, empty npmrc, and dependency cache', () => {
    const workflow = readFileSync(resolve('..', '..', '.github', 'workflows', 'notification-preferences-web-guard.yml'), 'utf8')
    expect(workflow).toContain('runs-on: ubuntu-24.04')
    expect(workflow).toContain('echo "" > /tmp/empty-npmrc')
    expect(workflow).toContain('NPM_CONFIG_USERCONFIG=/tmp/empty-npmrc')
    expect(workflow).toContain('uses: actions/cache@v4')
    expect(workflow).toContain('Get pnpm store directory')
    expect(workflow.indexOf('Use empty npmrc for pnpm')).toBeLessThan(workflow.indexOf('Install dependencies'))
  })
})

describe('notification candidates, writes, and route reachability', () => {
  it('distinguishes candidates that can be enabled from usable endpoints', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({
      endpoints: [],
      candidates: [candidate({ addressable: true, endpointId: null })],
    })))
    const el = await mountView()
    expect(text(el, 'notification-no-channels')).toBe('还没有启用的渠道，可在下方启用。')
    expect(text(el, 'notification-candidate-0')).toContain('可启用')
    expect(text(el, 'notification-candidate-0')).not.toContain('以下候选均不能用于通知')
    expect(shown(el, 'notification-enable-0')).toBeTruthy()
  })

  it('wraps Tab and Shift+Tab focus within the confirmation dialog', async () => {
    const el = await mountView()
    await click(el, 'notification-revoke-0')
    const confirm = must(el, 'notification-dialog-confirm') as HTMLButtonElement
    const cancel = must(el, 'notification-dialog-cancel') as HTMLButtonElement
    confirm.focus()
    confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await flush()
    expect(document.activeElement).toBe(cancel)
    cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    await flush()
    expect(document.activeElement).toBe(confirm)
    expect(writeCalls()).toHaveLength(0)
  })

  it('keeps notification types editable after the last channel is revoked', async () => {
    const el = await mountView()
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ endpoints: [], candidates: [] })))
    await click(el, 'notification-revoke-0')
    await click(el, 'notification-dialog-confirm')
    expect(shown(el, 'notification-types')).toBeTruthy()
    expect((must(el, 'notification-primary-task_reminder') as HTMLSelectElement).disabled).toBe(false)
    expect(text(el, 'notification-default-connection')).toBe('将使用管理员设置的默认连接')
    await toggle(el, 'notification-enabled-task_reminder')
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":0,"enabled":false}')
    expect(text(el, 'notification-action-result')).toBe('已保存')
  })

  it('hides candidates whose endpoint is already listed', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({
      candidates: [candidate({ addressable: true, endpointId: ENDPOINT })],
    })))
    const el = await mountView()
    expect(shown(el, 'notification-endpoint-0')).toBeTruthy()
    expect(shown(el, 'notification-candidate-0')).toBeNull()
    expect(shown(el, 'notification-enable-0')).toBeNull()
  })

  it('does not invalidate reads after a test-send outcome', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ delivery: { enabled: true, testSendAvailable: true, reason: null } })))
    const el = await mountView()
    const generation = page().readGeneration
    await click(el, 'notification-test-0')
    await click(el, 'notification-dialog-confirm')
    expect(text(el, 'notification-action-result')).toBe('已被平台接受')
    expect(page().readGeneration).toBe(generation)
    await click(el, 'notification-refresh')
    expect(calls('/api/me/notification-endpoints')).toHaveLength(2)
    expect(page().readGeneration).toBe(generation + 1)
  })

  it.each([
    [500, { error: { code: 'INTERNAL' } }],
    [502, { error: { code: 'BAD_GATEWAY' } }],
    [200, { outcome: 'accepted', code: 'TEST', testSendId: 'test-send-1', extra: true }],
  ])('treats an unclear test-send response at HTTP %s as unknown and retries with the same key', async (status, body) => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ delivery: { enabled: true, testSendAvailable: true, reason: null } })))
    h_.testReply
      .mockReturnValueOnce(response(status, body))
      .mockReturnValueOnce(response(200, { outcome: 'accepted', code: 'RETRY_ACCEPTED', testSendId: 'test-send-2' }))
    const el = await mountView()
    await click(el, 'notification-test-0')
    await click(el, 'notification-dialog-confirm')
    expect(text(el, 'notification-action-result')).toBe('结果未知，请在对应平台确认')
    expect(shown(el, 'notification-test-retry')).toBeTruthy()
    const firstBody = calls(`/api/me/notification-endpoints/${ENDPOINT}/test`, 'POST')[0][1]?.body
    await click(el, 'notification-test-retry')
    const testCalls = calls(`/api/me/notification-endpoints/${ENDPOINT}/test`, 'POST')
    expect(testCalls).toHaveLength(2)
    expect(testCalls[1][1]?.body).toBe(firstBody)
    expect(text(el, 'notification-action-result')).toBe('已被平台接受')
  })

  it('uses the neutral cross-account explanation for ADDRESS_ALREADY_BOUND', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ candidates: [candidate()] })))
    h_.establishReply.mockReturnValue(response(409, { error: { code: 'ADDRESS_ALREADY_BOUND' } }))
    const el = await mountView()
    await click(el, 'notification-enable-0')
    expect(text(el, 'notification-action-result')).toBe('该接收地址已被其他账号启用，请联系管理员')
  })

  it.each([
    ['not_verified', '连接尚未完成验证'],
    ['endpoint_unusable', '通知渠道当前不可用'],
  ])('shows the delivery reason %s', async (reason, copy) => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({
      delivery: { enabled: false, testSendAvailable: false, reason },
    })))
    const el = await mountView()
    expect(text(el, 'notification-test-reason-0')).toBe(copy)
  })

  it('clears the fallback when the primary changes to its provider', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ endpoints: [endpoint(), backupEndpoint()] })))
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({
        preference: {
          enabled: true,
          primaryEndpointId: ENDPOINT,
          fallbackEndpointId: OTHER_ENDPOINT,
          quietHours: null,
          revision: 3,
        },
      })],
    })))
    const el = await mountView()
    await select(el, 'notification-primary-task_reminder', OTHER_ENDPOINT)
    expect((must(el, 'notification-fallback-task_reminder') as HTMLSelectElement).value).toBe('')
  })

  it('renders each connection label once without a duplicate provider', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ candidates: [candidate()] })))
    const el = await mountView()
    for (const testid of ['notification-endpoint-0', 'notification-candidate-0']) {
      const title = must(el, testid).querySelector('.notification-card__title')!
      expect(title.querySelector('strong')?.textContent?.trim()).toBe('钉钉 · Primary')
      expect(title.querySelectorAll('span')).toHaveLength(1)
    }
  })

  it('disables and labels the error retry while a reread is pending', async () => {
    h_.endpointsReply.mockReturnValueOnce(response(500, null))
    const el = await mountView()
    const reply = deferred<Response>()
    h_.endpointsReply.mockReturnValue(reply.promise)
    await click(el, 'notification-retry')
    const retry = must(el, 'notification-retry') as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    expect(retry.textContent?.trim()).toBe('刷新中…')
    reply.resolve(response(200, endpointsListing()))
    await flush()
    expect(shown(el, 'notification-channels')).toBeTruthy()
  })

  it('matches session-route reachability in ordinary and focused shells', () => {
    const route = appRoutes.find((item) => item.path === '/settings/notifications')!
    const context = (over: Partial<RouteGuardPolicyContext> = {}): RouteGuardPolicyContext => ({
      hasFeature: () => true,
      hasPermission: () => true,
      attendanceFocused: false,
      plmWorkbenchFocused: false,
      resolveHomePath: () => '/HOME',
      ...over,
    })
    expect(resolveRouteGuardDecision({ path: '/settings/notifications', meta: route.meta }, context())).toEqual({ action: 'allow' })
    expect(resolveRouteGuardDecision({ path: '/settings/notifications', meta: route.meta }, context({ attendanceFocused: true }))).toEqual({ action: 'redirect', target: '/attendance' })
    expect(resolveRouteGuardDecision({ path: '/settings', meta: route.meta }, context({ attendanceFocused: true }))).toEqual({ action: 'allow' })
    expect(resolveRouteGuardDecision({ path: '/settings/notifications', meta: route.meta }, context({ plmWorkbenchFocused: true }))).toEqual({ action: 'redirect', target: '/plm' })
  })
})

describe('notification preference field transitions', () => {
  const existingPreference = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    primaryEndpointId: ENDPOINT,
    fallbackEndpointId: null,
    quietHours: null,
    revision: 4,
    ...over,
  })

  it('sends primaryEndpointId null only when the primary changes to the default connection', async () => {
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({ topics: [topic({ preference: existingPreference() })] })))
    const el = await mountView()
    await select(el, 'notification-primary-task_reminder', '')
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":4,"primaryEndpointId":null}')
  })

  it('sends fallbackEndpointId null only when the fallback changes to none', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ endpoints: [endpoint(), backupEndpoint()] })))
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({ preference: existingPreference({ fallbackEndpointId: OTHER_ENDPOINT, revision: 5 }) })],
    })))
    const el = await mountView()
    await select(el, 'notification-fallback-task_reminder', '')
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":5,"fallbackEndpointId":null}')
  })

  it('sends quietHours null only when quiet hours are turned off', async () => {
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({ preference: existingPreference({ quietHours: { start: '22:00', end: '08:00', timeZone: 'Europe/Paris' }, revision: 6 }) })],
    })))
    const el = await mountView()
    await toggle(el, 'notification-quiet-enabled-task_reminder')
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":6,"quietHours":null}')
  })

  it('sends the complete new quietHours only when the time zone changes', async () => {
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({ preference: existingPreference({ quietHours: { start: '22:00', end: '08:00', timeZone: 'Europe/Paris' }, revision: 7 }) })],
    })))
    const el = await mountView()
    await fill(el, 'notification-time-zone-task_reminder', 'Asia/Shanghai')
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":7,"quietHours":{"start":"22:00","end":"08:00","timeZone":"Asia/Shanghai"}}')
  })

  it('clears the fallback draft and sends both nulls when the primary becomes default', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({ endpoints: [endpoint(), backupEndpoint()] })))
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({
      topics: [topic({ preference: existingPreference({ fallbackEndpointId: OTHER_ENDPOINT, revision: 8 }) })],
    })))
    const el = await mountView()
    await select(el, 'notification-primary-task_reminder', '')
    expect((must(el, 'notification-fallback-task_reminder') as HTMLSelectElement).value).toBe('')
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":8,"primaryEndpointId":null,"fallbackEndpointId":null}')
  })

  it('distinguishes an unavailable selected channel from an empty default selection', async () => {
    h_.endpointsReply.mockReturnValue(response(200, endpointsListing({
      endpoints: [endpoint({ status: 'stale', usable: false, unusableReason: 'endpoint_stale' })],
    })))
    h_.preferencesReply.mockReturnValue(response(200, preferencesListing({ topics: [topic({ preference: existingPreference({ revision: 9 }) })] })))
    const el = await mountView()
    expect(text(el, 'notification-selected-unavailable')).toBe('所选渠道当前不可用，通知不会改投默认连接')
    expect(shown(el, 'notification-default-connection')).toBeNull()
    expect((must(el, 'notification-primary-task_reminder') as HTMLSelectElement).disabled).toBe(false)
    await select(el, 'notification-primary-task_reminder', '')
    expect(text(el, 'notification-default-connection')).toBe('将使用管理员设置的默认连接')
    expect(shown(el, 'notification-selected-unavailable')).toBeNull()
    await submit(el)
    expect(calls('/api/me/notification-preferences', 'PATCH')[0][1]?.body).toBe('{"topic":"task_reminder","expectedRevision":9,"primaryEndpointId":null}')
  })

  it('allows restarting a stalled refresh before allowing writes again', async () => {
    const el = await mountView()
    const first = deferred<Response>()
    const second = deferred<Response>()
    h_.endpointsReply.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    expect((must(el, 'notification-refresh') as HTMLButtonElement).disabled).toBe(false)
    await click(el, 'notification-refresh')
    expect((must(el, 'notification-save-task_reminder') as HTMLButtonElement).disabled).toBe(true)
    expect((must(el, 'notification-refresh') as HTMLButtonElement).disabled).toBe(false)
    await click(el, 'notification-refresh')
    expect(calls('/api/me/notification-endpoints')).toHaveLength(3)
    second.resolve(response(200, endpointsListing()))
    await flush()
    expect(page().loading).toBe(false)
    expect((must(el, 'notification-save-task_reminder') as HTMLButtonElement).disabled).toBe(false)
    first.resolve(response(200, endpointsListing()))
    await flush()
    expect(page().loading).toBe(false)
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
