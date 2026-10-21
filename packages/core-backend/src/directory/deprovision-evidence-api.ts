/**
 * D7 support — read models and restore execution for admin evidence UI.
 */

import { query, transaction } from '../db/pg'
import { translateRecoveryConflict } from '../db/recovery-conflict'
import { invalidateUserPerms } from '../rbac/service'
import {
  resolveLeastDestructiveDirectoryDeprovisionPolicy,
} from './deprovision-planner'
import { planDirectoryDeprovisionCandidate } from './deprovision-ledger'
import {
  evaluateDeprovisionRestoreEligibility,
  type RestoreEffectView,
} from './deprovision-restore'
import { lockUsersForAccessGraphWrite } from './access-graph-mutex'

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
            status, reversed_at, reversed_by, compensation_note,
            created_at, updated_at
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

type CompensationEventRow = {
  directory_account_id: string
  globally_clear: boolean
  id: string
  integration_id: string
  local_user_id: string
  org_id: string
  status: string
}

type CompensationEffectRow = {
  effect_type: string
  grant_row_created: boolean
  id: string
  status: string
}

/**
 * Remove only the orphan deny row created by a superseded Rev 4.4 creation
 * effect. This is deliberately separate from restore: it never changes the
 * user or membership and it never runs automatically during supersede.
 */
export async function compensateSupersededDenyGrant(options: {
  eventId: string
  adminUserId: string
  confirm?: boolean
  note?: string
}) {
  if (options.confirm !== true) {
    throw restoreError(
      'COMPENSATION_CONFIRM_REQUIRED',
      'orphan deny compensation requires confirm=true',
    )
  }
  const note = options.note?.trim() ?? ''
  if (note.length < 8) {
    throw restoreError(
      'COMPENSATION_NOTE_REQUIRED',
      'orphan deny compensation requires a note (min 8 chars)',
    )
  }
  const adminUserId = String(options.adminUserId ?? '').trim()
  if (!adminUserId) {
    throw restoreError(
      'COMPENSATION_ACTOR_REQUIRED',
      'orphan deny compensation requires an administrator identity',
    )
  }

  // O2-S2: this transaction writes users / user_external_auth_grants under the access-graph
  // mutex — a marker 40001 (recovery lease held) re-raises as the named retryable
  // RecoveryConflictError; every other error (COMPENSATION_* / DRIFT_CONFLICT / 55P03 →
  // COMPENSATION_SOURCE_BUSY included) rethrows unchanged.
  const compensated = await translateRecoveryConflict(() => transaction(async (client) => {
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

    const lockedUsers = await lockUsersForAccessGraphWrite(client, [eventOwner])
    const user = lockedUsers.get(eventOwner)
    if (!user) throw restoreError('USER_NOT_FOUND', 'User not found')

    const eventResult = await client.query(
      `SELECT id::text AS id,
              org_id,
              integration_id::text AS integration_id,
              directory_account_id::text AS directory_account_id,
              local_user_id,
              globally_clear,
              status
         FROM directory_deprovision_events
        WHERE id = $1::uuid
        FOR UPDATE`,
      [options.eventId],
    )
    const event = eventResult.rows[0] as CompensationEventRow | undefined
    if (!event) throw restoreError('EVENT_NOT_FOUND', 'Deprovision event not found')
    if (event.local_user_id !== eventOwner) {
      throw restoreError(
        'DRIFT_CONFLICT',
        'Deprovision event owner changed while acquiring the user mutex',
      )
    }

    const effectsResult = await client.query(
      `SELECT id::text AS id, effect_type, grant_row_created, status
         FROM directory_deprovision_effects
        WHERE event_id = $1::uuid
        ORDER BY id
        FOR UPDATE`,
      [options.eventId],
    )
    const effects = effectsResult.rows as CompensationEffectRow[]
    const candidates = effects.filter(
      (effect) =>
        effect.effect_type === 'grant_changed'
        && effect.grant_row_created === true,
    )
    if (candidates.length !== 1) {
      throw restoreError(
        'COMPENSATION_NOT_APPLICABLE',
        'event does not contain exactly one grant-row creation effect',
      )
    }
    const effect = candidates[0]

    if (effect.status === 'compensated') {
      const residual = await client.query(
        `SELECT 1
           FROM user_external_auth_grants
          WHERE provider = 'dingtalk'
            AND local_user_id = $1::text
          LIMIT 1
          FOR UPDATE`,
        [event.local_user_id],
      )
      if (residual.rows[0]) {
        throw restoreError(
          'DRIFT_CONFLICT',
          'compensated deny-row evidence conflicts with a live DingTalk grant row',
        )
      }
      return {
        event,
        effectId: effect.id,
        accessGeneration: user.accessGeneration,
        alreadyCompensated: true,
      }
    }

    if (event.status !== 'superseded' || effect.status !== 'superseded') {
      throw restoreError(
        'COMPENSATION_EVENT_NOT_SUPERSEDED',
        'only superseded grant-row creation evidence can be compensated',
      )
    }
    if (event.globally_clear !== true) {
      throw restoreError(
        'COMPENSATION_NOT_APPLICABLE',
        'grant-row creation event was not globally clear',
      )
    }
    if (user.isActive !== true || user.activationStatus !== 'activated') {
      throw restoreError(
        'COMPENSATION_USER_INACTIVE',
        'local user must be active and activated before deny-row compensation',
      )
    }

    const liveEvidence = await client.query(
      `SELECT event.id
         FROM directory_deprovision_events event
        WHERE event.local_user_id = $1::text
          AND event.status = 'applied'
        LIMIT 1
        FOR UPDATE`,
      [event.local_user_id],
    )
    if (liveEvidence.rows[0]) {
      throw restoreError(
        'COMPENSATION_LIVE_EVIDENCE',
        'an applied deprovision event still protects this user',
      )
    }
    const liveEffect = await client.query(
      `SELECT effect.id
         FROM directory_deprovision_effects effect
        WHERE effect.local_user_id = $1::text
          AND effect.status = 'applied'
        LIMIT 1
        FOR UPDATE`,
      [event.local_user_id],
    )
    if (liveEffect.rows[0]) {
      throw restoreError(
        'COMPENSATION_LIVE_EVIDENCE',
        'an applied deprovision effect still protects this user',
      )
    }

    let sourceResult: { rows: Array<Record<string, unknown>> }
    try {
      sourceResult = await client.query(
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
          FOR SHARE OF account, integration, link NOWAIT`,
        [
          event.directory_account_id,
          event.integration_id,
          event.local_user_id,
        ],
      )
    } catch (error) {
      // Directory sync locks account rows before it reaches the canonical user
      // mutex. Never wait here while holding that mutex: fail closed and let the
      // operator retry after the source write commits.
      if ((error as { code?: unknown })?.code === '55P03') {
        throw restoreError(
          'COMPENSATION_SOURCE_BUSY',
          'the evidenced DingTalk source is being updated; retry compensation',
        )
      }
      throw error
    }
    const source = sourceResult.rows[0] as
      | {
          account_active: boolean
          integration_status: string
          link_matches: boolean
        }
      | undefined
    if (
      source?.account_active !== true
      || String(source.integration_status).toLowerCase() !== 'active'
      || source.link_matches !== true
    ) {
      throw restoreError(
        'COMPENSATION_SOURCE_INACTIVE',
        'the evidenced DingTalk source must be active and linked before compensation',
      )
    }

    const membershipResult = await client.query(
      `SELECT COALESCE(is_active, TRUE) AS is_active
         FROM user_orgs
        WHERE user_id = $1::text
          AND org_id = $2::text
        FOR SHARE`,
      [event.local_user_id, event.org_id],
    )
    if (membershipResult.rows[0]?.is_active !== true) {
      throw restoreError(
        'COMPENSATION_MEMBERSHIP_INACTIVE',
        'the evidenced organization membership must be active before compensation',
      )
    }

    const removed = await client.query(
      `DELETE FROM user_external_auth_grants
        WHERE provider = 'dingtalk'
          AND local_user_id = $1::text
          AND enabled = FALSE
          AND granted_by = 'system:directory-deprovision'
        RETURNING local_user_id`,
      [event.local_user_id],
    )
    if (!removed.rows[0]) {
      throw restoreError(
        'DRIFT_CONFLICT',
        'DingTalk deny grant row is missing, enabled, or has different provenance',
      )
    }

    const effectResult = await client.query(
      `UPDATE directory_deprovision_effects
          SET status = 'compensated',
              reversed_at = NOW(),
              reversed_by = $3::text,
              compensation_note = $4::text,
              updated_at = NOW()
        WHERE id = $1::uuid
          AND event_id = $2::uuid
          AND effect_type = 'grant_changed'
          AND grant_row_created = TRUE
          AND status = 'superseded'
        RETURNING id`,
      [effect.id, options.eventId, adminUserId, note],
    )
    if (!effectResult.rows[0]) {
      throw restoreError(
        'DRIFT_CONFLICT',
        'grant-row creation effect changed before compensation',
      )
    }

    const generationResult = await client.query(
      `UPDATE users
          SET access_generation = COALESCE(access_generation, 0) + 1,
              updated_at = NOW()
        WHERE id = $1::text
          AND COALESCE(access_generation, 0) = $2::bigint
        RETURNING access_generation`,
      [event.local_user_id, user.accessGeneration],
    )
    const nextGeneration = Number(generationResult.rows[0]?.access_generation)
    if (!Number.isFinite(nextGeneration)) {
      throw restoreError(
        'DRIFT_CONFLICT',
        'access_generation changed before compensation completion',
      )
    }

    return {
      event,
      effectId: effect.id,
      accessGeneration: nextGeneration,
      alreadyCompensated: false,
    }
  }))

  if (!compensated.alreadyCompensated) {
    invalidateUserPerms(compensated.event.local_user_id)
  }
  return {
    eventId: options.eventId,
    effectId: compensated.effectId,
    localUserId: compensated.event.local_user_id,
    compensationMode: 'orphan_deny_creation' as const,
    grantRow: compensated.alreadyCompensated
      ? ('already_absent' as const)
      : ('deleted' as const),
    effectStatus: 'compensated' as const,
    accessGeneration: compensated.accessGeneration,
    alreadyCompensated: compensated.alreadyCompensated,
    adminUserId,
    note,
  }
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

  // O2-S2: writes users under the access-graph mutex — marker 40001 → named retryable
  // RecoveryConflictError; every other error rethrows unchanged.
  const restored = await translateRecoveryConflict(() => transaction(async (client) => {
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
  }))
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
