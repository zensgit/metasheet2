# LIVE07 native selection verification — Draft

This tests-only slice is based on #6630 at `fc914ccb6fe5ec628f184ea0ea71d55c79be1a4e`. It adds native PostgreSQL proof for legal adjustment exclusion and a distinguishable foreign-org physical event, in both shadow and authoritative live-punch branches. The same user belongs actively to both fixture orgs; work date and all remaining loader predicates match.

The boundary uses production plugin adapters and a production-migrated owned database. Its connection wrapper observes the actual SELECT result before mapping and returns the original native result unchanged. Assertions require the two physical controls and their persisted evidence snapshot. No runtime, migration, schema, dependency, flag or provider behavior is changed.

Actual validation: the whole new file passed all four unique cases with no filtered, skipped or todo cases. Removing the physical predicate produced two matching failures with an extra native adjustment row. Replacing only the loader org predicate with a non-null bind tautology produced two matching failures with the foreign physical row. Each mutation phase filtered the other two cases (the JSON reporter calls these skipped); they are not passes. Both grouped raw failures point to the native selection assertion. The exact runtime SHA256 was restored to `d472f2134e4a8b414b5adb80a3889d667a74d246f7e33d957c3e1b6e5a02c62b`; PostgreSQL is stopped and its owned data is retained. Mutation failures do not increase the unique passing case count.

Explicit new-file ESLint with `--no-ignore --parser-options '{"project":null}'` passed; this is an AST check, not a fresh whole-project typed lint or validate-all. Production inputs are unchanged from #6630.

Two harness stops are retained: the first happened after four passes but before mutation on a literal marker mismatch; the second followed the physical matching reds because the count parser expected pending instead of the reporter's skipped. Only unfinished mutation phases continued; no baseline or completed physical mutation was repeated. The module has two identical WHERE fragments, so the org mutation is scoped to the loader body.

The whole native file is registered in the existing post-migrate plugin CI chain and excluded from the no-DB default lane. Missing DATABASE_URL throws rather than skip-greens. Existing passed suites are carried by exact source and are not rerun locally.

This does not close the full MUT06 denominator, HTTP/permission acceptance, nondefault timezone callers, scheduled delegation or production readiness. Current main at intake `49d61ab231efc1392bbbfb492836566ea25ba081` differs from this source; no main equivalence is claimed. Keep Draft/HOLD; no merge, deployment or enablement.
