// Browser-verification harness (dev/CI only — NOT part of the app build/typecheck; lives outside
// src/ so vue-tsc + vite build ignore it). Mounts the REAL ApprovalCanvasNodeInspector.vue +
// ApprovalGraphNodeConfigEditor.vue — the exact shipped markup (native `role="radiogroup"` +
// `input[type=radio]` roster; native `role="tablist"`/`role="tab"` tab strip) — via the same
// provide/inject wiring (`APPROVAL_NODE_CONFIG_EDITOR_KEY`) TemplateAuthoringView.vue uses in
// production, so a real browser drives the real shipped DOM, not a hand-copied replica.
//
// Element Plus itself is stubbed with plain native elements, mirroring the convention already
// established in apps/web/tests/approval-template-authoring-canvas-inspector.spec.ts's
// `installStubs` — this harness deliberately isolates the ONE thing jsdom cannot execute at all
// (native radio-group / tablist keyboard semantics in a real browser — gate PR #4944 P1-1 "Link B"
// / A-13) from Element Plus's own widget behavior, which is unrelated and already covered by the
// existing jsdom suite + this repo's other verification harnesses.
//
// `setApprovalSourceKind` below MIRRORS (does not re-derive) the P1-1 fix landed in
// TemplateAuthoringView.vue: before switching kind, cache the outgoing per-kind payload; if
// switching TO a kind with a cached payload, restore it verbatim. Mounting the full
// TemplateAuthoringView (router + template-load API mocking) is out of scope for this fixture per
// the gate's own adjudication ("a fixture page or a component-level browser mount, not the full
// app"). The LOGIC correctness of the real production `setApprovalSourceKind` is pinned separately
// by a full-mount jsdom regression test in approval-template-authoring-canvas-inspector.spec.ts
// (search "P1-1 regression") that fails red if that function's algorithm regresses to lossy. This
// harness's job is narrower and browser-only: does a REAL ArrowDown/ArrowUp keypress on the REAL
// native radio markup actually commit (Link B), and does the REST of the shipped UI (echo line,
// tab strip roving tabindex, toolbar/tablist non-crossing) behave correctly around that.
//
// FAIL-5 fix (P7-R2, 20260818): production theme + design tokens, exactly as
// apps/web/src/main.ts loads them. Without these every `var(--el-*)`/`var(--ms-*)` reference in
// ApprovalCanvasNodeInspector.vue / ApprovalGraphNodeConfigEditor.vue's scoped CSS is undefined,
// so Chromium drops the whole declaration and any focus-ring / paint measurement over this
// harness is vacuously empty. CSS-only — deliberately NOT `import ElementPlus from 'element-plus'`
// + `.use(ElementPlus)`: this harness stubs Element Plus with the native elements below on
// purpose (see the header comment above) so a real browser measures native radiogroup/tablist
// keyboard semantics, not Element Plus's own widget behavior. Registering the plugin would let
// unstubbed `<el-*>` tags (e.g. `<el-input>` below) silently resolve to the real component,
// changing what this spec measures for zero contrast benefit.
import 'element-plus/dist/index.css'
import '../src/styles/tokens.css'
import { computed, createApp, defineComponent, h, ref } from 'vue'
import ApprovalCanvasNodeInspector from '../src/approvals/components/ApprovalCanvasNodeInspector.vue'
import ApprovalGraphNodeConfigEditor from '../src/approvals/components/ApprovalGraphNodeConfigEditor.vue'
import { APPROVAL_NODE_CONFIG_EDITOR_KEY, type ApprovalNodeConfigEditorApi } from '../src/approvals/nodeConfigEditorContext'
import type { ApprovalAssigneeSource, ApprovalAssigneeSourceKind, ApprovalNode } from '../src/types/approval'

const node: ApprovalNode = { key: 'app_b', type: 'approval', name: '分支 B', config: {} }

// Seed: static_role with roleIds:['legal'] — the exact fixture the gate's Link A / FIX-1
// instructions name.
const assigneeSources = ref<ApprovalAssigneeSource[]>([{ kind: 'static_role', roleIds: ['legal'] }])

const kindCache: Partial<Record<ApprovalAssigneeSourceKind, ApprovalAssigneeSource>> = {}
function cloneSource(source: ApprovalAssigneeSource): ApprovalAssigneeSource {
  return JSON.parse(JSON.stringify(source)) as ApprovalAssigneeSource
}
function defaultForKind(kind: ApprovalAssigneeSourceKind): ApprovalAssigneeSource {
  return kind === 'static_user' ? { kind, userIds: [] }
    : kind === 'static_role' ? { kind, roleIds: [] }
      : kind === 'form_field_user' ? { kind, fieldId: '' }
        : kind === 'continuous_managers' ? { kind, levels: 1 }
          : kind === 'manager_at_level' ? { kind, level: 1 }
            : { kind }
}

const changeEventLog = ref<string[]>([])

const api: ApprovalNodeConfigEditorApi = {
  readOnly: false,
  conditionEditFor: () => undefined,
  parallelEditFor: () => undefined,
  ccEditFor: () => undefined,
  approvalNodeEditFor: (key) =>
    key === node.key ? { nodeKey: node.key, assigneeSources: assigneeSources.value } : undefined,
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
  graphNodeLabel: (key: string) => key,
  parallelJoinModeLabel: () => '',
  ccTargetTypeLabel: () => '用户',
  setCcTargetIds: () => {},
  syncCcOptions: () => {},
  approvalSourceKind: (key) => (key === node.key ? assigneeSources.value[0]?.kind ?? 'requester' : 'requester'),
  // P1-1 fix mirror — see file header comment.
  setApprovalSourceKind: (key, kind) => {
    changeEventLog.value = [...changeEventLog.value, `change:${kind}`]
    if (key !== node.key) return
    const current = assigneeSources.value[0]
    if (current && current.kind !== kind) kindCache[current.kind] = cloneSource(current)
    const cached = kindCache[kind]
    const next = cached ? cloneSource(cached) : defaultForKind(kind)
    assigneeSources.value = [next, ...assigneeSources.value.slice(1)]
  },
  syncApprovalNodeOptions: () => {},
  approvalSourceIds: (key) => {
    const source = key === node.key ? assigneeSources.value[0] : undefined
    if (source?.kind === 'static_user') return source.userIds
    if (source?.kind === 'static_role') return source.roleIds
    return []
  },
  setApprovalSourceIdsFromPicker: (key, ids) => {
    if (key !== node.key) return
    const source = assigneeSources.value[0]
    if (source?.kind === 'static_user') source.userIds = ids
    else if (source?.kind === 'static_role') source.roleIds = ids
  },
  approvalSourceFieldId: (key) => {
    const source = key === node.key ? assigneeSources.value[0] : undefined
    return source?.kind === 'form_field_user' ? source.fieldId : ''
  },
  setApprovalSourceFieldId: (key, fieldId) => {
    if (key !== node.key) return
    const source = assigneeSources.value[0]
    if (source?.kind === 'form_field_user') source.fieldId = fieldId
  },
  approvalSourceLevel: (key) => {
    const source = key === node.key ? assigneeSources.value[0] : undefined
    if (source?.kind === 'manager_at_level') return source.level
    if (source?.kind === 'continuous_managers') return source.levels
    return 1
  },
  setApprovalSourceLevel: (key, value) => {
    if (key !== node.key) return
    const source = assigneeSources.value[0]
    if (source?.kind === 'manager_at_level') source.level = value
    else if (source?.kind === 'continuous_managers') source.levels = value
  },
  approvalSourceIsPlaceholder: () => false,
  approvalNodeMode: () => 'single',
  setApprovalNodeMode: () => {},
  approvalNodeEmptyPolicy: () => 'error',
  setApprovalNodeEmptyPolicy: () => {},
  approvalNodeMergeWithRequester: () => false,
  setApprovalNodeMergeWithRequester: () => {},
  approvalNodeFieldAccess: () => 'editable',
  setApprovalNodeFieldAccess: () => {},
  nodeConfigSummary: () => [],
  onUserSearch: () => {},
  directoryUsers: [],
  directoryUsersLoading: false,
  directoryRoles: [{ id: 'legal', name: '法务' }],
  formulaRoles: [],
  formatUserLabel: (u: { id: string; name?: string }) => u.name ?? u.id,
  formatRoleLabel: (r: { id: string; name?: string }) => r.name ?? r.id,
}

// Minimal native-element stand-ins for Element Plus (see file header) — same idiom as the jsdom
// spec's `installStubs`.
const ElButton = defineComponent({
  props: { disabled: Boolean, text: Boolean, size: String, type: String },
  emits: ['click'],
  render() {
    return h(
      'button',
      {
        type: 'button',
        disabled: this.disabled,
        'data-testid': (this.$attrs as Record<string, unknown>)['data-testid'],
        onClick: (event: Event) => this.$emit('click', event),
      },
      this.$slots.default?.(),
    )
  },
})
const ElSelect = defineComponent({
  props: { modelValue: [String, Array], disabled: Boolean },
  emits: ['update:modelValue', 'change'],
  render() {
    return h(
      'select',
      {
        value: this.modelValue ?? '',
        disabled: this.disabled,
        'data-testid': (this.$attrs as Record<string, unknown>)['data-testid'],
        onChange: (event: Event) => {
          const value = (event.target as HTMLSelectElement).value
          this.$emit('update:modelValue', value)
          this.$emit('change', value)
        },
      },
      this.$slots.default?.(),
    )
  },
})
const ElOption = defineComponent({
  props: { label: String, value: String },
  render() {
    return h('option', { value: this.value }, this.label)
  },
})
const ElCheckbox = defineComponent({
  inheritAttrs: false,
  props: { modelValue: Boolean, disabled: Boolean },
  emits: ['update:modelValue'],
  render() {
    return h('label', [
      h('input', {
        type: 'checkbox',
        checked: this.modelValue,
        disabled: this.disabled,
        'data-testid': (this.$attrs as Record<string, unknown>)['data-testid'],
        onChange: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLInputElement).checked),
      }),
      this.$slots.default?.(),
    ])
  },
})
const passthrough = (tag = 'div') =>
  defineComponent({
    render() {
      return h(tag, { 'data-testid': (this.$attrs as Record<string, unknown>)['data-testid'] }, this.$slots.default?.())
    },
  })

const eventLogText = computed(() => changeEventLog.value.join(', ') || '(none yet)')

const Harness = defineComponent({
  setup() {
    return () =>
      h('div', { style: 'max-width:480px' }, [
        h(
          'div',
          { 'data-test': 'change-event-log', style: 'font-size:12px;color:#555;margin-bottom:8px' },
          `radio "change" events fired: ${eventLogText.value}`,
        ),
        h(
          ApprovalCanvasNodeInspector,
          {
            node,
            readOnly: false,
            movingCanvasNode: null,
            graphNodeLabel: (key: string) => key,
            nodeTypeLabel: (type: string) => type,
            canMoveCanvasNode: () => false,
            canvasStepMoveTarget: () => undefined,
            // A-12 boundary check needs a REAL focusable control inside the toolbar to arrow-key
            // against (mirrors the jsdom A-12 test's `approval-canvas-insert-*` button).
            canInsertAfter: () => true,
            canInsertParallelAfter: () => false,
            canRemoveNode: () => false,
          },
          { default: () => h(ApprovalGraphNodeConfigEditor, { node }) },
        ),
      ])
  },
})

const app = createApp(Harness)
app.provide(APPROVAL_NODE_CONFIG_EDITOR_KEY, api)
app.component('ElButton', ElButton)
app.component('ElSelect', ElSelect)
app.component('ElOption', ElOption)
app.component('ElCheckbox', ElCheckbox)
app.component('ElFormItem', passthrough('label'))
app.component('ElInputNumber', passthrough('div'))
app.component('ElAlert', passthrough('div'))
app.component('ElIcon', passthrough('span'))
app.mount('#app')
