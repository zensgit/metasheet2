# Local Startup Prerequisite Verification

Base: `23dfdf417686b931a515bf03abbce1d6471c3098`.
Scope: archive application terminal-state prerequisite, not complete startup.

## Evidence

- Before source changes: application suite 2 failed / 34 passed. Stop-before-start
  incorrectly permitted boot; repeated start after failed boot silently returned.
- After repair: application 36/36 and server wiring 8/8, total 44/44.
- In-flight drain test also rejects start while draining and after drain; both
  stop callers still await the same accepted work and timers reach zero.
- Existing five exact-flag OFF cases remain inert, without factory/DB/timer calls.
- `pnpm run type-check` in core-backend passed (core and acceptance script tsconfigs).
- `pnpm exec eslint src/multitable/recovery-archive-application.ts` passed.
- `git diff --check` passed.
- Both existing test files are discovered by the default Vitest configuration;
  `plugin-tests.yml` runs `pnpm --filter @metasheet/core-backend test`. No shared
  selector or provenance change is needed for this prerequisite.

Commands:

```sh
pnpm exec vitest run tests/unit/multitable-recovery-archive-application.test.ts tests/unit/metasheet-recovery-archive-wiring.test.ts --reporter=dot
pnpm run type-check
pnpm exec eslint src/multitable/recovery-archive-application.ts
```

Sol high reviewed the base startup/lifecycle architecture read-only and identified
the terminal-state and HTTP/worker drain risks. This is not a final review of a
completed local launcher. Source repair is independently evidenced by the two
pre-fix failures above; no remote CI or real-DB evidence is claimed for this delta.

## Remaining

Async root/receipt admission, explicit operator-secret transport, real callback
composition, listener gating, post-HTTP-and-worker-drain custody disposal, and
synthetic restart verification remain unimplemented. Capture policy remains
design work, with no new defaults selected. No flags, dispatch, deployment,
customer storage, production access, or real customer data were used.
