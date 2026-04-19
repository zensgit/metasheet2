import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

import MetaApiTokenManager from '../src/multitable/components/MetaApiTokenManager.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
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
    httpStatus: 200,
    success: true,
    retryCount: 0,
    timestamp: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

function fakeDingTalkGroup(overrides: Partial<DingTalkGroupDestination> = {}): DingTalkGroupDestination {
  return {
    id: 'dt_1',
    name: 'Ops DingTalk Group',
    webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test-token',
    enabled: true,
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
  const app = createApp({ render: () => h(MetaApiTokenManager, props) })
  app.mount(container)
  return { container, app }
}

describe('MetaApiTokenManager', () => {
  afterEach(() => {
    document.body.innerHTML = ''
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
    const { client } = mockClient([], [], [], [fakeDingTalkGroup()])
    mount({ visible: true, client })
    await flushPromises()

    const dingTalkTab = document.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement
    dingTalkTab.click()
    await flushPromises()

    const cards = document.querySelectorAll('[data-dingtalk-group-id]')
    expect(cards.length).toBe(1)
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

    const newBtn = document.querySelector('[data-dingtalk-group-new]') as HTMLButtonElement
    newBtn.click()
    await flushPromises()

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
  })

  it('views DingTalk group deliveries', async () => {
    const { client } = mockClient([], [], [], [fakeDingTalkGroup()], [fakeDingTalkDelivery()])
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
