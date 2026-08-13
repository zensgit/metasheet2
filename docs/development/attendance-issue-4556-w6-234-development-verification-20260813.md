# Attendance Issue #4556 W6-2 + W6-3 Development & Verification Report

> Status: **RECORD**. This report documents what merged for W6-2 (contract
> wiring, PR #4893) and W6-3 (UI, PR #4894), per design-lock §7.5 ("W6-4
> verification"). W6-1's own development and verification reports are already
> on `main`
> (`docs/development/attendance-issue-4556-w6-1-development-report-20260812.md`,
> `docs/development/attendance-issue-4556-w6-1-verification-report-20260812.md`)
> and are not re-litigated here. This report is not runtime, flag, staging,
> deployment, soak, production-data, customer-data, or issue-close authority.
>
> Date: 2026-08-13
>
> Ratified contract:
> `docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md`
> (§4 aggregate contract, §5 UI contract, §7.3 W6-2 completion gate, §7.4 W6-3
> completion gate, §7.5 W6-4 verification gate).
>
> Fresh base for this record: `origin/main@a60723c99ca646a0ade363634fb682a6937ff967`
> (W6-1 + W6-2 + W6-3 merged, in that order, with zero intervening unrelated
> commits — see §1).
>
> **Authorization note (mirrors the disclosure practice both merged PR bodies
> already used):** the design-lock's own §9/§10 text scopes owner RATIFY to
> "the W6-1 backend aggregate slice only" and lists W6-2/W6-3/W6-4 as separate,
> un-granted acts; the lock's status header still reads "Every W6 slice beyond
> W6-1 remains **HOLD**" (unedited by this report — see §6 item 3). W6-2 and W6-3
> proceeded on an in-session owner grant ("授权 W6-2" / "build W6-2/3/4 to their
> gates") relayed by the coordinating session. As of this report, that grant
> has not yet been posted to issue #4556 as a durable comment — both PR bodies
> recommended it be posted before the next gate. This report records what
> landed under that grant; it does not itself constitute or backfill the
> durable ledger entry.

## 0. Scope of this record

W6-2 promotes the already-drafted, unpublished OpenAPI contract
(`packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml`)
into the published API surface (design-lock §7.3). W6-3 completes the W6-0
inert shell into a live, gated UI panel (design-lock §5/§7.4). Neither slice
changes W6-1's aggregate authorization, values-free response shape, or FSER
composition — those remain exactly as verified in the W6-1 reports; this
record's real-DB re-run in §5.2 confirms zero regression in that suite.

This record does **not** authorize: W7 calculation cutover, W8 closure, the
OD-W6-7 flag flip in any environment, staging, soak, production/customer
data, or closing issue #4556. See §7.

## 1. Merge record

| Slice | PR | Merge SHA | Sole parent | Merged at | Fresh CI |
| --- | --- | --- | --- | --- | --- |
| W6-1 | #4849 | `0aed2a85b27a48ca7ff3bd96b934494d27a47613` | (pre-existing `main`) | 2026-08-13T16:20:01+08:00 | — (see W6-1 reports) |
| W6-2 | #4893 | `6700494a9abf2b12f6dcef9d52bb6171f878d2bb` | `0aed2a85b27a48ca7ff3bd96b934494d27a47613` | 2026-08-13T21:01:31+08:00 | 19 checks, all SUCCESS except the repository-expected SKIP on "Strict E2E with Enhanced Gates" |
| W6-3 | #4894 | `a60723c99ca646a0ade363634fb682a6937ff967` | `6700494a9abf2b12f6dcef9d52bb6171f878d2bb` | 2026-08-13T23:24:52+08:00 | 21 checks, all SUCCESS except the same repository-expected SKIP |

Each slice's merge commit has exactly one parent, and that parent is the
previous slice's merge SHA (`git log --format=%P -1 <sha>`, re-verified for
this record). The three slices landed as an uninterrupted, linear train with
zero interleaving commits from unrelated lanes — confirming each PR body's own
"built on fresh main" claim.

## 2. Implementation surfaces

| Layer | Files (W6-2) |
| --- | --- |
| OpenAPI paths | `packages/openapi/src/paths/attendance.yml` (appended `paths` block verbatim) |
| OpenAPI schemas | `packages/openapi/src/base.yml` (appended `components.schemas` block verbatim) |
| Generated dist/SDK | `packages/openapi/dist/{openapi.yaml,openapi.json,combined.openapi.yml}`, `packages/openapi/dist-sdk/index.d.ts` |
| Draft marker | `packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml` (header only: `status: PROMOTED`, `mergedIntoBuild: true`) |
| Enum-parity gate | `packages/core-backend/tests/unit/attendance-w6-2-enum-parity.test.ts` (new) |
| Export visibility | `packages/core-backend/src/attendance/w6-group-effective-policy-response-contract.ts` (six constants exported, no behavior change) |

| Layer | Files (W6-3) |
| --- | --- |
| Pure label/nav module | `apps/web/src/views/attendance/attendanceGroupEffectivePolicyLabels.ts` (new) |
| Panel | `apps/web/src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue` (completed from the W6-0 static shell) |
| Host mount | `apps/web/src/views/attendance/AttendanceGroupContextHost.vue` (gated mount) |
| Backend flag | `packages/core-backend/src/attendance/w6-group-effective-policy-panel-flag.ts` (new) |
| Session payload wiring | `packages/core-backend/src/routes/auth.ts` (`buildFeaturePayload`) |
| FE flag store | `apps/web/src/stores/featureFlags.ts` |
| Specs | `apps/web/tests/attendanceGroupEffectivePolicyLabels.spec.ts`, `apps/web/tests/AttendanceGroupEffectivePolicyPanel.spec.ts`, `apps/web/tests/attendanceGroupContextHostEffectivePolicyGate.spec.ts`, `packages/core-backend/tests/unit/attendance-w6-group-effective-policy-panel-flag.test.ts` |
| CI wiring | `.github/workflows/attendance-web-guard.yml` (run list + both path filters) |
| Browser evidence | `docs/development/assets/w6-3-effective-policy-panel-20260813/{w6-3-01-idle-collapsed.png,w6-3-02-expanded-content.png}` |

## 3. Independent-gate record

### 3.1 W6-2 — three gate rounds, each recorded APPROVE / 0 P1 / 0 P2

W6-2's PR carries four commits. Each of the three follow-up commits names the
prior round's gate verdict in its own message — a grep-able, in-repo artifact,
not a paraphrase:

| Round | Head commit | Gate verdict cited in the *next* commit's message | What it found |
| --- | --- | --- | --- |
| 1 | `afc7b7aff87ca98ff2bfed79bb5fb9e97671b62f` (initial) | "the independent gate on #4893 (code APPROVE, 0 P1/0 P2 ...)" (cited by `7ee24fbfba`) | P3: enum-parity only covered 3 of the closed enums; extend to the full inventory |
| 2 | `7ee24fbfbaf4fddfe80178c29fb93acc0a63c5ec` | "the re-gate on 7ee24fbfba (code APPROVE, 0 P1/0 P2 ...)" (cited by `430107113c`) | P3: "FULL/EVERY" coverage claim still overclaimed — 14 of 22 raw stanzas pinned, 5 genuine positions drifted silently |
| 3 | `430107113c75514c79f4e2b773c11bc27bbe6996` | "Gate NIT: the header understated coverage as 'pins 20 of 22 raw stanzas'..." (cited by `7a8d8b4c19`) | NIT: prose/comment count was off by one raw stanza (20→21); no test/behavior change |

Final head `7a8d8b4c19f3e05a6624e0be9494e30b8bce708d` (= merge SHA
`6700494a9a`'s tip) carries no further gate citation in this PR's own commit
trail — consistent with the third round's finding being a NIT rather than a
P1/P2 requiring a fourth round.

### 3.2 W6-3 — recorded by the coordinating session, not reflected in this PR's commit trail

W6-3's PR carries two commits (`a4f87cb6fae371b41b3dace0e4a6e47a0c991a27`
initial, `b24cf344455852e83668040cdc85add59ffc6c76` committing the browser
screenshots). Unlike W6-2, neither commit message names a gate round or a
verdict. Per the coordinating session's own record, one independent gate round
returned APPROVE for W6-3. **This claim is a process record, not an
in-repo artifact**: this report did not find a grep-able commit-message or
PR-comment trail for it, in contrast to W6-2's three self-documented rounds
above (`gh pr view 4894 --json comments,reviews` returns zero GitHub PR
review/comment records for either PR — the coordinating session's gates are
run outside GitHub review objects). It is stated here as reported, not
independently reproduced.

What *is* independently reproducible, and was reproduced fresh for this
record (§5.3): the OD-W6-7 two-layer gate — the item the task instructions
flagged as security-critical — has its own mutation self-check, which this
report re-ran from a clean worktree rather than trusting the PR body's own
account of it.

## 4. Per-red-line evidence table

### 4.1 W6-2 — contract wiring (design-lock §7.3)

| Requirement | Artifact | State |
| --- | --- | --- |
| Move the draft YAML's `paths` block into `packages/openapi/src/paths/attendance.yml` verbatim | `packages/openapi/src/paths/attendance.yml` — `/api/attendance/groups/{groupId}/effective-policy` block at ~L4625; description text matches the draft, including the #4876 404 correction (see row below) | PASS — read and confirmed in this worktree |
| Move the draft YAML's `components.schemas` block into `packages/openapi/src/base.yml` verbatim | `packages/openapi/src/base.yml` L4273–L4577 — nine `AttendanceGroupEffectivePolicy*` schemas | PASS — read and confirmed |
| Rebuild `dist/`, validate, regenerate SDK; existing attendance OpenAPI contract gate stays green | `pnpm --filter @metasheet/openapi build && validate && generate:sdk`, then `git diff --exit-code -- packages/openapi/dist packages/openapi/dist-sdk/index.d.ts` (the exact command in `.github/workflows/plugin-tests.yml`'s "Run attendance W4C-4 calculation detail and diff contracts" step) | PASS — re-run fresh in this worktree, exit 0, byte-identical |
| Enum values in OpenAPI, TS contract, and runtime service proven equal by one mechanical comparison test | `packages/core-backend/tests/unit/attendance-w6-2-enum-parity.test.ts` | PASS — 62/62, re-run fresh (§5.1) |
| Enum-parity coverage is honestly stated, not "FULL/EVERY" | Independently counted (not just read from the test's own comment): the promoted schema block (`base.yml` L4273–L4577) contains exactly **22** raw `enum:` stanzas (`grep -c "enum:"` over that exact line range); the test pins **21** of them, expressed as **20** logical test cases (`editorRef.kind`'s two one-value oneOf-branch stanzas — `enum:[group_stage]` and `enum:[group_context_route]` — count as one logical two-value union, not two); the one deliberate exclusion is the envelope's `ok: { enum: [true] }` structural success/failure discriminator (L4473 area), which has no TS-array or runtime-enum-set analogue | PASS — independently recounted for this report, matches the test's own header comment exactly |
| Load-bearing (a drift in any one source reds at least one assertion) | Mutation self-check: added a spurious 6th value to `AttendanceGroupEffectivePolicySourceLabel`'s `enum:` in `base.yml` → exactly 1 of 62 assertions reds (`OpenAPI base.yml enum equals the TS contract set`); restored via `cp` backup, diffed clean, re-ran green (62/62) | PASS — mutation-proven fresh for this report (§5.4) |
| Unknown, cross-org, and delegated-non-member groups share one values-free 404 (not 403) — preserved verbatim from the #4876 correction | OpenAPI: `packages/openapi/src/paths/attendance.yml` `'404':` description at ~L4664 reads "Unknown, cross-org, or inaccessible group, including a delegated admin without active target-org membership; one shared values-free shape". Runtime: `packages/core-backend/tests/unit/attendance-w6-group-effective-policy-authorization.test.ts` — `'a delegated caller who is not an active member of the org is refused by the membership statement itself'` asserts `res.status).toBe(404)` and the exact body `{ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found', details: undefined } }` | PASS — both artifacts read directly; unit test re-run green (§5.1) |

### 4.2 W6-3 — UI (design-lock §5 / §7.4)

| Requirement | Artifact | State |
| --- | --- | --- |
| §5.1 — one label chip per closed `SourceLabelV1` union, 1:1 bound, no free text | `apps/web/src/views/attendance/attendanceGroupEffectivePolicyLabels.ts` — `SOURCE_LABEL_TEXT: Record<AttendanceGroupEffectivePolicySourceLabelV1, ...>`; `attendanceGroupEffectivePolicyLabels.spec.ts` (39 cases, every union member of all 6 mirrored enums asserted to exact bilingual text) | PASS — re-run fresh: 39/39 (§5.1) |
| §5.2 / OD-W6-7 — panel mounts inside the #4711 host, behind a default-OFF, **two-layer** gate; wildcard never matches | Master switch: `packages/core-backend/src/attendance/w6-group-effective-policy-panel-flag.ts` `isAttendanceGroupEffectivePolicyPanelMasterEnabled` (env `ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED`, string `'true'` only). Org allowlist: `isOrgExactlyAllowlisted` (env `ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ORGS`, exact-match split, `*` explicitly excluded — `'never treats a wildcard entry as a match'` case). Test: `packages/core-backend/tests/unit/attendance-w6-group-effective-policy-panel-flag.test.ts` | PASS — re-run fresh: 12/12 (§5.1) |
| OD-W6-7 gate is load-bearing at the host, not just at the flag-predicate unit | `apps/web/tests/attendanceGroupContextHostEffectivePolicyGate.spec.ts` — `'gate OFF (default)'` asserts `[data-attendance-w6-effective-policy-panel]` is `null` and zero `/effective-policy` fetches | PASS — **mutation-proven fresh for this report**: forced `AttendanceGroupContextHost.vue`'s `showEffectivePolicyPanel` to `computed(() => true)` → the "gate OFF (default)" case reds (`expected <section ...> to be null`); restored via `cp` backup, `diff` clean, re-ran green (§5.5) |
| Gate-OFF DOM/network behavior is byte-identical to pre-W6-3 | `apps/web/tests/attendanceGroupContextHost.spec.ts` — unmodified since PR #4729 (`git log --oneline -- <path>` shows no commit from the W6-3 merge), its exact `apiFetch`-call-count assertions still green with the panel mounted-but-gated | PASS, **scope-qualified**: DOM and network behavior of the attendance web surface are byte-identical gate-OFF. **Not** byte-identical: `buildFeaturePayload` in `packages/core-backend/src/routes/auth.ts` (~L310) now always emits one additional session-payload key, `attendanceGroupEffectivePolicyPanel: false` when the gate is OFF — read directly in this worktree. This is the same shape `approvalCanvasV2`/`approvalFwbWriteback` already introduced into the identical payload; no existing test asserts an exact `features` key set (`auth-login-routes`/`AuthService`/`auth-invite-routes`/`auth-runtime-config` re-run fresh in §5.1: 90/90, unaffected) |
| §5.3 — every conflict row resolves through the existing #4711 builder or existing stage selector; no second navigation spelling | `attendanceGroupEffectivePolicyLabels.ts` — `group_context_route` resolves via the real, imported `buildAttendanceGroupRouteHref`; `group_stage` resolves to `ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO` (the existing groups-list section — a disclosed fidelity gap, not a second navigation spelling; see §6.2) | PASS, with a disclosed fidelity limitation (§6.2) — not a red-line violation: no caller-supplied section ID is minted |
| §5.4 / #4711 host rule — exactly one aggregate GET per explicit open/refresh; no second cached status | `AttendanceGroupEffectivePolicyPanel.vue` — exactly one `apiFetch` call site (~L209), no `onMounted`/`watch` auto-trigger; `AttendanceGroupEffectivePolicyPanel.spec.ts` — `'starts idle and issues zero fetches on mount'`, `'fetches exactly once per explicit open click'`, `'issues exactly one additional GET per explicit refresh click, never automatically'` | PASS — re-run fresh: 10/10 (§5.1); single-call-site grep confirmed in this worktree |
| §5.5 — pure logic in a standalone `.ts` module, not the SFC or `AttendanceView.vue`; exhaustive by construction | `attendanceGroupEffectivePolicyLabels.ts` — no fetch/DOM/Vue import; six `Record<ClosedUnion, ...>` display-text maps (`SOURCE_LABEL_TEXT`, `DOMAIN_TEXT`, `CONFLICT_CODE_TEXT`, `GROUP_TYPE_TEXT`, `CALCULATION_POSTURE_TEXT`, `FIXED_SCHEDULE_STATE_TEXT`) | PASS — **mutation-proven fresh for this report**: deleted the `basics` entry from `DOMAIN_TEXT` → `pnpm exec vue-tsc -b` in `apps/web` reds with `TS2741: Property 'basics' is missing`; restored via `cp` backup, `diff` clean, re-ran clean (§5.5) |
| §5.5 / F1 lesson (#3487) — specs wired into `attendance-web-guard.yml`'s run list **and** both path filters | `.github/workflows/attendance-web-guard.yml`: `push.paths` list (L187–189), bash `case` classifier (L275–277), and the `vitest run` command (L339) all name `attendanceGroupEffectivePolicyLabels.spec.ts`, `AttendanceGroupEffectivePolicyPanel.spec.ts`, `attendanceGroupContextHostEffectivePolicyGate.spec.ts` | PASS — all three locations grepped and confirmed in this worktree |
| R7 (parent lock §2.3) — no raw-ID or cross-org fallback; unknown/deleted actors render neutral labels | `attendanceGroupEffectivePolicyLabels.ts` — `attendanceGroupEffectivePolicyNeutralMemberLabel('unknown' \| 'deleted', tr)`, exact bilingual text, "native ... from the start" per its own header comment; distinct from the pre-existing raw-UUID fallback tracked separately (`FE-06`, `attendance-issue-4556-w8-verification-and-closeout-plan-20260807.md` L358) | PASS, currently **inert**: `grep -rn attendanceGroupEffectivePolicyNeutralMemberLabel apps/web/src` finds only its own definition and its spec — no call site in this panel, because W6-R2 keeps the aggregate values-free (no member identities to label). Pre-positioned for a future member-bearing surface, not exercised by W6-3 itself |
| §7.4 browser evidence on the workspace route | `docs/development/assets/w6-3-effective-policy-panel-20260813/w6-3-01-idle-collapsed.png` (81,711 bytes), `.../w6-3-02-expanded-content.png` (163,728 bytes) | PASS — both files confirmed present in this worktree via `ls -la` |

## 5. Fresh local verification performed for this record

All commands below were re-run from a clean worktree of `origin/main@a60723c99c`
(`git worktree add ... -b claude/attendance-w6-4-verification-20260813
origin/main`), not copied from either merged PR body.

### 5.1 Unit matrix

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-w6-2-enum-parity.test.ts \
  tests/unit/attendance-w6-fser-single-source-caller-inventory.test.ts \
  tests/unit/attendance-w6-group-effective-policy-aggregate.test.ts \
  tests/unit/attendance-w6-group-effective-policy-authorization.test.ts \
  tests/unit/attendance-w6-group-effective-policy-dml-sweep.test.ts \
  tests/unit/attendance-w6-group-effective-policy-response-contract.test.ts \
  tests/unit/attendance-w6-group-effective-policy-panel-flag.test.ts \
  tests/unit/attendance-w6-import-graph-no-calculation-consumer.test.ts \
  tests/unit/attendance-w6-producer-key-single-source.test.ts \
  tests/unit/attendance-w6-schedule-route-surface-parity.test.ts \
  --reporter=dot
```
Result: **10 files / 346 tests passed** (the W6-2 PR's own 9-file/334-test
matrix plus the panel-flag test's 12 cases).

```
pnpm --filter @metasheet/web exec vitest run \
  attendanceGroupEffectivePolicyLabels AttendanceGroupEffectivePolicyPanel \
  attendanceGroupContextHostEffectivePolicyGate attendanceGroupContextHost.spec \
  --reporter=dot
```
Result: **4 files / 55 tests passed** (39 + 10 + 2 + 4).

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-w6-group-effective-policy-panel-flag.test.ts \
  tests/unit/auth-login-routes.test.ts tests/unit/AuthService.test.ts \
  tests/unit/auth-invite-routes.test.ts tests/unit/auth-runtime-config.test.ts \
  tests/unit/auth-alias-cutover-gate.test.ts --reporter=dot
```
Result: **6 files / 102 tests passed** (12 panel-flag + 90 auth blast-radius,
matching the W6-3 PR body's own "90/90" claim for the auth files).

### 5.2 Real-DB matrix (unchanged, confirms no regression)

Local PostgreSQL 15, `metasheet_test` database, `DATABASE_URL=postgresql://postgres@localhost:5432/metasheet_test`.

```
pnpm --filter @metasheet/core-backend migrate
```
Result: **Applied: 317, Pending: 0.** (W6-1's own report recorded 314 at its
evidence head; this is a fresh count at the later `a60723c99c` head plus
whatever unrelated migrations landed on `main` between those two points — not
reconciled line-by-line here, disclosed as environment-local.)

```
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/attendance-w6-group-effective-policy.db.test.ts \
  tests/integration/attendance-w6-group-effective-policy-fixture-matrix.db.test.ts \
  tests/integration/attendance-w6-group-effective-policy-membership-overlap.db.test.ts \
  --reporter=dot
```
Result: **3 files / 57 tests passed** — identical file/test count to the W6-1
verification report, confirming W6-2/W6-3 did not touch this suite's behavior.

### 5.3 OD-W6-7 gate mutation self-check (host level)

Backup: `cp apps/web/src/views/attendance/AttendanceGroupContextHost.vue <backup>`.
Mutation: changed `const showEffectivePolicyPanel = computed(() =>
hasFeature('attendanceGroupEffectivePolicyPanel'))` to `computed(() => true)`.
Re-run: `pnpm --filter @metasheet/web exec vitest run
attendanceGroupContextHostEffectivePolicyGate attendanceGroupContextHost.spec`
→ **1 failed / 5 passed** — the "gate OFF (default)" case reds with `expected
<section ...> to be null`; `attendanceGroupContextHost.spec.ts`'s own 4 cases
stay green (they do not assert panel absence). Restore: `cp` from backup,
`diff` against backup exits clean, re-run green (2/2, 4/4).

### 5.4 Enum-parity mutation self-check (OpenAPI leg)

Backup: `cp packages/openapi/src/base.yml <backup>`. Mutation: appended a
sixth value (`mutated_extra_value`) to `AttendanceGroupEffectivePolicySourceLabel`'s
`enum:` list. Re-run: `vitest run tests/unit/attendance-w6-2-enum-parity.test.ts`
→ **61 passed / 1 failed** (`'OpenAPI base.yml enum equals the TS contract
set'` for `SourceLabel`), all 61 other cases stay green — confirms the
key-narrowing is scoped to that one field, not a flat file-wide match. Restore:
`cp` from backup, `diff` clean, re-run green (62/62).

### 5.5 §5.5 exhaustiveness mutation self-check

Backup: `cp apps/web/src/views/attendance/attendanceGroupEffectivePolicyLabels.ts <backup>`.
Mutation: deleted the `basics: (tr) => tr('Basics', '基本信息'),` line from
`DOMAIN_TEXT`. Re-run: `pnpm exec vue-tsc -b` in `apps/web` → reds:

```
src/views/attendance/attendanceGroupEffectivePolicyLabels.ts(126,7): error TS2741:
Property 'basics' is missing in type '{...}' but required in type
'Record<"rules" | "schedule" | "segments" | "basics" | "membership" | "flex" |
"punch_method" | "request_posture", (tr: TranslateFn) => string>'.
```

Restore: `cp` from backup, `diff` clean, re-run: `vue-tsc -b` clean (exit 0).

### 5.6 Contract/dist and CI-wiring gates

```
pnpm --filter @metasheet/openapi build && validate && generate:sdk
git diff --exit-code -- packages/openapi/dist packages/openapi/dist-sdk/index.d.ts
```
Result: fresh rebuild, exit 0 — byte-identical to what's committed.

```
node --test scripts/ops/attendance-w4c4-openapi-contract.test.mjs
```
Result: **3/3 passed.**

```
node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs
```
Result: **223/223 passed** — all three W6 real-DB suites remain represented
in both the no-DB exclusion and the executable real-DB run list.

```
node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
```
Result: **1/1 passed.**

```
pnpm --filter @metasheet/core-backend exec tsc --noEmit -p tsconfig.json
pnpm exec vue-tsc -b   # in apps/web
pnpm run lint          # in apps/web
```
Result: all three clean (zero diagnostics; zero lint warnings under
`--max-warnings=0`, scoped to the file list the lint script names, which
includes the touched `src/stores/featureFlags.ts`).

### 5.7 Full `attendance-web-guard.yml` targeted run-list — disclosed local execution gap

Reproducing the workflow's own `vitest run <50 named patterns>` command
verbatim (`apps/web`) OOM'd in this sandbox after **49 files / 931 tests**
passed, on a worker running `tests/attendance-admin-regressions.spec.ts`
(9,092 lines) in parallel with the other 48 files
(`ERR_WORKER_OUT_OF_MEMORY`; reproduced with default and raised
`NODE_OPTIONS=--max-old-space-size`, both hit the same limit — a sandbox
resource ceiling, not a product failure). Running the missing file in
isolation (`vitest run attendance-admin-regressions --reporter=dot`,
`NODE_OPTIONS=--max-old-space-size=8192`) passed **141/141**. **931 + 141 =
1072**, exactly matching the W6-3 PR body's claimed "50 files / 1072 tests"
— reproduced across two batches rather than the PR's single batch, and that
split is disclosed here rather than silently presented as one clean run.

## 6. Explicit residuals (known, non-blocking)

These are disclosed, not silently shipped, and none of them block "code
landed, gates green" per §7:

1. **FE flag-default is not pinned in any required CI check.**
   `apps/web/src/stores/featureFlags.ts` sets
   `DEFAULT_FEATURES.attendanceGroupEffectivePolicyPanel = false` (L83), and
   `extractFeaturesFromPayload`/`resolveFeatures` fall back to that default
   when the key is absent — but no spec anywhere in `apps/web/tests` asserts
   this default value for this specific flag (only
   `attendanceGroupContextHostEffectivePolicyGate.spec.ts` exists, and it
   *mocks* `hasFeature` rather than exercising the real default-resolution
   path). This is **not** codebase-wide absence: a directly analogous
   precedent exists and IS CI-wired —
   `apps/web/tests/featureFlagsApprovalMobile.spec.ts` (`'defaults
   approvalMobile OFF when the backend does not enable it'`) and
   `featureFlagsApprovalAttachments.spec.ts` are both present, and the latter
   is listed in `.github/workflows/approval-web-guard.yml`'s path filters and
   run list (verified: 3 occurrences). No equivalent file/wiring exists for
   `attendanceGroupEffectivePolicyPanel`. The real enforcement for this
   capability is on the backend: `w6-group-effective-policy-panel-flag.ts`'s
   two-layer predicate is exhaustively tested (12/12, including the
   null/undefined/blank-org fail-closed legs and the explicit no-wildcard
   leg) and is what actually decides the value the FE default could only ever
   be overridden away from. Non-blocking because the backend is
   fail-closed independent of the FE default; a fix would be a dedicated
   spec file analogous to `featureFlagsApprovalMobile.spec.ts`, wired into
   `attendance-web-guard.yml`.

2. **`group_stage` editorRef fidelity gap.** Every `group_stage` reference
   (`basics|people|schedule|policies`) resolves to the existing groups-list
   section (`ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO`), not to the specific
   stage tab, because no query-addressable deep link into a group-editor
   stage exists today (`selectAttendanceGroupStage` is a private ref with no
   external route contract). This is W6-R8-compliant — it mints no second
   navigation spelling and no caller-supplied section ID — but it is a real
   fidelity gap for `people`/`policies` conflict rows specifically: a user
   clicking "Resolve" on such a row lands on the groups list, not the exact
   stage. `group_context_route` refs (`schedule|calendar|rules`) do navigate
   precisely via the existing `buildAttendanceGroupRouteHref`.

3. **Authorization ledger gap.** The design-lock's own status header still
   reads "Every W6 slice beyond W6-1 remains **HOLD**", and §9/§10 list
   W6-2/W6-3/W6-4 as separate, un-granted acts. The in-session grant that
   authorized W6-2 and W6-3 has not been posted to issue #4556 as a durable
   comment (both merged PR bodies disclosed and recommended this). This
   report does not edit the design-lock and does not itself close that gap —
   it is recorded here as a residual for the owner/coordinating session to
   close via a durable ledger entry, consistent with this issue's own prior
   practice for W6-0/W6-1/#4876.

4. **Pre-existing, unrelated NIT (not introduced by W6-2/W6-3, flagged by
   W6-3's own PR body).** `attendance-web-guard.yml`'s bash `case` classifier
   is missing `attendance-decision-trace-metric.spec.ts` — present in the
   `push.paths` YAML list (L186) and in the `vitest run` command (L339) but
   absent from the bash pattern list (verified: zero match in the `case`
   block) — a live instance of the exact class of bug the F1/#3487 lesson
   warned about, pre-dating W6-3. Not fixed here; out of this slice's scope.

5. **W6-2 test-count NITs, already self-corrected within the PR's own commit
   history** (see §3.1, round 3): the enum-parity header's raw-stanza count
   (20→21) and an unqualified dist-sdk "22/22" claim (dropped from
   verification evidence, not CI-gated). No action needed here; recorded for
   completeness of the per-red-line table's provenance trail.

## 7. Completion boundary

W6 completion claims stop at "code landed, gates green"; enablement (the
OD-W6-7 flag flip), staging, soak, and #4556 closure remain separately
owner-gated. This report does not claim the group effective-policy panel is
enabled or shipped to users — it is default-OFF in every environment
(`ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED` unset, `DEFAULT_FEATURES.attendanceGroupEffectivePolicyPanel = false`),
and no action in this report changes that.

## 8. Stop condition

- W6-2 (#4893) and W6-3 (#4894) are merged (`6700494a9a`, `a60723c99c`),
  Draft/HOLD status resolved by their own separate owner-authorized merges,
  not by this report.
- This report performs no runtime, flag, deployment, staging, soak,
  production/customer data, or issue #4556 close action.
- Per design-lock §7.5, remaining before "W6-4 verification" can itself be
  considered closed: an independent adversarial review of this report against
  the actual merged code, and owner review of the completed W6 scope. This
  report's own PR stays Draft pending that gate.
