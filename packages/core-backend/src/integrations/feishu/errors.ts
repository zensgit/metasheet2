/**
 * Feishu error classes, numeric-code reading, the outcome-unknown marker and the fixed failure sentences.
 *
 * Every message below is a developer-written sentence that carries at most a numeric code: no provider
 * text, no host, no request id, no URL. The provider's response body rides on the error as a
 * non-enumerable, read-only property (`responseBody`), so JSON.stringify(error), an object spread and a
 * logger that serialises `{ error }` never write it, while a caller that needs the code still reads
 * `error.responseBody`.
 *
 * Pure module: no imports, no I/O.
 */

function attachHiddenResponseBody(error: Error, responseBody: Record<string, unknown> | null): void {
  Object.defineProperty(error, 'responseBody', {
    value: responseBody,
    writable: false,
    enumerable: false,
    configurable: false,
  })
}

/** The provider answered with an error status (and, possibly, an unusable body). */
export class FeishuRequestError extends Error {
  readonly statusCode: number
  /** Non-enumerable, read-only. */
  declare readonly responseBody: Record<string, unknown> | null

  constructor(statusCode: number, responseBody: Record<string, unknown> | null) {
    super(`Feishu answered with an error status (HTTP ${statusCode})`)
    this.name = 'FeishuRequestError'
    this.statusCode = statusCode
    attachHiddenResponseBody(this, responseBody)
  }
}

/** The provider answered with an application-level rejection: a numeric `code` other than 0. */
export class FeishuBusinessError extends Error {
  readonly code: number
  readonly httpStatus: number
  /** Non-enumerable, read-only. */
  declare readonly responseBody: Record<string, unknown> | null

  constructor(code: number, httpStatus: number, responseBody: Record<string, unknown> | null) {
    super(`Feishu rejected the request (code ${code})`)
    this.name = 'FeishuBusinessError'
    this.code = code
    this.httpStatus = httpStatus
    attachHiddenResponseBody(this, responseBody)
  }
}

export class FeishuTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super('Feishu did not answer in time')
    this.name = 'FeishuTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** An HTTP-2xx answer whose body cannot be used as a success: not a JSON object, or without the envelope code. */
export class FeishuMalformedResponseError extends Error {
  readonly httpStatus: number
  readonly reason: 'unparseable_body' | 'missing_code'

  constructor(reason: 'unparseable_body' | 'missing_code', httpStatus: number) {
    super(`Feishu returned an unusable response (HTTP ${httpStatus})`)
    this.name = 'FeishuMalformedResponseError'
    this.reason = reason
    this.httpStatus = httpStatus
  }
}

/** A well-formed success that lacks the one field the call exists to obtain. Never retried, never outcome-unknown. */
export class FeishuIncompleteResponseError extends Error {
  readonly reason: string
  readonly code: number | null

  constructor(reason: string, code: number | null = null) {
    super(`Feishu returned a response without the expected data${code === null ? '' : ` (code ${code})`}`)
    this.name = 'FeishuIncompleteResponseError'
    this.reason = reason
    this.code = code
  }
}

/** The application credentials are not usable: the tenant token had to be re-minted more often than a run allows. */
export class FeishuCredentialError extends Error {
  constructor() {
    super('Feishu rejected the application credentials')
    this.name = 'FeishuCredentialError'
  }
}

/** A request target outside the closed host set (or with user information, or another scheme). No request was made. */
export class FeishuHostNotAllowedError extends Error {
  constructor() {
    super('The request target is not an allowed Feishu host')
    this.name = 'FeishuHostNotAllowedError'
  }
}

export const FEISHU_ID_TYPES = Object.freeze(['open_id', 'union_id', 'user_id', 'open_department_id', 'department_id'] as const)
export type FeishuIdType = (typeof FEISHU_ID_TYPES)[number]

/** A Feishu identifier was built without a connection, without a type, or with a value that is not visible ASCII of 1-128 characters. */
export class FeishuIdRefError extends Error {
  readonly code = 'FEISHU_ID_INVALID' as const

  constructor() {
    super('A Feishu identifier needs a connection, a known type and a visible ASCII value of at most 128 characters')
    this.name = 'FeishuIdRefError'
  }
}

/** An identifier issued by one connection was presented with another connection's credentials. */
export class FeishuIdConnectionMismatchError extends Error {
  readonly code = 'FEISHU_ID_CONNECTION_MISMATCH' as const

  constructor() {
    super('The Feishu identifier belongs to a different connection')
    this.name = 'FeishuIdConnectionMismatchError'
  }
}

/** The numeric `code` of an envelope or error body (a number, or a string that holds one); null when absent. */
export function readFeishuCode(body: unknown): number | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const value = (body as Record<string, unknown>).code
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) return Number(value)
  return null
}

/** Rate-limit code carried in a body (the HTTP status is 429 on most endpoints and 400 on some older ones). */
export const FEISHU_FLOW_CONTROL_CODE = 99991400

/** Codes that mean the tenant access token itself was refused. */
export const FEISHU_TOKEN_INVALID_CODES: ReadonlySet<number> = new Set([99991661, 99991663, 99991664, 99991665, 99991671, 20013])

export function isFeishuTokenInvalidCode(code: number): boolean {
  return FEISHU_TOKEN_INVALID_CODES.has(code)
}

export function isFeishuTokenInvalidError(error: unknown): boolean {
  return error instanceof FeishuBusinessError && FEISHU_TOKEN_INVALID_CODES.has(error.code)
}

const outcomeUnknownErrors = new WeakSet<object>()

/** Send tier: the request may have been executed although no usable answer was seen. */
export function isFeishuOutcomeUnknown(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (outcomeUnknownErrors.has(error)) return true
  return (error as { outcomeUnknown?: unknown }).outcomeUnknown === true
}

export function markFeishuOutcomeUnknown(error: unknown): void {
  if (typeof error !== 'object' || error === null) return
  outcomeUnknownErrors.add(error)
  try {
    Object.defineProperty(error, 'outcomeUnknown', { value: true, enumerable: true, configurable: true })
  } catch {
    // a frozen error: the WeakSet still answers isFeishuOutcomeUnknown
  }
}

export interface FeishuFailureCode {
  code: number
  kind: 'code' | 'http_status'
}

/** The one numeric code a typed Feishu failure carries, for reports; undefined for anything else. */
export function feishuFailureCode(error: unknown): FeishuFailureCode | undefined {
  if (error instanceof FeishuBusinessError) return { code: error.code, kind: 'code' }
  if (error instanceof FeishuRequestError) return { code: error.statusCode, kind: 'http_status' }
  if (error instanceof FeishuMalformedResponseError) return { code: error.httpStatus, kind: 'http_status' }
  if (error instanceof FeishuIncompleteResponseError && error.code !== null) return { code: error.code, kind: 'code' }
  return undefined
}

/**
 * The sentence an administrator-facing or persisted surface may carry for a caught failure: the caller's
 * fixed sentence plus one explanation written here and, where the failure has one, its numeric code.
 * Anything that is not a typed Feishu failure yields the fixed sentence alone, never the error's text.
 */
export function describeFeishuFailure(error: unknown, fallback: string): string {
  if (error instanceof FeishuRequestError) return `${fallback}: Feishu answered with an error status (HTTP ${error.statusCode})`
  if (error instanceof FeishuBusinessError) return `${fallback}: Feishu rejected the request (code ${error.code})`
  if (error instanceof FeishuIncompleteResponseError) {
    return `${fallback}: Feishu returned a response without the expected data${error.code === null ? '' : ` (code ${error.code})`}`
  }
  if (error instanceof FeishuMalformedResponseError) return `${fallback}: Feishu returned an unusable response (HTTP ${error.httpStatus})`
  if (error instanceof FeishuTimeoutError) return `${fallback}: Feishu did not answer in time`
  if (error instanceof FeishuCredentialError) return 'Feishu rejected the application credentials'
  return fallback
}
