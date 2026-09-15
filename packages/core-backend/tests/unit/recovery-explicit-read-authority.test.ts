import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Request } from 'express'
import ts from 'typescript'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const requestAccess = vi.hoisted(() => vi.fn())
vi.mock('../../src/multitable/access', async (original) => ({
  ...(await original<typeof import('../../src/multitable/access')>()),
  resolveRequestAccess: requestAccess,
}))
import type { ResolvedRequestAccess } from '../../src/multitable/access'
import { resolveBaseReadable, resolveBaseReadableForAccess, type QueryFn } from '../../src/multitable/permission-service'
import { resolveRecoverySheetAuthority } from '../../src/multitable/recovery-authorization-stability'
import { deriveElearningProjectionBaseId, deriveElearningProjectionSheetId } from '../../src/multitable/elearning-projection-constants'

const member: ResolvedRequestAccess = { userId: 'actor-read', permissions: [], isAdminRole: false }
const admin = { ...member, isAdminRole: true }
const baseId = 'base_read_authority'
const req = {} as Request
const queryFor = (exists = true, ownerId = 'other') => vi.fn<Parameters<QueryFn>, ReturnType<QueryFn>>(
  async (sql, params) => {
    expect(sql).toBe('SELECT owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL')
    expect(params).toEqual([baseId])
    return { rows: exists ? [{ owner_id: ownerId }] : [] }
  },
)
beforeEach(() => requestAccess.mockReset().mockResolvedValue(admin))

describe('explicit recovery base readability', () => {
  test.each([
    ['member', member, 'other', false],
    ['owner', member, member.userId, true],
    ['admin', admin, 'other', true],
    ['grant', { ...member, permissions: ['multitable:base:read'] }, 'other', true],
    ['write-only', { ...member, permissions: ['multitable:base:write'] }, 'other', false],
  ] satisfies Array<[string, ResolvedRequestAccess, string, boolean]>)('%s uses only the supplied access snapshot', async (_name, access, owner, expected) => {
    expect(await resolveBaseReadableForAccess(queryFor(true, owner), baseId, access)).toBe(expected)
    expect(requestAccess).not.toHaveBeenCalled()
  })
  test.each([admin, { ...member, permissions: ['multitable:base:read'] }])('missing/deleted base beats privileged access', async (access) => {
    expect(await resolveBaseReadableForAccess(queryFor(false), baseId, access)).toBe(false)
    expect(requestAccess).not.toHaveBeenCalled()
  })
  test('blank base performs no authority or database work', async () => {
    const query = queryFor()
    expect(await resolveBaseReadableForAccess(query, ' ', admin)).toBe(false)
    expect(await resolveBaseReadable(req, query, ' ')).toBe(false)
    expect(query).not.toHaveBeenCalled()
    expect(requestAccess).not.toHaveBeenCalled()
  })
  test('HTTP wrapper retains canonical request resolution and normalized base', async () => {
    requestAccess.mockResolvedValue(member)
    expect(await resolveBaseReadable(req, queryFor(), ` ${baseId} `)).toBe(false)
    expect(requestAccess).toHaveBeenCalledWith(req)
    expect(requestAccess).toHaveBeenCalledTimes(1)
  })
  test.each(['org-read', 'other-org', undefined])('preserves verified tenant for projection base parity (%s)', async (tenant) => {
    const permissions = ['multitable:read', 'elearning:admin']
    requestAccess.mockResolvedValue({ ...member, permissions, ...(tenant ? { authenticatedTenantId: tenant } : {}) })
    const authorityQuery: QueryFn = async (sql) => ({ rows: sql.includes('FROM users')
      ? [{ role: 'user', permissions, is_active: true, rbac_admin: false }]
      : [] })
    const resolved = await resolveRecoverySheetAuthority(req, authorityQuery, 'source-sheet')
    expect(resolved.access.permissions).toEqual(permissions)
    const targetBase = deriveElearningProjectionBaseId('org-read')
    const targetSheet = deriveElearningProjectionSheetId('org-read')
    const projectionQuery: QueryFn = async (sql) => {
      if (sql.includes('SELECT owner_id')) return { rows: [{ owner_id: null }] }
      if (sql.includes('SELECT org_id, sheet_id')) return { rows: [{ org_id: 'org-read', sheet_id: targetSheet }] }
      if (sql.includes('SELECT id') && sql.includes('FROM meta_sheets')) return { rows: [{ id: targetSheet }] }
      throw new Error('unexpected_projection_query')
    }
    expect(await resolveBaseReadableForAccess(projectionQuery, targetBase, resolved.access)).toBe(tenant === 'org-read')
    expect(resolved.access.authenticatedTenantId).toBe(tenant)
  })
})

const source = ts.createSourceFile('univer-meta.ts', readFileSync(resolve(__dirname, '../../src/routes/univer-meta.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
function bodyOf(name: string): ts.Block {
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!declaration?.body) throw new Error(`missing_authority_function:${name}`)
  return declaration.body
}
function callsIn(body: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === name) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(body)
  return calls
}
describe('recovery snapshot wiring through canonical formula masking', () => {
  test.each([
    ['hasFullTableReadAccess', 'maskStoredRecordFieldIds', 5, 'access'],
    ['maskStoredRecordFieldIds', 'resolveTaintedFormulaFieldIds', 4, 'authorityAccess'],
    ['resolveTaintedFormulaFieldIds', 'resolveForeignFieldReadability', 4, 'authorityAccess'],
    ['resolveForeignFieldReadability', 'resolveSheetCapabilitiesForAccess', 2, 'access'],
    ['resolveForeignFieldReadability', 'resolveBaseReadableForAccess', 2, 'access'],
  ] as const)('%s forwards the exact snapshot to %s', (caller, callee, position, argument) => {
    const calls = callsIn(bodyOf(caller), callee)
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments[position]?.getText(source)).toBe(argument)
  })
  test('full-read does not manufacture a request or resolve cached claims', () => {
    const body = bodyOf('hasFullTableReadAccess')
    for (const name of ['Object.create', 'Object.defineProperty', 'resolveRequestAccess']) {
      expect(callsIn(body, name)).toHaveLength(0)
    }
    const foreign = bodyOf('resolveForeignFieldReadability').getText(source)
    expect(foreign).toContain('authorityAccess ?? await resolveRequestAccess(req)')
    expect(foreign).toContain('? resolveSheetCapabilitiesForAccess')
    expect(foreign).toContain('? await resolveBaseReadableForAccess')
  })
})
