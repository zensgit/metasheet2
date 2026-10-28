import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * W1-6 (owner ruling 2026-10-10, "锚点进事务"): every local-directory writer runs inside
 * `withLocalAnchorTransaction`, whose FIRST statement is `SET TRANSACTION ISOLATION LEVEL READ
 * COMMITTED` (Postgres rejects the SET after any other statement in the transaction).
 *
 * Why a unit test: on a stock database the default isolation is already READ COMMITTED, so the
 * real-DB suites (local-directory-anchor-in-transaction / cycle-detection) stay green if the SET is
 * deleted. The SET only matters under a changed `default_transaction_isolation`, and the real-DB
 * lane cannot change that default on its shared CI database without affecting every other file.
 * The cycle-detection suite already proves the isolation MECHANISM on a raw connection; this file
 * pins that every writer actually issues the SET first, on the transaction's own client, before the
 * anchor get-or-create. Deleting the SET (or moving it after the anchor work) turns all nine cases red.
 *
 * The fake transaction client records each statement and fails the second one, so each writer
 * stops right after its first two statements; nothing else about the writer is exercised here.
 */

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

import {
  addLocalMembership,
  archiveLocalAccount,
  archiveLocalDepartment,
  createLocalAccount,
  createLocalDepartment,
  switchLocalPrimaryDepartment,
  updateLocalAccount,
  updateLocalDepartment,
} from '../../src/directory/local-directory-org'

const SET_READ_COMMITTED = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const ORG = 'org-isolation-unit'
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const STOP = new Error('unit stop after the second statement')

let statements: string[] = []

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

beforeEach(() => {
  statements = []
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  pgMocks.query.mockRejectedValue(new Error('pool query must not be used by a local-directory writer'))
  pgMocks.transaction.mockImplementation(async (handler: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
    const client = {
      query: async (sql: string) => {
        statements.push(normalizeSql(sql))
        if (statements.length >= 2) throw STOP
        return { rows: [], rowCount: 0 }
      },
    }
    return handler(client)
  })
})

const writers: Array<[string, () => Promise<unknown>]> = [
  ['createLocalDepartment', () => createLocalDepartment({ orgId: ORG, name: 'Ops' })],
  ['updateLocalDepartment (rename)', () => updateLocalDepartment(ORG, ID_A, { name: 'Renamed' })],
  ['updateLocalDepartment (reparent)', () => updateLocalDepartment(ORG, ID_A, { parentDepartmentId: ID_B })],
  ['archiveLocalDepartment', () => archiveLocalDepartment(ORG, ID_A)],
  ['createLocalAccount', () => createLocalAccount({ orgId: ORG, localUserId: 'user-isolation-unit' })],
  ['updateLocalAccount', () => updateLocalAccount(ORG, ID_A, { name: 'Renamed' })],
  ['archiveLocalAccount', () => archiveLocalAccount(ORG, ID_A)],
  ['addLocalMembership', () => addLocalMembership({ orgId: ORG, accountId: ID_A, departmentId: ID_B })],
  ['switchLocalPrimaryDepartment', () => switchLocalPrimaryDepartment(ORG, ID_A, ID_B)],
]

describe('W1-6 — every local-directory writer pins READ COMMITTED as its transaction\'s first statement', () => {
  for (const [name, call] of writers) {
    it(`${name}: SET TRANSACTION ISOLATION LEVEL READ COMMITTED comes first, then the anchor work, on the transaction client`, async () => {
      await expect(call()).rejects.toBe(STOP)
      expect(pgMocks.transaction).toHaveBeenCalledTimes(1)
      expect(pgMocks.query).not.toHaveBeenCalled()
      expect(statements).toHaveLength(2)
      expect(statements[0]).toBe(SET_READ_COMMITTED)
      // The second statement is the anchor get-or-create's first read, not a writer-specific query.
      expect(statements[1]).toMatch(/FROM directory_integrations/i)
      expect(statements[1]).toMatch(/provider = 'local'/i)
    })
  }
})
