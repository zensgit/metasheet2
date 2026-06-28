# T9-W unsafe config-restore — line review + closeout (development & verification) — 2026-06-27

Closeout for the **T9-W unsafe config-restore** line: an as-built review of the greenlit
slices, a reconciliation of the #3254 design-lock against current `main`, and a small
wording fix so the next reviewer isn't misled by stale "lossy" framing.

Design-lock: `multitable-t9-w-unsafe-restore-design-lock-20260626.md` (#3254, owner-approved,
greenlit Tier 1 + Tier 2). As-built reference: `config-restore.ts`,
`multitable-t9w-u2-field-retype-revert-dev-verification-20260627.md`.

## 1. As-built review (审阅这条线)

The greenlit scope (Tier 1 + Tier 2) is **shipped**; the classify layer stays pure and the
per-tier flags + scalar/key predicates gate execution at the route.

- **classify layer** — `classifyRevert` is pure and conservative: `safe` only for view config
  reverts + field `name`/`order`; everything else `gated`. It never reads flags/caps.
- **Tier 1 (U-1b) sheet_config revert** — `isSupportedSheetConfigRevert` opens only an `update`
  whose changed keys ⊆ `{conditionalReadRules, rowLevelReadPermissionsEnabled}`, behind
  `MULTITABLE_ENABLE_SHEET_CONFIG_REVERT`; the route 403s (`SHEET_CONFIG_REVERT_DISABLED`)
  when off. create/delete/unknown-key stay gated.
- **Tier 2 (U-2) field retype revert** — `isFieldRetypeRevert` + `isSupportedFieldRetypeRevert`
  gate a **scalar-safe, schema-only** retype (both `before.type`/`after.type` must be plain
  scalars; `FIELD_RETYPE_EXCLUDED_TYPES` excludes formula/lookup/rollup/link/attachment/button/
  autoNumber/created*/modified*). Behind `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT`; route 403s
  (`FIELD_RETYPE_REVERT_DISABLED`) when off. The in-code Tier-2 comment already states the
  schema-only/lossless contract (no cell-value migration; a value-transforming retype is a
  separate destructive decision, NOT this slice).
- **Redaction** — `redactConditionalReadRuleLiterals` strips rule `value` for fields the actor
  can't read; applied on the read path (`/config-history` sheet_config before/after) AND the
  preview path (sheet_config current/target). Real-DB goldens: field-denied
  `canManageSheetAccess` cannot see the secret literal; fully-allowed can.
- **execute response** — returns only `restored: { revisionId, entityType, entityId,
  changedKeys }`; it writes/records the revision with the raw server-side target but does NOT
  echo `preview.current` / `preview.target` / raw config back to the caller.

Verdict: no blocker. The line is internally consistent and the threat-model holds.

## 2. Design-lock reconciliation (#3254 amendment)

The #3254 lock's threat-modeling is sound, but two premises are corrected by as-built, and
three items are recorded as **future-gate contracts** (not current hard requirements):

1. **U-2 "lossy retype" premise CORRECTED → schema-only / lossless.** Per
   `multitable-t9w-u2-field-retype-revert-dev-verification-20260627.md` §1/§3 and
   `isSupportedFieldRetypeRevert`, the shipped retype revert restores only
   `meta_fields.type`/`property` and does NOT coerce or drop record values (a mismatched value
   like `'hello'` survives a revert to `number`). The lock's "coerce or drop cell values"
   framing does not describe the shipped path. **The original [P1] loss-magnitude-in-drift
   requirement does NOT apply to current U-2** and must not be retrofitted onto the schema-only
   path.
2. **Future destructive value-transform retype = separate owner sign-off + loss-bound gates.**
   IF a future slice does real value-transforming retype (coerce/drop), THEN: the preview
   identity MUST bind a loss summary; a preview↔execute loss-summary mismatch MUST 409; refuse
   on total/unknown loss. This is where the original [P1] belongs.
3. **U-L6 execute-response redaction (contract lock; not a current leak).** Current execute
   returns only the minimal `restored` envelope, so no literal leaks today. LOCK for the
   future: if execute ever returns a `current`/`target`/config payload, it MUST apply the same
   requester redaction as preview / `/config-history`.
4. **U-L8 default tightened.** Prefer the full-read gate (option b). If a scoped count is used,
   the `undisclosed` marker MUST appear unconditionally (constant), so its presence carries no
   existence signal (the conditional marker is itself a weak oracle vs U-L7).
5. **Tier 1 audit = the forward `meta_config_revisions` row.** Execute records `source='restore'`
   + `restoredFromId` on the forward revision, so "who re-exposed which rows, when" is a
   queryable audit trail — treat it as the explicit audit for the row-deny re-expose (intent
   parity with the Tier-4 permission-revert audit requirement).

## 3. Development (this PR)

Stale-wording fix in `config-restore.ts` — the supported retype path is now schema-only/lossless
via `isSupportedFieldRetypeRevert`, but two spots still said "potentially lossy":

- file header (the `type`/`property` bullet) → now "schema-only revert; gated at classify, route
  opens a scalar-safe Tier-2 subset".
- `classifyRevert`'s field-gated `reason` string → now "gated at the classify layer (type/property
  is route-gated to a scalar schema-only subset; see isSupportedFieldRetypeRevert)".

Comment/string-only; `classifyRevert`'s control flow and return `kind`s are unchanged.

## 4. Verification

- **No golden asserts the old text** — `git grep "potentially lossy"` over
  `packages/core-backend/**/*.test.*` returns nothing, so changing the `reason` string cannot
  break an assertion. (To run: `pnpm --filter @metasheet/core-backend test config-restore`.)
- **Behaviour unchanged** — only comment text + one `reason` string edited; no predicate,
  branch, or returned `kind` changed.
- **typecheck / lint** — to run in CI (`tsc -b` + eslint on the changed file).

## 5. Out of scope / follow-ups

- Tier 3 (un-create) HOLD; undelete DEFER; permission-revert HOLD — unchanged, per #3254.
- The future-gate contracts in §2 (loss-summary drift binding; execute-response redaction;
  U-L8 default) activate only when a destructive value-transform retype or a richer execute
  payload is built — tracked here, to be enforced at that slice's review.
