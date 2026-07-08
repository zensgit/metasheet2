<template>
  <div class="iu4-wizard" data-testid="composition-wizard">
    <!-- Decorative step indicator only — same rationale as IU-3's IntegrationReadSourceWizard.vue:
         Element Plus is not globally registered in every host that mounts this component in tests,
         and el-steps's own visuals are irrelevant to correctness. All real navigation/gating below is
         driven by plain <button data-testid> + currentStep, never by clicking an el-step header. -->
    <el-steps :active="currentStep - 1" align-center class="iu4-wizard__steps" data-testid="iu4-wizard-steps">
      <el-step :title="bi('①选两跳', '① Pick two hops')" />
      <el-step :title="bi('②接线可视', '② Wiring visual')" />
      <el-step :title="bi('③审批', '③ Approve')" />
    </el-steps>

    <section v-if="currentStep === 1" class="iu4-wizard__step" data-testid="iu4-wizard-step-1">
      <p class="iu4-wizard__step-desc">{{ bi(
        '从已审批的「解析定位读」读取源中选择两跳：第一跳的解析输出将作为第二跳的业务 key。',
        'Pick two hops from the APPROVED "resolver lookup" read sources: hop 1\'s resolved output becomes hop 2\'s business key.',
      ) }}</p>

      <p v-if="pickerError" class="iu4-wizard__error" data-testid="iu4-wizard-picker-error">{{ pickerError }}</p>
      <p v-if="pickerLoading" class="iu4-wizard__step-desc" data-testid="iu4-wizard-picker-loading">{{ bi('加载中…', 'Loading…') }}</p>
      <p v-else-if="resolverConfigs.length === 0" class="iu4-wizard__empty-hint" data-testid="iu4-wizard-no-configs">
        {{ bi(
          '尚无已审批的「解析定位读」读取源，请先在上方「读取源配置」面板配置并审批两个。',
          'No approved "resolver lookup" read sources yet — configure and approve two in the "read-source config" panel above first.',
        ) }}
      </p>
      <template v-else>
        <div class="iu4-wizard__hop-group">
          <h4 class="iu4-wizard__hop-title">{{ bi('第一跳(hop1)', 'Hop 1') }}</h4>
          <div class="iu4-wizard__card-grid" data-testid="iu4-wizard-hop1-grid">
            <button
              v-for="row in resolverConfigs"
              :key="row.id"
              type="button"
              class="iu4-wizard__card"
              :class="{ 'iu4-wizard__card--selected': draft.step1ConfigId === row.id }"
              :data-testid="`iu4-wizard-hop1-${row.id}`"
              @click="draft.step1ConfigId = row.id"
            >
              <el-icon v-if="draft.step1ConfigId === row.id" class="iu4-wizard__card-check"><Check /></el-icon>
              <span class="iu4-wizard__card-title">{{ row.id }} · {{ row.object }}</span>
              <span class="iu4-wizard__card-subtitle">{{ modeBadge(row.mode) }}</span>
            </button>
          </div>
        </div>

        <div class="iu4-wizard__hop-group">
          <h4 class="iu4-wizard__hop-title">{{ bi('第二跳(hop2)', 'Hop 2') }}</h4>
          <div class="iu4-wizard__card-grid" data-testid="iu4-wizard-hop2-grid">
            <button
              v-for="row in resolverConfigs"
              :key="row.id"
              type="button"
              class="iu4-wizard__card"
              :class="{ 'iu4-wizard__card--selected': draft.step2ConfigId === row.id }"
              :data-testid="`iu4-wizard-hop2-${row.id}`"
              @click="draft.step2ConfigId = row.id"
            >
              <el-icon v-if="draft.step2ConfigId === row.id" class="iu4-wizard__card-check"><Check /></el-icon>
              <span class="iu4-wizard__card-title">{{ row.id }} · {{ row.object }}</span>
              <span class="iu4-wizard__card-subtitle">{{ modeBadge(row.mode) }}</span>
            </button>
          </div>
        </div>

        <p v-if="hopsChosenButSame" class="iu4-wizard__error" data-testid="iu4-wizard-hop-same-hint">
          {{ bi('第一跳与第二跳不能是同一个读取源。', 'Hop 1 and hop 2 cannot be the same read source.') }}
        </p>
      </template>
    </section>

    <section v-else-if="currentStep === 2" class="iu4-wizard__step" data-testid="iu4-wizard-step-2">
      <p class="iu4-wizard__step-desc">{{ bi(
        '固定的两跳数据流：第一跳的解析输出字段名 → 第二跳的业务 key 输入。这里只做展示，不能新增跳数或自由编排。',
        'A fixed two-hop data flow: hop 1\'s resolved output field name flows into hop 2\'s business-key input. This is presentation only — no extra hops, no free-form wiring.',
      ) }}</p>

      <label class="iu4-wizard__field">
        <span>sourceTarget（{{ bi('第一跳输出字段名', "hop 1's output field name") }}）</span>
        <input v-model="draft.sourceTarget" data-testid="iu4-wizard-source-target" placeholder="internal_id" />
      </label>

      <!-- Static two-hop wiring diagram (design-lock §1/§2): pure presentation, not a free canvas —
           the shape is fixed at exactly two nodes and one connecting line, always. -->
      <div class="iu4-wizard__wiring" data-testid="iu4-wizard-wiring">
        <div class="iu4-wizard__wiring-node" data-testid="iu4-wizard-wiring-hop1">
          <span class="iu4-wizard__wiring-node-label">{{ bi('第一跳', 'Hop 1') }}</span>
          <span class="iu4-wizard__wiring-node-title">{{ hop1Row ? `${hop1Row.id} · ${hop1Row.object}` : bi('(未选择)', '(not selected)') }}</span>
          <span class="iu4-wizard__wiring-node-io">
            {{ bi('输出字段', 'output field') }}:
            <strong data-testid="iu4-wizard-wiring-output">{{ draft.sourceTarget.trim() || '—' }}</strong>
          </span>
        </div>
        <div class="iu4-wizard__wiring-line" aria-hidden="true">
          <el-icon class="iu4-wizard__wiring-arrow"><Right /></el-icon>
        </div>
        <div class="iu4-wizard__wiring-node" data-testid="iu4-wizard-wiring-hop2">
          <span class="iu4-wizard__wiring-node-label">{{ bi('第二跳', 'Hop 2') }}</span>
          <span class="iu4-wizard__wiring-node-title">{{ hop2Row ? `${hop2Row.id} · ${hop2Row.object}` : bi('(未选择)', '(not selected)') }}</span>
          <span class="iu4-wizard__wiring-node-io">
            {{ bi('key 输入', 'key input') }}:
            <strong data-testid="iu4-wizard-wiring-input">key</strong>
          </span>
        </div>
      </div>
    </section>

    <section v-else class="iu4-wizard__step" data-testid="iu4-wizard-step-3">
      <p class="iu4-wizard__step-desc">{{ bi(
        '命名并保存这次的组合版本，然后提交审批；审批通过后运行时才可选用该组合。',
        'Name and save this composition version, then submit it for approval; only after approval can runtime select this composition.',
      ) }}</p>

      <label class="iu4-wizard__field">
        <span>name（{{ bi('组合标识符', 'composition identifier') }}）</span>
        <input v-model="draft.name" data-testid="iu4-wizard-name" placeholder="material_to_bom_v1" />
      </label>

      <ul v-if="draftProblems.length > 0" class="iu4-wizard__problems" data-testid="iu4-wizard-problems">
        <li v-for="problem in draftProblems" :key="problem">{{ problem }}</li>
      </ul>

      <p v-if="!canWrite" class="iu4-wizard__error" data-testid="iu4-wizard-permission-hint">
        {{ bi(
          '当前用户只有只读权限，不能保存组合（需要 integration:write）。',
          'The current user only has read access and cannot save a composition (requires integration:write).',
        ) }}
      </p>

      <div class="iu4-wizard__actions">
        <button
          type="button"
          class="iu4-wizard__button iu4-wizard__button--primary"
          data-testid="iu4-wizard-save"
          :disabled="!canSave"
          @click="emit('save')"
        >{{ saving ? bi('保存中…', 'Saving…') : bi('保存组合版本', 'Save composition version') }}</button>
      </div>

      <p v-if="actionError" class="iu4-wizard__error" data-testid="iu4-wizard-error">{{ actionError }}</p>
      <ul v-if="saveFieldErrors.length > 0" class="iu4-wizard__problems" data-testid="iu4-wizard-field-errors">
        <li v-for="(entry, index) in saveFieldErrors" :key="index">{{ entry.code }} · {{ entry.field }} · {{ entry.reason }}</li>
      </ul>

      <p v-if="savedRow" class="iu4-wizard__save-result" data-testid="iu4-wizard-save-result">
        {{ savedRow.reused
          ? bi(`已复用现有版本 v${savedRow.version}`, `Reused existing version v${savedRow.version}`)
          : bi(`已保存新版本 v${savedRow.version}`, `Saved new version v${savedRow.version}`) }}
        (status: {{ savedRow.status }})
        —
        {{ bi('前往右侧「已保存组合」提交审批。', 'Go to the "saved composition" panel on the right to submit for approval.') }}
      </p>
    </section>

    <div class="iu4-wizard__nav">
      <button
        type="button"
        class="iu4-wizard__button"
        data-testid="iu4-wizard-back"
        :disabled="currentStep === 1"
        @click="goBack"
      >{{ bi('上一步', 'Back') }}</button>
      <button
        v-if="currentStep < 3"
        type="button"
        class="iu4-wizard__button iu4-wizard__button--primary"
        data-testid="iu4-wizard-next"
        :disabled="(currentStep === 1 && !canAdvanceStep1) || (currentStep === 2 && !canAdvanceStep2)"
        @click="goNext"
      >{{ bi('下一步', 'Next') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
// IU-4 composition config wizard (design-lock
// docs/development/integration-iu4-composition-wizard-design-lock-20260707.md, #3803).
//
// This is a REORDERING SHELL over the existing `IntegrationReadSourceCompositionAuthoringPanel.vue`
// state — same architectural pattern as IU-3's IntegrationReadSourceWizard.vue (see that file's header
// comment). It owns NO service calls and NO independent config model: `draft` is the exact same
// reactive object the parent panel's expert flat-form binds to (passed through as a plain prop and
// mutated in place via v-model-equivalent assignment on its nested fields). Because both surfaces
// write into ONE shared draft and both funnel it through the SAME `saveReadSourceCompositionVersion` /
// `buildReadSourceCompositionPayload` (called only in the parent, itself unchanged), the wizard's
// output is byte-equal to the expert form's by construction — proven empirically in
// IntegrationCompositionWizard.spec.ts's byte-equality test, which drives real DOM inputs through both
// surfaces and diffs the captured wire body.
//
// `save` is EMITTED to the parent, which runs the exact same `save()` function the expert form's own
// button calls — one function, two UI entry points. No new route, no new validator (design-lock §2
// hard lock). Approve/retire/audit are intentionally NOT duplicated here — the parent's existing
// "已保存组合" panel (savedRow block, unconditional on view mode) already renders them for the
// composition just saved, so step ③'s "→提交审批" is satisfied via that existing, un-duplicated UI.
import { computed, ref } from 'vue'
import { Check, Right } from '@element-plus/icons-vue'
import { useLocale } from '../../composables/useLocale'
import { READ_SOURCE_MODES, type ReadSourceConfigRow, type ReadSourceMode } from '../../services/integration/readSourceConfigs'
import { readSourceModePreset } from '../../services/integration/readSourceModePresets'
import {
  validateReadSourceCompositionDraft,
  type ReadSourceCompositionDraft,
  type ReadSourceCompositionFieldError,
  type ReadSourceCompositionSaveResult,
} from '../../services/integration/readSourceCompositions'

const props = defineProps<{
  draft: ReadSourceCompositionDraft
  resolverConfigs: ReadSourceConfigRow[]
  pickerLoading: boolean
  pickerError: string
  canWrite: boolean
  saving: boolean
  actionError: string
  saveFieldErrors: ReadSourceCompositionFieldError[]
  savedRow: ReadSourceCompositionSaveResult | null
}>()

const emit = defineEmits<{
  (e: 'save'): void
}>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const READ_SOURCE_MODE_SET: ReadonlySet<string> = new Set(READ_SOURCE_MODES)
function modeBadge(mode: string): string {
  if (!READ_SOURCE_MODE_SET.has(mode)) return mode
  const preset = readSourceModePreset(mode as ReadSourceMode)
  return bi(preset.title.zh, preset.title.en)
}

const currentStep = ref<1 | 2 | 3>(1)

const hop1Row = computed(() => props.resolverConfigs.find((row) => row.id === props.draft.step1ConfigId) ?? null)
const hop2Row = computed(() => props.resolverConfigs.find((row) => row.id === props.draft.step2ConfigId) ?? null)
const hopsChosenButSame = computed(() => {
  const a = props.draft.step1ConfigId.trim()
  const b = props.draft.step2ConfigId.trim()
  return a.length > 0 && b.length > 0 && a === b
})
const canAdvanceStep1 = computed(() => {
  const a = props.draft.step1ConfigId.trim()
  const b = props.draft.step2ConfigId.trim()
  return a.length > 0 && b.length > 0 && a !== b
})
const canAdvanceStep2 = computed(() => props.draft.sourceTarget.trim().length > 0)

// Same pure validator the parent's own `draftProblems` uses (readSourceCompositions.ts) — the wizard
// never invents its own validation rule, so it can never drift from the flat form's or the server's.
const draftProblems = computed(() => validateReadSourceCompositionDraft(props.draft))
const canSave = computed(() => !props.saving && props.canWrite && draftProblems.value.length === 0)

function goNext(): void {
  if (currentStep.value === 1 && !canAdvanceStep1.value) return
  if (currentStep.value === 2 && !canAdvanceStep2.value) return
  if (currentStep.value === 1) currentStep.value = 2
  else if (currentStep.value === 2) currentStep.value = 3
}

function goBack(): void {
  if (currentStep.value === 3) currentStep.value = 2
  else if (currentStep.value === 2) currentStep.value = 1
}
</script>

<style scoped>
/* Token-only (UF-1 / design-lock §2/§3 hard lock) — every style in this file uses var(--ms-*), zero
   hex/rgb literals; enforced by ui-foundation-style-guard.spec.ts (this file is in TARGET_FILES).
   Class names/values copied verbatim from IU-3's IntegrationReadSourceWizard.vue (same component
   vocabulary, design-lock §2 "复用 IU-3 组件语汇"), prefixed iu4-wizard instead of iu3-wizard. */
.iu4-wizard {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}
.iu4-wizard__steps {
  margin-bottom: var(--ms-space-2);
}
.iu4-wizard__step {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}
.iu4-wizard__step-desc {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
}
.iu4-wizard__hop-group {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}
.iu4-wizard__hop-title {
  margin: 0;
  font-size: 13px;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}
.iu4-wizard__card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--ms-space-3);
}
.iu4-wizard__card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ms-space-1);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.iu4-wizard__card:hover {
  border-color: var(--ms-color-primary);
}
.iu4-wizard__card--selected {
  border-color: var(--ms-color-primary);
  box-shadow: var(--ms-shadow-card);
}
.iu4-wizard__card-check {
  position: absolute;
  top: var(--ms-space-2);
  right: var(--ms-space-2);
  color: var(--ms-color-primary);
}
.iu4-wizard__card-title {
  font-size: 14px;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}
.iu4-wizard__card-subtitle {
  font-size: 12px;
  color: var(--ms-text-2);
}
.iu4-wizard__empty-hint {
  color: var(--ms-text-3);
  font-size: 13px;
}
.iu4-wizard__field {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 13px;
}
.iu4-wizard__field input {
  padding: var(--ms-space-1) var(--ms-space-2);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
}
.iu4-wizard__problems {
  margin: 0;
  padding-left: var(--ms-space-4);
  color: var(--ms-color-warning);
  font-size: 12px;
}
/* Static two-hop wiring diagram (design-lock §2 "接线图 = 纯展示"): a fixed row of exactly two nodes
   plus one connecting line — no free-canvas layout primitives, no dynamic node count. */
.iu4-wizard__wiring {
  display: flex;
  align-items: center;
  gap: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-4);
}
.iu4-wizard__wiring-node {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
  font-size: 13px;
}
.iu4-wizard__wiring-node-label {
  font-size: 12px;
  color: var(--ms-text-3);
}
.iu4-wizard__wiring-node-title {
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}
.iu4-wizard__wiring-node-io {
  color: var(--ms-text-2);
}
.iu4-wizard__wiring-line {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ms-color-primary);
  font-size: 20px;
}
.iu4-wizard__actions {
  display: flex;
  gap: var(--ms-space-2);
}
.iu4-wizard__button {
  padding: var(--ms-space-1) var(--ms-space-3);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-size: 13px;
}
.iu4-wizard__button:disabled {
  cursor: not-allowed;
  color: var(--ms-text-3);
}
.iu4-wizard__button--primary {
  border-color: var(--ms-color-primary);
  background: var(--ms-color-primary);
  color: var(--ms-bg-card);
}
.iu4-wizard__button--primary:disabled {
  background: var(--ms-border);
  border-color: var(--ms-border);
  color: var(--ms-bg-card);
}
.iu4-wizard__error {
  color: var(--ms-color-danger);
  font-size: 13px;
}
.iu4-wizard__save-result {
  color: var(--ms-color-success);
  font-size: 13px;
}
.iu4-wizard__nav {
  display: flex;
  justify-content: space-between;
  border-top: 1px solid var(--ms-border-light);
  padding-top: var(--ms-space-3);
}
</style>
