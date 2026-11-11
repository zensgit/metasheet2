/**
 * WeCom directory adapter: typed failures and the adapter-level failure-text hook.
 *
 * Every class extends `Error` directly and passes a developer-authored literal to `super`; none
 * carries provider text, a response body, a URL or a credential. `weComDirectoryFailureText` is a
 * pure function of the class identity and of the numeric `errcode` / `statusCode` / `count` fields:
 * it never reads `message`, and for a value it does not recognise it returns `null`.
 */
import {
  WeComBusinessError,
  WeComIncompleteResponseError,
  WeComInvalidInputError,
  WeComRequestError,
  WeComTimeoutError,
  WeComTransportError,
} from '../../integrations/wecom/client'

export const WECOM_DIRECTORY_FAILURE_SENTENCES = {
  scopeUnacknowledged:
    'The WeCom app visible scope has not been confirmed; verify and confirm it before pulling',
  scopeChanged:
    'The WeCom app visible scope differs from the confirmed one (or changed during the pull); review it and confirm again',
  appClosed: 'The WeCom app is disabled',
  appTypeUnsupported: 'The WeCom app type is not supported (only in-house self-built apps are supported)',
  scopeKindUnsupported:
    'The WeCom app visible scope includes members or tags; only a department-based visible scope is supported',
  rootDepartmentNotVisible: 'The configured root department is not visible to the WeCom app',
  incompleteResponse: 'WeCom returned incomplete data; nothing was written this round',
  memberShapeViolation:
    'Too many member identifiers do not follow the allowed format; nothing was written this round',
  pullTooLarge: 'The organization exceeds the per-round size limit',
  businessRejected: 'WeCom rejected the request',
  requestStatus: 'WeCom answered with an error status',
  timeout: 'WeCom did not answer in time',
  transport: 'WeCom could not be reached',
  invalidInput: 'The WeCom connection settings are invalid',
} as const

export class WeComScopeUnacknowledgedError extends Error {
  constructor() {
    super(WECOM_DIRECTORY_FAILURE_SENTENCES.scopeUnacknowledged)
    this.name = 'WeComScopeUnacknowledgedError'
  }
}

export class WeComScopeChangedError extends Error {
  constructor() {
    super(WECOM_DIRECTORY_FAILURE_SENTENCES.scopeChanged)
    this.name = 'WeComScopeChangedError'
  }
}

export class WeComAppClosedError extends Error {
  constructor() {
    super(WECOM_DIRECTORY_FAILURE_SENTENCES.appClosed)
    this.name = 'WeComAppClosedError'
  }
}

export class WeComAppTypeUnsupportedError extends Error {
  constructor() {
    super(WECOM_DIRECTORY_FAILURE_SENTENCES.appTypeUnsupported)
    this.name = 'WeComAppTypeUnsupportedError'
  }
}

export class WeComScopeKindUnsupportedError extends Error {
  constructor() {
    super(WECOM_DIRECTORY_FAILURE_SENTENCES.scopeKindUnsupported)
    this.name = 'WeComScopeKindUnsupportedError'
  }
}

export class WeComRootDepartmentNotVisibleError extends Error {
  constructor() {
    super(WECOM_DIRECTORY_FAILURE_SENTENCES.rootDepartmentNotVisible)
    this.name = 'WeComRootDepartmentNotVisibleError'
  }
}

export class WeComMemberShapeViolationError extends Error {
  /** Number of distinct member identifiers that were isolated. */
  readonly count: number

  constructor(count: number) {
    super(WECOM_DIRECTORY_FAILURE_SENTENCES.memberShapeViolation)
    this.name = 'WeComMemberShapeViolationError'
    this.count = count
  }
}

export class WeComPullTooLargeError extends Error {
  constructor() {
    super(WECOM_DIRECTORY_FAILURE_SENTENCES.pullTooLarge)
    this.name = 'WeComPullTooLargeError'
  }
}

export interface WeComDirectoryFailureText {
  text: string
  providerCode?: number
  providerCodeKind?: 'errcode' | 'http_status'
}

function readNumericField(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'number' && Number.isSafeInteger(field) ? field : undefined
}

/** The adapter-level failure text for a caught value, or `null` when the value is not one of ours. */
export function weComDirectoryFailureText(error: unknown): WeComDirectoryFailureText | null {
  if (error instanceof WeComScopeUnacknowledgedError) return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.scopeUnacknowledged }
  if (error instanceof WeComScopeChangedError) return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.scopeChanged }
  if (error instanceof WeComAppClosedError) return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.appClosed }
  if (error instanceof WeComAppTypeUnsupportedError) return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.appTypeUnsupported }
  if (error instanceof WeComScopeKindUnsupportedError) return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.scopeKindUnsupported }
  if (error instanceof WeComRootDepartmentNotVisibleError) {
    return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.rootDepartmentNotVisible }
  }
  if (error instanceof WeComPullTooLargeError) return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.pullTooLarge }
  if (error instanceof WeComMemberShapeViolationError) {
    const count = readNumericField(error, 'count')
    const base = WECOM_DIRECTORY_FAILURE_SENTENCES.memberShapeViolation
    return { text: count === undefined ? base : `${base} (${count} isolated)` }
  }
  if (error instanceof WeComIncompleteResponseError) return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.incompleteResponse }
  if (error instanceof WeComInvalidInputError) return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.invalidInput }
  if (error instanceof WeComTransportError) return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.transport }
  if (error instanceof WeComTimeoutError) return { text: WECOM_DIRECTORY_FAILURE_SENTENCES.timeout }
  if (error instanceof WeComBusinessError) {
    const code = readNumericField(error, 'errcode')
    const base = WECOM_DIRECTORY_FAILURE_SENTENCES.businessRejected
    return code === undefined
      ? { text: base }
      : { text: `${base} (errcode ${code})`, providerCode: code, providerCodeKind: 'errcode' }
  }
  if (error instanceof WeComRequestError) {
    const status = readNumericField(error, 'statusCode')
    const base = WECOM_DIRECTORY_FAILURE_SENTENCES.requestStatus
    return status === undefined
      ? { text: base }
      : { text: `${base} (HTTP ${status})`, providerCode: status, providerCodeKind: 'http_status' }
  }
  return null
}
