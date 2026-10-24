import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWeldingPlanClient, WeldingResourceImportError } from '../src/services/welding/planClient'
import { IMPORT_DEADLINE_MS, IMPORT_PREVIEW_BYTES, IMPORT_RAW_BYTES, IMPORT_RESPONSE_BYTES } from '../src/services/welding/resourceImportContracts'
import type { apiFetch, ApiFetchOptions } from '../src/utils/api'
import { importPending, importPreview, importRaw, importReceipt } from './utils/weldingResourceImportFixtures'
const auth = vi.hoisted(() => ({ signature: 'synthetic-owner', token: 'synthetic-token' }))
vi.mock('../src/composables/authPrincipal', () => ({ readStoredToken: () => auth.token, readAuthSessionSignature: () => auth.signature }))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => { auth.signature = 'synthetic-owner'; auth.token = 'synthetic-token' })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('narrow bounded raw import transport', () => {
  it('sends original octets and only the exact format/id/digest query, with independent transport copies', async () => {
    const pending = importPending(), original = new Uint8Array(pending.bytes).slice(), calls: Array<{ path: string; options: ApiFetchOptions; bytes: Uint8Array }> = []
    const transport = vi.fn(async (path: string, options?: ApiFetchOptions) => {
      calls.push({ path, options: options!, bytes: new Uint8Array(options!.body as ArrayBuffer).slice() })
      new Uint8Array(options!.body as ArrayBuffer)[0] = 55
      return path.includes('/preview?') ? json(importPreview()) : json(importReceipt(pending), 201)
    })
    const client = createWeldingPlanClient(transport as typeof apiFetch)
    await client.previewResourceImport('csv', pending.bytes, pending.raw_sha256)
    await client.commitResourceImport(pending)
    expect(calls.map(row => row.path)).toEqual(['/api/welding/resources/import/preview?format=csv', `/api/welding/resources/import/commit?format=csv&import_id=batch-original&preview_digest=${pending.preview_digest}`])
    for (const call of calls) {
      expect(call.bytes).toEqual(original); expect(call.options.body).toBeInstanceOf(ArrayBuffer)
      expect(call.options).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, redirect: 'error', cache: 'no-store', suppressUnauthorizedRedirect: true })
      expect(call.path).not.toContain(auth.token)
    }
    expect(new Uint8Array(pending.bytes)).toEqual(original)
  })
  it.each(['csv', 'xlsx'] as const)('downloads a fixed %s Blob without requiring diagram digest headers', async format => {
    const mime = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const transport = vi.fn(async () => new Response(new Uint8Array([0, 255, 128]), { headers: { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="welding-resource-import-v1.${format}"` } }))
    const result = await createWeldingPlanClient(transport as typeof apiFetch).resourceImportTemplate(format)
    expect(result.blob.size).toBe(3); expect(result.filename).toBe(`welding-resource-import-v1.${format}`)
    expect(transport.mock.calls[0]).toEqual([`/api/welding/resources/import/templates/${format}`, expect.objectContaining({ method: 'GET' })])
  })
  it('preserves the complete verified issue list, including a file issue and the hundredth row', async () => {
    const issues = [{ row: null, column: '', code: 'file', message: 'File problem' }, ...Array.from({ length: 300 }, (_, i) => ({ row: 101, column: 'name', code: `issue-${i}`, message: 'Final row problem' }))]
    const client = createWeldingPlanClient(vi.fn(async () => json({ error: { code: 'INVALID', message: 'Invalid batch', issues } }, 422)) as typeof apiFetch)
    await expect(client.previewResourceImport('csv', importRaw(), importPreview().raw_sha256)).rejects.toMatchObject({ status: 422, issues })
    const invalid = createWeldingPlanClient(vi.fn(async () => json({ error: { code: 'INVALID', issues: [...issues, { row: 102, column: '', code: 'bad', message: 'bad' }] } }, 422)) as typeof apiFetch)
    await expect(invalid.previewResourceImport('csv', importRaw(), importPreview().raw_sha256)).rejects.toMatchObject({ issues: [] })
  })
  it.each(['headers', 'body'] as const)('330 s deadline ends %s wait even when transport ignores abort', async stalled => {
    vi.useFakeTimers()
    const transport = vi.fn(() => stalled === 'headers' ? new Promise<Response>(() => {}) : Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'Content-Type': 'application/json' } })))
    const result = createWeldingPlanClient(transport as typeof apiFetch).commitResourceImport(importPending())
    const assertion = expect(result).rejects.toMatchObject({ code: 'WELDING_RESULT_UNKNOWN', issues: [] })
    await vi.advanceTimersByTimeAsync(IMPORT_DEADLINE_MS); await assertion
  })
  it('aborts a stalled body promptly and refuses a late owner response', async () => {
    const controller = new AbortController()
    const client = createWeldingPlanClient(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'Content-Type': 'application/json' } })) as typeof apiFetch)
    const result = client.commitResourceImport(importPending(), { signal: controller.signal, accepts: () => true })
    const assertion = expect(result).rejects.toMatchObject({ code: 'WELDING_RESULT_UNKNOWN' }); controller.abort(); await assertion
    const stale = createWeldingPlanClient(vi.fn(async () => { auth.signature = 'other'; return json(importPreview()) }) as typeof apiFetch)
    await expect(stale.previewResourceImport('csv', importRaw(), importPreview().raw_sha256)).rejects.toThrow()
  })
  it.each(['preview', 'receipt', 'error', 'template'] as const)('rejects actual oversized %s streams without returning partial data', async kind => {
    const limit = kind === 'preview' ? IMPORT_PREVIEW_BYTES : IMPORT_RESPONSE_BYTES
    const transport = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); controller.close() } }),
      { status: kind === 'error' ? 409 : kind === 'receipt' ? 201 : 200, headers: { 'Content-Type': 'application/json' } }))
    const client = createWeldingPlanClient(transport as typeof apiFetch)
    const result = kind === 'template' ? client.resourceImportTemplate('csv') : kind === 'preview' ? client.previewResourceImport('csv', importRaw(), importPreview().raw_sha256) : client.commitResourceImport(importPending())
    await expect(result).rejects.toMatchObject({ issues: [] })
  })
  it('rejects oversized uploads before transport and malformed response length, MIME, UTF-8, redirect and success status', async () => {
    const transport = vi.fn(async () => json(importPreview())), client = createWeldingPlanClient(transport as typeof apiFetch)
    await expect(client.previewResourceImport('csv', new ArrayBuffer(IMPORT_RAW_BYTES + 1), importPreview().raw_sha256)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled()
    const responses = [new Response('{}', { headers: { 'Content-Type': 'text/html' } }), new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
      new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '-1' } }), json(importReceipt(), 200)]
    const redirect = json(importReceipt(), 201); Object.defineProperty(redirect, 'redirected', { value: true }); responses.push(redirect)
    for (const response of responses) await expect(createWeldingPlanClient(vi.fn(async () => response) as typeof apiFetch).commitResourceImport(importPending())).rejects.toBeInstanceOf(WeldingResourceImportError)
  })
})
