import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createFormAuthoringAdapter,
  DEFAULT_IDENTITY_ALLOCATION_ATTEMPTS,
  type FormAdapterResult,
} from '../src/approvals/approvalFormAuthoringAdapter'
import {
  OPAQUE_IDENTITY_TOKEN_BYTES,
  createOpaqueFormIdentityAllocator,
  type IdentityRandomSource,
} from '../src/approvals/approvalFormIdentity'
import {
  createEmptyDetailColumnDraft,
  createEmptyFieldDraft,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  type FieldAuthoringDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'

function field(
  index: number,
  overrides: Partial<FieldAuthoringDraft> = {},
): FieldAuthoringDraft {
  return {
    ...createEmptyFieldDraft(index),
    localId: `local_${index}`,
    id: `field_${index}`,
    label: `字段 ${index}`,
    ...overrides,
  }
}

function draftWith(fields: FieldAuthoringDraft[]): TemplateAuthoringDraft {
  return {
    ...createEmptyTemplateDraft(),
    key: 'form_adapter',
    name: '表单适配器',
    fields,
    steps: [createEmptyStepDraft(1)],
  }
}

function assertOk(
  result: FormAdapterResult,
): asserts result is Extract<FormAdapterResult, { ok: true }> {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
}

/** Seam that replays scripted 8-byte blocks in order (then wraps). */
function scriptedSource(blocks: number[][]): IdentityRandomSource {
  let cursor = 0
  return {
    nextBytes(length: number): Uint8Array {
      expect(length).toBe(OPAQUE_IDENTITY_TOKEN_BYTES)
      const block = blocks[cursor % blocks.length]!
      cursor += 1
      return Uint8Array.from(block)
    },
  }
}

const BLOCK_A = [0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a]
const BLOCK_B = [0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b]
const BLOCK_C = [0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c]
const BLOCK_D = [0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d, 0x0d]
const HEX_A = '0a'.repeat(8)
const HEX_B = '0b'.repeat(8)
const HEX_C = '0c'.repeat(8)
const HEX_D = '0d'.repeat(8)

describe('approvalFormAuthoringAdapter - identity (FB-D5)', () => {
  it('delete-middle-then-add mints a FRESH opaque id: no reuse of the retired id, no collision', () => {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(
      draftWith([field(1), field(2), field(3)]),
    )
    const removed = adapter.removeField(session, 'local_2')
    assertOk(removed)
    expect(removed.session.draft.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_3',
    ])
    // Positive control: the add succeeds after the middle delete.
    const added = adapter.addField(removed.session, 'text')
    assertOk(added)
    const created = added.session.draft.fields.at(-1)!
    // Never the retired id, never a live id — and provably from the opaque
    // allocator (a length-derived `field_${length + 1}` mint cannot match).
    expect(created.id).not.toBe('field_2')
    expect(['field_1', 'field_2', 'field_3']).not.toContain(created.id)
    expect(created.id).toMatch(/^fld_[0-9a-f]{16}$/)
    expect(created.localId).toMatch(/^fldloc_[0-9a-f]{16}$/)
    const ids = added.session.draft.fields.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('retries a seam-forced collision with a FRESH candidate and succeeds', () => {
    // First candidate (A/B) collides with a live field id; second (C/D) is free.
    const source = scriptedSource([BLOCK_A, BLOCK_B, BLOCK_C, BLOCK_D])
    const adapter = createFormAuthoringAdapter({
      identityAllocator: createOpaqueFormIdentityAllocator(source),
    })
    const session = adapter.startSession(
      draftWith([field(1, { id: `fld_${HEX_A}` })]),
    )
    const added = adapter.addField(session, 'text')
    assertOk(added)
    const created = added.session.draft.fields.at(-1)!
    expect(created.id).toBe(`fld_${HEX_C}`)
    expect(created.localId).toBe(`fldloc_${HEX_D}`)
    expect(created.id).not.toBe(`fld_${HEX_A}`)
    // Exactly ONE history entry despite the internal retry.
    expect(added.session.history.undoStack).toHaveLength(1)
    expect(added.changed).toBe(true)
  })

  it('exhausts the retry budget as a typed values-free failure with zero mutation', () => {
    // Constant seam: every candidate collides with the live field id forever.
    const source = scriptedSource([BLOCK_A])
    const adapter = createFormAuthoringAdapter({
      identityAllocator: createOpaqueFormIdentityAllocator(source),
    })
    const session = adapter.startSession(
      draftWith([field(1, { id: `fld_${HEX_A}` })]),
    )
    const result = adapter.addField(session, 'text')
    expect(result).toMatchObject({
      ok: false,
      reason: 'identity_allocation_exhausted',
      dependencies: [],
    })
    if (!result.ok) {
      // Session returned unchanged by identity — zero draft/history mutation.
      expect(result.session).toBe(session)
      // Values-free failure surface: typed members only.
      expect(Object.keys(result).sort()).toEqual([
        'dependencies',
        'ok',
        'reason',
        'session',
      ])
    }
    expect(session.history.undoStack).toHaveLength(0)
    expect(session.draft.fields).toHaveLength(1)
    expect(DEFAULT_IDENTITY_ALLOCATION_ATTEMPTS).toBeGreaterThan(1)
  })

  it('appends a detail column through the opaque allocator with one history entry', () => {
    const adapter = createFormAuthoringAdapter()
    const detailOwner = field(1, {
      localId: 'detail_local',
      id: 'detail_field',
      type: 'detail',
      detailColumns: [
        {
          localId: 'existing_column_local',
          id: 'existing_column',
          type: 'text',
          label: '已有子字段',
          required: false,
          optionsText: '',
        },
      ],
    })
    const session = adapter.startSession(draftWith([detailOwner, field(2)]))
    const added = adapter.addDetailColumn(session, 'detail_local')
    assertOk(added)
    const columns = added.session.draft.fields[0].detailColumns
    expect(columns).toHaveLength(2)
    expect(columns.at(-1)!.id).toMatch(/^dcol_[0-9a-f]{16}$/)
    expect(columns.at(-1)!.localId).toMatch(/^dcolloc_[0-9a-f]{16}$/)
    expect(added.session.history.undoStack).toHaveLength(1)
    expect(added.focusLocalId).toBe('detail_local')
    // Negative: a non-detail target is a typed refusal with zero entries.
    const refused = adapter.addDetailColumn(added.session, 'local_2')
    expect(refused).toMatchObject({ ok: false, reason: 'unsupported_field_type' })
    if (!refused.ok) expect(refused.session).toBe(added.session)
  })

  it('detail column add retries a seam-forced collision with a FRESH candidate and succeeds (P2-3)', () => {
    // Gate F1 names "field/detail collision retry"; this loop (addDetailColumn)
    // is structurally identical to the field retry loop above but was
    // previously unexercised — cutting its budget to 1 must turn this RED.
    // First candidate (A/B) collides with the owner's live column id; second
    // (C/D) is free.
    const source = scriptedSource([BLOCK_A, BLOCK_B, BLOCK_C, BLOCK_D])
    const adapter = createFormAuthoringAdapter({
      identityAllocator: createOpaqueFormIdentityAllocator(source),
    })
    const detailOwner = field(1, {
      localId: 'detail_local',
      id: 'detail_field',
      type: 'detail',
      detailColumns: [
        {
          localId: 'existing_column_local',
          id: `dcol_${HEX_A}`,
          type: 'text',
          label: '已有子字段',
          required: false,
          optionsText: '',
        },
      ],
    })
    const session = adapter.startSession(draftWith([detailOwner]))
    const added = adapter.addDetailColumn(session, 'detail_local')
    assertOk(added)
    const columns = added.session.draft.fields[0].detailColumns
    expect(columns.at(-1)!.id).toBe(`dcol_${HEX_C}`)
    expect(columns.at(-1)!.localId).toBe(`dcolloc_${HEX_D}`)
    expect(columns.at(-1)!.id).not.toBe(`dcol_${HEX_A}`)
    // Exactly ONE history entry despite the internal retry.
    expect(added.session.history.undoStack).toHaveLength(1)
    expect(added.changed).toBe(true)
  })

  it('detail column add exhausts the retry budget as a typed values-free failure with zero mutation (P2-3)', () => {
    // Constant seam: every candidate collides with the owner's live column id
    // forever — proves the typed exhaustion path on the detail-column loop,
    // not just the field loop.
    const source = scriptedSource([BLOCK_A])
    const adapter = createFormAuthoringAdapter({
      identityAllocator: createOpaqueFormIdentityAllocator(source),
    })
    const detailOwner = field(1, {
      localId: 'detail_local',
      id: 'detail_field',
      type: 'detail',
      detailColumns: [
        {
          localId: 'existing_column_local',
          id: `dcol_${HEX_A}`,
          type: 'text',
          label: '已有子字段',
          required: false,
          optionsText: '',
        },
      ],
    })
    const session = adapter.startSession(draftWith([detailOwner]))
    const result = adapter.addDetailColumn(session, 'detail_local')
    expect(result).toMatchObject({
      ok: false,
      reason: 'identity_allocation_exhausted',
      dependencies: [],
    })
    if (!result.ok) {
      // Session returned unchanged by identity — zero draft/history mutation.
      expect(result.session).toBe(session)
    }
    expect(session.history.undoStack).toHaveLength(0)
    expect(session.draft.fields[0].detailColumns).toHaveLength(1)
  })
})

describe('approvalFormAuthoringAdapter - anchors (FB-D3)', () => {
  it('start anchor prepends exactly, atomically, as ONE history entry', () => {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(draftWith([field(1), field(2)]))
    const added = adapter.addField(session, 'text', { kind: 'start' })
    assertOk(added)
    expect(added.session.draft.fields).toHaveLength(3)
    expect(added.session.draft.fields[0].id).toMatch(/^fld_[0-9a-f]{16}$/)
    expect(added.session.draft.fields.slice(1).map((entry) => entry.id)).toEqual(
      ['field_1', 'field_2'],
    )
    expect(added.session.draft.fields[0].localId).toBe(added.focusLocalId)
    // ONE entry — a single undo returns to the pre-add list (no hidden
    // add-then-move pair).
    expect(added.session.history.undoStack).toHaveLength(1)
    const undone = adapter.undo(added.session)
    assertOk(undone)
    expect(undone.session.draft.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_2',
    ])
  })

  it('after anchor inserts at the exact slot', () => {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(draftWith([field(1), field(2)]))
    const added = adapter.addField(session, 'number', {
      kind: 'after',
      localId: 'local_1',
    })
    assertOk(added)
    expect(added.session.draft.fields.map((entry) => entry.localId)).toEqual([
      'local_1',
      added.focusLocalId,
      'local_2',
    ])
  })

  it('re-resolves the anchor immediately before mutation: a stale anchor is a zero-entry no-op', () => {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(
      draftWith([field(1), field(2), field(3)]),
    )
    // Anchor captured at "drag start" while local_2 sits at index 1…
    const anchor = { kind: 'after', localId: 'local_2' } as const
    // …the anchored field is deleted before the drop lands.
    const removed = adapter.removeField(session, 'local_2')
    assertOk(removed)
    const stale = adapter.addField(removed.session, 'text', anchor)
    expect(stale).toMatchObject({
      ok: false,
      reason: 'target_not_found',
      dependencies: [],
    })
    if (!stale.ok) expect(stale.session).toBe(removed.session)
    // Zero draft and zero history mutation: a captured-index implementation
    // would have inserted at the old index 2 instead.
    expect(removed.session.draft.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_3',
    ])
    expect(removed.session.history.undoStack).toHaveLength(1)
    // Positive control: the same anchor shape works when its neighbor lives.
    const live = adapter.addField(removed.session, 'text', {
      kind: 'after',
      localId: 'local_3',
    })
    assertOk(live)
    expect(live.session.draft.fields.map((entry) => entry.localId)).toEqual([
      'local_1',
      'local_3',
      live.focusLocalId,
    ])
  })
})

describe('approvalFormAuthoringAdapter - history semantics (FB-D4)', () => {
  it('a value-changing command creates exactly one entry with one focus result', () => {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(draftWith([field(1), field(2)]))
    const moved = adapter.moveField(session, 'local_2', 'local_1', 'before')
    assertOk(moved)
    expect(moved.changed).toBe(true)
    expect(moved.focusLocalId).toBe('local_2')
    expect(moved.session.history.undoStack).toHaveLength(1)
    expect(moved.session.history.focusLocalId).toBe('local_2')
  })

  it('a value-identical boundary no-op creates zero entries', () => {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(draftWith([field(1), field(2)]))
    const noop = adapter.moveFieldByOffset(session, 'local_1', -1)
    assertOk(noop)
    expect(noop.changed).toBe(false)
    expect(noop.session.history.undoStack).toHaveLength(0)
    expect(noop.session.draft.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_2',
    ])
  })

  it('a rejected command creates zero draft and zero history mutation', () => {
    const adapter = createFormAuthoringAdapter()
    const dependent = field(2, {
      visibility: {
        dependsOnFieldId: 'field_1',
        operator: 'eq',
        valueText: 'yes',
      },
    })
    const session = adapter.startSession(draftWith([field(1), dependent]))
    const refused = adapter.removeField(session, 'local_1')
    expect(refused).toMatchObject({ ok: false, reason: 'field_is_referenced' })
    if (!refused.ok) {
      expect(refused.session).toBe(session)
      expect(
        refused.dependencies.map((entry) => entry.kind),
      ).toContain('visibility_rule')
      // Values-free: dependencies carry only internal kind/location members.
      for (const dependency of refused.dependencies) {
        expect(Object.keys(dependency).sort()).toEqual(['kind', 'location'])
        expect(dependency.location).not.toContain('yes')
      }
    }
    expect(session.history.undoStack).toHaveLength(0)
  })

  it('undo/redo restore list and focus as coherent snapshots', () => {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(draftWith([field(1), field(2)]))
    const added = adapter.addField(session, 'text', { kind: 'start' })
    assertOk(added)
    const moved = adapter.moveField(added.session, 'local_2', 'local_1', 'before')
    assertOk(moved)
    expect(adapter.canUndo(moved.session)).toBe(true)

    const undoMove = adapter.undo(moved.session)
    assertOk(undoMove)
    expect(undoMove.session.draft.fields.map((entry) => entry.id)).toEqual(
      added.session.draft.fields.map((entry) => entry.id),
    )
    const undoAdd = adapter.undo(undoMove.session)
    assertOk(undoAdd)
    expect(undoAdd.session.draft.fields.map((entry) => entry.id)).toEqual([
      'field_1',
      'field_2',
    ])
    const redone = adapter.redo(undoAdd.session)
    assertOk(redone)
    expect(redone.session.draft.fields.map((entry) => entry.id)).toEqual(
      added.session.draft.fields.map((entry) => entry.id),
    )
    // Empty stacks fail closed with the typed history reason.
    const emptyRedo = adapter.redo(moved.session)
    expect(emptyRedo).toMatchObject({ ok: false, reason: 'history_empty' })
    const freshSession = adapter.startSession(draftWith([field(1)]))
    expect(adapter.undo(freshSession)).toMatchObject({
      ok: false,
      reason: 'history_empty',
    })
  })

  it('changed stays true across the history-stack cap (P2-2: fields identity, not stack-length growth)', () => {
    // FORM_AUTHORING_HISTORY_MAX_STACK = 100 (approvalFormAuthoringHistory.ts):
    // once the undo stack saturates, `trimStack` drops the oldest entry on
    // every further push, so `undoStack.length` stops growing even though
    // each add below is a genuine value-changing edit. Reproduced on the
    // pre-fix adapter: adds #101-105 reported `changed: false`. `changed` must
    // track `history.fields` identity (fresh clone on real change; same
    // reference on a full no-op or a focus-only change), not stack-length
    // growth, so it stays `true` through and past the cap.
    const adapter = createFormAuthoringAdapter()
    let session = adapter.startSession(draftWith([field(1)]))
    for (let i = 0; i < 105; i += 1) {
      const before = session.draft.fields.length
      const added = adapter.addField(session, 'text')
      assertOk(added)
      expect(added.changed).toBe(true)
      expect(added.session.draft.fields.length).toBe(before + 1)
      session = added.session
    }
    expect(session.draft.fields).toHaveLength(106)
    // Confirms this test actually crosses the saturation boundary the flag
    // got wrong: the stack itself is capped at 100 even though 105 real
    // edits landed.
    expect(session.history.undoStack.length).toBe(100)
  })

  it('undo preserves non-field draft properties (fields-scoped history)', () => {
    const adapter = createFormAuthoringAdapter()
    const draft = draftWith([field(1), field(2)])
    const session = adapter.startSession(draft)
    const moved = adapter.moveField(session, 'local_2', 'local_1', 'before')
    assertOk(moved)
    const undone = adapter.undo(moved.session)
    assertOk(undone)
    expect(undone.session.draft.key).toBe('form_adapter')
    expect(undone.session.draft.steps).toBe(draft.steps)
  })
})

describe('approvalFormAuthoringAdapter - guards and references (FB-D6)', () => {
  it('refuses removing the final field through the command-level guard', () => {
    const adapter = createFormAuthoringAdapter()
    const session = adapter.startSession(draftWith([field(1)]))
    const refused = adapter.removeField(session, 'local_1')
    expect(refused).toMatchObject({
      ok: false,
      reason: 'last_field_removal_forbidden',
    })
    if (!refused.ok) expect(refused.session).toBe(session)
    expect(session.history.undoStack).toHaveLength(0)
  })

  it('exposes the current-draft reference provider for inspector copy', () => {
    const adapter = createFormAuthoringAdapter()
    const dependent = field(2, {
      visibility: {
        dependsOnFieldId: 'field_1',
        operator: 'eq',
        valueText: 'yes',
      },
    })
    const session = adapter.startSession(draftWith([field(1), dependent]))
    const references = adapter.listFieldReferences(session, 'local_1')
    expect(references.map((entry) => entry.kind)).toEqual(['visibility_rule'])
    expect(adapter.listFieldReferences(session, 'local_2')).toEqual([])
    expect(adapter.listFieldReferences(session, 'missing')).toEqual([])
  })
})

describe('legacy length-derived helpers - frozen fallback baseline (delta §5 F1)', () => {
  it('createEmptyFieldDraft output is pinned byte-for-byte (deterministic members)', () => {
    const draft = createEmptyFieldDraft(3)
    const { localId, ...rest } = draft
    expect(rest).toEqual({
      id: 'field_3',
      type: 'text',
      label: '字段 3',
      required: false,
      placeholder: '',
      optionsText: '',
      visibility: { dependsOnFieldId: '', operator: 'eq', valueText: '' },
      detailColumns: [],
      minRowsText: '',
      maxRowsText: '',
      recordLinkBaseId: '',
      recordLinkSheetId: '',
      // L8-C (approval-lock8-field-vocabulary-20260817.md §1.3, OD-L8-6): deliberate widening,
      // neutral defaults — a new field always starts as `text`, so these are meaningless until
      // retyped to `number`, exactly like recordLinkBaseId/recordLinkSheetId above.
      numberCurrencySymbol: '',
      numberThousandsSeparator: false,
      numberUppercaseCny: false,
      // L8-B (approval-lock8-field-vocabulary-20260817.md §1.2): same deliberate-widening,
      // neutral-defaults discipline — meaningless until retyped to `date_range`. `dateRangeDateType`
      // is `''`, not an arm, matching §1.2's no-absent-default (never a silently-picked granularity).
      dateRangeDateType: '',
      dateRangeStartLabel: '',
      dateRangeEndLabel: '',
      dateRangeDurationLabel: '',
    })
    expect(localId).toMatch(/^field_\d+_[0-9a-f]{1,6}$/)
    // Default-arg pin: the historical `index = 1` default stays intact.
    expect(createEmptyFieldDraft().id).toBe('field_1')
  })

  it('createEmptyDetailColumnDraft output is pinned byte-for-byte (deterministic members)', () => {
    const column = createEmptyDetailColumnDraft(2)
    const { localId, ...rest } = column
    expect(rest).toEqual({
      id: 'col_2',
      type: 'text',
      label: '子字段 2',
      required: false,
      optionsText: '',
    })
    expect(localId).toMatch(/^detailcol_\d+_\d+$/)
    expect(createEmptyDetailColumnDraft().id).toBe('col_1')
  })

  it('the adapter and allocator never reference the legacy helpers while the inline fallback still does', () => {
    const adapterSource = readFileSync(
      join(__dirname, '../src/approvals/approvalFormAuthoringAdapter.ts'),
      'utf8',
    )
    const identitySource = readFileSync(
      join(__dirname, '../src/approvals/approvalFormIdentity.ts'),
      'utf8',
    )
    // Positive controls: the right, non-empty modules were read.
    expect(adapterSource).toContain('createFormAuthoringAdapter')
    expect(identitySource).toContain('createOpaqueFormIdentityAllocator')
    // Strip comments before scanning: doc prose may NAME the legacy helpers,
    // but any real import or call survives comment-stripping and fails here.
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    for (const source of [adapterSource, identitySource]) {
      const code = stripComments(source)
      // Scan control: stripping must not have emptied the module body.
      expect(code).toContain('export function')
      expect(code).not.toMatch(/createEmptyFieldDraft/)
      expect(code).not.toMatch(/createEmptyDetailColumnDraft/)
    }
    // The flag-OFF fallback (TemplateAuthoringView) keeps its legacy call
    // sites untouched — F1 must not silently migrate them.
    const viewSource = readFileSync(
      join(__dirname, '../src/views/approval/TemplateAuthoringView.vue'),
      'utf8',
    )
    expect(viewSource).toMatch(
      /createEmptyFieldDraft\(draft\.value\.fields\.length \+ 1\)/,
    )
    expect(viewSource).toMatch(
      /createEmptyDetailColumnDraft\(field\.detailColumns\.length \+ 1\)/,
    )
  })
})
