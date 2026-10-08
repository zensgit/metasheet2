import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  prepareRecoveryForeignAdmission,
  assertRecoveryParticipantSet,
  assertRecoveryParticipantStates,
  assertRecoveryAuthorityScopeCovered,
  RecoveryForeignAdmissionError,
} from '../../src/multitable/recovery-foreign-admission'
import {
  acquireMaterializedArchiveAsyncFencesInternal,
  applyExactAnchorRecovery,
  type ExactAnchorApplyInput,
} from '../../src/multitable/exact-anchor-recovery-execute'
import { mintExactAnchorRecoveryIdentity } from '../../src/multitable/restore-preview-identity'
import { SheetWriterBlockedError, __resetRecoveryWriterStateColumnProbe } from '../../src/multitable/canonical-sheet-fence'
import { registerRecoveryArchiveRestoreOwnerRoutes } from '../../src/routes/recovery-archive-restore-owner'
import type { QueryFn } from '../../src/multitable/permission-service'
import { usePinnedServer } from '../utils/pinned-server'

const pinned = usePinnedServer()

beforeEach(() => {
  vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
  vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
  vi.stubEnv('MULTITABLE_HISTORY_CONTIGUITY_STRICT', 'true')
  vi.stubEnv('JWT_SECRET', 'synthetic-g2-foreign-admission-signing-key-long-enough')
  __resetRecoveryWriterStateColumnProbe()
})
afterEach(() => { vi.unstubAllEnvs() })

function database(options: {
  first?: string[]
  current?: string[]
  states?: Record<string, unknown>
  stateRows?: unknown[]
  isolation?: string
  fail?: 'setup' | 'state'
} = {}) {
  let discovery = 0
  const query = vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(async (sql, params) => {
    if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' && options.fail === 'setup') throw new Error('private-driver-detail')
    if (sql === 'SHOW transaction_isolation') return { rows: [{ transaction_isolation: options.isolation ?? 'read committed' }] }
    if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '123' }] }
    if (sql.includes('information_schema')) return { rows: [{ present: 1 }] }
    if (sql.includes('FROM meta_fields')) {
      discovery++
      const ids = discovery === 1 ? options.first ?? ['a', 'b'] : options.current ?? options.first ?? ['a', 'b']
      return { rows: ids.map((id) => ({ id: `field-${id}`, property: { foreignSheetId: id } })) }
    }
    if (sql.includes('FROM meta_links')) return { rows: [] }
    if (sql.startsWith('SELECT recovery_writer_state')) {
      if (options.fail === 'state') throw new Error('private-schema-detail')
      const id = String(params?.[0])
      return { rows: options.stateRows ?? [{ recovery_writer_state: options.states && id in options.states ? options.states[id] : null }] }
    }
    return { rows: [] }
  })
  return { query, sql: () => query.mock.calls.map(([sql]) => sql) }
}

function hotInput(): ExactAnchorApplyInput {
  const claims = {
    sheetId: 'b', actorId: 'actor', anchorOperationId: 'operation', anchorSeq: '1', checkpointId: 'checkpoint',
    scopeHash: 'a'.repeat(64), liveSetHash: 'b'.repeat(64), schemaHash: 'c'.repeat(64),
    mode: 'reset' as const, authorizedScopeHash: 'd'.repeat(64),
  }
  return {
    token: mintExactAnchorRecoveryIdentity(claims), sheetId: 'b', actorId: 'actor',
    preliminaryFullRead: vi.fn(async () => false),
    stabilizeAuthorization: vi.fn(async () => 'ready' as const),
    finalLockedFullRead: vi.fn(async () => true), evaluatePlanAuthorization: vi.fn(async () => true),
  }
}

function runHot(db: ReturnType<typeof database>, input = hotInput()) {
  const calls = vi.fn()
  const transaction = async <T>(work: (query: QueryFn) => Promise<T>): Promise<T> => {
    calls()
    return work(db.query)
  }
  return { input, transaction: calls, result: applyExactAnchorRecovery(transaction, input) }
}

const isMutation = (sql: string) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)

describe('selected recovery foreign admission', () => {
  it('sets and verifies RC before any snapshot-bearing statement', async () => {
    const db = database()
    await prepareRecoveryForeignAdmission(db.query)
    expect(db.sql()).toEqual(['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SHOW transaction_isolation'])
  })

  it.each(['repeatable read', 'serializable', 'unexpected'])('refuses actual isolation %s values-free', async (isolation) => {
    const db = database({ isolation })
    await expect(prepareRecoveryForeignAdmission(db.query)).rejects.toMatchObject({ code: 'RECOVERY_FOREIGN_ADMISSION_REFUSED', reason: 'recovery-trust-required' })
  })

  it('sanitizes setup and state-schema failures', async () => {
    for (const fail of ['setup', 'state'] as const) {
      const db = database({ fail })
      const result = fail === 'setup' ? prepareRecoveryForeignAdmission(db.query) : assertRecoveryParticipantStates(db.query, ['private-sheet'])
      const error = await result.catch((error: unknown) => error)
      expect(error).toBeInstanceOf(RecoveryForeignAdmissionError)
      expect(JSON.stringify(error)).not.toContain('private-')
      expect(String(error)).toBe('RecoveryForeignAdmissionError: recovery-trust-required')
    }
  })

  it.each(['fencing', 'applying', 'paused_retryable', 'archiving'])('refuses durable %s without interpreting lease expiry', async (state) => {
    const db = database({ states: { a: state } })
    await expect(assertRecoveryParticipantStates(db.query, ['a', 'b'])).rejects.toMatchObject({ name: 'SheetWriterBlockedError', code: 'SHEET_WRITER_BLOCKED' })
    expect(db.sql()).toEqual(['SELECT recovery_writer_state FROM meta_sheets WHERE id = $1'])
    expect(db.sql().join(' ')).not.toContain('lease')
  })

  it.each([{ rows: [] }, { rows: [{ recovery_writer_state: null }, { recovery_writer_state: null }] }, { rows: [{}] }, { rows: [{ recovery_writer_state: 'unknown' }] }])('refuses missing/ambiguous/unknown state %#', async ({ rows }) => {
    const db = database({ stateRows: rows })
    await expect(assertRecoveryParticipantStates(db.query, ['a'])).rejects.toMatchObject({ reason: 'recovery-trust-required' })
  })

  it('checks every participant with no compatibility-cache probe', async () => {
    const db = database()
    await assertRecoveryParticipantStates(db.query, ['a', 'b', 'c'])
    expect(db.query.mock.calls.map(([, params]) => params)).toEqual([['a'], ['b'], ['c']])
    expect(db.sql().some((sql) => sql.includes('information_schema'))).toBe(false)
  })

  it.each([{ next: ['a', 'b', 'c'] }, { next: ['b'] }, { next: ['b', 'a'] }])('refuses changed participant set %#', ({ next }) => {
    expect(() => assertRecoveryParticipantSet(['a', 'b'], next)).toThrow(RecoveryForeignAdmissionError)
  })

  it('accepts identical sets but only covered actual authority scopes', () => {
    expect(() => assertRecoveryParticipantSet(['a', 'b'], ['a', 'b'])).not.toThrow()
    expect(() => assertRecoveryAuthorityScopeCovered(['a', 'b'], ['b'])).not.toThrow()
    expect(() => assertRecoveryAuthorityScopeCovered(['a', 'b'], ['a', 'c'])).toThrow(RecoveryForeignAdmissionError)
  })

  it('actual hot entry configures RC before xid, fences once in sorted order, and refuses foreign before authorization/burn', async () => {
    const db = database({ first: ['b', 'a', 'a'], states: { a: 'archiving' } })
    const run = runHot(db)
    await expect(run.result).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(db.sql().slice(0, 4)).toEqual([
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SHOW transaction_isolation',
      'SELECT pg_current_xact_id()::text AS xid', 'SELECT pg_current_xact_id()::text AS xid',
    ])
    expect(db.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock')).map(([, params]) => params)).toEqual([
      ['meta:auto-number:sheet:a'], ['meta:auto-number:sheet:b'],
    ])
    expect(db.sql().filter((sql) => sql.includes('FROM meta_fields'))).toHaveLength(2)
    expect(run.input.preliminaryFullRead).not.toHaveBeenCalled()
    expect(db.sql().some(isMutation)).toBe(false)
    expect(run.transaction).toHaveBeenCalledOnce()
  })

  it('does not mistake RC setup for proof of an ongoing transaction', async () => {
    const db = database()
    let xid = 0
    const inner = db.query.getMockImplementation()!
    db.query.mockImplementation(async (sql, params) => sql.includes('pg_current_xact_id')
      ? { rows: [{ xid: String(++xid) }] } : inner(sql, params))
    await expect(runHot(db).result).resolves.toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect(db.sql().slice(0, 2)).toEqual(['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SHOW transaction_isolation'])
    expect(db.sql().some((sql) => sql.includes('pg_advisory_xact_lock') || isMutation(sql))).toBe(false)
  })

  it('hot source remains blocked and no selected block can inherit async exemption', async () => {
    const db = database({ states: { b: 'archiving' } })
    await expect(runHot(db).result).rejects.toBeInstanceOf(SheetWriterBlockedError)
    expect(db.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT recovery_writer_state')).map(([, params]) => params)).toEqual([['a'], ['b']])
  })

  it('hot new participant refuses before state reads/burn, with no late fence or retry', async () => {
    const db = database({ first: ['a', 'b'], current: ['a', 'b', 'c'] })
    const run = runHot(db)
    await expect(run.result).resolves.toEqual({ ok: false, reason: 'preview-drift' })
    expect(run.transaction).toHaveBeenCalledOnce()
    expect(db.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock')).map(([, params]) => params)).toEqual([
      ['meta:auto-number:sheet:a'], ['meta:auto-number:sheet:b'],
    ])
    expect(db.sql().some((sql) => sql.startsWith('SELECT recovery_writer_state') || isMutation(sql))).toBe(false)
  })

  it('hot unknown trust returns existing closed refusal and clean participant set proceeds to authorization', async () => {
    const unknown = database({ stateRows: [{}] })
    await expect(runHot(unknown).result).resolves.toEqual({ ok: false, reason: 'recovery-trust-required' })
    const clean = database()
    const run = runHot(clean)
    await expect(run.result).resolves.toEqual({ ok: false, reason: 'forbidden' })
    expect(run.input.preliminaryFullRead).toHaveBeenCalledOnce()
  })

  it('async prelock exempts only its source and mints a frozen opaque lease after foreign check', async () => {
    const db = database({ states: { b: 'archiving' } })
    const lease = await acquireMaterializedArchiveAsyncFencesInternal(db.query, 'b')
    expect(Object.isFrozen(lease)).toBe(true)
    expect(Object.keys(lease)).toEqual([])
    expect(db.sql().slice(0, 2)).toEqual(['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SHOW transaction_isolation'])
    expect(db.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT recovery_writer_state')).map(([, params]) => params)).toEqual([['a']])
    expect(db.sql().some(isMutation)).toBe(false)
  })

  it('async prelock rejects foreign block and changed set before lease mint', async () => {
    await expect(acquireMaterializedArchiveAsyncFencesInternal(database({ states: { a: 'archiving', b: 'archiving' } }).query, 'b')).rejects.toBeInstanceOf(SheetWriterBlockedError)
    await expect(acquireMaterializedArchiveAsyncFencesInternal(database({ current: ['a', 'b', 'c'] }).query, 'b')).rejects.toMatchObject({ reason: 'preview-drift', code: 'RECOVERY_FOREIGN_ADMISSION_REFUSED' })
  })

  it('self-links deduplicate without granting a foreign bypass', async () => {
    const db = database({ first: ['b', 'b'], states: { b: 'archiving' } })
    await acquireMaterializedArchiveAsyncFencesInternal(db.query, 'b')
    expect(db.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock')).map(([, params]) => params)).toEqual([['meta:auto-number:sheet:b']])
    expect(db.sql().some((sql) => sql.startsWith('SELECT recovery_writer_state'))).toBe(false)
  })

  const flags = [undefined, 'false', 'TRUE', ' true ', 'true']
  for (const archive of flags) for (const fence of flags) {
    if (archive === 'true' && fence === 'true') continue
    it(`preserves unselected hot/async SQL and normalized legacy flag for ${String(archive)}/${String(fence)}`, async () => {
      if (archive === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
      else vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', archive)
      if (fence === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
      else vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', fence)
      const db = database({ states: { a: 'archiving' } })
      const run = runHot(db)
      const legacyEnabled = typeof fence === 'string' && fence.trim().toLowerCase() === 'true'
      await expect(run.result).resolves.toEqual({ ok: false, reason: legacyEnabled ? 'forbidden' : 'recovery-trust-required' })
      expect(db.sql().slice(0, 2)).toEqual(['SELECT pg_current_xact_id()::text AS xid', 'SELECT pg_current_xact_id()::text AS xid'])
      expect(db.sql().filter((sql) => sql.includes('FROM meta_fields'))).toHaveLength(legacyEnabled ? 1 : 0)
      expect(db.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT recovery_writer_state')).map(([, params]) => params)).toEqual(legacyEnabled ? [['b']] : [])
      const prelock = database({ states: { a: 'archiving' } })
      await acquireMaterializedArchiveAsyncFencesInternal(prelock.query, 'b')
      expect(prelock.sql().filter((sql) => sql.includes('FROM meta_fields'))).toHaveLength(1)
      expect(prelock.sql().some((sql) => /^(SET|SHOW)/.test(sql) || sql.startsWith('SELECT recovery_writer_state'))).toBe(false)
    })
  }

  it.each([true, false])('sync route maps recognized block only for selected=%s', async (selected) => {
    if (!selected) vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'TRUE')
    const app = express()
    app.use(express.json())
    const router = express.Router()
    registerRecoveryArchiveRestoreOwnerRoutes(router, {
      resolveContext: async () => ({ ok: true, context: {
        workspaceId: 'workspace', baseId: 'base', sheetId: 'b', actorId: 'actor',
        recheckAuthority: async () => true, evaluatePlanAuthorization: async () => true,
      } }),
      service: {
        executeSync: async () => { throw new SheetWriterBlockedError('private-sheet', 'archiving') },
        read: vi.fn(), resume: vi.fn(),
      },
    })
    app.use(router)
    pinned.setApp(app)
    const response = await request(pinned.url()).post('/sheets/b/recovery-archive/execute').send({ previewIdentity: 'synthetic', scope: { kind: 'whole_sheet' } })
    expect(response.status).toBe(selected ? 409 : 500)
    expect(response.body).toEqual(selected
      ? { ok: false, error: { code: 'RECOVERY_IN_PROGRESS', message: 'Another recovery operation is in progress on this sheet; retry shortly.' } }
      : { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Archive recovery request failed.' } })
    expect(response.text).not.toContain('private-sheet')
    expect(response.text).not.toContain('archiving')
  })
})
