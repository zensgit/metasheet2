export type DingTalkPermissionErrorDetails = {
  provider: 'dingtalk'
  message: string
  subcode: string | null
  requiredScopes: string[]
  applyUrl: string | null
}

export function readErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback
  }

  const record = payload as Record<string, unknown>
  for (const key of ['errmsg', 'sub_msg', 'error_description', 'reason']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }

  const topError = record.error
  if (typeof topError === 'string' && topError.trim().length > 0) {
    return topError
  }

  if (topError && typeof topError === 'object' && !Array.isArray(topError)) {
    const message = (topError as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim().length > 0) {
      return message
    }
  }

  const nested = record.data
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedError = (nested as Record<string, unknown>).error
    if (typeof nestedError === 'string' && nestedError.trim().length > 0) {
      return nestedError
    }
  }

  if (typeof record.message === 'string' && record.message.trim().length > 0) {
    return record.message
  }

  if (payload instanceof Error && payload.message.trim().length > 0) {
    return payload.message
  }

  return fallback
}

function collectErrorTexts(payload: unknown): string[] {
  if (typeof payload === 'string') {
    return payload.trim() ? [payload.trim()] : []
  }

  if (payload instanceof Error) {
    return payload.message.trim() ? [payload.message.trim()] : []
  }

  if (!payload || typeof payload !== 'object') {
    return []
  }

  const record = payload as Record<string, unknown>
  const texts: string[] = []

  for (const key of ['errmsg', 'sub_msg', 'submsg', 'error_description', 'reason', 'message']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      texts.push(value.trim())
    }
  }

  const topError = record.error
  if (typeof topError === 'string' && topError.trim().length > 0) {
    texts.push(topError.trim())
  } else if (topError && typeof topError === 'object' && !Array.isArray(topError)) {
    const message = (topError as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim().length > 0) {
      texts.push(message.trim())
    }
  }

  return Array.from(new Set(texts))
}

function extractFirstMatch(texts: string[], pattern: RegExp): string | null {
  for (const text of texts) {
    const match = text.match(pattern)
    if (match?.[1]?.trim()) {
      return match[1].trim()
    }
  }
  return null
}

function extractRequiredScopes(texts: string[]): string[] {
  const scopes = new Set<string>()

  for (const text of texts) {
    const bracketMatches = text.matchAll(/(?:requiredScopes=\[|所需的权限：\[)([^\]]+)\]/gi)
    for (const match of bracketMatches) {
      const candidates = match[1]?.match(/qyapi_[a-z0-9_]+/gi) || []
      candidates.forEach((scope) => scopes.add(scope))
    }

    const inlineMatches = text.match(/qyapi_[a-z0-9_]+/gi) || []
    inlineMatches.forEach((scope) => scopes.add(scope))
  }

  return Array.from(scopes)
}

export function readDingTalkPermissionErrorDetails(payload: unknown): DingTalkPermissionErrorDetails | null {
  const texts = collectErrorTexts(payload)
  if (texts.length === 0) return null

  const message = readErrorMessage(payload, texts[0] || 'DingTalk permission missing')
  const subcode = extractFirstMatch(texts, /subcode\s*=\s*([0-9]+)/i)
  const applyUrl = extractFirstMatch(texts, /(https:\/\/open-dev\.dingtalk\.com\/appscope\/apply\?[^,\]\s]+)/i)
  const requiredScopes = extractRequiredScopes(texts)
  const joined = texts.join(' ')
  const looksLikePermissionError = subcode === '60011'
    || requiredScopes.length > 0
    || joined.includes('应用尚未开通所需的权限')
    || joined.includes('requiredScopes')

  if (!looksLikePermissionError) {
    return null
  }

  return {
    provider: 'dingtalk',
    message,
    subcode,
    requiredScopes,
    applyUrl,
  }
}
