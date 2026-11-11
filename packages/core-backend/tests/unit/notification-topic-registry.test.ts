import { describe, expect, it } from 'vitest'
import { TASK_REMINDER_SCAN_WINDOW_MS } from '../../src/tasks/task-reminders'
import {
  NOTIFICATION_TOPICS,
  isNotificationTopic,
  listNotificationTopics,
  resolveNotificationTopic,
} from '../../src/notifications/topic-registry'

describe('notification topic registry', () => {
  it('has exactly the task_reminder topic', () => {
    expect([...NOTIFICATION_TOPICS]).toEqual(['task_reminder'])
    expect(listNotificationTopics().map((descriptor) => descriptor.topic)).toEqual(['task_reminder'])
  })

  it('pins the production descriptor', () => {
    const descriptor = resolveNotificationTopic('task_reminder')
    expect(descriptor).toEqual({
      topic: 'task_reminder',
      integrated: false,
      mandatory: false,
      freshnessWindowMs: TASK_REMINDER_SCAN_WINDOW_MS,
      quietHours: 'suppress',
      profiles: { dingtalk: { transport: 'work_notification' } },
    })
  })

  it('never overrides a personal preference and only suppresses in quiet hours', () => {
    for (const descriptor of listNotificationTopics()) {
      expect(descriptor.mandatory).toBe(false)
      expect(descriptor.quietHours).toBe('suppress')
    }
  })

  it('is frozen', () => {
    const descriptor = resolveNotificationTopic('task_reminder')!
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(Object.isFrozen(descriptor.profiles)).toBe(true)
  })

  it('answers null for any topic outside the closed set', () => {
    for (const topic of ['', 'task_event', 'TASK_REMINDER', 'constructor', '__proto__', 'task_reminder ']) {
      expect(resolveNotificationTopic(topic), topic).toBeNull()
      expect(isNotificationTopic(topic), topic).toBe(false)
    }
    expect(isNotificationTopic(undefined)).toBe(false)
    expect(isNotificationTopic(7)).toBe(false)
    expect(isNotificationTopic('task_reminder')).toBe(true)
  })
})
