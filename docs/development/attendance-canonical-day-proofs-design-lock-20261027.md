# Canonical split-day and overnight proof lock — 2026-10-27

Refs #4556. Evidence maintenance for the existing parent design lock attendance-shift-group-advanced-capability-design-lock-20260723.md §7.2 clauses CALC-01, CALC-02 and CALC-04. Draft/HOLD, no runtime feature or new acceptance denominator.

## Exact scope

Use the existing registered W4C3b request-operation real HTTP/nativePG fixture for two added named cases, with fresh per-case synthetic org/user/shift/assignment and legal exact-org calculation posture. Do not modify its original24cases/hooks, budgets, auth setup or registration. The fixture uses its existing RBAC_BYPASS=true posture; this proves calculation/HTTP/persistence behavior, not new authentication/RBAC coverage. Separate actual auth proofs remain separate.

The production online route gets no timestamp override. The existing historical test wrapper selects server clock instants and strips occurredAt before dispatch. Synthetic fixed dates may be chosen in the future to keep shift publication chronology unambiguous.

1. CALC02_HTTP_PG: explicit strict08:00–12:00 and13:00–17:00 segments. Three real HTTP punch200 yield healthy morning240 plus afternoon check_in/no checkout: exact segment1 missing_check_out reason, zero afternoon minutes and daily partial240. Query current parent/calculation/children and raw events, then replay the actual stored canonical inputs through the real calculator; no handcrafted output rows/snapshots.
2. CALC01 phase in that SAME case: fourth real checkout17:00 yields normal240+240/daily480, exact 4source events, new current calculation. Earlier missing-out calculation/children remain unchanged. This is a phase/assertion group, not a third Vitest case.
3. CALC04_HTTP_PG: explicit21:00–06:00+1 segment, assignment only on originD. Two real punches cross midnight; canonical replay dailyProjection.workDate and context/attribution remain originD, native parent originD exactly once with zeroD+1 rows, current authoritative canonical result and child normal540.
4. Add only explicit dailyProjection.workDate/timezone assertions to the existing pure overnight test; preserve all other original pure tests and budgets.

The replay is a fresh invocation from committed HTTP-produced native inputs. It is not instrumentation of the original in-flight return. HTTP and SQL parent/current calculation/child/event assertions in the SAME case are mandatory; resolver-only or replay-only checks cannot replace them. No direct writes to result/calculation/child/snapshot tables to fabricate outputs.

## Gates

| Gate | Required actual evidence |
|---|---|
| P1 scope/source | Fresh main, isolated own copy; exact inverse preserves original test bytes except the named pure assertions and added integration blocks/import. No product/schema/API/deps/flags/workflow changes. |
| P2 actual positive | Two added HTTP/PG cases actually pass, plus the affected pure overnight case. Record three clause phases without inflating Vitest test counts. No filtered/skip counted as pass. |
| P3 discriminator | Matching scoped mutations for missing-out classification, originating result date and planned-break minutes must fail the relevant selected assertions; restore exact runtime bytes. No guard/budget relaxation. |
| P4 quality | Explicit changed-test lint with same-path baseline comparison; actual pnpm validate:all. Independent source review and main assertion/log audit. |
| P5 publication/CI | Normal push to own branch, Draft PR, exact head/path/body readback. New head all required success plus actual registered-file named execution before final evidence. |

No final-approval correction/OT bridge or target protocol is implemented. No real provider/customer IO, merge/deploy/R71/tag/release/business config. Stream/lifecycle OFF, real UAT/business50004 excluded, historical08PUTINCONCLUSIVE. Owner/parent/W8/manual/live acceptance remains separate.
