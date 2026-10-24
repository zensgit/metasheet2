import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clone } from '../src/services/welding/planRecovery'
import { copyImportBytes, equalImportPending, importMetadata, validateImportIssues, validateImportPending, validateImportPreview, validateImportReceipt, verifyImportPending, IMPORT_METADATA_BYTES, IMPORT_RAW_BYTES } from '../src/services/welding/resourceImportContracts'
import { importCrypto, importPending, importPreview, importRaw, importReceipt, rawHash } from './utils/weldingResourceImportFixtures'
import { resourceKinds } from '../src/services/welding/resourceContracts'

beforeEach(() => { vi.stubGlobal('crypto', importCrypto) })
afterEach(() => vi.unstubAllGlobals())
describe('exact whole resource import contracts', () => {
  it('accepts all 100 rows and trailing payload, leading zero and Unicode content without normalization', () => {
    const preview = importPreview(100); preview.rows[99].payload.suggested_fields.material_a = '钢\n中文'
    expect(validateImportPreview(preview, 'csv', preview.raw_sha256)).toEqual(preview)
    expect(preview.rows[99].row).toBe(101)
    const pending = importPending(100), receipt = importReceipt(pending)
    expect(validateImportReceipt(receipt, pending)).toEqual(receipt)
    expect(receipt).not.toHaveProperty('format')
  })
  it('uses the actual Y literal SafeId boundary for row keys and import IDs', () => {
    const preview = importPreview(); preview.rows[0].row_key = 'row/%\\literal'
    expect(validateImportPreview(preview, 'csv', preview.raw_sha256)).toEqual(preview)
    const pending = importPending(); pending.import_id = 'batch/%\\literal'; pending.rows[0].row_key = preview.rows[0].row_key
    expect(validateImportPending(pending).import_id).toBe(pending.import_id)
    expect(validateImportReceipt(importReceipt(pending), pending).import_id).toBe(pending.import_id)
    for (const row_key of ['\u0085key', 'key\u001c', 'key\n']) expect(() => validateImportPending({ ...pending, rows: [{ ...pending.rows[0], row_key }] })).toThrow()
  })
  it.each(resourceKinds)('accepts the complete %s payload and only its qualified fixed sources', kind => {
    const preview = importPreview(), row = preview.rows[0]
    row.payload = { schema_version: 1, kind, suggested_fields: kind === 'requirements' ? { welding_requirements: '中文\n下一行', inspection_requirements: '' } : {} }
    if (['wps', 'pqr', 'joint_diagram'].includes(kind)) {
      row.payload.document = { item_id: 'doc/one', version_id: 'doc%v1', file_id: 'file', file_role: 'reference', expected_fingerprint: 'e'.repeat(64) }
      row.sources = { document: { item_id: 'doc/one', version_id: 'doc%v1', file_id: 'file', file_role: 'reference', fingerprint: 'e'.repeat(64), checksum: 'f'.repeat(64), title: 'Document', file_name: '固定文件', version_label: null, state: 'Released', is_released: true },
        ...(kind === 'joint_diagram' ? { diagram: { schema: 'yuantus.welding_joint_diagram/1', actual_sha256: 'f'.repeat(64), byte_size: 16, mime_type: 'image/png', format: 'png', width: 2, height: 2, exif_orientation: 1 } } : {}) }
    }
    expect(validateImportPreview(preview, 'csv', preview.raw_sha256)).toEqual(preview)
    if (row.payload.document) { row.payload.document.expected_fingerprint = 'a'.repeat(64); expect(() => validateImportPreview(preview, 'csv', preview.raw_sha256)).toThrow() }
  })
  it('accepts a header-only file and a not-ready valid-row subset without qualified sources', () => {
    const empty = { ...importPreview(0), ready: false, preview_digest: null, errors: [{ row: null, column: '', code: 'empty', message: 'Import requires a data row' }] }
    expect(validateImportPreview(empty, 'csv', empty.raw_sha256)).toEqual(empty)
    const subset = importPreview(100); subset.ready = false; subset.preview_digest = null; subset.rows = subset.rows.slice(0, 99)
    delete subset.rows[0].sources; subset.errors = [{ row: 101, column: 'name', code: 'schema', message: 'Invalid final row' }]
    expect(validateImportPreview(subset, 'csv', subset.raw_sha256)).toEqual(subset)
    expect(() => validateImportPreview({ ...subset, ready: true, preview_digest: 'c'.repeat(64), errors: [] }, 'csv', subset.raw_sha256)).toThrow()
  })
  it.each([1, 102, -1, '2'])('rejects invalid issue row %s instead of clipping it', row => {
    expect(() => validateImportIssues([{ row, column: 'name', code: 'bad', message: 'Invalid' }])).toThrow()
  })
  it('validates a trailing receipt identity, duplicate version/resource, hashes, schema and extra format', () => {
    const pending = importPending(100), receipt = importReceipt(pending)
    for (const patch of [{ name: 'another' }, { row_key: 'different' }, { kind: 'filler' }, { state: 'Released' }, { resource_id: receipt.items[0].resource_id }, { item_version_id: receipt.items[0].item_version_id }, { content_hash: 'D'.repeat(64) }]) {
      const bad = clone(receipt); Object.assign(bad.items[99], patch); expect(() => validateImportReceipt(bad, pending)).toThrow()
    }
    for (const patch of [{ schema: 'wrong' }, { import_id: 'other' }, { raw_sha256: 'a'.repeat(64) }, { normalized_sha256: 'a'.repeat(64) }, { preview_digest: 'a'.repeat(64) }, { total_rows: 99 }, { format: 'csv' }, { items: receipt.items.slice(0, 99) }, { items: [...receipt.items].reverse() }])
      expect(() => validateImportReceipt({ ...receipt, ...patch }, pending)).toThrow()
    // An opaque Y hash has no preview-side expected hash: only fixed read can compare it.
    const opaque = clone(receipt); opaque.items[99].content_hash = 'e'.repeat(64)
    expect(validateImportReceipt(opaque, pending)).toEqual(opaque)
  })
  it('copies a full 5 MiB ordinary buffer and keeps binary out of JSON metadata', async () => {
    const bytes = new Uint8Array(IMPORT_RAW_BYTES); bytes[0] = 255; bytes[bytes.length - 1] = 128
    const pending = importPending(100, bytes.buffer), result = await verifyImportPending(pending)
    expect(result.bytes).not.toBe(pending.bytes); expect(new Uint8Array(result.bytes)).toEqual(bytes)
    expect(new TextEncoder().encode(JSON.stringify(importMetadata(pending))).length).toBeLessThan(IMPORT_METADATA_BYTES)
    expect(importMetadata(pending)).not.toHaveProperty('bytes')
    bytes[0] = 0; expect(new Uint8Array(pending.bytes)[0]).toBe(255)
    expect(() => copyImportBytes(new Uint8Array(1))).toThrow()
    expect(() => copyImportBytes(new ArrayBuffer(0))).toThrow()
    expect(() => copyImportBytes(new ArrayBuffer(IMPORT_RAW_BYTES + 1))).toThrow()
  })
  it('rejects actual oversized UTF-8 metadata and corrupted raw digest without altering input', async () => {
    const pending = importPending(), before = new Uint8Array(pending.bytes).slice()
    await expect(verifyImportPending({ ...pending, raw_sha256: 'a'.repeat(64) })).rejects.toThrow()
    expect(new Uint8Array(pending.bytes)).toEqual(before)
    expect(() => validateImportPending({ ...pending, owner: { ...pending.owner, tenant_id: '钢'.repeat(180000) } })).toThrow()
  })
  it('full equality includes every byte, owner member, row order and metadata field', () => {
    const pending = importPending(2)
    expect(equalImportPending(validateImportPending(pending), pending)).toBe(true)
    for (const key of ['tenant_id', 'org_id', 'auth_user_id', 'rbac_user_id'] as const) {
      const owner = { ...pending.owner, [key]: typeof pending.owner[key] === 'number' ? 99 : 'other' }
      expect(equalImportPending(validateImportPending({ ...pending, owner }), pending)).toBe(false)
    }
    for (const patch of [{ format: 'xlsx' }, { import_id: 'other' }, { normalized_sha256: 'a'.repeat(64) }, { preview_digest: 'a'.repeat(64) }, { rows: [...pending.rows].reverse() }, { rows: pending.rows.map(row => ({ ...row, name: 'other' })) }])
      expect(equalImportPending(validateImportPending({ ...pending, ...patch }), pending)).toBe(false)
    const bytes = importRaw(); new Uint8Array(bytes)[7]++
    expect(equalImportPending(validateImportPending({ ...pending, bytes, raw_sha256: rawHash(bytes) }), pending)).toBe(false)
  })
})
