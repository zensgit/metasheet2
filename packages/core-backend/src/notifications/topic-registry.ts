/**
 * Notification topic registry: the closed set of topics a user can set preferences for. Adding a topic
 * is one entry here plus the slice that connects that business to the routing chain.
 */
export const NOTIFICATION_TOPICS = ['task_reminder'] as const
export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number]

export interface NotificationTopicDescriptor {
  readonly topic: NotificationTopic
  /** Whether sending for this topic is connected to the routing chain. */
  readonly integrated: boolean
  /** Whether a personal preference may switch the topic off or silence it. Never overridden: always false. */
  readonly mandatory: false
  /** After this age an event is no longer sent to any target. */
  readonly freshnessWindowMs: number
  /** Only suppression is implemented: a reminder that falls due inside quiet hours is skipped, not delayed. */
  readonly quietHours: 'suppress'
  /** Providers allowed to route this topic, each with its transport. */
  readonly profiles: Readonly<Record<string, { readonly transport: string }>>
}

const TASK_REMINDER: NotificationTopicDescriptor = Object.freeze({
  topic: 'task_reminder',
  integrated: false,
  mandatory: false,
  freshnessWindowMs: 2 * 60 * 60 * 1000,
  quietHours: 'suppress',
  profiles: Object.freeze({ dingtalk: Object.freeze({ transport: 'work_notification' }) }),
})

const PRODUCTION_TOPICS: readonly NotificationTopicDescriptor[] = Object.freeze([TASK_REMINDER])

export function isNotificationTopic(value: unknown): value is NotificationTopic {
  return typeof value === 'string' && (NOTIFICATION_TOPICS as readonly string[]).includes(value)
}

export function listNotificationTopics(): readonly NotificationTopicDescriptor[] {
  return PRODUCTION_TOPICS
}

export function resolveNotificationTopic(topic: string): NotificationTopicDescriptor | null {
  return PRODUCTION_TOPICS.find((descriptor) => descriptor.topic === topic) ?? null
}
