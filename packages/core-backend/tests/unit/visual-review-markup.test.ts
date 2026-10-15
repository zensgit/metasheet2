import { describe, expect, it } from 'vitest'
import {
  hasVisualMarkupInput,
  projectVisualMarkups,
  validVisualMarkupBody,
  validVisualMarkupInput,
  validVisualMarkupRead,
} from '../../src/auth/visual-review-markup'

const CONTENT = 'a'.repeat(64)
const PREVIEW = 'b'.repeat(64)

function pin(geometry: Record<string, unknown> = { x: 0.2, y: 0.3 }) {
  return {
    schema_version: 1,
    markup_type: 'pin',
    geometry,
    viewport: { width: 3, height: 2, rotation: 0 },
    file_id: 'file',
  }
}

function anchor(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'cad_2d_markup',
    file_id: 'file',
    file_version: 'version',
    content_checksum: CONTENT,
    preview_checksum: PREVIEW,
    page: 0,
    ...overrides,
  }
}

function bound(overrides: Record<string, unknown> = {}) {
  return {
    id: 'markup-1',
    markup_type: 'pin',
    geometry: { x: 0.2, y: 0.3 },
    viewport: { width: 3, height: 2, rotation: 0 },
    file_id: 'file',
    created_by_id: 1,
    created_at: '2026-09-30T00:00:00+00:00',
    schema_version: 1,
    part_id: 'part',
    file_version: 'version',
    content_checksum: CONTENT,
    preview_checksum: PREVIEW,
    page: 0,
    preview_width: 3,
    preview_height: 2,
    binding_state: 'bound',
    ...overrides,
  }
}

function legacy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'legacy-1',
    markup_type: 'scribble',
    geometry: [{ opaque: true }],
    viewport: null,
    file_id: 'file',
    created_by_id: 1,
    created_at: '2026-09-30T00:00:00+00:00',
    schema_version: null,
    part_id: null,
    file_version: null,
    content_checksum: null,
    preview_checksum: null,
    page: null,
    preview_width: null,
    preview_height: null,
    binding_state: 'legacy_unbound',
    ...overrides,
  }
}

describe('strict Visual Review V1 markup', () => {
  it('accepts exact pin, callout, arrow, and positive bounded rectangle geometry', () => {
    expect(validVisualMarkupInput(pin())).toBe(true)
    expect(validVisualMarkupInput({ ...pin(), markup_type: 'callout' })).toBe(true)
    expect(validVisualMarkupInput({ ...pin(), markup_type: 'arrow', geometry: { x1: 0, y1: 0, x2: 1, y2: 1 } })).toBe(true)
    expect(validVisualMarkupInput({ ...pin(), markup_type: 'rectangle', geometry: { x: 0.2, y: 0.3, width: 0.4, height: 0.5 } })).toBe(true)
  })

  it.each([
    { ...pin(), geometry: { x: true, y: 0.3 } },
    { ...pin(), geometry: { x: 0.2, y: 0.3, z: 0 } },
    { ...pin(), markup_type: 'rectangle', geometry: { x: 0.2, y: 0.3, width: 0, height: 0.5 } },
    { ...pin(), markup_type: 'rectangle', geometry: { x: 0.8, y: 0.3, width: 0.3, height: 0.5 } },
    { ...pin(), markup_type: 'arrow', geometry: { x: 0.2, y: 0.3 } },
    { ...pin(), extra: true },
    { ...pin(), viewport: { width: 3, height: 2, rotation: 90 } },
    { ...pin(), viewport: { width: true, height: 2, rotation: 0 } },
  ])('rejects booleans, unknown fields, and unbounded geometry', (value) => {
    expect(validVisualMarkupInput(value)).toBe(false)
  })

  it('requires an exact create or reply body and a matching file id', () => {
    const body = { target_type: 'item', target_id: 'part', body: 'check', anchor: anchor(), markup: pin() }
    expect(validVisualMarkupBody(body, true)).toBe(true)
    expect(validVisualMarkupBody({ body: 'check', anchor: anchor(), markup: pin() }, false)).toBe(true)
    expect(validVisualMarkupBody({ ...body, target_type: 'item', unknown: 1 }, true)).toBe(false)
    expect(validVisualMarkupBody({ ...body, markup: { ...pin(), file_id: 'other' } }, true)).toBe(false)
    expect(validVisualMarkupBody({ target_type: 'item', body: 'check', anchor: anchor(), markup: pin() }, false)).toBe(false)
    expect(hasVisualMarkupInput({ body: 'plain' })).toBe(false)
    expect(hasVisualMarkupInput({ markup: null })).toBe(true)
    expect(hasVisualMarkupInput({ anchor: { kind: 'cad_2d_markup' } })).toBe(true)
  })

  it('validates present envelope fields before a visual create or reply can be exchanged', () => {
    const create = {
      target_type: 'item', target_id: 'part', body: 'check', title: '',
      mentioned_user_ids: [1, 2], anchor: anchor(), markup: pin(),
    }
    expect(validVisualMarkupBody(create, true)).toBe(true)
    expect(validVisualMarkupBody({ ...create, mentioned_user_ids: [] }, true)).toBe(true)
    expect(validVisualMarkupBody({
      body: 'check', parent_comment_id: 'parent-1', anchor: anchor(), markup: pin(),
    }, false)).toBe(true)
    const rejected = [
      { ...create, body: '' },
      { ...create, body: '   ' },
      { ...create, body: 1 },
      { target_type: 'item', target_id: 'part', anchor: anchor(), markup: pin() },
      { ...create, target_type: 'file' },
      { ...create, target_id: ' padded' },
      { ...create, title: 1 },
      { ...create, mentioned_user_ids: [0] },
      { ...create, mentioned_user_ids: [1.5] },
      { ...create, mentioned_user_ids: [true] },
      { ...create, mentioned_user_ids: [Number.POSITIVE_INFINITY] },
      { ...create, visibility_scope: 'public' },
      { ...create, visibility_scope: 'internal' },
      { ...create, visibility_scope: null },
      { body: 'check', parent_comment_id: '', anchor: anchor(), markup: pin() },
      { body: 'check', parent_comment_id: ' parent', anchor: anchor(), markup: pin() },
    ]
    for (const body of rejected) expect(validVisualMarkupBody(body, 'target_type' in body)).toBe(false)
  })

  it('accepts a bound creation binding and legacy opaque geometry without treating currentness as binding', () => {
    expect(validVisualMarkupRead(bound(), 'part')).toBe(true)
    expect(validVisualMarkupRead(bound({ version_is_current: false }), 'part')).toBe(false)
    expect(validVisualMarkupRead(bound({ version_is_current: true }), 'part')).toBe(false)
    expect(validVisualMarkupRead(legacy(), 'part')).toBe(true)
    expect(validVisualMarkupRead(legacy({ geometry: { opaque: 1 }, file_id: null }), 'part')).toBe(true)
    expect(validVisualMarkupRead(legacy({ schema_version: 1 }), 'part')).toBe(false)
  })

  it('keeps comment text when markup is malformed or bound to another part', () => {
    const malformed = projectVisualMarkups({
      comments: [{ id: 'c1', body: 'keep malformed', markup: { schema_version: 1, geometry: { x: true } } }],
    }, true, 'part')
    expect(malformed.comments[0]).toMatchObject({ body: 'keep malformed', markup: null })
    const crossPart = projectVisualMarkups({
      comments: [{ id: 'c2', body: 'keep cross-part', markup: bound({ part_id: 'other-part' }) }],
    }, true, 'part')
    expect(crossPart.comments[0]).toMatchObject({ body: 'keep cross-part', markup: null })
  })

  it('nulls markup on soft-deleted or non-text comments and ignores a legacy comment list', () => {
    let reads = 0
    const deleted = {
      body: 'kept after delete',
      deleted_at: '2026-09-30T00:00:00Z',
      get markup(): unknown {
        reads += 1
        return bound()
      },
    }
    const redacted = projectVisualMarkups({ comments: [deleted, { body: null, markup: bound() }, { body: 12, markup: bound() }] }, true, 'part')
    expect(reads).toBe(0)
    expect(redacted.comments[0]).toMatchObject({ body: 'kept after delete', markup: null })
    expect(redacted.comments[1]).toMatchObject({ body: null, markup: null })
    expect(redacted.comments[2]).toMatchObject({ body: 12, markup: null })

    const legacyThread = { id: 'legacy-thread' }
    expect(projectVisualMarkups(legacyThread, true, 'part')).toBe(legacyThread)
    expect(projectVisualMarkups({ comments: null }, true, 'part')).toEqual({ comments: null })
    const mixed = projectVisualMarkups({ comments: [null, 'note'] }, true, 'part')
    expect(mixed.comments).toEqual([null, 'note'])
  })

  it('does not read markup while the source gate is off', () => {
    let reads = 0
    const comment = {
      id: 'c3',
      body: 'text stays',
      get markup(): unknown {
        reads += 1
        throw new Error('markup getter')
      },
    }
    const projected = projectVisualMarkups({ id: 'thread', comments: [comment] }, false, 'part')
    expect(reads).toBe(0)
    expect(projected.comments[0]).toMatchObject({ id: 'c3', body: 'text stays', markup: null })
    expect(Object.prototype.hasOwnProperty.call(projected.comments[0], 'markup')).toBe(true)
  })
})
