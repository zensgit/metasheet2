# Multitable Yjs `Not authenticated` i18n Closure — Design 2026-05-23

Base: `origin/main@f7ff5259b` (`test(approval): harden dynamic assignee resolver coverage (#1800)`)
Branch: `docs/multitable-yjs-auth-i18n-closure-20260523`
Predecessor: `docs/development/multitable-final-i18n-closure-audit-20260522.md` (Slice E #1768 — TRUE strict-zero theme-closure)
Scope: 1 hard-coded user-visible English literal in `apps/web/src/multitable/composables/useYjsDocument.ts`

## 0. Purpose

The 2026-05-22 closure audit (`multitable-final-i18n-closure-audit-20260522.md` §7) declared the multitable i18n track **TRUE strict-zero closed by theme** — every "multitable chrome" UI surface routes through one of the 17 typed label modules under `apps/web/src/multitable/utils/`.

Two literals were explicitly deferred (§3 Raw / Accepted Findings, §5.3 Yjs Diagnostic Boundary):

1. `useYjsDocument.ts:198` `INVALIDATED: document invalidated by REST write` — technical Yjs protocol prefix, classified as raw passthrough alongside L190's `${code}: ${msg}` backend-error template; stays raw.
2. `useYjsDocument.ts:126` `Not authenticated` — user-visible auth-error chrome that the audit could not finalize as "raw" but punted to a hypothetical future "Yjs UX slice".

This slice **converts the soft-deferred (2) into a hard closure**, while preserving (1) as raw on its existing rationale. It does **not** introduce a "Yjs UX slice" or re-classify (1).

**Standard tightening — explicit and bounded:**

| Closure audit standard | This slice standard |
|---|---|
| Theme-classified strict-zero ("multitable chrome") | File-location strict-zero (`apps/web/src/multitable/**` has zero user-visible English fallback) |

After this slice, **every literal under `apps/web/src/multitable/**` is either** (a) locale-routed via a label module, (b) backend/raw passthrough on a declared raw-boundary rationale, or (c) the explicit unreachable defensive branch `MetaCellEditor.vue:425-428` "Choose linked records..." preserved EN to avoid the T3A2 dead-key trap.

## 1. Code Facts

| ID | Fact | Evidence |
|---|---|---|
| F1 | `useYjsDocument.ts` is a Vue composable, already imports `vue` (`computed, ref, shallowRef, onUnmounted, watch`). | `apps/web/src/multitable/composables/useYjsDocument.ts:1` |
| F2 | `Not authenticated` is the **only user-visible** English literal in `useYjsDocument.ts` post-closure; it sets `error.value` after JWT token absence is detected. | `:126` |
| F3 | `INVALIDATED: ...` (L198) is the technical Yjs invalidation protocol sentinel; same shape as L190 `${code}: ${msg}` backend code-prefixed error pattern. The audit classified this as raw passthrough. | `:190,:198` |
| F4 | Slice E (#1768) established the **composable-level `useLocale()` pattern** for multitable composables (7 composables + 2 import helpers). `useYjsDocument` is the only multitable composable Slice E did NOT touch (theme-deferred). | `[[project_multitable_i18n]]` §Slice E |
| F5 | `meta-core-labels.ts` already hosts cross-surface error/state keys (`grid.error.*`, `cell.uploadFailed/removeFailed/clearFailed`, `presence.collaboratingNow`). It is the natural home for one new auth-error key — no new module needed. | Per [[project_multitable_i18n]] §17-modules-list — meta-core-labels.ts is "toolbar/grid/cell-editor static keys + cross-surface helpers" |
| F6 | The repo already has a `useAuth` composable imported at `useYjsDocument:8`; auth surfaces elsewhere in `apps/web/src/composables/useAuth` are outside multitable scope and not touched by this slice. | `:8` |
| F7 | The repo's actual test layout is `apps/web/tests/*.spec.ts` (flat). Existing yjs-related specs include `yjs-document-invalidation.spec.ts`, `yjs-document-stale-guard.spec.ts`, `yjs-awareness-presence.spec.ts`, `multitable-yjs-cell-binding.spec.ts`, `multitable-yjs-cell-editor.spec.ts`, `yjs-text-field-diff.spec.ts`, `yjs-text-field-seed-guard.spec.ts`. The existing meta-core spec is `apps/web/tests/multitable-core-i18n.spec.ts`. **Zero `.spec.ts` files live under `apps/web/src/`.** | `ls apps/web/tests \| grep yjs`; `find apps/web/src -name '*.spec.ts'` returns nothing |

## 2. Scope

### In Scope

- `apps/web/src/multitable/composables/useYjsDocument.ts` — extend with `const { isZh } = useLocale()` + replace L126 string literal with `metaCoreLabel('auth.notAuthenticated', isZh.value)` raw-first pattern (`error.value = metaCoreLabel('auth.notAuthenticated', isZh.value)`). The `Not authenticated` branch does NOT have a backend `e.message` to prefer; it fires when local `auth.getToken()` returns falsy. So the pattern is straight `error.value = metaCoreLabel(...)` rather than Slice E's `e.message ?? fallback(key)` raw-first pattern.
- `apps/web/src/multitable/utils/meta-core-labels.ts` — add 1 key `'auth.notAuthenticated'` to the typed key union + `META_CORE_LABELS` map (en: `'Not authenticated'`, zh: `'未登录'`). No new helper — the existing `metaCoreLabel(key, isZh)` accessor handles it.
- `apps/web/tests/yjs-document-i18n.spec.ts` (Option A — preferred) **OR** extension of `apps/web/tests/yjs-document-invalidation.spec.ts` (Option B) — new spec asserting the en + zh output of `error.value` after token-absence triggers L126; only T1/T2 are new because T3 (L198 INVALIDATED stays raw) is already covered byte-unchanged by the existing `yjs-document-invalidation.spec.ts` (see D7).
- Two design/verification docs (this file + verification plan).

### Out of Scope (and why)

- **`INVALIDATED: document invalidated by REST write` (L198)** — preserved raw per closure audit §3 / §5.3; this is a protocol sentinel prefix, mirrors L190's `${code}: ${msg}` backend-error template. Treating it as raw is internally consistent with the existing backend-error-passthrough discipline.
- **Yjs UX slice (auth/invalidation/disconnect/connection chrome polish)** — out of scope by design. This slice does NOT establish a Yjs UX track; it just closes 1 stray multitable literal.
- **`MetaCellEditor.vue:425-428` "Choose linked records..."** — deferred per closure audit (dead-key trap defense); not touched.
- **`calendarChipDisplay.ts` cross-domain label-module discipline** — out of scope; lives in `services/attendance/`, not under `apps/web/src/multitable/**`. Per [[project_attendance_multitable_report_boundary]], the attendance ↔ multitable boundary is strict; this slice does NOT propose cross-domain label coupling.
- **Anything else under `apps/web/**` outside multitable** — out of scope.

### Untouched (explicit, mechanical check via diff)

- migrations
- routes
- UI components (MetaCalendarView / MetaWorkbench / etc.) — composable change is internal to the composable's body
- automation
- SLA / breach
- Workflow Designer
- attendance/* services
- All 16 other label modules (only meta-core-labels.ts touched)
- All other multitable composables (Slice E already covered them)
- approval / K3 / dingtalk / formula / etc.

## 3. Required Decisions

### D1. Key Name and Namespace

`auth.notAuthenticated` in `meta-core-labels.ts`. Rationale:
- Slice E preferred extending existing modules over creating new ones; same here. No `meta-auth-labels.ts` proliferation for a single key.
- `auth.*` is a new namespace within meta-core but mirrors the established pattern (`grid.*`, `cell.*`, `presence.*`).
- Singular semantic: user is "not authenticated" — direct mapping from current literal.

### D2. zh Translation

`'未登录'` (literally "not signed in"). Alternatives considered:
- `'未认证'` (literally "not authenticated") — more direct, less idiomatic
- `'未授权'` (literally "not authorized") — semantic drift (authorization ≠ authentication)
- **`'未登录'`** — idiomatic Chinese UX phrasing for the same condition; matches what zh users expect to see in collaboration tools

D2 final: `'未登录'`. Lock before impl; do not re-litigate post-impl.

### D3. Pattern — Straight Localized Fallback, Not `raw ?? fallback`

Slice E's pattern was `error.value = e.message ?? fallback(key)` — backend message raw-first, then localized fallback. **This slice's L126 site does NOT have a backend error**: the branch fires on local `auth.getToken()` returning falsy, before any socket connection. So the pattern is:

```ts
error.value = metaCoreLabel('auth.notAuthenticated', isZh.value)
```

NOT:

```ts
error.value = (someBackendError?.message) ?? metaCoreLabel('auth.notAuthenticated', isZh.value)
```

The `?? raw-first` discipline applies to catch blocks with `e.message`; not to deterministic local-state branches. This distinction is important — verification plan asserts the impl does not invent a phantom raw source.

### D4. Event-Time Semantics

`isZh.value` is captured at error-write time (catch-time semantics), not module-load time. If the user switches locale after the error is set, the existing error message remains in the captured locale until the next error-write. This matches Slice E + T3D-3 composable-level semantics.

### D5. INVALIDATED:... Stays Raw

`useYjsDocument.ts:198` `error.value = 'INVALIDATED: document invalidated by REST write'` stays exactly as-is. Rationale:

- Same shape as L190 `error.value = \`${code}: ${msg}\`` — both encode a sentinel prefix + descriptive message.
- The `INVALIDATED:` prefix is a protocol-level token consumers may key on. Localizing breaks consumer parsing.
- Closure audit §3 + §5.3 explicitly classified this as raw.

Impl review must NOT localize L198 under cover of this slice. Verification plan §6 includes an explicit `git diff` assertion that line 198 is byte-identical.

### D6. No New Module / No New Helper

Add 1 key only. Do NOT:
- Add `meta-auth-labels.ts` (module proliferation)
- Add `notAuthenticatedLabel(isZh)` helper (the generic `metaCoreLabel(key, isZh)` already handles single-key resolution)
- Add a typed enum for auth states (no future auth-state union is planned)

### D7. Spec Coverage

Add or extend ONE focused spec asserting:
- (a) When `auth.getToken()` returns falsy, `error.value` equals `'Not authenticated'` in EN mode
- (b) Same path produces `'未登录'` in zh mode
- (c) L198's INVALIDATED:... behavior is unchanged (regression sentinel for D5)

Co-locate with the actual test layout (per F7): all specs live in `apps/web/tests/*.spec.ts` (flat). **Preferred path (Option A)**: create a new focused spec `apps/web/tests/yjs-document-i18n.spec.ts` covering T1/T2 (the new i18n cases at L126). T3 (L198 INVALIDATED regression) is already covered by the existing `apps/web/tests/yjs-document-invalidation.spec.ts`; the slice MUST verify that existing spec still passes byte-unchanged on the implementation branch.

**Acceptable alternative (Option B)**: extend `apps/web/tests/yjs-document-invalidation.spec.ts` with T1/T2 cases. Choose this if the implementation finds the socket/mock setup is shared enough that splitting creates duplication. Cost: mixes auth-i18n concerns with invalidation concerns.

Tests use a mock `useAuth` (returning `null` token) — no real socket, no real Yjs doc — for T1/T2; T3 regression reuses the existing invalidation spec's socket mock pattern (see file's `handlers` Map + `emitMock`/`disconnectMock` scaffolding).

### D8. Mock Boundary

The spec must mock `useAuth` to control `getToken()` return. No real auth, no real socket. The test is unit-level — it asserts the error.value string after token absence triggers the branch. No coupled state machinery to test.

## 4. Expected Files (3 changed + 2 new)

| File | Change | Lines (approx) |
|---|---|---|
| `apps/web/src/multitable/composables/useYjsDocument.ts` | `import { useLocale } from '...'`; `const { isZh } = useLocale()` near top of composable body; replace 1 string literal at L126 | +3 / -1 |
| `apps/web/src/multitable/utils/meta-core-labels.ts` | Add `'auth.notAuthenticated'` to `MetaCoreLabelKey` union + `META_CORE_LABELS` map (en + zh) | +3 / -0 |
| `apps/web/tests/yjs-document-i18n.spec.ts` (new, Option A — preferred) **OR** `apps/web/tests/yjs-document-invalidation.spec.ts` (extend, Option B) | New focused spec — 2 `it()` for T1/T2 (T3 regression covered by existing `yjs-document-invalidation.spec.ts` byte-unchanged) | +40-60 (new) or +20 (extend) |
| `docs/development/multitable-yjs-auth-i18n-closure-development-20260523.md` (new — implementation MD, written post-impl) | Records implementation execution | TBD |
| `docs/development/multitable-yjs-auth-i18n-closure-verification-20260523.md` (new — verification MD, written post-impl) | Records test/build outputs | TBD |

This design MD + the verification plan MD are this PR's deliverable; the development + verification post-impl MDs are written in the implementation PR that follows.

## 5. Required Tests

| ID | Test | Risk Covered |
|---|---|---|
| T1 | Token absent → `error.value === 'Not authenticated'` in EN mode | Backward compat — EN literal preserved byte-exact |
| T2 | Token absent → `error.value === '未登录'` in zh mode | i18n closure — zh user sees Chinese |
| T3 | L198 INVALIDATED:... path unchanged (assert exact string equality post-invalidation event) | D5 raw-boundary guard — guard against accidental localization |
| T4 | No regression in non-i18n behavior — `connected.value`, `synced.value`, `disconnect()` work identically | D0 — behavior-preserving slice |

T4 is a smoke-test only; the existing yjs document tests (if any) should remain green without modification.

## 6. Do-Not-Cross Lines

- Do NOT add `meta-auth-labels.ts` (module proliferation).
- Do NOT touch L198 `INVALIDATED:...` (raw boundary per closure audit §3, §5.3).
- Do NOT introduce a Yjs UX slice / Yjs UX track / Yjs UX label module — out of scope.
- Do NOT change `useAuth` (`apps/web/src/composables/useAuth`) — outside multitable namespace.
- Do NOT touch `calendarChipDisplay.ts` (attendance domain).
- Do NOT touch `MetaCellEditor.vue:425-428` (dead-key trap).
- Do NOT change behavior of non-Not-Authenticated error paths (the L190 `${code}: ${msg}` template, the `socket.on('yjs:error')` handler, etc.).

## 7. Risk Register

| ID | Risk | Required control |
|---|---|---|
| R1 | Impl accidentally localizes L198 INVALIDATED:... | D5 + verification §6 byte-exact diff assertion; T3 spec lock |
| R2 | Impl creates `meta-auth-labels.ts` despite D6 | Implementation MD must explicitly reuse `meta-core-labels.ts` extension; verification §3 grep for new label module files post-impl (must be zero new files in `apps/web/src/multitable/utils/`) |
| R3 | Impl injects phantom `e.message ?? ...` pattern at L126 where there is no `e` | D3 + impl MD must show the actual change is straight assignment, not raw-first |
| R4 | Slice expands into a Yjs UX slice (connection chrome, disconnect chrome, etc.) | Out-of-scope list §2 + do-not-cross §6; verification §5 confirms diff touches only useYjsDocument.ts + meta-core-labels.ts + 1 new spec + 2 docs |
| R5 | Mock setup leaks real socket calls | D8 + spec uses `vi.mock('../../../composables/useAuth')` returning `{ getToken: () => null }` to ensure deterministic L126 branch entry; no socket setup |
| R6 | Standard tightening creates precedent for future scope creep | This design MD §0 explicitly bounds the standard tightening to file-location closure; it does NOT obligate future closure of `services/attendance/calendarChipDisplay.ts` or other cross-domain surfaces |

## 8. Go / No-Go

**CONDITIONAL GO** for the implementation PR if these decisions are accepted:

- G1: Standard tightening from theme-closure to file-location closure scoped strictly to `apps/web/src/multitable/**`.
- G2: 1 key `auth.notAuthenticated` added to `meta-core-labels.ts`; no new module.
- G3: Straight `error.value = metaCoreLabel(...)` pattern at L126; not `raw ?? fallback`.
- G4: L198 INVALIDATED:... stays byte-exact; no localization.
- G5: zh string locked at `'未登录'`; no re-litigation post-impl.
- G6: Spec lives in `apps/web/tests/` (flat repo test layout per F7) — Option A new file `yjs-document-i18n.spec.ts` or Option B extension of the existing `yjs-document-invalidation.spec.ts`.
- G7: No cross-domain touches (`services/attendance/`, `useAuth`, etc.).
- G8: No Yjs UX track unlocked.

If any of G1-G8 changes, pause and update this gate before writing runtime code.

## 9. Forward Gate

After this slice merges:

- **multitable i18n track is closed under both interpretations**: theme-closure (since Slice E #1768) AND file-location closure (this slice).
- `MetaCellEditor.vue:425-428` "Choose linked records..." remains the ONLY explicit exception, preserved per closure audit dead-key trap rationale.
- No further multitable i18n slices are anticipated.
- Future UI string changes within `apps/web/src/multitable/**` continue to go through the 17 (still 17 — this slice does NOT add a new module) typed label modules per the existing convention.

This slice does NOT unlock:

- Yjs UX track / Yjs connection chrome polish
- Attendance i18n architectural rework (`calendarChipDisplay.ts` etc.)
- Any approval / K3 / dingtalk / automation track item

K3 PoC stage-1 lock per [[project_k3_poc_stage1_lock]] is unaffected; this is pure 内核打磨 (kernel polishing) of an already-closed track.

## 10. References

- Closure audit: `docs/development/multitable-final-i18n-closure-audit-20260522.md` (in worktree `metasheet2-final-i18n-audit-20260522`, may be local-only per memory)
- Predecessor closure slice: PR #1768 (Slice E composable fallbacks, merged 2026-05-22)
- Memory: [[project_multitable_i18n]], [[project_attendance_multitable_report_boundary]], [[feedback_staged_optin_lineage]]
