# Previous-night ambiguity evidence lock

Status: Draft/HOLD. Refs #4556.

The parent advanced shift/group lock, section 7.4 MUT-05, requires the gate
to detect choosing the previous work date on ambiguity. The current-day tie
case and unique previous-night success case do not instantiate two previous
overnight candidates. This slice adds that exact pure-selection regression
case to the existing required backend unit file.

Scope: two distinct previous overnight candidates both contain the same
post-midnight punch, without an open-record winner. Both candidate orders
must return the same full actionable ambiguity shape, exposing only the
existing four candidate fields. The legal unique previous-night case remains
a positive control. No production calculation or attribution rule changes.

| Gate | Required evidence |
| --- | --- |
| Full ambiguity | Exact kind/reason/two identities/UTC windows, both orders |
| Legal prior-night control | Existing unique-candidate case actually passes |
| Fault discrimination | Relax only the existing unique-prior-night branch to accept multiple; new case fails, control passes |
| Restoration | Original runtime bytes and selected two cases pass |
| Preservation | Removing only the new case exactly restores the original unit file, hooks and budgets |
| Lint/quality | Explicit same-path baseline comparison; actual unchanged production-input qualification |
| Required CI | All required checks succeed on this PR's exact head; no skipped check counted as green |

No new file registration is needed: this existing unit file runs in the
required backend core unit step. This proof is not five-entrypoint calendar
fallback parity, SQL/HTTP evidence, real authentication, UAT or parent/owner
acceptance. Stream/lifecycle and all external writes remain OFF; no merge,
deployment, release or R71 change is authorized by this slice.
