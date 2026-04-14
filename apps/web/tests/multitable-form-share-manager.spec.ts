import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

import MetaFormShareManager from '../src/multitable/components/MetaFormShareManager.vue'
import { MultitableApiClient } from '../src/multitable/api/client'

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    publicToken: 'tok_abc123',
    expiresAt: null,
    status: 'active',
    ...overrides,
  }
}

function mockClient(config = fakeConfig()) {
  const ok = (body: unknown) =>
    new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/form-share')) {
      return ok(config)
    }
    if (method === 'PATCH' && url.includes('/form-share')) {
      const body = JSON.parse(init?.body as string)
      return ok({ ...config, ...body })
    }
    if (method === 'POST' && url.includes('/regenerate')) {
      return ok({ publicToken: 'tok_new456' })
    }
    return ok({})
  })
  return { client: new MultitableApiClient({ fetchFn }), fetchFn }
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaFormShareManager, props) })
  app.mount(container)
  return { container, app }
}

describe('MetaFormShareManager', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders share config when visible', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const toggle = document.querySelector('[data-form-share-toggle]') as HTMLInputElement
    expect(toggle).toBeTruthy()
    expect(toggle.checked).toBe(true)
  })

  it('shows public link when enabled', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const linkInput = document.querySelector('[data-form-share-link]') as HTMLInputElement
    expect(linkInput).toBeTruthy()
    expect(linkInput.value).toContain('tok_abc123')
    expect(linkInput.value).toContain('/multitable/public-form/sh_1/v_1')
  })

  it('hides link section when disabled', async () => {
    const { client } = mockClient(fakeConfig({ enabled: false, publicToken: null, status: 'disabled' }))
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const linkInput = document.querySelector('[data-form-share-link]')
    expect(linkInput).toBeNull()
  })

  it('shows copy button', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const copyBtn = document.querySelector('[data-form-share-copy]')
    expect(copyBtn).toBeTruthy()
    expect(copyBtn?.textContent?.trim()).toBe('Copy')
  })

  it('shows regenerate button', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const regenBtn = document.querySelector('[data-form-share-regenerate]')
    expect(regenBtn).toBeTruthy()
  })

  it('calls regenerate API on click', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const regenBtn = document.querySelector('[data-form-share-regenerate]') as HTMLButtonElement
    regenBtn.click()
    await flushPromises()

    const regenerateCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0].includes('/regenerate'),
    )
    expect(regenerateCalls.length).toBe(1)
  })

  it('shows expiry date picker', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const expiryInput = document.querySelector('[data-form-share-expiry]')
    expect(expiryInput).toBeTruthy()
  })

  it('shows status indicator', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const status = document.querySelector('[data-status="active"]')
    expect(status).toBeTruthy()
    expect(status?.textContent?.trim()).toBe('Active')
  })

  it('toggles enabled calls API', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const toggle = document.querySelector('[data-form-share-toggle]') as HTMLInputElement
    toggle.click()
    await flushPromises()

    const patchCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'PATCH' && c[0].includes('/form-share'),
    )
    expect(patchCalls.length).toBe(1)
    const body = JSON.parse(patchCalls[0][1].body as string)
    expect(body.enabled).toBe(false)
  })
})
