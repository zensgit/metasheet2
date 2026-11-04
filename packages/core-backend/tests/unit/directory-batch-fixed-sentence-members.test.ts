/**
 * R-41 follow-up — every member of DIRECTORY_FAILURE_FIXED_SENTENCES (directory/directory-sync.ts) is proven on
 * the REAL batch services.
 *
 * The three batch routes answer a partially successful batch at 200 with `failed[].error`, which is
 * directoryFailureText(error, <fixed sentence>): a member of DIRECTORY_FAILURE_FIXED_SENTENCES shows its own
 * developer-authored sentence, anything else the batch's fixed sentence. The route tests mock the service, so
 * before this file nothing turned red when LoginAliasClaimError, PasswordPolicyError, LoginNameRuleError or
 * RecoveryConflictError was dropped from that list.
 *
 * Here batchBindDirectoryAccounts / batchAdmitDirectoryAccountUsers / batchUnbindDirectoryAccounts run for real
 * with pg mocked (the directory-sync-bind-account harness shape): the first account commits, the second throws
 * one instance of each member from its first database read, and `failed[].error` must be that instance's own
 * message — or the fixed sentence for an untyped error, and for a typed class that is NOT listed. Two members
 * are also driven from their production producer: RecoveryConflictError from a lease-marker 40001
 * (translateRecoveryConflict), LoginAliasClaimError from a driver failure inside the alias claim of an
 * admission.
 *
 * Completeness: the member list is read from directory-sync.ts SOURCE (TypeScript AST), and must equal the
 * classes MEMBER_FACTORIES builds — a class added to the list without a case here, or a case for a class no
 * longer listed, is red.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/security/auth-runtime-config', () => ({
  getBcryptSaltRounds: vi.fn(() => 4),
}))

vi.mock('../../src/auth/invite-ledger', () => ({
  recordInvite: vi.fn(async () => null),
}))

vi.mock('../../src/auth/invite-tokens', () => ({
  issueInviteToken: vi.fn(() => 'invite-token-fixed'),
}))

import {
  DirectoryConflictError,
  DirectoryNotFoundError,
  DirectorySyncLeaseLostError,
  DirectoryTenantChangeBlockedError,
  DirectoryValidationError,
  batchAdmitDirectoryAccountUsers,
  batchBindDirectoryAccounts,
  batchUnbindDirectoryAccounts,
  type DirectoryAccountBatchOutcome,
} from '../../src/directory/directory-sync'
import { DirectoryUserPaginationError } from '../../src/directory/directory-user-pagination'
import { LoginAliasClaimError } from '../../src/auth/login-alias-service'
import { LoginNameRuleError } from '../../src/auth/login-name-rule'
import { PasswordPolicyError } from '../../src/auth/password-policy-error'
import { RECOVERY_CONFLICT_HTTP_MESSAGE, RecoveryConflictError } from '../../src/db/recovery-conflict'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'
import { DingTalkCorpNotAllowedError } from '../../src/integrations/dingtalk/runtime-policy'

const MARKER = 'MARKER_r41b_batch'
const OK_ID = 'account-1'
const FAIL_ID = 'account-fail'

// ── the list, read from source ──────────────────────────────────────────────────────────────────────────────

const DIRECTORY_SYNC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/directory/directory-sync.ts')
function listedInSource(): string[] {
  const sf = ts.createSourceFile(DIRECTORY_SYNC, fs.readFileSync(DIRECTORY_SYNC, 'utf8'), ts.ScriptTarget.ES2022, true)
  let found: string[] | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'DIRECTORY_FAILURE_FIXED_SENTENCES') {
      const init = node.initializer
      if (!init || !ts.isArrayLiteralExpression(init)) throw new Error('DIRECTORY_FAILURE_FIXED_SENTENCES is not an array literal')
      found = init.elements.map((e) => {
        if (!ts.isIdentifier(e)) throw new Error(`unexpected list element ${e.getText()}`)
        return e.text
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!found) throw new Error('DIRECTORY_FAILURE_FIXED_SENTENCES not found in directory-sync.ts')
  return found
}

/**
 * One instance per member, built the way production builds it. Sentences are fixed or carry only our own ids —
 * the point is that the member's OWN message comes back, and that a non-member's never does.
 */
const MEMBER_FACTORIES: Readonly<Record<string, () => Error>> = {
  DirectoryValidationError: () => new DirectoryValidationError('Directory account is missing DingTalk openId/unionId and cannot be pre-bound for DingTalk login'),
  DirectoryNotFoundError: () => new DirectoryNotFoundError('Local user not found'),
  DirectoryConflictError: () => new DirectoryConflictError('Directory account binding changed; retry the operation'),
  DirectoryTenantChangeBlockedError: () => new DirectoryTenantChangeBlockedError('corp_id is immutable on directory integration dir-1'),
  DirectorySyncLeaseLostError: () => new DirectorySyncLeaseLostError('run-r41b'),
  DirectoryUserPaginationError: () => new DirectoryUserPaginationError(),
  RecoveryConflictError: () => new RecoveryConflictError(Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })),
  LoginNameRuleError: () => new LoginNameRuleError(),
  PasswordPolicyError: () => new PasswordPolicyError(['Password must contain at least one number']),
  LoginAliasClaimError: () => new LoginAliasClaimError('ALIAS_CONFLICT', 'email'),
}

// ── fixtures (the directory-sync-bind-account shapes) ───────────────────────────────────────────────────────

const accountRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  integration_id: 'dir-1',
  provider: 'dingtalk',
  corp_id: 'dingcorp',
  external_user_id: '0447654442691174',
  union_id: 'union-1',
  open_id: 'open-1',
  external_key: 'union-1',
  name: '林岚',
  email: null,
  mobile: '13900001234',
  ...overrides,
})

const summaryRow = (id: string, linked: boolean) => ({
  integration_id: 'dir-1',
  provider: 'dingtalk',
  corp_id: 'dingcorp',
  directory_account_id: id,
  external_user_id: '0447654442691174',
  union_id: 'union-1',
  open_id: 'open-1',
  external_key: 'union-1',
  account_name: '林岚',
  account_email: null,
  account_mobile: '13900001234',
  account_is_active: true,
  account_updated_at: '2026-07-08T00:00:00.000Z',
  link_status: linked ? 'linked' : 'unmatched',
  match_strategy: linked ? 'manual_admin' : 'manual_unbound',
  reviewed_by: linked ? 'admin-1' : null,
  review_note: null,
  link_updated_at: '2026-07-08T00:00:00.000Z',
  local_user_id: linked ? 'user-1' : null,
  local_user_email: linked ? 'alpha@example.com' : null,
  local_user_name: linked ? 'Alpha' : null,
  department_paths: ['DingTalk CN'],
})

type ClientQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

/**
 * The transaction harness. `failInside` lets one statement throw for the failing account (by its id or by an
 * alias value it claims); everything else answers like directory-sync-bind-account's installTransactionMock.
 */
function installTransaction(failInside?: (sql: string, params: unknown[]) => unknown): void {
  const aliasOwners = new Map<string, string>()
  const client: { query: ClientQuery } = {
    query: async (sql, params = []) => {
      const text = String(sql)
      const failure = failInside?.(text, params)
      if (failure !== undefined) throw failure
      if (/SELECT org_id\s+FROM directory_integrations/.test(text)) return { rows: [{ org_id: 'default' }] }
      if (/INSERT INTO user_login_aliases/i.test(text)) {
        aliasOwners.set(String(params[2] ?? ''), String(params[0] ?? ''))
        return { rows: [] }
      }
      if (/SELECT user_id FROM user_login_aliases/i.test(text)) {
        const owner = aliasOwners.get(String(params[0] ?? ''))
        return { rows: owner ? [{ user_id: owner }] : [] }
      }
      if (/SELECT l\.local_user_id,[\s\S]*FROM directory_account_links l/.test(text)) {
        return { rows: [{ local_user_id: 'user-1', local_user_email: 'alpha@example.com', local_user_name: 'Alpha' }] }
      }
      if (/FROM directory_accounts account\s+JOIN directory_integrations integration/.test(text)) {
        return { rows: [{ ...accountRow(String(params[0] ?? OK_ID)), is_active: true, integration_provider: 'dingtalk', integration_corp_id: 'dingcorp' }] }
      }
      if (/FROM users[\s\S]*FOR UPDATE/.test(text)) {
        return {
          rows: [{
            id: String(params[0] ?? 'user-1'),
            name: 'Alpha',
            email: 'alpha@example.com',
            username: null,
            mobile: null,
            activation_status: 'activated',
            is_active: true,
            access_generation: 0,
          }],
        }
      }
      if (/UPDATE users[\s\S]*access_generation/.test(text)) return { rows: [{ access_generation: 1 }] }
      return { rows: [] }
    },
  }
  pgMocks.transaction.mockImplementation(async (handler: (c: { query: ClientQuery }) => Promise<unknown>) => handler(client))
}

/** Outer pg reads: the queued answers serve the committing account; the failing account's first read throws. */
function installOuterReads(queued: Array<Array<Record<string, unknown>>>, failure: unknown): void {
  for (const rows of queued) pgMocks.query.mockResolvedValueOnce({ rows })
  pgMocks.query.mockImplementation(async (_sql: unknown, params: unknown[] = []) => {
    if (params.includes(FAIL_ID)) throw failure
    return { rows: [] }
  })
}

// ── the three batches, each: account-1 commits, account-fail throws `failure` ───────────────────────────────

interface BatchCase {
  name: string
  fixedSentence: string
  run: (failure: unknown) => Promise<DirectoryAccountBatchOutcome>
}

const BATCHES: readonly BatchCase[] = [
  {
    name: 'batchBindDirectoryAccounts',
    fixedSentence: 'Failed to bind directory account',
    run: (failure) => {
      installTransaction()
      installOuterReads([
        [accountRow(OK_ID)],
        [{ local_user_id: null, local_user_email: null, local_user_name: null }],
        [{ id: 'user-1', email: 'alpha@example.com', name: 'Alpha', role: 'user', is_active: true }],
        [summaryRow(OK_ID, true)],
      ], failure)
      return batchBindDirectoryAccounts([
        { accountId: OK_ID, localUserRef: 'alpha@example.com', enableDingTalkGrant: true },
        { accountId: FAIL_ID, localUserRef: 'beta@example.com', enableDingTalkGrant: true },
      ], { adminUserId: 'admin-1' })
    },
  },
  {
    name: 'batchAdmitDirectoryAccountUsers',
    fixedSentence: 'Failed to create and bind local user for directory account',
    run: (failure) => {
      installTransaction()
      installOuterReads([
        [accountRow(OK_ID, { open_id: null })], // the batch preloads the account to derive name / username
        [], // eligibility: no existing link
        [], // eligibility: no active user with this mobile
        [accountRow(OK_ID, { open_id: null })], // admitDirectoryAccountUser reloads the account …
        [{ local_user_id: null, local_user_email: null, local_user_username: null, local_user_name: null }], // … and its previous link
        [summaryRow(OK_ID, true)],
      ], failure)
      return batchAdmitDirectoryAccountUsers([OK_ID, FAIL_ID], { adminUserId: 'admin-1' }) as Promise<DirectoryAccountBatchOutcome>
    },
  },
  {
    name: 'batchUnbindDirectoryAccounts',
    fixedSentence: 'Failed to unbind directory account',
    run: (failure) => {
      // Unbind's first read of an account is inside its transaction.
      installTransaction((_sql, params) => (params.includes(FAIL_ID) ? failure : undefined))
      installOuterReads([[summaryRow(OK_ID, false)]], failure)
      return batchUnbindDirectoryAccounts([OK_ID, FAIL_ID], { adminUserId: 'admin-1' })
    },
  },
]

function expectPartial(outcome: DirectoryAccountBatchOutcome, failure: unknown, text: string): void {
  // The first account committed — this is a PARTIALLY successful batch, answered at 200 with `failed[]`.
  expect(outcome.succeeded).toHaveLength(1)
  expect(outcome.succeeded[0].account.id).toBe(OK_ID)
  expect(outcome.failed).toEqual([{ accountId: FAIL_ID, error: text }])
  expect(outcome.failedErrors).toHaveLength(1)
  expect(outcome.failedErrors[0]).toBe(failure)
}

beforeEach(() => {
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
})

describe('DIRECTORY_FAILURE_FIXED_SENTENCES — completeness against source', () => {
  it('every listed class has a case here, and every case is still listed', () => {
    expect(Object.keys(MEMBER_FACTORIES).sort()).toEqual(listedInSource().sort())
  })

  it('every factory builds an instance of the class it is named for', () => {
    for (const [name, make] of Object.entries(MEMBER_FACTORIES)) expect(make().constructor.name, name).toBe(name)
  })
})

describe.each(BATCHES)('$name: one failing account of a partially successful batch', ({ run, fixedSentence }) => {
  it.each(Object.keys(MEMBER_FACTORIES))('%s shows its own sentence in failed[].error', async (name) => {
    const failure = MEMBER_FACTORIES[name]()
    expect(failure.message).not.toBe(fixedSentence)
    const outcome = await run(failure)
    expectPartial(outcome, failure, failure.message)
  })

  it('an untyped error shows the fixed sentence, never its own text', async () => {
    const failure = Object.assign(new Error(`${MARKER} relation "directory_accounts" does not exist`), { code: '42P01', detail: MARKER })
    const outcome = await run(failure)
    expectPartial(outcome, failure, fixedSentence)
    expect(JSON.stringify(outcome.failed)).not.toContain(MARKER)
  })

  it('a typed error that is NOT listed shows the fixed sentence (DingTalkCorpNotAllowedError: unreachable here, not listed)', async () => {
    const failure = new DingTalkCorpNotAllowedError(`Directory integration corpId ${MARKER} is not allowed by DINGTALK_ALLOWED_CORP_IDS`, MARKER)
    const outcome = await run(failure)
    expectPartial(outcome, failure, fixedSentence)
    expect(JSON.stringify(outcome.failed)).not.toContain(MARKER)
  })
})

describe('members driven from their production producer', () => {
  it('RecoveryConflictError: a lease-marker 40001 inside the unbind transaction becomes the retryable sentence', async () => {
    const driverError = Object.assign(new Error(RECOVERY_AUTHORITY_BUSY_MARKER), { code: '40001' })
    installTransaction((_sql, params) => (params.includes(FAIL_ID) ? driverError : undefined))
    installOuterReads([[summaryRow(OK_ID, false)]], driverError)

    const outcome = await batchUnbindDirectoryAccounts([OK_ID, FAIL_ID], { adminUserId: 'admin-1' })

    expect(outcome.succeeded).toHaveLength(1)
    expect(outcome.failed).toEqual([{ accountId: FAIL_ID, error: RECOVERY_CONFLICT_HTTP_MESSAGE }])
    expect(outcome.failedErrors[0]).toBeInstanceOf(RecoveryConflictError)
  })

  it('LoginAliasClaimError: a driver failure while claiming the admitted user\'s alias shows the claim\'s fixed sentence, not the driver text', async () => {
    const FAIL_MOBILE = '13900009999'
    const driverError = Object.assign(new Error(`${MARKER} duplicate key value violates unique constraint "user_login_aliases_pkey"`), { code: '23505' })
    // The claim stores the NORMALIZED alias (`+86…` for a mainland mobile) as its third parameter.
    installTransaction((sql, params) => (/INSERT INTO user_login_aliases/i.test(sql) && String(params[2]).endsWith(FAIL_MOBILE) ? driverError : undefined))
    const failingAccount = accountRow(FAIL_ID, { open_id: null, external_user_id: '0447654442699999', union_id: 'union-2', external_key: 'union-2', mobile: FAIL_MOBILE })
    for (const rows of [
      [accountRow(OK_ID, { open_id: null })], [], [], [accountRow(OK_ID, { open_id: null })],
      [{ local_user_id: null, local_user_email: null, local_user_username: null, local_user_name: null }],
      [summaryRow(OK_ID, true)],
      // the failing account gets through the same reads; its admission transaction then fails in the claim
      [failingAccount], [], [], [failingAccount],
      [{ local_user_id: null, local_user_email: null, local_user_username: null, local_user_name: null }],
    ]) pgMocks.query.mockResolvedValueOnce({ rows })
    pgMocks.query.mockResolvedValue({ rows: [] })

    const outcome = await batchAdmitDirectoryAccountUsers([OK_ID, FAIL_ID], { adminUserId: 'admin-1' })

    expect(outcome.succeeded).toHaveLength(1)
    expect(outcome.failed).toEqual([{ accountId: FAIL_ID, error: 'Failed to claim login alias' }])
    expect(outcome.failedErrors[0]).toBeInstanceOf(LoginAliasClaimError)
    expect(JSON.stringify(outcome.failed)).not.toContain(MARKER)
  })
})
