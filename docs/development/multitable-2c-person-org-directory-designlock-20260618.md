# 多维表 2c · Person field → true org-member directory — DESIGN-LOCK (2c-S1) — 2026-06-18

> Status: **DESIGN-LOCK (design only — NO runtime).** Opens gate **2c** of `multitable-gated-remainder-development-plan-20260618.md`.
> Grounding: code-anchored on `origin/main@e2fa91bd5`. The runtime is BLOCKED on one owner product decision (§1); this doc presents the options + a recommendation so that decision can be made. Runtime slices (2c-S2+) are a SEPARATE opt-in after the source-of-truth is chosen.

## 0. Current state (what already exists)

- Native `person` field stores `userId[]` (coexistence with legacy link-backed person).
- **Assignment restriction is shipped + hardened**: the shared `person-field-restriction.ts` (#2833 validator + #2854 write-path parity / admin-bypass / person guard) enforces *assignable = sheet members ∩ active users in `restrictToMemberGroupIds`*, fail-closed, across all write paths.
- Directory **infrastructure already present**: `users` (with `is_active`), `platform_member_groups` + `platform_member_group_members`, and external linkage via `user_external_identities` / `directory_account_links` (e.g. DingTalk).
- So the person field is functional for assignment today; 2c is the **product depth** — making it a real, browsable org directory with a defined source of truth.

## 1. The gate — owner decision: directory SOURCE OF TRUTH

This is the one blocking decision; the rest of the arc derives from it.

| Option | Source | Pros | Cons |
|---|---|---|---|
| **A. Internal `users` only** | sheet-member `users` (current de-facto) | Zero new dependency; matches today's assignable set; smallest arc. | No real "org" structure (departments/titles); directory = flat user list. |
| **B. Member-group directory** *(recommended)* | `platform_member_groups` (already used for `restrictToMemberGroupIds`) | Reuses shipped infra; groups give org structure; restriction config already speaks this language; no external sync. | Requires member groups to be populated/maintained as the org model. |
| **C. External IdP sync** | `user_external_identities` / `directory_account_links` (DingTalk etc.) | True external org directory, auto-synced. | XL; external dependency + sync lifecycle (joiners/leavers); deactivation semantics; failure modes. |

**Recommendation: B** (member-group directory) — it reuses the infra the restriction feature already depends on, gives org structure without an external dependency, and is a medium (not XL) arc. C can be a later extension that feeds member groups. A is the fallback if no org structure is wanted.

## 2. Assignability semantics (decisions, given a source)

1. `restrictToMemberGroupIds` as a hard rule — **already done** (person-field-restriction.ts).
2. **Inactive/deleted users in existing records**: keep historical values **readable** (display the stored userId, possibly "(inactive)") but **not newly assignable** — never silently drop a stored assignee. (Lock this; it's the safe default.)
3. **Historical values outside the current restriction**: readable, not newly assignable (same principle).
4. Whether a user can be assigned to multiple person fields / multiple records — unchanged (current behavior).

## 3. Picker UX (decisions, given a source)

- Filter the offered set to the resolved directory (per the chosen source + the field's `restrictToMemberGroupIds`).
- Empty state (no eligible members), disabled rendering for inactive users, group labels (if source B/C), search.
- Server stays authoritative (the picker is convenience; the write validator is the gate — already shipped).

## 4. Recommended slices (separate opt-in, after §1 is decided)

| Slice | Scope | Verification |
|---|---|---|
| **2c-S1** | This design-lock (source-of-truth options + semantics). | Owner sign-off; no runtime. |
| **2c-S2** | Directory-source resolver for the chosen option (B: member-group directory read model), behind the existing restriction seam. | Unit + real-DB: resolver returns the right active member set; inactive/deleted excluded from assignable, retained for read. |
| **2c-S3** | Picker UX (filter/empty/disabled/group-labels/search). | FE tests + browser evidence. |
| **2c-S4** | Inactive/deleted + out-of-restriction historical-value display (read-not-assignable). | Real-DB: stored inactive assignee displays, is not re-assignable. |

## 5. Non-goals

- Do NOT change the stored person value shape (`userId[]`).
- Do NOT re-implement the restriction enforcement (shipped in person-field-restriction.ts).
- Option C (external IdP sync) is out of scope for the initial arc unless the owner picks it as the source.

## 6. Owner action

Pick the **source of truth** (A / B / C; B recommended) and the §2/§3 decisions. On that, 2c-S2+ becomes buildable (re-verifying current main first). Until then, 2c runtime stays gated.
