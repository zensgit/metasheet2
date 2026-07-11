<template>
  <div class="iu3-wizard" data-testid="read-source-wizard">
    <!-- Decorative step indicator only — Element Plus is NOT globally registered in every host that
         mounts this component in tests, and el-steps's own visuals are irrelevant to correctness.
         All real navigation/gating below is driven by plain <button data-testid> + currentStep,
         never by clicking an el-step header. -->
    <el-steps :active="currentStep - 1" align-center class="iu3-wizard__steps" data-testid="rsc-wizard-steps">
      <el-step :title="bi('①选系统', '① Pick system')" />
      <el-step :title="bi('②定形状', '② Define shape')" />
      <el-step :title="bi('③探测', '③ Probe')" />
      <el-step :title="bi('④审批', '④ Approve')" />
    </el-steps>

    <section v-if="currentStep === 1" class="iu3-wizard__step" data-testid="rsc-wizard-step-1">
      <p class="iu3-wizard__step-desc">{{ bi(
        '从已注册的外部系统中选择一个作为本次读取源的来源系统；选定后自动带出兼容的 requiredKind。',
        'Pick a registered external system as the source for this read source; the compatible requiredKind is filled in automatically.',
      ) }}</p>
      <div class="iu3-wizard__card-grid" data-testid="rsc-wizard-system-grid">
        <button
          v-for="system in systems"
          :key="system.id"
          type="button"
          class="iu3-wizard__card"
          :class="{ 'iu3-wizard__card--selected': draft.systemId === system.id }"
          :data-testid="`rsc-wizard-system-${system.id}`"
          @click="selectSystem(system)"
        >
          <el-icon v-if="draft.systemId === system.id" class="iu3-wizard__card-check"><Check /></el-icon>
          <span class="iu3-wizard__card-title">{{ system.name }}</span>
          <span class="iu3-wizard__card-subtitle">{{ system.kind }}</span>
        </button>
      </div>
      <p v-if="systems.length === 0" class="iu3-wizard__empty-hint" data-testid="rsc-wizard-no-systems">
        {{ bi(
          '尚无已注册的外部系统，请先在连接管理里添加一个。',
          'No external systems are registered yet — add one in connection management first.',
        ) }}
      </p>
    </section>

    <section v-else-if="currentStep === 2" class="iu3-wizard__step" data-testid="rsc-wizard-step-2">
      <p class="iu3-wizard__step-desc">{{ bi(
        '选择这次读取的形状；只展开该形状必填的字段，其余可选字段收进下面的「高级」区。',
        "Choose the shape of this read; only that shape's required fields are shown — the rest are optional and live in the Advanced section below.",
      ) }}</p>
      <div class="iu3-wizard__card-grid" data-testid="rsc-wizard-preset-grid">
        <button
          v-for="preset in READ_SOURCE_MODE_PRESETS"
          :key="preset.id"
          type="button"
          class="iu3-wizard__card"
          :class="{ 'iu3-wizard__card--selected': draft.mode === preset.id }"
          :data-testid="`rsc-wizard-mode-${preset.id}`"
          @click="selectMode(preset.id)"
        >
          <el-icon v-if="draft.mode === preset.id" class="iu3-wizard__card-check"><Check /></el-icon>
          <span class="iu3-wizard__card-title">{{ bi(preset.title.zh, preset.title.en) }}</span>
          <span class="iu3-wizard__card-subtitle">{{ bi(preset.oneLiner.zh, preset.oneLiner.en) }}</span>
        </button>
      </div>

      <label class="iu3-wizard__field">
        <span>object</span>
        <input v-model="draft.object" data-testid="rsc-wizard-object" placeholder="material" />
      </label>
      <label class="iu3-wizard__field">
        <span>readPath</span>
        <input v-model="draft.readPath" data-testid="rsc-wizard-read-path" placeholder="/K3API/Material/GetDetail" />
      </label>

      <label v-if="requiredKeys.includes('keyField')" class="iu3-wizard__field">
        <span>keyField（{{ bi('必填', 'required') }}）</span>
        <input v-model="draft.keyField" data-testid="rsc-wizard-key-field" placeholder="FNumber" />
      </label>

      <label v-if="requiredKeys.includes('containerPaths')" class="iu3-wizard__field">
        <span>containerPaths（{{ bi('必填', 'required') }}）</span>
        <input v-model="draft.containerPaths" data-testid="rsc-wizard-container-paths" placeholder="Data.Data, Data.DATA" />
      </label>

      <template v-if="requiredKeys.includes('headerContainerPaths')">
        <label class="iu3-wizard__field">
          <span>headerContainerPaths（{{ bi('必填', 'required') }}）</span>
          <input v-model="draft.headerContainerPaths" data-testid="rsc-wizard-header-container-paths" placeholder="Data.Page1" />
        </label>
      </template>
      <template v-if="requiredKeys.includes('lineContainerPaths')">
        <label class="iu3-wizard__field">
          <span>lineContainerPaths（{{ bi('必填', 'required') }}）</span>
          <input v-model="draft.lineContainerPaths" data-testid="rsc-wizard-line-container-paths" placeholder="Data.Page2" />
        </label>
      </template>

      <label v-if="requiredKeys.includes('resolverRule')" class="iu3-wizard__field">
        <span>resolverRule（{{ bi('必填', 'required') }}）</span>
        <select v-model="draft.resolverRule" data-testid="rsc-wizard-resolver-rule">
          <option value="">{{ bi('选择解析规则…', 'Choose a resolver rule…') }}</option>
          <option v-for="rule in RESOLVER_RULES" :key="rule" :value="rule">{{ rule }}</option>
        </select>
      </label>

      <ul v-if="validationProblems.length > 0" class="iu3-wizard__problems" data-testid="rsc-wizard-validation">
        <li v-for="problem in validationProblems" :key="problem">{{ problem }}</li>
      </ul>

      <!-- Advanced/optional fields (design-lock §2: keyEncoding / resolver rule detail / multi-fieldMap)
           — a plain toggled <div>, not <el-collapse>: that component's open/close-on-click behavior
           is Element Plus's own internal JS, which is a no-op when EP isn't globally registered
           (this component's own spec stubs only what it needs — see spec header). A native button +
           v-show works identically in every host. -->
      <div class="iu3-wizard__advanced">
        <button
          type="button"
          class="iu3-wizard__advanced-toggle"
          data-testid="rsc-wizard-advanced-toggle"
          @click="advancedOpen = !advancedOpen"
        >
          <el-icon><ArrowDown v-if="advancedOpen" /><ArrowRight v-else /></el-icon>
          {{ bi('高级(可选字段)', 'Advanced (optional fields)') }}
        </button>
        <div v-show="advancedOpen" class="iu3-wizard__advanced-body" data-testid="rsc-wizard-advanced-panel">
          <!-- Full capability parity with the expert flat form (design-lock §2 专家不降级 + byte-equal
               output): every optional field the flat form can set is reachable here too — an optional
               keyField (detail_with_lines only; it is REQUIRED and rendered in the main step-2 section
               for single_record / resolver_lookup), keyEncoding for any keyed mode (mirrors the flat
               form's `showKeyField` = mode !== 'list_page'), readMethod, and version. -->
          <label v-if="showOptionalKeyField" class="iu3-wizard__field">
            <span>keyField（{{ bi('可选', 'optional') }}）</span>
            <input v-model="draft.keyField" data-testid="rsc-wizard-key-field-optional" placeholder="FBillNo" />
          </label>
          <label v-if="showKeyField" class="iu3-wizard__field">
            <span>keyEncoding（{{ bi('可选', 'optional') }}）</span>
            <select v-model="draft.keyEncoding" data-testid="rsc-wizard-key-encoding">
              <option value="">{{ bi('（不指定）', '(unspecified)') }}</option>
              <option v-for="encoding in READ_SOURCE_KEY_ENCODINGS" :key="encoding" :value="encoding">{{ encoding }}</option>
            </select>
          </label>
          <label class="iu3-wizard__field">
            <span>readMethod（{{ bi('默认 POST', 'defaults to POST') }}）</span>
            <select v-model="draft.readMethod" data-testid="rsc-wizard-read-method">
              <option v-for="method in READ_SOURCE_METHODS" :key="method" :value="method">{{ method }}</option>
            </select>
          </label>
          <label class="iu3-wizard__field">
            <span>version（{{ bi('正整数,默认 1', 'positive integer, defaults to 1') }}）</span>
            <input v-model.number="draft.version" type="number" min="1" data-testid="rsc-wizard-version" />
          </label>

          <template v-if="draft.resolverRule === 'first_when_sorted'">
            <label class="iu3-wizard__field">
              <span>multiplicityRuleField（{{ bi('排序字段,必填', 'sort field, required') }}）</span>
              <input v-model="draft.multiplicityRuleField" data-testid="rsc-wizard-resolver-sort-field" placeholder="FVersion" />
            </label>
            <label class="iu3-wizard__field">
              <span>resolverSortDirection（{{ bi('必填', 'required') }}）</span>
              <select v-model="draft.resolverSortDirection" data-testid="rsc-wizard-resolver-sort-direction">
                <option value="">{{ bi('选择方向…', 'Choose a direction…') }}</option>
                <option v-for="direction in RESOLVER_SORT_DIRECTIONS" :key="direction" :value="direction">{{ direction }}</option>
              </select>
            </label>
          </template>
          <template v-if="draft.resolverRule === 'field_equals'">
            <label class="iu3-wizard__field">
              <span>multiplicityRuleField（{{ bi('判别字段,必填', 'discriminator field, required') }}）</span>
              <input v-model="draft.multiplicityRuleField" data-testid="rsc-wizard-resolver-discriminator-field" placeholder="FIsCurrent" />
            </label>
            <label class="iu3-wizard__field">
              <span>resolverDiscriminatorValue（{{ bi('必填', 'required') }}）</span>
              <input v-model="draft.resolverDiscriminatorValue" data-testid="rsc-wizard-resolver-discriminator-value" placeholder="Y" />
            </label>
          </template>

          <div class="iu3-wizard__field-map">
            <div class="iu3-wizard__field-map-head">
              <span>fieldMap（{{ bi('可选', 'optional') }}）</span>
              <button type="button" class="iu3-wizard__button" data-testid="rsc-wizard-field-map-add" @click="addFieldMapRow">
                {{ bi('添加映射行', 'Add mapping row') }}
              </button>
            </div>
            <div v-for="(entry, index) in draft.fieldMap" :key="index" class="iu3-wizard__field-map-row">
              <input v-model="entry.source" :data-testid="`rsc-wizard-field-map-source-${index}`" placeholder="FName" />
              <span>→</span>
              <input v-model="entry.target" :data-testid="`rsc-wizard-field-map-target-${index}`" placeholder="material_name" />
              <button
                type="button"
                class="iu3-wizard__button"
                :data-testid="`rsc-wizard-field-map-remove-${index}`"
                @click="removeFieldMapRow(index)"
              >{{ bi('删除', 'Remove') }}</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section v-else-if="currentStep === 3" class="iu3-wizard__step" data-testid="rsc-wizard-step-3">
      <p class="iu3-wizard__step-desc">{{ bi(
        '定位容器探测：values-free，只验证容器形状是否符合预期，从不读取或展示行值。',
        'Locate-container probe: values-free — it only verifies the container shape, never reads or displays row values.',
      ) }}</p>
      <label class="iu3-wizard__inline">
        <input v-model="boundedSmoke" type="checkbox" data-testid="rsc-wizard-bounded-smoke" />
        <span>{{ bi('bounded smoke(受平台上限约束的试读计数)', 'bounded smoke (a platform-capped sample read)') }}</span>
      </label>
      <label v-if="probeNeedsKey" class="iu3-wizard__inline">
        <span>{{ bi('探测 key(仅用于本次探测,不会保存)', 'probe key (used only for this probe, never saved)') }}</span>
        <input v-model="probeKey" data-testid="rsc-wizard-probe-key" placeholder="MAT-001" />
      </label>
      <div class="iu3-wizard__actions">
        <button
          type="button"
          class="iu3-wizard__button iu3-wizard__button--primary"
          data-testid="rsc-wizard-probe-run"
          :disabled="probing || validationProblems.length > 0"
          @click="emit('run-probe')"
        >{{ probing ? bi('探测中…', 'Probing…') : bi('定位容器探测', 'Run probe') }}</button>
      </div>
      <p v-if="actionError" class="iu3-wizard__error" data-testid="rsc-wizard-error">{{ actionError }}</p>
      <div v-if="probeEvidence" class="iu3-wizard__evidence" data-testid="rsc-wizard-evidence">
        <p class="iu3-wizard__evidence-summary" data-testid="rsc-wizard-evidence-summary">
          <el-icon v-if="probeEvidence.ok" class="iu3-wizard__evidence-icon--ok"><CircleCheck /></el-icon>
          <el-icon v-else class="iu3-wizard__evidence-icon--fail"><WarningFilled /></el-icon>
          {{ probeEvidence.ok
            ? bi('探测成功：容器形状符合预期。', 'Probe succeeded: the container shape matches expectations.')
            : evidenceErrorLabel }}<template v-if="!probeEvidence.ok && evidenceErrorHint"> — {{ evidenceErrorHint }}</template>
        </p>
        <ul class="iu3-wizard__evidence-list">
          <li
            v-for="entry in evidenceContainers"
            :key="entry.alias"
            :data-testid="`rsc-wizard-evidence-container-${entry.alias}`"
          >
            {{ entry.alias }}: {{ entry.shape.type }}<template v-if="entry.shape.arrayLength !== undefined">, arrayLength={{ entry.shape.arrayLength === null ? 'null' : entry.shape.arrayLength }}</template>
          </li>
        </ul>
        <!-- 机器码折叠详情 (design-lock §2/§3): raw codes stay reachable for expert troubleshooting,
             never in the prominent slot. -->
        <details class="iu3-wizard__evidence-raw" data-testid="rsc-wizard-evidence-raw">
          <summary>{{ bi('原始机器码(排障用)', 'Raw codes (for troubleshooting)') }}</summary>
          <p v-if="probeEvidence.errorCode" data-testid="rsc-wizard-evidence-error-code">errorCode: {{ probeEvidence.errorCode }}</p>
          <p v-if="probeEvidence.errorType" data-testid="rsc-wizard-evidence-error-type">errorType: {{ probeEvidence.errorType }}</p>
        </details>
      </div>
    </section>

    <section v-else class="iu3-wizard__step" data-testid="rsc-wizard-step-4">
      <p class="iu3-wizard__step-desc">{{ bi(
        '保存这次的配置版本，然后提交审批；审批通过后运行时才能选用该读取源。',
        'Save this configuration version, then submit it for approval; only after approval can runtime select this read source.',
      ) }}</p>
      <div class="iu3-wizard__actions">
        <button
          type="button"
          class="iu3-wizard__button iu3-wizard__button--primary"
          data-testid="rsc-wizard-save"
          :disabled="saving || validationProblems.length > 0"
          @click="emit('save-version')"
        >{{ saving ? bi('保存中…', 'Saving…') : bi('保存版本', 'Save version') }}</button>
        <button
          v-if="saveResult"
          type="button"
          class="iu3-wizard__button"
          data-testid="rsc-wizard-approve"
          @click="emit('approve-saved')"
        >{{ bi('提交审批', 'Submit for approval') }}</button>
      </div>
      <p v-if="actionError" class="iu3-wizard__error" data-testid="rsc-wizard-error-step4">{{ actionError }}</p>
      <p v-if="saveResult" class="iu3-wizard__save-result" data-testid="rsc-wizard-save-result">
        {{ saveResult.reused
          ? bi(`已复用现有版本 v${saveResult.version}`, `Reused existing version v${saveResult.version}`)
          : bi(`已保存新版本 v${saveResult.version}`, `Saved new version v${saveResult.version}`) }}
        (status: {{ saveResult.status }})
      </p>
    </section>

    <div class="iu3-wizard__nav">
      <button
        type="button"
        class="iu3-wizard__button"
        data-testid="rsc-wizard-back"
        :disabled="currentStep === 1"
        @click="goBack"
      >{{ bi('上一步', 'Back') }}</button>
      <button
        v-if="currentStep < 4"
        type="button"
        class="iu3-wizard__button iu3-wizard__button--primary"
        data-testid="rsc-wizard-next"
        :disabled="(currentStep === 1 && !canAdvanceStep1) || (currentStep === 2 && !canAdvanceStep2)"
        @click="goNext"
      >{{ bi('下一步', 'Next') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
// IU-3 read-source config wizard (design-lock
// docs/development/integration-iu3-read-source-wizard-design-lock-20260707.md, #3797).
//
// This is a REORDERING SHELL over the existing `IntegrationReadSourceConfigPanel.vue` state — it owns
// NO service calls and NO independent config model. `draft` is the exact same reactive object the
// parent panel's expert flat-form binds to (passed through as a plain prop and mutated in place via
// v-model on its nested fields, the same "shared reactive slice" pattern already used by
// IntegrationConnectionSection.vue's `connectionDraft` — see that file's header comment). Because both
// surfaces write into ONE shared draft and both funnel it through the SAME
// `buildReadSourceConfigPayload` (called only in the parent, itself unchanged), the wizard's output is
// byte-equal to the expert form's by construction — proven empirically (not just by this argument) in
// IntegrationReadSourceWizard.spec.ts's byte-equality test, which drives real DOM inputs through both
// surfaces and diffs the captured wire body.
//
// probe/save/approve are EMITTED to the parent, which runs the exact same `runProbe` / `saveVersion` /
// `approveSavedResult` functions the expert form's own buttons call — one function per action, two UI
// entry points. No new route, no new validator, no new approve path (design-lock §2 hard lock).
import { computed, ref } from 'vue'
import { ArrowDown, ArrowRight, Check, CircleCheck, WarningFilled } from '@element-plus/icons-vue'
import { useLocale } from '../../composables/useLocale'
import { integrationErrorCodeDisplayLabel, integrationErrorCodeHint } from '../../services/integration/errorCodeLabels'
import { READ_SOURCE_MODE_PRESETS, readSourceModePreset } from '../../services/integration/readSourceModePresets'
import {
  READ_SOURCE_KEY_ENCODINGS,
  READ_SOURCE_METHODS,
  RESOLVER_RULES,
  RESOLVER_SORT_DIRECTIONS,
  deriveReadSourceProbeEvidenceContainers,
  validateReadSourceDraft,
  type ReadSourceConfigDraft,
  type ReadSourceMode,
  type ReadSourceProbeEvidence,
  type ReadSourceSaveResult,
} from '../../services/integration/readSourceConfigs'
import type { WorkbenchExternalSystem } from '../../services/integration/workbench'

const props = defineProps<{
  draft: ReadSourceConfigDraft
  systems: WorkbenchExternalSystem[]
  probing: boolean
  saving: boolean
  actionError: string
  probeEvidence: ReadSourceProbeEvidence | null
  saveResult: ReadSourceSaveResult | null
}>()

// Two standalone primitives — the codebase's established `defineModel` pattern for a plain two-way
// bind (same as IU-2b's `stagingBaseId` / IU-2c's `sourceSystemId` etc.). `draft` above is NOT a
// defineModel — it is a shared nested object, not a primitive being reassigned; see the header
// comment for why plain-prop-plus-nested-mutation is the correct (and precedented) shape for it.
const boundedSmoke = defineModel<boolean>('boundedSmoke', { default: false })
const probeKey = defineModel<string>('probeKey', { default: '' })

const emit = defineEmits<{
  (e: 'run-probe'): void
  (e: 'save-version'): void
  (e: 'approve-saved'): void
}>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const currentStep = ref<1 | 2 | 3 | 4>(1)
const advancedOpen = ref(false)

const currentPreset = computed(() => readSourceModePreset(props.draft.mode))
// The SAME requiredFieldKeys the step-2 preset card displays drives which fields step 2 actually
// shows — the card's promise ("this mode needs these fields") and the form's behavior can't drift
// apart, because both read off one computed.
const requiredKeys = computed(() => currentPreset.value.requiredFieldKeys)
const validationProblems = computed(() => validateReadSourceDraft(props.draft))
const canAdvanceStep1 = computed(() => props.draft.systemId.trim().length > 0)
const canAdvanceStep2 = computed(() => validationProblems.value.length === 0)
// EXACT mirrors of the expert flat form's `showKeyField` / `probeNeedsKey` computeds — the S2-b
// runtime requires inputs.key precisely when the config declares a keyField, regardless of which
// surface authored it, so the two surfaces must agree on when to ask for a probe key.
const showKeyField = computed(() => props.draft.mode !== 'list_page')
// detail_with_lines: keyField is optional (not in MODE_REQUIRED_FIELDS) but settable in the expert
// form — surfaced in the Advanced area so wizard capability matches the flat form's.
const showOptionalKeyField = computed(() => showKeyField.value && !requiredKeys.value.includes('keyField'))
const probeNeedsKey = computed(() => showKeyField.value && props.draft.keyField.trim().length > 0)
const evidenceContainers = computed(() => deriveReadSourceProbeEvidenceContainers(props.probeEvidence?.containers))
const evidenceErrorLabel = computed(() => integrationErrorCodeDisplayLabel(props.probeEvidence?.errorCode, locale.value))
const evidenceErrorHint = computed(() => integrationErrorCodeHint(props.probeEvidence?.errorCode, locale.value))

function selectSystem(system: WorkbenchExternalSystem): void {
  // Mirrors the expert form's `onSystemChange` (native <select> @change) — same two-field mapping,
  // duplicated here because the wizard's input is a card click rather than a <select> change event.
  props.draft.systemId = system.id
  props.draft.requiredKind = system.kind
}

function selectMode(mode: ReadSourceMode): void {
  props.draft.mode = mode
}

function addFieldMapRow(): void {
  props.draft.fieldMap.push({ source: '', target: '' })
}

function removeFieldMapRow(index: number): void {
  props.draft.fieldMap.splice(index, 1)
}

function goNext(): void {
  if (currentStep.value === 1 && !canAdvanceStep1.value) return
  if (currentStep.value === 2 && !canAdvanceStep2.value) return
  if (currentStep.value === 1) currentStep.value = 2
  else if (currentStep.value === 2) currentStep.value = 3
  else if (currentStep.value === 3) currentStep.value = 4
}

function goBack(): void {
  if (currentStep.value === 4) currentStep.value = 3
  else if (currentStep.value === 3) currentStep.value = 2
  else if (currentStep.value === 2) currentStep.value = 1
}
</script>

<style scoped>
/* Token-only (UF-1 / design-lock §3 hard lock) — every new style in this file uses var(--ms-*), zero
   hex/rgb literals; enforced by ui-foundation-style-guard.spec.ts (this file is in TARGET_FILES). */
.iu3-wizard {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}
.iu3-wizard__steps {
  margin-bottom: var(--ms-space-2);
}
.iu3-wizard__step {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}
.iu3-wizard__step-desc {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
}
.iu3-wizard__card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--ms-space-3);
}
.iu3-wizard__card {
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
.iu3-wizard__card:hover {
  border-color: var(--ms-color-primary);
}
.iu3-wizard__card--selected {
  border-color: var(--ms-color-primary);
  box-shadow: var(--ms-shadow-card);
}
.iu3-wizard__card-check {
  position: absolute;
  top: var(--ms-space-2);
  right: var(--ms-space-2);
  color: var(--ms-color-primary);
}
.iu3-wizard__card-title {
  font-size: 14px;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}
.iu3-wizard__card-subtitle {
  font-size: 12px;
  color: var(--ms-text-2);
}
.iu3-wizard__empty-hint {
  color: var(--ms-text-3);
  font-size: 13px;
}
.iu3-wizard__field {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 13px;
}
.iu3-wizard__field input,
.iu3-wizard__field select {
  padding: var(--ms-space-1) var(--ms-space-2);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
}
.iu3-wizard__inline {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  font-size: 13px;
}
.iu3-wizard__problems {
  margin: 0;
  padding-left: var(--ms-space-4);
  color: var(--ms-color-warning);
  font-size: 12px;
}
.iu3-wizard__advanced {
  border-top: 1px solid var(--ms-border-light);
  padding-top: var(--ms-space-3);
}
.iu3-wizard__advanced-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--ms-space-1);
  border: none;
  background: none;
  color: var(--ms-color-primary);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
}
.iu3-wizard__advanced-body {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  margin-top: var(--ms-space-3);
}
.iu3-wizard__field-map-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-2);
  font-size: 13px;
}
.iu3-wizard__field-map-row {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  margin-top: var(--ms-space-2);
}
.iu3-wizard__field-map-row input {
  padding: var(--ms-space-1) var(--ms-space-2);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
}
.iu3-wizard__actions {
  display: flex;
  gap: var(--ms-space-2);
}
.iu3-wizard__button {
  padding: var(--ms-space-1) var(--ms-space-3);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-size: 13px;
}
.iu3-wizard__button:disabled {
  cursor: not-allowed;
  color: var(--ms-text-3);
}
.iu3-wizard__button--primary {
  border-color: var(--ms-color-primary);
  background: var(--ms-color-primary);
  color: var(--ms-bg-card);
}
.iu3-wizard__button--primary:disabled {
  background: var(--ms-border);
  border-color: var(--ms-border);
  color: var(--ms-bg-card);
}
.iu3-wizard__error {
  color: var(--ms-color-danger);
  font-size: 13px;
}
.iu3-wizard__evidence {
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-3);
  font-size: 13px;
}
.iu3-wizard__evidence-summary {
  display: flex;
  align-items: center;
  gap: var(--ms-space-1);
  margin: 0;
}
.iu3-wizard__evidence-icon--ok {
  color: var(--ms-color-success);
}
.iu3-wizard__evidence-icon--fail {
  color: var(--ms-color-danger);
}
.iu3-wizard__evidence-list {
  margin: var(--ms-space-2) 0 0;
  padding-left: var(--ms-space-4);
}
.iu3-wizard__evidence-raw {
  margin-top: var(--ms-space-2);
  color: var(--ms-text-3);
  font-size: 12px;
}
.iu3-wizard__save-result {
  color: var(--ms-color-success);
  font-size: 13px;
}
.iu3-wizard__nav {
  display: flex;
  justify-content: space-between;
  border-top: 1px solid var(--ms-border-light);
  padding-top: var(--ms-space-3);
}
</style>
