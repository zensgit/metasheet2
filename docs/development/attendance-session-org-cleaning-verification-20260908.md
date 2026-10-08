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

## September 9 repair-batch evidence addendum

The preceding section is the pre-publication snapshot. Draft #5575 was published at `8603df96e8a65537fec14c5be13624d4bfc7db31`. Its failed checks are retained, not rerun or relabeled:

- Stock-prep run `34250171993`, job `102142276736`: ownership guard 5 PASS / 1 FAIL, missing transitive dependency `apps/web/src/utils/explicitSessionOrg.ts` in its classifier.
- Attendance run `34250172248`, job `102142278263`: three suites, 47 tests / 10 failures (override 23/6, preview 17/2, caliber 7/2). Other remote jobs were still running at the last pre-checkpoint read; no terminal CI-green claim is made.
- Independent consumer review identified late punch, cleaning and mount continuations. The shared-auth review was closed without a terminal verdict; it is **not** an approval.

### Refute-first repair evidence

With unchanged 8603 product code, new/strengthened tests produced seven discriminating failures: punch body resolve/reject cleared the note (2); cleaning body resolve/reject cleared the selection (2); late identity and plugin resolve/reject mutated mount state (3). Before-send confirmation remained passing. The sent-action tests wait until the actual mocked body reader is entered, then change/invalidate the page session and settle the body. They assert state preservation and no follow-up requests, not server-side rollback. Busy flags are asserted released.

After the bounded two-component repair, the selected eight tests pass. Three mutation runs independently neutralized the punch protection (2 RED), the mount-continuation family (3 RED), and the cleaning catch/finalizer protection (2 RED). Every process reached terminal before restoring code; restored selected tests are 8/8 PASS.

The old CI trio independently reproduced 37 PASS / 10 FAIL locally. The caliber tests now provide an explicit synthetic root scope. Import tests wait for the specific preview-ready button, settled operation, or diagnostic before checking the original assertions. No timeout increase, payload/count assertion removal, or product import change was used. First repair rerun was 46 PASS / 1 FAIL: the truncated-sample test's second preview exposed the same premature read. Adding that completion wait yielded **47/47 PASS**, retaining both denied sample-derived backup and allowed explicit-user backup assertions.

Stock-prep's unchanged six-test guard ran RED (missing the exact path), GREEN after the single case addition, RED after removing that addition, and restored **6/6 GREEN**. No guard/ownership rule was edited.

### Final local gates for the repair source

All gates below bind the eight-file binary-diff SHA256 `1948e73d0b33ca7ba7ef2d9fcf1cb734b62755e6d5975828306498a674b1c6bb` against 8603; documents were appended afterwards.

- Parsed and executed the workflow's actual `Run attendance web guard specs (targeted)` command, unchanged argv/env: **65 files / 1,290 tests PASS**, including Admin 144, self-service 65 and ReportFields 44. Duration 49.29s.
- Auth/session/API/approval neighbor group: **6 files / 142 tests PASS**.
- Real application `vue-tsc --noEmit -p tsconfig.app.json`: exit 0.
- ESLint across all 21 changed web source files: no findings outside AttendanceView; its 16 findings equal exact main by ruleId, message and trimmed source line. Both candidate and baseline lint exit 1; this is baseline equivalence, not whole-source lint PASS.
- Original `bash apps/web/scripts/run-required-web-tests.sh`, Node 20 and offline npm, unchanged grouping: exit 0. Fourteen file/test execution groups: **4/55, 35/620, 1/23, 2/21, 2/28, 6/58, 27/376, 3/185, 2/95, 2/7, 2/71, 1/9, 4/107, 436/6035**. Total **527 file executions / 7,690 test executions**, not unique counts. Before/after diff hashes are identical. Mocked network/dynamic-import error text appears in output, but all groups and the command terminate successfully.
- Official live package provenance versus frozen manifest: equal, no pin changes. `git diff --check`: exit 0.

No local DB/browser was started during this repair batch. The changed product source still requires the coordinated late-action synthetic tail and final review; old e007 runtime evidence is historical, not a repaired-head run. Local checkpoint identifiers are reported separately in the task handoff. No repair push/remote CI success, Ready, main merge, UAT, deployment or persistent flag enablement is implied.

## Final repaired-product synthetic tail

After the repair batch, a separately authorized isolated runtime exercised frozen `763e4740055af8d972be5d6f572acba7c4184406`, tree `89cd5de59e0b1599b0079caee011936049fcfdc4`. This final documentation-only child preserves that product tree. Terra's narrow re-review of the two repaired components and dedicated tests reported P1/P2/P3 = 0; this is not full-delivery independent approval. Sol remains NO VERDICT.

Final local runner SHA256: `1c12cd8ffa89e94282a93b85493fc7c546fc919999425ee6c475b0e54ae19e28`. Invocation: `node_modules/.bin/tsx tmp/session-org-diagnostic/run.mts /opt/homebrew/opt/postgresql@15/bin late-actions` under Node 20. Existing dependencies, fresh nonce-owned PostgreSQL, real backend/Vite/login and Chromium, loopback-only network; maximum two contexts/three pages. The extended runner remains ignored local evidence, not a repository-only reproduction claim.

Final result: `tmp/session-org-diagnostic/evidence-93faac47a9bd48bc92fd90784889c754/result.json`, **5 events / 366 request records**, exit 0, `LATE_ACTIONS_PASS`:

- Synthetic geofence/outdoor-note settings produced a real 422 `OUTDOOR_NOTE_REQUIRED`. Keyboard note retry returned a real 422 `OUTDOOR_APPROVAL_FLOW_REQUIRED` because no approval flow was created. This is a refused punch, **not a successful punch**. The actual backend response was held before client consumption; another real tab selected B before release. Note/status remained, punching released, old-page follow-ups were 0, and the refused attempt's DB delta was 0.
- Actual multitable proposal edit/review/apply reached the backend and returned 200 before delivery was released. A's edit, completed operation and event each increased by one, canonical status became normal, custom data remained. After B selection and release, selection/message remained and busy released. Calling the old mounted callback sent no second apply. Old-page follow-ups were 0 and the post-switch snapshot added no effects. This does **not** claim zero writes for the lawful first apply.
- Explicit selection back to A and reload produced 47 separately counted requests; the consumed proposal disappeared, DB state stayed unchanged, and the actual grid-cell text retained the custom value. The screenshot `late-reloaded-table.png` is a narrow viewport at the drawer top and does not visually display that custom field; do not cite it as a custom-field viewport proof. `late-cleaning-selection.png` shows the retained review. The punch screenshot shows the stale-page notice, retained note input and original note-required status.

The first run remains intact at `evidence-09a7734fb2ba4e2bbd3e38faa23bbb34/result.json`, runner SHA256 `9434e5537302ad1ff8af3871024209e74fb59554c366a190dcbc98574576f8f7`. Its zero-follow-up assertion passed before reload, but its final mutable counter incorrectly included the 47 explicit-reload requests. That reporting-window defect was fixed in the runner, not product code, and verified with the fresh final nonce above. The original output was not rewritten.

Final owned PGDATA suffix `acp-full-pg-wNQHPW/data`, ports 53145/53157/5173: cleanup reported databases/backends/ports 0; independent connection probes returned ECONNREFUSED on all three and process inspection found no owned runner/PG residue. Tracked source stayed clean at 763e. No other DB, customer data, persistent settings or deployment was touched. Updated-head remote CI is still pending; old 8603 failures remain historical evidence rather than a green claim.
