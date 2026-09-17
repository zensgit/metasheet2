# Local Startup Verification

Base: `23dfdf417686b931a515bf03abbce1d6471c3098`.
Implementation head: `705473bbafc0c6cb9159c1d97d5dda3cd3c17f77`.
Implementation tree: `09ddad7b4aaa60670e45b1c9c9bd25ce222a9656`.
Scope: local launcher implementation and focused verification; full successful
PostgreSQL/HTTP/restart acceptance remains a gate.

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

## Launcher Evidence

- Main chain: application 37, server wiring 13, operator pipe 9, local startup 13,
  adjacent approval shutdown 8: 80 passing tests.
- Local custody 22, encrypted package store 7, filesystem archive provider 22:
  51 passing neighbors.
- Real Node subprocesses consume the inherited FD directly, without a `tsx` CLI
  child that drops FD 3. Exact 32-byte + EOF positive; empty/short/oversize, held
  pipe timeout, partial-input abort and inherited loopback TCP negatives pass.
- Actual launcher subprocesses refuse OFF, wrong secret and cancellation while
  locked; all exit 1 with the fixed refusal code and no listener-ready message.
- Synthetic temporary roots prove receipt/root replacement rejection, secret
  scrubbing, authentic capability admission, revocation and repeated explicit
  preparation. Repeated preparation is NOT a full successful server restart test.
- Server tests prove custody stays live until BOTH HTTP and worker drain; failed
  HTTP/worker drains do not release custody or close the pool. Release failure
  also prevents pool closure. Already-aborted startup never invokes listen/worker.
- Removing secret scrubbing, removing cancellation checks, neutralizing authentic
  capability release, and removing HTTP from the drain barrier each produces its
  targeted RED. All mutations were restored; no mutated code is committed.
- Core + acceptance-script typecheck passes. Four recovery source files pass lint;
  launcher lint passes with the acceptance-script TSConfig explicitly selected.
  `src/index.ts` has 22 existing warnings and no lint errors. Default lint config
  excludes script TSConfig membership, so its initial parser error is not a pass.
- Sol's first implementation review found four boundary issues (loopback/default
  OFF launcher, signal ownership/cancellation, paired custody release). These were
  fixed. A fresh bounded Sol read-only review returned no remaining P1/P2; it did
  not run tests and explicitly excluded the remaining real-DB E2E gate.

## Remaining Gates

The launcher now exists; the original ordinary server entry remains unchanged.
Before considering the startup slice merge-ready, run the actual launcher with
an isolated PostgreSQL instance, canonical HTTP restore and restart requiring
fresh operator input. Then publish/verify exact-head CI. Prior seeded/injected
server and backup-drill evidence does not replace this new entry-point proof.

Capture policy is a separate PROPOSED design with no numeric defaults selected.
No flags outside synthetic test processes, dispatch, deployment, customer storage,
production access, or real customer data were used.
