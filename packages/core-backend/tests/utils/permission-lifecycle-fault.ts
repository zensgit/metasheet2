import { pool, query } from '../../src/db/pg'

const RUN_HEX = /^[0-9a-f]{12}$/

export interface NamespaceAdmissionLock {
  pid: number
  release: () => Promise<void>
}

function assertUuid(userId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('admission fault user id must be a uuid')
  }
}

function assertRunHex(runHex: string): void {
  if (!RUN_HEX.test(runHex)) throw new Error('permission lifecycle suffix must be 12 hex characters')
}

function faultNames(runHex: string): { fn: string; trigger: string } {
  assertRunHex(runHex)
  return {
    fn: `plc_fail_${runHex}`,
    trigger: `plc_fail_${runHex}_trg`,
  }
}

function scopeInsertNames(runHex: string): { fn: string; trigger: string } {
  assertRunHex(runHex)
  return {
    fn: `plc_scope_ins_${runHex}`,
    trigger: `plc_scope_ins_${runHex}_trg`,
  }
}

export function scopeInsertLockKey(runHex: string): string {
  assertRunHex(runHex)
  return `plc-scope-insert:${runHex}`
}

export async function installPermissionLifecycleAdmissionFault(userId: string, runHex: string): Promise<void> {
  assertUuid(userId)
  const { fn, trigger } = faultNames(runHex)
  await dropPermissionLifecycleAdmissionFault(runHex)
  await query(
    `CREATE FUNCTION ${fn}() RETURNS trigger
     LANGUAGE plpgsql AS $fn$
     BEGIN
       IF NEW.user_id::text = '${userId}' THEN
         RAISE EXCEPTION 'permission lifecycle injected admission failure' USING ERRCODE = 'P0001';
       END IF;
       RETURN NEW;
     END
     $fn$`,
  )
  await query(
    `CREATE TRIGGER ${trigger}
     BEFORE INSERT OR UPDATE ON user_namespace_admissions
     FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  )
}

export async function dropPermissionLifecycleAdmissionFault(runHex: string): Promise<void> {
  const { fn, trigger } = faultNames(runHex)
  await query(`DROP TRIGGER IF EXISTS ${trigger} ON user_namespace_admissions`)
  await query(`DROP FUNCTION IF EXISTS ${fn}()`)
}

/**
 * Blocks only this user's stock-prep scope INSERT, after the route's role precheck,
 * until the matching advisory lock is released.
 */
export async function installPermissionLifecycleScopeInsertGate(userId: string, runHex: string): Promise<void> {
  assertUuid(userId)
  const { fn, trigger } = scopeInsertNames(runHex)
  const lockKey = scopeInsertLockKey(runHex)
  await dropPermissionLifecycleScopeInsertGate(runHex)
  await query(
    `CREATE FUNCTION ${fn}() RETURNS trigger
     LANGUAGE plpgsql AS $fn$
     BEGIN
       IF NEW.admin_user_id::text = '${userId}' AND NEW.namespace = 'stock-prep' THEN
         PERFORM pg_advisory_xact_lock(hashtextextended('${lockKey}', 0));
       END IF;
       RETURN NEW;
     END
     $fn$`,
  )
  await query(
    `CREATE TRIGGER ${trigger}
     BEFORE INSERT ON delegated_role_admin_scopes
     FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  )
  await query(
    `CREATE TRIGGER ${trigger}_grp
     BEFORE INSERT ON delegated_role_admin_member_groups
     FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  )
}

export async function dropPermissionLifecycleScopeInsertGate(runHex: string): Promise<void> {
  const { fn, trigger } = scopeInsertNames(runHex)
  await query(`DROP TRIGGER IF EXISTS ${trigger} ON delegated_role_admin_scopes`)
  await query(`DROP TRIGGER IF EXISTS ${trigger}_grp ON delegated_role_admin_member_groups`)
  await query(`DROP FUNCTION IF EXISTS ${fn}()`)
}

function memberGroupFaultNames(runHex: string): { fn: string; trigger: string } {
  assertRunHex(runHex)
  return { fn: `plc_grp_fail_${runHex}`, trigger: `plc_grp_fail_${runHex}_trg` }
}

export async function installPermissionLifecycleMemberGroupInsertFault(userId: string, runHex: string): Promise<void> {
  assertUuid(userId)
  const { fn, trigger } = memberGroupFaultNames(runHex)
  await dropPermissionLifecycleMemberGroupInsertFault(runHex)
  await query(
    `CREATE FUNCTION ${fn}() RETURNS trigger
     LANGUAGE plpgsql AS $fn$
     BEGIN
       IF NEW.admin_user_id::text = '${userId}' THEN
         RAISE EXCEPTION 'permission lifecycle injected member-group scope failure' USING ERRCODE = 'P0001';
       END IF;
       RETURN NEW;
     END
     $fn$`,
  )
  await query(
    `CREATE TRIGGER ${trigger}
     BEFORE INSERT ON delegated_role_admin_member_groups
     FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  )
}

export async function dropPermissionLifecycleMemberGroupInsertFault(runHex: string): Promise<void> {
  const { fn, trigger } = memberGroupFaultNames(runHex)
  await query(`DROP TRIGGER IF EXISTS ${trigger} ON delegated_role_admin_member_groups`)
  await query(`DROP FUNCTION IF EXISTS ${fn}()`)
}

async function holdAdvisoryLock(key: string): Promise<NamespaceAdmissionLock> {
  if (!pool) throw new Error('pg pool is unavailable')
  const client = await pool.connect()
  let released = false
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key])
  } catch (error) {
    client.release()
    throw error
  }
  const pidResult = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  const pid = Number(pidResult.rows[0]?.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    client.release()
    throw new Error('admission lock holder did not return a backend pid')
  }
  return {
    pid,
    release: async () => {
      if (released) return
      released = true
      try {
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    },
  }
}

export function holdNamespaceAdmissionLock(userId: string): Promise<NamespaceAdmissionLock> {
  assertUuid(userId)
  return holdAdvisoryLock(`namespace-admission:${userId}`)
}

export function holdScopeInsertLock(runHex: string): Promise<NamespaceAdmissionLock> {
  return holdAdvisoryLock(scopeInsertLockKey(runHex))
}

/**
 * True only when a backend is waiting on the advisory lock held by `blockerPid`.
 * The join is the lock identity (classid, objid, objsubid), so other waiters do not count.
 */
async function advisoryLockWaiterPids(blockerPid: number): Promise<number[]> {
  const waiting = await query<{ pid: number }>(
    `SELECT waiter.pid
     FROM pg_stat_activity waiter
     WHERE waiter.wait_event_type = 'Lock'
       AND $1 = ANY (pg_blocking_pids(waiter.pid))
       AND EXISTS (
         SELECT 1
         FROM pg_locks blocked
         JOIN pg_locks blocker
           ON blocker.locktype = blocked.locktype
          AND blocker.classid = blocked.classid
          AND blocker.objid = blocked.objid
          AND blocker.objsubid = blocked.objsubid
          AND blocker.granted
          AND NOT blocked.granted
         WHERE blocked.pid = waiter.pid
           AND blocker.pid = $1
           AND blocked.locktype = 'advisory'
       )`,
    [blockerPid],
  )
  return waiting.rows.map((row) => Number(row.pid)).filter((pid) => Number.isInteger(pid) && pid > 0)
}

export async function waitForAdvisoryLockWaiterPid(
  blockerPid: number,
  options: { ignorePids?: number[]; timeoutMs?: number } = {},
): Promise<number | null> {
  if (!Number.isInteger(blockerPid) || blockerPid <= 0) {
    throw new Error('admission lock waiter requires the holder pid')
  }
  const ignore = new Set(options.ignorePids ?? [])
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  while (Date.now() < deadline) {
    const found = (await advisoryLockWaiterPids(blockerPid)).find((pid) => !ignore.has(pid))
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return null
}

export async function waitForNamespaceAdmissionLockWaiter(blockerPid: number, timeoutMs = 5000): Promise<boolean> {
  return (await waitForAdvisoryLockWaiterPid(blockerPid, { timeoutMs })) !== null
}

/** True when `writerPid` holds a granted advisory lock other than the one `gatePid` holds. */
export async function writerHoldsAdvisoryLockBesides(writerPid: number, gatePid: number): Promise<boolean> {
  const result = await query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM pg_locks held
     WHERE held.pid = $1
       AND held.granted
       AND held.locktype = 'advisory'
       AND NOT EXISTS (
         SELECT 1
         FROM pg_locks gate
         WHERE gate.pid = $2
           AND gate.granted
           AND gate.locktype = 'advisory'
           AND gate.classid IS NOT DISTINCT FROM held.classid
           AND gate.objid IS NOT DISTINCT FROM held.objid
           AND gate.objsubid IS NOT DISTINCT FROM held.objsubid
       )`,
    [writerPid, gatePid],
  )
  return (result.rows[0]?.n ?? 0) > 0
}
