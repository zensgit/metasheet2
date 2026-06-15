# Multitable Remaining-Development — Autonomous-Tier Closeout (dev + verification) — 2026-06-15

Companion to the execution tracker `multitable-benchmark-arc-todo-20260615.md` and
the canonical map #2650. This is the dev + verification record for the autonomous
tier of "余下多维表功能开发" driven to completion this session.

## 0. Scope + honest completion statement

Per #2650 §0, "余下开发" splits by terminal gate; only the **autonomous** tier
(pure backend, unit + tsc closeable) can be driven to *done* without a privileged
actor. This session drove that tier to completion:

- **A5-2 color-scale + A5-3 icon-set backend** — built, verified, draft **PR #2663**.
- **A2 export masking-flag** — verified **SAFE** (no fix needed); concern closed.
- **Button-arc independent audit** — produced a B1-c gate checklist (handoff).

The **browser-gated** and **owner/ops-gated** tiers cannot be auto-completed; they
are design-locked and gate-marked in the tracker, not faked as "verified." Merge of
#2663 is the owner's (nothing auto-merges).

## 1. Development delivered — A5-2 / A5-3 conditional-format scale backend (PR #2663)

Extends the A5-1 data-bar scale machinery to the two remaining range styles.

**Built** (5 files; backend canonical + FE mirror):
- `conditional-formatting-service.ts`: `ConditionalFormattingColorScaleConfig` +
  `ConditionalFormattingIconSetConfig` types; per-kind `sanitizeConditionalFormattingScaleRule`
  (replaced the `kind !== 'dataBar'` early-reject); RGB-interpolation helpers; a
  3-kind `buildFieldScaleMap`.
- `apps/web/.../utils/conditional-formatting.ts` + `types.ts`: byte-identical FE mirror.
- Two unit specs: separate `colorScale` / `iconSet` describe blocks.

**Contract:**
- colorScale: 2 or 3 stops, each a valid `sanitizeHex` color, anchor set exactly
  `{min,max}` (2) or `{min,mid,max}` (3) — dup/missing anchor, 1 stop, 4 stops all
  reject. `scaleColor` = normalized `t=(v-min)/(max-min)` clamped [0,1]; 2-stop
  linear RGB lerp; 3-stop piecewise with mid anchored at t=0.5. Degenerate
  `min==max` → mid color (deliberately diverges from dataBar's degenerate=full-bar).
- iconSet: `set ∈ {arrows3,traffic3,signs3}`, `thresholds=[t0,t1]` finite +
  monotonic (`t0<=t1`). `iconKey` by ABSOLUTE thresholds (`v<t0`→low,
  `t0<=v<t1`→mid, `v>=t1`→high); percentile mode noted as a follow-up.
- dataBar path UNCHANGED; unknown kind → null (forward-dated-config guard kept).

**Verified (all real):**
- `tsc -p tsconfig.json` (core-backend) exit 0; `vue-tsc -b` (web) exit 0.
- cond-format spec 70/70; full backend unit suite **3296/3296** (no regression);
  FE cf-scale 24 + conditional-formatting 25 + grid-databar 4 + dialog-i18n 4.
- **94 scale/cf tests** total (BE 70 + FE 24).
- FE↔BE parity is load-bearing (separate vitest projects, no cross-package harness):
  the 7 shared scale helpers + the expected `scaleColor`/`iconKey` literals were
  diffed **byte-identical** across both specs — the mirror-drift trap closed.
- Harden caught a real masked test gap: the 3-stop upper segment (mid↔max) was only
  exercised at t=1 (where lerp returns `stops[2]` regardless), masking a plausible
  bug; added an interior assertion at t=0.75 → `#80ff00`, proven non-vacuous
  (injecting the wrong stop index yields `#808000` and fails it).

**Render-slice blocker (carried in the PR):** the sanitizer now ACCEPTS
colorScale/iconSet, but `MetaGridTable.vue:606` is still kind-blind (paints a
data-bar gradient from any scale entry → `linear-gradient(…undefined…)`). Safe
intermediate state today (the dialog, the only config producer, is dataBar-only),
but the render slice MUST make the cell renderer kind-aware **before** colorScale/
iconSet authoring ships.

## 2. Verification delivered — A2 export masking (SAFE; no code)

Question (#2650 §4): does the FE multitable export bypass server-side field masking?

**Verdict: SAFE (high confidence) — investigate + adversarial-refute both agree.**

- Read path masks VALUES: `GET /view` applies
  `row.data = filterRecordDataByFieldIds(row.data, allowedFieldIds)` at
  `univer-meta.ts:8128`; `filterRecordDataByFieldIds` (`:3133`) physically keeps
  only allowed keys. `allowedFieldIds` = visible-gate (`:7855`) narrowed by the
  formula-taint chokepoint `maskStoredRecordFieldIds` (`:7865`, monotone — only
  deletes).
- Export reads only `grid.rows` (set from the `/view` response,
  `useMultitableGrid.ts:476`), columns bounded by `scopedGridFields` (`:898`) —
  no unmasked re-read.
- Set relationship (the crux): `scopedGridFields ⊆ allowedFieldIds`, so every
  offered column is a value the server did NOT drop.
- All four value-injection channels apply the full composite mask: `GET /view`
  (8128), `GET /records/:id` (9319), submit echo (8804), PATCH echo (9024). The
  strongest counter-case (formula-taint + realtime full-record refresh) was chased
  and confirmed closed (taint-narrowing precedes the value filter on re-fetch).
- Non-bypass caveats (display-preference, not leaks): layer-1 view-hidden-but-
  readable values ride on the wire but the user could unhide them and
  `scopedGridFields` excludes them from offered columns.

The FE `scopedGridFields` filter is defense-in-depth; the **server data-mask is the
security boundary**. No fix required.

## 3. Verification delivered — button-arc independent audit (B1-c gate checklist)

Full report: `docs/research/multitable-button-arc-audit-20260615.md`. Read-only audit
of the merged button arc (#2645/#2648/#2653/#2657), every high/medium finding
adversarially refuted.

**Verdict: sound today — every value-leak is LATENT** (no path on main creates a
`button` field yet; `MULTITABLE_FIELD_INPUT_TYPES` omits it). But a real spec-gap
pattern exists: the button write-less invariant is enforced **inconsistently across
3+ serializers/write paths** (bulk-UPDATE rejects; single-record CREATE via
`record-service.ts:222` and the route-layer `univer-meta` sanitizer do not). These
go **live the instant B1-c wires button creation** — so they are a **B1-c gate
checklist** (design-lock §2 mandates closing each there).

- **Single highest-leverage fix:** add `'button'` to `isFieldAlwaysReadOnly`
  (`permission-derivation.ts:58`) as a TYPE-level always-readonly — closes the
  create/update/patch/xlsx asymmetry in one gate.
- **AUDIT-1 (live spec divergence):** the merged `button/run` route only does
  `logger.info`, not a durable `AutomationLogService.record()` row (design-lock
  §5.2). Worth reconciling.

## 4. Remaining ladder (gated — cannot be auto-completed)

**browser-gated** (backend autonomous; terminal slice needs a real browser): B1-b /
B1-c · A5-2/A5-3 grid render + dialog (+ the kind-aware renderer blocker above) ·
A3 inline-link expand · A4 form-logic depth · B4 dashboard widgets · B5 longText
@mention · B6 comment reactions.

**owner/ops-gated:** A1 grid virtualization (owner S5b staging baseline) · B7
row-level rule permissions · B2 AI auto-trigger · B3 native synced tables · C1 SMTP
creds · C2 template content · C4 mobile · A2 server-side full-dataset export.

## 5. Cleanup + open PRs from this session

- **PR #2663** — A5-2/A5-3 backend (draft, ready for review).
- **PR #2647** — execution tracker + this closeout (draft).
- **#2644** (button scope-gate) — superseded by merged #2645; recommend close.
- **#2641** (飞书 refresh research) — overlaps merged #2629; owner to decide.

## 6. Re-entry

The autonomous tier is closed. Next (each a named opt-in): review/merge #2663;
fold the B1-c gate checklist into the B1-c PR when button creation is wired; then
re-run the refresh audit to re-rank the gated ladder before opening any browser- or
owner-gated arc.
