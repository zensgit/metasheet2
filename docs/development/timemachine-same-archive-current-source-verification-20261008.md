# Time Machine same-archive source integration verification

This report closes source integration and focused non-native checks only. The
full V1 controlled-staging goal remains OPEN.

## Source

Fresh main is `644310ba60953b021d85ae393d94ef3408e25cb9`; the prior local candidate
is `680d50d339c027a82e5cf6862459ce9b267948ac`. Their conflict-free union tree is
`ad032398eab728446acbe1fa76f3cfe235c62a4a`. Independent review verified all 141
applied paths and preserved main's 13 independent changes plus the shared route
change. Package manifests, lockfile and flag manifest retain their bytes.

The existing extended backup driver and its manual HTTP, official target,
rollback and three-case helper test are reused from the same-chat
`tm-same-archive-5001-apfs-20261001` source. Its genuine captured generation remains
distinct from the seeded control; its 5001-row, attachment, backup/import,
source-unavailable, takeover, exact readback and fresh flag-OFF assertions remain.

The test-only adaptation supplies the actual source pool, a 1000 ms acquisition
timeout and explicit 64 MiB / 60 s capture limits. Native client depth changes
after fulfilled transaction statements; an active client is discarded on
release. Registered database name/OID/owner/cluster identity, zero clients,
ordinary DROP and absence are required. Parent IPC completion additionally waits
for actual exit 0. Normal teardown uses no SIGKILL or backend termination; the
existing verified-child crash injection remains a distinct fault test.

Independent review found a local empty-target pool could remain open when its
initial empty-table assertion failed. A minimal `try/finally` now closes that
pool while retaining the assertion. Failed child/drain/identity checks preserve
resources and report failure.

## Checks

| Check | Actual result | Scope |
| --- | --- | --- |
| `pnpm --filter @metasheet/core-backend exec tsc -p scripts/tsconfig.recovery-archive-acceptance.json --pretty false` | Exit 0, no diagnostics | Initial source port |
| `pnpm --filter @metasheet/core-backend type-check` | Exit 0 | Both backend and actual acceptance configurations; initial source port |
| Same package type check after the empty-target repair | Exit 0, source hashes stable during check | Final source; both configurations |
| Whole `multitable-recovery-local-same-archive-script.test.ts` plus `recovery-local-backup-driver-safety.test.ts` | 9 PASS, 0 skipped, exit 0 | Mocked restore HTTP helper and local driver safety; no native capture |
| Remove only the helper's 5001 effective-write-count assertion; rerun both whole files | 8 PASS / 1 FAIL, exit 1 | Matching truncated-5000 refusal case is the sole failure |
| Restore original helper bytes; rerun both whole files | 9 PASS, 0 skipped, exit 0 | Original/restored helper SHA-256 `8e47f9a8667811728ffda03c2d2c0977996b924da84769157e6f20aa35bfea42` |

Independent final review qualified the source and these bounded checks. No
PostgreSQL/APFS runner, real capture, restore worker or staging operation was
executed in this source-only slice. These checks do not validate the current
integrated native lifecycle.

## Open gates

The fixed-source same-generation native chain, full specified fault/writer
requirements, required exact-SHA remote CI, provider/KMS evidence, live Phase 5
attribution and owner-selected staging target/window remain OPEN. The previous
execution restriction remains pending verification of its precise saved reason;
this source port does not authorize an equivalent retry.

The read-only Phase 5 refresh at `2026-10-08T05:54:23Z` found no new runs:
Nightly `37717354051`, External `37716702373`, Regression `37716877137` remain
failed on `afd32b704c6ff4c82dbfe90b94066fcaf3fc0074`. Historical summaries have
five passing checks, no measured failing check and six unavailable checks, with
empty percentiles. Missing samples explain the validation failure; the actual
sampling cause and current deployment behavior remain unknown.

Local evidence is retained under
`artifacts/tm-same-archive-closeout-20261008/` and
`artifacts/tm-phase5-current-readonly-20261008-v4/`.
