/* eslint-disable vue/one-component-per-file, vue/require-default-prop */
/**
 * Lock-3 §1.5 — handler-node config surface + inspector tab strip (direct mount).
 *
 * Proves:
 *  - G-14: an inspector on a HANDLER node renders exactly `办理人设置` + `表单权限` (NO `操作权限`);
 *          positive control — a registry declaring a ratified operation policy renders the third tab,
 *          proving two tabs is the registry's doing.
 *  - the config editor renders the handler roster (seven kinds), the 办理模式 (会签/或签) picker, the
 *    办理意见 opt-in, and the field-permission honesty copy; and (M7) renders NONE of the approval-only
 *    controls (审批模式 / 空审批人策略 / 自审策略) for a handler.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, provide, reactive, type App as VueApp } from 'vue'
import ApprovalCanvasNodeInspector from '../src/approvals/components/ApprovalCanvasNodeInspector.vue'
import ApprovalGraphNodeConfigEditor from '../src/approvals/components/ApprovalGraphNodeConfigEditor.vue'
import { APPROVAL_NODE_CONFIG_EDITOR_KEY, type ApprovalNodeConfigEditorApi } from '../src/approvals/nodeConfigEditorContext'
import {
  DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
  assigneeSourceRoster,
  type ApprovalCapabilityRegistry,
} from '../src/approvals/approvalCapabilityRegistry'
import { HANDLER_ASSIGNEE_SOURCE_KINDS, type ApprovalNode } from '../src/types/approval'

// ── element-plus stubs (compact, mirrors approval-template-authoring-canvas-inspector.spec) ─────
const ElSelect = defineComponent({
  name: 'ElSelect', props: { modelValue: [String, Array], disabled: Boolean }, emits: ['update:modelValue', 'change'],
  render() {
    return h('select', {
      value: this.modelValue ?? '', disabled: this.disabled, 'data-testid': (this.$attrs as any)?.['data-testid'],
      onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; this.$emit('update:modelValue', v); this.$emit('change', v) },
    }, this.$slots.default?.())
  },
})
const ElOption = defineComponent({ name: 'ElOption', props: { label: String, value: String }, render() { return h('option', { value: this.value }, this.label) } })
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
  render() { return h('input', { type: 'number', value: this.modelValue ?? '', 'data-testid': (this.$attrs as any)?.['data-testid'], onInput: (e: Event) => this.$emit('update:modelValue', Number((e.target as HTMLInputElement).value)) }) },
})
const passthrough = (name: string, tag = 'div') => defineComponent({ name, render() { return h(tag, { 'data-testid': (this.$attrs as any)?.['data-testid'] }, this.$slots.default?.()) } })
const ElAlert = defineComponent({ name: 'ElAlert', props: { title: String, description: String }, render() { return h('div', { 'data-testid': (this.$attrs as any)?.['data-testid'] }, [h('strong', this.title), this.description ? h('p', this.description) : null]) } })
const ElButton = defineComponent({ name: 'ElButton', props: { disabled: Boolean, type: String, size: String }, emits: ['click'], render() { return h('button', { type: 'button', disabled: this.disabled, 'data-testid': (this.$attrs as any)?.['data-testid'], onClick: (e: Event) => this.$emit('click', e) }, this.$slots.default?.()) } })

function installStubs(app: VueApp<Element>) {
  app.component('ElSelect', ElSelect)
  app.component('ElOption', ElOption)
  app.component('ElCheckbox', ElCheckbox)
  app.component('ElInput', ElInput)
  app.component('ElInputNumber', ElInputNumber)
  app.component('ElButton', ElButton)
  app.component('ElButtonGroup', passthrough('ElButtonGroup'))
  app.component('ElAlert', ElAlert)
  app.component('ElForm', passthrough('ElForm', 'form'))
  app.component('ElFormItem', passthrough('ElFormItem', 'label'))
  app.component('ElIcon', passthrough('ElIcon', 'span'))
}

type Edit = { nodeKey: string; nodeType?: 'approval' | 'handler'; assigneeSources: Array<Record<string, unknown>>; fieldPermissions: Array<{ fieldId: string; access: string }>; handlerMode?: 'all' | 'any'; opinionRequired?: boolean }

function createStubConfigApi(seed: Record<string, Partial<Edit>>): ApprovalNodeConfigEditorApi {
  const edits: Record<string, Edit> = reactive({})
  for (const [key, v] of Object.entries(seed)) {
    edits[key] = { nodeKey: key, nodeType: v.nodeType, assigneeSources: (v.assigneeSources ?? []).map((s) => ({ ...s })), fieldPermissions: (v.fieldPermissions ?? []).map((p) => ({ ...p })), handlerMode: v.handlerMode, opinionRequired: v.opinionRequired }
  }
  return {
    readOnly: false,
    conditionEditFor: () => undefined,
    parallelEditFor: () => undefined,
    ccEditFor: () => undefined,
    approvalNodeEditFor: (k: string) => edits[k] as any,
    conditionFieldOptions: [],
    userFields: [{ id: 'reviewer', label: '审批人字段' }],
    conditionFormulaInsertOptions: [],
    fieldPermissionFields: [{ id: 'amount', label: '金额' }],
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
    // P1-B: every per-source accessor now takes an explicit sourceIndex (one card in the array).
    approvalSourceKind: (k: string, i: number) => (edits[k]?.assigneeSources[i]?.kind as any) ?? 'requester',
    setApprovalSourceKind: (k: string, i: number, kind: any) => {
      const e = edits[k]; if (!e || i < 0 || i >= e.assigneeSources.length) return
      const next: Record<string, unknown> = kind === 'static_user' ? { kind, userIds: [] } : kind === 'static_role' ? { kind, roleIds: [] } : kind === 'form_field_user' ? { kind, fieldId: '' } : kind === 'manager_at_level' ? { kind, level: 1 } : { kind }
      const nextSources = e.assigneeSources.slice(); nextSources[i] = next; e.assigneeSources = nextSources
    },
    syncApprovalNodeOptions: () => {},
    approvalSourceIds: (k: string, i: number) => { const s = edits[k]?.assigneeSources[i]; return (s?.userIds as string[]) ?? (s?.roleIds as string[]) ?? [] },
    setApprovalSourceIdsFromPicker: () => {},
    approvalSourceFieldId: (k: string, i: number) => (edits[k]?.assigneeSources[i]?.fieldId as string) ?? '',
    setApprovalSourceFieldId: () => {},
    approvalSourceLevel: (k: string, i: number) => (edits[k]?.assigneeSources[i]?.level as number) ?? 1,
    setApprovalSourceLevel: () => {},
    approvalSourceIsPlaceholder: () => false,
    approvalSourceCount: (k: string) => edits[k]?.assigneeSources.length ?? 0,
    addApprovalSourceCard: (k: string, defaultKind: any) => {
      const e = edits[k]; if (!e) return
      const next: Record<string, unknown> = defaultKind === 'static_user' ? { kind: defaultKind, userIds: [] } : defaultKind === 'static_role' ? { kind: defaultKind, roleIds: [] } : defaultKind === 'form_field_user' ? { kind: defaultKind, fieldId: '' } : defaultKind === 'manager_at_level' ? { kind: defaultKind, level: 1 } : { kind: defaultKind }
      e.assigneeSources = [...e.assigneeSources, next]
    },
    removeApprovalSourceCard: (k: string, i: number) => {
      const e = edits[k]; if (!e || e.assigneeSources.length <= 1) return
      e.assigneeSources = e.assigneeSources.filter((_: unknown, idx: number) => idx !== i)
    },
    approvalNodeMode: () => 'single',
    setApprovalNodeMode: () => {},
    approvalNodeEmptyPolicy: () => 'error',
    setApprovalNodeEmptyPolicy: () => {},
    approvalNodeMergeWithRequester: () => false,
    setApprovalNodeMergeWithRequester: () => {},
    handlerNodeMode: (k: string) => edits[k]?.handlerMode ?? 'all',
    setHandlerNodeMode: (k: string, mode: any) => { const e = edits[k]; if (e) e.handlerMode = mode },
    handlerNodeOpinionRequired: (k: string) => Boolean(edits[k]?.opinionRequired),
    setHandlerNodeOpinionRequired: (k: string, req: boolean) => { const e = edits[k]; if (e) e.opinionRequired = req },
    approvalNodeFieldAccess: (k: string, fieldId: string) => (edits[k]?.fieldPermissions.find((p) => p.fieldId === fieldId)?.access as any) ?? 'editable',
    setApprovalNodeFieldAccess: (k: string, fieldId: string, access: any) => { const e = edits[k]; if (!e) return; e.fieldPermissions = e.fieldPermissions.filter((p) => p.fieldId !== fieldId); if (access !== 'editable') e.fieldPermissions.push({ fieldId, access }) },
    nodeConfigSummary: () => [],
    onUserSearch: () => {},
    directoryUsers: [],
    directoryUsersLoading: false,
    directoryRoles: [],
    formulaRoles: [],
    formatUserLabel: (u: { id: string }) => u.id,
    formatRoleLabel: (r: { id: string }) => r.id,
  } as unknown as ApprovalNodeConfigEditorApi
}

const mounted: Array<() => void> = []
afterEach(() => { while (mounted.length) mounted.pop()!() })

function mountInspector(node: ApprovalNode, registry: ApprovalCapabilityRegistry, api: ApprovalNodeConfigEditorApi) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const Harness = defineComponent({
    name: 'H',
    setup() {
      provide(APPROVAL_NODE_CONFIG_EDITOR_KEY, api)
      return () => h(ApprovalCanvasNodeInspector as any, {
        node, readOnly: false, movingCanvasNode: null, graphNodeLabel: (k: string) => k, nodeTypeLabel: (t: string) => t,
        canMoveCanvasNode: () => false, canvasStepMoveTarget: () => undefined, canInsertAfter: () => false, canInsertParallelAfter: () => false, canRemoveNode: () => false, registry,
      }, { default: () => h(ApprovalGraphNodeConfigEditor as any, { node, registry }) })
    },
  })
  const app = createApp(Harness)
  installStubs(app)
  app.mount(container)
  mounted.push(() => { app.unmount(); container.remove() })
  return container
}
function mountEditorFlat(node: ApprovalNode, registry: ApprovalCapabilityRegistry, api: ApprovalNodeConfigEditorApi) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const Harness = defineComponent({ name: 'HF', setup() { provide(APPROVAL_NODE_CONFIG_EDITOR_KEY, api); return () => h(ApprovalGraphNodeConfigEditor as any, { node, registry }) } })
  const app = createApp(Harness)
  installStubs(app)
  app.mount(container)
  mounted.push(() => { app.unmount(); container.remove() })
  return container
}

function handlerNode(key = 'handler_h'): ApprovalNode {
  return { key, type: 'handler', name: '办理', config: {} as any }
}

describe('Lock-3 handler config surface + inspector tabs', () => {
  // Lock-3 G-14 explicitly DEFERRED the 操作权限 tab to Lock-5: "`操作权限` MUST NOT render UNTIL
  // Lock-5 lands ≥1 functional server-enforced per-node policy — same gate, same mechanism, one more
  // node type" (Lock-3 §1.5). Lock-5 §1.6 / OD-L5-11(a) has now landed `allowTransfer` for the
  // handler node type (server-enforced at the §2.1 dispatch choke), so the gate's CONDITION is met
  // and the tab renders. The mechanism assertion G-14 exists to prove — that the strip is the
  // registry's doing, not hardcoded — is unchanged and is carried by the empty-registry test below,
  // which is Lock-5 gate E-1's own positive control.
  it('G-14 (Lock-5 §1.6 landed): a handler inspector renders 办理人设置 + 表单权限 + 操作权限 with the shipped registry', () => {
    const api = createStubConfigApi({ handler_h: { nodeType: 'handler', assigneeSources: [{ kind: 'requester' }] } })
    const c = mountInspector(handlerNode(), DEFAULT_APPROVAL_CAPABILITY_REGISTRY, api)
    const tabs = Array.from(c.querySelectorAll('[role="tab"]')).map((t) => t.textContent?.trim())
    expect(tabs).toEqual(['办理人设置', '表单权限', '操作权限'])
  })

  it('G-14 mechanism control: a registry declaring NO handler operation policy renders no 操作权限 tab', () => {
    const registryWithoutOps: ApprovalCapabilityRegistry = {
      assigneeSourcesByNodeType: { handler: assigneeSourceRoster(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'handler') },
      operationPoliciesByNodeType: {},
    }
    const api = createStubConfigApi({ handler_h: { nodeType: 'handler', assigneeSources: [{ kind: 'requester' }] } })
    const c = mountInspector(handlerNode(), registryWithoutOps, api)
    const tabs = Array.from(c.querySelectorAll('[role="tab"]')).map((t) => t.textContent?.trim())
    expect(tabs).toEqual(['办理人设置', '表单权限'])
    expect(c.textContent).not.toContain('操作权限')
  })

  // Lock-5 gate F-1 (FE half) — §1.6 / OD-L5-11(a): a handler admits `allowTransfer` ONLY among the
  // rendered keys. Rendering 允许加签/减签 or 允许回退 here would be M8 theater: Lock-3 §2.2 already
  // 409s those verbs at a handler node, and the backend authoring choke rejects the keys outright.
  it('F-1 (FE): the handler 操作权限 tab renders 允许转交 ONLY — never add/reduce-sign or return', async () => {
    const api = createStubConfigApi({ handler_h: { nodeType: 'handler', assigneeSources: [{ kind: 'requester' }] } })
    const c = mountInspector(handlerNode(), DEFAULT_APPROVAL_CAPABILITY_REGISTRY, api)
    ;(c.querySelector('[data-testid="approval-canvas-inspector-tab-operations"]') as HTMLButtonElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const section = c.querySelector('[data-testid="approval-node-section-operations"]') as HTMLElement
    expect(section).not.toBeNull()
    expect(section.querySelector('[data-testid="approval-node-operation-policy-transfer"]')).not.toBeNull()
    expect(section.querySelectorAll('[data-testid="approval-node-operation-policy-row"]')).toHaveLength(1)
    expect(section.querySelector('[data-testid="approval-node-operation-policy-add_reduce_sign"]')).toBeNull()
    expect(section.querySelector('[data-testid="approval-node-operation-policy-return"]')).toBeNull()
  })

  it('renders the seven-member handler roster; the mode picker (会签/或签) and 办理意见 opt-in; NO approval-only controls (M7)', () => {
    const api = createStubConfigApi({ handler_h: { nodeType: 'handler', assigneeSources: [{ kind: 'requester' }] } })
    const c = mountEditorFlat(handlerNode(), DEFAULT_APPROVAL_CAPABILITY_REGISTRY, api)
    // roster: exactly the seven handler kinds, and NOT continuous_managers / requester_choice.
    const rosterKinds = Array.from(c.querySelectorAll('[data-testid^="approval-node-source-kind-"]'))
      .map((el) => (el.getAttribute('data-testid') || '').replace('approval-node-source-kind-', ''))
      .filter((k) => k !== 'unknown')
    expect(rosterKinds.sort()).toEqual([...HANDLER_ASSIGNEE_SOURCE_KINDS].sort())
    expect(rosterKinds).not.toContain('continuous_managers')
    expect(rosterKinds).not.toContain('requester_choice')
    // handler-only controls present.
    expect(c.querySelector('[data-testid="handler-node-mode"]')).toBeTruthy()
    expect(c.querySelector('[data-testid="handler-node-opinion-required"]')).toBeTruthy()
    // approval-only controls ABSENT (M7 — no inert theater).
    expect(c.querySelector('[data-testid="approval-node-mode"]')).toBeNull()
    expect(c.querySelector('[data-testid="approval-node-empty-policy"]')).toBeNull()
    expect(c.querySelector('[data-testid="approval-node-merge-with-requester"]')).toBeNull()
  })

  it('Lock-7 G-13: a handler field set to readonly renders NO readonly honesty hint (readonly is enforced server-side, not disclosed-as-pending)', () => {
    const api = createStubConfigApi({ handler_h: { nodeType: 'handler', assigneeSources: [{ kind: 'requester' }], fieldPermissions: [{ fieldId: 'amount', access: 'readonly' }] } })
    const c = mountEditorFlat(handlerNode(), DEFAULT_APPROVAL_CAPABILITY_REGISTRY, api)
    // The field-permissions section still renders (the selector remains functional)...
    expect(c.querySelector('[data-testid="approval-node-field-permissions"]')).toBeTruthy()
    // ...but the retired "只读将在后续版本…" not-yet-enforced hint no longer appears (G-13).
    expect(c.querySelector('[data-testid="approval-node-field-readonly-hint"]')).toBeNull()
  })

  it('the mode picker writes the handler edit model (会签→或签)', async () => {
    const api = createStubConfigApi({ handler_h: { nodeType: 'handler', assigneeSources: [{ kind: 'requester' }], handlerMode: 'all' } })
    const c = mountEditorFlat(handlerNode(), DEFAULT_APPROVAL_CAPABILITY_REGISTRY, api)
    const select = c.querySelector('[data-testid="handler-node-mode"]') as HTMLSelectElement
    expect(select.value).toBe('all')
    expect(api.handlerNodeMode('handler_h')).toBe('all')
    select.value = 'any'
    select.dispatchEvent(new Event('change'))
    expect(api.handlerNodeMode('handler_h')).toBe('any')
  })

  // P1-B — master §P1-B: multi-source assignee cards. A handler node's roster is the RATIFIED
  // seven-member subset (Lock-3 §1.5, G-13) — "＋添加办理人" must default the new card from THAT
  // roster, never a hand-picked kind or an approval-only kind (continuous_managers /
  // requester_choice / continuous_dept_heads / dept_head_at_level are all absent from it).
  it('P1-B: "＋添加办理人" defaults the new card from the SEVEN-member handler roster (never an approval-only kind)', () => {
    const api = createStubConfigApi({ handler_h: { nodeType: 'handler', assigneeSources: [{ kind: 'requester' }] } })
    const c = mountEditorFlat(handlerNode(), DEFAULT_APPROVAL_CAPABILITY_REGISTRY, api)

    const addBtn = c.querySelector('[data-testid="approval-node-source-add"]') as HTMLButtonElement
    expect(addBtn).not.toBeNull()
    expect(addBtn.textContent).toContain('办理人') // handler-specific copy, not "审批人"
    addBtn.click()

    const sources = api.approvalNodeEditFor('handler_h')?.assigneeSources as Array<{ kind: string }>
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({ kind: 'requester' }) // untouched
    const newKind = sources[1].kind
    // `requester` specifically (valid with zero config) — NOT the roster's raw first entry
    // (`static_user`, whose zero-config shape fails validation and would disable Save).
    expect(newKind).toBe('requester')
    expect([...HANDLER_ASSIGNEE_SOURCE_KINDS]).toContain(newKind) // in-roster
    expect(['continuous_managers', 'requester_choice', 'continuous_dept_heads', 'dept_head_at_level']).not.toContain(newKind)
  })
})
