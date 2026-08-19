# On-Prem Deploy Path Acceleration — main → Windows test host (2026-08-18)

Draft. Analysis + proposal only; authorizes nothing. Companion draft:
`scripts/ops/stock-preparation-lab0-inventory.mjs`.

## a. The path today

| # | Step | Who | Produces | Wall time | Round-trips |
|---|---|---|---|---|---|
| 1 | Owner ratification comment on the governing issue (#4695 / #4708 / #4437) | owner | `owner…Decision=…_V1` | hours–days | 1 |
| 2 | Build — `multitable-onprem-package-build.yml` (inputs `expected_sha`, `publish_release`, `release_tag`) | CI | .tgz/.zip + .sha256 + SHA256SUMS + metadata + bootstrap .ps1/.bat | ~3 min (run 30636435663) | 1 |
| 3 | Verify — `multitable-onprem-package-verify.sh` on both archives inside the build job, + a `pnpm install --frozen-lockfile` dependency preflight | CI | verify .json/.md ×2 | in step 2 | 0 |
| 3′ | Alternative: `stock-prep-main-package-verify.yml` = build + verify + one-byte negative control + migrate on PG 15/16/17, same run | CI | artifact only (`contents: read` — cannot publish) | ~4 min (run 31666982219) | 1 |
| 4 | `multitable-onprem-package-no-node-modules.test.mjs` | CI | pass/fail | — | 0 — wired **only** into `plugin-tests.yml` |
| 5 | Provenance — `BUILD_PROVENANCE.json` (gitCommit/gitRef/`sourceIsOnOriginMain`/fixMarkers); `packageProvenanceManifestDigest` = `verifySealedExportRuntimePackageProvenance().frozenManifestDigest` (65 pins) | CI / manual `node -e` | 2 digests | seconds | 0–1 |
| 6 | Freeze + release — only step 2 with `publish_release=true` has `contents: write`; owner then transcribes 5 fields (`serviceRuntimeSha`, `releaseTag`, `packageFile`, `packageSha256`, `packageProvenanceManifestDigest`) into an issue comment | owner | frozen block | hours | 1–2 |
| 7 | Transfer — `gh run download` / release download to a transfer workstation, then to the host. No automated Windows-host sync exists (docker-build.yml's `sync_rc`/`deploy_rc` lane, PR #4971, is the Linux K3-WISE host) | operator | package on host | minutes–hours | 1 |
| 8 | Deploy — `deploy.bat` → `multitable-onprem-deploy-launcher.ps1` → staged `multitable-onprem-apply-package.ps1` (#4437's last PASS: `installDeps=0 runMigrations=0`) | operator | `apply exit=0` | minutes | 0 |
| 9 | Preflight — **three** manual surfaces: LAB-0 inventory (#4708), the six-field reply (#4695), `stock-preparation-s6a-operator-preflight.mjs` (14 offline checks), plus hand-run Part-A SQL from the 2026-08-02 readiness checklist | operator → owner | values-free blocks | hours–days | **2–4** |
| 10 | Smoke / acceptance — `stock-preparation-onprem-acceptance.ps1` (7 stages, one command) or `…-s6a-onprem-acceptance.ps1`; `stock-preparation-mvp-postdeploy-smoke.mjs` | operator | acceptance-summary .txt/.json | minutes | 0 |
| 11 | Flag window — owner publishes one exact S6-B comment (fresh `acceptanceOperationId` + expected `operationBindingDigest`); 9 runtime env vars; one run + replay; single-use | owner + operator | run receipt | hours | 1 |
| 12 | Restore — flag OFF, purge env, restart, capability disabled, token hygiene | operator | `flagOffRestored=PASS` | minutes | 0 |

**CI is not the bottleneck.** Total machine time is ~5 minutes. The path is
**8–12 human round-trips**, each one a values-free block a person writes and
another person adjudicates.

## b. The five sequential blockers (#4695 comment 5173506702, run 30861719019)

`PROVISIONING_FAILED → RUNTIME_NOT_CONSTRUCTED → SEALED_EXPORT_BINDING_UNQUALIFIED → (drift-pin hardening) → activation 42501 → PASS`

| # | Blocker | Class | Pre-deploy CI gate would have caught it? |
|---|---|---|---|
| 1 | missing migration **074** at provisioning | privilege (DB) | **Yes** — role-bound migration leg (§d) |
| 2 | `RUNTIME_NOT_CONSTRUCTED` | env / config | Partly — a config-loader positive control; the operator preflight covers the artifact half |
| 3 | `SEALED_EXPORT_BINDING_UNQUALIFIED` — frozen `:167 ownedCanonical(raw)` vs current `:233 ownedCanonical(projectExternalSystem(raw))`; DB-written `Date` timestamps refused as `EXOTIC_OBJECT` | **production defect** | **Yes** — any real-DB round-trip through the ordinary external-system API |
| 4 | provenance drift-pin hardening (6 of 65 pins moved) | package / CI | **Yes** — pin-digest guards now exist |
| 5 | activation `42501` — missing migration **075** row lock | privilege (DB) | **Yes** — same leg as #1 |

Four of five were CI-catchable. The S6-A harness *did* find all five — but
**after** the freeze, so the cost was a mandatory re-freeze, not a red check.

## c. The PostgreSQL 17 question

**Already validated on 15/16/17.** `stock-prep-s6a-postgres17-validation.yml`
(frozen asset, SHA-gated) and `stock-prep-main-package-verify.yml`
(built-from-main) both run the package's own `migrate.js` against ephemeral
`postgres:15|16|17`, each leg re-confirming the live server major matches its
matrix cell; `sealed-export-s6a-authority-row-lock.yml` and
`…-grant-repair.yml` run the real-DB 073/074/075 tests on **16 and 17**. The
matrix add is done — the readiness checklist's Part G item 2 ("no `postgres:17`
exists anywhere in the repository", 2026-08-02) is **stale**.

**What is still unvalidated on every version.** Neither PG-matrix workflow sets
`PGOPTIONS` / `metasheet.sealed_export_runtime_role` /
`…_provisioning_role` (grep: zero hits). So in the matrix, 073/074/075 take
their documented latent-NOTICE branch: the role-safety predicate and the actual
GRANTs are proven only by the vitest lane, which creates both roles **as the
superuser `postgres`**.

**The one version-sensitive surface in 068–073.** `GENERATED ALWAYS AS (…)
STORED` is PG12+ and uniform across 15–17; `pg_has_role` /
`has_table_privilege` / `has_column_privilege` are stable. But `073:508-514`,
`074:123` and `075:166` require **zero `pg_auth_members` rows in either
direction**, and PostgreSQL 16 changed role creation so a non-superuser
`CREATEROLE` account is automatically granted membership in the roles it
creates (`createrole_self_grant`). On 16/17 a DBA creating the two roles that
way produces exactly the row 073 rejects as `sealed-export role has unsafe
authority` — a message that does not say which branch failed.
`createrole_self_grant` appears nowhere in the repo. Needs verification on a
real PG17, but it is invisible to today's superuser-only coverage.

## d. Proposal — one workflow, one script

**`stock-prep-freeze-and-verify.yml` (dispatchable).** Composes, unchanged, the
four jobs of `stock-prep-main-package-verify.yml` (`exclusion-list-drift-guard`,
`build-main-package`, `verify-built-package`, `migrate-postgres [15,16,17]`),
plus three additions:

1. run `multitable-onprem-package-no-node-modules.test.mjs` inside
   `verify-built-package` — *wiring only*;
2. **new** role-bound migration leg: create the two roles in the ephemeral PG
   (once as superuser, once as a non-superuser CREATEROLE account), export
   `PGOPTIONS`, migrate, assert the runbook's three `has_*_privilege`
   predicates — closes the latent-grant hole and §c's PG16+ hazard;
3. **new** `freeze` job (`contents: write`, gated on a `publish_draft_release`
   input): emits `frozenManifestDigest` from the **downloaded artifact** (the
   comparison step already exists at
   `stock-prep-s6a-postgres17-validation.yml:105-116` — here it *produces*),
   creates a **draft** release with archives/checksums/verify reports, and
   writes the paste-ready five-field freeze block to `$GITHUB_STEP_SUMMARY`.

**`stock-preparation-lab0-inventory.mjs` (drafted here).** Emits #4695's six
fields plus the LAB-0 environment facts from read-only probes: node/pwsh
majors, TCP reachability, one catalog `SELECT` for `server_version_num` +
`rolcreatedb|rolsuper` + `rolcreaterole|rolsuper`, an unauthenticated health
GET, disk/memory classes, and (closing a Windows runtime-parity class-2 risk
in `fs.link()`-based S6-A staging) `artifactRootFilesystem`/
`artifactRootHardlinkSupported` — a read-only `Get-Volume` probe of the
configured artifact root's volume format, path never printed. No install,
download, DB or principal creation, deploy, flag change, business-row read,
or write beyond stdout — pinned by `stock-preparation-lab0-inventory.test.mjs`
(28 cases, two of them discriminating negative controls). Next: one
`preflight-and-report.ps1`
composing this + `stock-preparation-s6a-operator-preflight.mjs` + a reader for
the runbook §2 privilege triple — one command, one paste, replacing step 9.

## e. Top 5 accelerations

| Rank | Change | Saves | Effort | Risk |
|---|---|---|---|---|
| 1 | One `freeze-and-verify` dispatch producing a draft release **and** the five-field block | 3 round-trips + hand-transcribing 5 digests | M | L — write scope is one draft release |
| 2 | Host-side `preflight-and-report` (inventory + preflight + privilege triple) | 2–4 round-trips; kills the `UNKNOWN` class | S–M | L — read-only, contract-pinned |
| 3 | Role-bound migration leg on the 15/16/17 matrix | pre-empts blockers 1 and 5 | M | M — goes red first; CREATEROLE leg may expose the PG16+ hazard |
| 4 | Windows-host pull by `packageWorkflowRun`/`verifiedArtifactId` + SHA-256 gate, then the existing launcher | collapses steps 7–8 to one command | M | M — needs a host credential; keep pull-only |
| 5 | Fold the no-node-modules test + provenance digest into the build run | removes a manual `node -e` and a cross-workflow dependency | S | L |
