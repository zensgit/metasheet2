# Optional cloud-classroom installation — local checkpoint

Base: `6624cd74056a09d25958d2fda2768f5022bc313d`.
Branch: `codex/elearning-app-installation-20260909`.
Status: local implementation, not deployed; publication/merged-main acceptance pending.
Verified product commit: `958c0b1d1fb72b8977dc09c9a9dc88dac57a9ba8`.

## Implemented

- Existing platform registry and shell reused; no extra installation database table.
- Missing instance is uninstalled. Admin installation creates inactive, notification-off
  state. Repeated installation does not overwrite configuration.
- Organization/actor from authenticated context, global administrator plus active
  membership for writes. Membership SHARE lock serializes concurrent deactivation.
- Explicit enable/disable; deployment flags remain the upper bound. Disabling preserves
  data and turns notification opt-in off. Closed state includes server-derived canManage.
- Authenticated business admission and signed playback check active installation.
  Jobs and daily-stat producers filter before admission. Notifications additionally
  require opt-in. Already-admitted work may drain; cleanup remains permitted.
- My Apps hides inactive/uninstalled classroom. Admin shell exposes configuration;
  learners have read-only state. Client state is bound to principal AND token.
- OpenAPI source, official generated SDK, and required test selectors updated.

## Verified locally

- Backend focused/neighbor run: 41/41; additional registry/producer run: 40/40.
  Counts overlap and must not be added as unique tests.
- Final four installation/shell/My Apps Web specs: 51/51.
- Required Web script exit 0; final broad invocation: 439 files / 6071 tests passed.
- Plugin e-learning full 13-suite chain passed.
- PostgreSQL 15: canonical full stream 399 migrations and second replay passed.
- New installation realDB: 4/4; stats neighbor: 8/8; existing playback/jobs/notification
  worker realDB: 33/33. Fixtures explicitly install enabled applications, not bypass gates.
- Membership lock mutation SHARE to KEY SHARE: concurrency test RED; restored 4/4.
- HTTP installation guard removed: request test RED; restored.
- Frontend token binding removed: seven failures; restored 51/51 (frontend worker evidence).
- Removing My Apps filtering: three failures, restored (frontend worker evidence).
- Removing required guard selector, required-web selector, or DB exclusion individually:
  wiring RED; restored wiring 15/15.
- OpenAPI focused 18/18, canonical build/SDK generation/guard passed.
- Official provenance helper: only workflow fingerprint changed; frozen/live equal.
  Positive provenance and complete sealed-export S5 chain passed.
- Full Web `pnpm --filter @metasheet/web run type-check` and core
  `pnpm --filter @metasheet/core-backend exec tsc --noEmit` passed.
- Web production build passed (Vite 5.4.21); only the nonblocking chunk-size advisory
  remains. This is a local build, not deployment evidence.
- After isolated dependency repair, source Web ESLint passed without NODE_PATH;
  installation/admin/learner Web neighbors passed 6 files / 149 tests, backend
  focused tests passed 4 files / 41 tests, and boot/runtime neighbors passed
  3 files / 24 tests. Wiring passed 15/15. These overlap earlier runs.
- Independent read-only review found two UI P2s (stale-principal write and learner
  controls), both fixed and re-reviewed closed; limited re-review P1/P2=0.
- All owned scratch databases dropped with drained=true, forced=false,
  residualBackends=0; `elearning_app_` database prefix and backend residue both zero.

## Dependency verification correction

- The initial full Web typecheck failed because reused node_modules symlinks resolved
  Vite 7 while this branch's lockfile requires Vite 5. Only this worktree's verified
  dependency symlinks were unlinked, then `pnpm install --frozen-lockfile --ignore-scripts`
  installed the locked dependencies. No source, package manifest or lockfile changed;
  other worktrees were untouched. The full command subsequently passed as recorded above.

## Honest remaining boundaries

- New behavior requires remote exact-head CI, UI visual acceptance and staging testing.
- Notification delivery PR #5572 is separate and not included in this base. Installation
  opt-in guards the existing worker, not proof that the pending channel is deployed.
- No production object storage provisioned, no real notifications sent, no flags enabled,
  no deployment or merge performed. Installation does not provide storage credentials.
- Process timers and safety cleanup may exist when global flags are on; optional app
  installation prevents new organization business work, not all maintenance SQL.
