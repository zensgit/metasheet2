# T9-W unsafe config-restore — design-lock (owner-approved; greenlight Tier 1+2) — 2026-06-26

> **Design-lock — owner-approved 2026-06-26.** The config-restore safe subset is shipped
> (`classifyRevert` → `safe` for view config-updates + field name/order updates; everything else
> `gated`/refused). This doc locks how the **gated/unsafe** reverts ship — tiered by risk, behind the
> default-off discipline. The owner greenlit **Tier 1 (sheet_config) + Tier 2 (lossy retype) ONLY**
> (see Decisions) — authorized to build contract/goldens-first behind per-tier flags; Tier 3/4 stay
> held/deferred. Anchored on current `main` (`config-restore.ts` `classifyRevert`,
> `SAFE_FIELD_KEYS = {name, order}`).

## The four gated reasons (what "unsafe" covers)
From `classifyRevert`: (1) **field lossy retype** — changed_keys beyond name/order (e.g. `type`,
`property`); (2) **sheet_config** revert (row-deny / conditional-rules); (3) **permission** revert
(field/sheet/view subtypes); (4) **create/delete** revert (action ≠ update — undelete an entity, or
un-create one). Each is gated today and refused fail-closed; none ships without this lock + a greenlight.

## Shared locks (apply to EVERY unsafe slice — reuse the proven patterns, don't reinvent)
- **U-L1 default-off PER-TIER flags (LOCKED)** — each tier behind its OWN default-off flag (e.g.
  `MULTITABLE_ENABLE_SHEET_CONFIG_REVERT`, `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT`) — NOT one shared
  `MULTITABLE_ENABLE_UNSAFE_CONFIG_RESTORE` (too coarse: the tiers have different blast radii + need
  independent rollout). Runtime-gated (preview AND execute 403 when off), like `MULTITABLE_ENABLE_PIT_RESET`.
- **U-L2 write-symmetric gate** — the read/restore gate = the capability that gates WRITING that config
  (R3 symmetry): field/field-perm → `canManageFields`; view/view-perm → `canManageViews`;
  sheet_config/sheet-perm → `canManageSheetAccess`. Fail-closed on unknown.
- **U-L3 bound dry-run preview → execute** — preview returns the EXACT change + mints a hashed identity
  binding it (the `restore-preview-identity` / reset pattern); execute re-derives + rejects on drift
  (409). A typed confirm for the destructive/lossy ones (`confirm:'<op>'`), so a stray call can't trigger.
- **U-L4 atomicity** — the config write + its forward `meta_config_revisions` row commit in ONE
  transaction; a mid-write failure rolls back fully (the BAR-1 / T8-2 atomicity model).
- **U-L5 append-only / forward** — a restore is a NEW recorded revision (never edits history).
- **U-L6 config-literal redaction (WIDENED)** — any preview payload redacts field-read-sensitive
  literals per requester: view `filterInfo` **AND** sheet_config `conditional_read_rules[].value`. Both
  are field-read-sensitive, and `canManageViews` / `canManageSheetAccess` do **NOT** imply field-read.
  Reuse/extend `redactViewConfigFilterLiterals` + `loadAllowedFieldIds`. EXECUTE applies the real
  server-side target (raw); only the PREVIEW read is redacted.
  > **Pre-existing leak (advisor, 2026-06-26):** the live `/config-history` read redacts only **view**
  > rows (`hasViewRow`/`isView`/`filterInfo`); sheet_config rows' `conditional_read_rules` literals have
  > **zero** redaction → a `canManageSheetAccess` actor who can't read a field sees its rule literal
  > today. This is the sheet_config twin of the R3.1 view fix, **unpatched on main**. T1 plan: land a
  > small standalone redaction hotfix to the read endpoint FIRST (R3.1 precedent — bugfix separate from
  > feature), then T1's revert-preview reuses the shared redactor, keeping read + preview consistent.
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
than silently drop.

> **U-L8 (Tier-2 hidden-data oracle — [P1], LOCKED).** The data-loss scan is itself a leak vector — a
> count of coerced/emptied cells over rows/fields the actor CANNOT read would expose hidden
> invalid-value counts (generic U-L7 is too broad to cover this). The loss stat MUST be computed in
> ONE of two locked ways: **(a) scope-to-readable** — count only over records/fields the actor can read
> (row-deny + field visibility + read-only field perms applied) and surface any out-of-scope rows/fields
> as an **undisclosed** bucket (no number); OR **(b) require a full-read capability** before preview AND
> execute. **Required golden:** a `canManageFields` actor with a field-denial AND a row-denial CANNOT
> infer the hidden invalid-value count from the preview (readable-scoped count + an undisclosed marker,
> never the true total).

Recommend: **second slice, only with the data-loss preview + U-L8.**

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

## Decisions (owner-locked 2026-06-26)
- **Greenlight: Tier 1 (sheet_config revert) + Tier 2 (lossy field retype) ONLY** — build these contract/goldens-first, each behind its own per-tier flag.
- **Hold: Tier 3 (un-create)** until a separate destructive-delete sign-off.
- **Defer: undelete** (its own resurrect+link-rebuild line).
- **Hold permission-revert ENTIRELY** until a per-grant re-grant policy exists (a capability alone is not sufficient).
- **Per-tier flags** (U-L1), not one shared flag.
- **Tier 2 [P1]:** U-L8 (hidden-data oracle) is a hard requirement — the data-loss preview is read-scoped (or full-read-gated), with the no-hidden-count-inference golden.

## TODO (gated)
- 🔒 **U-0** this design-lock — APPROVED 2026-06-26 with the Decisions above (greenlight T1+T2, per-tier flags, U-L8).
- ⬜ **U-1a (GREENLIT, PREREQ)** read-endpoint redaction hotfix — redact sheet_config `conditional_read_rules[].value` in the `/config-history` read per requester (R3.1 twin; fixes the pre-existing leak; a shared redactor T1 reuses) + golden: `canManageSheetAccess` + a field-deny → rule literal redacted, not revealed.
- ⬜ **U-1b (GREENLIT)** Tier 1 sheet_config revert — behind `MULTITABLE_ENABLE_SHEET_CONFIG_REVERT`; `classifyRevert` stays pure (flag/cap/apply handled at the route+apply layer, NOT threaded into classifyRevert); preview shows rule before→after **redacted per U-L6**; U-L1..L7; real-DB goldens (flag-off, gate, drift, atomicity, no-oracle, **+ preview literal-redaction**).
- ⬜ **U-2 (GREENLIT)** Tier 2 lossy retype — behind `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT`; data-loss preview **read-scoped per U-L8** + typed confirm; refuse on total/unknown loss; goldens incl. the **U-L8 no-hidden-count-inference** golden.
- 🔒 **U-3 (HOLD)** Tier 3 un-create — held until a separate destructive-delete sign-off.
- 🔒 **U-4 (DEFER/HOLD)** undelete deferred (its own line); permission-revert held entirely until a per-grant re-grant policy.

> Nothing here ships without (a) approving this lock and (b) a per-tier greenlight; the dangerous
> tiers (3/4) additionally need their own sign-off, mirroring the T8-2 destructive discipline.

## Amendment / closeout (2026-06-27)

Reconciled against as-built `main` — full record in
`multitable-t9w-unsafe-restore-line-closeout-dev-verification-20260627.md`. Summary:
- **U-2 "lossy retype" premise corrected → schema-only / lossless** (`isSupportedFieldRetypeRevert`;
  no cell-value coerce/drop). The original [P1] loss-magnitude-in-drift gate does NOT apply to the
  shipped schema-only path — it belongs to a FUTURE destructive value-transform retype (separate
  owner sign-off; preview identity binds a loss summary; preview↔execute loss mismatch → 409).
- **execute-response redaction** is a future contract lock, not a current leak (execute returns only
  `restored:{revisionId,entityType,entityId,changedKeys}`; read + preview already redact via
  `redactConditionalReadRuleLiterals`).
- **U-L8 default**: prefer the full-read gate; a scoped `undisclosed` marker must be constant.
- **Tier 1 audit** = the forward `meta_config_revisions` row (`source='restore'` + `restoredFromId`).
