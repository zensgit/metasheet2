export type VisualMarkupTool = 'pin' | 'rectangle' | 'arrow' | 'callout'
export type VisualGeometry = Record<string, number>

export interface VisualAssetBinding {
  schema_version: 1
  part_id: string
  file_id: string
  file_version: string
  content_checksum: string
  preview_checksum: string
  page: 0
  preview_width: number
  preview_height: number
}

export interface VisualPreviewDescriptor extends VisualAssetBinding { version_is_current: boolean }

export interface VisualMarkupDraft {
  descriptor: VisualPreviewDescriptor
  tool: VisualMarkupTool
  geometry: VisualGeometry
}

export interface VisualComment { id: string; body: string; markup: StoredVisualMarkup | null }

export interface VisualMarkupInput {
  schema_version: 1
  markup_type: VisualMarkupTool
  geometry: VisualGeometry
  viewport: { width: number; height: number; rotation: 0 }
  file_id: string
}

export type StoredVisualMarkup =
  | { binding_state: 'legacy_unbound' }
  | { binding_state: 'bound'; id: string; descriptor: VisualAssetBinding; markup: VisualMarkupInput }

const BINDING_KEYS = ['schema_version', 'part_id', 'file_id', 'file_version', 'content_checksum',
  'preview_checksum', 'page', 'preview_width', 'preview_height'] as const
const DESCRIPTOR_KEYS = [...BINDING_KEYS, 'version_is_current']
const STORED_KEYS = [...BINDING_KEYS, 'id', 'markup_type', 'geometry', 'viewport',
  'created_by_id', 'created_at', 'binding_state']
const SHA256 = /^[0-9a-f]{64}$/

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && actual.every((key) => expected.includes(key))
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value === value.trim()
}

function pixelSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 16_000_000
}

function parseVisualAssetBinding(value: unknown): VisualAssetBinding | null {
  if (!object(value) || !keys(value, BINDING_KEYS) || value.schema_version !== 1 || value.page !== 0
    || !identifier(value.part_id) || !identifier(value.file_id) || !identifier(value.file_version)
    || typeof value.content_checksum !== 'string' || !SHA256.test(value.content_checksum)
    || typeof value.preview_checksum !== 'string' || !SHA256.test(value.preview_checksum)
    || !pixelSize(value.preview_width) || !pixelSize(value.preview_height)
    || value.preview_width * value.preview_height > 16_000_000) return null
  return { ...value } as unknown as VisualAssetBinding
}

export function parseVisualPreviewDescriptor(value: unknown): VisualPreviewDescriptor | null {
  if (!object(value) || !keys(value, DESCRIPTOR_KEYS) || typeof value.version_is_current !== 'boolean') return null
  const binding = parseVisualAssetBinding(Object.fromEntries(BINDING_KEYS.map((key) => [key, value[key]])))
  return binding ? { ...binding, version_is_current: value.version_is_current } : null
}

/** The relay supplies public asset identity only; credentials never enter this header. */
export function parseVisualPreviewDescriptorHeader(value: string | null): VisualPreviewDescriptor | null {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
    // Reject non-canonical encodings, including non-zero unused trailing bits.
    if (btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') !== value) return null
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return parseVisualPreviewDescriptor(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch { return null }
}

export function isVisualGeometry(tool: unknown, geometry: unknown): geometry is VisualGeometry {
  if (!object(geometry)) return false
  const expected = tool === 'pin' || tool === 'callout' ? ['x', 'y']
    : tool === 'rectangle' ? ['x', 'y', 'width', 'height']
      : tool === 'arrow' ? ['x1', 'y1', 'x2', 'y2'] : null
  if (!expected || !keys(geometry, expected) || !Object.values(geometry).every((coordinate) =>
    typeof coordinate === 'number' && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)) return false
  if (tool === 'rectangle') {
    const { x, y, width, height } = geometry as VisualGeometry
    return width > 0 && height > 0 && x + width <= 1 && y + height <= 1
  }
  return true
}

export function parseStoredVisualMarkup(value: unknown): StoredVisualMarkup | null {
  if (!object(value) || !keys(value, STORED_KEYS)) return null
  if (value.binding_state === 'legacy_unbound') {
    const bindingKeys = BINDING_KEYS.filter((key) => key !== 'file_id')
    return bindingKeys.every((key) => value[key] === null) ? { binding_state: 'legacy_unbound' } : null
  }
  if (value.binding_state !== 'bound' || !identifier(value.id)
    || typeof value.created_by_id !== 'number' || !Number.isSafeInteger(value.created_by_id) || value.created_by_id <= 0
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) return null
  const descriptor = parseVisualAssetBinding(Object.fromEntries(BINDING_KEYS.map((key) => [key, value[key]])))
  if (!descriptor || !isVisualGeometry(value.markup_type, value.geometry) || !object(value.viewport)
    || !keys(value.viewport, ['width', 'height', 'rotation']) || value.viewport.rotation !== 0
    || value.viewport.width !== descriptor.preview_width || value.viewport.height !== descriptor.preview_height) return null
  return {
    binding_state: 'bound', id: value.id, descriptor,
    markup: { schema_version: 1, markup_type: value.markup_type as VisualMarkupTool,
      geometry: { ...value.geometry }, viewport: { width: descriptor.preview_width, height: descriptor.preview_height, rotation: 0 },
      file_id: descriptor.file_id },
  }
}

export function sameVisualPreview(a: VisualAssetBinding, b: VisualAssetBinding): boolean {
  return BINDING_KEYS.every((key) => a[key] === b[key])
}

export function visualMarkupWrite(descriptor: VisualPreviewDescriptor, tool: VisualMarkupTool, geometry: VisualGeometry): {
  anchor: Record<string, unknown>; markup: VisualMarkupInput
} | null {
  if (!parseVisualPreviewDescriptor(descriptor) || !descriptor.version_is_current || !isVisualGeometry(tool, geometry)) return null
  return {
    anchor: { kind: 'cad_2d_markup', file_id: descriptor.file_id, file_version: descriptor.file_version,
      content_checksum: descriptor.content_checksum, preview_checksum: descriptor.preview_checksum, page: 0 },
    markup: { schema_version: 1, markup_type: tool, geometry: { ...geometry }, file_id: descriptor.file_id,
      viewport: { width: descriptor.preview_width, height: descriptor.preview_height, rotation: 0 } },
  }
}
