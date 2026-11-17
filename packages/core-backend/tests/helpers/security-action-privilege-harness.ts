/**
 * Query-executor stand-in for the privilege classification unit tests. It answers the isolation probe,
 * the two transaction probes and the data statement from a fixture, records every statement, and can
 * fail a chosen statement with a SQLSTATE-shaped error.
 *
 * The stand-in is honest about the data statement: a source column is only answered when the
 * statement names that source table. Dropping a table from the statement therefore empties the
 * column, so the classification cases that depend on that source go red along with the static checks.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { readPrivilegeInputs } from '../../src/auth/security-action-privilege'
import type { PrivilegeInputs } from '../../src/auth/security-action-privilege'

export const SUBJECT = 'synthetic_subject'

/**
 * A key-existence predicate over the legacy permission column, taken verbatim (whitespace collapsed)
 * from the module below. The stored-object case runs it against a real row and the pin below keeps
 * the text bound to that module, so the case cannot drift away from the predicate it reasons about.
 */
export const LEGACY_KEY_EXISTENCE_PREDICATE_MODULE = 'src/attendance/w4c3a-import-rollback-boundary.ts'
export const LEGACY_KEY_EXISTENCE_PREDICATE =
  "COALESCE(to_jsonb(u)->'permissions', '[]'::jsonb) ?| ARRAY[ 'attendance:admin', 'attendance:*', '*:*' ]"

/** Whether the module still contains the predicate text, compared with all whitespace runs collapsed. */
export function legacyKeyExistencePredicateIsPinned(): boolean {
  const source = readFileSync(path.resolve(__dirname, '..', '..', LEGACY_KEY_EXISTENCE_PREDICATE_MODULE), 'utf8')
  return source.replace(/\s+/g, ' ').includes(LEGACY_KEY_EXISTENCE_PREDICATE)
}

export type PrivilegeRow = {
  id: unknown
  is_admin: unknown
  role: unknown
  legacy_permissions: unknown
  role_ids: unknown
  direct_codes: unknown
  role_permission_pairs: unknown
  admissions: unknown
  department_scopes: unknown
  member_group_scopes: unknown
}

export type PrivilegeFixture = {
  isolation: string
  xids: string[]
  rows: PrivilegeRow[]
}

export type HarnessOptions = {
  /** Statement fragment whose statement fails. */
  failAt?: string
  /** SQLSTATE attached to the synthetic failure; omitted when `null`. */
  failCode?: string | null
}

export function privilegeRow(overrides: Partial<PrivilegeRow> = {}): PrivilegeRow {
  return {
    id: SUBJECT,
    is_admin: false,
    role: 'user',
    legacy_permissions: [],
    role_ids: [],
    direct_codes: [],
    role_permission_pairs: [],
    admissions: [],
    department_scopes: [],
    member_group_scopes: [],
    ...overrides,
  }
}

export function privilegeFixture(overrides: Partial<PrivilegeFixture> = {}): PrivilegeFixture {
  return {
    isolation: 'read committed',
    xids: ['100', '100'],
    rows: [privilegeRow()],
    ...overrides,
  }
}

/**
 * The department-scope aggregate must project `include_children` as the third tuple element.
 * Naming the table is not enough: a fixture triple is returned only when this projection is present.
 * Otherwise the boolean is dropped, so a mocked triple cannot hide an omitted column.
 */
export const DEPARTMENT_SCOPE_PROJECTION = /jsonb_build_array\(\s*s\.namespace\s*,\s*s\.directory_department_id::text\s*,\s*s\.include_children\s*\)/

function departmentScopesForStatement(sql: string, value: unknown): unknown {
  if (!statementNamesTable(sql, 'delegated_role_admin_scopes')) return []
  if (DEPARTMENT_SCOPE_PROJECTION.test(sql)) return value
  if (!Array.isArray(value)) return value
  return value.map((item) => (Array.isArray(item) ? item.slice(0, 2) : item))
}

const COLUMN_SOURCE_TABLE: Record<keyof PrivilegeRow, string> = {
  id: 'users',
  is_admin: 'users',
  role: 'users',
  legacy_permissions: 'users',
  role_ids: 'user_roles',
  direct_codes: 'user_permissions',
  role_permission_pairs: 'role_permissions',
  admissions: 'user_namespace_admissions',
  department_scopes: 'delegated_role_admin_scopes',
  member_group_scopes: 'delegated_role_admin_member_groups',
}

function statementNamesTable(sql: string, table: string): boolean {
  return new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`).test(sql)
}

function answerRow(sql: string, row: PrivilegeRow): Record<string, unknown> {
  const answered: Record<string, unknown> = {}
  for (const column of Object.keys(COLUMN_SOURCE_TABLE) as Array<keyof PrivilegeRow>) {
    const table = COLUMN_SOURCE_TABLE[column]
    if (table === 'users') {
      if (!statementNamesTable(sql, 'users')) throw new Error('Unexpected query')
      answered[column] = row[column]
    } else if (column === 'department_scopes') {
      answered[column] = departmentScopesForStatement(sql, row[column])
    } else {
      answered[column] = statementNamesTable(sql, table) ? row[column] : []
    }
  }
  return answered
}

export function privilegeHarness(data: PrivilegeFixture = privilegeFixture(), options: HarnessOptions = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let probes = 0
  const executor: Queryable = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (options.failAt && sql.includes(options.failAt)) {
        const error = new Error('synthetic_private_sql_detail')
        if (options.failCode !== null) Object.assign(error, { code: options.failCode ?? '42P01' })
        throw error
      }
      if (sql.includes('current_setting')) return { rows: [{ isolation: data.isolation }], rowCount: 1 }
      if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: data.xids[probes++] }], rowCount: 1 }
      const rows = data.rows.map((row) => (row && typeof row === 'object' ? answerRow(sql, row) : row))
      return { rows, rowCount: rows.length }
    },
  }
  return { executor, calls }
}

/** Reads inputs for a single row through the real read path. */
export async function readInputs(overrides: Partial<PrivilegeRow> = {}): Promise<PrivilegeInputs> {
  return readPrivilegeInputs(privilegeHarness(privilegeFixture({ rows: [privilegeRow(overrides)] })).executor, SUBJECT)
}
