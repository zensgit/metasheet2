// W5-2 (Wave 5 explainability design-lock 2026-07-22, RATIFIED — see
// docs/development/attendance-vnext-wave5-explainability-data-contract-lock-20260722.md §6/§9
// W5-2): pure contextual-help content module. Charter §4.6 (L216-225) verbatim:
//   "帮助内容按当前任务显示，不复制整本外部手册"
//   "适用于什么场景" / "保存后影响谁、何时生效" / "常见失败与如何恢复" / "查看计算依据/审计记录"
//   "所有帮助必须 values-free，不包含客户标识、真实用户、token、主机、内部日志路径或环境秘密。"
//
// Design discipline (lock §6 W5-2 row + charter red line 8 "不以帮助代替产品" + red line 7
// "不造第二套表单"):
//   - CLOSED-SET CONSTANTS, not free text assembled at render time — adding/changing a help entry
//     is an edit to THIS FILE (a reviewable contract change), never a prop/config value threaded in
//     at runtime.
//   - "按当前任务上下文原则挑选，不做全站帮助" (task instructions): each of the four charter
//     categories lives in EXACTLY ONE context — the context whose task most needs it — rather than
//     stuffing all four into every mount point. Charter L216 "帮助内容按当前任务显示" makes this
//     PER-CONTEXT split the compliant reading, not a shortcut:
//       'setup-wizard'         -> ① applicable_scenarios (which starter template fits) +
//                                  ② save_impact (prefill -> preview -> confirm -> save chain,
//                                  the heaviest-weight category per the task brief)
//       'import'                -> ③ failure_recovery (mapped from the EXISTING closed-set
//                                  failure taxonomies below — zero new vocabulary)
//       'self-request-center'   -> ④ evidence_link (deep link into the W5-1 decision-trace surface
//                                  — the entry point W5-1's PR body explicitly left for this slice)
//   - "不复制手册" (no long-form manual paste): every body line is a short task-context sentence,
//     never a duplicated external doc dump.
//   - "映射既有失败码闭集的人话，禁新造词表" (import category rule, lock §9 W5-2 row): the
//     failure_recovery entries are keyed ONE-PER-VALUE off the existing closed-set failure code
//     enums — `AttendanceXlsxConvertFailure` and `BlockedSpreadsheetKind` (importXlsxConvert.ts /
//     importFileGuard.ts) — zero new failure CODES are invented. The COPY itself is this module's
//     own short anticipatory-help wording rather than `xlsxConvertFailureMessage` /
//     `blockedSpreadsheetMessage`'s byte-for-byte reactive-banner text: this help panel is always
//     mounted (v-show, not v-if), so reusing that exact prose would make it permanently present in
//     `container.textContent` and collide with existing tests asserting the REACTIVE banner text is
//     absent until a real xlsx file is actually selected (`attendance-import-preview-regression.spec.ts`
//     race-guard test — a real regression caught while wiring this in, not a hypothetical). The
//     negative spec asserts the two copy surfaces stay non-identical. The backend's generic
//     `VALIDATION_ERROR` import-row rejections are NOT a stable closed set (free-form message per
//     call site, `plugins/plugin-attendance/index.cjs`) and are deliberately excluded — mapping
//     them would mean inventing a word list the backend does not actually guarantee.
//   - Zero DOM, zero fetch, zero runtime interpolation of request/user/env values — every string
//     here is a byte-fixed literal, one reused from another closed-set module, or a literal derived
//     from a compile-time constant (`IMPORT_XLSX_MAX_BYTES`) — none of the three carries runtime data.
//     values-free by construction (charter L225's six-item list: no customer id, no real user, no
//     token, no host, no internal log path, no env secret — none of those concepts appear anywhere
//     below).
//   - R1 (owner freeze ⑦ 零配置写入口): the ONLY interactive affordance this module describes is a
//     READ-ONLY navigation link (category ④) built from the EXISTING W5-1 canonical deep-link
//     builder (`buildAttendanceSelfDecisionTraceDeepLink`) — reused, not reimplemented. Nothing in
//     this module's output shape carries a write endpoint, a config-save affordance, or a request
//     body of any kind.

import {
  buildAttendanceSelfDecisionTraceDeepLink,
  type AttendanceDecisionTraceCategory,
} from './attendanceDecisionTrace'
import { ATTENDANCE_SETUP_TEMPLATES } from './attendanceSetupTemplates'
import { IMPORT_XLSX_MAX_BYTES, type AttendanceXlsxConvertFailure } from './importXlsxConvert'
import type { BlockedSpreadsheetKind } from './importFileGuard'

export type TranslateFn = (en: string, zh: string) => string

// -------------------------------------------------------------------------------------------------
// Closed sets.
// -------------------------------------------------------------------------------------------------

/** Charter §4.6 four bullets (L220-223), in charter order. */
export const ATTENDANCE_CONTEXT_HELP_CATEGORIES = [
  'applicable_scenarios',
  'save_impact',
  'failure_recovery',
  'evidence_link',
] as const
export type AttendanceContextHelpCategory = (typeof ATTENDANCE_CONTEXT_HELP_CATEGORIES)[number]

/** The three task contexts this slice mounts help into (§6 W5-2 row candidates, picked per the
 *  task instructions' own priority reading — see file header). */
export const ATTENDANCE_CONTEXT_HELP_CONTEXTS = ['setup-wizard', 'import', 'self-request-center'] as const
export type AttendanceContextHelpContextId = (typeof ATTENDANCE_CONTEXT_HELP_CONTEXTS)[number]

export function isAttendanceContextHelpContextId(value: unknown): value is AttendanceContextHelpContextId {
  return typeof value === 'string' && (ATTENDANCE_CONTEXT_HELP_CONTEXTS as readonly string[]).includes(value)
}

/** Charter L220-223 verbatim zh titles — the copy-door spec asserts these byte-for-byte. The
 *  charter is zh-only prose (no en original exists to be "verbatim" against) — the en strings are
 *  this module's own stable translation, asserted only for locale-routing (en leg renders en, not
 *  a leaked zh string), never against a nonexistent "charter verbatim en". */
export function attendanceContextHelpCategoryLabel(category: AttendanceContextHelpCategory, tr: TranslateFn): string {
  switch (category) {
    case 'applicable_scenarios':
      return tr('What this is for', '适用于什么场景')
    case 'save_impact':
      return tr('Who is affected after saving, and when it takes effect', '保存后影响谁、何时生效')
    case 'failure_recovery':
      return tr('Common failures and how to recover', '常见失败与如何恢复')
    case 'evidence_link':
      return tr('View calculation basis / audit record', '查看计算依据/审计记录')
  }
}

// -------------------------------------------------------------------------------------------------
// Display shapes.
// -------------------------------------------------------------------------------------------------

export interface AttendanceContextHelpEvidenceLink {
  /** R2 (lock §6/§9 W5-2, W4-R2 same style): canonical QUERY-form deep link, zero hash. Reused
   *  verbatim from the W5-1 builder — never reassembled by hand here. */
  href: string
  label: string
  /** Optional hint the mounting host MAY use to preset the trace category picker before
   *  navigating (mirrors the W5-1 comp_time `handleOpenSelfBalanceTrace` precedent). This is a
   *  UI-only hint value — never itself a fetch, never sent to any endpoint. */
  presetCategory?: AttendanceDecisionTraceCategory
}

export interface AttendanceContextHelpEntry {
  category: AttendanceContextHelpCategory
  title: string
  body: string[]
  /** Present iff category === 'evidence_link'. */
  link?: AttendanceContextHelpEvidenceLink
}

// -------------------------------------------------------------------------------------------------
// Entry builders (one per category; each context composes only the categories it needs).
// -------------------------------------------------------------------------------------------------

function scenariosEntry(tr: TranslateFn, body: string[]): AttendanceContextHelpEntry {
  return { category: 'applicable_scenarios', title: attendanceContextHelpCategoryLabel('applicable_scenarios', tr), body }
}

function saveImpactEntry(tr: TranslateFn, body: string[]): AttendanceContextHelpEntry {
  return { category: 'save_impact', title: attendanceContextHelpCategoryLabel('save_impact', tr), body }
}

function failureRecoveryEntry(tr: TranslateFn, body: string[]): AttendanceContextHelpEntry {
  return { category: 'failure_recovery', title: attendanceContextHelpCategoryLabel('failure_recovery', tr), body }
}

function evidenceLinkEntry(tr: TranslateFn, body: string[], link: AttendanceContextHelpEvidenceLink): AttendanceContextHelpEntry {
  return { category: 'evidence_link', title: attendanceContextHelpCategoryLabel('evidence_link', tr), body, link }
}

// ---------------------------------------------------------------------------
// 'setup-wizard' — §4.5 seven-step shell (AttendanceSetupReadiness.vue). Category ②'s
// prefill -> preview -> confirm -> save chain is the heaviest-weight content here per the task
// brief; category ① reuses the FOUR existing FE-constant templates (attendanceSetupTemplates.ts,
// W4-2 #4562) rather than inventing new scenario language.
// ---------------------------------------------------------------------------
function buildSetupWizardEntries(tr: TranslateFn): AttendanceContextHelpEntry[] {
  const templateLines = ATTENDANCE_SETUP_TEMPLATES.map(
    (template) => `${tr(template.name.en, template.name.zh)} — ${tr(template.description.en, template.description.zh)}`,
  )
  return [
    scenariosEntry(tr, [
      tr(
        'Use this checklist to see how far a new org is from its first attendance activation. The starter templates below only PREFILL forms — pick whichever is closest to how the org actually works, then adjust.',
        '本清单用于核对一个新组织距首次启用还差什么。下方起步模板仅用于预填表单——请选择与该组织实际用工方式最接近的一个，再按需调整。',
      ),
      ...templateLines,
    ]),
    saveImpactEntry(tr, [
      tr(
        'Opening or applying a template only fills the group/shift forms in memory — nothing is written yet. Every write still goes through that form\'s own preview, then confirm, then save, and only ever affects the attendance group you actually save.',
        '打开或应用模板仅在内存中预填考勤组/班次表单——此时尚未写入任何内容。所有写入仍按各自表单原有的「预览 → 确认 → 保存」顺序进行，且只影响您实际保存的那个考勤组。',
      ),
      tr(
        'This wizard never silently turns on a feature flag or notifies real people on your behalf — activation always needs an explicit save on the canonical form.',
        '本向导不会替您静默开启任何 feature flag 或通知真实人员——启用始终需要在各自表单上显式保存。',
      ),
    ]),
  ]
}

// ---------------------------------------------------------------------------
// 'import' — the CSV import panel (`attendance-admin-import` section, AttendanceView.vue). Category
// ③ only — one line per EXISTING closed-set failure code (`BlockedSpreadsheetKind` +
// `AttendanceXlsxConvertFailure`, zero new failure vocabulary — lock §9 rule) — but this module
// writes its OWN short anticipatory-help copy rather than reusing `blockedSpreadsheetMessage` /
// `xlsxConvertFailureMessage` byte-for-byte. Those two functions produce the REACTIVE error-banner
// text that a live xlsx-guard rejection renders elsewhere on this same page (AttendanceView.vue's
// dynamic import-status banner); because this help panel is ALWAYS mounted (v-show, not v-if — the
// admin-import section stays in the DOM whether or not it is the active section) their text would
// live in `container.textContent` unconditionally, which broke an unrelated existing assertion
// (`attendance-import-preview-regression.spec.ts`'s race-guard test asserts the reactive banner
// text is ABSENT before any xlsx file is selected — a real regression caught by the full guard
// run-list, not merely a naming coincidence). The two copy surfaces are kept deliberately
// non-identical in wording; the negative spec asserts this non-collision explicitly.
const IMPORT_XLSX_MAX_MB = IMPORT_XLSX_MAX_BYTES / (1024 * 1024)

// Copy is keyed by a `Record<UnionType, …>` — NOT by a hand-written array — so the closed set
// cannot silently lose a member. Gate finding P2-1 (#4576): with a literal array + an exhaustive
// `switch`, adding a fifth `AttendanceXlsxConvertFailure` and its switch branch while forgetting
// the display array compiled clean and left every spec green (`toHaveLength(6)` still held) — the
// help panel just silently dropped one recovery line. With these Records, a new union member makes
// the object literal miss a key => `vue-tsc` fails; and because the rendered list is DERIVED from
// the Record keys, the count assertion turns red too. Two independent doors, neither masking the
// other (see the per-door mutation legs in attendance-context-help.spec.ts).
const BLOCKED_SPREADSHEET_HELP_LINES: Record<BlockedSpreadsheetKind, (tr: TranslateFn) => string> = {
  xlsx: (tr) =>
    tr('A selected .xlsx workbook is blocked before upload — export it as CSV.', '选择 .xlsx 工作簿会在上传前被拦截——请导出为 CSV。'),
  xls: (tr) =>
    tr('A selected legacy .xls workbook is blocked before upload — export it as CSV.', '选择旧版 .xls 工作簿会在上传前被拦截——请导出为 CSV。'),
}

const XLSX_CONVERT_FAILURE_HELP_LINES: Record<AttendanceXlsxConvertFailure, (tr: TranslateFn) => string> = {
  'too-large': (tr) =>
    tr(
      `A workbook larger than ${IMPORT_XLSX_MAX_MB}MB is refused — export a CSV copy instead.`,
      `超过 ${IMPORT_XLSX_MAX_MB}MB 的工作簿会被拒绝——请改为导出 CSV 副本。`,
    ),
  encrypted: (tr) =>
    tr(
      'A locked / password-protected workbook cannot be converted — unlock it, or export as CSV.',
      '加密/有密码保护的工作簿无法转换——请先解除密码，或导出为 CSV。',
    ),
  empty: (tr) =>
    tr(
      'A workbook with no usable rows on any sheet converts to nothing — confirm the sheet has data, or export as CSV directly.',
      '所有工作表均无可用数据行的工作簿转换后为空——请确认工作表有数据，或直接导出为 CSV。',
    ),
  unreadable: (tr) =>
    tr(
      'A workbook that fails to parse (often a corrupted download) — re-export it as CSV.',
      '无法解析的工作簿（常见于下载损坏）——请重新导出为 CSV。',
    ),
}

/** The exact closed set the ③ help body covers, DERIVED from the copy Records above (never
 *  re-transcribed). Exported so the spec anchors on the same derivation instead of keeping its own
 *  copy of the literals — a re-transcribed list in the spec is a same-source guard that a drifting
 *  union walks straight past (gate P2-1). */
export const ATTENDANCE_IMPORT_HELP_BLOCKED_KINDS = Object.keys(
  BLOCKED_SPREADSHEET_HELP_LINES,
) as readonly BlockedSpreadsheetKind[]
export const ATTENDANCE_IMPORT_HELP_CONVERT_FAILURES = Object.keys(
  XLSX_CONVERT_FAILURE_HELP_LINES,
) as readonly AttendanceXlsxConvertFailure[]

function buildImportEntries(tr: TranslateFn): AttendanceContextHelpEntry[] {
  const spreadsheetLines = ATTENDANCE_IMPORT_HELP_BLOCKED_KINDS.map((kind) => BLOCKED_SPREADSHEET_HELP_LINES[kind](tr))
  const xlsxConvertLines = ATTENDANCE_IMPORT_HELP_CONVERT_FAILURES.map((reason) =>
    XLSX_CONVERT_FAILURE_HELP_LINES[reason](tr),
  )
  return [failureRecoveryEntry(tr, [...spreadsheetLines, ...xlsxConvertLines])]
}

// ---------------------------------------------------------------------------
// 'self-request-center' — the self-service "Adjustment Request" / 补卡申请 card
// (`attendance-overview-anomalies` section, AttendanceView.vue). Category ④ only — the deep-link
// entry point the W5-1 PR body explicitly left for this slice ("从异常行/申请行的上下文深入口按锁
// 属 W5-2"). Preset category = missing_punch: the literal 1:1 match for a makeup-punch request
// card (mirrors the W5-1 comp_time-balance「查看依据」preset precedent).
// ---------------------------------------------------------------------------
function buildSelfRequestCenterEntries(tr: TranslateFn): AttendanceContextHelpEntry[] {
  return [
    evidenceLinkEntry(
      tr,
      [
        tr(
          'Not sure why a day looks flagged? Open the read-only decision trace to see the exact evidence behind it before filing a request.',
          '不确定某天为何被标记？提交申请前，可先打开只读的决策轨迹查看背后的确切依据。',
        ),
      ],
      {
        href: buildAttendanceSelfDecisionTraceDeepLink(),
        label: tr('View basis (decision trace)', '查看依据（决策轨迹）'),
        presetCategory: 'missing_punch',
      },
    ),
  ]
}

/** Entry point: closed-set contextId -> ordered display entries (already in charter category
 *  order for that context). Enum-strict by TypeScript's exhaustive switch — an unmapped
 *  `AttendanceContextHelpContextId` literal fails to compile, and `isAttendanceContextHelpContextId`
 *  fail-closes any runtime-sourced id before it ever reaches this function. */
export function getAttendanceContextHelpEntries(
  contextId: AttendanceContextHelpContextId,
  tr: TranslateFn,
): AttendanceContextHelpEntry[] {
  switch (contextId) {
    case 'setup-wizard':
      return buildSetupWizardEntries(tr)
    case 'import':
      return buildImportEntries(tr)
    case 'self-request-center':
      return buildSelfRequestCenterEntries(tr)
  }
}
