import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

class Worker extends EventEmitter {
  exitCode: number | null = null
  signalCode = null
  constructor(private readonly result: number) { super() }
  send(_input: unknown, callback: (error: Error | null) => void) {
    queueMicrotask(() => {
      callback(null)
      this.emit('message', { kind: 'manual-target-done', rollbackTableCount: 6 })
      this.exitCode = this.result
      this.emit('exit', this.result, null)
    })
  }
}

function fixture(exitCode: number) {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-backup.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('backup.mts', source, ts.ScriptTarget.ESNext, true)
  const names = ['runManualTargetChild', 'waitForChildExit']
  const functions = parsed.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ''))
  expect(functions.map(fn => fn.name!.text).sort()).toEqual([...names].sort())
  // Execute the real private functions without the native script's top-level entrypoint.
  const program = ts.transpileModule(`${functions.map(fn => fn.getText(parsed)).join('\n')}\nrunManualTargetChild`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  })
  const child = new Worker(exitCode)
  const children = new Set<Worker>()
  const run = new Script(program.outputText).runInNewContext({
    assert, fork: () => child, children, setTimeout, clearTimeout,
    require: { resolve: () => 'tsx/cjs' }, process: { env: {} },
    args: { workRoot: '/synthetic-owned' }, manualTargetPath: '/synthetic-owned/worker',
    targetAttachmentPath: '/synthetic-owned/target/attachments', jwtSecret: 'synthetic-only',
  }) as (input: { local: { archivePath: string; custodyPath: string; recoverySecret: Uint8Array } }, url: URL) => Promise<number>
  return { run, child, children }
}

describe('local backup parent process cleanup', () => {
  it.each([0, 1])('scrubs its secret copy when the worker exits with %i', async exitCode => {
    const f = fixture(exitCode)
    const recoverySecret = new Uint8Array(32).fill(1)
    const input = { local: { archivePath: '/synthetic-owned/target/archive',
      custodyPath: '/synthetic-owned/target/custody', recoverySecret } }
    const operation = f.run(input, new URL('postgresql://synthetic@127.0.0.1:9/synthetic'))
    if (exitCode === 0) await expect(operation).resolves.toBe(6)
    else await expect(operation).rejects.toThrow('RECOVERY_LOCAL_BACKUP_WORKER_STOP_FAILED')
    expect(recoverySecret.every(byte => byte === 0)).toBe(true)
    expect(f.children.has(f.child)).toBe(exitCode !== 0)
  })
})
