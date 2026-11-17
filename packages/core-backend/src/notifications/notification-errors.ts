/**
 * A failure that the notification routes answer as-is: a 4xx status, a fixed code and, optionally,
 * values-free details (names of fields, a revision number, a fixed reason code).
 */
export class NotificationHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(status: number, code: string, details?: Readonly<Record<string, unknown>>) {
    super(code)
    this.name = 'NotificationHttpError'
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function isNotificationHttpError(error: unknown): error is NotificationHttpError {
  return error instanceof NotificationHttpError
}
