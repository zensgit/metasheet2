import { createHmac } from 'node:crypto'

export interface DingTalkRobotPayload {
  msgtype: 'markdown'
  markdown: {
    title: string
    text: string
  }
}

interface DingTalkRobotResponse {
  errcode?: number
  errmsg?: string
}

export class DingTalkRobotResponseError extends Error {}

const DINGTALK_ROBOT_WEBHOOK_HOST = 'oapi.dingtalk.com'
const DINGTALK_ROBOT_WEBHOOK_PATH = '/robot/send'

export function buildDingTalkMarkdown(subject: string, content: string): DingTalkRobotPayload {
  const title = subject.trim() || 'MetaSheet Notification'
  const body = content.trim() || title
  return {
    msgtype: 'markdown',
    markdown: {
      title,
      text: `### ${title}\n\n${body}`,
    },
  }
}

export function normalizeDingTalkRobotWebhookUrl(value: string | undefined): string {
  const webhookUrl = value?.trim()
  if (!webhookUrl) throw new Error('Webhook URL is required')

  let parsed: URL
  try {
    parsed = new URL(webhookUrl)
  } catch {
    throw new Error('Webhook URL is not a valid URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('DingTalk robot webhook URL must use HTTPS')
  }
  if (parsed.hostname !== DINGTALK_ROBOT_WEBHOOK_HOST || parsed.pathname !== DINGTALK_ROBOT_WEBHOOK_PATH) {
    throw new Error(`DingTalk group webhook URL must be a DingTalk robot URL from https://${DINGTALK_ROBOT_WEBHOOK_HOST}${DINGTALK_ROBOT_WEBHOOK_PATH}`)
  }
  if (!parsed.searchParams.get('access_token')?.trim()) {
    throw new Error('DingTalk group webhook URL must include access_token')
  }

  return parsed.toString()
}

export function normalizeDingTalkRobotSecret(value: string | undefined): string | undefined {
  const secret = value?.trim()
  if (!secret) return undefined
  if (!secret.startsWith('SEC')) {
    throw new Error('DingTalk robot secret must start with SEC')
  }
  return secret
}

export function buildSignedDingTalkWebhookUrl(baseUrl: string, secret?: string): string {
  const normalizedSecret = typeof secret === 'string' ? secret.trim() : ''
  if (!normalizedSecret) return baseUrl

  const timestamp = Date.now()
  const stringToSign = `${timestamp}\n${normalizedSecret}`
  const sign = encodeURIComponent(createHmac('sha256', normalizedSecret).update(stringToSign).digest('base64'))
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}timestamp=${timestamp}&sign=${sign}`
}

export function validateDingTalkRobotResponse(payload: unknown): void {
  const data = payload as DingTalkRobotResponse | null
  if (!data || typeof data !== 'object') return
  const errcode = typeof data.errcode === 'number' ? data.errcode : 0
  if (errcode === 0) return
  const errmsg = typeof data.errmsg === 'string' && data.errmsg.trim().length > 0
    ? data.errmsg.trim()
    : 'DingTalk robot request failed'
  throw new DingTalkRobotResponseError(`DingTalk errcode ${errcode}: ${errmsg}`)
}
