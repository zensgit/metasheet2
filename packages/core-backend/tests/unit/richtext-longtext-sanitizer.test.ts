import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  validateLongTextValue,
  sanitizeRichLongText,
  richLongTextToPlainText,
  isRichLongTextProperty,
  sanitizeFieldProperty,
} from '../../src/multitable/field-codecs'
import {
  RecordWriteService,
  type RecordWriteHelpers,
  type RecordPatchInput,
  type UniverMetaField,
} from '../../src/multitable/record-write-service'

// ---------------------------------------------------------------------------
// Mock: publishMultitableSheetRealtime (real-wire round-trip canary)
// ---------------------------------------------------------------------------
const mockPublish = vi.fn()
vi.mock('../../src/multitable/realtime-publish', () => ({
  publishMultitableSheetRealtime: (...args: unknown[]) => mockPublish(...args),
}))

const RICH: Record<string, unknown> = { rich: true }
const PLAIN: Record<string, unknown> = {}

// ===========================================================================
// PART 1 — XSS canaries on the write-path chokepoint (validateLongTextValue)
//
// Each canary asserts on the value AS RETURNED by validateLongTextValue (= the
// value that gets persisted), exactly like the §8 matrix demands. The sanitizer
// is invoked for rich fields only.
// ===========================================================================

describe('rich-longText write-path sanitizer (validateLongTextValue, property.rich=true)', () => {
  function sanitize(value: string): string {
    return validateLongTextValue(value, 'fld_rich', RICH) ?? ''
  }

  // Canary #1 — <script> stripped (with contents, no inner-text leak).
  it('#1 strips <script> entirely', () => {
    const out = sanitize('<script>alert(1)</script><b>safe</b>')
    expect(out).not.toMatch(/<script/i)
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('<b>safe</b>')
  })

  // Canary #2 — <img onerror> gone (<img> not allowed + onerror stripped).
  it('#2 removes <img> and its onerror handler', () => {
    const out = sanitize('<img src=x onerror=alert(1)>')
    expect(out).not.toMatch(/<img/i)
    expect(out).not.toMatch(/onerror/i)
    expect(out).not.toContain('alert(1)')
  })

  // Canary #3 — javascript: href dropped, text kept.
  it('#3 drops a javascript: link href, keeps the text', () => {
    const out = sanitize('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toMatch(/javascript:/i)
    expect(out).not.toContain('href="javascript')
    expect(out).toContain('click')
  })

  // Canary #4 — entity-encoded protocol (&#106;avascript:) decoded + rejected.
  it('#4 rejects an entity-encoded javascript: protocol', () => {
    const out = sanitize('<a href="&#106;avascript:alert(1)">x</a>')
    expect(out.toLowerCase()).not.toContain('javascript:')
    expect(out).not.toMatch(/href\s*=\s*["']?\s*j/i)
    expect(out).toContain('x')
  })

  // Canary #5 — on* handler attr stripped from an allowed tag.
  it('#5 strips on* handler attributes from allowed tags', () => {
    const out = sanitize('<p onmouseover="alert(1)">hi</p>')
    expect(out).not.toMatch(/onmouseover/i)
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('hi')
  })

  // Canary #6 — style-based injection: style attr stripped, div unwrapped.
  it('#6 strips style attributes (CSS injection) and unwraps disallowed tags', () => {
    const out = sanitize('<div style="background:url(javascript:alert(1))">x</div>')
    expect(out).not.toMatch(/style\s*=/i)
    expect(out).not.toMatch(/javascript:/i)
    expect(out).not.toMatch(/<div/i)
    expect(out).toContain('x')
  })

  // Canary #7 — iframe/object/embed/form dropped WITH contents.
  it('#7 drops iframe/object/embed/form with their contents', () => {
    const out = sanitize(
      '<iframe src="evil"></iframe><object data="evil"></object><embed src="evil"><form action="evil"><input></form>',
    )
    expect(out).not.toMatch(/<iframe|<object|<embed|<form|<input/i)
    expect(out).not.toContain('evil')
  })

  // Canary #9 — benign formatting PRESERVED (with forced rel on the link).
  it('#9 preserves benign formatting and forces rel=noopener on links', () => {
    const out = sanitize(
      '<strong>hi</strong> <em>there</em> <a href="https://x.com">link</a><ul><li>a</li></ul>',
    )
    expect(out).toContain('<strong>hi</strong>')
    expect(out).toContain('<em>there</em>')
    expect(out).toMatch(/<a href="https:\/\/x\.com"/)
    expect(out).toMatch(/rel="noopener noreferrer"/)
    expect(out).toMatch(/target="_blank"/)
    expect(out).toContain('<ul><li>a</li></ul>')
  })

  // Allow-list coverage: every allowed formatting tag survives.
  it('keeps the full allowed tag set (b/i/u/s/h1-3/blockquote/code/pre/br)', () => {
    const out = sanitize(
      '<b>b</b><i>i</i><u>u</u><s>s</s><h1>h1</h1><h2>h2</h2><h3>h3</h3>' +
        '<blockquote>q</blockquote><code>c</code><pre>p</pre>line<br>next',
    )
    for (const tag of ['b', 'i', 'u', 's', 'h1', 'h2', 'h3', 'blockquote', 'code', 'pre']) {
      expect(out).toContain(`<${tag}>`)
    }
    expect(out).toMatch(/<br\s*\/?>/)
  })

  // mailto + http + https allowed; protocol-relative // rejected.
  it('allows http/https/mailto link protocols and rejects protocol-relative //', () => {
    expect(sanitize('<a href="mailto:a@b.com">m</a>')).toContain('href="mailto:a@b.com"')
    expect(sanitize('<a href="http://x.com">h</a>')).toContain('href="http://x.com"')
    const rel = sanitize('<a href="//evil.com">p</a>')
    expect(rel).not.toContain('href="//evil.com"')
    expect(rel).toContain('p')
  })
})

// ===========================================================================
// PART 2 — plain (non-rich) longText regression: NEVER sanitized/altered
// ===========================================================================

describe('plain (non-rich) longText is returned verbatim', () => {
  it('does not sanitize when property.rich is absent (legacy default)', () => {
    const raw = '<script>alert(1)</script> 5 < 3 && 4 > 2'
    expect(validateLongTextValue(raw, 'fld', PLAIN)).toBe(raw)
    expect(validateLongTextValue(raw, 'fld', undefined)).toBe(raw)
    expect(validateLongTextValue(raw, 'fld', { rich: false })).toBe(raw)
    // Truthy-but-not-true must NOT enable rich (strict === true).
    expect(validateLongTextValue(raw, 'fld', { rich: 'true' })).toBe(raw)
    expect(validateLongTextValue(raw, 'fld', { rich: 1 })).toBe(raw)
  })

  it('still enforces type + empty handling regardless of rich', () => {
    expect(validateLongTextValue(null, 'fld', RICH)).toBeNull()
    expect(validateLongTextValue('', 'fld', RICH)).toBeNull()
    expect(() => validateLongTextValue(42, 'fld', RICH)).toThrow(/must be a string/)
  })
})

// ===========================================================================
// PART 3 — unified plain-text projection (export + search)
// ===========================================================================

describe('richLongTextToPlainText projection (§7)', () => {
  it('strips all tags down to text content (export must not dump <p>)', () => {
    expect(richLongTextToPlainText('<p>Hello <strong>World</strong></p>')).toBe('Hello World')
    expect(richLongTextToPlainText('<ul><li>a</li><li>b</li></ul>')).toContain('a')
    expect(richLongTextToPlainText('<a href="https://x.com">link</a>')).toBe('link')
  })

  it('search projection matches text not markup', () => {
    const projected = richLongTextToPlainText('<strong>urgent</strong> review needed')
    expect(projected).toContain('urgent')
    expect(projected).not.toContain('<strong>')
  })

  it('is a no-op on plain text (no tags)', () => {
    expect(richLongTextToPlainText('just plain text')).toBe('just plain text')
  })
})

// ===========================================================================
// PART 4 — property.rich flag normalization (sanitizeFieldProperty)
// ===========================================================================

describe('sanitizeFieldProperty longText rich flag', () => {
  it('keeps rich:true', () => {
    expect(sanitizeFieldProperty('longText', { rich: true })).toEqual({ rich: true })
  })

  it('drops non-strict-true rich values', () => {
    expect(sanitizeFieldProperty('longText', { rich: false })).toEqual({})
    expect(sanitizeFieldProperty('longText', { rich: 'true' })).toEqual({})
    expect(sanitizeFieldProperty('longText', { rich: 1 })).toEqual({})
    expect(sanitizeFieldProperty('longText', {})).toEqual({})
  })

  it('isRichLongTextProperty is strict', () => {
    expect(isRichLongTextProperty({ rich: true })).toBe(true)
    expect(isRichLongTextProperty({ rich: 'true' })).toBe(false)
    expect(isRichLongTextProperty({})).toBe(false)
    expect(isRichLongTextProperty(undefined)).toBe(false)
    expect(isRichLongTextProperty(null)).toBe(false)
  })
})

// ===========================================================================
// PART 5 — REAL-WIRE ROUND-TRIP (canary #10, the drift trap)
//
// A malicious rich value written through the REAL RecordWriteService.patchRecords
// pipeline (not a hand-built fixture) must be persisted INERT. We capture the
// JSON.stringify(patch) param of the `UPDATE meta_records ... data || $1::jsonb`
// write and assert the stored payload carries no executable content.
// ===========================================================================

function createMockHelpers(): RecordWriteHelpers {
  return {
    normalizeLinkIds: (v) => (Array.isArray(v) ? v.map(String) : []),
    normalizeAttachmentIds: (v) => (Array.isArray(v) ? v.map(String) : []),
    normalizeJson: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}),
    parseLinkFieldConfig: () => null,
    buildId: (prefix) => `${prefix}_test123`,
    ensureRecordWriteAllowed: () => true,
    filterRecordDataByFieldIds: (data, ids) => {
      if (!data || typeof data !== 'object') return {}
      return Object.fromEntries(
        Object.entries(data as Record<string, unknown>).filter(([k]) => ids.has(k)),
      )
    },
    extractLookupRollupData: () => ({}),
    mergeComputedRecords: (base, extra) => {
      if ((!base || base.length === 0) && extra.length === 0) return undefined
      return [...(base ?? []), ...extra]
    },
    filterRecordFieldSummaryMap: (map) => map,
    serializeLinkSummaryMap: () => ({}),
    serializeAttachmentSummaryMap: () => ({}),
    applyLookupRollup: vi.fn().mockResolvedValue(undefined),
    computeDependentLookupRollupRecords: vi.fn().mockResolvedValue([]),
    recalculateFormulaFields: vi.fn().mockResolvedValue([]),
    loadLinkValuesByRecord: vi.fn().mockResolvedValue(new Map()),
    buildLinkSummaries: vi.fn().mockResolvedValue(new Map()),
    buildAttachmentSummaries: vi.fn().mockResolvedValue(new Map()),
  } as unknown as RecordWriteHelpers
}

function createMockPool(captured: { updateParams: unknown[][] }) {
  const queryFn = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT id, version, data, created_by, locked, locked_by FROM meta_records') && sql.includes('FOR UPDATE')) {
      return { rows: [{ id: 'rec1', version: 1, data: { fld_rich: 'Before' }, created_by: 'user1', locked: false, locked_by: null }] }
    }
    if (sql.includes('UPDATE meta_records')) {
      captured.updateParams.push(params ?? [])
      return { rows: [{ version: 2 }] }
    }
    return { rows: [] }
  })
  return {
    query: queryFn,
    transaction: vi.fn(async <T>(handler: (client: { query: typeof queryFn }) => Promise<T>) => handler({ query: queryFn })),
  }
}

function buildRichPatchInput(value: string): RecordPatchInput {
  const fields: UniverMetaField[] = [
    { id: 'fld_rich', name: 'Notes', type: 'longText', order: 0, property: { rich: true } },
  ]
  const fieldById = new Map([
    ['fld_rich', { type: 'longText' as const, readOnly: false, hidden: false, property: { rich: true } }],
  ])
  return {
    sheetId: 'sheet1',
    changesByRecord: new Map([['rec1', [{ fieldId: 'fld_rich', value }]]]),
    actorId: 'user1',
    fields,
    visiblePropertyFields: fields,
    visiblePropertyFieldIds: new Set(['fld_rich']),
    attachmentFields: [],
    fieldById: fieldById as never,
    capabilities: {
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageSheetAccess: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: true,
      canExport: true,
    },
    access: { userId: 'user1', permissions: [], isAdminRole: false },
  } as unknown as RecordPatchInput
}

describe('canary #10 — real-wire round-trip through RecordWriteService', () => {
  beforeEach(() => mockPublish.mockReset())

  it('persists a malicious rich value INERT (stored payload has no script/handler/js-protocol)', async () => {
    const captured = { updateParams: [] as unknown[][] }
    const pool = createMockPool(captured)
    const eventBus = { emit: vi.fn(), publish: vi.fn(), subscribe: vi.fn().mockReturnValue('s'), unsubscribe: vi.fn() }
    const service = new RecordWriteService(pool as never, eventBus as never, createMockHelpers())

    const malicious =
      '<script>steal()</script><img src=x onerror=alert(1)>' +
      '<a href="javascript:evil()">x</a><p onclick="boom()">text</p><b>ok</b>'
    await service.patchRecords(buildRichPatchInput(malicious))

    expect(captured.updateParams.length).toBeGreaterThan(0)
    const storedJson = String(captured.updateParams[0][0])
    const stored = JSON.parse(storedJson) as Record<string, unknown>
    const value = String(stored.fld_rich ?? '')

    // The stored byte sequence is inert by construction.
    expect(value.toLowerCase()).not.toContain('<script')
    expect(value.toLowerCase()).not.toContain('javascript:')
    expect(value.toLowerCase()).not.toContain('onerror')
    expect(value.toLowerCase()).not.toContain('onclick')
    expect(value).not.toContain('steal()')
    expect(value).not.toContain('evil()')
    expect(value).not.toContain('boom()')
    expect(value).not.toMatch(/<img/i)
    // Benign formatting survived the wire.
    expect(value).toContain('<b>ok</b>')
    expect(value).toContain('text')
  })

  it('persists a plain (non-rich) value verbatim through the same pipeline', async () => {
    const captured = { updateParams: [] as unknown[][] }
    const pool = createMockPool(captured)
    const eventBus = { emit: vi.fn(), publish: vi.fn(), subscribe: vi.fn().mockReturnValue('s'), unsubscribe: vi.fn() }
    const service = new RecordWriteService(pool as never, eventBus as never, createMockHelpers())

    const input = buildRichPatchInput('<b>not sanitized</b> a < b')
    // Flip the field to plain.
    input.fields[0].property = {}
    ;(input.fieldById.get('fld_rich') as { property?: unknown }).property = {}

    await service.patchRecords(input)
    const stored = JSON.parse(String(captured.updateParams[0][0])) as Record<string, unknown>
    expect(stored.fld_rich).toBe('<b>not sanitized</b> a < b')
  })
})

// ===========================================================================
// PART 6 — pure sanitizeRichLongText direct (the shared helper other writers use)
// ===========================================================================

describe('sanitizeRichLongText (shared helper for automation + validators)', () => {
  it('neutralizes script/handlers and keeps allow-listed formatting', () => {
    const out = sanitizeRichLongText('<script>x</script><strong>keep</strong><a href="https://a.io">l</a>')
    expect(out).not.toMatch(/<script/i)
    expect(out).toContain('<strong>keep</strong>')
    expect(out).toMatch(/rel="noopener noreferrer"/)
  })
})
