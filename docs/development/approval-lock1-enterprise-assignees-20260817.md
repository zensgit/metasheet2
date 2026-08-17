# Lock-1 — Enterprise Assignee Kinds and Resolution Semantics (2026-08-17)

**Status:** PROPOSED — NOT RATIFIED. This document authorizes nothing; §4 is blank until an explicit
owner decision names it and its SHA.
**Baseline:** `origin/main@0e8ed116712429c17abee41bd6bacb62fcc06331`. Every anchor below was read at
THIS baseline, which is NEWER than both parents (the master lock pins `d33a6a0fa1`; Lock-0 pins
`5b31cb4349`) — line numbers are exact here and may differ from those documents' own citations.
**Parents:** `approval-parity-master-design-lock-20260817.md` (RATIFIED) §3 Lock-1 row, §P2 exit, M4,
M5, M11 — this is that row's draft; `approval-lock0-d0-interaction-delta-20260817.md` L0-2 registry
contract — **on branch `docs/approval-lock0-d0-interaction-delta-20260817` @ `1c119d833`, NOT on
main**: its in-file §4 records a RATIFY but the file is absent from `origin/main` at this baseline, so
every registry row below is **conditional on Lock-0 landing**;
`attendance-approval-s7-resolver-direct-manager-dept-head-multilevel-design-lock-20260716.md`
(RATIFIED) — the governing precedent: an unimplemented kind fails closed 422 at authoring AND at
runtime and never lands inert; `approval-canvas-v2-interaction-design-lock-20260721.md` §10.2 (typed
pickers, no raw IDs) and §10.3 (one assignee-source picker).
**Non-effects:** no runtime code, no migration, no flag change, no tenant UAT, no deployment, no
completion label. Nothing here is implementable until ratified, and each slice still needs its own PR,
required checks, and named human approval. Department/contact FORM CONTROLS and field-derived routing
are Lock-2; dedup/fallback/same-person policy is Lock-4; the handler node is Lock-3.

## 1. Kinds

Each subsection states only what DIFFERS from the §2 invariants (single authoring choke,
freeze-at-create, empty-resolution, fingerprint, five FE mirror sites, typed picker, registry row,
values-free errors). Acceptance gates live only in §3.

### K1 — `user_group` approver, and group as a cc recipient

Shape: `{ kind: 'user_group'; groupIds: string[] }` over `platform_member_groups`
(`zzzz20260409154000_create_platform_member_groups_and_delegated_group_scopes.ts:11-26`), members in
`platform_member_group_members` (`:31-37`, PK `(group_id, user_id)`).

**The central fork (OD-L1-1).** The options are not interchangeable implementations of one semantic;
they differ in whether a membership change reaches an in-flight task.

| Option | Mechanism | Cost measured at this baseline | In-flight |
|---|---|---|---|
| **LATE_BINDING** | rows persist as `assignment_type='group'`, membership matched at action time — mirroring the shipped role precedent (`assignmentMatchesActor`, `ApprovalProductService.ts:2452-2465`, matches `role` against the actor's CURRENT role ids) | new `assignment_type` ⇒ migration altering the CHECK `IN ('user','role','source_queue')` (`zzzz20260404100000_extend_approval_tables_for_bridge.ts:88`) and re-examination of `UNIQUE (instance_id, assignment_type, assignee_id, source_step)` (`:95`); widening `ResolvedApprovalAssignment.assignmentType` past `'user' \| 'role'` (`ApprovalAssigneeResolver.ts:10`); a group branch at every reader — **55 `assignment_type` occurrences across 12 non-migration files** under `packages/core-backend/src` | membership change DOES affect pending tasks |
| **EAGER_EXPANSION** *(recommended)* | members read ONCE at create and frozen into the requester snapshot, exactly like `managerChainIds`; the resolver expands them purely | one opt-in create-time read mirroring `includeManagerChain` (`ApprovalDirectoryOrg.ts:493-503`, gated by `runtimeGraphUsesManagerChain` at `ApprovalProductService.ts:4783`); zero migration, zero reader changes | membership change does NOT affect in-flight instances |

Recommendation is EAGER_EXPANSION: freeze-at-create is this program's governing constraint for every
other org-derived kind (§2.1), and resolver purity (`ApprovalAssigneeResolver.ts:92-243`) is what makes
dispatch/admin-jump/return deterministic. Its honest cost: a user added to a group tomorrow cannot
approve a task dispatched today — which DIFFERS from the role precedent that the corpus's group model
most resembles, and that difference is the owner's actual trade, not an implementation detail. Under
EAGER the snapshot gains `groupMemberIds?: Record<string, string[]>` (group id → ordered local user
ids), populated only for group ids the published runtime graph references.

**Org/tenant boundary (OD-L1-2).** `platform_member_groups` has **no org column** and a **globally
UNIQUE name** (`idx_platform_member_groups_name`, migration `:24-26`), while approval routing is
org-anchored (S7 §3.3; `resolveApprovalRequesterOrgRelations` accepts an `orgId` that the kernel's own
create path does not pass — `ApprovalProductService.ts:4794-4796`). The discriminating question for
any option: **does it reject a cross-boundary group at publish without depending on
`platform_member_groups.description`?**

- **(a) curated per-org binding table** *(recommended)* — `approval_usable_member_groups(org_id, group_id)`,
  empty by default, re-validated at publish on the publishing transaction's client. This EXTENDS the
  RA-1b curated-vocabulary pattern (`roles.approval_usable`,
  `zzzz20260627150000_add_approval_usable_to_roles.ts`; `fetchCuratedApprovalRoleIds`,
  `approval-directory.ts:89-98`) to an approver kind. Stated precisely so it is not mis-cited:
  `approval_usable` today gates the `requester.role` **routing predicate**, not approver selection —
  `listDirectoryRoles` (`approval-directory.ts:58-63`) returns ALL roles to the `static_role` picker.
- **(b) add `org_id` to `platform_member_groups`** — touches a table owned by the delegated-scope line
  (`platform-member-groups-delegated-scope-design-20260409.md`); hand-created groups have no
  authoritative backfill source and the globally-unique-name contract would need revision.
- **(c) derive org from the projection marker** — REJECTED, recorded so it is not re-proposed:
  `dingtalk-sync-group:<integrationId>:<externalDeptId>` lives in the free-text `description` column
  (`directory-sync.ts:1689-1691`, written at `:6360-6366`), is admin-editable, and exists only for
  projected groups. A boundary on free text is not a boundary.
- **(d) single-org gate** — refuse `user_group` when more than one org exists: cheapest and
  fail-closed, but unavailable to exactly the deployments that need it.

Honesty note: this is the FIRST approver kind proposed with an explicit org binding. `roles` has no org
column either and the shipped `static_role` is equally unscoped; option (a) narrows a NEW kind and this
document does not claim it retro-fixes `static_role`.

**Cc is a second contract, not a rider.** `CcNodeConfig` is
`{ targetType: 'user' | 'role'; targetIds: string[] }` (`types/approval-product.ts:213-216`) and cc
nodes never call `resolveApprovalAssignees` — both executor cc branches hard-throw on any other
`targetType` (`ApprovalGraphExecutor.ts:993-1003`, `:1285-1295`). The cc half needs its own normalize
path, registry treatment, and acceptance row (§3 G-4). Whether it ships by widening `targetType` to
`'group'` or by adding `ccSources[]` belongs to the implementing slice; what is LOCKED is that the cc
half may not be declared delivered by the approver half's tests.

Empty group ⇒ EMPTY resolution, falling to `emptyAssigneePolicy` like an unresolvable manager
(`ApprovalGraphExecutor.ts:1017-1033`, `:1309-1325`); a group id that does not exist or is outside the
org binding is a DIFFERENT case, fail-closed at publish (§2.2), never at dispatch. Fingerprint
`user_group:<sorted groupIds joined by ','>` is provably identical under either binding, so identical
group sets across parallel branches are publish-blocked. Delegation is unchanged: expansion happens
BEFORE `pushResolved`, so substitution and the `seen` dedup apply per member
(`ApprovalAssigneeResolver.ts:102-136`). Audit: `resolvedFrom: { kind, sourceIndex, groupId }` per
member — `resolvedFrom` gains an optional `groupId` beside the existing optional `fieldId`
(`types/approval-product.ts:179-183`), so "why is this person an approver" is answerable from the row.

### K2 — `requester_choice` (提交人自选)

Shape: `{ kind: 'requester_choice'; mode: 'single' | 'multi'; scope }` where scope is
`{ type: 'company' } | { type: 'members'; userIds: string[] } | { type: 'role'; roleIds: string[] }`.

**Freeze-at-create is the governing constraint and it has a UI consequence.** The chooser runs at
SUBMIT time, before the instance exists: chosen ids travel in the create payload, are validated
server-side against the published node's configured scope, and are frozen into the create-time snapshot
as `requesterChoices?: Record<string, string[]>` (node key → chosen local user ids). The resolver reads
only that frozen map, so it stays pure and no live directory or role read happens at dispatch.

Scope validation at create: `company` accepts any active local user; `members` accepts only ids in the
configured list; `role` accepts only ids holding a configured role at create time, resolved by a fresh
read on the `resolveApprovalRequesterRoleIds` seam (`ApprovalRequesterRoles.ts:32-52`) and never from
the actor's token claims. `mode:'single'` rejects length ≠ 1; `'multi'` rejects length 0. Each
rejection is a values-free 422 BEFORE any instance/assignment insert, mirroring the org-read
fail-closed placement at `ApprovalProductService.ts:4846-4859`. A published node with a
`requester_choice` source and NO entry for its key in the create payload is likewise a create-time 422,
not an empty resolution — the requester was required to choose and did not; only a choice made and
later unusable (chosen user deactivated) reaches `emptyAssigneePolicy`.

Immutability after create: the frozen choice is never re-read, re-validated, or re-chosen — not on
return, admin-jump, or timeout-jump; a re-entered node re-resolves the SAME list. Changing an in-flight
seat is transfer (a shipped action), not a re-choice.

**Fingerprint: `null`, deliberately.** Two `requester_choice` sources on parallel branches are NOT
provably identical — the requester may pick different people — so per the gate's own rule (only
provably-identical sources are publish-blocked, `ApprovalProductService.ts:1461-1466`) this belongs to
the runtime `APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT` guard (`:7837`, `:7865`). The
`_exhaustive: never` guard (`:1445-1448`) forces an entry to exist; this `null` is a decision, not an
oversight, and that rationale must appear in the code comment.

### K3 — `prior_node_approver` (节点审批人)

Shape: `{ kind: 'prior_node_approver'; nodeKey: string }`, resolving to the referenced node's ACTUAL
deciders from instance state — never from config.

Node attribution lives in `approval_records.metadata->>'nodeKey'` (there is NO `node_key` column on
`approval_records`; the existing query idiom is at `ApprovalProductService.ts:6637`, `:6959-6980`),
with `metadata.nodeEntryEpoch` scoping re-entry rounds. **This is the one kind whose resolution is not
a pure function of the create-time snapshot** — the deciders are unknowable at create. The resolver
stays pure by contract: deciders are read by the CALLER at node activation and passed in alongside the
snapshots, exactly as `formSnapshot` and `requesterSnapshot` are today. No resolver-internal database
access is added.

Legal references (publish-time): the target MUST be an `approval` node strictly upstream on EVERY
runtime-reachable path to the referencing node. "Every path" is load-bearing — a node reachable only
through one condition branch resolves empty on the other, and a node inside a parallel region
referenced from outside it may not have decided when the referencing node activates. Validation reuses
the traversal already written for the parallel-conflict gate
(`assertNoParallelDynamicAssigneeConflicts`, `ApprovalProductService.ts:1484+`, documented to enumerate
every runtime-reachable path and cut cycles with a per-branch visited set); a failing reference is a
publish-time 400 in the same family as the other authoring config errors.

Skipped / auto-approved target — **decided by shipped precedent, not an enum**: an auto-approval
writes `actor_id = 'system:auto-approval'` unless `actorMode: 'original_approver'`
(`ApprovalProductService.ts:3133-3140`) and a timeout effect writes `'system:approval-timeout'`
(`:474`); neither sentinel is an assignable user, so a sentinel actor is DROPPED, never assigned. What
remains open (OD-L1-4) is what happens when dropping leaves nothing: fall through to
`emptyAssigneePolicy` (consistent with every other kind) or fail the dispatch explicitly. Round
scoping (OD-L1-3): a re-entered prior node has several rounds distinguished by `nodeEntryEpoch` —
LATEST round only (recommended: it is the decision that actually led here, matching the threshold
tally's own epoch-scoped posture at `:6975-6985`) or the UNION of all rounds.

**Explicit NO-DEDUP.** The reference corpus records this kind as not deduplicated — the same person
approves again at the referencing node. The resolver's `seen` set
(`ApprovalAssigneeResolver.ts:121-123`) dedups WITHIN one node's resolution and must keep doing so
(one seat per identity at this node); it does not and must not reach across nodes. The cross-node
"already approved" question is owned by the shipped `autoApprovalPolicy.dedupeHistoricalApprover` /
`mergeAdjacentApprover`, which are Lock-4's surface. **Cross-lock seam, named not designed:** if
Lock-4 later makes any historical-dedup policy the default it MUST state explicitly whether it applies
to `prior_node_approver`; this document's position is that a node meaning "ask the previous approver
again" is the natural exemption, and Lock-4 owns that ruling. Fingerprint:
`prior_node_approver:<nodeKey>` — provably identical for the same target.

### K4 — `continuous_dept_heads` (连续多级部门负责人)

Shape: `{ kind: 'continuous_dept_heads'; levels: number }`, `levels` validated
`[1, MAX_MANAGER_CHAIN_LEVELS]` byte-identically to `continuous_managers`
(`ApprovalProductService.ts:616-624`; constant `ApprovalDirectoryOrg.ts:101`, default 10 at `:76`,
hard ceiling 50 at `:79`).

**Which chain the shipped kind walks — verified, and it is NOT this one.** `continuous_managers`
consumes `managerChainIds`, built by `resolveManagerChain` (`ApprovalDirectoryOrg.ts:585-615`), which
walks the **`leader_in_dept` leader pointer**: each hop finds the account flagged leader of the current
department (`findDeptLeaderHop`, `:525-564`) and continues from **that leader's own primary
department**. K4 is a different pointer on a different tree — the **department parent tree**
(`directory_departments.external_parent_department_id`,
`zzzz20260324150000_create_directory_sync_tables.ts:48`, resolved level-by-level through the unique
`(integration_id, external_department_id)` index at `:60-62`) reading `dept_manager_userid_list` at
each level (`parseDeptManagerExternalIds`, `ApprovalDirectoryOrg.ts:137-147`). The two coincide only
where every department's leader is also its listed manager. Any claim that K4 is "continuous_managers
with a different label" is wrong.

"Primary" head for a multi-head department is **inherited, not invented**: `dept_manager_userid_list`
carries no primary marker, and the shipped `dept_head` already defines it as *the first external id in
list order, excluding the requester, that resolves to a LINKED local user*
(`ApprovalDirectoryOrg.ts:467-478`). K4 inherits that byte-identically at every level; a level whose
list is empty or resolves to no linked user contributes nothing and the walk CONTINUES upward,
matching `resolveManagerChain`'s dense-chain posture (`:605-608`). This is not an owner enum — only a
DIFFERENT rule would be.

Snapshot: new opt-in `deptHeadChainIds?: string[]`, built at create under the same "only when the
published graph uses it" gate as `includeManagerChain`, cycle-guarded by a visited set of external
department ids, self-excluded on the requester's LOCAL id, capped at `MAX_MANAGER_CHAIN_LEVELS`.
Resolution mirrors `continuous_managers` (`ApprovalAssigneeResolver.ts:187-204`) exactly: slice
`[0, levels)`, drop self, dedup via `pushResolved`, node `approvalMode` governs aggregation.
Fingerprint: `continuous_dept_heads:<levels>`.

Endpoint semantics (OD-L1-5, staged): the corpus evidences two terminations for continuous chains — a
LEVEL COUNT, or "stop when a resolved person belongs to a nominated user group". The level count is
deliverable with K4 alone; the group endpoint is a sub-decision **gated on K1** (meaningless before
`user_group` exists, and under EAGER_EXPANSION it also requires the endpoint group's membership frozen
at create beside the chain). Recommendation: ship the level count with K4 and defer the group endpoint
to a K1-dependent follow-up that cannot start before OD-L1-1 is decided.

### K5 — Bidirectional level addressing (直属+n upward, 最高-n downward)

This is smaller than it looks and one third of it is already shipped; saying so prevents rebuilding it.

- **K5-a manager upward `直属+n` — ALREADY EXPRESSIBLE, no backend contract change.** The shipped
  `manager_at_level` (`{ level: n+1 }`, level 1 = direct manager,
  `ApprovalAssigneeResolver.ts:205-225`) IS this semantic. What is missing is a picker affordance and a
  label — P1-B / D0 §10.3 territory, not a new kind. This document adds nothing here and no acceptance
  gate claims otherwise.
- **K5-b dept-head upward `部门负责人+n` — strictly downstream of K4.** It is `deptHeadChainIds[n]` and
  cannot exist before K4 builds that chain. Contract `{ kind: 'dept_head_at_level'; level: number }`,
  `level` validated `[1, MAX_MANAGER_CHAIN_LEVELS]`, fingerprint `dept_head_at_level:<level>`,
  semantics mirroring `manager_at_level` positionally.
- **K5-c downward `最高-n` — BLOCKED on snapshot data (OD-L1-6).** Both chains are bare `string[]`
  (`resolveManagerChain` returns `chain`, `ApprovalDirectoryOrg.ts:585-615`) and the walk terminates on
  any of three conditions — top of tree, cycle, or the `maxLevels` cap — **recording which one
  nowhere**. Counting `n` down from `chain.length - 1` therefore cannot distinguish "the real top of
  the organization" from "we stopped at level 10". Addressing from the top of a possibly-truncated
  chain is a silent wrong-approver bug of exactly the class this program exists to close. Options:
  **(i)** *recommended* — add a termination-reason field (`managerChainComplete?` /
  `deptHeadChainComplete?`, true only when the walk ended because no further hop exists) and fail
  closed with a values-free 422 at create when downward addressing meets an incomplete chain;
  **(ii)** defer downward addressing to a later lock; **(iii)** ship against the raw array — rejected
  here, recorded so it is not re-proposed.

For whichever direction ships: a `level` outside `[1, MAX_MANAGER_CHAIN_LEVELS]`, non-integer, or
missing is rejected at the authoring choke exactly as the shipped kinds are
(`ApprovalProductService.ts:625-633`) — never coerced, never defaulted. A level valid in contract but
absent from this requester's chain resolves EMPTY and falls to `emptyAssigneePolicy`, which is the
shipped `manager_at_level` behavior, unchanged.

### K6 — `sequential` within-node approval mode (依次审批)

`ApprovalMode` gains a fifth member. Complete post-K6 lattice:

| Mode | Meaning | Node resolves when |
|---|---|---|
| `single` | sole approver (absent default) | that approver acts |
| `any` | 或签 | the FIRST approver approves |
| `all` | 会签 | EVERY resolved approver has approved |
| `threshold` | N-of-M 门槛会签 (linear-only) | N DISTINCT identities have approved |
| `sequential` *(new)* | 依次审批 | every approver has approved, IN ORDER |

`sequential` is `all` plus an ordering constraint on WHEN each seat becomes actionable: only the head
of the remaining queue holds an active assignment, and the next seat activates when the head approves.
A reject at any position terminates the node exactly as under `all`.

Ordering source, locked: (1) `assigneeSources[]` array order — which master M5 declares display order
and this kind additionally makes semantic **for `sequential` nodes only** — then (2) within a source,
the resolver's own emission order (`ApprovalAssigneeResolver.ts:150-240`: `userIds` order for
`static_user`, chain order for chain kinds, group-member order for K1). Identity dedup runs first, so a
person appearing twice occupies their FIRST position only. The order must be deterministic and
re-derivable from the frozen graph plus frozen snapshot, so a re-entry recomputes an identical queue.

**The executor's mode normalizer is fail-OPEN today and K6 must fix that first.**
`normalizeApprovalMode` (`ApprovalGraphExecutor.ts:291-293`) silently maps ANY unrecognized mode to
`'single'`, while the authoring choke rejects unknown modes outright
(`ApprovalProductService.ts:500-506`). The gap is unreachable for contract-valid data today, but the
moment `sequential` is authorable it becomes reachable by **deploy skew or rollback**: a graph
published on new code and executed by old code degrades silently to first-approver-wins with no error
and no audit signal — the precise inverse of the S7 governing precedent. Locked requirement: the K6
slice replaces that silent default with an explicit failure for unknown modes BEFORE making
`sequential` authorable, with a positive control proving known modes still execute (§3 G-14). The
ordering of those two halves is not optional.

Re-entry/return seam, named with detail deferred: what happens to a partially-completed queue on
return, admin-jump, or timeout-jump is a runtime-slice question with an existing mechanism to hang it
on — `nodeEntryEpoch` already mints a fresh epoch per activation and scopes the threshold tally to the
current round (`ApprovalProductService.ts:6922-6990`). This document locks only that `sequential` MUST
use that same epoch scoping (a re-entry restarts the queue at position 1; prior-round approvals never
satisfy the new round) and that the runtime slice specifies the rest.

FE compatibility: an unknown mode is NEVER flattened — it renders read-only and round-trips unchanged
(Lock-0 A-series precedent; master P1-C / I12). Sequencing hazard: FE `ApprovalMode`
(`apps/web/src/types/approval.ts:19`) is `'single' | 'all' | 'any'` and already lacks `threshold`, and
K6's frontend work touches the same two allowlists as master P1-C (`templateAuthoring.ts:588-596`
complex, `:759-769` linear) — so **K6 FE must be sequenced after P1-C**, not in parallel with it.

## 2. Cross-cutting invariants

**2.1 Freeze-at-create.** Resolution is a PURE function over FROZEN snapshots
(`ApprovalAssigneeResolver.ts:92-243`); no live directory query runs at dispatch, admin-jump, return,
or timeout. Every new kind either reads a create-time snapshot field or (K3 alone) receives its input
from the caller at activation; no kind may add a database call inside the resolver. New snapshot reads
are OPT-IN, gated on the published runtime graph actually using the kind — the posture
`includeManagerChain` establishes (`ApprovalDirectoryOrg.ts:493-503`, gate at
`ApprovalProductService.ts:4783`) — so unrelated approvals pay nothing. Org-read failure keeps its
shipped fail-closed placement: read failed or routing policy misconfigured AND the graph uses an
org-derived source ⇒ create fails 422/503 before any insert (`ApprovalProductService.ts:4846-4859`,
detector `runtimeGraphUsesOrgAssigneeSource` at `:2922-2937`). **That detector MUST be extended to K4
and K5-b**; leaving it unextended reproduces exactly the fail-open the B5-b guard closed (an empty org
read plus `emptyAssigneePolicy: 'auto-approve'` silently auto-approves).

**2.2 Unimplemented is fail-closed, never inert.** `normalizeApprovalAssigneeSources`
(`ApprovalProductService.ts:581-646`) is the SINGLE authoring choke and its `default:` arm calls
`failValidation` (`:642-644`); every kind here extends that switch or does not exist. A kind
contract-declared but not resolver-implemented is rejected at authoring — it may not round-trip and lie
dormant (S7 §7 S7-1). At runtime the resolver's `default:` arm throws
`APPROVAL_ASSIGNEE_INVALID_SOURCE` (`ApprovalAssigneeResolver.ts:232-238`) and stays. Publish-time
config errors — unknown group id, group outside the org binding, illegal `prior_node_approver`
reference, downward addressing on an incomplete chain — are 400/422 at authoring or create, never a
dispatch-time surprise on a published template.

**2.3 Capability registry (conditional on Lock-0 landing).** Each ratified kind gets one L0-2 registry
row; the inspector renders a source only when its capability is ratified, implemented end to end, and
present in the registry for that node type (master M4). Unratified kinds are not rendered; a persisted
value outside the registry renders read-only and round-trips unchanged. The registry exact-set test
(Lock-0 A-3) grows from eight members to eight-plus-ratified-K-kinds in the SAME commit that lands each
kind — a kind landing without its registry row is an incomplete slice. Because Lock-0 is not on main at
this baseline, a slice starting before it lands must state which registry it writes into.

**2.4 Fingerprints.** `dynamicAssigneeSourceFingerprint` (`ApprovalProductService.ts:1429-1450`) closes
over the union with `_exhaustive: never` (`:1445-1448`), and its FE mirror does the same
(`apps/web/src/approvals/parallelEdit.ts:152-172`, guard at `:167-169`; consumer
`parallelDynamicAssigneeConflicts` at `:244`) — so adding a kind without a fingerprint entry is a
COMPILE error on BOTH sides. The guard is the enforcement, not a checklist; both sides must move in the
same slice or publish and authoring disagree. Locked entries: K1 `user_group:<sorted ids>`, K2 `null`
(rationale in the comment, §K2), K3 `prior_node_approver:<nodeKey>`, K4 `continuous_dept_heads:<levels>`,
K5-b `dept_head_at_level:<level>`.

**2.5 Mirror sites and typed pickers.** Five sites move in lockstep for every new kind, and the fifth
carries a defect that must NOT be inherited:

1. `packages/core-backend/src/types/approval-product.ts:15` (`ApprovalAssigneeSourceKind`) and
   `:149-170` (`ApprovalAssigneeSource` union).
2. `apps/web/src/types/approval.ts:18` and `:96-104` — the FE copies of both.
3. `apps/web/src/approvals/templateAuthoring.ts:603-612` (`BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND`) — the
   per-kind key allowlist; a kind missing here is treated as a backend-drop and forces read-only.
4. `apps/web/src/approvals/templateAuthoring.ts:775` — the linear editor's accepted-kind list.
5. `apps/web/src/approvals/assigneeSource.ts:19-31` (`assigneeSourceSummary`) — its `default:` arm
   returns `JSON.stringify(source)` (`:29`), leaking raw JSON including raw IDs into an ordinary-user
   surface. New kinds add an explicit case AND the slice replaces that default with a values-free
   fallback label. Inheriting the leak into a new kind's summary is a defect, not a precedent.

Typed pickers (D0 §10.2): every new reference resolves through a typed picker with business labels and
search; no control accepts or displays a raw ID. K1 needs a group picker (new minimal-exposure endpoint
on the `approval-directory.ts` seam returning id + name + member count only, behind the same
template-admin guard as the shipped user/role lookups, `:1-12`). K2 needs a scope-aware member picker
plus the submit-time chooser. K3 needs a node picker restricted to the publish-time-legal upstream set —
never a free-text node key.

**2.6 Empty resolution, errors, audit.** Empty resolution ALWAYS falls to the node's
`emptyAssigneePolicy` (`ApprovalGraphExecutor.ts:1017-1033`, `:1309-1325`); no kind invents its own
empty behavior, and the per-kind exceptions above are all authoring/create-time failures rather than
dispatch-time ones. Errors are values-free: node keys, source indexes, and template-authored ids are
permitted; resolved person identities, group membership, and form values are not. Every resolved
assignment carries `metadata.resolvedFrom` (`types/approval-product.ts:172-189`) extended per kind, so
audit answers "why is this person here" from the row alone; delegation continues to stamp
`delegatedFrom` (`ApprovalAssigneeResolver.ts:124-128`).

## 3. Acceptance gates

Master §P2 exit applies to every kind: save/publish/preview/execute parity, multi-corp negative
controls, directory-change tests, values-free errors. Every absence assertion carries a positive
control; an absence test without one is green against nothing.

| # | Gate | Assertion | Positive control (mandatory) |
|---|---|---|---|
| G-1 | Authoring choke | each new kind is accepted only in its exact shape; unknown kind, missing/non-integer/out-of-range params, and unknown extra keys each fail `normalizeApprovalAssigneeSources` | a valid instance of the SAME kind saves — the rejection is shape-selected, not blanket |
| G-2 | Not-yet-implemented is not inert | a contract-declared but resolver-unimplemented kind is rejected at create/update, never persisted | an implemented kind persists in the same fixture |
| G-3 | Round-trip parity | save → publish → preview → execute preserves each kind byte-for-byte; version compare and restore-to-new-draft carry it | mutate one param (e.g. `levels`) and assert the diff SHOWS it — the comparison is not vacuous |
| G-4 | Cc half (K1) | a group cc target delivers cc events for every member; the cc branch no longer throws for the ratified shape | a NON-ratified `targetType` still throws (`ApprovalGraphExecutor.ts:997`) — the widening is enumerated, not permissive |
| G-5 | K1 org boundary | publishing a template referencing a group outside the requesting org's binding fails closed at publish | a group INSIDE the binding publishes — the gate is membership-selected |
| G-6 | K1 multi-corp negative | two orgs, one local user linked in both, identically-named group fixtures: routing resolves only the requesting org's members | the same request in the other org resolves that org's members — both directions asserted |
| G-7 | K1 binding semantics | under the ratified option: EAGER — membership changed after create does NOT change an in-flight assignment; LATE — it DOES | the opposite-direction fixture must fail under the other option; the test names which option it pins |
| G-8 | K2 scope validation | choices outside `members`/`role`/mode cardinality are 422 at create with zero rows persisted | an in-scope choice creates successfully in the same fixture |
| G-9 | K2 immutability | a directory/role change after create does not alter the frozen choice; re-entry re-resolves the same list | a transfer action DOES change the seat — the instance is mutable only by the sanctioned path |
| G-10 | K3 upstream legality | a reference not strictly upstream on every runtime-reachable path fails at publish (condition-branch and parallel-region cases both) | a legal upstream reference publishes |
| G-11 | K3 sentinel actors | a prior node decided by `system:auto-approval` / `system:approval-timeout` never yields those ids as assignees | a human-decided prior node yields that human — the drop is actor-selected |
| G-12 | K3 no-dedup | the same person approves at the prior node and again at the referencing node | within ONE node the same identity still collapses to one seat — intra-node dedup survives |
| G-13 | K4 chain distinctness | in an org where `leader_in_dept` and `dept_manager_userid_list` disagree, `continuous_managers` and `continuous_dept_heads` resolve DIFFERENT people | a fixture where they agree resolves the same people — the test discriminates the pointer, not the label |
| G-14 | K6 unknown mode | an unrecognized `approvalMode` reaching the executor fails explicitly instead of running as `single` | each known mode (`single`/`all`/`any`/`threshold`/`sequential`) still executes — the failure is unknown-selected |
| G-15 | K6 ordering | a sequential node activates seats strictly in the locked order, one active head at a time; a re-entry restarts at position 1 under a fresh epoch | an `all`-mode node with identical assignees activates ALL seats at once — ordering is mode-selected |
| G-16 | FE unknown-value safety | a persisted kind outside the FE registry renders read-only and round-trips unchanged; no `JSON.stringify` fallback reaches any surface | a known kind renders editable with its typed summary |
| G-17 | Fingerprint lockstep | backend and FE fingerprints agree for every kind; identical-source parallel branches are publish-blocked | K2's `null` case is NOT publish-blocked and instead hits the runtime 409 — both arms asserted |
| G-18 | Values-free errors | every new error path's message and details carry no person id, group membership, or form value | assert the SAME path carries the node key / source index — the check is not passing on an empty payload |
| G-19 | Directory-change safety | mutating directory relations between node 1 and node 2 does not change an in-flight assignee for any snapshot-backed kind | the same mutation DOES change a NEWLY created approval — the freeze is temporal, not a dead read |
| G-20 | Org-read fail-closed | with the org read failed and a K4/K5-b source present, create fails 422/503 with zero rows | a graph with NO org-derived source still creates — the detector is source-selected |

## 4. Owner ratification block

Intentionally blank until an explicit owner decision names this document and its SHA.

```text
Decision: <RATIFY | REQUEST CHANGES | REJECT>
Owner:
Date:
Document SHA:
Decisions required ([R] = this document's recommendation; rejected options are listed so they are
not re-proposed):

  OD-L1-1  K1 binding — (a)[R] EAGER_EXPANSION: freeze members at create, no migration, no reader
           changes, membership changes do NOT reach in-flight · (b) LATE_BINDING: assignment_type=
           'group' matched at action time, needs a CHECK migration + a branch at 55 assignment_type
           sites across 12 files, changes DO reach in-flight
  OD-L1-2  K1 org boundary — (a)[R] curated per-org binding table, empty by default, re-validated at
           publish · (b) add org_id to platform_member_groups · (c) derive org from the `description`
           projection marker [rejected §K1] · (d) single-org gate
  OD-L1-3  K3 round scoping of a re-entered prior node — (a)[R] LATEST round only, epoch-scoped ·
           (b) UNION of all rounds
  OD-L1-4  K3 when every prior decider is a system sentinel or the node was skipped — (a)[R] fall
           through to emptyAssigneePolicy · (b) fail the dispatch explicitly
  OD-L1-5  K4 endpoint staging — (a)[R] level count with K4, group endpoint deferred to a
           K1-dependent follow-up · (b) both in one slice (cannot start before OD-L1-1 is decided)
  OD-L1-6  K5-c downward (最高-n) — (a)[R] add a chain-termination/completeness snapshot field and
           fail closed on an incomplete chain · (b) defer downward addressing to a later lock ·
           (c) ship against the raw array [rejected §K5]

Deltas:
Runtime authorization: NONE unless explicitly stated — ratifying this document authorizes design only.
  No flag, no UAT, no deployment, no runtime capability.
```
