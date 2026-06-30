# Permission-revert concurrency hardening — row-lock the live-grant load (dev + verification)

**Date:** 2026-06-29  **Grounding:** `origin/main @ 57fd06962`  **PR:** #3400
**Branch:** `claude/permrevert-concurrency-rowlock-20260629`
**Status of the flag:** `MULTITABLE_ENABLE_PERMISSION_REVERT` stays **default-off**. This change enables nothing; it is the engineering prerequisite that makes a future, separately-signed-off enablement safe.

> Positioning: this is a focused engineering hardening of one already-shipped, flag-gated path. It does **not** advance the gated Global History remainder (PIT/T9-W flag enablement, Reset-UI product entry, value-level undelete) — those remain owner-gated per-item decisions, re-listed in §7 for sign-off.

---

## 1. Context — what permission-revert is, and the gap

The Global History line includes a **config-history → config-restore** capability. One restorable kind is a `permission` revision: reverting it re-applies the revision's `before` grant, but **only when restoring `before` reduces** the subject's access on the entity's single total-order access rank (field `hidden < read-only < read-write`; view `none < read < write < admin`; sheet `none < read < write-own < write < admin`). Escalation / no-op is refused fail-closed (422). The path sits behind the default-off flag `MULTITABLE_ENABLE_PERMISSION_REVERT`, on top of the `canManageSheetAccess` capability floor and a typed `revert-permission` confirm.

The load-bearing safety property is **never-escalate**: the execute path re-checks `permissionRevertDirection(before, LIVE)` against the **current live grant** (not the recorded `after`), inside its transaction. A server-minted preview token binds the live grant via an HMAC `currentGrantHash`, so a grant changed between preview and execute → 409 `GRANT_DRIFT`.

**The gap (concurrency):** the execute path serialized via `SELECT 1 FROM meta_sheets WHERE id = $1 FOR UPDATE` as a coarse mutex, then read the live grant with a **plain `SELECT`**. The forward grant/revoke routes do **not** take that `meta_sheets` lock — they write the permission row directly. So a forward write that **lowered** the grant could commit *between* the revert's direction check and its apply, turning a checked de-escalation into a **net escalation**:

```
preview:  live = admin            (revert target `before` = read; admin→read is a de-escalation)
forward:  admin → none           (a concurrent authorized revoke commits)
revert:   applies "admin→read"   → but live is now none, so the net is none→read = ESCALATION
```

The original code documented this honestly: the `meta_sheets FOR UPDATE` carried a comment that "the forward grant/revoke routes must take the same lock for full coverage — tracked in the dev-verification honest gaps." This PR closes it — but via a **better mechanism** than making the forward routes take that lock.

---

## 2. Decision — row-lock the execute-path live-grant load (not a value-CAS, not a forward-route change)

A primary-source fact determined the mechanism: `loadLivePermissionGrant` returns **`null` for a no-row entity**, and `permissionAccessRank(null) = 0`. Therefore **a de-escalation always reads a non-null live grant** (de-escalation requires live rank ≥ 1, and rank ≥ 1 ⇒ non-null ⇒ a row exists) — for all three scopes. The "field rank-2 read-write = no-row default" subtlety that would have forced `INSERT … ON CONFLICT … WHERE` CAS gymnastics **does not arise**.

Given that, **pessimistic row-locking is strictly simpler and equally correct**: the execute-path live-grant load takes `FOR UPDATE` on the actual permission row(s). Because the locked row always exists, and a concurrent forward write on the same subject **writes that same row** (and so contends on the lock), the revert's drift re-check → direction re-check → apply become **atomic** against forward writes — with **no forward-route change** and **no new error branch** (it reuses the existing `GRANT_DRIFT` verdict).

| Option considered | Verdict |
|---|---|
| (a) Forward routes take `meta_sheets FOR UPDATE` (the original comment's plan) | Correct but touches **live** security routes; needs deadlock analysis; broader blast radius. Rejected. |
| (b) Per-scope value-CAS in the revert (`… ON CONFLICT … WHERE`, rowCount==0 → drift) | Confined, but intricate (NULL normalization; delete-then-insert atomicity across 3 scopes). Rejected once (2) below held. |
| **(c) `FOR UPDATE` on the execute-path live-grant load** | **Chosen.** Confined to the gated path; reuses the existing drift check verbatim; no forward-route change; no per-scope CAS fiddliness. |

### Change (the whole runtime diff)

`loadLivePermissionGrant` gains `forUpdate = false`; when true it appends ` FOR UPDATE` to the field, view, **and** sheet SELECTs. The execute path (the single `pool.transaction` caller) passes `forUpdate = true`; the **preview** path (a read-only GET on the pool, no txn) keeps the default `false`. The pre-existing `meta_sheets FOR UPDATE` is **kept** (see §5). Lock order is always `meta_sheets → permission-row`.

---

## 3. Correctness argument

- **Atomicity of the never-escalate check.** With `FOR UPDATE` held from the live-grant load through commit, no forward write can move the locked row in between. So `hashPermissionGrant(live)` (drift check) and `permissionRevertDirection(before, live)` (direction check) both see the same row state the apply writes against.
- **The two orderings.** (A) Revert acquires the row lock first → a concurrent lowering forward write **blocks** until the revert commits; the revert de-escalates against the value it checked; the forward then applies (authorized last-write-wins). No revert-blessed escalation. (B) Forward write holds the row first → the revert's `FOR UPDATE` **blocks**, then (READ COMMITTED) re-reads the **committed** lowered value; the drift check `hash(new) ≠ hash(preview)` → **409**, no apply. No escalation.
- **ABA is benign.** If a forward write moves the grant and then back to exactly the preview value before the execute-load, the drift check passes and the row is locked at that value; the apply de-escalates from the *current* value atomically — still correct.
- **Isolation dependency, verified.** The re-read semantics require **READ COMMITTED**. The connection pool issues a plain `BEGIN` with no `ISOLATION LEVEL`, and there is **no `default_transaction_isolation` override** anywhere in the package → READ COMMITTED (Postgres default) confirmed. (Under REPEATABLE READ/SERIALIZABLE a concurrent-modify would surface as a 40001 to map; that case does not apply here.)

---

## 4. Verification

### 4.1 Real-DB goldens (15/15 pass)

File `tests/integration/multitable-permission-revert-realdb.test.ts` — **already in the `plugin-tests.yml` real-DB allowlist** (so the new cases ride along in CI). Existing (a)–(l) plus **two new concurrency goldens**:

- **(m) CONCURRENCY sheet** — a forward **REVOKE** (`admin→none`) committed **while** the revert executes ⇒ revert re-reads `none` and **409 `GRANT_DRIFT`**; grant stays revoked (never raised to read).
- **(n) CONCURRENCY field** — a forward **HIDE** (`read-write→hidden`) committed **while** the revert executes ⇒ revert re-reads rank-0 and **409 `GRANT_DRIFT`**; field stays hidden (never restored to read-only).

Both stage the interleave **deterministically**, not via timing: a separate uncommitted txn holds the forward write's **row lock**; the revert execute is fired and (post-fix) blocks on that lock at its `FOR UPDATE` load; the holder then commits the lowered grant, the execute unblocks, re-reads, and 409s. The serial drift case (h) does **not** exercise the lock — it never overlaps two transactions. Pre-fix (plain SELECT) the load would read the stale pre-commit grant, pass drift, and raise the subject above the committed-forward grant; the assertions (`409` + grant unchanged at the lowered value) fail pre-fix and pass post-fix.

Local run against a fresh real Postgres (`metasheet_pr_test`, migrated to latest): **`Tests 15 passed (15)`**.

### 4.2 Type-check

`tsc --noEmit` on `@metasheet/core-backend`: clean.

### 4.3 Forward-path serialization audit (independent)

An independent sweep of every write path to `field_permissions`, `meta_view_permissions`, `spreadsheet_permissions`:

1. **Every forward path that lowers/removes a grant** (the sheet/view/field `PUT …/permissions/…` routes, and the legacy `spreadsheet-permissions` revoke route) does so via `DELETE`/upsert on the **exact lock key** → all **contend** on the revert's `FOR UPDATE`. There is **no** `UPDATE`-by-non-key, no `TRUNCATE`, and no dynamic `DELETE FROM ${table}` resolving to a permission table.
2. **One non-contending path:** the legacy `POST /api/spreadsheets/:id/permissions/grant` does `INSERT … ON CONFLICT DO NOTHING` of a single managed `perm_code` **without** deleting existing managed rows, so a brand-new managed row isn't covered by the row lock (sheet scope only — it inserts a *different* `perm_code`, a new row the revert's lock doesn't cover). **Benign for never-escalate** — and the precise claim matters: the **revert's own writes never raise the subject above the live grant it direction-checked** (it only `DELETE`s managed rows and inserts the lower target). It does **not** follow that the subject's final derived level always equals the target: if a concurrent §2 grant of a higher `perm_code` commits *after* the revert's apply-`DELETE`, that new row survives and the final derived level can be higher. But that higher level is set by an **independent authorized grant**, not by the revert — forward-vs-forward last-write-wins, which would occur with or without the revert and is explicitly out of scope. (Field/view grants are single-PK, so the row lock fully serializes — no new-row escape there; this is a sheet-scope-only nuance.) Optional future owner-gated hardening if grant/revert mutual exclusion is ever wanted.
3. **Deadlock check:** the revert is the **only** explicit `meta_sheets FOR UPDATE` holder, always taken **before** the permission-row lock. The sheet-delete cascade locks `meta_sheets` then cascades into `spreadsheet_permissions` (same `meta_sheets → permission` direction). The forward permission routes never lock `meta_sheets` at all. **No `permission-row → meta_sheets` order exists → deadlock-free.**

---

## 5. Why the `meta_sheets FOR UPDATE` is kept

It is not redundant. It (a) serializes **concurrent reverts** on the same sheet as a coarse mutex, and (b) is **load-bearing** for the sheet-delete FK cascade: `spreadsheet_permissions.sheet_id REFERENCES meta_sheets(id) ON DELETE CASCADE`, so a sheet delete bulk-removes permission rows by `sheet_id` (not the per-subject key) — the row lock alone would not serialize that, but the kept `meta_sheets FOR UPDATE` does (the delete needs the conflicting `meta_sheets` row lock). `field_permissions` / `meta_view_permissions` have no FKs, so only the exact-key forward routes touch them (covered by the row lock).

---

## 6. Not covered (honest gaps)

- The legacy `/permissions/grant` insert-only path (§4.3.2) — benign for never-escalate as analyzed; mutual exclusion with revert is an optional future owner-gated item, not required for safe enablement.
- Forward-vs-forward last-write-wins between two authorized permission writes — pre-existing, unchanged, out of scope.
- This PR does not add a UI surface or change any flag default.

---

## 7. Owner-gated remainder — unchanged, per-item sign-off (re-listed for clarity)

This PR settles the **one** autonomously-buildable engineering prerequisite. Everything below remains an explicit, separate owner decision (not a `/goal` sweep):

| Item | State after this PR | What enabling/building requires |
|---|---|---|
| **`MULTITABLE_ENABLE_PERMISSION_REVERT`** enablement | Engineering prerequisite (concurrency) **satisfied** by this PR + two-writer goldens (m)/(n) | Owner **GO** to enable in an environment (a prod-enablement decision; the runbook concurrency item is now backed by a passing golden, not a hand-waved gap). |
| `MULTITABLE_ENABLE_SHEET_CONFIG_REVERT` / `…_FIELD_RETYPE_REVERT` / `…_CONFIG_UNCREATE` / `…_CONFIG_UNDELETE` | Built, default-off | Owner per-tier enablement decision (operational, reversible). |
| `MULTITABLE_ENABLE_PIT_RESET` / `…_PIT_UNDELETE` | Built, default-off | Owner ops decision to enable. |
| Reset-to-T **product entry** (UI surface) | Minimal datetime-local product entry **shipped** (#3301); `ResetToPointPicker` wired into `MultitableWorkbench.vue` | Remaining owner decision is whether to **upgrade** to a history-anchored T-source picker + rollout (not a product-entry block). |
| Value-level field **undelete** of already-destroyed data | **Not possible** for data already destroyed | Only a forward-capture (going-forward) design is buildable, and that is a separate gated opt-in. |

Canonical source for the remainder remains current `main` + the existing Global History docs and the 2026-06-29 readiness refresh (`multitable-global-history-gated-remainder-readiness-refresh-20260629.md`).
