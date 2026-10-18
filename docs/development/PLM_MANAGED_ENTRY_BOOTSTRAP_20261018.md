# Managed entry bootstrap — worklog (2026-10-18)

Branch `codex/plm-managed-entry-bootstrap-20261018` at parent `28d2125719895310d8289bb685a36fe96d8ccfa0`. This slice is not committed, pushed, or deployed. The native tree and the parent checkout stay read-only. No dependency install. Existing `node_modules` symlinks stay as they are.

## Assumptions

The corrected review in `/tmp/plm-managed-b2b-astra-review-20261018.md` replaces the earlier public GET and the `/api/auth/me` `req.user` fallback. This Meta tree proves the SPA bridge with the existing native provider. It does not install the native workspace button. That launcher stays a later native slice.

Selection uses an existing active link plus active binding. `native_subject_hint` only chooses a row. The exchanged native AuthUser still has to match that frozen row. Equal Meta ids, emails, roles, or numeric ids are not identity. No new user, source, or business policy is created.

`POST /start`, `/unlink`, and `/revoke-retry` stay authenticated owner routes. Public entry is exact `POST /browser-start`, exact `POST /complete`, exact `GET /current`, and exact `POST /logout`, plus the existing callback path. The callback GET does not exchange. `routes/auth.ts` is not widened. `buildFeaturePayload` is exported so the dedicated snapshot can return the same feature shape.

A cross-tab change that is already visible when `POST /complete` starts is refused before consume and before exchange. A change that lands in another tab while that POST is in flight is rejected on the client: the stale body is not adopted. This slice does not claim that the server withholds `Set-Cookie` for that in-flight window. Ordinary auth writers are not all coordinated with completion. That stronger claim is reported, not implemented.

## Minimal approach

One transaction-local intent helper serves the owner start and the public start. The public start locks the single mapped row, then calls the helper. It does not call `startManagedLogin` inside that transaction.

The return view reads `TOKEN_KEYS` again, checks a hash-only tab correlation, strips `code` and `state`, and POSTs completion on the Meta origin. The SPA installs a non-credential descriptor only after `GET /current` verifies the purpose cookie. Cache keys include mode, person, Meta tenant, and session. Managed entry never calls dev-token acquisition, including after a failed probe.

## In-flight limit reported to main

Literal "no Set-Cookie while a cross-tab sign-in is in flight" is not proved. Completion commits and sets the HttpOnly cookie when its own request still shows the frozen person. Another tab's `localStorage` write is not visible to that request. Closing the gap would require every ordinary auth writer to share an interlock, or a staged confirm after the response. A navigation that observes the other person before POST is a different case and is tested separately. The client test discards a late body after the epoch moves. It does not prove the cookie was withheld.

## Results

Parent remains `28d2125719895310d8289bb685a36fe96d8ccfa0`. No commit, push, PR, or deploy. No schema migration. `routes/auth.ts` gained `export` on `buildFeaturePayload` and nothing else. `AuthService` and `jwt-middleware.ts` are unchanged. The native checkout was not edited. The native workspace button is not installed.

Public entry is `POST /browser-start`. The hint selects one persisted active mapping. The exchanged native AuthUser has to match that row. Two native persons on one client and root each resolve their own mapping. A swapped hint fails. A duplicate mapping for the same person is refused. Callback GET only hands the browser to `/plm/managed-return`. Exchange and the session cookie wait for same-origin `POST /complete`. `GET /current` returns the user, features, and a non-credential descriptor. Logout revokes only the presented managed session.

### Counts

| Check | Result |
| --- | --- |
| Backend unit trio | 21 passed, 0 failed. `/tmp/plm-managed-b2b-unit.json` |
| Managed PG | 34 passed, 0 pending. `/tmp/plm-managed-b2b-pg.json` |
| Web bridge + existing PLM specs | 22 passed (bridge 9, companion 1, companion view 2, BOM workspace 10) |
| Ordinary `useAuth.spec.ts` | 36 passed |
| `featureFlags.plm.spec.ts` | 1 passed |
| `plm-bom-customer-route.spec.ts` | 5 passed |
| Backend `tsc --noEmit` | exit 0. `/tmp/plm-managed-b2b-tsc.log` |
| Web `vue-tsc -p tsconfig.app.json --noEmit --incremental false` | exit 0. `/tmp/plm-managed-b2b-vue-tsc-app.log` |
| Chromium full `main.ts` entry | ok. `/tmp/plm-managed-b2b-entry-proof.json`, nonce `loeg1eg2` |
| Default paired `run.mts` | ok. `/tmp/plm-managed-b2b-paired-proof.json` |

CI strict counts in `.github/workflows/plm-managed-companion-consumer.yml` are unit 21, PG 34, web 22. The web command includes `tests/plmManagedEntryBridge.spec.ts`.

Chromium entry proof: empty `auth_token` / `jwt` / `devToken`, one open managed session, dev-token requests 0, embed requests 0, BOM line `line`, ordinary owner start true, Meta user `meta-owner`, native subject hint `42`. Native write audits 0 and write subjects empty, so the read did not create a write audit. Paired cleanup removed its directory after the postmaster stopped. Default paired proof: two handshakes, write patch 200, rebind generation 2, revoke outage pending-then-acked, late callback open sessions 0, native write subject `[42]`.

### RED before the fix

- `/tmp/plm-managed-b2b-gate-red.log`: public browser-start was not a gate exception.
- `/tmp/plm-managed-b2b-conflict-red.log`: the other person was consumed instead of left pending.
- `/tmp/plm-managed-b2b-feature-join-red.log`: a public feature load answered the next principal with `plm: false`.
- `/tmp/plm-managed-b2b-snapshot-adopt-red.log`: a 200 current snapshot returned `ok: false` because installing the descriptor changed the session signature and the post-install check cleared it.

### Limits

The in-flight Set-Cookie claim above is unchanged. Do not read the client epoch test as proof that the cookie was withheld.

Expired logout does not update `expires_at`. That column is immutable. The PG proof re-signs a JWT with the same session id and a past `exp`, then logs out with the flag off. The original cookie's `exp` did not elapse.

`vue-tsc -b` reports a plugin type clash in unchanged `apps/web/vite.config.ts` between Vite 5.4.21 and Vite 7.3.7 in the existing `node_modules` tree. The app project typecheck above does not include that file and passed. `tests/featureFlags.spec.ts` fails 3 assertions on this tree and, in a detached parent worktree, fails the same 3 assertions at `28d21257`. That file was not edited. The parent worktree was removed.

A managed bootstrap joins an in-flight probe only when the epoch and principal key match. A stale attempt does not clear a descriptor that a newer attempt replaced.

### Cleanup

Owned consumer PG nonce `b069bf5498eeb643` was removed only after `pg_ctl` status 3. Proof: `/tmp/plm-managed-b2b-pg-cleanup.json` (`postgresStopped` true, `directoryRemoved` true, `markerMatched` true). Both paired runs report `postgresStopped` true and `directoryRemoved` true.

### Code hashes

Recorded after the last code edit and before this results section:

- `apps/web/src/composables/authPrincipal.ts` `83d4920fe3ef3b89f493adf738a1d47eba7d26cdeb7d67b61811cf123e696170`
- `apps/web/src/composables/useAuth.ts` `b17cbc41cb26ab398b36cf60a4507d01a2510ad95a3e0eff0191ec82ce12baa6`
- `apps/web/src/main.ts` `76514128efc2128c8d1d0f386f10cfcea4144cc8e2ab0375f1bdc1b38b4d5642`
- `apps/web/src/router/appRoutes.ts` `41e58ceadab0c27cc89afa4ad25b58501f1f62972d0c8891fc7b42620e62ea9b`
- `apps/web/src/services/plm/plmManagedCompanion.ts` `4399b64120cfe35148ea697e1f368c93c8fbc50bf19016c82fdb0929fba0cc2f`
- `apps/web/src/stores/featureFlags.ts` `6a88a03596971ce718c24183d33a4ebd2fb0241fbb5e614b9d6829f847c2cba1`
- `apps/web/src/utils/api.ts` `dc3de2f25a6c3f0c1d108afaaa271fa3317dc326a3e8ae5bc1e636e03bb9d18e`
- `apps/web/src/views/PlmManagedEntryView.vue` `6603eb215793f7214ef93eef47402d5d5d9c2c56cb2f0f701b64bde949fe4328`
- `apps/web/src/views/PlmManagedReturnView.vue` `6d43217fe2536c907281af4d2a4af857beaf29f8534356a4ab4686e4e2b6a09e`
- `apps/web/tests/plmManagedEntryBridge.spec.ts` `18f3703a46971782486ea7d11d65dca0f507344712ac5c89a3e573edf725e672`
- `packages/core-backend/src/auth/api-path-policy.ts` `344b4f35dbc9790376550bc01274ec3add655b65112bdc47da3233f17101b64d`
- `packages/core-backend/src/auth/plm-managed-session.ts` `8149f3a8986d9bb70f698fc5f67b05b2bfd4223650db2cac4916c2ad1ce01ab7`
- `packages/core-backend/src/routes/auth.ts` `8b410b579cfe03cc3de45864b5d87fe9db7ff5a5856e039251d7264e1c68873e`
- `packages/core-backend/src/routes/plm-managed-companion.ts` `ebb0890a8bf8c1deed863d9a3606dfae0a7b0b391460166acdb811322de68a58`
- `packages/core-backend/src/services/plm-managed-companion-flow.ts` `992fbd82d4f1b5e2c55be1d48e5ab2f4ec419ffb5f6c6a4f055214836023449c`
- `packages/core-backend/tests/integration/plm-managed-companion-pg.realdb.ts` `bd3ec2b3964979acc4e1071853a6c51618012dc7d3d23bfcb7f051d1653a6bf9`
- `packages/core-backend/tests/unit/plm-managed-companion.test.ts` `e8f0795d0c80eeba817af1ff2dcf538b189d1246cee0876dccfbeaa0e8036d11`
- `.github/workflows/plm-managed-companion-consumer.yml` `677e35fe66196c09619e0ace45a6f839da9dac76f923595c8b5257630fb277dc`
- `scripts/verification/plm-managed-companion-paired/run.mts` `c448d2cd82df2ed3957d452e57f2d48c529e0890437e9f54157efc13b11a21ce`
- `scripts/verification/plm-managed-companion-paired/verify.py` `83bdc92b2e94e243d78b9273b66b4f7b51f29590b86a374969bf1abb956a6aa7`
- `scripts/verification/plm-managed-companion-paired/entry-run.mts` `2d885e37d6a7d855345adf3105b938ebc74df7cb125a5b0d18af67593573247d`

## Current response fields

Parent remains `28d2125719895310d8289bb685a36fe96d8ccfa0`. This tree was not resynced. `GET /current` copies `id`, `email`, `name`, `role`, `permissions`, `tenantId`, and `must_change_password` from the verified user, passes that same user to `buildFeaturePayload`, and copies `mode`, `userId`, `tenantId`, `sessionId`, `revision`, and `expiresAt` from the descriptor. Logout still returns `{ ok: true, revoked }`. Neither handler stringifies the body to scan it.

`/tmp/plm-managed-b2b-current-shape-red.log` shows the previous user object also carried `activation_status`, `created_at`, `is_active`, `managedPurpose`, `managedSessionId`, and `updated_at`. After the projection, the same PostgreSQL case passed: 1 passed, 33 skipped. Backend `tsc --noEmit` exited 0. Chromium was not rerun. The SPA still reads `id`, `email`, `role`, `permissions`, `must_change_password`, `data.features`, and the descriptor.

Owned nonce `5496bbc7fa52602a` was removed after cleanup. Proof: `/tmp/plm-managed-b2b-current-pg-cleanup.json` (`postgresStopped` true, `directoryRemoved` true, `markerMatched` true).

Hashes that replace the two entries above:

- `packages/core-backend/src/routes/plm-managed-companion.ts` `a6e4c335706cb912bc3c87bcf8b5f30c5f80d4fff474e8014862f48f5c38ed99`
- `packages/core-backend/tests/integration/plm-managed-companion-pg.realdb.ts` `cd248cfe87ea100b9903a97b18f3abc768a2ebbd824e793d156495a8af71db00`

## Bridge response shape

Parent remains `28d2125719895310d8289bb685a36fe96d8ccfa0`. Main's expiry check in `readManagedDescriptor` / `installManagedDescriptor` and the same-origin check in `bootstrapManagedCookie` stay. This continuation does not edit those files. `authPrincipal.ts` is `0ec3d9bc3394b18eb11ff30431a827e8b12a8412274b52f068421be6204f4bab`. `useAuth.ts` is `0b53f882451b5b49425bf7ff72e929d70576e316c34de3467f1fbb0acb166b27`.

The bridge client no longer searches response text or public values for `yur_`, `client_secret`, or `clientSecret`. Success bodies must be the exact field set the handler returns. A navigation URL must be `http` or `https`, path `/managed-login`, with query names only from `buildManagedLoginNavigation` (`client_id`, `callback`, `origin`, `tenant_id`, `org_id`, `issuer`, `root_part_id`, `state`, `code_challenge`, `code_challenge_method`). `code_challenge_method`, when present, must be `S256`. A completion destination must be a relative `/plm/bom-review` with query names only from `fixedDestination` (`dataSourceId`, `partId`, `managed`, `reason`). `managed`, when present, must be `ready` or `refused`. Credential query keys and unexpected fields are still rejected. `tests/plmManagedCompanion.spec.ts` is unchanged and still rejects `code_verifier` and an unexpected `credential` field.

At the worker release, the parent backend navigation builder still rejected public root ids containing `yur_`. Main subsequently reproduced and repaired this remaining end-to-end failure; the final independent results below supersede that limitation.

Managed bootstrap still drops an expired cookie snapshot instead of returning the cached success, because the cache short-circuit requires the principal key and `readManagedDescriptor` clears an expired descriptor first. `bootstrapManagedCookie` returns before fetch when the API origin is not the page origin. `apiFetch` keeps that check for later managed calls. Focus refresh passes `force`, so it does not reuse the cache. Ordinary token bootstrap still calls `getApiBase()` directly. That path is not the managed cookie probe. No further auth edit.

The in-flight Set-Cookie limit is unchanged. Completion can still set the HttpOnly cookie when its own request shows the frozen person. Ordinary auth writers are not interlocked with that request. This is not a full-goal claim.

### Counts after the shape repair

Strict web files, unchanged set:

- `tests/plmManagedCompanion.spec.ts` — 1
- `tests/PlmManagedCompanionView.spec.ts` — 2
- `tests/PlmBomReviewWorkspaceView.spec.ts` — 10
- `tests/plmManagedEntryBridge.spec.ts` — 13

The previous strict total was 22 with 9 bridge tests. Main added 3 bridge tests, which made 25. This continuation added 1 bridge shape test. The strict web total is 26. Asserted by `.github/workflows/plm-managed-companion-consumer.yml` and `/tmp/plm-managed-b2b-web-shape.json`.

| Check | Result |
| --- | --- |
| Strict web four files | 26 passed. `/tmp/plm-managed-b2b-web-shape.json` |
| Ordinary `useAuth.spec.ts` | 36 passed |
| `featureFlags.plm.spec.ts` | 1 passed |
| `plm-bom-customer-route.spec.ts` | 5 passed. Combined ordinary report `/tmp/plm-managed-b2b-ordinary.json` (42) |
| Managed PG, including the three concurrency cases | 34 passed, 0 pending. `/tmp/plm-managed-b2b-pg.json` |
| Web `vue-tsc -p tsconfig.app.json --noEmit --incremental false` | exit 0. `/tmp/plm-managed-b2b-vue-tsc-app.log` |
| Chromium full `main.ts` entry | ok. `/tmp/plm-managed-b2b-entry-proof.json` |
| Default paired `run.mts` | ok. `/tmp/plm-managed-b2b-paired-proof.json` |

Backend unit 21 was not re-run. Backend product files were not edited in this continuation. PostgreSQL unit count in the workflow stays 21. The PG count stays 34.

Chromium entry: empty `auth_token` / `jwt` / `devToken`, one open managed session, dev-token requests 0, embed requests 0, BOM line `line`, ordinary owner start true, Meta user `meta-owner`, native subject hint `42`, native write audits 0, write subjects empty. The entry fixture root is `part`, so this run does not exercise a public id that contains `yur_`. Default paired: two handshakes, write patch 200, rebind generation 2, revoke outage pending-then-acked, late callback open sessions 0, native write subject `[42]`.

### Cleanup

The first owned start, nonce `bac55e57a758de8b`, exited before vitest because `status` is read-only in zsh. That postmaster was stopped and the directory removed. Proof: `/tmp/plm-managed-b2b-pg-abandoned-cleanup.json`. The suite then ran on nonce `b07f9d7146a62854`. Proof: `/tmp/plm-managed-b2b-pg-cleanup.json` (`postgresStopped` true, `directoryRemoved` true, `markerMatched` true). Both paired runs report the same three cleanup flags. No other `/tmp` directory was removed.

### Code hashes

Recorded after the last code edit:

- `apps/web/src/services/plm/plmManagedCompanion.ts` `2ed228ee8b4d7965e7c6a882d13c3d0ce9d2b2768ad8b1e1c21a1c95b5ac8c1c`
- `apps/web/tests/plmManagedEntryBridge.spec.ts` `65654f6ce35c4942af3e5804a9ec4f28baaaf677a645521e38cc09b016c6d74d`
- `.github/workflows/plm-managed-companion-consumer.yml` `7575290035466cf7965bd1c028b471e879437566209f27d23f264878555234dd`
- `apps/web/src/composables/authPrincipal.ts` `0ec3d9bc3394b18eb11ff30431a827e8b12a8412274b52f068421be6204f4bab`
- `apps/web/src/composables/useAuth.ts` `0b53f882451b5b49425bf7ff72e929d70576e316c34de3467f1fbb0acb166b27`
- `packages/core-backend/src/services/plm-managed-companion.ts` `df359c48d050fa4b599353a89a70e49b416640516fcf3afdac3c8be6a6aa62ec`

`packages/core-backend/src/services/plm-managed-companion.ts` is the unmodified parent file. Its hash is recorded because the navigation scan above is still there. No commit, push, PR, or deploy. Native checkout status was empty. RELEASE for main's independent final review.

## Independent final verification

Main independently reproduced a backend navigation failure for valid public id `yur_public-part` (`/tmp/b2b-main-server-public-id-red.log`), then removed the serialized-value substring scan. The builder still constructs only its ten explicit public fields, and a new backend positive control verifies the id and absence of credential query keys. The strict unit gate increased to22. This complements the earlier main expired-cache and direct-bootstrap foreign-origin reproductions and fixes; no authority check, source binding, scope, baseline or skip gate was weakened.

Main reviewed the final bridge/route/current projection/session cache and callback identity checks, then ran **22 backend unit tests**, **68 web tests** (strict26 plus ordinary compatibility42), and **34 actual PostgreSQL15 tests**, each with zero failures/pending/skips. Counts are independent suites with overlap in earlier worker results, not cumulative evidence. Backend `tsc --noEmit`, web application `vue-tsc --noEmit -p tsconfig.app.json --incremental false`, actionlint and diff whitespace checks all exited0. The pre-existing full Vite config type clash described earlier is not claimed fixed.

The repository verifier now supports `--workspace-entry --browser-script entry-run.mts`. Main ran actual native first-party sign-in → workspace BOM tab → explicit review button → fixed same-origin launch (forged editable bearer/API base ignored) → Meta-origin browser bridge → native explicit Continue → callback return bridge → full real `main.ts` SPA → BOM line `line`. Native root was `yur_public-part`, native AuthUser42 versus RBAC900, and Meta person `meta-owner`; no ordinary `auth_token`/`jwt`/`devToken` was preloaded. The verified session opened once; dev-token and embed requests were zero. All owned native/Node/PostgreSQL/proxy resources were stopped and removed. This proves the combined local browser path, not an installed production topology. The first main draft harness omitted opening the BOM tab and timed out before a launch request; that harness mistake was corrected without a product workaround, and its failure/cleanup evidence was retained.

Main separately reran the default paired business proof: two handshakes, personal line PATCH200/native audit subject42, native logout204, owner transfer ACK, rebind generation2, revoke outage pending→acked and late callback zero live sessions; cleanup succeeded. The new workspace-entry option leaves that default fixture behavior unchanged. Source application hashes remained stable during final runtime verification. Compact evidence: `artifacts/plm-managed-entry-bootstrap-20261018/independent-verification.json`.

Reproduce the combined local proof using the interpreter, Node20, PG15 binaries and browser cache documented above with `scripts/verification/plm-managed-companion-paired/verify.py --meta-checkout <isolated-Meta-tree> --native-checkout <native-launcher-tree> --python <venv-python> --node <node20> --pg-bin <postgres-bin> --browser-cache <cache> --workspace-entry --browser-script entry-run.mts --output <proof.json>`. The native tree used source `991d8a62849df9576af164e935785bcdd15774c0`. Raw main reports use `/tmp/b2b-main-final-{unit,web,pg}.json`, `/tmp/b2b-main-repo-combined-proof.json` and `/tmp/b2b-main-final-paired-proof.json`.

The cross-tab change during the final request can still install the frozen person's HttpOnly cookie before the client discards a stale response. Ordinary auth writers are not yet interlocked. That remaining identity-race guarantee, installed upgrade/backup/restore/disable acceptance, exact remote head CI and the whole master goal remain unfinished. No claim of complete personal-identity closure or complete master-goal acceptance is made here.
