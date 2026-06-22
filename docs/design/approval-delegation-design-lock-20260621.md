# Design-lock (PROPOSED): Approval delegation (委托) — time-boxed assignee substitution

**Status:** **PROPOSED.** The next assignee-resolution rung after Reading B / B1
(`manager_at_level`, #2999). Mirrors the assignee-source design-locks (`direct_manager`
#2852 / `dept_head` #2873 / `continuous_managers` #2907 / `manager_at_level` #2980) in being
a **resolver-layer, read-only, convergence-safe** addition. **Build only on owner ratify**,
the same #2980→#2999 arc B1 followed.

## 1. The decision — what delegation is, and why it stays small

A user (the **delegator**) configures a time-boxed delegation: while it is active, their
approval tasks route to a **delegatee**. This is **not** a new node type or a graph change —
it is a **substitution applied as each resolved `user` assignee is pushed through
`pushResolved`** in the existing `ApprovalAssigneeResolver`: an assignee that has an active
delegation is replaced by the delegatee **before** dedup (see §2). Like the management chain, the
delegation is read at
assignee-resolution time and **frozen in the instance** at create — no live re-query
mid-instance, so an in-flight approval never re-routes under a later config edit.

It stays small because it adds **no graph runtime, no new node type, no automation coupling**.
It reuses the resolver's existing `pushResolved` dedup + self-exclusion machinery; it adds one
frozen delegation snapshot plus a substitution applied **inside `pushResolved`, before the dedup
key is built** (see §2 — substituting after the resolve loop would bypass the `seen` set).

## 2. Contract

- **Config store** — a new `approval_delegations` row: `delegator_user_id`,
  `delegatee_user_id`, `start_at`, `end_at`, `scope` (`all` | `template:{id}`), `active`. A
  unique constraint rejects overlapping active windows per `(delegator, scope)`.
- **Bake (frozen-at-start) — DECIDED:** at `createApproval`, capture the set of **active
  delegations scoped to the template + time window** into the instance snapshot (same posture as
  `managerChainIds`), prepared **before `executor.resolveInitialState()`**. **Not**
  capture-for-resolved-assignees-of-the-initial-node — later nodes, and `return` / admin-jump
  re-resolution, can resolve to different assignees, so an initial-node-only capture would break
  the "frozen at instance create" semantics. The resolver reads only this frozen set.
- **Resolver substitution — INSIDE `pushResolved`, before the dedup key:** substituting *after*
  the `sources.forEach` resolve loop would build the `seen` key on the **original** id, so
  replacing A→B when B is already resolved would **bypass dedup → duplicate assignment + wrong
  metadata**. Instead the substitution runs inside `pushResolved`, only for
  `assignmentType === 'user'`, and **before** `key = user:${assigneeId}` is computed:
  (1) original assignee = delegator; (2) look up the frozen delegation map; (3) replace with the
  delegatee; (4) record `delegatedFrom` metadata; (5) run `seen` dedup on the **substituted** id.
  A delegatee already in the set collapses to one; a delegatee equal to the delegator
  self-collapses.
- **One hop only (v1)** — A→B, B→C resolves A→B (deterministic, cycle-free). Multi-hop is
  reopen-only.
- **1→1 empty-safety** — substitution replaces, never empties: a node with one delegating
  assignee yields the one delegatee, so `emptyAssigneePolicy` behavior is unchanged.

## 3. Boundaries (convergence-safe — mirrors the assignee-source locks)

- **Resolver-layer + a small delegation-config CRUD.** Writes only the new
  `approval_delegations` config table; **touches no `approval_*` instance / `automation_*`
  table**. **W7 result write-back stays locked.** No automation/bridge coupling, no
  graph-runtime change.
- **Out of scope (reopen-only):** multi-hop chains; timeout-triggered auto-delegation (that is
  SLA — a separate lock); delegation of non-approval automation tasks; role delegatees
  (v1 is user→user).

## 4. Implementation slices (mirror the B1 PR checklist)

1. **Backend:** `approval_delegations` table + migration (a unique `zzzz…` timestamp **after** the
   latest existing tail); the active-delegations snapshot baked **before `resolveInitialState()`**;
   the substitution **inside `pushResolved` before the dedup key** (user-only, `delegatedFrom`
   metadata); one-hop determinism.
2. **Frontend:** a "委托设置" CRUD (delegator picks delegatee + window + scope) with the same
   fail-closed authoring discipline as the template editor; read-only display of active
   delegations.
3. **Tests:** resolver substitution (active window) / no-substitution (outside window, wrong
   scope) / self-collapse / one-hop only / 1→1 empty-safety; **the keystone dedup case —
   delegator A→delegatee B where B is already another source's assignee resolves to exactly one
   B** (proves the substitution-before-dedup ordering, not a post-loop replace); CRUD validation
   (window ordering, self-delegation rejected, overlapping-active rejected); FE wire round-trip;
   **a service-level bake→substitute test** (mirroring the B1 end-to-end linkage test) so the
   create/start path is covered, not just a hand-fed resolver.

## 5. Acceptance

- An approver with an active delegation has their assignment routed to the delegatee for the
  window; outside it, no substitution.
- Self / already-assigned delegatee collapses (no double-assign). One hop only.
- Resolver-layer only: no writes beyond the config table; W7 stays locked; `git grep` shows no
  new `approval_*` instance / `automation_*` write.

## 6. Non-goals / reopen-only

- Multi-hop chains; SLA/timeout auto-delegation; automation-task delegation; role delegatees.
