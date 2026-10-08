# Phase5 source and sampling union — 2026-10-08

Fresh main is `9eee3a3cd0e734f6a4abb972068f4f535eb08ebf`. Integrate
`0f89521b861fc9cbd434cf40976140bcfbd5e3f9` (Time Machine source port and
finite-percentile repair) with `04f851fed24b4ff215f082b375da1ad4785ad8df`
(sampling diagnostics). This closes static integration obligations only.

Preserve nullable/+Inf calculations and null FAIL behavior from the first source,
and complete-count witnesses, exact-key selection, second-input provenance,
values-free sampling and child-exit refusals from the second. Keep all cases:
7 + 8 minus the two shared controls = 13. The diagnostics nonfinite case now
requires exit1,9PASS/2FAIL/0NA rather than the legacy main PASS. The required
backend wrapper freezes 13/13 with no failure, skip, todo or cancellation.

Only resolve the percentile and wrapper conflicts plus that ops expectation;
all other merged paths retain the actual auto-union tree. The six preserved
source-port input files retain exact bytes and Git modes from 0f895; this is
source equivalence, not a native run of that candidate.
Preserve fresh-main paths, package/workspace/flags and the existing test chain.

Verify the whole 13-case CLI contract through the required backend unit guard,
the nine source-port/safety unit neighbors, and actual backend type-check including
its acceptance config. Reuse prior cache/auth neighbor evidence only for identical
bytes, with no new-execution claim. Once, neuter the new count witness: matching
behavioral RED, finally byte-identical restore, then whole guard GREEN.

No native/DB/APFS, old runner, real metrics, credentials, deployment, flags,
external feedback, commit, push or PR execution is part of this source integration.
Static green does not qualify a new native source SHA, remote CI or owner staging.
