# Multitable Final Audit Slice D: API Fallback I18n Design (2026-05-22)

## 1. Decision Summary

Slice D is the final follow-up from
`docs/development/multitable-final-i18n-audit-20260522.md`. It localizes the
frontend-generated fallback messages emitted by the multitable API client while
preserving backend/user messages as raw.

Chosen architecture: **new pure label module + client-level locale resolver +
App-level registration**.

| Decision | Choice | Reason |
| --- | --- | --- |
| Label owner | New `meta-api-error-labels.ts` | API transport fallback is not manager/workbench/view chrome and should not overload existing modules. |
| Locale access | Inject resolver into API client layer | Keeps `api/client.ts` free of direct `useLocale()` imports while allowing production singleton localization. |
| Production wiring | `App.vue` registers `() => isZh.value` once | Existing `App.vue` already owns `useLocale()`; singleton reads locale at error time, not module load time. |
| Backward compatibility | EN default remains | Existing tests constructing `new MultitableApiClient({ fetchFn })` keep English fallback messages unless a resolver/option is provided. |
| Backend messages | Preserve raw first | `fieldErrors` messages and `payload.message` remain backend/user text and must not be translated. |

Rejected options:

| Option | Rejection reason |
| --- | --- |
| Caller-pass `isZh` on every API method | Too much churn across dozens of methods and consumers. It also risks missing call-sites. |
| `api/client.ts` imports `useLocale()` directly | Non-Vue transport layer would depend on a Vue composable and complicate module-load/test isolation. |
| Keep singleton EN-only | Does not close the final audit finding because code-only API fallback errors can still surface in UI. |

## 2. Files In Scope

Implementation files:

| File | Change |
| --- | --- |
| `apps/web/src/multitable/utils/meta-api-error-labels.ts` | New API error fallback label module. |
| `apps/web/src/multitable/api/client.ts` | Replace inline English fallbacks with helper calls and locale resolver plumbing. |
| `apps/web/src/App.vue` | Register the global multitable API error locale resolver from `useLocale().isZh`. |

Tests:

| File | Change |
| --- | --- |
| `apps/web/tests/meta-api-error-labels.spec.ts` | New helper/unit coverage. |
| `apps/web/tests/multitable-client.spec.ts` | Extend existing API client tests for EN default, zh resolver, raw precedence, and field-error fallback. |
| `apps/web/tests/App.spec.ts` | Only touch if existing App tests need explicit resolver cleanup or a cheap registration assertion. |

Docs:

| File | Change |
| --- | --- |
| `docs/development/multitable-final-audit-api-fallbacks-design-20260522.md` | This design. |
| `docs/development/multitable-final-audit-api-fallbacks-verification-20260522.md` | Post-implementation evidence. |

Out of scope:

| Surface | Reason |
| --- | --- |
| Backend contracts / payload shape | Slice D only changes frontend fallback text. |
| Component-specific fallback strings in composables | Many have already moved to surface modules; any remaining broad cleanup is outside the API client finding. |
| Backend `e.message` / `payload.message` localization | These are server/user messages and stay raw. |
| Auth redirect, token handling, request headers | No transport behavior changes beyond error message fallback generation. |
| Attendance/K3/PLM/non-multitable clients | Final audit scope is `apps/web/src/multitable/**` plus the App-level locale registration. |

## 3. Ground Truth

Source findings in `apps/web/src/multitable/api/client.ts`:

| Line | Current source | Classification |
| --- | --- | --- |
| 109 | `firstFieldError(...) ?? payload.message ?? defaultApiErrorMessage(...)` | Preserve precedence; only fallback branch localizes. |
| 174 | `Validation failed` for array field error without message | Frontend fallback, localize. |
| 186 | `Validation failed` for object field error without message | Frontend fallback, localize. |
| 198 | `Insufficient permissions` | Frontend code-only fallback, localize. |
| 200 | `Please sign in to continue.` | Frontend code-only fallback, localize. |
| 202 | `Please check the submitted data and try again.` | Frontend code-only fallback, localize. |
| 204 | ``API ${status}`` | Technical status fallback; centralize helper, output stays `API ${status}` in both locales. |

Existing tests in `apps/web/tests/multitable-client.spec.ts` already prove:

| Lines | Contract |
| --- | --- |
| 395-417 | first field error wins over backend top-level message. |
| 419-432 | code-only `FORBIDDEN` currently maps to English `Insufficient permissions`. |
| 434-445 | legacy string payload `error: 'Insufficient permissions'` stays raw as message. |
| 516-566 | validation field-error arrays/objects are normalized into `fieldErrors`. |

`App.vue` already has `const { locale, isZh, setLocale } = useLocale()` at line 85,
so it is the lowest-risk place to register the production locale resolver.

## 4. Label Module

Create `apps/web/src/multitable/utils/meta-api-error-labels.ts`.

Proposed API:

```ts
export type MetaApiErrorLabelKey =
  | 'error.forbidden'
  | 'error.unauthenticated'
  | 'error.validation'
  | 'error.fieldValidation'

export function metaApiErrorLabel(key: MetaApiErrorLabelKey, isZh: boolean): string

export function apiFieldValidationFallback(isZh?: boolean): string

export function apiDefaultErrorMessage(code: string | undefined, status: number, isZh?: boolean): string
```

Labels:

| Key / helper branch | EN | zh |
| --- | --- | --- |
| `error.forbidden` | `Insufficient permissions` | `权限不足` |
| `error.unauthenticated` | `Please sign in to continue.` | `请先登录后继续。` |
| `error.validation` | `Please check the submitted data and try again.` | `请检查提交的数据后重试。` |
| `error.fieldValidation` | `Validation failed` | `验证失败` |
| `apiDefaultErrorMessage(default)` | `API ${status}` | `API ${status}` |

Notes:

- `API ${status}` intentionally keeps the `API` technical prefix unchanged in
  zh. The improvement is moving it into the typed helper so all fallback
  branches are audited and tested.
- Unknown `code` values use the status fallback. The raw `code` remains on the
  thrown error object and is not interpolated into the user-facing message.
- No backend message is passed into this module.

## 5. API Client Plumbing

`api/client.ts` keeps EN as the default. It gains a lightweight locale resolver
without importing `useLocale()`.

Proposed types:

```ts
type ApiErrorLocaleResolver = () => boolean
type ApiErrorLocaleOption = boolean | ApiErrorLocaleResolver

export function setMultitableApiErrorLocaleResolver(
  resolver: ApiErrorLocaleResolver | null | undefined,
): void
```

Proposed class extension:

```ts
export class MultitableApiClient {
  private fetch: FetchFn
  private readonly isZhOption?: ApiErrorLocaleOption

  constructor(opts?: { fetchFn?: FetchFn; isZh?: ApiErrorLocaleOption }) {
    this.fetch = opts?.fetchFn ?? defaultFetchFn()
    this.isZhOption = opts?.isZh
  }

  private resolveIsZh(): boolean {
    if (typeof this.isZhOption === 'function') return this.isZhOption()
    if (typeof this.isZhOption === 'boolean') return this.isZhOption
    return resolveGlobalApiErrorIsZh()
  }

  private parseJson<T>(res: Response): Promise<T> {
    return parseJson<T>(res, this.resolveIsZh())
  }
}
```

Implementation plan:

1. `parseJson<T>(res, isZh = false)` calls `normalizeApiErrorPayload(body, isZh)`.
2. `normalizeFieldErrors(fieldErrors, isZh)` uses `apiFieldValidationFallback(isZh)` only when a field-error entry has no usable message.
3. `defaultApiErrorMessage(...)` is replaced with `apiDefaultErrorMessage(...)`.
4. All class methods mechanically change from `parseJson(res)` to `this.parseJson(res)`.
5. Existing singleton remains `export const multitableClient = new MultitableApiClient()`.
6. Because the singleton resolves the global resolver at error time, it can be constructed before `App.vue` registers locale state.

Why both global resolver and constructor option:

- Global resolver localizes the production singleton without changing every API call.
- Constructor option gives tests and future service adapters deterministic local control.
- No resolver means EN default, preserving existing test and non-App behavior.

## 6. App Wiring

`App.vue` already owns the locale source. Register once near the existing
`useLocale()` destructure:

```ts
import { setMultitableApiErrorLocaleResolver } from './multitable/api/client'

const { locale, isZh, setLocale } = useLocale()
setMultitableApiErrorLocaleResolver(() => isZh.value)
```

This is intentionally App-level, not `client.ts`-level:

- `client.ts` remains a transport module.
- `useLocale()` stays inside Vue app setup.
- Locale is read at error time, so toggling locale affects future API fallback errors.
- Already-thrown/stored error strings do not retranslate. This is event-time
  behavior, consistent with toast/error-message slices such as T3E-2 and T3D-3.

Test isolation note:

- `multitable-client.spec.ts` should reset the global resolver in `beforeEach`
  or `afterEach` via `setMultitableApiErrorLocaleResolver(undefined)`.
- Tests that want zh should use either constructor-local `isZh: true` /
  `isZh: () => true` or the global resolver explicitly.

## 7. Raw Boundary

These remain raw and must have regression coverage:

| Value | Reason |
| --- | --- |
| `firstFieldError(payload.fieldErrors)` when message exists | Backend/user validation message. |
| `payload.message` | Backend/user message. |
| legacy string payload `error: '...'` | Existing contract treats it as message. |
| `fieldErrors` keys such as `fld_code` | Field IDs. |
| `code`, `status`, `serverVersion`, `retryAfterMs` | Technical metadata on the error object. |
| `Retry-After` header parsing | Transport behavior, not chrome. |
| `API ${status}` number | Technical HTTP status. |

Precedence must remain:

```text
first field-error message > payload.message > frontend fallback helper
```

Only the last branch localizes.

## 8. Test Plan

### 8.1 New Helper Spec

Create `apps/web/tests/meta-api-error-labels.spec.ts`:

- `metaApiErrorLabel('error.forbidden', false/true)`
- `metaApiErrorLabel('error.unauthenticated', false/true)`
- `metaApiErrorLabel('error.validation', false/true)`
- `apiFieldValidationFallback(false/true)`
- `apiDefaultErrorMessage('FORBIDDEN', 403, false/true)`
- `apiDefaultErrorMessage('UNAUTHENTICATED', 401, false/true)`
- `apiDefaultErrorMessage('VALIDATION_ERROR', 422, false/true)`
- `apiDefaultErrorMessage('SOMETHING_NEW', 418, false/true) === 'API 418'`
- ALL_KEYS / label-map lockstep if the module exposes a key list.

### 8.2 API Client Spec Extensions

Extend `apps/web/tests/multitable-client.spec.ts`:

| Case | Expected |
| --- | --- |
| Existing default client + code-only `FORBIDDEN` | Still `Insufficient permissions`. |
| `new MultitableApiClient({ fetchFn, isZh: true })` + code-only `FORBIDDEN` | `权限不足`. |
| Constructor resolver `isZh: () => true` + `UNAUTHENTICATED` | `请先登录后继续。`. |
| Global resolver set to zh + singleton-style client without constructor locale | zh fallback. |
| Backend `payload.message` present in zh client | Raw backend message wins. |
| First field-error message present in zh client | Raw field message wins. |
| Missing field-error message in zh client | `验证失败` in `fieldErrors` and thrown message. |
| Unknown code/status in zh client | `API ${status}`. |
| Legacy string payload in zh client | Raw legacy string wins. |

Spec hygiene:

- Reset global resolver before/after the spec file to avoid cross-file leakage.
- Do not change existing EN assertions except to add explicit "EN default" wording.

### 8.3 App Wiring

No broad App render spec is required unless existing tests fail. If a small
assertion is cheap, add one that imports `setMultitableApiErrorLocaleResolver`
through the real module and verifies App registration does not throw. The API
client spec is the authoritative behavior spec for resolver output.

## 9. Preflight Grep

Before implementation, run:

```bash
grep -R -n "Validation failed\|Insufficient permissions\|Please sign in to continue\|Please check the submitted data and try again\|API \${status}" \
  apps/web/src/multitable/api/client.ts apps/web/tests/multitable-client.spec.ts

grep -R -n "new MultitableApiClient\|multitableClient" \
  apps/web/src/multitable apps/web/src/views apps/web/src/services apps/web/tests | head -120

grep -R -n "useLocale()" apps/web/src/App.vue apps/web/src/multitable | head -80
```

Verification MD must include:

- pre-implementation source fallback grep,
- post-implementation fallback grep showing no inline English fallback remains
  in `api/client.ts`,
- resolver registration grep in `App.vue`,
- raw-boundary test evidence.

## 10. Implementation Order

1. Rebase to latest `origin/main` and verify the branch is clean.
2. Run §9 preflight grep.
3. Add `meta-api-error-labels.ts` and helper tests.
4. Add resolver plumbing in `api/client.ts`.
5. Mechanically convert class methods to `this.parseJson(res)` / `await this.parseJson(res)`.
6. Wire `App.vue` locale resolver registration.
7. Extend `multitable-client.spec.ts` with EN default + zh resolver + raw precedence coverage.
8. Add verification MD with preflight, raw-boundary, and command evidence.
9. Run targeted tests:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-api-error-labels.spec.ts \
  tests/multitable-client.spec.ts \
  --watch=false
```

10. Run:

```bash
pnpm --filter @metasheet/web run type-check
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

11. Commit only Slice D files and stop before push.

## 11. Risk Register

| Risk | Mitigation |
| --- | --- |
| Vue composable dependency leaks into transport client | Do not import `useLocale()` from `api/client.ts`; App registers a resolver. |
| Existing tests expecting English fallback fail | EN remains default; reset resolver in client specs. |
| Backend/raw messages accidentally translated | Preserve precedence and add raw precedence tests. |
| Broad mechanical `parseJson` conversion misses a method | Use grep for `return parseJson(res)` / `await parseJson(res)` before and after. |
| Global resolver leaks between tests | Export reset path via `setMultitableApiErrorLocaleResolver(undefined)` and use spec hooks. |
| App-level resolver not active for singleton | Register in `App.vue`; client resolves global provider at error time, not construction time. |
| `ViewManager` creates its own client | Constructor without explicit locale uses global resolver, so App registration still applies. |
| Stored error strings do not update on locale toggle | Accept event-time semantics; future API failures use the current locale. |

## 12. Approval Gate

Slice D is implementation-ready only when these design points are accepted:

- New `meta-api-error-labels.ts` module owns API fallback labels.
- `api/client.ts` does not import `useLocale()`.
- EN default remains backward compatible.
- `App.vue` registers the production singleton locale resolver.
- Backend `payload.message`, field-error messages, and legacy string payloads stay raw.
- Existing `MultitableApiClient({ fetchFn })` tests remain valid without passing locale.
- Verification MD includes preflight grep, post-implementation grep, raw-boundary tests, and local command output.
