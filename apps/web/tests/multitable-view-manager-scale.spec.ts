import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MetaViewManager from '../src/multitable/components/MetaViewManager.vue'
import type { ConditionalFormattingScaleRule } from '../src/multitable/types'

function scaleRule(): ConditionalFormattingScaleRule {
  return {
    id: 'scr_keep',
    order: 0,
    fieldId: 'fld_amount',
    kind: 'dataBar',
    enabled: true,
    range: { mode: 'auto' },
    dataBar: { color: '#3b82f6' },
  }
}

function mountManager(views: unknown[], activeViewId: string) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const updateSpy = vi.fn()
  const app = createApp({
    render() {
      return h(MetaViewManager, {
        visible: true,
        sheetId: 'sheet_1',
        activeViewId,
        fields: [
          { id: 'fld_name', name: 'Name', type: 'string' },
          { id: 'fld_amount', name: 'Amount', type: 'number' },
          { id: 'fld_cover', name: 'Cover', type: 'attachment' },
        ],
        views,
        onUpdateView: updateSpy,
      })
    },
  })
  app.mount(container)
  return { app, container, updateSpy }
}

describe('MetaViewManager scale formatting', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('saving a scale rule emits config with scale rules AND preserves operator rules', async () => {
    const { app, container, updateSpy } = mountManager(
      [
        {
          id: 'view_grid',
          sheetId: 'sheet_1',
          name: 'Grid',
          type: 'grid',
          config: {
            conditionalFormattingRules: [
              { id: 'cfr_1', order: 0, fieldId: 'fld_amount', operator: 'gt', value: 5, style: { backgroundColor: '#fce4e4' }, enabled: true },
            ],
          },
        },
      ],
      'view_grid',
    )

    // open the scale-formatting dialog
    const scaleBtn = container.querySelector('.meta-view-mgr__action[title="Scale formatting"]') as HTMLButtonElement
    expect(scaleBtn).toBeTruthy()
    scaleBtn.click()
    await nextTick()

    // add a scale rule and save
    const addBtn = Array.from(container.querySelectorAll('.scf-dlg__body > .scf-dlg__btn'))
      .find((b) => b.textContent?.includes('Add scale rule')) as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const saveBtn = Array.from(container.querySelectorAll('.scf-dlg__footer .scf-dlg__btn'))
      .find((b) => b.textContent?.includes('Save')) as HTMLButtonElement
    saveBtn.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [viewId, payload] = updateSpy.mock.calls[0]
    expect(viewId).toBe('view_grid')
    const config = payload.config as Record<string, unknown>
    expect(Array.isArray(config.conditionalFormattingScaleRules)).toBe(true)
    expect((config.conditionalFormattingScaleRules as unknown[]).length).toBe(1)
    // operator rules preserved by the {...target.config} spread
    expect(config.conditionalFormattingRules).toEqual([
      { id: 'cfr_1', order: 0, fieldId: 'fld_amount', operator: 'gt', value: 5, style: { backgroundColor: '#fce4e4' }, enabled: true },
    ])
    app.unmount()
  })

  // REGRESSION (Bug A5): saving an unrelated per-type view config must NOT drop
  // pre-existing scale rules. The fixture is SCALE-RULES-ONLY (no operator rules)
  // — that's the case the prior early-return-on-operator-key fix would have
  // silently dropped.
  it('saving a non-grid (gallery) view config preserves pre-existing scale rules (scale-only)', async () => {
    const { app, container, updateSpy } = mountManager(
      [
        {
          id: 'view_gallery',
          sheetId: 'sheet_1',
          name: 'Cards',
          type: 'gallery',
          config: {
            // NOTE: scale rules only — NO conditionalFormattingRules key.
            conditionalFormattingScaleRules: [scaleRule()],
            fieldIds: [],
            columns: 3,
            cardSize: 'medium',
          },
        },
      ],
      'view_gallery',
    )

    // open the per-type config panel
    const configBtn = container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement
    configBtn.click()
    await nextTick()

    // make a change so the draft is dirty (set a title field), then save
    const select = container.querySelector('.meta-view-mgr__config select') as HTMLSelectElement
    select.value = 'fld_name'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const saveBtn = Array.from(container.querySelectorAll('.meta-view-mgr__btn-add'))
      .find((b) => b.textContent?.includes('Save view settings')) as HTMLButtonElement
    expect(saveBtn).toBeTruthy()
    saveBtn.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [viewId, payload] = updateSpy.mock.calls[0]
    expect(viewId).toBe('view_gallery')
    const config = payload.config as Record<string, unknown>
    // the bug: this key was dropped. Assert it survives the gallery config save.
    expect(config.conditionalFormattingScaleRules).toEqual([scaleRule()])
    app.unmount()
  })

  it('saving an operator-rule preserves pre-existing scale rules (cross-family)', async () => {
    const { app, container, updateSpy } = mountManager(
      [
        {
          id: 'view_grid',
          sheetId: 'sheet_1',
          name: 'Grid',
          type: 'grid',
          config: {
            conditionalFormattingScaleRules: [scaleRule()],
          },
        },
      ],
      'view_grid',
    )

    const cfBtn = container.querySelector('.meta-view-mgr__action[title="Conditional formatting"]') as HTMLButtonElement
    cfBtn.click()
    await nextTick()

    const addBtn = Array.from(container.querySelectorAll('.cf-dlg__btn'))
      .find((b) => b.textContent?.includes('Add rule')) as HTMLButtonElement
    addBtn.click()
    await nextTick()

    const saveBtn = Array.from(container.querySelectorAll('.cf-dlg__footer .cf-dlg__btn'))
      .find((b) => b.textContent?.includes('Save')) as HTMLButtonElement
    saveBtn.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const config = updateSpy.mock.calls[0][1].config as Record<string, unknown>
    expect(config.conditionalFormattingScaleRules).toEqual([scaleRule()])
    expect(Array.isArray(config.conditionalFormattingRules)).toBe(true)
    app.unmount()
  })
})
