# ACP-1B browser / real-DB connection acceptance

Status: LOCAL CONNECTION ACCEPTANCE PASS / DRAFT-HOLD. Not a release or required-CI claim.

## Scope and baseline

- Base: `74dfa5b4627466f336920bacd1476f07d0d6280b`.
- Worktree: `/private/tmp/codex-attendance-acp1b-browser-realdb-20260908`.
- Branch: `codex/attendance-acp1b-browser-realdb-20260908`.
- Existing product PR #5542 is merged and remains untouched.
- Fresh-main / open-PR audit found no duplicate ACP cleaning browser-realDB work.
- Only the two dedicated acceptance scripts and this document may change.

This is an explicitly invoked **local synthetic acceptance script**, not an added
required-CI test, deployment, full application-shell UAT, or production acceptance.
The previous Chromium evidence intercepted API responses; the previous real-server
PostgreSQL tests used an HTTP client. This script connects those two layers.

## Real chain and oracles

Chromium mounts the actual `AttendanceReportFieldsSection.vue`. A loopback Vite
proxy forwards the actual metadata, multitable records, and cleaning-apply HTTP
requests to `MetaSheetServer` with the actual attendance plugin and private PG.
No API response is fulfilled or replaced. The browser context only aborts foreign
origins. Node TCP connections are confined to this invocation's allocated ports.

The positive case requires: tenant/sheet descriptor equality; no POST or edit
before explicit confirmation; a closed `{expectedVersion}` command; UI consumed
state and removed proposal; canonical normal status; exactly one edit, completed
operation, manual-override calculation and internal result event; no notification;
proposal cleanup and custom-column preservation. A later proposal is reviewed
before membership revocation; its real apply must be 403 and its complete
canonical/projection/effect snapshot must remain unchanged.

Every non-2xx API response is unexpected except the explicitly asserted revoked
apply 403. Transport errors and page errors fail acceptance. Desktop and narrow
screenshots require visual inspection; screenshots alone do not prove DB effects.

## Isolation and invocation

Run with existing workspace dependencies and an installed PostgreSQL binary
directory. No dependency installation, externally supplied DB/API URL or shared
PostgreSQL is used. The runner creates a fresh cluster with `mkdtemp`, creates its
nonce-bound `acp_browser_` database, runs current migrations, and uses synthetic
users only. `RBAC_BYPASS=false`; the private fixture's cleaning policy is true,
not a persistent flag change in any deployed environment. Outbound event workers
are disabled in this local process; this is not notification-delivery acceptance.
The synthetic organization is a newly generated canonical UUID, not `default`.
Its absence is checked before creation; a local ownership manifest binds it and
the separate foreign-tenant UUID to the run nonce. UUID syntax alone never grants
cleanup ownership. Token actor/tenant claims and both browser tenant headers are
checked against that fixture; no JWT or source/proposal values enter text logs.

```sh
packages/core-backend/node_modules/.bin/tsx \
  scripts/attendance/acceptance/acp1b-browser-realdb.mts \
  /opt/homebrew/opt/postgresql@15/bin
```

Optional second arguments `disconnect-apply` and `foreign-tenant` are deliberate
negative mutations. They must return nonzero at the positive apply oracle; they
are not alternative success modes. No product file changes for these mutations.

Cleanup closes Chromium, Vite, the real server and pools independently, checks
the ownership marker and PG data directory, requires no remaining DB connections,
drops only its created database, stops its private cluster, and verifies all owned
ports closed. Cleanup errors prevent PASS and preserve the owned directory for
diagnosis. A start attempt is checked even if `pg_ctl start` reports a timeout.

## Verification

| Gate | Result |
| --- | --- |
| Chromium → real Vue → actual metadata/list/apply → PG | PASS |
| Explicit confirmation and closed command | PASS; no pre-confirm POST/edit |
| UI consumed / canonical normal / exactly-once effects | PASS |
| Membership revoked after review | Real 403; complete DB snapshot unchanged, including proposal history/markers |
| Disconnect actual apply path | RED at `APPLY_HTTP_STATUS`, real 404; zero DB change |
| Wrong upstream tenant binding | RED at `APPLY_HTTP_STATUS`, real 403; zero DB change |
| Browser page errors / unexpected API failures / backend egress attempts | Zero in positive run; only the asserted revocation 403 allowed |
| Desktop 1280×900 and narrow 390×844 | Screenshots visually inspected; review/confirm/status visible |
| Web neighbor | `AttendanceReportFieldsSection.spec.ts`: 41/41 |
| Backend neighbors | cleaning-proposal + field-catalog: 45/45 |
| Backend normal typecheck | `pnpm --filter @metasheet/core-backend exec tsc --noEmit`: PASS |
| New script static check | 0 target type diagnostics; 0 syntax diagnostics |
| Resource cleanup on positive and negative runs | Owned DB/backends/ports = 0 |

Runtime: Node 20.20.2, locally installed PostgreSQL 15, existing Chromium from
the workspace Playwright dependency. No global installation was performed.
The standalone TypeScript check reuses backend compiler options with ESNext /
Bundler resolution, DOM types and pg/vite paths to their existing workspace
installations. Its imported backend closure reports 23 configuration-dependent
diagnostics; those are not counted as clean. The normal backend typecheck passes
separately, and both new script files have zero diagnostics.

Retained local logs (not committed, no real tenant data):

- `tmp/acp-browser-final-positive.log`
- `tmp/acp-browser-final-repeat.log`
- `tmp/acp-browser-final-disconnect-json.log`
- `tmp/acp-browser-final-tenant.log`
- `tmp/acp-browser-web-neighbor.log`
- `tmp/acp-browser-backend-neighbor.log`

Visually inspected screenshots are under
`tmp/acp-browser-7635e18f0f58403597e104a2e52b8037/`:
`desktop-review.png`, `narrow-review.png`, `narrow-consumed.png`,
`desktop-denied.png`. Only synthetic records appear. The host displays the real
catalog fallback notice because this minimal fixture does not populate custom
catalog rows; this acceptance does not claim catalog provisioning or full-shell
navigation coverage. It does exercise the actual physical proposal sheet.

## Retained carrier failures and review

- Sol implemented the dedicated fixture; main agent inspected its code.
- Astra's single risk-focused review found startup-timeout cleanup and incomplete
  browser-wide egress protection; both were corrected in the runner.
- Terra reported zero diagnostics in the two scripts and clean syntax; diagnostics
  in the imported backend closure under the standalone compiler configuration are
  separate from the backend's normal typecheck and are not counted as PASS.
- Initial fixture failure: calculation/segment/pointer inserts lacked their shared
  transaction; restored the original W4 fixture transaction semantics.
- Initial browser carrier failure: two Vue module instances prevented controls
  rendering; use the same Vite-resolved `vue` import as the real component.
- Disconnected real apply path: metadata 200, records 200, apply 404;
  `APPLY_HTTP_STATUS` RED, no page errors; cleanup DB/backends/ports all zero.
- First unmutated chain: metadata 200, records 200, apply 503. Exact source review
  identified the synthetic prefixed org key as incompatible with W4's UUID-only
  (or exact `default`) organization grammar. No product parser was changed.
  Coordination approved using a new UUID bound to the local nonce manifest;
  after correction the positive chain passes. This was not a security mutation.
- The dev-token route uses the `id` claim, not `sub`; its explicit fixture claim
  assertion was corrected to the actual route contract before positive acceptance.
- An unknown-route 404 can be non-JSON; diagnostic parsing now tolerates that
  format, while the HTTP-status assertion still fails and DB zero-write is checked.

All failed carriers remain failed evidence; none was reclassified as a product
regression or used as a passing test. The positive result comes from the separate
unmutated real chain. No product/shared/workflow/package/lockfile changes, no
deployment, live metrics sampling, real organization, persistent flag enablement,
Ready or merge are part of this follow-up.
