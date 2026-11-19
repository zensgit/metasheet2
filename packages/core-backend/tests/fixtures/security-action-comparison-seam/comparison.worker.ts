import { closeSync, existsSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { expect, test, vi } from 'vitest'

type Role = 'owner' | 'peer' | 'smoke'
type Phase = 'claim' | 'account' | 'release' | 'read' | 'acquisition'
type Fault = 'rollback-tx1' | 'rollback-tx2' | 'rollback-tx2-withheld' | 'unlock-false' | 'unlock-error'
type Hold = 'blocked' | 'abandoned'
type Raw = { outcome: 'TRUE' | 'FALSE'; value: boolean } | { outcome: 'ERROR'; error: unknown }
type Terminal = 'RETURNED_TRUE' | 'RETURNED_FALSE' | 'UNAVAILABLE' | 'REJECTED_OTHER'
type Event = 'WORKER_READY' | 'CHECKOUT' | 'CHECKOUT_READY' | 'CLAIM_OWNED' | 'CLAIM_FOREIGN' | 'CONNECT_REJECTED' | 'TX1_BACKEND' | 'CALLED'
  | 'RAW_SETTLED' | 'RAW_SYNC_THROW' | 'RELEASE_RECEIVED' | 'DELIVERY_RELEASED' | 'CONTROL_REJECTED'
  | 'TIMEOUT_UNKNOWN' | 'OWNER_LOST' | 'CLEANUP_LOST' | 'DISPOSE_DISCARD' | 'DISPOSE_RETURN'
  | 'DISPOSE_ERROR' | 'ACCOUNT_ENTERED' | 'ATTEMPT_TERMINAL' | 'PEER_REFUSED'
  | 'POOL_END_CALLED' | 'POOL_ENDED' | 'WORKER_DONE' | 'WORKER_FAILED'
  | 'NATIVE_COMMIT' | 'ACK_WITHHELD'
  | 'EFFECT_VISIBLE' | 'SQLSTATE_23502' | 'NATIVE_ROLLBACK' | 'ROLLBACK_WITHHELD'
  | 'UNLOCK_FIRST' | 'UNLOCK_NATIVE_FALSE' | 'UNLOCK_DISPATCH' | 'UNLOCK_REJECTED'
  | 'CLEANUP_BEFORE_LOCK' | 'CLEANUP_LOCK_ACKED' | 'RELEASE_NATIVE' | 'RELEASE_COMMIT' | 'CLEANUP_UNLOCK'
  | 'TOKEN_MATCH' | 'READ_HELD'
type Fields = {
  outcome?: Raw['outcome'] | Terminal
  count?: number
  checkout?: number
  backendPid?: number
  supervisorPid?: number
  phase?: Phase
  unlocked?: boolean
  released?: boolean
  equal?: boolean
  different?: boolean
}
type Seen = {
  event: Event
  seq: number
  checkout?: number
  backendPid?: number
  phase?: Phase
  count?: number
  unlocked?: boolean
  released?: boolean
  equal?: boolean
  different?: boolean
}
type Action = 'forward' | 'arm' | 'refuse'
type Frame = { kind: 'owner' | 'cleanup'; step: string; body: boolean }

test('production comparison delivery seam', async () => {
  const roleInput = process.env.SA_SEAM_ROLE
  if (roleInput !== 'owner' && roleInput !== 'peer' && roleInput !== 'smoke') throw new Error('SEAM_ROLE')
  const role: Role = roleInput
  const supervisorPid = Number(process.env.SA_SEAM_SUPERVISOR_PID)
  if (process.ppid !== supervisorPid || supervisorPid === process.pid || process.env.EXPECT_DB !== '1'
    || process.env.SECRET_PROVIDER !== 'env' || process.env.SA_SEAM_SYNTHETIC !== 'true') throw new Error('SEAM_BOOTSTRAP')
  const control = process.env.SA_SEAM_CONTROL_DIR ?? ''
  const schema = process.env.SA_SCHEMA ?? ''
  const sessionId = process.env.SA_SESSION_ID ?? ''
  const password = process.env.SA_PASSWORD ?? ''
  const passwordHash = process.env.SA_PASSWORD_HASH ?? ''
  const expectedOutcome = process.env.SA_SEAM_OUTCOME
  const effect = process.env.SA_SEAM_EFFECT
  const ackInput = process.env.SA_SEAM_ACK
  const ack: Phase | undefined = ackInput === undefined ? undefined
    : ackInput === 'claim' || ackInput === 'account' || ackInput === 'release' || ackInput === 'acquisition' ? ackInput
      : undefined
  if (ackInput !== undefined && ack === undefined) throw new Error('SEAM_ACK')
  const faultInput = process.env.SA_SEAM_FAULT
  const fault: Fault | undefined = faultInput === undefined ? undefined
    : faultInput === 'rollback-tx1' || faultInput === 'rollback-tx2' || faultInput === 'rollback-tx2-withheld'
      || faultInput === 'unlock-false' || faultInput === 'unlock-error' ? faultInput
      : undefined
  if (faultInput !== undefined && fault === undefined) throw new Error('SEAM_FAULT')
  const holdInput = process.env.SA_SEAM_HOLD
  const hold: Hold | undefined = holdInput === undefined ? undefined
    : holdInput === 'blocked' || holdInput === 'abandoned' ? holdInput
      : undefined
  if (holdInput !== undefined && hold === undefined) throw new Error('SEAM_HOLD')
  const gateInput = process.env.SA_SEAM_GATE
  const gate = gateInput === undefined ? undefined : gateInput === 'read' ? gateInput : undefined
  if (gateInput !== undefined && gate === undefined) throw new Error('SEAM_GATE')
  if (!/^sa_wpc_admit_[a-f0-9]{16}$/.test(schema) || !sessionId || !password
    || !['TRUE', 'FALSE', 'ERROR'].includes(expectedOutcome ?? '')
    || (effect !== 'none' && effect !== 'insert')) throw new Error('SEAM_INPUT')
  if (ack !== undefined && (role !== 'smoke' || (expectedOutcome !== 'TRUE' && expectedOutcome !== 'FALSE'))) throw new Error('SEAM_ACK')
  if (fault !== undefined && (ack !== undefined || role !== 'smoke' || expectedOutcome !== 'TRUE')) throw new Error('SEAM_FAULT')
  if (hold !== undefined && (ack !== 'release' || fault !== undefined || role !== 'smoke' || expectedOutcome !== 'TRUE')) throw new Error('SEAM_HOLD')
  if (gate !== undefined && (ack !== undefined || fault !== undefined || hold !== undefined || role !== 'smoke'
    || expectedOutcome !== 'TRUE' || effect !== 'none')) throw new Error('SEAM_GATE')
  const journal = openSync(join(control, 'events.jsonl'), 'ax', 0o600)
  let sequence = 0
  let instrumentationFailed = false
  const seen: Seen[] = []
  const emit = (event: Event, fields: Fields = {}) => {
    const seq = ++sequence
    seen.push({
      event, seq, checkout: fields.checkout, backendPid: fields.backendPid, phase: fields.phase,
      count: fields.count, unlocked: fields.unlocked, released: fields.released, equal: fields.equal,
      different: fields.different,
    })
    try {
      writeSync(journal, `${JSON.stringify({ event, role, seq, workerPid: process.pid, ...fields })}\n`)
    } catch {
      instrumentationFailed = true
    }
  }
  emit('WORKER_READY', { supervisorPid })
  let compareCount = 0
  let accountCount = 0
  let readCount = 0
  let checkoutCount = 0
  let ownerDiscardCount = 0
  let ownerLost = false
  let deliveredAfterLoss = false
  let raw: Raw | undefined
  let released = false
  let delivered = false
  let terminal: Terminal | undefined
  let actualPool: Pool | null = null
  const restorers: Array<() => void> = []
  let resolveDelivery!: (value: boolean) => void
  let rejectDelivery!: (error: unknown) => void
  const delivery = new Promise<boolean>((resolve, reject) => {
    resolveDelivery = resolve
    rejectDelivery = reject
  })
  const deliver = () => {
    if (!raw || !released || delivered) return
    delivered = true
    deliveredAfterLoss = ownerLost
    emit('DELIVERY_RELEASED', { outcome: raw.outcome })
    if (raw.outcome === 'ERROR') rejectDelivery(raw.error)
    else resolveDelivery(raw.value)
  }
  const deadline = Date.now() + 30000
  const releasePath = join(control, 'release.json')
  const poll = setInterval(() => {
    try {
      if (Date.now() >= deadline) {
        instrumentationFailed = true
        clearInterval(poll)
        emit('TIMEOUT_UNKNOWN')
        return
      }
      if (!existsSync(releasePath)) return
      const stat = lstatSync(releasePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024
        || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('SEAM_CONTROL')
      const command: unknown = JSON.parse(readFileSync(releasePath, 'utf8'))
      if (!command || typeof command !== 'object' || Object.keys(command).sort().join(',') !== 'command,role'
        || !('command' in command) || command.command !== 'RELEASE'
        || !('role' in command) || command.role !== role) throw new Error('SEAM_CONTROL')
      released = true
      clearInterval(poll)
      emit('RELEASE_RECEIVED')
      deliver()
    } catch {
      instrumentationFailed = true
      clearInterval(poll)
      emit('CONTROL_REJECTED')
    }
  }, 10)
  const boundsSql = `SELECT pg_catalog.set_config('lock_timeout', $1, false), pg_catalog.set_config('statement_timeout', $2, false)`
  const schemasSql = `SELECT candidate.nspname AS schema_name
       FROM unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord)
      ORDER BY candidate.ord`
  const relationSql = `SELECT c.oid::text AS rel_oid, c.relkind, c.relpersistence, n.nspname AS schema_name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2`
  const lockSql = 'SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1::text, 0))'
  const unlockSql = 'SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::text, 0)) AS unlocked'
  const acquireSql = `SELECT "${schema}"."security_action_session_flight_acquire"($1::text, $2::text) AS acquired`
  const releaseSql = `SELECT "${schema}"."security_action_session_flight_release"($1::text, $2::text) AS released`
  const frames = new Map<number, Frame>()
  let armUsed = false
  let originalToken: string | undefined
  const helperText = (text: string) => text === boundsSql || text === schemasSql || text === relationSql
    || text === lockSql || text === unlockSql || text === acquireSql || text === releaseSql
    || text === 'RESET lock_timeout' || text === 'RESET statement_timeout'
  const classify = (frame: Frame, text: string): Action => {
    const forwardTo = (step: string, body = false): Action => {
      frame.step = step
      frame.body = body
      return 'forward'
    }
    if (frame.kind === 'owner') {
      if (frame.step === 'sealed') return 'refuse'
      if (frame.step === 'bounds') return text === boundsSql ? forwardTo('schemas') : 'refuse'
      if (frame.step === 'schemas') return text === schemasSql ? forwardTo('relation') : 'refuse'
      if (frame.step === 'relation') return text === relationSql ? forwardTo('lock-begin') : 'refuse'
      if (frame.step === 'lock-begin') return text === 'BEGIN' ? forwardTo('lock-sql') : 'refuse'
      if (frame.step === 'lock-sql') return text === lockSql ? forwardTo('lock-commit') : 'refuse'
      if (frame.step === 'lock-commit') {
        if (text !== 'COMMIT') return 'refuse'
        if (ack === 'acquisition') {
          frame.step = 'sealed'
          return 'arm'
        }
        return forwardTo('claim-begin')
      }
      if (frame.step === 'claim-begin') return text === 'BEGIN' ? forwardTo('claim-sql') : 'refuse'
      if (frame.step === 'claim-sql') return text === acquireSql ? forwardTo('claim-commit') : 'refuse'
      if (frame.step === 'claim-commit') {
        if (text !== 'COMMIT') return 'refuse'
        if (ack === 'claim') {
          frame.step = 'sealed'
          return 'arm'
        }
        return forwardTo('read-begin')
      }
      if (frame.step === 'read-begin') return text === 'BEGIN' ? forwardTo('read-body') : 'refuse'
      if (frame.step === 'read-body') {
        if (text === 'COMMIT') return frame.body ? forwardTo('account-begin') : 'refuse'
        if (text === 'BEGIN' || text === 'ROLLBACK' || helperText(text)) return 'refuse'
        frame.body = true
        return 'forward'
      }
      if (frame.step === 'account-begin') return text === 'BEGIN' ? forwardTo('account-body') : 'refuse'
      if (frame.step === 'account-body') {
        if (text === 'COMMIT') {
          if (!frame.body) return 'refuse'
          if (ack === 'account') {
            frame.step = 'sealed'
            return 'arm'
          }
          return forwardTo('release-begin')
        }
        if (text === 'BEGIN' || text === 'ROLLBACK' || helperText(text)) return 'refuse'
        frame.body = true
        return 'forward'
      }
      if (frame.step === 'release-begin') return text === 'BEGIN' ? forwardTo('release-sql') : 'refuse'
      if (frame.step === 'release-sql') return text === releaseSql ? forwardTo('release-commit') : 'refuse'
      if (frame.step === 'release-commit') {
        if (text !== 'COMMIT' || ack !== 'release') return 'refuse'
        frame.step = 'sealed'
        return 'arm'
      }
      return 'refuse'
    }
    if (frame.step === 'bounds') return text === boundsSql ? forwardTo('clock-begin') : 'refuse'
    if (frame.step === 'clock-begin') return text === 'BEGIN' ? forwardTo('clock-sql') : 'refuse'
    if (frame.step === 'clock-sql') return text === lockSql ? forwardTo('clock-commit') : 'refuse'
    if (frame.step === 'clock-commit') return text === 'COMMIT' ? forwardTo('crelease-begin') : 'refuse'
    if (frame.step === 'crelease-begin') return text === 'BEGIN' ? forwardTo('crelease-sql') : 'refuse'
    if (frame.step === 'crelease-sql') return text === releaseSql ? forwardTo('crelease-commit') : 'refuse'
    if (frame.step === 'crelease-commit') return text === 'COMMIT' ? forwardTo('unlock') : 'refuse'
    if (frame.step === 'unlock') return text === unlockSql ? forwardTo('reset-lock') : 'refuse'
    if (frame.step === 'reset-lock') return text === 'RESET lock_timeout' ? forwardTo('reset-statement') : 'refuse'
    if (frame.step === 'reset-statement') return text === 'RESET statement_timeout' ? forwardTo('done') : 'refuse'
    return 'refuse'
  }
  const waitAckSeen = () => new Promise<void>((resolve, reject) => {
    const ackPath = join(control, 'ack-seen.json')
    const timer = setInterval(() => {
      try {
        if (Date.now() >= deadline) {
          clearInterval(timer)
          instrumentationFailed = true
          emit('TIMEOUT_UNKNOWN')
          reject(new Error('ack withheld'))
          return
        }
        if (!existsSync(ackPath)) return
        const stat = lstatSync(ackPath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024
          || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('SEAM_CONTROL')
        const command: unknown = JSON.parse(readFileSync(ackPath, 'utf8'))
        if (!command || typeof command !== 'object' || Object.keys(command).sort().join(',') !== 'command,phase,role'
          || !('command' in command) || command.command !== 'ACK_SEEN'
          || !('role' in command) || command.role !== 'smoke' || command.role !== role
          || !('phase' in command) || command.phase !== ack) throw new Error('SEAM_CONTROL')
        clearInterval(timer)
        resolve()
      } catch {
        clearInterval(timer)
        instrumentationFailed = true
        emit('CONTROL_REJECTED')
        reject(new Error('ack withheld'))
      }
    }, 10)
  })
  const waitControl = (name: string, accept: (command: Record<string, unknown>) => boolean) => new Promise<void>((resolve, reject) => {
    const controlPath = join(control, name)
    const timer = setInterval(() => {
      try {
        if (Date.now() >= deadline) {
          clearInterval(timer)
          instrumentationFailed = true
          emit('TIMEOUT_UNKNOWN')
          reject(new Error('seam control'))
          return
        }
        if (!existsSync(controlPath)) return
        const stat = lstatSync(controlPath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024
          || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('SEAM_CONTROL')
        const command: unknown = JSON.parse(readFileSync(controlPath, 'utf8'))
        if (!command || typeof command !== 'object' || Array.isArray(command)
          || !accept(command as Record<string, unknown>)) throw new Error('SEAM_CONTROL')
        clearInterval(timer)
        resolve()
      } catch {
        clearInterval(timer)
        instrumentationFailed = true
        emit('CONTROL_REJECTED')
        reject(new Error('seam control'))
      }
    }, 10)
  })
  const waitFaultSeen = () => waitControl('fault-seen.json', (command) => Object.keys(command).sort().join(',') === 'command,fault,role'
    && command.command === 'FAULT_SEEN' && command.role === 'smoke' && command.role === role && command.fault === fault)
  const waitUnlockProceed = () => waitControl('unlock-proceed.json', (command) => Object.keys(command).sort().join(',') === 'command,role'
    && command.command === 'UNLOCK_PROCEED' && command.role === 'smoke' && command.role === role)
  const waitLockProceed = () => waitControl('lock-proceed.json', (command) => Object.keys(command).sort().join(',') === 'command,role'
    && command.command === 'LOCK_PROCEED' && command.role === 'smoke' && command.role === role)
  const waitReadRelease = () => waitControl('read-release.json', (command) => Object.keys(command).sort().join(',') === 'command,role'
    && command.command === 'READ_RELEASE' && command.role === 'smoke' && command.role === role)
  const waitCleanupSeen = () => waitControl('cleanup-seen.json', (command) => Object.keys(command).sort().join(',') === 'command,role'
    && command.command === 'CLEANUP_SEEN' && command.role === 'smoke' && command.role === role)
  vi.doMock('bcryptjs', async () => {
    const actual = await vi.importActual<typeof import('bcryptjs')>('bcryptjs')
    const actualCompare = actual.compare
    return {
      ...actual,
      compare: (...args: [string, string]) => {
        compareCount += 1
        emit('CALLED', { count: compareCount })
        if (compareCount !== 1 || args.length !== 2 || args[0] !== password || args[1] !== passwordHash) {
          instrumentationFailed = true
          throw new Error('SEAM_COMPARE')
        }
        let pending: Promise<boolean>
        try {
          pending = actualCompare(args[0], args[1])
        } catch (error) {
          instrumentationFailed = true
          emit('RAW_SYNC_THROW')
          throw error
        }
        void pending.then((value) => {
          raw = { outcome: value ? 'TRUE' : 'FALSE', value }
          emit('RAW_SETTLED', { outcome: raw.outcome })
          deliver()
        }, (error: unknown) => {
          raw = { outcome: 'ERROR', error }
          emit('RAW_SETTLED', { outcome: raw.outcome })
          deliver()
        })
        return delivery
      },
    }
  })
  try {
    actualPool = (await import('../../../src/db/pg')).pool
    if (!actualPool) throw new Error('SEAM_POOL')
    const savedConnect = actualPool.connect
    const observeClient = (client: PoolClient, checkout: number) => {
      const backendPid = Number((client as PoolClient & { processID?: unknown }).processID)
      if (!Number.isSafeInteger(backendPid) || backendPid < 1) throw new Error('SEAM_CLIENT')
      emit('CHECKOUT_READY', { checkout, backendPid })
      if (ack !== undefined) {
        if (checkout > 2) instrumentationFailed = true
        frames.set(checkout, { kind: checkout === 1 ? 'owner' : 'cleanup', step: checkout > 2 ? 'done' : 'bounds', body: false })
      }
      const savedQuery = client.query
      const observeAcquire = (args: unknown[], result: unknown) => {
        if (args[0] !== acquireSql) return
        if (args.length !== 2 || !Array.isArray(args[1]) || args[1][0] !== sessionId
          || typeof args[1][1] !== 'string' || !/^[a-f0-9]{64}$/.test(args[1][1])) instrumentationFailed = true
        void (result as Promise<{ rows: Array<{ acquired?: unknown }> }>).then((value) => {
          const acquired = value.rows[0]?.acquired
          if (acquired !== true && acquired !== false) instrumentationFailed = true
          else emit(acquired ? 'CLAIM_OWNED' : 'CLAIM_FOREIGN', { checkout, backendPid })
        }, () => { instrumentationFailed = true }).catch(() => { instrumentationFailed = true })
      }
      const observedQuery = function (this: PoolClient, ...args: unknown[]) {
        if (fault !== undefined && checkout === 1 && typeof args[0] === 'string') {
          const text = args[0]
          const rollbackFault = fault === 'rollback-tx1' || fault === 'rollback-tx2' || fault === 'rollback-tx2-withheld'
          if (rollbackFault && text === 'ROLLBACK') {
            if (armUsed) {
              instrumentationFailed = true
              return Promise.reject(new Error('seam frame'))
            }
            armUsed = true
            const phase: Phase = fault === 'rollback-tx1' ? 'read' : 'account'
            let native: Promise<unknown>
            try {
              native = Reflect.apply(savedQuery, this, args) as Promise<unknown>
            } catch (error) {
              instrumentationFailed = true
              return Promise.reject(error instanceof Error ? error : new Error('seam frame'))
            }
            return Promise.resolve(native).then((value) => {
              if (ownerLost) instrumentationFailed = true
              emit('NATIVE_ROLLBACK', { phase, checkout: 1, backendPid })
              return waitFaultSeen().then(() => {
                if (fault === 'rollback-tx2-withheld') {
                  emit('ROLLBACK_WITHHELD', { phase, checkout: 1, backendPid })
                  throw new Error('rollback withheld')
                }
                return value
              })
            }, (error: unknown) => {
              instrumentationFailed = true
              throw error
            })
          }
          if ((fault === 'unlock-false' || fault === 'unlock-error') && text === unlockSql) {
            if (armUsed) {
              instrumentationFailed = true
              return Promise.reject(new Error('seam frame'))
            }
            armUsed = true
            if (fault === 'unlock-error') {
              emit('UNLOCK_DISPATCH', { checkout: 1, backendPid })
              return waitUnlockProceed().then(() => Reflect.apply(savedQuery, this, args) as Promise<unknown>).then((value) => {
                instrumentationFailed = true
                return value
              }, (error: unknown) => {
                emit('UNLOCK_REJECTED', { checkout: 1, backendPid })
                throw error
              })
            }
            return (async () => {
              const first = await (Reflect.apply(savedQuery, this, args) as Promise<{ rows: Array<{ unlocked?: unknown }> }>)
              if (first.rows[0]?.unlocked !== true) {
                instrumentationFailed = true
                throw new Error('SEAM_UNLOCK')
              }
              emit('UNLOCK_FIRST', { checkout: 1, backendPid, unlocked: true })
              const second = await (Reflect.apply(savedQuery, this, args) as Promise<{ rows: Array<{ unlocked?: unknown }> }>)
              if (second.rows[0]?.unlocked !== false) {
                instrumentationFailed = true
                throw new Error('SEAM_UNLOCK')
              }
              emit('UNLOCK_NATIVE_FALSE', { checkout: 1, backendPid, unlocked: false })
              await waitFaultSeen()
              return second
            })()
          }
        }
        if (ack === undefined) {
          const result = Reflect.apply(savedQuery, this, args)
          observeAcquire(args, result)
          return result
        }
        const text = args[0]
        const frame = frames.get(checkout)
        if (!frame || typeof text !== 'string') {
          instrumentationFailed = true
          return Promise.reject(new Error('seam frame'))
        }
        const stepBefore = frame.step
        const action = classify(frame, text)
        if (action === 'refuse' || (action === 'arm' && (armUsed || checkout !== 1))) {
          instrumentationFailed = true
          return Promise.reject(new Error('seam frame'))
        }
        if (action === 'arm') {
          armUsed = true
          let native: Promise<unknown>
          try {
            native = Reflect.apply(savedQuery, this, args) as Promise<unknown>
          } catch (error) {
            instrumentationFailed = true
            return Promise.reject(error instanceof Error ? error : new Error('seam frame'))
          }
          return Promise.resolve(native).then((value) => {
            void value
            if (ownerLost) instrumentationFailed = true
            emit('NATIVE_COMMIT', { phase: ack, checkout: 1, backendPid })
            return waitAckSeen()
          }, (error: unknown) => {
            instrumentationFailed = true
            throw error
          }).then(() => {
            emit('ACK_WITHHELD', { phase: ack, checkout: 1, backendPid })
            throw new Error('ack withheld')
          })
        }
        if (hold !== undefined && (text === acquireSql || text === releaseSql)) {
          const params = args[1]
          const token = Array.isArray(params) ? params[1] : undefined
          if (checkout === 1) {
            if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) instrumentationFailed = true
            else if (originalToken === undefined) originalToken = token
            else if (originalToken !== token) instrumentationFailed = true
          }
        }
        const forward = () => {
          const pending = Reflect.apply(savedQuery, this, args) as Promise<unknown>
          observeAcquire(args, pending)
          return pending
        }
        if (hold !== undefined && checkout === 2 && stepBefore === 'clock-sql' && text === lockSql) {
          emit('CLEANUP_BEFORE_LOCK', { checkout, backendPid, phase: 'release' })
          return waitLockProceed().then(() => forward())
        }
        const pending = forward()
        const watchCleanup = checkout === 2 && (hold !== undefined || ack === 'acquisition')
        if (!watchCleanup) return pending
        if (stepBefore === 'clock-commit' && text === 'COMMIT') {
          return Promise.resolve(pending).then((value) => {
            emit('CLEANUP_LOCK_ACKED', { checkout, backendPid })
            if (ack !== 'acquisition') return value
            return waitCleanupSeen().then(() => value)
          }, (error: unknown) => {
            instrumentationFailed = true
            throw error
          })
        }
        if (stepBefore === 'crelease-sql' && text === releaseSql) {
          return Promise.resolve(pending).then((value) => {
            const released = (value as { rows?: Array<{ released?: unknown }> }).rows?.[0]?.released
            if (released !== true && released !== false) {
              instrumentationFailed = true
              throw new Error('SEAM_RELEASE')
            }
            emit('RELEASE_NATIVE', { checkout, backendPid, released })
            if (hold === 'abandoned') {
              const params = args[1]
              const token = Array.isArray(params) ? params[1] : undefined
              const equal = typeof token === 'string' && originalToken !== undefined && token === originalToken
              emit('TOKEN_MATCH', { checkout, equal, different: !equal })
              if (!equal) instrumentationFailed = true
            }
            return value
          }, (error: unknown) => {
            instrumentationFailed = true
            throw error
          })
        }
        if (stepBefore === 'crelease-commit' && text === 'COMMIT') {
          return Promise.resolve(pending).then((value) => {
            if ((value as { command?: unknown }).command !== 'COMMIT') {
              instrumentationFailed = true
              throw new Error('SEAM_COMMIT')
            }
            emit('RELEASE_COMMIT', { checkout, backendPid })
            return value
          }, (error: unknown) => {
            instrumentationFailed = true
            throw error
          })
        }
        if (stepBefore === 'unlock' && text === unlockSql) {
          return Promise.resolve(pending).then((value) => {
            const unlocked = (value as { rows?: Array<{ unlocked?: unknown }> }).rows?.[0]?.unlocked
            if (unlocked !== true && unlocked !== false) {
              instrumentationFailed = true
              throw new Error('SEAM_UNLOCK')
            }
            emit('CLEANUP_UNLOCK', { checkout, backendPid, unlocked })
            return value
          }, (error: unknown) => {
            instrumentationFailed = true
            throw error
          })
        }
        return pending
      } as PoolClient['query']
      client.query = observedQuery
      restorers.push(() => { if (client.query === observedQuery) client.query = savedQuery })
      let lossObserved = false
      let suppressLoss = false
      let releaseCount = 0
      const onLoss = () => {
        if (suppressLoss) return
        if (lossObserved) return
        lossObserved = true
        if (checkout === 1) ownerLost = true
        emit(checkout === 1 ? 'OWNER_LOST' : 'CLEANUP_LOST', { checkout })
      }
      client.on('error', onLoss)
      client.on('end', onLoss)
      const savedRelease = client.release
      const observedRelease = function (this: PoolClient, ...args: Parameters<PoolClient['release']>) {
        releaseCount += 1
        if (checkout === 1 && args[0]) ownerDiscardCount += 1
        emit(args[0] ? 'DISPOSE_DISCARD' : 'DISPOSE_RETURN', { checkout, count: releaseCount })
        if (ack !== undefined || fault === 'rollback-tx2-withheld') suppressLoss = true
        try {
          return Reflect.apply(savedRelease, this, args)
        } catch (error) {
          instrumentationFailed = true
          emit('DISPOSE_ERROR', { checkout, count: releaseCount })
          throw error
        } finally {
          client.removeListener('error', onLoss)
          client.removeListener('end', onLoss)
          suppressLoss = false
        }
      }
      client.release = observedRelease
      restorers.push(() => {
        client.removeListener('error', onLoss)
        client.removeListener('end', onLoss)
        if (client.release === observedRelease) client.release = savedRelease
      })
    }
    const observedConnect = function (this: Pool, ...args: unknown[]) {
      const checkout = ++checkoutCount
      emit('CHECKOUT', { count: checkout })
      const result = Reflect.apply(savedConnect, this, args) as Promise<PoolClient> | void
      if (result) {
        void result.then((client) => observeClient(client, checkout), () => {
          instrumentationFailed = true
          emit('CONNECT_REJECTED', { checkout })
        }).catch(() => { instrumentationFailed = true })
      } else {
        instrumentationFailed = true
      }
      return result
    } as Pool['connect']
    actualPool.connect = observedConnect
    restorers.push(() => { if (actualPool?.connect === observedConnect) actualPool.connect = savedConnect })
    const { runOwnedAttempt } = await import('../../../src/auth/security-action-attempt-admission')
    const insertSql = `INSERT INTO "${schema}".security_action_attempt_effect (slot) VALUES ($1)`
    const readbackSql = `SELECT slot FROM "${schema}".security_action_attempt_effect WHERE slot = $1`
    const proveThenViolate = async (tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> }): Promise<never> => {
      const inserted = await tx.query(insertSql, [role])
      expect(inserted.rowCount).toBe(1)
      const readback = await tx.query(readbackSql, [role])
      expect(readback.rowCount).toBe(1)
      expect(readback.rows).toEqual([{ slot: role }])
      emit('EFFECT_VISIBLE', { count: 1 })
      try {
        await tx.query(insertSql, [null])
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
        if (code !== '23502') {
          instrumentationFailed = true
          throw error
        }
        emit('SQLSTATE_23502', { count: 1 })
        throw error
      }
      instrumentationFailed = true
      throw new Error('SEAM_23502_MISSING')
    }
    try {
      const value = await runOwnedAttempt(sessionId, password, {
        readInputs: async (tx) => {
          readCount += 1
          const backendPid = Number((await tx.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]?.pid)
          if (!Number.isSafeInteger(backendPid) || backendPid < 1) throw new Error('SEAM_BACKEND')
          emit('TX1_BACKEND', { backendPid, count: readCount })
          if (fault === 'rollback-tx1') await proveThenViolate(tx)
          if (gate === 'read') {
            emit('READ_HELD', { checkout: 1, backendPid, count: readCount })
            await waitReadRelease()
          }
          return { passwordHash }
        },
        account: async (tx, _snapshot, verified) => {
          accountCount += 1
          emit('ACCOUNT_ENTERED', { count: accountCount })
          if (fault === 'rollback-tx2' || fault === 'rollback-tx2-withheld') await proveThenViolate(tx)
          else if (effect === 'insert') {
            await tx.query(insertSql, [role])
          }
          return verified
        },
      })
      terminal = value ? 'RETURNED_TRUE' : 'RETURNED_FALSE'
    } catch (error) {
      terminal = error instanceof Error && error.name === 'AttemptUnavailable' ? 'UNAVAILABLE' : 'REJECTED_OTHER'
    }
    emit('ATTEMPT_TERMINAL', { outcome: terminal, count: compareCount })
    if (role === 'peer' && terminal === 'UNAVAILABLE' && compareCount === 0) emit('PEER_REFUSED', { count: 0 })
  } catch {
    instrumentationFailed = true
  } finally {
    clearInterval(poll)
    try {
      if (actualPool) {
        emit('POOL_END_CALLED')
        await actualPool.end()
        emit('POOL_ENDED')
      }
      for (const restore of restorers.reverse()) restore()
      vi.doUnmock('bcryptjs')
    } catch {
      instrumentationFailed = true
    }
  }
  try {
    expect(instrumentationFailed).toBe(false)
    expect(terminal).not.toBe('REJECTED_OTHER')
    if (fault !== undefined) {
      const ready = seen.filter((item) => item.event === 'CHECKOUT_READY')
      expect(ready[0]?.checkout).toBe(1)
      const ownerPid = ready[0]?.backendPid
      expect(ownerPid).toBeGreaterThan(0)
      if (fault === 'rollback-tx1' || fault === 'rollback-tx2' || fault === 'rollback-tx2-withheld') {
        const phase: Phase = fault === 'rollback-tx1' ? 'read' : 'account'
        const native = seen.filter((item) => item.event === 'NATIVE_ROLLBACK')
        const withheld = seen.filter((item) => item.event === 'ROLLBACK_WITHHELD')
        const visible = seen.filter((item) => item.event === 'EFFECT_VISIBLE')
        const sqlstate = seen.filter((item) => item.event === 'SQLSTATE_23502')
        expect(visible.map((item) => item.count)).toEqual([1])
        expect(sqlstate.map((item) => item.count)).toEqual([1])
        expect(visible[0]?.seq ?? 0).toBeLessThan(sqlstate[0]?.seq ?? 0)
        expect(sqlstate[0]?.seq ?? 0).toBeLessThan(native[0]?.seq ?? 0)
        expect(native.map((item) => [item.phase, item.checkout, item.backendPid])).toEqual([[phase, 1, ownerPid]])
        expect(seen.some((item) => item.event === 'OWNER_LOST')).toBe(false)
        if (fault === 'rollback-tx1') {
          expect(withheld).toHaveLength(0)
          expect([terminal, compareCount, readCount, accountCount]).toEqual(['UNAVAILABLE', 0, 1, 0])
          expect(seen.filter((item) => item.event === 'DISPOSE_RETURN' && item.checkout === 1)).toHaveLength(1)
          expect(seen.some((item) => item.event === 'DISPOSE_DISCARD')).toBe(false)
          expect(seen.filter((item) => item.event === 'CHECKOUT').map((item) => item.count)).toEqual([1])
        } else if (fault === 'rollback-tx2') {
          expect(withheld).toHaveLength(0)
          expect([terminal, compareCount, readCount, accountCount, raw?.outcome]).toEqual(['UNAVAILABLE', 1, 1, 1, 'TRUE'])
          expect(seen.filter((item) => item.event === 'ACCOUNT_ENTERED')).toHaveLength(1)
          expect(seen.filter((item) => item.event === 'DISPOSE_RETURN' && item.checkout === 1)).toHaveLength(1)
          expect(seen.some((item) => item.event === 'DISPOSE_DISCARD')).toBe(false)
          expect(seen.filter((item) => item.event === 'CHECKOUT').map((item) => item.count)).toEqual([1])
        } else {
          expect(withheld.map((item) => [item.phase, item.checkout, item.backendPid])).toEqual([[phase, 1, ownerPid]])
          expect(native[0]?.seq ?? 0).toBeLessThan(withheld[0]?.seq ?? 0)
          expect([terminal, compareCount, readCount, accountCount, raw?.outcome]).toEqual(['UNAVAILABLE', 1, 1, 1, 'TRUE'])
          const discards = seen.filter((item) => item.event === 'DISPOSE_DISCARD' && item.checkout === 1)
          expect(discards).toHaveLength(1)
          expect(withheld[0]?.seq ?? 0).toBeLessThan(discards[0]?.seq ?? 0)
          expect(seen.filter((item) => item.event === 'DISPOSE_RETURN' && item.checkout === 1)).toHaveLength(0)
          expect(seen.filter((item) => item.event === 'ACCOUNT_ENTERED')).toHaveLength(1)
          expect(seen.filter((item) => item.event === 'CHECKOUT').map((item) => item.count)).toEqual([1, 2])
          const cleanup = seen.filter((item) => item.event === 'CHECKOUT_READY' && item.checkout === 2)
          expect(cleanup).toHaveLength(1)
          expect(cleanup[0]?.backendPid).not.toBe(ownerPid)
          expect(seen.filter((item) => item.event === 'DISPOSE_RETURN' && item.checkout === 2)).toHaveLength(1)
        }
      } else if (fault === 'unlock-false') {
        const first = seen.filter((item) => item.event === 'UNLOCK_FIRST')
        const second = seen.filter((item) => item.event === 'UNLOCK_NATIVE_FALSE')
        expect(first.map((item) => [item.checkout, item.backendPid, item.unlocked])).toEqual([[1, ownerPid, true]])
        expect(second.map((item) => [item.checkout, item.backendPid, item.unlocked])).toEqual([[1, ownerPid, false]])
        expect(first[0]?.seq ?? 0).toBeLessThan(second[0]?.seq ?? 0)
        expect([terminal, compareCount, readCount, accountCount, raw?.outcome, ownerLost]).toEqual(['RETURNED_TRUE', 1, 1, 1, 'TRUE', false])
        const discard = seen.find((item) => item.event === 'DISPOSE_DISCARD' && item.checkout === 1)
        expect(discard).toBeTruthy()
        expect(second[0]?.seq ?? 0).toBeLessThan(discard?.seq ?? 0)
        expect(seen.some((item) => item.event === 'DISPOSE_RETURN')).toBe(false)
        expect(seen.filter((item) => item.event === 'CHECKOUT').map((item) => item.count)).toEqual([1])
      } else {
        const dispatch = seen.filter((item) => item.event === 'UNLOCK_DISPATCH')
        const rejected = seen.filter((item) => item.event === 'UNLOCK_REJECTED')
        expect(dispatch.map((item) => [item.checkout, item.backendPid])).toEqual([[1, ownerPid]])
        expect(rejected.map((item) => [item.checkout, item.backendPid])).toEqual([[1, ownerPid]])
        expect(dispatch[0]?.seq ?? 0).toBeLessThan(rejected[0]?.seq ?? 0)
        expect(seen.some((item) => item.event === 'UNLOCK_FIRST' || item.event === 'UNLOCK_NATIVE_FALSE')).toBe(false)
        expect([terminal, compareCount, readCount, accountCount, raw?.outcome]).toEqual(['RETURNED_TRUE', 1, 1, 1, 'TRUE'])
        expect(seen.filter((item) => item.event === 'DISPOSE_DISCARD' && item.checkout === 1)).toHaveLength(1)
        expect(seen.some((item) => item.event === 'DISPOSE_RETURN')).toBe(false)
        expect(seen.filter((item) => item.event === 'CHECKOUT').map((item) => item.count)).toEqual([1])
      }
    } else if (ack === undefined) {
      if (role === 'peer') {
        expect([terminal, compareCount, readCount, accountCount]).toEqual(['UNAVAILABLE', 0, 0, 0])
      } else {
        expect([compareCount, readCount, raw?.outcome, released, delivered]).toEqual([1, 1, expectedOutcome, true, true])
        if (role === 'owner') {
          expect([terminal, ownerLost, deliveredAfterLoss, ownerDiscardCount, accountCount]).toEqual(['UNAVAILABLE', true, true, 1, 0])
        } else {
          const expectedTerminal = expectedOutcome === 'ERROR' ? 'UNAVAILABLE' : expectedOutcome === 'TRUE' ? 'RETURNED_TRUE' : 'RETURNED_FALSE'
          expect([terminal, accountCount, ownerLost]).toEqual([expectedTerminal, expectedOutcome === 'ERROR' ? 0 : 1, false])
        }
      }
      if (gate === 'read') {
        const held = seen.filter((item) => item.event === 'READ_HELD')
        const called = seen.find((item) => item.event === 'CALLED')
        expect(held.map((item) => [item.checkout, item.count])).toEqual([[1, 1]])
        expect(held[0]?.seq ?? 0).toBeLessThan(called?.seq ?? 0)
        expect(seen.some((item) => item.event === 'TOKEN_MATCH' || item.event === 'CLEANUP_BEFORE_LOCK')).toBe(false)
      }
    } else {
      const native = seen.filter((item) => item.event === 'NATIVE_COMMIT')
      const withheld = seen.filter((item) => item.event === 'ACK_WITHHELD')
      const ready = seen.filter((item) => item.event === 'CHECKOUT_READY')
      const ownerDiscards = seen.filter((item) => item.event === 'DISPOSE_DISCARD' && item.checkout === 1)
      const ownerReturns = seen.filter((item) => item.event === 'DISPOSE_RETURN' && item.checkout === 1)
      const cleanupDispose = seen.filter((item) => (item.event === 'DISPOSE_DISCARD' || item.event === 'DISPOSE_RETURN') && item.checkout === 2)
      const discardSeq = ownerDiscards[0]?.seq ?? 0
      expect(native.map((item) => [item.phase, item.checkout, item.backendPid])).toEqual([[ack, 1, ready[0]?.backendPid]])
      expect(withheld.map((item) => [item.phase, item.checkout, item.backendPid])).toEqual([[ack, 1, ready[0]?.backendPid]])
      expect(ready.map((item) => item.checkout)).toEqual([1, 2])
      expect(ready[1]?.backendPid).not.toBe(ready[0]?.backendPid)
      expect(native[0]?.seq ?? 0).toBeLessThan(withheld[0]?.seq ?? 0)
      expect(withheld[0]?.seq ?? 0).toBeLessThan(discardSeq)
      expect(ownerDiscards.map((item) => item.count)).toEqual([1])
      expect(ownerDiscardCount).toBe(1)
      expect(ownerReturns).toHaveLength(0)
      expect(cleanupDispose).toHaveLength(1)
      expect(seen.some((item) => item.event === 'OWNER_LOST')).toBe(false)
      expect(seen.some((item) => item.seq > discardSeq && (item.event === 'CALLED' || item.event === 'TX1_BACKEND' || item.event === 'ACCOUNT_ENTERED'))).toBe(false)
      if (ack === 'claim') {
        expect([terminal, compareCount, readCount, accountCount]).toEqual(['UNAVAILABLE', 0, 0, 0])
        expect(seen.some((item) => item.event === 'CALLED' || item.event === 'TX1_BACKEND' || item.event === 'ACCOUNT_ENTERED')).toBe(false)
      } else if (ack === 'account') {
        expect([terminal, compareCount, readCount, accountCount, raw?.outcome]).toEqual(['UNAVAILABLE', 1, 1, 1, expectedOutcome])
      } else if (ack === 'acquisition') {
        expect([terminal, compareCount, readCount, accountCount]).toEqual(['UNAVAILABLE', 0, 0, 0])
        expect(seen.some((item) => item.event === 'CALLED' || item.event === 'TX1_BACKEND' || item.event === 'ACCOUNT_ENTERED'
          || item.event === 'CLAIM_OWNED' || item.event === 'CLAIM_FOREIGN' || item.event === 'TOKEN_MATCH')).toBe(false)
        const locked = seen.filter((item) => item.event === 'CLEANUP_LOCK_ACKED')
        const nativeRelease = seen.filter((item) => item.event === 'RELEASE_NATIVE')
        const releaseCommit = seen.filter((item) => item.event === 'RELEASE_COMMIT')
        const unlocked = seen.filter((item) => item.event === 'CLEANUP_UNLOCK')
        expect(locked.map((item) => [item.checkout, item.backendPid])).toEqual([[2, ready[1]?.backendPid]])
        expect(nativeRelease.map((item) => [item.checkout, item.backendPid, item.released])).toEqual([[2, ready[1]?.backendPid, false]])
        expect(releaseCommit.map((item) => [item.checkout, item.backendPid])).toEqual([[2, ready[1]?.backendPid]])
        expect(unlocked.map((item) => [item.checkout, item.backendPid, item.unlocked])).toEqual([[2, ready[1]?.backendPid, true]])
        expect(locked[0]?.seq ?? 0).toBeLessThan(nativeRelease[0]?.seq ?? 0)
        expect(nativeRelease[0]?.seq ?? 0).toBeLessThan(releaseCommit[0]?.seq ?? 0)
        expect(releaseCommit[0]?.seq ?? 0).toBeLessThan(unlocked[0]?.seq ?? 0)
        expect(seen.filter((item) => item.event === 'DISPOSE_RETURN' && item.checkout === 2)).toHaveLength(1)
        expect(seen.filter((item) => item.event === 'DISPOSE_DISCARD' && item.checkout === 2)).toHaveLength(0)
        expect(seen.some((item) => item.event === 'CLEANUP_BEFORE_LOCK')).toBe(false)
      } else {
        const expectedTerminal = expectedOutcome === 'TRUE' ? 'RETURNED_TRUE' : 'RETURNED_FALSE'
        expect([terminal, compareCount, readCount, accountCount, raw?.outcome]).toEqual([expectedTerminal, 1, 1, 1, expectedOutcome])
        if (hold !== undefined) {
          const before = seen.filter((item) => item.event === 'CLEANUP_BEFORE_LOCK')
          const locked = seen.filter((item) => item.event === 'CLEANUP_LOCK_ACKED')
          const nativeRelease = seen.filter((item) => item.event === 'RELEASE_NATIVE')
          const releaseCommit = seen.filter((item) => item.event === 'RELEASE_COMMIT')
          const unlocked = seen.filter((item) => item.event === 'CLEANUP_UNLOCK')
          expect(before.map((item) => [item.checkout, item.backendPid, item.phase])).toEqual([[2, ready[1]?.backendPid, 'release']])
          expect(locked.map((item) => [item.checkout, item.backendPid])).toEqual([[2, ready[1]?.backendPid]])
          expect(nativeRelease.map((item) => [item.checkout, item.backendPid, item.released])).toEqual([[2, ready[1]?.backendPid, false]])
          expect(releaseCommit.map((item) => [item.checkout, item.backendPid])).toEqual([[2, ready[1]?.backendPid]])
          expect(unlocked.map((item) => [item.checkout, item.backendPid, item.unlocked])).toEqual([[2, ready[1]?.backendPid, true]])
          expect(before[0]?.seq ?? 0).toBeLessThan(locked[0]?.seq ?? 0)
          expect(locked[0]?.seq ?? 0).toBeLessThan(nativeRelease[0]?.seq ?? 0)
          expect(nativeRelease[0]?.seq ?? 0).toBeLessThan(releaseCommit[0]?.seq ?? 0)
          expect(releaseCommit[0]?.seq ?? 0).toBeLessThan(unlocked[0]?.seq ?? 0)
          expect(seen.filter((item) => item.event === 'DISPOSE_RETURN' && item.checkout === 2)).toHaveLength(1)
          expect(seen.filter((item) => item.event === 'DISPOSE_DISCARD' && item.checkout === 2)).toHaveLength(0)
          expect(seen.filter((item) => item.event === 'CLAIM_OWNED' && item.checkout === 2)).toHaveLength(0)
          if (hold === 'abandoned') {
            expect(seen.filter((item) => item.event === 'TOKEN_MATCH').map((item) => [item.checkout, item.equal, item.different])).toEqual([[2, true, false]])
          } else {
            expect(seen.some((item) => item.event === 'TOKEN_MATCH')).toBe(false)
          }
        }
      }
    }
    emit('WORKER_DONE', { count: compareCount })
    if (instrumentationFailed) throw new Error('SEAM_JOURNAL')
  } catch {
    emit('WORKER_FAILED')
    throw new Error('SEAM_WORKER_FAILED')
  } finally {
    closeSync(journal)
  }
}, 30000)
