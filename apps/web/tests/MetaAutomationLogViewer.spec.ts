import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

import MetaAutomationLogViewer from '../src/multitable/components/MetaAutomationLogViewer.vue'
import type { AutomationExecution, AutomationStats } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

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
  useLocale().setLocale('en')
})

describe('MetaAutomationLogViewer — backend contract normalization', () => {
  it('localizes log chrome in zh-CN while preserving raw status selectors', async () => {
    useLocale().setLocale('zh-CN')
    const client = makeMockClient({
      logs: [PASS_EXECUTION],
      stats: { total: 1, success: 1, failed: 0, skipped: 0, avgDuration: 42 },
    })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()

    const text = mounted.container.textContent ?? ''
    expect(text).toContain('执行日志')
    expect(text).toContain('总计')
    expect(text).toContain('成功')
    expect(text).toContain('失败')
    expect(text).toContain('平均耗时')
    expect(text).toContain('全部状态')
    expect(text).toContain('刷新')
    expect(text).not.toContain('Execution Logs')
    expect(text).not.toContain('All statuses')

    const statusBadge = mounted.container.querySelector('[data-log-id="exec-pass"] [data-status="success"]')
    expect(statusBadge).not.toBeNull()
    expect(statusBadge?.textContent?.trim()).toBe('成功')
  })

  it('localizes expanded step and support actions in zh-CN without changing data-action attributes', async () => {
    useLocale().setLocale('zh-CN')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const client = makeMockClient({ logs: [PASS_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()

    const item = mounted.container.querySelector('[data-log-id="exec-pass"]') as HTMLElement
    item.click()
    await nextTick()

    expect(item.textContent ?? '').toContain('发送邮件')
    expect(item.querySelector('[data-action="copy-support-packet"]')?.textContent).toContain('复制脱敏包')
    expect(item.querySelector('[data-action="download-support-packet"]')?.textContent).toContain('下载 JSON')

    ;(item.querySelector('[data-action="copy-support-packet"]') as HTMLButtonElement).click()
    await flushPromises()
    expect(item.querySelector('[data-field="support-packet-status"]')?.textContent).toContain('已复制脱敏包')
  })

  it('does not add aria-label, title, or placeholder attributes for the log viewer fixture', async () => {
    const client = makeMockClient({ logs: [PASS_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()

    expect(mounted.container.querySelectorAll('[aria-label]')).toHaveLength(0)
    expect(mounted.container.querySelectorAll('[title]')).toHaveLength(0)
    expect(mounted.container.querySelectorAll('[placeholder]')).toHaveLength(0)
  })

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

describe('MetaAutomationLogViewer — redacted support packet actions', () => {
  it('renders copy and download actions for an expanded execution', async () => {
    const client = makeMockClient({ logs: [PASS_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const item = mounted.container.querySelector('[data-log-id="exec-pass"]') as HTMLElement
    item.click()
    await nextTick()

    expect(item.querySelector('[data-action="copy-support-packet"]')).not.toBeNull()
    expect(item.querySelector('[data-action="download-support-packet"]')).not.toBeNull()
  })

  it('copies a redacted Markdown support packet to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const client = makeMockClient({ logs: [LEAKY_EXECUTION] })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const item = mounted.container.querySelector('[data-log-id="exec-leaky"]') as HTMLElement
    item.click()
    await nextTick()

    const copyButton = item.querySelector('[data-action="copy-support-packet"]') as HTMLButtonElement
    copyButton.click()
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = String(writeText.mock.calls[0]?.[0] ?? '')
    expect(copied).toContain('# Automation Execution Support Packet')
    expect(copied).toContain('<redacted>')
    expect(copied).not.toContain('raw-leak-token-12345')
    expect(copied).not.toContain('user-001')
    expect(copied).not.toContain('Customer Order 12345')
    const status = item.querySelector('[data-field="support-packet-status"]')
    expect(status?.textContent ?? '').toContain('copied')
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

// 客户反馈 2026-09-24 #3 final review F1 — after the executor fix one delete of a record.deleted rule's trigger
// record logs ONE skipped run. This panel counted it in 总计 only, badged it 跳过, and printed the step output as
// raw JSON — a zh customer read `"reason":"target_record_missing"`.
const GONE_EXECUTION: AutomationExecution = {
  id: 'exec-gone',
  ruleId: 'rule-1',
  status: 'skipped',
  triggeredBy: 'event',
  triggeredAt: '2026-09-24T10:00:00Z',
  duration: 7,
  steps: [
    {
      actionType: 'delete_record',
      status: 'skipped',
      durationMs: 5,
      output: { recordId: 'rec_gone', sheetId: 'sheet_1', reason: 'target_record_missing' },
    },
  ],
}
const NOOP_EXECUTION: AutomationExecution = {
  id: 'exec-noop',
  ruleId: 'rule-1',
  status: 'success',
  triggeredBy: 'event',
  triggeredAt: '2026-09-24T10:01:00Z',
  duration: 6,
  steps: [
    {
      actionType: 'update_record',
      status: 'success',
      durationMs: 4,
      output: { updatedFields: ['fld_status'], noop: true, reason: 'target_record_missing' },
    },
    {
      actionType: 'start_approval',
      status: 'success',
      durationMs: 1,
      output: { approvalInstanceId: 'ai_1', backwriteSkipped: 'target_record_missing' },
    },
    {
      actionType: 'write_approval_form_values',
      status: 'skipped',
      durationMs: 0,
      output: { reason: 'APPROVAL_FWB_WRITEBACK_ENABLED is OFF' },
    },
  ],
}
const GONE_STATS: AutomationStats = { total: 3, success: 1, failed: 0, skipped: 2, avgDuration: 7 }

async function expandLog(container: HTMLElement, id: string): Promise<HTMLElement> {
  const item = container.querySelector(`[data-log-id="${id}"]`) as HTMLElement
  item.click()
  await nextTick()
  return item
}

describe('MetaAutomationLogViewer — a run skipped because its trigger record is gone (F1)', () => {
  it('zh: the stats bar counts 已跳过, the run is badged 已跳过, and the step reads as a sentence, not the code', async () => {
    useLocale().setLocale('zh-CN')
    const client = makeMockClient({ logs: [GONE_EXECUTION], stats: GONE_STATS })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()

    const skippedStat = mounted.container.querySelector('[data-stat="skipped"]')
    expect(skippedStat?.querySelector('.meta-log-viewer__stat-label')?.textContent).toBe('已跳过')
    expect(skippedStat?.querySelector('[data-field="stat-skipped"]')?.textContent?.trim()).toBe('2')
    expect(mounted.container.querySelector('[data-log-id="exec-gone"] [data-status="skipped"]')?.textContent?.trim()).toBe('已跳过')
    expect(mounted.container.querySelector('[data-field="statusFilter"] option[value="skipped"]')?.textContent).toBe('已跳过')

    const item = await expandLog(mounted.container, 'exec-gone')
    expect(item.querySelector('[data-field="step-reason"]')?.textContent).toBe('触发记录已不存在，已跳过（未做任何修改）')
    const output = item.querySelector('[data-field="step-output"]')?.textContent ?? ''
    expect(output).toContain('rec_gone') // ids stay raw
    expect(item.textContent ?? '').not.toContain('target_record_missing')
    expect(item.querySelector('.meta-log-viewer__step .meta-log-viewer__badge--skipped')?.textContent).toBe('已跳过')
  })

  it('en: the same run reads in English', async () => {
    const client = makeMockClient({ logs: [GONE_EXECUTION], stats: GONE_STATS })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    expect(mounted.container.querySelector('[data-stat="skipped"] .meta-log-viewer__stat-label')?.textContent).toBe('Skipped')
    const item = await expandLog(mounted.container, 'exec-gone')
    expect(item.querySelector('[data-field="step-reason"]')?.textContent).toBe('The trigger record no longer exists; skipped (nothing was changed).')
    expect(item.textContent ?? '').not.toContain('target_record_missing')
  })

  it('zh: the update no-op and the approval writeback marker get their own sentences; an unknown reason stays raw', async () => {
    useLocale().setLocale('zh-CN')
    const client = makeMockClient({ logs: [NOOP_EXECUTION], stats: GONE_STATS })
    mounted = mount({ visible: true, sheetId: 's', ruleId: 'rule-1', client })
    await flushPromises()
    const item = await expandLog(mounted.container, 'exec-noop')

    const reasons = [...item.querySelectorAll('[data-field="step-reason"]')].map((el) => el.textContent)
    expect(reasons).toEqual(['触发记录已不存在，未做任何修改', '审批结果未写回：触发记录已不存在（未做任何修改）'])
    const outputs = [...item.querySelectorAll('[data-field="step-output"]')].map((el) => el.textContent ?? '')
    expect(outputs).toHaveLength(3)
    expect(outputs[0]).toContain('fld_status')
    expect(outputs[0]).not.toContain('noop')
    expect(outputs[1]).toContain('ai_1')
    for (const text of outputs.slice(0, 2)) expect(text).not.toContain('target_record_missing')
    // Positive control: a reason this change does not recognise is rendered exactly as before.
    expect(outputs[2]).toContain('APPROVAL_FWB_WRITEBACK_ENABLED is OFF')
  })
})
