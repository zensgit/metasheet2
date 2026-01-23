export function formatApiErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const maybeMessage = (error as { message?: unknown }).message
    if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) return maybeMessage
    try {
      return JSON.stringify(error)
    } catch {
      return fallback
    }
  }
  return String(error)
}
