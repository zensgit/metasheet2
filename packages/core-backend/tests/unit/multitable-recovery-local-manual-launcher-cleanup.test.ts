import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import * as ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class Launcher extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []
  constructor(private readonly stopsOn: NodeJS.Signals | null) { super() }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal)
    if (signal === this.stopsOn) {
      this.exitCode = signal === 'SIGTERM' ? 0 : null
      this.signalCode = signal === 'SIGKILL' ? signal : null
      this.emit('exit', this.exitCode, this.signalCode)
    }
    return true
  }
}

function stopLauncher() {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-manual-target.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('manual-target.mts', source, ts.ScriptTarget.ESNext, true)
  const functions = parsed.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'stopLauncher')
  expect(functions.length).toBe(1)
  const program = ts.transpileModule(`${functions[0]!.getText(parsed)}\nstopLauncher`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  })
  // Run the actual private stop helper with simulated processes and time only.
  return new Script(program.outputText).runInNewContext({ assert, setTimeout, clearTimeout }) as
    (child: Launcher, requireGraceful: boolean) => Promise<void>
}

describe('local manual target launcher cleanup', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('accepts an already completed graceful launcher without sending a signal', async () => {
    const child = new Launcher(null)
    child.exitCode = 0
    await expect(stopLauncher()(child, true)).resolves.toBeUndefined()
    expect(child.signals).toEqual([])
  })

  it('accepts a graceful SIGTERM exit and clears its stop timer', async () => {
    const child = new Launcher('SIGTERM')
    await expect(stopLauncher()(child, true)).resolves.toBeUndefined()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('kills and confirms a launcher that ignored SIGTERM during cleanup', async () => {
    const child = new Launcher('SIGKILL')
    const result = expect(stopLauncher()(child, false)).resolves.toBeUndefined()
    void result.catch(() => {})
    await vi.advanceTimersByTimeAsync(60_000)
    await result
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.signalCode).toBe('SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses graceful success after escalation even though the launcher exited', async () => {
    const child = new Launcher('SIGKILL')
    const result = expect(stopLauncher()(child, true)).rejects.toThrow('RECOVERY_LOCAL_BACKUP_MANUAL_STOP_TIMEOUT')
    void result.catch(() => {})
    await vi.advanceTimersByTimeAsync(60_000)
    await result
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.signalCode).toBe('SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses cleanup if exit is still unconfirmed after escalation', async () => {
    const child = new Launcher(null)
    const result = expect(stopLauncher()(child, false)).rejects.toThrow('RECOVERY_LOCAL_BACKUP_MANUAL_STOP_TIMEOUT')
    void result.catch(() => {})
    await vi.advanceTimersByTimeAsync(70_000)
    await result
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: null, signal: null })
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
