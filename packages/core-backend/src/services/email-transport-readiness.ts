export const EMAIL_TRANSPORT_ENV = 'MULTITABLE_EMAIL_TRANSPORT'
export const EMAIL_REAL_SEND_SMOKE_ENV = 'MULTITABLE_EMAIL_REAL_SEND_SMOKE'
export const EMAIL_CONFIRM_SEND_ENV = 'CONFIRM_SEND_EMAIL'

export const EMAIL_SMTP_REQUIRED_ENV = [
  'MULTITABLE_EMAIL_SMTP_HOST',
  'MULTITABLE_EMAIL_SMTP_PORT',
  'MULTITABLE_EMAIL_SMTP_USER',
  'MULTITABLE_EMAIL_SMTP_PASSWORD',
  'MULTITABLE_EMAIL_SMTP_FROM',
] as const

export type EmailTransportMode = 'mock' | 'smtp' | 'unsupported'
export type EmailTransportReadinessStatus = 'pass' | 'blocked'

export interface EmailTransportEnvStatus {
  name: string
  present: boolean
  value: string
}

export interface EmailTransportReadinessReport {
  ok: boolean
  status: EmailTransportReadinessStatus
  mode: EmailTransportMode
  transportEnv: EmailTransportEnvStatus
  realSendRequested: boolean
  confirmSend: boolean
  requiredEnv: EmailTransportEnvStatus[]
  messages: string[]
}

export type EmailTransportEnv = Record<string, string | undefined>

function envString(env: EmailTransportEnv, name: string): string {
  const value = env[name]
  return typeof value === 'string' ? value.trim() : ''
}

function isTruthyEnv(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function resolveMode(value: string): EmailTransportMode {
  if (!value) return 'mock'
  const normalized = value.toLowerCase()
  if (normalized === 'mock' || normalized === 'disabled' || normalized === 'off') return 'mock'
  if (normalized === 'smtp') return 'smtp'
  return 'unsupported'
}

export function redactEmailTransportValue(name: string, value: string): string {
  if (!value) return '<unset>'
  const upper = name.toUpperCase()
  if (name === EMAIL_TRANSPORT_ENV) return resolveMode(value)
  if (name === EMAIL_REAL_SEND_SMOKE_ENV || name === EMAIL_CONFIRM_SEND_ENV) {
    return isTruthyEnv(value) ? 'true' : 'false'
  }
  if (upper.endsWith('_PORT') && /^\d+$/.test(value)) return value
  if (upper.endsWith('_SECURE')) return isTruthyEnv(value) ? 'true' : 'false'
  return '<set>'
}

function envStatus(env: EmailTransportEnv, name: string): EmailTransportEnvStatus {
  const value = envString(env, name)
  return {
    name,
    present: value.length > 0,
    value: redactEmailTransportValue(name, value),
  }
}

export function resolveEmailTransportReadiness(
  env: EmailTransportEnv = process.env,
): EmailTransportReadinessReport {
  const transportEnv = envStatus(env, EMAIL_TRANSPORT_ENV)
  const mode = resolveMode(envString(env, EMAIL_TRANSPORT_ENV))
  const realSendRequested = isTruthyEnv(envString(env, EMAIL_REAL_SEND_SMOKE_ENV))
  const confirmSend = isTruthyEnv(envString(env, EMAIL_CONFIRM_SEND_ENV))
  const requiredEnv = mode === 'smtp'
    ? EMAIL_SMTP_REQUIRED_ENV.map((name) => envStatus(env, name))
    : []
  const missing = requiredEnv.filter((item) => !item.present).map((item) => item.name)
  const messages: string[] = []

  if (mode === 'unsupported') {
    messages.push(`${EMAIL_TRANSPORT_ENV} must be "mock" or "smtp".`)
  } else if (mode === 'mock') {
    messages.push('Email transport is mock; no real email will be sent.')
  } else {
    if (missing.length > 0) {
      messages.push(`SMTP transport is enabled but missing required env: ${missing.join(', ')}.`)
    } else {
      messages.push('SMTP transport env is present; readiness check does not send email.')
    }
  }

  if (realSendRequested && !confirmSend) {
    messages.push(`${EMAIL_REAL_SEND_SMOKE_ENV}=1 requires ${EMAIL_CONFIRM_SEND_ENV}=1.`)
  }

  const blocked = mode === 'unsupported' || missing.length > 0 || (realSendRequested && !confirmSend)

  return {
    ok: !blocked,
    status: blocked ? 'blocked' : 'pass',
    mode,
    transportEnv,
    realSendRequested,
    confirmSend,
    requiredEnv,
    messages,
  }
}

export function renderEmailTransportReadinessMarkdown(report: EmailTransportReadinessReport): string {
  const lines = [
    '# Multitable Email Transport Readiness',
    '',
    `- Status: \`${report.status}\``,
    `- Mode: \`${report.mode}\``,
    `- Real-send smoke requested: \`${report.realSendRequested ? 'yes' : 'no'}\``,
    `- Confirm-send guard: \`${report.confirmSend ? 'set' : 'unset'}\``,
    '',
    '## Messages',
    '',
    ...report.messages.map((message) => `- ${message}`),
    '',
    '## Environment',
    '',
    '| Name | Present | Redacted value |',
    '| --- | --- | --- |',
    `| ${report.transportEnv.name} | ${report.transportEnv.present ? 'yes' : 'no'} | \`${report.transportEnv.value}\` |`,
    `| ${EMAIL_REAL_SEND_SMOKE_ENV} | ${report.realSendRequested ? 'yes' : 'no'} | \`${report.realSendRequested ? 'true' : 'false'}\` |`,
    `| ${EMAIL_CONFIRM_SEND_ENV} | ${report.confirmSend ? 'yes' : 'no'} | \`${report.confirmSend ? 'true' : 'false'}\` |`,
  ]

  if (report.requiredEnv.length > 0) {
    lines.push(...report.requiredEnv.map((item) =>
      `| ${item.name} | ${item.present ? 'yes' : 'no'} | \`${item.value}\` |`,
    ))
  }

  lines.push(
    '',
    '## Notes',
    '',
    '- This gate validates transport configuration only; it never sends real email.',
    '- Raw SMTP credentials, bearer tokens, JWTs, and recipient lists are not rendered in this report.',
  )

  return `${lines.join('\n')}\n`
}
