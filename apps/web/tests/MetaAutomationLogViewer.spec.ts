import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'

import MetaAutomationLogViewer from '../src/multitable/components/MetaAutomationLogViewer.vue'
import type { AutomationExecution, AutomationStats } from '../src/multitable/types'

interface MockClientOptions {
  logs?: AutomationExecution[]
  stats?: AutomationStats
  logsError?: Error
  statsError?: Error
}

function makeMockClient(options: MockClientOptions = {}) {
  const defaultStats: AutomationStats = {
    total: 1,
    success: 1,
    failed: 0,
    skipped: 0,
    avgDuration: 32,
  }
  return {
    getAutomationLogs: async (_sheetId: string, _ruleId: string, _limit?: number) => {
      if (options.logsError) throw options.logsError
      return options.logs ?? []
    },
    getAutomationStats: async (_sheetId: string, _ruleId: string) => {
      if (options.statsError) throw options.statsError
      return options.stats ?? defaultStats
    },
  } as unknown as Parameters<typeof MetaAutomationLogViewer.props.client.type>[0]
}

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationLogViewer, props) })
  app.mount(container)
  return { container, app }
}

const PASS_EXECUTION: AutomationExecution = {
  id: 'exec-pass',
  ruleId: 'rule-1',
  status: 'success',
  triggeredBy: 'event',
  triggeredAt: '2026-05-15T10:00:00Z',
  duration: 42,
  steps: [
    {
      actionType: 'send_email',
      status: 'success',
      durationMs: 30,
      output: {
        ok: true,
        recipient: 'qa-private@example.com',
        notificationStatus: 'sent',
      },
    },
  ],
}

const LEAKY_EXECUTION: AutomationExecution = {
  id: 'exec-leaky',
  ruleId: 'rule-1',
  status: 'failed',
  triggeredBy: 'manual',
  triggeredAt: '2026-05-15T10:05:00Z',
  duration: 18,
  steps: [
    {
      actionType: 'send_dingtalk_group_message',
      status: 'failed',
      durationMs: 18,
      output: {
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=raw-leak-token-12345',
        receiverUserIds: ['user-001', 'user-002'],
        subject: 'Customer Order 12345',
        authToken: 'Bearer raw-bearer-leak-token-abcdefghijklmnop',
      },
      error:
        'SMTP_PASSWORD=secret-pw-99 timed out for OPENAI_API_KEY=sk-raw-key-leak1234567890abc',
    },
  ],
}

let mounted: { container: HTMLDivElement; app: ReturnType<typeof createApp> } | null = null

beforeEach(() => {
  mounted = null
})

afterEach(() => {
  if (mounted) {
    mounted.app.unmount()
    mounted.container.remove()
    mounted = null
  }
})

describe('MetaAutomationLogViewer — backend contract normalization', () => {
  it('renders `triggeredAt` as the log time, not the removed `startedAt`', async () => {
    const client = makeMockClient({ logs: [PASS_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const item = mounted.container.querySelector('[data-log-id="exec-pass"]')
    expect(item).not.toBeNull()
    const timeCell = item!.querySelector('.meta-log-viewer__log-time')
    expect(timeCell?.textContent ?? '').not.toBe('')
    expect(timeCell?.textContent ?? '').not.toBe('Invalid Date')
  })

  it('renders `triggeredBy` value in the trigger column (not the removed `triggerType`)', async () => {
    const client = makeMockClient({ logs: [PASS_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const triggerCell = mounted.container.querySelector(
      '[data-log-id="exec-pass"] [data-field="triggeredBy"]',
    )
    expect(triggerCell?.textContent?.trim()).toBe('event')
  })

  it('renders `duration` ms in the duration column (not the removed `durationMs`)', async () => {
    const client = makeMockClient({ logs: [PASS_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const durCell = mounted.container.querySelector(
      '[data-log-id="exec-pass"] .meta-log-viewer__log-duration',
    )
    expect(durCell?.textContent?.trim()).toBe('42ms')
  })

  it('renders `avgDuration` in the stats bar (not the removed `avgDurationMs`)', async () => {
    const client = makeMockClient({
      logs: [PASS_EXECUTION],
      stats: { total: 5, success: 4, failed: 1, skipped: 0, avgDuration: 88 },
    })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const statValues = mounted.container.querySelectorAll(
      '[data-stats="true"] .meta-log-viewer__stat-value',
    )
    expect(statValues.length).toBeGreaterThanOrEqual(4)
    const avgCell = statValues[statValues.length - 1]
    expect(avgCell?.textContent?.trim()).toBe('88ms')
  })
})

describe('MetaAutomationLogViewer — step output redaction', () => {
  it('does not render raw JSON.stringify of step.output', async () => {
    const client = makeMockClient({ logs: [LEAKY_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const item = mounted.container.querySelector('[data-log-id="exec-leaky"]') as HTMLElement
    expect(item).not.toBeNull()
    item.click()
    await nextTick()
    const allText = item.textContent ?? ''
    // Sentinel substrings must NOT appear anywhere in the rendered DOM
    expect(allText).not.toContain('raw-leak-token-12345')
    expect(allText).not.toContain('user-001')
    expect(allText).not.toContain('user-002')
    expect(allText).not.toContain('Customer Order 12345')
    expect(allText).not.toContain('raw-bearer-leak-token-abcdefghijklmnop')
  })

  it('does not render raw step.error', async () => {
    const client = makeMockClient({ logs: [LEAKY_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const item = mounted.container.querySelector('[data-log-id="exec-leaky"]') as HTMLElement
    item.click()
    await nextTick()
    const errorCell = item.querySelector('[data-field="step-error"]')
    expect(errorCell).not.toBeNull()
    const errorText = errorCell?.textContent ?? ''
    expect(errorText).not.toContain('secret-pw-99')
    expect(errorText).not.toContain('sk-raw-key-leak1234567890abc')
    expect(errorText).toMatch(/SMTP_PASSWORD=<redacted>/)
    expect(errorText).toMatch(/OPENAI_API_KEY=<redacted>/)
  })

  it('shows redacted placeholder text in the output cell', async () => {
    const client = makeMockClient({ logs: [LEAKY_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const item = mounted.container.querySelector('[data-log-id="exec-leaky"]') as HTMLElement
    item.click()
    await nextTick()
    const outputCell = item.querySelector('[data-field="step-output"]')
    expect(outputCell).not.toBeNull()
    expect(outputCell?.textContent ?? '').toContain('<redacted>')
  })
})

describe('MetaAutomationLogViewer — load failure surfaces error', () => {
  it('renders a visible error alert when getAutomationLogs throws', async () => {
    const client = makeMockClient({ logsError: new Error('Network unreachable') })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const errorBlock = mounted.container.querySelector('[data-error="true"]')
    expect(errorBlock).not.toBeNull()
    const message = errorBlock!.querySelector('[data-field="error-message"]')
    expect(message?.textContent ?? '').toContain('Network unreachable')
  })

  it('renders a visible error alert when getAutomationStats throws', async () => {
    const client = makeMockClient({ statsError: new Error('Stats endpoint down') })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const errorBlock = mounted.container.querySelector('[data-error="true"]')
    expect(errorBlock).not.toBeNull()
  })

  it('redacts secret-shaped content in the load error message', async () => {
    const client = makeMockClient({
      logsError: new Error('Failed to fetch with Bearer abcdefghijklmnopqrstuvwxyz1234567890'),
    })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const message = mounted.container.querySelector('[data-field="error-message"]')
    const text = message?.textContent ?? ''
    expect(text).toContain('Bearer <redacted>')
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890')
  })

  it('retry button exists in the error alert', async () => {
    const client = makeMockClient({ logsError: new Error('boom') })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const retryBtn = mounted.container.querySelector('[data-action="retry"]')
    expect(retryBtn).not.toBeNull()
  })

  it('does not show the empty-state placeholder while error is present', async () => {
    const client = makeMockClient({ logsError: new Error('boom') })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const empty = mounted.container.querySelector('[data-empty="true"]')
    expect(empty).toBeNull()
  })
})
