# Native local organization department-head routing — verification (2026-10-27)

This backend increment reuses the canonical local organization, department and membership model. It adds independent `is_department_head`, default false, and a dedicated platform-admin GET/PATCH endpoint. A job title is not an approval permission. Local head resolution uses the native flag and active same-org identity links; external DingTalk rows retain their raw-list behavior.

## Contract

The new writer locks integration status (`FOR SHARE OF i`), then account, then department, binding the account to the locked local integration. A committed disable wins with404/no bit change; a writer holding the integration lock completes before a competing disable. The original membership XOR endpoint and B3 manager writer are unchanged.

Readers reject self/aliases, inactive accounts/users/departments/integrations, unlinked people and foreign org/integration/provider records. Local absence is authoritative, with no provider-raw fallback. Stable external-ID/account-ID order selects an eligible head. Parent walking retains its bounded/cycle/empty-level/dedup behavior. In-flight snapshots remain frozen; new instances observe changed roles.

The existing admin HTTP surface still resolves the server default org. This does not add a request-provided tenant selector, full organization UI, active-member enrollment UX, native manager-chain conversion or external binding application.

## Actual local phases

| Phase | Actual result |
| --- | --- |
| Original runtime / stored head flag | Direct manager control resolved, head absent; one expected-red program, not two Vitest cases |
| Workflow/default no-DB contract |3 passed |
| Initial whole native file |16 passed,1 alias-fixture-premise failure |
| Repaired alias anchor + stronger foreign-active-org fixture |2 passed,15 excluded; earlier16 greens not replayed |
| Reader/authority/archive faults |6 groups, each1 matching red +1 manager control,15 excluded; exact restore |
| Original candidate integration race | Actual200/head=true after committed disable; characterization1,20 excluded. Correctness1 red +1 control,19 excluded |
| Final status/fixture correction |6 affected passed,14 excluded, on20-case source |
| Share-lock omission / fixture-guard removal |2 groups, each1 matching red +1 manager control,18 excluded; exact restore |
| Existing resolver/chain neighbors |62 passed,2 broad-fake failures; after a narrow query discriminator those2 passed,24 excluded |
| Explicit same-path/parser lint | Current and baseline0 errors/0 warnings |
| Final production type-check / validate:all | Both exit0 |

Final source declares20 cases (sentinel1 +19 DB/HTTP). All20 qualify across phases; no fresh local whole20 or additive unique mutation/control count is claimed. The old alias fixture unintentionally became the requester's newest non-primary anchor; it is now older and the unchanged anchor selection is asserted. The old provider fake confused the new LEFT JOIN with its broad manager shape; only an explicit empty-native-probe discriminator changed.

A real kernel approval traversed manager then head. After a head-role change, the old instance retained its old assignee while a new instance froze the new head. Claim-free real sessions/database identity exercise admin/user refusals. These synthetic fixtures do not establish live UAT/provider operation.

## Migration apply and rollback

Only `zzzz20261027090000_add_local_department_head.ts` is added. An owned458 clone applied to459 and replayed without another migration; protected directory/user constraint definitions were exact. Catalog: boolean, NOT NULL, false default, partial department index.

A separate owned clone carried a nonempty old `is_manager=true/is_primary=true` membership:458→459→458→459 preserved its old row bytes and defaulted the new bit false. Down removed only the new index/column. The seed helper wrote its receipt/fixture but did not exit within its bound; that failure is retained. A continuation checked the existing seeded row with SQL and completed the migration sequence without repeating the seed. Every own PG start was finally stopped, port closed, data retained; source template unchanged.

Apply: `pnpm --filter @metasheet/core-backend db:migrate`.
One-step down: `pnpm --filter @metasheet/core-backend db:rollback`.
Executed only on owned synthetic clones.

## Preservation, review and remaining gates

TypeScript AST verifies all12 original resolver SQL literals, three manager functions and26 original unit test-call texts exact. The dedicated workflow migrates before unconditional whole native execution with EXPECT_DB=1; the no-DB default excludes that file. The provenance-pinned plugin workflow, dependencies, OpenAPI and feature switches are unchanged.

Independent review identified the integration-status race and disabled-default-anchor fixture revival. Both were corrected and mutation-checked. The fixture refuses a disabled-only default anchor before identity writes, rather than skipping or reactivating it. Follow-up had no confirmed new P1/P2 within its narrow source scope; main rechecked raw reports, restores and pins.

Current-head required CI and dedicated whole20 remain pending publication/execution; other-head greens never substitute. Parent owner/manual/frozen/live acceptance remains OPEN. No live organization/personnel/grant/template/provider change; no Ready/merge/deploy/R71/release. Stream/lifecycle/external writes OFF; real UAT/business50004 excluded; historical08PUT INCONCLUSIVE.
