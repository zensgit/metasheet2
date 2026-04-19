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
