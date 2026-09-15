# Time Machine Archive Readiness

## Scope and Authority

Owner requested continued archive recovery improvement on 2026-09-15. This
bounded slice improves existing error states and read-only retry, not archive
enablement. Base: `c6f2d437a8810a822fb4210976aaf6af9ed3af74`, independently
confirmed by remote main readback. The earlier recovery UX Draft #5709 remains
unchanged; this branch starts from main and has no dependency on that PR.

## Contract

- Match only known archive error codes to disabled, runtime unavailable, scope
  unavailable, or recovery-data unavailable copy. Preserve 401/403/404/409
  precedence. Unknown errors remain generic, including unknown 503 errors.
- Never render raw server messages, unknown codes, infrastructure identifiers,
  or provider credentials. An error is not evidence that a recovery point is
  absent, that a flag is enabled, or that a write completed.
- Provide an accessible refresh icon with a localized tooltip. Refresh is
  read-only: rediscover the latest durable job first, then list recovery points
  only when there is no job. Never automatically accept, resume, cancel or execute.
- Serialize refresh while discovery/catalog/preview/write is in flight. Clear
  any old preview and confirmation before a fresh discovery. Ignore obsolete
  catalog/preview/discovery responses after changing sheets, closing or unmounting.
- Preserve the pre-existing in-flight write contract: closing does not cancel a
  submitted recovery; async acceptance remains cached under its originating
  sheet, and reopening the same sheet can receive a pending synchronous result.
  This slice does not redefine execute/accept/resume/cancel lifetime semantics.
- Keep empty catalog, permission denial and disabled runtime distinct. Existing
  preview token, confirmation, authorization and durable-job controls remain.

## Runtime Boundary

Standard startup currently constructs `new MetaSheetServer()` without a recovery
composition factory. The application requires both exact archive/writer-fence
flags plus real object-store, key-custody, database and worker dependencies.
This slice supplies none of those providers and changes no flags. Existing
catalog gates still require verified/finalized/complete/unexpired archives.

Follow-on runtime work must use real providers and authorization adapters, retain
flag-off no-I/O behavior, and prove capture/verify/preview/restore plus process
restart, lease fencing and permission revocation on isolated synthetic data.
It cannot use always-true test authorization or claim production readiness from
UI tests. Hard-deleted table resurrection remains out of scope.

## Verification

- Red-first mounted tests for closed error classification and read-only retry.
- Positive recovery/empty/denied controls, duplicate-click and stale-reply cases.
- Mutation: collapse disabled into generic unavailable; bypass job rediscovery.
  Each must fail its matching test, then restore and rerun.
- Existing archive modal/client specs remain in both domain guard and required
  web gate. No new selector or workflow is needed.
- Focused/neighbor tests, Vue typecheck, lint, diff-check, desktop/mobile browser
  screenshots. Browser fixtures are synthetic presentation evidence, not UAT.
- Report local results, remote CI, merge and runtime enablement separately.

No DB, OpenAPI, shared workflow, Ready, merge, flag, dispatch, deployment,
production or customer-data action is included.
