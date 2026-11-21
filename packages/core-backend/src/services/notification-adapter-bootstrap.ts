/** Composition boundary: the notification adapter reuses the task channel's exact pure functions. */
import { DingTalkWorkNotificationAdapter } from '../notifications/adapters'
import { registerNotificationAdapter } from '../notifications/adapters/notification-adapter'
import { classifyTaskDingTalkSendError, normalizeTaskDingTalkBaseUrl } from './task-notification-dingtalk'

registerNotificationAdapter(new DingTalkWorkNotificationAdapter({
  normalizeBaseUrl: normalizeTaskDingTalkBaseUrl,
  classifySendError: classifyTaskDingTalkSendError,
}))
