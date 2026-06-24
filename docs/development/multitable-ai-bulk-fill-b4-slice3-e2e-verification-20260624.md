# B-4 Slice 3 — AI bulk-fill async over-cap: browser e2e verification — 2026-06-24

> **Status: verification-only.** This slice adds NO product/feature code. It proves the
> already-shipped B-4 over-cap flow (backend #3075, FE #3099, reconcile #3097/#3113) works
> **end-to-end in a real browser**, captures artifacts, and records one finding for a
> separate focused-fix PR.

## What this verifies (the locked scope)

A Playwright spec drives the **real stack** (browser → FE → backend job + worker → AI
provider), not the API:

1. **Over-cap happy path** — open the bulk-fill dialog from the field manager → generate →
   watch the progress UI → paginated review of the generated diff → commit the selected
   subset → read the commit summary.
2. **Cancel path** — start an over-cap job, click the dialog's cancel button **during
   polling**, and confirm it transitions **into review** of the already-generated rows
   (not a silent close), with the unreached rows shown truthfully as "not generated".

Spec: `packages/core-backend/tests/e2e/multitable-ai-bulk-fill-over-cap.e2e.spec.ts`.
Result: **2 passed (12.8s)** against the live stack.

## Harness / how it runs (dispatch-local, NOT PR-gated)

The backend e2e harness (`packages/core-backend/tests/e2e/`) expects a **pre-running
stack** and auto-skips when it's unreachable (`ensureServersReachable`), so this is **not a
PR gate** — the local run + the artifacts + this MD are the evidence. Bringup used here:

- **DB**: a fresh migrated Postgres (`pnpm --filter @metasheet/core-backend migrate`).
- **Backend** `:7778`: `dev:core` with `RBAC_BYPASS=true` and the AI env pointed at a mock
  provider — `MULTITABLE_AI_ENABLED=1`, `MULTITABLE_AI_PROVIDER=anthropic`,
  `MULTITABLE_AI_API_KEY=sk-test`, `MULTITABLE_AI_BASE_URL=http://127.0.0.1:9999`,
  `MULTITABLE_AI_MODEL=claude-opus-4-8`, `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS=1`, and
  **`MULTITABLE_AI_BULK_MAX_ROWS=1`** (forces 2+ rows into async job mode).
- **Mock AI** `:9999`: `tests/e2e/fixtures/mock-ai-server.mjs` returns Anthropic-shaped
  completions so the real worker generates deterministically with **zero live AI calls**.
  For the cancel test, start it with `MOCK_AI_DELAY_MS=1500` so the polling phase lasts long
  enough to click cancel.
- **Frontend** `:8899`: Vite dev (proxies `/api` → `:7778`).
- **Auth**: `GET /api/auth/dev-token` mints an admin JWT (sidesteps the absent `phase0` login
  user); injected into `localStorage` before app load. Locale pinned to `zh-CN` so the two
  text selectors (field-manager toggle, config gear) are deterministic — all dialog steps use
  locale-independent `data-test` selectors.

## Evidence (artifacts)

Committed copies: `docs/development/b4-slice3-e2e-shots/` (the spec also writes fresh ones to
`packages/core-backend/tests/e2e/artifacts/ai-bulk-fill/` on each run — that path is
gitignored).

| Screenshot | Phase |
|---|---|
| `01-progress.png` | generating — progress line "已生成 N / N" |
| `02-review.png` | paginated review — generated rows + charged-cost note ("$0.0032") |
| `03-commit-summary.png` | commit summary — "已写入 3 行" |
| `04-cancel-review.png` | post-cancel review — 1 row committable + "未生成 (4) … 未消耗配额" |

Per-test Playwright traces are emitted under `test-results/**/trace.zip`
(`npx playwright show-trace <zip>`); not committed (large binaries).

What the assertions lock:
- happy: progress UI appears; **3 generated rows**; cost note visible; commit summary shown;
  and — read straight from the API — **all 3 records were actually written**.
- cancel: the cancel button is present during polling; after clicking it the **dialog stays
  open** and shows the `pending`/"未生成" group + a `confirm` for the generated subset — a
  live demonstration of the #3113 truthful-status reconcile behavior at the UI layer.

## Finding (for a SEPARATE focused-fix PR — not fixed here)

**The open grid does not auto-refresh after a bulk-fill commit.** After the commit summary
reports "已写入 3 行", the grid's Summary column still renders the pre-fill "—"; the written
values appear only after a manual page reload. The data is correct — the API confirms the
records hold the AI output, and a reload renders them — so this is a **stale-view UX gap**,
not a write/correctness bug. The spec therefore asserts the write via the API (not the grid)
to avoid locking the stale behavior. Recommend a small focused fix: refresh the affected
view/records after `commitJob` resolves.

## Not covered (by design)

- **Hard-restart reconciliation** through the real boot path is not exercised here (it needs
  a backend restart mid-test, which this harness doesn't manage). Its substance is locked by
  the #3113 real-DB golden, and the cancel path above exercises the same
  `pending → pending_not_generated` truthful-status surface in the UI.
