import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

import MetaApiTokenManager from '../src/multitable/components/MetaApiTokenManager.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'
import type {
  ApiToken,
  DingTalkGroupDelivery,
  DingTalkGroupDestination,
  Webhook,
  WebhookDelivery,
} from '../src/multitable/types'

function okResponse(body: unknown) {
  return new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function noContentResponse() {
  return new Response(null, { status: 204 })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeToken(overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id: 'tok_1',
    name: 'Test token',
    prefix: 'mst_abc',
    scopes: ['read', 'write'],
    createdAt: '2026-04-01T00:00:00Z',
    lastUsedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

function fakeWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: 'wh_1',
    name: 'Test webhook',
    url: 'https://example.com/hook',
    events: ['record.created'],
    active: true,
    secret: null,
    failureCount: 0,
    sheetId: 'sheet_1',
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

function fakeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'del_1',
    webhookId: 'wh_1',
    event: 'record.created',
    status: 'success',
    httpStatus: 200,
    attemptCount: 1,
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

function fakeDingTalkGroup(overrides: Partial<DingTalkGroupDestination> = {}): DingTalkGroupDestination {
  return {
    id: 'dt_1',
    name: 'Ops DingTalk Group',
    webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
    hasSecret: false,
    enabled: true,
    scope: 'sheet',
    sheetId: 'sheet_1',
    createdBy: 'user_1',
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    lastTestedAt: '2026-04-01T01:00:00Z',
    lastTestStatus: 'success',
    lastTestError: undefined,
    ...overrides,
  }
}

function fakeDingTalkDelivery(overrides: Partial<DingTalkGroupDelivery> = {}): DingTalkGroupDelivery {
  return {
    id: 'dtd_1',
    destinationId: 'dt_1',
    sourceType: 'automation',
    subject: 'Please fill incident details',
    content: 'Body text',
    success: true,
    httpStatus: 200,
    createdAt: '2026-04-01T02:00:00Z',
    ...overrides,
  }
}

function mockClient(
  tokens: ApiToken[] = [],
  webhooks: Webhook[] = [],
  deliveries: WebhookDelivery[] = [],
  dingTalkGroups: DingTalkGroupDestination[] = [],
  dingTalkDeliveries: DingTalkGroupDelivery[] = [],
) {
  let currentDingTalkDeliveries = [...dingTalkDeliveries]

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'

    // Tokens
    if (method === 'GET' && url.includes('/tokens') && !url.includes('/rotate')) {
      return okResponse({ tokens })
    }
    if (method === 'POST' && url.includes('/tokens') && !url.includes('/rotate')) {
      const body = JSON.parse(init?.body as string)
      return okResponse({ token: { id: 'tok_new', prefix: 'mst_new', ...body, createdAt: '2026-04-01', lastUsedAt: null, expiresAt: null }, plaintext: 'mst_plaintext_secret_123' })
    }
    if (method === 'DELETE' && url.includes('/tokens/')) {
      return noContentResponse()
    }
    if (method === 'POST' && url.includes('/rotate')) {
      return okResponse({ token: fakeToken({ id: 'tok_rotated', prefix: 'mst_rot' }), plaintext: 'mst_rotated_secret_456' })
    }

    // Webhooks
    if (method === 'GET' && url.includes('/webhooks') && !url.includes('/deliveries')) {
      return okResponse({ webhooks })
    }
    if (method === 'POST' && url.includes('/webhooks') && !url.includes('/deliveries')) {
      const body = JSON.parse(init?.body as string)
      return okResponse({ id: 'wh_new', active: true, secret: null, failureCount: 0, createdAt: '2026-04-01', updatedAt: '2026-04-01', ...body })
    }
    if (method === 'PATCH' && url.includes('/webhooks/')) {
      return okResponse(webhooks[0] ?? {})
    }
    if (method === 'DELETE' && url.includes('/webhooks/')) {
      return noContentResponse()
    }
    if (method === 'GET' && url.includes('/webhooks/') && url.includes('/deliveries')) {
      return okResponse({ deliveries })
    }

    // DingTalk groups
    if (method === 'GET' && url.includes('/dingtalk-groups/') && url.includes('/deliveries')) {
      return okResponse({ deliveries: currentDingTalkDeliveries })
    }
    if (method === 'GET' && url.includes('/dingtalk-groups') && !url.includes('/test-send')) {
      return okResponse({ destinations: dingTalkGroups })
    }
    if (method === 'POST' && url.includes('/dingtalk-groups') && !url.includes('/test-send')) {
      const body = JSON.parse(init?.body as string)
      return okResponse({
        id: 'dt_new',
        createdBy: 'user_1',
        createdAt: '2026-04-01T00:00:00Z',
        ...body,
      })
    }
    if (method === 'PATCH' && url.includes('/dingtalk-groups/')) {
      return okResponse(dingTalkGroups[0] ?? {})
    }
    if (method === 'DELETE' && url.includes('/dingtalk-groups/')) {
      return noContentResponse()
    }
    if (method === 'POST' && url.includes('/dingtalk-groups/') && url.includes('/test-send')) {
      currentDingTalkDeliveries = [
        fakeDingTalkDelivery({
          id: `dtd_${currentDingTalkDeliveries.length + 1}`,
          sourceType: 'manual_test',
          subject: 'MetaSheet DingTalk group test',
        }),
        ...currentDingTalkDeliveries,
      ]
      return noContentResponse()
    }

    return okResponse({})
  })
  return { client: new MultitableApiClient({ fetchFn }), fetchFn }
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaApiTokenManager, { sheetId: 'sheet_1', ...props }) })
  app.mount(container)
  return { container, app }
}

describe('MetaApiTokenManager', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    useLocale().setLocale('en')
    vi.restoreAllMocks()
  })

  // ---- Token tests ----

  it('renders token list when visible', async () => {
    const { client } = mockClient([fakeToken()])
    mount({ visible: true, client })
    await flushPromises()

    const cards = document.querySelectorAll('[data-token-id]')
    expect(cards.length).toBe(1)
    expect(document.querySelector('.meta-api-mgr__card-name')?.textContent).toBe('Test token')
    // 客户反馈 2026-09-24 #4c follow-up: the business-timezone day (Asia/Shanghai default), YYYY-MM-DD —
    // createdAt 2026-04-01T00:00:00Z is 08:00 on 04-01 in Beijing, whatever the browser zone / locale.
    expect(document.querySelector('[data-token-id]')?.textContent).toContain('2026-04-01')
  })

  it('shows empty state when no tokens', async () => {
    const { client } = mockClient()
    mount({ visible: true, client })
    await flushPromises()

    expect(document.querySelector('[data-tokens-empty]')).toBeTruthy()
  })

  it('opens create token form', async () => {
    const { client } = mockClient()
    mount({ visible: true, client })
    await flushPromises()

    const newBtn = document.querySelector('[data-token-new]') as HTMLButtonElement
    expect(newBtn).toBeTruthy()
    newBtn.click()
    await flushPromises()

    expect(document.querySelector('[data-token-form]')).toBeTruthy()
    expect(document.querySelector('[data-token-name]')).toBeTruthy()
  })

  it('creates token and shows plaintext once', async () => {
    const { client } = mockClient()
    mount({ visible: true, client })
    await flushPromises()

    // Open form
    const newBtn = document.querySelector('[data-token-new]') as HTMLButtonElement
    newBtn.click()
    await flushPromises()

    // Fill name
    const nameInput = document.querySelector('[data-token-name]') as HTMLInputElement
    nameInput.value = 'My token'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    // Submit
    const createBtn = document.querySelector('[data-token-create]') as HTMLButtonElement
    createBtn.click()
    await flushPromises()

    // Plaintext shown
    const newTokenEl = document.querySelector('[data-new-token]')
    expect(newTokenEl).toBeTruthy()
    const tokenValue = document.querySelector('[data-new-token-value]')
    expect(tokenValue?.textContent).toBe('mst_plaintext_secret_123')
  })

  it('revokes a token', async () => {
    const { client, fetchFn } = mockClient([fakeToken()])
    mount({ visible: true, client })
    await flushPromises()

    const revokeBtn = document.querySelector('[data-token-revoke]') as HTMLButtonElement
    expect(revokeBtn).toBeTruthy()
    revokeBtn.click()
    await flushPromises()

    const deleteCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'DELETE' && c[0].includes('/tokens/'),
    )
    expect(deleteCalls.length).toBe(1)
  })

  it('rotates a token and shows new plaintext', async () => {
    const { client } = mockClient([fakeToken()])
    mount({ visible: true, client })
    await flushPromises()

    const rotateBtn = document.querySelector('[data-token-rotate]') as HTMLButtonElement
    rotateBtn.click()
    await flushPromises()

    const tokenValue = document.querySelector('[data-new-token-value]')
    expect(tokenValue?.textContent).toBe('mst_rotated_secret_456')
  })

  describe('copy new token on a plain-HTTP (non-secure-context) deployment — no Clipboard API', () => {
    let originalClipboard: PropertyDescriptor | undefined
    let originalExecCommand: PropertyDescriptor | undefined
    beforeEach(() => {
      originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
      originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    })
    afterEach(() => {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
      if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand)
      else Reflect.deleteProperty(document, 'execCommand')
    })

    async function rotateAndClickCopy(): Promise<HTMLButtonElement> {
      const { client } = mockClient([fakeToken()])
      mount({ visible: true, client })
      await flushPromises()
      ;(document.querySelector('[data-token-rotate]') as HTMLButtonElement).click()
      await flushPromises()
      const copyBtn = document.querySelector('[data-copy-new-token]') as HTMLButtonElement
      expect(copyBtn.textContent?.trim()).toBe('Copy')
      copyBtn.click()
      await flushPromises()
      return copyBtn
    }

    it('copies the plaintext through the execCommand fallback and only then says "Copied!"', async () => {
      const copied: string[] = []
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        writable: true,
        value: vi.fn((command: string) => {
          copied.push(`${command}:${document.querySelector('textarea')?.value ?? ''}`)
          return true
        }),
      })
      const copyBtn = await rotateAndClickCopy()
      expect(copied).toEqual(['copy:mst_rotated_secret_456'])
      expect(document.querySelector('textarea')).toBeNull()
      expect(copyBtn.textContent?.trim()).toBe('Copied!')
    })

    it('with no copy mechanism at all it does not throw and does not claim "Copied!"', async () => {
      Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: undefined })
      const copyBtn = await rotateAndClickCopy()
      expect(copyBtn.textContent?.trim()).toBe('Copy failed: select it manually')
      expect(document.querySelector('[data-new-token-value]')?.textContent).toBe('mst_rotated_secret_456')
    })
  })

  // ---- Webhook tests ----

  it('switches to webhooks tab', async () => {
    const { client } = mockClient([], [fakeWebhook()])
    mount({ visible: true, client })
    await flushPromises()

    const webhookTab = document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement
    webhookTab.click()
    await flushPromises()

    const cards = document.querySelectorAll('[data-webhook-id]')
    expect(cards.length).toBe(1)
  })

  it('shows webhook empty state', async () => {
    const { client } = mockClient()
    mount({ visible: true, client })
    await flushPromises()

    const webhookTab = document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement
    webhookTab.click()
    await flushPromises()

    expect(document.querySelector('[data-webhooks-empty]')).toBeTruthy()
  })

  it('creates a webhook', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, client })
    await flushPromises()

    // Switch to webhooks tab
    const webhookTab = document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement
    webhookTab.click()
    await flushPromises()

    // Open form
    const newBtn = document.querySelector('[data-webhook-new]') as HTMLButtonElement
    newBtn.click()
    await flushPromises()

    // Fill form
    const nameInput = document.querySelector('[data-webhook-name]') as HTMLInputElement
    nameInput.value = 'My webhook'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const urlInput = document.querySelector('[data-webhook-url]') as HTMLInputElement
    urlInput.value = 'https://example.com/hook'
    urlInput.dispatchEvent(new Event('input', { bubbles: true }))

    // Check an event
    const eventCheckbox = document.querySelector('[data-webhook-event="record.created"]') as HTMLInputElement
    eventCheckbox.click()
    await flushPromises()

    // Submit
    const saveBtn = document.querySelector('[data-webhook-save]') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const createCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0].includes('/webhooks'),
    )
    expect(createCalls.length).toBe(1)
  })

  async function openWebhookCreateForm() {
    const webhookTab = document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement
    webhookTab.click()
    await flushPromises()
    const newBtn = document.querySelector('[data-webhook-new]') as HTMLButtonElement
    newBtn.click()
    await flushPromises()

    const nameInput = document.querySelector('[data-webhook-name]') as HTMLInputElement
    nameInput.value = 'Policy hook'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    const urlInput = document.querySelector('[data-webhook-url]') as HTMLInputElement
    urlInput.value = 'https://example.com/hook'
    urlInput.dispatchEvent(new Event('input', { bubbles: true }))
    const eventCheckbox = document.querySelector('[data-webhook-event="record.created"]') as HTMLInputElement
    eventCheckbox.click()
    await flushPromises()
  }

  function setNumberField(selector: string, value: string) {
    const input = document.querySelector(selector) as HTMLInputElement
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('rejects an out-of-bounds maxRetries (save disabled + error shown)', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, client })
    await flushPromises()
    await openWebhookCreateForm()

    setNumberField('[data-webhook-max-retries]', '11') // > 10
    await flushPromises()

    expect(document.querySelector('[data-webhook-max-retries-error]')).toBeTruthy()
    const saveBtn = document.querySelector('[data-webhook-save]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)

    saveBtn.click()
    await flushPromises()
    const createCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0].includes('/webhooks'),
    )
    expect(createCalls.length).toBe(0)
  })

  it('rejects a below-min base delay', async () => {
    const { client } = mockClient()
    mount({ visible: true, client })
    await flushPromises()
    await openWebhookCreateForm()

    setNumberField('[data-webhook-base-delay]', '50') // < 100
    await flushPromises()

    expect(document.querySelector('[data-webhook-base-delay-error]')).toBeTruthy()
    expect((document.querySelector('[data-webhook-save]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends in-bounds retry policy in the create payload', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, client })
    await flushPromises()
    await openWebhookCreateForm()

    setNumberField('[data-webhook-max-retries]', '5')
    setNumberField('[data-webhook-base-delay]', '2000')
    setNumberField('[data-webhook-max-delay]', '30000')
    await flushPromises()

    expect(document.querySelector('[data-webhook-max-retries-error]')).toBeFalsy()
    const saveBtn = document.querySelector('[data-webhook-save]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    const createCall = fetchFn.mock.calls.find(
      (c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0].includes('/webhooks'),
    )
    expect(createCall).toBeTruthy()
    const body = JSON.parse(createCall![1]!.body as string)
    expect(body.maxRetries).toBe(5)
    expect(body.retryBaseDelayMs).toBe(2000)
    expect(body.retryMaxDelayMs).toBe(30000)
  })

  it('omits retry policy fields when blank (backend default)', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, client })
    await flushPromises()
    await openWebhookCreateForm()

    const saveBtn = document.querySelector('[data-webhook-save]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    const createCall = fetchFn.mock.calls.find(
      (c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0].includes('/webhooks'),
    )
    const body = JSON.parse(createCall![1]!.body as string)
    expect(body.maxRetries).toBeUndefined()
    expect(body.retryBaseDelayMs).toBeUndefined()
    expect(body.retryMaxDelayMs).toBeUndefined()
  })

  it('prefills retry policy when editing an existing webhook', async () => {
    const { client } = mockClient([], [fakeWebhook({ maxRetries: 7, retryBaseDelayMs: 3000 })])
    mount({ visible: true, client })
    await flushPromises()

    const webhookTab = document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement
    webhookTab.click()
    await flushPromises()
    const editBtn = document.querySelector('[data-webhook-edit]') as HTMLButtonElement
    editBtn.click()
    await flushPromises()

    expect((document.querySelector('[data-webhook-max-retries]') as HTMLInputElement).value).toBe('7')
    expect((document.querySelector('[data-webhook-base-delay]') as HTMLInputElement).value).toBe('3000')
  })

  it('deletes a webhook', async () => {
    const { client, fetchFn } = mockClient([], [fakeWebhook()])
    mount({ visible: true, client })
    await flushPromises()

    // Switch to webhooks tab
    const webhookTab = document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement
    webhookTab.click()
    await flushPromises()

    const deleteBtn = document.querySelector('[data-webhook-delete]') as HTMLButtonElement
    deleteBtn.click()
    await flushPromises()

    const deleteCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'DELETE' && c[0].includes('/webhooks/'),
    )
    expect(deleteCalls.length).toBe(1)
  })

  it('views webhook deliveries', async () => {
    const { client } = mockClient([], [fakeWebhook()], [fakeDelivery()])
    mount({ visible: true, client })
    await flushPromises()

    // Switch to webhooks tab
    const webhookTab = document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement
    webhookTab.click()
    await flushPromises()

    const deliveriesBtn = document.querySelector('[data-webhook-deliveries]') as HTMLButtonElement
    deliveriesBtn.click()
    await flushPromises()

    const deliveryRows = document.querySelectorAll('[data-delivery-id]')
    expect(deliveryRows.length).toBe(1)
  })

  // ---- DingTalk group tests ----

  it('switches to DingTalk groups tab', async () => {
    const { client, fetchFn } = mockClient([], [], [], [
      fakeDingTalkGroup(),
      fakeDingTalkGroup({ id: 'dt_2', name: 'QA DingTalk Group' }),
    ])
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const cards = document.querySelectorAll('[data-dingtalk-group-id]')
    expect(cards.length).toBe(2)
    const scopeNote = document.querySelector('[data-dingtalk-groups-scope-note]') as HTMLElement
    expect(scopeNote?.textContent).toContain('bound to this table')
    expect(scopeNote?.textContent).toContain('add multiple groups')
    expect(scopeNote?.textContent).toContain('choose one or more in automations')
    expect(scopeNote?.textContent).toContain('does not import DingTalk group members')
    expect(scopeNote?.textContent).toContain('control form access')
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/api/multitable/dingtalk-groups?sheetId=sheet_1'))).toBe(true)
  })

  // 客户反馈 2026-10-21 (c): the automation editor opens this dialog directly on DingTalk Groups, on top of its drawer.
  it('opens directly on the DingTalk Groups tab when asked, above the drawer that opened it', async () => {
    const { client } = mockClient([], [], [], [fakeDingTalkGroup()])
    mount({ visible: true, sheetId: 'sheet_1', client, initialTab: 'dingtalk-groups' })
    await flushPromises()

    const selected = document.querySelector('[role="tab"][aria-selected="true"]')
    expect(selected?.textContent?.trim()).toBe('DingTalk Groups')
    expect(document.querySelectorAll('[data-dingtalk-group-id]').length).toBe(1)
    const overlay = document.querySelector('.meta-api-mgr__overlay') as HTMLElement
    // element-plus drawers start at z-index 2000; a fixed 1000 would sit behind the rule editor.
    expect(Number(overlay.style.zIndex)).toBeGreaterThanOrEqual(2000)
  })

  it('ignores an initial DingTalk Groups tab the actor cannot see', async () => {
    const { client } = mockClient([], [], [], [fakeDingTalkGroup()])
    mount({ visible: true, sheetId: 'sheet_1', client, canManageAutomation: false, initialTab: 'dingtalk-groups' })
    await flushPromises()
    const selected = document.querySelector('[role="tab"][aria-selected="true"]')
    expect(selected?.textContent?.trim()).toBe('API Tokens')
  })

  it('hides DingTalk group management without automation permission', async () => {
    const { client, fetchFn } = mockClient([], [], [], [fakeDingTalkGroup()])
    mount({ visible: true, client, canManageAutomation: false })
    await flushPromises()

    const title = document.querySelector('.meta-api-mgr__title')
    expect(title?.textContent).toBe('API Tokens & Webhooks')
    const tabLabels = Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim())
    expect(tabLabels).toEqual(['API Tokens', 'Webhooks'])
    expect(document.querySelector('[data-dingtalk-groups-permission-note]')?.textContent).toContain('DingTalk group bindings require automation management permission')
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/dingtalk-groups'))).toBe(false)
  })

  it('localizes API token, webhook, and DingTalk group chrome while preserving raw enum data', async () => {
    useLocale().setLocale('zh-CN')
    const { client } = mockClient(
      [fakeToken({ scopes: ['read', 'admin'] })],
      [fakeWebhook({ events: ['record.created', 'field.changed'] })],
      [fakeDelivery({ event: 'field.changed', attemptCount: 2 })],
      [fakeDingTalkGroup({ hasSecret: true })],
      [fakeDingTalkDelivery({ sourceType: 'manual_test' })],
    )
    mount({ visible: true, client })
    await flushPromises()

    expect(document.querySelector('.meta-api-mgr__title')?.textContent).toBe('API 令牌、Webhook 与钉钉群')
    const tabLabels = Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim())
    expect(tabLabels).toEqual(['API 令牌', 'Webhook', '钉钉群'])
    expect(document.body.textContent).toContain('Test token')
    expect(document.body.textContent).toContain('mst_abc...')
    expect(document.body.textContent).toContain('权限范围: 读取, 管理')

    const newTokenBtn = document.querySelector('[data-token-new]') as HTMLButtonElement
    newTokenBtn.click()
    await flushPromises()
    expect(document.querySelector('[data-token-scope="records:read"]')).toBeTruthy()
    expect(document.querySelector('[data-token-form]')?.textContent).toContain('权限范围')

    const webhookTab = document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement
    webhookTab.click()
    await flushPromises()
    const webhookCard = document.querySelector('[data-webhook-id="wh_1"]') as HTMLElement
    expect(webhookCard.textContent).toContain('Test webhook')
    expect(webhookCard.textContent).toContain('事件: 记录已创建, 字段已变更')
    expect(webhookCard.querySelector('[data-webhook-status="active"]')?.textContent).toContain('有效')
    const newWebhookBtn = document.querySelector('[data-webhook-new]') as HTMLButtonElement
    newWebhookBtn.click()
    await flushPromises()
    expect(document.querySelector('[data-webhook-event="record.created"]')).toBeTruthy()
    expect(document.querySelector('[data-webhook-form]')?.textContent).toContain('记录已创建')
    document.querySelector('[data-webhook-deliveries]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-deliveries]')?.textContent).toContain('最近投递')
    expect(document.querySelector('[data-deliveries]')?.textContent).toContain('字段已变更')
    expect(document.querySelector('[data-deliveries]')?.textContent).toContain('尝试次数: 2')

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()
    const dingTalkCard = document.querySelector('[data-dingtalk-group-id="dt_1"]') as HTMLElement
    expect(document.querySelector('[data-dingtalk-groups-scope-note]')?.textContent).toContain('数据表级钉钉群')
    expect(dingTalkCard.textContent).toContain('Ops DingTalk Group')
    expect(dingTalkCard.textContent).toContain('Webhook: https://oapi.dingtalk.com/robot/send?access_token=***')
    expect(dingTalkCard.textContent).toContain('密钥: 已配置')
    expect(dingTalkCard.textContent).toContain('共享到数据表: sheet_1')
    expect(dingTalkCard.querySelector('[data-dingtalk-group-status="enabled"]')?.textContent).toContain('已启用')
    const dingTalkDeliveriesBtn = dingTalkCard.querySelector('[data-dingtalk-group-deliveries]') as HTMLButtonElement
    dingTalkDeliveriesBtn.click()
    await flushPromises()
    expect(document.querySelector('[data-dingtalk-deliveries]')?.textContent).toContain('最近投递')
    expect(document.querySelector('[data-dingtalk-deliveries]')?.textContent).toContain('手动测试')
    expect(document.querySelector('[data-dingtalk-deliveries]')?.textContent).toContain('Please fill incident details')
  })

  it('shows readable permission errors when DingTalk group loading is forbidden', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/tokens') && !url.includes('/rotate')) {
        return okResponse({ tokens: [] })
      }
      if (method === 'GET' && url.includes('/webhooks') && !url.includes('/deliveries')) {
        return okResponse({ webhooks: [] })
      }
      if (method === 'GET' && url.includes('/dingtalk-groups')) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return okResponse({})
    })
    mount({ visible: true, client: new MultitableApiClient({ fetchFn }) })
    await flushPromises()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Insufficient permissions')
  })

  it('masks DingTalk webhook access token in card display', async () => {
    const { client } = mockClient([], [], [], [fakeDingTalkGroup({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=super-secret-token',
    })])
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const card = document.querySelector('[data-dingtalk-group-id]') as HTMLElement
    const text = card.textContent ?? ''
    expect(text).toContain('access_token=***')
    expect(text).not.toContain('super-secret-token')
  })

  it('creates a DingTalk group destination', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    expect(document.querySelector('[data-dingtalk-groups-empty]')?.textContent).toContain('Add a group robot webhook')

    const newBtn = document.querySelector('[data-dingtalk-group-new]') as HTMLButtonElement
    newBtn.click()
    await flushPromises()

    const webhookHelp = document.querySelector('[data-dingtalk-group-webhook-help]') as HTMLElement
    expect(webhookHelp?.textContent).toContain('DingTalk group robot settings')
    expect(webhookHelp?.textContent).toContain("appears in this table's automation rule editor")
    expect(webhookHelp?.textContent).toContain('masked in this UI')
    const secretHelp = document.querySelector('[data-dingtalk-group-secret-help]') as HTMLElement
    expect(secretHelp?.textContent).toContain('signature security')
    expect(secretHelp?.textContent).toContain('without a SEC secret')

    const nameInput = document.querySelector('[data-dingtalk-group-name]') as HTMLInputElement
    nameInput.value = 'Support group'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const urlInput = document.querySelector('[data-dingtalk-group-webhook-url]') as HTMLInputElement
    urlInput.value = 'https://oapi.dingtalk.com/robot/send?access_token=test-token'
    urlInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const saveBtn = document.querySelector('[data-dingtalk-group-save]') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const createCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0].includes('/dingtalk-groups') && !c[0].includes('/test-send'),
    )
    expect(createCalls.length).toBe(1)
    expect(JSON.parse(createCalls[0][1]?.body as string)).toMatchObject({
      name: 'Support group',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
      sheetId: 'sheet_1',
    })
  })

  it('disables DingTalk group save for invalid robot webhook settings', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const newBtn = document.querySelector('[data-dingtalk-group-new]') as HTMLButtonElement
    newBtn.click()
    await flushPromises()

    const nameInput = document.querySelector('[data-dingtalk-group-name]') as HTMLInputElement
    nameInput.value = 'Support group'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))

    const urlInput = document.querySelector('[data-dingtalk-group-webhook-url]') as HTMLInputElement
    urlInput.value = 'https://example.com/hook'
    urlInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const saveBtn = document.querySelector('[data-dingtalk-group-save]') as HTMLButtonElement
    expect(document.querySelector('[data-dingtalk-group-webhook-error]')?.textContent).toContain('https://oapi.dingtalk.com/robot/send')
    expect(saveBtn.disabled).toBe(true)

    urlInput.value = 'https://oapi.dingtalk.com/robot/send?access_token=test-token'
    urlInput.dispatchEvent(new Event('input', { bubbles: true }))

    const secretInput = document.querySelector('[data-dingtalk-group-secret]') as HTMLInputElement
    secretInput.value = 'bad-secret'
    secretInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    expect(document.querySelector('[data-dingtalk-group-secret-error]')?.textContent).toContain('must start with SEC')
    expect(saveBtn.disabled).toBe(true)
    expect(fetchFn.mock.calls.some((c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0].includes('/dingtalk-groups'))).toBe(false)
  })

  it('omits unchanged legacy DingTalk webhook settings when editing metadata', async () => {
    const legacyGroup = fakeDingTalkGroup({
      webhookUrl: 'https://example.com/legacy-hook',
      hasSecret: true,
    })
    const { client, fetchFn } = mockClient([], [], [], [legacyGroup])
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const editBtn = document.querySelector('[data-dingtalk-group-edit]') as HTMLButtonElement
    editBtn.click()
    await flushPromises()

    const nameInput = document.querySelector('[data-dingtalk-group-name]') as HTMLInputElement
    nameInput.value = 'Legacy group renamed'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const saveBtn = document.querySelector('[data-dingtalk-group-save]') as HTMLButtonElement
    expect(document.querySelector('[data-dingtalk-group-webhook-error]')).toBeNull()
    expect(document.querySelector('[data-dingtalk-group-secret-error]')).toBeNull()
    expect(saveBtn.disabled).toBe(false)

    saveBtn.click()
    await flushPromises()

    const updateCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'PATCH' && c[0].includes('/dingtalk-groups/'),
    )
    expect(updateCalls.length).toBe(1)
    expect(JSON.parse(updateCalls[0][1]?.body as string)).toEqual({
      name: 'Legacy group renamed',
      enabled: true,
    })
  })

  it('does not prefill saved DingTalk group secret and can clear it explicitly', async () => {
    const signedGroup = fakeDingTalkGroup({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=***',
      hasSecret: true,
    })
    const { client, fetchFn } = mockClient([], [], [], [signedGroup])
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const editBtn = document.querySelector('[data-dingtalk-group-edit]') as HTMLButtonElement
    editBtn.click()
    await flushPromises()

    const secretInput = document.querySelector('[data-dingtalk-group-secret]') as HTMLInputElement
    expect(secretInput.value).toBe('')
    expect(document.querySelector('[data-dingtalk-group-secret-help]')?.textContent).toContain('already saved')

    const clearSecret = document.querySelector('[data-dingtalk-group-clear-secret]') as HTMLInputElement
    expect(clearSecret).toBeTruthy()
    clearSecret.checked = true
    clearSecret.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()

    const saveBtn = document.querySelector('[data-dingtalk-group-save]') as HTMLButtonElement
    saveBtn.click()
    await flushPromises()

    const updateCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'PATCH' && c[0].includes('/dingtalk-groups/'),
    )
    expect(updateCalls.length).toBe(1)
    expect(JSON.parse(updateCalls[0][1]?.body as string)).toEqual({
      name: 'Ops DingTalk Group',
      enabled: true,
      secret: '',
    })
  })

  it('tests a DingTalk group destination', async () => {
    const { client, fetchFn } = mockClient([], [], [], [fakeDingTalkGroup()])
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const testSendBtn = document.querySelector('[data-dingtalk-group-test-send]') as HTMLButtonElement
    testSendBtn.click()
    await flushPromises()

    const testSendCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0].includes('/dingtalk-groups/') && c[0].includes('/test-send'),
    )
    expect(testSendCalls.length).toBe(1)
    expect(testSendCalls[0][0]).toContain('sheetId=sheet_1')
  })

  it('views DingTalk group deliveries', async () => {
    const { client, fetchFn } = mockClient([], [], [], [fakeDingTalkGroup()], [fakeDingTalkDelivery()])
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const deliveriesBtn = document.querySelector('[data-dingtalk-group-deliveries]') as HTMLButtonElement
    deliveriesBtn.click()
    await flushPromises()

    const rows = document.querySelectorAll('[data-dingtalk-delivery-id]')
    expect(rows.length).toBe(1)
    expect(rows[0]?.textContent).toContain('Please fill incident details')
    expect(rows[0]?.textContent).toContain('Automation')
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/api/multitable/dingtalk-groups/dt_1/deliveries?sheetId=sheet_1'))).toBe(true)
  })

  it('shows organization catalog DingTalk groups as read-only and loads deliveries without sheet scope', async () => {
    const { client, fetchFn } = mockClient([], [], [], [
      fakeDingTalkGroup({ scope: 'org', sheetId: undefined, orgId: 'org_1' }),
    ], [fakeDingTalkDelivery()])
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const card = document.querySelector('[data-dingtalk-group-id="dt_1"]') as HTMLElement
    expect(card?.textContent).toContain('Organization catalog group: org_1')
    expect(card?.querySelector('[data-dingtalk-group-readonly]')?.textContent).toContain('Managed by organization admins')
    expect(card?.querySelector('[data-dingtalk-group-edit]')).toBeNull()
    expect(card?.querySelector('[data-dingtalk-group-toggle]')).toBeNull()
    expect(card?.querySelector('[data-dingtalk-group-test-send]')).toBeNull()
    expect(card?.querySelector('[data-dingtalk-group-delete]')).toBeNull()

    const deliveriesBtn = card.querySelector('[data-dingtalk-group-deliveries]') as HTMLButtonElement
    deliveriesBtn.click()
    await flushPromises()

    expect(fetchFn.mock.calls.some(([url]) => String(url) === '/api/multitable/dingtalk-groups/dt_1/deliveries')).toBe(true)
  })

  it('refreshes open DingTalk delivery history after test send', async () => {
    const { client } = mockClient([], [], [], [fakeDingTalkGroup()], [fakeDingTalkDelivery()])
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const deliveriesBtn = document.querySelector('[data-dingtalk-group-deliveries]') as HTMLButtonElement
    deliveriesBtn.click()
    await flushPromises()

    let rows = document.querySelectorAll('[data-dingtalk-delivery-id]')
    expect(rows.length).toBe(1)

    const testSendBtn = document.querySelector('[data-dingtalk-group-test-send]') as HTMLButtonElement
    testSendBtn.click()
    await flushPromises()

    rows = document.querySelectorAll('[data-dingtalk-delivery-id]')
    expect(rows.length).toBe(2)
    expect(rows[0]?.textContent).toContain('Manual test')
    expect(rows[0]?.textContent).toContain('MetaSheet DingTalk group test')
  })

  it('shows an empty state for DingTalk delivery history', async () => {
    const { client } = mockClient([], [], [], [fakeDingTalkGroup()], [])
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const deliveriesBtn = document.querySelector('[data-dingtalk-group-deliveries]') as HTMLButtonElement
    deliveriesBtn.click()
    await flushPromises()

    expect(document.querySelector('[data-dingtalk-deliveries-empty]')?.textContent).toContain('No DingTalk deliveries yet.')
  })

  it('ignores stale DingTalk delivery responses when switching groups', async () => {
    const groupA = fakeDingTalkGroup({ id: 'dt_a', name: 'Group A' })
    const groupB = fakeDingTalkGroup({ id: 'dt_b', name: 'Group B' })
    const groupARequest = deferred<Response>()
    const groupBRequest = deferred<Response>()

    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/dingtalk-groups') && !url.includes('/deliveries') && !url.includes('/test-send')) {
        return okResponse({ destinations: [groupA, groupB] })
      }
      if (method === 'GET' && url.includes('/dingtalk-groups/dt_a/deliveries')) {
        return groupARequest.promise
      }
      if (method === 'GET' && url.includes('/dingtalk-groups/dt_b/deliveries')) {
        return groupBRequest.promise
      }
      return okResponse({})
    })

    mount({ visible: true, client: new MultitableApiClient({ fetchFn }) })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const deliveriesButtons = document.querySelectorAll('[data-dingtalk-group-deliveries]')
    ;(deliveriesButtons[0] as HTMLButtonElement).click()
    await flushPromises()
    ;(deliveriesButtons[1] as HTMLButtonElement).click()
    await flushPromises()

    groupBRequest.resolve(okResponse({
      deliveries: [fakeDingTalkDelivery({ id: 'dtd_b', destinationId: 'dt_b', subject: 'Group B delivery' })],
    }))
    await flushPromises()

    expect(document.querySelector('[data-dingtalk-deliveries]')?.textContent).toContain('Group B delivery')

    groupARequest.resolve(okResponse({
      deliveries: [fakeDingTalkDelivery({ id: 'dtd_a', destinationId: 'dt_a', subject: 'Group A delivery' })],
    }))
    await flushPromises()

    const panelText = document.querySelector('[data-dingtalk-deliveries]')?.textContent ?? ''
    expect(panelText).toContain('Group B delivery')
    expect(panelText).not.toContain('Group A delivery')
  })
})

describe('MetaApiTokenManager webhooks bound to the current sheet (W1–W9)', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function openWebhooksTab() {
    const tab = document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement
    tab.click()
    await flushPromises()
  }

  function calls(fetchFn: ReturnType<typeof mockClient>['fetchFn'], method: string) {
    return fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => (c[1]?.method ?? 'GET') === method && String(c[0]).includes('/webhooks'),
    )
  }

  function bodyOf(call: [string, RequestInit?]) {
    return JSON.parse(String(call[1]?.body ?? '{}')) as Record<string, unknown>
  }

  async function fillCreateForm() {
    ;(document.querySelector('[data-webhook-new]') as HTMLButtonElement).click()
    await flushPromises()
    const name = document.querySelector('[data-webhook-name]') as HTMLInputElement
    name.value = 'Bound hook'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    const url = document.querySelector('[data-webhook-url]') as HTMLInputElement
    url.value = 'https://example.com/bound'
    url.dispatchEvent(new Event('input', { bubbles: true }))
    ;(document.querySelector('[data-webhook-event="record.created"]') as HTMLInputElement).click()
    await flushPromises()
  }

  it('W1 create sends the current sheet; New is disabled without a current sheet or without permission', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, client })
    await flushPromises()
    await openWebhooksTab()
    await fillCreateForm()
    ;(document.querySelector('[data-webhook-save]') as HTMLButtonElement).click()
    await flushPromises()
    const posts = calls(fetchFn, 'POST')
    expect(posts.length, 'W1.posts').toBe(1)
    expect(bodyOf(posts[0]).sheetId, 'W1.body.sheetId').toBe('sheet_1')
    document.body.innerHTML = ''

    mount({ visible: true, client: mockClient().client, sheetId: undefined })
    await flushPromises()
    await openWebhooksTab()
    expect((document.querySelector('[data-webhook-new]') as HTMLButtonElement).disabled, 'W1.noSheet.disabled').toBe(true)
    document.body.innerHTML = ''

    mount({ visible: true, client: mockClient().client, canManageAutomation: false })
    await flushPromises()
    await openWebhooksTab()
    expect((document.querySelector('[data-webhook-new]') as HTMLButtonElement).disabled, 'W1.noPermission.disabled').toBe(true)
  })

  it('W2 each row shows its bound sheet; an unbound row shows the bind action', async () => {
    const { client } = mockClient([], [
      fakeWebhook({ id: 'wh_here', sheetId: 'sheet_1' }),
      fakeWebhook({ id: 'wh_there', sheetId: 'sheet_other' }),
      fakeWebhook({ id: 'wh_none', sheetId: null }),
    ])
    mount({ visible: true, client })
    await flushPromises()
    await openWebhooksTab()
    const here = document.querySelector('[data-webhook-id="wh_here"]') as HTMLElement
    const there = document.querySelector('[data-webhook-id="wh_there"]') as HTMLElement
    const none = document.querySelector('[data-webhook-id="wh_none"]') as HTMLElement
    expect(here.querySelector('[data-webhook-sheet]')?.textContent, 'W2.here').toContain('This sheet')
    expect(there.querySelector('[data-webhook-sheet]')?.textContent, 'W2.there').toContain('sheet_other')
    expect(none.querySelector('[data-webhook-sheet]')?.textContent, 'W2.none').toContain('Not bound to a sheet')
    expect(none.querySelector('[data-webhook-bind]'), 'W2.bindAction').toBeTruthy()
    expect(here.querySelector('[data-webhook-bind]'), 'W2.noBindWhenBound').toBeNull()
  })

  it('W3 bind sends a PATCH with only the current sheet', async () => {
    const { client, fetchFn } = mockClient([], [fakeWebhook({ id: 'wh_none', sheetId: null, active: false })])
    mount({ visible: true, client })
    await flushPromises()
    await openWebhooksTab()
    ;(document.querySelector('[data-webhook-bind]') as HTMLButtonElement).click()
    await flushPromises()
    const patches = calls(fetchFn, 'PATCH')
    expect(patches.length, 'W3.patches').toBe(1)
    expect(bodyOf(patches[0]), 'W3.body').toEqual({ sheetId: 'sheet_1' })
  })

  it('W4 without permission the tab and list stay visible; New, bind and enable are disabled', async () => {
    const { client } = mockClient([], [
      fakeWebhook({ id: 'wh_off', sheetId: 'sheet_1', active: false }),
      fakeWebhook({ id: 'wh_none', sheetId: null, active: false }),
    ])
    mount({ visible: true, client, canManageAutomation: false })
    await flushPromises()
    await openWebhooksTab()
    expect(document.querySelectorAll('[data-webhook-id]').length, 'W4.listVisible').toBe(2)
    expect((document.querySelector('[data-webhook-new]') as HTMLButtonElement).disabled, 'W4.newDisabled').toBe(true)
    const off = document.querySelector('[data-webhook-id="wh_off"]') as HTMLElement
    expect((off.querySelector('[data-webhook-toggle]') as HTMLButtonElement).disabled, 'W4.enableDisabled').toBe(true)
    const none = document.querySelector('[data-webhook-id="wh_none"]') as HTMLElement
    expect((none.querySelector('[data-webhook-bind]') as HTMLButtonElement).disabled, 'W4.bindDisabled').toBe(true)
  })

  it('W5 editing only the name sends only the name (no url, no events)', async () => {
    const { client, fetchFn } = mockClient([], [fakeWebhook({ events: ['record.created', 'record.updated'] })])
    mount({ visible: true, client })
    await flushPromises()
    await openWebhooksTab()
    ;(document.querySelector('[data-webhook-edit]') as HTMLButtonElement).click()
    await flushPromises()
    const name = document.querySelector('[data-webhook-name]') as HTMLInputElement
    name.value = 'Renamed'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    ;(document.querySelector('[data-webhook-save]') as HTMLButtonElement).click()
    await flushPromises()
    const patches = calls(fetchFn, 'PATCH')
    expect(patches.length, 'W5.patches').toBe(1)
    expect(bodyOf(patches[0]), 'W5.patch.keys').toEqual({ name: 'Renamed' })
  })

  it('W6 enabling an unbound row points to binding (no PATCH); a row bound elsewhere cannot be enabled here', async () => {
    const { client, fetchFn } = mockClient([], [
      fakeWebhook({ id: 'wh_none', sheetId: null, active: false }),
      fakeWebhook({ id: 'wh_there', sheetId: 'sheet_other', active: false }),
    ])
    mount({ visible: true, client })
    await flushPromises()
    await openWebhooksTab()
    const none = document.querySelector('[data-webhook-id="wh_none"]') as HTMLElement
    ;(none.querySelector('[data-webhook-toggle]') as HTMLButtonElement).click()
    await flushPromises()
    expect(calls(fetchFn, 'PATCH').length, 'W6.noPatch').toBe(0)
    expect(document.querySelector('[data-webhook-id="wh_none"] [data-webhook-bind-hint]'), 'W6.bindHint').toBeTruthy()
    const there = document.querySelector('[data-webhook-id="wh_there"]') as HTMLElement
    expect((there.querySelector('[data-webhook-toggle]') as HTMLButtonElement).disabled, 'W6.elsewhereDisabled').toBe(true)
    expect(there.querySelector('[data-webhook-enable-hint]'), 'W6.elsewhereHint').toBeTruthy()
  })

  it('W7 without any permission the owner can still turn off and delete their webhook', async () => {
    const { client, fetchFn } = mockClient([], [fakeWebhook({ id: 'wh_on', sheetId: 'sheet_other', active: true })])
    mount({ visible: true, client, canManageAutomation: false, sheetId: undefined })
    await flushPromises()
    await openWebhooksTab()
    const toggle = document.querySelector('[data-webhook-toggle]') as HTMLButtonElement | null
    expect(toggle, 'W7.toggleVisible').toBeTruthy()
    expect(toggle!.disabled, 'W7.toggleEnabled').toBe(false)
    toggle.click()
    await flushPromises()
    const patches = calls(fetchFn, 'PATCH')
    expect(patches.length, 'W7.patches').toBe(1)
    expect(bodyOf(patches[0]), 'W7.patch.body').toEqual({ active: false })
    const del = document.querySelector('[data-webhook-delete]') as HTMLButtonElement
    expect(del.disabled, 'W7.deleteEnabled').toBe(false)
    del.click()
    await flushPromises()
    expect(calls(fetchFn, 'DELETE').length, 'W7.deletes').toBe(1)
  })

  it('W8 event options are only the event types the server accepts', async () => {
    const { client } = mockClient()
    mount({ visible: true, client })
    await flushPromises()
    await openWebhooksTab()
    ;(document.querySelector('[data-webhook-new]') as HTMLButtonElement).click()
    await flushPromises()
    const options = Array.from(document.querySelectorAll('[data-webhook-event]')).map((el) => el.getAttribute('data-webhook-event'))
    expect(options, 'W8.options').toEqual(['record.created', 'record.updated', 'record.deleted'])
  })

  it('W9 delivery history shows status (three states), attempts and time from the status fields', async () => {
    const { client } = mockClient([], [fakeWebhook()], [
      fakeDelivery({ id: 'd_ok', status: 'success', attemptCount: 1, createdAt: '2026-04-02T00:00:00Z' }),
      fakeDelivery({ id: 'd_fail', status: 'failed', attemptCount: 3, createdAt: '2026-04-03T00:00:00Z' }),
      fakeDelivery({ id: 'd_wait', status: 'pending', attemptCount: 2, createdAt: '2026-04-04T00:00:00Z' }),
    ])
    mount({ visible: true, client })
    await flushPromises()
    await openWebhooksTab()
    ;(document.querySelector('[data-webhook-deliveries]') as HTMLButtonElement).click()
    await flushPromises()
    const row = (id: string) => document.querySelector(`[data-delivery-id="${id}"]`) as HTMLElement
    expect(row('d_ok').querySelector('[data-delivery-status]')?.textContent?.trim(), 'W9.ok').toBe('OK')
    expect(row('d_fail').querySelector('[data-delivery-status]')?.textContent?.trim(), 'W9.fail').toBe('FAIL')
    expect(row('d_wait').querySelector('[data-delivery-status]')?.textContent?.trim(), 'W9.pending').toBe('PENDING')
    expect(row('d_fail').querySelector('[data-delivery-attempts]')?.textContent, 'W9.attempts').toContain('Attempts: 3')
    expect(row('d_wait').querySelector('[data-delivery-time]')?.textContent, 'W9.time').toContain('2026-04-04')
  })
})
