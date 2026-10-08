import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, test, vi } from 'vitest'
import { createRecoveryArchiveNativeDiagnostics } from '../utils/recovery-archive-native-diagnostics'

const fixtureSource = readFileSync(resolve(__dirname, '../utils/recovery-archive-owned-composer-fixture.ts'), 'utf8')
type NativeQuery = (sql: string, params?: unknown[]) => Promise<unknown>
/** Execute the actual fixture adapter body with a synthetic client, never import/boot the DB fixture. */
function adapter(diagnostics: ReturnType<typeof createRecoveryArchiveNativeDiagnostics>, client: { query: NativeQuery }, hook?:
  (sql: string, params: unknown[] | undefined, client: { query: NativeQuery }, execute: () => Promise<unknown>) => Promise<unknown>) {
  const source = ts.createSourceFile('fixture.ts', fixtureSource, ts.ScriptTarget.Latest, true)
  const candidates: ts.ArrowFunction[] = []
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'query' && ts.isArrowFunction(node.initializer)
      && node.initializer.getText(source).includes('nativeCalls.push')) candidates.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source); expect(candidates).toHaveLength(1)
  const body = ts.transpileModule(`const query = ${candidates[0].getText(source)}; return query;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const create = new Function('client', 'fixture', 'control', 'nativeCalls', 'diagnostics', 'claimCommitBeforeRR',
    `let active = false; let depth = 0; ${body}`) as (...args: unknown[]) => NativeQuery
  return create(client, { query: vi.fn() }, { query: hook }, [], diagnostics, [])
}
const snapshot = (diagnostics: ReturnType<typeof createRecoveryArchiveNativeDiagnostics>) => JSON.parse(diagnostics.failure('fail')!)

describe('owned native failure diagnostics — source-extracted adapter controls, no native evidence', () => {
  test('opt-in and unselected adapters preserve original receiver, parameters, result and exactly one execute', async () => {
    for (const enabled of [false, true]) {
      const diagnostics = createRecoveryArchiveNativeDiagnostics(), params = ['synthetic-private-value']
      if (enabled) diagnostics.start('canonical-cleanup', 1000)
      const result = { rowCount: 1, rows: [{ matches: false, privateValue: params[0] }] }
      const client = { query: vi.fn(function (this: unknown, sql: string, received?: unknown[]) {
        expect(this).toBe(client); expect(sql).toBe('SELECT 1'); expect(received).toBe(params); return Promise.resolve(result)
      }) }
      const query = adapter(diagnostics, client, async (_sql, _params, receiver, execute) => {
        expect(receiver).toBe(client); return execute()
      })
      expect(await query('SELECT 1', params)).toBe(result); expect(client.query).toHaveBeenCalledOnce()
      if (enabled) expect(snapshot(diagnostics).entries[0]).toMatchObject({ originalExecuteCalls: 1, outcome: 'fulfilled', rowCount: 1, rowBooleans: { matches: false } })
      else expect(diagnostics.failure('fail')).toBeUndefined()
    }
  })

  test('existing hook substitution and hook refusal execute zero original native calls', async () => {
    const diagnostics = createRecoveryArchiveNativeDiagnostics(); diagnostics.start('controlled-delayed-commit', 1500)
    const client = { query: vi.fn() }, substitute = { rowCount: 0, rows: [] }, error = Object.assign(new Error('recovery_archive_binding_invalid'), { code: 'TOKEN', severity: 'ERROR' })
    expect(await adapter(diagnostics, client, async () => substitute)('COMMIT')).toBe(substitute)
    await expect(adapter(diagnostics, client, async () => { throw error })('COMMIT')).rejects.toBe(error)
    expect(client.query).not.toHaveBeenCalled()
    expect(snapshot(diagnostics).entries.map((entry: { originalExecuteCalls: number }) => entry.originalExecuteCalls)).toEqual([0, 0])
    expect(snapshot(diagnostics).entries[1]).toMatchObject({ outcome: 'rejected' })
    expect(snapshot(diagnostics).entries[1]).not.toHaveProperty('nativeGuard'); expect(snapshot(diagnostics).entries[1]).not.toHaveProperty('sqlstate'); expect(diagnostics.failure('fail')).not.toContain('TOKEN')
  })

  test.each(['synchronous', 'promise'])('original %s query failure retains the exact rejection object', async mode => {
    const diagnostics = createRecoveryArchiveNativeDiagnostics(); diagnostics.start('canonical-cleanup', 1000)
    const error = Object.assign(new Error('synthetic-private-error'), { code: '23514', severity: 'ERROR', detail: 'synthetic-private-detail' })
    const client = { query: vi.fn(() => { if (mode === 'synchronous') throw error; return Promise.reject(error) }) }
    await expect(adapter(diagnostics, client)('SELECT 1')).rejects.toBe(error)
    expect(client.query).toHaveBeenCalledOnce()
    expect(snapshot(diagnostics).entries[0]).toMatchObject({ originalExecuteCalls: 1, outcome: 'rejected', sqlstate: '23514' })
    expect(diagnostics.failure('fail')).not.toContain('synthetic-private')
  })

  test('stores only static phases, constrained errors, narrow booleans and exact local duration — no SQL/hash/parameters/identities', async () => {
    const diagnostics = createRecoveryArchiveNativeDiagnostics(); diagnostics.start('natural-late-query', 1500)
    const client = { query: vi.fn(async () => ({ rows: [{ valid: true, within_budget: false, expired: true, id: 'synthetic-private' }], rowCount: 1 })) }
    const query = adapter(diagnostics, client)
    await query("SELECT set_config('statement_timeout',$1,true)", ['250ms'])
    await query("SELECT set_config('statement_timeout',$1,false)", ['999ms'])
    await query("SELECT 'synthetic-private-sql'", ['synthetic-private-parameter'])
    await query('/* owned-capture:binding */ INSERT INTO public.meta_recovery_archive_prepared_captures', ['synthetic-private-payload'])
    diagnostics.external('head'); diagnostics.external('synthetic-private-phase')
    diagnostics.commandError(new Error('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED'))
    diagnostics.commandError(new Error('synthetic-private-error'))
    const proof = snapshot(diagnostics)
    expect(proof.entries[0].statementBudgetMs).toBe(250)
    expect(proof.entries[1]).not.toHaveProperty('statementBudgetMs'); expect(proof.entries[2]).not.toHaveProperty('statementBudgetMs')
    expect(proof.entries[3].phase).toBe('prepared'); expect(proof.externalCounts).toEqual({ head: 1 })
    expect(proof.commandCodes).toEqual(['RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED'])
    expect(diagnostics.failure('fail')).not.toMatch(/synthetic-private|sqlShape|sha256/)
    expect(diagnostics.failure('pass')).toBeUndefined(); expect(diagnostics.failure(undefined)).toBeUndefined()
  })

  test('original PG guard messages require exact source-confirmed literals; prefixes and hook messages are omitted', async () => {
    const sources = {
      recovery_archive_binding_invalid: 'zzzz20261007120000_amend_recovery_archive_cleanup_anchor.ts',
      recovery_archive_snapshot_reservation_set_invalid: 'zzzz20260918120000_add_recovery_archive_section_checkpoints.ts',
      recovery_archive_abandoned_cleanup_claim_invalid: 'zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol.ts',
      recovery_archive_abandoned_cleanup_claim_shape_invalid: 'zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol.ts',
      recovery_archive_abandoned_cleanup_claim_refused: 'zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol.ts',
      recovery_archive_attachment_cleanup_release_refused: 'zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol.ts',
    }
    const diagnostics = createRecoveryArchiveNativeDiagnostics(); diagnostics.start('canonical-cleanup', 1000)
    for (const [message, file] of Object.entries(sources)) {
      expect(readFileSync(resolve(__dirname, '../../src/db/migrations', file), 'utf8')).toContain(`MESSAGE = '${message}'`)
      const error = Object.assign(new Error(message), { code: '23514', severity: 'ERROR' })
      const client = { query: vi.fn(async () => { throw error }) }
      await expect(adapter(diagnostics, client)('COMMIT')).rejects.toBe(error); expect(client.query).toHaveBeenCalledOnce()
    }
    const unknown = Object.assign(new Error('recovery_archive_binding_invalid synthetic-private-suffix'), { code: '23514', severity: 'ERROR' })
    await expect(adapter(diagnostics, { query: vi.fn(async () => { throw unknown }) })('COMMIT')).rejects.toBe(unknown)
    const proof = snapshot(diagnostics)
    expect(proof.entries.slice(0, 6).map((entry: { nativeGuard: string }) => entry.nativeGuard)).toEqual(Object.keys(sources))
    expect(proof.entries[6]).toMatchObject({ sqlstate: '23514' }); expect(proof.entries[6]).not.toHaveProperty('nativeGuard')
    expect(diagnostics.failure('fail')).not.toContain('synthetic-private')
  })

  test('observer metadata failure preserves original result and exposes incomplete diagnostics; getters are not invoked', async () => {
    const diagnostics = createRecoveryArchiveNativeDiagnostics(); diagnostics.start('canonical-cleanup', 1000)
    const result = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private observer failure') } })
    const client = { query: vi.fn(async () => result) }
    expect(await adapter(diagnostics, client)('SELECT 1')).toBe(result)
    const getter = vi.fn(() => { throw new Error('private getter') })
    diagnostics.commandError(Object.defineProperty({}, 'message', { get: getter }))
    const proof = JSON.parse(diagnostics.failure('fail', [new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private terminal observer failure') } })])!)
    expect(proof.incomplete).toBe(true); expect(proof.dropped).toBe(2); expect(getter).not.toHaveBeenCalled()
    expect(JSON.stringify(proof)).not.toContain('private')
    const value = { rows: [], rowCount: 0 }, original = Promise.resolve(value)
    Object.defineProperty(original, 'then', { value: () => { throw new Error('private registration observer failure') } })
    expect(await diagnostics.query('SELECT 1', undefined, () => 0, observed => observed(() => original))).toBe(value)
    expect(snapshot(diagnostics)).toMatchObject({ dropped: 3, incomplete: true, originalExecution: { started: 2, finished: 1, inFlight: 1 } })

  })

  test('settled hook result cannot hide still-pending original native execution at failure persistence', async () => {
    const diagnostics = createRecoveryArchiveNativeDiagnostics(); diagnostics.start('canonical-cleanup', 1000)
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve }), result = { rows: [], rowCount: 0 }
    const client = { query: vi.fn(() => pending) }
    let original!: Promise<unknown>
    const query = adapter(diagnostics, client, async (_sql, _params, _client, execute) => { original = execute(); return result })
    expect(await query('SELECT 1')).toBe(result); expect(client.query).toHaveBeenCalledOnce()
    const persisted = snapshot(diagnostics)
    expect(persisted).toMatchObject({ pending: 0, incomplete: true, originalExecution: { started: 1, finished: 0, inFlight: 1 } })
    finish(result); await original
    expect(snapshot(diagnostics)).toMatchObject({ incomplete: false, originalExecution: { started: 1, finished: 1, inFlight: 0 } })
    expect(persisted.originalExecution.inFlight).toBe(1)
  })

  test('observation cap is visible as incomplete and cannot suppress original execution', async () => {
    const diagnostics = createRecoveryArchiveNativeDiagnostics(); diagnostics.start('canonical-cleanup', 1000)
    const execute = vi.fn(async () => ({ rowCount: 0, rows: [] }))
    for (let index = 0; index < 2049; index++) await diagnostics.query('SELECT 1', undefined, () => 0, observed => observed(execute))
    expect(execute).toHaveBeenCalledTimes(2049)
    expect(snapshot(diagnostics)).toMatchObject({ sequence: 2049, dropped: 1, incomplete: true })
    expect(snapshot(diagnostics).entries).toHaveLength(2048)
  })

  test('failure-only private persistence is before dispose in both actual native specs and unit CI remains executable', () => {
    for (const name of ['cleanup', 'composer']) {
      const spec = readFileSync(resolve(__dirname, `../integration/multitable-recovery-archive-owned-${name}-realdb.test.ts`), 'utf8')
      const hook = spec.split('afterEach(async context => {')[1]?.split('afterAll')[0]
      expect(hook).toContain('context.task.result?.state'); expect(hook.indexOf('persistFailureDiagnostics')).toBeLessThan(hook.indexOf('dispose'))
    }
    expect(fixtureSource).toContain("writeFile(join(root, 'native-failure-diagnostic.json'), `${proof}\\n`, { mode: 0o600 })")
    const repo = resolve(__dirname, '../../../..'), file = 'tests/unit/multitable-recovery-archive-native-diagnostics.test.ts'
    expect(readFileSync(resolve(repo, 'packages/core-backend/vitest.config.ts'), 'utf8')).not.toContain(file)
    expect(JSON.parse(readFileSync(resolve(repo, 'packages/core-backend/package.json'), 'utf8')).scripts.test).toBe('vitest')
    expect(readFileSync(resolve(repo, '.github/workflows/plugin-tests.yml'), 'utf8')).toContain('pnpm --filter @metasheet/core-backend test')
  })
})
