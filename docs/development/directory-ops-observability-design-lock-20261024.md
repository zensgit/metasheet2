# Directory OPS-03 read-side completion — 2026-10-24

Status: owner-authorized final closeout Draft/HOLD only. Refs original DingTalk integrated roadmap §7.4. Local runtime validation base fdb30a671686db8dbdbdf606f3a6f1b98add9969. Publication base 8a426818804897a20f7674c39c56b3a445909c3a preserves the subsequent #6529 approval-only change. All five upstream paths are outside this slice; main entry/router/config/package/lock and every validated OPS-03 source byte remain unchanged. Local results are retained by this correspondence, not claimed as rerun after the fast-forward; published-head CI remains required.

## Required result

- Existing platform-admin directory view renders operational alert details and reads BOTH run and alert pages/filters from server, including totals and global confirmation counts. Never infer global counts from first-page items.
- Run status is exactly all/running/completed/failed/aborted (the actual source statuses, not invented success). New filter validates enum, defaults only when omitted, filters count and rows with identical integration/status predicates, and uses deterministic ID tie-breakers for equal times.
- Alert all/pending/acknowledged filter is server-side, enum-strict, and retains existing ack alias semantics. Existing platform-admin permission boundary is unchanged; never infer this is tenant-admin authorization.
- Page/filter/integration/reset/unmount invalidate earlier headers, JSON continuations, errors and finally/loading updates. Selection switch immediately clears old observations. Refresh and post-ack reload preserve the intended current scope; late acknowledgement must not target another integration.
- Details use escaped operational fields only (fixed allowlisted counts and booleans); no arbitrary raw JSON/HTML, credentials, user/host data or new provider calls. Acknowledge remains the existing explicit POST action. No new writes or sync actions.

## Gates

1. Original-view named red reproduction plus real positive controls, before source changes.
2. Full new UI/composable tests + existing view neighbor; page2 contents, filters beyond page1, global counts, empty/error/403, shrink clamp, stale header/JSON/error/finally/reset/unmount, ack/switch target and escaped details.
3. Existing route file plus new strict-enum and permission cases; real isolated UTF8 PG tests for page/filter counts, equal-time ordering and integration isolation. No unreachable/skip green.
4. Domain push/classifier/actual execution and required runner registry wire the new frontend spec, preserving every old token.
5. Matching negative mutations, exact restoration, API contract/design parity, quality, synthetic real-entry screenshots at desktop/mobile, independent fixed-source review.
6. Published exact-head required CI is separate; all PRs stay Draft/HOLD.

No schema/migration, account-binding policy, provider IO, business configuration, feature flags, Stream/lifecycle enablement, R71/tag/release/merge/deployment or real UAT. Business50004 excluded. Historical08am remains inconclusive.

## Private admin read contract

These existing administrative routes are not entries in the public OpenAPI/SDK source. The query addition and existing response shapes are pinned by the full route tests; no public SDK generation is claimed.

| Route under /api/admin/directory | Query and response |
| --- | --- |
| GET /integrations/:integrationId/runs | page/pageSize; optional status all/running/completed/failed/aborted. data = items,total,page,pageSize. Omitted status keeps the legacy two-argument service call. |
| GET /integrations/:integrationId/alerts | page/pageSize; ack ?? filter selects all/pending/acknowledged. data = items,total,counts,page,pageSize,filter,ack. counts.total/pending/acknowledged are integration-global; total is filtered. |

Both retain page=1/pageSize=20 defaults and maxPageSize=100; public limit/offset parameters are not paging inputs. Invalid selected filter values return 400 with fixed enum-only messages; no silent fallback. Existing authentication and platform-admin/RBAC fallback remain unchanged (401/403 precede reads); this is not a new tenant-admin permission. The UI requests ten runs or twenty alerts per page.

## Actual local gate evidence

| Gate | Actual result and boundary |
| --- | --- |
| Original source reproduction | 2 positive controls + 9 named assertion failures after correcting weak DOM assertions in the first harness attempt. |
| Current new UI/composable/details | 42/42 actual passed, zero skip. Includes page/filter/reset/unmount, late headers/JSON/errors/finally, page shrink, background poll and acknowledgement-refresh races. |
| Existing view and lane neighbors | 83/83 existing view before final ack continuation fix; affected original ack positive then passed (1 passed/82 filtered exclusions). Workflow 34/34 and lane registration 63/63 on unchanged wiring. These are distinct runs, not a claimed fresh post-fix 83-case run. |
| Admin route contract | Full file 206/206 actual passed, zero skip; strict values, page protocol, alias precedence, full responses and platform-admin positive/negative controls. |
| Real isolated PG16 UTF8 | 456 migrations, pending 0; existing DB file 42/42 actual passed. Includes both integrations, count/row predicate parity, tied ID ordering, global counts and existing ack idempotency/isolation. Isolated cluster stopped and data retained. |
| Guard mutations | Matching stale-read, detail allowlist, registration, ack continuation, SQL status and SQL ordering failures with real positive controls. Filtered cases are excluded, not passed. Source hashes restored after every mutation. |
| Quality | Current candidate pnpm validate:all exit 0; explicit new-web-file lint exit 0. |
| Browser | Actual main.ts entry, synthetic APIs only, widths 1366/768/390; five scenario records and six screenshots, zero page errors. Both held A reads cannot replace B; current 403 clears rows and hides private error text. No panel horizontal overflow. Mobile alert details continue below the captured first viewport. |
| Independent review | kimi-code/k3.1-pro supplied-source static review found one introduced ack-refresh P2. Main reproduced three matching failures, repaired the success continuation and reran current UI/quality and matching mutations. Static closure returned no remaining confirmed issue; it does not certify runtime or unchanged permission boundaries. |
| Exact-head required CI | Pending publication and actual terminal results; local success is not CI success. |

Reproduction and negative-harness failures are retained separately: the first SQL negative selected no case (42 filtered exclusions), then only the corrected named negative and positive targets ran; the normal 42-case PG run was not repeated. The first browser navigation timed out before API requests; the second harness warmed real Vite modules before navigation with the same 30-second navigation budget and unchanged product configuration.

Screenshots are synthetic artifacts under artifacts/directory-ops-observability/screenshots/. Machine receipts, full JSON assertion counts, mutation patches/restoration hashes and browser request traces remain in the isolated validation evidence store. No whole-product, real provider, live tenant, Windows, soak or production acceptance is implied. OPS-02/W6 and owner/manual residuals are separate closeout items.
