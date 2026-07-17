import { query } from '../db/pg'

/**
 * Canonical Org MVP — B7 (external-provider reconciliation, SUGGEST-ONLY), #4215 §9 + §5.5.
 *
 * Doctrine (§9, ratified): external providers PROPOSE bindings — they never silently rewrite the
 * local organization structure. Two service functions, both org-scoped:
 *
 *   - `sweepStaleDepartmentBindings(orgId)` — reflect REMOTE department liveness onto the BINDING
 *     rows only: a binding whose remote department has disappeared from the provider
 *     (archive-not-delete ⇒ `is_active = false`) is marked `status = 'stale'`; a stale binding
 *     whose remote department is live again heals back to `'active'`. Both directions touch
 *     `directory_department_bindings` EXCLUSIVELY — the local department is NEVER deactivated,
 *     renamed, or otherwise written by this sweep (the headline B7 invariant: a provider-side
 *     disappearance must not damage the canonical local org).
 *
 *   - `suggestDepartmentBindings(orgId)` — READ-ONLY proposals for UNBOUND remote departments.
 *     v1 matching signal: exact name (case- and whitespace-insensitive) against ACTIVE local
 *     departments of the org's active local integration. Exactly ONE candidate ⇒ a suggestion the
 *     admin may apply; MORE THAN ONE ⇒ an `ambiguous` entry that CANNOT be auto-applied (§9: "do
 *     not auto-match on name alone when multiple candidates exist"); ZERO ⇒ `unmatched`. The
 *     richer signals §9 lists (normalized path, stored external id, binding history,
 *     admin-selected) belong to the decision-workflow follow-up, not this v1. This function never
 *     writes — applying a suggestion is a separate, explicit admin action (future
 *     `PATCH /department-bindings` surface, §7).
 *
 * Neither function is wired into the sync loop yet: WHERE the sweep runs (a post-sync hook vs an
 * admin-triggered action) is an owner decision — wiring it into the hardened sync core without a
 * ruling would be scope creep. Both functions are deterministic and idempotent, so either wiring
 * is safe later.
 */

export interface StaleSweepResult {
  staled: number
  healed: number
}

/**
 * @param opts.remoteIntegrationId — Q6 (owner ruling): the post-sync hook narrows the sweep to the
 * integration that just synced; the admin retry endpoint may narrow the same way or sweep the org.
 */
export async function sweepStaleDepartmentBindings(
  orgId: string,
  opts: { remoteIntegrationId?: string } = {},
): Promise<StaleSweepResult> {
  // Owner review (#4436) — two remote-INTEGRATION guards on BOTH directions:
  //   - `ri.status = 'active'`: a disabled/frozen remote integration's data is a snapshot, not a
  //     live fact stream — its bindings must not churn (neither stale nor heal) until it is live.
  //   - `ri.provider <> 'local'`: the remote side of a binding is by definition a provider;
  //     belt-and-suspenders here (B4's provider FK + CHECK already make a local remote side
  //     unconstructible), so a raw-malformed row can never be swept as if it were provider truth.
  const narrow = opts.remoteIntegrationId ? ' AND b.remote_integration_id = $2::uuid' : ''
  const params: unknown[] = opts.remoteIntegrationId ? [orgId, opts.remoteIntegrationId] : [orgId]
  // Mark ACTIVE bindings whose remote department disappeared (is_active = false) as STALE.
  const staled = await query<{ id: string }>(
    `UPDATE directory_department_bindings b
        SET status = 'stale', updated_at = NOW()
       FROM directory_departments rd, directory_integrations ri
      WHERE rd.id = b.remote_department_id
        AND ri.id = b.remote_integration_id
        AND ri.status = 'active'
        AND ri.provider <> 'local'
        AND b.org_id = $1
        AND b.status = 'active'
        AND rd.is_active = false${narrow}
      RETURNING b.id`,
    params,
  )
  // Heal STALE bindings whose remote department is live again. Both directions only ever reflect
  // provider-side FACTS onto the binding row — never onto the local department.
  const healed = await query<{ id: string }>(
    `UPDATE directory_department_bindings b
        SET status = 'active', updated_at = NOW()
       FROM directory_departments rd, directory_integrations ri
      WHERE rd.id = b.remote_department_id
        AND ri.id = b.remote_integration_id
        AND ri.status = 'active'
        AND ri.provider <> 'local'
        AND b.org_id = $1
        AND b.status = 'stale'
        AND rd.is_active = true${narrow}
      RETURNING b.id`,
    params,
  )
  return { staled: staled.rows.length, healed: healed.rows.length }
}

export interface DepartmentBindingSuggestion {
  remoteIntegrationId: string
  remoteDepartmentId: string
  remoteDepartmentName: string
  localDepartmentId: string
  matchStrategy: 'exact-name'
}

export interface AmbiguousDepartmentMatch {
  remoteIntegrationId: string
  remoteDepartmentId: string
  remoteDepartmentName: string
  candidateLocalDepartmentIds: string[]
  reason: 'ambiguous-name'
}

export interface UnmatchedRemoteDepartment {
  remoteIntegrationId: string
  remoteDepartmentId: string
  remoteDepartmentName: string
}

export interface DepartmentBindingSuggestions {
  suggestions: DepartmentBindingSuggestion[]
  ambiguous: AmbiguousDepartmentMatch[]
  unmatched: UnmatchedRemoteDepartment[]
}

export async function suggestDepartmentBindings(orgId: string): Promise<DepartmentBindingSuggestions> {
  // One read: every UNBOUND active remote department of the org's active non-local integrations,
  // with its exact-name candidate set among the org's ACTIVE local departments (active local
  // integration). LEFT JOIN keeps zero-candidate remotes visible as `unmatched`.
  const rows = await query<{
    remote_integration_id: string
    remote_department_id: string
    remote_department_name: string
    local_department_id: string | null
  }>(
    `SELECT ri.id::text  AS remote_integration_id,
            rd.id::text  AS remote_department_id,
            rd.name      AS remote_department_name,
            ld.id::text  AS local_department_id
       FROM directory_integrations ri
       JOIN directory_departments rd
         ON rd.integration_id = ri.id
        AND rd.is_active = true
       LEFT JOIN directory_department_bindings b
         ON b.remote_department_id = rd.id
        AND b.remote_integration_id = ri.id
       LEFT JOIN directory_integrations li
         ON li.org_id = ri.org_id
        AND li.provider = 'local'
        AND li.status = 'active'
       LEFT JOIN directory_departments ld
         ON ld.integration_id = li.id
        AND ld.provider = 'local'
        AND ld.is_active = true
        AND lower(btrim(ld.name)) = lower(btrim(rd.name))
      WHERE ri.org_id = $1
        AND ri.provider <> 'local'
        AND ri.status = 'active'
        AND b.id IS NULL
      ORDER BY rd.id ASC, ld.id ASC`,
    [orgId],
  )

  const byRemote = new Map<string, { intId: string; name: string; candidates: string[] }>()
  for (const r of rows.rows) {
    let entry = byRemote.get(r.remote_department_id)
    if (!entry) {
      entry = { intId: r.remote_integration_id, name: r.remote_department_name, candidates: [] }
      byRemote.set(r.remote_department_id, entry)
    }
    if (r.local_department_id) entry.candidates.push(r.local_department_id)
  }

  const result: DepartmentBindingSuggestions = { suggestions: [], ambiguous: [], unmatched: [] }
  for (const [remoteDepartmentId, entry] of byRemote) {
    if (entry.candidates.length === 1) {
      result.suggestions.push({
        remoteIntegrationId: entry.intId,
        remoteDepartmentId,
        remoteDepartmentName: entry.name,
        localDepartmentId: entry.candidates[0],
        matchStrategy: 'exact-name',
      })
    } else if (entry.candidates.length > 1) {
      // §9: NEVER auto-match on name alone when multiple candidates exist — surfaced for an
      // explicit admin decision, deliberately NOT shaped like an appliable suggestion.
      result.ambiguous.push({
        remoteIntegrationId: entry.intId,
        remoteDepartmentId,
        remoteDepartmentName: entry.name,
        candidateLocalDepartmentIds: entry.candidates,
        reason: 'ambiguous-name',
      })
    } else {
      result.unmatched.push({
        remoteIntegrationId: entry.intId,
        remoteDepartmentId,
        remoteDepartmentName: entry.name,
      })
    }
  }
  return result
}
