/**
 * D7 support — read models and restore execution for admin evidence UI.
 */

import { query, transaction } from '../db/pg'
import { invalidateUserPerms } from '../rbac/service'
import {
  resolveLeastDestructiveDirectoryDeprovisionPolicy,
} from './deprovision-planner'
import { planDirectoryDeprovisionCandidate } from './deprovision-ledger'
import {
  evaluateDeprovisionRestoreEligibility,
  type RestoreEffectView,
} from './deprovision-restore'

export function readDeprovisionRuntimeFlags() {
  const enabled = ['true', '1', 'yes'].includes(
    String(process.env.DIRECTORY_DEPROVISION_ENABLED ?? '').trim().toLowerCase(),
  )
  const maxBatchRaw = Number(process.env.DIRECTORY_DEPROVISION_MAX_BATCH ?? 25)
  const maxBatch = Number.isFinite(maxBatchRaw) && maxBatchRaw > 0 ? Math.floor(maxBatchRaw) : 25
  return {
    enabled,
    maxBatch,
    policyNote: '策略≠已执行：default_deprovision_policy 仅在 DIRECTORY_DEPROVISION_ENABLED=true 时由同步 writer 执行',
  }
}

export async function previewDeprovisionForUser(localUserId: string, integrationId: string) {
  return transaction(async (client) => {
    // Preview spans user, integration, account, sibling, membership and grant reads.
    // A read-only repeatable snapshot prevents a mixed-time plan while sync is changing
    // those rows. This must be the first statement in the transaction.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const read = async <T extends Record<string, unknown>>(
      statement: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> => {
      const result = await client.query(statement, params)
      return { rows: result.rows as T[] }
    }

    const user = await read<{
      id: string
      activation_status: string | null
      is_active: boolean
      access_generation: number | null
    }>(
      `SELECT id,
              activation_status,
              COALESCE(is_active, TRUE) AS is_active,
              COALESCE(access_generation, 0) AS access_generation
         FROM users
        WHERE id = $1`,
      [localUserId],
    )
    if (!user.rows[0]) {
      const err = new Error('User not found')
      ;(err as Error & { code?: string }).code = 'USER_NOT_FOUND'
      throw err
    }
    const currentUser = user.rows[0]

    const integration = await read<{
      org_id: string
      default_deprovision_policy: string
    }>(
      `SELECT org_id, default_deprovision_policy
         FROM directory_integrations
        WHERE id = $1::uuid`,
      [integrationId],
    )
    if (!integration.rows[0]) {
      const err = new Error('Directory integration not found')
      ;(err as Error & { code?: string }).code = 'INTEGRATION_NOT_FOUND'
      throw err
    }
    const orgId = integration.rows[0].org_id

    const prospectiveAccounts = await read<{
      id: string
      deprovision_policy_override: string | null
    }>(
      `SELECT account.id::text AS id,
              account.deprovision_policy_override
         FROM directory_account_links link
         JOIN directory_accounts account
           ON account.id = link.directory_account_id
        WHERE link.local_user_id = $1::text
          AND link.link_status = 'linked'
          AND account.integration_id = $2::uuid
          AND account.is_active = TRUE
        ORDER BY account.id`,
      [localUserId, integrationId],
    )
    const prospectiveDeactivatedAccountIds = prospectiveAccounts.rows.map(
      (account) => account.id,
    )
    const policy = resolveLeastDestructiveDirectoryDeprovisionPolicy(
      integration.rows[0].default_deprovision_policy,
      prospectiveAccounts.rows.map(
        (account) => account.deprovision_policy_override,
      ),
    )
    if (prospectiveDeactivatedAccountIds.length === 0) {
      return {
        flags: readDeprovisionRuntimeFlags(),
        user: {
          id: currentUser.id,
          activationStatus: currentUser.activation_status,
          isActive: currentUser.is_active,
          accessGeneration: Number(currentUser.access_generation ?? 0),
        },
        prospectiveDeactivatedAccountIds,
        plan: {
          localUserId,
          skipReason: 'no_active_linked_accounts',
          effects: [],
        },
      }
    }

    const { plan, snapshot } = await planDirectoryDeprovisionCandidate(
      {
        query: async (statement, params) => {
          const result = await read<Record<string, unknown>>(statement, params)
          return { rows: result.rows }
        },
      },
      {
        localUserId,
        orgId,
        integrationId,
        directoryAccountId: prospectiveDeactivatedAccountIds[0],
        policy,
        write: false,
        prospectiveDeactivatedAccountIds,
        requireSourceInactive: false,
      },
    )

    return {
      flags: readDeprovisionRuntimeFlags(),
      user: {
        id: localUserId,
        activationStatus: snapshot.activationStatus,
        isActive: snapshot.isActive,
        accessGeneration: snapshot.accessGeneration,
      },
      prospectiveDeactivatedAccountIds,
      plan,
    }
  })
}

export async function listDeprovisionEvents(options: {
  integrationId?: string
  localUserId?: string
  limit?: number
  status?: 'applied' | 'fully_resolved' | 'superseded'
}) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const clauses: string[] = []
  const params: unknown[] = []
  if (options.integrationId) {
    params.push(options.integrationId)
    clauses.push(`e.integration_id = $${params.length}`)
  }
  if (options.localUserId) {
    params.push(options.localUserId)
    clauses.push(`e.local_user_id = $${params.length}`)
  }
  if (options.status) {
    params.push(options.status)
    clauses.push(`e.status = $${params.length}`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  params.push(limit)
  const result = await query(
    `SELECT e.id, e.org_id, e.integration_id, e.directory_account_id, e.local_user_id,
            e.run_id, e.triggered_by, e.event_origin, e.access_generation_at_apply,
            e.status, e.created_at, e.updated_at,
            (SELECT count(*)::int FROM directory_deprovision_effects fx
              WHERE fx.event_id = e.id AND fx.status = 'applied') AS open_effect_count
       FROM directory_deprovision_events e
       ${where}
       ORDER BY e.created_at DESC
       LIMIT $${params.length}`,
    params,
  )
  return result.rows
}

export async function listDeprovisionEffects(eventId: string) {
  const result = await query(
    `SELECT id, event_id, local_user_id, org_id, effect_type,
            before_active, after_active, grant_row_created,
            access_generation_at_apply,
            status, reversed_at, created_at, updated_at
       FROM directory_deprovision_effects
      WHERE event_id = $1
      ORDER BY created_at ASC`,
    [eventId],
  )
  return result.rows
}

type RestoreEventRow = {
  access_generation_at_apply: string | number
  directory_account_id: string
  id: string
  integration_id: string
  local_user_id: string
  status: string
}

type RestoreEffectRow = {
  access_generation_at_apply: string | number
  after_active: boolean
  before_active: boolean
  effect_type: string
  grant_row_created: boolean
  id: string
  org_id: string | null
  status: string
}

function restoreError(code: string, message: string): Error {
  const error = new Error(message)
  ;(error as Error & { code?: string }).code = code
  return error
}

/**
 * Restore open effects for an event (rehire or admin_force).
 */
export async function restoreDeprovisionEvent(options: {
  eventId: string
  mode: 'rehire' | 'admin_force'
  adminUserId: string
  confirm?: boolean
  note?: string
}) {
  if (options.mode === 'admin_force') {
    if (options.confirm !== true) {
      const err = new Error('admin_force requires confirm=true')
      ;(err as Error & { code?: string }).code = 'FORCE_CONFIRM_REQUIRED'
      throw err
    }
    if (!options.note || options.note.trim().length < 8) {
      const err = new Error('admin_force requires a note (min 8 chars)')
      ;(err as Error & { code?: string }).code = 'FORCE_NOTE_REQUIRED'
      throw err
    }
  }

  const restored = await transaction(async (client) => {
    // Event identity is DB-immutable. Read only the owner first so the canonical
    // users-row mutex remains the first blocking lock shared with every other
    // access-graph writer.
    const ownerResult = await client.query(
      `SELECT local_user_id
         FROM directory_deprovision_events
        WHERE id = $1::uuid`,
      [options.eventId],
    )
    const eventOwner = String(ownerResult.rows[0]?.local_user_id ?? '')
    if (!eventOwner) {
      throw restoreError('EVENT_NOT_FOUND', 'Deprovision event not found')
    }

    const userResult = await client.query(
      `SELECT id,
              email,
              username,
              mobile,
              activation_status,
              COALESCE(is_active, TRUE) AS is_active,
              COALESCE(access_generation, 0) AS access_generation
         FROM users
        WHERE id = $1::text
        FOR UPDATE`,
      [eventOwner],
    )
    const user = userResult.rows[0] as
      | {
          access_generation: string | number
          activation_status: string | null
          email: string | null
          id: string
          is_active: boolean
          mobile: string | null
          username: string | null
        }
      | undefined
    if (!user) throw restoreError('USER_NOT_FOUND', 'User not found')

    const eventResult = await client.query(
      `SELECT id::text AS id,
              integration_id::text AS integration_id,
              directory_account_id::text AS directory_account_id,
              local_user_id,
              access_generation_at_apply,
              status
         FROM directory_deprovision_events
        WHERE id = $1::uuid
        FOR UPDATE`,
      [options.eventId],
    )
    const event = eventResult.rows[0] as RestoreEventRow | undefined
    if (!event) {
      throw restoreError('EVENT_NOT_FOUND', 'Deprovision event not found')
    }
    if (event.local_user_id !== eventOwner) {
      throw restoreError(
        'DRIFT_CONFLICT',
        'Deprovision event owner changed while acquiring the user mutex',
      )
    }
    if (event.status !== 'applied') {
      throw restoreError(
        'EVENT_NOT_APPLIED',
        'Deprovision event is no longer applied',
      )
    }

    const effectsResult = await client.query(
      `SELECT id::text AS id,
              effect_type,
              org_id,
              before_active,
              after_active,
              grant_row_created,
              access_generation_at_apply,
              status
         FROM directory_deprovision_effects
        WHERE event_id = $1::uuid
        ORDER BY id
        FOR UPDATE`,
      [options.eventId],
    )
    const effects = effectsResult.rows as RestoreEffectRow[]
    const applied = effects.filter((effect) => effect.status === 'applied')
    if (effects.some((effect) => effect.status !== 'applied')) {
      throw restoreError(
        'EVENT_NOT_APPLIED',
        'Deprovision event has effects that are no longer applied',
      )
    }

    let sourceActive = false
    if (options.mode === 'rehire') {
      const sourceResult = await client.query(
        `SELECT account.is_active AS account_active,
                integration.status AS integration_status,
                link.link_status = 'linked' AS link_matches
           FROM directory_accounts account
           JOIN directory_integrations integration
             ON integration.id = account.integration_id
           JOIN directory_account_links link
             ON link.directory_account_id = account.id
            AND link.local_user_id = $3::text
          WHERE account.id = $1::uuid
            AND integration.id = $2::uuid
          FOR SHARE OF account, integration, link`,
        [
          event.directory_account_id,
          event.integration_id,
          event.local_user_id,
        ],
      )
      const source = sourceResult.rows[0] as
        | {
            account_active: boolean
            integration_status: string
            link_matches: boolean
          }
        | undefined
      sourceActive =
        source?.account_active === true
        && String(source.integration_status).toLowerCase() === 'active'
        && source.link_matches === true
    }

    const currentMatchesAfter: Record<string, boolean> = {}
    for (const effect of applied) {
      if (effect.effect_type === 'user_changed') {
        currentMatchesAfter[effect.id] =
          user.is_active === effect.after_active
      } else if (effect.effect_type === 'membership_changed') {
        if (!effect.org_id) {
          throw restoreError(
            'EFFECT_TYPE_UNSUPPORTED',
            'membership_changed effect is missing org_id',
          )
        }
        const membership = await client.query(
          `SELECT COALESCE(is_active, TRUE) AS is_active
             FROM user_orgs
            WHERE user_id = $1::text AND org_id = $2::text`,
          [event.local_user_id, effect.org_id],
        )
        currentMatchesAfter[effect.id] =
          (membership.rows[0]?.is_active === true) === effect.after_active
      } else if (
        effect.effect_type === 'grant_changed'
        && effect.grant_row_created === true
      ) {
        // Rev 4.4 creation effect: after-state is "row EXISTS and is disabled" — presence is
        // the change, so a missing row is drift, not a match.
        const grant = await client.query(
          `SELECT enabled
             FROM user_external_auth_grants
            WHERE local_user_id = $1::text
              AND provider = 'dingtalk'
            LIMIT 1`,
          [event.local_user_id],
        )
        currentMatchesAfter[effect.id] =
          grant.rows[0] !== undefined && grant.rows[0].enabled !== true
      } else if (effect.effect_type === 'grant_changed') {
        const grant = await client.query(
          `SELECT enabled
             FROM user_external_auth_grants
            WHERE local_user_id = $1::text
              AND provider = 'dingtalk'
            LIMIT 1`,
          [event.local_user_id],
        )
        currentMatchesAfter[effect.id] =
          (grant.rows[0]?.enabled === true) === effect.after_active
      } else {
        throw restoreError(
          'EFFECT_TYPE_UNSUPPORTED',
          `Unsupported deprovision effect type: ${effect.effect_type}`,
        )
      }
    }

    const effectViews: RestoreEffectView[] = effects.map((effect) => ({
      id: effect.id,
      status: effect.status,
      afterActive: effect.after_active,
      accessGenerationAtApply: Number(effect.access_generation_at_apply),
      effectType: effect.effect_type,
    }))
    const eventGeneration = Number(event.access_generation_at_apply)
    const eligibility = evaluateDeprovisionRestoreEligibility({
      mode: options.mode,
      directorySourceActive: sourceActive,
      currentUserAccessGeneration: Number(user.access_generation),
      eventAccessGeneration: eventGeneration,
      effects: effectViews,
      currentMatchesAfter,
    })
    if (eligibility.ok === false) {
      throw restoreError(
        eligibility.code === 'DRIFT'
          ? 'DRIFT_CONFLICT'
          : eligibility.code,
        eligibility.message,
      )
    }

    for (const effect of applied) {
      if (effect.effect_type === 'user_changed') {
        const changed = await client.query(
          `UPDATE users
              SET is_active = $2::boolean, updated_at = NOW()
            WHERE id = $1::text
              AND COALESCE(is_active, TRUE) IS NOT DISTINCT FROM $3::boolean
            RETURNING id`,
          [event.local_user_id, effect.before_active, effect.after_active],
        )
        if (!changed.rows[0]) {
          throw restoreError(
            'DRIFT_CONFLICT',
            'User active state changed before restore',
          )
        }
      } else if (effect.effect_type === 'membership_changed') {
        const changed = await client.query(
          `UPDATE user_orgs
              SET is_active = $3::boolean
            WHERE user_id = $1::text
              AND org_id = $2::text
              AND COALESCE(is_active, TRUE) IS NOT DISTINCT FROM $4::boolean
            RETURNING user_id`,
          [
            event.local_user_id,
            effect.org_id,
            effect.before_active,
            effect.after_active,
          ],
        )
        if (!changed.rows[0]) {
          throw restoreError(
            'DRIFT_CONFLICT',
            `membership row missing or changed for org ${effect.org_id}`,
          )
        }
      } else if (
        effect.effect_type === 'grant_changed'
        && effect.grant_row_created === true
      ) {
        // Rev 4.4 reversal of a deny-row CREATION: restore ABSENCE by deleting the row. The
        // enabled = FALSE predicate is the drift gate — if the row was re-enabled or replaced
        // since apply, deleting it would destroy state this ledger never created.
        const removed = await client.query(
          `DELETE FROM user_external_auth_grants
            WHERE provider = 'dingtalk'
              AND local_user_id = $1::text
              AND enabled = FALSE
            RETURNING local_user_id`,
          [event.local_user_id],
        )
        if (!removed.rows[0]) {
          throw restoreError(
            'DRIFT_CONFLICT',
            'DingTalk deny grant row missing or changed before restore',
          )
        }
      } else if (effect.effect_type === 'grant_changed') {
        const changed = await client.query(
          `INSERT INTO user_external_auth_grants (
             provider, local_user_id, enabled, granted_by, created_at, updated_at
           ) VALUES ('dingtalk', $1::text, $2::boolean, $3::text, NOW(), NOW())
           ON CONFLICT (provider, local_user_id)
           DO UPDATE SET enabled = EXCLUDED.enabled,
                         granted_by = EXCLUDED.granted_by,
                         updated_at = NOW()
                 WHERE user_external_auth_grants.enabled
                       IS NOT DISTINCT FROM $4::boolean
           RETURNING local_user_id`,
          [
            event.local_user_id,
            effect.before_active,
            `restore:${options.adminUserId}`,
            effect.after_active,
          ],
        )
        if (!changed.rows[0]) {
          throw restoreError(
            'DRIFT_CONFLICT',
            'DingTalk grant state changed before restore',
          )
        }
      }

      const reversed = await client.query(
        `UPDATE directory_deprovision_effects
            SET status = 'reversed',
                reversed_at = NOW(),
                reversed_by = $3::text,
                updated_at = NOW()
          WHERE id = $1::uuid
            AND event_id = $2::uuid
            AND status = 'applied'
            AND access_generation_at_apply = $4::bigint
          RETURNING id`,
        [
          effect.id,
          options.eventId,
          options.adminUserId,
          eventGeneration,
        ],
      )
      if (!reversed.rows[0]) {
        throw restoreError(
          'DRIFT_CONFLICT',
          `effect ${effect.id} changed before restore`,
        )
      }
    }

    const generation = await client.query(
      `UPDATE users
          SET access_generation = COALESCE(access_generation, 0) + 1,
              updated_at = NOW()
        WHERE id = $1::text
          AND COALESCE(access_generation, 0) = $2::bigint
        RETURNING access_generation`,
      [event.local_user_id, eventGeneration],
    )
    if (!generation.rows[0]) {
      throw restoreError(
        'DRIFT_CONFLICT',
        'access_generation changed before restore completion',
      )
    }

    const resolved = await client.query(
      `UPDATE directory_deprovision_events
          SET status = 'fully_resolved',
              resolved_at = NOW(),
              resolved_by = $2::text,
              resolve_note = $3::text,
              restore_mode = $4::text,
              updated_at = NOW()
        WHERE id = $1::uuid
          AND status = 'applied'
          AND access_generation_at_apply = $5::bigint
        RETURNING id`,
      [
        options.eventId,
        options.adminUserId,
        options.mode === 'admin_force'
          ? options.note!.trim()
          : 'rehire restore after the directory source became active',
        options.mode,
        eventGeneration,
      ],
    )
    if (!resolved.rows[0]) {
      throw restoreError(
        'DRIFT_CONFLICT',
        'Deprovision event changed before restore completion',
      )
    }

    return {
      event,
      effectsReversed: applied.map((effect) => effect.effect_type),
      localUser: {
        id: user.id,
        email: user.email,
        username: user.username,
        mobile: user.mobile,
        isActive:
          applied.find((effect) => effect.effect_type === 'user_changed')
            ?.before_active ?? user.is_active,
        activationStatus: user.activation_status,
      },
      restoredEffectCount: applied.length,
    }
  })
  invalidateUserPerms(restored.event.local_user_id)

  return {
    eventId: options.eventId,
    restoreMode: options.mode,
    restoredEffectCount: restored.restoredEffectCount,
    localUserId: restored.event.local_user_id,
    localUser: restored.localUser,
    effectsReversed: restored.effectsReversed,
    passwordUnchanged: true,
    passwordResetHint:
      'Use the existing administrator password-reset flow when local credentials need to change.',
    note: options.note ?? null,
    adminUserId: options.adminUserId,
  }
}
