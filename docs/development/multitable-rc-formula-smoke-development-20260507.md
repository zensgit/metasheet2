# Multitable RC Formula Smoke + Helper Extraction · Development

> Date: 2026-05-07
> Branch: `codex/multitable-rc-smoke-formula-20260507`
> Base: `origin/main@3ce20f59a` after reviewer rebase
> Closes RC TODO item: `Smoke test formula editor`

## Background

PRs #1415 / #1417 / #1419 / #1421 shipped the first four executable RC smoke specs (lifecycle, public-form, hierarchy, gantt). Each spec carried inline copies of the same scaffolding: server reachability check, `phase0@test.local` login, `authPost` / `authPatch` / `authGet` helpers, `injectTokenAndGo`, and a `setup<Type>Sheet` factory. Three inline copies was acceptable; the four-copy threshold came due, and the fifth smoke would have been a fifth divergent copy.

This PR closes the formula RC item by combining two layers of evidence:
- New Playwright smoke for formula-field persistence, sanitization, and workbench column rendering.
- Existing frontend formula-editor suite for field-token insertion, function insertion, and inline diagnostics.

It also extracts the shared scaffolding into `packages/core-backend/tests/e2e/multitable-helpers.ts`, then migrates all four prior smokes to consume it. The four merged specs lose ~50 lines each of inline boilerplate, and the formula spec is the first to be written natively against the helper module.

## Scope

### In

- New helper module `packages/core-backend/tests/e2e/multitable-helpers.ts`:
  - `FE_BASE_URL` / `API_BASE_URL` constants
  - `Entity` / `ApiEnvelope<TData>` / `FailureResponse` types
  - `requireValue<T>` for safe optional unwrap
  - `ensureServersReachable(request)` — checks both backend and frontend, calls `test.skip` if either fails
  - `loginAsPhase0(request)` — returns the phase0 token or skips
  - `AuthClient` interface + `makeAuthClient(request, token)` factory
    - Methods: `post<TData>` / `patch<TData>` / `get<TData>` / `postExpectingFailure` / `patchExpectingFailure`
    - All typed-parametric on `TData extends Record<string, unknown>`
    - No `any`; failure responses surface as `{ status, body }` with envelope shape
  - `injectTokenAndGo(page, token, path)` — browser-side localStorage prime + navigate
  - `uniqueLabel(prefix)` — `${prefix}-${Date.now()}-${random}` for collision-free fixture naming
  - Setup primitives: `createBase` / `createSheet` / `createField` / `createView` / `createRecord` (each returns a typed `Entity` and throws via `requireValue` on missing data)
- New formula smoke spec `packages/core-backend/tests/e2e/multitable-formula-smoke.spec.ts` with four cases:
  1. **Render**: create base + sheet + numA + numB + formula field with expression `={A.id} + {B.id}`. Add a record carrying inputs (no formula value). GET fields and assert the formula field persists with the expected `property.expression`. Browser asserts the workbench grid header shows all three column names without crashing.
  2. **PATCH expression update**: PATCH `/api/multitable/fields/:id` with a new expression. GET fields and assert the new value replaced the old.
  3. **Sanitize regression**: PATCH with a numeric (non-string) `expression`. The route's `sanitizeFieldProperty` formula branch should coerce to empty string rather than persisting a non-string or throwing.
  4. **Helpers envelope contract**: tiny smoke confirming `client.get<{fields: …}>` returns `{ ok, data: { fields: [] } }` for an empty sheet — fails first if any of the sibling specs would silently drift on envelope shape.
- Migrations of four sibling specs to use the helpers:
  - `multitable-lifecycle-smoke.spec.ts` (2 tests)
  - `multitable-public-form-smoke.spec.ts` (3 tests; anonymous POST stays inline as `anonymousPost(request, …)` since the helpers deliberately never strip the `Authorization` header)
  - `multitable-hierarchy-smoke.spec.ts` (3 tests)
  - `multitable-gantt-smoke.spec.ts` (3 tests)
- Frontend editor verification by rerunning `apps/web/tests/multitable-formula-editor.spec.ts`, which covers:
  - field-chip token insertion into the formula textarea
  - function catalog filtering and snippet insertion
  - diagnostics for syntax, argument-count, and unknown-field errors
- README "What's tested" addition for formula spec + new "Shared scaffolding" subsection pointing at the helper module.

### Out

- The remaining 1 RC smoke item: `automation send_email`. It needs an email-mock harness or SMTP stub before a smoke is meaningful; out of scope for this lane.
- Full browser E2E clicks through the field-manager drawer. The editor interactions themselves are already covered by `apps/web/tests/multitable-formula-editor.spec.ts`; promoting those interactions to a browser-level hard gate can remain a follow-up once the dev-stack runner is provisioned.
- handoff-journey.spec.ts is deliberately NOT migrated. It targets PLM federation, has its own session shape (cookies, B_ID constant, click-driven UX), and predates this lane; mixing it in would muddy the diff. If a future PLM smoke joins the family, helpers can grow to host it.

## K3 PoC Stage 1 Lock applicability

- Does NOT modify `plugins/plugin-integration-core/*`.
- Adds a test harness for already-shipped multitable surface — no new platform capability.
- Does NOT touch DingTalk / public-form runtime / Gantt runtime / Hierarchy runtime / formula runtime / migration / OpenAPI; only consumes existing endpoints.

## Implementation notes

### `AuthClient` shape

The factory binds `(request, token)` and returns five methods. Each happy-path method (`post`, `patch`, `get`) is generic on `TData extends Record<string, unknown>` and returns `ApiEnvelope<TData>`. Each failure-expecting method returns `{ status, body }` for inspection rather than throwing — that mirrors how the spec authors actually want to assert (`expect(fail.status).toBe(400)` is more direct than try/catch on a thrown Error).

The `expectOk` / `expectFailure` internal helpers branch on the HTTP method to call the right `request.post` / `patch` / `get`, then parse the body and decide whether to throw. Two `if-else` chains are slightly less elegant than a generic dispatch, but they are 10 lines, fully typed, and testable; abstracting further would just add cleverness.

### Why `fields: Entity[]` instead of `fields: Map<string, Entity>`

Specs name their fields explicitly (`title`, `numA`, `numB`, `parent`). A Map keyed by name would force callers to write `setup.fields.get('Title')!` everywhere; flat individual `createField` calls keep the destructuring straightforward. The "named-fields factory" temptation is rejected.

### Why the public-form spec keeps `anonymousPost` inline

The whole point of the public-form smoke is to call the submit endpoint WITHOUT an `Authorization` header. The helper-module's auth client always adds one. Hardcoding "send no auth" into the helpers was tempting, but it would couple the helpers to one spec's edge case. Inline `anonymousPost(request, …)` is two lines and clarifies the intent at the call site.

### Why the formula spec includes a "helpers envelope contract" test

Helpers + 5 specs is now ~600 lines spread across files. If the response envelope contract changes upstream (e.g., backend renames `data.fields` to `data.records.fields` or wraps `ok` differently) every spec drifts the same way. The envelope-shape guard fails first and centralizes the surface for one investigation. Cheap insurance — 12 lines.

### Diff hygiene during migration

Each migrated spec drops ~50 lines of inline boilerplate and gains an import block. The behavior-level test bodies are preserved verbatim; only the plumbing changes. This means:
- `git diff` per migrated spec shows large delete + small import-and-call replacement
- No changes to assertions, selectors, status codes, or error-body shapes
- The `expect(...).toBe(...)` / `expect(...).toMatchObject(...)` lines are unchanged

A reviewer can verify migration correctness by reading just the new "behavior" sections and confirming the inline replacements correspond to typed helper calls.

### `multitable-helpers.ts` lives next to the specs, not in `apps/web` or a top-level shared

The helpers reference `@playwright/test` types and assume the metasheet backend's REST shape. Putting them at `packages/core-backend/tests/e2e/` ties their scope to E2E tests of one project, avoiding the "shared util that grows tentacles" trap.

## Files changed

| File | Lines |
|---|---|
| `packages/core-backend/tests/e2e/multitable-helpers.ts` | +new (~190) |
| `packages/core-backend/tests/e2e/multitable-formula-smoke.spec.ts` | +new (~165) |
| `packages/core-backend/tests/e2e/multitable-lifecycle-smoke.spec.ts` | rewritten (-110 / +75) |
| `packages/core-backend/tests/e2e/multitable-public-form-smoke.spec.ts` | rewritten (-110 / +85) |
| `packages/core-backend/tests/e2e/multitable-hierarchy-smoke.spec.ts` | rewritten (-130 / +90) |
| `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts` | rewritten (-150 / +110) |
| `packages/core-backend/tests/e2e/README.md` | +1 spec entry + new "Shared scaffolding" subsection |
| `docs/development/multitable-feishu-rc-todo-20260430.md` | tick formula line + add PR/MD pointers |
| `docs/development/multitable-rc-formula-smoke-development-20260507.md` | +new |
| `docs/development/multitable-rc-formula-smoke-verification-20260507.md` | +new |

## Known limitations

1. **CI does not provision the dev stack** — same caveat as #1415 / #1417 / #1419 / #1421. Suite skip-passes by default; promoting to a hard gate is a follow-up CI provisioning task.
2. **Browser-level field-manager clicks deferred** — the Playwright smoke exercises the persisted formula-field surface. The editor UI interactions required by the RC item are covered by the existing frontend formula-editor suite and were rerun during review.
3. **`automation send_email` smoke is the last remaining RC item** — it needs an email-mock or SMTP stub before a smoke is meaningful.
4. **Test data not cleaned up** — `uniqueLabel` prevents collisions; matches the prior smoke policy.

## Cross-references

- RC TODO master: `docs/development/multitable-feishu-rc-todo-20260430.md`
- Frontend formula editor suite: `apps/web/tests/multitable-formula-editor.spec.ts`
- Formula property sanitize: `sanitizeFieldProperty` formula branch in `packages/core-backend/src/routes/univer-meta.ts`
- Formula evaluation engine: `packages/core-backend/src/multitable/formula-engine.ts`
- Pattern source: PR #1421 (`e23a5ab53`) — multitable Gantt smoke
