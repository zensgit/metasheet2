import type {
  ApprovalAssigneeResolutionMetadata,
  ApprovalAssigneeSource,
  ApprovalNodeConfig,
  FormSchema,
  SamePersonPolicy,
} from '../types/approval-product'
import { ServiceError } from './ApprovalBridgeService'

export type ResolvedApprovalAssignment = {
  assignmentType: 'user' | 'role'
  assigneeId: string
  nodeKey: string
  sourceStep: number
  metadata?: ApprovalAssigneeResolutionMetadata
}

export interface ResolveApprovalAssigneesOptions {
  nodeKey: string
  sourceStep: number
  config: ApprovalNodeConfig
  formSchema?: FormSchema
  formSnapshot: Record<string, unknown>
  requesterSnapshot: Record<string, unknown> | null
  /**
   * Lock-1 §K3 (`prior_node_approver`) — referenced prior node key → that node's ACTUAL decider
   * local user ids, read by the CALLER at node activation from instance-internal
   * `approval_records` rows (LATEST `nodeEntryEpoch` round only, OD-L1-3(a); system sentinel
   * actors already dropped) and passed in alongside the snapshots, exactly as `formSnapshot` and
   * `requesterSnapshot` are. The resolver performs NO database access of its own (§2.1 purity —
   * K3 is the one kind whose input is caller-supplied at activation rather than create-frozen).
   * Absent/undefined (create-time cascade, read-only previews) ⇒ every `prior_node_approver`
   * source resolves EMPTY and falls to the node's `emptyAssigneePolicy` (OD-L1-4(a)).
   */
  priorNodeApprovers?: Record<string, string[]>
  /**
   * Lock-4 F4-C (OD-L4-4(a)) — the EFFECTIVE `samePersonPolicy` at THIS node, late-bound exactly
   * like `priorNodeApprovers`/K3 above (§2.1 purity: this resolver has no `runtimeGraph` and cannot
   * compute it itself). Absent ⇒ no same-person substitution runs (today's behavior).
   */
  getEffectiveSamePersonPolicy?: (nodeKey: string) => SamePersonPolicy | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function metadataFor(
  source: ApprovalAssigneeSource,
  sourceIndex: number,
  // Lock-1 §K1 — the SPECIFIC group id this member was resolved from (a `user_group` source may
  // carry multiple `groupIds`; the sourceIndex alone cannot answer "which group").
  resolvedGroupId?: string,
): ApprovalAssigneeResolutionMetadata {
  return {
    resolvedFrom: {
      kind: source.kind,
      sourceIndex,
      ...(source.kind === 'form_field_user' ? { fieldId: source.fieldId } : {}),
      // Lock-2 §2.6 audit (form-field contact extensions): the referenced field id AND the
      // configured chain level on the row — both template-authored (values-free) — so "why is
      // this person an approver" is answerable from the row alone.
      ...(source.kind === 'form_field_user_manager' || source.kind === 'form_field_user_dept_head'
        ? { fieldId: source.fieldId, level: source.level }
        : {}),
      // Lock-1 §K3 audit: the referenced prior node's key on the row (§2.6 — a template-authored
      // node key, values-free), so "why is this person an approver" is answerable from the row.
      ...(source.kind === 'prior_node_approver' ? { priorNodeKey: source.nodeKey } : {}),
      ...(source.kind === 'user_group' && resolvedGroupId ? { groupId: resolvedGroupId } : {}),
    },
  }
}

/**
 * Lock-2 §2.5 — the ONE key under which a form-field contact-extension source is frozen into
 * `ApprovalRequesterSnapshot.fieldDerivedAssigneeIds` AND fingerprinted by the parallel-conflict
 * publish gate: `<kind>:<fieldId>:<level>`. A single exported producer (consumed by BOTH the
 * create-time freeze in ApprovalProductService and the resolver arms below, and by the backend
 * `dynamicAssigneeSourceFingerprint`) so the snapshot key and the fingerprint provably cannot
 * drift. `fieldId` is trimmed defensively (the authoring choke already trims it at normalize).
 * FE mirror: apps/web/src/approvals/parallelEdit.ts `dynamicAssigneeSourceFingerprint` — keep in
 * lockstep.
 */
export function fieldDerivedAssigneeSourceKey(
  source: Extract<ApprovalAssigneeSource, { kind: 'form_field_user_manager' | 'form_field_user_dept_head' }>,
): string {
  return `${source.kind}:${source.fieldId.trim()}:${source.level}`
}

/**
 * Lock-1 §K3 — `system:`-namespaced sentinel actors (`system:auto-approval`,
 * `system:approval-timeout`) are not assignable users and are DROPPED, never assigned. The
 * caller's audit-row read already drops them; this pure re-check keeps the guarantee even for a
 * hand-assembled `priorNodeApprovers` map. The `system:` prefix is the repo-wide non-user actor
 * namespace (directory-sync.ts applies the same predicate to reject `system:`-prefixed ids as
 * user ids).
 */
function isSystemSentinelActor(actorId: string): boolean {
  return actorId.startsWith('system:')
}

/**
 * Single-valued `user` form value → local user id (string id or `{ id }`; arrays yield `null` —
 * the L2-B×L2-C latent drop Lock-2 documents, unreachable while `validateApprovalFormData`
 * rejects arrays for `user` fields). EXPORTED (Lock-2 §L2-C) so the create-time field-derived
 * freeze reads the chosen contact through the EXACT same reader the shipped `form_field_user`
 * resolution uses — a second reader could drift.
 */
export function resolveFormUserValue(value: unknown): string | null {
  const stringId = normalizeId(value)
  if (stringId) return stringId
  if (isRecord(value)) {
    return normalizeId(value.id)
  }
  return null
}

// Source-of-truth for `form_field_user` field-type validation is publish-time
// (`validateApprovalAssigneeSourcesAgainstFormSchema` in ApprovalProductService).
// Runtime callers that operate against a frozen runtime graph + instance snapshots
// (dispatch / adminJump / return) intentionally do NOT pass `formSchema` here,
// because they must rely only on the published, frozen graph and never re-read
// active template tables. This belt-and-suspenders check only activates when a
// `formSchema` is available (i.e. createApproval path) and must not be turned
// into an active-template lookup.
function assertFormUserSource(
  source: Extract<ApprovalAssigneeSource, { kind: 'form_field_user' }>,
  formSchema: FormSchema | undefined,
  nodeKey: string,
): void {
  if (!formSchema) return
  const field = formSchema.fields.find((entry) => entry.id === source.fieldId)
  if (!field || field.type !== 'user') {
    throw new ServiceError(
      `Approval node ${nodeKey} references a non-user assignee field`,
      400,
      'APPROVAL_ASSIGNEE_INVALID_SOURCE',
      { nodeKey, fieldId: source.fieldId },
    )
  }
}

// Delegation map (delegator localUserId -> delegatee localUserId), read from the
// frozen instance snapshot. Both ids normalized; malformed entries dropped.
function extractDelegationMap(snapshot: Record<string, unknown> | null): Record<string, string> {
  const raw = snapshot?.delegations
  if (!isRecord(raw)) return {}
  const map: Record<string, string> = {}
  for (const [delegator, delegatee] of Object.entries(raw)) {
    const d = normalizeId(delegator)
    const t = normalizeId(delegatee)
    if (d && t) map[d] = t
  }
  return map
}

export function resolveApprovalAssignees(
  options: ResolveApprovalAssigneesOptions,
): ResolvedApprovalAssignment[] {
  const resolved: ResolvedApprovalAssignment[] = []
  const seen = new Set<string>()
  // Delegation substitution map (delegator -> delegatee), frozen in the instance
  // snapshot at create. Applied inside pushResolved BEFORE the dedup key — so it
  // covers BOTH the legacy assigneeIds path and the assigneeSources path.
  const delegations = extractDelegationMap(options.requesterSnapshot)

  const pushResolved = (
    assignmentType: 'user' | 'role',
    assigneeId: string,
    source: ApprovalAssigneeSource | null,
    sourceIndex: number,
    // Lock-1 §K1 — see metadataFor's resolvedGroupId param.
    resolvedGroupId?: string,
  ): void => {
    // Delegation (委托): a resolved USER assignee who is an active delegator routes to
    // the delegatee. Substituted HERE — before the dedup key — so `seen` dedups on the
    // delegatee: a delegatee already resolved collapses to one. One hop only (the
    // delegatee's own delegation is not re-resolved); user-only.
    let finalId = assigneeId
    let delegatedFrom: string | undefined
    if (assignmentType === 'user') {
      const delegatee = delegations[assigneeId]
      if (delegatee && delegatee !== assigneeId) {
        delegatedFrom = assigneeId
        finalId = delegatee
      }
    }
    // Lock-4 F4-C (OD-L4-4(a)) — same-person TRANSFER substitution. Computed POST-delegation
    // (`finalId` already reflects any delegation hop above), matching the shipped
    // `mergeWithRequester` cascade's own post-delegation comparison (`evaluateAutoApprovalAssignment`
    // in ApprovalProductService.ts reads the FINAL assignment). Reads ONLY the frozen
    // `requesterSnapshot.managerId` / `.deptHeadId` — the SAME fields `direct_manager`/`dept_head`
    // sources already read — so no live directory query runs during dispatch (gate C-2). Self-
    // exclusion mirrors those two sources' own `!== requesterId` guard.
    let samePersonTransfer: ApprovalAssigneeResolutionMetadata['samePersonTransfer']
    if (assignmentType === 'user') {
      const requesterId = normalizeId(options.requesterSnapshot?.id)
      if (requesterId && finalId === requesterId) {
        const policy = options.getEffectiveSamePersonPolicy?.(options.nodeKey)
        if (policy === 'transfer_direct_manager' || policy === 'transfer_dept_head') {
          const targetId = normalizeId(
            policy === 'transfer_direct_manager'
              ? options.requesterSnapshot?.managerId
              : options.requesterSnapshot?.deptHeadId,
          )
          // OD-L4-5(a), RATIFIED verbatim: "the seat is simply not produced" when the transfer
          // target is absent — `emptyAssigneePolicy` then governs. It must NEVER fall back to
          // 'self_approve' (gate C-3), so this is an early RETURN, not a fallthrough to the
          // unsubstituted requester seat.
          if (!targetId || targetId === requesterId) return
          samePersonTransfer = { from: finalId, policy }
          finalId = targetId
        }
      }
    }
    const key = `${assignmentType}:${finalId}`
    if (seen.has(key)) return
    seen.add(key)
    // Legacy (no source) stays metadata-free UNLESS a delegation or same-person transfer applied.
    // `resolvedFrom` (from the ORIGINAL `source`, if any) is preserved unchanged by a same-person
    // transfer — OD-L4-4(a): "the transferred seat keeps the originating resolvedFrom.kind".
    const base = source ? metadataFor(source, sourceIndex, resolvedGroupId) : undefined
    const metadata = (delegatedFrom || samePersonTransfer)
      ? {
          ...(base ?? {}),
          ...(delegatedFrom ? { delegatedFrom } : {}),
          ...(samePersonTransfer ? { samePersonTransfer } : {}),
        }
      : base
    resolved.push({
      assignmentType,
      assigneeId: finalId,
      nodeKey: options.nodeKey,
      sourceStep: options.sourceStep,
      ...(metadata ? { metadata } : {}),
    })
  }

  const sources = options.config.assigneeSources
  if (!sources) {
    // Legacy assigneeType/assigneeIds — routed through pushResolved so delegation
    // applies to existing templates too (delegation is a property of the approval task,
    // not only newly-authored assigneeSources). Metadata-free unless a delegation hits.
    const legacyType: 'user' | 'role' = options.config.assigneeType === 'role' ? 'role' : 'user'
    for (const assigneeId of options.config.assigneeIds ?? []) {
      pushResolved(legacyType, assigneeId, null, 0)
    }
    return resolved
  }

  sources.forEach((source, sourceIndex) => {
    switch (source.kind) {
      // Static sources intentionally remain pure and are dispatched as authored. Lock-4 F4-B's
      // designated fallback is the narrower exception: ApprovalProductService freezes its
      // create-time eligibility and injects a designated-only wrapper before this resolver is
      // called. Keeping the filter outside these arms prevents a designated policy from changing
      // ordinary static source semantics or adding a database read inside the resolver.
      case 'static_user':
        source.userIds.forEach((userId) => pushResolved('user', userId, source, sourceIndex))
        break
      case 'static_role':
        source.roleIds.forEach((roleId) => pushResolved('role', roleId, source, sourceIndex))
        break
      case 'requester': {
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        if (requesterId) pushResolved('user', requesterId, source, sourceIndex)
        break
      }
      case 'direct_manager': {
        // Resolve to the requester's direct manager, frozen in the requester snapshot at
        // approval start (no live directory re-query during dispatch/admin-jump/return).
        // Self-exclusion: a manager that resolves to the requester is not a valid manager,
        // so we return empty here and let the node's emptyAssigneePolicy decide.
        const managerId = normalizeId(options.requesterSnapshot?.managerId)
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        if (managerId && managerId !== requesterId) {
          pushResolved('user', managerId, source, sourceIndex)
        }
        break
      }
      case 'dept_head': {
        // Resolve to the requester's department head, frozen in the requester snapshot at
        // approval start (no live directory re-query). Self-exclusion: a dept head that
        // resolves to the requester is not a valid approver, so we return empty and let the
        // node's emptyAssigneePolicy decide.
        const deptHeadId = normalizeId(options.requesterSnapshot?.deptHeadId)
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        if (deptHeadId && deptHeadId !== requesterId) {
          pushResolved('user', deptHeadId, source, sourceIndex)
        }
        break
      }
      case 'continuous_managers': {
        // Resolve to the requester's management chain (levels 1..source.levels),
        // frozen in the snapshot at start (no live directory re-query). pushResolved's
        // seen-set dedups a person appearing at two levels; self-exclusion drops a hop
        // that resolves to the requester. An empty result falls through to the node's
        // emptyAssigneePolicy; the node's approvalMode (会签 all / 或签 any) then governs
        // how the resolved chain must act.
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        const rawChain = options.requesterSnapshot?.managerChainIds
        const chain = Array.isArray(rawChain) ? rawChain : []
        chain.slice(0, source.levels).forEach((entry) => {
          const managerId = normalizeId(entry)
          if (managerId && managerId !== requesterId) {
            pushResolved('user', managerId, source, sourceIndex)
          }
        })
        break
      }
      case 'manager_at_level': {
        // Resolve to a SINGLE level of the requester's management chain (the
        // `source.level`-th manager, level 1 = direct manager), frozen in the
        // snapshot. Self-exclusion drops a hop resolving to the requester; an empty
        // result (chain shorter than `level`) falls through to emptyAssigneePolicy.
        // Authoring N nodes at levels 1..N composes sequential 逐级 approval (B1).
        // managerChainIds is DENSE — resolveManagerChain (ApprovalDirectoryOrg) walks
        // THROUGH unlinked/self rungs at snapshot-build (pushes only linked, non-self
        // ids), so chain[level-1] is the level-th *linked* manager. The design's
        // "positional pick" and "skip-unlinked walk" reconcile here: the walk already
        // happened at build. A null rung (defensive, never produced by the builder)
        // resolves that level to empty via normalizeId — positional, no compaction.
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        const rawChain = options.requesterSnapshot?.managerChainIds
        const chain = Array.isArray(rawChain) ? rawChain : []
        const managerId = normalizeId(chain[source.level - 1])
        if (managerId && managerId !== requesterId) {
          pushResolved('user', managerId, source, sourceIndex)
        }
        break
      }
      case 'form_field_user': {
        assertFormUserSource(source, options.formSchema, options.nodeKey)
        const assigneeId = resolveFormUserValue(options.formSnapshot[source.fieldId])
        if (assigneeId) pushResolved('user', assigneeId, source, sourceIndex)
        break
      }
      case 'requester_choice': {
        // Lock-1 §K2: resolve to the requester's SUBMIT-TIME choice, read ONLY from the frozen
        // snapshot map (node key → chosen local user ids). The choices were scope-validated at
        // create (fail-closed 422 before any insert), so no live directory/role read happens
        // here — the resolver stays pure, and a re-entered node (return / admin-jump /
        // timeout-jump) re-resolves the SAME list regardless of any directory or role change
        // after create. Changing an in-flight seat is `transfer` (a shipped action), never a
        // re-choice. A missing/empty entry resolves EMPTY and falls to the node's
        // emptyAssigneePolicy — unreachable via createApproval (which 422s on a missing
        // choice); it covers only a made-then-unusable choice or a choices-free preview walk.
        // NO self-exclusion (deliberate, unlike direct_manager/dept_head): the requester may
        // legitimately be inside the configured scope; self-approval semantics stay owned by
        // autoApprovalPolicy.mergeWithRequester.
        const rawMap = options.requesterSnapshot?.requesterChoices
        const rawList = isRecord(rawMap) ? rawMap[options.nodeKey] : undefined
        const chosen = Array.isArray(rawList) ? rawList : []
        chosen.forEach((entry) => {
          const chosenId = normalizeId(entry)
          if (chosenId) pushResolved('user', chosenId, source, sourceIndex)
        })
        break
      }
      case 'continuous_dept_heads': {
        // Lock-1 §K4: resolve to the requester's DEPARTMENT-HEAD chain (levels 1..source.levels),
        // frozen in the snapshot at create — a DIFFERENT pointer from continuous_managers'
        // managerChainIds (the leader_in_dept LEADER pointer). This walks the department PARENT
        // tree reading dept_manager_userid_list at each level
        // (ApprovalDirectoryOrg.resolveDeptHeadChain), which — unlike managerChainIds — CONTINUES
        // past a level whose head is unresolved (the ratified continue-past-empty-level posture,
        // ratified Lock-1 §K4 / confirmed BINDING by Lock-2), since the chain-build's next hop is
        // the department's own parent pointer, never a resolved manager. No live directory
        // re-query happens HERE either way: this arm is a pure slice over the frozen chain,
        // mirroring continuous_managers exactly (same self-exclusion, same dedup-via-pushResolved,
        // same emptyAssigneePolicy fallthrough on an empty result).
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        const rawChain = options.requesterSnapshot?.deptHeadChainIds
        const chain = Array.isArray(rawChain) ? rawChain : []
        chain.slice(0, source.levels).forEach((entry) => {
          const headId = normalizeId(entry)
          if (headId && headId !== requesterId) {
            pushResolved('user', headId, source, sourceIndex)
          }
        })
        break
      }
      case 'prior_node_approver': {
        // Lock-1 §K3: resolve to the referenced prior node's ACTUAL decider(s), read from the
        // caller-supplied `priorNodeApprovers` map (instance-internal approval_records actors,
        // LATEST round only — OD-L1-3(a)); never from config, never from a directory read, and no
        // resolver-internal database access (§2.1: K3's input is caller-supplied at activation).
        // System sentinel actors are dropped here as a pure re-check (primary drop is in the
        // caller's audit-row read); when nothing remains — the node was skipped, unreached,
        // auto-approved under the system actor, or the map is absent (create-time cascade /
        // choices-free preview) — resolution is EMPTY and falls to the node's emptyAssigneePolicy
        // (OD-L1-4(a): fail-closed APPROVAL_ASSIGNEE_EMPTY under the default 'error'; an AUDITED
        // auto-approval event under an explicit 'auto-approve' — never a silent nobody).
        // NO self-exclusion (deliberate — the §K2 posture): a prior decider who is the requester
        // still gets the seat; self-approval stays owned by autoApprovalPolicy.mergeWithRequester.
        // Cross-node NO-DEDUP is structural: this node's `seen` set is per-resolution, so the same
        // person approving at the prior node simply gets a fresh seat here; intra-node dedup
        // (one seat per identity at THIS node) still applies via pushResolved.
        const rawMap = options.priorNodeApprovers
        const rawList = isRecord(rawMap) ? rawMap[source.nodeKey] : undefined
        const deciders = Array.isArray(rawList) ? rawList : []
        deciders.forEach((entry) => {
          const deciderId = normalizeId(entry)
          if (deciderId && !isSystemSentinelActor(deciderId)) {
            pushResolved('user', deciderId, source, sourceIndex)
          }
        })
        break
      }
      case 'dept_head_at_level': {
        // Lock-1 §K5-b: resolve to a SINGLE level of the requester's DEPARTMENT-HEAD chain (the
        // `source.level`-th entry, level 1 = the requester's own department head), frozen in the
        // same `deptHeadChainIds` snapshot K4's `continuous_dept_heads` reads — positionally
        // IDENTICAL to `manager_at_level` (:205-225 above), just over a different chain. Strictly
        // downstream of K4: no new snapshot field, no new directory read of its own.
        // Self-exclusion drops a hop resolving to the requester; an empty result (chain shorter
        // than `level`, or `deptHeadChainIds` absent because no node in the published graph
        // triggered the bake) falls through to `emptyAssigneePolicy` — Lock-1 §K5's explicit
        // ruling that an in-contract level absent from THIS requester's chain is never a
        // dispatch-time failure. deptHeadChainIds is DENSE under the RATIFIED
        // continue-past-empty-level posture (resolveDeptHeadChain continues past an empty/
        // unresolved level to that department's own parent — see the union member's doc
        // comment), so chain[level-1] is the level-th *resolved* head walking up, NOT "the head
        // N parent-hops up": an intermediate department with no resolvable head shifts every
        // deeper level's position, exactly as `manager_at_level`'s own dense-chain contract does
        // for managerChainIds. A null rung (defensive, never produced by the builder) resolves
        // that level to empty via normalizeId — positional, no compaction.
        const requesterId = normalizeId(options.requesterSnapshot?.id)
        const rawChain = options.requesterSnapshot?.deptHeadChainIds
        const chain = Array.isArray(rawChain) ? rawChain : []
        const headId = normalizeId(chain[source.level - 1])
        if (headId && headId !== requesterId) {
          pushResolved('user', headId, source, sourceIndex)
        }
        break
      }
      case 'user_group': {
        // Lock-1 §K1 (RATIFIED OD-L1-1(a) EAGER_EXPANSION): resolve to the FROZEN member list of
        // every referenced group id, read ONLY from the create-time snapshot
        // (`requesterSnapshot.groupMemberIds`) — no live `platform_member_group_members` read
        // happens here, so a membership change after create never reaches an in-flight instance
        // (return/admin-jump/timeout re-resolve the SAME frozen list). A group id absent from the
        // snapshot (never baked, or deleted after publish) contributes nothing — an empty group is
        // a normal empty resolution, falling to `emptyAssigneePolicy`, never a resolver-thrown
        // error (§K1: the org/existence boundary is enforced only at publish). NO self-exclusion
        // (deliberate — matches `static_user`/`static_role`: a finite explicit membership list, not
        // an org-hierarchy walk; self-approval semantics stay owned by
        // `autoApprovalPolicy.mergeWithRequester`). Each member carries `resolvedFrom.groupId` so
        // "why is this person here" answers WHICH group when a source lists more than one.
        const rawGroupMap = options.requesterSnapshot?.groupMemberIds
        const groupMap = isRecord(rawGroupMap) ? rawGroupMap : {}
        source.groupIds.forEach((groupId) => {
          const rawMembers = groupMap[groupId]
          const members = Array.isArray(rawMembers) ? rawMembers : []
          members.forEach((entry) => {
            const memberId = normalizeId(entry)
            if (memberId) pushResolved('user', memberId, source, sourceIndex, groupId)
          })
        })
        break
      }
      case 'form_field_user_manager':
      case 'form_field_user_dept_head': {
        // Lock-2 §L2-C (form-field contact extensions): resolve to the FROZEN create-time
        // extension of the person chosen in the referenced `user` field — a pure map lookup over
        // `fieldDerivedAssigneeIds` (source fingerprint → resolved local user ids), frozen by the
        // create path from the frozen directory read (submit IS create, §0 Correction 2). NO live
        // directory read happens here on ANY path — dispatch, return, admin-jump, timeout-jump
        // all re-resolve the SAME frozen list (§2.1 resolver purity; the freeze is temporal, not
        // a dead read — a directory change after create alters only NEWLY created approvals).
        // An empty/absent entry (contact without a directory account, chain shorter than the
        // configured level, or a snapshot that never baked the map because the graph carries no
        // such source) is EMPTY resolution falling to the node's `emptyAssigneePolicy` (§2.6) —
        // under the default 'error' that is a fail-closed APPROVAL_ASSIGNEE_EMPTY, and under an
        // explicit 'auto-approve' an AUDITED auto-approval event, never a silent nobody. A FAILED
        // create-time read never reaches this arm at all: the create wedge fails closed 422/503
        // before any instance/assignment insert (§2.3), so "read failed" cannot masquerade as
        // "resolved to nobody".
        // NO requester self-exclusion (deliberate — Lock-2 §L2-C: shipped `dept_head`'s inline
        // requester-exclusion is a requester-anchored artifact; a chosen contact's manager who
        // happens to BE the requester still gets the seat, and same-person semantics compose
        // through autoApprovalPolicy.mergeWithRequester). Anchor self-exclusion — the CONTACT is
        // never their own manager/head — already happened inside the chain walk at create.
        const rawMap = options.requesterSnapshot?.fieldDerivedAssigneeIds
        const rawList = isRecord(rawMap) ? rawMap[fieldDerivedAssigneeSourceKey(source)] : undefined
        const frozen = Array.isArray(rawList) ? rawList : []
        frozen.forEach((entry) => {
          const resolvedId = normalizeId(entry)
          if (resolvedId) pushResolved('user', resolvedId, source, sourceIndex)
        })
        break
      }
      default:
        throw new ServiceError(
          `Approval node ${options.nodeKey} has an unsupported assignee source`,
          400,
          'APPROVAL_ASSIGNEE_INVALID_SOURCE',
          { nodeKey: options.nodeKey },
        )
    }
  })

  return resolved
}
