/**
 * D3/D4 — deprovision effect ledger (design lock Rev 4.2 companion §5.2–§5.4).
 *
 * Every function here runs on the CALLER's transaction client. That is the whole point: §5.3
 * requires the access-graph write and its evidence row to commit or roll back together, so the
 * ledger must never open a transaction of its own (a nested `transaction()` would commit the
 * evidence independently of the write it claims to witness, and would take the per-user mutex on
 * a second connection while the caller still holds its own).
 *
 * Nothing here swallows a database error. An evidence chain whose INSERT can silently fail is
 * not an evidence chain — if the ledger cannot be written, the deprovision it describes must not
 * commit either. Identity/link/org/run validity is additionally enforced by the DB triggers from
 * `zzzz20260724190000` (§5.2.1 "trigger 才验 live link"); these helpers are the forward path, not
 * the guard.
 */

import type { DeprovisionPolicy, PlannedEffect } from './deprovision-planner'

/** The narrow shape both the sync transaction client and `pg`'s client satisfy. */
export type LedgerClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

export type UserAccessState = {
  localUserId: string
  activationStatus: string | null
  isActive: boolean
  accessGeneration: number
}

/**
 * §5.3 step 0 / §5.4 — the ONE mutex. `SELECT ... FOR UPDATE` on the `users` row, never an
 * advisory lock (the lock explicitly forbids a second, parallel locking protocol). Callers that
 * lock several people in one transaction MUST sort the ids first (§7.2 批量) or two runs touching
 * the same pair in opposite order deadlock.
 *
 * Returns null when the user disappeared — the caller then has nothing to deprovision.
 */
export async function lockUserForAccessGraphWrite(
  client: LedgerClient,
  localUserId: string,
): Promise<UserAccessState | null> {
  const result = await client.query(
    `SELECT id::text AS id,
            activation_status,
            COALESCE(is_active, TRUE) AS is_active,
            COALESCE(access_generation, 0)::bigint AS access_generation
       FROM users
      WHERE id = $1::text
      FOR UPDATE`,
    [localUserId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    localUserId: String(row.id),
    activationStatus: row.activation_status === null || row.activation_status === undefined
      ? null
      : String(row.activation_status),
    isActive: row.is_active === true,
    accessGeneration: Number(row.access_generation ?? 0),
  }
}

export type RecordDeprovisionEventInput = {
  localUserId: string
  orgId: string
  integrationId: string
  directoryAccountId: string
  /** NOT NULL for `event_origin='sync'` — the DB CHECK and trigger both enforce it. */
  runId: string
  triggeredBy: string
  policy: DeprovisionPolicy
  globallyClear: boolean
  /** The effects that were ACTUALLY applied, not merely planned. */
  effects: PlannedEffect[]
}

export type RecordDeprovisionEventResult = {
  eventId: string
  accessGeneration: number
  effectCount: number
}

/**
 * §5.3 step 4: generation++ → `G'`, then the event, then its effects, all stamped `G'`.
 *
 * The caller is responsible for step 3 (zero effects ⇒ zero write): this function refuses an
 * empty effect set rather than quietly writing an event with no effects, because a generation
 * bump with nothing behind it would invalidate every outstanding restore for that person.
 */
export async function recordDeprovisionEvent(
  client: LedgerClient,
  input: RecordDeprovisionEventInput,
): Promise<RecordDeprovisionEventResult> {
  if (input.effects.length === 0) {
    throw new Error(
      `recordDeprovisionEvent called with zero effects for user ${input.localUserId}: `
      + '§5.3 requires the caller to return without writing when the effect set is empty',
    )
  }

  const bumped = await client.query(
    `UPDATE users
        SET access_generation = COALESCE(access_generation, 0) + 1,
            updated_at = NOW()
      WHERE id = $1::text
      RETURNING access_generation`,
    [input.localUserId],
  )
  const generation = Number(bumped.rows[0]?.access_generation)
  if (!Number.isFinite(generation)) {
    throw new Error(`Failed to bump access_generation for user ${input.localUserId}`)
  }

  const event = await client.query(
    `INSERT INTO directory_deprovision_events (
       org_id, integration_id, directory_account_id, local_user_id,
       link_witness_account_id, link_witness_local_user_id,
       run_id, triggered_by, event_origin, policy, globally_clear,
       access_generation_at_apply, status
     ) VALUES ($1, $2::uuid, $3::uuid, $4,
               $3::uuid, $4,
               $5::uuid, $6, 'sync', $7, $8,
               $9, 'applied')
     RETURNING id::text AS id`,
    [
      input.orgId,
      input.integrationId,
      input.directoryAccountId,
      input.localUserId,
      input.runId,
      input.triggeredBy,
      input.policy,
      input.globallyClear,
      generation,
    ],
  )
  const eventId = event.rows[0]?.id
  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw new Error(`Deprovision event INSERT returned no id for user ${input.localUserId}`)
  }

  for (const effect of input.effects) {
    await client.query(
      `INSERT INTO directory_deprovision_effects (
         event_id, local_user_id, org_id, effect_type,
         before_active, after_active, access_generation_at_apply, status
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'applied')`,
      [
        eventId,
        input.localUserId,
        effect.orgId,
        effect.type,
        effect.beforeActive,
        effect.afterActive,
        generation,
      ],
    )
  }

  return { eventId, accessGeneration: generation, effectCount: input.effects.length }
}

/**
 * §5.4 — "其他访问图写者 必须同时 generation++ AND supersede open effects（不可只做一腿）".
 *
 * Any writer that changes this person's access graph outside the deprovision path (admin
 * activate/deactivate, grant toggle, bind/unbind, membership upsert) invalidates every open
 * effect as a restore target: replaying a stale `before` would overwrite whatever the newer
 * writer just decided. Doing only the supersede leg would leave `access_generation` equal and let
 * a restore proceed; doing only the bump would leave `applied` rows that no longer describe
 * anything. Hence one function, both legs, on the caller's transaction.
 *
 * Caller must already hold the mutex via `lockUserForAccessGraphWrite`.
 */
export async function supersedeOpenDeprovisionEffects(
  client: LedgerClient,
  localUserId: string,
): Promise<{ supersededEffectCount: number; accessGeneration: number }> {
  const superseded = await client.query(
    `UPDATE directory_deprovision_effects
        SET status = 'superseded', updated_at = NOW()
      WHERE local_user_id = $1
        AND status = 'applied'
      RETURNING id`,
    [localUserId],
  )

  await client.query(
    `UPDATE directory_deprovision_events e
        SET status = 'superseded', updated_at = NOW()
      WHERE e.local_user_id = $1
        AND e.status = 'applied'
        AND NOT EXISTS (
          SELECT 1 FROM directory_deprovision_effects fx
           WHERE fx.event_id = e.id AND fx.status = 'applied'
        )`,
    [localUserId],
  )

  const bumped = await client.query(
    `UPDATE users
        SET access_generation = COALESCE(access_generation, 0) + 1,
            updated_at = NOW()
      WHERE id = $1::text
      RETURNING access_generation`,
    [localUserId],
  )

  return {
    supersededEffectCount: superseded.rows.length,
    accessGeneration: Number(bumped.rows[0]?.access_generation ?? 0),
  }
}

export async function countOpenDeprovisionEffects(
  client: LedgerClient,
  localUserId: string,
): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::int AS n
       FROM directory_deprovision_effects
      WHERE local_user_id = $1 AND status = 'applied'`,
    [localUserId],
  )
  return Number(result.rows[0]?.n ?? 0)
}
