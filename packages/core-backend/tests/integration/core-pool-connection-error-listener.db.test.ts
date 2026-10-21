/**
 * Core pool connection-error listeners on a real PostgreSQL, observed from OUTSIDE the process under
 * test: each scenario runs in a child process (`tests/utils/core-pool-connection-error-child.ts`), so
 * "the process keeps running" is the child's exit code, not an in-process assertion.
 *
 *  (a) idle: the server closes a pooled connection while it is idle in the pool; the child keeps
 *      running, the pool records one connection error, discards that connection, and the next query on
 *      the pool succeeds on a different backend.
 *  (b) borrowed: a connection lost while `ConnectionPool.transaction()` holds it; the failure reaches
 *      the caller, the child keeps running, the pool has discarded the connection (total 0, one
 *      remove), and the next query succeeds on a different backend.
 *  (c) control: a scenario that does NOT reach its last line — the proof that this harness tells a
 *      child that stops early from one that runs to its end, so the two legs above are not green by
 *      construction.
 *
 * Shared-database safe: the child only affects connections it opened itself, and the parent only reads
 * `pg_stat_activity`.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have a database URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '../..')
const TSX = path.join(PKG_ROOT, 'node_modules/.bin/tsx')
const CHILD = path.join(HERE, '../utils/core-pool-connection-error-child.ts')

interface ChildRun {
  status: number | null
  signal: string | null
  stdout: string
  stderr: string
  lines: string[]
}

function runChild(scenario: 'idle' | 'borrowed' | 'control'): ChildRun {
  const proc = spawnSync(TSX, [CHILD, scenario], {
    cwd: PKG_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_PATH: path.join(PKG_ROOT, 'node_modules'),
      DATABASE_URL: dbUrl,
      LOG_LEVEL: 'error',
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (proc.error) {
    throw new Error(`spawn failed for ${scenario}: ${String(proc.error)}`)
  }
  const stdout = String(proc.stdout || '')
  return {
    status: proc.status,
    signal: proc.signal === null ? null : String(proc.signal),
    stdout,
    stderr: String(proc.stderr || ''),
    lines: stdout.split('\n').filter((line) => line.startsWith('D2 ')),
  }
}

function line(run: ChildRun, stage: string): string {
  const found = run.lines.find((candidate) => candidate.startsWith(`D2 ${stage} `) || candidate === `D2 ${stage}`)
  if (!found) {
    throw new Error(`child never printed ${stage}\nstatus=${String(run.status)} signal=${String(run.signal)}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
  }
  return found
}

function field(text: string, key: string): string {
  const match = new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(text)
  if (!match) throw new Error(`no field ${key} in: ${text}`)
  return match[1]
}

describeIfDatabase('core pool connection-error listeners (real DB, child process per scenario)', () => {
  let observer: Pool

  beforeAll(() => {
    if (!fs.existsSync(TSX)) throw new Error(`local tsx missing at ${TSX} (no npx fallback)`)
    if (!fs.existsSync(CHILD)) throw new Error(`child script missing at ${CHILD}`)
    observer = new Pool({ connectionString: dbUrl, max: 1, application_name: 'd2-parent-observer' })
  })

  afterAll(async () => {
    await observer?.end()
  })

  async function backendAlive(pid: number): Promise<boolean> {
    const { rows } = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid])
    return Number(rows[0].n) > 0
  }

  it('(a) an idle pooled connection that the server closes is recorded and discarded; the process keeps running and the next query succeeds', async () => {
    const run = runChild('idle')
    expect(run.signal, `stderr:\n${run.stderr}`).toBeNull()
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)

    const borrowed = line(run, 'IDLE_BORROWED')
    const first = Number(field(borrowed, 'pid'))
    expect(field(borrowed, 'idle')).toBe('1')

    expect(field(line(run, 'IDLE_TERMINATED'), 'gone')).toBe('true')

    const observed = line(run, 'IDLE_OBSERVED')
    expect(field(observed, 'observed')).toBe('true')
    expect(Number(field(observed, 'errors'))).toBeGreaterThanOrEqual(1)
    expect(field(observed, 'total')).toBe('0')
    expect(field(observed, 'idle')).toBe('0')

    const next = line(run, 'IDLE_NEXT')
    expect(field(next, 'different')).toBe('true')
    expect(Number(field(next, 'pid'))).not.toBe(first)

    expect(await backendAlive(first)).toBe(false)
  }, 90_000)

  it('(b) a connection that the server closes while the transaction wrapper holds it: the caller gets an error, the pool discards it, the process keeps running', async () => {
    const run = runChild('borrowed')
    expect(run.signal, `stderr:\n${run.stderr}`).toBeNull()
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)

    const inTxn = line(run, 'BORROWED_IN_TXN')
    const held = Number(field(inTxn, 'pid'))
    expect(field(inTxn, 'total')).toBe('1')

    expect(field(line(run, 'BORROWED_TERMINATED'), 'gone')).toBe('true')
    expect(field(line(run, 'BORROWED_CLIENT_STATE'), 'heard')).toBe('true')

    expect(run.lines.some((candidate) => candidate.startsWith('D2 BORROWED_REJECTED'))).toBe(true)
    expect(run.lines).not.toContain('D2 BORROWED_RESOLVED')

    const afterwards = line(run, 'BORROWED_POOL')
    expect(field(afterwards, 'total')).toBe('0')
    expect(field(afterwards, 'idle')).toBe('0')
    expect(Number(field(afterwards, 'removed'))).toBeGreaterThanOrEqual(1)

    const next = line(run, 'BORROWED_NEXT')
    expect(field(next, 'different')).toBe('true')
    expect(Number(field(next, 'pid'))).not.toBe(held)

    expect(await backendAlive(held)).toBe(false)
  }, 90_000)

  it('(c) control: the harness tells a child that does not reach its last line from one that does', async () => {
    const run = runChild('control')
    // Anchors: the start markers must exist and the end marker must not.
    const borrowed = line(run, 'CONTROL_BORROWED')
    const pid = Number(field(borrowed, 'pid'))
    expect(Number(field(line(run, 'CONTROL_TERMINATING'), 'pid'))).toBe(pid)
    expect(run.lines).not.toContain('D2 CONTROL_STILL_RUNNING')
    expect(run.signal).toBeNull()
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).not.toBe(0)
    // Locale-independent: the server's English text may be absent, but Node prints the error's own
    // properties (its SQLSTATE) and the driver's own messages are not localized.
    expect(run.stderr).toMatch(/terminating connection|57P01|Connection terminated|Unhandled error/)
  }, 90_000)
})
