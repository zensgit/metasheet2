# PLM package admin credentials after configuration loading

Source commit: `3d788082dbfc0797abc395de2dc6e7e8d5a47697`

Base main: `a03d804d60d83717feaedce099e5ff14216afc58`

The admin bootstrap script checked the caller's email and password before sourcing
`ENV_FILE`, then hashed and wrote the values selected by that file. A valid caller
could therefore pass the early checks while the file supplied an empty email or
an empty/short password. The original script completed successfully in all three
synthetic counterexamples.

The existing nonempty email, nonempty password and minimum-12-character checks now
share one pure function. It runs at the original position before command checks,
and immediately after the single configuration load. Diagnostics and thresholds
are unchanged. Invalid caller inputs still refuse before reading a valid file;
valid file credentials retain their existing priority and exact bytes.

The original executable mode, JWT/encryption/bcrypt/import-token checks, admin SQL,
W1 local-org routes and assertions, API selection and service receipt are unchanged.
The existing test fixture adds default-off, values-free witnesses that compare the
actual bcrypt password argument and psql email argument. Existing stub responses
and SQL pins remain intact.

## Source verification

Fixed Node 24.14.1 and Bash 3.2.57; private source/home/temp directories and an
explicit `/usr/bin:/bin` PATH. The inherited top-level PowerShell availability
probe found no command. Only the new `^effective admin inputs:` shell cases ran;
old HTTP/PowerShell callbacks were excluded. Real bcrypt and psql were replaced
by the existing stubs; the existing UUID fallback used Node's builtin crypto.

| Source/control | PASS | Expected RED | Seconds |
| --- | ---: | ---: | ---: |
| Original main, eight selected cases | 5 | 3 | 5.6902 |
| Guarded candidate, same eight cases | 8 | 0 | 3.2442 |
| Private copy with post-source call removed, three relevant cases | 0 | 3 | 2.5167 |
| Private copy with early call removed, three relevant cases | 0 | 3 | 2.3946 |

The original three failures are intended guard failures: source loaded once,
actual argument witnesses fired, two fake SQL statements ran, and the script
returned 0 where the tests require 1. The corrected script returns 1 with the
existing diagnostic and reaches neither hashing nor SQL. Two positive controls
prove final file-value priority and an exact 12-character password containing
spaces and an apostrophe. Three controls preserve early caller rejection.

All runs completed without timeout and left their owned fixture temp directories
empty. The mutations changed private copies only. Independent source, effect and
actual-result reviews accepted the exact hashes and causal controls. Unrelated
passing suites were not manually replayed.

## CI and delivery boundary

The existing `attendance-onprem-encryption-material-contracts.yml` already watches
both edited paths and runs this module under Node 20. No workflow was added or
relaxed. Current-head CI is reported separately in the Draft PR; these local
Node 24 results do not claim Node 20 CI success.

[Compact verification evidence](../../artifacts/plm-admin-effective-inputs-20261030/verification.json)
records source hashes, timings, review hashes and qualifications. This is source
and unit verification. Actual application HTTP/PG, static build, image provenance,
installation, browser and business acceptance were not performed in this cut.
Source23, W2 and Claude-owned HOLDs remain in force. The wider engineering goal
remains open; this change carries no merge, deployment or production authorization.
