# Multitable RC Public Form Smoke · Development

> Date: 2026-05-07
> Branch: `codex/multitable-rc-smoke-public-form-20260507`
> Base: `origin/main@35f70a230` (after PR #1416 ERP PLM phase 2 runtime closeout docs merge)
> Closes RC TODO line 108: `Smoke test public form submit path`

## Background

PR #1415 (`953a67082`) shipped the lifecycle smoke as the first executable Playwright spec under `packages/core-backend/tests/e2e/`. This PR forks that template for the **public form submit path** — the second of the six remaining RC smoke items — and adds two regression guards that exercise the unauthenticated submit's authorization boundary at the HTTP level.

Public form submission is a more interesting smoke than basic record create because it exercises a separate code path: `POST /api/multitable/views/:viewId/submit` runs without the actor's session token, instead authorizing the request via the view's persisted `publicForm.publicToken`. Regressions in that path either over-permit (anonymous writes against a disabled or rotated share) or under-permit (anon visitor with a valid token cannot submit). Both directions matter for governance.

## Scope

### In

- New Playwright spec `packages/core-backend/tests/e2e/multitable-public-form-smoke.spec.ts` containing three `test` cases:
  1. **Happy path**: admin creates base + sheet + string field + grid view (using the lifecycle template), then `PATCH /sheets/:sheetId/views/:viewId/form-share` with `{enabled: true, accessMode: 'public'}` to obtain `publicToken`. An anonymous request (no `Authorization` header) submits via `POST /views/:viewId/submit` with `{publicToken, data: {[fieldId]: 'pf-anon-…'}}`. The test then logs back in as admin and uses `GET /records?sheetId=…` to confirm the record persists with the expected cell value.
  2. **Disabled-view regression guard**: admin creates the same sheet + view layout but **does not** call PATCH form-share. Anonymous submit with a fabricated `publicToken` returns `401` with `Authentication required`.
  3. **Rotated-token regression guard**: admin enables form-share, captures `oldToken`, calls `POST /form-share/regenerate` to obtain `newToken`, asserts `oldToken !== newToken`. Anonymous submit with `oldToken` returns `401` with `Authentication required`; anonymous submit with `newToken` succeeds and returns the submitted value. Confirms the regenerate endpoint actually invalidates the prior credential rather than just adding a parallel one.
- README addition pointing to the new spec.
- RC TODO update marking the public-form smoke as covered by PR #1417 while preserving the live-stack execution caveat.
- Both auth helpers (`authPost`, `authPatch`, `authGet`) and the shared `setupSheetWithStringField` are local to this spec; not yet refactored into a common e2e helper module to keep the patch surface narrow. Three smoke files all sharing this scaffold is the threshold at which extracting helpers makes sense.

### Out

- The remaining 4 RC smoke items (`formula editor`, `Gantt rendering`, `Hierarchy rendering`, `automation send_email`).
- DingTalk-protected public form access mode (`accessMode: 'dingtalk'` / `'dingtalk_granted'`) — requires a configured DingTalk corp tenant fixture; out of scope for this PR.
- Public form `expiresAt` / TTL enforcement — covered structurally by the rotated-token test but not exercised explicitly via clock manipulation.
- Frontend public-form view (`/multitable/{sheetId}/{viewId}` with `?publicToken=…` query) DOM rendering. The lifecycle smoke already exercises the workbench DOM end-to-end; the public form's value is in its API contract, not its frontend layout.

## K3 PoC Stage 1 Lock applicability

- Does NOT modify `plugins/plugin-integration-core/*`.
- Adds a test harness for already-shipped multitable surface — no new platform capability.
- Does NOT touch DingTalk / public-form runtime / migration code; only consumes the existing endpoints.

## Implementation notes

### Why three tests instead of one

The lifecycle smoke (#1415) used a 1+1 shape (happy path + autoNumber regression guard). The public form path has two distinct authorization-boundary failure modes — disabled-view and rotated-token — that have historically been the most subtle bug class in this surface (silent over-permit). Covering both adds ~30 lines and meaningfully increases the test's value as a deploy gate.

### Why use `accessMode: 'public'` and not the default

The PATCH form-share schema accepts `accessMode: 'public' | 'dingtalk' | 'dingtalk_granted'`. Default behavior depends on `normalizePublicFormAccessMode` of an absent value, which the code reads as "fall back to existing config". Passing `'public'` explicitly removes ambiguity and makes the smoke independent of any default-mode flips elsewhere in the stack.

### Why anonymous submit uses no `Authorization` header at all (vs invalid token)

Sending no header at all forces the route to take the public-token branch. Sending an invalid Bearer token would force the auth middleware to reject before reaching the public-form code path, which would test the wrong invariant.

### Why the rotated-token test asserts both 401 AND that `newToken` works

If only the 401 case were asserted, a regression that broke `regenerate` entirely (always returning the same token, but also rejecting submissions) would still pass. The "new token works" sanity completes the bracket: regenerate must produce a different value AND that value must be honored by submit.

## Files changed

| File | Lines |
|---|---|
| `packages/core-backend/tests/e2e/multitable-public-form-smoke.spec.ts` | +new |
| `packages/core-backend/tests/e2e/README.md` | +1 / -1 |
| `docs/development/multitable-feishu-rc-todo-20260430.md` | public-form smoke marked complete |
| `docs/development/multitable-rc-public-form-smoke-development-20260507.md` | +new |
| `docs/development/multitable-rc-public-form-smoke-verification-20260507.md` | +new |

## Known limitations

1. **CI does not provision the dev stack** — same caveat as PR #1415. The suite skip-passes by default; promoting to a hard gate is a follow-up CI provisioning task.
2. **Local dev must have the public-form rate limiter relaxed or unset** — `conditionalPublicRateLimiter(publicFormSubmitLimiter)` may throttle rapid reruns. Acceptable for nightly smoke.
3. **No DingTalk-protected mode coverage** — see Out section above.
4. **Test data not cleaned up** — timestamp + random suffix prevents collision; matches lifecycle smoke's policy.

## Cross-references

- RC TODO master: `docs/development/multitable-feishu-rc-todo-20260430.md` (line 108, `Smoke test public form submit path`)
- Pattern source: PR #1415 (`953a67082`) — multitable lifecycle smoke
- Endpoints exercised: `PATCH /sheets/:sheetId/views/:viewId/form-share`, `POST /sheets/:sheetId/views/:viewId/form-share/regenerate`, `POST /views/:viewId/submit`, `GET /records?sheetId=…`
