import type { AutomationExecution } from '../types'
import {
  REDACTION_VERSION,
  redactString,
  summarizeStepError,
  summarizeStepOutput,
} from './automation-log-redact'

export interface AutomationStepSupportPacket {
  index: number
  actionType: string
  status: string
  durationMs?: number
  outputSummary?: string
  errorSummary?: string
}

export interface AutomationExecutionSupportPacket {
  schemaVersion: 1
  kind: 'multitable.automation.execution.support-packet'
  generatedAt: string
  redactionVersion: number
  redactionPolicy: 'step-output-and-error-summaries-only'
  execution: {
    id: string
    ruleId: string
    status: string
    triggeredBy: string
    triggeredAt: string
    completedAt?: string
    duration?: number
    errorSummary?: string
    steps: AutomationStepSupportPacket[]
  }
}

export function buildAutomationLogSupportPacket(
  execution: AutomationExecution,
  generatedAt = new Date().toISOString(),
): AutomationExecutionSupportPacket {
  return {
    schemaVersion: 1,
    kind: 'multitable.automation.execution.support-packet',
    generatedAt,
    redactionVersion: REDACTION_VERSION,
    redactionPolicy: 'step-output-and-error-summaries-only',
    execution: {
      id: redactString(execution.id),
      ruleId: redactString(execution.ruleId),
      status: execution.status,
      triggeredBy: redactString(execution.triggeredBy),
      triggeredAt: redactString(execution.triggeredAt),
      completedAt: execution.completedAt ? redactString(execution.completedAt) : undefined,
      duration: execution.duration,
      errorSummary: summarizeStepError(execution.error) || undefined,
      steps: (execution.steps ?? []).map((step, index) => ({
        index: index + 1,
        actionType: step.actionType,
        status: step.status,
        durationMs: step.durationMs,
        outputSummary: summarizeStepOutput(step.output) || undefined,
        errorSummary: summarizeStepError(step.error) || undefined,
      })),
    },
  }
}

export function renderAutomationLogSupportPacketJson(
  execution: AutomationExecution,
  generatedAt?: string,
): string {
  return `${JSON.stringify(buildAutomationLogSupportPacket(execution, generatedAt), null, 2)}\n`
}

export function renderAutomationLogSupportPacketMarkdown(
  execution: AutomationExecution,
  generatedAt?: string,
): string {
  const packet = buildAutomationLogSupportPacket(execution, generatedAt)
  const lines = [
    '# Automation Execution Support Packet',
    '',
    `- Generated at: \`${packet.generatedAt}\``,
    `- Redaction version: \`${packet.redactionVersion}\``,
    `- Redaction policy: \`${packet.redactionPolicy}\``,
    `- Execution id: \`${packet.execution.id}\``,
    `- Rule id: \`${packet.execution.ruleId}\``,
    `- Status: \`${packet.execution.status}\``,
    `- Triggered by: \`${packet.execution.triggeredBy}\``,
    `- Triggered at: \`${packet.execution.triggeredAt}\``,
    `- Duration: \`${packet.execution.duration ?? '-'}ms\``,
  ]

  if (packet.execution.completedAt) {
    lines.push(`- Completed at: \`${packet.execution.completedAt}\``)
  }
  if (packet.execution.errorSummary) {
    lines.push('', '## Execution Error', '', '```text', packet.execution.errorSummary, '```')
  }

  lines.push('', '## Steps')
  if (packet.execution.steps.length === 0) {
    lines.push('', 'No steps recorded.')
  } else {
    for (const step of packet.execution.steps) {
      lines.push(
        '',
        `### ${step.index}. ${step.actionType}`,
        '',
        `- Status: \`${step.status}\``,
        `- Duration: \`${step.durationMs ?? '-'}ms\``,
      )
      if (step.outputSummary) {
        lines.push('', 'Output:', '', '```text', step.outputSummary, '```')
      }
      if (step.errorSummary) {
        lines.push('', 'Error:', '', '```text', step.errorSummary, '```')
      }
    }
  }

  return `${lines.join('\n')}\n`
}

export function createAutomationLogSupportPacketFilename(execution: AutomationExecution): string {
  const safeId = sanitizeFilenamePart(execution.id || 'execution')
  const safeTime = sanitizeFilenamePart(execution.triggeredAt || new Date().toISOString())
  return `automation-execution-${safeId}-${safeTime}.json`
}

function sanitizeFilenamePart(value: string): string {
  const sanitized = redactString(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || 'redacted'
}
