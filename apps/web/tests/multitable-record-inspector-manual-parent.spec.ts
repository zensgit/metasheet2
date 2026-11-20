/**
 * 人工补充行的父组件 (ADR adr-stock-prep-manual-rows-20261030 §12.2 / §12.3 / §12.6 / §12.7 ①, slice P2) — the
 * components and the pure rules behind them:
 *
 *   MP-U   utils/manual-rows.ts: /context `parentFieldIds` read fail closed; the pair is dropped from the editable set;
 *          candidates grouped, own 图号 left out, values kept as returned; the client refusals and the payload;
 *   MP-D   MetaManualRowDialog 「父组件」: hidden without `parentFieldIds`; 不挂父组件 (default) sends nothing; 选已有的
 *          sends the pick exactly; 新建父组件 trims and requires both; name-without-code and self-parent refused before
 *          submit; a server message is still shown;
 *   MP-E   MetaManualRowParentDialog (the drawer's 「修改父组件」): 改成已有的 / 新建父组件 / 移出父组件 → the pair;
 *   MP-I   MetaRecordInspector shows 「修改父组件」 beside 父组件图号 only when the workbench passes `manualParent`;
 *   MP-C   utils/manual-row-parent-dependents.ts: the §12.7 ① confirm (sum, only when > 0, a failed count is no gate).
 *
 * Collected by the required web gate through the existing `multitable-record-inspector` token. Synthetic values only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaManualRowDialog from '../src/multitable/components/MetaManualRowDialog.vue'
import MetaManualRowParentDialog from '../src/multitable/components/MetaManualRowParentDialog.vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import {
  groupManualRowParentOptions,
  manualRowCodeChangeNeedsDependentsCheck,
  manualRowParentPayload,
  manualRowParentProblem,
  readManualRowsBlock,
  resolveManualRowEditableFieldIds,
  type ManualRowDialogPlan,
} from '../src/multitable/utils/manual-rows'
import { confirmManualRowParentDependents } from '../src/multitable/utils/manual-row-parent-dependents'

async function flushUi(cycles = 6) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const LOCK = { humanWriteLock: 'plm_system' }
const F = { name: 'fld_mp_name', code: 'fld_mp_code', pcode: 'fld_mp_pcode', pname: 'fld_mp_pname' }
const IDS = { code: F.pcode, name: F.pname }
const FIELDS: MetaField[] = [
  { id: F.name, name: '名称', type: 'string', property: { ...LOCK } },
  { id: F.code, name: '图号', type: 'string', property: { ...LOCK } },
  { id: F.pcode, name: '父组件图号', type: 'string', property: { ...LOCK } },
  { id: F.pname, name: '父组件名称', type: 'string', property: { ...LOCK } },
]
const PLAN: ManualRowDialogPlan = {
  fields: [{ field: FIELDS[0], required: true }, { field: FIELDS[1], required: false }],
  blockedRequiredCount: 0,
}
const CANDIDATES = {
  items: [
    { code: 'SYN-P1 ', name: ' Synthetic parent', kind: 'parent', childCount: 12 },
    { code: 'SYN-P2', name: null, kind: 'parent', childCount: 1 },
    { code: 'SYN-OWN', name: 'Own row', kind: 'component' },
    { code: 'SYN-C1', name: 'Synthetic part', kind: 'component' },
  ],
  truncated: true,
}

let mounted: App | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

function mountComponent(component: unknown, props: Record<string, unknown>): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  mounted = createApp({ render: () => h(component as never, props) })
  mounted.mount(container)
}

const q = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector as never) as T | null
function type(el: HTMLInputElement | null, value: string) {
  el!.value = value
  el!.dispatchEvent(new Event('input'))
}
async function choose(mode: string) {
  const radio = q<HTMLInputElement>(`[data-manual-parent-mode="${mode}"]`)!
  radio.checked = true
  radio.dispatchEvent(new Event('change'))
  await flushUi()
}
const fieldInput = (fieldId: string) => q<HTMLInputElement>(`[data-manual-row-field="${fieldId}"] input`)
/** Each option as「<code + name> | <child count>」 (the item's own children, whitespace collapsed). */
const optionTexts = () => Array.from(document.body.querySelectorAll('[data-manual-parent-option]'))
  .map((o) => Array.from(o.children).map((c) => c.textContent?.replace(/\s+/g, ' ').trim()).join(' | '))

describe('MP-U the pure rules', () => {
  it('reads parentFieldIds fail closed and keeps it out of the editable set', () => {
    const base = { state: 'allowed', editableFieldIds: [F.name, F.code, F.pcode], requiredFieldIds: [F.name], dialogFieldIds: [] }
    expect(readManualRowsBlock({ stockPreparationManualRows: { ...base, parentFieldIds: IDS } })?.parentFieldIds).toEqual(IDS)
    for (const bad of [undefined, null, 'x', [], { code: F.pcode }, { code: '', name: F.pname }, { code: F.pcode, name: F.pcode }, { code: 1, name: 2 }]) {
      expect(readManualRowsBlock({ stockPreparationManualRows: { ...base, parentFieldIds: bad } })?.parentFieldIds, JSON.stringify(bad)).toBeUndefined()
    }
    const block = readManualRowsBlock({ stockPreparationManualRows: { ...base, parentFieldIds: IDS } })
    expect(resolveManualRowEditableFieldIds(block, FIELDS, {})).toEqual([F.name, F.code])
  })

  it('reads componentCodeFieldId only beside a well-formed pair, fail closed', () => {
    const base = { state: 'allowed', editableFieldIds: [F.name, F.code], requiredFieldIds: [F.name], dialogFieldIds: [] }
    const read = (extra: Record<string, unknown>) => readManualRowsBlock({ stockPreparationManualRows: { ...base, ...extra } })
    expect(read({ parentFieldIds: IDS, componentCodeFieldId: F.code })?.componentCodeFieldId).toBe(F.code)
    // Absent beside the pair: the actor cannot read 图号 (the drawer offers no 「修改父组件」).
    expect(read({ parentFieldIds: IDS })).not.toHaveProperty('componentCodeFieldId')
    // Never without the pair, even if a host sent it.
    expect(read({ componentCodeFieldId: F.code })).not.toHaveProperty('componentCodeFieldId')
    expect(read({ parentFieldIds: { code: F.pcode }, componentCodeFieldId: F.code })).not.toHaveProperty('componentCodeFieldId')
    for (const bad of [undefined, null, '', '  ', 7, [], {}, F.pcode, F.pname]) {
      expect(read({ parentFieldIds: IDS, componentCodeFieldId: bad })?.componentCodeFieldId, JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('groups the candidates, drops the own 图号 (trimmed comparison) and malformed entries, keeps values exactly', () => {
    const groups = groupManualRowParentOptions({ ...CANDIDATES, items: [...CANDIDATES.items, { code: '  ', kind: 'parent' }, { code: 'X', kind: 'other' }, null] }, ' SYN-OWN ')
    expect(groups.parents).toEqual([
      { code: 'SYN-P1 ', name: ' Synthetic parent', kind: 'parent', childCount: 12 },
      { code: 'SYN-P2', name: null, kind: 'parent', childCount: 1 },
    ])
    expect(groups.components).toEqual([{ code: 'SYN-C1', name: 'Synthetic part', kind: 'component' }])
    expect(groups.truncated).toBe(true)
    expect(groupManualRowParentOptions(null)).toEqual({ parents: [], components: [], truncated: false })
  })

  it('refuses before submit and builds the pair with both keys', () => {
    expect(manualRowParentProblem({ mode: 'none' }, 'A')).toBeNull()
    expect(manualRowParentProblem({ mode: 'pick', option: null }, 'A')).toBe('pick_required')
    expect(manualRowParentProblem({ mode: 'pick', option: { code: ' A', name: null } }, 'A ')).toBe('self_parent')
    expect(manualRowParentProblem({ mode: 'new', code: ' ', name: 'n' }, null)).toBe('name_without_code')
    expect(manualRowParentProblem({ mode: 'new', code: '', name: '' }, null)).toBe('code_required')
    expect(manualRowParentProblem({ mode: 'new', code: 'P', name: ' ' }, null)).toBe('name_required')
    expect(manualRowParentProblem({ mode: 'new', code: ' A ', name: 'n' }, 'A')).toBe('self_parent')
    expect(manualRowParentPayload({ mode: 'none' }, IDS)).toEqual({ [F.pcode]: null, [F.pname]: null })
    expect(manualRowParentPayload({ mode: 'pick', option: { code: ' P ', name: null } }, IDS)).toEqual({ [F.pcode]: ' P ', [F.pname]: null })
    expect(manualRowParentPayload({ mode: 'new', code: ' P ', name: ' N ' }, IDS)).toEqual({ [F.pcode]: 'P', [F.pname]: 'N' })
  })

  it('asks about dependents only when a stored 图号 really changes', () => {
    expect(manualRowCodeChangeNeedsDependentsCheck('A', 'B')).toBe(true)
    expect(manualRowCodeChangeNeedsDependentsCheck('A', null)).toBe(true)
    expect(manualRowCodeChangeNeedsDependentsCheck('A', ' A ')).toBe(false)
    expect(manualRowCodeChangeNeedsDependentsCheck('', 'B')).toBe(false)
    expect(manualRowCodeChangeNeedsDependentsCheck(null, 'B')).toBe(false)
  })
})

describe('MP-D MetaManualRowDialog 「父组件」', () => {
  function mountDialog(props: Record<string, unknown> = {}) {
    const onSubmit = vi.fn()
    const search = vi.fn().mockResolvedValue(CANDIDATES)
    mountComponent(MetaManualRowDialog, {
      visible: true, plan: PLAN, parentFieldIds: IDS, ownCodeFieldId: F.code, searchParentOptions: search,
      parentSearchDebounceMs: 0, onSubmit, ...props,
    })
    return { onSubmit, search }
  }
  async function fillRow(code = 'SYN-OWN') {
    type(fieldInput(F.name), 'Synthetic row')
    type(fieldInput(F.code), code)
    await flushUi()
  }
  const submit = async () => { q<HTMLButtonElement>('[data-action="manual-row-dialog-submit"]')!.click(); await flushUi() }
  const parentError = () => q('[data-testid="manual-row-dialog-parent-error"]')?.textContent?.trim()

  it('is hidden without parentFieldIds, and the create is exactly as before', async () => {
    const { onSubmit } = mountDialog({ parentFieldIds: null })
    await flushUi()
    expect(q('[data-testid="manual-row-dialog-parent"]')).toBeNull()
    await fillRow()
    await submit()
    expect(onSubmit).toHaveBeenCalledWith({ [F.name]: 'Synthetic row', [F.code]: 'SYN-OWN' })
  })

  it('defaults to 不挂父组件 with its hint (zh) and sends no parent key', async () => {
    useLocale().setLocale('zh-CN')
    const { onSubmit } = mountDialog()
    await flushUi()
    expect(q('[data-testid="manual-row-dialog-parent"] legend')?.textContent?.trim()).toBe('父组件')
    expect(q<HTMLInputElement>('[data-manual-parent-mode="none"]')!.checked).toBe(true)
    expect(q('[data-testid="manual-row-dialog-parent"]')?.textContent).toContain('这一行会出现在填写视图的空值组')
    await fillRow()
    await submit()
    expect(onSubmit).toHaveBeenCalledWith({ [F.name]: 'Synthetic row', [F.code]: 'SYN-OWN' })
  })

  it('选已有的: grouped list with child counts, own 图号 left out, debounced search, pick sent exactly as returned', async () => {
    useLocale().setLocale('zh-CN')
    const { onSubmit, search } = mountDialog()
    await fillRow()
    await choose('pick')
    expect(search).toHaveBeenCalledWith('')
    expect(q('[data-testid="manual-parent-group-parents"]')?.textContent?.trim()).toBe('已有父组件')
    expect(q('[data-testid="manual-parent-group-components"]')?.textContent?.trim()).toBe('本项目物料（选它就让它成为父组件）')
    expect(optionTexts()).toEqual(['SYN-P1 Synthetic parent | 12 个子件', 'SYN-P2 （无名称） | 1 个子件', 'SYN-C1 Synthetic part'])
    expect(q('[data-testid="manual-parent-truncated"]')).not.toBeNull()
    type(q<HTMLInputElement>('[data-testid="manual-parent-search"]'), ' 底座 ')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await flushUi()
    expect(search).toHaveBeenLastCalledWith('底座')
    // Sent as typed (trimmed only): the host folds the case of both sides itself; the client never lower-cases.
    type(q<HTMLInputElement>('[data-testid="manual-parent-search"]'), ' Syn-Φ20 ')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await flushUi()
    expect(search).toHaveBeenLastCalledWith('Syn-Φ20')
    // Nothing picked yet: refused before submit.
    await submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(parentError()).toBe('请选一个父组件，或者改选「不挂父组件」。')
    document.body.querySelectorAll<HTMLButtonElement>('[data-manual-parent-option]')[0].click()
    await flushUi()
    expect(q('[data-testid="manual-parent-picked"]')?.textContent).toContain('SYN-P1')
    await submit()
    expect(onSubmit).toHaveBeenCalledWith({
      [F.name]: 'Synthetic row', [F.code]: 'SYN-OWN', [F.pcode]: 'SYN-P1 ', [F.pname]: ' Synthetic parent',
    })
  })

  it('选已有的: a pick that becomes the own 图号 after typing is refused (self-parent)', async () => {
    useLocale().setLocale('zh-CN')
    const { onSubmit } = mountDialog()
    await fillRow('SYN-X')
    await choose('pick')
    document.body.querySelectorAll<HTMLButtonElement>('[data-manual-parent-option]')[3].click()
    await flushUi()
    type(fieldInput(F.code), ' SYN-C1')
    await submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(parentError()).toBe('父组件图号不能和这一行自己的图号相同。')
  })

  it('新建父组件: both required, trimmed; name without code and self-parent refused; the hint is shown', async () => {
    useLocale().setLocale('zh-CN')
    const { onSubmit } = mountDialog()
    await fillRow()
    await choose('new')
    expect(q('[data-testid="manual-row-dialog-parent"]')?.textContent).toContain('只给这一行写上父组件，不会自动为父组件本身建一行。')
    type(q<HTMLInputElement>('[data-testid="manual-parent-new-name"]'), 'Synthetic new parent')
    await submit()
    expect(parentError()).toBe('只填了父组件名称、没有父组件图号，不能保存；请补上父组件图号，或者把两项都清空。')
    type(q<HTMLInputElement>('[data-testid="manual-parent-new-code"]'), ' SYN-OWN ')
    await submit()
    expect(parentError()).toBe('父组件图号不能和这一行自己的图号相同。')
    type(q<HTMLInputElement>('[data-testid="manual-parent-new-name"]'), '')
    type(q<HTMLInputElement>('[data-testid="manual-parent-new-code"]'), 'SYN-NEW')
    await submit()
    expect(parentError()).toBe('请填写父组件名称')
    expect(onSubmit).not.toHaveBeenCalled()
    type(q<HTMLInputElement>('[data-testid="manual-parent-new-code"]'), '  SYN-NEW  ')
    type(q<HTMLInputElement>('[data-testid="manual-parent-new-name"]'), ' Synthetic new parent ')
    await submit()
    expect(parentError()).toBeUndefined()
    expect(onSubmit).toHaveBeenCalledWith({
      [F.name]: 'Synthetic row', [F.code]: 'SYN-OWN', [F.pcode]: 'SYN-NEW', [F.pname]: 'Synthetic new parent',
    })
  })

  it('still shows the server\'s refusal as is', async () => {
    mountDialog({ error: '父组件图号不能和这一行自己的图号相同。' })
    await flushUi()
    expect(q('[data-testid="manual-row-dialog-error"]')?.textContent?.trim()).toBe('父组件图号不能和这一行自己的图号相同。')
  })
})

describe('MP-E MetaManualRowParentDialog (修改父组件)', () => {
  function mountEdit(props: Record<string, unknown> = {}) {
    const onSubmit = vi.fn()
    const search = vi.fn().mockResolvedValue(CANDIDATES)
    mountComponent(MetaManualRowParentDialog, {
      visible: true, current: { code: 'SYN-P2', name: null }, ownCode: 'SYN-OWN', search, debounceMs: 0, onSubmit, ...props,
    })
    return { onSubmit, search }
  }
  const save = async () => { q<HTMLButtonElement>('[data-action="manual-parent-dialog-submit"]')!.click(); await flushUi() }

  it('shows the current parent; 改成已有的 (default) sends the pick exactly; the hint is the prototype\'s', async () => {
    useLocale().setLocale('zh-CN')
    const { onSubmit } = mountEdit()
    await flushUi()
    const current = q('[data-testid="manual-parent-dialog-current"]')!
    expect(Array.from(current.children).map((c) => c.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['当前', 'SYN-P2 · （无名称）'])
    expect(q('[data-testid="manual-parent-dialog"]')?.textContent).toContain('只改这一行。已经推送或导出过的不会自动更新；正式导出下次按新的父组件排。')
    expect(optionTexts()).toEqual(['SYN-P1 Synthetic parent | 12 个子件', 'SYN-P2 （无名称） | 1 个子件', 'SYN-C1 Synthetic part'])
    await save()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(q('[data-testid="manual-parent-dialog-error"]')?.textContent?.trim()).toBe('请选一个父组件。')
    document.body.querySelectorAll<HTMLButtonElement>('[data-manual-parent-option]')[0].click()
    await flushUi()
    await save()
    expect(onSubmit).toHaveBeenCalledWith({ code: 'SYN-P1 ', name: ' Synthetic parent' })
  })

  it('新建父组件 trims both; 移出父组件 sends both empty', async () => {
    const { onSubmit } = mountEdit()
    await choose('new')
    type(q<HTMLInputElement>('[data-testid="manual-parent-new-code"]'), ' SYN-NEW ')
    type(q<HTMLInputElement>('[data-testid="manual-parent-new-name"]'), ' Synthetic new ')
    await save()
    expect(onSubmit).toHaveBeenLastCalledWith({ code: 'SYN-NEW', name: 'Synthetic new' })
    await choose('remove')
    await save()
    expect(onSubmit).toHaveBeenLastCalledWith({ code: null, name: null })
  })

  it('移出父组件 is disabled when the row has no parent; the server message is shown', async () => {
    mountEdit({ current: { code: null, name: null }, error: '父组件图号和父组件名称要一起提交，不能只改其中一列。' })
    await flushUi()
    expect(q<HTMLInputElement>('[data-manual-parent-mode="remove"]')!.disabled).toBe(true)
    expect(q('[data-testid="manual-parent-dialog-error"]')?.textContent?.trim()).toBe('父组件图号和父组件名称要一起提交，不能只改其中一列。')
  })
})

describe('MP-I MetaRecordInspector 「修改父组件」', () => {
  const RECORD: MetaRecord = { id: 'rec_mp_manual', version: 2, data: { [F.name]: 'Synthetic row', [F.code]: 'SYN-OWN', [F.pcode]: 'SYN-P1', [F.pname]: 'Synthetic parent' } }
  function mountInspector(props: Record<string, unknown>) {
    mountComponent(MetaRecordInspector, {
      visible: true, record: RECORD, fields: FIELDS, canEdit: true, canComment: false, canDelete: false, canCreate: false,
      rowActions: { canEdit: true, canDelete: true, canComment: false, manualSupplement: true },
      fieldPermissions: Object.fromEntries(FIELDS.map((f) => [f.id, { visible: true, readOnly: true }])),
      ...props,
    })
  }

  it('shows the pair with the link beside 父组件图号 and emits edit-manual-parent', async () => {
    useLocale().setLocale('zh-CN')
    const onEditManualParent = vi.fn()
    mountInspector({ manualParent: { code: 'SYN-P1', name: 'Synthetic parent' }, onEditManualParent })
    await flushUi()
    const block = q('[data-testid="record-inspector-manual-parent"]')
    expect(block?.querySelector('dt')?.textContent?.trim()).toBe('父组件图号')
    expect(q('[data-testid="record-inspector-manual-parent-code"]')?.textContent?.trim()).toBe('SYN-P1')
    expect(q('[data-testid="record-inspector-manual-parent-name"]')?.textContent?.trim()).toBe('Synthetic parent')
    const link = q<HTMLButtonElement>('[data-testid="record-inspector-manual-parent-edit"]')!
    expect(link.textContent?.trim()).toBe('修改父组件')
    link.click()
    expect(onEditManualParent).toHaveBeenCalledTimes(1)
  })

  it('is absent without manualParent (a PLM row, a sheet without the pair)', async () => {
    mountInspector({})
    await flushUi()
    expect(q('[data-testid="record-inspector-manual-parent"]')).toBeNull()
  })
})

describe('MP-C the §12.7 ① confirm', () => {
  it('sums the counts, asks once only when > 0, and treats a failed count as none', async () => {
    const confirm = vi.fn().mockReturnValue(false)
    const count = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('x')
      return { count: id === 'a' ? 2 : id === 'b' ? 1 : 0 }
    })
    expect(await confirmManualRowParentDependents({ recordIds: ['a', 'b', 'bad', 'c'], count, confirm, isZh: true })).toBe(false)
    expect(confirm).toHaveBeenCalledWith('有 3 行人工补充行以它为父组件，修改/删除后它们不会跟着变。要继续吗？')
    confirm.mockClear()
    expect(await confirmManualRowParentDependents({ recordIds: ['c', 'bad'], count, confirm, isZh: true })).toBe(true)
    expect(await confirmManualRowParentDependents({ recordIds: [], count, confirm, isZh: true })).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
})
