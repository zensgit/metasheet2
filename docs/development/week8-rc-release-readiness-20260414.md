# Week 8 RC Release Readiness — Multitable

Date: 2026-04-14
Branch: `main`

## Scope Snapshot

| Area | Mainline status | Evidence |
|---|---|---|
| Week 3 public form | Merged | `week3-4-5-dev-verification-20260414.md` |
| Week 4 field validation | Merged | `week3-4-5-dev-verification-20260414.md` |
| Week 5 API token + webhook | Merged | `week3-4-5-dev-verification-20260414.md` |
| Week 6 automation backend | Merged | `week6-7-frontend-dev-verification-20260414.md` |
| Week 7 dashboard backend | Merged | `week6-7-frontend-dev-verification-20260414.md` |
| Week 3-5 frontend managers | Merged | `week6-7-frontend-dev-verification-20260414.md` |
| Week 8 mainline hardening | Merged | `week3-5-mainline-hardening-*.md` + local rerun on `main` |

## Verified Gates

### Week 3-5 targeted backend regression

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/rate-limiter.test.ts \
  tests/integration/public-form-flow.test.ts \
  tests/unit/field-validation.test.ts \
  tests/integration/field-validation-flow.test.ts \
  tests/unit/api-token-webhook.test.ts \
  --reporter=dot
```

Result: `139/139` passed on `main`.

### Backend compile and build

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/core-backend build
```

Result: both passed after the Week 8 hardening slice.

### Previously documented merged validations

- Week 6 automation backend: `80` tests passed per [week6-7-frontend-dev-verification-20260414.md](/Users/chouhua/Downloads/Github/metasheet2/docs/development/week6-7-frontend-dev-verification-20260414.md:1)
- Week 7 dashboard backend: `50` tests passed per [week6-7-frontend-dev-verification-20260414.md](/Users/chouhua/Downloads/Github/metasheet2/docs/development/week6-7-frontend-dev-verification-20260414.md:1)
- Week 3-5 frontend managers: `29` tests passed per [week6-7-frontend-dev-verification-20260414.md](/Users/chouhua/Downloads/Github/metasheet2/docs/development/week6-7-frontend-dev-verification-20260414.md:1)

## Week 8 Hardening Included

- Comment canonical alias typing is now accepted in backend query contracts.
- API token auth middleware no longer fails TypeScript narrowing on invalid token results.
- Dashboard route helper definitions required by the merged backend path are present on `main`.
- Automation scheduler callback typing is aligned with the runtime executor signature.

## Remaining Risks

| Risk | Level | Note |
|---|---|---|
| Dashboard frontend UI is not on `main` | Medium | Backend endpoints are merged, but chart/dashboard UI remains a follow-up lane. |
| Manual smoke for public form / token / webhook paths not rerun in this turn | Medium | Existing docs cover automated gates; run smoke before external RC handoff. |
| Rate limiter is in-memory | Low | Acceptable for single-node V1, not final for horizontal scaling. |
| Webhook breaker/retry state is in-memory | Low | Acceptable for V1, but restart loses counters. |

## Recommendation

`main` is in a reasonable RC state for the merged Week 3-5 backend/frontend and Week 6-7 backend work. The current blocker for a broader feature-complete RC is the missing dashboard frontend lane on `main`, not backend readiness. The safest next step is:

1. keep Claude CLI on isolated `backend/contracts/integration` or `docs` worktrees,
2. keep Codex on `frontend/integration`,
3. run one focused dashboard frontend lane before broad RC sign-off.
