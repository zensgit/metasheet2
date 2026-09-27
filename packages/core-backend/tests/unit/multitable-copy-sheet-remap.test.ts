/**
 * Copy-sheet §5.2 id-remap layer (ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md CS-9/10/12) —
 * pure functions, no IO.
 *
 *   R1  every allowlisted id-bearing property key is remapped (lookup/rollup linkFieldId aliases, self-link
 *       targetFieldId, foreignSheetId aliases → new sheet on self-reference, visibilityRule/requiredWhen.fieldId,
 *       formula {fld_…} refs, aiShortcut.sourceFieldIds); foreign-sheet targetFieldId stays.
 *   R2  an UNLISTED key whose value looks like `fld_…` (string, array element, nested) → COPY_UNMAPPED_FIELD_REF with
 *       the owning fieldId and no value in the error.
 *   R3  mirror link not built (MIRROR_NOT_BUILT); twoWay / mirrorFieldId dropped on the forward side.
 *   R4  button → actionType 'record_click', actionConfig gone, label/variant/confirm kept (BUTTON_DISABLED).
 *   R5  attachment / self-link / property-hidden (without canManageFields) → built, values blanked, disclosed;
 *       with canManageFields the hidden column's values copy; derived column over a blanked input →
 *       DEPENDS_ON_BLANKED_COLUMN.
 *   R6  views: filter leaves on blanked/unbuilt/unknown fields are DROPPED (counted per view), nested groups
 *       walked, remaining leaves remapped; sort/group/config `*FieldId(s)` remapped; `publicForm` stripped;
 *       a stray `fld_` string elsewhere in config → COPY_UNMAPPED_FIELD_REF carrying the viewId.
 *   R7  rules: fieldId remapped; unbuilt/unknown → COPY_SOURCE_RULE_UNBUILDABLE (never dropped); autoNumber
 *       rule + renumbering → COPY_SOURCE_RULE_ON_RENUMBERED_FIELD; same rule without renumbering passes.
 *   R8  unknown field type → COPY_UNSUPPORTED_FIELD_TYPE; minted ids must keep the `fld_` prefix.
 */
import { describe, expect, it } from 'vitest'

import {
  COPY_SOURCE_RULE_ON_RENUMBERED_FIELD,
  COPY_SOURCE_RULE_UNBUILDABLE,
  COPY_UNMAPPED_FIELD_REF,
  COPY_UNSUPPORTED_FIELD_TYPE,
  CopySheetRemapError,
  planFieldCopies,
  planViewCopies,
  remapConditionalRules,
  type SourceFieldRow,
  type SourceViewRow,
} from '../../src/multitable/copy-sheet-remap'

const SRC = 'sheet_src'
const NEW = 'sheet_new'
const FOREIGN = 'sheet_foreign'

function field(id: string, type: string, property: Record<string, unknown> = {}, order = 0): SourceFieldRow {
  return { id, name: id, type, property, order }
}

function mint(prefix = 'fld') {
  let n = 0
  return () => `${prefix}_new_${++n}`
}

const BASE_FIELDS: SourceFieldRow[] = [
  field('fld_title', 'string', { validation: [{ type: 'required' }] }, 0),
  field('fld_link', 'link', { foreignSheetId: FOREIGN, limitSingleRecord: false, twoWay: true, mirrorFieldId: 'fld_far_mirror' }, 1),
  field('fld_self', 'link', { foreignSheetId: SRC, limitSingleRecord: true }, 2),
  field('fld_mirror', 'link', { foreignSheetId: FOREIGN, mirrorOf: 'fld_far_forward', readOnly: true }, 3),
  field('fld_lookup', 'lookup', { linkFieldId: 'fld_link', targetFieldId: 'fld_far_name', foreignSheetId: FOREIGN }, 4),
  field('fld_self_lookup', 'lookup', { relatedLinkFieldId: 'fld_self', lookUpTargetFieldId: 'fld_title', foreignDatasheetId: SRC }, 5),
  field('fld_formula', 'formula', { expression: '={fld_title} & "-" & {fld_num}' }, 6),
  field('fld_num', 'number', { visibilityRule: { fieldId: 'fld_title', operator: 'is_not_empty' }, requiredWhen: { fieldId: 'fld_num', operator: 'gt', value: 3 } }, 7),
  field('fld_att', 'attachment', {}, 8),
  field('fld_btn', 'button', { label: 'Go', variant: 'primary', actionType: 'send_webhook', actionConfig: { url: 'https://example.invalid', secret: 's3' }, confirm: { enabled: true } }, 9),
  field('fld_hidden', 'string', { hidden: true }, 10),
  field('fld_ai', 'string', { aiShortcut: { kind: 'summarize', sourceFieldIds: ['fld_title', 'fld_num'], params: {} } }, 11),
  field('fld_auto', 'autoNumber', { start: 1 }, 12),
  field('fld_rollup_blanked', 'rollup', { linkFieldId: 'fld_self', targetFieldId: 'fld_num', aggregation: 'sum', foreignSheetId: SRC }, 13),
]

describe('copy-sheet remap (§5.2)', () => {
  it('R1: allowlisted keys are remapped; foreign-sheet targets stay; self-references point at the new sheet', () => {
    const { plans, ctx } = planFieldCopies(BASE_FIELDS, SRC, NEW, mint(), { copierCanManageSourceFields: false })
    const byId = new Map(plans.map((p) => [p.sourceFieldId, p]))
    const map = ctx.fieldIdMap

    const lookup = byId.get('fld_lookup')!
    expect(lookup.property.linkFieldId).toBe(map.get('fld_link'))
    expect(lookup.property.targetFieldId).toBe('fld_far_name') // foreign field stays
    expect(lookup.property.foreignSheetId).toBe(FOREIGN)

    const selfLookup = byId.get('fld_self_lookup')!
    expect(selfLookup.property.relatedLinkFieldId).toBe(map.get('fld_self'))
    expect(selfLookup.property.lookUpTargetFieldId).toBe(map.get('fld_title')) // self-link → target remapped
    expect(selfLookup.property.foreignDatasheetId).toBe(NEW)

    const self = byId.get('fld_self')!
    expect(self.property.foreignSheetId).toBe(NEW)

    const formula = byId.get('fld_formula')!
    expect(formula.property.expression).toBe(`={${map.get('fld_title')}} & "-" & {${map.get('fld_num')}}`)

    const num = byId.get('fld_num')!
    expect((num.property.visibilityRule as { fieldId: string }).fieldId).toBe(map.get('fld_title'))
    expect((num.property.requiredWhen as { fieldId: string; value: unknown })).toEqual({ fieldId: map.get('fld_num'), operator: 'gt', value: 3 })

    const ai = byId.get('fld_ai')!
    expect((ai.property.aiShortcut as { sourceFieldIds: string[] }).sourceFieldIds).toEqual([map.get('fld_title'), map.get('fld_num')])

    // Non-id property passes through untouched.
    expect(byId.get('fld_title')!.property.validation).toEqual([{ type: 'required' }])
    // Every new id keeps the `fld_` prefix and is distinct from every source id.
    for (const p of plans) {
      expect(p.newFieldId).toMatch(/^fld_/)
      expect(BASE_FIELDS.some((f) => f.id === p.newFieldId)).toBe(false)
    }
  })

  it('R2: an unlisted key carrying a fld_ reference (string / array / nested) is refused with the owning fieldId only', () => {
    for (const rogue of [
      { someUnknownKey: 'fld_title' },
      { list: ['x', 'fld_num'] },
      { nested: { deeper: { ref: 'fld_title' } } },
    ]) {
      const fields = [field('fld_title', 'string'), field('fld_num', 'number'), field('fld_rogue', 'string', rogue)]
      const err = (() => { try { planFieldCopies(fields, SRC, NEW, mint(), { copierCanManageSourceFields: false }); return null } catch (e) { return e } })()
      expect(err).toBeInstanceOf(CopySheetRemapError)
      expect((err as CopySheetRemapError).code).toBe(COPY_UNMAPPED_FIELD_REF)
      expect((err as CopySheetRemapError).fieldId).toBe('fld_rogue')
      expect((err as Error).message).not.toContain('fld_title')
      expect((err as Error).message).not.toContain('fld_num')
    }
    // A rule VALUE that carries a fld_ ref is not a literal — refused too.
    const fields = [field('fld_title', 'string'), field('fld_x', 'string', { visibilityRule: { fieldId: 'fld_title', operator: 'eq', value: 'fld_title' } })]
    expect(() => planFieldCopies(fields, SRC, NEW, mint(), { copierCanManageSourceFields: false })).toThrow(COPY_UNMAPPED_FIELD_REF)
  })

  it('R3: mirror link not built; twoWay / mirrorFieldId dropped from the forward link', () => {
    const { plans, ctx } = planFieldCopies(BASE_FIELDS, SRC, NEW, mint(), { copierCanManageSourceFields: false })
    const byId = new Map(plans.map((p) => [p.sourceFieldId, p]))
    const mirror = byId.get('fld_mirror')!
    expect(mirror.build).toBe(false)
    expect(mirror.disclosures).toEqual([{ fieldId: 'fld_mirror', code: 'MIRROR_NOT_BUILT' }])
    expect(ctx.unbuiltFieldIds.has('fld_mirror')).toBe(true)
    // the mirror still has a map entry so references to it can be RECOGNISED (and refused) rather than passed through
    expect(ctx.fieldIdMap.has('fld_mirror')).toBe(true)
    const link = byId.get('fld_link')!
    expect(link.build).toBe(true)
    expect(link.property).not.toHaveProperty('twoWay')
    expect(link.property).not.toHaveProperty('mirrorFieldId')
    expect(link.property.foreignSheetId).toBe(FOREIGN)
  })

  it('R4: button → record_click, actionConfig gone, label/variant/confirm kept, BUTTON_DISABLED disclosed', () => {
    const { plans } = planFieldCopies(BASE_FIELDS, SRC, NEW, mint(), { copierCanManageSourceFields: false })
    const btn = plans.find((p) => p.sourceFieldId === 'fld_btn')!
    expect(btn.build).toBe(true)
    expect(btn.copyValues).toBe(false)
    expect(btn.property.actionType).toBe('record_click')
    expect(btn.property).not.toHaveProperty('actionConfig')
    expect(btn.property.label).toBe('Go')
    expect(btn.property.variant).toBe('primary')
    expect(btn.property.confirm).toEqual({ enabled: true })
    expect(btn.disclosures).toEqual([{ fieldId: 'fld_btn', code: 'BUTTON_DISABLED' }])
    expect(JSON.stringify(btn.property)).not.toContain('s3')
    expect(JSON.stringify(btn.property)).not.toContain('example.invalid')
  })

  it('R5: attachment / self-link / hidden blanked and disclosed; canManageFields lets the hidden column copy; derived-over-blanked disclosed', () => {
    const noAuthority = planFieldCopies(BASE_FIELDS, SRC, NEW, mint(), { copierCanManageSourceFields: false })
    const byId = new Map(noAuthority.plans.map((p) => [p.sourceFieldId, p]))
    expect(byId.get('fld_att')!.copyValues).toBe(false)
    expect(byId.get('fld_att')!.disclosures).toEqual([{ fieldId: 'fld_att', code: 'ATTACHMENT_BLANKED' }])
    expect(byId.get('fld_self')!.copyValues).toBe(false)
    expect(byId.get('fld_self')!.disclosures).toEqual([{ fieldId: 'fld_self', code: 'SELF_LINK_BLANKED' }])
    expect(byId.get('fld_hidden')!.build).toBe(true)
    expect(byId.get('fld_hidden')!.copyValues).toBe(false)
    expect(byId.get('fld_hidden')!.disclosures).toEqual([{ fieldId: 'fld_hidden', code: 'PROPERTY_HIDDEN_BLANKED' }])
    expect(byId.get('fld_hidden')!.property.hidden).toBe(true) // stays hidden
    expect([...noAuthority.ctx.blankedFieldIds].sort()).toEqual(['fld_att', 'fld_hidden', 'fld_self'])
    // rollup over the blanked self-link → disclosed, still built
    const rollup = byId.get('fld_rollup_blanked')!
    expect(rollup.build).toBe(true)
    expect(rollup.disclosures).toEqual([{ fieldId: 'fld_rollup_blanked', code: 'DEPENDS_ON_BLANKED_COLUMN' }])
    // derived / system columns are built and never copy values, but are NOT "blanked" inputs
    expect(byId.get('fld_formula')!.copyValues).toBe(false)
    expect(byId.get('fld_auto')!.copyValues).toBe(false)
    expect(byId.get('fld_lookup')!.disclosures).toEqual([])

    const withAuthority = planFieldCopies(BASE_FIELDS, SRC, NEW, mint(), { copierCanManageSourceFields: true })
    const hidden = withAuthority.plans.find((p) => p.sourceFieldId === 'fld_hidden')!
    expect(hidden.copyValues).toBe(true)
    expect(hidden.disclosures).toEqual([])
    expect(withAuthority.ctx.blankedFieldIds.has('fld_hidden')).toBe(false)
  })

  it('R6: views — dropped leaves counted, nested groups walked, *FieldId(s) remapped, publicForm stripped, stray fld_ refused', () => {
    const { ctx } = planFieldCopies(BASE_FIELDS, SRC, NEW, mint(), { copierCanManageSourceFields: false })
    const map = ctx.fieldIdMap
    const view: SourceViewRow = {
      id: 'view_1',
      name: 'Grid',
      type: 'grid',
      filterInfo: {
        conjunction: 'and',
        conditions: [
          { fieldId: 'fld_title', operator: 'contains', value: 'secret-literal' },
          { fieldId: 'fld_att', operator: 'is_not_empty' }, // blanked → dropped
          { conjunction: 'or', conditions: [
            { fieldId: 'fld_mirror', operator: 'is_empty' }, // unbuilt → dropped
            { fieldId: 'fld_unknown', operator: 'eq', value: 1 }, // unknown → dropped
            { fieldId: 'fld_num', operator: 'gt', value: 2 },
          ] },
        ],
      },
      sortInfo: { rules: [{ fieldId: 'fld_num', desc: true }, { fieldId: 'fld_att', desc: false }] },
      groupInfo: { fieldId: 'fld_title', fieldIds: ['fld_title', 'fld_mirror'] },
      hiddenFieldIds: ['fld_att', 'fld_mirror', 'fld_num'],
      config: {
        conditionalFormattingRules: [{ id: 'r1', fieldId: 'fld_num', operator: 'gt', value: 1, style: {} }, { id: 'r2', fieldId: 'fld_att', operator: 'is_empty', style: {} }],
        kanban: { groupFieldId: 'fld_title' },
        dependencyFieldId: 'fld_self',
        publicForm: { enabled: true, publicToken: 'tok_secret' },
        layout: { columns: 3 },
      },
    }
    const [plan] = planViewCopies(ctx, [view], mint('view'))
    expect(plan!.newViewId).toMatch(/^view_/)
    expect(plan!.droppedFilterLeaves).toBe(3)
    expect(plan!.filterInfo).toEqual({
      conjunction: 'and',
      conditions: [
        { fieldId: map.get('fld_title'), operator: 'contains', value: 'secret-literal' },
        { conjunction: 'or', conditions: [{ fieldId: map.get('fld_num'), operator: 'gt', value: 2 }] },
      ],
    })
    // sort / group / config: a BLANKED-but-built column (fld_att, fld_self) is still a real column, so its
    // reference is remapped (only FILTER leaves on it are dropped — ADR §5.2); the UNBUILT mirror is dropped.
    expect(plan!.sortInfo).toEqual({ rules: [{ fieldId: map.get('fld_num'), desc: true }, { fieldId: map.get('fld_att'), desc: false }] })
    expect(plan!.groupInfo).toEqual({ fieldId: map.get('fld_title'), fieldIds: [map.get('fld_title')] })
    expect(plan!.hiddenFieldIds).toEqual([map.get('fld_att'), map.get('fld_num')])
    expect(plan!.config).toEqual({
      conditionalFormattingRules: [
        { id: 'r1', fieldId: map.get('fld_num'), operator: 'gt', value: 1, style: {} },
        { id: 'r2', fieldId: map.get('fld_att'), operator: 'is_empty', style: {} },
      ],
      kanban: { groupFieldId: map.get('fld_title') },
      dependencyFieldId: map.get('fld_self'),
      layout: { columns: 3 },
    })
    // an UNBUILT reference in config is dropped (no dangling key), a stray unknown too
    const withMirror: SourceViewRow = { ...view, id: 'view_2', config: { groupFieldId: 'fld_mirror', titleFieldId: 'fld_unknown', keep: 1 } }
    const [plan2] = planViewCopies(ctx, [withMirror], mint('view'))
    expect(plan2!.config).toEqual({ keep: 1 })
    expect(JSON.stringify(plan!.config)).not.toContain('tok_secret')
    expect(plan!.config).not.toHaveProperty('publicForm')

    // stray fld_ string somewhere else in config → refused, naming the view (never the value)
    const rogue: SourceViewRow = { ...view, id: 'view_rogue', config: { note: 'fld_title' } }
    const err = (() => { try { planViewCopies(ctx, [rogue], mint('view')); return null } catch (e) { return e } })()
    expect(err).toBeInstanceOf(CopySheetRemapError)
    expect((err as CopySheetRemapError).code).toBe(COPY_UNMAPPED_FIELD_REF)
    expect((err as CopySheetRemapError).viewId).toBe('view_rogue')
  })

  it('R7: rules remapped, never dropped — unbuilt/unknown refuse; autoNumber + renumbering refuses; without renumbering passes', () => {
    const { ctx } = planFieldCopies(BASE_FIELDS, SRC, NEW, mint(), { copierCanManageSourceFields: false })
    const map = ctx.fieldIdMap
    const ok = remapConditionalRules(ctx, [{ id: 'r1', fieldId: 'fld_num', operator: 'gt', value: 5, effect: 'deny_read' }], true)
    expect(ok).toEqual([{ id: 'r1', fieldId: map.get('fld_num'), operator: 'gt', value: 5, effect: 'deny_read' }])

    for (const bad of ['fld_mirror', 'fld_unknown']) {
      const err = (() => { try { remapConditionalRules(ctx, [{ id: 'r', fieldId: bad, operator: 'isEmpty', effect: 'deny_read' }], false); return null } catch (e) { return e } })()
      expect((err as CopySheetRemapError).code).toBe(COPY_SOURCE_RULE_UNBUILDABLE)
    }
    const auto = [{ id: 'r', fieldId: 'fld_auto', operator: 'gt' as const, value: 10, effect: 'deny_read' as const }]
    expect(() => remapConditionalRules(ctx, auto, true)).toThrow(COPY_SOURCE_RULE_ON_RENUMBERED_FIELD)
    expect(remapConditionalRules(ctx, auto, false)[0]!.fieldId).toBe(map.get('fld_auto'))
  })

  it('R8: unknown field type refuses; a mint that loses the fld_ prefix is a programming error', () => {
    expect(() => planFieldCopies([field('fld_x', 'hologram')], SRC, NEW, mint(), { copierCanManageSourceFields: false }))
      .toThrow(COPY_UNSUPPORTED_FIELD_TYPE)
    expect(() => planFieldCopies([field('fld_x', 'string')], SRC, NEW, () => 'col_1', { copierCanManageSourceFields: false }))
      .toThrow('COPY_FIELD_ID_PREFIX_INVALID')
  })
})
