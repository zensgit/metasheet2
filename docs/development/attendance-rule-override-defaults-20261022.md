# Attendance partial rule override default preservation — 2026-10-22

Base: `4c78e75a0d1a96743c0b5b0ee9c8e8f059e99e3d`.

A partial rule-set override currently emits own properties whose values are undefined. Four production consumers spread those properties over a complete base rule: the calculation-group calendar, synchronous import planning, rule-set preview, and import preview. Missing grace values become NaN metrics; the real synchronous host correctly refuses their nonfinite fingerprint input.

## Contract

Only fields with a normalized value override the base rule. Omitted/unusable values inherit their existing base value. Explicit zero and existing accepted normalization retain their meaning. Do not substitute global defaults for organization-specific values, change precedence, or weaken canonical finite-number checks.

This is a bug fix on the existing default behavior. No new flag, migration, external IO, deployment, real UAT or 50004 work. Stream/lifecycle stay OFF; the PR remains Draft and is an R71 candidate.

## Verification gates

| Gate | Required evidence |
| --- | --- |
| Partial overrides | Production normalizer and calendar merge: exact full rule, nonzero base defaults, empty/partial/custom/zero controls |
| Routes and persistence | Real handlers, real PostgreSQL migrations and real synchronous host; preview, prepared commit, legacy import and rule preview |
| Permission neighbor | Denied actor gets 403 and no persistence |
| Mutation | Restore undefined overwrite; named regression assertions fail; restore exact source |
| Quality | Focused neighbors and pnpm validate:all |
| CI | Mandatory database lane plus every required check on the final exact head |

Final execution evidence is recorded in the PR; local checks are not proof of packaging or real business acceptance.
