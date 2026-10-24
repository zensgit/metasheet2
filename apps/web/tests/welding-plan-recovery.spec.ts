// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import ts from 'typescript'
import { readFileSync, writeFileSync, mkdirSync, realpathSync, lstatSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { validateRecovery, validatePayload } from '../src/services/welding/planRecovery'

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
function record(index = 1, text = '') {
  const payload = { schema_version: 1, product: { item_id: 'part', version_id: 'p1' }, drawing: { item_id: 'drawing', version_id: 'd1', file_id: 'file', file_role: 'drawing', expected_checksum: 'a'.repeat(64) }, welds: [], preparation_notes: text }
  return { schema: 'yuantus.welding_plan_recovery/1', recovery_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, updated_at: index, owner,
    draft: { plan_id: 'plan', version_id: 'v1', base_draft_seq: 1, base_content_hash: 'a'.repeat(64), name: 'Plan', number: 'W1', payload }, pending: null }
}

describe('original recovery envelope', () => {
  it('preserves unedited F18/overlay fields without adding native sid/token', () => {
    const value = record(); Object.assign(value.draft.payload, { overlay: { schema: 'vemcad-weld-overlay/3', future: { entity: 'retain' } }, assembly_source: { representation: 'retain' } })
    expect(validateRecovery(value)).toEqual(value)
    expect(JSON.stringify(validateRecovery(value))).not.toContain('session')
  })
  it.each([undefined, Infinity, NaN, '\ud800', 'text\0'])('rejects non-lossless JSON field %s', value => {
    expect(() => validatePayload({ ...record().draft.payload, future: value })).toThrow()
  })
  it('rejects altered pending path/seq and draft body beyond 5MiB', () => {
    const value = record()
    for (const bad of [{ path: '/other/versions/v1/draft', seq: 1 }, { path: '/plan/versions/v1/draft', seq: 2 }])
      expect(() => validateRecovery({ ...value, pending: { method: 'PUT', path: bad.path, body: { expected_draft_seq: bad.seq, save_id: 'same-save', payload: value.draft.payload }, local_ahead: false } })).toThrow()
    expect(() => validatePayload(record(1, 'x'.repeat(5 * 1024 * 1024)).draft.payload)).toThrow()
    expect(() => validateRecovery({ ...record(), draft: { ...record().draft, name: 'x'.repeat(12 * 1024 * 1024) } })).toThrow('12 MiB')
  })
})

describe('actual Chromium IndexedDB transactions', () => {
  let browser: Browser, context: BrowserContext, a: Page, b: Page
  const sourcePath = resolve('src/services/welding/planRecovery.ts')
  const source = readFileSync(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const bootstrap = `(function(){const exports={};${compiled};window.recovery=exports})();`
  const requireFromTest = createRequire(resolve('tests/welding-plan-recovery.spec.ts'))
  function dependencyPins() {
    return ['typescript', '@playwright/test'].map(name => {
      const path = requireFromTest.resolve(name)
      return { name, path: realpathSync(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
    })
  }
  let beforeDependencies: ReturnType<typeof dependencyPins>
  beforeAll(async () => {
    const out = resolve(process.env.WELDING_FOUNDATION_OUTPUT_DIR ?? '../../artifacts/welding-f15b/frontend-foundation-1', `storage-browser-${process.env.WELDING_FOUNDATION_RUN_LABEL ?? 'manual'}`)
    mkdirSync(out, { recursive: true })
    writeFileSync(resolve(out, 'recovery-browser-module.js'), bootstrap)
    const executable = process.env.WELDING_UI_CHROMIUM_EXECUTABLE ?? chromium.executablePath(); if (process.env.WELDING_UI_CHROMIUM_EXECUTABLE) expect(isAbsolute(executable) && lstatSync(executable).isFile()).toBe(true); const binary = readFileSync(executable)
    beforeDependencies = dependencyPins()
    writeFileSync(resolve(out, 'storage-browser-input-pins.json'), JSON.stringify({ utc: new Date().toISOString(), sourcePath, source_sha256: createHash('sha256').update(source).digest('hex'), transpiled_sha256: createHash('sha256').update(compiled).digest('hex'), bootstrap_sha256: createHash('sha256').update(bootstrap).digest('hex'), chromium: executable, browser_sha256_before: createHash('sha256').update(binary).digest('hex'), dependencies_before: beforeDependencies, typescript: ts.version, boundary: 'actual planRecovery module; export wrapper only; real same-origin IndexedDB; intercepted blank HTML; no domain API' }, null, 2))
    console.log(new Date().toISOString(), 'Starting installed Chromium for controlled storage browser tests', executable)
    browser = await chromium.launch({ headless: true, ...(process.env.WELDING_UI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.WELDING_UI_CHROMIUM_EXECUTABLE } : {}) })
    console.log(new Date().toISOString(), 'Chromium started', browser.version())
  }, 30000)
  beforeEach(async () => {
    context = await browser.newContext()
    await context.route('http://welding-storage.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Controlled storage test</title>' }))
    a = await context.newPage(); b = await context.newPage()
    for (const page of [a, b]) { await page.goto('http://welding-storage.test/'); await page.addScriptTag({ content: bootstrap }); await page.evaluate(async () => { (window as any).store = await (window as any).recovery.openPlanRecoveryStore(indexedDB) }) }
  })
  afterEach(async () => { await context?.close() })
  afterAll(async () => {
    await browser?.close()
    const executable = process.env.WELDING_UI_CHROMIUM_EXECUTABLE ?? chromium.executablePath()
    const out = resolve(process.env.WELDING_FOUNDATION_OUTPUT_DIR ?? '../../artifacts/welding-f15b/frontend-foundation-1', `storage-browser-${process.env.WELDING_FOUNDATION_RUN_LABEL ?? 'manual'}`)
    const afterDependencies = dependencyPins()
    writeFileSync(resolve(out, 'storage-browser-exit.json'), JSON.stringify({ utc: new Date().toISOString(), closed: !browser?.isConnected(), browser_version: browser?.version(), browser_sha256_after: createHash('sha256').update(readFileSync(executable)).digest('hex'), dependencies_after: afterDependencies }, null, 2))
    console.log(new Date().toISOString(), 'Owned Chromium closed')
    expect(afterDependencies).toEqual(beforeDependencies)
  })
  it('durable claim completes before a second page reads it and filters by four-field owner', async () => {
    expect(await a.evaluate(value => (window as any).store.claim(value), record())).toBe(true)
    expect(await b.evaluate(value => (window as any).store.get(value.owner, value.recovery_id), record())).toEqual(record())
    expect(await b.evaluate(value => (window as any).store.list(value), { ...owner, rbac_user_id: 20 })).toEqual([])
    expect(await b.evaluate(value => (window as any).store.list(value), owner)).toEqual([record()])
  })
  it('competing pages compare and replace in one transaction; stale ACK cannot clear the winner', async () => {
    const original = record(), second = { ...original, updated_at: 2 }, third = { ...original, updated_at: 3 }
    await a.evaluate(value => (window as any).store.claim(value), original)
    const results = await Promise.all([a.evaluate(([old, next]) => (window as any).store.compareReplace(old, next), [original, second]), b.evaluate(([old, next]) => (window as any).store.compareReplace(old, next), [original, third])])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await b.evaluate(value => (window as any).store.compareReplace(value, null), original)).toBe(false)
    expect(await a.evaluate(value => (window as any).store.get(value.owner, value.recovery_id), original)).toEqual(results[0] ? second : third)
  })
  it('an actual abort rolls back claim and preserves a record during ACK cleanup', async () => {
    const original = record()
    await a.evaluate(value => (window as any).store.claim(value), original)
    const result = await a.evaluate(async value => {
      const signal = new AbortController()
      const job = (window as any).store.compareReplace(value, null, signal.signal)
      queueMicrotask(() => signal.abort())
      try { await job; return 'committed' } catch { return 'aborted' }
    }, original)
    expect(result).toBe('aborted')
    expect(await b.evaluate(value => (window as any).store.get(value.owner, value.recovery_id), original)).toEqual(original)
  })
  it('rejects a ninth owner record without evicting existing history', async () => {
    for (let i = 1; i <= 8; i++) await a.evaluate(value => (window as any).store.claim(value), record(i))
    expect(await a.evaluate(async value => { try { await (window as any).store.claim(value); return '' } catch (error) { return (error as Error).message } }, record(9))).toContain('恢复空间已满')
    expect(await b.evaluate(value => (window as any).store.list(value), owner)).toHaveLength(8)
  })
  it('caps physical total bytes at 64MiB across owners in the same transaction', async () => {
    const outcome = await a.evaluate(async sample => {
      const large = 'x'.repeat(4 * 1024 * 1024)
      let accepted = 0, rejected = false
      for (let i = 1; i <= 10; i++) {
        const value = structuredClone(sample)
        value.owner.auth_user_id = i
        value.recovery_id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
        value.draft.payload.preparation_notes = large
        const pending = { method: 'PUT', path: '/plan/versions/v1/draft', body: { expected_draft_seq: 1, save_id: 'save', payload: value.draft.payload }, local_ahead: false }
        try { await (window as any).store.claim({ ...value, pending }); accepted++ } catch { rejected = true; break }
      }
      return { accepted, rejected }
    }, record())
    expect(outcome.rejected).toBe(true)
    expect(outcome.accepted).toBe(7)
  }, 90000)
})
