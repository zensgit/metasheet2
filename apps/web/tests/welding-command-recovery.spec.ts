// @vitest-environment node
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import ts from 'typescript'
import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateGenerationPending, validateWorkflowPending, validateResourcePending } from '../src/services/welding/commandRecovery'

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
const body = { request_id: '00000000-0000-4000-8000-000000000001', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), purpose: 'review', template_id: 'welding-a4', template_version: '1', template_digest: 'b'.repeat(64), template_options: { organization_name: '', header_text: '', footer_text: '', optional_columns: [], logo: null } }
const pending = () => ({ schema: 'metasheet.welding_command_pending/1', kind: 'generation', action: 'create', owner, plan_id: 'plan', item_version_id: 'v1', body, basis: null })
const reusePending = () => ({ schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'reuse', owner, plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'reuse-original', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), selected_weld_ids: ['w1'], target_plan_id: 'independent', name: 'Independent', number: 'R1', product: { item_id: 'other', version_id: 'p2' }, drawing: { item_id: 'drawing', version_id: 'd2', file_id: 'f2', file_role: 'drawing', expected_checksum: 'a'.repeat(64) }, bom: null, reason: 'explicit reuse' } })
describe('finite original generation records', () => {
  it('preserves the original create body without invented server fields or token', () => {
    expect(validateGenerationPending(pending())).toEqual(pending())
    expect(validateGenerationPending(pending())).not.toHaveProperty('generation_id')
  })
  it.each([{ action: 'final-render' }, { path: 'https://bad.test' }, { method: 'DELETE' }, { body: { ...body, payload: {} } }, { body: { ...body, purpose: 'final' } }, { basis: {} }])('rejects another protocol or injected transport %s', patch => {
    expect(() => validateGenerationPending({ ...pending(), ...patch })).toThrow()
  })
})

describe('actual generation IndexedDB completion and original CAS', () => {
  let browser: Browser, context: BrowserContext, a: Page, b: Page
  const inputs = ['planRecovery', 'resourceContracts', 'resourceImportContracts', 'planClient', 'commandRecovery'].map(name => {
    const path = resolve(`src/services/welding/${name}.ts`), source = readFileSync(path, 'utf8')
    return { name, path, source, compiled: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText }
  })
  const bootstrap = `(function(){const modules={}; const unloaded=()=>{throw new Error('transport/auth is outside this storage test')}; modules['../../utils/api']={apiFetch:unloaded}; modules['../../composables/authPrincipal']={readStoredToken:unloaded,readAuthSessionSignature:unloaded}; ${inputs.map(input => `modules['./${input.name}']=(function(){const exports={};const require=name=>modules[name];${input.compiled};return exports})();`).join('')} window.generationRecovery=modules['./commandRecovery'];})();`
  const out = resolve(process.env.WELDING_FOUNDATION_OUTPUT_DIR ?? '../../artifacts/welding-f15b/generation-ui-1', `command-storage-${process.env.WELDING_FOUNDATION_RUN_LABEL ?? 'manual'}`)
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
  let binaryHash: string
  beforeAll(async () => {
    mkdirSync(out, { recursive: true }); writeFileSync(resolve(out, 'storage-module.js'), bootstrap)
    const executable = process.env.WELDING_UI_CHROMIUM_EXECUTABLE ?? chromium.executablePath(); if (process.env.WELDING_UI_CHROMIUM_EXECUTABLE) expect(isAbsolute(executable) && lstatSync(executable).isFile()).toBe(true); binaryHash = hash(readFileSync(executable))
    writeFileSync(resolve(out, 'inputs.json'), JSON.stringify({ utc: new Date().toISOString(), inputs: inputs.map(input => ({ path: input.path, sha256: hash(input.source), compiled_sha256: hash(input.compiled) })), bootstrap_sha256: hash(bootstrap), executable, executable_sha256: binaryHash, typescript: ts.version, boundary: 'actual five modules; CommonJS wrapper; unused transport/auth imports throw; real Chromium same-origin IDB; intercepted empty HTML; no domain API' }, null, 2))
    browser = await chromium.launch({ headless: true, ...(process.env.WELDING_UI_CHROMIUM_EXECUTABLE ? { executablePath: process.env.WELDING_UI_CHROMIUM_EXECUTABLE } : {}) })
  }, 30000)
  beforeEach(async () => {
    context = await browser.newContext(); await context.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Generation storage</title>' }))
    a = await context.newPage(); b = await context.newPage()
    for (const page of [a, b]) { await page.goto('http://localhost/'); await page.addScriptTag({ content: bootstrap }); await page.evaluate(async () => { (window as any).store = await (window as any).generationRecovery.openGenerationRecoveryStore(indexedDB) }) }
  })
  afterEach(async () => { await context?.close() })
  it('F02 resource reload reads the exact owner and complete original without a plan ID or an automatic domain request', async () => {
    const original = validateResourcePending({ schema: 'metasheet.welding_command_pending/1', kind: 'resource', action: 'create', owner,
      resource_id: 'resource-1', source: null, body: { resource_id: 'resource-1', request_id: 'resource-original', name: 'WPS fixed document', number: 'WPS-1',
        payload: { schema_version: 1, kind: 'wps', suggested_fields: { method: 'GTAW', passes: [{ sequence: 1, current: null }] },
          document: { item_id: 'document/one', version_id: 'doc-v1', file_id: 'file%one', file_role: 'reference', expected_fingerprint: 'a'.repeat(64) } } } })
    expect(await a.evaluate(value => (window as any).store.claimResource(value), original)).toBe(true)
    await b.reload(); await b.addScriptTag({ content: bootstrap }); await b.evaluate(async () => { (window as any).store = await (window as any).generationRecovery.openGenerationRecoveryStore(indexedDB) })
    expect(await b.evaluate(value => (window as any).store.getResource(value), owner)).toEqual(original)
    expect(original).not.toHaveProperty('plan_id')
    expect(await b.evaluate(value => (window as any).store.getResource(value), { ...owner, rbac_user_id: 20 })).toBeNull()
    expect(await b.evaluate(value => (window as any).store.claimResource(value), { ...original, body: { ...original.body, name: 'Replacement' } })).toBe(false)
    expect(await a.evaluate(value => (window as any).store.getResource(value), owner)).toEqual(original)
  })
  it('F02 actual transaction abort preserves the original resource CAS; only exact completion clears it and legacy commands remain', async () => {
    const original = validateResourcePending({ schema: 'metasheet.welding_command_pending/1', kind: 'resource', action: 'revise', owner, resource_id: 'resource-1',
      source: { resource_id: 'resource-1', item_version_id: 'r-v1', content_hash: 'a'.repeat(64), number: 'M-1', kind: 'material' },
      body: { request_id: 'revision-original', source_version_id: 'r-v1', expected_current_version_id: 'r-v1', expected_content_hash: 'a'.repeat(64), name: 'Revised steel',
        payload: { schema_version: 1, kind: 'material', suggested_fields: { material_a: 'Manual steel' } } } })
    expect(await a.evaluate(value => (window as any).store.claim(value), pending())).toBe(true)
    expect(await a.evaluate(value => (window as any).store.claimResource(value), original)).toBe(true)
    const aborted = await a.evaluate(async value => {
      const nativeDelete = IDBObjectStore.prototype.delete; let invoked = 0, rejected = false, completed: Promise<void> | null = null
      IDBObjectStore.prototype.delete = function (key) {
        const request = nativeDelete.call(this, key); invoked++; const tx = this.transaction
        completed = new Promise<void>(resolve => tx.addEventListener('abort', () => resolve(), { once: true })); tx.abort(); return request
      }
      try { await (window as any).store.clearResource(value) } catch { rejected = true } finally { IDBObjectStore.prototype.delete = nativeDelete }
      if (!completed) throw new Error('Resource delete provided no native abort')
      await completed; return { invoked, rejected, remaining: await (window as any).store.getResource(value.owner) }
    }, original)
    expect(aborted).toEqual({ invoked: 1, rejected: true, remaining: original })
    expect(await b.evaluate(value => (window as any).store.clearResource(value), { ...original, body: { ...original.body, name: 'Later unconfirmed edit' } })).toBe(false)
    expect(await b.evaluate(value => (window as any).store.clearResource(value), original)).toBe(true)
    expect(await a.evaluate(value => (window as any).store.getResource(value), owner)).toBeNull()
    expect(await a.evaluate(value => (window as any).store.get(value), owner)).toEqual(pending())
  })
  it('F18b actual native storage accepts maximum 500 escaped IDs, names, reason and configured owner without truncation', async () => {
    const original = reusePending(), escaped = '\u0001', id = escaped.repeat(64)
    original.owner = { tenant_id: escaped.repeat(255), org_id: escaped.repeat(255), auth_user_id: Number.MAX_SAFE_INTEGER, rbac_user_id: Number.MAX_SAFE_INTEGER }
    const controls = [1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]
    original.body.expected_draft_seq = 2147483647
    original.plan_id = '\u0003'.repeat(64); original.item_version_id = '\u0004'.repeat(64)
    Object.assign(original.body, { request_id: id, source_publication_id: id, target_plan_id: '\u0002'.repeat(64), selected_weld_ids: Array.from({ length: 500 }, (_, i) => escaped.repeat(61) + [Math.floor(i / 441), Math.floor(i / 21) % 21, i % 21].map(n => String.fromCharCode(controls[n])).join('')), name: escaped.repeat(128), number: escaped.repeat(128), reason: escaped.repeat(4000), product: { item_id: id, version_id: id }, drawing: { item_id: id, version_id: id, file_id: id, file_role: 'native_cad', expected_checksum: 'a'.repeat(64) }, bom: { baseline_id: id, expected_fingerprint: 'a'.repeat(64) } })
    const raw = JSON.stringify(original), bytes = Buffer.byteLength(raw)
    expect(bytes).toBeGreaterThan(64 * 1024); expect(bytes).toBeLessThanOrEqual(256 * 1024)
    expect(validateWorkflowPending(original)).toEqual(original)
    expect(await a.evaluate(value => (window as any).store.claimWorkflow(value), original)).toBe(true)
    expect(await b.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), original)).toEqual(original)
    expect(await b.evaluate(value => (window as any).store.clearWorkflow(value), { ...original, body: { ...original.body, reason: 'different' } })).toBe(false)
    expect(await a.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), original)).toEqual(original)
    writeFileSync(resolve(out, 'reuse-maximum-size.json'), JSON.stringify({ body_bytes: Buffer.byteLength(JSON.stringify(original.body)), body_sha256: hash(JSON.stringify(original.body)), record_bytes: bytes, record_sha256: hash(raw), selected: original.body.selected_weld_ids.length, roundtrip: true, maximum_escape_bytes_per_codepoint: 6 }, null, 2))
  })
  it('F18b reuse occupies the existing source slot and generation admission while another target remains available', async () => {
    const original = reusePending()
    expect(await a.evaluate(value => (window as any).store.claimWorkflow(value), original)).toBe(true)
    expect(await b.evaluate(value => (window as any).store.claim(value), pending())).toBe(false)
    expect(await b.evaluate(value => (window as any).store.claim(value), { ...pending(), plan_id: 'other' })).toBe(true)
    expect(await b.evaluate(value => (window as any).store.claimWorkflow(value), { ...original, body: { ...original.body, request_id: 'different' } })).toBe(false)
    expect(await a.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), original)).toEqual(original)
  })
  it('F18b actual native delete invocation then abort preserves exact source raw; separate complete CAS clears only source', async () => {
    const original = reusePending(), other = { ...original, plan_id: 'other-source' }
    await a.evaluate(async values => { for (const value of values) await (window as any).store.claimWorkflow(value) }, [original, other])
    const aborted = await a.evaluate(async value => {
      const nativeDelete = IDBObjectStore.prototype.delete; let invoked = 0, abortEvent = 0, trustedAbort = false, rejected = false, key: unknown, abortCompleted: Promise<void> | null = null
      IDBObjectStore.prototype.delete = function (target) {
        const request = nativeDelete.call(this, target), transaction = this.transaction; invoked++; key = target
        abortCompleted = new Promise<void>(resolve => transaction.addEventListener('abort', event => { abortEvent++; trustedAbort = event.isTrusted && event.target === transaction; resolve() }, { once: true }))
        transaction.abort(); return request
      }
      try { await (window as any).store.clearWorkflow(value) } catch { rejected = true } finally { IDBObjectStore.prototype.delete = nativeDelete }
      if (!abortCompleted) throw new Error('Native delete did not provide its transaction abort event')
      await abortCompleted
      return { invoked, abortEvent, trustedAbort, rejected, key, remaining: await (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id) }
    }, original)
    expect(aborted).toEqual({ invoked: 1, abortEvent: 1, trustedAbort: true, rejected: true, key: ['workflow', 'tenant', 'org', 7, 19, 'plan', 'v1'], remaining: original })
    expect(await b.evaluate(value => (window as any).store.clearWorkflow(value), original)).toBe(true)
    expect(await a.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), original)).toBeNull()
    expect(await a.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), other)).toEqual(other)
  })
  it('F18b oversized reuse fails closed before native put and retains legacy and existing originals', async () => {
    const original = reusePending(); await a.evaluate(value => (window as any).store.claimWorkflow(value), original)
    const overflow = { ...original, owner: { ...owner, tenant_id: '\u0001'.repeat(45000) } }
    const result = await b.evaluate(async value => {
      const nativePut = IDBObjectStore.prototype.put; let puts = 0, rejected = false
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) { puts++; return nativePut.apply(this, args) }
      try { await (window as any).store.claimWorkflow(value) } catch { rejected = true } finally { IDBObjectStore.prototype.put = nativePut }
      return { puts, rejected }
    }, overflow)
    expect(result).toEqual({ puts: 0, rejected: true }); expect(await a.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), original)).toEqual(original)
    const legacy = { ...original, action: 'revise', body: { request_id: 'old', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), reason: '\u0001'.repeat(4000) }, owner: { ...owner, org_id: '\u0001'.repeat(8000) } }
    expect(() => validateWorkflowPending(legacy)).toThrow('64 KiB')
  })
  afterAll(async () => {
    await browser?.close(); const after = hash(readFileSync(process.env.WELDING_UI_CHROMIUM_EXECUTABLE ?? chromium.executablePath()))
    writeFileSync(resolve(out, 'exit.json'), JSON.stringify({ utc: new Date().toISOString(), closed: !browser?.isConnected(), browser_version: browser?.version(), executable_sha256_after: after }, null, 2)); expect(after).toBe(binaryHash)
  })
  it('C3 actual revision CAS abort retains raw, while a changed listener after commit cannot undo lawful cleanup', async () => {
    const original = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'revise', owner, plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'revision-original', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), reason: ' 原因 ' } }
    expect(await a.evaluate(value => (window as any).store.claimWorkflow(value), original)).toBe(true)
    expect(await a.evaluate(async value => {
      const signal = new AbortController(), job = (window as any).store.clearWorkflow(value, { signal: signal.signal, accepts: () => !signal.signal.aborted })
      queueMicrotask(() => signal.abort()); try { await job; return false } catch { return true }
    }, original)).toBe(true)
    expect(await b.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), original)).toEqual(original)
    expect(await a.evaluate(async value => {
      const w = window as any; let active = true; const unsubscribe = w.store.subscribe(() => { active = false })
      const cleared = await w.store.clearWorkflow(value, { accepts: () => active }); unsubscribe()
      return { cleared, active, remaining: await w.store.getWorkflow(value.owner, value.plan_id, value.item_version_id) }
    }, original)).toEqual({ cleared: true, active: false, remaining: null })
  })
  it('C3 real IDB keeps the original revision until an explicit exact CAS, including another tab replacement', async () => {
    const original = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'revise', owner, plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'revision-original', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), reason: ' 原因 ' } }
    expect(await a.evaluate(value => (window as any).store.claimWorkflow(value), original)).toBe(true)
    const different = { ...original, body: { ...original.body, reason: 'other' } }
    expect(await b.evaluate(value => (window as any).store.claimWorkflow(value), different)).toBe(false)
    expect(await b.evaluate(value => (window as any).store.clearWorkflow(value), different)).toBe(false)
    expect(await a.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), original)).toEqual(original)
    expect(await b.evaluate(value => (window as any).store.clearWorkflow(value), original)).toBe(true)
    expect(await a.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), original)).toBeNull()
  })
  it('rejects a generation claim when the same target has a durable workflow original', async () => {
    const workflow = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'submit', owner, plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'workflow-1', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), review_generation_id: '00000000-0000-4000-8000-000000000010', reviewer_rbac_id: 20 } }
    await a.evaluate(async value => {
      const db = await new Promise<IDBDatabase>(yes => { const request = indexedDB.open('metasheet-welding-command-recovery', 1); request.onsuccess = () => yes(request.result) })
      await new Promise<void>((yes, no) => { const tx = db.transaction('pending', 'readwrite'); tx.oncomplete = () => yes(); tx.onabort = () => no(tx.error); tx.objectStore('pending').put(JSON.stringify(value), ['workflow', value.owner.tenant_id, value.owner.org_id, value.owner.auth_user_id, value.owner.rbac_user_id, value.plan_id, value.item_version_id]) }); db.close()
    }, workflow)
    expect(await b.evaluate(value => (window as any).store.claim(value), pending())).toBe(false)
    expect(await a.evaluate(value => (window as any).store.get(value), owner)).toBeNull()
  })
  const workflow = () => ({ schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'submit', owner, plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'workflow-1', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), review_generation_id: '00000000-0000-4000-8000-000000000010', reviewer_rbac_id: 20 } })
  it('reverse cross-kind claims reject the current target but preserve another legal target', async () => {
    expect(await a.evaluate(value => (window as any).store.claim(value), pending())).toBe(true)
    expect(await b.evaluate(value => (window as any).store.claimWorkflow(value), workflow())).toBe(false)
    const other = { ...workflow(), item_version_id: 'v2' }
    expect(await b.evaluate(value => (window as any).store.claimWorkflow(value), other)).toBe(true)
    expect(await a.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), other)).toEqual(other)
    expect(await a.evaluate(value => (window as any).store.get(value), owner)).toEqual(pending())
  })
  it('actual simultaneous cross-kind claims admit only one original and stale clear preserves its replacement', async () => {
    const results = await Promise.all([a.evaluate(value => (window as any).store.claim(value), pending()), b.evaluate(value => (window as any).store.claimWorkflow(value), workflow())])
    expect(results.filter(Boolean)).toHaveLength(1)
    if (results[0]) await a.evaluate(value => (window as any).store.clear(value), pending())
    else await b.evaluate(value => (window as any).store.clearWorkflow(value), workflow())
    expect(await b.evaluate(value => (window as any).store.claimWorkflow(value), workflow())).toBe(true)
    const next = { ...workflow(), body: { ...workflow().body, request_id: 'workflow-2' } }
    expect(await a.evaluate(value => (window as any).store.clearWorkflow(value), workflow())).toBe(true)
    expect(await b.evaluate(value => (window as any).store.claimWorkflow(value), next)).toBe(true)
    expect(await a.evaluate(value => (window as any).store.clearWorkflow(value), workflow())).toBe(false)
    expect(await b.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), next)).toEqual(next)
  })
  it('workflow quota is separate from eight generation owners in the same physical v1 DB', async () => {
    for (let i = 0; i < 64; i++) expect(await a.evaluate(value => (window as any).store.claimWorkflow(value), { ...workflow(), plan_id: 'wf-' + i })).toBe(true)
    expect(await b.evaluate(async value => { try { await (window as any).store.claimWorkflow(value); return '' } catch (error) { return (error as Error).message } }, { ...workflow(), plan_id: 'wf-64' })).toContain('空间已满')
    for (let i = 1; i <= 8; i++) expect(await a.evaluate(value => (window as any).store.claim(value), { ...pending(), owner: { ...owner, auth_user_id: i } })).toBe(true)
    expect(await b.evaluate(value => (window as any).store.getWorkflow(value.owner, value.plan_id, value.item_version_id), { ...workflow(), plan_id: 'wf-0' })).toEqual({ ...workflow(), plan_id: 'wf-0' })
    expect(await a.evaluate(async () => (await indexedDB.databases()).map(value => ({ name: value.name, version: value.version })))).toEqual([{ name: 'metasheet-welding-command-recovery', version: 1 }])
  })
  it('claim becomes durable before resolution and survives reopening without affecting plan DB', async () => {
    const original = pending()
    expect(await a.evaluate(value => (window as any).store.claim(value), original)).toBe(true)
    expect(await b.evaluate(value => (window as any).store.get(value), owner)).toEqual(original)
    expect(await b.evaluate(value => (window as any).store.get(value), { ...owner, rbac_user_id: 20 })).toBeNull()
    await a.evaluate(async () => { (window as any).store.close(); (window as any).store = await (window as any).generationRecovery.openGenerationRecoveryStore(indexedDB) })
    expect(await a.evaluate(value => (window as any).store.get(value), owner)).toEqual(original)
    expect(await a.evaluate(async () => (await indexedDB.databases()).map(value => value.name))).toEqual(['metasheet-welding-command-recovery'])
  })
  it('two pages keep one owner original and stale CAS cannot clear it', async () => {
    const first = pending(), second = { ...first, body: { ...body, request_id: '00000000-0000-4000-8000-000000000002' } }
    const results = await Promise.all([a.evaluate(value => (window as any).store.claim(value), first), b.evaluate(value => (window as any).store.claim(value), second)])
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results[0] ? first : second, loser = results[0] ? second : first
    expect(await a.evaluate(value => (window as any).store.clear(value), loser)).toBe(false)
    expect(await b.evaluate(value => (window as any).store.get(value), owner)).toEqual(winner)
    expect(await a.evaluate(value => (window as any).store.clear(value), winner)).toBe(true)
    expect(await b.evaluate(value => (window as any).store.get(value), owner)).toBeNull()
    expect(await b.evaluate(value => (window as any).store.claim(value), loser)).toBe(true)
    expect(await a.evaluate(value => (window as any).store.clear(value), winner)).toBe(false)
    expect(await b.evaluate(value => (window as any).store.get(value), owner)).toEqual(loser)
  })
  it('signal abort rolls back claim and ACK deletion before oncomplete', async () => {
    const original = pending()
    const aborted = await a.evaluate(async value => {
      const signal = new AbortController(), scope = { signal: signal.signal, accepts: () => !signal.signal.aborted }
      const job = (window as any).store.claim(value, scope); queueMicrotask(() => signal.abort())
      try { await job; return false } catch { return true }
    }, original)
    expect(aborted).toBe(true); expect(await b.evaluate(value => (window as any).store.get(value), owner)).toBeNull()
    await a.evaluate(value => (window as any).store.claim(value), original)
    const deleted = await a.evaluate(async value => {
      const signal = new AbortController(), job = (window as any).store.clear(value, { signal: signal.signal, accepts: () => !signal.signal.aborted })
      queueMicrotask(() => signal.abort()); try { await job; return false } catch { return true }
    }, original)
    expect(deleted).toBe(true); expect(await b.evaluate(value => (window as any).store.get(value), owner)).toEqual(original)
  })
  it('rejects owner corruption and the ninth owner without evicting originals', async () => {
    for (let i = 1; i <= 8; i++) expect(await a.evaluate(value => (window as any).store.claim(value), { ...pending(), owner: { ...owner, auth_user_id: i } })).toBe(true)
    expect(await a.evaluate(async value => { try { await (window as any).store.claim(value); return '' } catch (error) { return (error as Error).message } }, { ...pending(), owner: { ...owner, auth_user_id: 9 } })).toContain('空间已满')
    expect(await b.evaluate(value => (window as any).store.get(value), owner)).toEqual(pending())
    await a.evaluate(async value => {
      const db = await new Promise<IDBDatabase>((yes, no) => { const request = indexedDB.open('metasheet-welding-command-recovery', 1); request.onsuccess = () => yes(request.result); request.onerror = () => no(request.error) })
      await new Promise<void>((yes, no) => { const tx = db.transaction('pending', 'readwrite'); tx.oncomplete = () => yes(); tx.onabort = () => no(tx.error); tx.objectStore('pending').put(JSON.stringify({ ...value, owner: { ...value.owner, rbac_user_id: 999 } }), ['generation', value.owner.tenant_id, value.owner.org_id, value.owner.auth_user_id, value.owner.rbac_user_id]) }); db.close()
    }, pending())
    expect(await b.evaluate(async value => { try { await (window as any).store.get(value); return false } catch { return true } }, owner)).toBe(true)
  })
  it('checks a queued scope again after the real owner lock and preserves the empty store', async () => {
    await a.evaluate(value => {
      const w = window as any
      w.holding = w.generationRecovery.withGenerationOwnerLock(value, { accepts: () => true }, async () => {
        w.held = true; await new Promise(yes => { w.release = yes })
      })
    }, owner)
    await a.waitForFunction(() => (window as any).held)
    await b.evaluate(value => {
      const w = window as any; w.allowed = true
      w.waiting = w.store.claim(value, { accepts: () => w.allowed }).then(() => false, () => true)
    }, pending())
    expect(await b.evaluate(value => (window as any).store.get(value), owner)).toBeNull()
    await b.evaluate(() => { (window as any).allowed = false })
    await a.evaluate(async () => { (window as any).release(); await (window as any).holding })
    expect(await b.evaluate(() => (window as any).waiting)).toBe(true)
    expect(await a.evaluate(value => (window as any).store.get(value), owner)).toBeNull()
  })
  it('reuses only a live owner lease for nested original CAS without deadlocking', async () => {
    expect(await a.evaluate(async value => {
      const w = window as any
      return w.generationRecovery.withGenerationOwnerLock(value.owner, { accepts: () => true }, async (scope: unknown) => {
        w.expired = scope
        const claimed = await w.store.claim(value, scope), cleared = await w.store.clear(value, scope)
        return { claimed, cleared }
      })
    }, pending())).toEqual({ claimed: true, cleared: true })
    expect(await a.evaluate(async value => { const w = window as any; try { await w.store.claim(value, w.expired); return false } catch { return true } }, pending())).toBe(true)
    expect(await b.evaluate(value => (window as any).store.get(value), owner)).toBeNull()
  })
  it('allows a different owner lock to proceed while retaining both independent originals', async () => {
    const other = { ...pending(), owner: { ...owner, rbac_user_id: 20 } }
    await a.evaluate(value => {
      const w = window as any
      w.holding = w.generationRecovery.withGenerationOwnerLock(value.owner, { accepts: () => true }, async (scope: unknown) => {
        await w.store.claim(value, scope); w.held = true; await new Promise(yes => { w.release = yes })
      })
    }, pending())
    await a.waitForFunction(() => (window as any).held)
    expect(await b.evaluate(value => (window as any).store.claim(value), other)).toBe(true)
    expect(await b.evaluate(value => (window as any).store.get(value), other.owner)).toEqual(other)
    expect(await b.evaluate(value => (window as any).store.get(value), owner)).toEqual(pending())
    await a.evaluate(async () => { (window as any).release(); await (window as any).holding })
  })
  it('fails closed without Web Locks and never clears the existing original', async () => {
    await a.evaluate(value => (window as any).store.claim(value), pending())
    await b.evaluate(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }) })
    for (const action of ['claim', 'clear']) expect(await b.evaluate(async ({ action, value }) => { try { await (window as any).store[action](value); return '' } catch (error) { return (error as Error).message } }, { action, value: pending() })).toContain('当前浏览器')
    expect(await a.evaluate(value => (window as any).store.get(value), owner)).toEqual(pending())
  })

})

// Final mutations keep their original body and one immutable generation basis.
describe('finite final workflow originals', () => {
  const point = { request_id: 'final-1', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), approval_request_id: 'approval-1', expected_submission_hash: 'c'.repeat(64), expected_decision_hash: 'd'.repeat(64) }
  const fixed = { generation_id: '00000000-0000-4000-8000-000000000010', render_key: 'e'.repeat(64), plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, plan_content_hash: 'a'.repeat(64), generation_content_hash: 'f'.repeat(64), purpose: 'final', approval_request_id: 'approval-1', submission_hash: 'c'.repeat(64), decision_hash: 'd'.repeat(64), template: { id: 'welding-approval-appendix', version: '1', digest: 'b'.repeat(64) } }
  const original = (action: string, body: unknown, basis?: unknown) => ({ schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action, owner, plan_id: 'plan', item_version_id: 'v1', body, ...(basis === undefined ? {} : { basis }) })
  it('preserves final create without inventing a generation or transport', () => {
    const value = original('final-render', { ...point, template_id: 'welding-approval-appendix', template_version: '1', template_digest: 'b'.repeat(64) })
    expect(validateWorkflowPending(value)).toEqual(value)
    expect(Object.keys(validateWorkflowPending(value))).toHaveLength(7)
  })
  it('preserves release with the two original Ready file hashes', () => {
    const value = original('release', { ...point, final_generation_id: fixed.generation_id, expected_final_pdf_sha256: '1'.repeat(64), expected_final_docx_sha256: '2'.repeat(64) })
    expect(validateWorkflowPending(value)).toEqual(value)
    expect(Object.keys(validateWorkflowPending(value))).toHaveLength(7)
  })
  it('preserves retry as eight keys with generation only in fixed basis', () => {
    const value = original('final-retry', { request_id: 'retry-1', expected_attempt: 0 }, fixed)
    expect(validateWorkflowPending(value)).toEqual(value)
    expect(Object.keys(validateWorkflowPending(value))).toHaveLength(8)
    expect(validateWorkflowPending(value)).not.toHaveProperty('generation_id')
  })
  it('rejects duplicate top-level generation and a basis from another target', () => {
    const value = original('final-retry', { request_id: 'retry-1', expected_attempt: 0 }, fixed)
    expect(() => validateWorkflowPending({ ...value, generation_id: fixed.generation_id })).toThrow()
    expect(() => validateWorkflowPending({ ...value, basis: { ...fixed, item_version_id: 'v2' } })).toThrow()
  })
})


describe('C3 original revision envelope', () => {
  it('retains five body fields and rejects ACK or transport fields in durable originals', () => {
    const original = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', owner, plan_id: 'plan', item_version_id: 'v1', action: 'revise', body: { request_id: 'revision-original', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), reason: ' 原因 ' } }
    expect(validateWorkflowPending(original)).toEqual(original)
    for (const patch of [{ ack: {} }, { basis: {} }, { body: { ...original.body, payload: {} } }, { body: { ...original.body, generation_id: 'fake' } }]) expect(() => validateWorkflowPending({ ...original, ...patch })).toThrow()
  })
})
