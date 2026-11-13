/**
 * Fixed guidance for a failed DingTalk sign-in / binding / activation callback.
 *
 * The callback page never shows the server's raw `error` text (it can carry provider or account
 * values); it shows one of these fixed sentences, chosen only by the stable top-level `code` of the
 * failure response. A code that is not listed here, a missing code, an older response without a
 * code, a network failure or an unreadable body all show the fixed fallback.
 *
 * The keys mirror the set of top-level codes the backend callback can answer; both are pinned to the
 * same literal list (apps/web/tests/dingtalk-auth-callback.spec.ts and
 * packages/core-backend/tests/unit/auth-login-routes.test.ts) — change them together.
 */

type Guidance = readonly [zh: string, en: string]

const NOT_LINKED: Guidance = [
  '该钉钉账号尚未关联本地账号。请联系管理员核验身份并完成关联。',
  'This DingTalk account is not linked to a local account. Ask an administrator to verify the identity and complete the link.',
]

const TEMPORARILY_UNVERIFIABLE: Guidance = [
  '暂时无法完成核验。请稍后重新发起；不要为此更改账号或绑定。',
  'Verification is temporarily unavailable. Start again later; do not change accounts or bindings because of this.',
]

const FALLBACK: Guidance = [
  '钉钉登录或绑定未完成。请返回重新发起；如仍失败，请联系管理员。',
  'DingTalk sign-in or binding did not complete. Go back and start again; if it still fails, ask an administrator.',
]

const GUIDANCE_BY_CODE: Readonly<Record<string, Guidance>> = Object.freeze(Object.assign(Object.create(null), {
  // Not linked to a local account
  unlinked_enabled_local_user: [
    '该钉钉账号尚未关联可登录的本地账号。请联系管理员核验身份并完成关联。',
    'This DingTalk account is not linked to a local account that can sign in. Ask an administrator to verify the identity and complete the link.',
  ],
  unlinked_local_user: NOT_LINKED,

  // The linked local account cannot sign in
  local_user_disabled: [
    '关联的本地账号当前不能登录（可能已停用或已删除）。请联系管理员核查账号状态。',
    'The linked local account cannot sign in right now (it may be disabled or deleted). Ask an administrator to check the account status.',
  ],
  ACCOUNT_PENDING_ACTIVATION: [
    '关联的本地账号尚未激活，暂不能登录。请联系管理员完成激活。',
    'The linked local account has not been activated yet and cannot sign in. Ask an administrator to complete the activation.',
  ],
  ACCOUNT_ACTIVATION_INVALID: [
    '关联的本地账号激活状态异常，暂不能登录。请联系管理员核查。',
    'The linked local account has an invalid activation status and cannot sign in. Ask an administrator to check it.',
  ],

  // Not authorized / authorization turned off
  grant_required: [
    '该账号尚未获准使用钉钉登录。请联系管理员开通钉钉登录授权。',
    'This account has not been granted DingTalk sign-in. Ask an administrator to grant it.',
  ],
  grant_disabled: [
    '该账号的钉钉登录授权已关闭。请联系管理员核查。',
    'DingTalk sign-in has been turned off for this account. Ask an administrator to check it.',
  ],

  // Identity conflicts
  identity_already_bound: [
    '该钉钉身份已关联其他本地账号。请联系管理员核验；不要重复绑定或新建账号。',
    'This DingTalk identity is already linked to another local account. Ask an administrator to verify it; do not bind again or create another account.',
  ],
  identity_ambiguous: [
    '该钉钉身份对应多个本地账号，无法确定要登录哪一个。请联系管理员核验。',
    'This DingTalk identity matches more than one local account, so the account to sign in cannot be determined. Ask an administrator to verify it.',
  ],
  identity_mismatch: [
    '该钉钉身份与本地账号现有的关联不一致或已变化。请重新发起登录；如仍失败，请联系管理员核验。',
    'This DingTalk identity does not match, or no longer matches, the local account\'s existing link. Start again; if it still fails, ask an administrator to verify it.',
  ],
  repair_identity_mismatch: [
    '扫码的钉钉身份与进行中的身份修复记录不一致。请联系管理员核验。',
    'The scanned DingTalk identity does not match the identity repair in progress. Ask an administrator to verify it.',
  ],
  directory_managed_identity: [
    '该账号的钉钉身份由目录同步管理。请联系管理员处理。',
    'This account\'s DingTalk identity is managed by directory sync. Ask an administrator to handle it.',
  ],
  directory_managed_conflict: [
    '当前账号的钉钉身份由目录同步管理，不能自行绑定。请联系管理员处理。',
    'The current account\'s DingTalk identity is managed by directory sync and cannot be bound here. Ask an administrator to handle it.',
  ],
  bind_user_mismatch: [
    '发起绑定的账号与当前登录的账号不一致。请用发起绑定的账号登录后重新绑定。',
    'The account that started the binding is not the account currently signed in. Sign in with that account and start the binding again.',
  ],
  auto_provision_email_conflict: [
    '无法自动开通账号：已有使用相同邮箱的本地账号。请联系管理员核验并完成关联。',
    'An account could not be created automatically: a local account with the same email already exists. Ask an administrator to verify it and complete the link.',
  ],
  auto_provision_alias_conflict: [
    '无法自动开通账号：登录标识已被占用。请联系管理员核验。',
    'An account could not be created automatically: a sign-in identifier is already taken. Ask an administrator to verify it.',
  ],
  auto_provision_corp_required: [
    '服务器尚未配置企业，不能自动开通账号。请联系管理员。',
    'No enterprise is configured on the server, so an account cannot be created automatically. Ask an administrator.',
  ],

  // Cannot be verified right now
  grant_state_unavailable: [
    '暂时无法核验钉钉登录授权。请稍后重新发起登录；不要为此更改账号或绑定。',
    'DingTalk sign-in authorization cannot be verified right now. Start a new sign-in later; do not change accounts or bindings because of this.',
  ],
  authentication_changed: [
    '登录状态已变化。请重新发起登录。',
    'The sign-in state changed. Start a new sign-in.',
  ],

  // Administrator-started account activation through DingTalk
  activate_state_invalid: [
    '激活请求无效。请从账号管理重新发起激活。',
    'The activation request is invalid. Start the activation again from account management.',
  ],
  activate_admin_required: [
    '发起激活需要平台管理员权限。请联系管理员。',
    'Starting an activation requires platform administrator permission. Ask an administrator.',
  ],
  activate_source_ineligible: [
    '扫码的钉钉身份不符合该账号的激活条件。请联系管理员核验。',
    'The scanned DingTalk identity is not eligible to activate this account. Ask an administrator to verify it.',
  ],
  activate_target_not_found: [
    '要激活的账号不存在。请联系管理员核查。',
    'The account to activate was not found. Ask an administrator to check it.',
  ],
  activate_failed: [
    '账号激活未完成。请稍后重新发起激活；如仍失败，请联系管理员。',
    'The account activation did not complete. Start it again later; if it still fails, ask an administrator.',
  ],
  activate_commit_incomplete: [
    '账号激活没有完成。请联系管理员核查后再重新发起。',
    'The account activation did not finish. Ask an administrator to check it before starting again.',
  ],
} satisfies Record<string, Guidance>))

/** The top-level failure codes that have their own guidance (sorted). */
export const DINGTALK_CALLBACK_FAILURE_CODES: readonly string[] = Object.freeze(Object.keys(GUIDANCE_BY_CODE).sort())

const RECOVERY_BUSY_CODE = 'RECOVERY_AUTHORITY_BUSY'

function ownField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined
  return (value as Record<string, unknown>)[key]
}

function ownString(value: unknown, key: string): string | null {
  const field = ownField(value, key)
  return typeof field === 'string' ? field : null
}

/**
 * The fixed sentence for a failed callback response body (or `null` for no readable body).
 * Only the stable code is read; the `error` text is never used.
 */
export function describeDingTalkCallbackFailure(payload: unknown, isZh: boolean): string {
  const pick = (guidance: Guidance) => guidance[isZh ? 0 : 1]
  const code = ownString(payload, 'code')
  if (code !== null && Object.prototype.hasOwnProperty.call(GUIDANCE_BY_CODE, code)) {
    return pick(GUIDANCE_BY_CODE[code])
  }
  // The recovery-conflict answer nests its code inside `error` (and says to retry): a temporary state.
  if (code === null && ownString(ownField(payload, 'error'), 'code') === RECOVERY_BUSY_CODE) {
    return pick(TEMPORARILY_UNVERIFIABLE)
  }
  return pick(FALLBACK)
}

/** The fixed fallback, for failures without a response body (network errors, unexpected exceptions). */
export function dingTalkCallbackFallback(isZh: boolean): string {
  return FALLBACK[isZh ? 0 : 1]
}
