import { normalizeRecoveryArchiveOwnedFailure } from '../../src/multitable/recovery-archive-owned-composer'
import type { Pool } from 'pg'
import type { SealQuery } from '../../src/multitable/recovery-archive-seals'
import { runRecoveryArchiveOwnedTransaction } from '../../src/multitable/recovery-archive-owned-authority'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindRecoveryArchiveManualCommand } from '../../src/multitable/recovery-archive-manual-command'
import type { RecoveryArchivePreviewRuntime } from '../../src/multitable/recovery-archive-preview'

afterEach(() => vi.unstubAllEnvs())

describe('owned manual generation composer', () => {
  it('refuses missing native pool and capture limits before any claim transaction', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const transaction = vi.fn(async () => { throw new Error('UNEXPECTED_CLAIM_TRANSACTION') })
    const command = bindRecoveryArchiveManualCommand(transaction, async () => true,
      {} as RecoveryArchivePreviewRuntime,
      { keyId: 'synthetic_key', keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 })
    await expect(command.capture({ actorId: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222', workspaceId: 'synthetic_workspace',
      baseId: 'synthetic_base', sheetId: 'synthetic_sheet' })).rejects.toThrow('RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID')
    expect(transaction).not.toHaveBeenCalled()
  })
  it.each([
    { maxBytes: 0, timeoutMs: 100 }, { maxBytes: 100, timeoutMs: 0 },
    { maxBytes: 100, timeoutMs: 100, extra: true }, { maxBytes: 100, timeoutMs: Infinity },
  ])('refuses invalid explicit capture limits before any claim or status transaction (%#)', async (limits) => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const transaction = vi.fn(async () => { throw new Error('UNEXPECTED_TRANSACTION') })
    const connect = vi.fn()
    const command = bindRecoveryArchiveManualCommand(transaction, async () => true, {} as RecoveryArchivePreviewRuntime,
      { keyId: 'synthetic_key', keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 }, undefined,
      { pool: { connect, options: { connectionTimeoutMillis: 10 } }, limits })
    await expect(command.capture({ actorId: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222', workspaceId: 'synthetic_workspace',
      baseId: 'synthetic_base', sheetId: 'synthetic_sheet' })).rejects.toThrow('RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID')
    expect(transaction).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it.each(['TRUE', 'false', ' true '])('keeps the existing unselected flag refusal before database or native acquisition: %s', async (archiveFlag) => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', archiveFlag)
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const transaction = vi.fn(async () => { throw new Error('UNSELECTED_LEGACY_TRANSACTION') })
    const connect = vi.fn()
    const command = bindRecoveryArchiveManualCommand(transaction, async () => true, {} as RecoveryArchivePreviewRuntime,
      { keyId: 'synthetic_key', keyRowVersion: '1', leaseSeconds: 60, expiresAfterSeconds: 3600 }, undefined,
      { pool: { connect, options: { connectionTimeoutMillis: 10 } }, limits: { maxBytes: 4096, timeoutMs: 100 } })
    await expect(command.capture({ actorId: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222', workspaceId: 'synthetic_workspace',
      baseId: 'synthetic_base', sheetId: 'synthetic_sheet' })).rejects.toThrow('RECOVERY_ARCHIVE_MANUAL_UNAVAILABLE')
    expect(transaction).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('revokes a retained transaction query before the client is returned for another borrower', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql === 'SHOW statement_timeout' ? [{ statement_timeout: '30s' }] : [] }))
    const release = vi.fn()
    const pool = { connect: vi.fn(async () => ({ query, release })), options: { connectionTimeoutMillis: 10 } }
    let retained!: SealQuery
    await runRecoveryArchiveOwnedTransaction(pool as unknown as Pick<Pool, 'connect' | 'options'>, 1000, { value: 0 }, async (ownedQuery) => {
      retained = ownedQuery
      await ownedQuery('SELECT pg_advisory_xact_lock(hashtext($1))', ['synthetic_sheet'])
    })
    const calls = query.mock.calls.length
    await expect(retained('SELECT 1')).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_AUTHORITY_UNAVAILABLE')
    expect(query.mock.calls.length).toBe(calls)
    expect(release).toHaveBeenCalledOnce()
  })

  it('refreshes the server statement timeout immediately before COMMIT after its first source-free fence', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql === 'SHOW statement_timeout' ? [{ statement_timeout: '30s' }] : [] }))
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })), options: { connectionTimeoutMillis: 10 } }
    await runRecoveryArchiveOwnedTransaction(pool as unknown as Pick<Pool, 'connect' | 'options'>, 1000, { value: 0 }, async (ownedQuery) => {
      await ownedQuery('SELECT pg_advisory_xact_lock(hashtext($1))', ['synthetic_sheet'])
      await ownedQuery('SELECT 1')
    })
    const sql = query.mock.calls.map(([text]) => text)
    expect(sql[sql.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED') + 1]).toBe('SELECT pg_advisory_xact_lock(hashtext($1))')
    expect(sql[sql.indexOf('COMMIT') - 1]).toBe("SELECT set_config('statement_timeout',$1,true)")
  })

  it('normalizes unrecognized exceptions and drops causes through an explicit closed code set', () => {
    const secret = 'private adapter source value'
    for (const original of [new Error(secret), new Error('RECOVERY_ARCHIVE_PRIVATE_SENTINEL'), { message: secret }, secret]) {
      const error = normalizeRecoveryArchiveOwnedFailure(original)
      expect(error.message).toBe('RECOVERY_ARCHIVE_OWNED_GENERATION_REFUSED')
      expect(error).not.toHaveProperty('cause')
      expect(String(error)).not.toContain(secret)
    }
    const original = new Error('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED', { cause: new Error(secret) })
    const error = normalizeRecoveryArchiveOwnedFailure(original)
    expect(error.message).toBe('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')
    expect(error).not.toBe(original)
    expect(error).not.toHaveProperty('cause')
  })

})
