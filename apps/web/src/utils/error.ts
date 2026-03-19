export function readErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback
  }

  const record = payload as Record<string, unknown>
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

  return fallback
}
