<!--
  W4-2 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §5/§9 W4-2): template-prefill confirm
  dialog — the §5.2 mandatory contract made visible. Pure display component: props in (tr +
  resolved template + plan + current/pristine form shapes + timezone state), emits out. It never
  fetches, never writes a form itself (the parent AttendanceView owns snapshot/apply/restore), and
  never claims anything is saved or active.

  Contract carried here (each leg has a spec in attendance-setup-templates.spec.ts):
  - §5.2① 覆盖确认: the affected-field list (current → template value) renders BEFORE any write;
    apply is an explicit button — never silent. A dirty-target warning appears when a target form
    already差异于 pristine (unsaved edits or a selected existing record).
  - §5.2② 快照/取消: stage 'applied' offers 「撤销预填（恢复原值）」 → parent restores the
    snapshot byte-identically; stage 'confirm' 「取消」 applies nothing.
  - §5.2③ 只承诺已保存: the applied-stage copy says the values are written to the FORMS and NOT
    saved — saving happens on each form's own save button; the wizard saves nothing.
  - §5.2④ 时区: shows the org's explicit current value when resolvable; otherwise REQUIRES a user
    choice (apply stays disabled) — the browser timezone is never presented as the org timezone.
  - R4: the field-sales settings hint is a deep-link emit only (navigate) — no settings write.
-->
<template>
  <div class="setup-template-dialog" data-setup-template-dialog :data-setup-template-dialog-stage="stage">
    <div class="setup-template-dialog__backdrop" aria-hidden="true"></div>
    <div
      class="setup-template-dialog__panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="attendance-setup-template-dialog-title"
    >
      <h4 id="attendance-setup-template-dialog-title" class="setup-template-dialog__title">
        {{ stage === 'confirm'
          ? `${tr('Apply template prefill', '应用模板预填')} — ${pickLabel(template.name)}`
          : `${tr('Template prefill written to forms (not saved)', '模板预填已写入表单（未保存）')} — ${pickLabel(template.name)}` }}
      </h4>

      <template v-if="stage === 'confirm'">
        <p class="setup-template-dialog__note">
          {{ tr(
            'The fields below will be overwritten with template values. A template only prefills forms — it saves nothing and changes no production configuration or switches; saving still happens on each form\'s own save button.',
            '以下字段将被模板值覆盖。模板只预填表单——不保存、不修改任何生产配置或开关；保存动作仍需在各表单自己的保存按钮完成。',
          ) }}
        </p>

        <p
          v-if="dirtyForms.length > 0"
          class="setup-template-dialog__warning"
          data-setup-template-dirty-warning
        >
          {{ tr(
            'Note: a target form already has content (unsaved edits or a selected existing record). Applying overwrites the form content; Cancel changes nothing, and after applying you can still undo to restore the original values. Applying also switches both forms to create-new mode so saving will not overwrite an existing record.',
            '注意：目标表单当前已有内容（未保存的编辑或已选中的现有记录）。应用会覆盖表单内容；「取消」不做任何修改，应用后也可「撤销预填」恢复原值。应用后两个表单将切换为新建模式，保存不会覆盖已有记录。',
          ) }}
        </p>

        <div class="setup-template-dialog__field" data-setup-template-timezone-block>
          <label for="attendance-setup-template-timezone">
            <span>{{ tr('Group / shift timezone', '考勤组与班次时区') }}</span>
            <select
              id="attendance-setup-template-timezone"
              data-setup-template-timezone-select
              :value="timezone"
              @change="emit('update:timezone', ($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>{{ tr('Choose the organization timezone...', '请选择组织时区…') }}</option>
              <option v-for="option in timezoneOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <p v-if="orgTimezone" class="setup-template-dialog__hint" data-setup-template-timezone-org>
            {{ tr('Organization current value (from this org\'s saved attendance groups)', '组织现值（取自本组织已保存的考勤组）') }}: {{ orgTimezone }}
          </p>
          <p v-else class="setup-template-dialog__hint setup-template-dialog__hint--required" data-setup-template-timezone-required>
            {{ tr(
              'No explicit organization timezone could be resolved (the browser timezone is never used as the organization timezone) — please choose one before applying.',
              '未能取得组织显式时区（浏览器时区不会被当作组织时区）——请先选择时区再应用。',
            ) }}
          </p>
        </div>

        <div
          v-if="template.shiftPresets.length > 1"
          class="setup-template-dialog__field"
          data-setup-template-preset-block
        >
          <label for="attendance-setup-template-preset">
            <span>{{ tr('Shift preset to prefill', '预填的班次预设') }}</span>
            <select
              id="attendance-setup-template-preset"
              data-setup-template-preset-select
              :value="shiftPresetKey ?? ''"
              @change="emit('update:shiftPresetKey', ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="preset in template.shiftPresets" :key="preset.key" :value="preset.key">
                {{ pickLabel(preset.label) }}{{ preset.overnight ? ` · ${tr('overnight', '跨夜')}` : '' }}
              </option>
            </select>
          </label>
          <p class="setup-template-dialog__hint">
            {{ tr(
              'One shift is prefilled per application; after saving, apply this template again to prefill the remaining presets.',
              '每次预填一个班次；保存后可再次应用本模板，预填其余班次预设。',
            ) }}
          </p>
        </div>

        <table v-if="plan" class="setup-template-dialog__changes" data-setup-template-field-changes>
          <thead>
            <tr>
              <th scope="col">{{ tr('Form / field', '表单/字段') }}</th>
              <th scope="col">{{ tr('Current value', '当前值') }}</th>
              <th scope="col">{{ tr('Template value', '模板值') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="change in fieldChanges"
              :key="`${change.form}-${change.field}`"
              :data-setup-template-field-change="`${change.form}.${change.field}`"
            >
              <td>{{ change.label }}</td>
              <td>{{ change.current === '' ? tr('(empty)', '（空）') : change.current }}</td>
              <td>{{ change.next }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="setup-template-dialog__hint setup-template-dialog__hint--required" data-setup-template-plan-missing>
          {{ tr('Choose a timezone to see the affected fields.', '选择时区后展示受影响字段清单。') }}
        </p>

        <p v-if="template.rotationRuleHint" class="setup-template-dialog__hint" data-setup-template-rotation-hint>
          {{ pickLabel(template.rotationRuleHint) }}
        </p>
        <p v-if="template.settingsHint" class="setup-template-dialog__hint" data-setup-template-settings-hint>
          {{ pickLabel(template.settingsHint) }}
        </p>

        <div class="setup-template-dialog__actions">
          <button
            class="setup-template-dialog__btn setup-template-dialog__btn--primary"
            type="button"
            data-setup-template-apply
            :disabled="!plan"
            @click="emit('apply')"
          >
            {{ tr('Apply prefill', '应用预填') }}
          </button>
          <button
            class="setup-template-dialog__btn"
            type="button"
            data-setup-template-cancel
            @click="emit('cancel')"
          >
            {{ tr('Cancel', '取消') }}
          </button>
        </div>
      </template>

      <template v-else>
        <p class="setup-template-dialog__note" data-setup-template-applied-note>
          {{ appliedNote }}
        </p>
        <p v-if="template.rotationRuleHint" class="setup-template-dialog__hint" data-setup-template-rotation-hint>
          {{ pickLabel(template.rotationRuleHint) }}
        </p>
        <p v-if="template.settingsHint" class="setup-template-dialog__hint" data-setup-template-settings-hint>
          {{ pickLabel(template.settingsHint) }}
        </p>
        <div class="setup-template-dialog__actions">
          <button
            class="setup-template-dialog__btn setup-template-dialog__btn--primary"
            type="button"
            data-setup-template-go-group
            @click="emit('navigate', 'attendance-admin-groups')"
          >
            {{ tr('Go to the group form to save', '前往考勤组表单保存') }}
          </button>
          <button
            v-if="plan?.shift"
            class="setup-template-dialog__btn"
            type="button"
            data-setup-template-go-shift
            @click="emit('navigate', 'attendance-admin-shifts')"
          >
            {{ tr('Go to the shift form to save', '前往班次表单保存') }}
          </button>
          <button
            v-if="template.settingsHint"
            class="setup-template-dialog__btn"
            type="button"
            data-setup-template-go-settings
            @click="emit('navigate', 'attendance-admin-settings')"
          >
            {{ tr('Review punch methods in Settings (manual)', '前往设置人工确认打卡方式') }}
          </button>
          <button
            class="setup-template-dialog__btn setup-template-dialog__btn--danger"
            type="button"
            data-setup-template-undo
            @click="emit('undo')"
          >
            {{ tr('Undo prefill (restore original values)', '撤销预填（恢复原值）') }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  ATTENDANCE_SETUP_GROUP_FORM_FIELDS,
  ATTENDANCE_SETUP_SHIFT_FORM_FIELDS,
  diffAttendanceSetupFormFields,
  type AttendanceSetupGroupFormShape,
  type AttendanceSetupShiftFormShape,
  type AttendanceSetupTemplate,
  type AttendanceSetupTemplateLabel,
  type AttendanceSetupTemplatePrefillPlan,
} from './attendanceSetupTemplates'

type TranslateFn = (en: string, zh: string) => string

const props = defineProps<{
  tr: TranslateFn
  stage: 'confirm' | 'applied'
  template: AttendanceSetupTemplate
  plan: AttendanceSetupTemplatePrefillPlan | null
  currentGroup: AttendanceSetupGroupFormShape
  currentShift: AttendanceSetupShiftFormShape
  pristineGroup: AttendanceSetupGroupFormShape
  pristineShift: AttendanceSetupShiftFormShape
  groupEditingId: string | null
  shiftEditingId: string | null
  orgTimezone: string | null
  timezone: string
  timezoneOptions: readonly { value: string; label: string }[]
  shiftPresetKey: string | null
}>()

const emit = defineEmits<{
  apply: []
  cancel: []
  undo: []
  navigate: [sectionId: string]
  'update:timezone': [value: string]
  'update:shiftPresetKey': [value: string]
}>()

const tr = props.tr
const pickLabel = (label: AttendanceSetupTemplateLabel): string => tr(label.en, label.zh)

/** §5.2③ applied-stage copy — states what happened (values written to FORMS) and what did NOT
 *  (nothing saved, nothing activated); only saved resources are promised to persist (OD-W4-7). */
const appliedNote = computed(() =>
  props.plan?.shift
    ? tr(
        'The template values are now in the group form and the shift form — NOT saved. Saving happens on each form\'s own save button; this wizard performs no save and no activation action. Only saved resources persist — unsaved prefill does not survive a page reload.',
        '模板值已写入考勤组表单与班次表单——尚未保存。保存需在各表单自己的保存按钮完成；本向导不执行保存、不执行任何启用动作。只有已保存的资源会持久存在——未保存的预填在刷新后不会保留。',
      )
    : tr(
        'The template values are now in the group form — NOT saved. Saving happens on the form\'s own save button; this wizard performs no save and no activation action. Only saved resources persist — unsaved prefill does not survive a page reload.',
        '模板值已写入考勤组表单——尚未保存。保存需在表单自己的保存按钮完成；本向导不执行保存、不执行任何启用动作。只有已保存的资源会持久存在——未保存的预填在刷新后不会保留。',
      ),
)

/** §5.2① "表单已有未保存内容时尤其" — dirty ⇔ the target form differs from its pristine defaults
 *  OR holds a selected existing record (editing mode: a save would PUT-overwrite that record). */
const dirtyForms = computed<Array<'group' | 'shift'>>(() => {
  const dirty: Array<'group' | 'shift'> = []
  const groupDirty =
    props.groupEditingId !== null ||
    diffAttendanceSetupFormFields(
      props.currentGroup as unknown as Record<string, unknown>,
      props.pristineGroup as unknown as Record<string, unknown>,
      ATTENDANCE_SETUP_GROUP_FORM_FIELDS,
    ).length > 0
  if (groupDirty) dirty.push('group')
  if (props.plan?.shift) {
    const shiftDirty =
      props.shiftEditingId !== null ||
      diffAttendanceSetupFormFields(
        props.currentShift as unknown as Record<string, unknown>,
        props.pristineShift as unknown as Record<string, unknown>,
        ATTENDANCE_SETUP_SHIFT_FORM_FIELDS,
      ).length > 0
    if (shiftDirty) dirty.push('shift')
  }
  return dirty
})

interface FieldChangeRow {
  form: 'group' | 'shift'
  field: string
  label: string
  current: string
  next: string
}

/** §5.2① affected-field list: exactly the fields the apply step writes, current → template. */
const fieldChanges = computed<FieldChangeRow[]>(() => {
  const plan = props.plan
  if (!plan) return []
  const rows: FieldChangeRow[] = [
    {
      form: 'group',
      field: 'name',
      label: tr('Group · name', '考勤组 · 名称'),
      current: props.currentGroup.name,
      next: plan.group.name,
    },
    {
      form: 'group',
      field: 'attendanceType',
      label: tr('Group · work-time type', '考勤组 · 班制'),
      current: props.currentGroup.attendanceType,
      next: plan.group.attendanceType,
    },
    {
      form: 'group',
      field: 'timezone',
      label: tr('Group · timezone', '考勤组 · 时区'),
      current: props.currentGroup.timezone,
      next: plan.group.timezone,
    },
  ]
  if (plan.shift) {
    rows.push(
      {
        form: 'shift',
        field: 'name',
        label: tr('Shift · name', '班次 · 名称'),
        current: props.currentShift.name,
        next: plan.shift.name,
      },
      {
        form: 'shift',
        field: 'window',
        label: tr('Shift · work window', '班次 · 上下班时间'),
        current: `${props.currentShift.workStartTime}-${props.currentShift.workEndTime}`,
        next: `${plan.shift.workStartTime}-${plan.shift.workEndTime}`,
      },
      {
        form: 'shift',
        field: 'timezone',
        label: tr('Shift · timezone', '班次 · 时区'),
        current: props.currentShift.timezone,
        next: plan.shift.timezone,
      },
      {
        form: 'shift',
        field: 'grace',
        label: tr('Shift · late/early grace (minutes)', '班次 · 迟到/早退宽限（分钟）'),
        current: `${props.currentShift.lateGraceMinutes}/${props.currentShift.earlyGraceMinutes}`,
        next: `${plan.shift.lateGraceMinutes}/${plan.shift.earlyGraceMinutes}`,
      },
      {
        form: 'shift',
        field: 'workingDays',
        label: tr('Shift · working days', '班次 · 工作日'),
        current: props.currentShift.workingDays,
        next: plan.shift.workingDays,
      },
    )
  }
  return rows
})
</script>

<style scoped>
.setup-template-dialog {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: var(--ms-space-4);
}

.setup-template-dialog__backdrop {
  position: absolute;
  inset: 0;
  /* Scrim alpha follows the existing `.attendance__modal` overlay precedent (no scrim token in
     tokens.css yet); no hex literals. */
  background: rgba(0, 0, 0, 0.45);
}

.setup-template-dialog__panel {
  position: relative;
  width: min(640px, 100%);
  max-height: min(80vh, 720px);
  overflow-y: auto;
  display: grid;
  gap: var(--ms-space-3);
  padding: var(--ms-space-5);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-pop);
}

.setup-template-dialog__title {
  margin: 0;
  color: var(--ms-text-1);
  font-size: var(--ms-font-size-section-title);
  font-weight: var(--ms-font-weight-title);
  overflow-wrap: anywhere;
}

.setup-template-dialog__note {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.setup-template-dialog__warning {
  margin: 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-color-warning);
  border-radius: var(--ms-radius-sm);
  color: var(--ms-color-warning);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.setup-template-dialog__field {
  display: grid;
  gap: var(--ms-space-1);
}

.setup-template-dialog__field label {
  display: grid;
  gap: var(--ms-space-1);
  color: var(--ms-text-1);
  font-size: 12px;
  font-weight: 600;
}

.setup-template-dialog__field select {
  padding: 6px 10px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font-size: 12px;
  max-width: 100%;
}

.setup-template-dialog__hint {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.setup-template-dialog__hint--required {
  color: var(--ms-color-warning);
}

.setup-template-dialog__changes {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.setup-template-dialog__changes th,
.setup-template-dialog__changes td {
  padding: 6px 8px;
  border: 1px solid var(--ms-border-light);
  color: var(--ms-text-2);
  text-align: left;
  overflow-wrap: anywhere;
}

.setup-template-dialog__changes th {
  color: var(--ms-text-1);
  background: var(--ms-bg-page);
}

.setup-template-dialog__actions {
  display: flex;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

.setup-template-dialog__btn {
  padding: 6px 14px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font-size: 12px;
  cursor: pointer;
}

.setup-template-dialog__btn--primary {
  border-color: var(--ms-color-primary);
  color: var(--ms-color-primary);
}

.setup-template-dialog__btn--primary:disabled {
  border-color: var(--ms-border);
  color: var(--ms-text-3);
  cursor: default;
}

.setup-template-dialog__btn--danger {
  border-color: var(--ms-color-danger);
  color: var(--ms-color-danger);
}
</style>
