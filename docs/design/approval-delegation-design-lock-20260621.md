# Design-lock (PROPOSED): Approval delegation (委托) — time-boxed assignee substitution

**Status:** **PROPOSED.** The next assignee-resolution rung after Reading B / B1
(`manager_at_level`, #2999). Mirrors the assignee-source design-locks (`direct_manager`
#2852 / `dept_head` #2873 / `continuous_managers` #2907 / `manager_at_level` #2980) in being
a **resolver-layer, read-only, convergence-safe** addition. **Build only on owner ratify**,
the same #2980→#2999 arc B1 followed.

## 1. The decision — what delegation is, and why it stays small

A user (the **delegator**) configures a time-boxed delegation: while it is active, their
approval tasks route to a **delegatee**. This is **not** a new node type or a graph change —
it is a **post-resolution substitution** inside the existing `ApprovalAssigneeResolver`: after
a node resolves its assignee set, any resolved `user` assignee that has an active delegation is
replaced by the delegatee. Like the management chain, the delegation is read at
assignee-resolution time and **frozen in the instance** at create — no live re-query
mid-instance, so an in-flight approval never re-routes under a later config edit.

It stays small because it adds **no graph runtime, no new node type, no automation coupling**.
It reuses the resolver's existing `pushResolved` dedup + self-exclusion machinery; it adds one
frozen delegation snapshot plus a post-resolution substitution pass.

## 2. Contract

- **Config store** — a new `approval_delegations` row: `delegator_user_id`,
  `delegatee_user_id`, `start_at`, `end_at`, `scope` (`all` | `template:{id}`), `active`. A
  unique constraint rejects overlapping active windows per `(delegator, scope)`.
- **Bake (frozen-at-start)** — at `createApproval`, the active delegation set is captured into
  the instance snapshot (same posture as `managerChainIds`); the resolver reads only that
  frozen set. (Impl detail to settle: capture-all-active vs. capture-for-resolved-assignees —
  either preserves the frozen-at-start guarantee.)
- **Resolver substitution** — for each resolved `user` assignee with a baked active delegation
  (now within `[start_at, end_at]`, scope matches the template), **substitute** the delegatee.
  A delegatee equal to the delegator, or already in the set, collapses via the existing `seen`
  set (no double-assign). Metadata records `delegatedFrom` for the audit trail.
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

1. **Backend:** `approval_delegations` table + migration; the frozen delegation snapshot read;
   the resolver post-substitution pass (substitute, self-collapse, dedup, `delegatedFrom`
   metadata); one-hop determinism.
2. **Frontend:** a "委托设置" CRUD (delegator picks delegatee + window + scope) with the same
   fail-closed authoring discipline as the template editor; read-only display of active
   delegations.
3. **Tests:** resolver substitution (active window) / no-substitution (outside window, wrong
   scope) / self-collapse / one-hop only / 1→1 empty-safety; CRUD validation (window ordering,
   self-delegation rejected, overlapping-active rejected); FE wire round-trip; **a service-level
   bake→substitute test** (mirroring the B1 end-to-end linkage test) so the create/start path is
   covered, not just a hand-fed resolver.

## 5. Acceptance

- An approver with an active delegation has their assignment routed to the delegatee for the
  window; outside it, no substitution.
- Self / already-assigned delegatee collapses (no double-assign). One hop only.
- Resolver-layer only: no writes beyond the config table; W7 stays locked; `git grep` shows no
  new `approval_*` instance / `automation_*` write.

## 6. Non-goals / reopen-only

- Multi-hop chains; SLA/timeout auto-delegation; automation-task delegation; role delegatees.
