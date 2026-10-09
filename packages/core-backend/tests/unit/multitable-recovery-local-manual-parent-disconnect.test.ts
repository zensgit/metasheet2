import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import * as ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class Child extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  signals: NodeJS.Signals[] = []
  constructor(readonly stopsOn: NodeJS.Signals | null = 'SIGTERM') { super() }
  send(_message: unknown, callback: (error: Error | null) => void) { callback(null) }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal)
    if (signal === this.stopsOn) queueMicrotask(() => {
      this.exitCode = signal === 'SIGTERM' ? 0 : null
      this.signalCode = signal === 'SIGKILL' ? signal : null
      this.emit('exit', this.exitCode, this.signalCode)
    })
    return true
  }
}

class Parent extends EventEmitter {
  connected: boolean
  exitCode = 0
  env = { NODE_ENV: 'test', MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
    MULTITABLE_ENABLE_WRITER_FENCE: 'true', DATABASE_URL: 'synthetic',
    ATTACHMENT_PATH: '/synthetic/target/attachments', JWT_SECRET: 'synthetic' }
  exit = vi.fn((_code: number) => undefined)
  messages: unknown[] = []
  constructor(connected = true) { super(); this.connected = connected }
  send(message: unknown, _handle: unknown, _options: unknown, callback: (error: Error | null) => void) {
    this.messages.push(message)
    callback(this.connected ? null : new Error('synthetic disconnected channel'))
  }
  disconnect() { this.connected = false; this.emit('disconnect') }
}

function fixture(mode: 'starting' | 'rollback' | 'normal' = 'starting', connected = true,
  stopsOn: NodeJS.Signals | null = 'SIGTERM') {
  const source = readFileSync(new URL('../../scripts/verify-recovery-local-manual-target.mts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('manual-target.mts', source, ts.ScriptTarget.ESNext, true)
  const functions = new Set(['send', 'launch', 'stopLauncher', 'stopLauncherOnce', 'waitForLocked', 'assertParentAttached', 'registerChild', 'onParentDisconnect'])
  if (mode !== 'normal') functions.add('run')
  if (mode === 'rollback') functions.add('probeFlagOff')
  const globals = new Set(['ownedChildren', 'stoppingLaunchers', 'parentCancellation', 'activeSecret', 'runSettled'])
  const statements = parsed.statements.filter(statement => {
    if (ts.isFunctionDeclaration(statement)) return functions.has(statement.name?.text ?? '')
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && globals.has(declaration.name.text))
    return statement.getText(parsed).startsWith("process.once('message'")
      || statement.getText(parsed).startsWith("process.once('disconnect'")
      || statement.getText(parsed).startsWith('if (process.connected === false)')
  })
  const text = `${statements.map(statement => statement.getText(parsed)).join('\n')}\n;({
    stopLauncher, registerChild: typeof registerChild === 'undefined' ? undefined : registerChild,
    parentSignal: typeof parentCancellation === 'undefined' ? undefined : parentCancellation.signal,
  })`
  const parent = new Parent(connected)
  const child = new Child(stopsOn)
  const poolEnd = vi.fn(async () => undefined)
  const poolClose = vi.fn(async () => undefined)
  const spawn = vi.fn(() => child)
  const fork = vi.fn(() => child)
  const writeFile = vi.fn(async () => undefined)
  const query = vi.fn(async () => ({ rows: [{ database_name: 'synthetic_target' }], rowCount: 1 }))
  const run = vi.fn(async () => 6)
  class Pool { query = query; end = poolEnd }
  const context = {
    process: parent, assert, setTimeout, clearTimeout, AbortController,
    backend: '/synthetic', launcher: '/synthetic/start', rollbackWitness: '/synthetic/rollback',
    dirname: () => '/synthetic/target', join: (...parts: string[]) => parts.join('/'),
    spawn, fork, writeFile, reserveLoopbackPort: async () => 1,
    targetEnvironment: () => ({}),
    require: (name: string) => {
      if (name === 'pg') return { Pool }
      if (name.includes('manual-http')) return { restoreImportedManualArchiveOverHttp: vi.fn() }
      if (name.includes('univer-meta')) return { getAttachmentStorageService: vi.fn() }
      if (name.includes('connection-pool')) return { poolManager: { close: poolClose } }
      throw new Error('unexpected synthetic dependency')
    },
    ...(mode !== 'rollback' ? { probeFlagOff: async () => ({ responses: [], tableCount: 6 }) } : {}),
    ...(mode === 'normal' ? { run } : {}),
  }
  const program = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } })
  const api = new Script(program.outputText).runInNewContext(context) as {
    stopLauncher: (child: Child, graceful: boolean) => Promise<void>
    registerChild?: (child: Child) => Child
    parentSignal?: AbortSignal
  }
  const secret = new Uint8Array(32).fill(7)
  const input = { databaseName: 'synthetic_target', local: { archivePath: '/synthetic/target/archive',
    custodyPath: '/synthetic/target/custody', recoverySecret: secret } }
  return { parent, child, secret, input, api, run, spawn, fork, poolEnd, poolClose, writeFile }
}

describe('local manual target parent-disconnect lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('stops the startup child and scrubs its secret when the parent disappears during locked startup', async () => {
    const f = fixture()
    f.parent.emit('message', f.input)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    f.parent.disconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.child.signals).toEqual(['SIGTERM'])
    expect(f.parent.exit).toHaveBeenCalledWith(1)
    expect(f.secret.every(byte => byte === 0)).toBe(true)
    expect(f.poolEnd).toHaveBeenCalledTimes(1)
    expect(f.poolClose).toHaveBeenCalledTimes(1)
    expect(f.parent.messages).toEqual([])
    expect(f.child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops an in-flight flag-OFF witness before exiting after parent loss', async () => {
    const f = fixture('rollback')
    f.parent.emit('message', f.input)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.fork).toHaveBeenCalledTimes(1)
    f.parent.disconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.child.signals).toEqual(['SIGTERM'])
    expect(f.parent.exit).toHaveBeenCalledWith(1)
    expect(f.secret.every(byte => byte === 0)).toBe(true)
    expect(f.parent.messages).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses an already disconnected parent before admitting input or launching a child', async () => {
    const f = fixture('normal', false)
    f.parent.emit('message', f.input)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.run).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.parent.exit).toHaveBeenCalledWith(1)
    expect(f.secret.every(byte => byte === 0)).toBe(true)
    expect(f.parent.messages).toEqual([])
  })

  it('preserves the normal result and ignores disconnect after completed work', async () => {
    const f = fixture('normal')
    f.parent.emit('message', f.input)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.parent.messages).toEqual([{ kind: 'manual-target-done', rollbackTableCount: 6 }])
    expect(f.parent.connected).toBe(false)
    expect(f.parent.exitCode).toBe(0)
    f.parent.emit('disconnect')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.parent.exit).not.toHaveBeenCalled()
    expect(f.parent.listenerCount('disconnect')).toBe(0)
  })

  it('shares an in-flight stop with parent-loss cleanup without duplicate signals or timers', async () => {
    const f = fixture()
    f.parent.emit('message', f.input)
    await vi.advanceTimersByTimeAsync(0)
    const stopping = f.api.stopLauncher(f.child, false)
    f.parent.disconnect()
    await vi.advanceTimersByTimeAsync(0)
    await stopping
    expect(f.child.signals).toEqual(['SIGTERM'])
    expect(f.parent.exit).toHaveBeenCalledTimes(1)
    expect(f.parent.exit).toHaveBeenCalledWith(1)
    expect(f.poolEnd).toHaveBeenCalledTimes(1)
    expect(f.child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for bounded escalation before exiting when the startup child ignores SIGTERM', async () => {
    const f = fixture('starting', true, 'SIGKILL')
    f.parent.emit('message', f.input)
    await vi.advanceTimersByTimeAsync(0)
    f.parent.disconnect()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.child.signals).toEqual(['SIGTERM'])
    expect(f.parent.exit).not.toHaveBeenCalled()
    expect(f.secret.every(byte => byte === 0)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(f.parent.exit).toHaveBeenCalledWith(1)
    expect(f.parent.messages).toEqual([])
    expect(f.child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('exits unsuccessfully after the stop bound even when a child exit cannot be confirmed', async () => {
    const f = fixture('starting', true, null)
    f.parent.emit('message', f.input)
    await vi.advanceTimersByTimeAsync(0)
    f.parent.disconnect()
    await vi.advanceTimersByTimeAsync(70_000)
    expect(f.child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(f.parent.exit).toHaveBeenCalledWith(1)
    expect(f.parent.messages).toEqual([])
    expect(f.secret.every(byte => byte === 0)).toBe(true)
  })
})
