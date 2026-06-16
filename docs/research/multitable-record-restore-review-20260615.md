# Record-Restore Stack — PR Review (#2654 / #2660 / #2662)

Reviewer: Claude (Opus 4.8). Date: 2026-06-15. READ-ONLY review.

Graded against the design-lock `docs/development/multitable-record-restore-layer1-design-20260615.md` and
its companion `…-dev-verification-…md` (both carried on the L1 branch / #2654).

Code read from the PR head refs (the two merged branches were deleted from origin; reviewed via
`refs/pull/<n>/head`): #2654 = `59f660a`, #2660 = `35fe5d3`, #2662 = `ba1e06e`. The L2 branch carries its
own copy of the L1 commit, so `record-write-service.ts` / `post-commit-hooks.ts` are byte-identical across
#2654 and #2660; line cites below are valid on both unless noted.

Merge status: **#2654 MERGED** (`ff3d1c6`), **#2660 MERGED** (`62f2ea9`, stacked), **#2662 OPEN** (FE).

---

## 1. Headline verdict per PR

| PR | Scope | Verdict | Why |
|---|---|---|---|
| **#2654** (L1 backend) | scalar restore + unset + dual write-gate | **Sound as merged; 2 retrospective test follow-ups (medium)** | Every behavioral dimension PASSes (no data corruption, no permission bypass, atomic version re-check). Gaps are missing *isolation* tests, not live defects. |
| **#2660** (L2 backend) | live link-field restore + retention | **Sound as merged; 3 retrospective test follow-ups (medium)** | Link write path correctly inherits the gate and the spine's atomic version/link validation. Gaps: reversed a security lock without a negative-permission test; an irreversible DELETE branch is unexercised. |
| **#2662** (FE) | drawer Restore button + confirm + api client | **APPROVE** | Wire contract and error-code surfacing are tested non-vacuously; concurrency threaded correctly. Only gap is the workbench orchestration handler (low). |

**No HIGH-severity findings survive.** The single raw "high" (unset-only test gap) was adversarially
downgraded to medium because the silent-false-success it guards against is **unreachable on current code**
— it only goes live under a hypothesized future deletion of one heavily-commented line. The behavioral
dimensions are all PASS. There are no merge blockers; #2662 is a clean approve.

**Confirmed: 0 high, 4 medium.**

---

## 2. CONFIRMED findings (ranked high → low)

There are no confirmed high-severity findings. The four mediums follow, then the lows.

### M1 — Unset-`applied` accounting (the sole guard against a silent false-success) has no isolating test  [#2654/#2660 · medium · TEST]

The restore route emits `op:'unset'` for a field present in current `data` but absent from the target
snapshot. In the spine, the *only* thing that stops an unset-only change set from hitting
`if (applied === 0) continue` is the `applied += 1` after `unsetIds.push(...)`.

- Guard: `packages/core-backend/src/multitable/record-write-service.ts:666-667` (`unsetIds.push`; `applied += 1`); skip at `:719`.
- The UPDATE branch is keyed on `unsetIds.length > 0` (`record-write-service.ts:759`), **not** on `applied` — so this accounting line is genuinely load-bearing and has no spine backstop.
- Route fallthrough: `univer-meta.ts:5837` (`result.updated.find(...)?.version ?? currentVersion + 1`) feeding `noop:false` at `:5838`; `restoredFieldIds` is computed from the diff at `:5809` regardless of whether the write landed. If the record were skipped it never enters `updated` (pushed at `record-write-service.ts:875`, past the skip), so the route would return `{noop:false, newVersion:Vcur+1, restoredFieldIds:[unset ids]}` — a restore the UI reports but the DB never performed.
- Coverage gap: T1 (`multitable-record-restore.test.ts:169-194`) is the only test that emits an unset, and it is **set+unset** (current `{A:'a3',B:'b3',SECRET}` → v1 snap `{A:'a1',SECRET}`). The `set A` makes `applied>=1` independently and the UPDATE fires on `unsetIds.length>0`, so B is removed and T1 passes even if `:667` is deleted. No test isolates the unset-only path.

Why medium not high: the silent-false-success shape is **unreachable today** — every unset hits `applied += 1`,
so an unset-only diff always has `applied>=1`; the `?? currentVersion + 1` branch is defensive/dead. This is a
regression-detection / fault-isolation gap on a real data-correctness consequence class, with a cheap missing test.

**Fix:** add an unset-only integration test — seed current `{A:'shared', B:'extra'}` at v2 with a v1 snapshot
`{A:'shared'}` (A identical, B added after v1); restore to v1 → diff is purely `unset B`. Bind response truth
to DB truth: assert the live row drops B, version bumped, a NEW `source='restore'` revision exists with `B` in
`changed_field_ids` and `patch.B === null`, and `restoredFieldIds === [B]` with `noop===false`.

### M2 — keep-days retention DELETE branch is reachable but never executed by any test  [#2660 · medium · TEST]

`sweepMetaRevisionRetention` has two DELETE branches. keep-last-n is exercised at the DB level by T13. The
**keep-days** branch is never run.

- Untested SQL: `meta-revision-retention.ts:96-113` (`WHERE ranked.rn > 1 AND ranked.created_at < now() - ($1::int * interval '1 day')`).
- Reachable in production: `resolveMetaRevisionRetentionConfig` selects it on `MULTITABLE_META_REVISION_RETENTION_POLICY === 'keep-days'` (`:62`); `startMetaRevisionRetention` wires the resolved config into the live sweep (`:157,:167`).
- No invocation: unit test `meta-revision-retention.test.ts:35-43` only asserts `resolveMetaRevisionRetentionConfig` returns `policy:'keep-days'` + a floored window — it never calls the sweep; integration T13 (`multitable-record-restore.test.ts:519`) uses `policy:'keep-last-n'`; T14 uses `enabled:false` (short-circuits at source `:93`); scheduler unit tests never advance timers so the callback never fires.

keep-days is a first-class, spec-committed policy (design §3 frames the guarantee as "most recent N versions /
D days"), so an untested **irreversible** DELETE covers half the retention contract. Not high because the
`rn > 1` latest-keep guard (`:106`) is the same structural protection T13 proves on the near-identical
keep-last-n SQL, so even a buggy date window cannot delete a record's current after-image — the realistic
blast radius is off-window pruning of *non-latest* history, and it is opt-in/default-disabled.

**Fix:** integration test seeding revisions with explicitly backdated `created_at` (some older than the window,
some newer; latest always recent), call the sweep with `policy:'keep-days', retentionDays:30`, assert only aged
non-latest rows are deleted and the latest is always retained even if itself old.

### M3 — Spec matrix item T4b (static FieldMutationGuard rejection) is not implemented — the route's static pre-check is unproven  [#2654 · medium · TEST]

Design §4 lists T4b ("a `property.readOnly`/`hidden` differing field is likewise refused"); the review
dimension grades "read-only-field restore rejection." The test file has no T4b (header matrix
`multitable-record-restore.test.ts:7-21` lists T4, not T4b; `grep` for T4b/static-guard finds nothing).

- T4 (`multitable-record-restore.test.ts:236-252`) exercises only the **layer-3** term: it seeds a `field_permissions.read_only` row on `FLD_SECRET` for `USER_RO` (`:147`) and trips `RESTORE_FORBIDDEN` via `layer3Ok===false`.
- Every seeded field uses `property '{}'` except `FLD_SEL`; none sets `property.readOnly`/`hidden`. So `isFieldAlwaysReadOnly`/`isFieldPermissionHidden` (`permission-derivation.ts:57-73`) return false for the restorable string fields, and the route's static term `staticOk = !!guard && !guard.hidden && guard.readOnly !== true` (`univer-meta.ts:5798`) is never the cause of any rejection.
- The static term is **reachable, not dead**: the diff loop excludes by *type* only, so a string field with `property.readOnly:true` that differs would enter the diff and trip `!staticOk` pre-transaction at the shared `hasForbidden` return (`univer-meta.ts:5802-5806`).

Not high: the spine backstops a readOnly/hidden field reaching the write loop —
`RecordWriteService.validateChanges` throws `RecordFieldForbiddenError` (`record-write-service.ts:438-445`),
which the catch maps to 403 (`univer-meta.ts:5816`, and both forbidden aliases at imports `:133`/`:142` are the
same class). So a regression dropping `staticOk` would still refuse the write — but the spine's message
*embeds the field id*, whereas the route's static branch exists to keep `RESTORE_FORBIDDEN` generic (the P3
no-leak property T4 asserts at `:244`). The unguarded residual is therefore the `isFieldAlwaysReadOnly →
guard → staticOk` wiring **and** the field-id-leak property — write-safety is backstopped, privacy is not.

**Fix:** add T4b — seed a field with `property { "readOnly": true }` (and a hidden variant) that differs
between versions, restore as a full-perms writer, assert atomic 403 `RESTORE_FORBIDDEN`, nothing written, and
the forbidden field id absent from the response body.

### M4 — L2 reverses Lock D for link fields (now a live write path through the gate) with ZERO negative-permission coverage on links  [#2660 · medium · PERMISSION]

*(Confirmed by my own primary-source check; this finding's dimension had no separate adversarial verdict — it
stands on the code read below, not on an adjudicated verdict.)*

Slice-1 Lock D excluded link fields from the diff. #2660 reverses that: the diff loop now emits link fields as
`op:'set'` routed through `patchRecords`, which re-syncs `meta_links` + the twoWay mirror fan-out — a real
live-data write path.

- L2 link branch: `univer-meta.ts:5777-5783` (`if (guard.type === 'link') { … diff.push({…, op:'set'}) }`).
- Every link test added in #2660 runs as the default full-perm writer `USER_W`: T6 / T6e / T6a / T6f / T6g (`multitable-record-restore.test.ts:285-360`). None sets `testUserId = USER_RO` or seeds a `field_permissions` row / property-hidden on a *link* field.

By inspection the `hasForbidden` gate **does** cover links (a link is in `fieldById` with the same gate
evaluation as scalars; a read-only/denied/hidden link → forbidden), so this is a coverage gap, not a confirmed
latent bug. But reversing a security-relevant lock and turning a previously-excluded type into a live write
path *without* a negative-permission test is exactly the change a future refactor of the link branch could
silently regress. The scalar layer-3 test T4 exists; the link analogue does not. (T6f does prove *atomicity*
on the foreign-validation-failure path, but not on a permission failure.)

**Fix:** add a link-field negative-permission test mirroring T4 — seed `field_permissions(field_id=<link>,
subject_id=USER_RO, read_only=true)` (and a `visible=false` case), make the link value differ across versions,
restore as `USER_RO`, assert 403 `RESTORE_FORBIDDEN`, `meta_links` unchanged (atomic), and no link/foreign id
echoed in the response.

---

### Lower-severity confirmed findings (low)

| ID | PR | Title | Cite | Note / fix |
|---|---|---|---|---|
| **L-LINK-CLEAR** | #2660 | Link restore clears live `meta_links` (cross-record blast radius) when the target snapshot lacks the link key, reported as `restored` | `univer-meta.ts:5778-5783` → spine full-clear `record-write-service.ts:806-823` | Faithful for current-era records (every live write mirrors link ids into `data` → snapshot — verified at `record-write-service.ts:641`, `record-service.ts:617/1044`, `univer-meta.ts:8928`, `records.ts`). Residual: a pre-mirroring legacy snapshot could clear edges it never captured; form-submit records no revision so is never a restore target. Document the snapshot-trust boundary in the L2 design; optionally gate a cross-record clear-on-absent behind confirm/skip. |
| **L-VEXP-MISREPORT** | #2660 | `VERSION_EXPIRED` (410) is misreported for genuinely never-captured early versions | `univer-meta.ts:5717-5725` (`MIN(version)` floor) vs keystone `meta-revision-retention.ts:88-130` | `MIN(version)` is the earliest *captured* revision, not a true prune floor; a record predating revision capture (migration `zzzz20260430172000`) yields a 410 "has been pruned" when nothing was pruned. Classification/message only; writes nothing; fail-safe direction. Either document the conflation or only emit `VERSION_EXPIRED` when retention is actually enabled. |
| **L-MIRROR-LINK** | #2660 | L2 link branch routes mirror/derived (`mirrorOf`) link fields to the SET path with no type carve-out | `univer-meta.ts:5777` (no `mirrorOf` exclusion); `:5798-5800` (`hasForbidden` trips on `guard.readOnly`); `permission-derivation.ts:65-66` | A mirror link is `isFieldAlwaysReadOnly===true`; if its projection ever appeared in data/snapshot and differed, the SET would enter the diff and the gate would atomically 403 an otherwise-restorable record. Not triggered today (mirror values have no materialized row → absent from data/snapshot → no diff entry). Defensive: exclude `mirrorOf` link fields by type; add a same-sheet mirror test. |
| **SEC-LOCK-STATUS** | #2654 | Locked-record / own-write-row rejection surfaces as **400 VALIDATION_ERROR** instead of 423/403 | spine `ensureRecordNotLocked → RecordValidationError(…, 'FORBIDDEN')` `record-write-service.ts:639-644`; `ensureRecordWriteAllowed → RecordValidationError` `:619-633`; restore catch maps `RecordValidationError → 400` `univer-meta.ts:~5848` | Write is atomically refused (security PASS) but the status is a generic validation failure; the `'FORBIDDEN'` code on the error is available but unused for branching. Distinguish lock/own-write rejections → 423/403 so clients can branch on the contract. Cosmetic. |
| **SEC-XBASE-LINK** | #2660 | Cross-base/foreign link restore writes `meta_links` edges to foreign records with no foreign-sheet permission check | spine link-target validation `record-write-service.ts:725` (existence-only `SELECT id … WHERE sheet_id=$1 AND id=ANY($2)`); foreign ids sourced from snapshot at `univer-meta.ts:5778` | Inherited `/patch` link-write model (shared spine), NOT introduced by restore; restore mildly amplifies by drawing foreign ids from the record's own historical snapshot. Out of scope for this slice; document as a known limitation; gate in the shared spine if a cross-base permission model lands. |
| **INT-STRINGIFY** | #2654 | `sameValue` uses `JSON.stringify`, so object-key-order differences in object-valued fields (e.g. `location`) can produce a spurious extra revision | `univer-meta.ts:5679` (`JSON.stringify(a ?? null) === JSON.stringify(b ?? null)`) | Bounded: distinct JSON values can never stringify-equal, so only a redundant no-change revision/version bump, never a missed revert or corruption. Optional canonical compare for object-typed fields. |
| **INT-DRIFT-AVAIL** | #2654 | `SCHEMA_DRIFT` rejects on ANY snapshot field id absent from the current schema, before type-filtering | `univer-meta.ts:5750-5755` (drift loop over all snapshot keys, before the restorable-type filter) | Matches the design's intended fail-closed lock, but a since-deleted *computed/link/system* field — one that would never enter the restore diff anyway — retroactively freezes restore for every prior revision that captured it. Availability cost; document the trade-off or restrict the drift check to restorable-typed keys (a noted Layer-2 follow-up). |
| **FE-WORKBENCH** | #2662 | Workbench `onRestoreRecordVersion` (confirm-gate + noop/success branch + post-restore refresh) has zero coverage | `MultitableWorkbench.vue` `onRestoreRecordVersion` (`window.confirm` gate, `result.noop ? restoreNoop : restoreSuccess`, `error.message ?? errorRestore`, `grid.loadViewData` + `refreshSelectedRecordContext`); `meta-record-drawer-restore.spec.ts:8` header states the round trip "needs manual/e2e QA" | The client error-code surfacing IS tested non-vacuously through real `parseJson` (`multitable-record-restore-client.spec.ts`). The restore-specific confirm-gate and noop branch are unit-untested. Low (mirrors the tested `onToggleRecordLock` pattern). Extract to a testable composable or add a component test asserting confirm-cancel skips the call + the noop/success/error branches. |
| **TEST-T13-FLOOR** | #2660 | T13 uses `keepN=10`, which equals `META_REVISION_RETENTION_MIN_KEEP_N`, so it cannot distinguish "keepN honored" from "always floored"; and the sweep is a global unfiltered DELETE | T13 `multitable-record-restore.test.ts:519`; floor `meta-revision-retention.ts:34,116`; global DELETE has no `record_id`/`sheet_id` WHERE filter | The per-record exact-window assertion `[4..13]` IS deterministic (record-scoped), but the `toBeGreaterThanOrEqual(3)` global count + cross-suite DELETE pollution are fragile if run in parallel with other DB suites. Run with `keepN` above the floor (seed 18, keepN=12, assert window `[7..18]`); note the global-sweep pollution risk. |
| **TEST-T5-VACUOUS** | #2654 | T5 proves formula EXCLUSION but is vacuous as to RECOMPUTE | T5 `multitable-record-restore.test.ts:254-266` asserts `!== 'fx_old'` over an excluded, expression-less (`property '{}'`) formula field; recompute wiring (sound, inherited) `record-write-service.ts:1078` | The recompute path IS wired and unconditional on source, so this is low — only the assertion is vacuous. Seed a formula with a real expression depending on a restored scalar and assert it re-derives, or relabel T5 exclusion-only and add a separate recompute assertion. |
| **TEST-T6A-FANOUT** | #2660 | T6a (twoWay link) asserts the forward edge but not the mirror fan-out it claims to prove | T6a `multitable-record-restore.test.ts:311-328` asserts only `linksOfField(FLD_LK_TW, rid)`; fan-out mechanism `record-write-service.ts:598,827,847` (`collectMirrorInvalidation`) | Forward-edge assertion is the correct primary check (the mirror is a derived single-edge projection with no materialized row), but the test name's "fan-out" claim is stronger than what is asserted. Drop the wording or capture the Yjs invalidator (as T11 does) and assert `FOREIGN_REC2` is among the invalidated ids. |

---

## 3. Refuted / downgraded / PASS (what was checked and dismissed)

### Downgraded
- **Unset-only test gap — raw HIGH → confirmed MEDIUM (M1).** Verified the silent-false-success is unreachable
  on current code: `:5837` is only reached when `diff.length>0`; an all-unset diff has every entry hit
  `applied += 1` at `record-write-service.ts:667`, so `applied>=1`, the `:719` skip never fires, the record
  enters `updated` at `:875`, and the route gets the real version. The `?? currentVersion+1` branch is dead
  today and only activates under a hypothesized future deletion of `:667`. Real consequence class, cheap
  missing test, regression-contingent → medium.

### Behavioral PASS (no defect — recorded for an auditable verdict)
- **SEC-1 — Write-gate sound, NO privilege-escalation bypass.** The `hasForbidden` gate (`univer-meta.ts:5795-5806`)
  fails closed on every axis: layer-3 `read_only` (`perm.readOnly===true`), read-denied `visible=false`
  (`perm.visible===false`), property-hidden (absent from `fieldPermissions` built from `visiblePropertyFields`
  → `perm` undefined → `!!perm` false; also `guard.hidden===true` on the static leg), and computed/link/system
  excluded by type before the diff. Verified `buildRecordPatchContext` builds `fieldById` from ALL fields and
  `fieldPermissions` from visible-only (`univer-meta.ts:3202-3243`), and `deriveFieldPermissions` default-allows
  only when no `field_permissions` row exists (`permission-derivation.ts:96-103`). `expectedVersion` + auth
  checked before any write; spine re-asserts under `FOR UPDATE` (`record-write-service.ts:647-648`). FE cannot
  bypass (actor derived server-side; client sends only `{targetVersion, expectedVersion}`).
- **VER-1 — Optimistic version re-check correct and atomic; no lost-update window.** Outer pre-check
  (`univer-meta.ts:5705-5708`) is belt-and-suspenders; the authoritative guard re-asserts `expectedVersion`
  under `SELECT … FOR UPDATE` (`record-write-service.ts:615-648`); the L2 `meta_links` re-sync runs in the
  same transaction, so the version guard protects the join-table mutation too.
- **INT-1 — `unset` is a true revert, not a merge; no Yjs/formula/revision desync.** `data = (data - keys) ||
  setPatch` in one statement (`record-write-service.ts:759-766`); after-image drops the keys and the revision
  patch marks `null` (`:782-787`); link/attachment unset rejected (`:461-466`); `source='restore'` ≠
  `'yjs-bridge'` so the invalidator fires (T11).
- **VER-2 — Forward-revision + edge cases correct:** current-version no-op (with the concurrency pre-check
  *before* the no-op return, `univer-meta.ts:5699-5708`), delete-tombstone resolution (`.find(action !==
  'delete')`), version-0 (`z.number().int().positive()`), non-existent target → 404, pruned floor → 410
  (L2), hard-deleted current record → 404.
- **VER-3 — FE threads the DISPLAYED `record.version` as `expectedVersion`** (`MetaRecordDrawer.vue:676`
  `expectedVersion: record.version`; button gated to non-current versions `:667-669`), so a concurrent edit
  surfaces as a 409 the user sees (`MultitableWorkbench.vue` handler → `showError`), never a silent clobber.

---

## 4. Per-PR recommendation

- **#2654 (L1, MERGED):** Implementation sound. File two retrospective test follow-ups — **M1** (unset-only
  isolation) and **M3** (T4b static-guard + no-leak). Lows (`INT-STRINGIFY`, `INT-DRIFT-AVAIL`,
  `TEST-T5-VACUOUS`, `SEC-LOCK-STATUS`) are optional polish.
- **#2660 (L2, MERGED):** Implementation sound; the link write path correctly inherits the gate and the
  spine's atomic version/link-target validation. File three retrospective follow-ups — **M2** (keep-days DELETE
  test), **M4** (link negative-permission test), and the documentation lows (`L-LINK-CLEAR` snapshot-trust
  boundary, `L-VEXP-MISREPORT`). `L-MIRROR-LINK` is a defensive nicety.
- **#2662 (FE, OPEN):** **APPROVE.** Wire contract and error-code surfacing are tested non-vacuously;
  `expectedVersion` is threaded so concurrency surfaces as a visible 409. The only gap (`FE-WORKBENCH`,
  low) is the workbench confirm/noop/refresh handler, already deferred to manual/e2e QA by the spec — worth a
  follow-up component test but not a merge blocker.

**Net: 0 high, 4 medium (all test-coverage / regression-detection gaps on irreversible or security-relevant
paths). No behavioral data-corruption or permission-bypass defect. No merge blocker.**
