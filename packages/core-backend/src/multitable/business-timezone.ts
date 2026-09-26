/**
 * Multitable instance business timezone — 客户反馈 2026-09-24 #4c（日期时间显示），裁定见 PR #6074.
 *
 * Owner ruling: date-times are STORED as UTC instants (unchanged) but DISPLAYED and PARSED in ONE business
 * timezone — never the browser's local zone. This module is the server half: it resolves the instance
 * default the web adopts when a dateTime field names no zone of its own.
 *
 *   MULTITABLE_BUSINESS_TIMEZONE  — an IANA zone id (e.g. `Asia/Shanghai`, `Asia/Tokyo`). Trimmed; any
 *                                   value the platform `Intl` rejects (and unset / blank) falls back to
 *                                   {@link DEFAULT_BUSINESS_TIMEZONE} (Asia/Shanghai). Unset is the
 *                                   intended normal state for a China deployment — no env change needed.
 *
 * Exposed to the web as `businessTimezone` on GET /api/multitable/context and GET /api/multitable/form-context.
 * The value is a zone id — no host, credential or tenant data — so echoing it (including to an anonymous
 * public-form caller) discloses nothing beyond which wall clock the instance shows.
 *
 * Registered in scripts/ops/global-history-flag-manifest.mjs (AGENTS.md: every new env flag is listed).
 */
import { Logger } from '../core/logger'
import { isValidIanaTimeZone } from './automation-timezone'

export const BUSINESS_TIMEZONE_ENV_KEY = 'MULTITABLE_BUSINESS_TIMEZONE'

/** Owner ruling (PR #6074): the business timezone when nothing else names one. */
export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Shanghai'

const logger = new Logger('MultitableBusinessTimezone')

// Warn once per distinct bad value, not once per request. The value itself is NOT logged (values-free).
let lastWarnedRaw: string | null = null

export function resolveMultitableBusinessTimezone(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[BUSINESS_TIMEZONE_ENV_KEY]
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return DEFAULT_BUSINESS_TIMEZONE
  if (isValidIanaTimeZone(trimmed)) return trimmed
  if (lastWarnedRaw !== trimmed) {
    lastWarnedRaw = trimmed
    logger.warn(
      `${BUSINESS_TIMEZONE_ENV_KEY} is not a valid IANA timezone — using ${DEFAULT_BUSINESS_TIMEZONE}`,
    )
  }
  return DEFAULT_BUSINESS_TIMEZONE
}
