# T9-W — Config / Schema-Change RESTORE (WRITE-SIDE) — DESIGN-LOCK

> Status: **DESIGN-LOCK, docs-only. Runtime GATED behind ratification of §6 (D1–D6) + an explicit owner opt-in per
> slice.** This is the **write half** of T9, deferred out of the read-side lock
> (`multitable-t9-config-history-readside-designlock-20260623.md`) exactly as the record line deferred the restore
> write (T6/BS) behind the read+preview (T5/T7). The read side (R1–R4: record + display config history) is shipped;
> this locks **mutating config back toward a prior recorded state**.
>
> Mirror of the record-restore discipline: **preview (read-only) → execute (forward-only write) → FE**, with the
> destructive subset hard-gated behind a separate sign-off (as T8 Reset is to T8 Revert).

## 1. Scope — what a config-restore does (and does NOT do)

A config-restore takes a recorded `meta_config_revisions` entry (or an entity's state as-of a prior revision) and
**re-applies that config forward** as a new change — never rewriting history. It operates on the same four entity
types the read side records: **field**, **view**, **permission**, **sheet_config**.

- **Revert a field property change** — restore a renamed/retyped/reconfigured field's prior config (name, options,
  formula expression, link/rollup config, read-only, hidden). **← v1 candidate (safe subset).**
- **Revert a view config change** — restore a view's prior filters / sorts / groups / hidden-fields / type. **← v1
  candidate (safe subset).**
- **Revert a permission change** — restore a prior `field_permissions` / sheet-access / view-permission / row-deny
  grant. **← R-W2 (after the field/view safe subset).**
- **Revert a sheet_config change** — restore a prior row-deny / conditional-rules / settings toggle. **← R-W2.**

**Explicitly OUT of scope (hard boundary):**
- **No mixed config+data restore (T9-W-L2).** A config-restore touches ONLY config. Restoring a *deleted field* does
  NOT resurrect its cell data; restoring a *retype* does NOT recover values the retype dropped. Data history is the
  record line's (T1–T8) job; the two never compose in one operation.
- **Data-loss config operations are a separate, hard-gated slice (T9-W-L6)** — field-delete *undelete*, retype that
  would reinterpret/lose values. Like T8 Reset, these need their own explicit owner sign-off after the safe subset is
  proven. v1 ships the *non-data-loss* reverts only.

## 2. Why this is dangerous (the threat model the locks address)

1. **Schema drift.** The live entity may have changed *since* the target revision. Blindly writing the old config
   overwrites intervening edits and can re-introduce a config that no longer matches the data (e.g. revert a field to
   `number` after rows were typed as text). → **T9-W-L5: schema-drift is a conflict, not a silent overwrite.**
2. **Restore is a NEW permission surface.** The read side gates *viewing* history per entity type; restore *writes*.
   The write must re-apply the same per-entity config-manage capability at execute time. → **T9-W-L3: read-gate ≡
   write-gate ≡ restore-gate.**
3. **Irreversibility illusion.** Undeleting a field looks like "undo" but the column data is gone — the restore can't
   honestly reverse it. → **T9-W-L2 + L6: no data resurrection; data-loss ops hard-gated.**
4. **History divergence.** If restore rewrote `meta_config_revisions` it would corrupt the audit trail. → **T9-W-L1:
   forward-only, append a new revision (`source=restore`), never rewrite.**

## 3. The LOCKS (T9-W-L1 … L7)

| Lock | Statement | Enforced by |
|---|---|---|
| **T9-W-L1** | **Forward-only, append-only.** Restore writes the new config + appends a `meta_config_revisions` row with `source=restore` (and a back-reference to the source revision/batch). It NEVER deletes/rewrites prior config-revisions. | Recorder writes a new row; no UPDATE/DELETE on `meta_config_revisions`. |
| **T9-W-L2** | **No mixed config+data restore.** A config-restore mutates only config tables (`meta_fields` / `meta_views` / `field_permissions` / `meta_sheets`). It never touches `meta_records` / `meta_record_revisions`. Restoring a deleted field does NOT restore cell data. | Grep-verifiable: the restore write path has no record-table writes. |
| **T9-W-L3** | **Read-gate ≡ write-gate ≡ restore-gate.** Restore re-checks, per entity type at execute time, the SAME capability the mutation route checks: field/field-perm → `canManageFields`; view/view-perm → `canManageViews`; sheet_config/sheet-perm → `canManageSheetAccess`. Not admin-bypassed silently. | Reuse the R3 gate mapping (shared helper). |
| **T9-W-L4** | **Preview-first + preview-identity.** Every execute is preceded by a read-only preview; a server-verifiable identity binds the executed change to the previewed diff (scope + before/after hash + actor). A stale/forged identity is rejected. | Mint at preview, verify at execute (reuse `restore-preview-identity.ts` pattern). |
| **T9-W-L5** | **Schema-drift is a conflict.** If the live entity's current config ≠ the target revision's `before` baseline (someone changed it since), restore does NOT blind-overwrite — preview flags it as a conflict and execute refuses until re-previewed. | Compare live config to the target revision's recorded baseline at preview + re-verify at execute. |
| **T9-W-L6** | **Data-loss ops hard-gated.** Field-delete undelete and lossy retype are a SEPARATE slice behind a SEPARATE explicit owner sign-off (post safe-subset). v1 restore refuses them with an explicit "not supported in this slice" error, never a partial attempt. | Allowlist of safe op kinds; everything else fail-closed. |
| **T9-W-L7** | **Atomic + idempotent.** The config write + the `source=restore` revision commit in ONE transaction. Re-submitting the same preview identity does not double-apply. | `pool.transaction` + idempotency key = preview identity. |

Cross-arc reuse (already-proven locks this inherits): LOCK-3 no-existence-oracle (restore-preview counts/visibility are
post-permission), field-audit LOCK-7 reveal-never-composes (a reveal grant never widens what restore writes),
deterministic order LOCK-11 (the "as-of revision" pick).

## 4. Restore semantics per entity type (v1 safe subset)

| Entity | Safe revert (v1) | Hard-gated (T9-W-L6, later) |
|---|---|---|
| **field** | name, options, formula expression, link/rollup config, read-only, hidden, **non-lossy** retype | **delete→undelete**, **lossy retype** |
| **view** | filters, sorts, groups, hidden fields, type, frozen columns, form-share config | view **delete→undelete** (recreate) |
| **permission** | `field_permissions` / sheet-access / view-permission grant, row-deny toggle | — (revert is inherently non-lossy) → **R-W2** |
| **sheet_config** | row-deny enabled, conditional-rules, settings | — → **R-W2** |

"Revert one change" (undo a single recorded revision) is v1's unit. "Restore an entity to its full config as-of T"
(compose multiple revisions) is a follow-up (D1).

## 6. Decisions to ratify (D1–D6)

- **D1 — scope unit.** Revert a single recorded revision (undo *this* change) vs restore an entity to its as-of-T
  config (compose revisions). **Recommend: single-revision revert first**; as-of-T entity restore is a follow-up
  (heavier; needs a config reconstructor analogous to the record reconstructor).
- **D2 — entity coverage v1.** **Recommend: field + view safe reverts first** (highest value, non-lossy, clearest
  semantics); permission + sheet_config reverts as R-W2; data-loss ops (undelete / lossy retype) hard-gated (L6).
- **D3 — schema-drift policy.** **Recommend: reject-and-re-preview** (safest; matches the record line's conflict
  policy) over apply-anyway-on-non-conflicting-keys.
- **D4 — restore capability.** **Recommend: the same per-entity config-manage capability** (read-gate ≡ write-gate ≡
  restore-gate, L3) — do not invent a new cap; restoring a field config needs `canManageFields`, same as editing it.
- **D5 — preview identity.** **Recommend: a signed short-lived payload** binding {entity, target revision, before/after
  hash, actor} — stateless, mirrors the record restore-preview-identity.
- **D6 — confirmation + audit.** **Recommend: explicit confirmation for any restore + an audit trail** (the
  `source=restore` revision already records actor/target/time; never logs record values).

## 7. Gated TODO (T9-W-0 … T9-W-3)

| Slice | What | Gate |
|---|---|---|
| **T9-W-0** | Ratify this lock (D1–D6) + opt-in. | Owner. |
| 🔒 **T9-W-1** | **Config-restore PREVIEW** (read-only): given an entity + target revision, compute the would-be config diff, the schema-drift conflict flag (L5), and the safe-vs-gated op classification (L6). Write-free (asserted). Real-DB goldens. | T9-W-0. |
| 🔒 **T9-W-2** | **Config-restore EXECUTE** (forward-only write): verify preview identity (L4) → re-gate per entity (L3) → schema-drift re-check (L5) → atomic forward write + `source=restore` revision (L1, L7). Refuses data-loss ops (L6). Real-DB goldens incl. **rollback/consistency** (a failed revision insert rolls back the config write) + **gate-deny** + **drift-reject** + **idempotency**, each mutation-proven. | T9-W-1. |
| 🔒 **T9-W-3** | **FE config-restore panel**: from the R4 config-history view, "revert this change" → preview → confirm → execute. Faithful client. | T9-W-2. |
| 🔒 **(separate)** | **Data-loss restore** (field undelete / lossy retype) — separate slice, separate sign-off. | Post-T9-W-2, owner re-ratify. |

**Out of scope for T9-W:** record-data restore (T1–T8) · destructive table PIT (T8) · any config+data joint restore.
