# Versioning Governance Policy Verification

Date: 2026-03-28

## Goal

Verify that the proposed versioning policy matches repository history and the release that was just published.

## Evidence checked

### Current formal semver tags

Command:

```bash
git tag --sort=-version:refname | head -n 20
```

Observed semver tags include:

- `v2.7.0`
- `v2.6.0`
- `v2.5.0`
- `v2.4.1`

### Current GitHub Releases

Command:

```bash
gh release list --limit 20
```

Observed:

- `v2.7.0` exists as the latest GitHub Release
- on-prem releases exist as separate GitHub Releases
- run-style attendance tags also exist as separate GitHub Releases

This confirms the repository currently mixes formal release, on-prem package, and run traceability concepts.

### Formal release tag vs `package.json`

Command:

```bash
for t in v2.7.0 v2.6.0 v2.5.0 v2.4.1; do
  printf "%s commit=%s pkg=%s\n" \
    "$t" \
    "$(git rev-list -n 1 "$t")" \
    "$(git show $t:package.json | jq -r '.version')"
done
```

Observed:

- `v2.7.0` -> `package.json = 2.5.0`
- `v2.6.0` -> `package.json = 2.5.0`
- `v2.5.0` -> `package.json = 2.4.0`
- `v2.4.1` -> `package.json = 2.4.0`

This verifies that the repository has already been using release tags as the effective shipping version, even when `package.json` lags.

### `v2.7.0` release metadata

Command:

```bash
gh release view v2.7.0 --json tagName,name,publishedAt,targetCommitish,url
```

Observed:

- tag: `v2.7.0`
- published at: `2026-03-28T08:34:48Z`
- target commit: `0977b4b19e35d474df4057ea82809d07e6f359c0`

### `v2.7.0` tag reachability

Command:

```bash
git ls-remote --tags origin 'refs/tags/v2.7.0'
```

Observed:

- `refs/tags/v2.7.0` points to `0977b4b19e35d474df4057ea82809d07e6f359c0`

### Tag-triggered deploy workflow

Command:

```bash
gh run watch 23681417368 --interval 5 --exit-status
```

Observed:

- `Deploy to Production` for tag `v2.7.0` completed successfully

## Conclusion

The policy matches repository reality:

- formal semver releases already function independently from `package.json`
- on-prem and run tags are separate concepts and need to stay separate in policy
- `v2.7.0` is defensible as a minor release under a capability-expansion rule

The policy therefore converts existing implicit behavior into explicit governance, while also documenting the cleanup still needed around version-file synchronization.
