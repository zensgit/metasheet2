# On-Prem Migration Bridge Package Verify Verification

## Scope

Verify that the multitable on-prem package verifier now fails closed if the
archive does not include the migration bridge required by issue `#651`.

## Local Checks

```bash
bash -n scripts/ops/multitable-onprem-package-verify.sh
```

Expected:

- shell syntax is valid.

Observed:

- exit `0`.

```bash
scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/metasheet2-k3wise-migbridge-25725063918/metasheet-multitable-onprem-v2.5.0-k3wise-migbridge-36ee325.zip
```

Expected:

- checksum passes;
- required content passes;
- migration bridge content checks pass.

Observed:

```text
metasheet-multitable-onprem-v2.5.0-k3wise-migbridge-36ee325.zip: OK
[multitable-onprem-package-verify] Package verify OK
```

```bash
scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/metasheet2-k3wise-migbridge-25725063918/metasheet-multitable-onprem-v2.5.0-k3wise-migbridge-36ee325.tgz
```

Expected:

- same checks pass for the `.tgz` archive.

Observed:

```text
metasheet-multitable-onprem-v2.5.0-k3wise-migbridge-36ee325.tgz: OK
[multitable-onprem-package-verify] Package verify OK
```

```bash
git diff --check origin/main...HEAD
```

Expected:

- no whitespace errors;
- no conflict markers.

Observed:

- exit `0`.

## Package Used

The verification package was the post-`#1486` package generated from main:

- workflow run: `25725063918`
- package tag: `k3wise-migbridge-36ee325`
- zip:
  `metasheet-multitable-onprem-v2.5.0-k3wise-migbridge-36ee325.zip`
- tgz:
  `metasheet-multitable-onprem-v2.5.0-k3wise-migbridge-36ee325.tgz`

## Acceptance Matrix

| Check | Expected |
| --- | --- |
| `migration-provider.js` exists in archive | PASS |
| `zzzz20260512100000_add_users_must_change_password.js` exists in archive | PASS |
| Provider contains `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL` | PASS |
| Provider contains `032_create_approval_records` skip-list marker | PASS |
| Legacy `056` SQL contains `to_regclass('public.users') IS NOT NULL` | PASS |
| Timestamp bridge contains `must_change_password` | PASS |
| ZIP verify | PASS |
| TGZ verify | PASS |

## Result

The package verifier now treats the migration bridge as part of the Windows
on-prem delivery contract. A future package that omits the runtime provider
policy or timestamp bridge should fail before reaching the entity-machine
deployment step.
