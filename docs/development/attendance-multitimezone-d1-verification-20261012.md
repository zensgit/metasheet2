# Attendance multi-timezone D1 verification — 2026-10-12

Status: foundation verified; full feature incomplete. Draft PR and CI are authorized but have not been created/run. No merge, Ready transition, deployment, enablement, or real customer data access.

Base: 154df39332fd28dd02b71795a42e0e072dd19df0; branch: codex/attendance-multitimezone-20261012. Source changes remain uncommitted. The base SHA is not the identity of the modified source; the six source hashes in the full-migration receipt identify this verification scope.

## Implemented scope

- Pure timezone precedence: approved effective trip, employee override, calculation group, organization default. OFF returns the strict organization default without reading other source getters.
- Organization policy and effective employee-override persistence, compare-and-set versions, active organization membership guards, immutable source identity, exclusion of overlapping overrides, and transactional enum-only audit.
- Organization-default timezone revision is governed by a database trigger; it changes on an actual timezone change, not an independent counter edit.
- Rollback refuses to delete persisted configuration/audit or governed default revisions. Empty-schema rollback remains supported.

These modules are not connected to production punch, request approval, or UI code. Selecting a synthetic approved trip is not evidence that business-trip approval exists.

## Verification

| Check | Evidence and result |
| --- | --- |
| Pure selector and clock neighbor | Root independent full-file run: 99/99, zero skipped; 89 selector + 10 neighbor |
| Persistence units, real PostgreSQL, neighbor | V2: 62/62, zero skipped; 33 units + 19 DB + 10 neighbor |
| Unique foundation tests | 151; the 10 clock tests appear in both runs and are counted once |
| Negative controls | Immutable id/created_at regressions first failed then passed; three independent rollback table blockers fail when removed; selector boundary and organization controls fail when mutated |
| TypeScript | Scoped migration and persistence TS tests pass; this is not a static type check of CJS or the whole workspace |
| Configured complete migration apply | 439 provider names match the real ledger, exit 0, zero pending; no migration exclusions |
| Complete migration replay | Same configured entrypoint, exit 0 on bounded retry; all ledger names and timestamps remain byte-identical |
| Actual public-schema store probe | Organization isolation, governed default revision, override identity, half-open interval, forbidden cross-org subject, and exact audit count pass |
| Evidence integrity | Root verified all logged artifact hashes and all six current source hashes; zero mismatches |
| Resource cleanup | Receipt records exact owned PostgreSQL PID/datadir/UID verification and stopped state; data/evidence retained |

The initial configured list encountered an IPC path-length error. Re-running the same CLI using an exclusive short TMPDIR succeeded. The first replay encountered a PostgreSQL connection timeout before migration introspection; liveness and ledger controls were checked and one retry through the same CLI succeeded. Both original failure logs remain retained.

Full-migration receipt SHA256: 2dabf3e10835b88b0f86b1d4a79c586817393fc1ce04bc56f1fcd8b955d3c46d.
Persistence V2 receipt SHA256: 4e85735b7c2ef53cd2a3732cda7a8e8d214af685a958bf7792e3fc397f0b5953.

## Remaining gates

Authority-loader and runtime integration; policy/schedule lock order and real concurrency; frozen timezone provenance; original-context checkout and exact replay; same-workDate conflict refusal; complete-shift boundary checks including already-started published shifts with no punches; business-trip submit/final approval/cancellation; related document target-context binding; frontend and two-point frontend test wiring; full synthetic acceptance; latest-main alignment; exact-head required CI and independent final review.

Administrator per-document input/display configuration remains a proposal awaiting scope confirmation. Attendance attribution, leave deduction and pay calculation must remain bound to the target shift. Generic task timezone behavior is outside the approved attendance scope.

## Local CI-wiring verification addendum

The existing attendance acceptance and W4C2 workflow guards pass 280/280 with zero skips, using both complete test files and Node file scheduling concurrency 1. The new DB suite was added to the exact pinned family, without narrowing predicates or weakening equality/multiplicity assertions. Original missing-dependency failures and a parallel-run YAML subprocess timeout remain retained. The complete serial rerun changed only scheduling; no name filters or timeout relaxations were introduced. This is local wiring verification, not GitHub CI.

Serial log SHA256: dd179f20d771a85fde93d0db272ba6907258e34f83d0433842ce72f490746445.
