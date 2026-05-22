import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLocale } from '../src/composables/useLocale'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import {
  FORMULA_FUNCTION_DOCS,
  buildFormulaFieldTokenInsertion,
  buildFormulaFunctionInsertion,
  extractFormulaFieldRefs,
  getFormulaFunctionCategories,
  getFormulaFunctionCatalog,
  searchFormulaFunctionDocs,
  validateFormulaExpression,
} from '../src/multitable/utils/formula-docs'

describe('multitable formula editor', () => {
  afterEach(() => {
    useLocale().setLocale('en')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('searches function docs and validates stable field-id references', () => {
    expect(searchFormulaFunctionDocs('sum').map((doc) => doc.name)).toContain('SUM')
    expect(extractFormulaFieldRefs('=SUM({fld_price}, {fld_tax})')).toEqual(['fld_price', 'fld_tax'])

    const diagnostics = validateFormulaExpression('=SUM({Price})', [
      { id: 'fld_price', name: 'Price', type: 'number' },
    ])
    expect(diagnostics).toContainEqual({
      severity: 'warning',
      message: 'Field reference {Price} uses a name. Use the field chip to insert a stable {fld_xxx} token.',
    })

    expect(validateFormulaExpression('=SUM({fld_missing})', [
      { id: 'fld_price', name: 'Price', type: 'number' },
    ])).toContainEqual({ severity: 'error', message: 'Unknown field reference {fld_missing}.' })
  })

  it('reports common formula syntax issues before save', () => {
    const fields = [{ id: 'fld_price', name: 'Price', type: 'number' }]

    expect(validateFormulaExpression('=CONCAT("unterminated)', fields)).toContainEqual({
      severity: 'error',
      message: 'Quoted string is not closed.',
    })
    expect(validateFormulaExpression('=SUM([1, 2)', fields)).toContainEqual({
      severity: 'error',
      message: 'Array brackets are not balanced.',
    })
    expect(validateFormulaExpression('=SUM({fld_price)', fields)).toContainEqual({
      severity: 'error',
      message: 'Field reference braces are not balanced.',
    })
    expect(validateFormulaExpression('=SUM({fld_price}) +', fields)).toContainEqual({
      severity: 'error',
      message: 'Formula cannot end with a binary operator.',
    })
    expect(validateFormulaExpression('="("', fields)).not.toContainEqual({
      severity: 'error',
      message: 'Parentheses are not balanced.',
    })
  })

  it('reports incomplete formula function arguments before save', () => {
    const fields = [
      { id: 'fld_price', name: 'Price', type: 'number' },
      { id: 'fld_start', name: 'Start', type: 'date' },
      { id: 'fld_end', name: 'End', type: 'date' },
    ]

    expect(validateFormulaExpression('=IF({fld_price} > 0, "ok")', fields)).toContainEqual({
      severity: 'error',
      message: 'IF expects at least 3 arguments.',
    })
    expect(validateFormulaExpression('=ROUND({fld_price}, 2, 3)', fields)).toContainEqual({
      severity: 'error',
      message: 'ROUND expects at most 2 arguments.',
    })
    expect(validateFormulaExpression('=ROUND(, 2)', fields)).toContainEqual({
      severity: 'error',
      message: 'ROUND has an empty argument.',
    })
    expect(validateFormulaExpression('=DATEDIF({fld_start}, {fld_end})', fields)).toContainEqual({
      severity: 'error',
      message: 'DATEDIF expects at least 3 arguments.',
    })
    expect(validateFormulaExpression('=TODAY(1)', fields)).toContainEqual({
      severity: 'error',
      message: 'TODAY expects at most 0 arguments.',
    })

    expect(validateFormulaExpression('=ROUND({fld_price}, 2)', fields).filter((diagnostic) =>
      diagnostic.severity === 'error'
    )).toEqual([])
  })

  it('builds categorized function catalog sections and insertion text', () => {
    const mathSections = getFormulaFunctionCatalog('round', 'math')
    expect(mathSections).toHaveLength(1)
    expect(mathSections[0]).toMatchObject({
      category: 'math',
      label: 'Math',
    })
    expect(mathSections[0].functions).toContainEqual(expect.objectContaining({ name: 'ROUND', insertText: 'ROUND(, 2)' }))

    const ifDoc = getFormulaFunctionCatalog('if', 'logic')[0].functions.find((doc) => doc.name === 'IF')
    expect(ifDoc).toBeTruthy()
    expect(buildFormulaFunctionInsertion('', ifDoc!)).toBe('=IF(, , )')
    expect(buildFormulaFunctionInsertion('=SUM({fld_price})', 'today')).toBe('=SUM({fld_price}) TODAY()')
    expect(buildFormulaFieldTokenInsertion('=SUM()', 'fld_tax')).toBe('=SUM() {fld_tax}')
  })

  it('localizes formula catalogs and diagnostics when requested', () => {
    expect(getFormulaFunctionCategories(true).find((category) => category.id === 'math')).toMatchObject({
      label: '数学',
      description: '对数字进行舍入、转换和比较。',
    })

    expect(searchFormulaFunctionDocs('SUM', true)[0]).toMatchObject({
      name: 'SUM',
      signature: 'SUM(number, ...)',
      description: '将数字值相加。',
      example: '=SUM({fld_price}, {fld_tax})',
      insertText: 'SUM()',
    })
    expect(searchFormulaFunctionDocs('Adds', true).map((doc) => doc.name)).toContain('SUM')
    expect(searchFormulaFunctionDocs('相加', true).map((doc) => doc.name)).toEqual(expect.arrayContaining(['SUM', 'ADD']))

    const fields = [{ id: 'fld_price', name: 'Price', type: 'number' }]
    expect(validateFormulaExpression('', fields, true)).toContainEqual({
      severity: 'warning',
      message: '公式表达式为空。',
    })
    expect(validateFormulaExpression('=ROUND(, 2)', fields, true)).toContainEqual({
      severity: 'error',
      message: 'ROUND 存在空参数。',
    })
    expect(validateFormulaExpression('=SUM({Price})', fields, true)).toContainEqual({
      severity: 'warning',
      message: '字段引用 {Price} 使用了名称。请使用字段标签插入稳定的 {fld_xxx} 令牌。',
    })
    expect(validateFormulaExpression('=FOO({fld_price})', fields, true)).toContainEqual({
      severity: 'warning',
      message: 'FOO 尚未在此编辑器中记录。',
    })
  })

  it('documents every backend registered formula function', () => {
    const backendFunctions = [
      'ABS',
      'AND',
      'AVERAGE',
      'CEILING',
      'CONCAT',
      'CONCATENATE',
      'COUNT',
      'COUNTA',
      'DATE',
      'DATEDIF',
      'DATEDIFF',
      'DAY',
      'FALSE',
      'FLOOR',
      'HLOOKUP',
      'IF',
      'INDEX',
      'LEFT',
      'LEN',
      'LOWER',
      'MATCH',
      'MAX',
      'MEDIAN',
      'MID',
      'MIN',
      'MOD',
      'MODE',
      'MONTH',
      'NOT',
      'NOW',
      'OR',
      'POWER',
      'RIGHT',
      'ROUND',
      'SQRT',
      'STDEV',
      'SUBSTITUTE',
      'SUM',
      'SWITCH',
      'TODAY',
      'TRIM',
      'TRUE',
      'UPPER',
      'VAR',
      'VLOOKUP',
      'YEAR',
    ]
    const documentedFunctions = new Set(FORMULA_FUNCTION_DOCS.map((doc) => doc.name))

    expect(backendFunctions.filter((name) => !documentedFunctions.has(name))).toEqual([])
  })

  it('documents recently supported formula operators', () => {
    const operatorSections = getFormulaFunctionCatalog('', 'operator')
    expect(operatorSections).toHaveLength(1)
    expect(operatorSections[0].functions.map((doc) => doc.signature)).toEqual(expect.arrayContaining([
      'left + right',
      'left ^ right',
      'value%',
      'left & right',
      '=, <>, >, >=, <, <=',
    ]))

    expect(searchFormulaFunctionDocs('%').map((doc) => doc.name)).toContain('PERCENT_OPERATOR')

    const percentDoc = operatorSections[0].functions.find((doc) => doc.name === 'PERCENT_OPERATOR')
    expect(percentDoc).toBeTruthy()
    expect(buildFormulaFunctionInsertion('={fld_price} *', percentDoc!)).toBe('={fld_price} * 10%')
  })

  it('inserts backend-compatible field id tokens from field chips', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_price', name: 'Price', type: 'number' },
            { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '' } },
          ],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const configureButtons = Array.from(container.querySelectorAll('.meta-field-mgr__action[title="Configure"]')) as HTMLButtonElement[]
    configureButtons[1]?.click()
    await nextTick()

    const priceChip = Array.from(container.querySelectorAll('.meta-field-mgr__chip'))
      .find((button) => button.textContent === 'Price') as HTMLButtonElement | undefined
    priceChip?.click()
    await nextTick()

    const textarea = container.querySelector('.meta-field-mgr__textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('{fld_price}')

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('fld_total', {
      property: { expression: '{fld_price}' },
    })

    app.unmount()
  })

  it('filters the formula function catalog by category and inserts snippets', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_price', name: 'Price', type: 'number' },
            { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '' } },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    const configureButtons = Array.from(container.querySelectorAll('.meta-field-mgr__action[title="Configure"]')) as HTMLButtonElement[]
    configureButtons[1]?.click()
    await nextTick()

    const categorySelect = container.querySelector('.meta-field-mgr__formula-toolbar .meta-field-mgr__select') as HTMLSelectElement
    categorySelect.value = 'math'
    categorySelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(container.textContent).toContain('Math')
    expect(container.textContent).toContain('ROUND(number, digits)')
    expect(container.textContent).not.toContain('TODAY()')

    const roundButton = Array.from(container.querySelectorAll('.meta-field-mgr__formula-doc'))
      .find((button) => button.textContent?.includes('ROUND(number, digits)')) as HTMLButtonElement | undefined
    roundButton?.click()
    await nextTick()

    const textarea = container.querySelector('.meta-field-mgr__textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('=ROUND(, 2)')

    app.unmount()
  })

  it('renders the operator reference category in the formula panel', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_price', name: 'Price', type: 'number' },
            { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '={fld_price}' } },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    const configureButtons = Array.from(container.querySelectorAll('.meta-field-mgr__action[title="Configure"]')) as HTMLButtonElement[]
    configureButtons[1]?.click()
    await nextTick()

    const categorySelect = container.querySelector('.meta-field-mgr__formula-toolbar .meta-field-mgr__select') as HTMLSelectElement
    categorySelect.value = 'operator'
    categorySelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(container.textContent).toContain('Operators')
    expect(container.textContent).toContain('value%')
    expect(container.textContent).toContain('left ^ right')

    app.unmount()
  })

  it('renders localized formula reference chrome while preserving raw formula syntax', async () => {
    useLocale().setLocale('zh-CN')

    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_price', name: 'Price', type: 'number' },
            { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '=SUM({fld_missing})' } },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    const configureButtons = Array.from(container.querySelectorAll('.meta-field-mgr__action[title="配置"]')) as HTMLButtonElement[]
    configureButtons[1]?.click()
    await nextTick()

    const categorySelect = container.querySelector('.meta-field-mgr__formula-toolbar .meta-field-mgr__select') as HTMLSelectElement
    expect(categorySelect.querySelector('option[value="math"]')?.textContent).toBe('数学')
    categorySelect.value = 'math'
    categorySelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(container.textContent).toContain('数学')
    expect(container.textContent).toContain('将数字舍入到指定小数位。')
    expect(container.textContent).toContain('ROUND(number, digits)')
    expect(container.textContent).toContain('=ROUND({fld_amount}, 2)')
    expect(container.textContent).toContain('未知字段引用 {fld_missing}。')
    expect(container.textContent).not.toContain('Unknown field reference {fld_missing}.')
    expect(container.querySelector('.meta-field-mgr__formula-diagnostic--error')).toBeTruthy()
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0)
    expect(container.querySelectorAll('[title]')).toHaveLength(13)
    expect(container.querySelectorAll('[placeholder]')).toHaveLength(3)

    app.unmount()
  })

  it('blocks saving formula expressions with unknown field references', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_price', name: 'Price', type: 'number' },
            { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '=SUM({fld_missing})' } },
          ],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const configureButtons = Array.from(container.querySelectorAll('.meta-field-mgr__action[title="Configure"]')) as HTMLButtonElement[]
    configureButtons[1]?.click()
    await nextTick()

    expect(container.textContent).toContain('Unknown field reference {fld_missing}.')

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).not.toHaveBeenCalled()

    app.unmount()
  })
})
