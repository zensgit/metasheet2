import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { hasLegacyAdminClaim as userClaim } from '../../src/rbac/platform-admin'
import { jsonError } from '../../src/util/response'
import express from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn(), resolve: vi.fn(), admin: true, gate: vi.fn(), transaction: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ transaction: (fn: (c: { query: typeof mocks.query }) => unknown) => mocks.transaction(fn) }))
vi.mock('../../src/services/ApprovalDirectoryOrg', () => ({
  resolveApprovalRequesterOrgRelations: (...args: unknown[]) => mocks.resolve(...args),
  ApprovalRoutingPolicyError: class ApprovalRoutingPolicyError extends Error {},
}))
import { userApprovalRelationsHandler } from '../../src/routes/admin-user-approval-relations'
import { ApprovalRoutingPolicyError } from '../../src/services/ApprovalDirectoryOrg'


function actualGate(file: string, directory: boolean) {
  const source = readFileSync(new URL('../../src/routes/' + file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const names = new Set(['getRequestUserId', 'ensurePlatformAdmin', ...(directory ? ['hasLegacyAdminClaim'] : [])])
  const functions = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!node.name && names.has(node.name.text))
  expect(functions).toHaveLength(directory ? 3 : 2)
  const code = ts.transpileModule(functions.map(node => node.getText(ast).replace(/^export /, '')).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function('hasLegacyAdminClaim', 'isRbacAdmin', 'jsonError', code + ';return ensurePlatformAdmin')(userClaim, async () => false, jsonError) as (req: express.Request, res: express.Response) => Promise<string | null>
}

const testGate = async (req: express.Request, res: express.Response) => {
  if (mocks.gate.getMockImplementation()) return mocks.gate(req, res)
  if (mocks.admin) return 'admin'
  res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } }); return null
}
const pinned = usePinnedServer()
const app = express(); app.get('/users/:userId/approval-relations', userApprovalRelationsHandler(testGate))
function rows(sql: string) {
  if (sql.startsWith('SET TRANSACTION')) return { rows: [] }
  if (sql === 'SELECT id FROM users WHERE id = $1') return { rows: [{ id: 'subject' }] }
  if (sql.includes('SELECT i.provider')) return { rows: [{ provider: 'local', policy: true }] }
  if (sql.includes('SELECT id, name')) return { rows: [{ id: 'manager', name: '主管甲' }, { id: 'head', name: '负责人乙' }] }
  throw new Error('unexpected SQL')
}
beforeEach(() => {
  pinned.setApp(app)
  mocks.gate.mockReset().mockImplementation(async (_req: express.Request, res: express.Response) => {
    if (mocks.admin) return 'admin'
    res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } }); return null
  }); mocks.admin = true; mocks.query.mockReset().mockImplementation(rows); mocks.resolve.mockReset()
  mocks.resolve.mockResolvedValue({ canonicalIntegrationId: '11111111-1111-4111-8111-111111111111', primaryDepartmentName: '演示部门', managerId: 'manager', deptHeadId: 'head' })
  mocks.transaction.mockReset().mockImplementation(fn => fn({ query: mocks.query }))
})
describe('admin user approval relations read', () => {
  it('returns exact existing relations under READ ONLY before any read', async () => {
    const response = await request(pinned.url()).get('/users/subject/approval-relations')
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ userId: 'subject', source: { mode: 'policy', provider: 'local' }, primaryDepartment: '演示部门', manager: { id: 'manager', name: '主管甲' }, departmentHead: { id: 'head', name: '负责人乙' } })
    expect(mocks.query.mock.calls[0]).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'])
    expect(mocks.resolve).toHaveBeenCalledWith('subject', expect.any(Function), { includeDepartmentFieldContext: true })
    expect(mocks.query.mock.calls.every(([sql]) => /^(SET TRANSACTION|SELECT)/.test(sql))).toBe(true)
  })
  it('refuses non-admin before transaction or resolver', async () => {
    mocks.admin = false; const response = await request(pinned.url()).get('/users/subject/approval-relations')
    expect(response.status).toBe(403); expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('rejects query-selected org/provider/preview without reading', async () => {
    const response = await request(pinned.url()).get('/users/subject/approval-relations?orgId=foreign')
    expect(response.status).toBe(400); expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('returns404 for absent subject without invoking resolver', async () => {
    mocks.query.mockImplementation(sql => sql === 'SELECT id FROM users WHERE id = $1' ? { rows: [] } : rows(sql))
    const response = await request(pinned.url()).get('/users/missing/approval-relations')
    expect(response.status).toBe(404); expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('preserves missing relation state instead of guessing manager from position', async () => {
    mocks.resolve.mockResolvedValue({}); const response = await request(pinned.url()).get('/users/subject/approval-relations')
    expect(response.body.data).toEqual({ userId: 'subject', source: { mode: 'unresolved', provider: null }, primaryDepartment: null, manager: null, departmentHead: null })
  })
  it('reports misconfigured or ambiguous policy without leaking exception values', async () => {
    mocks.resolve.mockRejectedValue(new ApprovalRoutingPolicyError('private-detail'))
    const response = await request(pinned.url()).get('/users/subject/approval-relations')
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('APPROVAL_RELATIONS_UNRESOLVED')
    expect(JSON.stringify(response.body)).not.toContain('private-detail')
  })
  it('fails closed when read-only setup fails, without querying subject', async () => {
    mocks.query.mockRejectedValue(new Error('private-detail')); const response = await request(pinned.url()).get('/users/subject/approval-relations')
    expect(response.status).toBe(500); expect(mocks.query).toHaveBeenCalledTimes(1); expect(mocks.resolve).not.toHaveBeenCalled()
    expect(JSON.stringify(response.body)).not.toContain('private-detail')
  })
  it('labels implicit DingTalk selection without altering it', async () => {
    mocks.query.mockImplementation(sql => sql.includes('SELECT i.provider') ? { rows: [{ provider: 'dingtalk', policy: false }] } : rows(sql))
    const response = await request(pinned.url()).get('/users/subject/approval-relations')
    expect(response.body.data.source).toEqual({ mode: 'legacy-default', provider: 'dingtalk' })
    expect(mocks.resolve.mock.calls[0][2]).not.toHaveProperty('overrideCanonicalIntegrationId')
  })
  it('preserves the existing user-admin admit set for a wildcard-only non-admin actor', async () => {
    const actor = { id: 'actor', role: 'user', permissions: ['*:*'] }
    const userGate = actualGate('admin-users.ts', false)
    const directoryGate = actualGate('admin-directory.ts', true)
    const directoryControl = express(); directoryControl.use((req, _res, next) => { Object.assign(req, { user: actor }); next() })
    directoryControl.get('/control', async (req, res) => { if (await directoryGate(req, res)) res.json({ allowed: true }) })
    pinned.setApp(directoryControl)
    expect((await request(pinned.url()).get('/control')).status).toBe(200)
    const control = express(); control.use((req, _res, next) => { Object.assign(req, { user: actor }); next() })
    control.get('/control', async (req, res) => { if (await userGate(req, res)) res.json({ allowed: true }) })
    pinned.setApp(control)
    expect((await request(pinned.url()).get('/control')).status).toBe(403)
    mocks.gate.mockImplementation(userGate)
    const selected = express(); selected.use((req, _res, next) => { Object.assign(req, { user: actor }); next() })
    selected.get('/users/:userId/approval-relations', userApprovalRelationsHandler(testGate))
    expect(readFileSync(new URL('../../src/routes/admin-users.ts', import.meta.url), 'utf8')).toContain("authenticate, userApprovalRelationsHandler(ensurePlatformAdmin))")
    pinned.setApp(selected)
    const response = await request(pinned.url()).get('/users/subject/approval-relations')
    expect(response.status).toBe(403)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('retains actual user-gate admin positive and no-subject401 controls', async () => {
    mocks.gate.mockImplementation(actualGate('admin-users.ts', false))
    const selected = express(); selected.use((req, _res, next) => { if (req.headers['x-control-admin']) Object.assign(req, { user: { id: 'admin', role: 'admin' } }); next() })
    selected.get('/users/:userId/approval-relations', userApprovalRelationsHandler(testGate))
    pinned.setApp(selected)
    expect((await request(pinned.url()).get('/users/subject/approval-relations').set('x-control-admin', 'yes')).status).toBe(200)
    mocks.transaction.mockClear()
    expect((await request(pinned.url()).get('/users/subject/approval-relations')).status).toBe(401)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

})
