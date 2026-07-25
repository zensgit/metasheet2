import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// org-transfer Phase 1 §12.1 — corp_id is IMMUTABLE once set.
//
// `updateDirectoryIntegration` is a generic integration-form save. Changing `corp_id` on an
// integration that already has it set is a tenant swap disguised as an edit: the next sync's
// absence sweep would treat every account/department still tagged with the OLD corp as "no
// longer seen" and mark them inactive — silently mass-deactivating the previous organization.
// A "block only if it already has synced records" rule leaves a first-sync TOCTOU window, so the
// rule is absolute: an ordinary PUT can never set, clear, or change corp_id — with NO record
// probe and NO production bypass. A legacy empty row must be deleted/recreated or repaired by
// the dedicated migration path; a generic update cannot safely retag existing or racing children.

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

import { DirectoryTenantChangeBlockedError, updateDirectoryIntegration } from '../../src/directory/directory-sync'

const ALLOW_ENV = 'DIRECTORY_ALLOW_ACTIVE_CORP_ID_CHANGE'
const originalAllowEnv = process.env[ALLOW_ENV]

function integrationRow(corpId: string | null) {
  return {
    id: 'dir-1',
    org_id: 'org-1',
    provider: 'dingtalk',
    name: 'Existing Integration',
    status: 'active',
    corp_id: corpId,
    config: {
      appKey: 'app-key-1',
      appSecret: '',
      rootDepartmentId: '1',
    },
    sync_enabled: false,
    schedule_cron: null,
    schedule_timezone: null,
    default_deprovision_policy: 'mark_inactive',
    last_sync_at: null,
    last_success_at: null,
    last_error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function baseInput(corpId: string) {
  return {
    name: 'Existing Integration',
    corpId,
    appKey: 'app-key-1',
    appSecret: 'super-secret',
  }
}

function updatedRow(corpId: string) {
  return {
    ...integrationRow(corpId),
    updated_at: '2026-01-02T00:00:00.000Z',
  }
}

describe('updateDirectoryIntegration — corp_id immutable-once-set guard (org-transfer Phase 1 §12.1)', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
    delete process.env[ALLOW_ENV]
  })

  afterEach(() => {
    if (originalAllowEnv === undefined) delete process.env[ALLOW_ENV]
    else process.env[ALLOW_ENV] = originalAllowEnv
  })

  it('blocks any change to an already-set corp_id, issues NO record probe, and never runs the UPDATE', async () => {
    // Only getIntegrationRow should be queried: the guard throws on the immutable-corp check before it
    // would probe accounts/departments (there is no probe) and before the UPDATE. This is the fix for
    // the first-sync TOCTOU window — the block does not depend on whether any rows have synced yet.
    pgMocks.query.mockResolvedValueOnce({ rows: [integrationRow('corpA')] })

    await expect(updateDirectoryIntegration('dir-1', baseInput('corpB') as never))
      .rejects.toBeInstanceOf(DirectoryTenantChangeBlockedError)

    expect(pgMocks.query).toHaveBeenCalledTimes(1) // getIntegrationRow only — no probe, no UPDATE
    expect(pgMocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE directory_integrations'),
      expect.anything(),
    )
    expect(pgMocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('directory_accounts'),
      expect.anything(),
    )
  })

  it('has NO production bypass: the change is still blocked even with DIRECTORY_ALLOW_ACTIVE_CORP_ID_CHANGE=true', async () => {
    process.env[ALLOW_ENV] = 'true'
    pgMocks.query.mockResolvedValueOnce({ rows: [integrationRow('corpA')] })

    await expect(updateDirectoryIntegration('dir-1', baseInput('corpB') as never))
      .rejects.toBeInstanceOf(DirectoryTenantChangeBlockedError)

    expect(pgMocks.query).toHaveBeenCalledTimes(1)
    expect(pgMocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE directory_integrations'),
      expect.anything(),
    )
  })

  it('does not block an ordinary edit that resends the same corp_id', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [integrationRow('corpA')] })
      .mockResolvedValueOnce({ rows: [updatedRow('corpA')] })

    const result = await updateDirectoryIntegration('dir-1', baseInput('corpA') as never)

    expect(result?.corpId).toBe('corpA')
    expect(pgMocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE directory_integrations'),
      expect.anything(),
    )
  })

  it('blocks an initial corp_id set on a legacy empty row without probing or updating', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [integrationRow(null)] })
      // Positive control for the guard mutation: if the blocker is removed, the ordinary update
      // completes instead of failing because the mock has no second response.
      .mockResolvedValueOnce({ rows: [updatedRow('corpB')] })

    await expect(updateDirectoryIntegration('dir-1', baseInput('corpB') as never))
      .rejects.toBeInstanceOf(DirectoryTenantChangeBlockedError)

    expect(pgMocks.query).toHaveBeenCalledTimes(1)
    expect(pgMocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE directory_integrations'),
      expect.anything(),
    )
  })
})
