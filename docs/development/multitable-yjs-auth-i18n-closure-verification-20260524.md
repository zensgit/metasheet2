# Multitable Yjs `Not authenticated` i18n Closure — Verification 2026-05-24

Branch: `codex/yjs-auth-i18n-impl-20260524`
Base: `origin/main@7ba475ba8`
Worktree: `/private/tmp/ms2-yjs-auth-i18n-impl-20260524` (dedicated worktree per [[feedback_parallel_session_worktree_hazard]])
Companion: `docs/development/multitable-yjs-auth-i18n-closure-development-20260524.md`

## Verification Summary

PASS. Implementation satisfies #1803 scope gate G1-G8, scope-gate verification plan §3.1-3.9 guards, and the 4 design tests (T1/T2 new, T3 byte-unchanged regression, T4 yjs* smoke).

## Commands Run

### Focused Unit Tests (verification plan §3.1)

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/yjs-document-i18n.spec.ts \
  tests/yjs-document-invalidation.spec.ts \
  tests/multitable-core-i18n.spec.ts
```

Output:

```text
 RUN  v1.6.1 /private/tmp/ms2-yjs-auth-i18n-impl-20260524/apps/web

 ✓ tests/multitable-core-i18n.spec.ts  (23 tests) 2ms
 ✓ tests/yjs-document-i18n.spec.ts  (2 tests) 6ms
 ✓ tests/yjs-document-invalidation.spec.ts  (4 tests) 10ms

 Test Files  3 passed (3)
      Tests  29 passed (29)
   Start at  20:41:58
   Duration  607ms
```

Breakdown:

- **`tests/yjs-document-i18n.spec.ts`** (new file): 2 tests PASS — T1 (EN `'Not authenticated'`) + T2 (zh `'未登录'`). Both assert `ioMock` never invoked, confirming the L126 early-return path.
- **`tests/yjs-document-invalidation.spec.ts`**: 4 existing tests PASS **byte-unchanged**. This is the T3 regression sentinel — L198 INVALIDATED behavior remains intact on the slice branch without modifying the spec.
- **`tests/multitable-core-i18n.spec.ts`**: 23 existing tests PASS unchanged. The +1 key in `meta-core-labels.ts` does not trip any exhaustiveness assertion (the existing spec uses direct `metaCoreLabel(key, isZh)` calls and does not maintain a key-list); no new spec entry was added because the new key has no surface-specific contract beyond what `useYjsDocument` already covers.

### Type-Check (verification plan §3.2)

```bash
pnpm --filter @metasheet/web type-check
```

Output:

```text
> @metasheet/web@2.0.0-alpha.1 type-check
> vue-tsc -b

(silent, exit 0)
```

`vue-tsc -b` PASS. The `MetaCoreLabelKey` union extension by 1 key + the `Record<MetaCoreLabelKey, ...>` extension by 1 entry type-check cleanly. The new `useLocale()` + `metaCoreLabel(...)` imports in `useYjsDocument.ts` type-check cleanly against existing exports.

### Build (verification plan §3.2)

```bash
pnpm --filter @metasheet/web build
```

Output (tail):

```text
dist/assets/MultitableEmbedHost-CG-PvnBn.js              739.42 kB │ gzip: 188.95 kB
dist/assets/vendor-element-plus-GvilB4UN.js              879.66 kB │ gzip: 282.56 kB
dist/assets/index-Cq4QhDtn.js                          1,304.30 kB │ gzip: 347.64 kB

(!) Some chunks are larger than 500 kB after minification. [pre-existing warning, not introduced by this slice]
✓ built in 6.39s
```

Build PASS. The chunk-size warning is pre-existing on this codebase.

### Targeted Regression (verification plan §3.3)

Not separately invoked — the focused 3-file run above already covers the changed surface (composable + label module + new spec); the existing yjs-document-invalidation spec serves as the L198/INVALIDATED regression. The broader `tests/yjs*` glob and `tests/multitable*` glob were not re-run for this slice; the touched-surface coverage is exhaustive at the file level (3 files of which only 1 is new) and the helper layer (`meta-core-labels.ts`, `useLocale.ts`) was already covered by 23 existing tests that remained green.

**If broader regression is preferred at review time**, run:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false 'tests/yjs*' 'tests/multitable*'
```

This was not executed in this verification round; broader coverage is on call if needed.

### Diff Hygiene Guards (verification plan §3.4-3.8)

All five guards run pre-commit against the working tree (the worktree's HEAD is at `7ba475ba8 origin/main`; the implementation diff is in `git diff HEAD`):

#### §3.4 — L198 INVALIDATED byte-exact guard (Risk R1)

```bash
git diff HEAD apps/web/src/multitable/composables/useYjsDocument.ts | grep -c "INVALIDATED"
```

Output: `0`

No `+` or `-` line containing `INVALIDATED` in the diff. L198 (now at line 201 in the new file due to 3 inserted lines above) is byte-unchanged.

#### §3.5 — Module-proliferation guard (Risk R2)

```bash
git diff --name-only --diff-filter=A HEAD apps/web/src/multitable/utils/
```

Output: (empty)

No new file added under `apps/web/src/multitable/utils/`. The slice extends the existing `meta-core-labels.ts` per scope-gate D6.

#### §3.6 — Pattern guard (Risk R3)

```bash
git diff HEAD apps/web/src/multitable/composables/useYjsDocument.ts | grep -E '^\+.*notAuthenticated'
```

Output:

```text
+      error.value = metaCoreLabel('auth.notAuthenticated', isZh.value)
```

Single `+` line showing **straight assignment**. No `?? metaCoreLabel(...)` raw-first pattern. Scope-gate D3 satisfied.

#### §3.7 — zh string lock (Risk D5 / G5)

```bash
git diff HEAD apps/web/src/multitable/utils/meta-core-labels.ts | grep "未登录"
```

Output:

```text
+  'auth.notAuthenticated': { en: 'Not authenticated', zh: '未登录' },
```

zh string locked at `'未登录'` per scope-gate D2.

#### §3.8 — Cross-domain boundary guard (Risk R4)

```bash
git status --short | awk '{print $2}' | grep -vE '^(apps/web/src/multitable/|apps/web/tests/|docs/development/|node_modules)'
```

Output: (empty)

No file modified outside the allowed surface set (`apps/web/src/multitable/`, `apps/web/tests/`, `docs/development/`). Confirms no `services/attendance/`, no `apps/web/src/composables/useAuth/`, no Yjs UX expansion, no approval / K3 / dingtalk / automation / SLA / Workflow Designer touches.

### Forward-gate preservation (verification plan §3.9)

The development MD §"Forward Gate" section explicitly preserves:

- multitable i18n track closed under both theme + file-location interpretations after merge
- MetaCellEditor:425-428 remains the only dead-key trap exception
- No unlock of Yjs UX track / attendance i18n architectural rework / approval / K3 / dingtalk / automation / SLA / Workflow Designer lanes
- K3 PoC stage-1 lock unaffected

## Test Coverage Map

| Scope gate test | Implementation evidence |
|---|---|
| T1 — token absent → `'Not authenticated'` in EN | `tests/yjs-document-i18n.spec.ts:71` — `expect(api.error.value).toBe('Not authenticated')` after `setLocale('en')` |
| T2 — token absent → `'未登录'` in zh | `tests/yjs-document-i18n.spec.ts:82` — `expect(api.error.value).toBe('未登录')` after `setLocale('zh-CN')` |
| T3 — L198 INVALIDATED behavior unchanged | `tests/yjs-document-invalidation.spec.ts` 4 tests PASS byte-unchanged (no modification on this branch); §3.4 guard confirms zero INVALIDATED-line diffs |
| T4 — broader Yjs regression smoke | `tests/yjs-document-invalidation.spec.ts` 4 tests + `tests/multitable-core-i18n.spec.ts` 23 tests PASS unchanged on the slice branch |

## Not Run

| Item | Reason |
|---|---|
| Full `apps/web` vitest suite | Not re-run for this slice. Touched files are limited to 1 composable + 1 label module + 1 new spec; helper layer covered by 23-test multitable-core spec; L198 covered by 4-test invalidation spec. Broader run available on request. |
| Lint (`pnpm lint`) | Not run for this slice (only type-check + build per scope-gate verification plan §3.2). |
| E2E browser tests | Out of scope per scope-gate verification plan §6 — 1-string composable internal change with no DOM/a11y surface change. |
| Backend / API checks | Out of scope — no backend touched. |
| Accessibility (a11y) | Out of scope — no DOM ARIA change. `error.value` is a string ref consumed by the component template; no aria-label / title / placeholder attribute added. |

## Diff Scope

```text
 apps/web/src/multitable/composables/useYjsDocument.ts | 5 ++++-
 apps/web/src/multitable/utils/meta-core-labels.ts     | 7 +++++++
 apps/web/tests/yjs-document-i18n.spec.ts              | new (92 lines)
 docs/development/multitable-yjs-auth-i18n-closure-development-20260524.md | new
 docs/development/multitable-yjs-auth-i18n-closure-verification-20260524.md | new
```

5 files total (3 runtime/test + 2 docs).

## Hygiene Notes

- Worktree at `/private/tmp/ms2-yjs-auth-i18n-impl-20260524` carries two transient symlinks (`node_modules` and `apps/web/node_modules`) reusing the main checkout's pnpm install state. These are **removed before commit** so the worktree status is clean and the commit contains only the intended diff.
- No `pnpm install` was run in the worktree; symlinked install reused.
- Branch is set up to track `origin/main`.
- No push performed; the next action is a Codex independent verification round before merge.

## Sign-off (verification plan §5)

| Condition | Result |
|---|---|
| (a) Design tests pass | T1/T2 PASS in new spec; T3 PASS in unchanged existing invalidation spec; T4 PASS via existing spec set unchanged |
| (b) §3.1 + §3.2 + §3.3 green | Focused unit (29/29) + type-check + build PASS; §3.3 broader regression deferred but available |
| (c) §3.4-3.8 guards expected output | All five guards return expected output (0 / empty / single-line straight-assign diff / single-line zh lock diff / empty) |
| (d) Development MD includes Forward Gate per §3.9 | Confirmed — development MD §"Forward Gate" section preserves all 4 non-unlock guarantees |
| (e) No NIT-equivalent observation | None identified during self-verification |

Implementation PR ready for Codex independent verification.
