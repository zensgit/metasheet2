import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import { useLocale } from '../src/composables/useLocale'
import { epOptions, epSetSelect } from './helpers/epControls'
import { AUTOMATION_READ_ACTION_TYPE as type, AUTOMATION_READ_OPERATION as operation } from '../src/multitable/automationReadAuthoring'

const apps: App[] = []
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
const config = { operation, allowManual: false }
const rule = (extra: Record<string, unknown> = {}) => ({
  id: 'read-rule', sheetId: 'sheet_1', name: 'Synthetic read preview', enabled: false,
  triggerType: 'record.created', triggerConfig: {}, executionMode: null,
  actionType: type, actionConfig: { ...config }, actions: [{ type, config: { ...config } }], ...extra,
})
async function mount(extra: Record<string, unknown> = {}) {
  useLocale().setLocale('en')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const onSave = vi.fn(), onTest = vi.fn()
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, { visible: true, sheetId: 'sheet_1', fields: [], rule: rule(), onSave, onTest, ...extra }) })
  apps.push(app)
  app.mount(container)
  await settle()
  const state = app._instance?.subTree.component?.setupState as Record<string, unknown>
  return { container, state, onSave, onTest }
}
const button = (container: HTMLElement, action: string) => container.querySelector(`[data-action="${action}"]`) as HTMLButtonElement
const checkbox = (container: HTMLElement, field: string) => container.querySelector(`[data-field="${field}"] input`) as HTMLInputElement

afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.innerHTML = ''; useLocale().setLocale('en'); vi.restoreAllMocks() })

describe('ordinary automation fixed read editor', () => {
  it('authors a fixed closed config with default manual off; Add and ordinary Test have handler guards', async () => {
    const { container, state, onSave, onTest } = await mount()
    const actionSelect = container.querySelector('[data-action-index="0"] .el-select')
    expect(epOptions(actionSelect).map(option => option.value)).toContain(type)
    expect(checkbox(container, 'automationReadAllowManual').checked).toBe(false)
    expect(container.querySelector('[data-action-config="integration_read_preview"]')?.querySelectorAll('input:not([type="checkbox"]),textarea')).toHaveLength(0)
    expect(button(container, 'add-action').disabled).toBe(true)
    ;(state.addAction as () => void)()
    await settle()
    expect(container.querySelectorAll('[data-action-index]')).toHaveLength(1)
    expect(button(container, 'test').disabled).toBe(true)
    await (state.onTestRun as () => Promise<void>)()
    expect(onTest).not.toHaveBeenCalled()
    expect(container.querySelector('[data-field="automationReadTestRunHint"]')?.textContent).toContain('owner')
    ;(state.setExecutionMode as (checked: boolean) => void)(true)
    button(container, 'save').click()
    await settle()
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0]).toMatchObject({ actionType: type, actionConfig: config, actions: [{ type, config }], executionMode: null })
  })
  it('creates read action from the real action dropdown and saves explicit manual selection', async () => {
    const { container, state, onSave, onTest } = await mount({ rule: undefined })
    const name = container.querySelector('[data-field="name"]') as HTMLInputElement
    name.value = 'Synthetic new read'; name.dispatchEvent(new Event('input', { bubbles: true }))
    epSetSelect(container.querySelector('[data-action-index="0"] .el-select'), type)
    await settle()
    expect(checkbox(container, 'automationReadAllowManual').checked).toBe(false)
    expect(button(container, 'add-action').disabled).toBe(true)
    ;(state.addAction as () => void)()
    await settle()
    expect(container.querySelectorAll('[data-action-index]')).toHaveLength(1)
    expect(checkbox(container, 'executionModeToggle').disabled).toBe(true)
    ;(state.setExecutionMode as (checked: boolean) => void)(true)
    await (state.onTestRun as () => Promise<void>)()
    expect(onTest).not.toHaveBeenCalled()
    checkbox(container, 'automationReadAllowManual').click()
    await settle()
    button(container, 'save').click()
    await settle()
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0].actionConfig).toEqual({ operation, allowManual: true })
    expect(onSave.mock.calls[0][0].actions[0].config).toEqual({ operation, allowManual: true })
  })
  it('selects record.updated in the ordinary editor and saves only rule authoring, never owner activation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { container, state, onSave, onTest } = await mount()
    epSetSelect(container.querySelector('[data-field="triggerType"]'), 'record.updated')
    await settle()
    expect(checkbox(container, 'automationReadAllowManual').checked).toBe(false)
    expect(button(container, 'test').disabled).toBe(true)
    await (state.onTestRun as () => Promise<void>)()
    expect(onTest).not.toHaveBeenCalled()
    expect(container.querySelector('[data-field="automationReadTestRunHint"]')?.textContent)
      .toContain('including zero-field or unchanged-value updates')
    button(container, 'save').click(); await settle()
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0]).toMatchObject({ triggerType: 'record.updated', triggerConfig: {},
      actionType: type, actionConfig: config, actions: [{ type, config }] })
    expect(onSave.mock.calls[0][0].conditions).toBeUndefined()
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('activationKey')
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('grantId')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it.each([
    { ...config, sourceId: 'must-not-save' }, { ...config, sql: 'must-not-save' },
    { operation: 'other', allowManual: false }, { operation, allowManual: 'true' },
  ])('blocks malformed persisted config until explicit reset', async invalid => {
    const { container, state, onSave } = await mount({ rule: rule({ actionConfig: invalid, actions: [{ type, config: invalid }] }) })
    expect(button(container, 'save').disabled).toBe(true)
    await (state.onSave as () => Promise<void>)()
    expect(onSave).not.toHaveBeenCalled()
    expect(() => (state.buildPayload as () => unknown)()).toThrow()
    button(container, 'reset-read-config').click()
    await settle()
    expect(button(container, 'save').disabled).toBe(false)
    button(container, 'save').click()
    await settle()
    expect(onSave.mock.calls[0][0].actionConfig).toEqual(config)
  })
  it('requires explicit legacy/list reconciliation and keeps hidden legacy reads blocked from Test', async () => {
    const modern = { type: 'send_notification', config: { userIds: ['synthetic-user'], message: 'Synthetic' } }
    const { container, state, onSave, onTest } = await mount({ rule: rule({ actions: [modern] }) })
    expect(button(container, 'save').disabled).toBe(true)
    expect(button(container, 'test').disabled).toBe(true)
    expect(() => (state.buildPayload as () => unknown)()).toThrow()
    await (state.onTestRun as () => Promise<void>)()
    expect(onTest).not.toHaveBeenCalled()
    button(container, 'repair-read-representation').click()
    await settle()
    expect(button(container, 'save').disabled).toBe(false)
    button(container, 'save').click()
    await settle()
    expect(onSave.mock.calls[0][0].actionType).toBe(modern.type)
  })
  it('does not delete loaded successors; explicit removal repairs singleton', async () => {
    const { container, state } = await mount({ rule: rule({ actions: [{ type, config }, { type: 'send_notification', config: { userIds: ['synthetic'], message: 'Synthetic' } }] }) })
    expect(container.querySelectorAll('[data-action-index]')).toHaveLength(2)
    expect(button(container, 'save').disabled).toBe(true)
    expect(() => (state.buildPayload as () => unknown)()).toThrow()
    ;(state.removeAction as (index: number) => void)(1)
    await settle()
    expect(button(container, 'save').disabled).toBe(false)
  })
  it.each(['workflow_job_v1', 'invalid-mode'])('lets the author turn off loaded %s, then forbids re-enabling', async executionMode => {
    const { container, state } = await mount({ rule: rule({ executionMode }) })
    expect(button(container, 'save').disabled).toBe(true)
    expect(checkbox(container, 'executionModeToggle').disabled).toBe(false)
    checkbox(container, 'executionModeToggle').click()
    await settle()
    expect(button(container, 'save').disabled).toBe(false)
    expect(checkbox(container, 'executionModeToggle').disabled).toBe(true)
    ;(state.setExecutionMode as (checked: boolean) => void)(true)
    expect(() => (state.buildPayload as () => unknown)()).not.toThrow()
    expect((state.buildPayload as () => { executionMode: unknown })().executionMode).toBeNull()
  })
  it('blocks save after an unsupported trigger change', async () => {
    const { container, state } = await mount()
    epSetSelect(container.querySelector('[data-field="triggerType"]'), 'form.submitted')
    await settle()
    expect(button(container, 'save').disabled).toBe(true)
    expect(() => (state.buildPayload as () => unknown)()).toThrow()
    expect(container.querySelector('[data-field="saveBlockReasons"]')?.textContent).toContain('record or schedule')
  })
  it('blocks persisted and draft nested read Test even when branch editor is read-only', async () => {
    const nested = { type: 'condition_branch', config: { branches: [{ key: 'synthetic', conditions: [], actions: [{ type, config }] }] } }
    const { container, state, onTest } = await mount({ rule: rule({ actionType: nested.type, actionConfig: nested.config, actions: [nested], executionMode: 'workflow_job_v1' }) })
    expect(button(container, 'test').disabled).toBe(true)
    await (state.onTestRun as () => Promise<void>)()
    expect(onTest).not.toHaveBeenCalled()
    expect(button(container, 'save').disabled).toBe(true)
    const branchMenus = container.querySelectorAll('[data-field="branch-action-type"]')
    for (const menu of branchMenus) expect(epOptions(menu).map(option => option.value)).not.toContain(type)
  })
  it.each([{ ...config, sourceId: 'hidden-legacy' }, { operation: 'invalid-operation', allowManual: false }])('requires explicit repair when valid modern config hides invalid legacy config', async invalid => {
    const { container, state, onSave } = await mount({ rule: rule({ actionConfig: invalid }) })
    expect(button(container, 'save').disabled).toBe(true)
    await (state.onSave as () => Promise<void>)()
    expect(onSave).not.toHaveBeenCalled()
    expect(() => (state.buildPayload as () => unknown)()).toThrow()
    button(container, 'repair-read-representation').click()
    await settle()
    expect(button(container, 'save').disabled).toBe(false)
    button(container, 'save').click()
    await settle()
    expect(onSave.mock.calls[0][0].actionConfig).toEqual(config)
  })
  it('read save computed inspects own config accessor without invoking it', async () => {
    const { container, state, onSave } = await mount()
    const getter = vi.fn(() => operation)
    const cfg = { allowManual: false }
    Object.defineProperty(cfg, 'operation', { enumerable: true, configurable: true, get: getter })
    const draft = state.draft as { actions: Array<{ config: Record<string, unknown> }> }
    draft.actions[0].config = cfg
    // Read the real production computed before rendering; no config normalization is simulated.
    expect(state.readAuthoringProblems).toContain('config')
    expect(getter).not.toHaveBeenCalled()
    const saveAttempt = (state.onSave as () => Promise<void>)()
    expect(onSave).not.toHaveBeenCalled()
    expect(getter).not.toHaveBeenCalled()
    // Dirty-state serialization is an existing separate JSON observer; reset before its render tick.
    draft.actions[0].config = { ...config }
    await saveAttempt
    await settle()
    expect(button(container, 'save').disabled).toBe(false)
  })
})
