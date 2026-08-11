/**
 * D4 deprovision writer.
 *
 * The caller supplies the transaction client used by the directory sync. This
 * module never opens a second transaction: user locking, write-time candidacy,
 * access-graph changes, generation, event, and effects either commit together
 * or all roll back.
 */

import type {
  DirectoryDeprovisionPlan,
  DirectoryDeprovisionPolicy,
  PlannedEffect,
} from './deprovision-planner'
import { planDirectoryDeprovision } from './deprovision-planner'

export type DirectoryTransactionClient = {
  query: (
    statement: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>
}

export type ApplyDeprovisionCandidateInput = {
  localUserId: string
  orgId: string
  integrationId: string
  directoryAccountId: string
  runId: string
  triggeredBy: string
  policy: DirectoryDeprovisionPolicy
  write: boolean
}

export type PlanDeprovisionCandidateInput = Pick<
  ApplyDeprovisionCandidateInput,
  | 'localUserId'
  | 'orgId'
  | 'integrationId'
  | 'directoryAccountId'
  | 'policy'
  | 'write'
> & {
  /**
   * Active account ids the preview treats as deactivated together. Apply
   * normally passes none because the sync transaction already flipped them.
   */
  prospectiveDeactivatedAccountIds?: string[]
  requireSourceInactive?: boolean
}

export type DirectoryDeprovisionCandidateSnapshot = {
  activationStatus: string | null
  isActive: boolean
  accessGeneration: number
  linkedAtApply: boolean
  orgMembershipActive: boolean
  orgCandidacyClear: boolean
  globallyClear: boolean
  dingtalkGrantEnabled: boolean
  dingtalkGrantRowExists: boolean
}

export type ApplyDeprovisionCandidateResult = {
  applied: boolean
  eventId: string | null
  accessGeneration: number
  globallyClear: boolean
  /**
   * Set when this candidate was skipped for a per-candidate race (user row vanished, or the
   * source account was unbound between candidate selection and the lock). A skip never aborts
   * the surrounding sync run; `plan.effects` is empty so counters stay untouched. When set,
   * `accessGeneration` is a meaningless 0 — discriminate on THIS field, never on the number.
   */
  skipReason: 'candidate_vanished' | null
  plan: DirectoryDeprovisionPlan
}

type CandidateStateRow = {
  activation_status: string | null
  is_active: boolean
  access_generation: string | number
  linked_at_apply: boolean
  org_membership_active: boolean
  org_candidacy_clear: boolean
  globally_clear: boolean
  dingtalk_grant_enabled: boolean
  dingtalk_grant_row_exists: boolean
}

function hasEffect(
  effects: PlannedEffect[],
  type: PlannedEffect['type'],
): boolean {
  return effects.some((effect) => effect.type === type)
}

/**
 * Adversarial review of #4647 (P1, two-connection proof): candidacy MUST NOT be read by the
 * statement that acquires the lock. Under READ COMMITTED the locking statement's subqueries are
 * evaluated against a snapshot taken BEFORE the lock wait — EPQ re-checks only the locked `users`
 * row itself, so `globally_clear` came back stale while `access_generation` looked fresh, and a
 * cross-org rehire committing during the wait was invisible: the user was platform-deactivated,
 * the grant revoked, and the event recorded `globally_clear=true` — false evidence. The lock is
 * therefore taken FIRST, in its own statement (`lockCandidateUser`), and this state read runs as
 * a SEPARATE statement afterwards, whose snapshot postdates the lock (§5.3 step 1 / §7.4).
 */
async function lockCandidateUser(
  client: DirectoryTransactionClient,
  localUserId: string,
): Promise<boolean> {
  const locked = await client.query(
    `SELECT id FROM users WHERE id = $1::text FOR UPDATE`,
    [localUserId],
  )
  return locked.rows.length > 0
}

async function loadCandidateState(
  client: DirectoryTransactionClient,
  input: PlanDeprovisionCandidateInput,
): Promise<CandidateStateRow | null> {
  // #4659 preview-mirror inputs: the preview may model account deactivations the sync has not
  // performed yet (prospective ids), and may relax the source-inactive requirement — apply
  // always runs with the strict defaults. NEVER a lock here in either mode: the apply path
  // takes the users FOR UPDATE mutex FIRST as its own statement (adversarial-review P1 — the
  // lock and this read must not share a statement/snapshot), and preview locks nothing.
  const prospectiveDeactivatedAccountIds = Array.from(
    new Set(
      (input.prospectiveDeactivatedAccountIds ?? [])
        .map((accountId) => String(accountId || '').trim())
        .filter(Boolean),
    ),
  )
  const requireSourceInactive = input.requireSourceInactive !== false
  const result = await client.query(
    `SELECT
       candidate_user.activation_status,
       candidate_user.is_active,
       COALESCE(candidate_user.access_generation, 0) AS access_generation,
       EXISTS (
         SELECT 1
           FROM directory_account_links source_link
           JOIN directory_accounts source_account
             ON source_account.id = source_link.directory_account_id
           JOIN directory_integrations source_integration
             ON source_integration.id = source_account.integration_id
          WHERE source_link.directory_account_id = $2::uuid
            AND source_link.local_user_id = candidate_user.id
            AND source_link.link_status = 'linked'
            AND source_account.integration_id = $3::uuid
            AND (
              ($6::boolean = TRUE AND source_account.is_active = FALSE)
              OR (
                $6::boolean = FALSE
                AND (
                  source_account.is_active = FALSE
                  OR source_account.id = ANY($5::uuid[])
                )
              )
            )
            AND source_integration.org_id = $4::text
       ) AS linked_at_apply,
       EXISTS (
         SELECT 1
           FROM user_orgs membership
          WHERE membership.user_id = candidate_user.id
            AND membership.org_id = $4::text
            AND COALESCE(membership.is_active, TRUE) = TRUE
       ) AS org_membership_active,
       NOT EXISTS (
         SELECT 1
           FROM directory_account_links sibling_link
           JOIN directory_accounts sibling
             ON sibling.id = sibling_link.directory_account_id
           JOIN directory_integrations sibling_integration
             ON sibling_integration.id = sibling.integration_id
          WHERE sibling_link.local_user_id = candidate_user.id
            AND sibling_link.link_status = 'linked'
            AND sibling.is_active = TRUE
            AND sibling.id <> ALL($5::uuid[])
            AND sibling_integration.org_id = $4::text
       ) AS org_candidacy_clear,
       NOT EXISTS (
         SELECT 1
           FROM directory_account_links sibling_link
           JOIN directory_accounts sibling
             ON sibling.id = sibling_link.directory_account_id
          WHERE sibling_link.local_user_id = candidate_user.id
            AND sibling_link.link_status = 'linked'
            AND sibling.is_active = TRUE
            AND sibling.id <> ALL($5::uuid[])
       ) AS globally_clear,
       COALESCE((
         SELECT grant_row.enabled
           FROM user_external_auth_grants grant_row
          WHERE grant_row.provider = 'dingtalk'
            AND grant_row.local_user_id = candidate_user.id
          LIMIT 1
       ), FALSE) AS dingtalk_grant_enabled,
       EXISTS (
         SELECT 1
           FROM user_external_auth_grants grant_presence
          WHERE grant_presence.provider = 'dingtalk'
            AND grant_presence.local_user_id = candidate_user.id
       ) AS dingtalk_grant_row_exists
     FROM users candidate_user
     WHERE candidate_user.id = $1::text`,
    [
      input.localUserId,
      input.directoryAccountId,
      input.integrationId,
      input.orgId,
      prospectiveDeactivatedAccountIds,
      requireSourceInactive,
    ],
  )
  // Adversarial review of #4647 (P2): a vanished user is a PER-CANDIDATE race, not a sync-level
  // fault — null here, and the APPLY caller skips with a warning (never aborts the run). The
  // linked_at_apply decision is the caller's: apply treats an unlinked source as the same skip,
  // while the PLAN path (#4659 preview) throws its coded error so the API can 4xx honestly.
  const row = result.rows[0] as CandidateStateRow | undefined
  if (!row) return null
  return row
}

export async function planDirectoryDeprovisionCandidate(
  client: DirectoryTransactionClient,
  input: PlanDeprovisionCandidateInput,
): Promise<{
  plan: DirectoryDeprovisionPlan
  snapshot: DirectoryDeprovisionCandidateSnapshot
}> {
  const state = await loadCandidateState(client, input)
  if (!state) {
    throw new Error(`directory deprovision user not found: ${input.localUserId}`)
  }
  if (!state.linked_at_apply) {
    throw new Error(
      'directory deprovision source account is no longer linked to the candidate user',
    )
  }
  const snapshot: DirectoryDeprovisionCandidateSnapshot = {
    activationStatus: state.activation_status,
    isActive: state.is_active,
    accessGeneration: Number(state.access_generation),
    linkedAtApply: state.linked_at_apply,
    orgMembershipActive: state.org_membership_active,
    orgCandidacyClear: state.org_candidacy_clear,
    globallyClear: state.globally_clear,
    dingtalkGrantEnabled: state.dingtalk_grant_enabled,
    dingtalkGrantRowExists: state.dingtalk_grant_row_exists,
  }
  return {
    snapshot,
    plan: planDirectoryDeprovision({
      localUserId: input.localUserId,
      policy: input.policy,
      activationStatus: snapshot.activationStatus,
      isActive: snapshot.isActive,
      orgId: input.orgId,
      orgMembershipActive:
        snapshot.orgMembershipActive && snapshot.orgCandidacyClear,
      dingtalkGrantEnabled: snapshot.dingtalkGrantEnabled,
      dingtalkGrantRowExists: snapshot.dingtalkGrantRowExists,
      globallyClear: snapshot.globallyClear,
    }),
  }
}

async function writeEffects(
  client: DirectoryTransactionClient,
  eventId: string,
  localUserId: string,
  generation: number,
  effects: PlannedEffect[],
): Promise<void> {
  for (const effect of effects) {
    await client.query(
      `INSERT INTO directory_deprovision_effects (
         event_id, local_user_id, org_id, effect_type,
         before_active, after_active, grant_row_created,
         access_generation_at_apply, status
       ) VALUES ($1::uuid, $2::text, $3::text, $4::text, $5, $6, $7, $8, 'applied')`,
      [
        eventId,
        localUserId,
        effect.orgId ?? null,
        effect.type,
        effect.beforeActive,
        effect.afterActive,
        effect.grantRowCreated === true,
        generation,
      ],
    )
  }
}

export async function applyDirectoryDeprovisionCandidate(
  client: DirectoryTransactionClient,
  input: ApplyDeprovisionCandidateInput,
): Promise<ApplyDeprovisionCandidateResult> {
  // §5.3 step 0: in write mode the mutex comes FIRST, as its own statement — see
  // `lockCandidateUser`'s doc comment for why the lock and the state read must never share a
  // statement. Preview takes no lock (it writes nothing, so there is nothing to serialise).
  if (input.write) {
    const lockHeld = await lockCandidateUser(client, input.localUserId)
    if (!lockHeld) {
      return {
        applied: false,
        eventId: null,
        accessGeneration: 0,
        globallyClear: false,
        skipReason: 'candidate_vanished',
        plan: { localUserId: input.localUserId, skipReason: 'candidate_vanished', effects: [] },
      }
    }
  }
  const state = await loadCandidateState(client, input)
  if (!state || !state.linked_at_apply) {
    return {
      applied: false,
      eventId: null,
      accessGeneration: 0,
      globallyClear: false,
      skipReason: 'candidate_vanished',
      plan: { localUserId: input.localUserId, skipReason: 'candidate_vanished', effects: [] },
    }
  }
  const plan = planDirectoryDeprovision({
    localUserId: input.localUserId,
    policy: input.policy,
    activationStatus: state.activation_status,
    isActive: state.is_active,
    orgId: input.orgId,
    orgMembershipActive:
      state.org_membership_active && state.org_candidacy_clear,
    dingtalkGrantEnabled: state.dingtalk_grant_enabled,
    dingtalkGrantRowExists: state.dingtalk_grant_row_exists,
    globallyClear: state.globally_clear,
  })
  const currentGeneration = Number(state.access_generation)

  if (!input.write || plan.effects.length === 0) {
    return {
      applied: false,
      eventId: null,
      accessGeneration: currentGeneration,
      globallyClear: state.globally_clear,
      skipReason: null,
      plan,
    }
  }

  const membershipChanged = hasEffect(plan.effects, 'membership_changed')
  const userChanged = hasEffect(plan.effects, 'user_changed')

  const generationResult = userChanged
    ? await client.query(
        `UPDATE users
          SET access_generation = COALESCE(access_generation, 0) + 1,
              is_active = FALSE,
              updated_at = NOW()
        WHERE id = $1::text
        RETURNING access_generation`,
        [input.localUserId],
      )
    : await client.query(
        `UPDATE users
          SET access_generation = COALESCE(access_generation, 0) + 1,
              updated_at = NOW()
        WHERE id = $1::text
        RETURNING access_generation`,
        [input.localUserId],
      )
  const generation = Number(
    (
      generationResult.rows[0] as
        | { access_generation?: string | number }
        | undefined
    )?.access_generation,
  )
  if (!Number.isFinite(generation)) {
    throw new Error('directory deprovision generation update returned no row')
  }

  if (membershipChanged) {
    const membership = await client.query(
      `UPDATE user_orgs
          SET is_active = FALSE
        WHERE user_id = $1::text
          AND org_id = $2::text
          AND COALESCE(is_active, TRUE) = TRUE
          AND NOT EXISTS (
            SELECT 1
              FROM directory_account_links sibling_link
              JOIN directory_accounts sibling
                ON sibling.id = sibling_link.directory_account_id
              JOIN directory_integrations sibling_integration
                ON sibling_integration.id = sibling.integration_id
             WHERE sibling_link.local_user_id = $1::text
               AND sibling_link.link_status = 'linked'
               AND sibling.is_active = TRUE
               AND sibling_integration.org_id = $2::text
          )
        RETURNING user_id`,
      [input.localUserId, input.orgId],
    )
    if (!membership.rows[0]) {
      throw new Error(
        'directory deprovision membership changed after planning; transaction aborted',
      )
    }
  }

  // Rev 4.4: grant-table writes are purely EFFECT-DRIVEN — every mutation of
  // user_external_auth_grants corresponds 1:1 to a grant_changed effect row, so restore can
  // reverse it. (The prior OPS-01 shape wrote an unconditional disabled row for every
  // globally-clear candidate outside the ledger; a rehired never-granted person was then
  // permanently blocked from OAuth with no evidence to reverse — closeout review P1. The deny
  // mark itself is unchanged: it still blocks ensureGrant's creation-only auto-grant.)
  const grantEffect = plan.effects.find((effect) => effect.type === 'grant_changed')
  if (grantEffect) {
    if (grantEffect.grantRowCreated === true) {
      // Deny-row CREATION for a person with no existing row. Plain INSERT, no ON CONFLICT:
      // the per-user lock plus the same-transaction EXISTS read guarantee absence, so a
      // conflict means the invariant broke — abort rather than write unevidenced state.
      await client.query(
        `INSERT INTO user_external_auth_grants (
           provider, local_user_id, enabled, granted_by, created_at, updated_at
         ) VALUES ('dingtalk', $1::text, FALSE, 'system:directory-deprovision', NOW(), NOW())`,
        [input.localUserId],
      )
    } else {
      const flipped = await client.query(
        `UPDATE user_external_auth_grants
            SET enabled = FALSE,
                granted_by = 'system:directory-deprovision',
                updated_at = NOW()
          WHERE provider = 'dingtalk'
            AND local_user_id = $1::text
            AND enabled = TRUE
          RETURNING local_user_id`,
        [input.localUserId],
      )
      if (!flipped.rows[0]) {
        throw new Error(
          'directory deprovision grant changed after planning; transaction aborted',
        )
      }
    }
  }

  await client.query(
    `UPDATE directory_deprovision_effects
        SET status = 'superseded', updated_at = NOW()
      WHERE local_user_id = $1::text
        AND status = 'applied'`,
    [input.localUserId],
  )
  await client.query(
    `UPDATE directory_deprovision_events
        SET status = 'superseded',
            resolved_at = NOW(),
            resolved_by = $2::text,
            resolve_note = 'superseded by a newer directory deprovision event',
            updated_at = NOW()
      WHERE local_user_id = $1::text
        AND status = 'applied'`,
    [input.localUserId, input.triggeredBy],
  )

  const eventResult = await client.query(
    `INSERT INTO directory_deprovision_events (
       org_id, integration_id, directory_account_id, local_user_id,
       run_id, triggered_by, event_origin, link_witness_account_id,
       link_witness_local_user_id, policy, globally_clear,
       access_generation_at_apply, status
     ) VALUES (
       $1::text, $2::uuid, $3::uuid, $4::text,
       $5::uuid, $6::text, 'sync', $3::uuid,
       $4::text, $7::text, $8::boolean, $9, 'applied'
     )
     RETURNING id`,
    [
      input.orgId,
      input.integrationId,
      input.directoryAccountId,
      input.localUserId,
      input.runId,
      input.triggeredBy,
      input.policy,
      state.globally_clear,
      generation,
    ],
  )
  const eventId = (eventResult.rows[0] as { id?: string } | undefined)?.id
  if (!eventId) {
    throw new Error('directory deprovision event INSERT returned no id')
  }

  await writeEffects(
    client,
    eventId,
    input.localUserId,
    generation,
    plan.effects,
  )

  return {
    applied: true,
    eventId,
    accessGeneration: generation,
    globallyClear: state.globally_clear,
    skipReason: null,
    plan,
  }
}
