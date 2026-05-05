import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import {
  FORMULA_FUNCTION_DOCS,
  buildFormulaFieldTokenInsertion,
  buildFormulaFunctionInsertion,
  extractFormulaFieldRefs,
  getFormulaFunctionCatalog,
  searchFormulaFunctionDocs,
  validateFormulaExpression,
} from '../src/multitable/utils/formula-docs'

describe('multitable formula editor', () => {
  afterEach(() => {
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
