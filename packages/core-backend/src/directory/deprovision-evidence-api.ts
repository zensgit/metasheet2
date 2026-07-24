/**
 * D7 support — read models and restore execution for admin evidence UI.
 */

import { query, transaction } from '../db/pg'
import { planDirectoryDeprovision } from './deprovision-planner'
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

export async function previewDeprovisionForUser(localUserId: string) {
  const user = await query<{
    id: string
    activation_status: string | null
    is_active: boolean
    access_generation: number | null
  }>(
    `SELECT id,
            COALESCE(activation_status, 'activated') AS activation_status,
            COALESCE(is_active, TRUE) AS is_active,
            COALESCE(access_generation, 0) AS access_generation
       FROM users WHERE id = $1`,
    [localUserId],
  )
  if (!user.rows[0]) {
    const err = new Error('User not found')
    ;(err as Error & { code?: string }).code = 'USER_NOT_FOUND'
    throw err
  }
  const u = user.rows[0]

  const orgs = await query<{ org_id: string }>(
    `SELECT org_id FROM user_orgs WHERE user_id = $1 AND COALESCE(is_active, TRUE) = TRUE`,
    [localUserId],
  )

  // The DingTalk grant lives in `user_external_auth_grants` — the table `dingtalk-oauth.ts`
  // itself reads at login. An earlier cut read `user_external_identities.grant_enabled`, a
  // column no migration has ever created, behind a `.catch` that turned the resulting error into
  // "no grant": the preview could therefore never show a grant effect, whatever the truth was.
  // No `.catch` here either — a preview that cannot read the access graph must say so rather
  // than quietly under-report what deprovision would take away.
  const grant = await query<{ enabled: boolean }>(
    `SELECT enabled
       FROM user_external_auth_grants
      WHERE local_user_id = $1 AND provider = 'dingtalk'
      LIMIT 1`,
    [localUserId],
  )

  const plan = planDirectoryDeprovision({
    localUserId,
    // Preview answers "what would deprovision do to this person if it fired", so it asks the
    // most permissive policy and the globally-clear branch; the writer re-decides both under the
    // per-user lock against that person's actual integration policy.
    policy: 'mark_inactive',
    activationStatus: u.activation_status,
    membershipOrgId: orgs.rows[0]?.org_id ?? null,
    membershipActive: orgs.rows.length > 0,
    dingtalkGrantEnabled: grant.rows[0]?.enabled === true,
    userActive: u.is_active,
    globallyClear: true,
  })

  return {
    flags: readDeprovisionRuntimeFlags(),
    user: {
      id: u.id,
      activationStatus: u.activation_status,
      isActive: u.is_active,
      accessGeneration: Number(u.access_generation ?? 0),
    },
    // A person can hold memberships in several orgs while a deprovision event is anchored to ONE
    // (`UNIQUE (event_id, effect_type)`, and the writer is scoped to the integration's org). The
    // plan below therefore models the first; the full set is reported so the admin is not shown a
    // single membership effect and left to assume it is the only one.
    activeOrgIds: orgs.rows.map((r) => r.org_id),
    plan,
  }
}

export async function listDeprovisionEvents(options: {
  integrationId?: string
  localUserId?: string
  limit?: number
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
  ).catch(() => ({ rows: [] }))
  return result.rows
}

export async function listDeprovisionEffects(eventId: string) {
  const result = await query(
    `SELECT id, event_id, local_user_id, org_id, effect_type,
            before_active, after_active, access_generation_at_apply,
            status, reversed_at, created_at, updated_at
       FROM directory_deprovision_effects
      WHERE event_id = $1
      ORDER BY created_at ASC`,
    [eventId],
  ).catch(() => ({ rows: [] }))
  return result.rows
}

async function loadEventBundle(eventId: string) {
  const ev = await query<{
    id: string
    local_user_id: string
    access_generation_at_apply: number
    status: string
    directory_account_id: string
  }>(
    `SELECT id, local_user_id, access_generation_at_apply, status, directory_account_id
       FROM directory_deprovision_events WHERE id = $1`,
    [eventId],
  )
  if (!ev.rows[0]) {
    const err = new Error('Deprovision event not found')
    ;(err as Error & { code?: string }).code = 'EVENT_NOT_FOUND'
    throw err
  }
  return { event: ev.rows[0] }
}

type ReadClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }

/**
 * "Is the person still gone according to the directory?" — the question that separates a rehire
 * restore from an admin force. Takes the caller's client so the restore transaction reads it
 * under the same lock as everything else it decides on; no `.catch` swallow, because a read
 * failure here would otherwise present as "source inactive" and silently push an eligible rehire
 * onto the force path.
 */
async function isDirectorySourceActive(
  directoryAccountId: string,
  client: ReadClient = { query: (sql, params) => query(sql, params) },
): Promise<boolean> {
  const r = await client.query(
    `SELECT COALESCE(da.is_active, FALSE) AS account_active,
            COALESCE(di.status, '') AS integration_status
       FROM directory_accounts da
       JOIN directory_integrations di ON di.id = da.integration_id
      WHERE da.id = $1::uuid
      LIMIT 1`,
    [directoryAccountId],
  )
  const row = r.rows[0] as { account_active?: boolean; integration_status?: string } | undefined
  if (!row) return false
  return row.account_active === true && String(row.integration_status ?? '').toLowerCase() === 'active'
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

  const { event } = await loadEventBundle(options.eventId)

  // §5.4: eligibility turns on `access_generation` being UNCHANGED since the event was applied.
  // Deciding that outside the transaction and then writing inside it is a check-then-act: a
  // concurrent access-graph write (admin deactivate, a newer deprovision) could bump the
  // generation in between, and the restore would proceed on an eligibility verdict that was true
  // only in the past — replaying a stale `before` over whatever the newer writer decided. The
  // whole decision therefore happens under the same `users` row lock that guards the write.
  const restored = await transaction(async (client) => {
    const lockedUserResult = await client.query(
      `SELECT COALESCE(is_active, TRUE) AS is_active,
              COALESCE(access_generation, 0) AS access_generation
         FROM users WHERE id = $1 FOR UPDATE`,
      [event.local_user_id],
    )
    const lockedUser = lockedUserResult.rows[0] as
      | { is_active: boolean; access_generation: number }
      | undefined
    if (!lockedUser) {
      const err = new Error('User not found')
      ;(err as Error & { code?: string }).code = 'USER_NOT_FOUND'
      throw err
    }

    const effects = await client.query(
      `SELECT id, status, after_active, access_generation_at_apply, effect_type, org_id
         FROM directory_deprovision_effects
        WHERE event_id = $1
        ORDER BY created_at ASC`,
      [options.eventId],
    )
    const applied = (effects.rows as Array<{
      id: string
      status: string
      after_active: boolean
      access_generation_at_apply: number
      effect_type: string
      org_id: string | null
    }>).filter((e) => e.status === 'applied')

    const sourceActive = await isDirectorySourceActive(event.directory_account_id, client)

    const effectViews: RestoreEffectView[] = applied.map((e) => ({
      id: e.id,
      status: e.status,
      afterActive: e.after_active,
      accessGenerationAtApply: Number(e.access_generation_at_apply),
      effectType: e.effect_type,
    }))

    const currentMatchesAfter: Record<string, boolean> = {}
    for (const e of applied) {
      if (e.effect_type === 'user_changed') {
        // after_active false means user should still be inactive for restore eligibility
        currentMatchesAfter[e.id] = lockedUser.is_active === false
      } else if (e.effect_type === 'membership_changed') {
        const org = await client.query(
          `SELECT count(*)::int AS n FROM user_orgs
            WHERE user_id = $1 AND org_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
          [event.local_user_id, e.org_id],
        )
        // after false → no active membership
        currentMatchesAfter[e.id] = Number((org.rows[0] as { n?: number } | undefined)?.n ?? 0) === 0
      } else if (e.effect_type === 'grant_changed') {
        const g = await client.query(
          `SELECT enabled
             FROM user_external_auth_grants
            WHERE local_user_id = $1 AND provider = 'dingtalk' LIMIT 1`,
          [event.local_user_id],
        )
        currentMatchesAfter[e.id] = (g.rows[0] as { enabled?: boolean } | undefined)?.enabled !== true
      } else {
        currentMatchesAfter[e.id] = true
      }
    }

    const eligibility = evaluateDeprovisionRestoreEligibility({
      mode: options.mode,
      directorySourceActive: sourceActive,
      currentUserAccessGeneration: Number(lockedUser.access_generation),
      eventAccessGeneration: Number(event.access_generation_at_apply),
      effects: effectViews,
      currentMatchesAfter,
    })

    if (eligibility.ok === false) {
      const err = new Error(eligibility.message)
      ;(err as Error & { code?: string }).code =
        eligibility.code === 'DRIFT' ? 'DRIFT_CONFLICT' : eligibility.code
      throw err
    }

    for (const e of applied) {
      // No `.catch` on any of these: a restore that silently fails to give access back is worse
      // than one that fails loudly — the admin would be told the person was restored while the
      // grant or membership stayed revoked.
      if (e.effect_type === 'user_changed') {
        await client.query(
          `UPDATE users SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
          [event.local_user_id],
        )
      } else if (e.effect_type === 'membership_changed' && e.org_id) {
        await client.query(
          `UPDATE user_orgs SET is_active = TRUE, updated_at = NOW()
            WHERE user_id = $1 AND org_id = $2`,
          [event.local_user_id, e.org_id],
        )
      } else if (e.effect_type === 'grant_changed') {
        await client.query(
          `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
           VALUES ('dingtalk', $1, TRUE, $2, NOW(), NOW())
           ON CONFLICT (provider, local_user_id)
           DO UPDATE SET enabled = TRUE, updated_at = NOW()`,
          [event.local_user_id, `admin:${options.adminUserId}`],
        )
      }
      await client.query(
        `UPDATE directory_deprovision_effects
            SET status = 'reversed', reversed_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [e.id],
      )
    }

    await client.query(
      `UPDATE users
          SET access_generation = COALESCE(access_generation, 0) + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [event.local_user_id],
    )

    await client.query(
      `UPDATE directory_deprovision_events
          SET status = 'fully_resolved',
              restore_mode = $2,
              resolved_at = NOW(),
              resolved_by = $3,
              resolve_note = $4,
              updated_at = NOW()
        WHERE id = $1`,
      [options.eventId, options.mode, options.adminUserId, options.note ?? null],
    )

    return applied.length
  })

  return {
    eventId: options.eventId,
    mode: options.mode,
    restoredEffectCount: restored,
    localUserId: event.local_user_id,
    note: options.note ?? null,
    adminUserId: options.adminUserId,
  }
}
