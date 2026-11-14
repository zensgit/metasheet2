# Retirement timestamp precision — Draft/HOLD

Refs #4556. Base: 2e3aed2540659cd7a133f7b8c3f888b01115c7f8.

## Problem and bounded repair
A PostgreSQL timestamp decoded as JavaScript Date can carry milliseconds. The retirement helper converted it through String, which drops that precision. The resulting reversal snapshot disagreed with the unchanged daily parent, and the real W4C0_POINTER constraint rejected retirement with HTTP 500.

Preserve existing Date objects during ISO normalization. Keep the existing string, null and invalid-value behavior, transaction ownership, exact pointer/projection checks, retirement permissions and budgets. No migration, dependency, flag, OpenAPI or business-policy change.

## Evidence gates
| Gate | Evidence / state |
| --- | --- |
| Matching old-source reproduction | Two Date-millisecond cases fail; six ISO/whole-second/null controls pass; 15 existing cases filtered. |
| Repaired Date cases | Four Date cases pass; 19 filtered. Runtime and test bytes transferred exactly from the private proof checkout. This is not a whole-file rerun. |
| Native behavior | Real HTTP retirement then exact overtime refusal passed in the private OT candidate (one selected, 23 filtered). That integration evidence includes unpublished OT changes and is not a standalone current-head CI claim. |
| Source applicability | Fresh main has the same backend base tree as the proof base; both changed files match the tested candidate byte for byte. |
| Quality / independent review | Separate fresh-main candidate pnpm validate:all exit 0. Independent source review found no confirmed introduced P1/P2; main rechecked both source hashes, original test prefix and 76-file literal relative import closure equality to the tested candidate. No successful test suite rerun. |
| Publication / exact-head required CI | Pending; Draft/HOLD only. |

Original 15 test bodies stay unchanged. Added matrix covers authoritative and legacy parents, reversal SQL parameters and baseline fingerprint/preimage. No filtered, skipped or todo case is counted as passed. Historical failed fixture setup and mutation attempts remain in private evidence.

No merge, deployment, R71/tag/release/configuration/provider changes. Stream/lifecycle remain OFF; real UAT and business error 50004 excluded. This repair does not close full EP01, owner acceptance or production validation.
