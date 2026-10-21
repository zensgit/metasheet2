import { describe, expect, it, vi } from 'vitest'

import {
  listRecoveryArchiveRestoreJobs,
  RecoveryArchiveRestoreJobError,
  type RecoveryArchiveRestoreJobQuery,
  type RecoveryArchiveRestoreJobTransaction,
} from '../../src/multitable/recovery-archive-restore-jobs'

const JOB_ID = '11111111-1111-4111-8111-111111111111'

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    workspace_id: 'workspace-a',
    base_id: 'base-a',
    sheet_id: 'sheet-a',
    actor_id: 'actor-a',
    recovery_mode: 'revert',
    scope_kind: 'whole_sheet',
    state: 'applying',
    total_count: '6001',
    completed_count: '5000',
    block_fence: '7',
    worker_fence: '9',
    resume_deadline: '2026-08-30T00:00:00.000Z',
    terminal_operation_id: null,
    terminal_at: null,
    row_version: '4',
    created_at: '2026-08-29T00:00:00.000Z',
    ...overrides,
  }
}

function transaction(query: RecoveryArchiveRestoreJobQuery): RecoveryArchiveRestoreJobTransaction {
  return async (work) => work(query)
}

const input = {
  workspaceId: 'workspace-a',
  baseId: 'base-a',
  sheetId: 'sheet-a',
  actorId: 'actor-a',
  recheckAuthority: async () => true,
  env: { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true' },
}

describe('recovery archive restore job listing', () => {
  it('rechecks authority then binds every owner scope key in newest-first keyset SQL', async () => {
    const query = vi.fn<RecoveryArchiveRestoreJobQuery>(async () => ({
      rows: [jobRow(), jobRow({ id: '22222222-2222-4222-8222-222222222222', created_at: '2026-08-28T00:00:00.000Z' })],
    }))
    const recheckAuthority = vi.fn(async () => true)

    const page = await listRecoveryArchiveRestoreJobs(transaction(query), {
      ...input,
      recheckAuthority,
      limit: 1,
    })

    expect(recheckAuthority).toHaveBeenCalledWith(query)
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain('workspace_id = $1')
    expect(sql).toContain('base_id = $2')
    expect(sql).toContain('sheet_id = $3')
    expect(sql).toContain('actor_id = $4')
    expect(sql).toContain('ORDER BY created_at DESC, id DESC')
    expect(params).toEqual(['workspace-a', 'base-a', 'sheet-a', 'actor-a', 2])
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({ id: JOB_ID, state: 'applying' })
    expect(page.nextCursor).toEqual(expect.any(String))
  })

  it('rejects a second actor or sheet before querying and never accepts malformed cursor or limit input', async () => {
    const query = vi.fn<RecoveryArchiveRestoreJobQuery>(async () => ({ rows: [] }))
    const denied = listRecoveryArchiveRestoreJobs(transaction(query), {
      ...input,
      actorId: 'actor-b',
      recheckAuthority: async () => false,
    })
    await expect(denied).rejects.toMatchObject({
      code: 'RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED',
    } satisfies Partial<RecoveryArchiveRestoreJobError>)
    await expect(listRecoveryArchiveRestoreJobs(transaction(query), {
      ...input,
      sheetId: 'sheet-b',
      recheckAuthority: async () => false,
    })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED' })
    await expect(listRecoveryArchiveRestoreJobs(transaction(query), {
      ...input,
      cursor: 'stale-cursor',
    })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT' })
    await expect(listRecoveryArchiveRestoreJobs(transaction(query), {
      ...input,
      cursor: Buffer.from(JSON.stringify(['2026-08-29T00:00:00.000Z', 'not-a-uuid'])).toString('base64url'),
    })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT' })
    await expect(listRecoveryArchiveRestoreJobs(transaction(query), {
      ...input,
      limit: 51,
    })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT' })
    expect(query).not.toHaveBeenCalled()
  })

  it('binds a valid cursor as the next keyset page and refuses malformed persisted rows', async () => {
    const query = vi.fn<RecoveryArchiveRestoreJobQuery>(async () => ({ rows: [] }))
    const cursor = Buffer.from(JSON.stringify([
      '2026-08-28T00:00:00.000Z',
      '22222222-2222-4222-8222-222222222222',
    ])).toString('base64url')

    await expect(listRecoveryArchiveRestoreJobs(transaction(query), {
      ...input,
      cursor,
      limit: 3,
    })).resolves.toEqual({ entries: [], nextCursor: null })
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain('AND (created_at, id) < ($5::timestamptz, $6::uuid)')
    expect(sql).toContain('LIMIT $7::integer')
    expect(params).toEqual([
      'workspace-a', 'base-a', 'sheet-a', 'actor-a',
      '2026-08-28T00:00:00.000Z', '22222222-2222-4222-8222-222222222222', 4,
    ])

    const corruptQuery = vi.fn<RecoveryArchiveRestoreJobQuery>(async () => ({
      rows: [jobRow({ state: 'corrupt-state' })],
    }))
    await expect(listRecoveryArchiveRestoreJobs(transaction(corruptQuery), input)).rejects.toMatchObject({
      code: 'RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID',
    })
  })

  it('does not touch storage or the database when the archive flag is exact-off', async () => {
    const query = vi.fn<RecoveryArchiveRestoreJobQuery>(async () => ({ rows: [jobRow()] }))

    await expect(listRecoveryArchiveRestoreJobs(transaction(query), {
      ...input,
      env: { MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'TRUE' },
    })).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_DISABLED' })
    expect(query).not.toHaveBeenCalled()
  })
})
