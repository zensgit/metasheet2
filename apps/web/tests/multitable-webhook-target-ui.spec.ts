/**
 * Webhook target hints in the two places a user types a webhook target (since R81 the server refuses any
 * target that is not a public https address):
 *   - 「API 与 Webhook」 subscription form (MetaApiTokenManager.vue)
 *   - 「发送 Webhook」 action in the automation rule editor (MetaAutomationRuleEditor.vue, via MetaAutomationManager.vue
 *     for the save-refusal path)
 * Each: the fixed help line renders, the live warning appears / disappears while typing and never blocks save,
 * and a server refusal at save reads as plain zh copy (no raw code, no URL).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

const routerPushMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}))

import MetaApiTokenManager from '../src/multitable/components/MetaApiTokenManager.vue'
import MetaAutomationManager from '../src/multitable/components/MetaAutomationManager.vue'
import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRule } from '../src/multitable/types'

const HELP_ZH = '只能填公网可访问的 https 地址'
const HELP_SEND_TIME_ZH = '发送时被拒绝'
const WARN_NOT_HTTPS_ZH = '只能使用 https:// 开头的地址'
const WARN_INTERNAL_IP_ZH = '这是内网或本机地址'
const WARN_INTERNAL_NAME_ZH = '这是内网域名'
const REFUSED_PREFIX_ZH = '未保存：'

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const mountedApps: Array<{ unmount: () => void }> = []

function mountComponent(component: unknown, props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(component as Parameters<typeof h>[0], props) })
  app.mount(container)
  mountedApps.push(app)
  return { container }
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  useLocale().setLocale('zh-CN')
  routerPushMock.mockClear()
})

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount()
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('「API 与 Webhook」 subscription URL', () => {
  function mockClient(createResponse: () => Response) {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && url.includes('/tokens')) return json(200, { data: { tokens: [] } })
      if (method === 'GET' && url.includes('/webhooks')) return json(200, { data: { webhooks: [] } })
      if (method === 'GET' && url.includes('/dingtalk-groups')) return json(200, { data: { destinations: [] } })
      if (method === 'POST' && url.includes('/webhooks')) return createResponse()
      return json(200, { data: {} })
    })
    return { client: new MultitableApiClient({ fetchFn }), fetchFn }
  }

  async function openNewWebhookForm(client: MultitableApiClient) {
    mountComponent(MetaApiTokenManager, { visible: true, client, sheetId: 'sheet_1' })
    await flushPromises()
    ;(document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click()
    await flushPromises()
    ;(document.querySelector('[data-webhook-new]') as HTMLButtonElement).click()
    await flushPromises()
  }

  const warning = () => document.querySelector('[data-webhook-url-warning]') as HTMLElement | null

  it('shows the fixed help line and a live warning that follows the typed URL', async () => {
    const { client } = mockClient(() => json(200, { data: {} }))
    await openNewWebhookForm(client)

    const help = document.querySelector('[data-webhook-url-help]') as HTMLElement
    expect(help?.textContent).toContain(HELP_ZH)
    expect(help?.textContent).toContain(HELP_SEND_TIME_ZH)
    expect(warning()).toBeNull()

    const urlInput = document.querySelector('[data-webhook-url]') as HTMLInputElement
    typeInto(urlInput, 'http://example.com/hook')
    await flushPromises()
    expect(warning()?.textContent).toContain(WARN_NOT_HTTPS_ZH)

    typeInto(urlInput, 'https://192.168.1.10/hook')
    await flushPromises()
    expect(warning()?.textContent).toContain(WARN_INTERNAL_IP_ZH)
    expect(warning()?.textContent).not.toContain('192.168.1.10')

    typeInto(urlInput, 'https://example.com/hook')
    await flushPromises()
    expect(warning()).toBeNull()

    typeInto(urlInput, '')
    await flushPromises()
    expect(warning()).toBeNull()
  })

  it('a server refusal at save reads as zh copy, without the raw code or the URL; the warning did not block the save', async () => {
    const { client, fetchFn } = mockClient(() => json(400, {
      ok: false,
      error: { code: 'WEBHOOK_TARGET_REJECTED', message: 'WEBHOOK_TARGET_REJECTED:private' },
    }))
    await openNewWebhookForm(client)

    typeInto(document.querySelector('[data-webhook-name]') as HTMLInputElement, 'Hook')
    typeInto(document.querySelector('[data-webhook-url]') as HTMLInputElement, 'https://10.0.0.5/hook')
    ;(document.querySelector('[data-webhook-event="record.created"]') as HTMLInputElement).click()
    await flushPromises()
    expect(warning()?.textContent).toContain(WARN_INTERNAL_IP_ZH)

    const saveBtn = document.querySelector('[data-webhook-save]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    const posts = fetchFn.mock.calls.filter((c) => c[1]?.method === 'POST' && String(c[0]).includes('/webhooks'))
    expect(posts).toHaveLength(1)
    const alert = document.querySelector('.meta-api-mgr__error[role="alert"]') as HTMLElement
    expect(alert?.textContent).toContain(REFUSED_PREFIX_ZH)
    expect(alert?.textContent).toContain(WARN_INTERNAL_IP_ZH)
    expect(alert?.textContent).not.toContain('WEBHOOK_TARGET_REJECTED')
    expect(alert?.textContent).not.toContain('10.0.0.5')
  })
})

describe('「发送 Webhook」 action URL in the rule editor', () => {
  function webhookRule(url: string): AutomationRule {
    return {
      id: 'rule_1',
      sheetId: 'sheet_1',
      name: 'Hook rule',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'send_webhook',
      actionConfig: { url, method: 'POST' },
      enabled: true,
      actions: [{ type: 'send_webhook', config: { url, method: 'POST' } }],
    }
  }

  const warning = () => document.querySelector('[data-field="webhookTargetWarning"]') as HTMLElement | null

  it('shows the fixed help line and a live warning that follows the typed URL, without blocking save', async () => {
    mountComponent(MetaAutomationRuleEditor, {
      visible: true,
      sheetId: 'sheet_1',
      fields: [{ id: 'fld_1', name: 'Status', type: 'string' }],
      rule: webhookRule('https://example.com/hook'),
    })
    await flushPromises()

    const help = document.querySelector('[data-field="webhookTargetHelp"]') as HTMLElement
    expect(help?.textContent).toContain(HELP_ZH)
    expect(help?.textContent).toContain(HELP_SEND_TIME_ZH)
    expect(warning()).toBeNull()

    const urlInput = document.querySelector('[data-field="webhookTargetUrl"]') as HTMLInputElement
    expect(urlInput).toBeTruthy()
    typeInto(urlInput, 'https://svc.internal/hook')
    await flushPromises()
    expect(warning()?.textContent).toContain(WARN_INTERNAL_NAME_ZH)
    expect((document.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(false)

    typeInto(urlInput, 'http://example.com/hook')
    await flushPromises()
    expect(warning()?.textContent).toContain(WARN_NOT_HTTPS_ZH)

    typeInto(urlInput, 'https://example.com/hook')
    await flushPromises()
    expect(warning()).toBeNull()
  })

  it('a server refusal at save (via the automation manager) shows zh copy inside the open editor, without the raw code or the URL', async () => {
    const rule = webhookRule('https://127.0.0.1/hook')
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'PATCH' && url.includes('/automations/')) {
        return json(400, {
          ok: false,
          error: { code: 'WEBHOOK_TARGET_REJECTED', message: 'send_webhook target refused (loopback) at actions[0].config.url' },
        })
      }
      if (method === 'GET' && url.includes('/automations')) {
        if (url.includes('-deliveries')) return json(200, { data: { deliveries: [] } })
        if (url.endsWith('/stats')) return json(200, { data: { total: 0, success: 0, failed: 0, skipped: 0, avgDuration: 0 } })
        return json(200, { data: { rules: [{ ...rule, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] } })
      }
      return json(200, { data: {} })
    })
    const client = new MultitableApiClient({ fetchFn })
    mountComponent(MetaAutomationManager, {
      visible: true,
      sheetId: 'sheet_1',
      fields: [{ id: 'fld_1', name: 'Status', type: 'string' }],
      views: [],
      client,
    })
    await flushPromises()
    ;(document.querySelector('[data-automation-edit="true"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(warning()?.textContent).toContain(WARN_INTERNAL_IP_ZH)
    const saveBtn = document.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    saveBtn.click()
    await flushPromises()

    expect(fetchFn.mock.calls.filter((c) => c[1]?.method === 'PATCH')).toHaveLength(1)
    const saveError = document.querySelector('[data-field="saveError"]') as HTMLElement
    expect(saveError?.textContent).toContain(REFUSED_PREFIX_ZH)
    expect(saveError?.textContent).toContain(WARN_INTERNAL_IP_ZH)
    expect(saveError?.textContent).not.toContain('WEBHOOK_TARGET_REJECTED')
    expect(saveError?.textContent).not.toContain('send_webhook target refused')
    expect(saveError?.textContent).not.toContain('127.0.0.1')
  })
})
