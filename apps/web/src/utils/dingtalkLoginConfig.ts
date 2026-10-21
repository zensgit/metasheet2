/**
 * #6467: presentation helpers for the DingTalk login (OAuth) probe
 * `GET /api/auth/dingtalk/launch?probe=1`.
 *
 * The backend reports `missingEnv` as documented variable NAMES (an entry with `|` means
 * "either name satisfies it"). The web side only renders entries from this closed list, so an
 * unexpected or value-bearing string in the response can never reach the page.
 */

export const DINGTALK_LOGIN_ENV_REQUIREMENTS = [
  'DINGTALK_CLIENT_ID|DINGTALK_APP_KEY',
  'DINGTALK_CLIENT_SECRET|DINGTALK_APP_SECRET',
  'DINGTALK_REDIRECT_URI',
] as const

export type DingTalkLoginEnvRequirement = typeof DINGTALK_LOGIN_ENV_REQUIREMENTS[number]

export const DINGTALK_REDIRECT_URI_REQUIREMENT: DingTalkLoginEnvRequirement = 'DINGTALK_REDIRECT_URI'

/** Known requirements present in `value`, in canonical order; anything else is dropped. */
export function readDingTalkMissingEnv(value: unknown): DingTalkLoginEnvRequirement[] {
  if (!Array.isArray(value)) return []
  const reported = new Set(value.filter((item): item is string => typeof item === 'string'))
  return DINGTALK_LOGIN_ENV_REQUIREMENTS.filter((requirement) => reported.has(requirement))
}

/** `DINGTALK_CLIENT_ID|DINGTALK_APP_KEY` -> `DINGTALK_CLIENT_ID（或 DINGTALK_APP_KEY）`. */
export function formatDingTalkLoginEnvRequirement(
  requirement: DingTalkLoginEnvRequirement,
  isZh: boolean,
): string {
  const [primary, alias] = requirement.split('|')
  if (!alias) return primary
  return isZh ? `${primary}（或 ${alias}）` : `${primary} (or ${alias})`
}

export function formatDingTalkLoginEnvList(
  requirements: readonly DingTalkLoginEnvRequirement[],
  isZh: boolean,
): string {
  return requirements
    .map((requirement) => formatDingTalkLoginEnvRequirement(requirement, isZh))
    .join(isZh ? '、' : ', ')
}

/** Reason -> the single requirement it names (used when an older backend sends no missingEnv). */
export function requirementForDingTalkReason(reason: unknown): DingTalkLoginEnvRequirement | null {
  if (reason === 'missing_client_id') return DINGTALK_LOGIN_ENV_REQUIREMENTS[0]
  if (reason === 'missing_client_secret') return DINGTALK_LOGIN_ENV_REQUIREMENTS[1]
  if (reason === 'missing_redirect_uri') return DINGTALK_LOGIN_ENV_REQUIREMENTS[2]
  return null
}
