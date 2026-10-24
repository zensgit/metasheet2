import { createHash, webcrypto } from 'node:crypto'
import { importIdentities, validateImportPending, type ResourceImportPending, type ResourceImportPreview, type ResourceImportReceipt } from '../../src/services/welding/resourceImportContracts'
// Node 20 WebCrypto needs a Node-realm copy of JSDOM bytes; keep the real digest.
export const importCrypto = { subtle: { digest: (algorithm: string, bytes: ArrayBuffer) => webcrypto.subtle.digest(algorithm, Buffer.from(new Uint8Array(bytes))) } }
export const importOwner = { tenant_id: 'synthetic-tenant', org_id: 'synthetic-org', auth_user_id: 7, rbac_user_id: 19 }
export const importRaw = () => new Uint8Array([0, 255, 128, 13, 10, 48, 48, 49]).buffer
export const rawHash = (value: ArrayBuffer) => createHash('sha256').update(new Uint8Array(value)).digest('hex')
export function importPreview(count = 1, bytes = importRaw()): ResourceImportPreview {
  return { schema: 'yuantus.welding_resource_import/1', format: 'csv', raw_sha256: rawHash(bytes), normalized_sha256: 'b'.repeat(64), preview_digest: 'c'.repeat(64), total_rows: count, ready: true,
    rows: Array.from({ length: count }, (_, index) => ({ row: index + 2, row_key: `row-${index}`, name: `资料 ${index}`, number: `00${index}`,
      payload: { schema_version: 1, kind: 'material', suggested_fields: { material_a: '钢', material_b: '' } }, sources: {} })), errors: [] }
}
export function importPending(count = 1, bytes = importRaw()): ResourceImportPending {
  const preview = importPreview(count, bytes)
  return validateImportPending({ schema: 'metasheet.welding_resource_import_pending/1', kind: 'resource-import', owner: importOwner,
    import_id: 'batch-original', format: preview.format, bytes, raw_sha256: preview.raw_sha256, normalized_sha256: preview.normalized_sha256,
    preview_digest: preview.preview_digest, total_rows: count, rows: importIdentities(preview.rows) })
}
export function importReceipt(pending = importPending()): ResourceImportReceipt {
  return { schema: 'yuantus.welding_resource_import/1', import_id: pending.import_id, raw_sha256: pending.raw_sha256,
    normalized_sha256: pending.normalized_sha256, preview_digest: pending.preview_digest, total_rows: pending.total_rows,
    items: pending.rows.map(row => ({ ...row, resource_id: `resource-${row.row}`, item_version_id: `version-${row.row}`, version_label: '1.A', content_hash: 'd'.repeat(64), state: 'Draft' })) }
}
