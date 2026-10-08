# Time Machine existing sheet_config entry admission companion — 2026-10-08

Status: bounded test-only implementation; verification pending. Frozen caller base: `8662ede1f64831c2cb3c480400b9c5b6e12d6135`. Branch: `codex/tm-sheet-config-admission-20261008`.

## Contract and scope

Use synthetic local scratch resources to exercise three existing REST writers through a pinned HTTP listener and the real `univerMetaRouter`: `PUT /sheets/:sheetId/row-level-read-deny`, `PUT /sheets/:sheetId/conditional-rules`, and `PATCH /sheets/:sheetId` (display rename). This companion protects admission at existing writers; it introduces no product capability, permission, production flag, migration, restore path, background worker, or runtime change. No customer resource, staging access, deployment, push, PR, or merge is authorized by this lock.

The two access-control PUTs require `canManageSheetAccess`; rename requires `canManageFields`. All three call `fenceWriterEntry` within their real transaction before reading/writing their configuration and recording history. The PUTs additionally call `assertSheetLiveForUpdate` after the fence. Capability refusal precedes missing/deleted sheet responses. Admin sessions see the actual coded 404; a real non-management actor sees the corresponding 403 before existence disclosure. Sessions are hydrated from real synthetic `users` rows; this is session-shaped route admission verification, not login/JWT verification. Archive claim and cleanup use their genuine database-bound authority evaluator, including full-table read.

Source references on the frozen base:

| Source | Symbol / location | Contract |
| --- | --- | --- |
| `packages/core-backend/src/routes/univer-meta.ts` | row-level PUT ~L9958; conditional-rules PUT ~L10047; rename PATCH ~L16315 | Actual REST transactions, capabilities, responses and config revision writes |
| `packages/core-backend/src/multitable/canonical-sheet-fence.ts` | `fenceWriterEntry` ~L235 | Canonical fence before durable writer-block check |
| `packages/core-backend/src/multitable/sheet-liveness.ts` | `assertSheetLiveForUpdate`, `SHEET_ROW_LOCK_LIVENESS_SQL` ~L167 | Same transaction row lock plus soft-delete recheck |
| `packages/core-backend/src/multitable/config-revision-recorder.ts` | `recordConfigRevision` ~L43 | Existing config-only history: `source='mutation'`, nullable `operation_id`; no `seq` field |
| `packages/core-backend/src/multitable/recovery-archive-owned-claim.ts` | `claimInTransaction` ~L94, `observedHeads` ~L119 | Genuine committed claim sees record operation and declared section heads |
| `packages/core-backend/src/multitable/recovery-archive-bounded-source.ts` | section queries ~L37 | V1 `schema` projects fields and `views_config` projects views |
| `packages/core-backend/src/multitable/recovery-archive-section-rows.ts` | `SECTION_SPECS` ~L52 | Declared exact capture row shapes |
| `packages/core-backend/tests/utils/recovery-archive-records-entry-fixture.ts` | `createRecordsEntryFixture`, `claim`, `cleanup`, `snapshot` | Existing owned native fixture, unchanged |

**Archive boundary:** `meta_sheets.name`, `row_level_read_permissions_enabled`, and `conditional_read_rules` are protected by these writer fences, but none is in the V1 declared archive capture projection. A successful companion cannot establish archive restoration of those columns. The config recorder does not attach these ordinary revisions to a record operation, allocate a record-chain sequence, or create a section seal. Assertions preserve that exact current behavior rather than fabricating a config head or extending the archive format.

## Native evidence protocol

Reuse `TM_RECORDS_ENTRY_TEST_ROOT`, `TM_RECORDS_ENTRY_TEST_EVIDENCE_ROOT`, and `TM_RECORDS_ENTRY_TEST_ATTEMPT_TOKEN`. They are test-only fixture selectors. The native lane is armed only by `METASHEET_REAL_DB_TEST_STEP='1'`; armed execution without `DATABASE_URL` must fail with `SHEET_CONFIG_ENTRY_DATABASE_URL_REQUIRED`. An unarmed skipped suite is not a passing native gate.

The existing helper supplies actual administration `CREATE_INTENT → CREATED` with exact database name/OID/owner/system identifier and non-FORCE disposal; real PostgreSQL pool/adapter, `__rawClient`, and ALS transaction context; hooks only after original fulfilled SQL; real claim, SQL-clock expiration, four-key operator cleanup; and snapshots of every public heap table, independent record-chain `last_value/is_called`, and physical source inode/device/size/hash. Disposal follows release of all barriers and settlement of every tracked operation. Metrics registration is cleared before each module reset and after disposal. Only pool routing and values-free log sinks are spied; domain behavior and permission evaluation remain real. The router is imported directly, with no server/core-API construction or background scheduler.

For claim-first interleaving, an actual canonical holder/waiter is observed through `pg_blocking_pids` and native `Lock` state. The refusal baseline is taken only after the genuine claim COMMIT completes and the writer acquires the released canonical fence. For writer-first, the genuine claim is observed waiting behind the real writer; the writer COMMIT completes before a committed snapshot and claim resume. A read-only observer on the same native claim client, after its original fulfilled scope read, proves the live configuration and new config revision are committed. `observedHeads` is compared with the complete existing declared record/section shape, without adding a config head.

Each fixture writes `SHEET_CONFIG_CASE_SOURCE`: the caller base is fixed above, while the helper's inherited `INITIALIZED.inputBase` is explicitly a legacy helper-origin marker, not proof of the caller's source. The driver must freeze the full base archive plus the six task overlays and hash actual sources. Synthetic row values and local resource identities stay in private mode-0600 evidence; public reporting contains codes/counts/hashes only.

## Planned acceptance matrix

The three routes each receive all eight core branches: usable unblocked write; live genuine committed claim refusal; actual SQL-clock-expired claim refusal; claim-first native waiter refusal; writer-first native waiter then committed visibility to genuine claim; exact-owner terminal cleanup followed by the same usable route; archive OFF/fence ON refusal; ordinary archive OFF/fence OFF success. Refusals pin the complete current 409 body and full snapshot equality. Positive controls pin complete HTTP response, exactly one transaction COMMIT, precisely one new `sheet_config` revision, actual changed key and before/after endpoints, entity/actor/source, retained old revisions, and unchanged unrelated rows, operation/section tables, record-chain allocator and physical source.

Additional branches: three no-op requests (no new history or allocator change); three real non-management actors; three invalid payloads including an invalid rule enum; twelve auth-first missing/deleted-sheet cells (three routes × two liveness states × two actors); two actual preflight-to-write committed soft-delete windows for the access-control PUTs; and three same-base other-sheet positive controls under a main-sheet genuine claim. In the delete window, a separate real transaction takes the canonical fence and commits soft deletion before the route proceeds, and the refusal baseline is the already committed deletion snapshot.

The implementation currently plans **50 native cells plus one armed sentinel** (51 total). This is source arithmetic, not a collected or passing test count. Collection and actual native results must be reported by the independent runner.

## Gates

| Gate | Required evidence | Current state |
| --- | --- | --- |
| Source freeze and surgical diff | Two companion sources plus separately owned four CI overlays; production/shared fixture unchanged; source hashes | Source-only handoff pending independent audit |
| Collection / sentinel | Actual collected case count; armed missing-URL sentinel demonstrably fails | Not executed by implementer |
| Focused companion native lane | Real HTTP, migrated fresh DBs, all matrix cells, values-free result manifest | Not executed by implementer |
| Native holder/waiter and expiry | PostgreSQL lock evidence; SQL-clock proof; committed comparison baselines | Implemented; not executed |
| Ownership and disposal | Driver lifecycle receipt and every fixture non-FORCE disposal; zero residual clients/transactions | Implemented; not executed |
| Correctness guard mutation | Independent reviewer-selected mutations must turn matching assertions red, then restored | Pending independent reviewer |
| Neighbor contract regression | Focused existing records admission / liveness / config / rename neighbors as selected by reviewer | Pending independent reviewer |
| CI wiring union | Four existing workflow/test-chain edits reviewed without dropping prior entries | Owned by primary agent; pending |

Completion means these bounded admission gates have actual evidence. It does not imply whole Time Machine completion, configuration archive restore coverage, merge/CI approval, default flag ratification, staging delivery, or business acceptance.
