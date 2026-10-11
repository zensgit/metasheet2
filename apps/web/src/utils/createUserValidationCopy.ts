import type { PasswordRequirementLocale } from './passwordRequirements'

/**
 * Localised copy for create-user validation failures, keyed by the backend's machine-readable
 * codes (never by its English prose):
 * - `PASSWORD_POLICY_FAILED` carries `details.reasons` (one code per failed rule, index-aligned
 *   with the English `details.details` strings);
 * - `INVALID_USERNAME` carries `details.rule === 'login_name_ascii'`.
 * Anything this module does not recognise returns `null` so the caller keeps the server message.
 */

export type PasswordPolicyReason =
  | 'too_short'
  | 'too_long'
  | 'no_lowercase'
  | 'no_uppercase'
  | 'no_digit'
  | 'weak_pattern'

export type CreateUserErrorPayload = {
  code?: unknown
  message?: unknown
  details?: unknown
}

const PASSWORD_REASON_COPY: Record<PasswordRequirementLocale, Record<PasswordPolicyReason, string>> = {
  zh: {
    too_short: '至少 8 位',
    too_long: '不超过 128 位',
    no_lowercase: '要有小写字母',
    no_uppercase: '要有大写字母',
    no_digit: '要有数字',
    weak_pattern: '不能包含 123456、password、qwerty、abc123、letmein、admin 这类常见片段（不区分大小写）',
  },
  en: {
    too_short: 'at least 8 characters',
    too_long: 'at most 128 characters',
    no_lowercase: 'at least one lowercase letter',
    no_uppercase: 'at least one uppercase letter',
    no_digit: 'at least one number',
    weak_pattern: 'must not contain common fragments such as 123456, password, qwerty, abc123, letmein, or admin (case-insensitive)',
  },
}

const PASSWORD_FAILED_PREFIX: Record<PasswordRequirementLocale, string> = {
  zh: '密码不符合要求：',
  en: 'Password does not meet requirements: ',
}

const LIST_SEPARATOR: Record<PasswordRequirementLocale, string> = {
  zh: '；',
  en: '; ',
}

const LOGIN_NAME_RULE_COPY: Record<PasswordRequirementLocale, string> = {
  zh: '登录名只能用小写字母、数字和 . _ -，3–64 位且至少一个字母；中文姓名请填「姓名」栏',
  en: 'Login name may only use lowercase letters, digits, and . _ -, 3-64 characters with at least one letter; put a Chinese name in the Name field',
}

const CREATE_USER_RULE_HINTS: Record<PasswordRequirementLocale, { loginName: string; password: string }> = {
  zh: {
    loginName: '登录名：只能用小写字母、数字和 . _ -，3–64 位且至少一个字母；中文姓名请填「姓名」栏。',
    password: '初始密码：8–128 位，要同时有大写字母、小写字母和数字，不能包含 123456、password 这类常见片段；留空则自动生成临时密码。',
  },
  en: {
    loginName: 'Login name: lowercase letters, digits, and . _ - only, 3-64 characters with at least one letter; put a Chinese name in the Name field.',
    password: 'Initial password: 8-128 characters with an uppercase letter, a lowercase letter, and a number, and no common fragments such as 123456 or password; leave blank to generate a temporary password.',
  },
}

// W1-6: the create form's org selector sends `attendanceOrgId`; the server validates it against an
// existing org anchor. Values-free: the copy never echoes the org id back.
const ATTENDANCE_ORG_ERROR_COPY: Record<PasswordRequirementLocale, Record<'ATTENDANCE_ORG_NOT_FOUND' | 'ATTENDANCE_ORG_CONFLICT', string>> = {
  zh: {
    ATTENDANCE_ORG_NOT_FOUND: '所选组织尚未在目录中建立，未创建用户；请改选其他组织或不指定组织',
    ATTENDANCE_ORG_CONFLICT: '所选组织与考勤组/默认班次所属的组织不一致，未创建用户',
  },
  en: {
    ATTENDANCE_ORG_NOT_FOUND: 'The selected organization is not set up in the directory, so the user was not created; choose another organization or leave it unset',
    ATTENDANCE_ORG_CONFLICT: 'The selected organization does not match the organization of the attendance group or default shift, so the user was not created',
  },
}

const KNOWN_PASSWORD_REASONS = new Set<string>(Object.keys(PASSWORD_REASON_COPY.zh))

function isPasswordPolicyReason(value: unknown): value is PasswordPolicyReason {
  return typeof value === 'string' && KNOWN_PASSWORD_REASONS.has(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Fragments for each failed password rule. An unrecognised reason code falls back to the
 * server's index-aligned English string when present, so a rule added server-side is never
 * silently dropped from the message.
 */
export function describePasswordPolicyReasons(
  reasons: readonly unknown[],
  locale: PasswordRequirementLocale,
  serverDetails: readonly unknown[] = [],
): string[] {
  const fragments: string[] = []
  reasons.forEach((reason, index) => {
    if (isPasswordPolicyReason(reason)) {
      fragments.push(PASSWORD_REASON_COPY[locale][reason])
      return
    }
    const fallback = serverDetails[index]
    if (typeof fallback === 'string' && fallback.trim()) fragments.push(fallback.trim())
  })
  return fragments
}

/** Localised banner text for a create-user API error, or `null` when there is no mapping. */
export function describeCreateUserError(
  error: CreateUserErrorPayload | null | undefined,
  locale: PasswordRequirementLocale,
): string | null {
  if (!error) return null
  const details = asRecord(error.details)
  if (error.code === 'PASSWORD_POLICY_FAILED') {
    const reasons = Array.isArray(details?.reasons) ? details.reasons as unknown[] : []
    const serverDetails = Array.isArray(details?.details) ? details.details as unknown[] : []
    const fragments = describePasswordPolicyReasons(reasons, locale, serverDetails)
    if (fragments.length === 0) return null
    return PASSWORD_FAILED_PREFIX[locale] + fragments.join(LIST_SEPARATOR[locale])
  }
  if (error.code === 'INVALID_USERNAME' && details?.rule === 'login_name_ascii') {
    return LOGIN_NAME_RULE_COPY[locale]
  }
  if (error.code === 'ATTENDANCE_ORG_NOT_FOUND' || error.code === 'ATTENDANCE_ORG_CONFLICT') {
    return ATTENDANCE_ORG_ERROR_COPY[locale][error.code]
  }
  return null
}

export function getCreateUserRuleHints(locale: PasswordRequirementLocale): { loginName: string; password: string } {
  return CREATE_USER_RULE_HINTS[locale]
}
