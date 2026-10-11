/**
 * Task notification pipeline switches (design lock §10 P1 flags; M4 PR-3b design
 * `docs/development/task-m4-pr3b-backend-design-20261001.md` §9).
 *
 * Three independent env reads. Each is on only when its value is the exact string 'true' (no
 * trimming, no case folding), the same predicate shape as `src/tasks/feature-flag.ts#isTasksEnabled`;
 * default OFF. Each switch is read where it takes effect: the scheduler and the delivery worker read
 * at start-up, the producer reads on every call. The environment is not changed while the process
 * runs, so the two read times agree.
 *
 * `TASKS_ENABLED` is not read here. The start-up site combines it with the scheduler switch
 * (ASSUMPTION(task-m4): [own-3b-06]); the producer is reached only through mounted task routes,
 * which already required it.
 *
 * ASSUMPTION(task-m4): [own-3b-01] the derived pipeline predicate is the conjunction of the three
 * switches; the producer and the two scans write outbox rows only while it holds. [D3] the scheduler
 * interval is a numeric knob, not a switch: default 60 000 ms, clamped to
 * [5 000 ms, TASK_REMINDER_SCAN_WINDOW_MS / 2] ([own-3b-39]: half the scan window, so that after
 * one missed tick the next tick's window still holds every moment that fell more than twice the
 * timer lateness after the tick before it).
 */
import { TASK_NOTIFICATION_CHANNEL_DINGTALK, type TaskNotificationChannel } from '../tasks/task-notifications'
import { TASK_REMINDER_SCAN_WINDOW_MS } from '../tasks/task-reminders'

/** Scheduler loop switch (design §6). Read once at start-up. */
export function isTasksSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TASKS_SCHEDULER_ENABLED === 'true'
}

/** Delivery worker switch (design §7). Read once at start-up. */
export function isTaskNotificationDeliveryWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED === 'true'
}

/** DingTalk work-notification channel switch (design §8). Read once at start-up. */
export function isTaskDingTalkWorkNotificationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED === 'true'
}

/**
 * The pipeline is on only when all three switches are on (design §5.1, §9.1). The producer and the
 * two scheduler scans call this on every invocation and write no rows while it is false.
 */
export function isTaskNotificationPipelineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTasksSchedulerEnabled(env)
    && isTaskNotificationDeliveryWorkerEnabled(env)
    && isTaskDingTalkWorkNotificationEnabled(env)
}

/**
 * Channel names the producer writes one outbox row per recipient for: the DingTalk channel while the
 * pipeline is on, nothing otherwise (design §5.1). M4 has one channel, so this is the single place
 * that changes when another is added.
 */
export function resolveTaskDeliveryChannelNames(env: NodeJS.ProcessEnv = process.env): TaskNotificationChannel[] {
  return isTaskNotificationPipelineEnabled(env) ? [TASK_NOTIFICATION_CHANNEL_DINGTALK] : []
}

/** Default scheduler tick interval (design §6.6, §9.1). */
export const TASK_SCHEDULER_INTERVAL_DEFAULT_MS = 60_000
/** Lower clamp of the tick interval (design §9.1). */
export const TASK_SCHEDULER_INTERVAL_MIN_MS = 5_000
/**
 * Upper clamp of the tick interval: half the reminder scan window W, so that W ≥ 2 × interval and,
 * after one missed tick, the next tick's window still holds every moment that fell more than twice
 * the timer lateness after the tick before it (design §6.2).
 */
export const TASK_SCHEDULER_INTERVAL_MAX_MS = TASK_REMINDER_SCAN_WINDOW_MS / 2

/**
 * `TASKS_SCHEDULER_INTERVAL_MS` as a number of milliseconds. The value must be a plain non-negative
 * integer after trimming (digits only; no sign, decimal point, exponent or unit); anything else,
 * including an unset or blank variable, reads as the default. The result is clamped to
 * [TASK_SCHEDULER_INTERVAL_MIN_MS, TASK_SCHEDULER_INTERVAL_MAX_MS], so 0 reads as the minimum.
 */
export function resolveTaskSchedulerIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TASKS_SCHEDULER_INTERVAL_MS
  if (typeof raw !== 'string') return TASK_SCHEDULER_INTERVAL_DEFAULT_MS
  const trimmed = raw.trim()
  if (!/^[0-9]+$/.test(trimmed)) return TASK_SCHEDULER_INTERVAL_DEFAULT_MS
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return TASK_SCHEDULER_INTERVAL_DEFAULT_MS
  return Math.min(Math.max(parsed, TASK_SCHEDULER_INTERVAL_MIN_MS), TASK_SCHEDULER_INTERVAL_MAX_MS)
}
