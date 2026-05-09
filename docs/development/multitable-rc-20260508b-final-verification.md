# Multitable RC `2026-05-08b` — Final Verification

> Date: 2026-05-08
> RC tag: [`multitable-rc-20260508b-08c6036284`](https://github.com/zensgit/metasheet2/releases/tag/multitable-rc-20260508b-08c6036284)
> RC commit: `08c6036284bf975dc1396c752d07f44486c7d4b2`
> Validated against image: `ghcr.io/zensgit/metasheet2-{backend,web}:08c6036284bf975dc1396c752d07f44486c7d4b2`
> Predecessor: `multitable-rc-20260508-1b06bf286` (API/automation GO baseline)

This is the **canonical evidence archive** for the `2026-05-08b` RC. The earlier RC tag `multitable-rc-20260508-1b06bf286` shipped the API/automation surfaces; this `b` cut adds the UI Gantt sign-off after the dependency-arrow render fix (PR #1444). The artifacts referenced below are checked into this commit so future audits do not need to chase shell history or `/tmp` files.

## Verification matrix

| Surface | Tool | Run | Result |
|---|---|---|---|
| API + automation surfaces | `pnpm verify:multitable-rc:staging` (pure HTTP harness) | 2026-05-08T14:27:27Z → 14:27:30Z (~3.2 s) | **7/7 pass** |
| UI Gantt rendering + dep arrow + validation | `multitable-gantt-smoke.spec.ts` (chromium 1208, `--workers=1`) | 2026-05-08T14:30:13Z (14.0 s elapsed) | **3/3 pass** |

## API harness — 7/7 pass

Source: `pnpm verify:multitable-rc:staging` against the deployed image, run from the operator side via SSH tunnel into 142's `:8081`.

```
$ pnpm verify:multitable-rc:staging
[rc-smoke] PASS lifecycle (627ms)
[rc-smoke] PASS public-form (378ms)
[rc-smoke] PASS hierarchy (243ms)
[rc-smoke] PASS gantt-config (223ms)
[rc-smoke] PASS formula (163ms)
[rc-smoke] PASS automation-email (1225ms)
[rc-smoke] PASS autoNumber-backfill (305ms)
[rc-smoke] result: 7 pass / 0 fail / 0 skip / 7 total
```

Full report: [`multitable-rc-20260508b-api-harness-report.md`](./multitable-rc-20260508b-api-harness-report.md).

What each check exercises (recap; full implementation lives at `scripts/verify-multitable-rc-staging-smoke.mjs`):

- **lifecycle** — base/sheet/field/view/record + GET records readback
- **public-form** — admin enables `accessMode:'public'`, anonymous submit using the issued `publicToken`, admin verifies persisted; stale-token negative
- **hierarchy** — self-link parent + PATCH self-parent → 400 + `error.code === 'HIERARCHY_CYCLE'`
- **gantt-config** — gantt view PATCH with non-link `dependencyFieldId` → 400 + `VALIDATION_ERROR` + message contains `self-table link field`
- **formula** — formula field with `={A.id}+{B.id}` expression + GET fields verifies persisted property
- **automation-email** — `record.created` → `send_email` rule via the **real event chain** (not `/test`); poll `/logs?limit=10` for up to 12 s; assert `execution.status === 'success'`, `step.actionType === 'send_email'`, `step.status === 'success'`, `step.output.recipientCount === 2`, `step.output.notificationStatus === 'sent'`
- **autoNumber-backfill** — pre-create 3 records, then add an `autoNumber` field with `start: 1000, prefix: 'INV-', digits: 4`; assert all 3 pre-existing records receive backfilled values, raw client write returns 403 + `FIELD_READONLY`, fresh post-backfill record gets `value >= start + 3`

## UI Gantt smoke — 3/3 pass

Source: `pnpm --filter @metasheet/core-backend exec playwright test --config tests/e2e/playwright.config.ts multitable-gantt-smoke.spec.ts --workers=1` with `FE_BASE_URL` / `API_BASE_URL` pointed at a tunneled `127.0.0.1:18081 → 142:8081`, fresh admin JWT minted via `scripts/gen-staging-token.js` shape (canonical `{userId, email, role}` claims) inside the `metasheet-backend` container.

```
$ FE_BASE_URL=http://127.0.0.1:18081 API_BASE_URL=http://127.0.0.1:18081 \
  AUTH_TOKEN="$(cat <staging-admin-jwt>)" \
  pnpm --filter @metasheet/core-backend exec playwright test \
    --config tests/e2e/playwright.config.ts \
    multitable-gantt-smoke.spec.ts --workers=1

Running 3 tests using 1 worker

  ✓  1 tests/e2e/multitable-gantt-smoke.spec.ts:66:7 › Multitable Gantt smoke › renders task bars and labels for records with date ranges (5.3s)
  ✓  2 tests/e2e/multitable-gantt-smoke.spec.ts:95:7 › Multitable Gantt smoke › renders dependency arrows when dependencyFieldId is configured (5.6s)
  ✓  3 tests/e2e/multitable-gantt-smoke.spec.ts:134:7 › Multitable Gantt smoke › rejects saving a gantt view with a non-link dependencyFieldId (VALIDATION_ERROR) (1.7s)

  3 passed (14.0s)
```

Per-case coverage:

- **Bars**: `.meta-gantt__bar` selector visible (`count >= 2`); record names rendered as task labels.
- **Dependency arrows**: with `dependencyFieldId` configured pointing at a self-table link field, `.meta-gantt__dependency-arrow` selector visible (`count >= 1`). This is the case that previously failed pre-PR #1444 — the fix routed sheet-anchored URLs through `loadSheetMeta(sheetId, {viewId})` instead of `loadBaseContext(bases[0], …)`, avoiding the 403 on `/context` for sheets that do not live under the user's first base.
- **Backend validation**: PATCH `/views/:viewId` with a non-link `dependencyFieldId` → 400 + `VALIDATION_ERROR` + body containing `self-table link field`. Exercises `validateGanttDependencyConfig` at the HTTP layer.

## Composition / how this RC was reached

Sequence of merges that produced `08c6036284`:

| PR | Title | Merge contribution |
|---|---|---|
| #1406 | feat(multitable): harden auto number fields | autoNumber baseline |
| #1409 | feat(multitable): tighten Gantt dependency field to link-only | dependency type narrowed |
| #1410 | feat(multitable): inline name-conflict validation in Field Manager | UX polish |
| #1412 | feat(multitable): enforce self-table gantt dependencies | dependency cross-table guard |
| #1415 | test(multitable): add RC lifecycle Playwright smoke | RC smoke series start |
| #1417 | test(multitable): add RC public form submit Playwright smoke | RC smoke 2/6 |
| #1419 | test(multitable): add RC Hierarchy smoke and HTTP cycle guard | RC smoke 3/6 |
| #1421 | test(multitable): add RC Gantt smoke and HTTP dependency-config guard | RC smoke 4/6 |
| #1424 | test(multitable): add RC formula smoke and extract shared helpers | RC smoke 5/6 + helpers |
| #1428 | test(multitable): add RC automation send_email smoke (option 2) | RC smoke 6/6 |
| #1431 | perf(multitable): collapse autoNumber backfill into single window UPDATE | gemini perf follow-up |
| #1432 | test(multitable): add RC staging remote verification harness | `verify:multitable-rc:staging` |
| #1435 | fix(multitable): extend automation_rules CHECK to include send_email | first staging-revealed bug |
| #1436 | fix(multitable): jsonb double-encoding + executor exception swallow in AutomationLogService | second staging-revealed bug |
| #1438 | docs(multitable): archive RC staging verification | `2026-05-08-1b06bf286` evidence archive |
| #1440 | feat(multitable): support staging UI smoke auth bootstrap (forced view modes) | Workbench `?mode=…` support |
| #1441 | test(multitable): force Gantt mode in RC smoke | smoke deeplinks `?mode=gantt` |
| #1444 | fix(multitable): resolve sheet's owning base via /context when URL lacks baseId | UI Gantt dep-arrow render fix |

The two preceding RC tags:

- `multitable-rc-20260508-1b06bf286` — API/automation GO baseline (pre-#1444)
- `multitable-rc-20260508b-08c6036284` — UI sign-off complete (this RC, post-#1444)

## Operational pointers

The harness pair to use for future RCs:

```bash
# Backend / automation surfaces — pure HTTP, ~3 s
pnpm verify:multitable-rc:staging

# UI Gantt surfaces — Playwright + Chromium, requires SSH tunnel
pnpm verify:multitable-rc:ui  # see this PR
```

`verify:multitable-rc:ui` is added in this PR so future closeouts do not conflate "API harness 7/7" with "UI smoke complete". The script wraps the existing `multitable-gantt-smoke.spec.ts` with the env contract documented in `scripts/verify-multitable-rc-ui-smoke.sh`.

## Unverified surfaces (out of scope for this RC)

- **Hierarchy drag-to-reparent UI** — covered by client-side vitest `apps/web/tests/multitable-hierarchy-view.spec.ts`; not exercised against staging Chromium in this RC.
- **Formula editor click flows** — token-insertion / function-picker / inline diagnostics are covered by `apps/web/tests/multitable-formula-editor.spec.ts`; not exercised against staging Chromium.
- **DingTalk-protected public form access modes** (`'dingtalk'`, `'dingtalk_granted'`) — require corp tenant fixtures; out of scope.
- **Real SMTP delivery** — `EmailNotificationChannel` is mocked in dev/staging; `notificationStatus === 'sent'` is the wire-level signal, not actual mail receipt.

## Cross-references

- API harness: `scripts/verify-multitable-rc-staging-smoke.mjs` (PR #1432)
- UI smoke spec: `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts`
- UI smoke wrapper added by this PR: `scripts/verify-multitable-rc-ui-smoke.sh`
- Earlier RC verification archive: `docs/development/multitable-rc-staging-142-verification-20260508.md` (PR #1438)
- Investigation MD that ended with PR #1444: `docs/development/multitable-gantt-dependency-render-investigation-20260508.md` (already merged via #1444)
- Memory note that distilled the lessons: `~/.claude/projects/.../memory/feedback_metasheet2_skip_when_unreachable_blind_spot.md`
