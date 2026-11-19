import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as bcrypt from 'bcryptjs'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool as PgPool } from 'pg'
import type { PoolClient } from 'pg'
import { up as createSessionFlight } from '../../src/db/migrations/zzzz20261117120100_create_security_action_session_flight'
import { assertSeamDatabaseOwner, validateSeamBaseDatabaseUrl } from '../fixtures/security-action-comparison-seam/database-owner.mjs'

if (process.env.EXPECT_DB !== '1' || !process.env.DATABASE_URL) {
  throw new Error('security-action-attempt-admission.db.test.ts requires EXPECT_DB=1 and DATABASE_URL')
}
const databaseUrl: string = validateSeamBaseDatabaseUrl(process.env.DATABASE_URL).toString()

const IDENT = /^[a-z_][a-z0-9_]*$/
const SID_PREFIX = 'security-action-sid:'
const APP_SMOKE = 'sa_wpc_admit_smoke'
const APP_HOLDER = 'sa_wpc_admit_holder'
const APP_WAITER = 'sa_wpc_admit_waiter'
const APP_CAPACITY = 'sa_wpc_admit_capacity'
const APP_MAXN = 'sa_wpc_admit_maxn'
const WORKER = fileURLToPath(new URL('../fixtures/security-action-attempt-worker.ts', import.meta.url))
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

type Slot = 'primary' | 'other' | 'holder' | 'waiter'
type OwnedLine = {
  event: 'owned'
  ok: boolean
  slot: Slot
  verified: boolean
  sameBackend: boolean
  workerPid: number
  name?: string
}
type ReadLine = { event: 'read'; slot: Slot; workerPid: number; backendPid: number }
type ChildHandle = {
  pid: number
  exitCode: () => number | null
  text: () => string
  reads: () => ReadLine[]
  done: Promise<{ code: number; owned: OwnedLine[]; crashed: boolean }>
  stop: () => void
}
type Parts = { classid: string; objid: string }
type SessionRow = { readPid: number | null; accountPid: number | null; verified: boolean | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asSlot(value: unknown): Slot | undefined {
  if (value === 'primary' || value === 'other' || value === 'holder' || value === 'waiter') return value
  return undefined
}

function parseOwned(stdout: string): { owned: OwnedLine[]; reads: ReadLine[]; crashed: boolean } {
  const owned: OwnedLine[] = []
  const reads: ReadLine[] = []
  let crashed = false
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    if (value.event === 'crash') {
      crashed = true
      continue
    }
    if (value.event === 'read') {
      const slot = asSlot(value.slot)
      if (slot && typeof value.workerPid === 'number' && Number.isSafeInteger(value.workerPid) && value.workerPid > 0
        && typeof value.backendPid === 'number' && Number.isSafeInteger(value.backendPid) && value.backendPid > 0) {
        reads.push({ event: 'read', slot, workerPid: value.workerPid, backendPid: value.backendPid })
      }
      continue
    }
    if (value.event !== 'owned' || typeof value.ok !== 'boolean') continue
    const slot = asSlot(value.slot)
    if (!slot) continue
    if (typeof value.workerPid !== 'number' || !Number.isSafeInteger(value.workerPid) || value.workerPid <= 0) continue
    if ('sessionId' in value || 'password' in value || 'passwordHash' in value || 'token' in value) continue
    const lineValue: OwnedLine = {
      event: 'owned',
      ok: value.ok,
      slot,
      verified: value.verified === true,
      sameBackend: value.sameBackend === true,
      workerPid: value.workerPid,
    }
    if (typeof value.name === 'string') lineValue.name = value.name
    owned.push(lineValue)
  }
  return { owned, reads, crashed }
}

function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error('owned schema was refused')
  return `"${name}"`
}

function withOptions(base: string, options: string): string {
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}options=${encodeURIComponent(options)}`
}

function freshKey(prefix: string): string {
  return `${prefix}${randomBytes(8).toString('hex')}`
}

describe('security action attempt admission fail closed', () => {
  it('fails closed when DATABASE_URL is absent', async () => {
    const child = startChild({ url: '', mode: 'owned', applicationName: APP_SMOKE, dropUrl: true })
    try {
      const result = await child.done
      expect(result.code).toBe(1)
      expect(result.crashed).toBe(true)
      expect(result.owned).toEqual([])
    } finally {
      child.stop()
      await child.done
    }
  })

  it('fails closed when DATABASE_URL is unreachable', async () => {
    const unavailable = new URL(databaseUrl)
    const socket = unavailable.searchParams.get('host')
    unavailable.searchParams.set('host', socket?.startsWith('/')
      ? join(socket, 'wpc-missing-admission-socket')
      : join(PACKAGE_ROOT, 'artifacts', freshKey('wpc_missing_socket_')))
    const child = startChild({
      url: unavailable.toString(),
      mode: 'owned',
      applicationName: APP_SMOKE,
      unavailable: true,
    })
    try {
      const result = await child.done
      expect(result.code).toBe(1)
      expect(result.crashed).toBe(true)
      expect(result.owned).toEqual([])
    } finally {
      child.stop()
      await child.done
    }
  })
})

describe('security action attempt admission owned schema', () => {
  let observe: PgPool | undefined
  let schemaName: string | undefined
  let password = ''
  let passwordHash = ''

  beforeAll(async () => {
    const schema = `sa_wpc_admit_${randomBytes(8).toString('hex')}`
    observe = new PgPool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000 })
    try {
      await observe.query('SELECT 1')
    } catch {
      throw new Error('DATABASE_URL is unreachable')
    }
    if (!IDENT.test(schema)) throw new Error('owned schema was refused')
    await observe.query(`CREATE SCHEMA ${quoteIdent(schema)}`)
    schemaName = schema
    const kpool = new PgPool({ connectionString: databaseUrl, max: 1 })
    const kdb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: kpool }) })
    try {
      await kdb.transaction().execute(async (trx) => {
        await sql`SELECT pg_catalog.set_config('search_path', ${schema}::text, true)`.execute(trx)
        await createSessionFlight(trx)
      })
    } finally {
      await kdb.destroy()
    }
    const installed = await observe.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = 'security_action_session_flight'
          AND c.relkind = 'r'
          AND c.relpersistence = 'p'`,
      [schema],
    )
    if (installed.rows[0]?.n !== 1) throw new Error('owned session flight relation was not installed')
    await observe.query(
      `CREATE TABLE ${quoteIdent(schema)}.security_action_attempt_session (
         slot text PRIMARY KEY,
         read_pid integer,
         account_pid integer,
         verified boolean
       )`,
    )
    await observe.query(
      `CREATE TABLE ${quoteIdent(schema)}.security_action_attempt_effect (
         id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         slot text NOT NULL
       )`,
    )
    password = freshKey('sa-wpc-admit-')
    passwordHash = await bcrypt.hash(password, 4)
    schemaPassword.password = password
    schemaPassword.hash = passwordHash
    schemaPassword.schema = schema
  })

  afterEach(async () => {
    if (!observe || !schemaName) return
    await observe.query(`DELETE FROM ${quoteIdent(schemaName)}.security_action_attempt_effect`)
    await observe.query(`DELETE FROM ${quoteIdent(schemaName)}.security_action_attempt_session`)
  })

  afterAll(async () => {
    if (observe && schemaName && IDENT.test(schemaName)) {
      await observe.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`)
    }
    await observe?.end()
    schemaPassword.password = ''
    schemaPassword.hash = ''
    schemaPassword.schema = ''
  })

  it('completes one owned attempt through the real entry on one backend', async () => {
    const sessionId = freshKey('sa-wpc-admit-')
    await insertSlot('primary')
    const child = startChild({
      url: childUrl(APP_SMOKE),
      mode: 'owned',
      applicationName: APP_SMOKE,
      slot: 'primary',
      sessionId,
      poolMax: '4',
      poolMin: '0',
    })
    try {
      const result = await child.done
      expect(child.pid).toBeGreaterThan(0)
      expect(result.code).toBe(0)
      expect(result.crashed).toBe(false)
      const workerPid = result.owned[0]?.workerPid
      expect(workerPid).toBeGreaterThan(0)
      expect(workerPid).not.toBe(process.pid)
      expect(result.owned).toEqual([{ event: 'owned', ok: true, slot: 'primary', verified: true, sameBackend: true, workerPid }])
      const row = await sessionRow('primary')
      expect(row.readPid).toBeGreaterThan(0)
      expect(row.accountPid).toBe(row.readPid)
      expect(row.verified).toBe(true)
      expect(await effectCount()).toBe(1)
      expect(await latchCount(sessionId)).toBe(0)
    } finally {
      child.stop()
      await child.done
    }
  })

  it('orders two operating-system processes on one session advisory lock during the first read callback', async () => {
    const sessionId = freshKey('sa-wpc-admit-')
    const readGate = freshKey('sa-wpc-admit-read-')
    const startGate = freshKey('sa-wpc-admit-start-')
    await insertSlot('holder')
    await insertSlot('waiter')
    const gates: PoolClient[] = []
    const children: ChildHandle[] = []
    try {
      gates.push(await holdGate(readGate), await holdGate(startGate))
      const readGateOwnerPid = Number((await gates[0]!.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      const holder = startChild({
        url: childUrl(APP_HOLDER),
        mode: 'owned',
        applicationName: APP_HOLDER,
        slot: 'holder',
        sessionId,
        readGate,
        poolMax: '4',
        poolMin: '0',
      })
      const waiter = startChild({
        url: childUrl(APP_WAITER),
        mode: 'owned',
        applicationName: APP_WAITER,
        slot: 'waiter',
        sessionId,
        startGate,
        poolMax: '4',
        poolMin: '0',
      })
      children.push(holder, waiter)
      const sessionParts = await advisoryParts(SID_PREFIX + sessionId)
      const readParts = await advisoryParts(readGate)
      const held = await pollUntil(async () => {
        const read = holder.reads().find((event) => event.slot === 'holder')
        if (!read) return undefined
        const granted = await backendPids(sessionParts, true, `${APP_HOLDER}_owned`, true)
        if (granted.length !== 1 || granted[0] !== read.backendPid) {
          console.info('WPC_ADMISSION_PG_EVIDENCE', JSON.stringify({
            phase: 'first_read_sid_ownership', worker_pid: read.workerPid,
            read_backend_pid: read.backendPid, owned_sid_lock_count: granted.length,
          }))
        }
        expect(granted).toEqual([read.backendPid])
        const waiting = await backendPids(readParts, false, APP_HOLDER, false)
        if (granted.length !== 1 || waiting.length !== 1) return undefined
        if (holder.exitCode() !== null || (await latchCount(sessionId)) !== 1 || (await effectCount()) !== 0) return undefined
        return { holderPid: granted[0] ?? 0, gatePid: waiting[0] ?? 0, workerPid: read.workerPid }
      }, 18_000)
      expect(held.holderPid).toBeGreaterThan(0)
      expect(held.gatePid).toBeGreaterThan(0)
      expect(held.holderPid).not.toBe(held.gatePid)
      expect(await isBlockedBy(held.gatePid, readGateOwnerPid)).toBe(true)
      expect(holder.pid).toBeGreaterThan(0)
      expect(waiter.pid).toBeGreaterThan(0)
      expect(holder.pid).not.toBe(waiter.pid)
      await releaseGate(gates.pop())
      const blocked = await pollUntil(async () => {
        const granted = await backendPids(sessionParts, true, `${APP_HOLDER}_owned`, true)
        const waiting = await backendPids(sessionParts, false, `${APP_WAITER}_owned`, false)
        if (granted.length !== 1 || waiting.length !== 1) return undefined
        if (granted[0] === waiting[0]) return undefined
        if (!await isBlockedBy(waiting[0]!, granted[0]!)) return undefined
        if (holder.exitCode() !== null || waiter.exitCode() !== null) return undefined
        if ((await latchCount(sessionId)) !== 1 || (await effectCount()) !== 0) return undefined
        const holderRow = await sessionRow('holder')
        const waiterRow = await sessionRow('waiter')
        if (holderRow.accountPid !== null || waiterRow.readPid !== null) return undefined
        if (waiter.reads().length !== 0) return undefined
        return { holderPid: granted[0] ?? 0, waiterPid: waiting[0] ?? 0 }
      }, 8_000)
      expect(blocked.holderPid).toBe(held.holderPid)
      expect(blocked.waiterPid).toBeGreaterThan(0)
      expect(blocked.waiterPid).not.toBe(blocked.holderPid)
      await releaseGate(gates.pop())
      const holderResult = await holder.done
      const waiterResult = await waiter.done
      expect(holderResult.code).toBe(0)
      expect(waiterResult.code).toBe(0)
      const holderWorkerPid = holderResult.owned[0]?.workerPid
      const waiterWorkerPid = waiterResult.owned[0]?.workerPid
      expect(holderWorkerPid).toBeGreaterThan(0)
      expect(waiterWorkerPid).toBeGreaterThan(0)
      expect(holderWorkerPid).not.toBe(waiterWorkerPid)
      expect(holderWorkerPid).not.toBe(process.pid)
      expect(waiterWorkerPid).not.toBe(process.pid)
      expect(holderWorkerPid).toBe(held.workerPid)
      expect(waiter.reads()).toEqual([{ event: 'read', slot: 'waiter', workerPid: waiterWorkerPid, backendPid: blocked.waiterPid }])
      expect(holderResult.owned).toEqual([{ event: 'owned', ok: true, slot: 'holder', verified: true, sameBackend: true, workerPid: holderWorkerPid }])
      expect(waiterResult.owned).toEqual([{ event: 'owned', ok: true, slot: 'waiter', verified: true, sameBackend: true, workerPid: waiterWorkerPid }])
      const holderRow = await sessionRow('holder')
      const waiterRow = await sessionRow('waiter')
      expect(holderRow.readPid).toBeGreaterThan(0)
      expect(holderRow.readPid).toBe(blocked.holderPid)
      expect(holderRow.accountPid).toBe(holderRow.readPid)
      expect(holderRow.verified).toBe(true)
      expect(waiterRow.readPid).toBeGreaterThan(0)
      expect(waiterRow.readPid).toBe(blocked.waiterPid)
      expect(waiterRow.accountPid).toBe(waiterRow.readPid)
      expect(waiterRow.verified).toBe(true)
      expect(holderRow.readPid).not.toBe(waiterRow.readPid)
      expect(await effectCount()).toBe(2)
      expect(await latchCount(sessionId)).toBe(0)
      console.info('WPC_ADMISSION_PG_EVIDENCE', JSON.stringify({
        phase: 'two_os_process_read_callback_serialization',
        holder_worker_pid: holderWorkerPid, waiter_worker_pid: waiterWorkerPid,
        holder_backend_pid: blocked.holderPid, waiter_backend_pid: blocked.waiterPid,
        read_gate_waiter_pid: held.gatePid, read_gate_owner_pid: readGateOwnerPid,
        direct_blocker_link: true, effect_count: 2, remaining_latch_count: 0,
      }))
    } finally {
      while (gates.length > 0) await releaseGate(gates.pop())
      for (const child of children) child.stop()
      await Promise.all(children.map((child) => child.done))
    }
  })

  it('admits only one session while the only pool slot is held in the first read callback', async () => {
    const primaryId = freshKey('sa-wpc-admit-')
    const otherId = freshKey('sa-wpc-admit-')
    const readGate = freshKey('sa-wpc-admit-read-')
    await insertSlot('primary')
    await insertSlot('other')
    const gates: PoolClient[] = []
    const children: ChildHandle[] = []
    try {
      gates.push(await holdGate(readGate))
      const readGateOwnerPid = Number((await gates[0]!.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      const child = startChild({
        url: childUrl(APP_CAPACITY),
        mode: 'capacity',
        applicationName: APP_CAPACITY,
        sessionId: primaryId,
        otherSessionId: otherId,
        readGate,
        poolMax: '1',
        poolMin: '0',
      })
      children.push(child)
      const readParts = await advisoryParts(readGate)
      const held = await pollUntil(async () => {
        const primaryLatch = await latchCount(primaryId)
        const otherLatch = await latchCount(otherId)
        const inTransaction = await inTransactionBackends(`${APP_CAPACITY}_owned`)
        const waiting = await backendPids(readParts, false, APP_CAPACITY, false)
        if (primaryLatch + otherLatch !== 1 || inTransaction.length !== 1 || waiting.length !== 1) return undefined
        const reads = child.reads()
        if (reads.length !== 1 || reads[0]?.backendPid !== inTransaction[0]) return undefined
        if (child.exitCode() !== null || (await effectCount()) !== 0 || parseOwned(child.text()).owned.length !== 0) return undefined
        return { latch: primaryLatch + otherLatch, backends: inTransaction.length, ownerPid: inTransaction[0]!, gatePid: waiting[0] ?? 0 }
      }, 18_000)
      expect(held.latch).toBe(1)
      expect(held.backends).toBe(1)
      expect(held.gatePid).toBeGreaterThan(0)
      expect(held.gatePid).not.toBe(held.ownerPid)
      expect(await isBlockedBy(held.gatePid, readGateOwnerPid)).toBe(true)
      expect(child.pid).toBeGreaterThan(0)
      await releaseGate(gates.pop())
      const result = await child.done
      expect(result.code).toBe(0)
      expect(result.crashed).toBe(false)
      const workerPid = result.owned[0]?.workerPid
      expect(workerPid).toBeGreaterThan(0)
      expect(workerPid).not.toBe(process.pid)
      expect(result.owned).toEqual([
        { event: 'owned', ok: true, slot: 'primary', verified: true, sameBackend: true, workerPid },
        { event: 'owned', ok: true, slot: 'other', verified: true, sameBackend: true, workerPid },
      ])
      for (const slot of ['primary', 'other'] as const) {
        const row = await sessionRow(slot)
        expect(row.readPid).toBeGreaterThan(0)
        expect(row.accountPid).toBe(row.readPid)
        expect(row.verified).toBe(true)
      }
      const primaryRow = await sessionRow('primary')
      const otherRow = await sessionRow('other')
      expect(primaryRow.readPid).toBe(otherRow.readPid)
      expect(primaryRow.readPid).toBe(held.ownerPid)
      expect(await effectCount()).toBe(2)
      expect(await latchCount(primaryId)).toBe(0)
      expect(await latchCount(otherId)).toBe(0)
      console.info('WPC_ADMISSION_PG_EVIDENCE', JSON.stringify({
        phase: 'single_pool_slot_read_callback_capacity', worker_pid: workerPid,
        first_backend_pid: primaryRow.readPid, second_backend_pid: otherRow.readPid,
        read_gate_waiter_pid: held.gatePid, read_gate_owner_pid: readGateOwnerPid,
        owned_transaction_count_while_held: held.backends, effect_count: 2,
        remaining_latch_count: 0,
      }))
    } finally {
      while (gates.length > 0) await releaseGate(gates.pop())
      for (const child of children) child.stop()
      await Promise.all(children.map((child) => child.done))
    }
  })

  it('overlaps two sessions on one pool of two with distinct backends and no third checkout', async () => {
    const primaryId = freshKey('sa-wpc-maxn-')
    const otherId = freshKey('sa-wpc-maxn-')
    const readGate = freshKey('sa-wpc-maxn-read-')
    await insertSlot('primary')
    await insertSlot('other')
    const gates: PoolClient[] = []
    const children: ChildHandle[] = []
    try {
      gates.push(await holdGate(readGate))
      const child = startChild({
        url: childUrl(APP_MAXN),
        mode: 'capacity',
        applicationName: APP_MAXN,
        sessionId: primaryId,
        otherSessionId: otherId,
        readGate,
        poolMax: '2',
        poolMin: '0',
      })
      children.push(child)
      const readParts = await advisoryParts(readGate)
      const identified = await pollUntil(async () => {
        const primaryLatch = await latchCount(primaryId)
        const otherLatch = await latchCount(otherId)
        const inTransaction = await inTransactionBackends(`${APP_MAXN}_owned`)
        const waiting = await backendPids(readParts, false, APP_MAXN, false)
        const reads = child.reads()
        if (primaryLatch !== 1 || otherLatch !== 1 || inTransaction.length !== 2 || waiting.length !== 2) return undefined
        if (new Set(inTransaction).size !== 2 || new Set(waiting).size !== 2 || reads.length !== 2) return undefined
        if (waiting.some((pid) => inTransaction.includes(pid))) return undefined
        if (reads.some((row) => !inTransaction.includes(row.backendPid))) return undefined
        if (child.exitCode() !== null || (await effectCount()) !== 0 || parseOwned(child.text()).owned.length !== 0) return undefined
        const named = await pool().query<{ pid: number; application_name: string }>(
          `SELECT pid, application_name
             FROM pg_catalog.pg_stat_activity
            WHERE datname = current_database()
              AND pid = ANY($1::int[])`,
          [inTransaction],
        )
        if (named.rows.length !== 2 || named.rows.some((row) => row.application_name !== `${APP_MAXN}_owned`)) return undefined
        return { pids: [...inTransaction].sort((left, right) => left - right), workerPid: child.pid }
      }, 18_000)
      expect(identified.pids).toHaveLength(2)
      expect(identified.pids[0]).not.toBe(identified.pids[1])
      expect(identified.workerPid).toBeGreaterThan(0)
      await releaseGate(gates.pop())
      const result = await child.done
      expect(result.code).toBe(0)
      expect(result.crashed).toBe(false)
      expect(result.owned).toHaveLength(2)
      const workerPid = result.owned[0]?.workerPid
      expect(workerPid).toBeGreaterThan(0)
      expect(workerPid).not.toBe(process.pid)
      expect(result.owned.every((row) => row.ok && row.verified && row.sameBackend && row.workerPid === workerPid)).toBe(true)
      expect(result.owned.map((row) => row.slot).sort()).toEqual(['other', 'primary'])
      const primaryRow = await sessionRow('primary')
      const otherRow = await sessionRow('other')
      expect(primaryRow.readPid).toBe(primaryRow.accountPid)
      expect(otherRow.readPid).toBe(otherRow.accountPid)
      expect([primaryRow.readPid, otherRow.readPid].sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual(identified.pids)
      expect(await effectCount()).toBe(2)
      expect(await latchCount(primaryId)).toBe(0)
      expect(await latchCount(otherId)).toBe(0)
      console.info('WPC_ADMISSION_PG_EVIDENCE', JSON.stringify({
        phase: 'pool_max_two_independent_sessions', worker_pid: workerPid,
        backend_pids: identified.pids, application_name: `${APP_MAXN}_owned`,
        identification: 'once', product_backends: 2, effect_count: 2, remaining_latch_count: 0,
      }))
    } finally {
      while (gates.length > 0) await releaseGate(gates.pop())
      for (const child of children) child.stop()
      await Promise.all(children.map((child) => child.done))
    }
  })

  function pool(): PgPool {
    if (!observe || !schemaName) throw new Error('owned schema is absent')
    return observe
  }

  function childUrl(applicationName: string): string {
    if (!schemaName) throw new Error('owned schema is absent')
    return withOptions(databaseUrl, `-c search_path=${schemaName} -c application_name=${applicationName}`)
  }

  async function insertSlot(slot: Slot): Promise<void> {
    await pool().query(`INSERT INTO ${quoteIdent(schemaName ?? '')}.security_action_attempt_session (slot) VALUES ($1)`, [slot])
  }

  async function effectCount(): Promise<number> {
    const found = await pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${quoteIdent(schemaName ?? '')}.security_action_attempt_effect`)
    return found.rows[0]?.n ?? 0
  }

  async function latchCount(sessionId: string): Promise<number> {
    const found = await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${quoteIdent(schemaName ?? '')}.security_action_session_flight WHERE session_id = $1`,
      [sessionId],
    )
    return found.rows[0]?.n ?? 0
  }

  async function sessionRow(slot: Slot): Promise<SessionRow> {
    const found = await pool().query<{ read_pid: number | null; account_pid: number | null; verified: boolean | null }>(
      `SELECT read_pid, account_pid, verified FROM ${quoteIdent(schemaName ?? '')}.security_action_attempt_session WHERE slot = $1`,
      [slot],
    )
    const row = found.rows[0]
    if (!row) return { readPid: null, accountPid: null, verified: null }
    return { readPid: row.read_pid, accountPid: row.account_pid, verified: row.verified }
  }

  async function advisoryParts(key: string): Promise<Parts> {
    const found = await pool().query<{ k: string }>('SELECT pg_catalog.hashtextextended($1::text, 0)::text AS k', [key])
    const raw = found.rows[0]?.k
    if (typeof raw !== 'string') throw new Error('advisory key was not available')
    const value = BigInt(raw)
    const unsigned = value < 0n ? value + (1n << 64n) : value
    return { classid: ((unsigned >> 32n) & 0xffffffffn).toString(), objid: (unsigned & 0xffffffffn).toString() }
  }

  async function backendPids(parts: Parts, granted: boolean, applicationName: string, inTransaction: boolean): Promise<number[]> {
    const found = await pool().query<{ pid: number }>(
      `SELECT a.pid
         FROM pg_catalog.pg_locks l
         JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND l.granted = $3
          AND l.objsubid = 1
          AND l.classid = $1::oid
          AND l.objid = $2::oid
          AND a.application_name = $4
          AND (($5::boolean AND a.xact_start IS NOT NULL) OR (NOT $5::boolean))`,
      [parts.classid, parts.objid, granted, applicationName, inTransaction],
    )
    return found.rows.map((row) => Number(row.pid)).filter((pid) => pid > 0)
  }

  async function inTransactionBackends(applicationName: string): Promise<number[]> {
    const found = await pool().query<{ pid: number }>(
      `SELECT pid
         FROM pg_catalog.pg_stat_activity
        WHERE application_name = $1
          AND xact_start IS NOT NULL
        ORDER BY pid`,
      [applicationName],
    )
    return found.rows.map((row) => row.pid)
  }

  async function isBlockedBy(waiterPid: number, holderPid: number): Promise<boolean> {
    const result = await pool().query<{ linked: boolean }>(
      'SELECT pg_catalog.pg_blocking_pids($1::integer) @> ARRAY[$2::integer] AS linked',
      [waiterPid, holderPid],
    )
    return result.rows[0]?.linked === true
  }

  async function holdGate(key: string): Promise<PoolClient> {
    const client = await pool().connect()
    await client.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1::text, 0))', [key])
    return client
  }
})

function startChild(input: {
  url: string
  mode: 'owned' | 'capacity'
  applicationName: string
  dropUrl?: boolean
  unavailable?: boolean
  slot?: Slot
  sessionId?: string
  otherSessionId?: string
  readGate?: string
  startGate?: string
  poolMax?: string
  poolMin?: string
}): ChildHandle {
  const env: NodeJS.ProcessEnv = { ...process.env }
  env.SECRET_PROVIDER = 'env'
  delete env.SA_PASSWORD
  delete env.SA_PASSWORD_HASH
  delete env.SA_READ_GATE
  delete env.SA_START_GATE
  delete env.SA_SLOT
  delete env.SA_SESSION_ID
  delete env.SA_SESSION_ID_OTHER
  delete env.SA_SCHEMA
  if (input.dropUrl) env.DATABASE_URL = ''
  else env.DATABASE_URL = input.url
  env.SA_WORKER_MODE = input.mode
  env.APP_NAME = `${input.applicationName}_owned`
  if (input.slot) env.SA_SLOT = input.slot
  if (input.sessionId) env.SA_SESSION_ID = input.sessionId
  if (input.otherSessionId) env.SA_SESSION_ID_OTHER = input.otherSessionId
  if (input.readGate) env.SA_READ_GATE = input.readGate
  if (input.startGate) env.SA_START_GATE = input.startGate
  if (input.poolMax) env.DB_POOL_MAX = input.poolMax
  if (input.poolMin) env.DB_POOL_MIN = input.poolMin
  if (schemaPassword.password) env.SA_PASSWORD = schemaPassword.password
  if (schemaPassword.hash) env.SA_PASSWORD_HASH = schemaPassword.hash
  if (schemaPassword.schema) env.SA_SCHEMA = schemaPassword.schema
  if (input.dropUrl || input.unavailable) {
    delete env.SA_PASSWORD
    delete env.SA_PASSWORD_HASH
    delete env.SA_SCHEMA
  }
  const tsx = createRequire(import.meta.url).resolve('tsx/cli')
  const child = spawn(process.execPath, [tsx, WORKER], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.on('data', () => undefined)
  child.stdout?.on('data', (chunk: string) => { out += chunk })
  let settled = false
  let resolveDone: (value: { code: number; owned: OwnedLine[]; crashed: boolean }) => void = () => undefined
  const done = new Promise<{ code: number; owned: OwnedLine[]; crashed: boolean }>((resolve) => {
    resolveDone = resolve
  })
  const finish = (code: number) => {
    if (settled) return
    settled = true
    const parsed = parseOwned(out)
    resolveDone({ code, owned: parsed.owned, crashed: parsed.crashed })
  }
  child.on('error', () => finish(1))
  child.on('close', (code) => finish(code ?? 1))
  return {
    pid: child.pid ?? -1,
    exitCode: () => child.exitCode,
    text: () => out,
    reads: () => parseOwned(out).reads,
    done,
    stop: () => { if (child.exitCode === null) child.kill() },
  }
}

async function pollUntil<T>(read: () => Promise<T | undefined>, limitMs: number): Promise<T> {
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for the admission schedule')
}

async function releaseGate(client: PoolClient | undefined): Promise<void> {
  if (!client) return
  try {
    await client.query('SELECT pg_catalog.pg_advisory_unlock_all()')
  } finally {
    client.release()
  }
}

const schemaPassword: { password: string; hash: string; schema: string } = { password: '', hash: '', schema: '' }

type SeamEvent = {
  event: string
  role: 'owner' | 'peer' | 'smoke'
  seq: number
  workerPid: number
  outcome?: string
  backendPid?: number
  count?: number
  checkout?: number
  phase?: 'claim' | 'account' | 'release' | 'read' | 'acquisition'
  unlocked?: boolean
  released?: boolean
  equal?: boolean
  different?: boolean
}
type SeamFault = 'rollback-tx1' | 'rollback-tx2' | 'rollback-tx2-withheld' | 'unlock-false' | 'unlock-error'
type SeamHold = 'blocked' | 'abandoned'
type SeamDatabaseOwner = { nonce: string; databaseOid: string; schemaOid: string; ownerOid: string }
type SeamChild = {
  events(): SeamEvent[]
  exited(): boolean
  release(): void
  ackSeen(): void
  faultSeen(): void
  unlockProceed(): void
  lockProceed(): void
  readRelease(): void
  cleanupSeen(): void
  done: Promise<number>
  stop(): void
}

describe('security action comparison delivery seam', () => {
  let observe: PgPool | undefined
  let schema = ''
  let secret = ''
  let fastHash = ''
  let slowHash = ''
  let databaseOwner: SeamDatabaseOwner
  const children: SeamChild[] = []

  beforeAll(async () => {
    schema = `sa_wpc_admit_${randomBytes(8).toString('hex')}`
    observe = new PgPool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 5000 })
    await observe.query('SELECT 1')
    await observe.query(`CREATE SCHEMA ${quoteIdent(schema)}`)
    const nonce = randomBytes(32).toString('hex')
    await observe.query(`COMMENT ON SCHEMA ${quoteIdent(schema)} IS '${nonce}'`)
    const ownership = await observe.query<{ database_oid: string; schema_oid: string; owner_oid: string }>(
      `SELECT d.oid::text AS database_oid, n.oid::text AS schema_oid, n.nspowner::text AS owner_oid
         FROM pg_catalog.pg_database d
         JOIN pg_catalog.pg_namespace n ON n.nspname = $1
        WHERE d.datname = pg_catalog.current_database()`, [schema],
    )
    if (ownership.rows.length !== 1) throw new Error('SEAM_DATABASE_REFUSED')
    databaseOwner = { nonce, databaseOid: ownership.rows[0].database_oid, schemaOid: ownership.rows[0].schema_oid, ownerOid: ownership.rows[0].owner_oid }
    await assertSeamDatabaseOwner((text: string, params: unknown[]) => observe!.query(text, params), schema, databaseOwner)
    const migrationPool = new PgPool({ connectionString: databaseUrl, max: 1 })
    const migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) })
    try {
      await migrationDb.transaction().execute(async (tx) => {
        await sql`SELECT pg_catalog.set_config('search_path', ${schema}::text, true)`.execute(tx)
        await createSessionFlight(tx)
      })
    } finally {
      await migrationDb.destroy()
    }
    await observe.query(`CREATE TABLE ${quoteIdent(schema)}.security_action_attempt_effect (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, slot text NOT NULL)`)
    secret = freshKey('sa-wpc-compare-')
    ;[fastHash, slowHash] = await Promise.all([bcrypt.hash(secret, 4), bcrypt.hash(secret, 12)])
  })

  afterEach(async () => {
    for (const child of children) {
      child.release()
      child.ackSeen()
      child.faultSeen()
      child.unlockProceed()
      child.lockProceed()
      child.readRelease()
      child.cleanupSeen()
    }
    try {
      await Promise.all(children.map((child) => Promise.race([
        child.done,
        new Promise<number>((resolve) => setTimeout(() => { child.stop(); resolve(1) }, 3000)),
      ])))
    } finally {
      children.length = 0
    }
    if (observe && schema) {
      await observe.query(`DELETE FROM ${quoteIdent(schema)}.security_action_attempt_effect`)
      expect(await latchCount()).toBe(0)
    }
  })

  afterAll(async () => {
    if (observe && schema) await observe.query(`DROP SCHEMA ${quoteIdent(schema)} CASCADE`)
    await observe?.end()
    secret = ''
    fastHash = ''
    slowHash = ''
  })

  it.each(['nonce', 'databaseOid'] as const)('refuses a mismatched parent %s before starting the comparison worker', async (field) => {
    const wrongOwner = { ...databaseOwner, [field]: field === 'nonce' ? randomBytes(32).toString('hex') : String(BigInt(databaseOwner.databaseOid) + 1n) }
    const child = startSeam('smoke', freshKey('sa-wpc-owner-'), 'TRUE', fastHash, undefined, undefined, undefined, undefined, 'none', wrongOwner)
    await expect(waitEvent(child, 'WORKER_READY')).rejects.toThrow('SEAM_CHILD_EXITED_BEFORE_EVENT')
    expect(await child.done).toBe(1)
    expect(child.events()).toEqual([])
    expect(await effectCount()).toBe(0)
    expect(await latchCount()).toBe(0)
  })

  it.each(['TRUE', 'FALSE', 'ERROR'] as const)('forwards the actual bcrypt %s outcome through the production import', async (outcome) => {
    const child = startSeam('smoke', freshKey('sa-wpc-compare-'), outcome, fastHash)
    await waitEvent(child, 'RAW_SETTLED')
    expect(child.events().filter((event) => event.event === 'CALLED').map((event) => event.count)).toEqual([1])
    expect(child.events().some((event) => event.event === 'ACCOUNT_ENTERED')).toBe(false)
    expect(await effectCount()).toBe(0)
    expect(await latchCount()).toBe(1)
    child.release()
    expect(await child.done).toBe(0)
    const terminal = await waitEvent(child, 'ATTEMPT_TERMINAL')
    expect(terminal.outcome).toBe(outcome === 'ERROR' ? 'UNAVAILABLE' : `RETURNED_${outcome}`)
    expect(await effectCount()).toBe(outcome === 'ERROR' ? 0 : 1)
    expect(await latchCount()).toBe(0)
  }, 30000)

  it.each(['TRUE', 'FALSE', 'ERROR'] as const)('retains the active latch after owner loss until admitted %s delivery terminates', async (outcome) => {
    const sessionId = freshKey('sa-wpc-loss-')
    const owner = startSeam('owner', sessionId, outcome, outcome === 'ERROR' ? fastHash : slowHash)
    await waitEvent(owner, 'CALLED')
    const backend = await waitEvent(owner, 'TX1_BACKEND')
    expect(Number.isSafeInteger(backend.backendPid)).toBe(true)
    const terminated = await pool().query<{ terminated: boolean }>(
      `SELECT pg_catalog.pg_terminate_backend(pid) AS terminated FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND application_name = 'sa_wpc_seam_owner'`,
      [backend.backendPid],
    )
    expect(terminated.rows).toEqual([{ terminated: true }])
    const lost = await waitEvent(owner, 'OWNER_LOST')
    const raw = await waitEvent(owner, 'RAW_SETTLED')
    if (outcome !== 'ERROR') expect(lost.seq).toBeLessThan(raw.seq)
    expect(raw.outcome).toBe(outcome)
    expect(await latchCount()).toBe(1)
    expect(await effectCount()).toBe(0)
    expect(owner.events().some((event) => event.event === 'ATTEMPT_TERMINAL')).toBe(false)
    const peer = startSeam('peer', sessionId, 'TRUE', fastHash)
    const peerTerminal = await pollUntil(async () => {
      const event = peer.events().find((entry) => ['TX1_BACKEND', 'CALLED', 'ACCOUNT_ENTERED', 'ATTEMPT_TERMINAL'].includes(entry.event))
      if (event) return event
      if (peer.exited()) throw new Error('SEAM_CHILD_EXITED_BEFORE_EVENT')
      return undefined
    }, 8000)
    expect(peerTerminal.event).toBe('ATTEMPT_TERMINAL')
    expect([peerTerminal.outcome, peerTerminal.count]).toEqual(['UNAVAILABLE', 0])
    const peerClaims = peer.events().filter((event) => event.event === 'CLAIM_FOREIGN')
    expect(peerClaims).toHaveLength(1)
    const peerClaim = peerClaims[0]
    expect(peerClaim.seq).toBeLessThan(peerTerminal.seq)
    expect(peer.events().filter((event) => event.event === 'CHECKOUT_READY').map((event) =>
      [event.checkout, event.backendPid])).toEqual([[1, peerClaim.backendPid]])
    expect(Number.isSafeInteger(peerClaim.backendPid)).toBe(true)
    expect(peerClaim.backendPid).not.toBe(backend.backendPid)
    expect(peer.events().some((event) => event.event === 'CONNECT_REJECTED' || event.event === 'CLAIM_OWNED')).toBe(false)
    expect(await peer.done).toBe(0)
    expect(peerTerminal.workerPid).not.toBe(lost.workerPid)
    expect(peer.events().some((event) => event.event === 'TX1_BACKEND' || event.event === 'CALLED' || event.event === 'ACCOUNT_ENTERED')).toBe(false)
    expect(await latchCount()).toBe(1)
    expect(await effectCount()).toBe(0)
    owner.release()
    expect(await owner.done).toBe(0)
    expect((await waitEvent(owner, 'ATTEMPT_TERMINAL')).outcome).toBe('UNAVAILABLE')
    expect(owner.events().some((event) => event.event === 'ACCOUNT_ENTERED')).toBe(false)
    expect(owner.events().filter((event) => event.event === 'DISPOSE_DISCARD' && event.count === 1)).toHaveLength(1)
    expect(await latchCount()).toBe(0)
    expect(await effectCount()).toBe(0)
    const successor = startSeam('smoke', sessionId, 'TRUE', fastHash)
    await waitEvent(successor, 'RAW_SETTLED')
    successor.release()
    expect(await successor.done).toBe(0)
    expect(await effectCount()).toBe(1)
    expect(await latchCount()).toBe(0)
    console.log(JSON.stringify({ phase: 'comparison-loss', outcome, raw_in_flight_at_loss: lost.seq < raw.seq,
      owner_worker: lost.workerPid, peer_worker: peerTerminal.workerPid, owner_backend: backend.backendPid,
      owner_compares: 1, peer_compares: 0, successor_effects: 1 }))
  }, 30000)

  it.each([
    ['claim', 'TRUE'],
    ['account', 'TRUE'],
    ['release', 'TRUE'],
    ['release', 'FALSE'],
  ] as const)('preserves real persistence when the %s COMMIT acknowledgement is withheld (%s)', async (phase, outcome) => {
    const child = startSeam('smoke', freshKey('sa-wpc-ack-'), outcome, fastHash, phase)
    await waitEvent(child, 'WORKER_READY')
    child.release()
    const committed = await waitEvent(child, 'NATIVE_COMMIT')
    expect([committed.phase, committed.checkout]).toEqual([phase, 1])
    expect(child.events().filter((event) => event.event === 'NATIVE_COMMIT')).toHaveLength(1)
    const ready = child.events().filter((event) => event.event === 'CHECKOUT_READY')
    expect(ready.map((event) => [event.checkout, event.backendPid])).toEqual([[1, committed.backendPid]])
    const backend = await pool().query(
      `SELECT state, xact_start IS NULL AS outside_transaction FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND application_name = 'sa_wpc_seam_smoke'`,
      [committed.backendPid],
    )
    expect(backend.rows).toEqual([{ state: 'idle', outside_transaction: true }])
    expect(await latchCount()).toBe(phase === 'release' ? 0 : 1)
    expect(await effectCount()).toBe(phase === 'claim' ? 0 : 1)
    expect(child.events().some((event) => ['ATTEMPT_TERMINAL', 'OWNER_LOST', 'DISPOSE_DISCARD', 'DISPOSE_RETURN'].includes(event.event))).toBe(false)
    child.ackSeen()
    expect(await child.done).toBe(0)
    const events = child.events()
    const terminal = events.find((event) => event.event === 'ATTEMPT_TERMINAL')
    const expectedTerminal = phase === 'release' ? `RETURNED_${outcome}` : 'UNAVAILABLE'
    expect([terminal?.outcome, terminal?.count]).toEqual([expectedTerminal, phase === 'claim' ? 0 : 1])
    expect(events.filter((event) => event.event === 'ACCOUNT_ENTERED')).toHaveLength(phase === 'claim' ? 0 : 1)
    const withheld = events.filter((event) => event.event === 'ACK_WITHHELD')
    expect(withheld).toHaveLength(1)
    expect([withheld[0].phase, withheld[0].checkout, withheld[0].backendPid]).toEqual([phase, 1, committed.backendPid])
    expect(withheld[0].seq).toBeGreaterThan(committed.seq)
    const discarded = events.filter((event) => event.event === 'DISPOSE_DISCARD' && event.checkout === 1)
    expect(discarded).toHaveLength(1)
    expect(discarded[0].seq).toBeGreaterThan(withheld[0].seq)
    expect(events.some((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 1)).toBe(false)
    expect(events.filter((event) => event.event === 'CHECKOUT').map((event) => event.count)).toEqual([1, 2])
    const cleanup = events.filter((event) => event.event === 'CHECKOUT_READY' && event.checkout === 2)
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0].backendPid).not.toBe(committed.backendPid)
    expect(cleanup[0].seq).toBeGreaterThan(discarded[0].seq)
    expect(events.filter((event) => event.seq > discarded[0].seq && ['TX1_BACKEND', 'CALLED', 'ACCOUNT_ENTERED'].includes(event.event))).toEqual([])
    expect(events.filter((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 2)).toHaveLength(1)
    expect(await latchCount()).toBe(0)
    expect(await effectCount()).toBe(phase === 'claim' ? 0 : 1)
    console.log(JSON.stringify({ phase: 'commit-ack', frame: phase, outcome, native_commit_observed: true,
      owner_backend: committed.backendPid, cleanup_backend: cleanup[0].backendPid, compares: terminal?.count,
      final_latch: 0, final_effects: phase === 'claim' ? 0 : 1, terminal: terminal?.outcome }))
  }, 30000)

  it('rolls back a visible read-transaction effect after 23502 and returns the native rollback', async () => {
    const child = startSeam('smoke', freshKey('sa-wpc-rb1-'), 'TRUE', fastHash, undefined, 'rollback-tx1')
    await waitEvent(child, 'WORKER_READY')
    child.release()
    const rolled = await waitEvent(child, 'NATIVE_ROLLBACK')
    await assertRollbackGate(child, rolled, 'read')
    expect(child.events().some((event) => event.event === 'CALLED' || event.event === 'ACCOUNT_ENTERED')).toBe(false)
    child.faultSeen()
    expect(await child.done).toBe(0)
    const events = child.events()
    const terminal = events.find((event) => event.event === 'ATTEMPT_TERMINAL')
    expect([terminal?.outcome, terminal?.count]).toEqual(['UNAVAILABLE', 0])
    expect(events.filter((event) => event.event === 'ROLLBACK_WITHHELD')).toHaveLength(0)
    expect(events.filter((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 1)).toHaveLength(1)
    expect(events.some((event) => event.event === 'DISPOSE_DISCARD' || event.event === 'OWNER_LOST')).toBe(false)
    expect(events.filter((event) => event.event === 'CHECKOUT').map((event) => event.count)).toEqual([1])
    expect(await effectCount()).toBe(0)
    expect(await latchCount()).toBe(0)
    console.log(JSON.stringify({ phase: 'rollback-tx1', native_rollback_returned: true, persistence: 'select', gate_effect: 0, final_latch: 0 }))
  }, 30000)

  it('rolls back a visible account-transaction effect after 23502 and returns the native rollback', async () => {
    const child = startSeam('smoke', freshKey('sa-wpc-rb2-'), 'TRUE', fastHash, undefined, 'rollback-tx2')
    await waitEvent(child, 'WORKER_READY')
    child.release()
    const rolled = await waitEvent(child, 'NATIVE_ROLLBACK')
    await assertRollbackGate(child, rolled, 'account')
    expect(child.events().filter((event) => event.event === 'ACCOUNT_ENTERED')).toHaveLength(1)
    expect(child.events().filter((event) => event.event === 'CALLED')).toHaveLength(1)
    child.faultSeen()
    expect(await child.done).toBe(0)
    const events = child.events()
    const terminal = events.find((event) => event.event === 'ATTEMPT_TERMINAL')
    expect([terminal?.outcome, terminal?.count]).toEqual(['UNAVAILABLE', 1])
    expect(events.filter((event) => event.event === 'ROLLBACK_WITHHELD')).toHaveLength(0)
    expect(events.filter((event) => event.event === 'ACCOUNT_ENTERED')).toHaveLength(1)
    expect(events.filter((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 1)).toHaveLength(1)
    expect(events.some((event) => event.event === 'DISPOSE_DISCARD' || event.event === 'OWNER_LOST')).toBe(false)
    expect(events.filter((event) => event.event === 'CHECKOUT').map((event) => event.count)).toEqual([1])
    expect(await effectCount()).toBe(0)
    expect(await latchCount()).toBe(0)
    console.log(JSON.stringify({ phase: 'rollback-tx2', native_rollback_returned: true, persistence: 'select', gate_effect: 0, final_latch: 0 }))
  }, 30000)

  it('withholds the account rollback acknowledgement after the native rollback', async () => {
    const child = startSeam('smoke', freshKey('sa-wpc-rb3-'), 'TRUE', fastHash, undefined, 'rollback-tx2-withheld')
    await waitEvent(child, 'WORKER_READY')
    child.release()
    const rolled = await waitEvent(child, 'NATIVE_ROLLBACK')
    await assertRollbackGate(child, rolled, 'account')
    child.faultSeen()
    expect(await child.done).toBe(0)
    const events = child.events()
    const withheld = events.filter((event) => event.event === 'ROLLBACK_WITHHELD')
    const discarded = events.filter((event) => event.event === 'DISPOSE_DISCARD' && event.checkout === 1)
    const cleanup = events.filter((event) => event.event === 'CHECKOUT_READY' && event.checkout === 2)
    const terminal = events.find((event) => event.event === 'ATTEMPT_TERMINAL')
    expect(withheld).toHaveLength(1)
    expect(withheld[0].seq).toBeGreaterThan(rolled.seq)
    expect([terminal?.outcome, terminal?.count]).toEqual(['UNAVAILABLE', 1])
    expect(events.filter((event) => event.event === 'ACCOUNT_ENTERED')).toHaveLength(1)
    expect(events.some((event) => event.event === 'OWNER_LOST')).toBe(false)
    expect(discarded).toHaveLength(1)
    expect(events.some((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 1)).toBe(false)
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0].backendPid).not.toBe(rolled.backendPid)
    expect(cleanup[0].seq).toBeGreaterThan(discarded[0].seq)
    expect(events.filter((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 2)).toHaveLength(1)
    expect(await effectCount()).toBe(0)
    expect(await latchCount()).toBe(0)
    console.log(JSON.stringify({ phase: 'rollback-tx2-withheld', native_rollback_returned: true, persistence: 'select', gate_effect: 0, gate_latch: 1, final_latch: 0 }))
  }, 30000)

  it('discards the owner when the product unlock returns native false', async () => {
    const sessionId = freshKey('sa-wpc-unlock-')
    const child = startSeam('smoke', sessionId, 'TRUE', fastHash, undefined, 'unlock-false')
    await waitEvent(child, 'WORKER_READY')
    child.release()
    const native = await waitEvent(child, 'UNLOCK_NATIVE_FALSE')
    const first = child.events().find((event) => event.event === 'UNLOCK_FIRST')
    expect(first?.unlocked).toBe(true)
    expect(native.unlocked).toBe(false)
    expect(first && first.seq < native.seq).toBe(true)
    expect(native.backendPid).toBeGreaterThan(0)
    expect(await sessionLockGranted(sessionId, native.backendPid ?? 0)).toBe(false)
    expect(await effectCount()).toBe(1)
    expect(await latchCount()).toBe(0)
    expect(child.events().some((event) => ['ATTEMPT_TERMINAL', 'DISPOSE_DISCARD', 'DISPOSE_RETURN'].includes(event.event))).toBe(false)
    child.faultSeen()
    expect(await child.done).toBe(0)
    const events = child.events()
    const terminal = events.find((event) => event.event === 'ATTEMPT_TERMINAL')
    expect([terminal?.outcome, terminal?.count]).toEqual(['RETURNED_TRUE', 1])
    expect(events.filter((event) => event.event === 'DISPOSE_DISCARD' && event.checkout === 1)).toHaveLength(1)
    expect(events.some((event) => event.event === 'DISPOSE_RETURN' || event.event === 'OWNER_LOST')).toBe(false)
    expect(events.filter((event) => event.event === 'CHECKOUT').map((event) => event.count)).toEqual([1])
    expect(await effectCount()).toBe(1)
    expect(await latchCount()).toBe(0)
    console.log(JSON.stringify({ phase: 'unlock-false', native_second_unlock: false, persistence: 'pg_locks', final_effect: 1, final_latch: 0 }))
  }, 30000)

  it('discards the owner when the unlock backend is dead at dispatch and keeps the result', async () => {
    const child = startSeam('smoke', freshKey('sa-wpc-unlock-err-'), 'TRUE', fastHash, undefined, 'unlock-error')
    await waitEvent(child, 'WORKER_READY')
    child.release()
    const dispatch = await waitEvent(child, 'UNLOCK_DISPATCH')
    expect(dispatch.backendPid).toBeGreaterThan(0)
    expect(await effectCount()).toBe(1)
    expect(await latchCount()).toBe(0)
    const idle = await pool().query(
      `SELECT state, xact_start IS NULL AS outside_transaction FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND application_name = 'sa_wpc_seam_smoke'`,
      [dispatch.backendPid],
    )
    expect(idle.rows).toEqual([{ state: 'idle', outside_transaction: true }])
    expect(child.events().some((event) => event.event === 'UNLOCK_REJECTED' || event.event === 'UNLOCK_NATIVE_FALSE' || event.event === 'ATTEMPT_TERMINAL')).toBe(false)
    const terminated = await pool().query<{ terminated: boolean }>(
      `SELECT pg_catalog.pg_terminate_backend(pid) AS terminated FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND application_name = 'sa_wpc_seam_smoke'`,
      [dispatch.backendPid],
    )
    expect(terminated.rows).toEqual([{ terminated: true }])
    child.unlockProceed()
    expect(await child.done).toBe(0)
    const events = child.events()
    const rejected = events.filter((event) => event.event === 'UNLOCK_REJECTED')
    const terminal = events.find((event) => event.event === 'ATTEMPT_TERMINAL')
    expect(rejected.map((event) => [event.checkout, event.backendPid])).toEqual([[1, dispatch.backendPid]])
    expect(rejected[0].seq).toBeGreaterThan(dispatch.seq)
    expect([terminal?.outcome, terminal?.count]).toEqual(['RETURNED_TRUE', 1])
    expect(events.some((event) => event.event === 'UNLOCK_FIRST' || event.event === 'UNLOCK_NATIVE_FALSE')).toBe(false)
    expect(events.filter((event) => event.event === 'DISPOSE_DISCARD' && event.checkout === 1)).toHaveLength(1)
    expect(events.some((event) => event.event === 'DISPOSE_RETURN')).toBe(false)
    expect(events.filter((event) => event.event === 'CHECKOUT').map((event) => event.count)).toEqual([1])
    expect(await effectCount()).toBe(1)
    expect(await latchCount()).toBe(0)
    console.log(JSON.stringify({ phase: 'unlock-dispatch-dead', terminated: true, driver_rejected: true, in_flight: false, terminal: 'RETURNED_TRUE', final_effect: 1 }))
  }, 30000)

  it('blocks old cleanup on the successor session lock and returns native false before the lock timeout', async () => {
    const sessionId = freshKey('sa-wpc-late-')
    const old = startSeam('smoke', sessionId, 'TRUE', fastHash, 'release', undefined, 'blocked')
    await waitEvent(old, 'WORKER_READY')
    old.release()
    const committed = await waitEvent(old, 'NATIVE_COMMIT')
    expect([committed.phase, committed.checkout]).toEqual(['release', 1])
    expect(committed.backendPid).toBeGreaterThan(0)
    const ownerIdle = await pool().query(
      `SELECT state, xact_start IS NULL AS outside_transaction FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND application_name = 'sa_wpc_seam_smoke'`,
      [committed.backendPid],
    )
    expect(ownerIdle.rows).toEqual([{ state: 'idle', outside_transaction: true }])
    expect(await latchCount()).toBe(0)
    expect(await effectCount()).toBe(1)
    expect(old.events().some((event) => ['ATTEMPT_TERMINAL', 'DISPOSE_DISCARD', 'DISPOSE_RETURN', 'CLEANUP_BEFORE_LOCK', 'RELEASE_NATIVE'].includes(event.event))).toBe(false)
    old.ackSeen()
    const paused = await waitEvent(old, 'CLEANUP_BEFORE_LOCK')
    expect([paused.checkout, paused.phase]).toEqual([2, 'release'])
    expect(paused.backendPid).not.toBe(committed.backendPid)
    expect(old.events().some((event) => event.event === 'RELEASE_NATIVE' || event.event === 'CLEANUP_LOCK_ACKED' || event.event === 'TOKEN_MATCH')).toBe(false)
    expect(await latchCount()).toBe(0)
    const successor = startSeam('smoke', sessionId, 'TRUE', fastHash, undefined, undefined, undefined, 'read', 'none')
    await waitEvent(successor, 'WORKER_READY')
    const held = await waitEvent(successor, 'READ_HELD')
    const claim = successor.events().find((event) => event.event === 'CLAIM_OWNED')
    expect(claim?.checkout).toBe(1)
    expect(held.backendPid).toBe(claim?.backendPid)
    expect(held.backendPid).toBeGreaterThan(0)
    expect(await sessionLockGranted(sessionId, held.backendPid ?? 0)).toBe(true)
    expect(await latchCount()).toBe(1)
    const live = await pool().query(
      `SELECT state, xact_start IS NOT NULL AS in_transaction FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND application_name = 'sa_wpc_seam_smoke'`,
      [held.backendPid],
    )
    expect(live.rows).toEqual([{ state: 'idle in transaction', in_transaction: true }])
    expect(old.events().some((event) => event.event === 'RELEASE_NATIVE' || event.event === 'CLEANUP_LOCK_ACKED')).toBe(false)
    old.lockProceed()
    await pollUntil(async () => {
      if (old.events().some((event) => event.event === 'RELEASE_NATIVE' || event.event === 'CLEANUP_LOCK_ACKED')) return undefined
      return await sidWaitLinked(sessionId, paused.backendPid ?? 0, held.backendPid ?? 0) ? true : undefined
    }, 4000)
    expect(old.events().some((event) => event.event === 'RELEASE_NATIVE' || event.event === 'CLEANUP_LOCK_ACKED')).toBe(false)
    successor.readRelease()
    successor.release()
    const successorTerminal = await waitEvent(successor, 'ATTEMPT_TERMINAL')
    expect([successorTerminal.outcome, successorTerminal.count]).toEqual(['RETURNED_TRUE', 1])
    expect(successor.events().filter((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 1)).toHaveLength(1)
    expect(successor.events().some((event) => event.event === 'DISPOSE_DISCARD')).toBe(false)
    expect(successor.events().filter((event) => event.event === 'CHECKOUT').map((event) => event.count)).toEqual([1])
    const locked = await waitEvent(old, 'CLEANUP_LOCK_ACKED')
    expect([locked.checkout, locked.backendPid]).toEqual([2, paused.backendPid])
    expect(locked.seq).toBeGreaterThan(paused.seq)
    expect(await successor.done).toBe(0)
    expect(await old.done).toBe(0)
    const events = old.events()
    const released = events.filter((event) => event.event === 'RELEASE_NATIVE')
    const releaseCommit = events.filter((event) => event.event === 'RELEASE_COMMIT')
    const unlocked = events.filter((event) => event.event === 'CLEANUP_UNLOCK')
    const terminal = events.find((event) => event.event === 'ATTEMPT_TERMINAL')
    const discarded = events.find((event) => event.event === 'DISPOSE_DISCARD' && event.checkout === 1)
    expect(released.map((event) => [event.checkout, event.backendPid, event.released])).toEqual([[2, paused.backendPid, false]])
    expect(released[0].seq).toBeGreaterThan(locked.seq)
    expect(releaseCommit.map((event) => [event.checkout, event.backendPid])).toEqual([[2, paused.backendPid]])
    expect(releaseCommit[0].seq).toBeGreaterThan(released[0].seq)
    expect(unlocked.map((event) => [event.checkout, event.backendPid, event.unlocked])).toEqual([[2, paused.backendPid, true]])
    expect([terminal?.outcome, terminal?.count]).toEqual(['RETURNED_TRUE', 1])
    expect(events.filter((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 2)).toHaveLength(1)
    expect(events.filter((event) => event.event === 'DISPOSE_DISCARD' && event.checkout === 2)).toHaveLength(0)
    expect(events.filter((event) => event.event === 'CALLED')).toHaveLength(1)
    expect(events.filter((event) => (discarded ? event.seq > discarded.seq : false) && ['CALLED', 'TX1_BACKEND', 'ACCOUNT_ENTERED'].includes(event.event))).toEqual([])
    expect(events.some((event) => event.event === 'TOKEN_MATCH')).toBe(false)
    expect(await latchCount()).toBe(0)
    expect(await effectCount()).toBe(1)
    expect(await sessionLockGranted(sessionId, paused.backendPid ?? 0)).toBe(false)
    expect(await sessionLockGranted(sessionId, held.backendPid ?? 0)).toBe(false)
    console.log(JSON.stringify({ phase: 'late-successor-block', native_release: false, blocked: true, within_budget: true, healthy_return: true, final_latch: 0, final_effects: 1 }))
  }, 30000)

  it('returns native false for the old token after an abandoned successor latch', async () => {
    const sessionId = freshKey('sa-wpc-abandon-')
    const successorToken = randomBytes(32).toString('hex')
    const old = startSeam('smoke', sessionId, 'TRUE', fastHash, 'release', undefined, 'abandoned')
    await waitEvent(old, 'WORKER_READY')
    old.release()
    const committed = await waitEvent(old, 'NATIVE_COMMIT')
    expect([committed.phase, committed.checkout]).toEqual(['release', 1])
    expect(await latchCount()).toBe(0)
    expect(await effectCount()).toBe(1)
    expect(old.events().some((event) => ['ATTEMPT_TERMINAL', 'CLEANUP_BEFORE_LOCK', 'RELEASE_NATIVE'].includes(event.event))).toBe(false)
    old.ackSeen()
    const paused = await waitEvent(old, 'CLEANUP_BEFORE_LOCK')
    expect(paused.checkout).toBe(2)
    expect(paused.backendPid).not.toBe(committed.backendPid)
    expect(old.events().some((event) => event.event === 'RELEASE_NATIVE' || event.event === 'TOKEN_MATCH' || event.event === 'CLEANUP_LOCK_ACKED')).toBe(false)
    const fixture = await pool().connect()
    let heldLock = false
    let boundAt = ''
    try {
      await fixture.query(`SELECT pg_catalog.set_config('lock_timeout', '5s', false)`)
      await fixture.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1::text, 0))', [`${SID_PREFIX}${sessionId}`])
      heldLock = true
      await fixture.query('BEGIN')
      const acquired = await fixture.query<{ acquired: boolean }>(
        `SELECT ${quoteIdent(schema)}.security_action_session_flight_acquire($1::text, $2::text) AS acquired`,
        [sessionId, successorToken],
      )
      expect(acquired.rows).toEqual([{ acquired: true }])
      const fixtureCommit = await fixture.query('COMMIT')
      expect(fixtureCommit.command).toBe('COMMIT')
      expect(await latchCount()).toBe(1)
      const identity = await pool().query<{ same_owner: boolean; bound_at: string }>(
        `SELECT owner_token = $2 AS same_owner, bound_at::text AS bound_at
           FROM ${quoteIdent(schema)}.security_action_session_flight
          WHERE session_id = $1`,
        [sessionId, successorToken],
      )
      expect(identity.rows).toHaveLength(1)
      expect(identity.rows[0]?.same_owner).toBe(true)
      boundAt = identity.rows[0]?.bound_at ?? ''
      expect(boundAt.length).toBeGreaterThan(0)
      const unlocked = await fixture.query<{ unlocked: boolean }>(
        'SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::text, 0)) AS unlocked',
        [`${SID_PREFIX}${sessionId}`],
      )
      expect(unlocked.rows).toEqual([{ unlocked: true }])
      heldLock = false
      const fixturePid = Number(fixture.processID)
      expect(fixturePid).toBeGreaterThan(0)
      expect(await sessionLockGranted(sessionId, fixturePid)).toBe(false)
    } finally {
      await fixture.query('ROLLBACK').catch(() => undefined)
      if (heldLock) {
        await fixture.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::text, 0))', [`${SID_PREFIX}${sessionId}`]).catch(() => undefined)
      }
      await fixture.query('RESET lock_timeout').catch(() => undefined)
      fixture.release()
    }
    expect(old.events().filter((event) => event.event === 'CALLED')).toHaveLength(1)
    expect(old.events().some((event) => event.event === 'ACCOUNT_ENTERED' && event.checkout === 2)).toBe(false)
    expect(await latchCount()).toBe(1)
    old.lockProceed()
    const native = await waitEvent(old, 'RELEASE_NATIVE')
    const locked = old.events().find((event) => event.event === 'CLEANUP_LOCK_ACKED')
    const match = old.events().find((event) => event.event === 'TOKEN_MATCH')
    expect(locked?.checkout).toBe(2)
    expect(locked?.backendPid).toBe(paused.backendPid)
    expect(native.seq).toBeGreaterThan(locked?.seq ?? 0)
    expect([native.checkout, native.backendPid, native.released]).toEqual([2, paused.backendPid, false])
    expect([match?.checkout, match?.equal, match?.different]).toEqual([2, true, false])
    const unchanged = await pool().query<{ n: number; same_owner: boolean; same_bound: boolean }>(
      `SELECT count(*)::integer AS n,
              bool_and(owner_token = $2) AS same_owner,
              bool_and(bound_at::text = $3) AS same_bound
         FROM ${quoteIdent(schema)}.security_action_session_flight
        WHERE session_id = $1`,
      [sessionId, successorToken, boundAt],
    )
    expect(unchanged.rows).toEqual([{ n: 1, same_owner: true, same_bound: true }])
    expect(await old.done).toBe(0)
    const events = old.events()
    const discarded = events.find((event) => event.event === 'DISPOSE_DISCARD' && event.checkout === 1)
    expect(events.filter((event) => event.event === 'RELEASE_COMMIT' && event.checkout === 2 && event.backendPid === paused.backendPid)).toHaveLength(1)
    expect(events.filter((event) => event.event === 'CLEANUP_UNLOCK' && event.checkout === 2 && event.unlocked === true)).toHaveLength(1)
    expect(events.filter((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 2)).toHaveLength(1)
    expect(events.filter((event) => event.event === 'DISPOSE_DISCARD' && event.checkout === 2)).toHaveLength(0)
    expect(events.filter((event) => event.event === 'CLAIM_OWNED' && event.checkout === 2)).toHaveLength(0)
    expect(events.filter((event) => event.event === 'CALLED')).toHaveLength(1)
    expect(events.filter((event) => event.event === 'ACCOUNT_ENTERED')).toHaveLength(1)
    expect(events.find((event) => event.event === 'ATTEMPT_TERMINAL')?.outcome).toBe('RETURNED_TRUE')
    expect(events.filter((event) => (discarded ? event.seq > discarded.seq : false) && ['CALLED', 'TX1_BACKEND', 'ACCOUNT_ENTERED'].includes(event.event))).toEqual([])
    const again = await pool().connect()
    let againHeld = false
    try {
      await again.query(`SELECT pg_catalog.set_config('lock_timeout', '5s', false)`)
      await again.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1::text, 0))', [`${SID_PREFIX}${sessionId}`])
      againHeld = true
      await again.query('BEGIN')
      const removed = await again.query<{ released: boolean }>(
        `SELECT ${quoteIdent(schema)}.security_action_session_flight_release($1::text, $2::text) AS released`,
        [sessionId, successorToken],
      )
      expect(removed.rows).toEqual([{ released: true }])
      const againCommit = await again.query('COMMIT')
      expect(againCommit.command).toBe('COMMIT')
      const againUnlock = await again.query<{ unlocked: boolean }>(
        'SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::text, 0)) AS unlocked',
        [`${SID_PREFIX}${sessionId}`],
      )
      expect(againUnlock.rows).toEqual([{ unlocked: true }])
      againHeld = false
    } finally {
      if (againHeld) {
        await again.query('ROLLBACK').catch(() => undefined)
        await again.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::text, 0))', [`${SID_PREFIX}${sessionId}`]).catch(() => undefined)
      }
      await again.query('RESET lock_timeout').catch(() => undefined)
      again.release()
    }
    expect(await latchCount()).toBe(0)
    expect(await effectCount()).toBe(1)
    console.log(JSON.stringify({ phase: 'abandoned-successor', native_release: false, token_equal: true, token_different: false, healthy_return: true, row_unchanged: true, final_latch: 0, final_effects: 1 }))
  }, 30000)

  it('withholds the acquisition COMMIT acknowledgement before the latch claim', async () => {
    const sessionId = freshKey('sa-wpc-ack-acq-')
    const child = startSeam('smoke', sessionId, 'TRUE', fastHash, 'acquisition')
    await waitEvent(child, 'WORKER_READY')
    child.release()
    const committed = await waitEvent(child, 'NATIVE_COMMIT')
    expect([committed.phase, committed.checkout]).toEqual(['acquisition', 1])
    expect(committed.backendPid).toBeGreaterThan(0)
    expect(child.events().filter((event) => event.event === 'NATIVE_COMMIT')).toHaveLength(1)
    const ready = child.events().filter((event) => event.event === 'CHECKOUT_READY')
    expect(ready.map((event) => [event.checkout, event.backendPid])).toEqual([[1, committed.backendPid]])
    const backend = await pool().query(
      `SELECT state, xact_start IS NULL AS outside_transaction FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND application_name = 'sa_wpc_seam_smoke'`,
      [committed.backendPid],
    )
    expect(backend.rows).toEqual([{ state: 'idle', outside_transaction: true }])
    expect(await sessionLockGranted(sessionId, committed.backendPid ?? 0)).toBe(true)
    expect(await latchCount()).toBe(0)
    expect(await effectCount()).toBe(0)
    expect(child.events().some((event) => ['CLAIM_OWNED', 'CLAIM_FOREIGN', 'TX1_BACKEND', 'CALLED', 'ACCOUNT_ENTERED', 'ATTEMPT_TERMINAL', 'DISPOSE_DISCARD', 'DISPOSE_RETURN', 'OWNER_LOST', 'RELEASE_NATIVE'].includes(event.event))).toBe(false)
    child.ackSeen()
    const locked = await waitEvent(child, 'CLEANUP_LOCK_ACKED')
    expect(locked.checkout).toBe(2)
    expect(locked.backendPid).not.toBe(committed.backendPid)
    expect(locked.backendPid).toBeGreaterThan(0)
    await pollUntil(async () => {
      const gone = await pool().query<{ n: number }>(
        `SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
          WHERE pid = $1 AND datname = current_database()`,
        [committed.backendPid],
      )
      if (gone.rows[0]?.n !== 0) return undefined
      if (!await sessionLockGranted(sessionId, locked.backendPid ?? 0)) return undefined
      return true
    }, 2000)
    const cleanupIdle = await pool().query(
      `SELECT state, xact_start IS NULL AS outside_transaction FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND application_name = 'sa_wpc_seam_smoke'`,
      [locked.backendPid],
    )
    expect(cleanupIdle.rows).toEqual([{ state: 'idle', outside_transaction: true }])
    expect(await sessionLockGranted(sessionId, committed.backendPid ?? 0)).toBe(false)
    expect(await latchCount()).toBe(0)
    expect(await effectCount()).toBe(0)
    expect(child.events().some((event) => event.event === 'RELEASE_NATIVE' || event.event === 'CLAIM_OWNED' || event.event === 'CALLED' || event.event === 'TX1_BACKEND' || event.event === 'ACCOUNT_ENTERED')).toBe(false)
    child.cleanupSeen()
    expect(await child.done).toBe(0)
    const events = child.events()
    const withheld = events.filter((event) => event.event === 'ACK_WITHHELD')
    const discarded = events.filter((event) => event.event === 'DISPOSE_DISCARD' && event.checkout === 1)
    const nativeRelease = events.filter((event) => event.event === 'RELEASE_NATIVE')
    const releaseCommit = events.filter((event) => event.event === 'RELEASE_COMMIT')
    const unlocked = events.filter((event) => event.event === 'CLEANUP_UNLOCK')
    const terminal = events.find((event) => event.event === 'ATTEMPT_TERMINAL')
    expect(withheld.map((event) => [event.phase, event.checkout, event.backendPid])).toEqual([['acquisition', 1, committed.backendPid]])
    expect(withheld[0].seq).toBeGreaterThan(committed.seq)
    expect(discarded).toHaveLength(1)
    expect(discarded[0].seq).toBeGreaterThan(withheld[0].seq)
    expect(locked.seq).toBeGreaterThan(discarded[0].seq)
    expect(events.some((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 1)).toBe(false)
    expect(events.filter((event) => event.event === 'CHECKOUT').map((event) => event.count)).toEqual([1, 2])
    expect([terminal?.outcome, terminal?.count]).toEqual(['UNAVAILABLE', 0])
    expect(events.filter((event) => event.event === 'CALLED' || event.event === 'TX1_BACKEND' || event.event === 'ACCOUNT_ENTERED' || event.event === 'CLAIM_OWNED' || event.event === 'CLAIM_FOREIGN')).toHaveLength(0)
    expect(nativeRelease.map((event) => [event.checkout, event.backendPid, event.released])).toEqual([[2, locked.backendPid, false]])
    expect(nativeRelease[0].seq).toBeGreaterThan(locked.seq)
    expect(releaseCommit.map((event) => [event.checkout, event.backendPid])).toEqual([[2, locked.backendPid]])
    expect(unlocked.map((event) => [event.checkout, event.backendPid, event.unlocked])).toEqual([[2, locked.backendPid, true]])
    expect(events.filter((event) => event.event === 'DISPOSE_RETURN' && event.checkout === 2)).toHaveLength(1)
    expect(events.filter((event) => event.event === 'DISPOSE_DISCARD' && event.checkout === 2)).toHaveLength(0)
    expect(events.some((event) => event.event === 'TOKEN_MATCH' || event.event === 'OWNER_LOST')).toBe(false)
    expect(await latchCount()).toBe(0)
    expect(await effectCount()).toBe(0)
    expect(await sessionLockGranted(sessionId, locked.backendPid ?? 0)).toBe(false)
    expect(await sessionLockGranted(sessionId, committed.backendPid ?? 0)).toBe(false)
    console.log(JSON.stringify({ phase: 'acquisition-commit-ack', native_commit_observed: true, idle: true, outside_transaction: true, sid_granted_at_gate: true, native_release: false, cleanup_pid_distinct: true, final_latch: 0, final_effects: 0, terminal: 'UNAVAILABLE' }))
  }, 30000)

  function pool(): PgPool {
    if (!observe) throw new Error('comparison observer unavailable')
    return observe
  }

  async function assertRollbackGate(child: SeamChild, rolled: SeamEvent, phase: 'read' | 'account'): Promise<void> {
    expect([rolled.phase, rolled.checkout]).toEqual([phase, 1])
    const events = child.events()
    const visible = events.filter((event) => event.event === 'EFFECT_VISIBLE')
    const sqlstate = events.filter((event) => event.event === 'SQLSTATE_23502')
    expect(visible).toHaveLength(1)
    expect(sqlstate).toHaveLength(1)
    expect(visible[0].seq).toBeLessThan(sqlstate[0].seq)
    expect(sqlstate[0].seq).toBeLessThan(rolled.seq)
    expect(events.filter((event) => event.event === 'NATIVE_ROLLBACK')).toHaveLength(1)
    expect(events.some((event) => ['ROLLBACK_WITHHELD', 'OWNER_LOST', 'DISPOSE_DISCARD', 'DISPOSE_RETURN', 'ATTEMPT_TERMINAL'].includes(event.event))).toBe(false)
    const ready = events.filter((event) => event.event === 'CHECKOUT_READY')
    expect(ready.map((event) => [event.checkout, event.backendPid])).toEqual([[1, rolled.backendPid]])
    const backend = await pool().query(
      `SELECT state, xact_start IS NULL AS outside_transaction FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND application_name = 'sa_wpc_seam_smoke'`,
      [rolled.backendPid],
    )
    expect(backend.rows).toEqual([{ state: 'idle', outside_transaction: true }])
    expect(await effectCount()).toBe(0)
    expect(await latchCount()).toBe(1)
  }

  async function sessionLockGranted(sessionId: string, backendPid: number): Promise<boolean> {
    const key = `${SID_PREFIX}${sessionId}`
    const found = await pool().query<{ k: string }>('SELECT pg_catalog.hashtextextended($1::text, 0)::text AS k', [key])
    const raw = found.rows[0]?.k
    if (typeof raw !== 'string') throw new Error('advisory key was not available')
    const value = BigInt(raw)
    const unsigned = value < 0n ? value + (1n << 64n) : value
    const classid = ((unsigned >> 32n) & 0xffffffffn).toString()
    const objid = (unsigned & 0xffffffffn).toString()
    const held = await pool().query<{ held: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_locks l
          WHERE l.locktype = 'advisory' AND l.granted AND l.pid = $3 AND l.objsubid = 1
            AND l.classid = $1::oid AND l.objid = $2::oid
       ) AS held`,
      [classid, objid, backendPid],
    )
    return held.rows[0]?.held === true
  }

  async function sidWaitLinked(sessionId: string, waiterPid: number, holderPid: number): Promise<boolean> {
    const key = `${SID_PREFIX}${sessionId}`
    const found = await pool().query<{ k: string }>('SELECT pg_catalog.hashtextextended($1::text, 0)::text AS k', [key])
    const raw = found.rows[0]?.k
    if (typeof raw !== 'string' || waiterPid < 1 || holderPid < 1) return false
    const value = BigInt(raw)
    const unsigned = value < 0n ? value + (1n << 64n) : value
    const classid = ((unsigned >> 32n) & 0xffffffffn).toString()
    const objid = (unsigned & 0xffffffffn).toString()
    const linked = await pool().query<{ linked: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM pg_catalog.pg_locks l
            WHERE l.locktype = 'advisory' AND NOT l.granted AND l.pid = $3 AND l.objsubid = 1
              AND l.classid = $1::oid AND l.objid = $2::oid
         )
         AND EXISTS (
           SELECT 1 FROM pg_catalog.pg_locks l
            WHERE l.locktype = 'advisory' AND l.granted AND l.pid = $4 AND l.objsubid = 1
              AND l.classid = $1::oid AND l.objid = $2::oid
         )
         AND pg_catalog.pg_blocking_pids($3::integer) @> ARRAY[$4::integer]
       ) AS linked`,
      [classid, objid, waiterPid, holderPid],
    )
    return linked.rows[0]?.linked === true
  }

  async function latchCount(): Promise<number> {
    return Number((await pool().query(`SELECT count(*)::integer AS count FROM ${quoteIdent(schema)}.security_action_session_flight`)).rows[0].count)
  }

  async function effectCount(): Promise<number> {
    return Number((await pool().query(`SELECT count(*)::integer AS count FROM ${quoteIdent(schema)}.security_action_attempt_effect`)).rows[0].count)
  }

  function startSeam(
    role: 'owner' | 'peer' | 'smoke',
    sessionId: string,
    outcome: 'TRUE' | 'FALSE' | 'ERROR',
    hash: string,
    ack?: 'claim' | 'account' | 'release' | 'acquisition',
    fault?: SeamFault,
    hold?: SeamHold,
    gate?: 'read',
    effect: 'insert' | 'none' = 'insert',
    owner: SeamDatabaseOwner = databaseOwner,
  ): SeamChild {
    const directory = join(PACKAGE_ROOT, '../../artifacts', freshKey(`wpc-seam-${role}-`))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const url = new URL(databaseUrl)
    url.searchParams.set('options', `-c search_path=${schema} -c application_name=sa_wpc_seam_${role}`)
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8',
      EXPECT_DB: '1', SECRET_PROVIDER: 'env', DATABASE_URL: url.toString(), SA_SEAM_SYNTHETIC: 'true',
      SA_SCHEMA: schema, SA_SEAM_ROLE: role, SA_SEAM_CONTROL_DIR: directory, SA_SEAM_OUTCOME: outcome,
      SA_SESSION_ID: sessionId, SA_PASSWORD: outcome === 'FALSE' ? `${secret}-wrong` : secret,
      SA_PASSWORD_HASH: outcome === 'ERROR' ? hash.replace('$2b$', '$2c$') : hash, SA_SEAM_EFFECT: effect,
      SA_SEAM_DATABASE_OWNER: JSON.stringify(owner),
    }
    if (ack) env.SA_SEAM_ACK = ack
    if (fault) env.SA_SEAM_FAULT = fault
    if (hold) env.SA_SEAM_HOLD = hold
    if (gate) env.SA_SEAM_GATE = gate
    const processHandle = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/security-action-comparison-seam/bootstrap.mjs', import.meta.url))], {
      cwd: PACKAGE_ROOT, env, stdio: 'ignore',
    })
    let exited = false
    const done = new Promise<number>((resolve) => {
      processHandle.once('error', () => { exited = true; resolve(1) })
      processHandle.once('close', (code) => { exited = true; resolve(code ?? 1) })
    })
    const child: SeamChild = {
      events: () => {
        const path = join(directory, 'events.jsonl')
        if (!existsSync(path)) return []
        const lines = readFileSync(path, 'utf8').split('\n')
        return lines.slice(0, -1).map((line) => JSON.parse(line) as SeamEvent)
      },
      exited: () => exited,
      release: () => {
        const path = join(directory, 'release.json')
        if (!existsSync(path)) writeFileSync(path, JSON.stringify({ command: 'RELEASE', role }), { mode: 0o600, flag: 'wx' })
      },
      ackSeen: () => {
        if (!ack) return
        const path = join(directory, 'ack-seen.json')
        if (!existsSync(path)) writeFileSync(path, JSON.stringify({ command: 'ACK_SEEN', role, phase: ack }), { mode: 0o600, flag: 'wx' })
      },
      faultSeen: () => {
        if (!fault || fault === 'unlock-error') return
        const path = join(directory, 'fault-seen.json')
        if (!existsSync(path)) writeFileSync(path, JSON.stringify({ command: 'FAULT_SEEN', role, fault }), { mode: 0o600, flag: 'wx' })
      },
      unlockProceed: () => {
        if (fault !== 'unlock-error') return
        const path = join(directory, 'unlock-proceed.json')
        if (!existsSync(path)) writeFileSync(path, JSON.stringify({ command: 'UNLOCK_PROCEED', role }), { mode: 0o600, flag: 'wx' })
      },
      lockProceed: () => {
        if (hold !== 'blocked' && hold !== 'abandoned') return
        const path = join(directory, 'lock-proceed.json')
        if (!existsSync(path)) writeFileSync(path, JSON.stringify({ command: 'LOCK_PROCEED', role }), { mode: 0o600, flag: 'wx' })
      },
      readRelease: () => {
        if (gate !== 'read') return
        const path = join(directory, 'read-release.json')
        if (!existsSync(path)) writeFileSync(path, JSON.stringify({ command: 'READ_RELEASE', role }), { mode: 0o600, flag: 'wx' })
      },
      cleanupSeen: () => {
        if (ack !== 'acquisition') return
        const path = join(directory, 'cleanup-seen.json')
        if (!existsSync(path)) writeFileSync(path, JSON.stringify({ command: 'CLEANUP_SEEN', role }), { mode: 0o600, flag: 'wx' })
      },
      done,
      stop: () => { if (processHandle.exitCode === null) processHandle.kill() },
    }
    children.push(child)
    return child
  }

  async function waitEvent(child: SeamChild, name: string): Promise<SeamEvent> {
    return pollUntil(async () => {
      const event = child.events().find((entry) => entry.event === name)
      if (event) return event
      if (child.exited()) throw new Error('SEAM_CHILD_EXITED_BEFORE_EVENT')
      return undefined
    }, 8000)
  }
})
