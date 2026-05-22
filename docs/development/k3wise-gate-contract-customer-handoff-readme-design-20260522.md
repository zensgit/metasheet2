# K3 WISE GATE Contract Customer Handoff README Design - 2026-05-22

## Purpose

The first local GATE contract packet after #1710 closed needed a Chinese
operator/customer README next to the generated JSON files. That README was
useful, but it was only added manually to `/tmp`, so the next operator could
regenerate the packet with `--init-template` and still miss the handoff guide.

This slice makes the README part of the canonical initializer:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --init-template /path/outside-git/k3wise-gate-contract
```

The generated directory now includes `README-CUSTOMER-HANDOFF.zh.md` in
addition to the packet JSON and eight redacted sample skeletons.

## Scope

Changed:

- `scripts/ops/integration-k3wise-gate-contract-check.mjs`
- `scripts/ops/integration-k3wise-gate-contract-check.test.mjs`
- `scripts/ops/multitable-onprem-package-verify.sh`
- this design note
- companion verification note

Not changed:

- no `plugins/plugin-integration-core` runtime
- no K3 WebAPI read/list implementation
- no relationship resolver implementation
- no SQL executor implementation
- no DB migration
- no API route
- no frontend route
- no K3 Save, Submit, or Audit call

Customer GATE remains blocked until the filled packet passes validation.

## README Contents

The README is Chinese-facing and intentionally operational. It explains:

- which files in the packet must be filled;
- the WebAPI read/list answer IDs `O1-MAT`, `O1-MAT-M`, `O1-BOM`,
  `O1-BOM-M`, `O2-P`, `O2-T`, `O2-C`, `O3-F`, `O3-M`, `O4-MAT`,
  `O4-BOM`, and `O6`;
- the relationship answer IDs `R1` through `R7`;
- redaction expectations for tokens, cookies, passwords, SQL connection
  strings, URL query secrets, and real business data;
- the checker command to run after filling the packet;
- the current boundary: the packet never triggers K3 Save, Submit, or Audit.

The README deliberately does not contain real hostnames, tokens, passwords,
authority codes, database URLs, or customer business values.

## Package Verification

`scripts/ops/multitable-onprem-package-verify.sh` now asserts that the packaged
GATE contract checker contains the `README-CUSTOMER-HANDOFF.zh.md` marker.

This catches stale on-prem packages that still generate the JSON packet but do
not generate the customer handoff README.

## Operator Impact

Operators can still generate the packet outside Git with one command. The only
visible difference is that the target directory now contains a human-readable
Chinese checklist for the customer-facing GATE handoff.

The runtime unlock condition is unchanged:

1. Customer fills O1-O6 and R1-R7 evidence outside Git.
2. The checker returns `PASS`.
3. Maintainer reviews the evidence and explicitly starts the post-GATE runtime
   work.
