import { maskDingTalkWebhookUrl } from '../integrations/dingtalk/runtime-policy'
import type { DingTalkGroupDestination } from './dingtalk-group-destinations'

export type DingTalkGroupDestinationResponse = Omit<DingTalkGroupDestination, 'secret'> & {
  hasSecret: boolean
}

export function toDingTalkGroupDestinationResponse(
  destination: DingTalkGroupDestination,
): DingTalkGroupDestinationResponse {
  const { secret: _secret, ...rest } = destination
  return {
    ...rest,
    // DT-HARDEN-03 P3: an unreadable row's webhookUrl is the empty-string placeholder
    // set in rowToDestination, never the raw `enc:` ciphertext — maskDingTalkWebhookUrl
    // passes non-URL strings through verbatim, so masking alone would leak it.
    webhookUrl: maskDingTalkWebhookUrl(destination.webhookUrl),
    hasSecret: Boolean(destination.secret),
  }
}
