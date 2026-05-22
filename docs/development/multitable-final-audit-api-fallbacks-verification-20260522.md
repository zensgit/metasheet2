# Multitable Final Audit Slice D: API Fallback I18n Verification (2026-05-22)

## 1. Scope / DoD

Slice D localizes frontend-generated multitable API fallback errors while
preserving backend/user messages as raw.

DoD:

- New `meta-api-error-labels.ts` owns API fallback labels.
- `api/client.ts` does not import `useLocale()`.
- `MultitableApiClient({ fetchFn })` keeps English defaults.
- Production singleton reads locale through an App-registered resolver.
- Raw precedence remains: first field-error message > backend payload message >
  frontend fallback helper.
- Targeted Vitest, type-check, build, and diff-check pass.

Changed files:

```text
apps/web/src/App.vue
apps/web/src/multitable/api/client.ts
apps/web/src/multitable/utils/meta-api-error-labels.ts
apps/web/tests/App.spec.ts
apps/web/tests/meta-api-error-labels.spec.ts
apps/web/tests/multitable-client.spec.ts
docs/development/multitable-final-audit-api-fallbacks-design-20260522.md
docs/development/multitable-final-audit-api-fallbacks-verification-20260522.md
```

## 2. Preflight Evidence

Source fallback grep before implementation:

```text
apps/web/src/multitable/api/client.ts:174:        : 'Validation failed'
apps/web/src/multitable/api/client.ts:186:          typeof message === 'string' && message.trim() ? message.trim() : 'Validation failed',
apps/web/src/multitable/api/client.ts:198:      return 'Insufficient permissions'
apps/web/src/multitable/api/client.ts:200:      return 'Please sign in to continue.'
apps/web/src/multitable/api/client.ts:202:      return 'Please check the submitted data and try again.'
apps/web/tests/multitable-client.spec.ts:429:    expect(error.message).toBe('Insufficient permissions')
apps/web/tests/multitable-client.spec.ts:437:        error: 'Insufficient permissions',
apps/web/tests/multitable-client.spec.ts:443:    expect(error.message).toBe('Insufficient permissions')
```

Consumer audit:

```text
grep -R -n "new MultitableApiClient\|multitableClient" apps/web/src/multitable apps/web/src/views apps/web/src/services apps/web/tests | wc -l
129
```

Conclusion: per-method caller-pass `isZh` would be high churn. The chosen
client-level resolver avoids touching those consumers and keeps their default
behavior stable.

`useLocale()` audit confirmed `App.vue` is the top-level locale owner:

```text
apps/web/src/App.vue:85:const { locale, isZh, setLocale } = useLocale()
```

## 3. Implementation Evidence

`api/client.ts` no longer contains inline frontend fallback strings:

```bash
grep -R -n "Validation failed\|Insufficient permissions\|Please sign in to continue\|Please check the submitted data and try again" apps/web/src/multitable/api/client.ts
```

Output: no matches.

`client.ts` now uses the label helper and resolver:

```text
apps/web/src/multitable/api/client.ts:72:import { apiDefaultErrorMessage, apiFieldValidationFallback } from '../utils/meta-api-error-labels'
apps/web/src/multitable/api/client.ts:87:export function setMultitableApiErrorLocaleResolver(
apps/web/src/multitable/api/client.ts:93:function resolveGlobalApiErrorIsZh(): boolean {
apps/web/src/multitable/api/client.ts:124:    const error = new Error(firstFieldError(payload.fieldErrors) ?? payload.message ?? apiDefaultErrorMessage(payload.code, res.status, isZh)) as Error & {
apps/web/src/multitable/api/client.ts:189:        : apiFieldValidationFallback(isZh)
apps/web/src/multitable/api/client.ts:201:          typeof message === 'string' && message.trim() ? message.trim() : apiFieldValidationFallback(isZh),
apps/web/src/multitable/api/client.ts:752:    return resolveGlobalApiErrorIsZh()
```

`parseJson` mechanical conversion check:

```text
grep -n "return parseJson(res)\|await parseJson(res)\|return parseJson<\|await parseJson<" apps/web/src/multitable/api/client.ts
apps/web/src/multitable/api/client.ts:756:    return parseJson<T>(res, this.resolveIsZh())
```

Only the private wrapper calls the module-level parser. Class methods use
`this.parseJson(...)`.

App-level resolver registration:

```text
apps/web/src/App.vue:77:import { setMultitableApiErrorLocaleResolver } from './multitable/api/client'
apps/web/src/App.vue:86:const { locale, isZh, setLocale } = useLocale()
apps/web/src/App.vue:87:setMultitableApiErrorLocaleResolver(() => isZh.value)
```

`App.spec.ts` resets resolver state and mocks `apiFetch` because App now imports
the multitable API client module:

```text
apps/web/tests/App.spec.ts:4:import { setMultitableApiErrorLocaleResolver } from '../src/multitable/api/client'
apps/web/tests/App.spec.ts:48:  apiFetch: vi.fn(),
apps/web/tests/App.spec.ts:64:    setMultitableApiErrorLocaleResolver(undefined)
```

## 4. Raw Boundary

Raw precedence tests covered:

| Boundary | Test evidence |
| --- | --- |
| First field-error message wins | Existing `surfaces first field error for submitForm failures` still asserts `Field is readonly`. |
| Backend payload message wins | New localized-client test asserts raw `Backend policy denied access`. |
| Legacy string payload stays raw | Existing permission failure test still asserts raw `Insufficient permissions`. |
| Missing field-error message localizes | New zh test asserts `fieldErrors: { fld_code: '验证失败' }`. |
| Unknown code/status stays technical | New zh test asserts `API 418`. |
| Constructor locale overrides global resolver | New test sets global zh and constructor EN, then asserts English validation fallback. |

No backend message, field ID, error code, status, server version, retry header,
or legacy string payload is translated.

## 5. Test Results

Targeted Vitest:

```text
pnpm --filter @metasheet/web exec vitest run tests/meta-api-error-labels.spec.ts tests/multitable-client.spec.ts tests/App.spec.ts --watch=false

✓ tests/meta-api-error-labels.spec.ts  (5 tests)
✓ tests/multitable-client.spec.ts  (29 tests)
✓ tests/App.spec.ts  (1 test)

Test Files  3 passed (3)
Tests       35 passed (35)
```

Type-check:

```text
pnpm --filter @metasheet/web run type-check
vue-tsc -b
exit 0
```

Build:

```text
pnpm --filter @metasheet/web build
✓ 2423 modules transformed.
✓ built in 6.13s
```

Build warning observed:

```text
WorkflowDesigner.vue is dynamically imported by appRoutes.ts but also statically imported by viewRegistry.ts and AttendanceWorkflowDesigner.vue.
```

This warning is pre-existing and unrelated to Slice D.

## 6. Remaining Validation

Before commit:

```bash
git diff --check origin/main..HEAD
git status --short
```

Expected PR scope:

```text
apps/web/src/App.vue
apps/web/src/multitable/api/client.ts
apps/web/src/multitable/utils/meta-api-error-labels.ts
apps/web/tests/App.spec.ts
apps/web/tests/meta-api-error-labels.spec.ts
apps/web/tests/multitable-client.spec.ts
docs/development/multitable-final-audit-api-fallbacks-design-20260522.md
docs/development/multitable-final-audit-api-fallbacks-verification-20260522.md
```

No backend/contract/migration/attendance/K3 files are in scope.
