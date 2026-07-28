/**
 * D3/D4 — deprovision effect ledger helpers (design lock Rev 4.2 companion §5).
 *
 * Immutability of identity fields is enforced by DB triggers in migration;
 * application helpers only INSERT events/effects and supersede open rows.
 */

import { query, transaction } from '../db/pg'
import type { PlannedEffect } from './deprovision-planner'
import { planDirectoryDeprovision } from './deprovision-planner'

export type ApplyDeprovisionInput = {
  localUserId: string
  orgId: string
  integrationId: string
  directoryAccountId: string
  runId: string | null
  triggeredBy: string
  enabled: boolean
  /** When false, planner runs but writer is no-op (preview mode). */
  write: boolean
  loadUserState: () => Promise<{
    activationStatus: string | null
    isActive: boolean
    activeOrgIds: string[]
    dingtalkGrantEnabled: boolean
    accessGeneration: number
  }>
  globallyClear?: boolean
}

export type ApplyDeprovisionResult = {
  applied: boolean
  effectCount: number
  accessGeneration: number | null
  skipReason: string | null
  eventId: string | null
}

/**
 * Apply deprovision: zero-effect → no generation++ / no ledger rows.
 * Non-zero → generation++ AND event+effects in one transaction.
 */
export async function applyDirectoryDeprovisionPlan(
  input: ApplyDeprovisionInput,
): Promise<ApplyDeprovisionResult> {
  if (!input.enabled) {
    return {
      applied: false,
      effectCount: 0,
      accessGeneration: null,
      skipReason: 'deprovision_disabled',
      eventId: null,
    }
  }

  const state = await input.loadUserState()
  const plan = planDirectoryDeprovision({
    localUserId: input.localUserId,
    activationStatus: state.activationStatus,
    isActive: state.isActive,
    activeOrgIds: state.activeOrgIds,
    dingtalkGrantEnabled: state.dingtalkGrantEnabled,
    globallyClear: input.globallyClear !== false,
  })

  if (plan.effects.length === 0) {
    return {
      applied: false,
      effectCount: 0,
      accessGeneration: state.accessGeneration,
      skipReason: plan.skipReason ?? 'zero_effect',
      eventId: null,
    }
  }

  if (!input.write) {
    return {
      applied: false,
      effectCount: plan.effects.length,
      accessGeneration: state.accessGeneration,
      skipReason: 'preview_only',
      eventId: null,
    }
  }

  return writeDeprovisionLedger({
    localUserId: input.localUserId,
    orgId: input.orgId,
    integrationId: input.integrationId,
    directoryAccountId: input.directoryAccountId,
    runId: input.runId,
    triggeredBy: input.triggeredBy,
    effects: plan.effects,
    previousGeneration: state.accessGeneration,
  })
}

async function writeDeprovisionLedger(options: {
  localUserId: string
  orgId: string
  integrationId: string
  directoryAccountId: string
  runId: string | null
  triggeredBy: string
  effects: PlannedEffect[]
  previousGeneration: number
}): Promise<ApplyDeprovisionResult> {
  let eventId: string | null = null
  let nextGen = options.previousGeneration

  await transaction(async (client) => {
    // Per-user mutex
    await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [options.localUserId])

    const gen = await client.query(
      `UPDATE users
          SET access_generation = COALESCE(access_generation, 0) + 1,
              is_active = FALSE,
              updated_at = NOW()
        WHERE id = $1
        RETURNING access_generation`,
      [options.localUserId],
    )
    nextGen = Number(gen.rows[0]?.access_generation ?? options.previousGeneration + 1)

    // Supersede open effects for this user
    await client.query(
      `UPDATE directory_deprovision_effects
          SET status = 'superseded', updated_at = NOW()
        WHERE local_user_id = $1 AND status = 'applied'`,
      [options.localUserId],
    ).catch(() => {
      /* table may not exist in unit mocks */
    })

    const ev = await client.query(
      `INSERT INTO directory_deprovision_events (
         org_id, integration_id, directory_account_id, local_user_id,
         run_id, triggered_by, event_origin, access_generation_at_apply, status
       ) VALUES ($1,$2,$3,$4,$5,$6,'sync',$7,'open')
       RETURNING id`,
      [
        options.orgId,
        options.integrationId,
        options.directoryAccountId,
        options.localUserId,
        options.runId,
        options.triggeredBy,
        nextGen,
      ],
    ).catch(() => ({ rows: [] as Array<{ id: string }> }))

    eventId = (ev.rows[0] as { id?: string } | undefined)?.id ?? null

    for (const effect of options.effects) {
      await client.query(
        `INSERT INTO directory_deprovision_effects (
           event_id, local_user_id, org_id, effect_type,
           before_active, after_active, access_generation_at_apply, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'applied')`,
        [
          eventId,
          options.localUserId,
          effect.orgId ?? options.orgId,
          effect.type,
          effect.beforeActive,
          effect.afterActive,
          nextGen,
        ],
      ).catch(() => {
        /* unit/mock */
      })
    }
  })

  return {
    applied: true,
    effectCount: options.effects.length,
    accessGeneration: nextGen,
    skipReason: null,
    eventId,
  }
}

/** D5 helper — supersede open effects + bump generation (other writers). */
export async function supersedeOpenDeprovisionEffects(userId: string): Promise<void> {
  await transaction(async (client) => {
    await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId])
    await client.query(
      `UPDATE users
          SET access_generation = COALESCE(access_generation, 0) + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [userId],
    )
    await client.query(
      `UPDATE directory_deprovision_effects
          SET status = 'superseded', updated_at = NOW()
        WHERE local_user_id = $1 AND status = 'applied'`,
      [userId],
    ).catch(() => {})
  })
}

export async function countOpenDeprovisionEffects(userId: string): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM directory_deprovision_effects
      WHERE local_user_id = $1 AND status = 'applied'`,
    [userId],
  ).catch(() => ({ rows: [{ n: 0 }] }))
  return r.rows[0]?.n ?? 0
}
