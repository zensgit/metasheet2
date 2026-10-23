# Meta direct managed BOM read publication: C2a

Status: locally verified and committed; publication queued. Whole-window acceptance remains open.

Source `57f9af221118bf8483dbb9605f3f3bd64e6a99ee`, parent `884a8cb0e5358c03889848fea56c949262be6e57`. Existing Grok4.7(xhigh) session implemented the bounded repair; Codex independently reproduced owner-transfer and final-source-lock membership races and reviewed the corrected diff.

## Behavior

The existing direct managed BOM relay freezes the verified personal session, native identity, source and part before network access. After the native response it uses existing renewal lock ordering: link, binding, frozen session, renewal operation, delegation advisory, then source row. It checks the current source owner/configuration fingerprint, binding/link revision, personal identity and session. Active user, both distinct Meta tenant/organization memberships and wall-clock expiry are checked after all those waits. A revoked or replaced frozen session cannot become a newer session or legacy shared transport. Missing link/generation or a transaction callback that does not execute fails closed in every environment.

Native requests remain outside database locks. The operation cannot atomically serialize a later native-only revocation with a local database commit; native status/read checks do not claim a distributed transaction. No new grant, shared-account fallback, approval grant reuse or read engine was added.

The fixture applies and reverses the existing renewal migration. Production lockRenewal remains unchanged: missing schema is not tolerated to accommodate tests. Projection unit doubles now execute the transaction callback and provide the selected persistent identity columns; assertions were not weakened.

## Independent counterexamples and validation

Before repair, an independent Node process transferred the source owner while the native response was held; direct relay still returned success. The first implementation also returned success when organization membership was removed while publication demonstrably waited on the final source row. Historical RED logs and the initial unaccepted worker report remain immutable. The second probe includes an unchanged-source positive control and verifies the actual PostgreSQL lock wait via pg_blocking_pids.

On reviewed flow SHA256 `168626504550ec27cab915d57bfca693ce7c65f72b98989af55127b45a1217b3`, the external combined owner-transfer/source-wait probes passed3 selected cases (51 unselected),1.77s. No repository test was temporarily changed. Independent full backend typecheck exited0;2 unit files passed63 tests; complete PostgreSQL config passed119 tests in51.00s (80 companion,29 renewal,10 continuous), no failures/skips. Source and test hashes were unchanged across the gates; git diff --check passed.

Node20.20.2; task-owned PostgreSQL16 UTF8 used existing16.15 binaries with16.15_1 share prefix. Probe nonce `ec6026907f0ed952` and full-suite nonce `414bf9ea6f3b27d6` each proved marker match, server stopped and owned directory removed. Evidence bundle `w10-meta-c2-root-green-20261022`, manifest `1291735c8c4e374f5e965c6c179c56f5d07c961dc4051f0dc4a29b9139f7bd32`. Counts overlap earlier runs and are not cumulative.

## Remaining acceptance

Native HTTP is fixture-backed in these tests. Cookie-authenticated original iframe integration, independent native/Meta processes, real wall-clock hour, fixed-image installation, upgrade and backup/restore remain separate work. No current-source remote CI, installed-browser acceptance, merge, production enablement or whole-goal completion is claimed. Keep eventual PRs Draft and publish in dependency order after useful parent CI terminates.

The final worker repair2 report matched all three independently checked file hashes; its own63 unit/119 PostgreSQL/typecheck gates also passed, and owned nonce `709c7c82a21dd753` cleanup completed. Grok was observed done with the write lock absent before the source commit. The worker setup shell initially used zsh readonly `status`; that failed attempt was preserved and the owned cluster was verified before the successful UTF8 run.
