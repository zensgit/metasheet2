# Multitable M0 Extraction — Verification Notes (2026-04-21)

> Document type: verification / status
> Date: 2026-04-21
> Branch: `codex/multitable-m0-extraction-20260421`
> Worktree: `/Users/chouhua/Downloads/Github/metasheet2/.worktrees/multitable-m0`
> Baseline: `6c5c652d1` (= `origin/main` HEAD)

## TL;DR

- Outcome: **BLOCKED, no code changes, no commit.**
- Reason: target files already exist on `main`; inline copies in `univer-meta.ts` have drifted and cannot be deleted as a "pure move" per the task brief's rule 1.
- See companion document: `multitable-m0-extraction-development-20260421.md`.

## 1. Baseline confirmation

```
$ git log --oneline -3
6c5c652d1 feat(infra): add Redis runtime stores for token bucket and circuit breaker (#1016)
c6caa537b feat(approval): wire any-mode aggregation runtime (#1015)
bac834a6c feat(admin-audit): wire audit log UI to backend (#1014)

$ git branch --show-current
codex/multitable-m0-extraction-20260421

$ git merge-base HEAD origin/main
6c5c652d1086674772ae78cc451f057563bb69b4

$ git merge-base --is-ancestor 2206cc45b origin/main && echo "ancestor"
ancestor
```

Confirms:
- HEAD = `origin/main` HEAD.
- Historical commits `2206cc45b` (extract access and loader helpers), `9aa1b8725` (provisioning views and install shell), `8da4c02c8`, `3f3079490` are all ancestors of `origin/main`.
- The M0 deliverables are already on `main`.

## 2. Install

```
$ pnpm install --prefer-offline
Done in 4.5s using pnpm v10.33.0
```

No errors. No deprecation flags relevant to this task.

## 3. Target file inventory

```
$ ls packages/core-backend/src/multitable/
access.ts
loaders.ts
provisioning.ts
(and many others — field-codecs.ts, record-write-service.ts, etc.)

$ ls packages/core-backend/tests/unit/multitable-*.test.ts
multitable-access.test.ts
multitable-loaders.test.ts
multitable-provisioning.test.ts
(and others)
```

All six artifacts the task brief asked to create already exist on `main`.

## 4. Verification commands — NOT EXECUTED

Per the task brief, verification should include:

```
# TypeScript check
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false

# New unit tests (already exist on main, not introduced this session)
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-provisioning.test.ts \
  tests/unit/multitable-loaders.test.ts \
  tests/unit/multitable-access.test.ts --reporter=dot

# Full core-backend unit suite — MUST pass (zero regressions)
pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot

# Multitable integration smoke
pnpm --filter @metasheet/core-backend exec vitest run tests/integration --reporter=dot
```

Rationale for skipping: **no code was changed this session**, so these checks would only verify the state of `main` at `6c5c652d1`, not anything this session produced. Running them would consume time without answering the task's actual question, which is the blocker described in section 5. If the user selects Path A or Path B (see development MD section 5), the full verification battery becomes appropriate and should be run at that point.

## 5. Blocker summary

`packages/core-backend/src/routes/univer-meta.ts` contains inline duplicate helpers at:

- L1803 `tryResolveView` — uses module-level cache, 2-arg signature
- L1939 `resolveRequestAccess` — returns `{ userId, permissions, isAdminRole }`
- L1972 `deriveCapabilities` — returns 10-field `MultitableCapabilities` including `canManageSheetAccess`, `canExport`
- L3162 `ensureLegacyBase` — identical to module
- L3310 `loadSheetRow` — identical shape to module
- L3328 `loadFieldsForSheet` — takes `query: QueryFn` directly, not `{ query }`

The module copies have **different** signatures:

- `multitable/access.ts::resolveRequestAccess` returns `{ permissions, isAdminRole }` — **no `userId`**
- `multitable/access.ts::MultitableCapabilities` has 8 fields — **missing `canManageSheetAccess` and `canExport`**
- `multitable/loaders.ts::loadFieldsForSheet` takes `(pool: { query }, sheetId, cache?)`
- `multitable/loaders.ts::tryResolveView` takes caller-provided cache

Call-site evidence in `univer-meta.ts`:

```
$ grep -n 'access\.userId\|canManageSheetAccess\|canExport' packages/core-backend/src/routes/univer-meta.ts | wc -l
18
```

18 call sites read these fields. Dropping them in favor of the module shapes would be a TypeScript break and an HTTP response contract change. Therefore a "pure move" as defined in the task brief's rule 1 is not achievable.

## 6. What would need to happen to unblock

User picks one of (Path A / Path B / Path C) described in
`multitable-m0-extraction-development-20260421.md` section 5. Path A (additive widening of the shared modules, then delete inline duplicates) is recommended.

## 7. Artifacts produced this session

- `docs/development/multitable-m0-extraction-development-20260421.md`
- `docs/development/multitable-m0-extraction-verification-20260421.md` (this file)

No other files were created or modified. No commit.

---

## Path A execution — 2026-04-21

Path A executed after sign-off. All verification gates green.

### 1. TypeScript

```
$ pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
exit=0  (no output, no errors)

$ pnpm --filter @metasheet/web exec vue-tsc --noEmit
exit=0  (no output, no errors)
```

### 2. Multitable targeted unit tests

```
$ pnpm --filter @metasheet/core-backend exec vitest run \
    tests/unit/multitable-provisioning.test.ts \
    tests/unit/multitable-loaders.test.ts \
    tests/unit/multitable-access.test.ts --reporter=dot

 ✓ tests/unit/multitable-access.test.ts        (8 tests) 3ms   [was 5; +3]
 ✓ tests/unit/multitable-provisioning.test.ts  (7 tests) 3ms   [unchanged]
 ✓ tests/unit/multitable-loaders.test.ts       (7 tests) 2ms   [was 3; +4]

 Test Files  3 passed (3)
      Tests  22 passed (22)
```

### 3. Full core-backend unit suite

```
$ pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot

 Test Files  121 passed (121)
      Tests  1568 passed (1568)
   Duration  5.67s
```

Baseline at `6c5c652d1` (measured in-session via `git stash` of Path A source + test edits, then re-run):

```
 Test Files  121 passed (121)
      Tests  1561 passed (1561)
   Duration  5.84s
```

**Net delta: +7 new tests (3 access + 4 loader), 0 regressions, all 1561 baseline cases continue to pass.** Three `.toEqual`-on-exact-shape assertions inside the existing multitable-access tests were updated in-place to reflect the widened return shape of `resolveRequestAccess` (adds `userId`) and `deriveCapabilities` (adds `canManageSheetAccess`, `canExport`); those three assertions are counted within the baseline 1561 and are green post-widening.

(Pre-existing `error: database "chouhua" does not exist` log lines are from `server-lifecycle.test.ts` and `plm-disable-routes.test.ts` driving degraded-mode init paths; they are not test failures — exit code is 0 and the test summary is all-green. Same behavior as on baseline.)

### 4. Integration tests (optional, not run)

The multitable routes do not have their own integration-level regression owned by M0; `approval-pack1a-lifecycle.api.test.ts` was the suggested spot-check in the brief. Skipped this session to keep scope minimal — the M0 change is module-surface and TypeScript-gated, and the full unit suite exercises every derivation path that the route wires. If a later gate requires it, run:

```
DATABASE_URL='postgresql://chouhua@127.0.0.1:5432/postgres' \
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=postgres PGUSER=chouhua \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/approval-pack1a-lifecycle.api.test.ts --reporter=dot
```

### 5. Behavioural invariants preserved

- `resolveRequestAccess` return now includes `userId`. **11 existing `access.userId` reads in `univer-meta.ts` (L2582, L2604, L2627, …, L8326) continue to compile and behave identically** because the inline return shape already included `userId`; it has merely moved from the route's private `ResolvedRequestAccess` alias to the shared one.
- `deriveCapabilities` on the same inputs produces the same 10-field object as before. Verified by test case `'grants every capability (including canManageSheetAccess and canExport) for admin role'` and `'derives full write capability set from multitable:write'` — both assertions are exact equality against the 10-field shape.
- `metaViewConfigCache` is still written by `tryResolveView` (via the shared impl), and still invalidated by L1759/L1762 and written by L5343/L5422/L5470/L5623/L5696. The route wrapper passes the route's cache explicitly as the third arg to the shared function, so cache isolation and invalidation semantics are byte-for-byte identical to baseline.
- `PUBLIC_FORM_CAPABILITIES` (L343, 10-field literal) still satisfies `MultitableCapabilities` — 10 declared fields match the widened type.

### 6. Commit

See commit at branch tip: `refactor(multitable): widen M0 modules to absorb route-side helpers`.
No `--amend`. No `--no-verify`. No push.

---

## Rebase verification - 2026-04-22

Rebased onto `origin/main@9f07a1a408faa761adc2e746b86ef5905c9f2735`.

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-provisioning.test.ts \
  tests/unit/multitable-loaders.test.ts \
  tests/unit/multitable-access.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot
pnpm --filter @metasheet/core-backend build
git diff --check origin/main...HEAD
```

Result:

- Targeted multitable unit tests: passed, 3 files / 22 tests.
- Core backend typecheck: passed.
- Web typecheck: passed.
- Full core-backend unit suite: passed, 123 files / 1587 tests.
- Backend build: passed.
- `git diff --check`: passed.
- Pre-existing degraded-mode logs for missing local `chouhua` database appeared in lifecycle-related unit tests; assertions passed and exit code was 0.
