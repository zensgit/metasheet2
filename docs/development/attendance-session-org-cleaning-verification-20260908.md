# Attendance organization session and cleaning: verification

Prepared in the **2026-09-09 local delivery window**; September 8 browser evidence retains its original provenance. Companion: [development](attendance-session-org-cleaning-development-20260908.md).

## Evidence layers

The product checkpoint is `5f4b643b786bc3986a6398989e7839bfc223eea9`. Real-browser evidence runs on pinned combined `e007096c1af1de5012b2897fb2ea474be3dc6f47`, not on the later delivery integration `d20466b4d5ebfcc5aa7fc8efbd50ef29bc7ba308`. Product equality permits bounded inheritance of that evidence; **the browser suite was not rerun on delivery/main**. The integration also includes unrelated main changes.

Local evidence root: `/private/tmp/codex-attendance-session-org-combined-20260908/tmp/session-org-diagnostic/`. This is local-session material, not a permanent GitHub artifact. Extended `run.mts` is intentionally uncommitted. Its invocation below is **not** a repository-only, one-command reproduction claim. The committed #5566 harness supplies the reused real UI flow and fixture; the local extension supplies session-switch cases.

## Local gates and retained failures

Node used: `/Users/chouhua/.nvm/versions/node/v20.20.2/bin`. Existing dependencies only.

- Product checkpoint's final selected suites have separate PASS evidence. The combined 18-spec single-fork command was **444 PASS / 57 FAIL**, not green: Admin defines `HTMLElement.prototype.scrollIntoView` without writable; self-service's setup/teardown then assigns it. Unchanged-code isolated self-service was 60/60 PASS. No product workaround or assertion weakening hides that fixture collision.
- Earlier Admin default-worker attempt exhausted memory. The repository's established 8192 MiB/single-fork admin lane was used subsequently. Seventeen asynchronous admin tests were changed only to wait for their specific visible completion/readiness conditions; payload/count/security assertions remained. Admin 144/144 passed.
- Earlier plain `vue-tsc --noEmit` targeted a references-only config and was not a real app check. That claim was withdrawn. Only `vue-tsc --noEmit -p tsconfig.app.json` counts as application typechecking.
- CI-tail contract first RED: 17 failures. After wiring: contract 23/23 and four session suites 55/55 (78 total). Domain `pnpm --filter @metasheet/web exec vitest run` and required-style `npx --no-install vitest run` each collected the same four suites/55 tests with the exact session argv.
- CI mutation: four new spec arguments removed independently from each of domain/required commands (8 RED), plus eight source triggers removed independently from push/PR selectors (16 RED), total **24/24 RED**, restored. An initial orchestration attempt restored a mutation before observing its process terminal; it is discarded as evidence. No owned process remained before the clean 24-run series; each subsequent mutation waited for terminal exit before restoration.
- Delivery integration plus CI diff: 14 auth/API/approval/attendance/contract neighbor suites **266/266 PASS**; isolated self-service **60/60 PASS**.
- CI diff fingerprint before local gates: `161878a3185d77ada7796cc5f5e2e712c3df968ea76aef985614bd30e83e19d7`; three files, 62 insertions, zero deletions. Formal documents do not change product/test behavior.

Actual session argv:

```text
tests/useAuth.spec.ts tests/useSessionOrg.spec.ts
tests/AttendanceSessionOrgSwitcher.spec.ts tests/useAttendanceSessionGuard.spec.ts
--pool=forks --poolOptions.forks.singleFork=true --reporter=dot
```

Final delivery app typecheck `vue-tsc --noEmit -p tsconfig.app.json`: exit 0. Six shared/session source files (authPrincipal/useAuth/useSessionOrg/useAttendanceSessionGuard/api/explicitSessionOrg) ESLint with `--max-warnings=0`: exit 0. Broader source lint is **not green**; baseline-equivalent debt is itemized below.

Full required invocation, unchanged repository grouping:

```text
PATH=/Users/chouhua/.nvm/versions/node/v20.20.2/bin:$PATH NPM_CONFIG_OFFLINE=true bash apps/web/scripts/run-required-web-tests.sh
```

Exit 0, start 00:08:40 on September 9; 14 completed groups. File/test execution counts by group: **4/55, 35/619, 1/23, 2/21, 2/28, 6/58, 27/376, 3/185, 2/95, 2/7, 2/71, 1/9, 4/107, 436/6035**. Sum: **527 file executions / 7,689 test executions**, not deduplicated suite/test counts. Last group duration 63.49s; the full script is longer than this final-group duration. Vue fixture warnings and expected mocked-error logs appeared; terminal groups all passed. The earlier Admin/self-service ad-hoc single-fork collision did not occur in this authoritative grouped command and is still retained above. No grouping or suite deletion was used to avoid it.

The selected CI diff fingerprint remained `161878a3185d77ada7796cc5f5e2e712c3df968ea76aef985614bd30e83e19d7` before/after; source/CI/tests were not edited during execution. Documentation was finalized afterwards. `git diff --check`: exit 0.

### Broader source lint: equal pre-existing debt, not PASS

ESLint over every changed web source reported 15 errors and one warning, all in AttendanceView.vue. The exact main file was piped through the same ESLint config and then both JSON results were normalized by **ruleId + diagnostic message (including symbol) + trimmed source line**, ignoring line-number movement: candidate16/main16, **differenceCount=0**. A first comparison helper hit Node's default child-process output buffer limit when reading this large source; it was rerun with an explicit 16 MiB buffer. That failed probe is not lint evidence.

Every row below is identical in candidate and exact main `97dc5cefaef6ac11020d83851312f7fc0a812435`:

| Rule | Symbol / source context | Comparison |
| --- | --- | --- |
| @typescript-eslint/no-unused-vars | `adminNavDefaultStorageScope,` | equal |
| same | `adminNavScopeFeedback,` | equal |
| same | `adminSectionFilter,` | equal |
| same | `adminSectionFilterActive,` | equal |
| same | `adminSectionNavCountLabel,` | equal |
| same | `allAdminSectionGroupsCollapsed,` | equal |
| same | `allAdminSectionGroupsExpanded,` | equal |
| same | `interface AttendanceImportBatch {` | equal |
| same | `interface AttendanceImportItem {` | equal |
| same | `collapseAllAdminSectionGroups,` | equal |
| same | `copyCurrentAdminSectionLink,` | equal |
| same | `expandAllAdminSectionGroups,` | equal |
| same | `function formatMetaMinutes(meta: Record<string, any> ...` | full source line equal |
| same | `const holidayMap = computed(() => {` | equal |
| @typescript-eslint/prefer-as-const | `minConfidence: 'high' as 'high',` | equal |
| vue/no-v-html (warning) | static bilingual `engine.templates[].rules[]` help markup | full source line equal |

No unrelated lint debt was modified or waived into a green lint claim.

### Official package provenance

Read-only `computePackageProvenancePinSet(process.cwd())` from `plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs` was recursively compared with its exported `FROZEN_MANIFEST_RELATIVE` JSON, same keys and array ordering: **differenceCount=0, fields=[]**. No pins were refreshed. This is package-union consistency, not attendance runtime evidence.

## Real browser, real server, isolated PostgreSQL

Each run used a new nonce-owned private PG/database, real backend and actual Vite index/router/LoginView, loopback-only network, one Chromium, bounded execution/cleanup, no customer data. Temporary setup context has sheet-only authority; reviewer permissions do not grow. Peak two contexts/three pages was recorded. Local test-only cleaning settings are not persistent environment flag enablement.

| Run | Evidence directory suffix | Runner SHA256 | Outcome |
| --- | --- | --- | --- |
| Initial compatibility | `d405f909e1a643a2916dc639b9f8debc` | `852e107523006ba283716af723f95baf813766d666ba25cfe642719ea96cb8aa` | Compatibility PASS only |
| First full chain | `bdce0bbc5f224a8ea28941c9290ed677` | `3012b25c0bb9bad689ff8e7d26899fcf10be8eebce166618e2865ba27943caec` | BASELINE_PASS |
| Disconnected apply | `1f861bc62026485a998e19bd2c73bc71` | `091920d67da837b27148f6fce59a843d7f439e579c671ba965793c0e194bacd5` | Expected RED, 404, zero write |
| Foreign-tenant apply | `f14e0f111c3741719930348d6325e033` | same as preceding row | Expected RED, 403 ATTENDANCE_CLEANING_FORBIDDEN, zero write |
| Final full chain | `77c3775aea7c46a28a7319377f0dd4b2` | `1c8ad0eafd1c1096a9114a59f271f858a3caeba8276866c072cad186ac9c209e` | BASELINE_PASS, 14 events/314 request records |
| Old confirmation/keyboard draft | `702885a590c64505bd590ac76d825fd3` | `aa1191eda07f942c80bf006417814d951348312a0c35cc6d760f8ed382658323` | OLD_CONFIRM_PASS, 9 events/310 request records |

Directory names are `evidence-<suffix>`. Final full-chain and old-confirm directories contain `result.json`; earlier runs retain screenshots/tool output, not fabricated retroactive JSON logs. Request records keep method, stage and normalized path shape/header-presence/query-count, not credentials or raw values.

Local invocation used Node 20 PATH and:

```text
node_modules/.bin/tsx tmp/session-org-diagnostic/run.mts /opt/homebrew/opt/postgresql@15/bin [mode]
```

Mode is omitted for positive, or `disconnect-apply`, `foreign-tenant`, `old-confirm` for the named controls. The extended runner must already exist locally; see the reproducibility limitation above.

### Assertions actually observed

1. Real login and active-membership UI choice B; signed `/auth/me`, effective headers and query agree on B. Ordinary persisted hint remains A. B records/calendar return 200; no B canonical records were invented.
2. Real A response is received from backend, delayed before client consumption, then B is selected; old `loadRecords` rejects the response and preserves state. This is result isolation, not cancellation of server work.
3. Old mounted punch callback after B and A-B-A sends nothing and preserves its synthetic draft. This initial leg set component state; it is not the keyboard evidence.
4. Final keyboard leg prepares a real A cleaning review, types an unsaved user-filter draft with `pressSequentially`, switches another tab to B, verifies old confirm has an inert ancestor/stale notice, then presses Enter. No send. Separate invocation of the actual mounted `applyCleaningProposal` also sends nothing; visible input and reviewed proposal remain. DB canonical/projection/version/effect snapshot is unchanged. Explicit discard/reload makes B readable.
5. Return to valid member org A and actual catalog/report sync → real multitable popup → setup actor creates custom field in UI → user edits reason and cleaning checkbox. No proposal is preseeded in place of UI action; canonical/effect state is unchanged before review confirmation.
6. Real same-org review/confirm changes eligible result to normal: edit/completed operation/manual override calculation/event each one, notifications zero. Raw punch and leave/travel facts are not edited.
7. Same-org old reviewed version retry returns 503 ATTENDANCE_CLEANING_UNAVAILABLE; relative to its own pre-attempt snapshot, no further effect. Consumed proposal disappears on reload.
8. Custom value survives apply and resync; resync adds no canonical effect. Actual table UI retains it and clears requested flag. Actual attendance report returns one Normal row, including narrow viewport cell visibility.
9. Nonmember/revoked org switch is refused with session unchanged. Foreign read canary returns 403 without disclosure. Revoked confirmation returns 403. Negative snapshot comparisons are local to each attempted action, not a false claim of zero writes across earlier lawful positive actions.
10. Disconnected/foreign apply mutations make the real workflow fail at APPLY_HTTP_STATUS, with the entire before/after snapshot unchanged. These expected failures are never labeled positive PASS.

### Cleanup and screenshot review

All six rows above reported owned DB/backends/listening ports zero; independent process/listener checks found no owned residue. Full-chain final ports: 53066/53088/5173; PGDATA nonce directory `acp-full-pg-6citgv/data`. Old-confirm ports: 54803/54825/5173; PGDATA `acp-full-pg-sHsxuJ/data`. No shared PG/store cleanup was performed. Free disk rose during other work; no reclaimed-space credit is claimed by this task.

Visually reviewed local final screenshots: `desktop-review-section.png`, `narrow-canonical-cell.png`, `switched-stale-alert.png`; old-confirm screenshots: `old-cleaning-confirm-stale.png`, `keyboard-draft-preserved.png`. They show the actual review, Normal result and stale/draft behavior. Full-screen internal captures contain only synthetic UUIDs and are not values-free public artifacts.

## Outstanding delivery gates

Local gates above are terminal. CI and documentation are separate local commits in the delivery branch; their final IDs are reported in the task handoff (avoiding a self-referential documentation commit hash). No remote exact-head CI, main merge, main runtime rerun, user-site UAT, deployment or persistent flag validation is claimed. Frozen #5145/#5559/#5564/#5566 are unchanged at the recorded readback. Draft publication requires coordination; green local evidence alone is not publication/Ready/merge authority.
