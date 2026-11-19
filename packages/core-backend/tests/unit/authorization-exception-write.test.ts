import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as mutex from '../../src/directory/access-graph-mutex'
import * as authority from '../../src/admin/platform-actor-authority'
import * as exceptionAuthority from '../../src/admin/direct-permission-authority'
import * as brand from '../../src/rbac/authorization-input-brand'
import * as kernel from '../../src/rbac/authorization-input-lock'
import type { AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import * as legacy from '../../src/admin/legacy-permission-revoke'
import { writeAuthorizationException } from '../../src/admin/authorization-exception-write'
import type { AuthorizationExceptionInput } from '../../src/admin/authorization-exception-write'
import type { LockedAccessGraphUser } from '../../src/directory/access-graph-mutex'

const user = (id: string): LockedAccessGraphUser => ({ id, name: null, email: null, username: null, mobile: null, role: null, isActive: true, activationStatus: 'activated', accessGeneration: 0, deletedAt: null, purgedAt: null })
function fixture() {
  const direct = new Set(['read'])
  const catalog = new Set(['read', 'write', 'export'])
  let admin = true
  let badReturn: 'user' | 'code' | 'count' | null = null
  let supersedes = 0
  let legacy: unknown = ['read', null, ' write ']
  const subjects = Object.freeze(['actor', 'target'])
  const plan = Object.freeze({ intent: 'AUTHORIZATION_OPERATION' as const, userIds: subjects, admissionUserIds: subjects,
    roleIds: Object.freeze(['admin']), operation: Object.freeze({ actorId:'actor', clientOperationId:'operation' }),
    witness: Object.freeze({userIds: subjects, admissionUserIds: subjects}) })
  const rows = new Map(subjects.map(id => [id, user(id)]))
  const client = { plan, locked: rows, world: 'shared', born: new Set(), roleRows: new Map([['admin','held']]),
    witnessed: { userIds: new Set(subjects), admissionUserIds: new Set(subjects) }, query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM user_roles')) return { rows: admin ? [{ role_id: 'admin' }] : [] }
    if (sql.includes('SELECT permission_code FROM user_permissions')) return { rows: [...direct].sort().map(permission_code => ({ permission_code })) }
    if (sql.includes('SELECT code FROM permissions')) return { rows: (params[0] as string[]).filter(code => catalog.has(code)).map(code => ({ code })) }
    if (sql.includes('INSERT INTO user_permissions') || sql.includes('DELETE FROM user_permissions')) {
      const code = params[1] as string
      if (sql.includes('INSERT')) direct.add(code); else direct.delete(code)
      return { rows: [{ user_id: badReturn === 'user' ? 'other' : params[0], permission_code: badReturn === 'code' ? 'other' : code }], rowCount: badReturn === 'count' ? 0 : 1 }
    }
    if (sql.includes('pg_typeof(permissions)::text AS')) return { rows: [{ permissions_type: 'jsonb', permissions: legacy }] }
    if (sql.includes('SET permissions =')) { legacy = JSON.parse(params[1] as string); return { rows: [{ id: params[0] }], rowCount: 1 } }
    if (sql.includes('directory_deprovision_effects')) { supersedes++; return { rows: [] } }
    if (sql.includes('directory_deprovision_events')) return { rows: [] }
    if (sql.includes('access_generation')) return { rows: [{ access_generation: 1 }] }
    throw new Error(`Unexpected SQL: ${sql}`)
  } } as unknown as AuthorizationInputTx
  brand.mintAuthorizationInputBrand(client, [client])
  const input: AuthorizationExceptionInput = { actorId: 'actor', userId: 'target', plan, action: { kind: 'direct.grant', code: 'write' }, expectedDirectCodes: ['read'] }
  return { client, input, rows, direct, setAdmin: (value: boolean) => { admin = value }, setBadReturn: (kind: 'user' | 'code' | 'count' = 'user') => { badReturn = kind }, supersedes: () => supersedes, legacy: () => legacy }
}

describe('locked authorization exception writer', () => {
  it('grants only actual changes, supersedes once, and preserves no-op semantics', async () => {
    const f = fixture()
    expect(await writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).toEqual({ changedCodes: ['write'] })
    expect([...f.direct].sort()).toEqual(['read', 'write'])
    expect(f.supersedes()).toBe(1)
    f.input.expectedDirectCodes = ['read', 'write']
    expect(await writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).toEqual({ changedCodes: [] })
    expect(f.supersedes()).toBe(1)
  })
  it('revokes exact code and template grants only missing codes', async () => {
    const f = fixture()
    f.input.action = { kind: 'direct.revoke', code: 'read' }
    expect(await writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).toEqual({ changedCodes: ['read'] })
    f.input.expectedDirectCodes = []
    f.input.action = { kind: 'template.grant', codes: ['write', 'export'] }
    expect(await writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).toEqual({ changedCodes: ['write', 'export'] })
  })
  it('requires locked live RBAC administrator and exact visible target', async () => {
    const f = fixture()
    f.setAdmin(false)
    f.rows.delete('target')
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    f.rows.set('target', { ...user('target'), deletedAt: 'now' })
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    f.rows.set('target', user('target'))
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    f.setAdmin(true)
    f.rows.set('actor', user('wrong'))
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    f.rows.set('actor', { ...user('actor'), isActive: false })
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    f.rows.set('actor', user('actor'))
    f.rows.set('target', { ...user('target'), deletedAt: 'now' })
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toMatchObject({ code: 'USER_IN_RECYCLE_BIN' })
    f.rows.set('target', user('wrong'))
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect([...f.direct]).toEqual(['read'])
  })
  it('refuses stale witnesses, missing catalog entries, and wrong acknowledged row', async () => {
    const f = fixture()
    f.input.expectedDirectCodes = []
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toMatchObject({ code: 'STALE' })
    f.input.expectedDirectCodes = ['read']
    f.input.action = { kind: 'template.grant', codes: ['write', 'missing'] }
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toMatchObject({ code: 'UNKNOWN_PERMISSION' })
    expect([...f.direct]).toEqual(['read'])
    f.input.action = { kind: 'direct.grant', code: 'write' }
    f.setBadReturn()
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toMatchObject({ code: 'WRITE_NOT_ACKNOWLEDGED' })
    expect(f.supersedes()).toBe(0)
    for (const kind of ['count', 'code'] as const) {
      const other = fixture(); other.setBadReturn(kind)
      await expect(writeAuthorizationException(other.client, Object.freeze({ ...other.input }))).rejects.toMatchObject({ code: 'WRITE_NOT_ACKNOWLEDGED' })
    }
  })
  it('removes legacy matches without normalizing unrelated elements and checks before-image', async () => {
    const f = fixture()
    f.input.action = { kind: 'legacy.revoke', code: 'write' }
    f.input.expectedLegacy = { value: ['read', null, 'write'] }
    await expect(writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).rejects.toThrow('AUTHORIZATION_EXCEPTION_STALE')
    f.input.expectedLegacy = { value: ['read', null, ' write '] }
    expect(await writeAuthorizationException(f.client, Object.freeze({ ...f.input }))).toEqual({ changedCodes: ['write'] })
    expect(f.legacy()).toEqual(['read', null])
    expect(f.supersedes()).toBe(1)
  })
})



describe('in-memory guard mutation probes', () => {
  const source = readFileSync(new URL('../../src/admin/authorization-exception-write.ts', import.meta.url), 'utf8')
  const authoritySource = readFileSync(new URL('../../src/admin/direct-permission-authority.ts', import.meta.url), 'utf8')
  function mutant(before: string, after: string): typeof writeAuthorizationException {
    expect(source.includes(before) || authoritySource.includes(before)).toBe(true)
    const transform = (content: string, imports: Record<string, unknown>) => {
      const code = ts.transpileModule(content.replace(before, after), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
      const exports: Record<string, unknown> = {}
      new Function('require','exports',code)((id: string) => { if (!(id in imports)) throw new Error(id); return imports[id] }, exports)
      return exports
    }
    const predicate = authoritySource.includes(before) ? transform(authoritySource, {
      '../directory/access-graph-mutex': mutex, './platform-actor-authority': authority,
      '../rbac/authorization-input-brand': brand, '../rbac/authorization-input-lock': kernel,
    }) : exceptionAuthority
    return transform(source, {'../directory/access-graph-mutex':mutex, './direct-permission-authority':predicate, './legacy-permission-revoke':legacy}).writeAuthorizationException as typeof writeAuthorizationException
  }
  it('detects removal of target, before-image, catalog, and acknowledgement guards', async () => {
    const probes: Array<{ label: string; before: string; after: string; setup: (f: ReturnType<typeof fixture>) => void }> = [
      { label: 'actor identity', before: 'actor.id !== context.actorId', after: 'false', setup: f => { f.rows.set('actor', user('other')) } },
      { label: 'target identity', before: 'target.id !== context.userId', after: 'false', setup: f => { f.rows.set('target', user('other')) } },
      { label: 'target recycle', before: 'if (target.deletedAt || target.purgedAt)', after: 'if (false)', setup: f => { f.rows.set('target', { ...user('target'), deletedAt: 'now' }) } },
      { label: 'direct before-image', before: "JSON.stringify([...currentCodes].sort()) !== JSON.stringify([...expected].sort())", after: 'false', setup: f => { f.input.expectedDirectCodes = [] } },
      { label: 'catalog', before: "JSON.stringify([...found].sort()) !== JSON.stringify([...requested].sort())", after: 'false', setup: f => { f.input.action = { kind: 'direct.grant', code: 'missing' } } },
      { label: 'acknowledged count', before: 'rowCount !== 1', after: 'false', setup: f => { f.setBadReturn('count') } },
      { label: 'acknowledged code', before: 'result.rows[0]?.permission_code !== code', after: 'false', setup: f => { f.setBadReturn('code') } },
      { label: 'acknowledged target', before: "result.rows[0]?.user_id !== userId", after: 'false', setup: f => { f.setBadReturn() } },
    ]
    for (const probe of probes) {
      const f = fixture(); probe.setup(f)
      let rejected = false
      try { await mutant(probe.before, probe.after)(f.client, Object.freeze({ ...f.input })) } catch { rejected = true }
      expect(rejected, `mutant ${probe.label} should escape its original rejection`).toBe(false)
      console.log(`MUTATION CAUGHT: ${probe.label}`)
    }
  })
})
