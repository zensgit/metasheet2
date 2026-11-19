# Delegated namespace admission transaction boundary

## Scope and inherited compatibility

This B2 prerequisite covers only existing `PATCH /api/admin/role-delegation/users/:userId/namespaces/:namespace/admission`. It enables no proof purpose, login, grant producer, birth, flag or deployment. W16 remains pending; the two create/birth paths, raw wrapper and W15 are not converted here. The bounded private v2/v3 design received independent design PASS; implementation and physical gates remain separate.

Extract unchanged `DelegationAuthorityRefusal`, `fetchUserRoleIds`, `deriveDelegableNamespaces`, `isUserWithinDelegatedScope` and `recheckDelegatedAuthority` into `admin/delegated-authority.ts`, importing them back into the route. Preserve all five SQL texts, arguments, return types, account authentication gate and three refusal messages. Keep one shared exported error constructor for instanceof. The role POST still uses the returned namespace array, not boolean true. `requireWritableTarget`, audience/preflight helpers and unrelated callers stay unchanged.

Preserve existing input normalization, boolean/controlled-namespace checks, preflight profile/audience/scope checks, response filtering and post-commit snapshot → cache invalidation → audit. Do not import the stricter target-ID policy approved for different APIs. Inactive and pending targets remain writable. Missing target gives NOT_FOUND and deleted/purged target USER_IN_RECYCLE_BIN before either actor arm. Actor=target is one subject, not two writes.

## Root and exact plan

`writeRoleDelegationNamespaceAdmissionCommand` accepts only the five scalar values actorId, userId, namespace, enabled and isPlatformAdmin. Clone them synchronously before the first await. No caller transaction, runner, hook, authorization callback or retained executor.

Platform discovery has no pre-root role read and empty roleIds. Delegated discovery reads raw role IDs, deriving only canonical admin-role IDs: each deriving ID must equal its trim, not be silently dropped or normalized into the plan. A noncanonical deriving ID is AUTHORIZATION_INPUT_PLAN_STALE. Freeze sorted deduplicated role parents and sorted actor/target subjects.

Use one default shared READ COMMITTED authorization-input root, intent SET_ADMISSION: R0 shared → sorted role-row SHARE → all R3 subject keys → all R5 subject rows. Qualify only SET_ADMISSION in ROLE_ROW_SHARE_INTENTS; empty-parent P1h/P1i plans remain valid. No R1, upgrade, nested root, takeover, tx.acquire, identityRead widening, late source-freeze/reparent advisory or separate subject-lock helper. Existing kernel missing role rows remain missing, not physically held and not a new orphan-membership refusal.

Require genuine open same-connection branded token, identical frozen plan/context/keys/witness lists and complete actor/target sets. Repeat structural and actual R3/R5/parent-state checks immediately before DML. A born subject is not held. Call existing writeUserNamespaceAdmission once on that token, source platform_admin or delegated_admin. Do not copy its DML or invoke its raw-transaction wrapper.

## Actor and role-child authority

Check target writability first. Platform authority uses the existing locked account gate and S0: raw users.role admin remains sufficient without child query; otherwise hold exact live user_roles(actor,admin) FOR SHARE through root completion. Do not call or globally change the old unlocked platform helper, require live RBAC for raw admins, or add an is_admin/token/wildcard shortcut.

Delegated authority pins the frozen deriving membership children FOR SHARE in sorted role order, then compares the full post-lock raw canonical deriving-ID set symmetrically. A locked authority refusal takes precedence over a stale plan and retains its existing 403 response. If authority remains valid, additions, removals and substitutions are stale, including a removed role whose namespace is not requested. Reordering is equal; unrelated non-deriving membership changes are not stale. The SHARE result alone cannot detect additions. Preserve the unchanged delegated helper's own authentication and namespace/audience/scope checks. Its successful return is a namespace array; call it once. Known raw role grant/revoke routes already share this actor's R3/R5, so their later helper reads are covered narrowly, not a claim of every writer's conversion.

Child and scope-row acquisitions use the existing 5000/10000 timeout window, saving/restoring settings on healthy completion. Do not send restore statements into an aborted transaction or increase budgets. Parent SHARE is not a positive child-membership pin.

## Exact delegated scope witness

After the delegated helper succeeds, enumerate with its matching requested namespace subset. Freeze `Readonly<{ departmentIds: readonly string[]; memberships: readonly Readonly<{ groupId: string; targetUserId: string }>[] }>` before the first SHARE acquisition, not before enumeration. IDs use code-unit sorting and deduplication; membership target is the fixed target user.

Retain the existing department predicate's active seeds, bool_or(COALESCE(include_children,TRUE)) and finite recursive UNION state `(id,integration_id,external_department_id,include_children)`. Only true parents emit active same-integration children by external-parent identity; descendants carry true. False seeds authorize themselves only. Null coalesces to true. The seed is the path root; unrelated ancestors above an independently assigned seed are not dependencies. Historical cycles terminate by tuple deduplication, while retaining all valid edge provenance, not a first-discovered-path tree.

A matching leaf has the existing linked target, active account and account-department edge. Do not invent account/department integration equality. Department IDs are the union of every node on every successful finite seed-to-matching-leaf path, including each seed and intermediate; exclude allowed nodes on no successful path. Never substitute leaves alone or the entire reachable tree. Reconstruct the finite edge relation after tuple deduplication so alternate successful paths remain represented.

Group witnesses are exact existing `(group_id,targetUserId)` children for this actor's matching namespace assignments. Group-only success has no department locks. Department-only has no group child locks. Mixed/multiple successful paths use the exact union. Add no integration-enabled or group-catalogue eligibility condition or unrelated catalogue-parent SHARE.

SHARE each frozen department ID, one statement at a time in sorted order, then SHARE each membership in group-ID order. Every requested row must actually return. Re-enumerate identically and compare both sets symmetrically, then require the original scope predicate boolean true. Missing, unheld, changed or newly appearing keys refuse ROLE_DELEGATION_USER_OUT_OF_SCOPE before DML; never adopt newly discovered keys. Hold every positive witness through root completion.

## Actual competitors and bounded deadlocks

Existing delegated assignment writers share the actor's R3/R5; membership POST shares the target's. Sync account/link/edge inventory, local account archive, purge and handover have their actual linked-user or account protections. A competitor-only similarly named account lock is not reader protection. Local department archive/reparent lacks the target key; sync projection can DELETE a member absent from its user inventory. Foreign account-department edges are legal. Full path and membership-child shares cover these exceptions.

This command's sorted acquisitions are not sync's configured projection/departments.values order. With actor/target absent from sync inventory, opposite two-group or two-department orders may deadlock. When sync inventories the relevant actor/target its earlier user locks close that particular interleaving. Group-only witnesses must not create gratuitous department conflicts. Do not rewrite sync, add a global mutex or retry until a preferred victim is selected.

Callback-time actual 40P01 retains kernel busy classification. P1k victim rolls back and returns existing 409 AUTHORIZATION_INPUT_BUSY with retryable true, no admission/cache/success audit/replay. Sync victim rolls back; surviving P1k must finish its unchanged locked-set re-enumeration and original predicate check before DML. Record whichever physical victim PG chooses. Injected SQLSTATE branch coverage is not a physical cycle observation.

## Errors and commit boundaries

Only actual AuthorizationInputBusyError maps to existing 409 `{ ok:false, error:{ code:'AUTHORIZATION_INPUT_BUSY', message:'Authorization inputs are busy; retry this change.', details:{ retryable:true } } }`. Eligible acquisition/awaited-work SQLSTATEs retain kernel behavior. PLAN_STALE, recovery-marker40001 and XX000 retain this caller's 500 ROLE_DELEGATION_ADMISSION_FAILED envelope. No global mapper edit or automatic replay. Uncertain COMMIT and post-commit readback/cache/audit failures are not busy or proof of rollback.

## Required gates

1. Existing HTTP/preflight/normalization, returned filtering and post-commit ordering; raw-admin no-child, RBAC-only, delegated, actor=target, inactive/pending targets, target-before-actor/recycle precedence, genuine token/frozen plan/actual-witness negatives.
2. Raw deriving IDs: losing authority under the lock returns the existing 403. While authority remains valid, addition/removal/substitution/noncanonical IDs are stale, reordered IDs pass and unrelated non-deriving drift does not stale. Five helper SQL/return/message identities and shared error constructor remain unchanged after extraction. Exact command caller, importer, data-key and root-shape guards; W16 still pending.
3. Actual child revoker-first and admission-first schedules through COMMIT for RBAC platform and delegated deriving membership; parent-row waiter controls remain. Removing only the positive child SHARE must produce the matching physical assertion red, then exact restore and green.
4. Separate seed/intermediate/leaf archive, intermediate reparent/clear-to-root, false/null/true descendants, independent direct seed below archived ancestor, alternate positive path, unrelated allowed branch, group-only/mixed and missing/added-key controls. Admission-first pauses after final recheck but before DML/COMMIT and holds every successful intermediate, not just leaf. Writer-first refuses without admission.
5. Actual projection-child DELETE for excluded-inventory target in both orders; existing actor/target competitor controls. Multi-group/relevant department cycles record selected physical victim with the specified rollback/side effects; distinguish them from unit-injected busy branches. No artificial timeout increase or forced-victim retry.
6. Persisted admission rows and unchanged neighbors; busy/pre-commit/no replay, uncertain-COMMIT and post-commit distinctions. New whole PG suite zero skips; missing URL and unreachable required runs fail, never skip-green. Preserve adjacent tests and exact source-fault byte snapshots/restores.
7. Main alone wires each new whole PG suite once into the existing required Node owner lane, default unit exclusion and exact removal/duplicate/relocation guards, preserving all siblings. Local tests/registration do not establish remote CI/native/full-app/business acceptance.

## Ownership and delivery

Grok4.7 is the scoped product author. Codex owns guard/CI integration, serial heavy/PG execution, mutation restoration and final verification; independent code review is separate. Only the existing owned synthetic temporary PG may be used, with original binding verified before each run. No software installation, commit, push, deployment, staging, provider or real-account operation. No other writer promotion, default/purpose/production availability change or full B2 completion claim.
