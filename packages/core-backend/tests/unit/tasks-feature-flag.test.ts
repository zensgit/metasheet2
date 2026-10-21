import { afterEach, describe, expect, it, vi } from 'vitest'

// tasksRouter() only builds an express Router; no query runs. The pool module is stubbed so that
// importing the route module does not reach for a database.
vi.mock('../../src/db/pg', () => ({ pool: null, query: vi.fn(), transaction: vi.fn() }))

import { isTasksEnabled } from '../../src/tasks/feature-flag'
import { tasksRouter } from '../../src/routes/tasks'

/**
 * The session feature `tasks` (what the web uses to show 任务, its badge and /tasks) and the
 * /api/tasks mount gate in routes/tasks.ts are two reads of TASKS_ENABLED. They must agree for
 * every value, or the web shows an entry whose API is not mounted (the defect seen after R61) or
 * hides one whose API is.
 */
const CASES: ReadonlyArray<readonly [string, string | undefined, boolean]> = [
  ['unset', undefined, false],
  ['empty', '', false],
  ['TRUE', 'TRUE', false],
  ['1', '1', false],
  ['leading space', ' true', false],
  ['trailing space', 'true ', false],
  ['false', 'false', false],
  ['exact true', 'true', true],
]

function withTasksEnv(value: string | undefined, run: () => void): void {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'TASKS_ENABLED')
  const previous = process.env.TASKS_ENABLED
  if (value === undefined) delete process.env.TASKS_ENABLED
  else process.env.TASKS_ENABLED = value
  try {
    run()
  } finally {
    if (had) process.env.TASKS_ENABLED = previous
    else delete process.env.TASKS_ENABLED
  }
}

describe('tasks feature flag (session features.tasks) agrees with the /api/tasks mount gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(CASES)('TASKS_ENABLED %s (%j): isTasksEnabled and tasksRouter() mounting are both %s', (_label, value, expected) => {
    expect(isTasksEnabled(value === undefined ? {} : { TASKS_ENABLED: value })).toBe(expected)
    withTasksEnv(value, () => {
      expect(isTasksEnabled()).toBe(expected)
      expect(tasksRouter() !== null).toBe(expected)
    })
  })
})
