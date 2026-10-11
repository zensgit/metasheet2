import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { finishSeededRecoveryLocalControl } from '../../scripts/verify-recovery-local-seeded-control'
import type { ArchiveProcessWorkerInput, ArchiveProcessWorkerMessage } from '../utils/recovery-archive-process-worker'

function driverFixture() {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-backup.mts', import.meta.url), 'utf8')
  const start = source.indexOf('    const localWorkerInput:')
  const end = source.indexOf('    const manualQualification =', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  // Execute the real driver's ordered control/manual statements, never its native top level.
  const program = ts.transpileModule(`async function run() {\n${source.slice(start, end)}\n}\nrun`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  })
  const calls: string[] = []
  const done = new Set<string>()
  const drained = new Set<string>()
  const expectedRestoredRows = [{ id: 'control-row', data: { value: 'archived' }, version: 3 }]
  const manualSourceLiveRows = [{ id: 'manual-row', data: { value: 'captured' }, version: 1 }]
  const manualSourceNonces = [{ section_name: 'records' }]
  const copiedBackup = new Uint8Array([1, 2])
  const names = { source: 'source', target: 'target', staleTarget: 'stale-target' }
  const runtime = (name: string) => ({ name, query: async (sql: string) => ({ rows:
    sql.includes('SELECT id, data, version') ? expectedRestoredRows
      : sql.includes('exact_once') ? [{ count: 5001 }] : [{ state: 'done',
        completed_count: '5001', recovery_writer_state: null, restore_events: 5001,
        effects: 5001, completed_effects: 5001 }] }), depth: {} })
  const targetRuntime = runtime(names.target)
  const runWorker = async (input: { phase: string }, url: URL) => {
    const name = url.pathname.slice(1)
    calls.push(`${name}:${input.phase}`)
    if (input.phase === 'finish') {
      done.add(name)
      return { kind: 'done', outcome: { kind: 'completed', swept: 0, chunks: 2 },
        terminal: { state: 'done', completedCount: '5001' }, lifecycle: ['started', 'drained'] }
    }
    assert.ok(done.has(name))
    drained.add(name)
    return { kind: 'drained', attempts: 5001, completed: 5001, lifecycle: ['started', 'drained'] }
  }
  const context = {
    assert: { ...assert, deepEqual: (actual: unknown, expected: unknown) => expect(actual).toEqual(expected) },
    join, names, targetRuntime, staleTargetRuntime: undefined,
    targetUrl: new URL('postgresql://synthetic@127.0.0.1:9/target'),
    staleTargetUrl: new URL('postgresql://synthetic@127.0.0.1:9/stale-target'),
    targetArchive: '/synthetic/target/archive', targetCustody: '/synthetic/target/custody',
    targetAttachmentPath: '/synthetic/target/attachments', staleTargetRoot: '/synthetic/stale-target',
    staleTargetArchive: '/synthetic/stale-target/archive', staleTargetCustody: '/synthetic/stale-target/custody',
    sourceUrl: {}, sourceArchive: '', sourceCustody: '', admin: {}, prefix: 'synthetic',
    targetDatabaseIdentity: { oid: '11' }, sourceDatabaseIdentity: { oid: '10' },
    storeId: 'store', custodyId: 'custody', rotatedReceipt: {}, copiedBackup, recoverySecret: new Uint8Array(32),
    backupDigest: 'a'.repeat(64), fixture: { archivedKeyId: 'key', jobId: 'control', fixture: { sheetId: 'control-sheet' } },
    manual: { sheetId: 'manual-sheet', generationId: 'generation', recordIds: ['manual-row'], attachmentBytes: new Uint8Array([3]) },
    manualSourceLiveRows, manualSourceNonces, expectedRestoredRows, runWorker,
    readLiveRows: async (_query: unknown, sheet: string) => sheet === 'control-sheet' ? expectedRestoredRows : manualSourceLiveRows,
    readNonceTuples: async () => manualSourceNonces, assertPathMissing: async () => {}, assertSourceUnavailable: async () => {},
    createDatabaseRuntime: () => runtime(names.staleTarget), databaseIdentity: async () => ({ name: names.staleTarget, oid: '12' }),
    readFile: async () => 'store', createLocalCustodyStore: async () => ({ readBackup: async () => copiedBackup }),
    finishSeededRecoveryLocalControl,
    runManualTargetChild: async (input: { databaseName: string; scenario: string }) => {
      // Mirrors the production selector: the older planned seeded job wins until completed.
      assert.ok(done.has(input.databaseName), 'CONTROL_TASK_SELECTED_BEFORE_MANUAL')
      assert.ok(drained.has(input.databaseName), 'CONTROL_DERIVED_WORK_REMAINED')
      calls.push(`${input.databaseName}:${input.scenario}`)
      return { databaseOid: input.databaseName === names.target ? '11' : '12' }
    },
  }
  return { run: new Script(program.outputText).runInNewContext(context) as () => Promise<void>, calls }
}

describe('same-backup seeded control ordering', () => {
  it('finishes and drains each imported control before that target admits the manual scenario', async () => {
    const f = driverFixture()
    await f.run()
    expect(f.calls).toEqual(['target:finish', 'target:drain', 'target:process-crash',
      'stale-target:finish', 'stale-target:drain', 'stale-target:stale-worker'])
  })
})

describe('seeded control proof', () => {
  it.each(['finish-kind', 'chunks', 'terminal', 'drain-kind', 'drain-count', 'rows', 'effects', 'once'])(
    'refuses incomplete %s evidence', async mode => {
      const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
        expect(values).toEqual([sql.includes('job.id=') ? 'control' : 'control-sheet'])
        if (sql.includes('SELECT id, data, version')) return { rows: mode === 'rows' ? [] : [{ id: 'row', data: {}, version: 3 }], rowCount: 1 }
        if (sql.includes('exact_once')) return { rows: [{ count: mode === 'once' ? 5000 : 5001 }], rowCount: 1 }
        return { rows: [{ state: 'done', completed_count: '5001', recovery_writer_state: null,
          restore_events: 5001, effects: 5001, completed_effects: mode === 'effects' ? 5000 : 5001 }], rowCount: 1 }
      })
      const worker = vi.fn(async (input: Omit<ArchiveProcessWorkerInput, 'applicationName'>) => {
        expect(input.jobId).toBe('control')
        expect(input.keyId).toBe('key')
        if (input.phase === 'finish') return { kind: mode === 'finish-kind' ? 'error' : 'done',
          outcome: { kind: 'completed', swept: 0, chunks: mode === 'chunks' ? 1 : 2 },
          terminal: { state: mode === 'terminal' ? 'applying' : 'done', completedCount: '5001' }, lifecycle: ['started', 'drained'] } as ArchiveProcessWorkerMessage
        expect(input.drainTicks).toBe(158)
        return { kind: mode === 'drain-kind' ? 'error' : 'drained', attempts: 5001,
          completed: mode === 'drain-count' ? 5000 : 5001, lifecycle: ['started', 'drained'] } as ArchiveProcessWorkerMessage
      })
      await expect(finishSeededRecoveryLocalControl({ query, runWorker: worker, jobId: 'control',
        keyId: 'key', sheetId: 'control-sheet', expectedRestoredRows: [{ id: 'row', data: {}, version: 3 }],
        local: { archivePath: '/synthetic/archive', custodyPath: '/synthetic/custody', custodyId: 'custody',
          storeId: 'store', receipt: {} as NonNullable<ArchiveProcessWorkerInput['local']>['receipt'],
          recoverySecret: new Uint8Array(32) } })).rejects.toThrow()
    })
})

function workerAdmissionFixture() {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-backup.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('backup.mts', source, ts.ScriptTarget.ESNext, true)
  const fn = parsed.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'runWorker')!
  expect(fn).toBeDefined()
  const program = ts.transpileModule(`${fn.getText(parsed)}\nrunWorker`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  })
  const names = { target: 'owned-target', staleTarget: 'owned-stale-target' }
  const targetUrl = new URL('postgresql://synthetic@127.0.0.1:9/owned-target')
  const staleTargetUrl = new URL('postgresql://synthetic@127.0.0.1:9/owned-stale-target')
  const fork = vi.fn(() => { throw new Error('SYNTHETIC_FORK_BOUNDARY') })
  const run = new Script(program.outputText).runInNewContext({ assert, join, randomUUID, fork,
    names, targetUrl, staleTargetUrl, args: { workRoot: '/synthetic' }, prefix: 'synthetic',
    workerPath: '/synthetic/worker', require: { resolve: () => 'synthetic-tsx' }, process: { env: {} },
    jwtSecret: 'synthetic-test-secret' }) as
    (input: { expectedDatabaseName: string; local: { archivePath: string; custodyPath: string } }, url: URL) => Promise<unknown>
  return { run, fork, names, targetUrl, staleTargetUrl }
}

describe('seeded worker target admission', () => {
  it.each(['target', 'staleTarget'] as const)('admits only the matching %s database and exact roots', async role => {
    const f = workerAdmissionFixture()
    const root = role === 'target' ? 'target' : 'stale-target'
    await expect(f.run({ expectedDatabaseName: f.names[role],
      local: { archivePath: `/synthetic/${root}/archive`, custodyPath: `/synthetic/${root}/custody` } },
    role === 'target' ? f.targetUrl : f.staleTargetUrl)).rejects.toThrow('SYNTHETIC_FORK_BOUNDARY')
    expect(f.fork).toHaveBeenCalledTimes(1)
  })
  it.each(['foreign-url', 'wrong-name', 'source-url', 'cross-archive', 'cross-custody', 'root-alias'])(
    'refuses %s before spawning a child', async mode => {
      const f = workerAdmissionFixture()
      const input = { expectedDatabaseName: mode === 'wrong-name' ? f.names.staleTarget : f.names.target,
        local: { archivePath: mode === 'cross-archive' ? '/synthetic/stale-target/archive'
          : mode === 'root-alias' ? '/synthetic/target/archive/../archive' : '/synthetic/target/archive',
        custodyPath: mode === 'cross-custody' ? '/synthetic/stale-target/custody' : '/synthetic/target/custody' } }
      const url = mode === 'foreign-url' ? new URL('postgresql://synthetic@127.0.0.1:10/owned-target')
        : mode === 'source-url' ? new URL('postgresql://synthetic@127.0.0.1:9/source') : f.targetUrl
      await expect(f.run(input, url)).rejects.toThrow('RECOVERY_LOCAL_BACKUP_WORKER_')
      expect(f.fork).not.toHaveBeenCalled()
    })
})
