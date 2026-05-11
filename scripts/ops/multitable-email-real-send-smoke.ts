#!/usr/bin/env tsx

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import emailTransportReadinessModule from '../../packages/core-backend/src/services/email-transport-readiness.ts'

const {
  EMAIL_CONFIRM_SEND_ENV,
  EMAIL_REAL_SEND_SMOKE_ENV,
  EMAIL_TRANSPORT_ENV,
  redactEmailTransportText,
  resolveEmailTransportReadiness,
} = emailTransportReadinessModule as typeof import('../../packages/core-backend/src/services/email-transport-readiness')

type EmailTransportEnv = import('../../packages/core-backend/src/services/email-transport-readiness').EmailTransportEnv

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
const RECIPIENT_ENV = 'MULTITABLE_EMAIL_SMOKE_TO'

interface RealSendSmokeReport {
  ok: boolean
  status: 'pass' | 'blocked' | 'failed'
  mode: string
  recipientConfigured: boolean
  notificationStatus?: string
  notificationId?: string
  failedReason?: string
  messages: string[]
  readiness: ReturnType<typeof resolveEmailTransportReadiness>
}

function envString(name: string): string {
  return process.env[name]?.trim() ?? ''
}

function outputPath(envName: string, fallback: string): string {
  const raw = envString(envName)
  return path.resolve(repoRoot, raw || fallback)
}

function redactRuntimeText(value: string, env: EmailTransportEnv): string {
  const recipient = envString(RECIPIENT_ENV)
  const redacted = redactEmailTransportText(value, env)
  return recipient ? redacted.split(recipient).join('<redacted-recipient>') : redacted
}

function renderRealSendMarkdown(report: RealSendSmokeReport): string {
  const lines = [
    '# Multitable Email Real-Send Smoke',
    '',
    `- Status: \`${report.status}\``,
    `- Mode: \`${report.mode}\``,
    `- Recipient configured: \`${report.recipientConfigured ? 'yes' : 'no'}\``,
  ]

  if (report.notificationStatus) {
    lines.push(`- Notification status: \`${report.notificationStatus}\``)
  }
  if (report.notificationId) {
    lines.push(`- Notification id: \`${report.notificationId}\``)
  }
  if (report.failedReason) {
    lines.push(`- Failed reason: ${report.failedReason}`)
  }

  lines.push(
    '',
    '## Messages',
    '',
    ...report.messages.map((message) => `- ${message}`),
    '',
    '## Notes',
    '',
    '- This script sends real email only when all explicit real-send guards are set.',
    '- Raw SMTP credentials, bearer tokens, JWTs, and recipient addresses are not rendered in this report.',
    '- Store SMTP credentials in the runtime secret store or shell environment, not in tracked docs.',
  )

  return `${lines.join('\n')}\n`
}

async function writeReport(report: RealSendSmokeReport): Promise<void> {
  const jsonPath = outputPath('EMAIL_REAL_SEND_JSON', 'output/multitable-email-real-send-smoke/report.json')
  const mdPath = outputPath('EMAIL_REAL_SEND_MD', 'output/multitable-email-real-send-smoke/report.md')
  const markdown = renderRealSendMarkdown(report)

  await fs.mkdir(path.dirname(jsonPath), { recursive: true })
  await fs.mkdir(path.dirname(mdPath), { recursive: true })
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  await fs.writeFile(mdPath, markdown)

  process.stdout.write(markdown)
  process.stdout.write(`\nJSON report: ${jsonPath}\nMarkdown report: ${mdPath}\n`)
}

async function main(): Promise<void> {
  const env = process.env as EmailTransportEnv
  const readiness = resolveEmailTransportReadiness(env)
  const recipient = envString(RECIPIENT_ENV)
  const messages = [...readiness.messages]

  if (readiness.mode !== 'smtp') {
    messages.push(`${EMAIL_TRANSPORT_ENV}=smtp is required for real-send smoke.`)
  }
  if (!readiness.realSendRequested) {
    messages.push(`${EMAIL_REAL_SEND_SMOKE_ENV}=1 is required for real-send smoke.`)
  }
  if (!readiness.confirmSend) {
    messages.push(`${EMAIL_CONFIRM_SEND_ENV}=1 is required for real-send smoke.`)
  }
  if (!recipient) {
    messages.push(`${RECIPIENT_ENV} is required for real-send smoke.`)
  }

  if (!readiness.ok || readiness.mode !== 'smtp' || !readiness.realSendRequested || !readiness.confirmSend || !recipient) {
    await writeReport({
      ok: false,
      status: 'blocked',
      mode: readiness.mode,
      recipientConfigured: Boolean(recipient),
      messages,
      readiness,
    })
    process.exitCode = 2
    return
  }

  const notificationServiceModule = await import('../../packages/core-backend/src/services/NotificationService.ts')
  const { EmailNotificationChannel } = (notificationServiceModule.default ?? notificationServiceModule) as typeof import('../../packages/core-backend/src/services/NotificationService')
  const channel = new EmailNotificationChannel({ env })
  const subject = envString('MULTITABLE_EMAIL_SMOKE_SUBJECT') || `MetaSheet email transport smoke ${new Date().toISOString()}`
  const result = await channel.sender(
    {
      channel: 'email',
      subject,
      content: [
        'MetaSheet multitable send_email real-send smoke.',
        `Generated at: ${new Date().toISOString()}`,
        'If you received this message, SMTP transport delivery is wired.',
      ].join('\n'),
      recipients: [{ id: recipient, type: 'email' }],
      metadata: {
        source: 'multitable-email-real-send-smoke',
      },
    },
    [{ id: recipient, type: 'email' }],
  )

  const ok = result.status === 'sent'
  await writeReport({
    ok,
    status: ok ? 'pass' : 'failed',
    mode: readiness.mode,
    recipientConfigured: true,
    notificationStatus: result.status,
    notificationId: result.id,
    failedReason: result.failedReason ? redactRuntimeText(result.failedReason, env) : undefined,
    messages: ok
      ? ['Real-send smoke completed; verify mailbox receipt for the configured recipient.']
      : ['Real-send smoke failed before a successful notification result.'],
    readiness,
  })
  process.exitCode = ok ? 0 : 1
}

main().catch(async (error: unknown) => {
  const env = process.env as EmailTransportEnv
  const readiness = resolveEmailTransportReadiness(env)
  const message = redactRuntimeText(error instanceof Error ? error.message : String(error), env)
  await writeReport({
    ok: false,
    status: 'failed',
    mode: readiness.mode,
    recipientConfigured: Boolean(envString(RECIPIENT_ENV)),
    failedReason: message,
    messages: ['Real-send smoke crashed before producing a successful notification result.'],
    readiness,
  })
  process.exitCode = 1
})
