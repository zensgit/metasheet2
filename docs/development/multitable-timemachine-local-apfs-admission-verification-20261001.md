# Time Machine LOCAL APFS admission verification — 2026-10-01

Status: bounded local repair PASS; Draft/HOLD; this new PR's remote CI pending. Tested runtime `8bc49f9d6dbf6a84e2875b490ba7a63db92a16e0`, prerequisite cleanup head `9d1d589ea0da7aad79e5482fc29a41e5db69026f`. This evidence-only child changes no tested runtime.

Both archive and custody storage previously refused actual local APFS roots on this host because Darwin's numeric filesystem type was `26`, while their check admitted only `25`. The repair queries the exact resolved root through `/bin/df` without a shell and independently requires one native JSON filesystem record with literal name `apfs`. It checks mount/root device identity and root realpath/inode before and after the bounded probe. `df` local/type selectors interact; successful exit or `-T apfs` alone is not the name proof. Linux retains its prior supported numeric set and does not execute a child command. Unknown platforms/filesystems and ambiguous probes refuse with the original values-free provider errors.

| Gate | Evidence |
| --- | --- |
| Reproduction | Actual APFS type-26 provisioning failed before repair; retained as nonacceptance evidence. |
| Focused unit and neighbors | Six actual files, 125 passed, zero skipped, cache disabled; independent reviewer repeated all 125. Shared helper 42, archive provider 22, custody provider 8, abandoned store 24, object store 19, receipt compiler 10. |
| Discriminating mutations | Literal-name, mount-device and root-recheck negatives went RED; native-argument census mutation also went RED. All exact source bytes restored; no guessed numeric fallback or provider bypass. |
| Independent native check | Owned APFS scratch path with spaces/quote/shell metacharacters: provision/PUT/exact read/discard/same-namespace restart and custody roundtrip passed; scratch removed. |
| Validation | `pnpm validate:all`, normal backend/acceptance and explicit touched-test type checks passed; two existing CI wiring suites total 49 passed. |
| Review | Immutable runtime review found no actionable P1/P2 in the bounded repair; namespace and transaction-depth guards remain active. |

Commands and exact source/log hashes are retained under the implementation checkout's `artifacts/tm-apfs-admission/`. The shared helper is 52 lines; only the two provider admission callsites and focused refusal tests change alongside it. No migration or workflow selection changed.

## Current-main combined APFS recovery

Test-only composite `32a79bb4b9118c6880e9fae9c742fdeff67634ee` combines the tested runtime with current main `ef9eb2d86cf4cbef7327036368f92ca3eb0f53d3`. Its tree differs from their true merge tree only in six acceptance-helper paths from PR #6183 head `7c6c79aae7c67c19ecbc22ca065348c6f3330d05`: five blobs match exactly; the acceptance tsconfig include list is the exact union with current main's private-database drain declaration. Earlier manifests retain their original frozen source correspondence.

On actual APFS, the same authenticated manual generation was backed up and imported into an initially empty target, then restored by the official FD3-unlock launcher after the source database/roots became unavailable. Exact scalar data, attachment bytes and history recovered. Two fresh ordinary flag-OFF processes compared identical HTTP bodies and canonical content/counts across 22 tables, then stopped without listeners. The separate seeded 5001-row control completed two chunks and 5001 derived effects; this is not a 5001-row manual-capture claim.

Driver and runner exited 0. Pre-stop scoped database/backend census was `0|0`; independent scoped cluster/root/child counts were zero. Log SHA256 `16d9287dc24f8be6fbc6ffac2988c342f85d8741c261ede3a043302f8c359e2a`; manifest `artifacts/timemachine-apfs-admission-20261001/apfs-manifest.json` in the separate test checkout. Driver explicitly set `TSX_DISABLE_CACHE=1`; no separate per-child cache-activity instrumentation is claimed. An initial manifest setup used `files` instead of `include` and did not create/start the runner; its failure is retained and excluded from acceptance.

## Remaining gates

This PR's own exact-head CI and actual execution census remain pending. Cleanup PR #6195's new-head CI is separate; its first head's missing fence-ledger classifications were repaired without changing runtime, and its pre-existing web JWT comparison timing defect was independently reproduced. Green checks from another head or PR are never substituted.

No actual remount/crash/power-loss or independent physical fault-domain proof is supplied. This name admission does not attest remote/physical storage identity. Expired-builder terminalization and actual process-death cleanup acceptance, full D7/D-L verified/pinned/legacy expiry and slow-provider cases, Phase 5 live attribution, actual staging deployment/window/rollback and production acceptance remain OPEN. No route, scheduler, provider/profile/default, flag, retention/lease policy, schema, key-reference release/destruction, customer data or remote provider/KMS call changed. No GitHub merge or deployment occurred.
