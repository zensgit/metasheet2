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
  ).catch(() => ({ rows: [] as Array<{ org_id: string }> }))

  const grant = await query<{ enabled: boolean }>(
    `SELECT COALESCE(grant_enabled, FALSE) AS enabled
       FROM user_external_identities
      WHERE local_user_id = $1 AND provider = 'dingtalk'
      LIMIT 1`,
    [localUserId],
  ).catch(() => ({ rows: [] as Array<{ enabled: boolean }> }))

  const plan = planDirectoryDeprovision({
    localUserId,
    activationStatus: u.activation_status,
    isActive: u.is_active,
    activeOrgIds: orgs.rows.map((r) => r.org_id),
    dingtalkGrantEnabled: grant.rows[0]?.enabled === true,
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
  const effects = await listDeprovisionEffects(eventId)
  return { event: ev.rows[0], effects }
}

async function isDirectorySourceActive(directoryAccountId: string): Promise<boolean> {
  const r = await query<{ account_active: boolean; integration_status: string }>(
    `SELECT COALESCE(da.is_active, FALSE) AS account_active,
            COALESCE(di.status, '') AS integration_status
       FROM directory_accounts da
       JOIN directory_integrations di ON di.id = da.integration_id
      WHERE da.id::text = $1 OR da.id = $1::uuid
      LIMIT 1`,
    [directoryAccountId],
  ).catch(() => ({ rows: [] as Array<{ account_active: boolean; integration_status: string }> }))
  const row = r.rows[0]
  if (!row) return false
  return row.account_active === true && String(row.integration_status).toLowerCase() === 'active'
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

  const { event, effects } = await loadEventBundle(options.eventId)
  const applied = effects.filter((e: any) => e.status === 'applied') as Array<{
    id: string
    status: string
    after_active: boolean
    access_generation_at_apply: number
    effect_type: string
    org_id: string | null
  }>

  const user = await query<{ is_active: boolean; access_generation: number }>(
    `SELECT COALESCE(is_active, TRUE) AS is_active,
            COALESCE(access_generation, 0) AS access_generation
       FROM users WHERE id = $1`,
    [event.local_user_id],
  )
  if (!user.rows[0]) {
    const err = new Error('User not found')
    ;(err as Error & { code?: string }).code = 'USER_NOT_FOUND'
    throw err
  }

  const sourceActive = await isDirectorySourceActive(event.directory_account_id)

  const effectViews: RestoreEffectView[] = applied.map((e) => ({
    id: e.id,
    status: e.status,
    afterActive: e.after_active,
    accessGenerationAtApply: Number(e.access_generation_at_apply),
    effectType: e.effect_type,
  }))

  const currentMatchesAfter: Record<string, boolean> = {}
  for (const e of applied) {
    if (e.effect_type === 'set_user_inactive') {
      // after_active false means user should still be inactive for restore eligibility
      currentMatchesAfter[e.id] = user.rows[0].is_active === false
    } else if (e.effect_type === 'clear_user_orgs') {
      const org = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_orgs
          WHERE user_id = $1 AND org_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
        [event.local_user_id, e.org_id],
      ).catch(() => ({ rows: [{ n: 0 }] }))
      // after false → no active membership
      currentMatchesAfter[e.id] = (org.rows[0]?.n ?? 0) === 0
    } else if (e.effect_type === 'disable_dingtalk_grant') {
      const g = await query<{ enabled: boolean }>(
        `SELECT COALESCE(grant_enabled, FALSE) AS enabled
           FROM user_external_identities
          WHERE local_user_id = $1 AND provider = 'dingtalk' LIMIT 1`,
        [event.local_user_id],
      ).catch(() => ({ rows: [{ enabled: false }] }))
      currentMatchesAfter[e.id] = g.rows[0]?.enabled !== true
    } else {
      currentMatchesAfter[e.id] = true
    }
  }

  const eligibility = evaluateDeprovisionRestoreEligibility({
    mode: options.mode,
    directorySourceActive: sourceActive,
    currentUserAccessGeneration: Number(user.rows[0].access_generation),
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

  await transaction(async (client) => {
    await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [event.local_user_id])

    for (const e of applied) {
      if (e.effect_type === 'set_user_inactive') {
        await client.query(
          `UPDATE users SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
          [event.local_user_id],
        )
      } else if (e.effect_type === 'clear_user_orgs' && e.org_id) {
        await client.query(
          `UPDATE user_orgs SET is_active = TRUE, updated_at = NOW()
            WHERE user_id = $1 AND org_id = $2`,
          [event.local_user_id, e.org_id],
        ).catch(() => {})
      } else if (e.effect_type === 'disable_dingtalk_grant') {
        await client.query(
          `UPDATE user_external_identities
              SET grant_enabled = TRUE, updated_at = NOW()
            WHERE local_user_id = $1 AND provider = 'dingtalk'`,
          [event.local_user_id],
        ).catch(() => {})
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
          SET status = 'fully_resolved', updated_at = NOW()
        WHERE id = $1`,
      [options.eventId],
    )
  })

  return {
    eventId: options.eventId,
    mode: options.mode,
    restoredEffectCount: applied.length,
    localUserId: event.local_user_id,
    note: options.note ?? null,
    adminUserId: options.adminUserId,
  }
}
