import { beforeEach, describe, expect, it, vi } from 'vitest'

// A Postgres unique_violation (23505) on the directory_integrations INSERT / UPDATE is the admin colliding with an
// existing row — a duplicate name for the provider, or a second active local integration — not a system fault.
// Before the typed errors, the route answered it 400 echoing the driver text; with typed errors alone it would have
// become a generic 500. It is a DirectoryConflictError (409 at the route) with a fixed sentence, and the driver text
// (constraint and table names) stays out of the response. Any other database error is rethrown unchanged.

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

import { DirectoryConflictError, createDirectoryIntegration, updateDirectoryIntegration } from '../../src/directory/directory-sync'

const DRIVER_TEXT = 'duplicate key value violates unique constraint'
const NAME_SENTENCE = 'A directory integration with this name already exists for this provider'
const LOCAL_SENTENCE = 'This organization already has an active local directory integration'

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error(`${DRIVER_TEXT} "${constraint}"`), { code: '23505', constraint, table: 'directory_integrations' })
}

function integrationRow() {
  return {
    id: 'dir-1',
    org_id: 'org-1',
    provider: 'dingtalk',
    name: 'Existing Integration',
    status: 'active',
    corp_id: 'corpA',
    config: { appKey: 'app-key-1', appSecret: '', rootDepartmentId: '1' },
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

const input = { name: 'Existing Integration', corpId: 'corpA', appKey: 'app-key-1', appSecret: 'super-secret' }

const failureOf = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error)

describe('directory_integrations unique_violation becomes DirectoryConflictError with a fixed sentence', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
  })

  it('create: a duplicate (org, provider, name) answers the name sentence, never the driver text', async () => {
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO directory_integrations')) throw uniqueViolation('idx_directory_integrations_org_provider_name')
      return { rows: [] }
    })
    const failure = await failureOf(createDirectoryIntegration(input as never))
    expect(failure).toBeInstanceOf(DirectoryConflictError)
    expect((failure as Error).message).toBe(NAME_SENTENCE)
    expect((failure as Error).message).not.toContain(DRIVER_TEXT)
    expect((failure as Error).message).not.toContain('directory_integrations')
  })

  it('create: a second active local integration answers the local sentence', async () => {
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO directory_integrations')) throw uniqueViolation('one_active_local_integration_per_org')
      return { rows: [] }
    })
    const failure = await failureOf(createDirectoryIntegration(input as never))
    expect(failure).toBeInstanceOf(DirectoryConflictError)
    expect((failure as Error).message).toBe(LOCAL_SENTENCE)
  })

  it('update: a rename onto an existing name answers the name sentence after the UPDATE was attempted', async () => {
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE directory_integrations')) throw uniqueViolation('idx_directory_integrations_org_provider_name')
      return { rows: [integrationRow()] } // getIntegrationRow
    })
    const failure = await failureOf(updateDirectoryIntegration('dir-1', input as never))
    expect(failure).toBeInstanceOf(DirectoryConflictError)
    expect((failure as Error).message).toBe(NAME_SENTENCE)
    expect(pgMocks.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE directory_integrations'), expect.anything())
  })

  it('any other database error is rethrown as it was, so the route still answers a fixed 500', async () => {
    const notNull = Object.assign(new Error('null value in column "name" violates not-null constraint'), { code: '23502' })
    pgMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO directory_integrations')) throw notNull
      return { rows: [] }
    })
    const failure = await failureOf(createDirectoryIntegration(input as never))
    expect(failure).toBe(notNull)
    expect(failure).not.toBeInstanceOf(DirectoryConflictError)
  })
})
