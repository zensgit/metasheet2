# Time Machine abandoned-object cleanup verification — 2026-10-01

Status: local synthetic prerequisite PASS; Draft/HOLD; remote CI for this new PR pending. Tested runtime/source commit: `dcd57c9c7af95605042138f24e1b418484f279da`, based on main `48ae5025a5f899de02efd511e7b7e2f2646049ce`. This report is an evidence-only child; it does not change the tested runtime.

## Result and contract

Manual upload now records the complete immutable prepared object plan before the first PUT. Registration binds the original opaque storage namespace, exact object/version/digest/size/expiry, and durable operation UUID. Explicit abandoned-builder cleanup uses the existing expired-owner/fence claim, independently revalidates the complete prepared plan and namespace, reconciles operation-bound provider status outside transactions, and records terminal receipts before releasing source pins. Unknown/partial inventory, wrong namespace, stale authority, ambiguous status, active hold and verified/pinned cases refuse or retain pins.

The LOCAL provider shares its existing exclusive retention decision with pin/PUT. Discard writes an immutable namespace-bound operation journal and tombstone, reconciles unlink plus directory fsync, and prevents successful late PUT resurrection. Its terminal `absent` outcome proves unavailability through the declared provider namespace; it is not physical erasure or key-release authority. Store identity is trusted configuration and is not physical-location or remote attestation.

## Verified gates

| Gate | Evidence on the tested source |
| --- | --- |
| Focused unit + neighbors | Four actual files, 75 passed, zero failed/skipped, cache disabled; independently repeated by reviewer. |
| Owned real database | D2b, source-pin and claim-anchor files: 57 passed. Complete inventory before lost PUT, newer owner after provider confirmation, ambiguous response retention, stable-operation restart, wrong/mixed namespace zero IO/terminal/pin writes, and legacy refusal covered. |
| Migrations | All 33 migrations and 1026 catalog objects replayed; fingerprint `ef8c43cc0cc149502193e9f51093f8419b283ac7674f03569ac53b15b7744b78`. New migration applies/replays, empty rollback succeeds, populated rollback refuses. Prior migrations are unchanged; only disposable prepublication candidate schema was recreated. |
| Ordinary manual workflow | Frozen source completed actual capture/catalog/restore/download, complete sealed provenance, finalization/source-pin handoff and verified-generation cleanup refusal. Log SHA256 `beba0af1ba9151b38bc0e5d71573a98db3bd13d431dcc68602e923f4dad99f74`; helper-owned database/connections zero. |
| Two-process LOCAL contention | Two distinct child Node processes initialize providers, wait at a barrier and race pin/discard. Exact winner/status/receipt/availability and child exits checked; separate child pin-first positive prevents invalid-pin false green. Crash/restart contention remains outside this proof. |
| Validation and collection | `pnpm validate:all`, backend/acceptance/fixture type checks and 43 CI wiring contracts passed. Existing D2b whole-file workflow selection/sentinel remains; migration/test lists take the union. |
| Independent review | Initial receipt reread and wrong-store findings independently reproduced and fixed; final frozen-source review found no remaining actionable P1/P2 in this bounded slice. |

Reproduction commands: `pnpm --filter @metasheet/core-backend exec vitest run --cache=false` with `multitable-recovery-archive-{abandoned-object-store,file-store,object-store,object-receipt-compiler}.test.ts`; realDB uses `vitest.integration.config.ts`, owned disposable database references, `EXPECT_DB=1` and `METASHEET_REAL_DB_TEST_STEP=1`. Replay entrypoint: `tests/integration/multitable-timemachine-migration-replay-realdb.verify.ts`. Local ignored evidence is under `artifacts/tm-abandoned-cleanup/`, including exact commands, per-file hashes, collection, failures and mutation restoration.

## Combined APFS recovery and rollback

A separate owned integration checkout composed the tested runtime above with exactly six acceptance-helper blobs from PR #6183 head `7c6c79aae7c67c19ecbc22ca065348c6f3330d05`. Composite commit `8f9100c7b24205d93fc02c67104ddc36089f2ce3`; every other runtime blob equals the tested source. On macOS APFS, Node 24.14.1 and PostgreSQL 15.17, the authenticated manual HTTP generation was backed up, imported into an initially empty target and restored through the official FD3-unlock launcher after the source database and roots became unavailable. Exact scalar data, attachment bytes and history recovered. Ordinary flag-OFF processes before/after compared identical HTTP bodies and counts/canonical content digests for 22 tables; both stopped with no listener. A separate seeded 5001-row archive completed two chunks and 5001 derived effects; this is not a 5001-row manual-capture claim.

Driver/runner exited 0; pre-stop database/backend census was `0|0`, and independent matching child/cluster/run-root counts were zero. Exact log SHA256 `7dca66458e34de3e67a7a0165d06a048995e01daeda743320ba70828acc1fda9`; manifest retained under the separate checkout's `artifacts/timemachine-cleanup-apfs-20261001/namespace-apfs-manifest.json`. Vitest guard runs disabled cache; this standard APFS driver does not assert TSX cache disabled in every child.

## Discriminating negatives and remaining gates

Actual RED then corrected/restored: missing pre-PUT registration; transaction-depth guard; discarded tombstone; changed durable operation UUID (provider and realDB caller); repeated Proxy receipt reads; microsecond DB expiry versus provider milliseconds; raw LOCAL namespace guard; whole-generation namespace guard. Mutation/source SHA correspondence is retained; earlier probes are not relabelled as runs of the final source. Failed startup, moving-schema, fixture compatibility, import/type-check and real HTTP precision attempts are preserved and excluded from acceptance.

No automatic caller/timer/startup activation, provider choice, retention/default/flag change, verified archive expiry, key-reference release or key destruction is included. Full D7, verified/pinned/late-finalize/legacy cleanup, bounded slow-provider deadlines, cross-process crash/fault acceptance, actual staging deployment/window/rollback and production acceptance remain OPEN. D1 permits local filesystem test/staging; this NON-KMS same-host synthetic evidence does not execute or authorize staging, and does not satisfy the separate independent-provider/staging-KMS D7 profile. Phase 5 live scheduled attribution remains open. No merge, deployment, customer-data operation or remote provider/KMS call occurred.
