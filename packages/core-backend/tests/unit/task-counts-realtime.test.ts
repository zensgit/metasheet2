/**
 * M4 PR-3c (design task-m4-pr3c-backend-design-20261008.md §4, §7.1): the send port and the
 * per-write signal collector of `tasks:counts-updated`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import { buildAuthenticatedUserRoom } from '../../src/services/CollabService'
import {
  resetTaskCountsBroadcasterForTests,
  setTaskCountsBroadcaster,
  TASK_COUNTS_UPDATED_EVENT,
  taskCountsSignal,
} from '../../src/services/task-counts-realtime'

type Sent = { room: string; event: string; payload: unknown }

function recorder(): { sent: Sent[] } {
  const sent: Sent[] = []
  setTaskCountsBroadcaster((room, event, payload) => {
    sent.push({ room, event, payload })
  })
  return { sent }
}

function rooms(sent: Sent[]): string[] {
  return sent.map((entry) => entry.room)
}

afterEach(() => {
  resetTaskCountsBroadcasterForTests()
})

describe('task counts signal: the send port', () => {
  it('the event name is tasks:counts-updated', () => {
    expect(TASK_COUNTS_UPDATED_EVENT).toBe('tasks:counts-updated')
  })

  it('the default port sends nothing and a publish with a noted change does not throw', () => {
    const counts = taskCountsSignal()
    counts.note({ before: ['usr_a'], after: ['usr_b'] })
    expect(() => counts.publish()).not.toThrow()
  })

  it('one send per recipient on the authenticated user room, with the event name and the empty payload', () => {
    const { sent } = recorder()
    const counts = taskCountsSignal()
    counts.note({ before: ['usr_a'], after: ['usr_b'] })
    counts.publish()
    expect(sent).toHaveLength(2)
    expect(rooms(sent)).toEqual([buildAuthenticatedUserRoom('usr_a'), buildAuthenticatedUserRoom('usr_b')])
    for (const entry of sent) {
      expect(entry.room.startsWith('auth-user:')).toBe(true)
      expect(entry.event).toBe('tasks:counts-updated')
      expect(JSON.stringify(entry.payload)).toBe('{}')
    }
  })

  it('every send gets its own payload object', () => {
    const { sent } = recorder()
    const counts = taskCountsSignal()
    counts.note({ before: ['usr_a', 'usr_b'], after: [] })
    counts.publish()
    expect(sent).toHaveLength(2)
    expect(sent[0].payload).not.toBe(sent[1].payload)
  })

  it('after the reset the port sends nothing again', () => {
    const { sent } = recorder()
    resetTaskCountsBroadcasterForTests()
    const counts = taskCountsSignal()
    counts.note({ before: ['usr_a'], after: ['usr_a'] })
    counts.publish()
    expect(sent).toHaveLength(0)
  })
})

describe('task counts signal: recipients', () => {
  it('nothing noted: publish sends nothing', () => {
    const { sent } = recorder()
    taskCountsSignal().publish()
    expect(sent).toHaveLength(0)
  })

  it('noted but never published: nothing is sent (note never sends)', () => {
    const { sent } = recorder()
    taskCountsSignal().note({ before: ['usr_a'], after: ['usr_b'] })
    expect(sent).toHaveLength(0)
  })

  it('a removed assignee (before only) is a recipient', () => {
    const { sent } = recorder()
    const counts = taskCountsSignal()
    counts.note({ before: ['usr_a'], after: [] })
    counts.publish()
    expect(rooms(sent)).toEqual([buildAuthenticatedUserRoom('usr_a')])
  })

  it('an added assignee (after only) is a recipient', () => {
    const { sent } = recorder()
    const counts = taskCountsSignal()
    counts.note({ before: [], after: ['usr_b'] })
    counts.publish()
    expect(rooms(sent)).toEqual([buildAuthenticatedUserRoom('usr_b')])
  })

  it('an assignee on both sides is sent once', () => {
    const { sent } = recorder()
    const counts = taskCountsSignal()
    counts.note({ before: ['usr_a', 'usr_b'], after: ['usr_b', 'usr_c'] })
    counts.publish()
    expect(rooms(sent)).toEqual(['usr_a', 'usr_b', 'usr_c'].map(buildAuthenticatedUserRoom))
  })

  it('empty sets on both sides: nothing is sent', () => {
    const { sent } = recorder()
    const counts = taskCountsSignal()
    counts.note({ before: [], after: [] })
    counts.publish()
    expect(sent).toHaveLength(0)
  })

  it('two notes in one write: the union of both, still one send per user (not only the last note)', () => {
    const { sent } = recorder()
    const counts = taskCountsSignal()
    counts.note({ before: ['usr_x'], after: [] })
    counts.note({ before: ['usr_a'], after: ['usr_a', 'usr_b'] })
    counts.publish()
    expect(rooms(sent)).toEqual(['usr_a', 'usr_b', 'usr_x'].map(buildAuthenticatedUserRoom))
  })

  it('a second publish sends nothing', () => {
    const { sent } = recorder()
    const counts = taskCountsSignal()
    counts.note({ before: ['usr_a'], after: ['usr_a'] })
    counts.publish()
    counts.publish()
    expect(sent).toHaveLength(1)
  })

  it('note does not keep a reference to the caller arrays', () => {
    const { sent } = recorder()
    const before = ['usr_a']
    const after = ['usr_a']
    const counts = taskCountsSignal()
    counts.note({ before, after })
    before.push('usr_x')
    after.push('usr_y')
    counts.publish()
    expect(rooms(sent)).toEqual([buildAuthenticatedUserRoom('usr_a')])
  })

  it('two writes, two collectors: each publishes its own recipients', () => {
    const { sent } = recorder()
    const first = taskCountsSignal()
    const second = taskCountsSignal()
    first.note({ before: ['usr_a'], after: [] })
    second.note({ before: [], after: ['usr_b'] })
    first.publish()
    expect(rooms(sent)).toEqual([buildAuthenticatedUserRoom('usr_a')])
    second.publish()
    expect(rooms(sent)).toEqual(['usr_a', 'usr_b'].map(buildAuthenticatedUserRoom))
  })
})

describe('task counts signal: failure isolation', () => {
  it('a send that throws for one user does not stop the others and publish does not throw', () => {
    const sent: string[] = []
    setTaskCountsBroadcaster((room) => {
      if (room === buildAuthenticatedUserRoom('usr_b')) throw new Error('socket down')
      sent.push(room)
    })
    const counts = taskCountsSignal()
    counts.note({ before: ['usr_a', 'usr_b'], after: ['usr_c'] })
    expect(() => counts.publish()).not.toThrow()
    expect(sent).toEqual(['usr_a', 'usr_c'].map(buildAuthenticatedUserRoom))
  })

  it('a send that returns a rejected promise is caught (no unhandled rejection)', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const sent: string[] = []
      setTaskCountsBroadcaster(((room: string) => {
        sent.push(room)
        return Promise.reject(new Error('async socket down'))
      }) as unknown as Parameters<typeof setTaskCountsBroadcaster>[0])
      const counts = taskCountsSignal()
      counts.note({ before: ['usr_a'], after: ['usr_b'] })
      expect(() => counts.publish()).not.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(sent).toEqual(['usr_a', 'usr_b'].map(buildAuthenticatedUserRoom))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

/**
 * Everything the logger received, with each error's own properties written out: `JSON.stringify`
 * alone renders an error as `{}`, since its message and stack are not enumerable.
 */
function loggedText(calls: unknown[][]): string {
  return JSON.stringify(calls, (_key, value: unknown) => {
    if (!(value instanceof Error)) return value
    const own: Record<string, unknown> = { name: value.name }
    for (const key of Object.getOwnPropertyNames(value)) own[key] = (value as unknown as Record<string, unknown>)[key]
    return own
  })
}

/** The one log line a failed send writes: a fixed message and a fixed code, nothing from the error. */
const SEND_FAILED_LOG_LINE = ['task counts signal not sent', { code: 'TASK_COUNTS_SEND_FAILED' }]

/** An error whose `code` and `name` getters throw: a log line that reads either one throws instead. */
function errorWithThrowingGetters(): Error {
  const error = new Error('MARKER getter send failure text')
  for (const key of ['code', 'name']) {
    Object.defineProperty(error, key, {
      get() {
        throw new Error(`the ${key} getter of the send failure was read`)
      },
    })
  }
  return error
}

/** A send that fails by throwing, or by returning a promise that rejects. */
const FAILING_SENDS: Array<[string, (error: Error) => unknown]> = [
  ['thrown', (error) => {
    throw error
  }],
  ['rejected', (error) => Promise.reject(error)],
]

describe('task counts signal: the failure log line is the fixed code alone', () => {
  it('a send that throws: one warn, exactly the fixed message and the fixed code, and nothing of the error is logged', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    try {
      const failure = Object.assign(new Error('MARKER sync send failure text'), { code: 'MARKER_SYNC_CODE' })
      setTaskCountsBroadcaster(() => {
        throw failure
      })
      const counts = taskCountsSignal()
      counts.note({ before: ['usr_a'], after: [] })
      expect(() => counts.publish()).not.toThrow()
      expect(loggedText(warn.mock.calls)).not.toContain('MARKER')
      expect(warn.mock.calls).toStrictEqual([SEND_FAILED_LOG_LINE])
    } finally {
      warn.mockRestore()
    }
  })

  it('a send whose promise rejects: one warn, exactly the fixed message and the fixed code, and nothing of the error is logged', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    try {
      setTaskCountsBroadcaster((() => Promise.reject(
        Object.assign(new TypeError('MARKER async send failure text'), { code: 'MARKER_ASYNC_CODE' }),
      )) as unknown as Parameters<typeof setTaskCountsBroadcaster>[0])
      const counts = taskCountsSignal()
      counts.note({ before: [], after: ['usr_b'] })
      expect(() => counts.publish()).not.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(loggedText(warn.mock.calls)).not.toContain('MARKER')
      expect(warn.mock.calls).toStrictEqual([SEND_FAILED_LOG_LINE])
    } finally {
      warn.mockRestore()
    }
  })

  it.each(FAILING_SENDS)('an error whose code and name getters throw, %s: the send path does not throw, the other recipient is still sent, no unhandled rejection, and the log line is the fixed code', async (_mode, fail) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const unhandled = vi.fn()
    // Prepended, not appended: Vitest's own listener reads the rejection reason's `name`, which
    // throws for this error, and an emit stops at the first listener that throws, so a listener
    // added after Vitest's never sees a rejection whose reason is this error. Only the call count
    // is asserted: printing the calls would read the getters as well.
    process.prependListener('unhandledRejection', unhandled)
    try {
      const sent: string[] = []
      setTaskCountsBroadcaster(((room: string) => {
        if (room === buildAuthenticatedUserRoom('usr_a')) return fail(errorWithThrowingGetters())
        sent.push(room)
        return undefined
      }) as unknown as Parameters<typeof setTaskCountsBroadcaster>[0])
      const counts = taskCountsSignal()
      counts.note({ before: ['usr_a'], after: ['usr_b'] })
      expect(() => counts.publish()).not.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(sent).toEqual([buildAuthenticatedUserRoom('usr_b')])
      expect(unhandled).toHaveBeenCalledTimes(0)
      expect(warn.mock.calls).toStrictEqual([SEND_FAILED_LOG_LINE])
    } finally {
      process.off('unhandledRejection', unhandled)
      warn.mockRestore()
    }
  })
})
