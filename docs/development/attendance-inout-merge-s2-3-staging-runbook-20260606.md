# S2-3 in/out merge staging smoke — retired

**Retired:** 2026-10-10. `scripts/ops/staging-attendance-inout-merge-s2-3-smoke.mjs` refuses every invocation with exit status 2 and `ATTENDANCE_LIVE_TIMESTAMP_TOOL_RETIRED` before file access or network activity. `scripts/attendance/import-punch-events.cjs` has the same retirement contract.

Both tools supplied historical instants to ordinary `POST /api/attendance/punch`. That route now owns the server instant and refuses `occurredAt` and `occurred_at`; rewriting historical input to the current instant would corrupt its meaning.

For historical records, use the separately authorized attendance import or makeup/correction workflow with its existing organization, permission, provenance and review requirements. This notice does not authorize a staging run, migration, data repair or deployment.

Current synthetic verification uses the focused real-database attendance suites, including `attendance-online-punch-server-time.db.test.ts`, `attendance-online-punch-replay.db.test.ts` and the existing outdoor/shift writer regressions. The old S2-3 script cannot establish staging acceptance or change a tracker row to PASS. The server-clock design lock and verification report record current evidence and outstanding acceptance gates.
