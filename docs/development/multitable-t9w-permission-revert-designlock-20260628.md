# T9-W permission-revert — DESIGN-LOCK (PROPOSED)

**Date:** 2026-06-28 · **Type:** T9-W unsafe-restore write-slice design-lock, narrowed v1. Docs-only; locks scope + per-decision bars **before any runtime code**. The **last and highest-blast-radius** link on the config-restore line — it touches the access-control surface itself.

## The gap
`classifyRevert` routes `entity_type='permission'` to `gated` → execute 422 today. A **permission config revision** records a grant change (`entity_id` namespaced `field:%` / `view:%` / `sheet:%`) with `before`/`after` over the grant keys: **field** `{fieldId, subjectType, subjectId, visible, readOnly}`, **view** `{viewId, subjectType, subjectId, permission}`, **sheet** `{subjectType, subjectId, accessLevel}`. Reverting one forward-only re-applies its `before` grant state.

## The hazard — why this is held, and why the umbrella demanded a "per-grant re-grant policy"
Reverting a permission revision can **re-grant access that was deliberately revoked** (revert a permission `delete`), or **raise an access level that was deliberately lowered** (revert an access-lowering `update`). That is **privilege escalation via the history API** — the single most dangerous operation in the whole T9-W line. A blanket "revert permission changes" is unacceptable: it would let anyone with the restore capability silently re-open access an admin closed.

## v1 surface — LOCKED NARROW: **DE-ESCALATION-ONLY**
- **IN:** a permission revert whose net effect is to **REMOVE or LOWER** access on **every** axis — i.e. restoring `before` grants **≤** the current (`after`) access on all of `visible`/`readOnly`/`permission`/`accessLevel`. Concretely the safe cases are: revert a permission **`create`** (→ the grant is removed = revoke) and revert an access-**raising** `update` (→ restore the lower level). These can only *reduce* a subject's access, so they can never escalate.
- **OUT — DEFERRED pending an explicit per-grant re-grant policy + escalation-confirmation design (NOT opened here):** any revert that would **add a grant or raise access on any axis** (revert a permission `delete` = re-grant; revert an access-**lowering** `update` = re-raise). The **re-grant direction is the deferred dangerous half.** Also OUT: bulk/subject-wide permission revert · cross-base · FE.

## Locked decisions
- **PR-L1 — De-escalation-only, enforced by a pure direction classifier.** A pure `permissionRevertDirection(rev)` computes whether restoring `before` grants **strictly ≤** the current `after` access on every axis. Only `'de-escalation'` is opened; `'escalation'` (more access on any axis) and `'mixed'` (more on one axis, less on another) stay **gated → 422**. This is the load-bearing safety property: **the route can never increase anyone's access.**
- **PR-L2 — The access partial-order (per type).** field: `visible false < true`, `readOnly true < false` (readOnly=true is *less* access); view: `permission` level order (`none < read < … < manage`); sheet: `accessLevel` order (`none < read < write < admin`). De-escalation = `before ≤ after` on ALL axes; ANY axis where `before > after` (grants more) ⇒ refused. The exact level orderings are pinned by a tripwire test (mirrors the Tier-1/2 key-set tripwires) so the ladder can't silently change.
- **PR-L3 — Live re-check, not just the recorded `after`.** The recorded `after` may be stale (the grant changed again since). Execute re-reads the **current live grant** and re-runs `permissionRevertDirection` against it inside the txn; if the live grant is now ≥ what `before` would set (no de-escalation left) or the direction flipped → refuse (409). So the safety holds against the *current* state, never a stale snapshot.
- **PR-L4 — Identity + drift.** A disjoint `type:'config-permission-revert-preview'` identity binding `{sheetId, revisionId, entityId, currentGrantHash, actorId}`; execute re-hashes the live grant → drift since preview → 409 (mirrors the Tier-1 baselineHash, but over the live permission row).
- **PR-L5 — Flag + an ABOVE-baseline floor + typed confirm + single-txn.** Default-off **`MULTITABLE_ENABLE_PERMISSION_REVERT`**. Floor = the existing permission-management cap **`canManageSheetAccess`** (the forward grant/revoke floor) — **and**, because this is access-control history, the lock REQUIRES owner sign-off on whether even de-escalation needs a *higher* admin floor than canManageSheetAccess (a decision below). Typed `confirm:'revert-permission'`; one `pool.transaction`.
- **PR-L6 — No-oracle.** Preview names the subject + the de-escalation it will apply, but MUST NOT reveal grants the actor can't already see via permission management; no counts of affected subjects.
- **PR-L7 — Append-only audit.** Record the revert as a permission `update`/`delete` revision with `source='restore'`, `restoredFromId`. The revert is itself in history (and itself de-escalation-only-revertible).

## Test matrix (gated on ratification)
flag-off → 403 · cap (non-`canManageSheetAccess`) → 403 · **revert a permission `create` → revoke** (de-escalation, applied) · **revert an access-raising `update` → restored lower level** (de-escalation, applied) · **revert a permission `delete` → 422** (would re-grant = escalation, REFUSED) · **revert an access-lowering `update` → 422** (would re-raise = escalation, REFUSED) · **mixed-axis revert → 422** (more on one axis) · **live re-check** (grant changed since the revision so the revert would no longer de-escalate → 409) · drift (grant changed since preview → 409) · typed-confirm · single-txn atomicity · audit `source='restore'` · **no-oracle** (no hidden-grant / subject-count leak).

## Decisions — for owner ratification (this is the highest-stakes slice — none assumed)
1. **Scope = de-escalation-only** (RECOMMENDED: the route can never escalate) vs keep **held entirely** vs open the re-grant direction behind a separate escalation-confirmation policy (NOT recommended for v1).
2. **Floor** = `canManageSheetAccess` (the forward-op parity floor) vs a **higher admin/owner floor** specifically for access-control history. I lean parity (`canManageSheetAccess`) since de-escalation can only *reduce* access, but defer to you.
3. **Flag name** `MULTITABLE_ENABLE_PERMISSION_REVERT`.

## Out of scope
The **re-grant / escalation direction** (deferred pending a per-grant re-grant policy) · bulk/subject-wide permission revert · cross-base · FE.

## Runtime gate (implementation may NOT start until all hold)
1. **Lock ratified** — with an explicit owner decision on scope (de-escalation-only vs held) and the floor (PR-L5), given this is the access-control surface.
2. **Tier 4 (#3338) ratified + its runtime landed** — keep the line in order; permission-revert is last.
3. **No live parallel T9-W runtime session.**
