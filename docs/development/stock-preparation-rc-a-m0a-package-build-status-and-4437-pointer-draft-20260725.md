# Stock-prep RC-A — M0-A package build status + #4437 pointer revision draft (2026-07-25)

Lane: **LANE C — M0-A** (per `docs/development/database-system-integration-line-design-and-verification-20260724.md`,
§2 M0-A / §4 "Parallel and unblocked" M0-A track, ⟲C1/⟲R1/⟲R7). Authorized: build + verify the COMPLETE
on-prem deployment package at the owner-chosen main SHA, regenerate manifest/SHA256/provenance/(disputed —
see §6) loopback verification, prepare (not post) the #4437 pointer revision. Not authorized: deployment,
flag-ON, connecting to any host, editing #4437 itself, merging, pushing to main, and — per this fix pass —
still not the release/freeze act (see §3 A2).

**Scope note:** the ledger's §2 M0-A paragraph also names "prepare the bounded approved config" as part of
M0-A. This document's Lane-C task list does not include that item, and it is **not** addressed here — do not
read this document as a complete M0-A closeout.

## FIX PASS (2026-07-25, same day): the prior "BLOCKED" verdict below was WRONG on its primary reason. Retracted in §3.

**What changed:** an adversarial reviewer proved that `.github/workflows/multitable-onprem-package-build.yml`
runs the build (`Build on-prem package`) and verify steps, and uploads the CI artifact, **unconditionally** —
only the `Publish GitHub Release` step (and one echo line in the step summary) are gated behind
`inputs.publish_release == 'true'`. The build+verify half this lane is authorized for was executable all
along; the original document's "(b) PRIMARY = freeze act blocks everything" reasoning conflated the *ref
prerequisite* (minting a ref at the desired commit, needed only because `workflow_dispatch` takes a
branch/tag, not a bare SHA) with the *publish/freeze act* (owner-only). This session independently confirmed
the reviewer's read against the current workflow file and then **ran the authorized build+verify half for
real** — see §3 A1 for the run and §2.4/§6 below for what the "no fabrication" claim now covers.

## Status: build + verify (A1) is DONE and PASSED. Residual blocker is narrow: only the owner's publish/freeze act (A2).

A real CI run built and verified the complete on-prem package at the exact recommended SHA, using the
project's own unmodified tooling, and self-verified with four structural checks (all PASS). No release was
published. No checksum was hand-typed or fabricated — the checksums recorded below are read verbatim from the
run's own `SHA256SUMS` output. §3 gives the retraction, the A1 record, and the narrow residual (A2, owner-only).

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
  at `headSha=d87e086fd1218b4cfb150177d43f2c52904b1d6d`, created `2026-07-17T06:16:54Z`. Its `gitSha` matches
  the release's exactly; `generatedAt` does **not** match exactly (corrected in §2.4 — it falls inside the
  run's time window, which is the actual mechanic, not an exact-timestamp match).
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
gave the 11 commits between the recommended SHA and main tip at original draft time (main tip then =
`402f04982`): `#4590` (this ledger doc, doc-only), **seven** attendance W4/W5 commits
(`#4595/#4592/#4588/#4585/#4586/#4584/#4576` — the original draft undercounted this as "three" while
listing all seven PR numbers; corrected here), two directory-deprovision commits (`#4577/#4575`), and
**`#4583`** — `fix(data-source): enforce the A5 row bound in MySQLAdapter + pin the SQL-adapter roster` — a
**runtime data-source change**. Building at current main tip (instead of `7bf2bd7a1`) would silently pull
`#4583` into the RC-A package for no RC-A benefit, which is exactly the "enlarging the runtime change surface"
the ledger's recommendation warns against. I found no reason to deviate from `7bf2bd7a1` and did not choose a
different SHA.

**Drift note (fix pass, re-run same day):** `origin/main` has since advanced one more commit — tip is now
`b5ff168e9` (`#4600`, doc-only, committed `2026-07-25T06:51:44Z`), so `git rev-list --count 7bf2bd7a1..origin/main`
now reads **12**, not 11. The count was accurate when first drafted; it is a moving target because main keeps
advancing. The choose-`7bf2bd7a1`-over-main-tip argument is unaffected by this drift (if anything strengthened
— one more non-RC-A commit would be pulled in by building at tip instead).

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
    no leaked GitHub URLs). **There is no `loopback`-named check in this script — confirmed by grep, zero
    hits.** This is now escalated as a specification gap against the RATIFIED ledger rather than silently
    inferred; see §6. It is not resolved here and this document does not rule on it.
  - `SHA256SUMS` — four checksummed files: `.tgz`, `.zip`, both first-hop bootstrap scripts.
  - **Corrected timestamp mechanic (fix pass):** the 07-17 sidecar's `generatedAt` (`2026-07-17T06:18:40Z`,
    downloaded read-only: `gh release download stock-prep-onprem-rc-a-20260717-d87e086fd --pattern "*.json"`)
    is **not** an exact match to the triggering run's `createdAt` (`2026-07-17T06:16:54Z`, from
    `gh run view 29559593867 --json headSha,createdAt,updatedAt`) — it falls **inside** that run's window
    (`createdAt` 06:16:54Z → `updatedAt` 06:18:59Z), ~1m46s after start, consistent with build duration. Only
    `gitSha` (`d87e086fd1218b4cfb150177d43f2c52904b1d6d`) matches exactly. This session's own A1 run (§3)
    independently reproduces the identical mechanic: manifest `generatedAt` `2026-07-25T07:04:41Z` falls
    inside run 30148584851's window (`createdAt` 07:02:23Z → `updatedAt` 07:04:56Z), and its `gitSha` matches
    the dispatch input exactly. Two independent instances of "manifest timestamp lands inside the run window,
    gitSha matches exactly" is the actual, stronger claim — not the false "matches exactly" the original draft
    made for `generatedAt`.

## 3. RETRACTION, then A1 record, then the narrow residual (A2)

### 3.0 Retraction — what this section previously claimed, and why it was wrong

The original draft said, verbatim: *"(b) — PRIMARY: reaching `7bf2bd7a1` for a real build requires an action
this lane is not authorized to take... Both [Option A and Option B] are the owner's freeze act in substance."*
That framing is **withdrawn**. It conflated two different things:

1. minting a **ref** at the exact historical commit `7bf2bd7a1` (needed only because GitHub's
   `workflow_dispatch` takes a branch/tag `ref`, not a bare SHA — a mechanical prerequisite, not a decision
   about product state), with
2. the **freeze act** — publishing a GitHub Release that makes a specific build the addressable, checksummed,
   permanent RC-A artifact #4437 points at.

The mechanical refutation, read directly from the current workflow file
(`.github/workflows/multitable-onprem-package-build.yml`): the `if:` gate
`${{ inputs.publish_release == 'true' }}` appears **once**, on the `Publish GitHub Release` step (currently
line 135), plus one conditional echo inside `Step summary` (line 201) that only prints the release tag when
`publish_release=true`. `Build on-prem package` (line 81, includes the verify calls) and
`Upload package artifacts` (line 173) carry **no** `if:` — they run unconditionally. This session's own run
(§3.1 below) confirms it empirically, not just by reading the YAML: the job step list shows every build/verify/
upload step `✓` and `Publish GitHub Release` skipped (`-`), exactly as the ungated/gated split predicts.

**(a) was not refuted — it was satisfied, not by this session.** The old draft was right that no ref existed
at `7bf2bd7a1` at the time it checked (`git tag --points-at` / `git branch -r --points-at` both empty). By the
time this fix pass started, a branch ref did exist:
```
git ls-remote origin refs/heads/build/m0a-rca-7bf2bd7a1
# 7bf2bd7a1f8cdf54cca83a733fcd89afb076848b   refs/heads/build/m0a-rca-7bf2bd7a1
```
— confirming (a)'s prerequisite (a ref must exist for `workflow_dispatch` to reach that commit) and confirming
it was satisfied by construction. This session did not create that ref and cannot attest who did; the ruling
that ref creation is a build prerequisite rather than the freeze act itself comes from this fix pass's
direction, not from a finding made here.

**Corrected boundary:** M0-A's authorized build+verify half required only a ref to exist at the target
commit — already true — not the freeze act. The freeze act (owner-only, §3.2/A2) is a separate, later,
narrower thing: publishing the Release that makes one specific build the permanent, addressable RC-A artifact.

### 3.1 A1 — build + verify, `publish_release=false` (Lane C authority; ALREADY RUN)

Dispatched (by the fix-pass direction, prior to this session) and watched to completion by this session:
```
gh run view 30148584851 --json status,conclusion,headSha,headBranch,createdAt,updatedAt,workflowName
# {"conclusion":"success","createdAt":"2026-07-25T07:02:23Z","headBranch":"build/m0a-rca-7bf2bd7a1",
#  "headSha":"7bf2bd7a1f8cdf54cca83a733fcd89afb076848b","status":"completed",
#  "updatedAt":"2026-07-25T07:04:56Z","workflowName":"Multitable On-Prem Package Build"}
```
`headSha` matches `expected_sha=7bf2bd7a1f8cdf54cca83a733fcd89afb076848b` exactly. Job steps
(`gh run view 30148584851 --job=89654954864`):
```
✓ Set up job          ✓ Build web/backend dist         ✓ Upload package artifacts
✓ Checkout             ✓ Build on-prem package          ✓ Step summary
✓ Verify expected SHA  ✓ Bind build SHA into metadata    (+ Post-* / Complete job, all ✓)
✓ Setup pnpm/Node.js   - Publish GitHub Release   ← skipped, confirms publish_release=false
✓ Install deps
```
Downloaded the real artifact read-only (`gh run download 30148584851`) — not hand-typed:

- **`SHA256SUMS`** (this A1 run's own output):
  ```
  759adcc3cbb6f677f2c6aea92224df83085d1afb1424c1759d980b98abd07f4d  metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz
  880e9f47b2f887cb752176fa2c6eb45cb04008fa285aae0265647544a16e92c4  metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.zip
  25197ba31dcc5638c63eb79e4928e4db6b0fcdc715aae799f7672d70119d0056  metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725-deploy-bootstrap.ps1
  75261b3f3b3a161e6c586d95ee4110a740454957c3c55cb0cd5e742839a176d5  metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725-deploy-bootstrap.bat
  ```
  **These four checksums are A1-run-scoped evidence that the build+verify half executed and self-verified —
  they are NOT the checksums the eventual A2 freeze run will produce.** `BUILD_PROVENANCE.json` (packaged
  *inside* the checksummed archive) embeds `builtAt` (`date -u` at build time) and `ciRunId`
  (`$GITHUB_RUN_ID`) — both per-run values baked into the archive bytes before hashing
  (`scripts/ops/multitable-onprem-package-build.sh` lines ~508-510). A fresh `publish_release=true` dispatch
  is a **new build**, with a new `ciRunId`/`builtAt`/archive bytes, therefore a **different** `.tgz`/`.zip`
  SHA256 than the four values above. Do not carry these into #4437 as "the" RC-A checksums (§4 keeps them
  `<<PENDING FREEZE RUN>>`).
- **In-archive `BUILD_PROVENANCE.json`** (extracted from the `.tgz`, not the external sidecar):
  ```json
  { "schema": "metasheet-onprem-build-provenance/v1", "gitCommit": "7bf2bd7a1f8cdf54cca83a733fcd89afb076848b",
    "gitCommitShort": "7bf2bd7a1f8c", "gitRef": "build/m0a-rca-7bf2bd7a1", "sourceIsOnOriginMain": "unknown",
    "ciRunId": "30148584851", "ciRunAttempt": "1", "builtAt": "2026-07-25T07:04:39Z" }
  ```
  `gitCommit` = `7bf2bd7a1f8cdf54cca83a733fcd89afb076848b` — **exact match to `expected_sha`, CONFIRMED from
  the checksummed bytes, not the external sidecar.** Unlike `builtAt`/`ciRunId`, `gitCommit` is derived from
  `git rev-parse HEAD` at the pinned commit and will be the same in A2 provided A2 also targets `7bf2bd7a1`.
- **Verify reports** (both archives, `ok: true`):
  ```json
  "checks": [
    {"name":"checksum","status":"PASS"},
    {"name":"required-content","status":"PASS","requiredCount":128},
    {"name":"deployability-contract","status":"PASS","artifactKind":"deployable-onprem-app-package",
     "deployMode":"fresh-extract-or-existing-root-apply","directReplaceSafe":false,"nodeModulesBundled":false},
    {"name":"no-github-links","status":"PASS"}
  ]
  ```
  Four checks, all PASS. No `loopback`-named check ran (see §6 — this is a ledger-vs-tooling spec gap, not an
  A1 defect).

**Two constraints the "done" framing must carry, or it misleads:**

- **The Actions artifact (`multitable-onprem-package-30148584851-1`) is not a release.** It is unfrozen,
  privately-scoped to this run, and has `retention-days: 14` set in the workflow — it expires around
  **2026-08-08** (14 days from `createdAt` 2026-07-25T07:02:23Z). "Build+verify done" does not mean "package
  available to deploy"; nothing here is a publicly-addressable checksummed asset until A2 runs.
- If the owner's A2 act slips past the retention window, A1 must be re-run (cheap — no code changed, same
  `expected_sha`, same ref) before A2, since A2's own build supersedes A1's bytes anyway.

### 3.2 A2 — publish/freeze, `publish_release=true` (OWNER-ONLY — NOT inside M0-A's authorization)

This is the one remaining blocked step, and it is a narrow one: an owner (or someone the owner delegates to)
re-dispatches the same workflow, on a ref at the same commit, with `publish_release=true`. This performs the
actual freeze — `gh release create`/`upload` inside the gated step — which is the ⟲R1 exit (b) act ("the
owner formally revises #4437 — publish, checksum, and **FREEZE** a new RC-A exact-SHA"), not a Lane-C action.
This document does not perform it, and does not choose the release tag on the owner's behalf:

```
gh workflow run multitable-onprem-package-build.yml --repo zensgit/metasheet2 \
  --ref <a ref at 7bf2bd7a1f8cdf54cca83a733fcd89afb076848b — e.g. build/m0a-rca-7bf2bd7a1, already exists> \
  -f expected_sha=7bf2bd7a1f8cdf54cca83a733fcd89afb076848b \
  -f publish_release=true \
  -f release_tag=<OWNER TO CHOOSE — not pre-selected by this document> \
  -f release_name=<optional>
```
Once A2 completes, §4's `<<PENDING FREEZE RUN>>` fields (release tag, `.tgz`/`.zip` SHA256) get filled from
that run's own `SHA256SUMS` and release assets — the same way A1's were, never hand-typed. `serviceRuntimeSha`
does not change (same commit, same in-archive `gitCommit`); only the archive bytes/checksums and the release
tag are new.

**A local build in this sandbox remains disqualified**, independent of A1/A2: the workflow pins Node 20 +
pnpm exactly `9.15.9` on `ubuntu-latest`. This environment runs Node `v25.9.0` / pnpm `10.33.0` on darwin — a
locally-built package would not be the artifact the CI pipeline produces, and publishing its hand-computed
SHA256 as "the RC-A checksum" would repeat the exact fabricated/self-certified-provenance failure mode this
line exists to close. Not attempted.

---

## 4. Draft — #4437 execution pointer v3 (NOT POSTED)

Everything below is a draft only. It is not posted to #4437. `gitCommit` is now CONFIRMED (§3.1, A1, stable
across rebuilds of the same commit). Fields that only A2's own freeze run can produce (release tag, `.tgz`/
`.zip` SHA256 — **not reusable from A1**, see §3.1) are marked `<<PENDING FREEZE RUN>>` — do not fill them by
guessing or by copying A1's run-scoped checksums; they must come from A2's own `SHA256SUMS` and release assets.

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
>   applied-limit echo-verification, P1b `.v2` qualification lineage). In-archive `BUILD_PROVENANCE.json.gitCommit`
>   read-back **CONFIRMED** (A1, run 30148584851) = `7bf2bd7a1f8cdf54cca83a733fcd89afb076848b`, exact match.
>   `<<PENDING FREEZE RUN (A2): release tag, `.tgz`/`.zip` SHA256 from A2's own `SHA256SUMS` — A1's checksums
>   are run-scoped and will NOT match A2's, see §3.1>>`
> - **`clientHelperSha`** (the two exact-SHA smoke harnesses the abort-provenance diagnostic and the sidecar
>   wrapper import) — **unchanged, carried over from the frozen `d87e086fd` package**, independently verified
>   blob-identical at `d87e086fd`, `7bf2bd7a1`, and current `main`:
>   - `stock-preparation-mvp-postdeploy-smoke.mjs` → `e5265a2a8052ddc34866438a1ee3356b5d2aa1a106c8199f5e2fbbe4f2614df4`
>   - `stock-preparation-prep-line-extended-smoke.mjs` → `912f3ef75c4487dbdd946486d4cb7374f1c3ea1eb126c3b68381ad11963f0049`
>   These already match `HELPER_CONTENT_SHA256` in `scripts/ops/stock-preparation-rca-abort-provenance.mjs` —
>   **no code change is required for the client half of this revision.**
> - **Release / tag**: `<<PENDING FREEZE RUN (A2) — owner selects the tag; not pre-chosen by this document>>`,
>   built via the **Multitable On-Prem Package Build** workflow
>   (`.github/workflows/multitable-onprem-package-build.yml`, `publish_release=true`) — stock-prep ships as a
>   plugin inside the multitable on-prem platform bundle; there is no stock-prep-specific package build.
>   `expected_sha=7bf2bd7a1f8cdf54cca83a733fcd89afb076848b` must be set at dispatch time so the build fails
>   closed on an uncertain checkout (as A1's did, successfully); in-archive `BUILD_PROVENANCE.gitCommit` must
>   equal the same value; `.tgz`/`.zip` checksums must verify against A2's own `SHA256SUMS` — A1's build+verify
>   already proves the pipeline mechanics work end-to-end at this exact commit (§3.1); A2 is a re-run of the
>   identical, already-proven mechanics with one flag flipped.
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
> | "Exact source SHA" heading + in-archive `BUILD_PROVENANCE.gitCommit` validation | `serviceRuntimeSha` | `7bf2bd7a1f8cdf54cca83a733fcd89afb076848b` (read-back **CONFIRMED** via A1, run 30148584851 — §3.1) |
> | Step 1 "Deploy the RC-A exact-SHA package to the isolated entity machine" | `serviceRuntimeSha` | same |
> | Step 2 "detached local worktree at exact SHA `d87e086fd…`" + `git rev-parse HEAD` check | client checkout SHA (its own field, **not** renamed to either of the two above) | **stays** `d87e086fd1218b4cfb150177d43f2c52904b1d6d` — see "What did NOT change" |
> | Step 2 v3.1 erratum "two exact-`d87e086fd` helpers" from sidecar v2 (no-Git path) | `clientHelperSha` | the two content hashes in "Package" above — already SHA-independent verification (byte comparison), so this path needs no wording change beyond noting the values now also equal the `7bf2bd7a1` bytes |
> | PASS criterion `clientSourceShaMatch=PASS` / `clientContentVerified=PASS` | `clientHelperSha` (and the unchanged client checkout SHA for the Git path) | unchanged mechanism; unchanged expected values |
>
> Everything else in Operator steps 1-5, the PASS criteria list, and the Prohibitions section of v2 is
> unchanged in substance — only the SHA references in the table above move.

---

## 5. What this document is and is not

- It is: an investigation record; a real, passing CI build+verify (A1, run 30148584851) at the exact
  recommended commit, watched to completion and checked against its own downloaded outputs (not hand-typed);
  a CONFIRMED `serviceRuntimeSha`/`gitCommit` read-back; the mechanically-verified `clientHelperSha` half
  (unchanged from the original investigation, no rebuild needed); a draft the operator/owner can lift into
  #4437 once A2 (§3.2) exists; and an escalation (§6) of a ledger-vs-tooling naming gap for the owner to rule
  on.
- It is not: a published release, a permanent/addressable checksummed artifact (A1's Actions artifact expires
  ~2026-08-08, §3.1), the owner's freeze act, or an edit to #4437 itself. Nothing here was posted to the
  issue. A1's `.tgz`/`.zip` SHA256 values are recorded as run-scoped evidence only and must not be read as
  "the" RC-A checksums — those come from A2.

## 6. Escalation to the owner — RATIFIED ledger names a check the verify tooling does not have

**This is a specification gap, not a bug this document can fix, and not something it rules on.**

The RATIFIED ledger (`docs/development/database-system-integration-line-design-and-verification-20260724.md`)
names "loopback verification" as part of M0-A's authorized/expected output in two places:

- §4, the M0-A bullet itself: *"regenerate manifest / SHA256 / provenance / **loopback verification**, revise
  the #4437 pointer..."*
- §2 ⟲R7: *"regenerate manifest + SHA256 + provenance + **loopback verification**; revise #4437..."*

The actual verify tooling this build produces output through, `scripts/ops/multitable-onprem-package-verify.sh`,
runs exactly **four** checks — confirmed from this session's own A1 `verify.json` output (§3.1):
`checksum`, `required-content`, `deployability-contract`, `no-github-links`. None is named or behaves as a
loopback check. Confirmed by direct grep against the current script, not inference:
```
grep -n "loopback" scripts/ops/multitable-onprem-package-verify.sh
# (zero hits)
grep -n "loopback" scripts/ops/attendance-onprem-package-verify.sh
# 321:  die "Frontend bundle embeds loopback VITE_API_* config; rebuild package with isolated web env"
```
Attendance's on-prem verify script has exactly this kind of check (fails the build if the frontend bundle
embeds a loopback `VITE_API_URL`); multitable's does not. So either:

1. **the ledger's phrase should be amended** to name the four checks that actually exist (`checksum` /
   `required-content` / `deployability-contract` / `no-github-links`), because "loopback verification" was
   never built for the multitable path and the ledger's authorization language should describe what M0-A's
   output actually is, or
2. **a loopback check must be built** into `multitable-onprem-package-verify.sh` (mirroring attendance's
   pattern) before M0-A's output can honestly be described as including it.

Both are owner decisions. This document does not choose between them and does not edit the RATIFIED ledger.
It records that A1's real, passing verify run covered four checks — not five, not "loopback" — so whoever
reads M0-A's ledger line against A1's actual output does not silently assume a check ran that did not.
