/**
 * The single login-name (username) rule shared by every local-user writer that accepts an
 * operator-chosen login name: `POST /api/admin/users` (routes/admin-users.ts) and the DingTalk
 * directory admission (directory/directory-sync.ts, manual "create local user and bind").
 *
 * Before #6259 each writer carried its own copy of the regex and the English sentence, and only
 * the admin-users route surfaced a stable code for it. One definition here keeps the two writers
 * from drifting apart; the rule itself is unchanged.
 *
 * The input is expected to be trimmed and lowercased by the caller (both writers already do).
 */

/** Lowercase ASCII letters, digits, `.`, `_`, `-`; 3-64 characters; at least one letter. */
export const LOGIN_NAME_PATTERN = /^(?=.*[a-z])[a-z0-9._-]{3,64}$/

/** English message returned to API callers. Byte-identical to the pre-#6259 copies. */
export const LOGIN_NAME_RULE_MESSAGE =
  'Username must be 3-64 characters and include at least one letter. Only lowercase letters, numbers, dot, underscore, and dash are allowed'

/** Stable machine-readable rule code clients localise by (`error.details.rule`). */
export const LOGIN_NAME_RULE_CODE = 'login_name_ascii'

/** Error code an HTTP route answers a login-name rule failure with (400). */
export const LOGIN_NAME_RULE_ERROR_CODE = 'INVALID_USERNAME'

/** Returns the English rule message when `loginName` is present and breaks the rule, else `null`. */
export function validateLoginName(loginName: string | null | undefined): string | null {
  if (!loginName) return null
  return LOGIN_NAME_PATTERN.test(loginName) ? null : LOGIN_NAME_RULE_MESSAGE
}

/**
 * Thrown by service-layer writers (which cannot answer HTTP themselves) when the login name breaks
 * the rule. Routes recognise it by type and answer 400 `INVALID_USERNAME` with `details.rule`;
 * code that only reads `error.message` keeps seeing the unchanged English sentence.
 */
export class LoginNameRuleError extends Error {
  readonly code = LOGIN_NAME_RULE_ERROR_CODE
  readonly rule = LOGIN_NAME_RULE_CODE

  constructor() {
    super(LOGIN_NAME_RULE_MESSAGE)
    this.name = 'LoginNameRuleError'
  }
}

/** Throws {@link LoginNameRuleError} when `loginName` is present and breaks the rule. */
export function assertLoginName(loginName: string | null | undefined): void {
  if (validateLoginName(loginName) !== null) throw new LoginNameRuleError()
}
