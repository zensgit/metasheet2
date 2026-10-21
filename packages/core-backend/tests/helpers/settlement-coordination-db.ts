/**
 * Real-database helpers for the attendance settlement coordination suites. Observations go
 * through a SEPARATE pool connection (never the connection under test), so they see what the
 * server actually holds rather than what the code under test believes.
 */
import type { Pool, PoolClient } from 'pg'

import { SETTLEMENT_COORDINATION_KEY1 } from '../../src/attendance/coordination/settlement-coordination-key'

export interface AdvisoryLockRow {
  classid: string
  objid: string
  objsubid: number
  mode: string
  granted: boolean
}

export async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid')
  return Number(rows[0].pid)
}

/** Advisory locks held or awaited by `pid` in the current database, as seen from `observer`. */
export async function advisoryLocksOf(observer: Pool, pid: number): Promise<AdvisoryLockRow[]> {
  const { rows } = await observer.query(
    `SELECT classid::text AS classid, objid::text AS objid, objsubid::int AS objsubid, mode, granted
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND pid = $1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY objsubid, classid, objid, mode`,
    [pid],
  )
  return rows as AdvisoryLockRow[]
}

/** Two-int4 dedicated key: classid = key1, objid = key2 read as unsigned, objsubid = 2. */
export function isDedicatedLock(row: AdvisoryLockRow, key2: number): boolean {
  return row.objsubid === 2 && row.classid === String(SETTLEMENT_COORDINATION_KEY1) && row.objid === String(key2 >>> 0)
}

/** Single-bigint key: classid = high 32 bits, objid = low 32 bits, objsubid = 1. */
export function isBigintLock(row: AdvisoryLockRow, key: bigint): boolean {
  const unsigned = BigInt.asUintN(64, key)
  return row.objsubid === 1 && row.classid === String(unsigned >> 32n) && row.objid === String(unsigned & 0xffffffffn)
}

export async function backendAlive(observer: Pool, pid: number): Promise<boolean> {
  const { rows } = await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid])
  return Number(rows[0].n) > 0
}

/** Waits until the backend is gone; destruction is asynchronous on the server side. */
export async function waitForBackendGone(observer: Pool, pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await backendAlive(observer, pid))) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !(await backendAlive(observer, pid))
}

/** Waits until `pid` shows an ungranted advisory lock request (it is queued). */
export async function waitForQueuedAdvisory(observer: Pool, pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await advisoryLocksOf(observer, pid)
    if (rows.some((row) => !row.granted)) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}
