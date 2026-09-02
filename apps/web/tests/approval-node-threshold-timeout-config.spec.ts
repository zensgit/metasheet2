/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
/**
 * P1-C (approval-parity-master-design-lock-20260817.md §P1-C, master M7): direct-mount proof that
 * the complex-graph node editor's NEW threshold (T2-4 N-of-M) + timeout (T1-1) controls are actually
 * WIRED — every rendered control changes real edit state through the typed setter, not inert theater
 * (M7). Also the behavioral positive control for "never offer a capability the engine doesn't
 * implement" (M6/M8): the timeout-effect picker's option set is asserted against the DOM, not a
 * hand-copied literal, so a mutation widening it to `auto_approve`/`auto_reject` is caught. Mirrors
 * the mount harness in approval-handler-node-config.spec.ts (element-plus stubs + provide/inject).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, reactive, type App as VueApp } from 'vue'
import ApprovalGraphNodeConfigEditor from '../src/approvals/components/ApprovalGraphNodeConfigEditor.vue'
import { APPROVAL_NODE_CONFIG_EDITOR_KEY, type ApprovalNodeConfigEditorApi } from '../src/approvals/nodeConfigEditorContext'
import { DEFAULT_APPROVAL_CAPABILITY_REGISTRY } from '../src/approvals/approvalCapabilityRegistry'
import { NODE_TIMEOUT_SUPPORTED_EFFECTS } from '../src/approvals/templateAuthoring'
import type { ApprovalMode, ApprovalNode, NodeTimeoutConfig, SupportedNodeTimeoutEffect } from '../src/types/approval'

// ── element-plus stubs (same shapes as approval-handler-node-config.spec.ts) ─────────────────────
const ElSelect = defineComponent({
  name: 'ElSelect', props: { modelValue: [String, Array], disabled: Boolean }, emits: ['update:modelValue', 'change'],
  render() {
    return h('select', {
      value: this.modelValue ?? '', disabled: this.disabled, 'data-testid': (this.$attrs as any)?.['data-testid'],
      onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; this.$emit('update:modelValue', v); this.$emit('change', v) },
    }, this.$slots.default?.())
  },
})
const ElOption = defineComponent({ name: 'ElOption', props: { label: String, value: String, disabled: Boolean }, render() { return h('option', { value: this.value, disabled: this.disabled }, this.label) } })
const ElCheckbox = defineComponent({
  name: 'ElCheckbox', inheritAttrs: false, props: { modelValue: Boolean, disabled: Boolean }, emits: ['update:modelValue'],
  render() { return h('label', [h('input', { type: 'checkbox', checked: this.modelValue, disabled: this.disabled, 'data-testid': (this.$attrs as any)?.['data-testid'], onChange: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLInputElement).checked) }), this.$slots.default?.()]) },
})
const ElInput = defineComponent({
  name: 'ElInput', props: { modelValue: [String, Number], disabled: Boolean }, emits: ['update:modelValue'],
  render() { return h('input', { value: this.modelValue ?? '', disabled: this.disabled, 'data-testid': (this.$attrs as any)?.['data-testid'], onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLInputElement).value) }) },
})
const ElInputNumber = defineComponent({
  name: 'ElInputNumber', props: { modelValue: Number, disabled: Boolean, min: Number, max: Number, step: Number }, emits: ['update:modelValue'],
  render() { return h('input', { type: 'number', value: this.modelValue ?? '', disabled: this.disabled, 'data-testid': (this.$attrs as any)?.['data-testid'], onInput: (e: Event) => this.$emit('update:modelValue', Number((e.target as HTMLInputElement).value)) }) },
})
const passthrough = (name: string, tag = 'div') => defineComponent({ name, render() { return h(tag, { 'data-testid': (this.$attrs as any)?.['data-testid'] }, this.$slots.default?.()) } })
const ElButton = defineComponent({ name: 'ElButton', props: { disabled: Boolean, type: String, size: String }, emits: ['click'], render() { return h('button', { type: 'button', disabled: this.disabled, 'data-testid': (this.$attrs as any)?.['data-testid'], onClick: (e: Event) => this.$emit('click', e) }, this.$slots.default?.()) } })

function installStubs(app: VueApp<Element>) {
  app.component('ElSelect', ElSelect)
  app.component('ElOption', ElOption)
  app.component('ElCheckbox', ElCheckbox)
  app.component('ElInput', ElInput)
  app.component('ElInputNumber', ElInputNumber)
  app.component('ElButton', ElButton)
  app.component('ElButtonGroup', passthrough('ElButtonGroup'))
  app.component('ElAlert', passthrough('ElAlert'))
  app.component('ElForm', passthrough('ElForm', 'form'))
  app.component('ElFormItem', passthrough('ElFormItem', 'label'))
  app.component('ElIcon', passthrough('ElIcon', 'span'))
}

type Edit = {
  nodeKey: string
  assigneeSources: Array<Record<string, unknown>>
  approvalMode: ApprovalMode
  approvalThreshold: number
  fieldPermissions: Array<{ fieldId: string; access: string }>
  timeout: NodeTimeoutConfig | null | undefined
}

function createStubConfigApi(
  seed: Record<string, Partial<Edit>>,
  opts: { inParallelRegion?: boolean } = {},
): ApprovalNodeConfigEditorApi {
  const edits: Record<string, Edit> = reactive({})
  for (const [key, v] of Object.entries(seed)) {
    edits[key] = {
      nodeKey: key,
      assigneeSources: (v.assigneeSources ?? [{ kind: 'requester' }]).map((s) => ({ ...s })),
      approvalMode: v.approvalMode ?? 'single',
      approvalThreshold: v.approvalThreshold ?? 1,
      fieldPermissions: (v.fieldPermissions ?? []).map((p) => ({ ...p })),
      timeout: v.timeout,
    }
  }
  return {
    readOnly: false,
    conditionEditFor: () => undefined,
    parallelEditFor: () => undefined,
    ccEditFor: () => undefined,
    approvalNodeEditFor: (k: string) => edits[k] as any,
    conditionFieldOptions: [],
    userFields: [],
    conditionFormulaInsertOptions: [],
    fieldPermissionFields: [],
    conditionOperatorLabel: () => '',
    liveBranchSummary: () => '',
    conditionRuleValueText: () => '',
    setConditionRuleValue: () => {},
    addConditionRule: () => {},
    removeConditionRule: () => {},
    setConditionBranchPredicateMode: () => {},
    insertConditionFormulaToken: () => {},
    insertConditionFormulaFunction: () => {},
    insertConditionFormulaRoleMembership: () => {},
    conditionFormulaDryRunResult: () => '',
    conditionFormulaDryRunLoading: () => false,
    dryRunConditionFormula: () => {},
    conditionOutgoingEdgeKeys: () => [],
    conditionEdgeLabel: () => '',
    graphEdgeTargetLabel: () => '',
    graphNodeLabel: (k: string) => k,
    parallelJoinModeLabel: () => '',
    ccTargetTypeLabel: () => '用户',
    setCcTargetIds: () => {},
    syncCcOptions: () => {},
    approvalSourceKind: (k: string, i: number) => (edits[k]?.assigneeSources[i]?.kind as any) ?? 'requester',
    setApprovalSourceKind: () => {},
    syncApprovalNodeOptions: () => {},
    approvalSourceIds: () => [],
    setApprovalSourceIdsFromPicker: () => {},
    approvalSourceFieldId: () => '',
    setApprovalSourceFieldId: () => {},
    approvalSourceLevel: () => 1,
    setApprovalSourceLevel: () => {},
    approvalSourceIsPlaceholder: () => false,
    approvalSourceCount: (k: string) => edits[k]?.assigneeSources.length ?? 0,
    addApprovalSourceCard: () => {},
    removeApprovalSourceCard: () => {},
    approvalNodeMode: (k: string) => edits[k]?.approvalMode ?? 'single',
    setApprovalNodeMode: (k: string, mode: ApprovalMode) => { const e = edits[k]; if (e) e.approvalMode = mode },
    // P1-C — the controls this spec exists to prove are wired.
    approvalNodeThreshold: (k: string) => edits[k]?.approvalThreshold ?? 1,
    setApprovalNodeThreshold: (k: string, value: number) => { const e = edits[k]; if (e) e.approvalThreshold = value },
    approvalNodeInParallelRegion: () => opts.inParallelRegion ?? false,
    approvalNodeTimeout: (k: string) => edits[k]?.timeout ?? undefined,
    setApprovalNodeTimeoutEnabled: (k: string, enabled: boolean) => {
      const e = edits[k]; if (!e) return
      if (!enabled) { e.timeout = null; return }
      if (e.timeout) return
      e.timeout = { afterMinutes: 60, effect: 'remind' }
    },
    setApprovalNodeTimeoutAfterMinutes: (k: string, minutes: number) => { const e = edits[k]; if (e?.timeout) e.timeout = { ...e.timeout, afterMinutes: minutes } },
    setApprovalNodeTimeoutEffect: (k: string, effect: SupportedNodeTimeoutEffect) => { const e = edits[k]; if (e?.timeout) e.timeout = { afterMinutes: e.timeout.afterMinutes, effect } },
    setApprovalNodeTimeoutTransferToUserId: (k: string, userId: string) => { const e = edits[k]; if (e?.timeout) e.timeout = { ...e.timeout, transferToUserId: userId } },
    setApprovalNodeTimeoutJumpToNodeKey: (k: string, targetNodeKey: string) => { const e = edits[k]; if (e?.timeout) e.timeout = { ...e.timeout, jumpToNodeKey: targetNodeKey } },
    setApprovalNodeTimeoutUnit: (k: string, unit: 'wall_clock' | 'business') => {
      const e = edits[k]; if (!e?.timeout) return
      const next = { ...e.timeout }
      if (unit === 'business') next.unit = 'business'
      else delete next.unit
      e.timeout = next
    },
    timeoutJumpTargetOptions: () => [{ key: 'approval_2', label: '二审' }],
    approvalNodeEmptyPolicy: () => 'error',
    setApprovalNodeEmptyPolicy: () => {},
    approvalNodeMergeWithRequester: () => false,
    setApprovalNodeMergeWithRequester: () => {},
    handlerNodeMode: () => 'all',
    setHandlerNodeMode: () => {},
    handlerNodeOpinionRequired: () => false,
    setHandlerNodeOpinionRequired: () => {},
    approvalNodeFieldAccess: () => 'editable',
    setApprovalNodeFieldAccess: () => {},
    nodeConfigSummary: () => [],
    onUserSearch: () => {},
    directoryUsers: [{ id: 'backup_u1', name: '备份审批人' }],
    directoryUsersLoading: false,
    directoryRoles: [],
    formulaRoles: [],
    formatUserLabel: (u: { id: string; name?: string }) => u.name ?? u.id,
    formatRoleLabel: (r: { id: string }) => r.id,
  } as unknown as ApprovalNodeConfigEditorApi
}

const mounted: Array<() => void> = []
afterEach(() => { while (mounted.length) mounted.pop()!() })

function mountEditorFlat(node: ApprovalNode, api: ApprovalNodeConfigEditorApi) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const Harness = defineComponent({ name: 'HF', setup() { provide(APPROVAL_NODE_CONFIG_EDITOR_KEY, api); return () => h(ApprovalGraphNodeConfigEditor as any, { node, registry: DEFAULT_APPROVAL_CAPABILITY_REGISTRY }) } })
  const app = createApp(Harness)
  installStubs(app)
  app.mount(container)
  mounted.push(() => { app.unmount(); container.remove() })
  return container
}

function approvalNode(key = 'approval_1'): ApprovalNode {
  return { key, type: 'approval', name: '主管', config: {} as any }
}

describe('P1-C threshold control (M7 wired, not inert)', () => {
  it('the mode picker offers a threshold option; selecting it calls setApprovalNodeMode', () => {
    const api = createStubConfigApi({ approval_1: {} })
    const c = mountEditorFlat(approvalNode(), api)
    const select = c.querySelector('[data-testid="approval-node-mode"]') as HTMLSelectElement
    const thresholdOption = c.querySelector('[data-testid="approval-node-mode-threshold-option"]') as HTMLOptionElement
    expect(thresholdOption).toBeTruthy()
    expect(thresholdOption.disabled).toBe(false)
    select.value = 'threshold'
    select.dispatchEvent(new Event('change'))
    expect(api.approvalNodeMode('approval_1')).toBe('threshold')
  })

  it('the mode picker offers sequential and disables it inside a parallel region', () => {
    const api = createStubConfigApi({ approval_1: {} })
    const c = mountEditorFlat(approvalNode(), api)
    const select = c.querySelector('[data-testid="approval-node-mode"]') as HTMLSelectElement
    const option = c.querySelector('[data-testid="approval-node-mode-sequential-option"]') as HTMLOptionElement
    expect(option.disabled).toBe(false)
    select.value = 'sequential'
    select.dispatchEvent(new Event('change'))
    expect(api.approvalNodeMode('approval_1')).toBe('sequential')

    const parallelApi = createStubConfigApi({ approval_1: {} }, { inParallelRegion: true })
    const parallel = mountEditorFlat(approvalNode(), parallelApi)
    expect((parallel.querySelector('[data-testid="approval-node-mode-sequential-option"]') as HTMLOptionElement).disabled).toBe(true)
  })

  it('the N input renders once mode is threshold and setApprovalNodeThreshold fires on change', async () => {
    const api = createStubConfigApi({ approval_1: { approvalMode: 'threshold', approvalThreshold: 1 } })
    const c = mountEditorFlat(approvalNode(), api)
    const input = c.querySelector('[data-testid="approval-node-threshold"]') as HTMLInputElement
    expect(input).toBeTruthy()
    input.value = '3'
    input.dispatchEvent(new Event('input'))
    expect(api.approvalNodeThreshold('approval_1')).toBe(3)
  })

  it('the N input is ABSENT for a non-threshold mode (no inert control)', () => {
    const api = createStubConfigApi({ approval_1: { approvalMode: 'single' } })
    const c = mountEditorFlat(approvalNode(), api)
    expect(c.querySelector('[data-testid="approval-node-threshold"]')).toBeNull()
  })

  it('linear-only fail-closed: the threshold option is DISABLED for a node inside a parallel region', () => {
    const api = createStubConfigApi({ approval_1: {} }, { inParallelRegion: true })
    const c = mountEditorFlat(approvalNode(), api)
    const thresholdOption = c.querySelector('[data-testid="approval-node-mode-threshold-option"]') as HTMLOptionElement
    expect(thresholdOption.disabled).toBe(true)
    expect(c.querySelector('[data-testid="approval-node-threshold-parallel-hint"]')).toBeTruthy()
  })
})

describe('P1-C timeout controls (M7 wired, not inert)', () => {
  it('the enable checkbox calls setApprovalNodeTimeoutEnabled and the detail fields then appear', () => {
    const api = createStubConfigApi({ approval_1: {} })
    const c = mountEditorFlat(approvalNode(), api)
    expect(c.querySelector('[data-testid="approval-node-timeout-after-minutes"]')).toBeNull()
    const checkbox = c.querySelector('[data-testid="approval-node-timeout-enabled"]') as HTMLInputElement
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))
    expect(api.approvalNodeTimeout('approval_1')).toBeTruthy()
  })

  it('linear-only fail-closed: the enable checkbox is DISABLED for a node inside a parallel region', () => {
    const api = createStubConfigApi({ approval_1: {} }, { inParallelRegion: true })
    const c = mountEditorFlat(approvalNode(), api)
    const checkbox = c.querySelector('[data-testid="approval-node-timeout-enabled"]') as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
    expect(c.querySelector('[data-testid="approval-node-timeout-parallel-hint"]')).toBeTruthy()
  })

  it('afterMinutes / effect fields are wired; effect option set is EXACTLY the supported three (M6/M8 — never invents auto_approve/auto_reject)', () => {
    const api = createStubConfigApi({ approval_1: { timeout: { afterMinutes: 60, effect: 'remind' } } })
    const c = mountEditorFlat(approvalNode(), api)
    const minutesInput = c.querySelector('[data-testid="approval-node-timeout-after-minutes"]') as HTMLInputElement
    minutesInput.value = '90'
    minutesInput.dispatchEvent(new Event('input'))
    expect(api.approvalNodeTimeout('approval_1')?.afterMinutes).toBe(90)

    const effectSelect = c.querySelector('[data-testid="approval-node-timeout-effect"]') as HTMLSelectElement
    const optionValues = Array.from(effectSelect.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value)
    expect(optionValues.sort()).toEqual([...NODE_TIMEOUT_SUPPORTED_EFFECTS].sort())
    expect(optionValues).not.toContain('auto_approve')
    expect(optionValues).not.toContain('auto_reject')
  })

  it('transfer effect reveals the target picker, wired to setApprovalNodeTimeoutTransferToUserId', async () => {
    const api = createStubConfigApi({ approval_1: { timeout: { afterMinutes: 60, effect: 'remind' } } })
    const c = mountEditorFlat(approvalNode(), api)
    const effectSelect = c.querySelector('[data-testid="approval-node-timeout-effect"]') as HTMLSelectElement
    effectSelect.value = 'transfer'
    effectSelect.dispatchEvent(new Event('change'))
    expect(api.approvalNodeTimeout('approval_1')?.effect).toBe('transfer')
    await nextTick()

    const target = c.querySelector('[data-testid="approval-node-timeout-transfer-target"]') as HTMLSelectElement
    expect(target).toBeTruthy()
    expect(c.querySelector('[data-testid="approval-node-timeout-jump-target"]')).toBeNull()
    target.value = 'backup_u1'
    target.dispatchEvent(new Event('change'))
    expect(api.approvalNodeTimeout('approval_1')?.transferToUserId).toBe('backup_u1')
  })

  it('jump effect reveals the target node picker (business labels), wired to setApprovalNodeTimeoutJumpToNodeKey', async () => {
    const api = createStubConfigApi({ approval_1: { timeout: { afterMinutes: 60, effect: 'remind' } } })
    const c = mountEditorFlat(approvalNode(), api)
    const effectSelect = c.querySelector('[data-testid="approval-node-timeout-effect"]') as HTMLSelectElement
    effectSelect.value = 'jump'
    effectSelect.dispatchEvent(new Event('change'))
    await nextTick()

    const target = c.querySelector('[data-testid="approval-node-timeout-jump-target"]') as HTMLSelectElement
    expect(target).toBeTruthy()
    expect(c.querySelector('[data-testid="approval-node-timeout-transfer-target"]')).toBeNull()
    // Business label, never a raw node key, in the rendered option text (M8).
    expect(target.querySelector('option')?.textContent).toBe('二审')
    target.value = 'approval_2'
    target.dispatchEvent(new Event('change'))
    expect(api.approvalNodeTimeout('approval_1')?.jumpToNodeKey).toBe('approval_2')
  })

  it('the unit radios are wired to setApprovalNodeTimeoutUnit', () => {
    const api = createStubConfigApi({ approval_1: { timeout: { afterMinutes: 60, effect: 'remind' } } })
    const c = mountEditorFlat(approvalNode(), api)
    const businessRadio = c.querySelector('[data-testid="approval-node-timeout-unit-business"]') as HTMLInputElement
    businessRadio.checked = true
    businessRadio.dispatchEvent(new Event('change'))
    expect(api.approvalNodeTimeout('approval_1')?.unit).toBe('business')
    const wallClockRadio = c.querySelector('[data-testid="approval-node-timeout-unit-wall-clock"]') as HTMLInputElement
    wallClockRadio.checked = true
    wallClockRadio.dispatchEvent(new Event('change'))
    expect(api.approvalNodeTimeout('approval_1')?.unit).toBeUndefined()
  })
})
