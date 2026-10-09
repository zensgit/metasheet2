import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

function verifier(kind: 'import' | 'custody', context: Record<string, unknown>) {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-backup.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('backup.mts', source, ts.ScriptTarget.ESNext, true)
  const main = parsed.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'main')
  const body = main?.body?.statements.find(ts.isTryStatement)?.tryBlock.statements
  expect(body).toBeDefined()
  const variable = (statement: ts.Statement, name: string) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === name)
  const start = body!.findIndex(statement => kind === 'import'
    ? ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && statement.expression.left.getText(parsed) === 'targetRuntime'
    : variable(statement, 'finalNonces'))
  const end = body!.findIndex(statement => kind === 'import'
    ? variable(statement, 'targetProvider')
    : ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && statement.expression.left.getText(parsed) === 'result')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  // Exercise the driver's actual verification blocks without its native IO entrypoint.
  const program = ts.transpileModule(`async function verify() {\n${body!.slice(start, end)
    .map(statement => statement.getText(parsed)).join('\n')}\n}\nverify`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  })
  const sections = Array.from({ length: 10 }, (_, index) => `section${index}`)
  const sandbox = createContext({
    assert, prefix: 'synthetic', targetUrl: {}, names: { target: 'synthetic_target' },
    targetRuntime: undefined, createDatabaseRuntime: () => ({ query: () => {} }),
    databaseIdentity: async () => ({ name: 'synthetic_target', oid: '2' }), sourceDatabaseIdentity: { oid: '1' },
    fixture: { fixture: { generationId: 'fixture-generation', sheetId: 'fixture-sheet' } },
    manual: { sheetId: 'manual-sheet' }, RECOVERY_ARCHIVE_V1_SECTION_NAMES: sections,
    hashRows: () => 'fixture-hash', sourceLiveHash: 'fixture-hash',
    ...context,
  })
  sandbox.sourceNonces = new Script('Array.from(RECOVERY_ARCHIVE_V1_SECTION_NAMES, section_name => ({ section_name }))')
    .runInContext(sandbox)
  sandbox.readNonceTuples = async () => sandbox.sourceNonces
  return new Script(program.outputText).runInContext(sandbox) as () => Promise<void>
}

describe('local backup manual import witness', () => {
  const sourceRows = Array.from({ length: 5001 }, (_, index) => ({
    id: `record-${String(index).padStart(5, '0')}`, version: 1,
    data: { scalar: 'captured', file: index === 0 ? ['archived-attachment'] : [] },
  }))
  function run(rows: typeof sourceRows) {
    return verifier('import', {
      manualSourceLiveRows: sourceRows,
      readLiveRows: async (_query: unknown, sheetId: string) => sheetId === 'manual-sheet' ? rows : [],
    })()
  }
  it('accepts the same complete manual rows while the other fixture remains independently valid', async () => {
    await expect(run(structuredClone(sourceRows))).resolves.toBeUndefined()
  })
  it.each(['scalar', 'version', 'attachment', 'count'] as const)('refuses a changed manual import %s', async kind => {
    const rows = structuredClone(sourceRows)
    if (kind === 'scalar') rows[2000].data.scalar = 'changed'
    else if (kind === 'version') rows[2000].version++
    else if (kind === 'attachment') rows[0].data.file = []
    else rows.pop()
    await expect(run(rows)).rejects.toThrow(kind === 'count'
      ? 'RECOVERY_LOCAL_BACKUP_MANUAL_IMPORT_COUNT_MISMATCH'
      : 'RECOVERY_LOCAL_BACKUP_MANUAL_IMPORT_ROWS_MISMATCH')
  })
})

describe('local backup final custody witness', () => {
  it.each(['same', 'store', 'backup'] as const)('verifies retained custody after workers: %s', async kind => {
    const backup = new Uint8Array([1, 2, 3])
    const receipt = { receiptId: 'synthetic-receipt' }
    const run = verifier('custody', {
      targetRuntime: { query: () => {} }, targetArchive: '/synthetic-owned/target/archive', storeId: 'synthetic-store',
      join: (...parts: string[]) => parts.join('/'), readFile: async (file: string, encoding: string) => {
        expect(file).toBe('/synthetic-owned/target/archive/.metasheet-archive-root')
        expect(encoding).toBe('utf8')
        return kind === 'store' ? 'changed-store' : 'synthetic-store'
      },
      copiedBackup: backup, rotatedReceipt: receipt,
      targetCustodyStore: { readBackup: async (input: unknown) => {
        expect(input).toBe(receipt)
        return kind === 'backup' ? new Uint8Array([1, 2, 4]) : backup
      } },
    })
    if (kind === 'same') await expect(run()).resolves.toBeUndefined()
    else await expect(run()).rejects.toThrow(kind === 'store'
      ? 'RECOVERY_LOCAL_BACKUP_STORE_ID_CHANGED'
      : 'RECOVERY_LOCAL_BACKUP_CUSTODY_BACKUP_CHANGED')
  })
})
