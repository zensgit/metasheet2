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
