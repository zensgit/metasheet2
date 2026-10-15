import { describe, expect, it } from 'vitest'
import {
  isVisualGeometry, parseStoredVisualMarkup, parseVisualPreviewDescriptor,
  parseVisualPreviewDescriptorHeader, sameVisualPreview, visualMarkupWrite,
  type VisualPreviewDescriptor,
} from '../src/services/integration/plmVisualMarkup'

const descriptor: VisualPreviewDescriptor = {
  schema_version: 1, part_id: 'part-1', file_id: 'file-1', file_version: 'version-1',
  content_checksum: 'a'.repeat(64), preview_checksum: 'b'.repeat(64),
  page: 0, preview_width: 2048, preview_height: 1536, version_is_current: true,
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const { version_is_current: _current, ...binding } = descriptor
const record = () => ({ ...binding, id: 'markup-1', binding_state: 'bound', markup_type: 'rectangle',
  geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
  viewport: { width: 2048, height: 1536, rotation: 0 }, created_by_id: 1, created_at: '2026-09-30T00:00:00Z' })

describe('provider-bound visual markup DTO', () => {
  it('accepts the canonical UTF-8 descriptor and does not mutate it', () => {
    const value = { ...descriptor, part_id: '零件-1' }
    expect(parseVisualPreviewDescriptorHeader(encode(value))).toEqual(value)
    expect(parseVisualPreviewDescriptor(value)).not.toBe(value)
  })

  it.each([null, '', 'a'.repeat(4097), '%', 'e30=', 'e31', Buffer.from([0xff]).toString('base64url')])(
    'rejects absent, oversized, malformed or noncanonical header %s', (header) => {
      expect(parseVisualPreviewDescriptorHeader(header)).toBeNull()
    })

  it.each(Object.keys(descriptor))('rejects removal of required descriptor field %s', (field) => {
    const value: Record<string, unknown> = { ...descriptor }
    delete value[field]
    expect(parseVisualPreviewDescriptor(value)).toBeNull()
  })

  it.each([
    { version_is_current: 'true' }, { version_is_current: null }, { extra: true }, { schema_version: '1' }, { page: false }, { page: 1 }, { part_id: '' }, { file_id: ' file-1' },
    { file_version: 1 }, { content_checksum: 'A'.repeat(64) }, { preview_checksum: 'x'.repeat(64) },
    { preview_width: true }, { preview_height: 1.5 }, { preview_width: Infinity }, { preview_width: 0 },
    { preview_width: 4001, preview_height: 4000 },
  ])('rejects wrong-type or out-of-bound descriptor %j', (change) => {
    expect(parseVisualPreviewDescriptor({ ...descriptor, ...change })).toBeNull()
  })

  it.each([
    ['pin', { x: 0, y: 1 }], ['callout', { x: 0.3, y: 0.4 }],
    ['rectangle', { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
    ['arrow', { x1: 0, y1: 1, x2: 1, y2: 0 }],
  ])('accepts exact %s geometry', (tool, geometry) => expect(isVisualGeometry(tool, geometry)).toBe(true))

  it.each([
    ['pin', { x: true, y: 0 }], ['pin', { x: 0, y: NaN }], ['pin', { x: Infinity, y: 0 }],
    ['pin', { x: '0.3', y: 0 }], ['pin', [0.3, 0.4]], ['pin', { x: -0.1, y: 0 }],
    ['pin', { x: 0, y: 0, html: '<img onerror=alert(1)>' }], ['ellipse', { x: 0, y: 0 }],
    ['rectangle', { x: 0.9, y: 0, width: 0.2, height: 1 }],
    ['rectangle', { x: 0, y: 0, width: 0, height: 1 }],
    ['arrow', { x1: 0, y1: 0, x2: 1.1, y2: 1 }],
    ['callout', { x: 0, y: 0, text: '<script>' }],
  ])('rejects invalid %s geometry %j', (tool, geometry) => expect(isVisualGeometry(tool, geometry)).toBe(false))

  it('accepts bound data only when its geometry and viewport agree with its binding', () => {
    expect(parseStoredVisualMarkup(record())).toMatchObject({ binding_state: 'bound', descriptor: binding })
    expect(parseStoredVisualMarkup({ ...record(), viewport: { width: 2047, height: 1536, rotation: 0 } })).toBeNull()
    expect(parseStoredVisualMarkup({ ...record(), viewport: { width: 2048, height: 1536, rotation: 90 } })).toBeNull()
    expect(parseStoredVisualMarkup({ ...record(), geometry: { x: 0, y: 0 } })).toBeNull()
    expect(parseStoredVisualMarkup({ ...record(), extra: 'hidden' })).toBeNull()
  })

  it('preserves legacy as text-only history even when its geometry is not a V1 tool', () => {
    const legacy = { ...record(), binding_state: 'legacy_unbound', markup_type: 'measurement', geometry: [1, 2],
      file_id: null, viewport: null, schema_version: null, part_id: null, file_version: null,
      content_checksum: null, preview_checksum: null, page: null, preview_width: null, preview_height: null }
    expect(parseStoredVisualMarkup(legacy)).toEqual({ binding_state: 'legacy_unbound' })
    expect(parseStoredVisualMarkup({ ...legacy, preview_width: 1024 })).toBeNull()
    expect(parseStoredVisualMarkup(null)).toBeNull()
  })

  it.each(Object.keys(binding))('does not silently remap changed binding field %s', (field) => {
    const changed = { ...descriptor, [field]: typeof descriptor[field as keyof VisualPreviewDescriptor] === 'number' ? 99 : 'changed' }
    expect(sameVisualPreview(descriptor, changed as VisualPreviewDescriptor)).toBe(false)
  })

  it('keeps historical geometry readable but prevents new writes', () => {
    const historical = { ...descriptor, version_is_current: false }
    expect(parseVisualPreviewDescriptor(historical)).toEqual(historical)
    expect(sameVisualPreview(historical, binding)).toBe(true)
    expect(visualMarkupWrite(historical, 'pin', { x: 0.5, y: 0.5 })).toBeNull()
  })

  it('constructs the exact anchor and markup, without caller-supplied authority or geometry text', () => {
    const written = visualMarkupWrite(descriptor, 'callout', { x: 0.25, y: 0.75 })
    expect(written).toEqual({
      anchor: { kind: 'cad_2d_markup', file_id: 'file-1', file_version: 'version-1',
        content_checksum: 'a'.repeat(64), preview_checksum: 'b'.repeat(64), page: 0 },
      markup: { schema_version: 1, markup_type: 'callout', geometry: { x: 0.25, y: 0.75 },
        file_id: 'file-1', viewport: { width: 2048, height: 1536, rotation: 0 } },
    })
    expect(visualMarkupWrite(descriptor, 'pin', { x: true as unknown as number, y: 0 })).toBeNull()
  })
})
