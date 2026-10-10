import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { createLocalCustodyBackup, createLocalCustodySession } from '../../src/multitable/recovery-local-custody'

function fixture(failAt: 'load' | 'capture') {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-backup.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('backup.mts', source, ts.ScriptTarget.ESNext, true)
  const functions = parsed.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'main')
  expect(functions).toHaveLength(1)
  // Run only the real main function with all process, database and filesystem IO replaced.
  const program = ts.transpileModule(`${functions[0].getText(parsed)}\nmain`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  })
  const failure = new Error('synthetic backup failure')
  const secret = new Uint8Array(32).fill(1)
  const sessions: Array<ReturnType<typeof createLocalCustodySession>> = []
  const dropped: string[] = []
  const poolObservations: Array<{ locked: boolean; secretScrubbed: boolean }> = []
  const probe = { currentTransactionDepth: () => 0 }
  const args = { workRoot: '/synthetic-owned', pgdata: '/synthetic-pgdata',
    adminUrl: new URL('postgresql://synthetic@127.0.0.1:9/postgres') }
  class Admin {
    async query() { return { rows: [{ database_name: 'postgres', owner: 'synthetic', data_directory: args.pgdata }] } }
    async end() {}
  }
  const runtime = () => ({
    depth: probe, query: async () => ({ rows: [] }), transaction: async () => {},
    pool: { async end() {
      if (sessions.length) poolObservations.push({
        locked: sessions.every(session => !session.isUnlocked()),
        secretScrubbed: secret.every(byte => byte === 0),
      })
    } },
  })
  const run = new Script(program.outputText).runInNewContext({
    assert, randomUUID, args, prefix: 'synthetic', process: { env: { NODE_ENV: 'test' } },
    names: { source: 'synthetic_source', target: 'synthetic_target', staleTarget: 'synthetic_stale_target' }, sourceUrl: args.adminUrl,
    targetUrl: args.adminUrl, staleTargetUrl: args.adminUrl, recoverySecret: secret, PgPool: Admin,
    RECOVERY_ARCHIVE_V1_SECTION_NAMES: Array.from({ length: 10 }, (_, index) => `section${index}`),
    children: new Set(), custodySessions: new Set(), sourceCreated: false, targetCreated: false, staleTargetCreated: false,
    sourceRuntime: undefined, targetRuntime: undefined, staleTargetRuntime: undefined, workRootCreated: false,
    loadRuntimeDependencies: async () => { if (failAt === 'load') throw failure },
    assertPathMissing: async () => {}, mkdir: async () => {}, rm: async () => {},
    assertOwnedPrivateDirectory: async (value: string) => ({ realPath: value }),
    assertDistinctDirectoryIdentities: () => {}, realpath: async (value: string) => value,
    databaseCount: async () => 0, backendCount: async () => 0, existingPathCount: async () => 0,
    createOwnedDatabase: async () => {}, dropOwnedDatabase: async (_admin: unknown, name: string) => { dropped.push(name) }, assertDatabaseOwner: async () => {},
    createDatabaseRuntime: runtime, databaseIdentity: async () => ({ name: 'synthetic_source' }),
    userTableCount: async () => 0, runChecked: () => {},
    join: (...parts: string[]) => parts.join('/'), provisionRecoveryArchiveFileRoot: async () => {},
    createRecoveryArchiveFileStoreProvider: async () => ({}),
    createLocalCustodyStore: async () => ({ putBackup: async () => ({}) }), createLocalCustodyBackup,
    createLocalCustodySession: () => {
      const session = createLocalCustodySession(probe)
      sessions.push(session)
      return session
    },
    createRecoveryArchiveLocalBackupFixture: async () => { throw failure },
  }) as () => Promise<unknown>
  return { run, failure, secret, sessions, poolObservations, dropped }
}

describe('local backup custody cleanup', () => {
  it.each(['load', 'capture'] as const)('scrubs custody before IO cleanup after %s failure', async failAt => {
    const f = fixture(failAt)
    try {
      await expect(f.run()).rejects.toBe(f.failure)
      expect(f.secret.every(byte => byte === 0)).toBe(true)
      expect(f.sessions).toHaveLength(failAt === 'capture' ? 1 : 0)
      expect(f.dropped).toEqual(failAt === 'capture'
        ? ['synthetic_source', 'synthetic_target', 'synthetic_stale_target'] : [])
      expect(f.sessions.every(session => !session.isUnlocked())).toBe(true)
      expect(f.poolObservations).toEqual(failAt === 'capture' ? [{ locked: true, secretScrubbed: true }] : [])
    } finally {
      f.sessions.forEach(session => session.lock())
      f.secret.fill(0)
    }
  })
})
