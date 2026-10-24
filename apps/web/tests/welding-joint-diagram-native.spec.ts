// @vitest-environment node
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import ts from 'typescript'
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ResourceMaintenanceRecord } from '../src/services/welding/resourceContracts'

interface Fixture { name: string; format: 'png' | 'jpeg' | 'webp'; mime_type: string; exif_orientation: number; display_width: number; display_height: number; bytes: number; sha256: string }
const fixtureRoot = resolve('tests/fixtures/welding-joint-diagrams-native')
const fixtures = JSON.parse(readFileSync(resolve(fixtureRoot, 'manifest.json'), 'utf8')).fixtures as Fixture[]
const owner = { tenant_id: 'synthetic-tenant', org_id: 'synthetic-org', auth_user_id: 7, rbac_user_id: 19 }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const moduleNames = ['planRecovery', 'resourceContracts', 'resourceImportContracts', 'planClient', 'commandRecovery']
const paths = [...moduleNames.map(name => resolve(`src/services/welding/${name}.ts`)), resolve('tests/welding-joint-diagram-native.spec.ts'),
  ...['manifest.json', 'generate.py', 'README.md', ...fixtures.map(row => row.name)].map(name => resolve(fixtureRoot, name))]
const pins = () => paths.map(path => {
  const info = lstatSync(path); expect(info.isFile() && !info.isSymbolicLink()).toBe(true)
  return { path, mode: info.mode & 0o777, bytes: info.size, sha256: hash(readFileSync(path)) }
})
const record = (row: Fixture): ResourceMaintenanceRecord => ({ resource_id: 'native-diagram', item_version_id: 'native-diagram-v1', name: 'Synthetic corner image', number: 'SYNTHETIC-J1', kind: 'joint_diagram', content_hash: 'a'.repeat(64), state: 'Draft', version_label: 'A',
  payload: { schema_version: 1, kind: 'joint_diagram', suggested_fields: {}, document: { item_id: 'synthetic-doc', version_id: 'synthetic-doc-v1', file_id: 'synthetic-file', file_role: 'reference', expected_fingerprint: 'c'.repeat(64) } },
  sources: { document: { item_id: 'synthetic-doc', version_id: 'synthetic-doc-v1', file_id: 'synthetic-file', file_role: 'reference', fingerprint: 'c'.repeat(64), checksum: row.sha256, title: 'Synthetic corner image', file_name: row.name, version_label: 'A', state: 'Released', is_released: true },
    diagram: { schema: 'yuantus.welding_joint_diagram/1', actual_sha256: row.sha256, byte_size: row.bytes, mime_type: row.mime_type, format: row.format, width: row.display_width, height: row.display_height, exif_orientation: row.exif_orientation } } })
const colors = { red: [240, 30, 30], green: [30, 220, 40], blue: [30, 50, 240], yellow: [240, 220, 30] }
// Independent EXIF expectations, in displayed TL/TR/BL/BR order; no transpose helper supplies this oracle.
const orientationCorners = [[], ['red', 'green', 'blue', 'yellow'], ['green', 'red', 'yellow', 'blue'], ['yellow', 'blue', 'green', 'red'],
  ['blue', 'yellow', 'red', 'green'], ['red', 'blue', 'green', 'yellow'], ['blue', 'red', 'yellow', 'green'], ['yellow', 'green', 'blue', 'red'], ['green', 'yellow', 'red', 'blue']] as (keyof typeof colors)[][]
const native = process.env.WELDING_UI_CHROMIUM_EXECUTABLE !== undefined

;(native ? describe : describe.skip)('actual Chromium fixed joint diagram client and decoder (synthetic transport)', () => {
  let browser: Browser, context: BrowserContext, page: Page, out: string, bootstrap: string
  let before: ReturnType<typeof pins>, executable: string, binaryHash: string
  const results: Record<string, unknown>[] = []
  function receipt(name: string, value: Record<string, unknown>) { results.push({ name, ...value }); boundedJson('native-results.json', { results }) }
  function boundedJson(name: string, value: unknown) { const raw = JSON.stringify(value, null, 2) + '\n'; expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(128 * 1024); writeFileSync(resolve(out, name), raw) }
  beforeAll(async () => {
    expect(process.env.WELDING_FOUNDATION_RUN_LABEL).toBe('joint-diagram-native-1')
    const output = process.env.WELDING_FOUNDATION_OUTPUT_DIR!
    expect(isAbsolute(output) && realpathSync(output) === output && lstatSync(output).isDirectory()).toBe(true)
    out = resolve(output, 'joint-diagram-native-1'); mkdirSync(out)
    executable = process.env.WELDING_UI_CHROMIUM_EXECUTABLE!
    expect(isAbsolute(executable) && lstatSync(executable).isFile()).toBe(true); binaryHash = hash(readFileSync(executable))
    before = pins(); expect(fixtures).toHaveLength(10)
    for (const row of fixtures) { const data = readFileSync(resolve(fixtureRoot, row.name)); expect(data.length).toBe(row.bytes); expect(hash(data)).toBe(row.sha256) }
    const inputs = moduleNames.map(name => {
      const path = resolve(`src/services/welding/${name}.ts`), source = readFileSync(path, 'utf8')
      return { name, path, source, compiled: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText }
    })
    bootstrap = `(function(){const modules={};window.syntheticDiagramToken='synthetic-only';window.syntheticDiagramSignature='synthetic-owner-1';modules['../../utils/api']={apiFetch:()=>{throw new Error('domain API is outside this native fixture')}};modules['../../composables/authPrincipal']={readStoredToken:()=>window.syntheticDiagramToken,readAuthSessionSignature:()=>window.syntheticDiagramSignature};${inputs.map(input => `modules['./${input.name}']=(function(){const exports={};const require=name=>modules[name];${input.compiled};return exports})();`).join('')}window.nativeJointDiagram=modules['./planClient'];})();`
    expect(Buffer.byteLength(bootstrap)).toBeLessThanOrEqual(1024 * 1024); writeFileSync(resolve(out, 'image-module.js'), bootstrap)
    boundedJson('inputs.json', { source_pins: before, compiled: inputs.map(input => ({ name: input.name, sha256: hash(input.compiled) })), bootstrap_sha256: hash(bootstrap), executable, executable_sha256: binaryHash, typescript: ts.version,
      boundary: 'actual five TS modules; explicit synthetic token/signature and authority; controlled native Response streams; empty HTML; actual Chrome Image/Canvas/Blob; no Vue component, domain HTTP, real SSO or professional qualification' })
    browser = await chromium.launch({ headless: true, executablePath: executable, timeout: 30000 })
  }, 30000)
  beforeEach(async () => {
    context = await browser.newContext(); await context.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic joint decoder</title>' }) : route.abort())
    page = await context.newPage(); await page.goto('http://localhost/'); await page.addScriptTag({ content: bootstrap })
  })
  afterEach(async () => { await context?.close() })
  afterAll(async () => {
    await browser?.close()
    if (out) {
      const after = pins(), afterHash = hash(readFileSync(executable))
      boundedJson('exit.json', { closed: !browser?.isConnected(), browser_version: browser?.version(), executable_sha256_after: afterHash, source_pins_after: after, inputs_equal: JSON.stringify(after) === JSON.stringify(before), cases_recorded: results.length })
      expect(after).toEqual(before); expect(afterHash).toBe(binaryHash); expect(browser?.isConnected()).toBe(false)
    }
  }, 30000)
  it.each(fixtures)('decodes $name with native display dimensions, corner orientation and revoked Blob rejection', async row => {
    const result = await page.evaluate(async ({ raw, base64, owner }) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), calls: string[] = [], diagram: any = raw.sources.diagram
      const transport = async (path: string, options: any) => {
        calls.push(path); if (options.method !== 'GET') throw new Error('unexpected method')
        if (path === '/api/welding/authority') return new Response(JSON.stringify({ schema: 'yuantus.welding_generation_authority/1', owner }))
        if (path !== '/api/welding/resources/native-diagram/versions/native-diagram-v1/diagram') throw new Error('unexpected path')
        return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 257) controller.enqueue(bytes.slice(offset, offset + 257)); controller.close() } }),
          { headers: { 'Content-Type': diagram.mime_type, 'Content-Length': String(bytes.length), 'X-Content-SHA256': diagram.actual_sha256 } })
      }
      const signal = new AbortController(), blob = await (window as any).nativeJointDiagram.createWeldingPlanClient(transport).readResourceDiagram(raw, { signal: signal.signal, accepts: () => !signal.signal.aborted })
      const url = URL.createObjectURL(blob), image = new Image()
      const loaded = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('native image load deadline')), 15000); image.onload = () => { clearTimeout(timer); resolve() }; image.onerror = () => { clearTimeout(timer); reject(new Error('native image decode failed')) } })
      image.src = url; document.body.append(image); await loaded
      const width = image.naturalWidth, height = image.naturalHeight, displayed = image.getBoundingClientRect()
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0)
      const corners = [[8, 8], [width - 9, 8], [8, height - 9], [width - 9, height - 9]].map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data))
      image.remove(); URL.revokeObjectURL(url)
      const revoked = await new Promise<boolean>((resolve, reject) => { const next = new Image(), timer = setTimeout(() => reject(new Error('revoked URL load deadline')), 15000); next.onload = () => { clearTimeout(timer); resolve(false) }; next.onerror = () => { clearTimeout(timer); resolve(true) }; next.src = url })
      return { width, height, displayed_width: displayed.width, displayed_height: displayed.height, corners, revoked, blob_bytes: blob.size, blob_type: blob.type, calls }
    }, { raw: record(row), base64: readFileSync(resolve(fixtureRoot, row.name)).toString('base64'), owner })
    expect([result.width, result.height, result.displayed_width, result.displayed_height]).toEqual([row.display_width, row.display_height, row.display_width, row.display_height])
    const tolerance = row.format === 'jpeg' ? 12 : 0
    for (let index = 0; index < 4; index++) { const expected = colors[orientationCorners[row.exif_orientation][index]]; expect(result.corners[index][3]).toBe(255); for (let channel = 0; channel < 3; channel++) expect(Math.abs(result.corners[index][channel] - expected[channel])).toBeLessThanOrEqual(tolerance) }
    expect(result.revoked).toBe(true); expect(result.blob_bytes).toBe(row.bytes); expect(result.blob_type).toBe(row.mime_type)
    expect(result.calls).toEqual(['/api/welding/authority', '/api/welding/resources/native-diagram/versions/native-diagram-v1/diagram', '/api/welding/authority'])
    receipt(row.name, result)
  }, 30000)
  it('rejects real fixture bytes with a mismatched qualified digest before publishing a Blob', async () => {
    const row = fixtures[0], raw = record(row); (raw.sources.document as any).checksum = 'b'.repeat(64); (raw.sources.diagram as any).actual_sha256 = 'b'.repeat(64)
    const result = await page.evaluate(async ({ raw, base64, owner }) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), calls: string[] = [], diagram: any = raw.sources.diagram
      const transport = async (path: string) => { calls.push(path); return path.endsWith('/authority') ? new Response(JSON.stringify({ schema: 'yuantus.welding_generation_authority/1', owner })) : new Response(bytes, { headers: { 'Content-Type': diagram.mime_type, 'Content-Length': String(bytes.length), 'X-Content-SHA256': diagram.actual_sha256 } }) }
      try { await (window as any).nativeJointDiagram.createWeldingPlanClient(transport).readResourceDiagram(raw); return { rejected: false, calls } } catch (error) { return { rejected: error instanceof Error && error.message.includes('实际摘要'), calls } }
    }, { raw, base64: readFileSync(resolve(fixtureRoot, row.name)).toString('base64'), owner })
    expect(result.rejected).toBe(true); expect(result.calls).toHaveLength(2); receipt('qualified-digest-rejection', result)
  })
  it('rejects a late native Response after selection changed without returning its Blob', async () => {
    const row = fixtures[0]
    const result = await page.evaluate(async ({ raw, base64, owner }) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), diagram: any = raw.sources.diagram, calls: string[] = []
      let current = true, release!: (response: Response) => void, reached!: () => void
      const arrived = new Promise<void>(resolve => { reached = resolve })
      const transport = (path: string) => { calls.push(path); return path.endsWith('/authority') ? Promise.resolve(new Response(JSON.stringify({ schema: 'yuantus.welding_generation_authority/1', owner }))) : new Promise<Response>(resolve => { release = resolve; reached() }) }
      const job = (window as any).nativeJointDiagram.createWeldingPlanClient(transport).readResourceDiagram(raw, { accepts: () => current }).then(() => false, () => true)
      await arrived; current = false; release(new Response(bytes, { headers: { 'Content-Type': diagram.mime_type, 'Content-Length': String(bytes.length), 'X-Content-SHA256': diagram.actual_sha256 } }))
      return { rejected: await job, calls }
    }, { raw: record(row), base64: readFileSync(resolve(fixtureRoot, row.name)).toString('base64'), owner })
    expect(result.rejected).toBe(true); expect(result.calls).toHaveLength(2); receipt('late-selection-rejection', result)
  })
  it('aborts a pending native stream and cancels its real reader without returning a Blob', async () => {
    const result = await page.evaluate(async ({ raw, owner }) => {
      const diagram: any = raw.sources.diagram, calls: string[] = [], signal = new AbortController()
      let cancelled = false, reached!: () => void; const reading = new Promise<void>(resolve => { reached = resolve })
      const stream = new ReadableStream<Uint8Array>({ pull() { reached() }, cancel() { cancelled = true } }, { highWaterMark: 0 })
      const transport = async (path: string) => { calls.push(path); return path.endsWith('/authority') ? new Response(JSON.stringify({ schema: 'yuantus.welding_generation_authority/1', owner })) : new Response(stream, { headers: { 'Content-Type': diagram.mime_type, 'Content-Length': String(diagram.byte_size), 'X-Content-SHA256': diagram.actual_sha256 } }) }
      const job = (window as any).nativeJointDiagram.createWeldingPlanClient(transport).readResourceDiagram(raw, { signal: signal.signal, accepts: () => !signal.signal.aborted }).then(() => false, () => true)
      await reading; signal.abort(); const rejected = await job; await Promise.resolve(); return { rejected, cancelled, calls }
    }, { raw: record(fixtures[0]), owner })
    expect(result).toEqual({ rejected: true, cancelled: true, calls: ['/api/welding/authority', '/api/welding/resources/native-diagram/versions/native-diagram-v1/diagram'] }); receipt('native-stream-abort', result)
  })
})
