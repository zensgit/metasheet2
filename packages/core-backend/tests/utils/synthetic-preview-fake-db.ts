/**
 * In-memory stand-in for the RC transaction the synthetic integration preview admits on. It answers
 * exactly the admission statements (automation-synthetic-preview.ts L1-L5 and
 * automation-live-authority.ts) from a mutable synthetic state, and records every summary insert.
 * Unit tests only; the real lock protocol is proven against PostgreSQL in
 * tests/integration/automation-synthetic-preview-realdb.test.ts.
 */
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

export type FakePreviewState = {
  actorId: string
  tenantId: string
  sheetId: string
  ruleId: string
  ruleSheetId: string
  ruleOwner: string | null
  sheetLive: boolean
  roles: string[]
  rolePermissions: Array<{ role_id: string; permission_code: string }>
  directPermissions: string[]
  legacyPermissions: string[]
  userActive: boolean
  membershipTenant: string | null
  integrationAdmission: boolean
  sheetGrants: Array<{ perm_code: string; subject_type: string; subject_id: string }>
  failOn?: RegExp
}

export function defaultFakePreviewState(overrides: Partial<FakePreviewState> = {}): FakePreviewState {
  return {
    actorId: 'synthetic-actor',
    tenantId: 'synthetic-tenant',
    sheetId: 'synthetic-sheet',
    ruleId: 'synthetic-rule',
    ruleSheetId: 'synthetic-sheet',
    ruleOwner: 'synthetic-actor',
    sheetLive: true,
    roles: ['admin'],
    rolePermissions: [],
    directPermissions: [],
    legacyPermissions: [],
    userActive: true,
    membershipTenant: 'synthetic-tenant',
    integrationAdmission: false,
    sheetGrants: [],
    ...overrides,
  }
}

export type FakeSummaryInsert = { sql: string; params: unknown[] }

export function createFakePreviewDatabase(state: FakePreviewState) {
  let xid = 100
  const statements: string[] = []
  const inserts: FakeSummaryInsert[] = []
  let transactions = 0
  async function answer(sql: string, params: unknown[] = [], currentXid: number): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    statements.push(sql)
    if (state.failOn && state.failOn.test(sql)) {
      const error = new Error('synthetic database failure') as Error & { code?: string }
      error.code = '42P01'
      throw error
    }
    const rows = (list: Array<Record<string, unknown>>) => ({ rows: list, rowCount: list.length })
    if (/current_setting\('transaction_isolation'\)/.test(sql)) return rows([{ isolation: 'read committed' }])
    if (/pg_current_xact_id/.test(sql)) return rows([{ xid: String(currentXid) }])
    if (/^\s*(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return rows([])
    if (/FROM automation_rules/.test(sql)) {
      return rows(params[0] === state.ruleId ? [{ id: state.ruleId, sheet_id: state.ruleSheetId, created_by: state.ruleOwner }] : [])
    }
    if (/FROM meta_sheets/.test(sql)) return rows(params[0] === state.sheetId && state.sheetLive ? [{ id: state.sheetId }] : [])
    if (/FROM user_roles/.test(sql)) return rows(params[0] === state.actorId ? state.roles.map((role_id) => ({ role_id })) : [])
    if (/FROM role_permissions/.test(sql)) {
      const ids = new Set(params[0] as string[])
      return rows(state.rolePermissions.filter((row) => ids.has(row.role_id)))
    }
    if (/FROM user_permissions/.test(sql)) {
      return rows(params[0] === state.actorId ? state.directPermissions.map((permission_code) => ({ permission_code })) : [])
    }
    if (/FROM users/.test(sql)) {
      return rows(params[0] === state.actorId ? [{
        id: state.actorId,
        role: state.roles.includes('admin') ? 'admin' : 'user',
        is_active: state.userActive,
        activation_status: 'activated',
        permissions: state.legacyPermissions,
      }] : [])
    }
    if (/FROM user_orgs/.test(sql)) {
      return rows(state.membershipTenant && params[0] === state.actorId && params[1] === state.membershipTenant
        ? [{ user_id: state.actorId, org_id: state.membershipTenant, is_active: true }] : [])
    }
    if (/FROM user_namespace_admissions/.test(sql)) {
      return rows(state.integrationAdmission && params[0] === state.actorId ? [{ namespace: 'integration', enabled: true }] : [])
    }
    if (/FROM platform_member_group_members/.test(sql)) return rows([])
    if (/FROM spreadsheet_permissions/.test(sql)) {
      return rows(state.sheetGrants.filter((grant) => params[0] === state.sheetId
        && ((grant.subject_type === 'user' && grant.subject_id === params[1])
          || (grant.subject_type === 'role' && (params[2] as string[]).includes(grant.subject_id)))))
    }
    if (/INSERT INTO multitable_automation_executions/.test(sql)) {
      inserts.push({ sql, params })
      return rows([])
    }
    throw new Error(`fake preview database: unexpected statement ${sql.slice(0, 80)}`)
  }
  const database = {
    async transaction<T>(work: (trx: Queryable) => Promise<T>): Promise<T> {
      transactions += 1
      const currentXid = ++xid
      const trx: Queryable = { query: (sql: string, params?: unknown[]) => answer(sql, params, currentXid) }
      return work(trx)
    },
  }
  return {
    database,
    statements,
    inserts,
    transactions: () => transactions,
  }
}

/** A promise you resolve from outside (a barrier). */
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
