import { describe, expect, it } from 'vitest'

import type { AutomationExecution } from '../src/multitable/types'
import {
  buildAutomationLogSupportPacket,
  createAutomationLogSupportPacketFilename,
  renderAutomationLogSupportPacketJson,
  renderAutomationLogSupportPacketMarkdown,
} from '../src/multitable/utils/automation-log-support-packet'

const LEAKY_EXECUTION: AutomationExecution = {
  id: 'exec-leaky',
  ruleId: 'rule-raw@example.com',
  status: 'failed',
  triggeredBy: 'operator@example.com',
  triggeredAt: '2026-05-15T10:05:00Z',
  duration: 18,
  error: 'top-level failed for qa-private@example.com with Bearer top-level-token-abcdefghijklmnopqrstuvwxyz',
  steps: [
    {
      actionType: 'send_email',
      status: 'failed',
      durationMs: 18,
      output: {
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=raw-leak-token-12345',
        receiverUserIds: ['user-001', 'user-002'],
        subject: 'Customer Order 12345',
        note: 'delivery failed to qa-private@example.com',
      },
      error:
        'SMTP_PASSWORD=secret-pw-99 timed out for OPENAI_API_KEY=sk-raw-key-leak1234567890abc',
    },
  ],
}

describe('automation log support packet', () => {
  it('builds a redacted, schema-versioned execution packet', () => {
    const packet = buildAutomationLogSupportPacket(LEAKY_EXECUTION, '2026-05-15T11:00:00Z')

    expect(packet.schemaVersion).toBe(1)
    expect(packet.kind).toBe('multitable.automation.execution.support-packet')
    expect(packet.generatedAt).toBe('2026-05-15T11:00:00Z')
    expect(packet.redactionPolicy).toBe('step-output-and-error-summaries-only')
    expect(packet.execution.ruleId).toBe('<email:redacted>')
    expect(packet.execution.triggeredBy).toBe('<email:redacted>')
    expect(packet.execution.errorSummary).toContain('<email:redacted>')
    expect(packet.execution.steps[0]?.outputSummary).toContain('<redacted>')
    expect(packet.execution.steps[0]?.errorSummary).toContain('SMTP_PASSWORD=<redacted>')
  })

  it('renders JSON without raw secret, recipient, or customer-like values', () => {
    const json = renderAutomationLogSupportPacketJson(LEAKY_EXECUTION, '2026-05-15T11:00:00Z')

    expect(json).toContain('"schemaVersion": 1')
    expect(json).toContain('<email:redacted>')
    expect(json).toContain('<redacted>')
    expect(json).not.toContain('raw-leak-token-12345')
    expect(json).not.toContain('user-001')
    expect(json).not.toContain('Customer Order 12345')
    expect(json).not.toContain('secret-pw-99')
    expect(json).not.toContain('sk-raw-key-leak1234567890abc')
    expect(json).not.toContain('operator@example.com')
    expect(json).not.toContain('qa-private@example.com')
  })

  it('renders Markdown without raw secret, recipient, or customer-like values', () => {
    const md = renderAutomationLogSupportPacketMarkdown(LEAKY_EXECUTION, '2026-05-15T11:00:00Z')

    expect(md).toContain('# Automation Execution Support Packet')
    expect(md).toContain('```text')
    expect(md).toContain('<email:redacted>')
    expect(md).not.toContain('raw-leak-token-12345')
    expect(md).not.toContain('user-002')
    expect(md).not.toContain('Customer Order 12345')
    expect(md).not.toContain('secret-pw-99')
    expect(md).not.toContain('operator@example.com')
  })

  it('creates a filesystem-safe filename and redacts email-shaped ids', () => {
    const filename = createAutomationLogSupportPacketFilename({
      ...LEAKY_EXECUTION,
      id: 'exec/admin@example.com',
    })

    expect(filename).toMatch(/^automation-execution-/)
    expect(filename).toMatch(/\.json$/)
    expect(filename).not.toContain('/')
    expect(filename).not.toContain(':')
    expect(filename).not.toContain('admin@example.com')
    expect(filename).toContain('email-redacted')
  })
})

// 客户反馈 2026-10-21 item 1 (review round 1, F3): the support packet carries no skipped recipient id either.
describe('automation log support packet — DingTalk person-message recipients', () => {
  const LEGACY: AutomationExecution = {
    id: 'exec-legacy',
    ruleId: 'rule-1',
    status: 'skipped',
    triggeredBy: 'event',
    triggeredAt: '2026-10-20T10:00:00Z',
    steps: [
      {
        actionType: 'send_dingtalk_person_message',
        status: 'skipped',
        error: 'DingTalk account not linked for users: user_fake_old_a, user_fake_old_b',
        output: { notifiedUsers: 0, skippedRecipientCount: 2, skippedUserIds: ['user_fake_old_a', 'user_fake_old_b'] },
      },
      {
        actionType: 'send_dingtalk_person_message',
        status: 'skipped',
        error: 'No DingTalk recipient was reached: 1 skipped (not linked: 1, inactive: 0, not found: 0) (DINGTALK_RECIPIENTS_UNREACHABLE)',
        output: { reason: 'dingtalk_recipients_unreachable', notifiedUsers: 0, skippedRecipientCount: 1, skippedUserIds: ['user_fake_new'], skippedReasonCounts: { notLinked: 1, inactive: 0, notFound: 0 } },
      },
    ],
  }

  it('rewrites the legacy id-listing error and masks skippedUserIds; counts stay', () => {
    const packet = buildAutomationLogSupportPacket(LEGACY, '2026-10-22T00:00:00Z')
    expect(packet.execution.steps[0]?.errorSummary).toBe('Some recipients were not linked to DingTalk (older record; the users are not listed).')
    expect(packet.execution.steps[1]?.errorSummary).toContain('No DingTalk recipient was reached: 1 skipped')
    const json = renderAutomationLogSupportPacketJson(LEGACY, '2026-10-22T00:00:00Z')
    const markdown = renderAutomationLogSupportPacketMarkdown(LEGACY, '2026-10-22T00:00:00Z')
    for (const text of [json, markdown]) {
      for (const id of ['user_fake_old_a', 'user_fake_old_b', 'user_fake_new']) expect(text).not.toContain(id)
      expect(text).toContain('skippedRecipientCount')
    }
  })
})
