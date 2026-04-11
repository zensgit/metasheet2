const DINGTALK_WEBHOOK_SENSITIVE_QUERY_KEYS = new Set(['access_token', 'timestamp', 'sign'])

export class DingTalkCorpNotAllowedError extends Error {
  readonly statusCode = 403
  readonly code = 'DINGTALK_CORP_NOT_ALLOWED'
  readonly corpId: string | null

  constructor(message: string, corpId: string | null) {
    super(message)
    this.name = 'DingTalkCorpNotAllowedError'
    this.corpId = corpId
  }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

export function readDingTalkAllowedCorpIds(): string[] {
  return Array.from(new Set(
    normalizeText(process.env.DINGTALK_ALLOWED_CORP_IDS)
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  ))
}

export function isDingTalkCorpAllowed(corpId: string | null | undefined): boolean {
  const allowedCorpIds = readDingTalkAllowedCorpIds()
  if (allowedCorpIds.length === 0) return true

  const normalizedCorpId = normalizeText(corpId)
  if (!normalizedCorpId) return false
  return allowedCorpIds.includes(normalizedCorpId)
}

export function assertDingTalkCorpAllowed(
  corpId: string | null | undefined,
  options: {
    allowEmpty?: boolean
    context?: string
  } = {},
): void {
  const normalizedCorpId = normalizeText(corpId)
  const allowedCorpIds = readDingTalkAllowedCorpIds()

  if (allowedCorpIds.length === 0) return
  if (!normalizedCorpId) {
    if (options.allowEmpty) return
    const context = options.context || 'DingTalk corpId'
    throw new DingTalkCorpNotAllowedError(
      `${context} is required when DINGTALK_ALLOWED_CORP_IDS is configured`,
      null,
    )
  }
  if (allowedCorpIds.includes(normalizedCorpId)) return

  const context = options.context || 'DingTalk corpId'
  throw new DingTalkCorpNotAllowedError(
    `${context} ${normalizedCorpId} is not allowed by DINGTALK_ALLOWED_CORP_IDS`,
    normalizedCorpId,
  )
}

export function maskDingTalkWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url)
    for (const key of DINGTALK_WEBHOOK_SENSITIVE_QUERY_KEYS) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '***')
      }
    }
    if (parsed.password) {
      parsed.password = '***'
    }
    return parsed.toString()
  } catch {
    return String(url || '').replace(
      /([?&](?:access_token|timestamp|sign)=)[^&]+/gi,
      '$1***',
    )
  }
}
