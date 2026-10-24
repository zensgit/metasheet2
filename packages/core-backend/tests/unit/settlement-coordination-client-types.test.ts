/**
 * Codex S3-CX-06 / S1 note 6, compile-time half: the coordination primitives and the coordinator's pool
 * contract accept only clients that report pg's command tag (and, for the pool, that can report
 * connection errors). The project's tsc run excludes test files, so this test compiles a small
 * in-memory program against the real modules with the project's compiler options and expects zero
 * diagnostics: each negative case carries `@ts-expect-error`, so a case that stops failing to compile
 * shows up as an unused-directive error. A real `pg` `PoolClient` is the positive control. The runtime
 * half (BEGIN / COMMIT answered without the expected tag) is in the handover tests.
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import ts from 'typescript'

const BACKEND = path.resolve(__dirname, '../..')
const VIRTUAL = path.join(BACKEND, 'tests/unit/__virtual__/settlement-coordination-client-types.check.ts')

const SNIPPET = `
import type { PoolClient } from 'pg'
import {
  commitSettlementCoordinationTransactionV1,
  releaseSettlementCoordinationSessionLocksV1,
  rollbackSettlementCoordinationTransactionV1,
  runSettlementCoordinationHandoverV1,
  runSettlementCoordinationS1V1,
  type SettlementCoordinationCredentialV1,
  type SettlementCoordinationPlanV1,
} from '../../../src/attendance/coordination/settlement-coordination-handover'
import type { SettlementCoordinationClientV1, SettlementCoordinationPoolV1 } from '../../../src/attendance/coordination/settlement-coordinator'

type Rows = Array<Record<string, unknown>>
declare const plan: SettlementCoordinationPlanV1
declare const credential: SettlementCoordinationCredentialV1
declare const tagged: { query(sqlText: string, params?: unknown[]): Promise<{ command: string; rows: Rows }> }
declare const rowsOnly: { query(sqlText: string, params?: unknown[]): Promise<{ rows: Rows }> }
const options = { isolation: 'SERIALIZABLE' as const, timeouts: { kind: 'none' as const }, entryLabel: 'types.check' }

void runSettlementCoordinationS1V1(tagged, plan)
void runSettlementCoordinationHandoverV1(tagged, plan, options)
void commitSettlementCoordinationTransactionV1(tagged, credential)
void rollbackSettlementCoordinationTransactionV1(tagged, credential)
void releaseSettlementCoordinationSessionLocksV1(tagged, plan)

// @ts-expect-error S1 needs the command tag
void runSettlementCoordinationS1V1(rowsOnly, plan)
// @ts-expect-error the handover needs the command tag (BEGIN is trusted only on its tag)
void runSettlementCoordinationHandoverV1(rowsOnly, plan, options)
// @ts-expect-error COMMIT is trusted only on its tag
void commitSettlementCoordinationTransactionV1(rowsOnly, credential)
// @ts-expect-error ROLLBACK goes through the same contract
void rollbackSettlementCoordinationTransactionV1(rowsOnly, credential)
// @ts-expect-error the session unlock goes through the same contract
void releaseSettlementCoordinationSessionLocksV1(rowsOnly, plan)

type Listener = (error: unknown) => void
declare const taggedPool: { connect(): Promise<{ query(sqlText: string, params?: unknown[]): Promise<{ command: string; rows: Rows }>; release(error?: unknown): void; on(event: 'error', listener: Listener): unknown; removeListener(event: 'error', listener: Listener): unknown }> }
declare const rowsOnlyPool: { connect(): Promise<{ query(sqlText: string, params?: unknown[]): Promise<{ rows: Rows }>; release(error?: unknown): void; on(event: 'error', listener: Listener): unknown; removeListener(event: 'error', listener: Listener): unknown }> }
declare const silentPool: { connect(): Promise<{ query(sqlText: string, params?: unknown[]): Promise<{ command: string; rows: Rows }>; release(error?: unknown): void }> }

export const okPool: SettlementCoordinationPoolV1 = taggedPool
// @ts-expect-error clients that report no command tag cannot back a coordinator
export const badPool: SettlementCoordinationPoolV1 = rowsOnlyPool
// @ts-expect-error clients that cannot report connection errors cannot back a coordinator
export const silent: SettlementCoordinationPoolV1 = silentPool

declare const pgClient: PoolClient
export const fromPg: SettlementCoordinationClientV1 = pgClient
`

function compilerOptions(): ts.CompilerOptions {
  const configPath = path.join(BACKEND, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  expect(config.error).toBeUndefined()
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, BACKEND)
  return { ...parsed.options, noEmit: true, skipLibCheck: true, types: ['node'] }
}

describe('coordination client contract (compile-time; Codex S3-CX-06)', () => {
  it('the primitives and the pool contract reject clients without the command tag or error events; a pg PoolClient fits', () => {
    const options = compilerOptions()
    const host = ts.createCompilerHost(options, true)
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
      path.resolve(fileName) === VIRTUAL ? ts.createSourceFile(fileName, SNIPPET, languageVersion, true) : getSourceFile(fileName, languageVersion, onError, shouldCreate)
    const fileExists = host.fileExists.bind(host)
    host.fileExists = (fileName) => path.resolve(fileName) === VIRTUAL || fileExists(fileName)
    const program = ts.createProgram({ rootNames: [VIRTUAL], options, host })
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => !diagnostic.file || path.resolve(diagnostic.file.fileName) === VIRTUAL)
      .map((diagnostic) => {
        const line = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 0
        return `${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
      })
    expect(diagnostics).toEqual([])
  }, 60_000)
})
