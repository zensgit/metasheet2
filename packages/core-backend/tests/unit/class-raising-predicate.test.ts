/**
 * Differential test: the contract's class-raising predicates agree with the privilege classifier on
 * the same matrix of permission codes and role ids, compared only through the exported
 * `classifyPrivilege` over minimal inputs. A change to either side that the other does not mirror
 * fails here.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { classifyPrivilege } from '../../src/auth/security-action-privilege'
import { isClassRaisingPermissionCode, isClassRaisingRoleId } from '../../src/rbac/authorization-input-classes'
import { readInputs } from '../helpers/security-action-privilege-harness'

const CLASSES_MODULE = path.resolve(__dirname, '..', '..', 'src', 'rbac', 'authorization-input-classes.ts')

const CODES = [
  'Attendance:Admin',
  'attendance : admin',
  'attendance:admin',
  '*',
  '*:*',
  'x:*',
  'admin:all',
  'admin:read',
  'users:write',
  'roles:write',
  'permissions:write',
  'Users:Write',
  ' users:write ',
  'users : write',
  'users:read',
  'roles:read',
  'permissions:read',
  'attendance:read',
  'docs:write',
  'tasks:write',
  'attendance:*',
  '*:read',
  ':write',
  'write',
  '',
  ' ',
  'admin',
  'users',
  'x:admin',
  'x:ADMIN',
  'x:Admin ',
]

const ROLE_IDS = [
  'admin',
  'Admin',
  ' admin',
  'ADMIN',
  'admin ',
  'x_Admin',
  'X_ADMIN',
  'x_admin',
  'users_admin',
  'admin_',
  '_admin',
  'adminx',
  'viewer',
  'attendance_employee',
  'stock-prep:admin',
  ' admin',
  'admin ',
  '﻿admin',
  'users _admin',
  'x_admin ',
]

function folded(value: string): string {
  return value.trim().toLowerCase()
}

describe('class-raising permission codes agree with the classifier', () => {
  for (const code of CODES) {
    for (const value of [code, folded(code)]) {
      it(`${JSON.stringify(value)}`, async () => {
        const inputs = await readInputs({ direct_codes: [value] })
        expect(isClassRaisingPermissionCode(value)).toBe(classifyPrivilege(inputs).privilegeClass === 'high')
      })
    }
  }

  it('the matrix contains both verdicts', () => {
    expect(CODES.some((code) => isClassRaisingPermissionCode(code))).toBe(true)
    expect(CODES.some((code) => !isClassRaisingPermissionCode(code))).toBe(true)
    expect(isClassRaisingPermissionCode(42)).toBe(false)
    expect(isClassRaisingPermissionCode(null)).toBe(false)
  })
})

describe('class-raising role ids agree with the classifier', () => {
  for (const roleId of ROLE_IDS) {
    for (const value of [roleId, folded(roleId)]) {
      it(`${JSON.stringify(value)}`, async () => {
        const inputs = await readInputs({ role_ids: [value] })
        expect(isClassRaisingRoleId(value)).toBe(classifyPrivilege(inputs).privilegeClass === 'high')
      })
    }
  }

  it('the matrix contains both verdicts', () => {
    expect(ROLE_IDS.some((roleId) => isClassRaisingRoleId(roleId))).toBe(true)
    expect(ROLE_IDS.some((roleId) => !isClassRaisingRoleId(roleId))).toBe(true)
    expect(isClassRaisingRoleId(undefined)).toBe(false)
  })
})

describe('predicate module shape', () => {
  it('imports exactly the two modules the classifier reads its predicates from, and never the classifier', () => {
    const source = readFileSync(CLASSES_MODULE, 'utf8')
    const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
    const specifiers = file.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [])
    expect(specifiers.sort()).toEqual(['./namespace-admission', './role-assignment'])
    expect(source).not.toMatch(/security-action-privilege/)
  })
})
