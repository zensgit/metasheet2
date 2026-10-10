/**
 * R-41 (docs/development/takeover-beiliao-20260821/decision-register.md): what an admin-facing surface may say
 * about a caught failure.
 *
 * Admin HTTP bodies of ANY status, and failure text that is persisted and later shown or sent out
 * (`directory_sync_runs.error_message`, `directory_integrations.last_error`, `directory_sync_alerts.message` —
 * the alert is also delivered OUTBOUND to a DingTalk group — and the batch routes' `failed[].error`), never
 * carry provider (DingTalk), transport or database-driver text: that text can hold egress addresses, hosts,
 * ports, request ids and SQL fragments. This module maps a caught value to the text such a surface may carry:
 *
 *  - an instance of one of the caller's FIXED-SENTENCE classes — developer-authored sentences thrown typed
 *    (DirectoryValidationError, DingTalkConfigValidationError, …) — → its own message;
 *  - a typed DingTalk failure → the caller's fixed sentence plus ONE explanation written here, carrying only
 *    DingTalk's numeric code (the oapi `errcode`, or the HTTP status). Never `errmsg`, never the body, never
 *    the error's message: the messages of DingTalkBusinessError / DingTalkRequestError /
 *    DingTalkIncompleteResponseError are provider text;
 *  - anything else — driver, transport, unknown, not an Error at all — → the caller's fixed sentence.
 *
 * Pure: no I/O, no logging, no reads of anything but the fields named above. Callers log the original text
 * themselves (the server log is where troubleshooting finds it, by error code). For a value it does not
 * recognise it never returns any of that value's text.
 */
import {
  DingTalkBusinessError,
  DingTalkIncompleteResponseError,
  DingTalkMalformedResponseError,
  DingTalkRequestError,
  DingTalkTimeoutError,
  readNumericField,
} from '../integrations/dingtalk/transport'

/** An error class whose message is, by its contract, a developer-authored sentence (R-41 rule 3). */
export type FixedSentenceErrorClass = abstract new (...args: never[]) => Error

export type FailureTextKind = 'fixed_sentence' | 'provider' | 'fallback'

export interface FailureText {
  kind: FailureTextKind
  /** What the surface may carry. */
  text: string
  /** DingTalk's own numeric code, when the failure carried one. */
  providerCode?: number
  providerCodeKind?: 'errcode' | 'http_status'
}

export interface FailureTextOptions {
  /** The caller's fixed sentence for this operation — a literal at the call site, never derived from the error. */
  fallback: string
  /** Classes whose message may be shown as it is. Anything not listed is never shown. */
  fixedSentenceClasses?: readonly FixedSentenceErrorClass[]
}

/**
 * `instanceof` that tolerates a value that is not a constructor (`x instanceof undefined` throws): such an
 * entry simply matches nothing, which only ever makes the answer MORE conservative (the fixed sentence).
 * Note this does not protect module load: with vitest, a factory mock that omits an exported class makes
 * the import itself throw, and the allow-lists in admin-directory.ts / directory-sync.ts read their classes
 * at load time — a factory mock of a module they import must re-export every listed class.
 */
function isInstanceOf(value: unknown, ctor: unknown): boolean {
  return typeof ctor === 'function' && value instanceof (ctor as FixedSentenceErrorClass)
}

function readProviderCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function providerText(base: string, code: number | undefined, codeKind: 'errcode' | 'http_status'): FailureText {
  if (code === undefined) return { kind: 'provider', text: base }
  const label = codeKind === 'errcode' ? 'errcode' : 'HTTP'
  return { kind: 'provider', text: `${base} (${label} ${code})`, providerCode: code, providerCodeKind: codeKind }
}

function readEnvelopeCode(body: unknown): number | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  return readProviderCode(readNumericField(body as Record<string, unknown>, 'errcode', 'code'))
}

export function classifyDirectoryFailureText(error: unknown, options: FailureTextOptions): FailureText {
  const fallback = options.fallback

  for (const ctor of options.fixedSentenceClasses ?? []) {
    if (!isInstanceOf(error, ctor)) continue
    const message = (error as Error).message
    return typeof message === 'string' && message.trim().length > 0
      ? { kind: 'fixed_sentence', text: message }
      : { kind: 'fallback', text: fallback }
  }

  if (isInstanceOf(error, DingTalkBusinessError)) {
    return providerText(
      `${fallback}: DingTalk rejected the request`,
      readEnvelopeCode((error as DingTalkBusinessError).responseBody),
      'errcode',
    )
  }
  if (isInstanceOf(error, DingTalkRequestError)) {
    return providerText(
      `${fallback}: DingTalk answered with an error status`,
      readProviderCode((error as DingTalkRequestError).statusCode),
      'http_status',
    )
  }
  if (isInstanceOf(error, DingTalkIncompleteResponseError)) {
    return providerText(
      `${fallback}: DingTalk returned a response without the expected data`,
      readEnvelopeCode((error as DingTalkIncompleteResponseError).responseBody),
      'errcode',
    )
  }
  if (isInstanceOf(error, DingTalkMalformedResponseError)) {
    return providerText(
      `${fallback}: DingTalk returned an unusable response`,
      readProviderCode((error as DingTalkMalformedResponseError).httpStatus),
      'http_status',
    )
  }
  if (isInstanceOf(error, DingTalkTimeoutError)) {
    return { kind: 'provider', text: `${fallback}: DingTalk did not answer in time` }
  }

  return { kind: 'fallback', text: fallback }
}
