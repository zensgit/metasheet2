import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { recoveryLocalBackupDatabaseNames } from '../utils/recovery-local-backup-driver-safety'

function fixture(failIdentity = false) {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-backup.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('backup.mts', source, ts.ScriptTarget.ESNext, true)
  const functions = parsed.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && ['createOwnedDatabase', 'quoteIdentifier'].includes(statement.name?.text ?? ''))
  expect(functions.map(fn => fn.name!.text).sort()).toEqual(['createOwnedDatabase', 'quoteIdentifier'])
  const program = ts.transpileModule(`${functions.map(fn => fn.getText(parsed)).join('\n')}\ncreateOwnedDatabase`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  })
  const names = recoveryLocalBackupDatabaseNames('0123456789abcdef')
  const context = { assert, names, ownedDatabases: new Map(),
    sourceCreated: false, targetCreated: false, staleTargetCreated: false }
  const query = vi.fn(async (sql: string, values?: readonly string[]) => {
    if (sql.includes('WHERE d.datname=$1')) {
      if (failIdentity) throw new Error('SYNTHETIC_IDENTITY_READ_FAILED')
      return { rows: [{ name: values![0], oid: '17001', owner: 'tm_backup_owner', system_identifier: '9001' }] }
    }
    if (sql.startsWith('SELECT system_identifier')) return { rows: [{ system_identifier: '9001' }] }
    return { rows: [] }
  })
  // Execute the real private creator; its native top-level driver never runs.
  const create = new Script(program.outputText).runInNewContext(context) as
    (admin: { query: typeof query }, name: string, owner: string) => Promise<void>
  return { context, names, query, create: (name: string) => create({ query }, name, 'tm_backup_owner') }
}

describe('local backup database admission', () => {
  it.each(['source', 'target', 'staleTarget'] as const)('admits and registers only the owned %s database', async role => {
    const f = fixture()
    const name = f.names[role]
    await expect(f.create(name)).resolves.toBeUndefined()
    expect(f.query.mock.calls.map(([sql]) => sql.split(' ')[0])).toEqual(['SELECT', 'CREATE', 'SELECT', 'REVOKE'])
    expect(f.query.mock.calls[1][0]).toBe(`CREATE DATABASE "${name}" OWNER "tm_backup_owner"`)
    expect([...f.context.ownedDatabases]).toEqual([[name,
      { name, oid: '17001', owner: 'tm_backup_owner', system_identifier: '9001' }]])
    expect({ source: f.context.sourceCreated, target: f.context.targetCreated, staleTarget: f.context.staleTargetCreated })
      .toEqual({ source: role === 'source', target: role === 'target', staleTarget: role === 'staleTarget' })
  })

  it.each(['unrelated', 'tm_local_backup_ffffffffffffffff_stale_target',
    'tm_local_backup_0123456789abcdef_target_alias'])('refuses an unowned database before SQL', async name => {
    const f = fixture()
    await expect(f.create(name)).rejects.toThrow('RECOVERY_LOCAL_BACKUP_DATABASE_NAME_REFUSED')
    expect(f.query).not.toHaveBeenCalled()
    expect([...f.context.ownedDatabases]).toEqual([])
  })

  it('refuses duplicate admission before issuing CREATE', async () => {
    const f = fixture()
    f.context.ownedDatabases.set(f.names.staleTarget, { oid: '17001' })
    await expect(f.create(f.names.staleTarget)).rejects.toThrow('RECOVERY_LOCAL_BACKUP_DATABASE_ALREADY_REGISTERED')
    expect(f.query).not.toHaveBeenCalled()
  })

  it('tracks a created stale target even when the following identity read fails', async () => {
    const f = fixture(true)
    await expect(f.create(f.names.staleTarget)).rejects.toThrow('SYNTHETIC_IDENTITY_READ_FAILED')
    expect(f.query.mock.calls.map(([sql]) => sql.split(' ')[0])).toEqual(['SELECT', 'CREATE', 'SELECT'])
    expect(f.context.staleTargetCreated).toBe(true)
    expect([...f.context.ownedDatabases]).toEqual([])
  })
})
