/**
 * 备料 「查看子件」 / 「查看所有使用位置」 (owner question 2026-11-07) — the record drawer and the pure rules
 * (utils/bom-relations.ts):
 *
 *   B-01 detection: only /context's stockPreparationBomRelations block turns the buttons on — absent / malformed /
 *        blank ids / the two id columns equal ⇒ null (fail closed); column names are never read;
 *   B-02 filter construction: 子件 = parentSourceId `is` this row's componentSourceId; 使用位置 = componentSourceId `is`
 *        the same id — exact physical ids, equality on the PLM id (never on 图号, which can repeat); a column the view
 *        hides is used all the same (the block names it; GET /view filters view-hidden columns);
 *   B-03 a row without a PLM material id ⇒ no filter (the buttons are disabled with the reason);
 *   B-04 the drawer renders the two buttons only when the workbench passes `bomRelations`, emits the kind, and shows the
 *        reason (disabled) when the row has no PLM id;
 *   B-05 copy (zh + en): the 「只对你生效」 banner, the once-per-position note, the 全部记录 hint.
 *
 * Collected by the required web gate through the existing `multitable-record-inspector` token. Synthetic values only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaBomRelationsBlock, MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import {
  bomRelationsLabel,
  bomRelationsSourceValue,
  buildBomRelationsViewerFilter,
  readBomRelationsBlock,
} from '../src/multitable/utils/bom-relations'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

// Synthetic physical ids (on a real sheet these are provisioning's sha1-derived `fld_…` ids).
const BLOCK: MetaBomRelationsBlock = {
  componentSourceFieldId: 'fld_br_src',
  parentSourceFieldId: 'fld_br_parent_src',
  activeFieldId: 'fld_br_active',
  componentCodeFieldId: 'fld_br_code',
  componentNameFieldId: 'fld_br_name',
}
const FIELDS: MetaField[] = [
  { id: 'fld_br_code', name: '图号', type: 'string' },
  { id: 'fld_br_name', name: '名称', type: 'string' },
  { id: 'fld_br_src', name: 'PLM 物料ID', type: 'string' },
  { id: 'fld_br_parent_src', name: '父件源ID', type: 'string' },
]
const SUB_ASSEMBLY: MetaRecord = {
  id: 'rec_br_s01',
  version: 1,
  data: { fld_br_code: 'S-01', fld_br_name: 'Synthetic sub-assembly', fld_br_src: 'SRC-S01', fld_br_parent_src: 'SRC-P07' },
}
const NO_SOURCE: MetaRecord = { id: 'rec_br_manual', version: 1, data: { fld_br_code: 'X', fld_br_name: 'Synthetic manual row' } }

let mounted: App | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

function mountInspector(props: Record<string, unknown>): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  mounted = createApp({
    render() {
      return h(MetaRecordInspector, {
        visible: true,
        record: SUB_ASSEMBLY,
        fields: FIELDS,
        canEdit: false,
        canComment: false,
        canDelete: false,
        rowActions: { canEdit: false, canDelete: false, canComment: false },
        ...props,
      })
    },
  })
  mounted.mount(container)
  return container
}

const childrenButton = () => document.querySelector<HTMLButtonElement>('[data-testid="record-inspector-bom-children"]')
const whereUsedButton = () => document.querySelector<HTMLButtonElement>('[data-testid="record-inspector-bom-where-used"]')

describe('B-01 detection reads only the /context block, fail closed', () => {
  it('a well-formed block is read as is', () => {
    expect(readBomRelationsBlock({ canRead: true, stockPreparationBomRelations: { ...BLOCK } })).toEqual(BLOCK)
  })
  it('an ordinary sheet (no block), a malformed block, a blank id or equal id columns ⇒ null', () => {
    expect(readBomRelationsBlock({ canRead: true })).toBeNull()
    expect(readBomRelationsBlock(null)).toBeNull()
    expect(readBomRelationsBlock({ stockPreparationBomRelations: 'yes' })).toBeNull()
    expect(readBomRelationsBlock({ stockPreparationBomRelations: [BLOCK] })).toBeNull()
    expect(readBomRelationsBlock({ stockPreparationBomRelations: { ...BLOCK, parentSourceFieldId: ' ' } })).toBeNull()
    const { activeFieldId: _drop, ...missing } = BLOCK
    expect(readBomRelationsBlock({ stockPreparationBomRelations: missing })).toBeNull()
    expect(readBomRelationsBlock({ stockPreparationBomRelations: { ...BLOCK, parentSourceFieldId: BLOCK.componentSourceFieldId } })).toBeNull()
  })
  it('columns NAMED like the template on a sheet without the block do not count', () => {
    // FIELDS above carry the template's Chinese names; the capabilities say nothing ⇒ no buttons.
    expect(readBomRelationsBlock({ canRead: true, fields: FIELDS })).toBeNull()
  })
})

describe('B-02 filter construction: exact ids, equality on the PLM id', () => {
  it('子件: parentSourceId is this row\'s componentSourceId', () => {
    expect(buildBomRelationsViewerFilter('children', BLOCK, SUB_ASSEMBLY, false)).toEqual({
      label: 'Viewing: children of S-01 (only for you)',
      conditions: [{ fieldId: 'fld_br_parent_src', operator: 'is', value: 'SRC-S01' }],
    })
  })
  it('使用位置: componentSourceId is the same id (never 图号)', () => {
    const filter = buildBomRelationsViewerFilter('whereUsed', BLOCK, SUB_ASSEMBLY, true)
    expect(filter).toEqual({
      label: '正在查看：S-01 的所有使用位置（只对你生效）',
      conditions: [{ fieldId: 'fld_br_src', operator: 'is', value: 'SRC-S01' }],
    })
    expect(JSON.stringify(filter!.conditions)).not.toContain('fld_br_code')
  })
  it('the id columns are used even when the view hides them (the block names them, not the view)', () => {
    // Nothing about the view enters the construction: the same ids come back whatever the view hides.
    const hiddenInView = new Set([BLOCK.componentSourceFieldId, BLOCK.parentSourceFieldId])
    const filter = buildBomRelationsViewerFilter('children', BLOCK, SUB_ASSEMBLY, false)!
    expect(hiddenInView.has(filter.conditions[0].fieldId)).toBe(true)
  })
  it('a numeric id is sent as its text; the label falls back to 名称, then a neutral word', () => {
    const numeric: MetaRecord = { id: 'r', version: 1, data: { fld_br_src: 4711, fld_br_name: 'Synthetic part' } }
    expect(buildBomRelationsViewerFilter('children', BLOCK, numeric, false)).toEqual({
      label: 'Viewing: children of Synthetic part (only for you)',
      conditions: [{ fieldId: 'fld_br_parent_src', operator: 'is', value: '4711' }],
    })
    const bare: MetaRecord = { id: 'r', version: 1, data: { fld_br_src: 'SRC-X' } }
    expect(buildBomRelationsViewerFilter('whereUsed', BLOCK, bare, true)?.label).toBe('正在查看：这个物料 的所有使用位置（只对你生效）')
  })
})

describe('B-03 a row without a PLM material id', () => {
  it('has no source value and no filter', () => {
    expect(bomRelationsSourceValue(BLOCK, NO_SOURCE)).toBeNull()
    expect(bomRelationsSourceValue(BLOCK, { id: 'r', version: 1, data: { fld_br_src: '   ' } })).toBeNull()
    expect(buildBomRelationsViewerFilter('children', BLOCK, NO_SOURCE, false)).toBeNull()
    expect(buildBomRelationsViewerFilter('whereUsed', BLOCK, NO_SOURCE, false)).toBeNull()
  })
})

describe('B-04 the drawer', () => {
  it('no `bomRelations` (an ordinary sheet) ⇒ no buttons', async () => {
    mountInspector({})
    await flushUi()
    expect(document.querySelector('[data-testid="record-inspector-bom-relations"]')).toBeNull()
    expect(childrenButton()).toBeNull()
    expect(whereUsedButton()).toBeNull()
  })

  it('with `bomRelations` both buttons show (zh labels, the once-per-position hint) and emit their kind', async () => {
    useLocale().setLocale('zh-CN')
    const onBomRelations = vi.fn()
    mountInspector({ bomRelations: { disabledReason: null }, onBomRelations })
    await flushUi()
    expect(childrenButton()?.textContent?.trim()).toBe('查看子件')
    expect(whereUsedButton()?.textContent?.trim()).toBe('查看所有使用位置')
    expect(document.querySelector('[data-testid="record-inspector-bom-relations-hint"]')?.textContent?.trim())
      .toBe('只对你生效，不改视图。同一个部件用在几处，它的子件按每处各列一次。')
    childrenButton()!.click()
    whereUsedButton()!.click()
    expect(onBomRelations.mock.calls).toEqual([['children'], ['whereUsed']])
  })

  it('a row without a PLM id: both disabled, the reason shown, nothing emitted', async () => {
    const onBomRelations = vi.fn()
    const reason = bomRelationsLabel('action.noSource', false)
    mountInspector({ record: NO_SOURCE, bomRelations: { disabledReason: reason }, onBomRelations })
    await flushUi()
    expect(childrenButton()!.disabled).toBe(true)
    expect(whereUsedButton()!.disabled).toBe(true)
    expect(document.querySelector('[data-testid="record-inspector-bom-relations-hint"]')?.textContent?.trim()).toBe(reason)
    childrenButton()!.click()
    expect(onBomRelations).not.toHaveBeenCalled()
  })
})

describe('B-05 copy', () => {
  it('zh', () => {
    expect(bomRelationsLabel('banner.children', true, { part: 'S-01' })).toBe('正在查看：S-01 的子件（只对你生效）')
    expect(bomRelationsLabel('banner.note', true)).toContain('全部记录')
    expect(bomRelationsLabel('banner.note', true)).toContain('视图本身没有被改动')
    expect(bomRelationsLabel('action.childrenTitle', true)).toContain('它的子件按每处各列一次')
    expect(bomRelationsLabel('banner.clear', true)).toBe('清除，回到视图')
  })
  it('en', () => {
    expect(bomRelationsLabel('banner.whereUsed', false, { part: 'S-01' })).toBe('Viewing: all positions of S-01 (only for you)')
    expect(bomRelationsLabel('action.hint', false)).toContain('once per position')
    expect(bomRelationsLabel('banner.note', false)).toContain('All Records')
  })
})
