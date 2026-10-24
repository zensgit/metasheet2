# W23 readiness transport, cut T

Branch `codex/plm-w23-readiness-transport-20261024` stays on `f33398b790b191294d69a43e0bc1832a437e3755`. Nonce `7e09d5e00da0451287d73467c39d4a0b`. Session `gbt-d5a9-1a169a37722-bd`. This cut adds `getReadinessCollaborationSource` on the existing `PLMAdapter`. The accepted readiness wire parser is imported and left unchanged. The method reads one release-readiness collaboration source from an explicit fresh source config.

The human choice recorded on the owner is `Humanadoptedreadonlypersistentcollaboration; technicalTcutonly; no newproductdecision`. This cut is the transport slice only.

## Scope

Five paths. The two files that already existed keep these baselines. The three new files had no baseline.

| Path | Baseline sha256 | Baseline bytes | Working sha256 | Working bytes |
| --- | --- | --- | --- | --- |
| `packages/core-backend/src/data-adapters/PLMAdapter.ts` | `b2cf3aa31fb763a929ada84a4f07553cc5b0b1c6664676f71a7c7db6f7e33638` | 177607 | `a1df570b27ba6ef95627295a963e7885c5cdf4baa158c7624fcc555b6439732c` | 182908 |
| `packages/core-backend/tests/unit/plm-collaboration-readiness-source-transport.test.ts` | absent | absent | `0bca08ddda7a7cbd37cbc38448aaa294c44f90c93159c2132274a2750f47469c` | 25856 |
| `.github/workflows/plm-bom-listener.yml` | `da580118aca6fa1f2e8d4863b918aa41efbbf266a537125ea1a2f5c5129aa3f0` | 3334 | `84cf1f71bb1b6c0c5c5cafc1a04003131a9b48dc8886bc7c6c572390dd0eed01` | 3408 |
| `docs/development/PLM_W23_READINESS_TRANSPORT_DESIGN_VALIDATION_20261024.md` | absent | absent | recorded in the receipt after this file is written | recorded in the receipt |
| `artifacts/plm-w23-readiness-transport-20261024/verification.json` | absent | absent | recorded in the grok report after the receipt is written | recorded in the grok report |

`git diff --numstat` at closeout, before this design existed, was `1 0` for the workflow and `212 74` for the adapter. The workflow diff is one appended argument in the existing folded vitest step:

`tests/unit/plm-collaboration-readiness-source-transport.test.ts`

The real PostgreSQL collaboration snapshot job steps are unchanged. The workflow baseline `da580118aca6fa1f2e8d4863b918aa41efbbf266a537125ea1a2f5c5129aa3f0` is the pre-append pin and remains the owner pin. The working hash above is the file after that single append.

All 46 owner pin paths were rehashed at closeout. Mismatches: 0. The ECO transport test stays `1113dae8a3462ff1ca56a2e8f351c1b738721aed69dc42e219a0566fb3acae9b`, 22892 bytes. The readiness wire stays `87a547b7d9915ed10dc48ba5498c9bb16f58d88aaa663e74b6a1d658d705576a`. The receipt lists every pin.

`artifacts/` is ignored by `.git/info/exclude` line 10. That exclude file was not edited. The receipt is written on disk and stays untracked.

## Transport

`getReadinessCollaborationSource(input, freshSourceConfig)` returns `Promise<ReadinessCollaborationSource>`. `getEcoCollaborationSource` keeps its previous signature and returns through the same executor. The shared path is a finite `eco | readiness` branch in the existing prepare, login, accept, and execute helpers. There is no second transport implementation and no registry.

Prepare runs before the first await. It copies the fresh config's source id, URL, Native `x-tenant-id` and `x-org-id` headers, matching options, and credentials. The request uses those copies. It does not read `this.config`, `this.client`, `this.query`, a cached token, a shared service identity, or Meta actor and workspace ids.

Scope still uses `isEcoCollaborationId(value, 64)` and rejects CR or LF. Missing, non-string, ambiguous, or conflicting header and option aliases throw `403 READINESS_SOURCE_SCOPE_AMBIGUOUS` before any request. The source id uses `isEcoCollaborationId(sourceId, 128)`. Request item, ruleset, and nullable version go through `parseReadinessCollaborationSourceInput`. The Python 3.11 strip set stays inside that parser.

The readiness POST is `/api/v1/plm/collaboration-sources/items/{encodeURIComponent(itemId)}/release-readiness`. The JSON body is `ruleset_id` plus required nullable `current_version_id`, in that order. Login, when the captured token is absent, is `POST /api/v1/auth/login` with the captured `username`, `password`, `tenant_id`, and `org_id`. Login and the readiness POST use `redirect: 'error'` and `AbortSignal.timeout(8000)`.

An explicit token that receives HTTP 401 or 403 becomes `401 READINESS_SOURCE_TOKEN_REJECTED`. That path does not call login, including when username and password are also present. Login uses only the credentials copied from the same fresh config.

The captured source id is classified with `assertLegacySharedTransportAllowed` before the first request, after a login JSON token is accepted and before the readiness POST, and around the source body: once before status handling and again after `parseReadinessCollaborationSource` returns, before the value is returned. A refusal cancels the owned body. Bound, disabled, stale, schema-missing, and unavailable classifications reject for every observed flag value (`undefined`, empty, `false`, `true`, and `arbitrary`). Schema-missing is `403 PLM_MANAGED_SCHEMA_MISSING`. Unavailable is `403 PLM_MANAGED_BINDING_UNAVAILABLE`. Bound, including disabled and stale, is `403 PLM_MANAGED_SHARED_TRANSPORT_REFUSED`. This admission does not write, change flags, change auth, or change grants.

Parser results stay on the wire class: `422 READINESS_SOURCE_INPUT_INVALID`, `403 READINESS_SOURCE_UNLICENSED`, `502 READINESS_SOURCE_REJECTED`, and `409 READINESS_SOURCE_ANCHOR_MISMATCH`. Other non-ok HTTP responses, including 503, become `502 READINESS_SOURCE_UNAVAILABLE` before a snapshot is returned. Unexpected transport failures use the same 502 code. The error message is the code, so credential, token, and body text are not copied into it. Entitled false, a malformed envelope, a foreign tuple, version, or ruleset, coverage `all_ready`, and HTTP 503 do not return an empty or global-ready snapshot.

## Measured checks

An implementation-turn run of the same two commands was observed before this closeout. It had no log file, so it has no log sha256. Free space before that run was 11832700928 bytes. `tsc --noEmit --pretty false` exited 0. Vitest 1.6.1 with `--maxWorkers=1 --minWorkers=1` started locally at 08:55:42, printed pool timestamps `2026-10-24T00:55:42.811Z` and `2026-10-24T00:55:43.092Z`, and reported 2 files and 61 passed tests in 858 ms, exit 0. UTC start and end for that `tsc` process were not recorded.

The frozen closeout capture is `/tmp/plm-w23-readiness-transport-checks-20261024.log`, sha256 `06f6f7e6c393cfd324f5b801f1b90dee53bcd5f87a85e65873f938f9c8ab9fc5`, 9580 bytes. The disk floor was 4563402752 bytes. Free space at the gate was 13505818624 bytes. Both commands ran in `packages/core-backend`.

- `node node_modules/typescript/bin/tsc --noEmit --pretty false` started `2026-10-24T01:01:07.887856+00:00`, ended `2026-10-24T01:01:16.534193+00:00`, and exited 0. Free space before it was 13505806336 bytes and after it was 13495025664 bytes. `tsconfig.json` includes `src` and excludes `**/*.test.ts`, so this check covers the adapter and not the new unit file.
- `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1 tests/unit/plm-collaboration-readiness-source-transport.test.ts tests/unit/plm-collaboration-eco-source-transport.test.ts` used Vitest 1.6.1, started `2026-10-24T01:01:16.534288+00:00`, ended `2026-10-24T01:01:17.789536+00:00`, and exited 0. The local start line is `09:01:16`. Duration was 840 ms (transform 169 ms, setup 51 ms, collect 397 ms, tests 113 ms, environment 0 ms, prepare 81 ms). Test files: 2 passed. Tests: 61 passed. The log lists 33 readiness checks and 28 existing ECO checks. Free space before it was 13495025664 bytes and after it was 13490708480 bytes. Stderr is the Vite CJS Node API deprecation warning.

The readiness file checks controlled loopback path, body, and headers, captured-id mutation during admission, classification before egress for every flag value plus disabled, stale, schema-missing, and unavailable at `false` and `true`, credential and scope and URL refusal, explicit 401 and 403 with username and password and no login fallback, redirect and timeout, management change after login JSON and after the readiness body with cancellation, and malformed, foreign tuple, foreign version, foreign ruleset, unlicensed, `all_ready`, and 503 denial.

The loopback server is `127.0.0.1` inside the unit process. That result is local transport evidence. It is not Native authority, PostgreSQL, UI, or install acceptance.

Outside this cut: the readiness service, the forward migration, real PostgreSQL, UI, route enablement, grants, flags, persistence admission, and Native authority. No commit, push, pull request, merge, deploy, enablement, business notice, or issue close was performed. Parent Draft 6520 CI was left running.


## Independent Codex acceptance and final CI integration

Root admitted the matching released Grok owner and actual session activity `done`, then verified all 46 protected pins. The Adapter stayed `a1df570b27ba6ef95627295a963e7885c5cdf4baa158c7624fcc555b6439732c`. Independent static review found no actionable transport defect. Root executed only eight separately prepared transport controls: 8 PASS, zero failure/error/skip, log SHA-256 `e3724c3d08922434a2789a4d2b8e41c649711b112484a81ca7381e34fec677bd`, probe SHA-256 `556d87d3742f6ac3b25711d514a090762eb37495897ee0fae4207f46447273a3`. The temporary probe was removed and all 51 pre-run pins stayed unchanged. These controlled fetch/classifier controls do not qualify Native auth or real PostgreSQL.

The author's pinned log independently records new Readiness33 plus affected ECO28, all61 passed, and backend tsc exit0 on that same source body. Root verified that log hash and did not rerun the passing cohort or typecheck. Backend tsc excludes test files; Vitest transpilation is not a test-file typecheck.

The preceding table and one-argument workflow snapshot are the author's measured implementation state. Root then found that the existing ECO transport filename had no registration in any workflow at the frozen base. Because this slice changes ECO's shared executor, Root appended that affected unit filename beside the new Readiness filename in the same existing command. The final workflow is an exact two-argument append against the parent, with YAML parsing verified; all old arguments, jobs, gates, triggers and permissions remain. This metadata-only integration does not change the tested Adapter or unit bodies. The final workflow hash and Root evidence are in the receipt's `root_independent_validation` block. No new broad passing cohort was rerun.

Parent Draft6520 `f33398b790b191294d69a43e0bc1832a437e3755` is all-terminal16successful checks plus the retained private Native checkout-token failure; its necessary listener job records the prior pure-wire8 green. Child transport still needs exact-head CI after publication. Readiness source-kind persistence remains closed; forward DB admission, shared service/routes, genuine PostgreSQL, actual Native/Meta process HTTP, workspace/browser, installed and whole-master acceptance remain open.
