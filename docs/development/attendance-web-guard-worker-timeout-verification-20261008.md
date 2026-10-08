# attendance-web-guard worker timeout — design and verification — 2026-10-08

Owner-approved investigation (Harold, 2026-10-08). One concern: the required
`attendance-web-guard` check fails with vitest's `[vitest-worker]: Timeout calling "onTaskUpdate"`
while `apps/web/tests/attendance-admin-regressions.spec.ts` is still running. No assertion fails.
68/69 files and 1271/1371 tests are reported passed. Seen twice on PR #6051 head
`24bb31894916b13c390c9e4befd0520972562234` (merge of main `3884d49e90d1e4340b65a87d5bebbd3c5041307e`):

- attempt 1: https://github.com/zensgit/metasheet2/actions/runs/37637572836/job/112847700824
- attempt 2: https://github.com/zensgit/metasheet2/actions/runs/37637572836/job/112868309819

#6051 does not change attendance web code. This PR does not change the guard workflow,
`apps/web/vite.config.ts`, or `packages/core-backend/vitest.config.ts`.

## 1. Does it reproduce on main?

Yes. The attendance web tree executed by the guard is the same on main as on the failing merge.

| Tree | Spec lines | `AttendanceView.vue` lines | Guard result |
|---|---:|---:|---|
| Passing PR head `0d1a3a3c74bc0362b056c00fc29c9a64f03e7bba` (already contained main `7137688372c07a32fc992d8d73deca3a92a9ed3c`) | 9315 | same bytes as the failing tree for every guarded attendance path | pass, 69/69 files, 1371/1371 tests, duration 99.91s. Run https://github.com/zensgit/metasheet2/actions/runs/37628940500/job/112817862231 |
| Failing merge `24bb31894916b13c390c9e4befd0520972562234` of main `3884d49e90` | 9315 | 33143 | fail twice, 68/69 files, 1271/1371 tests, duration 247.43s, 16 `onTaskUpdate` timeouts |
| main `3884d49e90` and current main `afd32b704c6ff4c82dbfe90b94066fcaf3fc0074` | 9315 | 33143 | attendance files byte-identical to the failing merge |

`git diff 0d1a3a3c74 24bb318949 -- apps/web` is only stock-prep fixture text (8 files, placeholder
replacement, PR #6245). The single commit between those trees is
`3884d49e9 chore(stock-prep): synthetic fixture values…`. No attendance spec, view, or guard
workflow byte changed. The earlier head of the same PR had already run the real vitest step
(not the "unrelated changes" skip) and passed.

The spec file itself last changed on 2026-09-12 (`7c9885336`, #5661) and has stayed 9315 lines /
144 tests since. What grew around it is `AttendanceView.vue` (32988 lines at that commit, 33143
now), including the 1s hero-clock interval added in #3738 (`f5bd8d5a9`, 2026-07-07). The guard's
targeted list is still one worker (`--maxWorkers=2`) stuck on this single file for the whole run.

Main pushes of the workflow since 2026-10-01 did not re-execute the suite: `push` is path-filtered,
and no later main commit touched a guarded attendance path. The two red runs are therefore the
latest executions of main's attendance suite, on a runner whose startup phase was about 2.5× the
passing run (environment 55.17s vs 19.29s, collect 33.93s vs 14.61s, wall clock 247.43s vs 99.91s).

Local idle reproduction of the unmodified spec (same `--maxWorkers=2 --minWorkers=1`,
`NODE_OPTIONS=--max-old-space-size=8192`, `CI=true`) passed: 144/144, duration 69.00s, tests
63.92s. It does not trip the 60s RPC budget on an idle machine. The failure is the same suite
crossing that budget when the runner is slow. That is main, not #6051.

## 2. Root cause

vitest 1.6.1 (birpc `DEFAULT_TIMEOUT` 60s) has the worker call `onTaskUpdate` and wait for the
main thread's ack. The runner debounces that send by 10ms (`setTimeout` in `@vitest/runner`).
The worker only reads the ack when the event loop reaches the poll phase.

This spec does not yield to that phase between mounts:

- `flushUi()` is `Promise.resolve()` + `nextTick()` only (microtasks).
- Each test mounts the full `AttendanceView` with `createApp` and no router. `useRouter()` is
  `inject(routerKey)` with no default, so Vue warns `injection "Symbol(router)" not found` on
  every mount. Measured locally: 141 warns in one file. Vitest forwards each warn on the worker
  RPC. The in-repo note of the same failure shape is
  `docs/development/takeover-beiliao-20260821/autonomous-24h-run-20260915.md` (the warn flood
  fills the RPC until `onTaskUpdate` times out with assertions still green).
- `onMounted` starts `setInterval(() => { heroClockNow.value = new Date() }, 1000)`. A tick
  re-renders the whole view. `onUnmounted` clears it, so it is not a leak across tests, but while
  a test is in `vi.waitFor` the interval is live. If a tick's render runs longer than 1000ms, Node
  stays in the timers phase and does not read the RPC ack. The 60s timer then fires first and
  rejects `onTaskUpdate`.

On the failing attempt the worker was still inside this file (last attributed tests include
`restores template version details and import batch diagnostics from the split admin sections`).
16 unhandled `onTaskUpdate` timeouts were reported together. No test assertion failed.
`PromiseRejectionHandledWarning` (rejection ids 9–19) was logged once during the same stretch;
it is a symptom of promises settled after they were already unhandled, not a separate assertion.

The fix stays in the spec. It does not raise timeouts, skip tests, or change pool settings.

## 3. Change

`apps/web/tests/attendance-admin-regressions.spec.ts` only:

1. `createAttendanceApp` wraps `createApp` and `provide(routerKey, undefined)` before mount.
   `useRouter()` therefore resolves to `undefined` without the injection warn, and
   `onAdminTaskHomeNavigate` stays on the `window.location.assign` fallback this file already
   covers. No test installs a real router here, so no assertion changes path.
2. `beforeEach` awaits a 20ms macrotask (`drainWorkerRpc`) so the previous test's debounced
   `onTaskUpdate` can be sent and acked before the next mount. The longest single test locally
   is about 2s, so the in-flight RPC window stays one test, not the whole file.
3. `beforeEach` replaces `window.setInterval` only for the 1000ms handler whose source contains
   `heroClockNow`, and `afterEach` restores it after `unmount`. Other intervals are unchanged.
   A one-test probe logged the silence once for the overview mount, then the probe log was removed.

Assertions, test names, and the guard's vitest token list are unchanged. File count stays 69.
Test count stays 1371 (144 of them in this spec).

## 4. Local verification

Command (same worker flags as the guard step):

```bash
cd apps/web
CI=true NODE_OPTIONS=--max-old-space-size=8192 \
  pnpm exec vitest run --maxWorkers=2 --minWorkers=1 \
  tests/attendance-admin-regressions.spec.ts --reporter=dot
```

Unmodified spec, once: 144 passed, duration 69.00s, 141 `Symbol(router)` warns.

Fixed spec, five runs, all exit 0, 144 passed, 0 router warns on the checked log:

| Run | Wall | Vitest duration | tests time |
|---:|---:|---:|---:|
| 1 | 70s | 69.65s | 65.14s |
| 2 | 69s | 68.26s | 63.25s |
| 3 | 70s | 69.40s | 64.17s |
| 4 | 71s | 69.69s | 64.65s |
| 5 | 73s | 72.22s | 67.56s |

Full guard token list (the `vitest run --maxWorkers=2 --minWorkers=1 … --reporter=dot` line in
`.github/workflows/attendance-web-guard.yml`, `CI=true`, `NODE_OPTIONS=--max-old-space-size=8192`):

```text
Test Files  69 passed (69)
     Tests  1371 passed (1371)
  Duration  92.63s (transform 5.55s, setup 525ms, collect 15.80s, tests 131.70s, environment 22.52s, prepare 4.07s)
```

Exit 0. File count and test count match the last green CI run of this step (69 / 1371). The
passing CI run's duration was 99.91s; this local run is 92.63s. The two red runs stopped at
247.43s with 68/69 and 1271/1371.

## 5. Out of scope

`test (20.x)` on main `3884d49e90` (push run
https://github.com/zensgit/metasheet2/actions/runs/37635536027 , job
https://github.com/zensgit/metasheet2/actions/runs/37635536027/job/112840651859 )
died in `apps/web type-check` / `vue-tsc -b` with `Reached heap limit Allocation failed -
JavaScript heap out of memory`. That is a separate PR. Not touched here.

`test (18.x)` still existed on that same push and passed (job
https://github.com/zensgit/metasheet2/actions/runs/37635536027/job/112840652009 ).
Current main dropped the 18.x matrix leg (`plugin-tests.yml` keeps a one-entry `[20.x]` matrix
so the required check name stays `test (20.x)`). A PR based on current main therefore has no
`test (18.x)` job.

## 6. CI on the first PR head

Head `0f15a310ade568ecdba8666b9b673cb6841f2443` (parent of the alignment merge below).
`attendance-web-guard` attempt 1, targeted vitest step: 69 passed (69), 1371 passed (1371),
duration 254.45s. Job https://github.com/zensgit/metasheet2/actions/runs/37715093672/job/113109641098 .
The thirteen required checks on that head all passed on attempt 1. Workflow file diff: none.

## 7. Alignment onto main `9eee3a3cd` (Harold, 2026-10-08)

Fetched `origin/main` before the merge. It was exactly
`9eee3a3cd0e734f6a4abb972068f4f535eb08ebf`. Nothing newer than that tip was on `main`.
Previous base was `afd32b704c6ff4c82dbfe90b94066fcaf3fc0074`. The three commits in between
were merged with `git merge` (no rebase, no force push). The merge had no conflicts, including
none in this file or in `apps/web/tests/attendance-admin-regressions.spec.ts`.

| Commit | What it changes | Sensitive paths |
|---|---|---|
| `317cf60d9042cd8f7df4c593fa010986025927a8` | Docs only: `docs/development/takeover-beiliao-20260821/customer-reply-20260924.md` | none |
| `644310ba60953b021d85ae393d94ef3408e25cb9` | Business-timezone day for date-only leftovers. `apps/web/src/multitable/import/delimited.ts`, `apps/web/src/multitable/utils/business-timezone.ts`, `apps/web/src/multitable/utils/conditional-formatting.ts`, `apps/web/src/multitable/utils/field-display.ts`, `apps/web/tests/multitable-conditional-formatting.spec.ts`, `apps/web/tests/multitable-datetime-business-tz.spec.ts`, `apps/web/tests/multitable-field-display-i18n.spec.ts`, `docs/development/takeover-beiliao-20260821/decision-register.md`, `packages/core-backend/src/multitable/date-time-wall-clock.ts`, `packages/core-backend/src/routes/univer-meta.ts`, `packages/core-backend/tests/integration/multitable-xlsx-routes.test.ts`, `packages/core-backend/tests/unit/multitable-datetime-wall-clock.test.ts`, `packages/core-backend/tests/unit/multitable-view-filter-operators.test.ts` | `packages/core-backend/src/routes/univer-meta.ts` (loaded by the manual checkpoint script). No workflow, `vitest.config.ts`, migration, pins file, drain helper, timemachine script, `recovery-archive-contract.ts`, `src/index.ts`, or `http-routes.cjs` |
| `9eee3a3cd0e734f6a4abb972068f4f535eb08ebf` | Access presets stop granting unregistered `workflow:read`. `packages/core-backend/src/auth/access-presets.ts`, `packages/core-backend/tests/integration/multitable-permmatrix-b4-g8-comments-visibility-realdb.test.ts`, `packages/core-backend/tests/unit/access-presets-permission-catalogue.guard.test.ts`, `packages/core-backend/tests/unit/admin-users-create-preset-grant-failure.test.ts` | none. The guard reads the catalogue from existing migrations; this commit does not change a migration file |

The three web specs added by `644310ba6` are `multitable-conditional-formatting.spec.ts`,
`multitable-datetime-business-tz.spec.ts`, and `multitable-field-display-i18n.spec.ts`.
