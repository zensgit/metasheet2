# Multitable Yjs `Not authenticated` i18n Closure — Development 2026-05-24

Base: `origin/main@7ba475ba8` (`docs(multitable): scope yjs not-authenticated i18n closure (#1803)`)
Branch: `codex/yjs-auth-i18n-impl-20260524`
Scope gate: `docs/development/multitable-yjs-auth-i18n-closure-design-20260523.md` (merged via #1803)
Verification plan: `docs/development/multitable-yjs-auth-i18n-closure-verification-plan-20260523.md`

## Summary

Implements the file-location closure tightening proposed by #1803 scope gate. Localizes one user-visible English literal — `useYjsDocument.ts:126` `'Not authenticated'` — via the existing `meta-core-labels.ts` label module, leaving L198 INVALIDATED:... raw on its declared protocol-sentinel rationale.

This slice does **not** establish a Yjs UX track, does **not** modify `MetaCellEditor.vue:425-428` (dead-key trap exception preserved), and does **not** unlock any other Phase 2 surface (per [[project_approval_phase2_resolver_unlocked]] / [[project_multitable_i18n]]).

## Implementation

### File 1 — `apps/web/src/multitable/utils/meta-core-labels.ts` (+7 / -0)

Two additions:

1. Extended `MetaCoreLabelKey` union with a new section comment + key:

   ```ts
   // --- Auth chrome (file-location closure tightening per #1803) ---
   | 'auth.notAuthenticated'
   ```

2. Extended `META_CORE_LABELS` Record with the matching entry plus a 3-line block comment naming the consumer call site + the event-time semantic:

   ```ts
   // Auth chrome (#1803 file-location closure tightening).
   // Used by useYjsDocument.ts:126 when local auth.getToken() returns falsy.
   // Catch-time isZh capture (event-time semantics matching Slice E composables).
   'auth.notAuthenticated': { en: 'Not authenticated', zh: '未登录' },
   ```

No new helper function (D6 of scope gate); the existing `metaCoreLabel(key, isZh)` accessor handles the key. No new exhaustiveness array needed — the repo's `meta-core-labels.ts` does not maintain a `META_CORE_LABEL_KEYS` array; type-checking against `MetaCoreLabelKey` covers exhaustiveness for the typed `Record<MetaCoreLabelKey, ...>` map.

### File 2 — `apps/web/src/multitable/composables/useYjsDocument.ts` (+5 / -1)

Three small additions plus the L126 literal replacement:

1. Two new imports immediately after the existing `useAuth` import:

   ```ts
   import { useLocale } from '../../composables/useLocale'
   import { metaCoreLabel } from '../utils/meta-core-labels'
   ```

2. One destructure line immediately after `const auth = useAuth()` inside the `useYjsDocument` composable body:

   ```ts
   const { isZh } = useLocale()
   ```

3. The L126 string-literal replacement (single-line edit):

   ```diff
   -      error.value = 'Not authenticated'
   +      error.value = metaCoreLabel('auth.notAuthenticated', isZh.value)
   ```

   This is a **straight assignment** (scope-gate D3). The branch fires when local `auth.getToken()` returns falsy — there is no backend `e.message` to prefer, so the Slice E `e.message ?? fallback(key)` raw-first pattern does **not** apply here. Verification §3.6 guards against accidental `?? metaCoreLabel(...)` regression.

L198 `error.value = 'INVALIDATED: document invalidated by REST write'` is byte-unchanged. Verification §3.4 confirms with `git diff | grep -c INVALIDATED = 0`.

### File 3 — `apps/web/tests/yjs-document-i18n.spec.ts` (new, +92 lines)

New focused spec for T1/T2 — only the EN/zh outputs on the no-token branch. T3 (L198 INVALIDATED-stays-raw) regression is covered byte-unchanged by the existing `tests/yjs-document-invalidation.spec.ts` (4 tests pass without modification on this branch).

Spec structure (Option A from scope-gate D7):

- Mocks `socket.io-client` minimally (no-op `io` factory; the L126 branch returns before any socket creation so the mock body is intentionally minimal)
- Mocks `useAuth` to force `getToken()` returning `null` — distinct from the existing invalidation spec which mocks `getToken` returning `'jwt-token'`; `vi.mock` is per-test-file scoped so the two specs coexist
- `mountDocument(recordId)` helper mirrors the existing invalidation spec's pattern (`createApp` + `defineComponent` setup that captures the composable api into a closure ref)
- `flushUi(cycles = 4)` awaits the watch-induced async `connect()` reaching the L126 branch
- `beforeEach` + `afterEach` set the locale back to `'en'` (the module-level `localeState` in `useLocale.ts` is a singleton; clean reset between tests)

Two `it()` cases:

- **T1**: `setLocale('en')` → `error.value === 'Not authenticated'` + `ioMock` never invoked (confirms early return before socket creation) + `connected.value === false`
- **T2**: `setLocale('zh-CN')` → `error.value === '未登录'` + same socket + connected assertions

## Patterns Applied (cross-reference)

- **Slice E composable-level `useLocale()`** ([[project_multitable_i18n]] §Slice E): `const { isZh } = useLocale()` at composable top body; reads `isZh.value` at error-write time (event-time semantics)
- **Module-extension over module-proliferation** (Slice E precedent): extended `meta-core-labels.ts` rather than creating a new `meta-auth-labels.ts`; scope-gate D6 locked this
- **D3 straight assignment vs raw-first** (this slice): the L126 branch is a deterministic local-state branch with no backend `e.message`, so the assignment is straight `metaCoreLabel(...)` not `e.message ?? metaCoreLabel(...)`
- **L198 protocol-sentinel raw boundary** (closure audit §3 / §5.3): unchanged on the same rationale as L190's `${code}: ${msg}` backend-error template
- **MetaCellEditor:425-428 dead-key trap** (closure audit §5.3): preserved unchanged

## Scope-Gate G1-G8 Mapping

| Gate | Result |
|---|---|
| G1 `assigneeSources` in frozen runtime graph snapshot | N/A — this slice is i18n closure tightening, not Phase 2 Resolver |
| (slice-specific G1) standard tightening scoped to `apps/web/src/multitable/**` | All changes under `apps/web/src/multitable/` runtime + `apps/web/tests/` spec; cross-domain guard §3.8 confirms no out-of-scope files |
| G2 1 key in existing `meta-core-labels.ts`, no new module | `META_CORE_LABEL_KEYS` exhaustiveness array does not exist in repo; key union + Record map extended; §3.5 module-proliferation guard returns empty |
| G3 straight `error.value = metaCoreLabel(...)` at L126, not raw-first | §3.6 guard shows `+      error.value = metaCoreLabel(...)` with no `??` prefix |
| G4 L198 INVALIDATED:... stays byte-exact | §3.4 guard returns 0 INVALIDATED-line diffs |
| G5 zh locked at `'未登录'` | §3.7 guard shows `+  'auth.notAuthenticated': { en: 'Not authenticated', zh: '未登录' }` |
| G6 spec lives in `apps/web/tests/yjs-document-i18n.spec.ts` (Option A) | File created at exactly that path; 92 lines, 2 `it()` |
| G7 no cross-domain touches | §3.8 guard returns empty (no `services/attendance/`, no `useAuth` source change, no other lanes) |
| G8 no Yjs UX track unlocked | No connection/disconnect/reconnect chrome touched; only the deterministic local L126 branch localized |

## Forward Gate (per #1803 §9)

This implementation PR concludes the file-location closure tightening. After merge:

- multitable i18n track closed under both interpretations (theme + file-location)
- `MetaCellEditor.vue:425-428` "Choose linked records..." remains the ONLY explicit exception (dead-key trap)
- No further multitable i18n slices anticipated within the scope-gate's bounded standard

Does **NOT** unlock:

- Yjs UX track (connection/disconnect chrome polish)
- attendance i18n architectural rework (`services/attendance/calendarChipDisplay.ts` etc.)
- approval / K3 / dingtalk / automation / SLA / Workflow Designer lanes

K3 PoC stage-1 lock unaffected.

## File Set (final, 5 files)

| File | + / - | Type |
|---|---|---|
| `apps/web/src/multitable/utils/meta-core-labels.ts` | +7 / -0 | label module extension |
| `apps/web/src/multitable/composables/useYjsDocument.ts` | +5 / -1 | composable wiring |
| `apps/web/tests/yjs-document-i18n.spec.ts` | +92 (new) | T1/T2 focused spec |
| `docs/development/multitable-yjs-auth-i18n-closure-development-20260524.md` | new | this MD |
| `docs/development/multitable-yjs-auth-i18n-closure-verification-20260524.md` | new | verification MD |
