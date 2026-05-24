# Multitable Yjs `Not authenticated` i18n Closure — Verification Plan 2026-05-23

Companion to: `docs/development/multitable-yjs-auth-i18n-closure-design-20260523.md`
Branch: `docs/multitable-yjs-auth-i18n-closure-20260523`
Base: `origin/main@f7ff5259b`
Status: Pre-implementation. This document plans what verification the implementation PR must execute; actual command outputs are recorded in the post-impl `-verification-20260523.md`.

## 1. Verification Scope

This plan covers:

- **Scope-gate verification** (this docs-only PR): confirms the scope gate is grounded in current `origin/main` code and the design's code facts (F1-F7) are accurate.
- **Implementation PR verification** (next PR, not in this branch): what the implementation MUST run + record before being marked PASS.

## 2. Scope-Gate Verification (this PR)

### 2.1 Code fact checks (read-only)

| Fact | Verification command |
|---|---|
| F1 (useYjsDocument is Vue composable, imports `vue`) | `head -10 apps/web/src/multitable/composables/useYjsDocument.ts` |
| F2 (`'Not authenticated'` at L126) | `sed -n '120,130p' apps/web/src/multitable/composables/useYjsDocument.ts` |
| F3 (`INVALIDATED: ...` at L198) | `sed -n '193,205p' apps/web/src/multitable/composables/useYjsDocument.ts` |
| F4 (Slice E pattern in 7 other composables) | `grep -l "useLocale()" apps/web/src/multitable/composables/*.ts` |
| F5 (meta-core-labels.ts hosts cross-surface keys) | `grep -E "^export type MetaCoreLabelKey\|^const META_CORE_LABELS" apps/web/src/multitable/utils/meta-core-labels.ts` |
| F6 (useYjsDocument imports useAuth) | `grep "useAuth" apps/web/src/multitable/composables/useYjsDocument.ts` |
| F7 (test layout: flat `apps/web/tests/*.spec.ts`, zero specs under `apps/web/src/`, existing yjs specs include `yjs-document-invalidation.spec.ts`/`yjs-document-stale-guard.spec.ts`/`yjs-awareness-presence.spec.ts`/`multitable-yjs-cell-{binding,editor}.spec.ts`; existing meta-core spec is `multitable-core-i18n.spec.ts`) | `ls apps/web/tests \| grep -E 'yjs\|multitable-core'`; `find apps/web/src -name '*.spec.ts'` (returns nothing) |

### 2.2 Untouched-surface confirmation

```bash
git diff --name-only origin/main..HEAD
```

Expected output (this branch only):

```
docs/development/multitable-yjs-auth-i18n-closure-design-20260523.md
docs/development/multitable-yjs-auth-i18n-closure-verification-plan-20260523.md
```

If the diff includes any `.ts`, `.vue`, `migration`, or non-`docs/` files, this PR is out of scope. Codex review should reject.

### 2.3 Base freshness

```bash
git fetch origin main --prune
git rev-list --left-right --count HEAD...origin/main
```

Expect: ahead/behind report `1 0` at PR open (1 commit ahead — the docs commit itself contains both files; behind=0 immediately after rebase). BEHIND drift during the review window is acceptable (no overlap possible since this PR is docs-only outside multitable runtime). If BEHIND > 0 before push, rebase onto latest `origin/main` and re-confirm `git diff --name-status origin/main..HEAD` shows only the 2 new yjs-auth docs and no stray deletions from upstream commits the branch was missing.

## 3. Implementation PR Verification (forward-looking)

The implementation PR (NOT this branch) must execute and record:

### 3.1 Focused unit tests

`pnpm --filter @metasheet/web exec` runs with cwd = `apps/web`, so use package-relative paths:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/yjs-document-i18n.spec.ts \
  tests/yjs-document-invalidation.spec.ts \
  tests/multitable-core-i18n.spec.ts
```

(Per design §3 D7 + §4, the new T1/T2 spec is `apps/web/tests/yjs-document-i18n.spec.ts` (Option A) OR Option B extends `apps/web/tests/yjs-document-invalidation.spec.ts`. The existing meta-core spec is `apps/web/tests/multitable-core-i18n.spec.ts` — extending its key coverage when `meta-core-labels.ts` gains the `'auth.notAuthenticated'` key is recommended but not strictly required if a key-list exhaustiveness assertion already locks it.)

Expected: the new T1/T2 cases (the only genuinely new tests, per design §5 D7) pass; existing `yjs-document-invalidation.spec.ts` passes **byte-unchanged** (this is the T3 INVALIDATED-stays-raw regression sentinel — design §5 T3 is satisfied by that spec being green, not by a duplicate new assertion); existing `multitable-core-i18n.spec.ts` passes after the +1 key entry (if it has a `META_CORE_LABEL_KEYS` exhaustiveness assertion the new key must be added in lockstep); design §5 T4 smoke regression is covered by the broader `tests/yjs*` set passing — no T4-specific new assertion is added.

### 3.2 Type check + build

```bash
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web build
```

Expected: PASS. The `MetaCoreLabelKey` union extension by 1 key triggers no breaks. If `META_CORE_LABEL_KEYS` readonly array exists for exhaustiveness, it MUST be extended in lockstep — verification post-impl confirms.

### 3.3 Targeted regression

Per F7, all multitable web specs live in `apps/web/tests/` (flat, not under `src/`). Under `pnpm --filter @metasheet/web exec`, the cwd is `apps/web`, so use either a directory or a glob package-relative:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/
# or, if narrower scope is preferred:
pnpm --filter @metasheet/web exec vitest run --watch=false 'tests/multitable*' 'tests/yjs*'
```

Expected: full multitable + yjs web test surface remains green. If any non-yjs spec fails, the failure must be diagnosed and resolved before merge; "unrelated failure" is not an accepted explanation per the established discipline.

### 3.4 Byte-exact L198 guard

```bash
git diff origin/main..HEAD apps/web/src/multitable/composables/useYjsDocument.ts | grep -c "INVALIDATED"
```

Expected: 0 (no lines added or removed containing `INVALIDATED`). This guards Risk R1 from design §7.

### 3.5 Module-proliferation guard

```bash
git diff --name-only --diff-filter=A origin/main..HEAD apps/web/src/multitable/utils/
```

Expected: empty output (no new label module files added). The 17 existing label modules under `apps/web/src/multitable/utils/` are the SOLE extension points; extending `meta-core-labels.ts` is allowed; creating `meta-auth-labels.ts` is forbidden per design §6 D6.

### 3.6 Pattern guard

```bash
git diff origin/main..HEAD apps/web/src/multitable/composables/useYjsDocument.ts | grep -E "^\+.*notAuthenticated"
```

Expected: shows `error.value = metaCoreLabel('auth.notAuthenticated', isZh.value)` straight assignment. MUST NOT show `?? metaCoreLabel(...)` (raw-first pattern at a deterministic local-state branch — D3 violation).

### 3.7 zh string lock

```bash
git diff origin/main..HEAD apps/web/src/multitable/utils/meta-core-labels.ts | grep "未登录"
```

Expected: shows 1 occurrence (the new key value). If the actual zh string differs from `'未登录'`, design D2 was re-litigated during impl — Codex review should flag.

### 3.8 Cross-domain boundary guard

```bash
git diff --name-only origin/main..HEAD | grep -vE '^(apps/web/src/multitable/|docs/development/)'
```

Expected: empty. The impl PR must not touch any file outside multitable namespace + docs/development. If `services/attendance/calendarChipDisplay.ts` or `apps/web/src/composables/useAuth/` appear, scope creep — Codex review should reject.

### 3.9 Forward-gate preservation

The implementation MD must include a §"Forward Gate" section reaffirming:

- This slice does NOT unlock a Yjs UX track
- `MetaCellEditor.vue:425-428` remains the only explicit dead-key trap deferral
- K3 PoC stage-1 lock unaffected
- No new multitable i18n slices anticipated

If any of these guarantees is missing, the impl PR is incomplete.

## 4. Recording Discipline

The post-impl `-verification-20260523.md` MUST:

- Record exact command + exit code + truncated output for each §3.1-3.8 check
- NOT collapse "interleaved" with assertions about what should have happened — only what DID happen
- Mark any DB-required test as "DB-required; not run; reason" if local DB unavailable; do NOT silently mark such tests PASS (per [[feedback_metasheet2_skip_when_unreachable_blind_spot]])
- Confirm `git diff --check origin/main..HEAD` PASS
- Confirm working tree clean (no node_modules symlink residue from worktree-based impl)

## 5. Sign-off Conditions

Implementation PR is APPROVED when ALL of:

- (a) Design T1/T2 (the new EN + zh cases on the L126 path) PASS; T3 (L198 INVALIDATED byte-unchanged) confirmed by the existing `yjs-document-invalidation.spec.ts` remaining green without modification; T4 (broader Yjs regression smoke) confirmed by the `tests/yjs*` glob remaining green
- (b) §3.1 + 3.2 + 3.3 all green
- (c) §3.4-3.8 guards all show expected outputs
- (d) Implementation MD includes Forward Gate section per §3.9
- (e) No NIT-equivalent observation about reversed design decisions or scope creep

Otherwise pause + redesign + re-review.

## 6. Out of Scope Even of Verification

- E2E browser tests — unnecessary for a 1-string composable internal change
- Performance benchmarks — no perf surface touched
- Backend / API checks — no backend touched
- Storybook / docs site — multitable composables aren't surfaced there
- Accessibility tests (a11y) — error.value is set to a string; no DOM ARIA change

## 7. Related Discipline References

- Slice E composable pattern: `[[project_multitable_i18n]]` §Slice E
- Pre-impl scan rules: M1 CSS-selector trap (N/A — no `data-*` here), withDefaults locale-reactivity trap (N/A — composable, not component props)
- Anti-fake-pass: `[[feedback_metasheet2_skip_when_unreachable_blind_spot]]`
- Staged opt-in: `[[feedback_staged_optin_lineage]]`
- Attendance↔multitable boundary: `[[project_attendance_multitable_report_boundary]]` — §2 design out-of-scope §confirms cross-domain restraint
