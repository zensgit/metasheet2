# T9-W unsafe config-restore — design-lock (PROPOSED) — 2026-06-26

> **Design-lock (PROPOSED).** The config-restore safe subset is shipped (`classifyRevert` →
> `safe` for view config-updates + field name/order updates; everything else `gated`/refused). This
> doc locks how the **gated/unsafe** reverts would ship — tiered by risk, behind the existing
> default-off discipline — **before any code**. It does NOT authorize building; it makes the
> per-slice safety bar and the greenlight decision concrete. Anchored on current `main`
> (`config-restore.ts` `classifyRevert`, `SAFE_FIELD_KEYS = {name, order}`).

## The four gated reasons (what "unsafe" covers)
From `classifyRevert`: (1) **field lossy retype** — changed_keys beyond name/order (e.g. `type`,
`property`); (2) **sheet_config** revert (row-deny / conditional-rules); (3) **permission** revert
(field/sheet/view subtypes); (4) **create/delete** revert (action ≠ update — undelete an entity, or
un-create one). Each is gated today and refused fail-closed; none ships without this lock + a greenlight.

## Shared locks (apply to EVERY unsafe slice — reuse the proven patterns, don't reinvent)
- **U-L1 default-off flag** — ship behind a flag (per-slice or a shared `MULTITABLE_ENABLE_UNSAFE_CONFIG_RESTORE`),
  off by default; runtime-gated (preview AND execute 403 when off), like `MULTITABLE_ENABLE_PIT_RESET`.
- **U-L2 write-symmetric gate** — the read/restore gate = the capability that gates WRITING that config
  (R3 symmetry): field/field-perm → `canManageFields`; view/view-perm → `canManageViews`;
  sheet_config/sheet-perm → `canManageSheetAccess`. Fail-closed on unknown.
- **U-L3 bound dry-run preview → execute** — preview returns the EXACT change + mints a hashed identity
  binding it (the `restore-preview-identity` / reset pattern); execute re-derives + rejects on drift
  (409). A typed confirm for the destructive/lossy ones (`confirm:'<op>'`), so a stray call can't trigger.
- **U-L4 atomicity** — the config write + its forward `meta_config_revisions` row commit in ONE
  transaction; a mid-write failure rolls back fully (the BAR-1 / T8-2 atomicity model).
- **U-L5 append-only / forward** — a restore is a NEW recorded revision (never edits history).
- **U-L6 view-literal redaction** — any view payload in a preview redacts `filterInfo` literals per
  requester (#2052/R9), as the read API does. EXECUTE applies the real server-side target.
- **U-L7 no oracle** — refuse/block responses leak no denied count/existence; preview surfaces only
  what the caller may see.

## Tiered slices (risk order — lowest first) + per-slice bar

### Tier 1 — sheet_config revert (row-deny / conditional-rules) — LOWEST marginal risk
Security-relevant (a row-deny flip re-exposes/re-hides rows), but gated by `canManageSheetAccess` —
the **same cap that can toggle it live anyway**, so low *marginal* risk. **Bar:** preview shows the
exact rule before→after; execute re-applies under U-L3; the row-deny/rule flip is surfaced explicitly
(not a silent toggle). Recommend: **first implementable slice.**

### Tier 2 — field lossy retype (type / property revert) — LOSSY, no privilege issue
Reverting a field's `type`/`property` can **coerce or drop cell values** that don't fit the reverted
type (the "lossy" gate reason). Gated by `canManageFields`. **Bar:** the preview MUST quantify the
data-loss impact (how many records' cell values would be coerced/emptied by the type round-trip) and
require a typed confirm; the revert is recorded forward; if loss is total/unknowable, refuse rather
than silently drop. Recommend: **second slice, only with the data-loss preview.**

### Tier 3 — un-create (revert a `create`) — destructive but bounded
Reverting a field/view *create* = **deleting** the created entity (+ its column data / view). This is
a destructive delete, analogous to T8-2's delete-set. **Bar:** the full T8-2 destructive bar — typed
confirm, all-or-nothing, atomic delete+record, soft-delete where possible (recoverable), no oracle.
Recommend: **after Tier 1/2, with the T8-2 delete discipline.**

### Tier 4 (DEFER) — undelete (revert a `delete`) — genuinely hard
Undeleting a deleted field means **its column data was dropped from every record** — an honest "undo"
is impossible without a separate resurrect + link-rebuild slice (links, formula deps, lookups). **Bar:**
do NOT fake it. Either ship the cross-cutting undelete slice first, or keep undelete refused
(`undeleteSupported:false`, as reset-preview already reports). Recommend: **defer — its own line.**

### Tier 4 (HOLD) — permission revert — PRIVILEGE-ESCALATION, highest blast radius
Reverting a permission revision **re-grants a deliberately-revoked permission** (or revokes a granted
one). Gated per-subtype (field→`canManageFields`, view→`canManageViews`, sheet→`canManageSheetAccess`).
**Bar:** the preview MUST render the exact privilege delta ("re-grants `<permission>` to `<subject>`"),
a re-grant requires an explicit confirm naming the subject+grant, and it is audited (who re-granted
what, when). Never a silent re-grant. Recommend: **highest-risk — its own slice, last, with extra
review; arguably needs the owner's explicit per-grant policy, not just a cap.**

## Phasing (recommended)
Tier 1 (sheet_config) → Tier 2 (lossy retype, with data-loss preview) → Tier 3 (un-create, T8-2
discipline) → **then** Tier 4 permission-revert and undelete as their own gated slices (deferred).
Each tier is a separate greenlight + (for the dangerous ones) a separate sign-off, not a blanket "build all."

## Out of scope (each a later opt-in)
Undelete-execute (Tier 4 defer); cross-base config restore; any FE; bulk/multi-entity unsafe restore.

## Open questions (decide before any code)
1. Which tiers to greenlight for a first build — recommend Tier 1 + Tier 2 only; hold Tier 3/4.
2. Permission-revert: in scope at all, or held entirely until a per-grant re-grant policy exists?
3. One shared flag, or per-tier flags (finer rollout control)?

## TODO (gated)
- 🔒 **U-0** this design-lock — review/approve the tiers, the per-slice bars, and the greenlight set.
- ⬜ **U-1** Tier 1 sheet_config revert (preview shows rule before→after; U-L1..L7; real-DB goldens incl. flag-off, gate, drift, atomicity, no-oracle).
- ⬜ **U-2** Tier 2 lossy retype (data-loss preview + typed confirm; refuse on total/unknown loss; goldens).
- ⬜ **U-3** Tier 3 un-create (T8-2 delete discipline) — separate greenlight.
- ⬜ **U-4** Tier 4 permission-revert + undelete — deferred, each its own design-lock + sign-off.

> Nothing here ships without (a) approving this lock and (b) a per-tier greenlight; the dangerous
> tiers (3/4) additionally need their own sign-off, mirroring the T8-2 destructive discipline.
