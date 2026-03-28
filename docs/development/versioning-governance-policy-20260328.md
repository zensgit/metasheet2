# Versioning Governance Policy

Date: 2026-03-28

## Background

The repository currently mixes three release-like concepts:

1. Formal GitHub product releases, for example `v2.7.0` and `v2.6.0`.
2. On-prem package releases, for example `v2.5.1-onprem-20260307-current`.
3. Run or operations tags, for example `attendance-onprem-run21-20260322`.

The existing history also shows that formal release tags do not currently move in lockstep with `package.json`. For example:

- `v2.7.0` points to commit `0977b4b19e35d474df4057ea82809d07e6f359c0`, while `package.json` at that tag is still `2.5.0`.
- `v2.6.0` points to commit `f35e7b6792c9a1795f92f5d26ba2f1c6d933150f`, while `package.json` at that tag is still `2.5.0`.
- `v2.5.0` points to commit `06dbfc4509bcc2973c79250648ffb7a9ecd8f081`, while `package.json` at that tag is still `2.4.0`.

That mismatch is already a repository fact, so the first job of this policy is to make the source of truth explicit instead of pretending the tree is already synchronized.

## Decision

### 1. Formal product version

The formal product version is the latest semver Git tag that also has a published GitHub Release.

Examples:

- `v2.7.0`
- `v2.6.0`
- `v2.5.0`

This tag and GitHub Release pair is the source of truth for external release communication.

### 2. On-prem package version

On-prem package tags are separate delivery artifacts and do not replace the formal product version.

Examples:

- `v2.5.1-onprem-20260307-current`
- `v2.5.0-onprem-20260306-current`

These tags describe a packaging stream or delivery bundle, not the canonical product version.

### 3. Run and operations tags

Run tags are traceability markers only.

Examples:

- `attendance-onprem-run21-20260322`
- `attendance-onprem-pr396-20260310`

They must not be used as product versions in release notes, user-facing announcements, or deployment sign-off.

## Release naming rules

### Patch release: `vX.Y.Z+1`

Use a patch bump when the release is primarily:

- release blocker removal
- deployment recovery
- workflow or packaging repair
- operator or observability correction
- low-risk bug fix without a meaningful new product capability boundary

### Minor release: `vX.Y+1.0`

Use a minor bump when the release materially expands user-facing or operator-facing capability, even if part of the work is operational hardening.

Use a minor bump when one or more of these are true:

- a new product surface or workflow is added
- an existing surface gains materially new capability
- a release aggregates multiple cross-cutting capability lines
- pilot, on-prem, or embedded delivery becomes meaningfully stronger, not just repaired

`v2.7.0` fits this rule because it was not only a hotfix train. Relative to `v2.6.0`, it bundled:

- multitable runtime and embed-host capability expansion
- pilot delivery chain and on-prem operator artifact hardening
- attendance remote deploy and health-check recovery
- attendance daily gate signal-channel observability enhancement

### Major release: `vX+1.0.0`

Use a major bump only when external compatibility changes materially, for example:

- incompatible public API behavior
- incompatible deployment or packaging contract
- incompatible plugin or extension contract
- incompatible user data or migration expectations

## `package.json` rule

Until a dedicated cleanup lands, `package.json` is not the formal release source of truth.

Current rule:

- formal release identity comes from the semver Git tag plus GitHub Release
- `package.json` version may lag
- release notes or merge/release checklist must state the release tag explicitly

Recommended future cleanup:

- either align `package.json` to the formal semver release at each release
- or add a dedicated `RELEASE_VERSION` artifact and stop implying that `package.json` alone defines shipping version

Do not assume the repository is already on the first model.

## Release workflow

### Formal product release

1. Merge to `main`.
2. Ensure the mainline checks and deploy chain are green.
3. Pick the next semver tag using the rules above.
4. Publish a GitHub Release for that tag targeting the verified `main` commit.
5. Treat that GitHub Release as the publish event.

### On-prem package release

1. Build the package or delivery bundle.
2. Publish an on-prem tag with channel/date suffix.
3. Reference the current formal product version from release notes or operator material when useful.

### Run tag

1. Use only for traceability.
2. Keep out of public version statements.

## Decision for the 2026-03-28 release

The choice of `v2.7.0` was reasonable under this policy.

Why it was not `v2.6.1`:

- the release scope was broader than a pure patch train
- it included net-new multitable capability and release-chain strengthening
- it also included attendance operational recovery and new signal visibility

Why it was not tied to `package.json = 2.7.0`:

- the repository had already established a history where release tags outpaced `package.json`
- forcing a late version-file cleanup into the release would have enlarged scope without improving release safety

## Follow-up recommendation

The next release cycle should choose one cleanup path explicitly:

1. Synchronize `package.json` with the formal semver release.
2. Or document permanently that GitHub Release tags, not `package.json`, define shipped version.

The repository should stop living in the current implicit middle state.
