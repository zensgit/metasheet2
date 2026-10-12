/**
 * Owner ruling 2026-10-12 (R-39): the legacy floor-role move script
 * (scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs) gained the option ① split step
 * (`--split-extra-codes-to-role`). A plain-node ops script cannot import the backend's TypeScript, so
 * it carries copies of the server's role-id and permission-code predicates. This file pins every copy
 * EQUAL to the original over a corpus that exercises each branch, so the split role id the script
 * accepts is judged exactly as the server judges delegated assignment (rbac/namespace-admission.ts,
 * rbac/role-assignment.ts) and role creation (routes/roles.ts `isWellFormedNewRoleId`).
 *
 * It also pins the script's static split-id rule against the server's assignment boundary: an id the
 * script accepts is refused by `assertRoleAssignable` under delegated (`namespaces`) authority for
 * every namespace the id's LEADING segment could name, and is never a main-admin id.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

// routes/roles.ts is imported for `isWellFormedNewRoleId` only; its module graph must not reach a pool.
vi.mock('../../src/db/pg', () => ({ query: vi.fn(), transaction: vi.fn(), pool: { query: vi.fn() } }))
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))

import {
  deriveDelegatedAdminNamespace,
  derivePermissionNamespace,
  isNamespaceAdmissionControlledResource,
  roleIdMatchesNamespace,
} from '../../src/rbac/namespace-admission'
import { assertRoleAssignable, isAdminLevelPermissionCode } from '../../src/rbac/role-assignment'
import { isWellFormedNewRoleId } from '../../src/routes/roles'

const SCRIPT_PATH = path.resolve(__dirname, '../../../../scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs')

type Script = {
  NON_NAMESPACED_PERMISSION_RESOURCES: readonly string[]
  RECOMMENDED_SPLIT_ROLE_ID: string
  deriveDelegatedAdminNamespace: (roleId: unknown) => string | null
  roleIdMatchesNamespace: (roleId: unknown, namespace: unknown) => boolean
  isNamespaceAdmissionControlledResource: (resource: unknown) => boolean
  derivePermissionNamespace: (code: unknown) => string | null
  isAdminLevelPermissionCode: (code: unknown) => boolean
  isWellFormedNewRoleId: (id: string) => boolean
  candidateNamespaces: (roleId: string) => string[]
  splitRoleIdProblem: (roleId: unknown) => string | null
}

const loadScript = async () => (await import(pathToFileURL(SCRIPT_PATH).href)) as Script

const ROLE_IDS = [
  '', ' ', 'admin', ' admin ', '_admin', 'x_admin', ' x_admin ', 'stock-prep_admin', 'stock-prep_x_admin', 'stock-prep',
  'stock-prep_frontline', 'stock-prep-operator', 'attendance_admin', 'plugin_elearning_admin', 'approvals_admin',
  'approvals_operator', 'operator_approvals', 'a__b', 'a_b_c', '_x', 'x_', 'adminx', 'x-admin', 'X_ADMIN', '　x_admin',
]
const NAMESPACES = ['', ' ', 'stock-prep', 'stock-prep_c', 'approvals', 'approvals_operator', 'operator', 'a', 'a_', 'a_b', 'x', 'attendance', 'plugin_elearning']
const RESOURCES = ['', ' ', '*', 'admin', 'approvals', 'multitable', 'workflow', 'stock-prep', 'attendance', 'operator', 'approvals_operator', ' approvals ', 'Approvals']
const CODES = [
  '', ':', ':read', 'approvals', 'approvals:read', ' approvals:read ', 'approvals:admin', 'approvals:*', 'Approvals:Admin', '*:*', '*:read',
  'admin:all', 'admin:read', 'stock-prep:admin', 'stock-prep:read', 'attendance : admin', 'multitable:submit-approval',
  'approval-templates:manage', 'approvals_operator:read', 'x:y:admin', 'x:', 42, null,
]
const NEW_ROLE_IDS = ['', ' ', 'a', ' a', 'a ', 'a​b', 'a\u0007b', 'a ', '﻿a', 'approvals_operator', '审批', 'a‮b', 'a\tb']

describe('option ① split step — the ops script mirrors the server predicates exactly', () => {
  it('NON_NAMESPACED_PERMISSION_RESOURCES: every entry is non-admission-controlled on the server, and the two predicates agree', async () => {
    const script = await loadScript()
    for (const resource of script.NON_NAMESPACED_PERMISSION_RESOURCES) {
      expect(isNamespaceAdmissionControlledResource(resource), resource).toBe(false)
    }
    for (const resource of [...RESOURCES, ...script.NON_NAMESPACED_PERMISSION_RESOURCES]) {
      expect(script.isNamespaceAdmissionControlledResource(resource), JSON.stringify(resource)).toBe(isNamespaceAdmissionControlledResource(resource))
    }
  })

  it('deriveDelegatedAdminNamespace / roleIdMatchesNamespace / derivePermissionNamespace / isAdminLevelPermissionCode / isWellFormedNewRoleId agree with the server', async () => {
    const script = await loadScript()
    for (const roleId of ROLE_IDS) {
      expect(script.deriveDelegatedAdminNamespace(roleId), JSON.stringify(roleId)).toBe(deriveDelegatedAdminNamespace(roleId))
      for (const namespace of NAMESPACES) {
        expect(script.roleIdMatchesNamespace(roleId, namespace), `${JSON.stringify(roleId)} in ${JSON.stringify(namespace)}`).toBe(roleIdMatchesNamespace(roleId, namespace))
      }
    }
    for (const code of CODES) {
      expect(script.derivePermissionNamespace(code), JSON.stringify(code)).toBe(derivePermissionNamespace(code as string))
      expect(script.isAdminLevelPermissionCode(code), JSON.stringify(code)).toBe(isAdminLevelPermissionCode(code))
    }
    for (const id of NEW_ROLE_IDS) {
      expect(script.isWellFormedNewRoleId(id), JSON.stringify(id)).toBe(isWellFormedNewRoleId(id))
    }
  })

  it('candidateNamespaces lists exactly the namespaces roleIdMatchesNamespace accepts for the id (over every prefix)', async () => {
    const script = await loadScript()
    for (const roleId of ROLE_IDS.filter((id) => id.trim() === id && id !== '')) {
      const everyPrefix = Array.from({ length: roleId.length }, (_, index) => roleId.slice(0, index + 1))
      const expected = everyPrefix.filter((namespace) => roleIdMatchesNamespace(roleId, namespace))
      expect(script.candidateNamespaces(roleId), roleId).toEqual(expected)
    }
  })

  it('an id the script accepts is never a main-admin id, and no delegate of its LEADING segment can assign it', async () => {
    const script = await loadScript()
    const accepted = ['approvals_operator', 'multitable_floor', 'workflow_x.y', 'approvals']
    for (const roleId of accepted) {
      expect(script.splitRoleIdProblem(roleId), roleId).toBeNull()
      expect(deriveDelegatedAdminNamespace(roleId), roleId).toBeNull()
      const leading = script.candidateNamespaces(roleId)[0]!
      expect(() => assertRoleAssignable(roleId, { kind: 'namespaces', namespaces: [leading] }), roleId).toThrow()
    }
    expect(script.splitRoleIdProblem(script.RECOMMENDED_SPLIT_ROLE_ID)).toBeNull()
    // …while the ids it refuses for their leading segment ARE assignable by that segment's delegate.
    for (const roleId of ['operator_approvals', 'stock-prep_split', 'attendance_split']) {
      expect(script.splitRoleIdProblem(roleId), roleId).not.toBeNull()
      const leading = script.candidateNamespaces(roleId)[0]!
      expect(() => assertRoleAssignable(roleId, { kind: 'namespaces', namespaces: [leading] }), roleId).not.toThrow()
    }
  })
})
