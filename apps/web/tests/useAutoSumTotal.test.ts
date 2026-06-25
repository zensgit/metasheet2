import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, reactive, ref, nextTick } from 'vue'
import type { ApprovalTemplateDetailDTO } from '../src/types/approval'
import { useAutoSumTotal } from '../src/approvals/useAutoSumTotal'

function makeTemplate(withMapping: boolean, precision?: number): ApprovalTemplateDetailDTO {
  return {
    formSchema: {
      fields: [
        { id: 'amount', type: 'number', label: '总额' },
        {
          id: 'items', type: 'detail', label: '明细', columns: [
            { id: 'name', type: 'text', label: '名称' },
            { id: 'amount', type: 'number', label: '金额', ...(precision !== undefined ? { props: { precision } } : {}) },
          ],
        },
      ],
      ...(withMapping ? { amountConsistencyCheck: { totalFieldId: 'amount', detailFieldId: 'items', amountColumnId: 'amount' } } : {}),
    },
  } as unknown as ApprovalTemplateDetailDTO

}

function harness(template: ReturnType<typeof ref<ApprovalTemplateDetailDTO | null>>, formData: Record<string, unknown>) {
  let api!: ReturnType<typeof useAutoSumTotal>
  const Comp = defineComponent({ setup() { api = useAutoSumTotal(template, formData); return () => h('div') } })
  const app = createApp(Comp)
  app.mount(document.createElement('div'))
  return { api, app }
}

describe('useAutoSumTotal (Gate B — auto-fill wiring)', () => {
  it('immediate: seeds the total from the detail rows on load', async () => {
    const formData = reactive<Record<string, unknown>>({ items: [{ amount: 100 }, { amount: 200 }] })
    const { app } = harness(ref(makeTemplate(true)), formData)
    await nextTick()
    expect(formData.amount).toBe(300)
    app.unmount()
  })

  it('reactive: updates the total when a row is added and when a cell changes', async () => {
    const formData = reactive<Record<string, unknown>>({ items: [{ amount: 100 }] })
    const { app } = harness(ref(makeTemplate(true)), formData)
    await nextTick()
    expect(formData.amount).toBe(100)
    ;(formData.items as Array<Record<string, unknown>>).push({ amount: 50 })
    await nextTick()
    expect(formData.amount).toBe(150)
    ;(formData.items as Array<Record<string, unknown>>)[0].amount = 999
    await nextTick()
    expect(formData.amount).toBe(1049)
    app.unmount()
  })

  it('money-safe: 0.005 + 0.005 auto-fills 0.02 (clears the backstop, not the float 0.01)', async () => {
    const formData = reactive<Record<string, unknown>>({ items: [{ amount: 0.005 }, { amount: 0.005 }] })
    const { app } = harness(ref(makeTemplate(true)), formData)
    await nextTick()
    expect(formData.amount).toBe(0.02)
    app.unmount()
  })

  it('incomplete rows: a not-yet-filled amount cell counts as 0 in the live total', async () => {
    const formData = reactive<Record<string, unknown>>({ items: [{ amount: 100 }, { name: 'x' }, { amount: 50 }] })
    const { app } = harness(ref(makeTemplate(true)), formData)
    await nextTick()
    expect(formData.amount).toBe(150)
    app.unmount()
  })

  it('isAutoSummedTotal: true for the total field, false otherwise', () => {
    const { api, app } = harness(ref(makeTemplate(true)), reactive({}))
    expect(api.isAutoSummedTotal('amount')).toBe(true)
    expect(api.isAutoSummedTotal('items')).toBe(false)
    app.unmount()
  })

  it('no mapping → no auto-fill, total untouched, isAutoSummedTotal false', async () => {
    const formData = reactive<Record<string, unknown>>({ items: [{ amount: 100 }], amount: 7 })
    const { api, app } = harness(ref(makeTemplate(false)), formData)
    await nextTick()
    expect(formData.amount).toBe(7)
    expect(api.isAutoSummedTotal('amount')).toBe(false)
    app.unmount()
  })
})

function makeDerivedTemplate(withHiddenOperand = false): ApprovalTemplateDetailDTO {
  return {
    formSchema: {
      fields: [
        { id: 'amount', type: 'number', label: '总额' },
        {
          id: 'items', type: 'detail', label: '明细', columns: [
            ...(withHiddenOperand ? [{ id: 'use_quantity', type: 'select' as const, label: '使用数量' }] : []),
            { id: 'quantity', type: 'number', label: '数量' },
            { id: 'unit_price', type: 'number', label: '单价' },
            { id: 'amount', type: 'number', label: '小计', props: { derivedFrom: { operandColumnIds: ['quantity', 'unit_price'], operation: 'product' } } },
          ],
        },
      ],
      amountConsistencyCheck: { totalFieldId: 'amount', detailFieldId: 'items', amountColumnId: 'amount' },
    },
  } as unknown as ApprovalTemplateDetailDTO
}

describe('useAutoSumTotal — derive-then-sum one pass (line-subtotal #3203)', () => {
  it('derives each row amount from its operands AND sums the total, in one flush', async () => {
    const formData = reactive<Record<string, unknown>>({ items: [{ quantity: 3, unit_price: 100 }, { quantity: 2, unit_price: 50 }] })
    const { app } = harness(ref(makeDerivedTemplate()), formData)
    await nextTick()
    expect((formData.items as Array<Record<string, unknown>>)[0].amount).toBe(300)
    expect((formData.items as Array<Record<string, unknown>>)[1].amount).toBe(100)
    expect(formData.amount).toBe(400)
    // edit an operand → that row re-derives + the total updates (same chain)
    ;(formData.items as Array<Record<string, unknown>>)[0].unit_price = 200
    await nextTick()
    expect((formData.items as Array<Record<string, unknown>>)[0].amount).toBe(600)
    expect(formData.amount).toBe(700)
    app.unmount()
  })

  it('a row with a partial operand is left manual (not derived); the total uses its manual amount', async () => {
    const formData = reactive<Record<string, unknown>>({ items: [{ quantity: 3, unit_price: 100 }, { quantity: 2, amount: 999 }] })
    const { app } = harness(ref(makeDerivedTemplate()), formData)
    await nextTick()
    expect((formData.items as Array<Record<string, unknown>>)[0].amount).toBe(300) // derived
    expect((formData.items as Array<Record<string, unknown>>)[1].amount).toBe(999) // partial (no unit_price) → manual
    expect(formData.amount).toBe(1299)
    app.unmount()
  })

  it('a row with a hidden operand is left manual; the total uses its manual amount', async () => {
    const template = makeDerivedTemplate(true)
    const detail = template.formSchema.fields.find((field) => field.id === 'items')
    const quantity = detail?.columns?.find((column) => column.id === 'quantity')
    if (quantity) {
      quantity.visibilityRule = { fieldId: 'use_quantity', operator: 'eq', value: true }
    }
    const formData = reactive<Record<string, unknown>>({
      items: [
        { use_quantity: true, quantity: 3, unit_price: 100 },
        { use_quantity: false, quantity: 2, unit_price: 50, amount: 999 },
      ],
    })
    const { app } = harness(ref(template), formData)
    await nextTick()
    expect((formData.items as Array<Record<string, unknown>>)[0].amount).toBe(300)
    expect((formData.items as Array<Record<string, unknown>>)[1].amount).toBe(999)
    expect(formData.amount).toBe(1299)
    app.unmount()
  })
})
