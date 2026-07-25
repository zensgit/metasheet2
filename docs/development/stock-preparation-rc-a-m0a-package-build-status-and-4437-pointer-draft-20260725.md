# Stock-prep RC-A — M0-A package build status + #4437 pointer revision draft (2026-07-25)

Lane: **LANE C — M0-A** (per `docs/development/database-system-integration-line-design-and-verification-20260724.md`,
§2 M0-A / §4 "Parallel and unblocked" M0-A track, ⟲C1/⟲R1/⟲R7). Authorized: build + verify the COMPLETE
on-prem deployment package at the owner-chosen main SHA, regenerate manifest/SHA256/provenance/loopback
verification, prepare (not post) the #4437 pointer revision. Not authorized: deployment, flag-ON, connecting
to any host, editing #4437 itself, merging, pushing to main.

**Scope note:** the ledger's §2 M0-A paragraph also names "prepare the bounded approved config" as part of
M0-A. This document's Lane-C task list (the four numbered "Your job" items given to this run) does not include
that item, and it is **not** addressed here — do not read this document as a complete M0-A closeout.

## Status: BLOCKED on the build itself. Investigation, blob-identity proof, and the pointer draft are DONE.

No package was built. No release was published. No fabricated checksum was produced. §3 below gives the
exact blocker and what a human needs to run.

---

## 1. Tooling identification

**There is no stock-prep-specific on-prem package build.** Stock-prep ships as a plugin (`plugin-integration-core`)
inside the multitable on-prem platform bundle, so "the complete on-prem deployment package" for RC-A is the
**Multitable On-Prem Package Build** workflow:
`.github/workflows/multitable-onprem-package-build.yml` → `scripts/ops/multitable-onprem-package-build.sh`
(packaging) → `scripts/ops/multitable-onprem-package-verify.sh` (loopback/structural verification).

Evidence this — not `scripts/ops/build-stock-preparation-rca-window-sidecar.mjs` — is the real RC-A package
builder:

- `gh release view stock-prep-onprem-rc-a-20260717-d87e086fd --repo zensgit/metasheet2` lists assets named
  `metasheet-multitable-onprem-v2.5.0-rc-a-20260717-d87e086fd.*` (`.tgz`, `.zip`, `.json`, bootstrap `.ps1`/`.bat`,
  `SHA256SUMS`, `*.verify.json`/`.md`) — the exact output shape the multitable workflow produces.
- `gh run list --repo zensgit/metasheet2 --workflow=multitable-onprem-package-build.yml` shows a `success` run
  at `headSha=d87e086fd1218b4cfb150177d43f2c52904b1d6d`, created `2026-07-17T06:16:54Z`, matching the release's
  `generatedAt`/`gitSha` exactly.
- The package's own metadata (`metasheet-multitable-onprem-v2.5.0-rc-a-20260717-d87e086fd.json`, downloaded
  read-only for this investigation): `"includedPlugins": ["plugin-attendance", "plugin-integration-core"]`,
  `"productMode": "platform"` — the platform+plugin bundle, confirming ⟲R7's claim directly: the sidecar ZIP
  (`build-stock-preparation-rca-window-sidecar.mjs`'s output) is a separate, smaller artifact (smoke helpers +
  PowerShell wrapper + PM2 sample + provenance only — no `bridge-agent-readonly-adapter.cjs`) and is **not**
  what #4437 references as "the package."

## 2. Verified facts (mechanical, no fabrication)

### 2.1 `d87e086fd` predates `7bf2bd7a1`, both reachable from current `origin/main`
```
git rev-parse stock-prep-onprem-rc-a-20260717-d87e086fd   # d87e086fd1218b4cfb150177d43f2c52904b1d6d
git merge-base --is-ancestor 7bf2bd7a1 stock-prep-onprem-rc-a-20260717-d87e086fd   # NOT an ancestor
git merge-base --is-ancestor stock-prep-onprem-rc-a-20260717-d87e086fd 7bf2bd7a1   # IS an ancestor
git merge-base --is-ancestor 7bf2bd7a1 origin/main                                  # IS an ancestor
git rev-list --count 7bf2bd7a1..origin/main                                         # 11
```
Confirms the ledger's framing: `d87e086fd` (frozen RC-A) < `7bf2bd7a1` (`bridge.bounded_read.v2`, #4573) <
current `origin/main` (`402f04982`).

### 2.2 The recommended build SHA `7bf2bd7a1` keeps the change surface small — verified, not assumed
```
git log --oneline 7bf2bd7a1..origin/main
```
gives the 11 commits between the recommended SHA and current main tip: `#4590` (this ledger doc, doc-only),
three attendance W4/W5 commits (`#4595/#4592/#4588/#4585/#4586/#4584/#4576`), two directory-deprovision
commits (`#4577/#4575`), and **`#4583`** — `fix(data-source): enforce the A5 row bound in MySQLAdapter + pin
the SQL-adapter roster` — a **runtime data-source change**. Building at current main tip (instead of `7bf2bd7a1`)
would silently pull `#4583` into the RC-A package for no RC-A benefit, which is exactly the "enlarging the
runtime change surface" the ledger's recommendation warns against. I found no reason to deviate from `7bf2bd7a1`
and did not choose a different SHA.

Also verified: the build tooling itself is byte-identical between the recommended SHA and current main —
```
git log --oneline 7bf2bd7a1..origin/main -- .github/workflows/multitable-onprem-package-build.yml \
  scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
```
returns nothing, so "build at `7bf2bd7a1`" and "build at current main" would use the identical build/verify
scripts — only the source snapshot differs.

### 2.3 `clientHelperSha` — identified and proven blob-identical (this is the reusable half of the two-SHA split)

`scripts/ops/stock-preparation-rca-abort-provenance.mjs` (the RC-A abort-provenance diagnostic) already names
and pins exactly **two** files as "the two RC-A smoke harnesses":

```js
export const HELPER_BASENAME_ALLOWLIST = Object.freeze([
  'stock-preparation-prep-line-extended-smoke.mjs',
  'stock-preparation-mvp-postdeploy-smoke.mjs',
])
export const HELPER_CONTENT_SHA256 = Object.freeze({
  'stock-preparation-prep-line-extended-smoke.mjs': '912f3ef75c4487dbdd946486d4cb7374f1c3ea1eb126c3b68381ad11963f0049',
  'stock-preparation-mvp-postdeploy-smoke.mjs': 'e5265a2a8052ddc34866438a1ee3356b5d2aa1a106c8199f5e2fbbe4f2614df4',
})
```

Verified independently — git blob identity across all three points in history, plus the content SHA-256 of the
blob at the recommended build SHA:

| file | blob @ `d87e086fd` | blob @ `7bf2bd7a1` | blob @ `origin/main` | content SHA-256 @ `7bf2bd7a1` |
|---|---|---|---|---|
| `stock-preparation-mvp-postdeploy-smoke.mjs` | `30b2653f1...` | `30b2653f1...` (identical) | `30b2653f1...` (identical) | `e5265a2a8052ddc34866438a1ee3356b5d2aa1a106c8199f5e2fbbe4f2614df4` (matches pin) |
| `stock-preparation-prep-line-extended-smoke.mjs` | `8a7998f29...` | `8a7998f29...` (identical) | `8a7998f29...` (identical) | `912f3ef75c4487dbdd946486d4cb7374f1c3ea1eb126c3b68381ad11963f0049` (matches pin) |

(`stock-preparation-rca-window-pm2-sample.mjs`, the PM2 sample, did not exist yet at `d87e086fd` —
`git rev-parse d87e086fd:scripts/ops/stock-preparation-rca-window-pm2-sample.mjs` errors "exists on disk, but
not in 'd87e086fd'" — confirming it is not part of the carried-over pair.)

This directly confirms the ledger's ⟲R7 claim ("the two smoke helpers are blob-identical between `d87e086fd`
and `7bf2bd7a1`, so the helper content hash may carry over") and gives the exact `clientHelperSha` values for
§4's draft below — no rebuild needed for the client half.

### 2.4 Provenance/checksum mechanics a real build must satisfy (read from code, not assumed)

- `BUILD_PROVENANCE.json` ships **inside** the archive at the package root, schema
  `metasheet-onprem-build-provenance/v1`, and `multitable-onprem-package-verify.sh` (L297-L306) requires its
  `gitCommit` field to be a real 40-hex SHA (never "unknown", never short).
- `scripts/ops/stock-preparation-onprem-acceptance.ps1`'s `-ExpectedGitSha` lock (L146-L318) explicitly binds
  to **that in-archive field**, not the external sidecar `.json`'s `gitSha` — "an old archive cannot be
  laundered by a fresh sidecar" (comment at L305-306). `serviceRuntimeSha` in §4 below must anchor to this
  in-archive field once the build exists, not to a hand-typed value.
- Confirmed by downloading (read-only) the three small metadata assets from the existing 07-17 release:
  - `metasheet-multitable-onprem-v2.5.0-rc-a-20260717-d87e086fd.json` — external sidecar; carries `gitSha`
    (workflow-appended, informational only, not the trust anchor).
  - `metasheet-multitable-onprem-v2.5.0-rc-a-20260717-d87e086fd.tgz.verify.json` — `"ok": true`, checks:
    `checksum` PASS, `required-content` PASS (`requiredCount: 128`), `deployability-contract` PASS, `no-github-links`
    PASS — this is what `multitable-onprem-package-verify.sh` actually runs: a local/offline structural
    verification of the produced archive (checksum + required-file inventory + deployability-contract shape +
    no leaked GitHub URLs). **Mapping this to the ledger's phrase "loopback verification" is my inference, not
    a confirmed match** — I searched `multitable-onprem-package-verify.sh` for a `loopback`-named check (the
    kind attendance's `attendance-onprem-package-verify.sh` has, which fails if the built frontend bundle
    embeds a loopback `VITE_API_URL`) and found none; multitable's verify script has no such check. If the
    ledger's "loopback verification" instead means a live loopback HTTP probe against a running instance (the
    pattern `stock-preparation-rca-c-window-runner-development-verification-20260722.md` uses), that is a
    runtime/host action and belongs to M0-B's "flag-OFF health verification," not to this build-only step —
    it was not run here either way.
  - `SHA256SUMS` — four checksummed files: `.tgz`, `.zip`, both first-hop bootstrap scripts.

## 3. Blocker — exact, plain

The package build itself **cannot be executed under this lane's authority in this environment.** The primary
reason is (b); (a) is corroborating and independently verified.

**(b) — PRIMARY: reaching `7bf2bd7a1` for a real build requires an action this lane is not authorized to take,
and the verified precedent confirms there is no lighter-weight path left.** Checked the actual mechanics of
how the frozen `d87e086fd` package was produced, rather than assuming:
```
gh run view 29559593867 --repo zensgit/metasheet2 --json headBranch,event,workflowName,headSha
# {"event":"workflow_dispatch","headBranch":"main","headSha":"d87e086fd1218b...","workflowName":"Multitable On-Prem Package Build"}
git log -1 --format="%H %cI" d87e086fd
# d87e086fd1218b... 2026-07-17T05:52:47Z   (run dispatched 2026-07-17T06:16:54Z, same-day)
git cat-file -t stock-prep-onprem-rc-a-20260717-d87e086fd
# commit   (lightweight — consistent with gh release create minting it, not a hand-annotated freeze tag)
```
The precedent process was: dispatch `multitable-onprem-package-build.yml` with `ref=main` **at the moment
`main`'s tip was the desired commit**, with `expected_sha` pinned to that same commit as a fail-closed check;
`gh release create` then mints the release tag from that exact state. **That window has passed for `7bf2bd7a1`**
— `origin/main` has since advanced 11 commits past it (§2.1/§2.2), so `ref=main` today would build the wrong
commit and `expected_sha` would correctly refuse it. Reaching `7bf2bd7a1` now requires either minting a new
ref at that exact historical commit (§3 Option A — a **new pattern**, not the precedent process, since the
precedent never needed a standalone tag) or checking it out directly on a matching local toolchain (§3 Option
B). Both are the owner's freeze act in substance — ⟲R1 exit (b) is explicit: "the owner formally revises
#4437 — publish, checksum, and **FREEZE** a new RC-A exact-SHA." This lane's authorization is "build and
verify… prepare the #4437 pointer," not deploy, not flag-ON, and — per the lane's own doubt-is-the-answer
discipline — not silently performing the adjacent owner-gated freeze step either. I did not create a ref at
`7bf2bd7a1` and did not dispatch the workflow.

**(a) — corroborating, not independently verified this session.** `git tag --points-at 7bf2bd7a1` and
`git branch -r --points-at 7bf2bd7a1` both return empty, so no ref currently exists at that SHA. I understand
GitHub's `workflow_dispatch` API to require a branch-or-tag `ref` rather than accepting a bare commit SHA,
which would make this a second, independent blocker on top of (b) — but I have not verified that constraint
against GitHub's API/docs this session, so it should be read as understood-but-unconfirmed, not as an asserted
fact. (b) alone is sufficient to block the build regardless of whether (a) also holds.

**A local build in this sandbox is also disqualified**, independent of (a)/(b): the workflow pins Node 20 +
pnpm exactly `9.15.9` on `ubuntu-latest` (the build script's own `PACKAGE_PNPM_VERSION="9.15.9"`, with an
explicit comment that release lockfile compatibility depends on that exact pin). This environment runs
Node `v25.9.0` / pnpm `10.33.0` on darwin. A package built here would not be the artifact the CI pipeline
would produce, and hand-computing/publishing its SHA256 as "the RC-A checksum" would repeat the exact
fabricated/self-certified-provenance failure mode this line exists to close (the frozen `d87e086fd` package's
own defect is a **locally fabricated** `metadata.limit` rather than an echo-verified one — #4573's whole point;
see also the `-ExpectedGitSha` in-archive-only binding in §2.4, which exists specifically to distrust
externally-asserted provenance). I did not attempt a local build.

**What a human needs to run** (either option; both are outside this lane's authority):

- **Option A — CI, a NEW scaffold pattern (not the precedent process; see §3(b)).** The precedent (dispatch at
  `ref=main` the moment main's tip is the desired commit) is unavailable now that main has advanced past
  `7bf2bd7a1`. A human/owner with tag-push rights would instead create a tag at exactly
  `7bf2bd7a1f8cdf54cca83a733fcd89afb076848b` (e.g. `stock-prep-onprem-rc-a-build-7bf2bd7a1`), then:
  ```
  gh workflow run multitable-onprem-package-build.yml --repo zensgit/metasheet2 \
    --ref stock-prep-onprem-rc-a-build-7bf2bd7a1 \
    -f expected_sha=7bf2bd7a1f8cdf54cca83a733fcd89afb076848b \
    -f publish_release=true \
    -f release_tag=stock-prep-onprem-rc-a-20260725-7bf2bd7a1 \
    -f release_name="Stock-prep on-prem RC-A (7bf2bd7a1)"
  ```
  This reuses the exact tooling that produced the frozen `d87e086fd` package and self-verifies inside the run
  (`expected_sha` gate + `multitable-onprem-package-verify.sh` + the post-build `pnpm install --frozen-lockfile`
  dependency preflight).
- **Option B — local, matching toolchain.** On a host that can pin Node 20 + pnpm `9.15.9` (matching
  `PACKAGE_PNPM_VERSION`) — e.g. via `corepack`/`nvm` on an ubuntu-like machine — checkout `7bf2bd7a1`, run
  `pnpm install --frozen-lockfile`, `pnpm --filter @metasheet/web build`, `pnpm --filter @metasheet/core-backend build`,
  then `INSTALL_DEPS=0 BUILD_WEB=0 BUILD_BACKEND=0 scripts/ops/multitable-onprem-package-build.sh` followed by
  `scripts/ops/multitable-onprem-package-verify.sh` on both the `.tgz` and `.zip` outputs.

Either way, once the archive exists, `serviceRuntimeSha` = the in-archive `BUILD_PROVENANCE.json.gitCommit`
(expected `7bf2bd7a1f8cdf54cca83a733fcd89afb076848b`), and the manifest / `SHA256SUMS` / `*.verify.json` /
`*.verify.md` are generated as a byproduct of the build — none of them should be hand-typed.

---

## 4. Draft — #4437 execution pointer v3 (NOT POSTED)

Everything below is a draft only. It is not posted to #4437. Fields the build in §3 has not yet produced are
marked `<<PENDING BUILD>>` — do not fill them by guessing; they come from the archive's own
`BUILD_PROVENANCE.json` and `SHA256SUMS` once §3's build runs.

> **Execution pointer v3 (DATE-OF-ACTUAL-BUILD — draft). Supersedes execution pointer v2.**
> Records the package's `serviceRuntimeSha` and `clientHelperSha` **separately** (per
> `docs/development/database-system-integration-line-design-and-verification-20260724.md` §2 ⟲R7) — v2's
> single "Exact source SHA" field conflated the deployed server runtime with the two client smoke helpers used
> by the abort-provenance diagnostic. As with v2: RC-A must use a local detached checkout at the exact package
> SHA; do **not** use the public `workflow_dispatch` inputs for the entity host, tenant, or approved config
> reference. The service flag must be restored and verified OFF in a `finally` path even when the smoke fails.
>
> ### Package (two-SHA, exact)
> - **`serviceRuntimeSha`** (the backend/plugin runtime deployed to the entity machine) — read from the
>   package's in-archive `BUILD_PROVENANCE.json.gitCommit` (never the external sidecar `.json`'s `gitSha` —
>   that field cannot be trusted alone; see `stock-preparation-onprem-acceptance.ps1`'s `-ExpectedGitSha`
>   comment). Build commit: `7bf2bd7a1f8cdf54cca83a733fcd89afb076848b` (`bridge.bounded_read.v2`, PR #4573 —
>   closes the pre-hardening fabricated-`metadata.limit` gap the frozen `d87e086fd` package carries; P1a
>   applied-limit echo-verification, P1b `.v2` qualification lineage). `<<PENDING BUILD: release tag, `.tgz`/`.zip`
>   SHA256 from `SHA256SUMS`, in-archive `BUILD_PROVENANCE.json.gitCommit` read-back confirming
>   `7bf2bd7a1f8cdf54cca83a733fcd89afb076848b`>>`
> - **`clientHelperSha`** (the two exact-SHA smoke harnesses the abort-provenance diagnostic and the sidecar
>   wrapper import) — **unchanged, carried over from the frozen `d87e086fd` package**, independently verified
>   blob-identical at `d87e086fd`, `7bf2bd7a1`, and current `main`:
>   - `stock-preparation-mvp-postdeploy-smoke.mjs` → `e5265a2a8052ddc34866438a1ee3356b5d2aa1a106c8199f5e2fbbe4f2614df4`
>   - `stock-preparation-prep-line-extended-smoke.mjs` → `912f3ef75c4487dbdd946486d4cb7374f1c3ea1eb126c3b68381ad11963f0049`
>   These already match `HELPER_CONTENT_SHA256` in `scripts/ops/stock-preparation-rca-abort-provenance.mjs` —
>   **no code change is required for the client half of this revision.**
> - **Release / tag**: `<<PENDING BUILD — e.g. stock-prep-onprem-rc-a-20260725-7bf2bd7a1>>`, built via the
>   **Multitable On-Prem Package Build** workflow (`.github/workflows/multitable-onprem-package-build.yml`) —
>   stock-prep ships as a plugin inside the multitable on-prem platform bundle; there is no stock-prep-specific
>   package build. `expected_sha=7bf2bd7a1f8cdf54cca83a733fcd89afb076848b` must be set at dispatch time so the
>   build fails closed on an uncertain checkout; in-archive `BUILD_PROVENANCE.gitCommit` must equal the same
>   value (40-hex, read back from the checksummed bytes); `.tgz`/`.zip` checksums must verify against
>   `SHA256SUMS`.
>
> ### What did NOT change from the frozen `d87e086fd` package
> - Both RC-A smoke helper client scripts (content-identical; `clientHelperSha` above).
> - The PowerShell wrapper's `-ExpectedGitSha` lock mechanism and the abort-provenance diagnostic's
>   `HELPER_CONTENT_SHA256` allowlist — no code change needed for the client half.
> - **The client worktree checkout SHA in Operator step 2 stays `d87e086fd1218b4cfb150177d43f2c52904b1d6d`,
>   unchanged.** Deliberate, not a default: since the two smoke helpers are content-identical at `d87e086fd`
>   and `7bf2bd7a1` (§2.3), moving the client checkout would yield the same bytes for no benefit, while
>   *keeping* it avoids re-cutting the `stock-preparation-rca-window-sidecar` (its `FROZEN_RUNTIME_SHA` /
>   `FROZEN_HELPERS` in `scripts/ops/build-stock-preparation-rca-window-sidecar.mjs` are already pinned to
>   `d87e086fd`) and avoids re-running the "sidecar v2" no-Git-equivalence verification recorded in the v2
>   erratum. This is a recommendation for the human finalizing the pointer to confirm, not something this
>   document can ratify.
>
> ### What changed
> - The service runtime moves from `d87e086fd` (pre-`bridge.bounded_read.v2`; `metadata.limit` **locally
>   fabricated**, not echo-verified) to `serviceRuntimeSha` above (post-`7bf2bd7a1`; `metadata.limit`
>   echo-verified against the agent's own response per #4573 P1a; qualification digest keys on
>   `actionProfileVersion=.v2` per P1b, so an authenticated old-v1 qualification recomputes to
>   `QUALIFICATION_DIGEST_MISMATCH` instead of silently surviving).
> - v2's single "Exact source SHA" field, which governed both the deployed runtime and the smoke client, is
>   replaced by the two named fields above so a future runtime bump cannot silently be read as implying the
>   client also changed (or vice versa).
>
> ### Operator steps — per-occurrence mapping (this is the actual de-conflation; do not paraphrase it away)
> v2's body uses "the exact source SHA" / "`d87e086fd1218b4cfb150177d43f2c52904b1d6d`" at five distinct spots
> that this revision's two-SHA split must not leave ambiguous:
>
> | v2 occurrence | governed by in v3 | value |
> |---|---|---|
> | "Exact source SHA" heading + in-archive `BUILD_PROVENANCE.gitCommit` validation | `serviceRuntimeSha` | `7bf2bd7a1f8cdf54cca83a733fcd89afb076848b` (`<<PENDING BUILD>>` for read-back confirmation) |
> | Step 1 "Deploy the RC-A exact-SHA package to the isolated entity machine" | `serviceRuntimeSha` | same |
> | Step 2 "detached local worktree at exact SHA `d87e086fd…`" + `git rev-parse HEAD` check | client checkout SHA (its own field, **not** renamed to either of the two above) | **stays** `d87e086fd1218b4cfb150177d43f2c52904b1d6d` — see "What did NOT change" |
> | Step 2 v3.1 erratum "two exact-`d87e086fd` helpers" from sidecar v2 (no-Git path) | `clientHelperSha` | the two content hashes in "Package" above — already SHA-independent verification (byte comparison), so this path needs no wording change beyond noting the values now also equal the `7bf2bd7a1` bytes |
> | PASS criterion `clientSourceShaMatch=PASS` / `clientContentVerified=PASS` | `clientHelperSha` (and the unchanged client checkout SHA for the Git path) | unchanged mechanism; unchanged expected values |
>
> Everything else in Operator steps 1-5, the PASS criteria list, and the Prohibitions section of v2 is
> unchanged in substance — only the SHA references in the table above move.

---

## 5. What this document is and is not

- It is: an investigation record + a draft the operator/owner can lift into #4437 once §3's build exists, plus
  the mechanically-verified `clientHelperSha` half that needs no rebuild.
- It is not: a built package, a published release, a real `serviceRuntimeSha`, or an edit to #4437 itself.
  Nothing here was posted to the issue.
