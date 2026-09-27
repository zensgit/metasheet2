// 客户反馈 2026-09-24 #4b（自动化条件按字段类型编辑），裁定见 PR #6074 — the rule editor end to end: the blank
// row no longer seeds `equals` (rule-level AND condition_branch rows), both kinds of row use the same typed
// value control, the field dropdown names each field's type, date operators read 晚于 / 早于, and the
// condition_branch values are saved in their typed shape (legacy string values included).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRule } from '../src/multitable/types'
import { epOptions, epSelectValue, epSetSelect } from './helpers/epControls'

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => nextTick())
}

const fields = [
  { id: 'fld_name', name: 'Name', type: 'string' },
  { id: 'fld_score', name: 'Score', type: 'number' },
  { id: 'fld_done', name: 'Done', type: 'boolean' },
  { id: 'fld_due', name: 'Due', type: 'date' },
  { id: 'fld_start', name: 'Start', type: 'dateTime' },
  { id: 'fld_owner', name: 'Owner', type: 'person' },
  { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'todo' }, { value: 'done' }] },
]

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, props) })
  app.mount(container)
  return { container, app }
}

function setInput(container: HTMLElement, selector: string, value: string) {
  const el = container.querySelector(selector) as HTMLInputElement
  el.value = value
  el.dispatchEvent(new Event('input'))
}

function selectAction0(container: HTMLElement, type: string) {
  const select = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header .el-select') as HTMLElement
  epSetSelect(select, type)
}

function rowSelects(row: HTMLElement) {
  return {
    field: row.querySelector('[data-condition-field]') as HTMLElement,
    operator: row.querySelector('[data-condition-operator]') as HTMLElement,
  }
}

/** The text an el-select shows in its closed box: the selected label, else its placeholder. */
function selectDisplayText(select: HTMLElement): string {
  return (select.querySelector('.el-select__selected-item:not(.el-select__input-wrapper)')?.textContent ?? '').trim()
}

function ruleWithBranch(config: Record<string, unknown>): AutomationRule {
  return {
    id: 'rule_cb', sheetId: 'sheet_1', name: 'Branch rule', triggerType: 'record.created', triggerConfig: {},
    actionType: 'condition_branch', actionConfig: config, enabled: true, executionMode: 'workflow_job_v1',
    actions: [{ type: 'condition_branch', config }],
  } as AutomationRule
}

async function addBranchCondition(container: HTMLElement) {
  selectAction0(container, 'condition_branch')
  await flush()
  ;(container.querySelector('[data-branch-index="0"] [data-action="add-branch-condition"]') as HTMLButtonElement).click()
  await flush()
  return container.querySelector('[data-branch-index="0"] [data-branch-condition-index="0"]') as HTMLElement
}

// Explicit per-test timeout (same reasoning as ROUND_TRIP_TIMEOUT_MS in multitable-automation-rule-editor.spec.ts):
// every case mounts the FULL rule editor and most drive a save — sub-second on an idle box, but the CI web
// lane shares the runner across hundreds of spec files and the first mount of a file can overrun vitest's 5s
// default. The global testTimeout stays 5s so a hung editor still fails fast elsewhere.
const EDITOR_MOUNT_TIMEOUT_MS = 30_000

beforeEach(() => useLocale().setLocale('zh-CN'))
afterEach(() => {
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('blank condition row: no operator until a field is chosen', () => {
  it('rule-level row: operator + value disabled with 请先选择字段, save blocked, and no raw `equals` anywhere', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()
    setInput(container, '[data-field="name"]', 'Rule')
    ;(container.querySelector('[data-action="add-condition"]') as HTMLButtonElement).click()
    await flush()

    const row = container.querySelector('[data-condition-index="0"]') as HTMLElement
    const { operator } = rowSelects(row)
    expect(operator.querySelector('.el-select__wrapper')?.classList.contains('is-disabled')).toBe(true)
    expect(epSelectValue(operator)).toBe('')
    expect(selectDisplayText(operator)).toBe('请先选择字段')
    const value = row.querySelector('[data-condition-value="pending"]') as HTMLInputElement
    expect(value.disabled).toBe(true)
    expect(value.placeholder).toBe('请先选择字段')

    const save = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(container.querySelector('[data-field="saveBlockReasons"]')?.textContent).toContain('请完善所有筛选条件')

    expect(row.textContent).not.toContain('equals')
    expect(document.body.textContent).not.toMatch(/\bequals\b/)
  }, EDITOR_MOUNT_TIMEOUT_MS)

  it('condition_branch row: the same disabled pending state, its own save-block reason, no raw `equals`', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()
    setInput(container, '[data-field="name"]', 'Branch rule')
    const row = await addBranchCondition(container)

    const { operator } = rowSelects(row)
    expect(operator.querySelector('.el-select__wrapper')?.classList.contains('is-disabled')).toBe(true)
    expect(selectDisplayText(operator)).toBe('请先选择字段')
    const value = row.querySelector('[data-condition-value="pending"]') as HTMLInputElement
    expect(value.disabled).toBe(true)
    expect(value.placeholder).toBe('请先选择字段')

    // A blank branch row used to reach the backend (400: fieldId is required); now it blocks save here.
    const save = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(container.querySelector('[data-field="saveBlockReasons"]')?.textContent).toContain('请完善条件分支中的所有条件')

    expect(row.textContent).not.toContain('equals')
    expect(document.body.textContent).not.toMatch(/\bequals\b/)
  }, EDITOR_MOUNT_TIMEOUT_MS)

  it('choosing a field enables the operator (the type\'s first) and the typed value; clearing it goes back to pending', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()
    ;(container.querySelector('[data-action="add-condition"]') as HTMLButtonElement).click()
    await flush()
    const row = container.querySelector('[data-condition-index="0"]') as HTMLElement
    const { field, operator } = rowSelects(row)

    epSetSelect(field, 'fld_score')
    await flush()
    expect(operator.querySelector('.el-select__wrapper')?.classList.contains('is-disabled')).toBe(false)
    expect(epSelectValue(operator)).toBe('equals')
    expect(selectDisplayText(operator)).toBe('等于')
    expect(row.querySelector('[data-condition-value="number"]')).toBeTruthy()

    epSetSelect(field, '')
    await flush()
    expect(operator.querySelector('.el-select__wrapper')?.classList.contains('is-disabled')).toBe(true)
    expect(row.querySelector('[data-condition-value="pending"]')).toBeTruthy()
  }, EDITOR_MOUNT_TIMEOUT_MS)
})

describe('field dropdown and operator labels', () => {
  it('each field option names the field type next to the field name (rule-level and branch rows)', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()
    ;(container.querySelector('[data-action="add-condition"]') as HTMLButtonElement).click()
    await flush()
    const mainRow = container.querySelector('[data-condition-index="0"]') as HTMLElement
    const branchRow = await addBranchCondition(container)
    for (const row of [mainRow, branchRow]) {
      const hints = epOptions(rowSelects(row).field)
        .filter((option) => option.value)
        .map((option) => [
          option.el.querySelector('.meta-rule-editor__field-option-name')?.textContent?.trim(),
          option.el.querySelector('[data-field-type-hint]')?.textContent?.trim(),
        ])
      expect(hints).toEqual([
        ['Name', '文本'],
        ['Score', '数字'],
        ['Done', '复选框'],
        ['Due', '日期'],
        ['Start', '日期时间'],
        ['Owner', '人员'],
        ['Status', '单选'],
      ])
    }
  }, EDITOR_MOUNT_TIMEOUT_MS)

  it('date / date-time rows label greater/less as 晚于 / 早于 (codes unchanged); a number row keeps 大于 / 小于', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()
    ;(container.querySelector('[data-action="add-condition"]') as HTMLButtonElement).click()
    await flush()
    const row = container.querySelector('[data-condition-index="0"]') as HTMLElement
    const { field, operator } = rowSelects(row)
    const labelOf = (code: string) => epOptions(operator).find((option) => option.value === code)?.textContent?.trim()

    epSetSelect(field, 'fld_due')
    await flush()
    expect(labelOf('greater_than')).toBe('晚于')
    expect(labelOf('less_than')).toBe('早于')
    expect(labelOf('greater_or_equal')).toBe('不早于')
    expect(labelOf('less_or_equal')).toBe('不晚于')

    epSetSelect(field, 'fld_start')
    await flush()
    expect(labelOf('greater_than')).toBe('晚于')
    expect(labelOf('less_than')).toBe('早于')

    epSetSelect(field, 'fld_score')
    await flush()
    expect(labelOf('greater_than')).toBe('大于')
    expect(labelOf('less_than')).toBe('小于')
  }, EDITOR_MOUNT_TIMEOUT_MS)
})

describe('condition_branch rows are typed and saved in the typed shape', () => {
  it('a branch row on a number field saves a number, on a checkbox field a boolean (是 / 否)', async () => {
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onSave: saved })
    await flush()
    setInput(container, '[data-field="name"]', 'Typed branch')
    const row0 = await addBranchCondition(container)
    epSetSelect(rowSelects(row0).field, 'fld_score')
    await flush()
    epSetSelect(rowSelects(row0).operator, 'greater_than')
    await flush()
    const numberInput = row0.querySelector('[data-condition-value="number"]') as HTMLInputElement
    numberInput.value = '100'
    numberInput.dispatchEvent(new Event('input'))
    await flush()

    ;(container.querySelector('[data-branch-index="0"] [data-action="add-branch-condition"]') as HTMLButtonElement).click()
    await flush()
    const row1 = container.querySelector('[data-branch-index="0"] [data-branch-condition-index="1"]') as HTMLElement
    epSetSelect(rowSelects(row1).field, 'fld_done')
    await flush()
    const boolSelect = row1.querySelector('[data-condition-value="boolean"]') as HTMLElement
    expect(epOptions(boolSelect).map((option) => option.textContent?.trim())).toEqual(['-- 值 --', '是', '否'])
    epSetSelect(boolSelect, 'true')
    await flush()

    const save = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    save.click()
    await flush()
    const branch = saved.mock.calls[0][0].actions[0].config.branches[0]
    expect(branch.conditions.conditions).toEqual([
      { fieldId: 'fld_score', operator: 'greater_than', value: 100 },
      { fieldId: 'fld_done', operator: 'equals', value: true },
    ])
  }, EDITOR_MOUNT_TIMEOUT_MS)

  it('an unparseable branch value blocks save with the branch reason, anchored at the row', async () => {
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields })
    await flush()
    setInput(container, '[data-field="name"]', 'Bad branch value')
    const row = await addBranchCondition(container)
    epSetSelect(rowSelects(row).field, 'fld_start')
    await flush()
    const input = row.querySelector('[data-condition-value="date-time"]') as HTMLInputElement
    input.value = 'next tuesday'
    input.dispatchEvent(new Event('input'))
    await flush()
    expect((container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('[data-field="saveBlockReasons"]')?.textContent).toContain('请完善条件分支中的所有条件')

    input.value = '2026-09-24 09:30'
    input.dispatchEvent(new Event('input'))
    await flush()
    expect((container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(false)
  }, EDITOR_MOUNT_TIMEOUT_MS)

  it('round-trip: a loaded typed branch saves byte-identically; legacy string values save typed', async () => {
    const typed = {
      branches: [{
        key: 'typed',
        conditions: {
          conjunction: 'AND',
          conditions: [
            { fieldId: 'fld_score', operator: 'greater_than', value: 100 },
            { fieldId: 'fld_done', operator: 'equals', value: false },
            { fieldId: 'fld_due', operator: 'less_than', value: '2026-12-31' },
            { fieldId: 'fld_start', operator: 'greater_or_equal', value: '2026-09-24T01:30:00Z' },
            { fieldId: 'fld_owner', operator: 'in', value: ['user_1', 'user_2'] },
            { fieldId: 'fld_status', operator: 'equals', value: 'done' },
          ],
        },
        actions: [{ type: 'update_record', config: { fields: { fld_name: 'vip' } } }],
      }],
    }
    const savedTyped = vi.fn()
    const typedMount = mount({ visible: true, sheetId: 'sheet_1', fields, rule: ruleWithBranch(typed), onSave: savedTyped })
    await flush()
    expect(typedMount.container.querySelector('[data-field="condition-branch-readonly"]')).toBeNull()
    // The typed controls show the stored values (是/否, the business wall clock, the person chips).
    const rows = typedMount.container.querySelectorAll('[data-branch-index="0"] [data-branch-condition-index]')
    expect(epSelectValue(rows[1].querySelector('[data-condition-value="boolean"]') as HTMLElement)).toBe('false')
    expect((rows[3].querySelector('[data-condition-value="date-time"]') as HTMLInputElement).value).toBe('2026-09-24 09:30')
    expect(Array.from(rows[4].querySelectorAll('[data-condition-value-id]')).map((chip) => chip.getAttribute('data-condition-value-id'))).toEqual(['user_1', 'user_2'])
    ;(typedMount.container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flush()
    expect(savedTyped.mock.calls[0][0].actions[0].config).toEqual(typed)
    expect(JSON.stringify(savedTyped.mock.calls[0][0].actions[0].config)).toBe(JSON.stringify(typed))
    typedMount.app.unmount()
    document.body.innerHTML = ''

    const legacy = {
      branches: [{
        key: 'legacy',
        conditions: {
          conjunction: 'AND',
          conditions: [
            { fieldId: 'fld_score', operator: 'equals', value: '5' },
            { fieldId: 'fld_done', operator: 'equals', value: 'true' },
            { fieldId: 'fld_owner', operator: 'equals', value: 'user_1' },
          ],
        },
        actions: [{ type: 'update_record', config: { fields: { fld_name: 'vip' } } }],
      }],
    }
    const savedLegacy = vi.fn()
    const legacyMount = mount({ visible: true, sheetId: 'sheet_1', fields, rule: ruleWithBranch(legacy), onSave: savedLegacy })
    await flush()
    ;(legacyMount.container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flush()
    expect(savedLegacy.mock.calls[0][0].actions[0].config.branches[0].conditions.conditions).toEqual([
      { fieldId: 'fld_score', operator: 'equals', value: 5 },
      { fieldId: 'fld_done', operator: 'equals', value: true },
      { fieldId: 'fld_owner', operator: 'equals', value: 'user_1' }, // one id is already the saved shape
    ])
    // ...and the loaded rule object itself was never mutated by the editor.
    expect(legacy.branches[0].conditions.conditions[0].value).toBe('5')
  }, EDITOR_MOUNT_TIMEOUT_MS)

  it('a rule-level date-time row saves the business-timezone instant (not the browser-local datetime-local string)', async () => {
    const saved = vi.fn()
    const { container } = mount({ visible: true, sheetId: 'sheet_1', fields, onSave: saved })
    await flush()
    setInput(container, '[data-field="name"]', 'Start after')
    ;(container.querySelector('[data-action="add-condition"]') as HTMLButtonElement).click()
    await flush()
    const row = container.querySelector('[data-condition-index="0"]') as HTMLElement
    epSetSelect(rowSelects(row).field, 'fld_start')
    await flush()
    epSetSelect(rowSelects(row).operator, 'greater_than')
    await flush()
    const input = row.querySelector('[data-condition-value="date-time"]') as HTMLInputElement
    expect(input.type).toBe('text')
    input.value = '2026-09-24 09:30'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flush()
    expect(saved.mock.calls[0][0].conditions).toEqual({
      conjunction: 'AND',
      conditions: [{ fieldId: 'fld_start', operator: 'greater_than', value: '2026-09-24T01:30:00.000Z' }],
    })
  }, EDITOR_MOUNT_TIMEOUT_MS)
})
