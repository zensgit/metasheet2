# 多维表 native person — `restrictToMemberGroupIds` enforcement (DESIGN-LOCK) — 2026-06-17

> Status: **DESIGN-LOCK** — Tier-1 P1 of `multitable-current-development-plan-20260617.md`.
> Decision authority: owner `/goal` 2026-06-17 ("complete all development per plan/TODO") = the explicit product decision to enforce the stored group restriction.

## 0. Problem

The native person field sanitizes + **stores** `property.restrictToMemberGroupIds` (field-codecs.ts:299) but does **not** enforce it: write-time `validatePersonValue` (field-codecs.ts:1015) only rejects userIds outside the **sheet member set** (`allowedUserIds`), with an inline note (field-codecs.ts:293–295) that the group narrowing is "stored ONLY and NOT YET ENFORCED". So a sheet member who is **not** in any configured group can still be assigned.

## 1. Semantics (locked)

`restrictToMemberGroupIds` **narrows** the assignable set; it never widens beyond sheet membership.

- **Empty / absent** → assignable = sheet member set (unchanged behavior).
- **Set to groups G** → assignable = `sheetMembers ∩ (⋃ members(g) for g ∈ G)`. A person must be **both** a sheet member **and** in at least one configured group.
- **Groups empty / nonexistent / no members** → the union is empty → assignable is empty → **all** person assignments rejected (a closed set, consistent with the existing "null member-set = closed set" rule in `validatePersonValue`).
- Narrowing is **per-field** (different person fields on a sheet may carry different `restrictToMemberGroupIds`), computed from the one per-patch sheet member set.

Rationale: intersection (not replacement) keeps the existing sheet-membership security floor intact — enforcement can only *tighten*, never grant a non-sheet-member. This is a safe, monotonic narrowing.

## 2. Implementation (locked)

- `validatePersonValue` is **unchanged** — it already rejects anything outside the `allowedUserIds` it is given. Enforcement happens by passing it the **narrowed** set.
- New helper on the write path: `loadMemberGroupUserIds(query, groupIds): Promise<Set<string>>` — resolves the union of `platform_member_group_members.user_id` for the given group ids (mirrors the existing automation-executor resolution; empty/҂unknown groups → empty set). Cached per patch op (resolve each distinct group id at most once).
- Per person-field, before `validatePersonValue`: if `field.property.restrictToMemberGroupIds` is non-empty, compute `allowed = intersect(sheetMembers, loadMemberGroupUserIds(restrict))`; else `allowed = sheetMembers`.
- Wire at all three write seams that currently call `validatePersonValue`: `record-write-service.ts` (PATCH), `record-service.ts` (create + a second create/import path), and the `univer-meta` form-submit path if it validates person values.
- **FE** `MetaPersonPicker.vue`: when the field has `restrictToMemberGroupIds`, filter the offered member list to the same intersection (display parity with the server gate). Server remains authoritative (FE filter is convenience, not the gate).

## 3. Tests (locked)

Real-DB (CI `test (20.x)`):
- A sheet member **in** a configured group → assignment **accepted**.
- A sheet member **not** in any configured group → assignment **rejected** (write-time 400), even though sheet membership holds (proves the new narrowing, not just the old floor).
- Empty `restrictToMemberGroupIds` → full sheet set assignable (no regression).
- Configured group with no members → closed set (all rejected).
Unit: the narrowing helper (intersection math, empty-group → empty, dedup).

## 4. Non-goals

- No change to the stored person value shape (`userId[]`).
- No member-group **grant expansion** into the assignable set beyond explicit `restrictToMemberGroupIds` (that is a separate deferred item).
- No change to read/egress masking (covered by the #2734 lock).
