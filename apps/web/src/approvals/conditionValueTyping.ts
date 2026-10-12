import type { ConditionRule, FormFieldType, FormFieldVisibilityOperator, FormOption } from '../types/approval'
import { CONDITION_RULE_OPERATORS } from './conditionEdit'

// R-43 (B) — condition values are authored by the dependency field's TYPE. PURE logic module (no
// .vue / Element Plus import) shared by the visibility editors (Designer 2.0 inspector + legacy
// inline editor), the condition-branch editor, and the read-only summaries (`conditionSummary.ts`,
// `fieldVisibility.ts describeFieldVisibilityRule`). It must NOT import templateAuthoring.ts: the
// summaries ship on the member-facing bundle and must not drag the authoring module along.
//
// Evaluation is NOT changed anywhere (FE `fieldVisibility.ts evaluateRule` and the backend executor
// stay byte-identical). The editors only store the value in the type those evaluators already
// compare against:
//   - single select → the option VALUE string (never its label);
//   - multi select  → visibility `in` values / branch `in` value as an ARRAY of option values;
//   - number        → a JS number (a numeric STRING never matches `===`);
//   - `in`          → always an array.
// The issue helpers below mirror the same evaluators, so an editor can MARK a stored rule that cannot
// work as intended: a value no current option carries, a non-number on a number field, an `in` that
// holds a single value, a LIST under a single-value operator (eq/neq/gt/gte/lt/lte — eq never
// matches, neq always matches; an empty list included), a non-string value compared strictly
// (eq/neq/in) against a text-type field (e.g. a number left behind when the field was retyped from
// number to text: `'5' === 5` never matches), a non-date value ordered (gt/gte/lt/lte) against a
// date field (the executor turns the date into a timestamp, so the result never depends on the
// date), or an operator a multi-select cannot use. Marking is display-only: never a save/publish
// blocker, never a rewrite.

export type ConditionValueKind = 'option-single' | 'option-multi' | 'number' | 'text'

/** Minimal description of the field a condition value is compared against. */
export interface ConditionValueField {
  type: FormFieldType
  options?: readonly FormOption[]
  /**
   * The submitted form value is a LIST for this field although its kind is not option-multi (a
   * multi-person picker). The executor's `in` then also matches a single stored value
   * (`formValue.includes(value)`), so a scalar `in` is not marked there.
   */
  listValued?: boolean
}

export function conditionValueKind(field: ConditionValueField | null | undefined): ConditionValueKind {
  if (!field) return 'text'
  if (field.type === 'select') return 'option-single'
  if (field.type === 'multi-select') return 'option-multi'
  if (field.type === 'number') return 'number'
  return 'text'
}

export function isOptionKind(kind: ConditionValueKind): boolean {
  return kind === 'option-single' || kind === 'option-multi'
}

const MULTI_VISIBILITY_OPERATORS: readonly FormFieldVisibilityOperator[] = ['in', 'isEmpty', 'notEmpty']
const ALL_VISIBILITY_OPERATORS: readonly FormFieldVisibilityOperator[] = ['eq', 'neq', 'in', 'isEmpty', 'notEmpty']
const MULTI_CONDITION_OPERATORS: readonly ConditionRule['operator'][] = ['in', 'isEmpty']

/**
 * Visibility operators that can take effect for this kind. A multi-select value is an array, so
 * `eq`/`neq` (`===` / `!==` against a scalar) never / always match — only `in` (array `some`) and
 * the emptiness checks are meaningful.
 */
export function visibilityOperatorsFor(kind: ConditionValueKind): FormFieldVisibilityOperator[] {
  return kind === 'option-multi' ? [...MULTI_VISIBILITY_OPERATORS] : [...ALL_VISIBILITY_OPERATORS]
}

/** Branch-condition operators that can take effect for this kind (same reasoning; `in` + `isEmpty`). */
export function conditionOperatorsFor(kind: ConditionValueKind): ConditionRule['operator'][] {
  return kind === 'option-multi' ? [...MULTI_CONDITION_OPERATORS] : [...CONDITION_RULE_OPERATORS]
}

/** A finite number from a number or a trimmed numeric string; null otherwise. */
export function parseConditionNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/**
 * One-value-per-line text → list. Lines are trimmed and blanks dropped; for a number field each
 * line becomes a number when it parses, and an unparsable line is kept verbatim (so the editor can
 * mark it instead of silently dropping what the author typed).
 */
export function parseConditionListText(text: string, kind: ConditionValueKind): unknown[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (kind !== 'number') return lines
  return lines.map((line) => parseConditionNumber(line) ?? line)
}

export function formatConditionListText(values: readonly unknown[]): string {
  return values.map((value) => (value === null || value === undefined ? '' : String(value))).join('\n')
}

export function sameConditionList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

/** The option label for a stored option value, or null (not an option field / not found). */
export function optionLabelForValue(field: ConditionValueField | null | undefined, value: unknown): string | null {
  if (!field || !isOptionKind(conditionValueKind(field)) || typeof value !== 'string') return null
  const option = (field.options ?? []).find((candidate) => candidate.value === value)
  return option ? option.label : null
}

/** True for an option field that declares at least one option. */
export function hasOptions(field: ConditionValueField | null | undefined): boolean {
  return Boolean(field) && isOptionKind(conditionValueKind(field)) && (field!.options ?? []).length > 0
}

/** True when `value` is one of the field's current option values. */
export function isCurrentOptionValue(field: ConditionValueField | null | undefined, value: unknown): boolean {
  return typeof value === 'string' && (field?.options ?? []).some((option) => option.value === value)
}

/**
 * Picker key for a stored single-option value that is not a STRING (option values always are), so
 * the picker shows the invalid-value placeholder instead of an option whose text happens to match.
 * Never saved: the placeholder entry is disabled.
 */
export const STALE_OPTION_KEY = '\u0000condition-value-not-an-option'

export type ConditionValueIssue =
  | 'operator-not-effective'
  | 'value-not-option'
  | 'in-not-list'
  | 'list-not-scalar'
  | 'not-number'
  | 'not-text'
  | 'not-date'

function isBlankValue(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

function isDateField(field: ConditionValueField): boolean {
  return field.type === 'date' || field.type === 'datetime'
}

/**
 * True when gt/gte/lt/lte can order this stored value against a date: the executor turns a
 * `YYYY-MM-DD…` string that parses as a date into a timestamp (the same thing it does to the date
 * form value). Anything else — a number, a numeric string, a malformed date — is compared as-is
 * against that timestamp, so the outcome never depends on the date entered.
 */
function isComparableDateValue(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}(?:$|[T\s].*)/.test(text)) return false
  // Lenient on purpose (the mark is advisory): a browser that rejects the space-separated form the
  // server accepts must not mark a working rule, so the `T` form is tried as well.
  return !Number.isNaN(Date.parse(text)) || !Number.isNaN(Date.parse(text.replace(' ', 'T')))
}

/**
 * `strict`: the operator compares with `===` / `includes` (eq/neq/in). Only then can a non-string
 * value never match a text-type field's string value; gt/gte/lt/lte normalise both sides in the
 * executor (a number/date compared against text still works there), so they are never marked.
 */
function valueIssues(
  values: readonly unknown[],
  field: ConditionValueField,
  numberCheck: (value: unknown) => boolean,
  strict: boolean,
): ConditionValueIssue[] {
  // `strict === false` ⇔ gt/gte/lt/lte (branch rules only; visibility rules have no ordering).
  const kind = conditionValueKind(field)
  const present = values.filter((value) => !isBlankValue(value))
  const issues: ConditionValueIssue[] = []
  if (isOptionKind(kind) && hasOptions(field) && present.some((value) => !isCurrentOptionValue(field, value))) {
    issues.push('value-not-option')
  }
  if (kind === 'number' && present.some((value) => !numberCheck(value))) {
    issues.push('not-number')
  }
  if (kind === 'text' && strict && present.some((value) => typeof value !== 'string')) {
    issues.push('not-text')
  }
  if (!strict && isDateField(field) && present.some((value) => !isComparableDateValue(value))) {
    issues.push('not-date')
  }
  return issues
}

/**
 * Why a stored VISIBILITY rule can never take effect against `field` (empty = fine / not yet
 * filled in). `field === null` (dependency missing) is left to the existing validators.
 */
export function visibilityRuleValueIssues(
  rule: { operator: FormFieldVisibilityOperator; value?: unknown; values?: unknown[] } | undefined,
  field: ConditionValueField | null,
): ConditionValueIssue[] {
  if (!rule || !field) return []
  const kind = conditionValueKind(field)
  if (!visibilityOperatorsFor(kind).includes(rule.operator)) return ['operator-not-effective']
  if (rule.operator === 'isEmpty' || rule.operator === 'notEmpty') return []
  // eq/neq compare one value with `===` / `!==`: a stored LIST (even an empty one) never / always matches.
  if (rule.operator !== 'in' && Array.isArray(rule.value)) return ['list-not-scalar']
  const values = rule.operator === 'in'
    ? (Array.isArray(rule.values) ? rule.values : [])
    : [rule.value]
  return valueIssues(values, field, isFiniteNumber, true)
}

/**
 * Why a stored BRANCH rule can never take effect against `field`. Mirrors the backend executor:
 * `in` needs an array (except where the form value itself is an array — a multi-select, a
 * multi-person picker — which `includes` a scalar); gt/gte/lt/lte normalise a
 * numeric string (but a date field only orders against a date string), eq/neq/in compare strictly.
 */
export function conditionRuleValueIssues(
  rule: { operator: ConditionRule['operator']; value?: unknown },
  field: ConditionValueField | null,
): ConditionValueIssue[] {
  if (!field) return []
  const kind = conditionValueKind(field)
  if (!conditionOperatorsFor(kind).includes(rule.operator)) return ['operator-not-effective']
  if (rule.operator === 'isEmpty') return []
  const value = rule.value
  if (isBlankValue(value)) return []
  // eq/neq/gt/gte/lt/lte compare ONE value: a stored list (even an empty one) never matches (neq:
  // always matches). An empty `in` list is simply not filled in yet.
  if (rule.operator !== 'in' && Array.isArray(value)) return ['list-not-scalar']
  if (Array.isArray(value) && value.length === 0) return []
  const issues: ConditionValueIssue[] = []
  if (rule.operator === 'in' && !Array.isArray(value) && kind !== 'option-multi' && !field.listValued) {
    issues.push('in-not-list')
  }
  const values = Array.isArray(value) ? value : [value]
  const comparesNormalised = rule.operator === 'gt' || rule.operator === 'gte' || rule.operator === 'lt' || rule.operator === 'lte'
  issues.push(...valueIssues(
    values,
    field,
    comparesNormalised ? (entry) => parseConditionNumber(entry) !== null : isFiniteNumber,
    !comparesNormalised,
  ))
  return issues
}

// --- copy (authoring surfaces; values-free: never a field value, option value, or id) ----------

export interface ConditionValueCopy {
  issueTitle: string
  issueOperatorNotEffective: string
  issueValueNotOption: string
  issueInNotList: string
  issueListNotScalar: string
  issueNotNumber: string
  issueNotText: string
  issueNotDate: string
  /** Prefix of the read-only note under a box shown empty because its stored value is marked. */
  storedValuePrefix: string
  chooseOption: string
  chooseOptions: string
  noOptions: string
  invalidValue: string
  staleListHint: (count: number) => string
  enterNumber: string
  oneValuePerLine: string
  oneNumberPerLine: string
  invalidNumber: string
  notApplicableSuffix: string
  visibilityInLabelText: string
  visibilityInLabelOption: string
}

export const CONDITION_VALUE_COPY_ZH: ConditionValueCopy = {
  issueTitle: '条件已失效：',
  issueOperatorNotEffective: '多选字段不能使用这个条件类型（「等于」类永远不成立，「不等于」永远成立），无法按预期生效，请重新选择条件类型。',
  issueValueNotOption: '已保存的值不在当前选项中（选项可能已被删除），此条件不会生效，请重新选择。',
  issueInNotList: '「包含于」需要一组值，当前只保存了单个值，此条件不会生效，请重新填写或选择。',
  issueListNotScalar: '这个条件类型只能比较单个值，当前保存的是一组值，无法按预期生效，请重新填写或选择。',
  issueNotNumber: '数值字段的比较值不是数字，此条件不会生效，请重新填写。',
  issueNotText: '比较值的类型与字段类型不一致（字段可能改过类型），此条件不会生效，请重新填写。',
  issueNotDate: '日期字段只能和日期比较大小，当前比较值不是日期，比较结果与所填日期无关，无法按预期生效，请按「年-月-日」重新填写。',
  storedValuePrefix: '原值：',
  chooseOption: '请选择选项',
  chooseOptions: '请选择一个或多个选项',
  noOptions: '依赖字段还没有选项，请先添加选项。',
  invalidValue: '（已失效的值）',
  staleListHint: (count: number) => `另有 ${count} 个已失效的值，修改勾选后将被移除。`,
  enterNumber: '请输入数字',
  oneValuePerLine: '每行一个值',
  oneNumberPerLine: '每行一个数字',
  invalidNumber: '请输入有效的数字。',
  notApplicableSuffix: '（不适用）',
  visibilityInLabelText: '包含任一（每行一个值）',
  visibilityInLabelOption: '包含任一',
}

export const CONDITION_VALUE_COPY_EN: ConditionValueCopy = {
  issueTitle: 'Condition not in effect: ',
  issueOperatorNotEffective: 'This condition type does not work on a multi-select field ("equals"-type conditions never match, "not equals" always matches). Choose another condition type.',
  issueValueNotOption: 'The saved value is not one of the current options (it may have been deleted), so this condition never takes effect. Choose again.',
  issueInNotList: 'The "in" condition needs a list of values; it holds a single value and never takes effect. Enter or choose the values again.',
  issueListNotScalar: 'This condition type compares a single value, but a list of values is saved, so it does not work as intended. Enter or choose the value again.',
  issueNotNumber: 'The value for a number field is not a number, so this condition never takes effect. Enter it again.',
  issueNotText: 'The saved value does not match the field type (the field type may have changed), so this condition never takes effect. Enter it again.',
  issueNotDate: 'A date field can only be compared with a date. The saved value is not a date, so the result does not depend on the date entered and the condition does not work as intended. Enter it again as year-month-day.',
  storedValuePrefix: 'Saved value: ',
  chooseOption: 'Choose an option',
  chooseOptions: 'Choose one or more options',
  noOptions: 'The field has no options yet. Add options first.',
  invalidValue: '(invalid value)',
  staleListHint: (count: number) => `${count} saved value(s) are no longer options and will be removed when you change the selection.`,
  enterNumber: 'Enter a number',
  oneValuePerLine: 'One value per line',
  oneNumberPerLine: 'One number per line',
  invalidNumber: 'Enter a valid number.',
  notApplicableSuffix: ' (not applicable)',
  visibilityInLabelText: 'Contains any (one per line)',
  visibilityInLabelOption: 'Contains any',
}

export function conditionValueCopy(isZh: boolean): ConditionValueCopy {
  return isZh ? CONDITION_VALUE_COPY_ZH : CONDITION_VALUE_COPY_EN
}

export function conditionValueIssueMessage(issue: ConditionValueIssue, isZh: boolean): string {
  const copy = conditionValueCopy(isZh)
  switch (issue) {
    case 'operator-not-effective':
      return copy.issueOperatorNotEffective
    case 'value-not-option':
      return copy.issueValueNotOption
    case 'in-not-list':
      return copy.issueInNotList
    case 'list-not-scalar':
      return copy.issueListNotScalar
    case 'not-number':
      return copy.issueNotNumber
    case 'not-text':
      return copy.issueNotText
    case 'not-date':
      return copy.issueNotDate
  }
}

/** Title + every issue message, one line (empty when there are no issues). */
export function conditionValueIssueText(issues: readonly ConditionValueIssue[], isZh: boolean): string {
  if (issues.length === 0) return ''
  const copy = conditionValueCopy(isZh)
  return `${copy.issueTitle}${issues.map((issue) => conditionValueIssueMessage(issue, isZh)).join(' ')}`
}

// --- marked values the text boxes show EMPTY ----------------------------------------------------

/**
 * Issues whose stored value a free-text box shows EMPTY instead of its text. Element Plus's
 * `el-input` emits nothing when the typed text equals the text it already shows, so re-entering a
 * marked value exactly as displayed (`5` for a number on a text field, `a` for a single value under
 * `in`, `a` for a one-entry list under `eq`) would change nothing and keep the mark. Shown empty,
 * re-entering it is a real edit that stores the right shape. The stored value is never rewritten on
 * load; the editors show it separately as a read-only note (see `conditionStoredValuePreview`).
 */
const BLANKED_TEXT_ISSUES: readonly ConditionValueIssue[] = ['not-text', 'in-not-list', 'list-not-scalar']

export function conditionValueShowsBlank(issues: readonly ConditionValueIssue[]): boolean {
  return issues.some((issue) => BLANKED_TEXT_ISSUES.includes(issue))
}

/**
 * Whether a free-entry box's marked stored value gets the read-only「stored value」note: every
 * text-box case above, plus a number box holding a non-number (it never hands one to
 * `el-input-number`, so the box is empty — e.g. the common pre-R-43 `'5000'` under eq). Option
 * pickers are excluded by the callers (they show their own invalid-value placeholders). A number
 * `in` list is a textarea, not `el-input-number`: it may still SHOW a non-number line (e.g. while
 * it is being typed), so the callers also require that textarea's displayed text to be empty.
 */
export function conditionStoredValueNoteShown(issues: readonly ConditionValueIssue[]): boolean {
  return conditionValueShowsBlank(issues) || issues.includes('not-number')
}

const STORED_VALUE_PREVIEW_MAX = 60

/**
 * Read-only preview of a stored condition value (rendered as plain text, never as HTML): a string
 * as-is, anything else as JSON, so a list (`[1,2]`) and a joined string (`'1,2'`) look different.
 * A number and its digit string both read `5`; the issue text next to the note says which one is
 * stored. Line breaks are flattened and the text is cut to a short length with an ellipsis.
 */
export function conditionStoredValuePreview(value: unknown, maxLength = STORED_VALUE_PREVIEW_MAX): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  const flat = text.replace(/\s*[\r\n]+\s*/g, ' ⏎ ')
  const chars = Array.from(flat)
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : flat
}
