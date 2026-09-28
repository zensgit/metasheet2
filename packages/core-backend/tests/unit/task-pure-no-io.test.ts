/**
 * Gate 20 (task feature design lock §12): `src/tasks/` has no I/O.
 *
 * Behavioural check, not a grep. Every database entry point is replaced BEFORE any module is
 * imported (vi.mock is hoisted): the shared pool manager, its pool's `query` / `connect` /
 * `transaction`, and the `pg` driver's `Pool` / `Client`. Each throws a sentinel error with
 * `code === 'TASK_DB_STUB'`. The test then imports every file under `src/tasks/`, calls every
 * exported function with placeholder arguments (executor-shaped parameters get the stub `query`),
 * and fails if any call reaches the stub. A positive control proves the stub is live.
 */
import { readdirSync } from 'fs'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'

const STUB_CODE = 'TASK_DB_STUB'
function stubError(): Error {
  return Object.assign(new Error(STUB_CODE), { code: STUB_CODE })
}
const thrower = (): never => {
  throw stubError()
}
const asyncThrower = async (): Promise<never> => {
  throw stubError()
}

vi.mock('../../src/integration/db/connection-pool', () => {
  const internalPool = { query: asyncThrower, connect: asyncThrower, end: async () => undefined, on: () => undefined }
  const pool = {
    query: asyncThrower,
    transaction: asyncThrower,
    getInternalPool: () => internalPool,
    healthCheck: asyncThrower,
  }
  return { poolManager: { get: () => pool } }
})

vi.mock('pg', () => {
  class Pool {
    constructor() {
      thrower()
    }
  }
  class Client {
    constructor() {
      thrower()
    }
  }
  return { Pool, Client, default: { Pool, Client } }
})

const TASKS_DIR = path.resolve(__dirname, '../../src/tasks')

function isStubError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === STUB_CODE
}

/** Placeholder argument list: the stub query for executor-looking params, otherwise a harmless scalar. */
function placeholderArgs(fn: (...args: unknown[]) => unknown): unknown[] {
  const src = Function.prototype.toString.call(fn)
  const paramText = src.slice(src.indexOf('(') + 1, src.indexOf(')'))
  const names = paramText.split(',').map((p) => p.trim().split(/[\s=:]/)[0]).filter(Boolean)
  return names.map((name) => (/query|executor|client|db/i.test(name) ? asyncThrower : 'x'))
}

async function callAndClassify(fn: (...args: unknown[]) => unknown): Promise<'stub' | 'ok-or-other'> {
  try {
    const result = fn(...placeholderArgs(fn))
    if (result && typeof (result as Promise<unknown>).then === 'function') await result
    return 'ok-or-other'
  } catch (err) {
    return isStubError(err) ? 'stub' : 'ok-or-other'
  }
}

describe('gate 20 — src/tasks has no I/O (behavioural)', () => {
  const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith('.ts'))

  it('the scanned population is non-empty', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('positive control: the pg query entry point reaches the stub', async () => {
    const pg = await import('../../src/db/pg')
    await expect(pg.query('SELECT 1')).rejects.toMatchObject({ code: STUB_CODE })
  })

  it('positive control: an executor-taking function fed the stub query reaches the stub', async () => {
    const probe = async (query: (sql: string) => Promise<unknown>) => query('SELECT 1')
    expect(await callAndClassify(probe as (...args: unknown[]) => unknown)).toBe('stub')
  })

  it('no exported function under src/tasks reaches the database stub', async () => {
    const reached: string[] = []
    let called = 0
    for (const file of files) {
      const mod = (await import(path.join(TASKS_DIR, file))) as Record<string, unknown>
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue
        called += 1
        if ((await callAndClassify(value as (...args: unknown[]) => unknown)) === 'stub') {
          reached.push(`${file}:${name}`)
        }
      }
    }
    expect(called).toBeGreaterThan(0)
    expect(reached).toEqual([])
  })
})
