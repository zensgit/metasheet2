# Stock Preparation RC-A C-Stage No-Git Runner - Development and Verification (2026-07-22)

Issue: #4437. Status: implementation proposed; merge, sidecar publication, and entity-machine
execution remain separate owner/operator gates.

## 1. Problem

The entity machine completed the flag-OFF sidecar-v2 diagnostic, but it had no executable channel
for the authorized C-stage window. Free-form instructions were not sufficient because the window
must temporarily enable a write-bearing internal feature, execute the exact frozen smoke once, and
restore the service to OFF even when any intermediate step fails.

This change adds a tested Windows PowerShell 5.1 sidecar. It does not change product runtime code,
the deployed RC-A package, any database schema, or the `externalWrite=false` product invariant.

## 2. Frozen Inputs

The sidecar pins the previously accepted RC-A runtime at
`d87e086fd1218b4cfb150177d43f2c52904b1d6d` and copies these helpers into one private temporary
directory before execution:

| Helper | SHA-256 |
| --- | --- |
| `stock-preparation-prep-line-extended-smoke.mjs` | `912f3ef75c4487dbdd946486d4cb7374f1c3ea1eb126c3b68381ad11963f0049` |
| `stock-preparation-mvp-postdeploy-smoke.mjs` | `e5265a2a8052ddc34866438a1ee3356b5d2aa1a106c8199f5e2fbbe4f2614df4` |

The new PM2 projection helper is pinned by the runner as a third digest. A missing file, reparse
point, digest mismatch, malformed PM2 payload, duplicate target process, or non-closed projection
fails before the flag-ON window.

## 3. Execution Contract

The runner performs exactly this sequence:

1. Require private approved-config preflight attestation, tenant input, token, and config reference.
   The API origin must be a bare loopback HTTP(S) origin; authenticated PowerShell calls do not
   follow redirects.
2. Acquire an exclusive machine-local lock.
3. Verify and privately copy all frozen helpers.
4. Prove the current PM2 process is online, token-clean, and effectively flag-OFF; prove health.
5. Set `MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED=true`, restart PM2, prove stable online,
   effective ON, token-clean, and healthy.
6. Execute the frozen extended smoke at most once with fixed `timeoutMs=15000`.
7. Require `201 internal_persist`, exact replay `200 internal_noop`, the full T4 chain,
   `selfScanClean=true`, and `externalWrite=false`.
8. Read the internal project and snapshot-batch endpoints and prove exactly one expected project,
   exactly one expected batch, `lineCount>=1`, the exact run handle, and `incomplete=false`.
9. In independent cleanup blocks: scrub token carriers, set the flag literal false, restart/stabilize
   PM2, prove effective OFF and token hygiene, prove health, revoke the token, remove helpers, and
   release the lock.
10. Emit one 17-field values-free block. Exit 0 is possible only when every result is PASS; all
    blocked or failed outcomes exit 2.

The physical readback accepts JSON booleans only. Strings such as `"true"` and `"false"` are rejected
instead of being coerced by PowerShell.

## 4. Native Process and Environment Safety

Windows PowerShell 5.1 can promote native stderr into a terminating `NativeCommandError` under
`$ErrorActionPreference='Stop'`. Both PM2 command execution and the Node projection therefore:

- scope `Continue` only around the native call;
- discard native stderr and never echo raw PM2 output;
- preserve the native exit code;
- restore the caller error policy in `finally`.

PM2 `--update-env` otherwise imports every variable in the operator shell. The native PM2 boundary
temporarily reduces its inherited environment to a fixed operational allowlist plus the one feature
flag, then restores the parent PowerShell environment. Plant-and-assert tests prove unrelated
database-password and cloud-key sentinels are absent from the PM2 process while still present in the
operator process afterward.

The approved config reference remains a command-line argument to the frozen helper because that
exact helper has no environment-variable interface. It is an opaque internal reference, not a
credential. The login token remains environment-scoped only for the child and is cleared in the
same capture `finally`.

## 5. No-Git Delivery Channel

`.github/workflows/stock-preparation-rca-window-sidecar.yml` is the executable transport path.
After merge, an owner dispatch on `main` produces a ZIP artifact containing exactly:

- the C-stage PowerShell runner;
- the values-free PM2 projection helper;
- both frozen exact-RC-A smoke helpers;
- an operator README;
- `BUILD_PROVENANCE.json` with sidecar source SHA and frozen runtime SHA;
- `SHA256SUMS` covering every payload file.

The workflow does not publish a GitHub Release. Public/private release publication remains an
explicit owner action after the exact-main artifact is verified.

For pull requests, the workflow explicitly checks out the PR head SHA rather than GitHub's synthetic
merge commit, records that same SHA in provenance, and rejects the build unless `git rev-parse HEAD`
equals it. For manual dispatch, both values resolve to the selected ref's `github.sha`.

## 6. Verification

Local verification after the first adversarial correction:

| Gate | Result |
| --- | --- |
| PM2 projection Node tests | 8/8 PASS |
| PowerShell contract tests | 36/36 PASS |
| PowerShell behavior tests | 27/27 PASS |
| Sidecar builder and provenance-wiring tests | 3/3 PASS |
| Frozen extended + MVP + abort-provenance regressions | 95/95 PASS |
| PowerShell parser | zero errors under the 5.1 grammar |
| Diff hygiene | `git diff --check` PASS |

The Windows job runs the target-shell suite under real Windows PowerShell 5.1. Its PM2 `.cmd` shim
writes a sentinel to stderr for both `jlist` and `restart`; the projection/restart must still succeed,
preserve exit 0, exclude the sentinel, and restore `$ErrorActionPreference='Stop'`.

Behavior tests additionally prove:

- helper tamper is rejected before execution;
- a second smoke invocation is child-free and refused;
- duplicate smoke fields and `externalWrite=true` cannot pass;
- duplicate project, zero lines, incomplete batch, and string-booleans fail physical proof;
- smoke failure restores OFF and performs no readback or retry;
- helper disappearance after ON cannot suppress the literal-false PM2 restart attempt;
- restore failure overrides an otherwise green run;
- final PM2 sampling failure cannot skip token logout, helper cleanup, or lock release;
- planted token, config, tenant, database-secret, and cloud-key sentinels do not enter evidence or PM2.

Twelve committed-head mutations were applied one at a time in a detached worktree and all were
killed by the focused tests: helper-dependent restore, PM2 environment bypass, external-write gate
removal, physical-readback bypass, smoke-once bypass, boolean coercion, loopback removal, incomplete
archive manifest, helper-digest bypass, cleanup-failure unlatching, PM2 stderr-scope removal, and
redirect refusal removal. Each mutation was restored before the next; the source worktree remained
clean.

## 7. Independent Adversarial Review

A read-only Kimi K3 pass verified the frozen digests and locally ran the first 8/25/18 test set. It
found one blocking P2: an unguarded final PM2 sample could throw under PowerShell 5.1 and skip token
revocation, helper cleanup, and lock release. The final implementation closes that gap with native
boundaries and isolated cleanup blocks, then adds the target-shell stderr and cleanup-continuation
tests above.

The same review identified three smaller fail-open shapes, all closed here: PowerShell boolean
coercion, a vacuous `IndexOf` contract assertion, and deleting the lock inode after release. It also
identified whole-shell `--update-env` inheritance; the fixed minimum PM2 environment closes that
risk rather than documenting it away.

## 8. Honest Boundary

Local tests cannot prove the entity machine's PM2 layout, approved source data, service health, or
the final ON/OFF window. Those remain the purpose of one controlled entity run after merge and
exact-main artifact publication. A PASS closes only the #4437 RC-A acceptance scope; it does not
authorize production rollout, external writes, or any later value-plane gate.
