# T9-W low-risk flags (sheet-config-revert + field-retype-revert) — lossless envelope + flag-on smoke + runbook

**Date:** 2026-06-30  **Grounding:** `origin/main @ f14be042e`
**Flags:** `MULTITABLE_ENABLE_SHEET_CONFIG_REVERT`, `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT`
**Scope:** staging/sandbox enablement only; **prod flags NOT changed.** Phase 2 of the flag-enablement sequence (lower risk than uncreate / undelete / permission per owner's prioritization).

> Per the directive, this **verifies** the "option I = schema-only / lossless" interpretation for field-retype rather than asserting it, and establishes the exact safety envelope (what's supported, what stays gated, and why).

---

## 1. SHEET_CONFIG_REVERT — supported envelope

`classifyRevert` returns `gated` for **every** `sheet_config` revision; the route opens only the keys in `SUPPORTED_SHEET_CONFIG_REVERT_KEYS = {conditionalReadRules, rowLevelReadPermissionsEnabled}` (the conditional-read rules + the row-level-read-deny toggle), via `isSupportedSheetConfigRevert`. A sheet_config revert touching any other key stays gated (fail-closed).

**Lossless by nature:** these are **configuration settings**, not data. Reverting them restores a prior config value; no cell values, schema, or records are touched. There is nothing to lose — it is a setting flip, fully reversible.

## 2. FIELD_RETYPE_REVERT — the lossless claim, verified

**Claim ("option I"):** a field `type`/`property` revert is *schema-only / lossless*. **Verified, with a bounded envelope:**

- **Why it's lossless (symmetry argument, from primary source):** the forward `PATCH /fields` retype changes `type`/`property` with **NO cell-value migration** — stored values are kept raw and the read path tolerates type-mismatched values (`config-restore.ts` U-2 comment). A schema-only revert is therefore *symmetric with the forward op*: it does a raw `meta_fields` UPDATE of the type back, coercing/dropping **nothing**. Neither direction touches values, so the round-trip loses nothing.
- **Empirical proof (golden (c)):** revert toward a numeric type while a cell holds `'hello'` → after execute, `recValue() === 'hello'` — the non-fitting value is **KEPT, not coerced or dropped**. That is the lossless property demonstrated on real data.
- **The safety envelope (why `FIELD_RETYPE_EXCLUDED_TYPES` exists):** `applyConfigRevert` does a *raw* UPDATE, but the forward route also runs **type-transition side effects** (autoNumber sequence, formula dependency graph, link join-table) that a raw UPDATE skips. So both endpoints must be **plain scalars**; the excluded set — `formula, lookup, rollup, link, attachment, button, autoNumber, createdTime, modifiedTime, createdBy, modifiedBy` — is exactly the **side-effecting / computed / system** types, which stay **gated even flag-on**. v1 also requires an actual `type` change (property-only deferred).
- **Empirical gating proof (golden (d)):** a non-scalar endpoint (`link`) → preview not confirmable, execute **422** `RESTORE_NOT_SUPPORTED`, **no write** — even with the flag on. So "lossless" is *scoped*: in-envelope (scalar↔scalar) is lossless; out-of-envelope is refused, not silently mis-reverted.

So "option I = schema-only / lossless" holds **for the scalar↔scalar envelope**, and the envelope is enforced fail-closed. It is **not** a blanket "all retypes are lossless" claim — value-transforming/dropping retypes are explicitly a separate, destructive, not-this-slice decision.

## 3. Flag-on smoke — evidence

Run flag-on against a fresh real Postgres at current main: `multitable-sheet-config-revert-realdb`, `multitable-field-retype-revert-realdb`, `multitable-config-restore-realdb` → **26/26 passed**. (The "forced restore-revision insert failure" / "t9w injected" lines are *intentional* injected-failure atomicity goldens — they assert the execute rolls back cleanly on a mid-apply failure — and sit inside passing tests.)

Coverage includes, per flag: flag-off 403; happy in-envelope revert (200 + `source='restore'` forward revision); out-of-envelope gated (422, no write); drift (409); and apply-atomicity (injected failure → rollback, no partial write).

## 4. Operator runbook

Both flags are read **per-request directly from `process.env`** (field-retype: `univer-meta.ts:8097/8178`; sheet-config: `:8102/8183`) — no in-app config cache, same as permission-revert.

- **Enable:** set `MULTITABLE_ENABLE_SHEET_CONFIG_REVERT=true` and/or `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT=true` in the staging env + **restart/redeploy** (value captured at launch).
- **Smoke (post-enable, live):** revert a `conditionalReadRules` / `rowLevelReadPermissionsEnabled` change → 200; revert a scalar↔scalar field retype → 200 + values intact; attempt a non-scalar (e.g. link) retype revert → 422; verify a `source='restore'` revision is recorded.
- **Rollback:** unset (or ≠ `true`) + restart → routes return to 403. No persisted state; rollback is clean/immediate.

## 5. Scope / recommendation

- **Staging/sandbox only; prod unchanged.** These two are independent flags — enable either/both.
- Both expose only their **supported envelope** (config-toggle keys / scalar retypes); everything else stays gated fail-closed.
- **Recommendation:** both are **verified and ready for staging/sandbox enablement on the operator's go**, and are genuinely lower-risk than the uncreate/undelete/permission tiers — sheet-config is a setting flip; field-retype is provably lossless in-envelope with destructive types gated. Prod remains a separate decision. No code ships with this doc.
