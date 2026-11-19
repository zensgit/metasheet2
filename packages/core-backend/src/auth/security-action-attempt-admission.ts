/**
 * One physical connection for one local-password security-action attempt.
 *
 * The connection takes the session advisory lock and the active session latch, runs the first
 * read, compares the password while no transaction is open, runs the accounting transaction, then
 * releases that same latch and lock. It never checks a connection back into the pool once the
 * ownership of a command is unknown. A later cleanup connection may delete only the original
 * session and owner token, and only after the comparison is quiescent.
 */
import { randomBytes } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { pool } from '../db/pg'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { withAuthorizationInputTransaction } from '../rbac/authorization-input-lock'
import type { AuthorizationInputHandlerClient, AuthorizationInputTx } from '../rbac/authorization-input-lock'
import type { PrivilegeRolePlan } from '../rbac/authorization-privilege-witness-plan'

const SID_PREFIX = 'security-action-sid:'
const RELATION = 'security_action_session_flight'
const ACQUIRE = 'security_action_session_flight_acquire'
const RELEASE = 'security_action_session_flight_release'
const LOCK_TIMEOUT = '5s'
const STATEMENT_TIMEOUT = '30s'
const IDENT = /^[a-z_][a-z0-9_]*$/
const OID = /^[1-9][0-9]*$/
const SQLSTATE = /^[0-9A-Z]{5}$/
const CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\b/i

export type OwnedAttemptSnapshot = Readonly<{ passwordHash: string }>

export type OwnedAttemptSteps<Snapshot extends OwnedAttemptSnapshot, Outcome> = Readonly<{
  readInputs(tx: Queryable): Promise<Snapshot>
  account(tx: Queryable, firstSnapshot: Snapshot, verified: boolean): Promise<Outcome>
}>

export type AdminGrantOwnedSteps<Snapshot extends OwnedAttemptSnapshot, Outcome> = Readonly<{
  kind: 'admin_grant_issue'
  privilegePlan: PrivilegeRolePlan
  readInputs(tx: AuthorizationInputTx): Promise<Snapshot>
  accountRejected(tx: Queryable, first: Snapshot): Promise<Outcome>
  issue(tx: AuthorizationInputTx, first: Snapshot): Promise<Outcome>
}>

type ComparePhase = 'not-started' | 'admitted' | 'terminal'
type LockState = 'none' | 'acked' | 'uncertain'
type ClaimState = 'none' | 'owned' | 'foreign' | 'uncertain'
type Decision<Outcome> =
  | Readonly<{ kind: 'value'; value: Outcome }>
  | Readonly<{ kind: 'domain'; error: unknown }>
  | Readonly<{ kind: 'unavailable' }>

type Epoch = { sealed: boolean; pending: Array<Promise<unknown>> }

type Checkout = {
  client: PoolClient
  lost: boolean
  discarded: boolean
  released: boolean
  mark: () => void
}

class AttemptUnavailable extends Error {
  constructor() {
    super('Security action refused')
    this.name = 'AttemptUnavailable'
  }
}

function isDomain(error: unknown): boolean {
  return error instanceof Error && error.name === 'SecurityActionProofError'
}

function isSqlState(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && SQLSTATE.test(code)
}

function qualify(schema: string, name: string): string {
  if (!IDENT.test(schema) || !IDENT.test(name)) throw new AttemptUnavailable()
  return `"${schema}"."${name}"`
}

function hasConnectionString(candidate: NonNullable<typeof pool>): boolean {
  const options = (candidate as { options?: { connectionString?: unknown } }).options
  return typeof options?.connectionString === 'string' && options.connectionString.length > 0
}

function attach(client: PoolClient, seal: () => void): Checkout {
  const owned: Checkout = {
    client,
    lost: false,
    discarded: false,
    released: false,
    mark: () => {
      owned.lost = true
      seal()
      dispose(owned, true)
    },
  }
  client.on('error', owned.mark)
  client.on('end', owned.mark)
  return owned
}

function dispose(owned: Checkout, discard: boolean): void {
  if (owned.released) return
  owned.released = true
  owned.client.removeListener('error', owned.mark)
  owned.client.removeListener('end', owned.mark)
  try {
    if (discard || owned.lost) {
      owned.discarded = true
      owned.client.release(new Error('discard'))
    } else {
      owned.client.release()
    }
  } catch {
    owned.discarded = true
  }
}

async function runQuery<T extends QueryResultRow>(owned: Checkout, text: string, params: unknown[] = []): Promise<QueryResult<T>> {
  if (owned.lost || owned.discarded || owned.released) throw new AttemptUnavailable()
  let pending: Promise<QueryResult<T>>
  try {
    pending = owned.client.query<T>(text, params)
  } catch {
    throw new AttemptUnavailable()
  }
  try {
    const result = await pending
    if (owned.lost) throw new AttemptUnavailable()
    return result
  } catch (error) {
    if (error instanceof AttemptUnavailable) throw error
    if (owned.lost || !isSqlState(error)) {
      owned.mark()
      throw new AttemptUnavailable()
    }
    throw error
  }
}

async function rollback(owned: Checkout): Promise<boolean> {
  if (owned.lost || owned.discarded || owned.released) return false
  try {
    await runQuery(owned, 'ROLLBACK')
    return !owned.lost
  } catch {
    owned.mark()
    return false
  }
}

async function drain(epoch: Epoch): Promise<unknown | null> {
  epoch.sealed = true
  let failure: unknown = null
  while (epoch.pending.length > 0) {
    const batch = epoch.pending.splice(0, epoch.pending.length)
    const settled = await Promise.allSettled(batch)
    for (const item of settled) {
      if (item.status === 'rejected' && failure === null) failure = item.reason
    }
  }
  return failure
}

function scoped(owned: Checkout, epoch: Epoch, slotBusy: () => boolean): Queryable {
  return {
    query: (sql, params = []) => {
      if (epoch.sealed || !slotBusy() || owned.lost || owned.discarded || owned.released) {
        return Promise.reject(new AttemptUnavailable())
      }
      if (typeof sql !== 'string' || CONTROL.test(sql) || sql.includes('pg_advisory_unlock')) {
        return Promise.reject(new AttemptUnavailable())
      }
      let pending: Promise<QueryResult>
      try {
        pending = owned.client.query(sql, params)
      } catch {
        return Promise.reject(new AttemptUnavailable())
      }
      const tracked = pending.then(
        (result) => {
          if (owned.lost) throw new AttemptUnavailable()
          return result
        },
        (error: unknown) => {
          if (!isSqlState(error)) owned.mark()
          throw error
        },
      )
      void tracked.then(() => undefined, () => undefined)
      epoch.pending.push(tracked)
      return tracked
    },
  }
}

async function setSessionBounds(owned: Checkout): Promise<void> {
  await runQuery(
    owned,
    `SELECT pg_catalog.set_config('lock_timeout', $1, false), pg_catalog.set_config('statement_timeout', $2, false)`,
    [LOCK_TIMEOUT, STATEMENT_TIMEOUT],
  )
}

async function resetSessionBounds(owned: Checkout): Promise<boolean> {
  try {
    await runQuery(owned, 'RESET lock_timeout')
    await runQuery(owned, 'RESET statement_timeout')
    return !owned.lost
  } catch {
    owned.mark()
    return false
  }
}

function isApplicationSchema(name: unknown): name is string {
  return typeof name === 'string' && IDENT.test(name) && !name.startsWith('pg_') && name !== 'information_schema'
}

async function resolveSchema(owned: Checkout): Promise<string> {
  const listed = await runQuery<{ schema_name: string | null }>(
    owned,
    `SELECT candidate.nspname AS schema_name
       FROM unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord)
      ORDER BY candidate.ord`,
  )
  let schema = ''
  for (const row of listed.rows) {
    const name = row?.schema_name
    if (name === 'information_schema' || (typeof name === 'string' && name.startsWith('pg_'))) continue
    if (!isApplicationSchema(name)) throw new AttemptUnavailable()
    schema = name
    break
  }
  if (!isApplicationSchema(schema)) throw new AttemptUnavailable()
  const found = await runQuery<{ schema_name: string; rel_oid: string; relkind: string; relpersistence: string }>(
    owned,
    `SELECT c.oid::text AS rel_oid, c.relkind, c.relpersistence, n.nspname AS schema_name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2`,
    [schema, RELATION],
  )
  const relation = found.rows[0]
  if (found.rows.length !== 1 || !relation) throw new AttemptUnavailable()
  if (!isApplicationSchema(relation.schema_name) || relation.schema_name !== schema) throw new AttemptUnavailable()
  if (relation.relkind !== 'r' || relation.relpersistence !== 'p') throw new AttemptUnavailable()
  if (!OID.test(relation.rel_oid)) throw new AttemptUnavailable()
  return schema
}

async function acquireSidLock(owned: Checkout, sessionKey: string): Promise<LockState> {
  let began = false
  let statementOk = false
  try {
    await runQuery(owned, 'BEGIN')
    began = true
    await runQuery(owned, 'SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1::text, 0))', [sessionKey])
    statementOk = true
    await runQuery(owned, 'COMMIT')
    return owned.lost ? 'uncertain' : 'acked'
  } catch {
    if (!began) return owned.lost ? 'uncertain' : 'none'
    const acked = await rollback(owned)
    if (!acked || owned.lost) return 'uncertain'
    if (!statementOk) return 'none'
    const unlocked = await exactUnlock(owned, sessionKey)
    if (!unlocked) owned.mark()
    return owned.lost ? 'uncertain' : 'none'
  }
}

async function claimLatch(owned: Checkout, schema: string, sessionId: string, token: string): Promise<ClaimState> {
  let began = false
  let sent = false
  try {
    await runQuery(owned, 'BEGIN')
    began = true
    sent = true
    const result = await runQuery<{ acquired: boolean }>(
      owned,
      `SELECT ${qualify(schema, ACQUIRE)}($1::text, $2::text) AS acquired`,
      [sessionId, token],
    )
    const acquired = result.rows[0]?.acquired
    if (acquired !== true && acquired !== false) throw new AttemptUnavailable()
    await runQuery(owned, 'COMMIT')
    if (owned.lost) return 'uncertain'
    return acquired ? 'owned' : 'foreign'
  } catch {
    if (!began || !sent) return owned.lost ? 'uncertain' : 'none'
    const acked = await rollback(owned)
    if (!acked || owned.lost) return 'uncertain'
    return 'none'
  }
}

async function releaseLatch(owned: Checkout, schema: string, sessionId: string, token: string): Promise<'true' | 'zero' | 'unknown'> {
  let began = false
  try {
    await runQuery(owned, 'BEGIN')
    began = true
    const result = await runQuery<{ released: boolean }>(
      owned,
      `SELECT ${qualify(schema, RELEASE)}($1::text, $2::text) AS released`,
      [sessionId, token],
    )
    const released = result.rows[0]?.released
    if (released !== true && released !== false) throw new AttemptUnavailable()
    await runQuery(owned, 'COMMIT')
    if (owned.lost) return 'unknown'
    return released ? 'true' : 'zero'
  } catch {
    if (!began) return owned.lost ? 'unknown' : 'unknown'
    const acked = await rollback(owned)
    if (!acked || owned.lost) return 'unknown'
    return 'unknown'
  }
}

async function exactUnlock(owned: Checkout, sessionKey: string): Promise<boolean> {
  if (owned.lost || owned.discarded || owned.released) return false
  try {
    const result = await runQuery<{ unlocked: boolean }>(
      owned,
      'SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::text, 0)) AS unlocked',
      [sessionKey],
    )
    return result.rows[0]?.unlocked === true && !owned.lost
  } catch {
    owned.mark()
    return false
  }
}

export async function runOwnedAttempt<Snapshot extends OwnedAttemptSnapshot, Outcome>(
  sessionId: string,
  password: string,
  steps: OwnedAttemptSteps<Snapshot, Outcome> | AdminGrantOwnedSteps<Snapshot, Outcome>,
): Promise<Outcome> {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof password !== 'string') throw new AttemptUnavailable()
  const candidate = pool
  if (!candidate || typeof candidate.connect !== 'function' || !hasConnectionString(candidate)) throw new AttemptUnavailable()

  const token = randomBytes(32).toString('hex')
  const sessionKey = SID_PREFIX + sessionId
  const slot = { busy: false }
  let dispatchSealed = false
  let comparePhase: ComparePhase = 'not-started'
  let compareCount = 0
  let compareInFlight: Promise<boolean> | null = null
  let schema = ''
  let lockState: LockState = 'none'
  let claimState: ClaimState = 'none'
  let owner: Checkout | null = null
  let cleanup: Checkout | null = null
  let releasedOnOwner = false
  let decision: Decision<Outcome> = { kind: 'unavailable' }

  const slotBusy = () => slot.busy

  async function runStep<T>(work: (tx: Queryable) => Promise<T>): Promise<
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: unknown; rollbackAcked: boolean }>
  > {
    if (!owner || slot.busy || dispatchSealed || owner.lost || owner.discarded) {
      return { ok: false, error: new AttemptUnavailable(), rollbackAcked: owner ? !owner.lost : true }
    }
    slot.busy = true
    const epoch: Epoch = { sealed: false, pending: [] }
    const tx = scoped(owner, epoch, slotBusy)
    let began = false
    try {
      await runQuery(owner, 'BEGIN')
      began = true
      const execution = work(tx).then(
        (value) => {
          epoch.sealed = true
          return value
        },
        (error: unknown) => {
          epoch.sealed = true
          throw error
        },
      )
      try {
        const value = await execution
        const drained = await drain(epoch)
        if (drained) {
          const rollbackAcked = await rollback(owner)
          return { ok: false, error: isDomain(drained) ? drained : new AttemptUnavailable(), rollbackAcked }
        }
        if (owner.lost) return { ok: false, error: new AttemptUnavailable(), rollbackAcked: false }
        try {
          await runQuery(owner, 'COMMIT')
          if (owner.lost) return { ok: false, error: new AttemptUnavailable(), rollbackAcked: false }
          return { ok: true, value }
        } catch (error) {
          if (owner.lost || error instanceof AttemptUnavailable) {
            return { ok: false, error: new AttemptUnavailable(), rollbackAcked: false }
          }
          return { ok: false, error, rollbackAcked: true }
        }
      } catch (error) {
        const drained = await drain(epoch)
        const rollbackAcked = began ? await rollback(owner) : true
        const primary = isDomain(error) ? error : (drained ?? error)
        return { ok: false, error: primary, rollbackAcked }
      }
    } catch (error) {
      epoch.sealed = true
      await drain(epoch)
      const rollbackAcked = began && owner ? await rollback(owner) : !owner?.lost
      return { ok: false, error, rollbackAcked }
    } finally {
      epoch.sealed = true
      slot.busy = false
    }
  }

  type RawStepOutcome =
    | Readonly<{ ok: true; value: unknown }>
    | Readonly<{ ok: false; error: unknown; rollbackAcked: boolean }>

  async function runAis<T>(
    plan: PrivilegeRolePlan,
    work: (tx: AuthorizationInputTx) => Promise<T>,
  ): Promise<
    | Readonly<{ ok: true; value: T }>
    | Readonly<{ ok: false; error: unknown; rollbackAcked: boolean }>
  > {
    const rawOutcome: { current: RawStepOutcome | null } = { current: null }
    try {
      const value = await withAuthorizationInputTransaction(plan.lockPlan, work, {
        transaction: async <U>(handler: (client: AuthorizationInputHandlerClient) => Promise<U>): Promise<U> => {
          rawOutcome.current = null
          if (!owner) {
            const error = new AttemptUnavailable()
            rawOutcome.current = { ok: false, error, rollbackAcked: true }
            throw error
          }
          const current = owner
          const result = await runStep((tx) => handler({
            query: (sql, params) => tx.query(sql, params),
            __rawClient: current.client,
          }))
          if (result.ok === true) {
            rawOutcome.current = { ok: true, value: result.value }
            return result.value
          }
          rawOutcome.current = { ok: false, error: result.error, rollbackAcked: result.rollbackAcked }
          throw result.error
        },
      })
      return { ok: true, value }
    } catch (error) {
      const recorded = rawOutcome.current
      if (recorded !== null && recorded.ok === false) return recorded
      if (recorded !== null && recorded.ok === true) return { ok: false, error, rollbackAcked: false }
      return { ok: false, error, rollbackAcked: owner ? !owner.lost : true }
    }
  }

  async function invokeCompare(hash: string): Promise<boolean> {
    if (!owner || dispatchSealed || comparePhase !== 'not-started' || slot.busy || owner.lost || compareCount !== 0) {
      throw new AttemptUnavailable()
    }
    comparePhase = 'admitted'
    compareCount += 1
    let dispatched: Promise<boolean> | null = null
    try {
      const returned = bcrypt.compare(password, hash)
      dispatched = Promise.resolve(returned).then((value) => {
        if (typeof value !== 'boolean') throw new AttemptUnavailable()
        return value
      })
      compareInFlight = dispatched
    } catch {
      comparePhase = 'terminal'
      compareInFlight = null
      if (dispatched) await dispatched.then(() => undefined, () => undefined)
      throw new AttemptUnavailable()
    }
    try {
      const verified = await dispatched
      if (!owner || owner.lost || dispatchSealed) throw new AttemptUnavailable()
      return verified
    } finally {
      comparePhase = 'terminal'
      compareInFlight = null
    }
  }

  async function perform(): Promise<Decision<Outcome>> {
    let client: PoolClient
    try {
      client = await candidate.connect()
    } catch {
      return { kind: 'unavailable' }
    }
    owner = attach(client, () => {
      dispatchSealed = true
    })
    try {
      await setSessionBounds(owner)
      schema = await resolveSchema(owner)
      lockState = await acquireSidLock(owner, sessionKey)
      if (lockState !== 'acked') {
        if (lockState === 'uncertain') claimState = 'uncertain'
        return { kind: 'unavailable' }
      }
      claimState = await claimLatch(owner, schema, sessionId, token)
      if (claimState !== 'owned') return { kind: 'unavailable' }
      if (owner.lost) {
        claimState = 'uncertain'
        return { kind: 'unavailable' }
      }

      if ('kind' in steps) {
        if (steps.kind !== 'admin_grant_issue'
          || typeof steps.readInputs !== 'function'
          || typeof steps.accountRejected !== 'function'
          || typeof steps.issue !== 'function'
          || typeof steps.privilegePlan !== 'object'
          || steps.privilegePlan === null
          || typeof steps.privilegePlan.lockPlan !== 'object'
          || steps.privilegePlan.lockPlan === null) {
          return { kind: 'unavailable' }
        }
        const adminSteps = steps
        let adminReads = 0
        const adminFirst = await runAis(adminSteps.privilegePlan, async (tx) => {
          adminReads += 1
          if (adminReads !== 1) throw new AttemptUnavailable()
          return adminSteps.readInputs(tx)
        })
        if (adminFirst.ok === false) {
          if (!adminFirst.rollbackAcked) {
            if (owner) owner.mark()
            claimState = claimState === 'owned' ? 'uncertain' : claimState
            return { kind: 'unavailable' }
          }
          if (isDomain(adminFirst.error)) return { kind: 'domain', error: adminFirst.error }
          return { kind: 'unavailable' }
        }
        if (owner.lost) {
          claimState = 'uncertain'
          return { kind: 'unavailable' }
        }
        const adminSnapshot = adminFirst.value
        if (!adminSnapshot || typeof adminSnapshot.passwordHash !== 'string' || adminSnapshot.passwordHash.length === 0) {
          return { kind: 'unavailable' }
        }
        let adminVerified: boolean
        try {
          adminVerified = await invokeCompare(adminSnapshot.passwordHash)
        } catch {
          return { kind: 'unavailable' }
        }
        if (owner.lost || comparePhase !== 'terminal' || compareCount !== 1) return { kind: 'unavailable' }
        let adminAccounts = 0
        const adminSecond = adminVerified
          ? await runAis(adminSteps.privilegePlan, async (tx) => {
            adminAccounts += 1
            if (adminAccounts !== 1) throw new AttemptUnavailable()
            return adminSteps.issue(tx, adminSnapshot)
          })
          : await runStep(async (tx) => {
            adminAccounts += 1
            if (adminAccounts !== 1) throw new AttemptUnavailable()
            return adminSteps.accountRejected(tx, adminSnapshot)
          })
        if (adminSecond.ok === false) {
          if (!adminSecond.rollbackAcked) {
            if (owner) owner.mark()
            return { kind: 'unavailable' }
          }
          if (isDomain(adminSecond.error)) return { kind: 'domain', error: adminSecond.error }
          return { kind: 'unavailable' }
        }
        if (owner.lost) return { kind: 'unavailable' }
        return { kind: 'value', value: adminSecond.value }
      }

      let reads = 0
      const first = await runStep(async (tx) => {
        reads += 1
        if (reads !== 1) throw new AttemptUnavailable()
        return steps.readInputs(tx)
      })
      if (first.ok === false) {
        if (!first.rollbackAcked) {
          if (owner) owner.mark()
          claimState = claimState === 'owned' ? 'uncertain' : claimState
          return { kind: 'unavailable' }
        }
        if (isDomain(first.error)) return { kind: 'domain', error: first.error }
        return { kind: 'unavailable' }
      }
      if (owner.lost) {
        claimState = 'uncertain'
        return { kind: 'unavailable' }
      }
      const snapshot = first.value
      if (!snapshot || typeof snapshot.passwordHash !== 'string' || snapshot.passwordHash.length === 0) {
        return { kind: 'unavailable' }
      }

      let verified: boolean
      try {
        verified = await invokeCompare(snapshot.passwordHash)
      } catch {
        return { kind: 'unavailable' }
      }
      if (owner.lost || comparePhase !== 'terminal' || compareCount !== 1) return { kind: 'unavailable' }

      let accounts = 0
      const second = await runStep(async (tx) => {
        accounts += 1
        if (accounts !== 1) throw new AttemptUnavailable()
        return steps.account(tx, snapshot, verified)
      })
      if (second.ok === false) {
        if (!second.rollbackAcked) {
          if (owner) owner.mark()
          return { kind: 'unavailable' }
        }
        if (isDomain(second.error)) return { kind: 'domain', error: second.error }
        return { kind: 'unavailable' }
      }
      if (owner.lost) return { kind: 'unavailable' }
      return { kind: 'value', value: second.value }
    } catch {
      if (owner?.lost && claimState === 'owned') claimState = 'uncertain'
      return { kind: 'unavailable' }
    }
  }

  async function cleanupConnection(): Promise<void> {
    if (!owner || schema.length === 0) return
    const quiescent = comparePhase === 'terminal' || (comparePhase === 'not-started' && compareCount === 0 && dispatchSealed)
    if (!quiescent) return
    let client: PoolClient
    try {
      client = await candidate.connect()
    } catch {
      return
    }
    cleanup = attach(client, () => {
      dispatchSealed = true
    })
    try {
      await setSessionBounds(cleanup)
      const locked = await acquireSidLock(cleanup, sessionKey)
      if (locked !== 'acked' || cleanup.lost) {
        dispose(cleanup, true)
        return
      }
      const released = await releaseLatch(cleanup, schema, sessionId, token)
      if (released === 'unknown' || cleanup.lost) {
        dispose(cleanup, true)
        return
      }
      const unlocked = await exactUnlock(cleanup, sessionKey)
      if (!unlocked || cleanup.lost) {
        dispose(cleanup, true)
        return
      }
      const reset = await resetSessionBounds(cleanup)
      dispose(cleanup, !reset)
    } catch {
      dispose(cleanup, true)
    }
  }

  async function settle(): Promise<void> {
    dispatchSealed = true
    if (comparePhase === 'admitted' && compareInFlight) {
      await compareInFlight.then(() => undefined, () => undefined)
    }
    if (comparePhase === 'admitted') comparePhase = 'terminal'
    const needsDelete = claimState === 'owned' || claimState === 'uncertain'
    if (!owner || owner.released) {
      if (needsDelete && !releasedOnOwner) await cleanupConnection()
      return
    }
    if (owner.lost || owner.discarded || lockState === 'uncertain') {
      dispose(owner, true)
      if (needsDelete && !releasedOnOwner) await cleanupConnection()
      return
    }
    if (lockState === 'acked' && schema.length > 0 && needsDelete) {
      const released = await releaseLatch(owner, schema, sessionId, token)
      if (released === 'unknown' || owner.lost) {
        owner.mark()
        if (!releasedOnOwner) await cleanupConnection()
        return
      }
      releasedOnOwner = true
    }
    if (lockState === 'acked') {
      const unlocked = await exactUnlock(owner, sessionKey)
      if (!unlocked || owner.lost) {
        dispose(owner, true)
        if (needsDelete && !releasedOnOwner) await cleanupConnection()
        return
      }
    }
    const reset = await resetSessionBounds(owner)
    dispose(owner, !reset || owner.lost)
    if (needsDelete && !releasedOnOwner) await cleanupConnection()
  }

  try {
    decision = await perform()
  } catch {
    decision = { kind: 'unavailable' }
  } finally {
    try {
      await settle()
    } catch {
      if (owner && !owner.released) dispose(owner, true)
      if (cleanup && !cleanup.released) dispose(cleanup, true)
    }
  }

  if (decision.kind === 'value') return decision.value
  if (decision.kind === 'domain') throw decision.error
  throw new AttemptUnavailable()
}
