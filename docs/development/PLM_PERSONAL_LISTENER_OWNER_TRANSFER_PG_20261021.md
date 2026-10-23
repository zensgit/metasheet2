# Personal listener owner-transfer PostgreSQL verification

The existing personal listener now has regression coverage for an owner transfer
while a separate Node process is waiting for a Native page. Product behavior and
the fixed distribution source are unchanged.

## Exact scope and assumptions

- Product source: `ed7b2945542346f52a1fc25b265b3f064b657aba`.
- Test source: `1cee59fd63721c90ac2fd6cf480441d2798333bc`. This document is a separate closing commit.
- Grok4.7(xhigh) implemented the bounded test change; Codex independently reviewed
  the source and ran the actual PostgreSQL checks.
- Administrative A→B→A transfer is represented by durable `data_sources.owner_id`
  updates in the owned database. This does not invent or qualify a transfer HTTP API.
- The original owner's still-valid independent `yue` grant may be explicitly
  re-enrolled after ownership returns. Re-enrollment rechecks current authority;
  a separate explicit start establishes the current baseline.
- The Native adapter is controlled. Real PostgreSQL and separate Node processes
  do not establish paired installed Native/Meta HTTP or browser acceptance.

## Verified behavior

One parameterized test covers both empty and nonempty late pages. A child waits
at the existing page barrier while the parent commits A→B→A. Each transition
changes the durable source authority epoch. The old listener remains stopped at
cursor5, with its old generation and provenance. The worker reports only `page`,
so no new Native fact request occurs after authority changed. Inbox, completion
events, snapshot rows and binding snapshot metadata remain unchanged.

An automatic poll remains inactive. Starting with the old enrollment fails with
the exact `403 PLM_CHANGE_READ_AUTHORITY_CHANGED` before transport. Explicit
same-grant enrollment refreshes provenance and generation without retiring the
credential. Explicit start uses current head8 and imports no historical event.
A distinct worker then performs `page` and `fact`, committing exactly one later
event and one completion at cursor9. Snapshots remain unchanged.

A separate case gives owner B active Meta memberships and target administration.
B cannot rewrite the immutable Meta/Native identity link or use the previous
owner's personal authority; start fails with
`403 PLM_CHANGE_READ_IDENTITY_CHANGED` before any Native call.
The helper exposes only operation names and process ID, never the credential.

## Execution and evidence

| Check | Actual result |
| --- | --- |
| Focused three new cases | 3 passed; 48 deliberately unselected |
| Full personal-read PostgreSQL suite | 51 passed; 0 skipped; 0 failed |
| Full suite measured test duration | 8930 ms |
| Existing migration/locking/CAS/unlink regressions | Included in the full suite |
| Owned test process groups, postmasters and sockets | Absent after every run |
| Product source and fixed Meta distribution tree | Unchanged |
| CI/publication | Pending; local commits only |

The runner used Node20.20.2, PostgreSQL16.15, a new database and private
`/tmp/plm-crpg-s-*` socket per run, with TCP disabled. It retained the existing
4GiB admission floor and test/hook timeouts. Dependencies were reused; Vitest cache
was disabled to avoid writing through the shared dependency symlink.

The reproducible test command, with both database URL variables pointing to the
same explicitly owned Unix socket, is:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.plm-change-read.config.ts --no-cache --reporter=json --outputFile /owned/evidence/vitest.json
```

Run from `packages/core-backend`; use the existing fixture's required
`DATABASE_URL` and `PLM_CHANGE_READ_TEST_PG_URL`. The retained private driver
creates and stops the isolated database and records source hashes before/after.

The first QA run failed before collection because its empty-host PostgreSQL URL
was invalid for WHATWG URL parsing. The corrected URL has `localhost` plus the
explicit Unix-socket query; PostgreSQL still has no TCP listener. Raw failure
and cleanup evidence are retained; this was a harness correction, not a product fix.

This Vitest version's focused JSON top-level counters incorrectly include the
48 name-filtered skips as passes. Counts above come from individual assertion
statuses. The final driver rejects zero selected passes and any skipped case in
the full run. Raw reports are unchanged.

Compact evidence:
`artifacts/plm-listener-owner-transfer-pg-20261021/verification.json`.
Private frozen manifest SHA-256:
`55247b67ca3e576f37811b288dd1844e5fd30b848ecc2cd987c365dc96127135` (29 retained files).
Owned test database directories remain private; no unknown data or Docker
resources were deleted.

## Delivery and remaining gates

Publication remains held behind Yuantus Draft#366 at
`33b2553bc8a04362f2fc7bfb18426c5cd5d239f5`, whose
[valuable perf job](https://github.com/zensgit/yuantus-plm/actions/runs/39411113459/job/118588819008)
was still queued at 2026-10-20T19:11:53Z. No useful job was cancelled, no passed
job rerun, and no threshold changed. Draft#349 remains at
`f5a15616468c6208e06c58c620cc8280c86834a6` with its previously diagnosed failures.

Fresh Metaed7 web-image construction still needs the unchanged 8GiB admission
floor. Final paired-image HTTPS/install/backup-restore qualification and installed
owner-transfer browser/HTTP proof remain open. Prior frozen acceptance and HOLD
evidence are preserved. This slice does not complete the full window goal, authorize
merge/deployment, or qualify real customer/device/production acceptance.
