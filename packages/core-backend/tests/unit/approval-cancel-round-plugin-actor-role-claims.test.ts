import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'

import { resolveApprovalActorRoles } from '../../src/services/approval-actor-roles'
import { resolveApprovalActorPermissions } from '../../src/routes/approvals'

/**
 * Cancel-round product entry (phase C gate r2, NIT) — the plugin's `getActorRoleClaims` against
 * core's `resolveApprovalActorRoles`.
 *
 * The plugin (CJS, no import of the TS side) keeps its own copy of the resolver for the entry's
 * count push. The real-DB suite reaches it only with the `role` claim set, so the `roles` array arm
 * had no reading. The helper is not exported; this takes its bytes from `index.cjs` (exactly one
 * definition), RUNS them, and compares the result on each request shape with core's resolver AND
 * with a literal, so two equally wrong copies cannot agree their way to green.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const pluginSource = readFileSync(join(repoRoot, 'plugins/plugin-attendance/index.cjs'), 'utf8')

function loadPluginHelper(name: string): (req: unknown) => string[] {
  const head = `function ${name}(req) {`
  const start = pluginSource.indexOf(head)
  if (start < 0 || pluginSource.indexOf(head, start + 1) >= 0) {
    throw new Error(`expected exactly one ${name} definition in plugins/plugin-attendance/index.cjs`)
  }
  const end = pluginSource.indexOf('\n}\n', start)
  const body = pluginSource.slice(start, end + 2)
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict"; ${body}; return ${name};`)() as (req: unknown) => string[]
}

const pluginGetActorRoleClaims = loadPluginHelper('getActorRoleClaims')
// Phase D T6: the permission-claim copy the entry's count push carries for the actor.
const pluginGetActorPermissionClaims = loadPluginHelper('getActorPermissionClaims')

const cases: Array<{ name: string; user: unknown; expected: string[] }> = [
  { name: 'the role claim alone', user: { role: 'admin' }, expected: ['admin'] },
  { name: 'the roles array alone', user: { roles: ['attendance_approver', 'hr'] }, expected: ['attendance_approver', 'hr'] },
  { name: 'both, trimmed role, deduplicated across the two', user: { role: ' admin ', roles: ['admin', 'hr', 'hr'] }, expected: ['admin', 'hr'] },
  { name: 'blank and non-string array entries dropped', user: { roles: ['', '  ', 7, null, 'hr'] }, expected: ['hr'] },
  { name: 'array entries kept as written (not trimmed)', user: { roles: [' hr '] }, expected: [' hr '] },
  { name: 'a non-array roles claim and a blank role ignored', user: { role: '  ', roles: 'admin' }, expected: [] },
  { name: 'no user', user: undefined, expected: [] },
]

describe('plugin getActorRoleClaims matches core resolveApprovalActorRoles', () => {
  it.each(cases)('$name', ({ user, expected }) => {
    const req = { user } as unknown as Request
    expect(resolveApprovalActorRoles(req)).toEqual(expected)
    expect(pluginGetActorRoleClaims(req)).toEqual(expected)
  })
})

const permissionCases: Array<{ name: string; user: unknown; expected: string[] }> = [
  { name: 'the permissions claim alone', user: { permissions: ['attendance:approve', 'approvals:read'] }, expected: ['attendance:approve', 'approvals:read'] },
  { name: 'the perms claim alone', user: { perms: ['attendance:read'] }, expected: ['attendance:read'] },
  { name: 'both, trimmed, deduplicated across the two', user: { permissions: [' attendance:approve '], perms: ['attendance:approve', 'x:y'] }, expected: ['attendance:approve', 'x:y'] },
  { name: 'blank and non-string entries dropped', user: { permissions: ['', '  ', 7, null, 'a:b'] }, expected: ['a:b'] },
  { name: 'non-array claims ignored', user: { permissions: 'attendance:approve', perms: { a: 1 } }, expected: [] },
  { name: 'no user', user: undefined, expected: [] },
]

describe('plugin getActorPermissionClaims matches core resolveApprovalActorPermissions (phase D T6)', () => {
  it.each(permissionCases)('$name', ({ user, expected }) => {
    const req = { user } as unknown as Request
    expect(resolveApprovalActorPermissions(req)).toEqual(expected)
    expect(pluginGetActorPermissionClaims(req)).toEqual(expected)
  })
})
