import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { createLocalCustodyBackup, createLocalCustodySession } from '../../src/multitable/recovery-local-custody'

function fixture(outcome: 'expected' | 'unexpected' | 'accepted') {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-backup.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('backup.mts', source, ts.ScriptTarget.ESNext, true)
  const functions = parsed.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && ['main', 'runFailClosedNegatives', 'readCode'].includes(statement.name?.text ?? ''))
  expect(functions).toHaveLength(3)
  const body = functions.find(fn => fn.name!.text === 'main')!.body!.statements
  const start = body.findIndex(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === 'cleanupFailures'))
  const end = body.findIndex(statement => ts.isForOfStatement(statement)
    && statement.expression.getText(parsed) === '[...children]')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  // Exercise the actual negative helper and main's synchronous custody cleanup, with all IO replaced.
  const program = ts.transpileModule(`${functions.filter(fn => fn.name!.text !== 'main')
    .map(fn => fn.getText(parsed)).join('\n')}
async function run(input) {
  try { await runFailClosedNegatives(input) }
  finally { ${body.slice(start + 1, end).map(statement => statement.getText(parsed)).join('\n')} }
}
run`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } })
  class PreviewError extends Error { code = 'RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND' }
  class ReaderError extends Error { code = 'RECOVERY_ARCHIVE_READER_KEY_CUSTODY_FAILED' }
  const probe = { currentTransactionDepth: () => 0 }
  const secret = new Uint8Array(32).fill(1)
  const custodyId = randomUUID()
  const backup = createLocalCustodyBackup({ custodyId, recoverySecret: secret, transactionDepth: probe })
  const sessions: Array<ReturnType<typeof createLocalCustodySession>> = []
  const readerFailure = new Error('synthetic unexpected reader failure')
  const laterFailure = new Error('synthetic later provider failure')
  let readerCalls = 0
  const client = { query: async () => ({ rows: [] }), release() {} }
  const run = new Script(program.outputText).runInNewContext({
    assert, randomBytes, randomUUID, recoverySecret: secret, custodySessions: new Set(),
    readLiveRows: async () => [], hashRows: () => 'synthetic-hash', authorityInput: () => ({}),
    loadRecoveryArchiveAuthorityInternal: async () => { throw new PreviewError() },
    RecoveryArchivePreviewErrorClass: PreviewError, RecoveryArchiveReaderErrorClass: ReaderError,
    loadAuthority: async () => ({ selectedBinding: {}, manifestObject: {}, sectionObjects: [] }),
    createLocalCustodyBackup, createLocalCustodyStore: async () => ({ readBackup: async () => backup }),
    createLocalCustodySession: () => {
      const session = createLocalCustodySession(probe)
      sessions.push(session)
      return session
    },
    readRecoveryArchiveCompleteSectionState: async () => {
      readerCalls++
      if (outcome === 'expected') throw new ReaderError()
      if (outcome === 'unexpected') throw readerFailure
      return {}
    },
    createRecoveryArchiveFileStoreProvider: async () => { throw laterFailure },
  }) as (input: unknown) => Promise<void>
  const input = {
    runtime: { query: async () => ({ rows: [] }), pool: { connect: async () => client }, depth: probe },
    fixture: { fixture: { sheetId: 'synthetic-sheet' }, jobId: 'synthetic-job' },
    custodyId, receipt: {}, recoverySecret: secret, sourceLiveHash: 'synthetic-hash',
  }
  return { run: () => run(input), sessions, secret, readerFailure, laterFailure, readerCalls: () => readerCalls }
}

describe('local backup negative-test custody cleanup', () => {
  it.each(['expected', 'unexpected', 'accepted'] as const)('locks temporary custody when the reader outcome is %s', async outcome => {
    const f = fixture(outcome)
    try {
      const failure = await f.run().catch(error => error)
      expect(failure).toMatchObject({ code: 'ERR_ASSERTION' })
      if (outcome !== 'accepted') expect(failure.actual).toBe(outcome === 'expected' ? f.laterFailure : f.readerFailure)
      expect(f.readerCalls()).toBe(1)
      expect(f.sessions).toHaveLength(2)
      expect(f.secret.every(byte => byte === 0)).toBe(true)
      expect(f.sessions.every(session => !session.isUnlocked())).toBe(true)
    } finally {
      f.sessions.forEach(session => session.lock())
      f.secret.fill(0)
    }
  })
})
