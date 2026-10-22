# Meta managed cookie renewal bootstrap: C1

Status: locally verified; publication queued. Whole-window acceptance remains open.

Source `089887032375e714c016c0cf7cb750b4c22abacb`, parent `fac8847a156735ba50c36c232b1841b468d5fc8a`. Grok4.7(xhigh) implemented this bounded slice in the existing session; Codex reviewed the diff, independently reproduced two counterexamples and reran the final gates. This is the separate closeout document.

## Behavior and boundaries

The authenticated current descriptor now reports persisted continuity mode and native credential generation after existing native verification. Meta link revision remains distinct. Inconsistent persisted combinations fail closed; ordinary and snapshot sessions do not acquire renewal authority. Browser descriptor fields are scheduling hints; the verified server cookie remains authority.

Bootstrap may renew inside the 120-second lead window. A current401 with eligible unexpired context may recover once and then fetch current once after exact200 `{ok:true}`. The renewal POST uses same-origin cookies, the purpose header and empty body, without generic apiFetch or Authorization.409 cannot install identity. Existing cross-tab identity locks and in-memory epoch/token/signature comparisons protect late completion; stale or malformed cookie responses trigger logout compensation.

A distinct renewal marker permits retry after an unknown transport result. It contains only descriptor identity and epoch, never a bearer or signature. Unreadable, mixed-identity or reload-without-context markers are conservatively logged out, not accepted as authority. The initial-complete pending marker retains its fail-closed behavior. Only authenticated current installs the successor descriptor. No timer, iframe remount or new personal-read engine is included.

## Red evidence and repair

The first independent probe showed that a lost renewal response left the generic initial-complete marker and the next bootstrap returned without making another request. The repair separates renewal ownership from initial completion. The second independent probe showed that an ordinary synthetic bearer was copied into the renewal marker. The final marker excludes credentials and rejects legacy credential-bearing records. Both original RED logs and earlier reports remain immutable. Both unchanged probes now pass independently; the lost-response probe observes a second renewal, authenticated current, and successor session installation.

The Vite config type failure mixed Vitest's Vite5 defineConfig with the application's Vite7 loadEnv. Both imports now come from vite; no type suppression, dependency update or gate change was used.

## Validation and toolchain

Root Node20.20.2: eight available targeted web files,100 tests passed,0 failed/skipped,1.22s. Both independent probes passed. Full unchanged web `npm run type-check` exited0, including build, verification-approval and verification-stock-prep projects.

The Node20 corepack shim selected cached pnpm12.6.0, whose run path attempted dependency resolution in this sparse checkout. That historical failure remains recorded. A task-local executable symlink selected already-installed pnpm10.33.0; no installation, dependency/lockfile edit or script weakening was needed. CI commonly selects10.16.1, so this local runtime is not claimed identical to CI.

Root backend TypeScript exited0,39 unit tests passed, and91 real PostgreSQL tests passed in48.89s (29 renewal,52 companion,10 continuous). All five backend hashes were rechecked unchanged after frontend repair; these runs are not added to earlier overlapping counts. PostgreSQL16 UTF8 used the task-owned16.15 binaries plus16.15_1 share prefix because the old named share directory was absent. Cleanup nonce `6974c5cb78cceaf7` proved marker match, server stopped and owned directory removed.

All12 changed file hashes match the reviewed reports. `git diff --check` passed. Receipt: `artifacts/plm-meta-cookie-recovery-ui-20261022/verification.json`. Private evidence bundle `w10-meta-c1-final-root-green-20261022`, manifest `162efdc57f1f36a227032875832f43bc96310f6e5f3c707fa1b7eb80a2b82b29`. Backend bundle manifest `22bcb4cf6450ac3f26af9d2aeff066ce2c29e04630efdbb19d14e9735010da15`.

## Remaining acceptance

Backend native calls in these tests use fixtures; jsdom transport tests are not independent native/Meta process or installed-browser proof. Original iframe continuity, actual wall-clock hour, current exact images, installation, upgrade and backup/restore remain open. No current-source PR CI, merge, deployment, production enablement or whole-goal completion is claimed. Continue the master goal and keep eventual PRs Draft under the serial publication queue.
