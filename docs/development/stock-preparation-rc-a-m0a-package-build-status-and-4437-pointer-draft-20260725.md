# Stock-prep RC-A — M0-A package build status + #4437 pointer revision draft (2026-07-25)

Lane: **LANE C — M0-A** (per `docs/development/database-system-integration-line-design-and-verification-20260724.md`,
§2 M0-A / §4 "Parallel and unblocked" M0-A track, ⟲C1/⟲R1/⟲R7). Authorized: build + verify the COMPLETE
on-prem deployment package at the owner-chosen main SHA, regenerate manifest/SHA256/provenance/loopback
verification (built and run post-hoc/standalone this fix pass — owner-ruled, see §6/§3.1a; not yet part of
the frozen package's own CI-produced verify output, a known forward gap §3.1a records), prepare (not post)
the #4437 pointer revision. Not authorized: deployment, flag-ON, connecting to any host, editing #4437
itself, merging, pushing to main, and — per this fix pass — still not the release/freeze act (see §3 A2).

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

## Verdict: A1 PASS. This is a component verdict, not "M0-A PASS" — see below for exactly what remains open.

**A1 PASS** — build + verify executed, run `30148584851`, `publish_release=false`. A real CI run built and
verified the complete on-prem package at the exact recommended SHA, using the project's own unmodified
tooling at that commit, and self-verified with four structural checks (all PASS). No release was published.
No checksum was hand-typed or fabricated — the checksums recorded below are read verbatim from the run's own
`SHA256SUMS` output.

**M0-A is still open**, pending two separate things — do not read "A1 PASS" as "M0-A PASS":

- **(i) the ledger's loopback-verification deliverable, as produced by the canonical pipeline.** This fix
  pass builds the check (§6) and runs it **post-hoc, standalone**, against A1's real artifact bytes — PASS
  (§3.1a) — but that is corroborating evidence from a tool run outside the CI pipeline, at a commit newer
  than `7bf2bd7a1`, recorded under its own `verificationToolSha` (§3.1a). It is **not** the same claim as "the
  frozen package's own CI-produced verify output includes a loopback check" — run `30148584851`'s own
  `verify.json` is immutable and still shows four checks (§3.1). §3.1a also records a known forward gap: a
  future A2 dispatch at the pinned ref (`build/m0a-rca-7bf2bd7a1`, still targeting source commit `7bf2bd7a1`)
  will check out the **old**, four-check verify script, not this fix pass's five-check version — so A2's own
  `verify.json` will also be four checks unless the owner separately revisits the ref/tooling situation. That
  is not resolved here.
- **(ii) the owner-only A2 publish/freeze act** (§3.2) — unchanged from before this fix pass.

§3 gives the retraction, the A1 record, the loopback-check build + post-hoc execution (§3.1a), and the narrow
residual (A2, owner-only, §3.2).

---

## 1. Tooling identification

**There is no stock-prep-specific on-prem package build.** Stock-prep ships as a plugin (`plugin-integration-core`)
inside the multitable on-prem platform bundle, so "the complete on-prem deployment package" for RC-A is the
**Multitable On-Prem Package Build** workflow:
`.github/workflows/multitable-onprem-package-build.yml` → `scripts/ops/multitable-onprem-package-build.sh`
(packaging) → `scripts/ops/multitable-onprem-package-verify.sh` (structural verification — four checks, see
§2.4/§3.1; the ledger's "loopback verification" phrasing is escalated, not confirmed, in §6).

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
git rev-list --count 7bf2bd7a1..origin/main                                         # 11 at original draft time
```
Confirms the ledger's framing: `d87e086fd` (frozen RC-A) < `7bf2bd7a1` (`bridge.bounded_read.v2`, #4573) <
main tip at original draft time (`402f04982`). **Both the count and the tip named here are draft-time
snapshots, not live values — see §2.2's drift note: as of this fix pass, `origin/main` tip is `b5ff168e9`
and the count is 12. The ancestry claims themselves (predates/reachable) do not change with main's tip.**

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

**Dated snapshot, now stale as of this fix pass's own commit (see note below):** at original draft time, the
build tooling itself was byte-identical between the recommended SHA and current main —
```
git log --oneline 7bf2bd7a1..origin/main -- .github/workflows/multitable-onprem-package-build.yml \
  scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
```
returned nothing at draft time, so "build at `7bf2bd7a1`" and "build at current main" would have used
identical build/verify scripts then — only the source snapshot differed.

**This is no longer true as of this same-day fix pass.** §6/§3.1a add a loopback check to
`scripts/ops/multitable-onprem-package-verify.sh` on this branch — a real, intentional change to the verify
script, landed at a commit newer than `7bf2bd7a1` and not yet on `origin/main`. Re-running the same command at
this fix pass's HEAD:
```
git log --oneline 7bf2bd7a1..HEAD -- .github/workflows/multitable-onprem-package-build.yml \
  scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
```
now returns exactly one commit — this fix pass's own loopback-check commit. The build workflow and build
script remain untouched; only the verify script differs, and only by this fix pass's own addition. This does
not change the §2.2 recommendation (still build at `7bf2bd7a1`, not current main) — it only means the
"identical tooling" claim is a point-in-time snapshot, not a standing invariant, and the record must say so
rather than imply it holds indefinitely.

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
- **In-archive `BUILD_PROVENANCE.json`** (extracted from the `.tgz`, not the external sidecar — **read in
  full, not excerpted**, per this fix pass's re-extraction and read of the same archive; the prior draft
  showed only a partial field set here without marking it as an excerpt, while the sibling manifest block
  below was correctly marked "read in full" — corrected):
  ```json
  { "schema": "metasheet-onprem-build-provenance/v1",
    "packageName": "metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725",
    "version": "2.5.0", "tag": "m0a-rca-20260725",
    "gitCommit": "7bf2bd7a1f8cdf54cca83a733fcd89afb076848b",
    "gitCommitShort": "7bf2bd7a1f8c", "gitRef": "build/m0a-rca-7bf2bd7a1", "sourceIsOnOriginMain": "unknown",
    "ciRunId": "30148584851", "ciRunAttempt": "1", "builtAt": "2026-07-25T07:04:39Z",
    "fixMarkers": { "issue1912": {
      "title": "K3 WISE M1 Material Save-only backend fix",
      "adapter": "plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs",
      "marker": "material-k3wise-customer-profile-v1", "embedded": true } } }
  ```
  `gitCommit` = `7bf2bd7a1f8cdf54cca83a733fcd89afb076848b` — **exact match to `expected_sha`, CONFIRMED from
  the checksummed bytes, not the external sidecar.** Unlike `builtAt`/`ciRunId`, `gitCommit` is derived from
  `git rev-parse HEAD` at the pinned commit and will be the same in A2 provided A2 also targets `7bf2bd7a1`.
  `fixMarkers.issue1912.embedded: true` corroborates §2.4/§2.3's marker findings from the same archive this
  fix pass independently re-extracted (see §3.1a).
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
- **External sidecar manifest** (`metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.json`, read in full,
  not excerpted):
  ```json
  { "name": "metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725", "version": "2.5.0", "tag": "m0a-rca-20260725",
    "artifactKind": "deployable-onprem-app-package", "deployMode": "fresh-extract-or-existing-root-apply",
    "directReplaceSafe": false, "nodeModulesBundled": false, "pnpmVersion": "9.15.9",
    "dependencyPreflight": "staging-full-install-before-live-overlay", "dependencyFailureRollback": true,
    "windowsEntryPoint": "deploy.bat <package.zip|package.tgz>",
    "windowsFirstHopBootstrap": "metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725-deploy-bootstrap.ps1",
    "windowsFirstHopBootstrapWrapper": "metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725-deploy-bootstrap.bat",
    "windowsStagingRootEnv": "METASHEET_ONPREM_STAGING_ROOT", "windowsDefaultStagingRoot": "C:\\ms-tmp",
    "attendanceOnly": false, "productMode": "platform",
    "includedPlugins": ["plugin-attendance", "plugin-integration-core"],
    "archive": "metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz",
    "archiveZip": "metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.zip", "checksumFile": "SHA256SUMS",
    "generatedAt": "2026-07-25T07:04:41Z", "gitSha": "7bf2bd7a1f8cdf54cca83a733fcd89afb076848b" }
  ```
  `productMode: "platform"` + `includedPlugins: [plugin-attendance, plugin-integration-core]` is the A1-side
  confirmation, now at `7bf2bd7a1` (not just at the frozen `d87e086fd`, §1), that this is the platform+plugin
  bundle ⟲R7 means by "the package" — not the sidecar. `gitSha` here (the external, workflow-appended field)
  also matches `7bf2bd7a1f8cdf54cca83a733fcd89afb076848b`, but per §2.4's `-ExpectedGitSha` note this field is
  informational only — the trust anchor is the in-archive `BUILD_PROVENANCE.json.gitCommit` above.

**Two constraints the "done" framing must carry, or it misleads:**

- **The Actions artifact (`multitable-onprem-package-30148584851-1`) is not a release.** It is unfrozen,
  privately-scoped to this run, and has `retention-days: 14` set in the workflow — it expires around
  **2026-08-08** (14 days from `createdAt` 2026-07-25T07:02:23Z). "Build+verify done" does not mean "package
  available to deploy"; nothing here is a publicly-addressable checksummed asset until A2 runs.
- If the owner's A2 act slips past the retention window, A1 must be re-run (cheap — no code changed, same
  `expected_sha`, same ref) before A2, since A2's own build supersedes A1's bytes anyway.

### 3.1a Loopback verification — built, then run post-hoc/standalone against A1's real artifact (this fix pass)

**Owner ruling on §6's escalation (below): build the real check — option 2, not option 1.** This fix pass
adds `verify_no_loopback_frontend_config()` to `scripts/ops/multitable-onprem-package-verify.sh`, porting
`scripts/ops/attendance-onprem-package-verify.sh`'s existing loopback rule
(`VITE_API_(URL|BASE):"http://(127\.0\.0\.1|localhost)"` against `apps/web/dist`) — same pattern, same target.
Wired unconditionally (not gated behind an env var, matching attendance's rule) into the main verify flow, and
reported as a fifth `"loopback"` field in both the JSON and Markdown reports. New focused test
(`scripts/ops/multitable-onprem-package-verify-loopback.test.sh`, sourced-function style matching the sibling
`multitable-onprem-package-verify.provenance.test.sh`) covers one positive fixture and three negatives —
`VITE_API_URL`+`127.0.0.1`, `VITE_API_BASE`+`localhost` (opposite corners of the alternation), and
`apps/web/dist` missing entirely (closes a vacuous-pass hole: `search_extended_regex` returns non-zero/no-match
against a target directory that does not exist, which would otherwise silently report PASS on a package
missing its frontend bundle).

**Hardening (review #4604 P2 — two findings, both addressed within the file's existing conventions):**
1. The report's `"loopback"` row was a hardcoded `"status": "PASS"` literal — printed even if the check were
   never invoked. Replaced with a derived `loopback_status` variable (default `"SKIPPED"`, set to `"PASS"` by
   `verify_no_loopback_frontend_config()` itself only on a successful run) and wired that variable into both
   the JSON and Markdown report emission. The focused test gained a fifth case that greps the main script body
   for the literal top-level call site (distinct from the `function ... () {` definition, which survives a
   call-site deletion) — deleting the call site now reds this test (verified: 4 passed/1 failed) instead of
   staying green at 4/4. **This pin is itself only as strong as item 2 below**: it fires when
   `multitable-onprem-package-verify-loopback.test.sh` is run, and per item 2 nothing runs that file
   automatically — the pin protects a manual run from a silent regression, it does not by itself make a
   dropped call site fail any automated check.
2. Neither this focused test nor its sibling `multitable-onprem-package-verify.provenance.test.sh` has any
   automated caller (no workflow, no package script, no glob runner) — this is **pre-existing convention**,
   not something this fix pass introduced or regressed. The underlying *check* does run in CI: nothing was
   silently going untested — `multitable-onprem-package-build.yml` invokes
   `scripts/ops/multitable-onprem-package-verify.sh` directly against both the `.tgz` and `.zip` outputs
   (L101/L104), so the loopback check itself executes on every real package build. What is **not** CI-covered
   is the *focused fixture test* — its exposure is that it can rot unnoticed (e.g. a future edit to the
   function silently breaking one of the four fixture cases would not fail CI). **Disclosed here rather than
   wired into a caller**: wiring would mean either adding a `pull_request`-triggered job for a check-family
   that does not have one **today**, or adding a step to `multitable-onprem-package-build.yml`, which is
   `workflow_dispatch`-only and would not run on ordinary PR iteration anyway — both are broader
   infra/convention changes than this fix pass's scope, and singling out only these two `.test.sh` files (this
   fix pass separately confirmed the same is true of at least two sibling `.test.mjs` contract tests against
   this same script — `multitable-onprem-package-verify-k3-helper-contract.test.mjs` and
   `bridge-agent-driver-smoke-contract.test.mjs`, neither referenced by any workflow or package script either)
   would be an arbitrary, partial fix to a repo-wide pattern rather than a considered one. Run manually:
   `bash scripts/ops/multitable-onprem-package-verify-loopback.test.sh` and
   `bash scripts/ops/multitable-onprem-package-verify.provenance.test.sh`; the doc does not imply CI coverage
   for either that it does not have.

**Scope limitation, stated plainly:** the ported pattern is reused **verbatim** per the owner's ruling
("reuse attendance's rule") and is not changed here. The fixtures prove the rule is falsifiable *as specified*
— a bundle containing that exact literal string shape fails, a clean one passes — not that multitable's own
web bundler can or does ever emit that shape in practice (whether it can was not independently established by
this fix pass; §3.1a's direct grep against the real artifact only shows this particular build does not
contain it today).

**`verificationToolSha`** — the exact tool used below. Recorded as the **blob** SHA of the script content at
this document's own final commit in this fix pass, re-derived AFTER that commit (not carried forward from an
earlier draft — see the erratum immediately below), with the introducing commit also recorded for provenance:
```
git rev-parse HEAD:scripts/ops/multitable-onprem-package-verify.sh
# 89ec733a41af25bee9d7f02f608fefcbefbbd9c1
```
Introduced at commit `76417a0ceaefaff85433bf3b4df9327e61c9175f` on this branch as rebased onto `origin/main`
tip `aebac4f8bef344b3ff3443ee045439c789a569a1` (this section's final, required pre-push rebase — the
introducing **commit** SHA is rebase-unstable and has already changed once since it was first recorded here;
it will change again on any future rebase of this branch). **This is a tooling identity, not a
deployed-artifact identity — it must never be conflated into `serviceRuntimeSha`** (still
`7bf2bd7a1f8cdf54cca83a733fcd89afb076848b`, unchanged) **or presented as part of what run `30148584851`
itself produced.**

**Erratum (review #4604):** an earlier version of this section recorded blob `2e64b9d66…` and claimed it was
"stable across this fix pass's own later commits" — that claim was **false**, and was falsified by this very
fix pass's own comment-only edit to the script (commit `dbfd25643724eeb0477bdf89c040fadc8317c7af`, whose own
diff header reads `index 2e64b9d66..b2f5ff716`), which changed the blob without the sentence being revisited.
A comment-stripped diff of the two blobs is **identical**, so the PASS recorded in this section was never
behaviourally wrong — only the recorded tool *identity* was stale, the same class of slip this branch already
fixed once at `593e66efd5835780843a59fe693185eb9fa10963`. (Both of those are **post-rebase commit SHAs**,
current as of this section's own final pre-push rebase onto `origin/main` tip `aebac4f8b…` above — like the
introducing commit above, they are rebase-unstable and will shift again on any future rebase of this branch;
the **blob** SHAs `2e64b9d66…`/`b2f5ff716…` they refer to are content hashes and remain valid identities
regardless of any rebase.) The blob SHA recorded above is a content hash of the script as it exists at this
document's own final commit; blobs (unlike commit SHAs) do not shift on a content-preserving rebase, and it
was re-confirmed (not assumed) after this branch's final pre-push rebase — same value, `89ec733a4…`, before
and after. It is **not** asserted to be stable against any future *content* change to the script — if the
script changes again after this fix pass, this line goes stale again and must be re-derived, not assumed
correct.

**What was executed — a real, full run of the updated tool against A1's real, already-built artifact bytes**
(not the sourced-function fixture test above; not a rebuild; `serviceRuntimeSha` does not move). Commands
below were run via a small wrapper script (the harness this session runs in refused the inline
`VAR=... bash ...` form directly) — the wrapper only `cd`s and exports the two report-path env vars before
calling the unmodified verify script with the real package path as its sole argument; the verify script's own
behavior is exactly as it would be invoked directly. Output is real, with local absolute scratch paths
abbreviated to `<local>`:

1. Re-downloaded (read-only) the same Actions artifact §3.1 already recorded:
   ```
   gh run download 30148584851 --repo zensgit/metasheet2 -D .
   ```
   Local recompute reproduces the exact `SHA256SUMS` line already in §3.1 — same bytes, no re-fetch drift:
   ```
   $ shasum -a 256 metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz
   759adcc3cbb6f677f2c6aea92224df83085d1afb1424c1759d980b98abd07f4d  metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz
   ```
2. Ran the **full** updated `multitable-onprem-package-verify.sh` (all checks, not just the new function in
   isolation) against that real `.tgz`, with **both** `VERIFY_REPORT_JSON` and `VERIFY_REPORT_MD` set — CI
   itself exercises both report formats (the downloaded artifact's `verify/` directory contains both a
   `.verify.json` and a `.verify.md` per archive), so both paths are checked here, not just the JSON one.
   Equivalent invocation:
   ```
   $ VERIFY_REPORT_JSON=<local>/posthoc-verify-2.json VERIFY_REPORT_MD=<local>/posthoc-verify-2.md \
     bash scripts/ops/multitable-onprem-package-verify.sh <local>/metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz
   metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz: OK
   [multitable-onprem-package-verify] Package verify OK
   [multitable-onprem-package-verify]   package: <local>/metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz
   [multitable-onprem-package-verify]   root: <extracted temp dir>
   [multitable-onprem-package-verify]   verify_report_json: <local>/posthoc-verify-2.json
   [multitable-onprem-package-verify]   verify_report_md: <local>/posthoc-verify-2.md
   EXIT=0
   ```
   `posthoc-verify-2.json`, real content (local absolute paths abbreviated to `<local>`):
   ```json
   {
     "ok": true,
     "packageFile": "<local>/metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz",
     "packageName": "metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725",
     "archiveType": "tgz",
     "packageRootInArchive": "metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725",
     "extractMode": "temporary",
     "extractRoot": null,
     "checks": [
       { "name": "checksum", "status": "PASS" },
       { "name": "required-content", "status": "PASS", "requiredCount": 128 },
       { "name": "deployability-contract", "status": "PASS", "artifactKind": "deployable-onprem-app-package",
         "deployMode": "fresh-extract-or-existing-root-apply", "directReplaceSafe": false, "nodeModulesBundled": false },
       { "name": "no-github-links", "status": "PASS" },
       { "name": "loopback", "status": "PASS" }
     ],
     "generatedAt": "2026-07-25T14:23:18Z"
   }
   ```
   `posthoc-verify-2.md`'s `## Checks` section, real content:
   ```markdown
   ## Checks

   - Checksum: `PASS`
   - Required content: `PASS` (128 paths)
   - Deployability contract: `PASS` (deployable-onprem-app-package, directReplaceSafe=false, nodeModulesBundled=false)
   - No GitHub links in delivery docs: `PASS`
   - Loopback frontend config: `PASS` (no loopback VITE_API_URL/BASE embedded in apps/web/dist)
   ```
   Five checks, all PASS, in **both** report formats — the four-check report becomes five in each.
   `requiredCount=128` (JSON) / "128 paths" (MD) matches §3.1's original A1 run exactly — no unrelated drift
   in the required-file inventory between the original CI run and this post-hoc pass.
3. Independently corroborated outside the script, by direct extraction and grep against the real
   `apps/web/dist` inside the archive (122 files under `apps/web/dist`):
   ```
   $ tar -xzf metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz -C <extract-dir>
   $ grep -rIE 'VITE_API_(URL|BASE):"http://(127\.0\.0\.1|localhost)' <extract-dir>/.../apps/web/dist
   # (no output)
   $ echo "grep exit=$?"
   grep exit=1
   ```
   Zero matches, independently of the new check function. Matches the owner's own finding (review #4604): the
   current artifact does not hit the forbidden pattern. This is the expected outcome the owner's ruling was
   scoped to — **completing the proof, not changing service code** — and that is what happened; no
   runtime/service code changed, only the verify tool.
4. **Re-ran a third time after this fix pass's own P2 hardening** (§3.1a "Hardening" above —
   `loopback_status` derived variable + call-site pin), against the same real artifact bytes, on the file the
   artifact's own checksum still confirms unchanged (`shasum -a 256` reproduces the identical
   `759adcc3…07f4d` line from step 1 again). Unlike steps 1-3, this one was run **directly** in this session
   (no wrapper script needed here — that earlier constraint was specific to the session that ran steps 1-3),
   with real absolute paths, abbreviated below to `<local>` the same way as elsewhere in this document:
   ```
   $ VERIFY_REPORT_JSON=<local>/posthoc-verify-3.json VERIFY_REPORT_MD=<local>/posthoc-verify-3.md \
     bash scripts/ops/multitable-onprem-package-verify.sh <local>/metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz
   metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz: OK
   [multitable-onprem-package-verify] Package verify OK
   [multitable-onprem-package-verify]   package: <local>/metasheet-multitable-onprem-v2.5.0-m0a-rca-20260725.tgz
   [multitable-onprem-package-verify]   root: <extracted temp dir>
   [multitable-onprem-package-verify]   verify_report_json: <local>/posthoc-verify-3.json
   [multitable-onprem-package-verify]   verify_report_md: <local>/posthoc-verify-3.md
   EXIT=0
   ```
   `posthoc-verify-3.json`'s `checks` array, real content (the full file also carries the same
   `packageFile`/`packageName`/`archiveType`/`packageRootInArchive`/`extractMode`/`extractRoot` fields as
   `posthoc-verify-2.json` above, omitted here since only the `checks` array and `generatedAt` are new
   information) — identical shape/values to `posthoc-verify-2.json` above (`requiredCount=128`, all five
   checks `PASS`, including `loopback` now via the derived `loopback_status` variable rather than the prior
   literal), only `generatedAt` differs:
   ```json
   {
     "checks": [
       { "name": "checksum", "status": "PASS" },
       { "name": "required-content", "status": "PASS", "requiredCount": 128 },
       { "name": "deployability-contract", "status": "PASS", "artifactKind": "deployable-onprem-app-package",
         "deployMode": "fresh-extract-or-existing-root-apply", "directReplaceSafe": false, "nodeModulesBundled": false },
       { "name": "no-github-links", "status": "PASS" },
       { "name": "loopback", "status": "PASS" }
     ],
     "generatedAt": "2026-07-25T15:11:16Z"
   }
   ```
   `posthoc-verify-3.md`'s `## Checks` section (both report formats exercised again, matching step 2's point
   that CI itself produces both): identical five-line content to `posthoc-verify-2.md`'s `## Checks` section
   above, byte-for-byte, since `loopback_status` resolves to `"PASS"` on a successful run either way.

   This is the run that corresponds to the `verificationToolSha` recorded above
   (`89ec733a41af25bee9d7f02f608fefcbefbbd9c1`). `posthoc-verify-2` above was run against the prior,
   now-superseded blob (`b2f5ff716…`, comment-only diff from the one before it) and is kept in this document
   as its own historical record — not deleted or silently overwritten — because the P2 hardening changed how
   the `"loopback"` row is *derived* (a real code change, unlike the comment-only edit the erratum above
   describes), not what result a successful run against this artifact reports. The call-site pin added in
   Hardening item 1 only fires when `multitable-onprem-package-verify-loopback.test.sh` is itself run (it is
   not wired into any automated caller, per Hardening item 2 above) — it does not run as part of this or any
   other real verify invocation, which is why this step re-runs the full verify script directly rather than
   relying on the pin for behavioral proof.

**Explicit non-conflation, stated plainly (this is the exact thing ⟲R7 exists to prevent):** run
`30148584851`'s own `verify.json`, the one packaged inside the CI-produced Actions artifact, is **immutable
and still shows four checks** (§3.1) — it was produced by the verify script as it existed at commit
`7bf2bd7a1`, before this fix pass's check existed. The fifth check above ran **after the fact, standalone,
at `verificationToolSha`**, against the same archive bytes. It is corroborating evidence, not a retroactive
edit of the run's own artifact, and must be cited as such — not as "run 30148584851 produced five checks."

**Known forward gap, not resolved here:** the workflow's `workflow_dispatch` checks out the *ref* it is given
(`build/m0a-rca-7bf2bd7a1`, pinned to source commit `7bf2bd7a1`) — including whatever version of
`multitable-onprem-package-verify.sh` exists **at that commit**, not on this feature branch. A future A2
dispatch at that same ref will therefore still run the **old, four-check** verify script and produce a
**four**-check `verify.json` of its own, not five — unless the owner separately decides to move the build ref
forward (which `docs/development/database-system-integration-line-design-and-verification-20260724.md`'s
"Build SHA stays `7bf2bd7a1`... do not enlarge the runtime change surface" ruling weighs against, and this
document does not decide). This gap is recorded, not closed.

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
> - **Loopback verification** (not a third deployed-artifact SHA — a tooling-run result; see §3.1a for the
>   full record, kept separate here on purpose): PASS, via a post-hoc/standalone run of the updated verify
>   tool (`verificationToolSha` = `89ec733a41af25bee9d7f02f608fefcbefbbd9c1`, the script blob at this
>   document's final commit — see §3.1a's erratum for the prior stale value) against A1's
>   real artifact. **This did not come from run `30148584851`'s own `verify.json`** (that artifact is
>   immutable and still shows four checks) and will not come from a future A2 run at the pinned ref either,
>   unless the ref/tooling question is separately revisited (§3.1a forward gap) — do not post this line to
>   #4437 as if it were part of A2's own build output.
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
  (unchanged from the original investigation, no rebuild needed); a real loopback-verification check, built
  per owner ruling (§6) and run post-hoc/standalone against A1's real artifact bytes at a recorded, separate
  `verificationToolSha` (§3.1a), PASS, corroborated by an independent direct grep; a draft the operator/owner
  can lift into #4437 once A2 (§3.2) exists.
- It is not: a published release, a permanent/addressable checksummed artifact (A1's Actions artifact expires
  ~2026-08-08, §3.1), the owner's freeze act, an edit to #4437 itself, or an edit to the RATIFIED ledger
  (§6's ruling is recorded here, not written into the ledger's own text). Nothing here was posted to the
  issue. A1's `.tgz`/`.zip` SHA256 values are recorded as run-scoped evidence only and must not be read as
  "the" RC-A checksums — those come from A2. The post-hoc loopback PASS (§3.1a) is not the same claim as "run
  30148584851's own `verify.json` has five checks" — that artifact is immutable and still has four (§3.1); a
  future A2 dispatch at the pinned ref will also still emit four unless the ref/tooling question is
  separately revisited (§3.1a's forward gap, not resolved here). **A1 PASS is not M0-A PASS** — M0-A remains
  open pending A2 regardless.

## 6. Owner ruling on the escalation — build the check (option 2), not amend the ledger (option 1)

**This section previously escalated a specification gap and left it unresolved for the owner to rule on. The
owner has now ruled (review #4604 P1): "BUILD THE REAL CHECK, DO NOT DELETE THE CONTRACT." This section
records that ruling and what this fix pass did to satisfy it. It still does not edit the RATIFIED ledger —
the ledger's own text is unchanged; this section only records that its "loopback verification" phrase now has
a real, falsifiable check backing it, per the mechanics in §3.1a.**

The RATIFIED ledger (`docs/development/database-system-integration-line-design-and-verification-20260724.md`)
names "loopback verification" as part of M0-A's authorized/expected output in two places (unchanged, quoted
verbatim, not edited by this document):

- §4, the M0-A bullet itself: *"regenerate manifest / SHA256 / provenance / **loopback verification**, revise
  the #4437 pointer..."*
- §2 ⟲R7: *"regenerate manifest + SHA256 + provenance + **loopback verification**; revise #4437..."*

Before this fix pass, `scripts/ops/multitable-onprem-package-verify.sh` ran exactly **four** checks —
confirmed from the original A1 `verify.json` output (§3.1): `checksum`, `required-content`,
`deployability-contract`, `no-github-links`. None was named or behaved as a loopback check, confirmed by
direct grep at that point in history:
```
grep -n "loopback" scripts/ops/multitable-onprem-package-verify.sh
# (zero hits, before this fix pass)
grep -n "loopback" scripts/ops/attendance-onprem-package-verify.sh
# 321:  die "Frontend bundle embeds loopback VITE_API_* config; rebuild package with isolated web env"
```
Attendance's on-prem verify script already had exactly this kind of check (fails the build if the frontend
bundle embeds a loopback `VITE_API_URL`); multitable's did not.

**Owner's ruling bounded the expected work:** they had already downloaded and inspected run `30148584851`'s
A1 artifacts and found the current artifacts do **not** hit the forbidden pattern — so this was expected to
be *completing the proof, not changing service code*. §3.1a confirms exactly that: the check was built
(reusing attendance's rule verbatim, same pattern/target), the real artifact was independently re-checked and
found clean by both the new check and a direct grep outside it, and no runtime/service code changed. Had the
real artifact instead hit the pattern, this document would stop and report rather than reconcile — it did
not need to.

Residual, recorded not resolved: §3.1a's forward gap (a future A2 dispatch at the pinned ref will still emit
a four-check `verify.json` unless the ref/tooling question is separately revisited) remains open, and this
document does not decide it.
