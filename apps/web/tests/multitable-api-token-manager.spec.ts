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
import type { ApiToken, Webhook, WebhookDelivery } from '../src/multitable/types'

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

function mockClient(tokens: ApiToken[] = [], webhooks: Webhook[] = [], deliveries: WebhookDelivery[] = []) {
  const ok = (body: unknown) =>
    new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const noContent = () => new Response(null, { status: 204 })

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'

    // Tokens
    if (method === 'GET' && url.includes('/tokens') && !url.includes('/rotate')) {
      return ok({ tokens })
    }
    if (method === 'POST' && url.includes('/tokens') && !url.includes('/rotate')) {
      const body = JSON.parse(init?.body as string)
      return ok({ token: { id: 'tok_new', prefix: 'mst_new', ...body, createdAt: '2026-04-01', lastUsedAt: null, expiresAt: null }, plaintext: 'mst_plaintext_secret_123' })
    }
    if (method === 'DELETE' && url.includes('/tokens/')) {
      return noContent()
    }
    if (method === 'POST' && url.includes('/rotate')) {
      return ok({ token: fakeToken({ id: 'tok_rotated', prefix: 'mst_rot' }), plaintext: 'mst_rotated_secret_456' })
    }

    // Webhooks
    if (method === 'GET' && url.includes('/webhooks') && !url.includes('/deliveries')) {
      return ok({ webhooks })
    }
    if (method === 'POST' && url.includes('/webhooks') && !url.includes('/deliveries')) {
      const body = JSON.parse(init?.body as string)
      return ok({ id: 'wh_new', active: true, secret: null, failureCount: 0, createdAt: '2026-04-01', updatedAt: '2026-04-01', ...body })
    }
    if (method === 'PATCH' && url.includes('/webhooks/')) {
      return ok(webhooks[0] ?? {})
    }
    if (method === 'DELETE' && url.includes('/webhooks/')) {
      return noContent()
    }
    if (method === 'GET' && url.includes('/deliveries')) {
      return ok({ deliveries })
    }

    return ok({})
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
})
