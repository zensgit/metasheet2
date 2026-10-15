# Yuantus personal approval receiver: design and verification

## Delivered slice and authority

This receiver is based on MetaSheet `a5ed6d86376d25e93c9a9904fc044ba0eadfab8b` (PR #6418), paired with the Yuantus personal-purpose provider in Draft PR #343, source `5dc3b1c41c0e07c1f9b71d7c760e77171a92152c`. The entire restored development window and W22 cross-process acceptance are not complete.

Existing Yuantus ECO approval remains Yuantus-owned. MetaSheet presents source tasks and passes the bound person's decision to the native provider; it does not create a competing platform approval instance or use the old service-account bridge. Source receipt fields distinguish this person's seat decision from completion of the stage/ECO. Different Yuantus AUTH people, not MetaSheet account or seat counts, govern native multi-person thresholds.

The explicit current-user binding uses a configured server connection; input cannot nominate a URL, subject, tenant or organization. Provider verification supplies that scope. Grants are encrypted at rest; the binding preserves identity across replacement grants and prevents two MetaSheet owners binding the same scoped Yuantus subject. Unbind destroys the stored credential and withdraws projected tasks/cards while retaining unresolved command evidence. The settings panel uses existing login transport, immediately clears submitted credentials, projects only metadata, aborts on account change and rejects late responses. The `/settings` and `/m/approval-decision` focus exceptions are exact paths; permission checks and descendant exclusions remain.

`PLM_APPROVAL_CARD_ENABLED` defaults off and requires byte-exact `true`; its manifest requires the existing durable event runtime. Initialize the personal-only provider before consumers, start the bounded polling worker after initialization, and drain it before persistence resources close. Ordinary platform cards retain their own engine dispatch.

## Persistence and recovery

Migration `zzzz20261015040000_create_plm_personal_approval_cards` adds bindings, source tasks, immutable command intents and a source XOR on the shared card ledger. Each source task/round has a projection identity and entry epoch. Reappearance after withdrawal gets a fresh epoch, so an old card cannot decide the current seat.

Before a source decision, commit one immutable command intent with its command ID, recipient/scope and request hash. Explicit retry queries the original receipt first. Only a typed source 404 plus a newly admitted current source task permits the original command to be submitted again. Background reconciliation only looks up receipts; it never issues a decision. A same-person replacement grant can recover a prior receipt. Each resolution rechecks owner, binding, scope and typed source receipt.

An independent Astra ultra review found two recovery P2s, reproduced by the parent against PostgreSQL before repair:

1. A definitely undelivered `failed` card was permanently blocked by its unique task/epoch ledger. Retry now uses a conditional conflict update only for a `sent` card-state row with `send_status='failed'`, retaining the delivery ID and updating the current directory recipient/integration. Pending, sent and outcome-unknown sends do not resend.
2. Repeatedly scanning the oldest 100 missing receipts starved later committed results. A persistent UUID cursor on the binding now rotates a finite page under its binding lock. Every receipt still rechecks authority. Absent receipts remain explicit admission-required results, without background POST.

The bounded follow-up review identified a related post-send SQL failure: an actually delivered OA card could be recorded as retryable failed. Parent PostgreSQL failure injection observed two sends before repair. Personal sends that returned successfully now become outcome-unknown if ledger persistence fails, preventing a second send. The ordinary platform Class-B behavior is unchanged.

Downgrade takes ACCESS EXCLUSIVE NOWAIT locks on all four affected tables before checking retained evidence and dropping anything, in one SQL batch. Empty down/up remains supported; evidence-bearing or concurrently written storage is refused. This is not a production rollback execution.

## Executed verification

| Scope | Result |
| --- | --- |
| Backend shared-card, transport, route, worker and lifecycle suites | 16 files, 240 passed, 0 failed/skipped |
| Frontend client, panel, session entry and focused-route regression | 5 files, 54 passed, 0 failed/skipped |
| Fresh owned PostgreSQL feature suite (`pg-07-postsend-green`) | 16 passed, 0 failed/skipped; cleanup true |
| Real browser + feature HTTP routes + authentication + PostgreSQL (`browser-02`) | 18 assertions passed; no page errors; cleanup true |
| Global flag manifest and negative dependency controls | 49 passed, 0 failed/skipped |
| Backend TypeScript and web application TypeScript | passed |
| New runtime module ESLint, new panel/client ESLint, workflow actionlint and diff check | passed |

PostgreSQL includes concurrent projection/duplicate command, projection rollback, lost ACK/rebind, settlement rollback, stale source/recipient/refusal, actual durable consumer + sender/callback with synthetic transport, definite-failure recovery, post-send ledger failure, 101-command receipt fairness, source XOR and downgrade locks. It uses a synthetic Yuantus transport and synthetic DingTalk responses, not a paired Yuantus server or real enterprise messaging. Browser runs real feature routers/AuthService and actual frontend routes against a minimal predecessor catalog plus feature migrations, not the full MetaSheet server or all historical migrations. It verifies login, exact settings reachability, metadata endpoint, management link, stale card, invalid HMAC and foreign recipient, and performs no approval/grant POST. The browser preceded only the sender failure-classification change, which is independently covered by the final PG run; its UI/router/auth sources are unchanged.

Negative runs are preserved locally: `pg-01` 12/1 downgrade lock; `pg-03` 13/2 recovery; `pg-05` 15/1 post-send duplicate; `pg-06` repeats that failure because a patch precondition aborted before applying. Earlier wrong-directory/fixture invocations are not counted as product failures. `browser-01` reached the real entry but asserted Chinese copy while the current app selected English; `browser-02` explicitly selects the app's supported Chinese locale. Route red-03 failed both exact paths before the focus fix.

Full web `vue-tsc -b` is not claimed green: its unchanged Vite Node configuration has TS2769 with this shared dependency runtime. An independent existing worktree with byte-identical baseline Vite/Node config reproduced that error. The application project (`--noEmit -p tsconfig.app.json`) passes. Initial ESLint resolution/project errors were invocation/environment problems; the corrected backend project and explicit installed Vue parser module search passed without changing repository dependencies.

## Reproduce

Use Node 20 and frozen workspace dependencies. With a fresh disposable PostgreSQL database only:

```sh
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.plm-personal-approval.config.ts
pnpm --filter @metasheet/web exec vitest run --config vite.config.ts tests/plm-approval-bindings-service.spec.ts tests/plm-approval-bindings-panel.spec.ts tests/plm-approval-bindings-routes.spec.ts tests/sessionCenterView.spec.ts tests/dataSourcesRouteRedirect.spec.ts
```

The PG suite requires `DATABASE_URL` and creates its own fixture tables; never target an existing deployment. The dedicated workflow provisions disposable PostgreSQL and requires nonempty, zero-skip JUnit evidence. Browser driver: `packages/core-backend/tests/e2e/plm-personal-approval-entry-browser.mts`, with `W22_BROWSER_OUTPUT` naming a new local evidence directory and `W22_PG_BIN` the PostgreSQL binary directory; run under Node 20/tsx. It creates and removes its own PostgreSQL, HTTP, Vite and browser resources. Public compact evidence and synthetic screenshot are beside this document; raw local logs are not release evidence.

## Still open

The paired HTTP/PostgreSQL feature rehearsal below now covers current-round partial/threshold decisions, lost ACK, grant revocation/rebind, receiver restart and observed source lock contention. It does not replace full server or production acceptance. Fresh installation/all-migration chain, full server startup/shutdown acceptance, production TLS/provider provisioning, real DingTalk/Stream and customer acceptance remain unverified. This receiver does not package a standalone MetaSheet engine into Yuantus or migrate workflow authority. Keep Draft; no merge, deployment, production enablement or issue closure is performed by this slice.


## Paired feature HTTP and PostgreSQL follow-up

The companion source now runs `scripts/rehearse_plm_personal_approval.py` against the receiver controller `packages/core-backend/tests/plm-personal-approval/crossstack.mts`. Final local run **52 checks passed in 12.842 seconds**, exit 0, cleanup true, **2166 recorded source/fixture/lock inputs unchanged** and 71 exact Python dependency versions verified. Actual Y source migrations reached t19/i10/default011. Runtime product bytes remain those of receiver `80210bc964cb96afe55e040c131597bfa798ff89` and Y source `5dc3b1c41c0e07c1f9b71d7c760e77171a92152c`; newer source commits repair CI/contracts and publish this rehearsal.

Unlike the earlier synthetic-provider PG test, this run uses actual Meta AuthService JWT and personal binding, sync, unbind, reconcile and rejection-decision HTTP routers, real PLMAdapter HTTP and the actual Y ASGI/auth/native ECO services backed by three migrated PG authority databases. Source AUTH42 maps to RBAC900 with a decoy RBAC42. Checks include partial first vote, different-person threshold, same-person two seats not satisfying two people, grant lifecycle/purpose refusal, receipt rollback with native seat rollback, old-round card/event refusal and revoked grant blocking a pending decision. Durable outbox rows feed actual consumer/executor/callback functions; external DingTalk transport and card updates remain synthetic.

A real source commit followed by an injected lost response leaves a persisted receiver intent. The actual Node receiver gracefully closes and a new PID reopens the same store; unbind removes its credential and same-person rebind settles the original receipt without another source decision POST. Missing receipt recovery never issues a command until an explicit fresh click. This is a restart test, not an arbitrary crash-timing test.

Independent Astra ultra review rejected a mere client Barrier as proof of DB contention because one async Uvicorn loop executes synchronous business code serially. The corrected run uses two independent source loops/threads, externally locks the ECO row, observes **two active PostgreSQL source connections waiting on Lock**, then releases and checks identical receipts/one commit. It does not claim two Y OS processes. The review also found cleanup=false could be reported successful: final status now requires cleanup, and a live-thread observation fault produced exit1/statusfailed, with the owned PG directory nevertheless removed.

Compact proof is [PLM_PERSONAL_APPROVAL_CROSSSTACK_20261015.evidence.json](PLM_PERSONAL_APPROVAL_CROSSSTACK_20261015.evidence.json). Exact input hashes and full reproducible driver are published in companion Yuantus PR #343. The controller requires a private owned temporary-directory marker before fixture SQL, including when reopening its database. No existing DSN is accepted by the parent driver. These feature routers use a minimal Meta predecessor catalog plus real auth/card/outbox/personal migrations, not all Meta migrations or full MetaSheetServer. Dispatcher lease/ACK, real enterprise Stream, browser password login, production deployment/TLS, arbitrary crashes and customer acceptance remain unverified. Earlier sections' local test totals retain their original scope and are not added to this overlapping rehearsal count.
