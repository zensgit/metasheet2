# Continuous managed-session scheduling — 2026-10-23

Source `e5e7a0bc112d18662514831520f2f59469e06a51`; parent `f9ea64e1f00d4a0c4a99357a0b0ea6d5ec2410b8`. Local candidate; publication remains held behind Native #370 useful CI. This records source and mounted component verification, not installed acceptance.

## Behavior and implementation

An already focused document now invokes the existing managed bootstrap when its renewal lead opens. One document timer is installed through the existing main-entry permission refresh lifecycle and rearmed from the existing principal-change signal. It preserves the existing identity lock, pending recovery journal, provider authority and60-second attempt throttle. There is no new renewal transport or engine.

The next wake never exceeds the known absolute expiry. Epoch/token/session/deadline/generation checks reject superseded work. Hidden documents and held network operations keep an expiry wake without starting a second renewal; a completion arriving after expiry publishes before rearm cancels the old timer. Generation7 does not renew. Ordinary tokens and noncontinuous modes retain their existing paths.

A resolved HTTP200 current response with invalid JSON or no usable managed principal already cleared the descriptor. That branch now also emits the existing principal signal, clearing original iframe rows. Transport failures and non401 HTTP failures using keepSessionOnFailure retain their prior behavior. Native authority, scope/grants, authPrincipal and backend files are unchanged.

## Independent counterexamples and actual verification

- Original focused lead-window test failed before scheduler implementation: no renew request without focus. Preserved original RED.
- Root corrected8-case mounted test suite proved3 deadline failures oncd42 (hot throttle, current-response resume, JSON-body resume), then8 passes on candidate. It uses unique session identities and positive initial/held transport counters; DOM assertions run before descriptor getters or manual notification.
- Independent static review found resolved malformed current could clear the descriptor silently and cancel the expiry watchdog. Root reproduced2 DOM failures on a821 at the original deadline;8 other assertions were skipped in this focused run. The aggregate Vitest field incorrectly counted those8 as passes, so only actual assertion statuses are accepted.
- Final frozen root suite:10 passed. Existing renewal recovery:11 passed. Exact workflow cohort:17 files,222 assertions, every assertion passed, no skips/failures/todos; exit0 and unchanged assert-report exit0.
- All15 previous workflow test files remain byte-identical to parent. Their actual199 assertions plus13 scheduler and10 expiry cases are present in the222 run; the old configured198 count is superseded by this actual exact cohort, with no removed baseline test or weakened comparator.
- Full web typecheck passed at02:02:10–02:02:38UTC: build typecheck, verification-approval and verification-stock-prep; exit0. Root read actual terminal logs and JSON, verified exact workflow file set and four final source hashes. Sol6.1high reviewed the concrete notify fix; original static finding and source-specific disposition are retained.

Actual workflow command is the unchanged pnpm/Vitest invocation in `.github/workflows/plm-managed-companion-consumer.yml`, now registering both new specs and requiring exactly222. Targeted command: `pnpm exec vitest run --watch=false tests/plmContinuousExpiry.spec.ts`. Typecheck: `pnpm run type-check` in apps/web.

The first reused-session fixture had cache contamination, and a later cap fixture incorrectly returned a new successor to a request started only after expiry. Both failed intermediate receipts remain preserved and are not definitive product findings. The corrected unique-identity fixture models the cap provider's401 response. The earlier220-case green cohort predates the malformed-current fix and is not current-source acceptance.

## Evidence and limits

Implementation used the verified persistent Grok4.7xhigh session, with root reproduction/review and independent Sol6.1high static review. `verification.json` records exact hashes, counts and limitations. Private evidence `/Users/chouhua/.codex/worktrees/plm-listener-review-20261015/Yuantus/artifacts/plm-listener-review-20261015/private-acceptance-evidence-20261020/w10-scheduler-final-20261023`, manifest SHA256 `6198d2fcb8ae2e4f20f8e9b279ed682052cf09d864be24a4b492f551309966ce`, includes actual typecheck/cohort logs and reports; earlier RED directories remain immutable.

These tests use fake timers and mounted Vue DOM. Actual original browser Frame, production static build, source process, immutable image source and installation acceptance remain separate and pending for this successor. No elapsed-hour, production, merge or deployment claim. No remote push occurred while useful Native #370 CI remained active. All PRs remain Draft.
