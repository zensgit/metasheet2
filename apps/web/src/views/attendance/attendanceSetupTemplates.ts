// W4-2 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §5/§9 W4-2): the four setup templates
// as FE constants (OD-W4-3 =(a): FE constant module, zero new backend surface) plus the pure
// prefill-plan/snapshot/diff helpers behind the same-host prefill mechanism (§5.2). Zero DOM,
// zero fetch, zero Vue reactivity — the wizard shell renders the cards, AttendanceView (the form
// host) orchestrates confirm → snapshot → write → jump.
//
// Red lines carried by this module (each has a negative spec in
// apps/web/tests/attendance-setup-templates.spec.ts):
// - §5.2④ 时区禁硬编码: template constants contain NO timezone value anywhere — not a `timezone`
//   key, not an IANA-zone string, not 'UTC'. The timezone enters ONLY at plan-build time, from the
//   org's explicit current value (`resolveAttendanceSetupOrgTimezone`) or from an explicit user
//   choice in the confirm dialog. A blank timezone yields NO plan (never a silent default — the
//   browser timezone is NOT an org timezone, lock §5.2 on `AttendanceView.vue` `defaultTimezone`).
// - §5.2①② 覆盖确认 + 快照: `captureAttendanceSetupPrefillSnapshot` deep-copies exactly the
//   state the apply step mutates (both forms' fields + both editing ids), so cancel restores it
//   byte-identically; `diffAttendanceSetupFormFields` powers the affected-field list and the
//   "target form already has content" warning.
// - R3/R4: this module performs no requests and plans no requests — a plan is only ever form
//   values. Saving stays each canonical form's own save button (§5.3 只承诺已保存).
//
// Appendix A (锁附录 A) is the field-set authority:每模板 = 满足表约束的最小合法集 (group name +
// attendance_type + timezone placeholder; shift presets with HH:mm windows / grace / working
// days; hints for rotation rules (store/factory) and outdoor punch settings (field sales — deep
// link only, 不代存部署级设置)).

/** The four template ids (OD-VX3 已裁), stable card/order identity. */
export const ATTENDANCE_SETUP_TEMPLATE_IDS = [
  'office-fixed',
  'store-scheduled',
  'factory-multi-shift',
  'field-sales',
] as const
export type AttendanceSetupTemplateId = (typeof ATTENDANCE_SETUP_TEMPLATE_IDS)[number]

/** Bilingual display label — consumers pick a side with the host `tr(en, zh)` translator. */
export interface AttendanceSetupTemplateLabel {
  en: string
  zh: string
}
export type AttendanceSetupTemplateLabelPicker = (label: AttendanceSetupTemplateLabel) => string

/** attendance_type CHECK domain (zzzz20260529213000_add_attendance_group_type.ts) — enum-strict. */
export const ATTENDANCE_SETUP_TEMPLATE_GROUP_TYPES = ['fixed_shift', 'scheduled_shift', 'free_time'] as const
export type AttendanceSetupTemplateGroupType = (typeof ATTENDANCE_SETUP_TEMPLATE_GROUP_TYPES)[number]

/** One prefillable shift preset. NOTE: deliberately NO timezone field — see module header. */
export interface AttendanceSetupTemplateShiftPreset {
  key: string
  label: AttendanceSetupTemplateLabel
  /** HH:mm, 24h — the exact `shiftForm` input format. */
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  /** Comma-joined 1..7 working-day list — the exact `shiftForm.workingDays` input format. */
  workingDays: string
  /** Display hint only (工厂夜班跨夜示例): true ⇔ the window crosses midnight (end <= start).
   *  The backend derives overnight from the window itself; this flag never reaches a payload. */
  overnight: boolean
}

export interface AttendanceSetupTemplate {
  id: AttendanceSetupTemplateId
  name: AttendanceSetupTemplateLabel
  description: AttendanceSetupTemplateLabel
  attendanceType: AttendanceSetupTemplateGroupType
  /** Group-form prefill source (name only — code/ruleSetId/description are NOT touched; Appendix A
   *  minimal legal set). Timezone is resolved at plan time. */
  group: { name: AttendanceSetupTemplateLabel }
  shiftPresets: readonly AttendanceSetupTemplateShiftPreset[]
  /** 门店/工厂: ③ step3Ready 联动提示 — scheduled_shift groups additionally need active rotation
   *  rules (org-level existence, §3③). Display copy only; no prefill target exists for rules. */
  rotationRuleHint: AttendanceSetupTemplateLabel | null
  /** 销售/外勤: outdoor punch methods live in the deployment-level Settings form — the template
   *  deep-links there and NEVER writes settings (R4 向导对 settings 整体禁写). */
  settingsHint: AttendanceSetupTemplateLabel | null
}

const OFFICE_FIXED: AttendanceSetupTemplate = {
  id: 'office-fixed',
  name: { en: 'Office fixed shift', zh: '办公室固定班' },
  description: {
    en: 'One fixed 09:00-18:00 weekday shift for office teams.',
    zh: '面向办公室团队的固定班：工作日 09:00-18:00 单班次。',
  },
  attendanceType: 'fixed_shift',
  group: { name: { en: 'Office attendance group', zh: '办公室考勤组' } },
  shiftPresets: [
    {
      key: 'office-day',
      label: { en: 'Office shift 09:00-18:00', zh: '办公室班次 09:00-18:00' },
      workStartTime: '09:00',
      workEndTime: '18:00',
      lateGraceMinutes: 10,
      earlyGraceMinutes: 10,
      roundingMinutes: 5,
      workingDays: '1,2,3,4,5',
      overnight: false,
    },
  ],
  rotationRuleHint: null,
  settingsHint: null,
}

const STORE_SCHEDULED: AttendanceSetupTemplate = {
  id: 'store-scheduled',
  name: { en: 'Store scheduled shifts', zh: '门店排班' },
  description: {
    en: 'Scheduled-shift store staffing with early/late shift presets.',
    zh: '面向门店的排班制：早/晚两个班次预设。',
  },
  attendanceType: 'scheduled_shift',
  group: { name: { en: 'Store attendance group', zh: '门店考勤组' } },
  shiftPresets: [
    {
      key: 'store-early',
      label: { en: 'Store early shift 08:00-16:00', zh: '门店早班 08:00-16:00' },
      workStartTime: '08:00',
      workEndTime: '16:00',
      lateGraceMinutes: 10,
      earlyGraceMinutes: 10,
      roundingMinutes: 5,
      workingDays: '1,2,3,4,5,6,7',
      overnight: false,
    },
    {
      key: 'store-late',
      label: { en: 'Store late shift 14:00-22:00', zh: '门店晚班 14:00-22:00' },
      workStartTime: '14:00',
      workEndTime: '22:00',
      lateGraceMinutes: 10,
      earlyGraceMinutes: 10,
      roundingMinutes: 5,
      workingDays: '1,2,3,4,5,6,7',
      overnight: false,
    },
  ],
  rotationRuleHint: {
    en: 'Scheduled-shift groups also need an active rotation rule before setup step 3 turns complete; add one under Rotation Rules after saving.',
    zh: '排班制考勤组还需要一条启用的轮班规则，步骤③才会转为完成；保存后请在「轮班规则」中补充。',
  },
  settingsHint: null,
}

const FACTORY_MULTI_SHIFT: AttendanceSetupTemplate = {
  id: 'factory-multi-shift',
  name: { en: 'Factory multi-shift', zh: '工厂多班次' },
  description: {
    en: 'Three-shift factory rotation with an overnight night-shift example.',
    zh: '面向工厂的三班制：早/中/夜三个班次预设，夜班为跨夜示例。',
  },
  attendanceType: 'scheduled_shift',
  group: { name: { en: 'Factory attendance group', zh: '工厂考勤组' } },
  shiftPresets: [
    {
      key: 'factory-early',
      label: { en: 'Factory early shift 06:00-14:00', zh: '工厂早班 06:00-14:00' },
      workStartTime: '06:00',
      workEndTime: '14:00',
      lateGraceMinutes: 10,
      earlyGraceMinutes: 10,
      roundingMinutes: 5,
      workingDays: '1,2,3,4,5,6',
      overnight: false,
    },
    {
      key: 'factory-middle',
      label: { en: 'Factory middle shift 14:00-22:00', zh: '工厂中班 14:00-22:00' },
      workStartTime: '14:00',
      workEndTime: '22:00',
      lateGraceMinutes: 10,
      earlyGraceMinutes: 10,
      roundingMinutes: 5,
      workingDays: '1,2,3,4,5,6',
      overnight: false,
    },
    {
      key: 'factory-night',
      label: { en: 'Factory night shift 22:00-06:00 (overnight)', zh: '工厂夜班 22:00-06:00（跨夜）' },
      workStartTime: '22:00',
      workEndTime: '06:00',
      lateGraceMinutes: 10,
      earlyGraceMinutes: 10,
      roundingMinutes: 5,
      workingDays: '1,2,3,4,5,6',
      overnight: true,
    },
  ],
  rotationRuleHint: {
    en: 'Scheduled-shift groups also need an active rotation rule before setup step 3 turns complete; add one under Rotation Rules after saving.',
    zh: '排班制考勤组还需要一条启用的轮班规则，步骤③才会转为完成；保存后请在「轮班规则」中补充。',
  },
  settingsHint: null,
}

const FIELD_SALES: AttendanceSetupTemplate = {
  id: 'field-sales',
  name: { en: 'Sales / field work', zh: '销售/外勤' },
  description: {
    en: 'Free-time attendance for sales and field staff; outdoor punch methods are confirmed by a person in Settings.',
    zh: '面向销售与外勤人员的自由工时考勤；外勤打卡方式需真人在「设置」面确认。',
  },
  attendanceType: 'free_time',
  group: { name: { en: 'Field sales attendance group', zh: '外勤考勤组' } },
  shiftPresets: [],
  rotationRuleHint: null,
  settingsHint: {
    en: 'Outdoor punch methods (approval / note / photo) are a deployment-level policy — review and save them yourself in the Settings form. The template never saves settings for you.',
    zh: '外勤打卡方式（外勤审批/备注/拍照）属部署级策略——请自行前往「设置」表单核对并保存；模板不会代存任何设置。',
  },
}

export const ATTENDANCE_SETUP_TEMPLATES: readonly AttendanceSetupTemplate[] = [
  OFFICE_FIXED,
  STORE_SCHEDULED,
  FACTORY_MULTI_SHIFT,
  FIELD_SALES,
]

export function getAttendanceSetupTemplate(id: string): AttendanceSetupTemplate | null {
  return ATTENDANCE_SETUP_TEMPLATES.find((template) => template.id === id) ?? null
}

// ---------------------------------------------------------------------------
// Prefill-target form shapes (structural mirror of the prefill-relevant fields of
// AttendanceView's `attendanceGroupForm` / `shiftForm` reactive forms — §5.2 同宿主预填).
// ---------------------------------------------------------------------------

export interface AttendanceSetupGroupFormShape {
  name: string
  code: string
  timezone: string
  ruleSetId: string
  attendanceType: string
  description: string
}

export interface AttendanceSetupShiftFormShape {
  name: string
  timezone: string
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  workingDays: string
}

export const ATTENDANCE_SETUP_GROUP_FORM_FIELDS = [
  'name',
  'code',
  'timezone',
  'ruleSetId',
  'attendanceType',
  'description',
] as const satisfies readonly (keyof AttendanceSetupGroupFormShape)[]

export const ATTENDANCE_SETUP_SHIFT_FORM_FIELDS = [
  'name',
  'timezone',
  'workStartTime',
  'workEndTime',
  'lateGraceMinutes',
  'earlyGraceMinutes',
  'roundingMinutes',
  'workingDays',
] as const satisfies readonly (keyof AttendanceSetupShiftFormShape)[]

/** §5.2② snapshot contract: exactly the state the apply step mutates — every field of both forms
 *  plus both editing ids (apply clears the editing ids so a follow-up save CREATES a new resource
 *  instead of PUT-overwriting whichever existing record happened to be selected in the form). */
export interface AttendanceSetupPrefillSnapshot {
  group: AttendanceSetupGroupFormShape
  shift: AttendanceSetupShiftFormShape
  groupEditingId: string | null
  shiftEditingId: string | null
}

export function captureAttendanceSetupPrefillSnapshot(input: {
  group: AttendanceSetupGroupFormShape
  shift: AttendanceSetupShiftFormShape
  groupEditingId: string | null
  shiftEditingId: string | null
}): AttendanceSetupPrefillSnapshot {
  return {
    group: {
      name: input.group.name,
      code: input.group.code,
      timezone: input.group.timezone,
      ruleSetId: input.group.ruleSetId,
      attendanceType: input.group.attendanceType,
      description: input.group.description,
    },
    shift: {
      name: input.shift.name,
      timezone: input.shift.timezone,
      workStartTime: input.shift.workStartTime,
      workEndTime: input.shift.workEndTime,
      lateGraceMinutes: input.shift.lateGraceMinutes,
      earlyGraceMinutes: input.shift.earlyGraceMinutes,
      roundingMinutes: input.shift.roundingMinutes,
      workingDays: input.shift.workingDays,
    },
    groupEditingId: input.groupEditingId,
    shiftEditingId: input.shiftEditingId,
  }
}

/** Field-level diff between two same-shape form records — powers both the affected-field display
 *  and the "target form already has content" (dirty vs pristine) warning. */
export function diffAttendanceSetupFormFields<T extends Record<string, unknown>>(
  current: T,
  baseline: T,
  fields: readonly (keyof T)[],
): string[] {
  return fields.filter((field) => current[field] !== baseline[field]).map((field) => String(field))
}

// ---------------------------------------------------------------------------
// Org timezone resolution (§5.2④): the org's explicit current value, or nothing.
// ---------------------------------------------------------------------------

/**
 * Resolve the org's explicit timezone from explicit per-resource values the org has already saved
 * (the caller passes the timezones of the org's existing attendance groups — each was explicitly
 * part of a saved payload on the canonical group form). Exactly ONE distinct non-empty value ⇒
 * that value; zero (first-run org) or several distinct values (ambiguous) ⇒ null — the confirm
 * dialog must then REQUIRE a user choice. Never falls back to the browser timezone (lock §5.2:
 * `defaultTimezone` is the browser zone, not the org zone).
 */
export function resolveAttendanceSetupOrgTimezone(
  zones: readonly (string | null | undefined)[],
): string | null {
  const distinct = new Set<string>()
  for (const zone of zones) {
    const normalized = typeof zone === 'string' ? zone.trim() : ''
    if (normalized) distinct.add(normalized)
  }
  if (distinct.size !== 1) return null
  return distinct.values().next().value ?? null
}

// ---------------------------------------------------------------------------
// Prefill plan (§5.2): template + resolved timezone (+ chosen shift preset) → form values.
// ---------------------------------------------------------------------------

export interface AttendanceSetupTemplatePrefillPlan {
  templateId: AttendanceSetupTemplateId
  /** Group-form target values — only the Appendix-A fields (name/type/timezone); code, ruleSetId
   *  and description are never touched by a template. */
  group: {
    name: string
    attendanceType: AttendanceSetupTemplateGroupType
    timezone: string
  }
  /** Shift-form target values (one preset per application), or null for presetless templates. */
  shift: {
    presetKey: string
    name: string
    timezone: string
    workStartTime: string
    workEndTime: string
    lateGraceMinutes: number
    earlyGraceMinutes: number
    roundingMinutes: number
    workingDays: string
  } | null
  /** True when the template carries a Settings deep-link hint (field sales — R4: link only). */
  hasSettingsHint: boolean
}

/**
 * Build the prefill plan. Returns null (NO plan — the confirm dialog keeps apply disabled) when:
 * - the template id is unknown (enum-strict, never a silent default),
 * - the timezone is blank (§5.2④ — a template application without a resolved org/user timezone
 *   must not fall through to any implicit zone), or
 * - the template has shift presets but `shiftPresetKey` names none of them (invalid preset is a
 *   caller bug, not a "pick the first one" situation).
 */
export function buildAttendanceSetupTemplatePrefillPlan(options: {
  templateId: string
  shiftPresetKey: string | null
  timezone: string
  pickLabel: AttendanceSetupTemplateLabelPicker
}): AttendanceSetupTemplatePrefillPlan | null {
  const template = getAttendanceSetupTemplate(options.templateId)
  if (!template) return null
  const timezone = options.timezone.trim()
  if (!timezone) return null

  let shift: AttendanceSetupTemplatePrefillPlan['shift'] = null
  if (template.shiftPresets.length > 0) {
    const preset = template.shiftPresets.find((candidate) => candidate.key === options.shiftPresetKey)
    if (!preset) return null
    shift = {
      presetKey: preset.key,
      name: options.pickLabel(preset.label),
      timezone,
      workStartTime: preset.workStartTime,
      workEndTime: preset.workEndTime,
      lateGraceMinutes: preset.lateGraceMinutes,
      earlyGraceMinutes: preset.earlyGraceMinutes,
      roundingMinutes: preset.roundingMinutes,
      workingDays: preset.workingDays,
    }
  }

  return {
    templateId: template.id,
    group: {
      name: options.pickLabel(template.group.name),
      attendanceType: template.attendanceType,
      timezone,
    },
    shift,
    hasSettingsHint: template.settingsHint !== null,
  }
}
