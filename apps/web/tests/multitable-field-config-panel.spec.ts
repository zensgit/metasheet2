// r4 items 4/5 (2026-09-10 field-manager test feedback, screenshots): the "配置" panel for a
// field type with no branch in MetaFieldManager.vue's configTargetType chain rendered nothing
// between the header and the Save/Cancel row — indistinguishable from a broken dialog. Separately,
// the formula panel (expression + AI generate + insert-field chips + formula reference catalog)
// had no bound on its own height, so inside the modal's fixed max-height box it pushed the
// Save/Cancel row below the viewport with no way to scroll to it.
//
// This file is intentionally separate from multitable-field-manager.spec.ts: the parallel
// #5602 branch (feat/multitable-field-manager-hint-palette-retype) appends ~800 lines to the end
// of that same file, and a second concurrent append to the same anchor line risks an avoidable
// merge hunk collision. Registered in .github/workflows/multitable-web-guard.yml (paths + vitest
// filter token `multitable-field-config-panel`) and apps/web/scripts/run-required-web-tests.sh.
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import { managerLabel } from '../src/multitable/utils/meta-manager-labels'

describe('MetaFieldManager — field-config panel: no-options fallback + scroll container', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function mountManager(fields: Record<string, unknown>[]) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaFieldManager, { visible: true, sheetId: 'sheet_1', sheets: [], fields })
      },
    })
    app.mount(container)
    return { container, app }
  }

  async function openConfig(container: HTMLElement, fieldName: string) {
    const rows = Array.from(container.querySelectorAll('.meta-field-mgr__row'))
    const row = rows.find((r) => r.querySelector('.meta-field-mgr__name')?.textContent === fieldName)
    const configureButton = row?.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null
    expect(configureButton).toBeTruthy()
    configureButton!.click()
    await nextTick()
  }

  // --- item 4: types with NO branch in the configTargetType chain (own enumeration —
  // dateTime and boolean/checkbox have no template branch, unlike select/link/person/
  // lookup/rollup/formula/attachment/number/currency/percent/rating/duration/button/
  // autoNumber which all DO, and unlike string/longText which render the separate
  // always-on AI-shortcut section instead of being blank). ---

  it('shows the no-configurable-options fallback (not a blank panel) for dateTime', async () => {
    const { container, app } = mountManager([{ id: 'fld_due', name: 'Due', type: 'dateTime', property: {} }])
    try {
      await openConfig(container, 'Due')

      const notice = container.querySelector('[data-test="field-config-no-options"]')
      expect(notice).toBeTruthy()
      expect(notice!.textContent).toBe(managerLabel('field.noConfigurableOptions', false))

      // Blank-panel proof: between the header and the Save/Cancel row there must be no
      // input/select/textarea control at all — only the notice text node.
      const configPanel = container.querySelector('.meta-field-mgr__config') as HTMLElement
      const controls = configPanel.querySelectorAll('input, select, textarea')
      expect(controls.length).toBe(0)
    } finally {
      app.unmount()
    }
  })

  it('shows the no-configurable-options fallback for boolean (checkbox)', async () => {
    const { container, app } = mountManager([{ id: 'fld_done', name: 'Done', type: 'boolean', property: {} }])
    try {
      await openConfig(container, 'Done')
      const notice = container.querySelector('[data-test="field-config-no-options"]')
      expect(notice).toBeTruthy()
      expect(notice!.textContent?.length).toBeGreaterThan(0)
    } finally {
      app.unmount()
    }
  })

  it('shows the no-configurable-options fallback for the read-only createdBy system field', async () => {
    const { container, app } = mountManager([{ id: 'fld_creator', name: 'Creator', type: 'createdBy', property: {} }])
    try {
      await openConfig(container, 'Creator')
      const notice = container.querySelector('[data-test="field-config-no-options"]')
      expect(notice).toBeTruthy()
    } finally {
      app.unmount()
    }
  })

  it('does NOT show the fallback for number, which has real configurable options', async () => {
    const { container, app } = mountManager([{ id: 'fld_qty', name: 'Qty', type: 'number', property: {} }])
    try {
      await openConfig(container, 'Qty')
      expect(container.querySelector('[data-test="field-config-no-options"]')).toBeFalsy()
      const configPanel = container.querySelector('.meta-field-mgr__config') as HTMLElement
      expect(configPanel.querySelectorAll('input, select, textarea').length).toBeGreaterThan(0)
    } finally {
      app.unmount()
    }
  })

  it('does NOT show the fallback for select, which has real configurable options', async () => {
    const { container, app } = mountManager([
      { id: 'fld_status', name: 'Status', type: 'select', property: { options: [] } },
    ])
    try {
      await openConfig(container, 'Status')
      expect(container.querySelector('[data-test="field-config-no-options"]')).toBeFalsy()
    } finally {
      app.unmount()
    }
  })

  it('does NOT show the fallback for string, which renders the AI-shortcut section instead', async () => {
    const { container, app } = mountManager([{ id: 'fld_name', name: 'Name', type: 'string', property: {} }])
    try {
      await openConfig(container, 'Name')
      expect(container.querySelector('[data-test="field-config-no-options"]')).toBeFalsy()
      expect(container.querySelector('[data-test="ai-shortcut-section"]')).toBeTruthy()
    } finally {
      app.unmount()
    }
  })

  // --- item 5: the config panel container must be its own bounded scroll region so the
  // Save/Cancel row stays reachable regardless of how tall the type-specific content is. ---

  it('gives the config panel container its own scroll region, with Save/Cancel inside it', async () => {
    const { container, app } = mountManager([{ id: 'fld_qty', name: 'Qty', type: 'number', property: {} }])
    try {
      await openConfig(container, 'Qty')
      const configPanel = container.querySelector('.meta-field-mgr__config') as HTMLElement
      expect(configPanel.classList.contains('meta-field-mgr__config--scrollable')).toBe(true)

      const actions = configPanel.querySelector('.meta-field-mgr__config-actions')
      expect(actions).toBeTruthy()
      // The Save/Cancel row must be a DESCENDANT of the scrollable container (so the sticky
      // footer rule in <style> — `.meta-field-mgr__config--scrollable .meta-field-mgr__config-actions`
      // — actually applies to it) rather than a sibling that merely happens to render after it.
      expect(configPanel.contains(actions)).toBe(true)
      const saveButton = Array.from(configPanel.querySelectorAll('button, [role="button"]'))
        .find((el) => el.textContent?.includes('Save field settings'))
      expect(saveButton).toBeTruthy()
    } finally {
      app.unmount()
    }
  })

  it('keeps the scroll container and reachable Save/Cancel row when the formula panel (tallest content) is mounted', async () => {
    const { container, app } = mountManager([
      { id: 'fld_total', name: 'Total', type: 'formula', property: { expression: '' } },
    ])
    try {
      await openConfig(container, 'Total')
      const configPanel = container.querySelector('.meta-field-mgr__config') as HTMLElement
      expect(configPanel.classList.contains('meta-field-mgr__config--scrollable')).toBe(true)

      // Formula-specific tall content actually mounted (expression box + reference catalog).
      expect(configPanel.querySelector('textarea.meta-field-mgr__textarea')).toBeTruthy()
      const formulaDocs = configPanel.querySelector('.meta-field-mgr__formula-docs')
      expect(formulaDocs).toBeTruthy()

      // Save/Cancel must still be inside the SAME scrollable container as the tall formula
      // content, not pushed outside it.
      const actions = configPanel.querySelector('.meta-field-mgr__config-actions')
      expect(configPanel.contains(actions)).toBe(true)
    } finally {
      app.unmount()
    }
  })
})
