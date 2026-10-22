/**
 * DingTalk person-message recipient status — ONE definition of "can this local user be reached".
 *
 * 客户反馈 2026-10-21 item 1: a rule author typed a local user id the sheet roster does not list (a
 * directory-synced user with no multitable role), the editor showed no DingTalk link status for it, and
 * the real run reached 0 people. The send path (automation-executor.ts, send_dingtalk_person_message) and
 * the rule editor's preflight (routes/automation.ts, POST …/automations/dingtalk-person-recipient-status)
 * therefore read the SAME query, so the editor can never say "linked" for a user the sender would skip.
 *
 * Conditions (unchanged from the sender, DT-OPS-04): the user row exists; `is_active`; and the most
 * recently updated `directory_account_links` row with `link_status = 'linked'` to an ACTIVE `dingtalk`
 * `directory_accounts` row, whose `external_user_id` is the DingTalk userid (its integration is carried
 * so the sender can notify with the right corp's credentials).
 */

export type DingTalkPersonRecipientStatusQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>

/** $1 = text[] of local user ids. Byte-identical to what the sender ran before it was shared. */
export const DINGTALK_PERSON_RECIPIENT_STATUS_SQL = `SELECT u.id AS local_user_id,
              u.is_active AS local_user_active,
              linked.external_user_id AS dingtalk_user_id,
              linked.integration_id AS integration_id
         FROM users u
         LEFT JOIN LATERAL (
           SELECT a.external_user_id, a.integration_id::text AS integration_id
             FROM directory_account_links l
             JOIN directory_accounts a ON a.id = l.directory_account_id
            WHERE l.local_user_id = u.id
              AND l.link_status = 'linked'
              AND a.provider = 'dingtalk'
              AND a.is_active = TRUE
            ORDER BY a.updated_at DESC
            LIMIT 1
         ) linked ON TRUE
        WHERE u.id = ANY($1::text[])`

/** Most ids one preflight request may ask about (a rule's typed recipient list, not a directory scan). */
export const DINGTALK_PERSON_RECIPIENT_STATUS_MAX_IDS = 200
/** Longest local user id the preflight accepts (ids are opaque text; this only bounds the request). */
export const DINGTALK_PERSON_RECIPIENT_STATUS_MAX_ID_LENGTH = 256

/** Booleans only — no name, email, DingTalk userid or integration ever leaves this module. */
export interface DingTalkPersonRecipientStatus {
  userId: string
  exists: boolean
  active: boolean
  dingtalkLinked: boolean
}

export type DingTalkPersonRecipientIdsParse =
  | { ok: true; userIds: string[] }
  | { ok: false; code: 'USER_IDS_REQUIRED' | 'INVALID_USER_IDS' | 'TOO_MANY_USER_IDS' }

// C0 controls and DEL: an id carrying them is not something a person typed into the editor.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** Validate + trim + dedupe the request's `userIds`. Order of first appearance is kept. */
export function parseDingTalkPersonRecipientIds(raw: unknown): DingTalkPersonRecipientIdsParse {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, code: 'USER_IDS_REQUIRED' }
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') return { ok: false, code: 'INVALID_USER_IDS' }
    const id = entry.trim()
    if (!id || id.length > DINGTALK_PERSON_RECIPIENT_STATUS_MAX_ID_LENGTH || CONTROL_CHARS.test(id)) {
      return { ok: false, code: 'INVALID_USER_IDS' }
    }
    seen.add(id)
    if (seen.size > DINGTALK_PERSON_RECIPIENT_STATUS_MAX_IDS) return { ok: false, code: 'TOO_MANY_USER_IDS' }
  }
  return { ok: true, userIds: Array.from(seen) }
}

/**
 * Status of each requested id, in request order. An id with no user row → all false. `dingtalkLinked`
 * is the link itself (an inactive user may still be linked); the sender reaches a user only when
 * `active && dingtalkLinked`.
 */
export async function readDingTalkPersonRecipientStatuses(
  queryFn: DingTalkPersonRecipientStatusQueryFn,
  userIds: string[],
): Promise<DingTalkPersonRecipientStatus[]> {
  if (userIds.length === 0) return []
  const result = await queryFn(DINGTALK_PERSON_RECIPIENT_STATUS_SQL, [userIds])
  const byId = new Map<string, { active: boolean; linked: boolean }>()
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const localUserId = typeof row.local_user_id === 'string' ? row.local_user_id.trim() : ''
    if (!localUserId || byId.has(localUserId)) continue
    const dingtalkUserId = typeof row.dingtalk_user_id === 'string' ? row.dingtalk_user_id.trim() : ''
    byId.set(localUserId, { active: row.local_user_active === true, linked: dingtalkUserId.length > 0 })
  }
  return userIds.map((userId) => {
    const found = byId.get(userId)
    return {
      userId,
      exists: Boolean(found),
      active: found?.active ?? false,
      dingtalkLinked: found?.linked ?? false,
    }
  })
}
