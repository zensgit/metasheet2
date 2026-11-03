import { describe, expect, it } from 'vitest'

import { isTasksEnabled } from '../../src/tasks/feature-flag'
import { TASK_NOTIFICATION_CHANNEL_DINGTALK } from '../../src/tasks/task-notifications'
import { TASK_REMINDER_SCAN_WINDOW_MS } from '../../src/tasks/task-reminders'
import {
  TASK_SCHEDULER_INTERVAL_DEFAULT_MS,
  TASK_SCHEDULER_INTERVAL_MAX_MS,
  TASK_SCHEDULER_INTERVAL_MIN_MS,
  isTaskDingTalkWorkNotificationEnabled,
  isTaskNotificationDeliveryWorkerEnabled,
  isTaskNotificationPipelineEnabled,
  isTasksSchedulerEnabled,
  resolveTaskDeliveryChannelNames,
  resolveTaskSchedulerIntervalMs,
} from '../../src/services/task-notification-flags'

/**
 * M4 PR-3b S0 (design §9): three default-OFF switches, each the exact string 'true' only, the same
 * predicate shape as the TASKS_ENABLED read pinned by tests/unit/tasks-feature-flag.test.ts; a
 * derived pipeline predicate; the registered channel-name list; the scheduler interval knob.
 */

const SCHEDULER = 'TASKS_SCHEDULER_ENABLED'
const WORKER = 'TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED'
const DINGTALK = 'TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED'
const INTERVAL = 'TASKS_SCHEDULER_INTERVAL_MS'
const MASTER = 'TASKS_ENABLED'
const TASK_ENV_KEYS = [SCHEDULER, WORKER, DINGTALK, INTERVAL, MASTER] as const
type TaskEnvKey = (typeof TASK_ENV_KEYS)[number]

/** Same value table as tests/unit/tasks-feature-flag.test.ts: only the exact string 'true' is on. */
const VALUE_CASES: ReadonlyArray<readonly [string, string | undefined, boolean]> = [
  ['unset', undefined, false],
  ['empty', '', false],
  ['TRUE', 'TRUE', false],
  ['1', '1', false],
  ['leading space', ' true', false],
  ['trailing space', 'true ', false],
  ['false', 'false', false],
  ['exact true', 'true', true],
]

const READERS: ReadonlyArray<readonly [TaskEnvKey, (env?: NodeJS.ProcessEnv) => boolean]> = [
  [SCHEDULER, isTasksSchedulerEnabled],
  [WORKER, isTaskNotificationDeliveryWorkerEnabled],
  [DINGTALK, isTaskDingTalkWorkNotificationEnabled],
]

const SWITCHES = [SCHEDULER, WORKER, DINGTALK] as const

function envWith(values: Partial<Record<TaskEnvKey, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(values)) if (value !== undefined) env[key] = value
  return env
}

const ALL_ON = envWith({ [SCHEDULER]: 'true', [WORKER]: 'true', [DINGTALK]: 'true' })

/** Runs `run` with the five task keys set as given on process.env (undefined = deleted), then restores them. */
function withProcessEnv(values: Partial<Record<TaskEnvKey, string | undefined>>, run: () => void): void {
  const saved = TASK_ENV_KEYS.map(
    (key) => [key, Object.prototype.hasOwnProperty.call(process.env, key), process.env[key]] as const,
  )
  try {
    for (const key of TASK_ENV_KEYS) {
      const value = values[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    run()
  } finally {
    for (const [key, had, previous] of saved) {
      if (had) process.env[key] = previous
      else delete process.env[key]
    }
  }
}

describe('task notification flags — defaults', () => {
  it('an empty environment: every switch off, pipeline off, no channel, interval 60 000 ms', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(isTasksSchedulerEnabled(env)).toBe(false)
    expect(isTaskNotificationDeliveryWorkerEnabled(env)).toBe(false)
    expect(isTaskDingTalkWorkNotificationEnabled(env)).toBe(false)
    expect(isTaskNotificationPipelineEnabled(env)).toBe(false)
    expect(resolveTaskDeliveryChannelNames(env)).toEqual([])
    expect(resolveTaskSchedulerIntervalMs(env)).toBe(60_000)
  })

  it('process.env with none of the task keys set (the default parameter) gives the same defaults', () => {
    withProcessEnv({}, () => {
      expect(isTasksSchedulerEnabled()).toBe(false)
      expect(isTaskNotificationDeliveryWorkerEnabled()).toBe(false)
      expect(isTaskDingTalkWorkNotificationEnabled()).toBe(false)
      expect(isTaskNotificationPipelineEnabled()).toBe(false)
      expect(resolveTaskDeliveryChannelNames()).toEqual([])
      expect(resolveTaskSchedulerIntervalMs()).toBe(60_000)
    })
  })
})

describe('task notification flags — each switch is the exact string true', () => {
  describe.each(READERS)('%s', (key, read) => {
    it.each(VALUE_CASES)('%s (%j) reads %s, the same as isTasksEnabled for that value', (_label, value, expected) => {
      expect(read(envWith({ [key]: value }))).toBe(expected)
      expect(read(envWith({ [key]: value }))).toBe(isTasksEnabled(envWith({ [MASTER]: value })))
    })

    it('reads only its own key: the other two switches on do not turn it on', () => {
      const others = SWITCHES.filter((other) => other !== key)
      const env = envWith({ [others[0]]: 'true', [others[1]]: 'true' })
      expect(read(env)).toBe(false)
      expect(read(envWith({ [key]: 'true' }))).toBe(true)
    })

    it('the default parameter reads process.env', () => {
      withProcessEnv({ [key]: 'true' }, () => expect(read()).toBe(true))
      withProcessEnv({ [key]: 'TRUE' }, () => expect(read()).toBe(false))
      withProcessEnv({ [key]: ' true' }, () => expect(read()).toBe(false))
    })
  })
})

describe('task notification flags — pipeline predicate and channel names', () => {
  const COMBINATIONS: Array<[string | undefined, string | undefined, string | undefined]> = []
  for (const s of ['true', undefined] as const) {
    for (const w of ['true', undefined] as const) {
      for (const d of ['true', undefined] as const) COMBINATIONS.push([s, w, d])
    }
  }

  it.each(COMBINATIONS)('scheduler=%j worker=%j dingtalk=%j: on only when all three are true', (s, w, d) => {
    const env = envWith({ [SCHEDULER]: s, [WORKER]: w, [DINGTALK]: d })
    const expected = s === 'true' && w === 'true' && d === 'true'
    expect(isTaskNotificationPipelineEnabled(env)).toBe(expected)
    expect(resolveTaskDeliveryChannelNames(env)).toEqual(expected ? ['dingtalk_work_notification'] : [])
  })

  it.each(SWITCHES)('a near-miss value (TRUE) in %s turns the pipeline off', (key) => {
    const env = { ...ALL_ON, [key]: 'TRUE' }
    expect(isTaskNotificationPipelineEnabled(env)).toBe(false)
    expect(resolveTaskDeliveryChannelNames(env)).toEqual([])
  })

  it('TASKS_ENABLED is not part of the pipeline predicate (design §5.1): three switches on, master unset, is on', () => {
    expect(ALL_ON[MASTER]).toBeUndefined()
    expect(isTaskNotificationPipelineEnabled(ALL_ON)).toBe(true)
    expect(isTaskNotificationPipelineEnabled({ ...ALL_ON, [MASTER]: 'false' })).toBe(true)
  })

  it('the channel name is the task line constant and the literal the outbox channel column carries', () => {
    expect(TASK_NOTIFICATION_CHANNEL_DINGTALK).toBe('dingtalk_work_notification')
    expect(resolveTaskDeliveryChannelNames(ALL_ON)).toEqual([TASK_NOTIFICATION_CHANNEL_DINGTALK])
    expect(resolveTaskDeliveryChannelNames(ALL_ON)).toHaveLength(1)
  })

  it('the default parameter reads process.env', () => {
    withProcessEnv({ [SCHEDULER]: 'true', [WORKER]: 'true', [DINGTALK]: 'true' }, () => {
      expect(isTaskNotificationPipelineEnabled()).toBe(true)
      expect(resolveTaskDeliveryChannelNames()).toEqual(['dingtalk_work_notification'])
    })
    withProcessEnv({ [SCHEDULER]: 'true', [WORKER]: 'true' }, () => {
      expect(isTaskNotificationPipelineEnabled()).toBe(false)
      expect(resolveTaskDeliveryChannelNames()).toEqual([])
    })
  })
})

describe('task notification flags — scheduler interval knob', () => {
  it('constants: default 60 000, minimum 5 000, maximum = half the reminder scan window (1 h)', () => {
    expect(TASK_SCHEDULER_INTERVAL_DEFAULT_MS).toBe(60_000)
    expect(TASK_SCHEDULER_INTERVAL_MIN_MS).toBe(5_000)
    expect(TASK_SCHEDULER_INTERVAL_MAX_MS).toBe(TASK_REMINDER_SCAN_WINDOW_MS / 2)
    expect(TASK_SCHEDULER_INTERVAL_MAX_MS).toBe(3_600_000)
    // One missed tick plus timer lateness still lands inside the window (design §6.2).
    expect(2 * TASK_SCHEDULER_INTERVAL_MAX_MS).toBeLessThanOrEqual(TASK_REMINDER_SCAN_WINDOW_MS)
    expect(TASK_SCHEDULER_INTERVAL_MIN_MS).toBeLessThan(TASK_SCHEDULER_INTERVAL_DEFAULT_MS)
    expect(TASK_SCHEDULER_INTERVAL_DEFAULT_MS).toBeLessThan(TASK_SCHEDULER_INTERVAL_MAX_MS)
  })

  const INTERVAL_CASES: ReadonlyArray<readonly [string, string | undefined, number]> = [
    ['unset', undefined, 60_000],
    ['empty', '', 60_000],
    ['blank', '   ', 60_000],
    ['letters', 'abc', 60_000],
    ['negative', '-1', 60_000],
    ['decimal', '1.5', 60_000],
    ['exponent', '1e3', 60_000],
    ['hex', '0x10', 60_000],
    ['signed', '+5000', 60_000],
    ['unit suffix', '5000ms', 60_000],
    ['beyond safe integer', '99999999999999999999', 60_000],
    ['zero clamps to the minimum', '0', 5_000],
    ['below the minimum', '4999', 5_000],
    ['at the minimum', '5000', 5_000],
    ['in range, trimmed', ' 30000 ', 30_000],
    ['the default spelled out', '60000', 60_000],
    ['at the maximum (W/2)', '3600000', 3_600_000],
    ['above the maximum clamps to W/2', '3600001', 3_600_000],
    ['the window itself clamps to W/2', '7200000', 3_600_000],
    ['far above the maximum clamps to W/2', '86400000', 3_600_000],
  ]

  it.each(INTERVAL_CASES)('%s (%j) resolves to %d', (_label, value, expected) => {
    expect(resolveTaskSchedulerIntervalMs(envWith({ [INTERVAL]: value }))).toBe(expected)
  })

  it('the switches do not affect the interval and the interval does not affect the switches', () => {
    expect(resolveTaskSchedulerIntervalMs(ALL_ON)).toBe(60_000)
    const env = envWith({ [INTERVAL]: '30000' })
    expect(isTasksSchedulerEnabled(env)).toBe(false)
    expect(isTaskNotificationPipelineEnabled(env)).toBe(false)
  })

  it('the default parameter reads process.env', () => {
    withProcessEnv({ [INTERVAL]: '30000' }, () => expect(resolveTaskSchedulerIntervalMs()).toBe(30_000))
    withProcessEnv({ [INTERVAL]: 'soon' }, () => expect(resolveTaskSchedulerIntervalMs()).toBe(60_000))
  })
})
