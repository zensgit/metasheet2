/** Internal comparison values only. Never include these results in a public report or an event. */
import type { DingTalkMessageConfig } from './client'
import { DingTalkMessageConfigError } from './config-validation-error'
import { readDingTalkIntegrationScopedMessageTuple, type DingTalkMessageTupleClient } from './work-notification-settings'
import { normalizeTaskDingTalkBaseUrl } from '../../services/task-notification-dingtalk'
import { isAllowedTaskDingTalkBaseUrl } from '../../tasks/task-delivery-protocol'
import { sha256Hex } from '../../notifications/witness'

export function notificationTupleFingerprint(config: DingTalkMessageConfig): { ok: true; value: string } | { ok: false; code: string } {
  const baseUrl = normalizeTaskDingTalkBaseUrl(config.baseUrl)
  if (!isAllowedTaskDingTalkBaseUrl(baseUrl)) return { ok: false, code: 'routed_base_url_rejected' }
  return {
    ok: true,
    value: sha256Hex('mx.notif.tuple.v1', {
      provider: 'dingtalk', appKey: config.appKey, agentId: config.agentId, baseUrl, secret: config.appSecret,
    }),
  }
}

export async function readNotificationTupleFingerprint(connectionId: string, client?: DingTalkMessageTupleClient) {
  if (!connectionId.trim()) return { ok: false as const, code: 'routed_credentials_unavailable' }
  try {
    const tuple = await readDingTalkIntegrationScopedMessageTuple(connectionId, client)
    return notificationTupleFingerprint(tuple.config)
  } catch (error) {
    if (!(error instanceof DingTalkMessageConfigError)) throw error
    return { ok: false as const, code: 'routed_credentials_unavailable' }
  }
}
