import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

function fixture(resultOverride?: Record<string, unknown>, failure?: Error, qualification = {
  result: 'HOLD', staleWorkerClaimQualified: false,
  holdReason: 'RECOVERY_LOCAL_BACKUP_MANUAL_SCENARIO_PAIR_UNQUALIFIED',
}) {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-backup.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('backup.mts', source, ts.ScriptTarget.ESNext, true)
  const main = parsed.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'main')!
  const assignments: ts.BinaryExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left) && node.left.text === 'result' && ts.isObjectLiteralExpression(node.right)) {
      assignments.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(main)
  expect(assignments).toHaveLength(1)
  const topLevel = parsed.statements.filter(ts.isTryStatement)
  expect(topLevel).toHaveLength(1)
  // Execute the real receipt expression and CLI verdict handling, without native entrypoint IO.
  const receipt = new Function('recoveryLocalBackupRecordCount', 'finalNonces', 'rollbackTableCount', 'manualQualification', 'manualStale',
    `return (${assignments[0]!.right.getText(parsed)})`)(() => 2, Array(10).fill(null), 7, qualification, { rollbackTableCount: 7 }) as Record<string, unknown>
  const program = ts.transpileModule(topLevel[0]!.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  })
  const stdout: Record<string, unknown>[] = []
  const stderr: Record<string, unknown>[] = []
  const processState: { exitCode?: number } = {}
  const run = new Function('main', 'console', 'process',
    `return (async () => { ${program.outputText} })()`)
  return {
    receipt, stdout, stderr, processState,
    run: () => run(async () => {
      if (failure) throw failure
      return resultOverride ?? receipt
    }, {
      log: (value: string) => stdout.push(JSON.parse(value)),
      error: (value: string) => stderr.push(JSON.parse(value)),
    }, processState) as Promise<void>,
  }
}

describe('local backup CLI qualification verdict', () => {
  it('keeps an incomplete scenario pair on HOLD with a failing exit', async () => {
    const f = fixture()
    await f.run()
    expect(f.stdout).toEqual([expect.objectContaining({
      result: 'HOLD',
      holdReason: 'RECOVERY_LOCAL_BACKUP_MANUAL_SCENARIO_PAIR_UNQUALIFIED',
      manualCapturedArchive: expect.objectContaining({ staleTupleCasWrites: 0, staleWorkerClaimQualified: false }),
    })])
    expect(f.receipt.manualCapturedArchive).not.toHaveProperty('staleWorkerCasWrites')
    expect(f.processState.exitCode).toBe(1)
    expect(f.stderr).toEqual([])
  })

  it('qualifies the real receipt expression only when the pair qualifies', async () => {
    const f = fixture(undefined, undefined, { result: 'PASS', staleWorkerClaimQualified: true,
      holdReason: 'unused' })
    await f.run()
    expect(f.stdout).toEqual([expect.objectContaining({ result: 'PASS',
      manualCapturedArchive: expect.objectContaining({ staleWorkerClaimQualified: true,
        sameBackupDistinctTargets: true, acceptanceScenarios: ['process-crash', 'stale-worker'] }),
    })])
    expect(f.stdout[0]).not.toHaveProperty('holdReason')
    expect(f.processState.exitCode).toBeUndefined()
  })

  it('leaves a PASS verdict successful', async () => {
    const f = fixture({ result: 'PASS' })
    await f.run()
    expect(f.stdout).toEqual([{ result: 'PASS' }])
    expect(f.processState.exitCode).toBeUndefined()
    expect(f.stderr).toEqual([])
  })

  it.each([{}, { result: 'UNKNOWN' }])('fails closed for an incomplete or unknown verdict', async result => {
    const f = fixture(result)
    await f.run()
    expect(f.stdout).toEqual([result])
    expect(f.processState.exitCode).toBe(1)
    expect(f.stderr).toEqual([])
  })

  it('preserves classified failures and their failing exit', async () => {
    const f = fixture(undefined, new Error('RECOVERY_LOCAL_BACKUP_SYNTHETIC_FAILURE'))
    await f.run()
    expect(f.stdout).toEqual([])
    expect(f.stderr).toEqual([{ result: 'FAIL', code: 'RECOVERY_LOCAL_BACKUP_SYNTHETIC_FAILURE', frames: [] }])
    expect(f.processState.exitCode).toBe(1)
  })
})
