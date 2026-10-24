// @vitest-environment node
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import ts from 'typescript'
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const names = ['planRecovery', 'resourceContracts', 'resourceImportContracts', 'planClient', 'commandRecovery']
const oldNames = ['planRecovery', 'resourceContracts', 'planClient', 'commandRecovery']
const oldHashes: Record<string, string> = {
  commandRecovery: 'f5bceb8bff8f5d6e8786d4b05310582ff699f2584835effb877cb17a07054cdc',
  planClient: 'ec18e6e1a503c1228ea6449622b702e8954c11a564e32353bcb16b6ad388377d',
  planRecovery: '20b244acf3f0dc88f3325dd9be8bd752be72a1b9f62f10d5538d0e2603bbe635',
  resourceContracts: '4cc6a355543250efc7af5862e6b7a3e8f9bdbcc0925ec3efe8a3b627bc3d3dcf',
}
const paths = [...names.map(name => resolve(`src/services/welding/${name}.ts`)), ...oldNames.map(name => resolve(`tests/fixtures/welding-resource-import-old-v1/${name}.ts.txt`)), resolve('tests/welding-resource-import-native.spec.ts')]
const pins = () => paths.map(path => { const info = lstatSync(path); expect(info.isFile() && !info.isSymbolicLink()).toBe(true); return { path, mode: info.mode & 0o777, bytes: info.size, sha256: hash(readFileSync(path)) } })
describe('actual Chromium binary import recovery and sealed old v1 compatibility', () => {
  let browser: Browser, context: BrowserContext, a: Page, b: Page, out: string, bootstrap: string, oldBootstrap: string, executable: string, binaryHash: string
  let before: ReturnType<typeof pins>
  const results: Array<Record<string, unknown>> = []
  function write(name: string, value: unknown) { const raw = JSON.stringify(value, null, 2) + '\n'; expect(Buffer.byteLength(raw)).toBeLessThan(256 * 1024); writeFileSync(resolve(out, name), raw) }
  function receipt(name: string, value: Record<string, unknown>) { results.push({ name, ...value }); write('native-results.json', { results }) }
  const runtime = `window.makeImport=async function(owner={tenant_id:'synthetic-tenant',org_id:'synthetic-org',auth_user_id:7,rbac_user_id:19},size=1024){const bytes=new ArrayBuffer(size),view=new Uint8Array(bytes);for(let i=0;i<view.length;i++)view[i]=(i*37)&255;return window.contracts.validateImportPending({schema:'metasheet.welding_resource_import_pending/1',kind:'resource-import',owner,import_id:'batch-original',format:'csv',bytes,raw_sha256:await window.contracts.hashImportBytes(bytes),normalized_sha256:'b'.repeat(64),preview_digest:'c'.repeat(64),total_rows:2,rows:[{row:2,row_key:'first',name:'钢',number:'001',kind:'material'},{row:3,row_key:'last',name:'Filler',number:'002',kind:'filler'}]})};window.rawRecord=async function(owner,writeValue){const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('metasheet-welding-command-recovery',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});try{return await new Promise((resolve,reject)=>{const tx=db.transaction('pending',writeValue===undefined?'readonly':'readwrite'),key=['resource-import',owner.tenant_id,owner.org_id,owner.auth_user_id,owner.rbac_user_id],store=tx.objectStore('pending');let value;if(writeValue===undefined){const request=store.get(key);request.onsuccess=()=>{value=request.result}}else store.put(writeValue,key);tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error)})}finally{db.close()}};`
  beforeAll(async () => {
    expect(process.env.WELDING_FOUNDATION_RUN_LABEL).toBe('resource-import-native-1')
    const output = process.env.WELDING_FOUNDATION_OUTPUT_DIR!
    expect(isAbsolute(output) && realpathSync(output) === output && lstatSync(output).isDirectory()).toBe(true)
    out = resolve(output, 'resource-import-native-1'); mkdirSync(out)
    executable = process.env.WELDING_UI_CHROMIUM_EXECUTABLE!
    expect(isAbsolute(executable) && lstatSync(executable).isFile()).toBe(true); binaryHash = hash(readFileSync(executable)); before = pins()
    const compile = (moduleNames: string[], old: boolean) => moduleNames.map(name => {
      const path = resolve(old ? `tests/fixtures/welding-resource-import-old-v1/${name}.ts.txt` : `src/services/welding/${name}.ts`), source = readFileSync(path, 'utf8')
      if (old) expect(hash(source)).toBe(oldHashes[name])
      return { name, path, source, compiled: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText }
    })
    const current = compile(names, false), old = compile(oldNames, true)
    expect(hash(old.find(input => input.name === 'commandRecovery')!.compiled)).toBe('301a9a3434bf7df7220ce05b3f390b585a389e8d9d284b33418383b7d4a0908a')
    const wrap = (inputs: typeof current) => `(function(){const modules={};const unloaded=()=>{throw new Error('auth/transport is outside native storage qualification')};modules['../../utils/api']={apiFetch:unloaded};modules['../../composables/authPrincipal']={readStoredToken:unloaded,readAuthSessionSignature:unloaded};${inputs.map(input => `modules['./${input.name}']=(function(){const exports={};const require=name=>modules[name];${input.compiled};return exports})();`).join('')}window.recovery=modules['./commandRecovery'];window.contracts=modules['./resourceImportContracts'];})();`
    bootstrap = wrap(current) + runtime; oldBootstrap = wrap(old)
    writeFileSync(resolve(out, 'new-module.js'), bootstrap); writeFileSync(resolve(out, 'old-v1-module.js'), oldBootstrap)
    write('inputs.json', { source_pins: before, modules: current.map(input => ({ name: input.name, source_sha256: hash(input.source), compiled_sha256: hash(input.compiled) })),
      old_modules: old.map(input => ({ name: input.name, source_sha256: hash(input.source), compiled_sha256: hash(input.compiled) })), bootstrap_sha256: hash(bootstrap), old_bootstrap_sha256: hash(oldBootstrap), executable, executable_sha256: binaryHash, typescript: ts.version,
      boundary: 'actual new five TS modules plus separately sealed D old four-module closure; real Chromium IDB/Web Locks; intercepted empty same-origin HTML; no domain API, SSO, CSV/XLSX parser or business qualification' })
    browser = await chromium.launch({ headless: true, executablePath: executable, timeout: 30000 })
  }, 30000)
  async function install(page: Page, old = false) { await page.addScriptTag({ content: old ? oldBootstrap : bootstrap }); await page.evaluate(async () => { (window as any).store = await (window as any).recovery.openGenerationRecoveryStore(indexedDB) }) }
  beforeEach(async () => {
    context = await browser.newContext(); await context.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Binary import storage</title>' }) : route.abort())
    a = await context.newPage(); b = await context.newPage()
    for (const page of [a, b]) { await page.goto('http://localhost/'); await install(page) }
  })
  afterEach(async () => { await context?.close() })
  afterAll(async () => {
    await browser?.close()
    if (out) { const after = pins(), afterBinary = hash(readFileSync(executable)); write('exit.json', { source_pins_after: after, executable_sha256_after: afterBinary, inputs_equal: JSON.stringify(before) === JSON.stringify(after), closed: !browser?.isConnected(), browser_version: browser?.version(), cases_recorded: results.length }); expect(after).toEqual(before); expect(afterBinary).toBe(binaryHash); expect(browser?.isConnected()).toBe(false) }
  }, 30000)
  it('roundtrips every byte of a 5 MiB buffer across copies, page reload and close/reopen', async () => {
    const saved = await a.evaluate(async () => {
      const w = window as any, value = await w.makeImport(undefined, 5 * 1024 * 1024); w.original = value
      const result = await w.store.claimResourceImport(value); new Uint8Array(value.bytes)[0] = 200
      const read = await w.store.getResourceImport(value.owner), raw = await w.rawRecord(value.owner)
      const all = new Uint8Array(read.bytes).every((byte, index) => byte === ((index * 37) & 255)); new Uint8Array(read.bytes)[1] = 0
      const reread = await w.store.getResourceImport(value.owner)
      return { result, all, binary: raw.bytes instanceof ArrayBuffer, length: raw.bytes.byteLength, hash: read.raw_sha256, owner: value.owner, isolated: new Uint8Array(reread.bytes)[0] === 0 && new Uint8Array(reread.bytes)[1] === 37 }
    })
    expect(saved).toMatchObject({ result: true, all: true, binary: true, length: 5 * 1024 * 1024, isolated: true })
    await a.close(); await b.reload(); await install(b)
    const restored = await b.evaluate(async owner => { const w = window as any; w.store.close(); w.store = await w.recovery.openGenerationRecoveryStore(indexedDB); const value = await w.store.getResourceImport(owner); return { hash: value.raw_sha256, all: new Uint8Array(value.bytes).every((byte, i) => byte === ((i * 37) & 255)) } }, saved.owner)
    expect(restored).toEqual({ hash: saved.hash, all: true }); receipt('binary-reopen', { ...saved, restored })
  })
  it('full CAS detects every byte, all owner fields, ordered rows and every command binding', async () => {
    const result = await a.evaluate(async () => {
      const w = window as any, value = await w.makeImport(); await w.store.claimResourceImport(value)
      const changedBytes = value.bytes.slice(0); new Uint8Array(changedBytes)[100]++
      const patches = [{ format: 'xlsx' }, { import_id: 'other' }, { preview_digest: 'a'.repeat(64) }, { normalized_sha256: 'a'.repeat(64) },
        { rows: [...value.rows].reverse() }, { rows: value.rows.map((row: object) => ({ ...row, name: 'other' })) }, { bytes: changedBytes, raw_sha256: await w.contracts.hashImportBytes(changedBytes) }]
      const checks = []
      for (const patch of patches) { const changed = w.contracts.validateImportPending({ ...value, ...patch }); checks.push(!await w.store.claimResourceImport(changed) && !await w.store.clearResourceImport(changed)) }
      for (const key of ['tenant_id', 'org_id', 'auth_user_id', 'rbac_user_id']) {
        const owner = { ...value.owner, [key]: typeof value.owner[key] === 'number' ? 99 : 'other' }
        checks.push(!await w.store.clearResourceImport({ ...value, owner }))
      }
      const intact = w.contracts.equalImportPending(await w.store.getResourceImport(value.owner), value)
      const idempotent = await w.store.claimResourceImport(value), cleared = await w.store.clearResourceImport(value), missing = await w.store.clearResourceImport(value)
      return { checks, intact, idempotent, cleared, missing }
    })
    expect(result.checks.every(Boolean)).toBe(true); expect(result).toMatchObject({ intact: true, idempotent: true, cleared: true, missing: false }); receipt('full-cas', result)
  })
  it('two native pages race for one owner while other owners remain independent', async () => {
    const claims = await Promise.all([a.evaluate(async () => { const w = window as any; w.original = await w.makeImport(); return w.store.claimResourceImport(w.original) }),
      b.evaluate(async () => { const w = window as any; w.original = { ...await w.makeImport(), import_id: 'other-batch' }; return w.store.claimResourceImport(w.original) })])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const result = await b.evaluate(async () => { const w = window as any, value = await w.makeImport({ ...w.original.owner, org_id: 'another-org' }); return { other: await w.store.claimResourceImport(value), original: (await w.store.getResourceImport(w.original.owner)).import_id } })
    expect(result.other).toBe(true); expect(result.original).toBe(claims[0] ? 'batch-original' : 'other-batch'); receipt('two-pages', { claims, ...result })
  })
  it('rejects the ninth import owner and corrupt metadata/hash without deleting the first eight', async () => {
    const result = await a.evaluate(async () => {
      const w = window as any, saved = []
      for (let i = 1; i <= 8; i++) { const value = await w.makeImport({ tenant_id: 'synthetic-tenant', org_id: 'synthetic-org', auth_user_id: i, rbac_user_id: 19 }); await w.store.claimResourceImport(value); saved.push(value) }
      let ninth = false; try { await w.store.claimResourceImport(await w.makeImport({ ...saved[0].owner, auth_user_id: 9 })) } catch { ninth = true }
      const original = saved[0], corrupt = { ...original, bytes: original.bytes.slice(0) }; new Uint8Array(corrupt.bytes)[0] = 255
      await w.rawRecord(original.owner, corrupt); const rejects = []
      for (const action of [() => w.store.getResourceImport(original.owner), () => w.store.claimResourceImport(original), () => w.store.clearResourceImport(original)]) { try { await action(); rejects.push(false) } catch { rejects.push(true) } }
      const raw = await w.rawRecord(original.owner), rest = []
      for (const value of saved.slice(1)) rest.push(w.contracts.equalImportPending(await w.store.getResourceImport(value.owner), value))
      await w.rawRecord(original.owner, { ...original, owner: { ...original.owner, rbac_user_id: 88 } })
      let ownerRejected = false; try { await w.store.getResourceImport(original.owner) } catch { ownerRejected = true }
      return { ninth, rejects, corruptedBytePreserved: new Uint8Array(raw.bytes)[0] === 255, rest, ownerRejected }
    })
    expect(result).toMatchObject({ ninth: true, corruptedBytePreserved: true, ownerRejected: true }); expect(result.rejects.every(Boolean) && result.rest.every(Boolean)).toBe(true); receipt('capacity-corruption', result)
  })
  it('native abort after put/delete and synthetic quota injection preserve existing entries', async () => {
    const result = await a.evaluate(async () => {
      const w = window as any, value = await w.makeImport(), nativePut = IDBObjectStore.prototype.put, nativeDelete = IDBObjectStore.prototype.delete
      let putAbort = false, quota = false, deleteAbort = false
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) { const request = nativePut.apply(this, args); this.transaction.abort(); return request }
      try { await w.store.claimResourceImport(value) } catch { putAbort = true } finally { IDBObjectStore.prototype.put = nativePut }
      const empty = await w.store.getResourceImport(value.owner) === null; await w.store.claimResourceImport(value)
      IDBObjectStore.prototype.put = function () { throw new DOMException('synthetic quota injection', 'QuotaExceededError') }
      try { await w.store.claimResourceImport({ ...value, owner: { ...value.owner, auth_user_id: 88 } }) } catch { quota = true } finally { IDBObjectStore.prototype.put = nativePut }
      IDBObjectStore.prototype.delete = function (key) { const request = nativeDelete.call(this, key); this.transaction.abort(); return request }
      try { await w.store.clearResourceImport(value) } catch { deleteAbort = true } finally { IDBObjectStore.prototype.delete = nativeDelete }
      return { putAbort, empty, quota, deleteAbort, intact: w.contracts.equalImportPending(await w.store.getResourceImport(value.owner), value), quota_boundary: 'synthetic QuotaExceededError injection, not real disk exhaustion' }
    })
    expect(result).toMatchObject({ putAbort: true, empty: true, quota: true, deleteAbort: true, intact: true }); receipt('abort-and-injected-quota', result)
  })
  it('sealed D old module retains generation/workflow/resource behavior beside new binary records in the same v1 store', async () => {
    await a.evaluate(async () => { const w = window as any; w.original = await w.makeImport(); await w.store.claimResourceImport(w.original) })
    await b.evaluate(() => (window as any).store.close()); await b.reload(); await install(b, true)
    const old = await b.evaluate(async () => {
      const w = window as any, owner = { tenant_id: 'synthetic-tenant', org_id: 'synthetic-org', auth_user_id: 7, rbac_user_id: 19 }
      const generation = { schema: 'metasheet.welding_command_pending/1', kind: 'generation', action: 'create', owner, plan_id: 'plan', item_version_id: 'v1', basis: null,
        body: { request_id: '00000000-0000-4000-8000-000000000001', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), purpose: 'review', template_id: 'welding-a4', template_version: '1', template_digest: 'b'.repeat(64), template_options: { organization_name: '', header_text: '', footer_text: '', optional_columns: [], logo: null } } }
      const workflow = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'withdraw', owner, plan_id: 'another-plan', item_version_id: 'v1', body: { request_id: 'workflow-original', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), approval_request_id: 'approval', expected_submission_hash: 'b'.repeat(64), reason: 'Explicit withdraw' } }
      const resource = { schema: 'metasheet.welding_command_pending/1', kind: 'resource', owner, action: 'create', resource_id: 'resource', source: null,
        body: { resource_id: 'resource', request_id: 'resource-original', name: 'Steel', number: 'M001', payload: { schema_version: 1, kind: 'material', suggested_fields: {} } } }
      const claims = [await w.store.claim(generation), await w.store.claimWorkflow(workflow), await w.store.claimResource(resource)]
      const reads = [JSON.stringify(await w.store.get(owner)) === JSON.stringify(generation), JSON.stringify(await w.store.getWorkflow(owner, 'another-plan', 'v1')) === JSON.stringify(workflow), JSON.stringify(await w.store.getResource(owner)) === JSON.stringify(resource)]
      // Eight old resource slots still fit while a new import record exists outside its prefix range.
      for (let i = 1; i <= 7; i++) await w.store.claimResource({ ...resource, owner: { ...owner, auth_user_id: 100 + i } })
      const clears = [await w.store.clear(generation), await w.store.clearWorkflow(workflow), await w.store.clearResource(resource)]
      w.store.close(); return { claims, reads, clears, oldImportMethodAbsent: typeof w.recovery.getResourceImport === 'undefined' && !w.contracts }
    })
    expect(old.claims.every(Boolean) && old.reads.every(Boolean) && old.clears.every(Boolean)).toBe(true); expect(old.oldImportMethodAbsent).toBe(true)
    const intact = await a.evaluate(async () => { const w = window as any; w.store.close(); w.store = await w.recovery.openGenerationRecoveryStore(indexedDB); return w.contracts.equalImportPending(await w.store.getResourceImport(w.original.owner), w.original) })
    expect(intact).toBe(true); receipt('sealed-old-v1', { ...old, newBinaryIntact: intact })
  })
})
