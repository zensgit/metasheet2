import { describe, expect, it, vi } from 'vitest'

import {
  AUTHORIZE_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_SQL,
  AUTHORIZE_RECOVERY_ARCHIVE_EXPIRY_SQL,
  EXPIRE_RECOVERY_ARCHIVE_SQL,
  expireRecoveryArchiveAfterLegalHoldCheck,
  placeRecoveryArchiveLegalHold,
  RECOVERY_ARCHIVE_LEGAL_HOLD_FENCE_SQL,
  RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_LOCK_SQL,
  RECOVERY_ARCHIVE_LEGAL_HOLD_GENERATION_LOCK_SQL,
  RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_LOCK_SQL,
  RESET_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_AUTHORIZATION_SQL,
  RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL,
  RecoveryArchiveLegalHoldError,
  RELEASE_RECOVERY_ARCHIVE_LEGAL_HOLD_SQL,
  releaseRecoveryArchiveLegalHold,
  type PlaceRecoveryArchiveLegalHoldInput,
  type RecoveryArchiveLegalHoldQuery,
  type ReleaseRecoveryArchiveLegalHoldInput,
} from '../../src/multitable/recovery-archive-legal-holds'

const XID = '7001'
const HOLD_ID = '11111111-1111-4111-8111-111111111111'
const GENERATION_ID = '22222222-2222-4222-8222-222222222222'

const placeInput: PlaceRecoveryArchiveLegalHoldInput = {
  holdId: HOLD_ID,
  workspaceId: 'workspace-a',
  baseId: 'base-a',
  sheetId: 'sheet-a',
  generationId: GENERATION_ID,
  reasonCode: 'REGULATORY',
  placedByActorId: 'actor-a',
}

const releaseInput: ReleaseRecoveryArchiveLegalHoldInput = {
  holdId: HOLD_ID,
  workspaceId: 'workspace-a',
  baseId: 'base-a',
  sheetId: 'sheet-a',
  generationId: GENERATION_ID,
  expectedRowVersion: '1',
  releasedByActorId: 'actor-b',
}

function result(rows: unknown[]) {
  return { rows, rowCount: rows.length }
}

function activeSnapshotRow() {
  return {
    id: HOLD_ID,
    workspace_id: 'workspace-a',
    base_id: 'base-a',
    sheet_id: 'sheet-a',
    generation_id: GENERATION_ID,
    state: 'active',
    reason_code: 'REGULATORY',
    placed_by_actor_id: 'actor-a',
    placed_at: '2026-08-28 00:00:00+00',
    released_by_actor_id: null,
    released_at: null,
    row_version: '1',
    xid: XID,
  }
}

function releasedSnapshotRow() {
  return {
    ...activeSnapshotRow(),
    state: 'released',
    released_by_actor_id: 'actor-b',
    released_at: '2026-08-28 00:01:00+00',
    row_version: '2',
  }
}

function authorityQuery(mode: 'place' | 'release' | 'expiry'): RecoveryArchiveLegalHoldQuery {
  return vi.fn(async (sqlText: string) => {
    if (sqlText === 'SELECT pg_current_xact_id()::text AS xid') return result([{ xid: XID }])
    if (sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_FENCE_SQL) {
      return result([{ locked: null, xid: XID }])
    }
    if (sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_LOCK_SQL) {
      return result([{ key_id: 'catalog-key', state: 'active', xid: XID }])
    }
    if (sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_GENERATION_LOCK_SQL) {
      return result([{
        generation_id: GENERATION_ID,
        workspace_id: 'workspace-a',
        base_id: 'base-a',
        sheet_id: 'sheet-a',
        key_id: 'catalog-key',
        state: 'verified',
        expires_at: '2026-08-27 00:00:00+00',
        xid: XID,
      }])
    }
    if (sqlText.includes('FROM public.meta_recovery_archives archive')) {
      return result([{
        generation_id: GENERATION_ID,
        workspace_id: 'workspace-a',
        base_id: 'base-a',
        sheet_id: 'sheet-a',
        key_id: 'catalog-key',
        state: 'verified',
        expires_at: '2026-08-27 00:00:00+00',
        xid: XID,
      }])
    }
    if (sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_LOCK_SQL) {
      return result([{ active_hold_count: 0, xid: XID }])
    }
    if (sqlText === AUTHORIZE_RECOVERY_ARCHIVE_EXPIRY_SQL) return result([{ xid: XID }])
    if (sqlText === AUTHORIZE_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_SQL) return result([{ xid: XID }])
    if (sqlText === EXPIRE_RECOVERY_ARCHIVE_SQL) {
      return result([{
        generation_id: GENERATION_ID,
        workspace_id: 'workspace-a',
        base_id: 'base-a',
        sheet_id: 'sheet-a',
        state: 'expired',
        expires_at: '2026-08-27 00:00:00+00',
        xid: XID,
      }])
    }
    if (sqlText === RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL) {
      return result([{ reset: '', xid: XID }])
    }
    if (sqlText === RESET_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_AUTHORIZATION_SQL) {
      return result([{ reset_hold: '', reset_generation: '', xid: XID }])
    }
    if (sqlText.includes('ORDER BY hold_row.id')) return result([])
    if (sqlText.startsWith('INSERT INTO public.meta_recovery_archive_legal_holds')) {
      return result([activeSnapshotRow()])
    }
    if (sqlText.includes('hold_row.id = $1::uuid')) {
      return result([{
        id: HOLD_ID,
        workspace_id: 'workspace-a',
        base_id: 'base-a',
        sheet_id: 'sheet-a',
        generation_id: GENERATION_ID,
        state: 'active',
        row_version: '1',
        xid: XID,
      }])
    }
    if (sqlText === RELEASE_RECOVERY_ARCHIVE_LEGAL_HOLD_SQL) {
      return result([releasedSnapshotRow()])
    }
    throw new Error(`unexpected query in ${mode}`)
  })
}

async function errorOf(promise: Promise<unknown>): Promise<RecoveryArchiveLegalHoldError> {
  try {
    await promise
  } catch (error) {
    return error as RecoveryArchiveLegalHoldError
  }
  throw new Error('expected_error')
}

describe('recovery archive legal-hold storage authority', () => {
  it('rebinds through the catalog and locks fence, catalog key, generation, then hold rows', async () => {
    const query = authorityQuery('place') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    const snapshot = await placeRecoveryArchiveLegalHold(query, placeInput)

    expect(snapshot).toMatchObject({ holdId: HOLD_ID, state: 'active', rowVersion: '1' })
    const calls = query.mock.calls as Array<[string, unknown[] | undefined]>
    const rebind = calls.findIndex(([sqlText]) => (
      sqlText.includes('FROM public.meta_recovery_archives archive')
      && sqlText !== RECOVERY_ARCHIVE_LEGAL_HOLD_GENERATION_LOCK_SQL
    ))
    const fence = calls.findIndex(([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_FENCE_SQL)
    const key = calls.findIndex(([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_LOCK_SQL)
    const generation = calls.findIndex(
      ([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_GENERATION_LOCK_SQL,
    )
    const hold = calls.findIndex(([sqlText]) => sqlText.includes('ORDER BY hold_row.id'))
    expect([rebind, fence, key, generation, hold]).toEqual([2, 3, 4, 5, 6])
    expect(calls[fence]?.[1]).toEqual(['meta:auto-number:sheet:sheet-a'])
    expect(calls[key]?.[1]).toEqual(['catalog-key'])
  })

  it('release authorizes only after the ordered prefix, retains its exact CAS, and clears its guard', async () => {
    const query = authorityQuery('release') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    const snapshot = await releaseRecoveryArchiveLegalHold(query, releaseInput)

    expect(snapshot).toMatchObject({ state: 'released', rowVersion: '2' })
    expect(RELEASE_RECOVERY_ARCHIVE_LEGAL_HOLD_SQL).toContain('AND row_version = $7::bigint')
    const calls = query.mock.calls as Array<[string, unknown[] | undefined]>
    const fence = calls.findIndex(([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_FENCE_SQL)
    const key = calls.findIndex(([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_LOCK_SQL)
    const generation = calls.findIndex(
      ([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_GENERATION_LOCK_SQL,
    )
    const hold = calls.findIndex(([sqlText]) => sqlText.includes('hold_row.id = $1::uuid'))
    const authorize = calls.findIndex(([sqlText]) => sqlText === AUTHORIZE_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_SQL)
    const update = calls.findIndex(([sqlText]) => sqlText === RELEASE_RECOVERY_ARCHIVE_LEGAL_HOLD_SQL)
    const reset = calls.findIndex(
      ([sqlText]) => sqlText === RESET_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_AUTHORIZATION_SQL,
    )
    expect([fence, key, generation, hold, authorize, update, reset]).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(calls[authorize]?.[1]).toEqual([
      HOLD_ID,
      GENERATION_ID,
      'workspace-a',
      'base-a',
      'sheet-a',
      '1',
    ])
    const updateCall = query.mock.calls.find(
      ([sqlText]) => sqlText === RELEASE_RECOVERY_ARCHIVE_LEGAL_HOLD_SQL,
    )
    expect(updateCall?.[1]).toEqual([
      HOLD_ID,
      'workspace-a',
      'base-a',
      'sheet-a',
      GENERATION_ID,
      'actor-b',
      '1',
    ])
  })

  it('clears the release guard when its exact CAS produces no row', async () => {
    const query = authorityQuery('release') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    query.mockImplementation(async (sqlText: string) => {
      if (sqlText === RELEASE_RECOVERY_ARCHIVE_LEGAL_HOLD_SQL) return result([])
      return authorityQuery('release')(sqlText)
    })

    const refusal = await errorOf(releaseRecoveryArchiveLegalHold(query, releaseInput))
    expect(refusal.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_STALE')
    expect(query.mock.calls.some(
      ([sqlText]) => sqlText === RESET_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_AUTHORIZATION_SQL,
    )).toBe(true)
  })

  it('preserves the values-free release refusal when reset follows an aborted authorization', async () => {
    const query = authorityQuery('release') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    query.mockImplementation(async (sqlText: string) => {
      if (sqlText === AUTHORIZE_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_SQL) {
        throw new Error('untrusted_authorizer_failure')
      }
      if (sqlText === RESET_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_AUTHORIZATION_SQL) {
        throw new Error('aborted_transaction')
      }
      return authorityQuery('release')(sqlText)
    })

    const refusal = await errorOf(releaseRecoveryArchiveLegalHold(query, releaseInput))
    expect(refusal.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_REFUSED')
    expect(refusal.message).not.toContain('untrusted_authorizer_failure')
    expect(query.mock.calls.some(
      ([sqlText]) => sqlText === RESET_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_AUTHORIZATION_SQL,
    )).toBe(true)
  })

  it('does not report release success when its guard reset fails', async () => {
    const sentinel = 'untrusted_release_reset_failure'
    const query = authorityQuery('release') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    query.mockImplementation(async (sqlText: string) => {
      if (sqlText === RESET_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_AUTHORIZATION_SQL) {
        throw new Error(sentinel)
      }
      return authorityQuery('release')(sqlText)
    })

    const refusal = await errorOf(releaseRecoveryArchiveLegalHold(query, releaseInput))
    expect(refusal.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION')
    expect(refusal.message).not.toContain(sentinel)
    expect(query.mock.calls.filter(
      ([sqlText]) => sqlText === RESET_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_AUTHORIZATION_SQL,
    )).toHaveLength(1)
  })

  it('expires only through the stable ordered authority and always clears its exact guard', async () => {
    const query = authorityQuery('expiry') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    const snapshot = await expireRecoveryArchiveAfterLegalHoldCheck(query, {
      workspaceId: 'workspace-a',
      baseId: 'base-a',
      sheetId: 'sheet-a',
      generationId: GENERATION_ID,
    })

    expect(snapshot).toEqual({
      workspaceId: 'workspace-a',
      baseId: 'base-a',
      sheetId: 'sheet-a',
      generationId: GENERATION_ID,
      state: 'expired',
      expiresAt: '2026-08-27 00:00:00+00',
    })
    expect(EXPIRE_RECOVERY_ARCHIVE_SQL).toContain("AND state = 'verified'")
    expect(EXPIRE_RECOVERY_ARCHIVE_SQL).toContain('AND expires_at <= clock_timestamp()')
    const calls = query.mock.calls as Array<[string, unknown[] | undefined]>
    const fence = calls.findIndex(([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_FENCE_SQL)
    const key = calls.findIndex(([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_LOCK_SQL)
    const generation = calls.findIndex(
      ([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_GENERATION_LOCK_SQL,
    )
    const hold = calls.findIndex(([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_LOCK_SQL)
    const authorize = calls.findIndex(([sqlText]) => sqlText === AUTHORIZE_RECOVERY_ARCHIVE_EXPIRY_SQL)
    const update = calls.findIndex(([sqlText]) => sqlText === EXPIRE_RECOVERY_ARCHIVE_SQL)
    const reset = calls.findIndex(([sqlText]) => sqlText === RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL)
    expect([fence, key, generation, hold, authorize, update, reset]).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(calls[authorize]?.[1]).toEqual([GENERATION_ID, 'workspace-a', 'base-a', 'sheet-a'])
  })

  it('clears the expiry guard when its exact CAS produces no row', async () => {
    const query = authorityQuery('expiry') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    query.mockImplementation(async (sqlText: string) => {
      if (sqlText === EXPIRE_RECOVERY_ARCHIVE_SQL) return result([])
      return authorityQuery('expiry')(sqlText)
    })

    const refusal = await errorOf(expireRecoveryArchiveAfterLegalHoldCheck(query, {
      workspaceId: 'workspace-a',
      baseId: 'base-a',
      sheetId: 'sheet-a',
      generationId: GENERATION_ID,
    }))
    expect(refusal.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_RESULT_INVALID')
    expect(query.mock.calls.some(
      ([sqlText]) => sqlText === RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL,
    )).toBe(true)
  })

  it('clears the expiry guard after an authorizer result is malformed in a live transaction', async () => {
    const query = authorityQuery('expiry') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    query.mockImplementation(async (sqlText: string) => {
      if (sqlText === AUTHORIZE_RECOVERY_ARCHIVE_EXPIRY_SQL) return result([{ xid: 'other-xid' }])
      return authorityQuery('expiry')(sqlText)
    })

    const refusal = await errorOf(expireRecoveryArchiveAfterLegalHoldCheck(query, {
      workspaceId: 'workspace-a',
      baseId: 'base-a',
      sheetId: 'sheet-a',
      generationId: GENERATION_ID,
    }))

    expect(refusal.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION')
    expect(query.mock.calls.some(
      ([sqlText]) => sqlText === RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL,
    )).toBe(true)
  })

  it('preserves the values-free expiry refusal when reset follows an aborted update', async () => {
    const query = authorityQuery('expiry') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    query.mockImplementation(async (sqlText: string) => {
      if (sqlText === EXPIRE_RECOVERY_ARCHIVE_SQL) throw new Error('untrusted_update_failure')
      if (sqlText === RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL) {
        throw new Error('aborted_transaction')
      }
      return authorityQuery('expiry')(sqlText)
    })

    const refusal = await errorOf(expireRecoveryArchiveAfterLegalHoldCheck(query, {
      workspaceId: 'workspace-a',
      baseId: 'base-a',
      sheetId: 'sheet-a',
      generationId: GENERATION_ID,
    }))

    expect(refusal.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_REFUSED')
    expect(refusal.message).not.toContain('untrusted_update_failure')
    expect(query.mock.calls.some(
      ([sqlText]) => sqlText === RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL,
    )).toBe(true)
  })

  it('does not report expiry success when its guard reset fails', async () => {
    const sentinel = 'untrusted_expiry_reset_failure'
    const query = authorityQuery('expiry') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    query.mockImplementation(async (sqlText: string) => {
      if (sqlText === RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL) throw new Error(sentinel)
      return authorityQuery('expiry')(sqlText)
    })

    const refusal = await errorOf(expireRecoveryArchiveAfterLegalHoldCheck(query, {
      workspaceId: 'workspace-a',
      baseId: 'base-a',
      sheetId: 'sheet-a',
      generationId: GENERATION_ID,
    }))
    expect(refusal.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION')
    expect(refusal.message).not.toContain(sentinel)
    expect(query.mock.calls.filter(
      ([sqlText]) => sqlText === RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL,
    )).toHaveLength(1)
  })

  it('refuses mismatched catalog binding before acquiring any lock', async () => {
    const query = authorityQuery('place') as ReturnType<typeof vi.fn> & RecoveryArchiveLegalHoldQuery
    const refusal = await errorOf(placeRecoveryArchiveLegalHold(query, {
      ...placeInput,
      workspaceId: 'workspace-other',
    }))
    expect(refusal.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_BINDING_REFUSED')
    expect(query.mock.calls.some(
      ([sqlText]) => sqlText === RECOVERY_ARCHIVE_LEGAL_HOLD_FENCE_SQL,
    )).toBe(false)
  })

  it('refuses autocommit query capabilities before authority locks', async () => {
    let xid = 8000
    const query = vi.fn(async () => result([{ xid: String(xid++) }]))
    const refusal = await errorOf(placeRecoveryArchiveLegalHold(query, placeInput))
    expect(refusal.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION')
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('keeps hostile input and query failures values-free', async () => {
    const sentinel = 'SENTINEL_MUST_NOT_ESCAPE'
    const hostile = new Proxy(placeInput, {
      get() {
        throw new Error(sentinel)
      },
    })
    const query = vi.fn(async () => {
      throw new Error(sentinel)
    })

    const invalid = await errorOf(placeRecoveryArchiveLegalHold(query, hostile))
    expect(invalid.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_INVALID_INPUT')
    expect(invalid.message).not.toContain(sentinel)

    const rejected = await errorOf(placeRecoveryArchiveLegalHold(query, placeInput))
    expect(rejected.code).toBe('RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION')
    expect(rejected.message).not.toContain(sentinel)
  })
})
