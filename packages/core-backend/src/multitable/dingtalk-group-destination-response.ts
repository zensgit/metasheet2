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
    webhookUrl: maskDingTalkWebhookUrl(destination.webhookUrl),
    hasSecret: Boolean(destination.secret),
  }
}
