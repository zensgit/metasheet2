import { FEISHU_ENDPOINTS, feishuEndpointUrl } from './endpoints'
import type { FeishuTenantTokenCredentials, FeishuTenantTokenService } from './token'
import { requestFeishuJson } from './transport'

/**
 * The Feishu message client: one text message to one recipient, sent on the `send` tier.
 *
 *  - Exactly one request is made per call to the transport, which never repeats a `send` request. The
 *    only replay is the tenant-token layer's single replay after the token itself was refused; the
 *    request body, including its `uuid`, is built once and is identical on both calls.
 *  - Only recipients of type `open_id` are addressed.
 *  - The result says WHERE a failure arose: while the tenant token was being obtained (no message was
 *    sent), or on the send request itself (the caller classifies it), or because the caller's signal had
 *    already aborted before any send request was made. The typed errors are handed back unchanged.
 *  - Nothing is logged here. A token, an identifier, the text and the `uuid` stay in memory.
 *
 * The wait for a token mint is not abortable by the caller's signal; only the send request is.
 */
export const FEISHU_MESSAGE_RECEIVE_ID_TYPE = 'open_id' as const

export interface FeishuTextMessageRequest {
  credentials: FeishuTenantTokenCredentials
  /** The recipient's open id, issued by the application of `credentials`. */
  receiveId: string
  text: string
  /** Request de-duplication key; the same value on every attempt of one send. */
  uuid: string
}

export interface FeishuMessageClientOptions {
  tokens: Pick<FeishuTenantTokenService, 'withTenantToken'>
  fetchFn?: typeof fetch
  /** Aborts the send request; checked before it is made. */
  signal?: AbortSignal
  /** Per-attempt timeout and wait hooks handed to the transport. */
  transport?: {
    timeoutMs?: number
    sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<boolean>
    random?: () => number
  }
}

export type FeishuTextMessageResult =
  /** The provider answered code 0; `messageId` is null when the answer carries no usable message id. */
  | { ok: true; messageId: string | null }
  /** The failure arose while obtaining the tenant token (or re-minting it) or on the send request. */
  | { ok: false; phase: 'token' | 'send'; error: unknown }
  /** The signal had aborted before any send request was made. */
  | { ok: false; phase: 'aborted' }

function messageIdOf(payload: Record<string, unknown>): string | null {
  const data = payload.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const id = (data as Record<string, unknown>).message_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

export async function sendFeishuTextMessage(
  options: FeishuMessageClientOptions,
  request: FeishuTextMessageRequest,
): Promise<FeishuTextMessageResult> {
  const url = feishuEndpointUrl(request.credentials.brand ?? 'feishu', FEISHU_ENDPOINTS.sendMessage, {
    receive_id_type: FEISHU_MESSAGE_RECEIVE_ID_TYPE,
  })
  // Built once: the replay after a refused token sends these exact bytes.
  const body = JSON.stringify({
    receive_id: request.receiveId,
    msg_type: 'text',
    content: JSON.stringify({ text: request.text }),
    uuid: request.uuid,
  })

  const abortedBeforeSend = new Error('send aborted before any request')
  let lastSendFailure: { error: unknown } | null = null

  const call = async (accessToken: string): Promise<Record<string, unknown>> => {
    if (options.signal?.aborted) {
      // After a request that was refused, the refusal is still the answer for this send.
      if (lastSendFailure !== null) throw lastSendFailure.error
      throw abortedBeforeSend
    }
    try {
      return await requestFeishuJson({
        url,
        init: {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
          body,
        },
        kind: 'send',
        envelope: 'open_api',
        fetchFn: options.fetchFn,
        signal: options.signal,
        timeoutMs: options.transport?.timeoutMs,
        sleep: options.transport?.sleep,
        random: options.transport?.random,
      })
    } catch (error) {
      lastSendFailure = { error }
      throw error
    }
  }

  try {
    const payload = await options.tokens.withTenantToken(request.credentials, call)
    return { ok: true, messageId: messageIdOf(payload) }
  } catch (error) {
    if (error === abortedBeforeSend) return { ok: false, phase: 'aborted' }
    const failure = lastSendFailure as { error: unknown } | null
    if (failure !== null && error === failure.error) return { ok: false, phase: 'send', error }
    return { ok: false, phase: 'token', error }
  }
}
