// Browser-verification harness (dev/CI only — NOT part of the app build/typecheck via the DEFAULT
// tsconfig.app.json; lives outside src/ so vite build ignores it). This ONE file, however, IS
// covered by tsconfig.verification-approval.json (see that file's header) — a standalone,
// non-composite project that type-checks it against the SAME live src/ tree, specifically so a
// future `ApprovalNodeConfigEditorApi` change cannot rot this harness silently again (P7-R1 /
// FAIL-1 rot-class closure: 8 missing members + a 2-vs-3-arg signature drift on
// `setApprovalSourceKind` produced ZERO compile-time signal before this file existed, because
// `vue-tsc -b`'s only referenced project is `src/**`).
//
// Mounts the REAL ApprovalCanvasNodeInspector.vue + ApprovalGraphNodeConfigEditor.vue — the exact
// shipped markup (native `role="radiogroup"` + `input[type=radio]` roster; native `role="tablist"`/
// `role="tab"` tab strip) — via the same provide/inject wiring (`APPROVAL_NODE_CONFIG_EDITOR_KEY`)
// TemplateAuthoringView.vue uses in production, so a real browser drives the real shipped DOM, not
// a hand-copied replica.
//
// Element Plus itself is stubbed with plain native elements, mirroring the convention already
// established in apps/web/tests/approval-template-authoring-canvas-inspector.spec.ts's
// `installStubs` — this harness deliberately isolates the ONE thing jsdom cannot execute at all
// (native radio-group / tablist keyboard semantics in a real browser — gate PR #4944 P1-1 "Link B"
// / A-13) from Element Plus's own widget behavior, which is unrelated and already covered by the
// existing jsdom suite + this repo's other verification harnesses.
//
// The `api` object below MIRRORS (does not re-derive) TemplateAuthoringView.vue's node-config-
// editor accessors — same field shapes, same `approvalSourceKindCache` per-(nodeKey,sourceIndex)
// payload-preservation strategy (P1-1 fix), same P1-B sourceIndex threading. Mounting the full
// TemplateAuthoringView (router + template-load API mocking) is out of scope for this fixture per
// the gate's own adjudication ("a fixture page or a component-level browser mount, not the full
// app"). The LOGIC correctness of the real production accessors is pinned separately by full-mount
// jsdom regression tests in approval-template-authoring-canvas-inspector.spec.ts (search "P1-1
// regression"). This harness's job is narrower and browser-only: does a REAL ArrowDown/ArrowUp
// keypress on the REAL native radio markup actually commit (Link B), and does the REST of the
// shipped UI (echo line, tab strip roving tabindex, toolbar/tablist non-crossing) behave correctly
// around that.
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
import type { ApprovalAssigneeSource, ApprovalAssigneeSourceKind, ApprovalNode, HandlerMode } from '../src/types/approval'

const node: ApprovalNode = { key: 'app_b', type: 'approval', name: '分支 B', config: {} }

// Seed: static_role with roleIds:['legal'] — the exact fixture the gate's Link A / FIX-1
// instructions name.
const assigneeSources = ref<ApprovalAssigneeSource[]>([{ kind: 'static_role', roleIds: ['legal'] }])

function sourceAt(key: string, sourceIndex: number): ApprovalAssigneeSource | undefined {
  return key === node.key ? assigneeSources.value[sourceIndex] : undefined
}
// P1-B: replace ONLY the card at sourceIndex, mirroring setApprovalNodeSourceAt's out-of-range
// no-op refusal.
function setSourceAt(key: string, sourceIndex: number, source: ApprovalAssigneeSource): void {
  if (key !== node.key) return
  if (sourceIndex < 0 || sourceIndex >= assigneeSources.value.length) return
  const next = assigneeSources.value.slice()
  next[sourceIndex] = source
  assigneeSources.value = next
}

// P1-1 payload-preservation cache, keyed by `${nodeKey}:${sourceIndex}` — mirrors
// TemplateAuthoringView.vue's `approvalSourceKindCache`.
const kindCache: Record<string, Partial<Record<ApprovalAssigneeSourceKind, ApprovalAssigneeSource>>> = {}
function cacheKeyFor(nodeKey: string, sourceIndex: number): string {
  return `${nodeKey}:${sourceIndex}`
}
function cloneSource(source: ApprovalAssigneeSource): ApprovalAssigneeSource {
  return JSON.parse(JSON.stringify(source)) as ApprovalAssigneeSource
}
// Mirrors TemplateAuthoringView.vue's defaultApprovalSourceForKind exactly — every current
// ApprovalAssigneeSourceKind that carries its own required extra field(s) has its own named arm;
// only the three trivial `{ kind }`-only members (requester/direct_manager/dept_head) share the
// fallback. A future kind landing with its own required extra field(s) and no named arm here
// would silently type-check against that fallback's cast and only fail at runtime — exactly
// FAIL-1's rot class — so any new member with extra fields MUST get its own arm here, mirroring
// production.
function defaultForKind(kind: ApprovalAssigneeSourceKind): ApprovalAssigneeSource {
  return kind === 'static_user' ? { kind, userIds: [] }
    : kind === 'static_role' ? { kind, roleIds: [] }
      : kind === 'form_field_user' ? { kind, fieldId: '' }
        : kind === 'continuous_managers' ? { kind, levels: 1 }
          : kind === 'manager_at_level' ? { kind, level: 1 }
            : kind === 'requester_choice' ? { kind, mode: 'single', scope: { type: 'company' } }
              : kind === 'continuous_dept_heads' ? { kind, levels: 1 }
                : kind === 'dept_head_at_level' ? { kind, level: 1 }
                  // Lock-1 §K3: '' = not yet chosen — mirrors production's own comment: invalid
                  // to save until the typed picker selects a legal upstream node.
                  : kind === 'prior_node_approver' ? { kind, nodeKey: '' }
                    : { kind: kind as 'requester' | 'direct_manager' | 'dept_head' }
}

const changeEventLog = ref<string[]>([])
const handlerMode = ref<HandlerMode>('all')
const handlerOpinionRequired = ref(false)

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
  graphNodeLabel: (key) => key,
  parallelJoinModeLabel: () => '',
  ccTargetTypeLabel: () => '用户',
  setCcTargetIds: () => {},
  syncCcOptions: () => {},
  approvalSourceKind: (key, sourceIndex) => sourceAt(key, sourceIndex)?.kind ?? 'requester',
  // P1-1 fix mirror (see file header) — 3-arg (nodeKey, sourceIndex, kind), current contract.
  setApprovalSourceKind: (key, sourceIndex, kind) => {
    changeEventLog.value = [...changeEventLog.value, `change:${kind}`]
    if (key !== node.key) return
    const cacheKey = cacheKeyFor(key, sourceIndex)
    const current = sourceAt(key, sourceIndex)
    if (current && current.kind !== kind) {
      const cacheForCard = kindCache[cacheKey] ?? {}
      cacheForCard[current.kind] = cloneSource(current)
      kindCache[cacheKey] = cacheForCard
    }
    const cached = kindCache[cacheKey]?.[kind]
    setSourceAt(key, sourceIndex, cached ? cloneSource(cached) : defaultForKind(kind))
  },
  syncApprovalNodeOptions: () => {},
  approvalSourceIds: (key, sourceIndex) => {
    const source = sourceAt(key, sourceIndex)
    if (source?.kind === 'static_user') return source.userIds
    if (source?.kind === 'static_role') return source.roleIds
    return []
  },
  setApprovalSourceIdsFromPicker: (key, sourceIndex, ids) => {
    const source = sourceAt(key, sourceIndex)
    if (source?.kind === 'static_user') setSourceAt(key, sourceIndex, { ...source, userIds: ids })
    else if (source?.kind === 'static_role') setSourceAt(key, sourceIndex, { ...source, roleIds: ids })
  },
  approvalSourceFieldId: (key, sourceIndex) => {
    const source = sourceAt(key, sourceIndex)
    return source?.kind === 'form_field_user' ? source.fieldId : ''
  },
  setApprovalSourceFieldId: (key, sourceIndex, fieldId) => {
    setSourceAt(key, sourceIndex, { kind: 'form_field_user', fieldId })
  },
  approvalSourceLevel: (key, sourceIndex) => {
    const source = sourceAt(key, sourceIndex)
    if (source?.kind === 'manager_at_level') return source.level
    if (source?.kind === 'continuous_managers') return source.levels
    if (source?.kind === 'continuous_dept_heads') return source.levels
    if (source?.kind === 'dept_head_at_level') return source.level
    return 1
  },
  setApprovalSourceLevel: (key, sourceIndex, value) => {
    const kind = sourceAt(key, sourceIndex)?.kind
    if (kind === 'manager_at_level') setSourceAt(key, sourceIndex, { kind, level: value })
    else if (kind === 'continuous_managers') setSourceAt(key, sourceIndex, { kind, levels: value })
    else if (kind === 'continuous_dept_heads') setSourceAt(key, sourceIndex, { kind, levels: value })
    else if (kind === 'dept_head_at_level') setSourceAt(key, sourceIndex, { kind, level: value })
  },
  approvalSourceIsPlaceholder: () => false,
  // P1-B: card count for the v-for + the "keep ≥1" remove-guard's disabled state.
  approvalSourceCount: (key) => (key === node.key ? assigneeSources.value.length : 0),
  addApprovalSourceCard: (key, defaultKind) => {
    if (key !== node.key) return
    assigneeSources.value = [...assigneeSources.value, defaultForKind(defaultKind)]
  },
  // Fail-closed: refuses (no-op) when the node has exactly one source — mirrors
  // removeAssigneeSourceCard's ≥1-source guard living in the mutator itself, not only in a
  // disabled button.
  removeApprovalSourceCard: (key, sourceIndex) => {
    if (key !== node.key) return
    if (assigneeSources.value.length <= 1) return
    assigneeSources.value = assigneeSources.value.filter((_, index) => index !== sourceIndex)
  },
  approvalNodeMode: () => 'single',
  setApprovalNodeMode: () => {},
  // P1-C (T2-4 N-of-M / 门槛会签) + (T1-1) node-level timeout — out of THIS harness's scoped
  // interaction surface (roster ArrowDown/ArrowUp + tab strip only, see file header); stubbed
  // inert like approvalNodeMode/setApprovalNodeMode above, not wired to a live edit model.
  approvalNodeThreshold: () => 1,
  setApprovalNodeThreshold: () => {},
  approvalNodeInParallelRegion: () => false,
  approvalNodeTimeout: () => undefined,
  setApprovalNodeTimeoutEnabled: () => {},
  setApprovalNodeTimeoutAfterMinutes: () => {},
  setApprovalNodeTimeoutEffect: () => {},
  setApprovalNodeTimeoutTransferToUserId: () => {},
  setApprovalNodeTimeoutJumpToNodeKey: () => {},
  setApprovalNodeTimeoutUnit: () => {},
  timeoutJumpTargetOptions: () => [],
  approvalNodeEmptyPolicy: () => 'error',
  setApprovalNodeEmptyPolicy: () => {},
  approvalNodeMergeWithRequester: () => false,
  setApprovalNodeMergeWithRequester: () => {},
  // Lock-3 §1.1 — handler-node mode (会签/或签) + 办理意见 required.
  handlerNodeMode: () => handlerMode.value,
  setHandlerNodeMode: (_key, mode) => { handlerMode.value = mode },
  handlerNodeOpinionRequired: () => handlerOpinionRequired.value,
  setHandlerNodeOpinionRequired: (_key, required) => { handlerOpinionRequired.value = required },
  approvalNodeFieldAccess: () => 'editable',
  setApprovalNodeFieldAccess: () => {},
  nodeConfigSummary: () => [],
  // Lock-0 L0-6/D5 — optional per the interface's own doc comment; this fixture has no
  // form_field_user routing-driver scenario, so an empty set is the honest value.
  routingDriverFieldIds: new Set<string>(),
  onUserSearch: () => {},
  directoryUsers: [],
  directoryUsersLoading: false,
  directoryRoles: [{ id: 'legal' }],
  formulaRoles: [],
  formatUserLabel: (u) => u.name ?? u.id,
  formatRoleLabel: (r) => r.name ?? r.id,
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
